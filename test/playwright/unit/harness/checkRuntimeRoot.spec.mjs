import {test, expect}  from '@playwright/test';
import {execFile}      from 'node:child_process';
import fs              from 'node:fs';
import os              from 'node:os';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * Guards `ai/scripts/diagnostics/check-runtime-root.mjs` — the check that an `agentosRuntimeRoot`
 * owns its dependency closure (ADR 0040 §2.5, neomjs/neo-agent-brain#335).
 *
 * The specimen these fixtures reproduce is the real 2026-09-04 outage shape: a runtime root whose
 * `node_modules` was a SYMLINK into a separate checkout, which kept working until that other tree's
 * install pruned a package the daemon imported. The borrowed-closure arm therefore asserts the
 * check REDs while the entrypoint still resolves — the fault is latent, and a check that only fires
 * after the crash would have been useless on the day it mattered.
 *
 * The script is driven as a subprocess rather than imported, because the exit code IS the contract:
 * a CI caller and an operator both consume it that way, and importing it would need an export that
 * no production caller wants.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url))),
      SCRIPT    = path.join(REPO_ROOT, 'ai/scripts/diagnostics/check-runtime-root.mjs');

/**
 * Runs the check against one root.
 * @param {String} root
 * @returns {Promise<{code: Number, out: String}>} Exit code and combined output.
 */
function runCheck(root) {
    return new Promise(resolve => {
        execFile(
            process.execPath, [SCRIPT, '--root', root], {timeout: 60000},
            (error, stdout = '', stderr = '') => resolve({
                code: error ? (error.code ?? 1) : 0,
                out : `${stdout}${stderr}`
            })
        );
    });
}

/**
 * Builds a runtime-root fixture.
 *
 * @param {Object} options
 * @param {String} options.name Unique fixture name.
 * @param {Boolean} [options.borrowClosure=false] Symlink `node_modules` at a sibling tree instead of owning it.
 * @param {Boolean} [options.installDep=true] Whether the imported package exists in the closure.
 * @param {Boolean} [options.withEntrypoints=true] Whether the daemon entrypoints exist.
 * @returns {String} Absolute path to the fixture root.
 */
function makeRoot({name, borrowClosure = false, installDep = true, withEntrypoints = true}) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-root-${name}-`)),
          root = path.join(base, 'root');

    fs.mkdirSync(root, {recursive: true});

    if (withEntrypoints) {
        // Both entrypoints import the same package, and both gate their boot exactly as production
        // does — so the probe resolves the graph and starts nothing.
        for (const rel of ['ai/daemons/orchestrator/hostEdge.mjs', 'ai/daemons/wake/receiver.mjs']) {
            fs.mkdirSync(path.join(root, path.dirname(rel)), {recursive: true});
            fs.writeFileSync(path.join(root, rel),
                'import \'fixture-dep\';\n' +
                'if (process.argv[1] && import.meta.url === (await import(\'url\')).pathToFileURL(process.argv[1]).href) {\n' +
                '    throw new Error("fixture booted — the probe must never reach this");\n' +
                '}\n'
            );
        }
    }

    // The closure the root either owns, or borrows from a tree it does not control.
    const closureHome = borrowClosure ? path.join(base, 'other-checkout') : root,
          modulesPath = path.join(closureHome, 'node_modules');

    fs.mkdirSync(modulesPath, {recursive: true});

    if (installDep) {
        const dep = path.join(modulesPath, 'fixture-dep');

        fs.mkdirSync(dep, {recursive: true});
        fs.writeFileSync(path.join(dep, 'package.json'), '{"name":"fixture-dep","version":"1.0.0","main":"index.mjs","type":"module"}');
        fs.writeFileSync(path.join(dep, 'index.mjs'), 'export default {};\n');
    }

    if (borrowClosure) {
        fs.symlinkSync(modulesPath, path.join(root, 'node_modules'));
    }

    return root
}

test.describe('check-runtime-root', () => {
    test('a root that owns its closure passes', async () => {
        const {code, out} = await runCheck(makeRoot({name: 'sound'}));

        expect(out).toContain('every runtime root owns its dependency closure');
        expect(code).toBe(0);
    });

    test('a borrowed closure REDs even though the entrypoints still resolve — the #335 latent shape', async () => {
        const {code, out} = await runCheck(makeRoot({name: 'borrowed', borrowClosure: true}));

        // The distinguishing assertion: the dependency IS installed and IS resolvable here, so the
        // only thing that can fail this arm is the ownership finding itself. This is the state the
        // machine sat in for weeks before the prune landed.
        expect(out).not.toContain('unresolved dependency');
        expect(out).toContain('node_modules resolves OUTSIDE the root');
        expect(code).toBe(1);
    });

    test('a pruned dependency REDs by name — the shape the outage finally took', async () => {
        const {code, out} = await runCheck(makeRoot({name: 'pruned', borrowClosure: true, installDep: false}));

        expect(out).toContain('unresolved dependency \'fixture-dep\'');
        expect(code).toBe(1);
    });

    test('a root missing the daemon entrypoints REDs — an Engine clone installs cleanly and never launches', async () => {
        const {code, out} = await runCheck(makeRoot({name: 'no-entrypoints', withEntrypoints: false}));

        expect(out).toContain('entrypoint missing from this root');
        expect(code).toBe(1);
    });

    test('a nonexistent root REDs rather than reporting a clean audit', async () => {
        const {code, out} = await runCheck(path.join(os.tmpdir(), 'runtime-root-absent-fixture'));

        expect(out).toContain('root does not exist');
        expect(code).toBe(1);
    });
});

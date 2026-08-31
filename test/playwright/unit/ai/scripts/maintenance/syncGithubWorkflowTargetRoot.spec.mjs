import {test, expect}     from '@playwright/test';
import {readFileSync}     from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath}    from 'node:url';

import {
    assertTargetHoldsCorpus,
    resolveEmissionTargetRoot,
    TARGET_PACKAGE_NAME,
    TARGET_ROOT_FLAG
} from '../../../../../../ai/scripts/maintenance/syncGithubWorkflowTargetRoot.mjs';

const
    // maintenance -> scripts -> ai -> unit -> playwright -> test -> repo root
    REPO_ROOT   = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..'),
    ENTRY       = resolve(REPO_ROOT, 'ai/scripts/maintenance/emitGithubCorpus.mjs'),
    BRAIN_ROOT  = '/repos/neo-agent-brain',
    ENGINE_ROOT = '/repos/neo',
    enginePkg   = () => ({name: TARGET_PACKAGE_NAME});

/**
 * @summary Resolves against fixed roots so the assertions describe the BINDING, not this checkout.
 * @param {String[]} argv
 * @param {Object} [overrides]
 * @returns {String}
 */
function resolveWith(argv, overrides = {}) {
    return resolveEmissionTargetRoot({
        argv,
        readPackageJson: enginePkg,
        runtimeRoot    : BRAIN_ROOT,
        ...overrides
    })
}

test.describe('corpus emission target-root binding (#289)', () => {
    test('binds the named Engine checkout', () => {
        expect(resolveWith([TARGET_ROOT_FLAG, ENGINE_ROOT])).toBe(ENGINE_ROOT)
    });

    test('the binding, not the flag position, decides — extra args do not disturb it', () => {
        // `postReleasePreflight.resolveTargetRepoRoot` matches argv arity exactly; this caller also
        // carries `--verbose`, so an arity check here would refuse a correct invocation. Asserted so
        // a future tightening toward the sibling's shape has to break a test that says why.
        expect(resolveWith(['--verbose', TARGET_ROOT_FLAG, ENGINE_ROOT])).toBe(ENGINE_ROOT);
        expect(resolveWith([TARGET_ROOT_FLAG, ENGINE_ROOT, '--verbose'])).toBe(ENGINE_ROOT)
    });

    test('NEGATIVE CONTROL: no flag refuses rather than falling back to cwd', () => {
        // The whole defect in one assertion. Before the split, an absent binding resolved to ambient
        // cwd and *happened* to be right; ADR 0040 §2.5 forbids restoring that, and a fallback here
        // is how it would come back — silently, and only wrong on the scheduled path.
        expect(() => resolveWith([])).toThrow(/target repository root is required explicitly/);
        expect(() => resolveWith([])).toThrow(/never a target-root fallback/)
    });

    test('NEGATIVE CONTROL: the flag without a path refuses', () => {
        // The shape a forgotten path actually produces on a command line, rather than an absent flag.
        expect(() => resolveWith([TARGET_ROOT_FLAG])).toThrow(/without a path/);
        expect(() => resolveWith([TARGET_ROOT_FLAG, '--verbose'])).toThrow(/without a path/);
        expect(() => resolveWith([TARGET_ROOT_FLAG, '   '])).toThrow(/without a path/)
    });

    test('NEGATIVE CONTROL: a target aliasing this repository refuses', () => {
        expect(() => resolveWith([TARGET_ROOT_FLAG, BRAIN_ROOT]))
            .toThrow(/aliases agentosRuntimeRoot/)
    });

    test('NEGATIVE CONTROL: a directory that is not the Engine package refuses', () => {
        // A path check alone would accept any tree holding `resources/content` — a stale clone, a
        // sibling repo. Emission into the wrong repository is not recoverable by inspection.
        expect(() => resolveWith([TARGET_ROOT_FLAG, '/repos/devindex'], {
            readPackageJson: () => ({name: 'devindex'})
        })).toThrow(/must identify the Engine package/);

        expect(() => resolveWith([TARGET_ROOT_FLAG, '/repos/nowhere'], {
            readPackageJson: () => { throw new Error('ENOENT') }
        })).toThrow(/cannot read target package.json/)
    });

    test('an unreadable runtime root refuses', () => {
        expect(() => resolveWith([TARGET_ROOT_FLAG, ENGINE_ROOT], {runtimeRoot: ''}))
            .toThrow(/Brain runtime root is unavailable/)
    });
});

test.describe('corpus preflight: the target must already hold a corpus (#289)', () => {
    test('a target holding resources/content passes and reports the corpus root', () => {
        expect(assertTargetHoldsCorpus({targetRoot: ENGINE_ROOT, directoryExists: () => true}))
            .toBe('/repos/neo/resources/content')
    });

    test('NEGATIVE CONTROL: a corpus-less target refuses and never creates the tree', () => {
        // This is the AC that matters most, and it is not about crashing. Emission into a fresh tree
        // would SUCCEED: three facets written with current timestamps into a directory belonging to
        // no repository. Every instrument we have reads that as healthier than the frozen corpus it
        // replaced, because staleness is the only signal a corpus emits about its own provenance.
        let created = 0;

        expect(() => assertTargetHoldsCorpus({
            targetRoot     : ENGINE_ROOT,
            directoryExists: () => { created++; return false }
        })).toThrow(/has never held a corpus/);

        // The predicate was consulted; nothing tried to make the answer true.
        expect(created).toBe(1)
    });

    test('a file at the corpus path is not a corpus', () => {
        expect(() => assertTargetHoldsCorpus({targetRoot: ENGINE_ROOT, directoryExists: () => false}))
            .toThrow(/does not exist/)
    });
});

test.describe('the bound entrypoint keeps the guarded delegate intact (#289)', () => {
    test('cwd is set only AFTER both refusals, and only from the resolved binding', () => {
        // Ordering is the property, and it is not observable from the exports: a chdir placed before
        // either refusal would still pass every assertion above while re-promoting ambient cwd on
        // the failure path. Read from source for the same reason `syncGithubWorkflow.spec.mjs`
        // reads its ordering from source — importing this entry would chdir the test process.
        const
            source     = readFileSync(ENTRY, 'utf8'),
            resolveIdx = source.indexOf('resolveEmissionTargetRoot({'),
            assertIdx  = source.indexOf('assertTargetHoldsCorpus({targetRoot})'),
            chdirIdx   = source.indexOf('process.chdir(targetRoot)'),
            importIdx  = source.indexOf("await import('./syncGithubWorkflow.mjs')");

        expect(resolveIdx, 'target-root resolution must exist').toBeGreaterThan(-1);
        expect(assertIdx,  'corpus preflight must exist').toBeGreaterThan(-1);
        expect(chdirIdx,   'the binding must be applied').toBeGreaterThan(-1);
        expect(importIdx,  'the delegate must load AFTER the binding').toBeGreaterThan(-1);

        expect(resolveIdx).toBeLessThan(assertIdx);
        expect(assertIdx).toBeLessThan(chdirIdx);
        expect(chdirIdx).toBeLessThan(importIdx);

        // `process.chdir` appears exactly once: a second site is how a "convenience" restore or an
        // early cd creeps back in.
        expect(source.match(/process\.chdir\(/g)).toHaveLength(1)
    });

    test('the entry is import-safe: no chdir and no emission on import', () => {
        const source = readFileSync(ENTRY, 'utf8');

        expect(source).toContain("if (cliEntryPath && cliEntryPath === modulePath) {");
        // `main()` is invoked once, inside the gate.
        expect(source.match(/main\(\)\.catch\(/g)).toHaveLength(1)
    });

    test('the delegate is loaded dynamically HERE and stays statically imported THERE', () => {
        // The constraint that shaped this whole design. `syncGithubWorkflowImportException.spec.mjs`
        // walks the STATIC graph of `syncGithubWorkflow.mjs` and asserts `walked > 50` against a
        // measured 63, to prove the SDK-boundary exception still keeps `chromadb` out of the hourly
        // stage. Applying the binding inside that file would have meant making its config/service
        // imports dynamic, collapsing that walk and blinding a guard that catches a real failure —
        // which is why the binding lives in a separate entry instead.
        const delegate = readFileSync(
            resolve(REPO_ROOT, 'ai/scripts/maintenance/syncGithubWorkflow.mjs'), 'utf8'
        );

        for (const specifier of [
            "import GH_Config      from '../../mcp/server/github-workflow/config.mjs'",
            "import GH_SyncService from '../../services/github-workflow/SyncService.mjs'",
            "import AiConfig       from '../../config.mjs'"
        ]) {
            expect(
                delegate,
                'a static import moved out of syncGithubWorkflow.mjs — the import-exception walk ' +
                'is calibrated on this graph and goes vacuous when it shrinks'
            ).toContain(specifier)
        }

        expect(delegate).not.toContain("await import('../../mcp/server/github-workflow/config.mjs')")
    });

    test('the delegate accepts an injected mode while its argv defaults are unchanged', () => {
        const delegate = readFileSync(
            resolve(REPO_ROOT, 'ai/scripts/maintenance/syncGithubWorkflow.mjs'), 'utf8'
        );

        expect(delegate).toContain("emitOnly = process.argv.includes('--emit-only')");
        expect(delegate).toContain("verbose  = process.argv.includes('--verbose')");
        expect(readFileSync(ENTRY, 'utf8')).toContain('syncGithubWorkflow({emitOnly: true')
    })
});

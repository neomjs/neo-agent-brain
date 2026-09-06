import {execFile, execFileSync} from 'node:child_process';
import fs                       from 'node:fs';
import path                     from 'node:path';
import process                  from 'node:process';

/**
 * Pre-Flight (structural fast-path): `ai/scripts/diagnostics/check-runtime-root.mjs` matches the
 * sibling pattern of `ai/scripts/diagnostics/check-retired-primitives.mjs` and
 * `ai/scripts/diagnostics/mcpHealthcheck.mjs` — mechanical host/substrate validation invoked as
 * `npm run ai:check-runtime-root`. Sibling-file-lift applies; no novel directory choice.
 *
 * @summary Proves an `agentosRuntimeRoot` owns its dependency closure, and that the host daemons
 * installed against it can actually resolve their module graphs.
 *
 * ADR 0040 §2.5 names two root authorities: `agentosRuntimeRoot` (where the Agent OS is installed
 * and runs) and `targetRepoRoot` (the checkout it operates ON). This guard defends the first one.
 *
 * **The failure it exists to catch** (neomjs/neo-agent-brain#335). A machine's LaunchAgents were
 * pinned to a frozen snapshot whose `node_modules` was a SYMLINK into an agent seat's separate
 * checkout. When the Agent OS extraction removed `dotenv` from that other repository, the seat's
 * next install pruned the package — and the machine's host-edge daemon died with
 * `ERR_MODULE_NOT_FOUND`, 4,648 times over 42 hours, with no relationship to any change in this
 * repository. Inference went down for every seat on the host at the following reboot.
 *
 * **Why a structural check alone is not enough.** The prescribing guide already warns that an
 * Engine clone "installs cleanly and never launches". That guard would have passed this machine
 * every single day: the root WAS launching, correctly, for weeks. The defect was latent in the
 * dependency closure, not visible in the file layout — so this script ends with an executed
 * resolution probe rather than a directory inspection. A green layout is never the whole property.
 *
 * **Why importing an entrypoint is safe.** Both `ai/daemons/orchestrator/hostEdge.mjs` and
 * `ai/daemons/wake/receiver.mjs` gate their boot behind
 * `process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href`. Imported from
 * `node -e`, `process.argv[1]` is undefined, so the module graph resolves and nothing starts. The
 * probe therefore exercises exactly the import that failed, without supervising anything.
 *
 * **Bound of the probe, stated so a reader does not over-read a green.** It resolves each
 * entrypoint's OWN module graph. Modules an entrypoint imports lazily after its boot guard — the
 * orchestrator's `./daemon.mjs`, for instance — are not reached. The 2026-09-04 outage was in
 * `hostEdge.mjs`'s own top-level `import 'dotenv/config'`, so it is covered; a prune reaching only
 * a lazily-imported package is not, and closing that needs a boot, which a check may not do.
 *
 * Usage:
 *   npm run ai:check-runtime-root                 # audit the installed host LaunchAgents (macOS)
 *   npm run ai:check-runtime-root -- --root .     # audit one explicit root
 *
 * @see learn/agentos/decisions/0040-agentos-extraction-topology.md §2.5 Two root authorities, never one
 * @see ai/scripts/lifecycle/local-agent-os/README.md
 */

/**
 * @summary launchd labels this host installs, paired with the entrypoint each one runs.
 *
 * The entrypoint is repeated here rather than parsed out of `ProgramArguments` because the plist's
 * argument vector is the thing under audit: a plist naming a script this repository does not own is
 * itself the finding, and a parser that simply believed it could not report that.
 * @type {Object[]}
 */
const HOST_AGENTS = [
    {label: 'com.neomjs.agent-os-host-edge', entrypoint: 'ai/daemons/orchestrator/hostEdge.mjs'},
    {label: 'com.neomjs.agent-os-wake',      entrypoint: 'ai/daemons/wake/receiver.mjs'}
];

/**
 * @summary Reads one key from a plist, or null when the file or key is absent.
 * @param {String} plistPath Absolute path to the plist.
 * @param {String} key Key to extract.
 * @returns {String|null}
 */
function readPlistKey(plistPath, key) {
    if (!fs.existsSync(plistPath)) {
        return null;
    }

    try {
        return execFileSync('plutil', ['-extract', key, 'raw', plistPath], {encoding: 'utf8'}).trim();
    } catch {
        return null;
    }
}

/**
 * @summary Resolves an entrypoint's module graph from a root, WITHOUT starting it.
 *
 * Runs in a child process so a resolution failure is observed as an exit code and a message rather
 * than taking this script down with it.
 *
 * @param {String} root Directory used as the child's cwd — the root under audit.
 * @param {String} entrypoint Root-relative module specifier.
 * @returns {Promise<{ok: Boolean, detail: String}>}
 */
function probeResolution(root, entrypoint) {
    const target = path.join(root, entrypoint);

    return new Promise(resolve => {
        execFile(
            process.execPath,
            ['--input-type=module', '-e', `await import(${JSON.stringify(target)})`],
            {cwd: root, timeout: 30000},
            (error, stdout = '', stderr = '') => {
                if (!error) {
                    resolve({ok: true, detail: 'module graph resolved'});
                    return;
                }

                const missing = /Cannot find package '([^']+)'/.exec(stderr);

                resolve({
                    ok    : false,
                    detail: missing
                        ? `unresolved dependency '${missing[1]}' — the root does not own its closure`
                        : (stderr.trim().split('\n')[0] || `exited ${error.code}`)
                });
            }
        );
    });
}

/**
 * @summary Audits one runtime root and returns its findings.
 *
 * Ordered cheapest-first, and every check still runs: a reader repairing this wants the whole
 * picture, not the first thing that broke.
 *
 * @param {String} root Absolute path to the candidate `agentosRuntimeRoot`.
 * @param {String[]} entrypoints Root-relative entrypoints expected to resolve from it.
 * @returns {Promise<String[]>} Findings; empty means sound.
 */
async function auditRoot(root, entrypoints) {
    const findings = [];

    if (!fs.existsSync(root)) {
        return [`root does not exist: ${root}`];
    }

    const modulesPath = path.join(root, 'node_modules');

    if (!fs.existsSync(modulesPath)) {
        findings.push('no node_modules — the root was never installed (`npm ci`)');
    } else {
        // BOTH sides are realpath'd. Resolving only one produces a false positive wherever the
        // root itself sits under a symlinked prefix — on macOS that includes `/tmp` and
        // `/var/folders`, so a check comparing a resolved path against an unresolved one REDs on
        // every temp-dir fixture and on any host whose install path crosses a link.
        const real = fs.realpathSync(modulesPath),
              own  = path.join(fs.realpathSync(root), 'node_modules');

        // The mechanism behind #335: the closure belonged to a tree any seat could reinstall.
        if (real !== own) {
            findings.push(
                `node_modules resolves OUTSIDE the root -> ${real}\n` +
                '  the root shares another checkout\'s dependency closure; that tree\'s next ' +
                'install can prune this daemon\'s packages'
            );
        }
    }

    for (const entrypoint of entrypoints) {
        if (!fs.existsSync(path.join(root, entrypoint))) {
            findings.push(`entrypoint missing from this root: ${entrypoint}`);
            continue;
        }

        const {ok, detail} = await probeResolution(root, entrypoint);

        if (!ok) {
            findings.push(`${entrypoint}: ${detail}`);
        }
    }

    return findings
}

/**
 * @summary Entry point: audits an explicit `--root`, or every installed host LaunchAgent.
 * @returns {Promise<void>}
 */
async function main() {
    const rootFlag = process.argv.indexOf('--root'),
          targets  = [];

    if (rootFlag !== -1 && process.argv[rootFlag + 1]) {
        targets.push({
            label      : 'explicit --root',
            root       : path.resolve(process.argv[rootFlag + 1]),
            entrypoints: HOST_AGENTS.map(agent => agent.entrypoint)
        });
    } else if (process.platform !== 'darwin') {
        console.log('ℹ️  SKIP: LaunchAgent audit is macOS-only. Pass --root <path> to audit a root directly.');
        process.exit(0);
    } else {
        for (const {label, entrypoint} of HOST_AGENTS) {
            const plistPath = path.join(process.env.HOME, 'Library', 'LaunchAgents', `${label}.plist`),
                  root      = readPlistKey(plistPath, 'WorkingDirectory');

            if (root) {
                targets.push({label, root, entrypoints: [entrypoint]});
            }
        }

        if (targets.length === 0) {
            console.log('ℹ️  SKIP: no Neo host LaunchAgents installed on this machine.');
            process.exit(0);
        }
    }

    const failures = [];

    for (const {label, root, entrypoints} of targets) {
        const findings = await auditRoot(root, entrypoints);

        console.log(`${findings.length === 0 ? '✅' : '❌'} ${label}`);
        console.log(`    root: ${root}`);

        if (findings.length > 0) {
            failures.push({label, root, findings});
        }
    }

    console.log('-'.repeat(80));

    if (failures.length === 0) {
        console.log('✅ PASS: every runtime root owns its dependency closure and resolves its entrypoints.');
        console.log('    ADR 0040 §2.5 `agentosRuntimeRoot` holds.\n');
        process.exit(0);
    }

    console.error('\n❌ FAIL: an Agent OS runtime root is not self-contained:\n');

    for (const {label, root, findings} of failures) {
        console.error(`  ▸ ${label}`);
        console.error(`      ${root}`);
        findings.forEach(finding => console.error(`      - ${finding}`));
        console.error('');
    }

    console.error('  Repair: install the Agent OS at a root no agent seat owns, give it its own');
    console.error('  `npm ci`, and point the LaunchAgents there. See');
    console.error('  ai/scripts/lifecycle/local-agent-os/README.md and ADR 0040 §2.5.\n');
    process.exit(1);
}

main();

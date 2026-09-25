import {spawnSync}                              from 'node:child_process';
import {existsSync, readFileSync, realpathSync} from 'node:fs';
import path                                     from 'node:path';
import process                                  from 'node:process';
import {fileURLToPath}                          from 'node:url';

const
    __filename = fileURLToPath(import.meta.url),
    repoRoot   = path.resolve(path.dirname(__filename), '../../..');

/**
 * @module ai/scripts/setup/prepare
 * @summary The Brain's npm `prepare` lifecycle: the per-clone config bootstrap, then the skills
 * façade — the second guarded to this checkout, the way the engine guards its own
 * (`neomjs/neo buildScripts/util/prepare.mjs`).
 *
 * The materializer used to run from `postinstall`. npm runs a dependency's `postinstall` inside
 * every consumer's install, and `neo-agent-skills-materialize` resolves its target from `INIT_CWD`,
 * the consumer's root — so every consumer that installed the Brain got the Brain's skills façade
 * written into ITS `.agents/skills` / `.claude/skills`, and the Institution's pack stage died on
 * the symlink race between that write and its own (#482). A registry or tarball install never
 * runs `prepare`; a git-dependency install runs it in a cache clone with `INIT_CWD` naming the
 * consumer's root, which {@link isDependencyBuild} recognises and skips.
 *
 * The config bootstrap is NOT guarded: `initServerConfigs.mjs` writes the per-clone `ai/config.mjs`
 * files inside this package, never into the consumer, and a nested Brain that runs from a consumer's
 * `node_modules` needs them.
 */

/**
 * @summary The lifecycle stages, in order. The config stage is this repository's own script; the
 * materialize stage names the dependency whose manifest declares the bin it runs, so a failed stage
 * reports which tool failed.
 * @type {{stage: String, guarded: Boolean, resolve: Function}[]}
 */
const stages = [
    {stage: 'configs',     guarded: false, resolve: root => [process.execPath, [path.join(root, 'ai/scripts/setup/initServerConfigs.mjs')]]},
    {stage: 'materialize', guarded: true,  resolve: root => [process.execPath, [resolvePackageBin('neo-agent-skills', 'neo-agent-skills-materialize', root)]]}
];

/**
 * @summary A package's bin entrypoint, resolved from its own `bin` declaration — never a PATH shim,
 * so the script behaves identically under cmd.exe, PowerShell and POSIX shells.
 * @param {String} packageName
 * @param {String} binName
 * @param {String} [root=repoRoot]
 * @returns {String}
 */
export function resolvePackageBin(packageName, binName, root=repoRoot) {
    const packagePath = path.join(root, 'node_modules', packageName, 'package.json');

    if (!existsSync(packagePath)) {
        throw new Error(`prepare: ${packageName} package not found at '${packagePath}' — run with the repo's dependencies installed`);
    }

    let bin;

    try {
        bin = JSON.parse(readFileSync(packagePath, 'utf8')).bin;
    } catch (error) {
        throw new Error(`prepare: cannot parse ${packageName}'s package.json at '${packagePath}' (${error.message})`);
    }

    const entry = typeof bin === 'string' ? bin : bin?.[binName];

    if (typeof entry !== 'string' || entry.length === 0) {
        throw new Error(`prepare: ${packageName}'s package.json declares no bin entry '${binName}' at '${packagePath}'`);
    }

    const candidate = path.join(root, 'node_modules', packageName, entry);

    if (!existsSync(candidate)) {
        throw new Error(`prepare: ${packageName} entrypoint '${entry}' not found at '${candidate}' — the package is present but its bin target is missing`);
    }

    return candidate
}

/**
 * @summary Is this `prepare` running inside a consumer's install rather than this checkout's own?
 * npm hands every lifecycle script `INIT_CWD`, the directory the top-level command was invoked
 * from: this checkout under its own `npm install` / `npm ci` / `npm run prepare`, a foreign
 * directory when npm builds this repository as a git dependency in a cache clone. Paths compare by
 * identity (realpath), so a symlinked checkout is still its own root.
 * @param {Object} options
 * @param {Object} options.env
 * @param {String} options.root
 * @returns {Boolean}
 */
export function isDependencyBuild({env, root}) {
    const identity = dir => {
        const resolved = path.resolve(dir);

        try {
            return realpathSync(resolved)
        } catch {
            return resolved
        }
    };

    return Boolean(env.INIT_CWD) && identity(env.INIT_CWD) !== identity(root)
}

/**
 * @summary Runs the prepare lifecycle: the lock-only guard, then each stage in order — a guarded
 * stage is skipped inside a dependency build — stopping at the first failure. Seams are injected so
 * the contract is testable without writing configs or links.
 * @param {Object} [options]
 * @param {String} [options.root=repoRoot]
 * @param {Object} [options.env=process.env]
 * @param {Function} [options.spawnFn=spawnSync]
 * @returns {{skipped: String[], stage: String, status: Number}}
 */
export function runPrepare({root=repoRoot, env=process.env, spawnFn=spawnSync}={}) {
    if (env.npm_config_package_lock_only === 'true') {
        return {skipped: ['package-lock-only'], stage: 'guard', status: 0}
    }

    const
        dependencyBuild = isDependencyBuild({env, root}),
        skipped         = [];

    for (const {stage, guarded, resolve} of stages) {
        if (guarded && dependencyBuild) {
            skipped.push(stage);
            continue
        }

        const
            [file, args] = resolve(root),
            result       = spawnFn(file, args, {cwd: root, env, stdio: 'inherit'});

        // A failure-to-LAUNCH is not a status: spawnSync signals it through `result.error` with
        // `status: null`, and with `stdio: 'inherit'` no child exists to print anything.
        if (result.error) {
            console.error(`prepare: ${stage} failed to launch — ${result.error.message}`);
            return {skipped, stage, status: 1}
        }

        if (result.status !== 0) {
            console.error(`prepare: ${stage} exited with status ${result.status}`);
            return {skipped, stage, status: result.status ?? 1}
        }
    }

    return {skipped, stage: 'done', status: 0}
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
    process.exitCode = runPrepare().status
}

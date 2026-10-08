import {assertRoot, deriveAgentRepoPath} from './deriveAgentRepoPath.mjs';
import {ensureSeatRoot}                  from './ensureSeatRoot.mjs';
import {inspectAgentRepo}                from './inspectAgentRepo.mjs';
import {provisionAgentRepo}              from './provisionAgentRepo.mjs';
import {execFile}                        from 'node:child_process';
import fs                                from 'node:fs/promises';
import path                              from 'node:path';
import {promisify}                       from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * @summary Ensure an agent's managed repo checkout exists — the single Fleet Manager entry point that
 * composes the repo-provisioning trio (derive the path → inspect the state → provision the action).
 *
 * Given an agent + repo + the managed root + a clone URL, this derives the stable checkout path,
 * inspects what is on disk, and carries out the provisioning decision WITHOUT clobbering:
 * - an absent / empty path → clones `cloneUrl` into it;
 * - an existing valid checkout → reuses it as-is (no reclone — Fleet Manager auto-memory is path-keyed);
 * - a foreign occupant (a file, a non-empty non-checkout, a symlink) → throws (never overwrite).
 *
 * Each step's contract is inherited from its primitive: `deriveAgentRepoPath` validates the inputs +
 * computes a stable, collision-free, traversal-safe path; `inspectAgentRepo` classifies the on-disk
 * state read-only; `provisionAgentRepo` executes via an injectable clone seam. The `cloneRepo` seam is
 * passed through so the composed flow is unit-testable without a git binary; the default (un-injected)
 * path runs a real `git clone`.
 *
 * The managed root is made owner-only first ({@link Neo.ai.services.fleet.ensureSeatRoot}): a clone
 * would otherwise create it with the process umask, and the harness homes beside the checkouts hold
 * logins. It is the root as the derivation resolves it (`assertRoot`), so a spelling the filesystem
 * reads differently (a symlink before `..`) cannot secure one directory and clone into another.
 *
 * Fleet Manager is single-writer (Scenario-C-zero per the MVP epic), so the inspect→provision sequence
 * is not TOCTOU-guarded — and does not need to be: `git clone` fails safe if the directory changed
 * underneath, and no second writer races the same checkout.
 *
 * @param {Object}    options
 * @param {String}    options.managedRoot The absolute, trusted fleet-managed checkout root.
 * @param {String}    options.agentId     The Fleet Manager agent id.
 * @param {String}    options.repoSlug    The repo identifier, e.g. `'neomjs/neo'`.
 * @param {String}   [options.cloneUrl]   The clone source (required only when a clone is needed).
 * @param {String}   [options.credential]       The seat's PAT, which a clone on its origin authenticates with.
 * @param {String}   [options.credentialOrigin] The origin the PAT was stored for; omitted means GitHub's.
 * @param {Function} [options.cloneRepo]        `(cloneUrl, repoPath, {credential, credentialOrigin}) => Promise<void>` —
 *                                              the clone executor; defaults to a real `git clone`, injectable for tests.
 * @returns {Promise<{repoPath: String, state: String, action: String, cloned: Boolean}>}
 *   `repoPath` is the derived checkout path; `state` is the inspected on-disk state; `action` ∈
 *   `'cloned' | 'reused'`; `cloned` is `true` only when a clone ran.
 * @throws {Error} On invalid `managedRoot` / `agentId` / `repoSlug` (from derivation), a conflicting
 *   occupant, or a missing `cloneUrl` when a clone is required.
 */
export async function ensureAgentRepo({managedRoot, agentId, repoSlug, cloneUrl, credential, credentialOrigin, cloneRepo} = {}) {
    const repoPath = deriveAgentRepoPath({managedRoot, agentId, repoSlug});

    ensureSeatRoot(assertRoot(managedRoot, 'managedRoot', 'ensureAgentRepo'));

    const
        inspection = inspectAgentRepo({repoPath}),
        result     = await provisionAgentRepo({
            repoPath,
            provisioningAction: inspection.provisioningAction,
            cloneUrl,
            credential,
            credentialOrigin,
            cloneRepo
        });

    return {repoPath, state: inspection.state, action: result.action, cloned: result.cloned};
}

/**
 * @summary Verify the origin and persisted trust root of an assigned checkout without changing it.
 * Provisioning may reuse a checkout by presence alone; a native trust grant needs this stronger proof.
 * A linked worktree is not allowed to grant trust to its unassigned main checkout. Git overrides are
 * excluded, and failures never echo a remote URL or Git stderr, either of which may contain credentials.
 * @param {Object} options
 * @param {String} options.repoPath The assigned checkout's absolute path.
 * @param {String} options.cloneUrl Its declared clone remote.
 * @param {Function} [options.execute=execFileAsync] Node's promisified subprocess boundary; used only for Git reads.
 * @returns {Promise<{state: String, root?: String, reason?: String}>}
 */
export async function verifyAgentRepoTrust({repoPath, cloneUrl, execute = execFileAsync}) {
    const refused = reason => ({state: 'unverified', reason});

    if (!path.isAbsolute(repoPath || '') || !remoteIdentity(cloneUrl)) {
        return refused('the assignment has no verifiable checkout and remote')
    }

    try {
        const root = await fs.realpath(repoPath);

        if (root !== path.resolve(repoPath)) return refused('the checkout path crosses a symlink');

        const
            env                      = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
            git                      = async args => (await execute('git', args, {cwd: root, env, timeout: 10000, maxBuffer: 65536})).stdout,
            [top, origin, worktrees] = await Promise.all([
                git(['rev-parse', '--show-toplevel']),
                git(['remote', 'get-url', 'origin']),
                git(['worktree', 'list', '--porcelain', '-z'])
            ]),
            main = worktrees.split('\0')[0];

        if (await fs.realpath(top.trim()) !== root) return refused('the assigned path is not a repository root');
        if (remoteIdentity(origin.trim()) !== remoteIdentity(cloneUrl)) return refused('the checkout origin differs from the assignment');
        if (!main.startsWith('worktree ') || await fs.realpath(main.slice(9)) !== root) {
            return refused('the worktree would grant trust to a different main checkout')
        }

        return {state: 'verified', root}
    } catch {
        return refused('the checkout identity could not be verified')
    }
}

/** @summary Normalize a credential-free forge remote without guessing cross-transport equivalence. @private */
function remoteIdentity(value) {
    if (typeof value !== 'string' || /[\s?#]/.test(value)) return null;

    const scp = /^git@([^/:]+):(.+)$/.exec(value);

    try {
        const url = new URL(scp ? `ssh://git@${scp[1]}/${scp[2]}` : value);

        if (!['https:', 'ssh:'].includes(url.protocol) || url.password ||
            (url.username && (url.protocol !== 'ssh:' || url.username !== 'git'))) return null;

        return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '').replace(/\.git$/, '')}`
    } catch {
        return null
    }
}

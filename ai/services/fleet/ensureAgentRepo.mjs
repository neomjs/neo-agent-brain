import {assertRoot, deriveAgentRepoPath}      from './deriveAgentRepoPath.mjs';
import {ensureSeatRoot}                       from './ensureSeatRoot.mjs';
import {inspectAgentRepo}                     from './inspectAgentRepo.mjs';
import {gitRemoteCommand, provisionAgentRepo} from './provisionAgentRepo.mjs';
import {redactReadFailure}                    from './redactReadFailure.mjs';
import {execFile}                             from 'node:child_process';
import fs                                     from 'node:fs/promises';
import os                                     from 'node:os';
import path                                   from 'node:path';
import {promisify}                            from 'node:util';

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
 * @summary Ensures the ordered additional-repository list for Start or a running launch. One failed
 * checkout becomes a redacted row; the remaining entries continue. Ownership is checked around
 * awaits, but an already dispatched clone is not interrupted or rolled back.
 * @param {Object} options
 * @param {Object[]} options.repos Declared additional repositories, excluding the working checkout.
 * @param {String} options.managedRoot Trusted checkout root.
 * @param {String} options.agentId
 * @param {String} [options.credential]
 * @param {String} [options.credentialOrigin]
 * @param {'start'|'prepare'} options.via The operation producing the rows.
 * @param {Function} [options.ensureRepo=ensureAgentRepo] Single-checkout seam.
 * @param {Function} [options.cloneRepo] Clone seam forwarded unchanged.
 * @param {Function} [options.onEnsured] Optional post-clone work before a row is prepared.
 * @param {Function} [options.isCurrent] Ownership check; Start may throw its cancellation here.
 * @param {Function} [options.now] ISO observation clock.
 * @returns {Promise<{repos: Object[], checkouts: Object[], current: Boolean}>}
 */
export async function ensureAgentRepos({repos, managedRoot, agentId, credential, credentialOrigin, via,
    ensureRepo = ensureAgentRepo, cloneRepo, onEnsured, isCurrent = () => true, now = () => new Date().toISOString()}) {
    const rows = [], checkouts = [];

    for (const {repoSlug, cloneUrl} of repos) {
        if (!isCurrent()) return {repos: rows, checkouts, current: false};

        let ensured, reason;

        try {
            ensured = await ensureRepo({managedRoot, agentId, repoSlug, cloneUrl, credential, credentialOrigin, cloneRepo})
        } catch (error) {
            reason = redactReadFailure(error) ?? 'no legible error'
        }

        if (!isCurrent()) {
            rows.push({repoSlug, state: 'failed', reason: 'the launch changed before repository preparation completed', via, at: now()});
            return {repos: rows, checkouts, current: false}
        }

        if (ensured && onEnsured) {
            try {
                await onEnsured({repoSlug, cloneUrl, ...ensured})
            } catch (error) {
                reason = redactReadFailure(error) ?? 'no legible error'
            }
        }

        if (!reason) checkouts.push({repoSlug, cloneUrl, repoPath: ensured.repoPath});
        rows.push({repoSlug, state: reason ? 'failed' : 'prepared', ...(reason ? {reason} : {}), via, at: now()});
        if (!isCurrent()) return {repos: rows, checkouts, current: false};
    }

    return {repos: rows, checkouts, current: isCurrent()}
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

/**
 * The only variables a fast-forward's `git` inherits from the Fleet, whose environment carries plane, forge and
 * bridge credentials. `PATH` finds `git` itself.
 * @type {String[]}
 * @private
 */
const FAST_FORWARD_ENV = ['HOME', 'LANG', 'LOGNAME', 'PATH', 'TMPDIR', 'USER'];

/**
 * The bound on a fast-forward's fetch. Past it `git` is stopped and the checkout stays where it was.
 * @type {Number}
 */
export const FETCH_TIMEOUT_MS = 120_000;

/**
 * @summary Moves a reused checkout to its remote's default branch before the harness starts, when that moves nothing
 * a seat wrote.
 *
 * The checkout must pass {@link verifyAgentRepoTrust}, sit on the branch `origin/HEAD` names, carry no change to a
 * tracked file and hold no commit its remote lacks. Anything else is `skipped`, with the reason. Untracked files need
 * no check of their own: the merge runs with `--no-overwrite-ignore`, so it refuses to replace a seat's file, ignored
 * or not, and the checkout stays where it was. The fetch goes to the declared `cloneUrl`, and the
 * seat's PAT reaches it only the way a clone carries it (`provisionAgentRepo.gitCloneCommand`). The checkout is the
 * seat's to write and the Fleet's credentials are not, so its hooks and filesystem monitor never run, and `git` reads
 * no host config and inherits only {@link FAST_FORWARD_ENV}.
 *
 * The outcome is data, never a throw, and a failure's reason is credential-redacted and bounded.
 * @param {Object}      options
 * @param {String}      options.repoPath           The checkout's absolute path.
 * @param {String}      options.cloneUrl           Its declared remote.
 * @param {String}      [options.credential]       The seat's PAT
 * @param {String}      [options.credentialOrigin] The origin the PAT was stored for; omitted means GitHub's.
 * @param {AbortSignal} [options.signal]           The Start's signal; aborting it stops `git`.
 * @param {Object}      [options.env=process.env]  The Fleet's environment.
 * @param {Function}    [options.execute=execFileAsync] Node's promisified subprocess boundary.
 * @param {Function}    [options.verifyTrust=verifyAgentRepoTrust]
 * @returns {Promise<{state: 'fast-forwarded'|'up-to-date'|'skipped'|'failed', reason?: String, from?: String, to?: String}>}
 */
export async function fastForwardAgentRepo({repoPath, cloneUrl, credential, credentialOrigin, signal, env = process.env,
    execute = execFileAsync, verifyTrust = verifyAgentRepoTrust}) {
    const trust = await verifyTrust({repoPath, cloneUrl});

    if (trust.state !== 'verified') return {state: 'skipped', reason: trust.reason};

    const
        childEnv = {
            ...Object.fromEntries(FAST_FORWARD_ENV.filter(name => env[name] != null).map(name => [name, env[name]])),
            GIT_CONFIG_GLOBAL  : os.devNull,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_TERMINAL_PROMPT: '0'
        },
        noSeatPrograms = ['-c', `core.hooksPath=${os.devNull}`, '-c', 'core.fsmonitor=false'],
        git            = async (args, {env: commandEnv = childEnv, timeout = 10000} = {}) => (await execute('git',
            [...noSeatPrograms, ...args], {cwd: trust.root, env: commandEnv, signal, timeout, maxBuffer: 1 << 20})).stdout.trim(),
        optional       = args => git(args).catch(() => '');

    try {
        const
            branch   = (await optional(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).replace(/^refs\/remotes\/origin\//, ''),
            current  = await optional(['symbolic-ref', '--quiet', '--short', 'HEAD']),
            tracking = `refs/remotes/origin/${branch}`;

        if (!branch)            return {state: 'skipped', reason: 'the checkout records no default branch'};
        if (current !== branch) return {state: 'skipped', reason: current ? `on ${current}, not ${branch}` : 'a detached HEAD'};

        if (await git(['status', '--porcelain', '--untracked-files=no'])) return {state: 'skipped', reason: 'tracked files have changes'};

        const fetch = gitRemoteCommand(['fetch', '--quiet', '--no-tags', '--', cloneUrl, `+refs/heads/${branch}:${tracking}`],
            cloneUrl, credential, childEnv, credentialOrigin);

        await git(fetch.args, {env: fetch.env ?? childEnv, timeout: FETCH_TIMEOUT_MS});

        const [ahead, behind] = (await git(['rev-list', '--left-right', '--count', `HEAD...${tracking}`])).split(/\s+/).map(Number);

        if (ahead)   return {state: 'skipped', reason: `${ahead} local commit${ahead === 1 ? '' : 's'} its remote lacks`};
        if (!behind) return {state: 'up-to-date'};

        const from = await git(['rev-parse', '--short', 'HEAD']);

        await git(['merge', '--ff-only', '--no-overwrite-ignore', '--quiet', tracking]);

        return {state: 'fast-forwarded', from, to: await git(['rev-parse', '--short', 'HEAD'])}
    } catch (error) {
        return {state: 'failed', reason: redactReadFailure(error) ?? 'git failed with no legible error'}
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

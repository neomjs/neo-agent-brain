import {execFile}  from 'child_process';
import os          from 'os';
import path        from 'path';
import {promisify} from 'util';

const execFileAsync = promisify(execFile);

/**
 * Environment variables through which a host's Git setup reaches a child `git`: askpass programs and config
 * injected without a file. A seat's clone drops them.
 * @type {RegExp}
 * @private
 */
const HOST_GIT_ENV = /^(GIT_ASKPASS|SSH_ASKPASS|GIT_CONFIG|GIT_CONFIG_(GLOBAL|SYSTEM|NOSYSTEM|PARAMETERS|COUNT|KEY_\d+|VALUE_\d+))$/;

/**
 * The origin a seat's PAT belongs to when its registry row names no other: a GitHub PAT's.
 * @type {String}
 * @private
 */
const GITHUB_ORIGIN = 'https://github.com';

/**
 * @summary The `git` invocation of a clone: its argv and the child's environment.
 *
 * A seat's credential is presented only to the origin it was stored for: `https://github.com` for a GitHub PAT, or
 * the instance's own origin for a GitLab one, which `FleetRegistryService.defineAgent` records beside the PAT. It goes
 * through a helper scoped to that origin that reads the token from the child's environment, so the token never
 * appears in argv, where every process on the machine can read it. Both forges take `x-access-token` as the username
 * beside a token (GitLab accepts any). That clone runs outside the host's Git setup: no system or global config file,
 * no home directory (so no `~/.netrc`), no config or askpass handed down through the environment, and git never
 * prompts. So an ambient URL rewrite, header, netrc entry, credential helper or askpass can neither redirect nor
 * authenticate it. Proxy and CA settings reach it only through the environment (`HTTPS_PROXY`, `GIT_SSL_CAINFO`),
 * never through a config file. Any other remote (another origin, a URL carrying userinfo, plain `http`), or no
 * credential, is a plain clone in the process's own environment. The `--` ends git's option parsing, so a hostile
 * URL or path cannot smuggle a flag.
 * @param {String} cloneUrl
 * @param {String} repoPath
 * @param {String} [credential] The seat's PAT
 * @param {Object} [env=process.env] The environment the clone would inherit
 * @param {String} [credentialOrigin='https://github.com'] The origin the PAT was stored for
 * @returns {{args: String[], env: Object|undefined}}
 */
export function gitCloneCommand(cloneUrl, repoPath, credential, env = process.env, credentialOrigin = GITHUB_ORIGIN) {
    if (!credential || !isOriginOf(cloneUrl, credentialOrigin)) {
        return {args: ['clone', '--', cloneUrl, repoPath], env: undefined}
    }

    return {
        args: [
            '-c', 'credential.helper=',
            '-c', `credential.${credentialOrigin}.helper=!f() { echo username=x-access-token; echo "password=$NEO_SEAT_FORGE_TOKEN"; }; f`,
            'clone', '--', cloneUrl, repoPath
        ],
        env : {
            ...Object.fromEntries(Object.entries(env).filter(([name]) => !HOST_GIT_ENV.test(name))),
            HOME                : os.devNull,
            GIT_CONFIG_GLOBAL   : os.devNull,
            GIT_CONFIG_NOSYSTEM : '1',
            GIT_TERMINAL_PROMPT : '0',
            NEO_SEAT_FORGE_TOKEN: credential
        }
    }
}

/**
 * @summary Whether a clone URL addresses a seat's bound GitLab instance. An `https` URL must carry the instance's
 * exact origin, so the same host on another port is another instance. An `ssh` URL or scp-style remote
 * (`git@host:group/project.git`) matches by host alone, because SSH has its own port. Any other shape matches nothing.
 * @param {String} cloneUrl
 * @param {URL}    instance The seat's parsed `forgeHost`.
 * @returns {Boolean}
 */
export function isOnInstance(cloneUrl, instance) {
    if (typeof cloneUrl !== 'string') return false;

    const scpHost = cloneUrl.match(/^[^@/:]+@(\[[^\]]+\]|[^/:]+):/)?.[1];

    try {
        // a non-special scheme normalizes an IPv6 host but keeps a DNS name's case
        if (scpHost) return new URL(`ssh://${scpHost}`).hostname.toLowerCase() === instance.hostname;

        const url = new URL(cloneUrl);

        if (url.protocol === 'https:') return url.origin === instance.origin;

        return url.protocol === 'ssh:' && url.hostname.toLowerCase() === instance.hostname
    } catch {
        return false
    }
}

/**
 * @summary Whether a clone URL is an `https` URL with no userinfo on exactly this origin.
 * @param {String} cloneUrl
 * @param {String} origin
 * @returns {Boolean}
 * @private
 */
function isOriginOf(cloneUrl, origin) {
    try {
        const url = new URL(cloneUrl);

        return url.protocol === 'https:' && !url.username && !url.password && url.origin === origin
    } catch {
        return false
    }
}

/**
 * Default clone executor: a real `git clone` as {@link gitCloneCommand} builds it. Overridden via the
 * `cloneRepo` seam in tests so the provisioning contract is exercised without a git binary or network —
 * mirroring `FleetLifecycleService`'s default-real `spawnFn` seam.
 * @param {String} cloneUrl
 * @param {String} repoPath
 * @param {Object} [options]
 * @param {String} [options.credential]       The seat's PAT
 * @param {String} [options.credentialOrigin] The origin it was stored for; omitted means GitHub's
 * @returns {Promise<void>}
 * @private
 */
async function gitClone(cloneUrl, repoPath, {credential, credentialOrigin} = {}) {
    const {args, env} = gitCloneCommand(cloneUrl, repoPath, credential, process.env, credentialOrigin);

    await execFileAsync('git', args, env ? {env} : undefined);
}

/**
 * @summary Execute a Fleet Manager repo-provisioning decision — the side-effecting "act" half of the
 * read → decide → act trio, materializing (or safely declining to touch) an agent's managed checkout.
 *
 * Given an already-derived `repoPath` and the `provisioningAction` an inspector decided for it, this
 * carries it out WITHOUT clobbering:
 * - `'clone'`    → clone `cloneUrl` into the absent / empty path.
 * - `'reuse'`    → no-op: an existing valid checkout is kept as-is. Re-cloning is never correct —
 *                 Fleet Manager auto-memory is path-keyed, so it would fork the agent's memory.
 * - `'conflict'` → throw: the path holds a foreign occupant (a file, a non-empty non-checkout, a
 *                 symlink) and must never be overwritten.
 *
 * The clone is a subprocess side effect, so the executor is injectable: `cloneRepo` defaults to a real
 * `git clone` but a test passes a recording stub, so the clone / reuse / conflict contract is
 * unit-testable without a git binary or network — the same default-real + injectable seam
 * `FleetLifecycleService` uses for process spawning. Decoupled from the inspector (it takes the decided
 * `provisioningAction`, not the inspector) — the composing derive → inspect → provision orchestrator
 * is a later leaf.
 *
 * @param {Object}    options
 * @param {String}    options.repoPath           The absolute, already-derived managed checkout path.
 * @param {String}    options.provisioningAction One of `'clone'` | `'reuse'` | `'conflict'`.
 * @param {String}   [options.cloneUrl]          The clone source (required for `'clone'`).
 * @param {String}   [options.credential]        The seat's PAT, which a clone on its origin authenticates with.
 * @param {String}   [options.credentialOrigin]  The origin the PAT was stored for; omitted means GitHub's.
 * @param {Function} [options.cloneRepo=gitClone] `(cloneUrl, repoPath, {credential, credentialOrigin}) => Promise<void>` —
 *                                               the clone executor; defaults to a real `git clone`, injectable for tests.
 * @returns {Promise<{repoPath: String, action: String, cloned: Boolean}>}
 *   `action` ∈ `'cloned' | 'reused'`; `cloned` is `true` only when a clone actually ran.
 * @throws {Error} On a `'conflict'` action, an unknown action, a missing `cloneUrl` for `'clone'`, or a
 *   non-string / empty / non-absolute `repoPath`.
 */
export async function provisionAgentRepo({repoPath, provisioningAction, cloneUrl, credential, credentialOrigin, cloneRepo=gitClone} = {}) {
    if (typeof repoPath !== 'string' || repoPath.length === 0) {
        throw new Error("provisionAgentRepo: 'repoPath' must be a non-empty string.");
    }
    if (!path.isAbsolute(repoPath)) {
        throw new Error(`provisionAgentRepo: 'repoPath' must be an absolute path, received '${repoPath}'.`);
    }

    switch (provisioningAction) {
        case 'conflict':
            // The inspector found a foreign occupant — refuse rather than overwrite it.
            throw new Error(`provisionAgentRepo: refusing to provision over a conflicting occupant at '${repoPath}'.`);

        case 'reuse':
            // An existing valid checkout: keep it as-is (re-cloning would fork the path-keyed memory).
            return {repoPath, action: 'reused', cloned: false};

        case 'clone': {
            // Blank-check, not just empty-check: a whitespace-only cloneUrl must fail closed and never
            // reach the clone seam. Pass the trimmed url so accidental padding doesn't break the clone.
            const url = typeof cloneUrl === 'string' ? cloneUrl.trim() : '';
            if (!url) {
                throw new Error("provisionAgentRepo: 'cloneUrl' is required (a non-blank string) for a 'clone' action.");
            }
            await cloneRepo(url, repoPath, {credential, credentialOrigin});
            return {repoPath, action: 'cloned', cloned: true};
        }

        default:
            throw new Error(`provisionAgentRepo: unknown provisioningAction '${provisioningAction}'.`);
    }
}

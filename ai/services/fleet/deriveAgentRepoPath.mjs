import path from 'path';

/**
 * The one shape every seat path segment must have: lowercase letters, digits, `.`, `_` and `-`, at
 * most 100 characters, never a leading `-` and never `.` or `..`. Lowercase only because the default
 * macOS volume is case-insensitive: `Ada` and `ada` would otherwise share a folder.
 * @type {RegExp}
 * @private
 */
const SEGMENT = /^(?!\.{1,2}$)(?!-)[a-z0-9._-]{1,100}$/;

/**
 * The segment under an agent's folder that holds its harness homes. No clone owner may take it, so a
 * checkout can never land inside a harness home.
 * @type {String}
 */
export const HARNESS_SEGMENT = 'harness';

/**
 * The segment under an agent's folder that holds the memory the seat keeps whichever checkout it opens.
 * No clone owner may take it, so a checkout can never land inside that memory.
 * @type {String}
 */
export const MEMORY_SEGMENT = 'memory';

/**
 * What each reserved owner segment holds, for the refusal.
 * @type {Object<String, String>}
 * @private
 */
const RESERVED_OWNERS = {
    [HARNESS_SEGMENT]: "an agent's harness homes",
    [MEMORY_SEGMENT] : "an agent's memory"
};

/**
 * @summary Derive the managed checkout path of a Fleet agent's clone of a repo:
 * `<managedRoot>/<agentId>/<owner>/<repo>`, the layout a person would make by hand.
 *
 * The pure half of Fleet repo provisioning: path math only, with no fs / git / env / config access.
 * The clone / locate / health-check consumes it.
 *
 * Two invariants are load-bearing because Claude file-memory is **keyed by the checkout path**:
 * - **Stable:** identical inputs map to the identical path, so an agent's memory never forks.
 * - **Collision-free:** every segment is the raw value itself — an invalid value is refused, never
 *   rewritten — so distinct agents or repos never share a path.
 *
 * The values are untrusted (an agent id may be any explicit string), so each segment is validated by
 * {@link assertSeatSegment} and the resolved path is asserted to stay **contained** under
 * `managedRoot`.
 *
 * `managedRoot` is required, never defaulted, derived or read from env here: the composing
 * entrypoint passes the resolved `AiConfig.fleet.agentsRoot`.
 *
 * @param {Object} options
 * @param {String} options.managedRoot An absolute path to the trusted agents root.
 * @param {String} options.agentId     The Fleet agent id (untrusted).
 * @param {String} options.repoSlug    `<owner>/<repo>`, e.g. `'neomjs/neo'` (untrusted).
 * @returns {String} `<managedRoot>/<agentId>/<owner>/<repo>`, absolute, stable, contained.
 * @throws {Error} If `managedRoot` is not an absolute path, `repoSlug` is not exactly
 * `<owner>/<repo>`, a segment fails {@link assertSeatSegment}, the owner is {@link HARNESS_SEGMENT} or
 * {@link MEMORY_SEGMENT}, or (defense-in-depth) the resolved path escapes `managedRoot`.
 */
export function deriveAgentRepoPath({managedRoot, agentId, repoSlug} = {}) {
    const root = assertRoot(managedRoot, 'managedRoot', 'deriveAgentRepoPath');

    assertSeatSegment(agentId, 'agentId', 'deriveAgentRepoPath');

    const [owner, repo] = assertRepoSlug(repoSlug, 'deriveAgentRepoPath');

    return assertContained(root, path.resolve(root, agentId, owner, repo), 'deriveAgentRepoPath')
}

/**
 * @summary Refuse any repo slug that could not name a seat's checkout: exactly `<owner>/<repo>`, both
 * seat segments, and never a reserved owner ({@link HARNESS_SEGMENT}, {@link MEMORY_SEGMENT}). The one
 * rule for the checkout path and for the verb that records a seat's repo.
 * @param {*} repoSlug
 * @param {String} caller For the error message
 * @returns {String[]} `[owner, repo]`
 * @throws {Error} On any other shape.
 */
export function assertRepoSlug(repoSlug, caller) {
    if (typeof repoSlug !== 'string' || repoSlug.split('/').length !== 2) {
        throw new Error(`${caller}: 'repoSlug' must be '<owner>/<repo>', received '${repoSlug}'.`);
    }

    const [owner, repo] = repoSlug.split('/');

    assertSeatSegment(owner, 'owner', caller);
    assertSeatSegment(repo,  'repo',  caller);

    if (Object.hasOwn(RESERVED_OWNERS, owner)) {
        throw new Error(`${caller}: the owner '${owner}' is reserved for ${RESERVED_OWNERS[owner]}.`);
    }

    return [owner, repo]
}

/**
 * @summary Refuse any value that is not a valid seat path segment. Nothing is sanitized: a lossy
 * rewrite is what once needed a hash to stay collision-free.
 * @param {*}      value  The untrusted value.
 * @param {String} name   The argument name, for the error.
 * @param {String} caller The deriving function, for the error.
 * @throws {Error} If `value` is not a string matching the segment shape.
 */
export function assertSeatSegment(value, name, caller) {
    if (typeof value !== 'string' || !SEGMENT.test(value)) {
        throw new Error(
            `${caller}: '${name}' must be 1–100 lowercase letters, digits, '.', '_' or '-' (not '.', '..' ` +
            `or a leading '-'), received '${value}'.`
        )
    }
}

/**
 * @summary Guard the trusted root: a non-empty absolute path.
 * @param {*}      value  The root.
 * @param {String} name   The argument name, for the error.
 * @param {String} caller The deriving function, for the error.
 * @returns {String} The resolved root.
 * @throws {Error} If `value` is not a non-empty absolute path.
 */
export function assertRoot(value, name, caller) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
        throw new Error(`${caller}: '${name}' must be an absolute path, received '${value}'.`)
    }

    return path.resolve(value)
}

/**
 * @summary Defense-in-depth over the segment rule: the resolved path must stay strictly within the
 * root. `path.relative` is the robust containment idiom (a root of `/`, cross-drive targets).
 * @param {String} root   The resolved root.
 * @param {String} target The resolved path.
 * @param {String} caller The deriving function, for the error.
 * @returns {String} `target`.
 * @throws {Error} If `target` escapes `root`.
 */
export function assertContained(root, target, caller) {
    const rel = path.relative(root, target);

    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`${caller}: the derived path escaped the root ('${target}').`)
    }

    return target
}

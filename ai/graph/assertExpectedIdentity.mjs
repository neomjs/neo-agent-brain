/**
 * @summary Pure, fail-closed comparison of a runtime-bound GitHub identity with the authenticated viewer.
 *
 * Provider authentication supplies the login; the harness or request context binds the expected
 * identity. Callers resolve these independently before invoking this comparison. Team-roster
 * metadata is not an admission authority: an outside team's authenticated peer needs no entry in
 * `identityRoots.mjs`. Missing references and mismatches still fail closed.
 *
 * GitHub Workflow's healthcheck and public-write guard share this dependency-free core. The optional
 * Memory-Core cross-check compares a supplied identity; it performs no lookup or provisioning.
 */

/**
 * @summary Stable machine codes naming each `assertExpectedIdentity` outcome — a structured contract
 * so consumers branch on a code, not on the human-readable `reason` prose (which is free to reword).
 * Generic by design (not GitHub-specific): a consumer like the write-boundary guard maps these to its
 * own domain codes. `OK` is the pass; each other value names one distinct fail-closed kind.
 * @enum {String}
 */
export const IdentityAssertionCode = Object.freeze({
    OK                  : 'OK',
    EXPECTED_UNMAPPABLE : 'EXPECTED_UNMAPPABLE',
    NO_AUTHED_LOGIN     : 'NO_AUTHED_LOGIN',
    LOGIN_MISMATCH      : 'LOGIN_MISMATCH',
    MEMORY_CORE_MISMATCH: 'MEMORY_CORE_MISMATCH'
});

/**
 * @summary Strips a single leading `@` so the id form (`@neo-gpt`) and the `gh api user` login form
 * (`neo-gpt`) compare equal. Non-string input passes through unchanged for the caller to reject.
 * @param {*} value
 * @returns {*}
 */
const bare = value => typeof value === 'string' ? value.replace(/^@/, '') : value;

/**
 * @summary Reads a canonical provider login from the expected reference without consulting a roster.
 *
 * A single `@` prefix is allowed. Empty, malformed, addressing-scheme and reserved system references
 * are not account logins. Never derive a missing expected identity from the viewer being checked.
 * @param {String} expected
 * @returns {String|null}
 */
const resolveExpectedLogin = expected => {
    const login = bare(expected);

    return typeof login === 'string' && /^[a-z\d]+(?:-[a-z\d]+)*$/i.test(login) && login.toLowerCase() !== 'system'
        ? login
        : null;
};

/**
 * @summary Fail-closed assertion that the live authed identity matches the expected agent.
 *
 * Returns `{ok:true, reason:null, code:'OK'}` only when the expected agent resolves to a canonical
 * login AND the authed login matches it AND (when supplied) the Memory-Core self-identity matches it
 * too. Any gap — unmappable expected id, absent authed login, login mismatch, or Memory-Core mismatch
 * — returns `{ok:false, reason, code}` with an explicit `"authed as X, expected Y"`-style message
 * suitable for a `degraded` healthcheck status or a write-boundary denial. The `code` is a stable
 * {@link IdentityAssertionCode} naming the outcome kind, so consumers branch on it rather than
 * string-matching the human-readable `reason`.
 *
 * `memoryCoreIdentity` is optional: omit it (or pass `null`/`undefined`) to assert the GitHub surface
 * alone; pass it to also cover the second surface that shares the drifted token.
 *
 * @param {Object} params
 * @param {String} params.expected The expected agent identity — the harness `NEO_AGENT_IDENTITY`
 * (the canonical provider login, `@`-prefixed or bare).
 * @param {String} params.actualLogin The live authed login from `gh api user --jq .login` (bare).
 * @param {String} [params.memoryCoreIdentity] The Memory-Core self-identity, when available.
 * @returns {{ok: Boolean, reason: (String|null), code: String}} `code` is an {@link IdentityAssertionCode} value.
 */
export function assertExpectedIdentity({expected, actualLogin, memoryCoreIdentity} = {}) {
    const expectedLogin = resolveExpectedLogin(expected);

    if (!expectedLogin) {
        return {ok: false, reason: `identity drift: expected identity '${expected}' has no account login form`, code: IdentityAssertionCode.EXPECTED_UNMAPPABLE};
    }

    const authedLogin = bare(actualLogin);

    if (!authedLogin) {
        return {ok: false, reason: `identity drift: no authed login resolved, expected ${expectedLogin}`, code: IdentityAssertionCode.NO_AUTHED_LOGIN};
    }

    if (authedLogin !== expectedLogin) {
        return {ok: false, reason: `identity drift: authed as ${authedLogin}, expected ${expectedLogin}`, code: IdentityAssertionCode.LOGIN_MISMATCH};
    }

    if (memoryCoreIdentity != null) {
        const memoryLogin = bare(memoryCoreIdentity);

        if (memoryLogin !== expectedLogin) {
            return {ok: false, reason: `identity drift: Memory-Core identity ${memoryLogin}, expected ${expectedLogin}`, code: IdentityAssertionCode.MEMORY_CORE_MISMATCH};
        }
    }

    return {ok: true, reason: null, code: IdentityAssertionCode.OK};
}

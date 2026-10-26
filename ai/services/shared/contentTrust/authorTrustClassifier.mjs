import {IDENTITIES, TRUST_TIERS, TRUST_TIER_ORDER} from '../../../graph/identityRoots.mjs';

/**
 * @summary Fail-closed GitHub-author → content-trust-tier classifier (organism self-defense substrate).
 *
 * The read- and ingest-boundary sanitizers (astroturfSanitizer) need to know whether a GitHub
 * comment author is one of us (internal / peer-trusted / owner) or an outside party (external /
 * unclassified) before deciding whether to defang and quarantine their content. Today the
 * `get_conversation` read path and the KB ingestion path return `author.login` but project NO
 * trust tier (verified 2026-06-12) — this helper closes that gap as a pure function.
 *
 * Pure + injectable by design: it derives the known-internal set from the canonical
 * `identityRoots.IDENTITIES` roster (the single source of truth for who the swarm is) and accepts
 * the repo-collaborator set as a parameter rather than fetching it, so it stays unit-testable and
 * carries no I/O. It NEVER infers trust upward from comment prose — a credible-sounding critique
 * from an unknown login still classifies `external` — the astroturf attack class succeeds
 * precisely by sounding peer-to-peer.
 *
 * @see ../../../graph/identityRoots.mjs (TRUST_TIERS taxonomy + the canonical identity roster)
 * @see ./astroturfSanitizer.mjs (the primary consumer — gates defang/redaction on `isExternalTier`)
 */

/**
 * Normalizes a GitHub login for comparison: trims, strips a leading `@`, lowercases.
 * The roster stores `@`-prefixed mixed-case logins; GitHub `author.login` is bare — normalize both.
 * @param {*} login
 * @returns {String} normalized login, or '' for non-strings / empties
 */
export function normalizeLogin(login) {
    return typeof login === 'string' ? login.trim().replace(/^@/, '').toLowerCase() : ''
}

/**
 * Canonical and former login → trustTier map, built once from the frozen identity roster.
 * Indexes both `properties.githubLogin` and `properties.formerLogins` so historical GitHub
 * comments, reviews, and issues authored before an identity rename still resolve to the
 * owning resident's trust tier.
 * @type {Map<String, String>}
 */
const KNOWN_TIER_BY_LOGIN = new Map(
    IDENTITIES
        .filter(identity => identity.properties?.githubLogin)
        .flatMap(identity => {
            const
                tier         = identity.properties.trustTier,
                formerLogins = Array.isArray(identity.properties.formerLogins) ? identity.properties.formerLogins : [];

            return [
                [normalizeLogin(identity.properties.githubLogin), tier],
                ...formerLogins
                    .map(normalizeLogin)
                    .filter(Boolean)
                    .map(login => [login, tier])
            ];
        })
);

/**
 * GitHub `CommentAuthorAssociation` values that prove repository maintainer / organization member
 * standing even when the author login is not listed in `identityRoots.mjs` (e.g. non-rostered
 * Fleet-Manager-created seats such as `@neo-gemini-maryam` or human org members).
 * @type {Set<String>}
 */
const REPO_TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * @summary Classifies a GitHub author login into a content-trust tier — fail-closed.
 *
 * Resolution order:
 * 1. Empty / non-string login → `UNCLASSIFIED` (no author info; still untrusted).
 * 2. Login present in the canonical roster (`githubLogin` or `formerLogins`) → that identity's tier (`owner` / `peer-trusted` / `system`).
 * 3. Login in the injected repo-collaborator set → `REPO_TRUSTED` (write-access humans we don't seed).
 * 4. GitHub `authorAssociation` in `['OWNER', 'MEMBER', 'COLLABORATOR']` → `REPO_TRUSTED` (non-rostered org members and collaborators).
 * 5. Anything else → `EXTERNAL` (the conservative default; never inferred up from prose).
 *
 * @param {String} login GitHub author login (bare `octocat` or `@octocat` both accepted)
 * @param {Object}               [opts]
 * @param {Set<String>|String[]} [opts.collaborators] Repo collaborator logins (write+). Members not
 *        in the canonical roster classify `REPO_TRUSTED`. Injected for purity — never fetched here.
 * @param {String}               [opts.authorAssociation] GitHub `CommentAuthorAssociation` (`OWNER`,
 *        `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `NONE`, etc.) from the GraphQL/REST node.
 * @returns {String} a `TRUST_TIERS` value
 */
export function classifyAuthorTrust(login, {collaborators, authorAssociation} = {}) {
    const normalized = normalizeLogin(login);

    if (!normalized) {
        return TRUST_TIERS.UNCLASSIFIED
    }

    if (KNOWN_TIER_BY_LOGIN.has(normalized)) {
        return KNOWN_TIER_BY_LOGIN.get(normalized)
    }

    // Normalize every entry the same way regardless of container (array OR Set), so a Set
    // carrying `@Mixed-Case` logins still matches the normalized comparison key.
    const collaboratorList = collaborators instanceof Set
        ? [...collaborators]
        : (Array.isArray(collaborators) ? collaborators : []);
    const collaboratorSet = new Set(collaboratorList.map(normalizeLogin));

    if (collaboratorSet.has(normalized)) {
        return TRUST_TIERS.REPO_TRUSTED
    }

    const normalizedAssociation = typeof authorAssociation === 'string'
        ? authorAssociation.trim().toUpperCase()
        : '';

    if (REPO_TRUSTED_ASSOCIATIONS.has(normalizedAssociation)) {
        return TRUST_TIERS.REPO_TRUSTED
    }

    return TRUST_TIERS.EXTERNAL
}

/**
 * @summary Whether a tier is untrusted-origin — the gate the sanitizer keys defang/redaction on.
 *
 * Both `external` (a real outside party) and `unclassified` (no resolvable author) are untrusted:
 * content from either is defang-and-quarantine eligible. Every roster / collaborator tier is trusted.
 *
 * @param {String} tier a `TRUST_TIERS` value
 * @returns {Boolean}
 */
export function isExternalTier(tier) {
    return tier === TRUST_TIERS.EXTERNAL || tier === TRUST_TIERS.UNCLASSIFIED
}

/**
 * @summary Whether a tier is POSITIVELY a recognized trusted origin — the fail-closed passthrough gate.
 *
 * Returns true ONLY for a recognized, non-external/unclassified tier. A missing, malformed, or
 * unrecognized tier returns false: at this self-defense boundary, absent provenance must not mean
 * "trusted" — callers (the sanitizer) fail closed and treat it as untrusted.
 *
 * @param {String} tier a `TRUST_TIERS` value
 * @returns {Boolean}
 */
export function isTrustedTier(tier) {
    return TRUST_TIER_ORDER.includes(tier) && !isExternalTier(tier)
}

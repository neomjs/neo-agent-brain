/**
 * @module ai/graph/trustTiers
 * @summary The content-provenance trust taxonomy every plane's identity nodes carry, in trust order.
 *
 * The taxonomy belongs to the plane, not to a team. `identityRoots.mjs` re-exports both constants
 * for its existing readers.
 */

/**
 * @summary Content-provenance trust taxonomy for AgentIdentity roots.
 *
 * Higher-level Memory Core query filtering and frontier weighting use these stable string
 * values; do not replace them with display labels.
 *
 * @member {Object}
 */
export const TRUST_TIERS = Object.freeze({
    SYSTEM           : 'system',
    REPO_TRUSTED     : 'repo-trusted',
    OWNER            : 'owner',
    SELF             : 'self',
    PEER_TRUSTED     : 'peer-trusted',
    INTERNAL_AUTHORED: 'internal-authored',
    EXTERNAL         : 'external',
    UNCLASSIFIED     : 'unclassified'
});

/**
 * @summary Highest-to-lowest trust ordering for the provenance taxonomy.
 *
 * The order is intentionally exported next to the enum so query-path slices can compare tiers
 * without duplicating ranking tables.
 *
 * @member {String[]}
 */
export const TRUST_TIER_ORDER = Object.freeze([
    TRUST_TIERS.SYSTEM,
    TRUST_TIERS.REPO_TRUSTED,
    TRUST_TIERS.OWNER,
    TRUST_TIERS.SELF,
    TRUST_TIERS.PEER_TRUSTED,
    TRUST_TIERS.INTERNAL_AUTHORED,
    TRUST_TIERS.EXTERNAL,
    TRUST_TIERS.UNCLASSIFIED
]);

import {memberLoginsOf, readAgentIdentityNodes} from './agentIdentityParticipation.mjs';
import {isSubjectSelectionActive}               from '../services/memory-core/helpers/subjectBinding.mjs';

/**
 * @module ai/graph/issueEdgeWeightSchema
 * @summary Pure, singleton-free edge-protection and read-time issue-emphasis primitives shared by
 * `GraphService`, `computedGoldenPathRouting`, `IssueIngestor`, and offline SQLite graph migrations.
 *
 * Keeping these pure contracts in `ai/graph/` lets CLI migrations and routing diagnostics evaluate
 * edge protection and issue emphasis directly against a `better-sqlite3` handle without booting
 * Neo service singletons or opening the configured live graph store as an import side effect.
 */

export const MESSAGE_ID_PREFIX = 'MESSAGE:';

/**
 * Edge types exempt from time-based scent decay and pruning by structural role.
 * Message-sourced edges are exempt by source prefix instead ({@link isMessageRecordEdge}).
 * @type {ReadonlyArray<String>}
 */
export const PROTECTED_EDGE_TYPES = Object.freeze([
    'ADVANCED_BY',
    'ATTRIBUTED_TO',
    'DELIVERED_TO',
    'SENT_TO',
    'SENT_BY',
    'IMPLEMENTS',
    'EXTENDS',
    'SYSTEM_TENET',
    'RESOLVES'
]);

/**
 * Structural topology edge types projected between `ISSUE` nodes by `IssueIngestor`.
 * @type {ReadonlyArray<String>}
 */
export const ANCHORED_ISSUE_EDGE_TYPES = Object.freeze(['PARENT_OF', 'BLOCKS']);

/**
 * @summary Checks whether an edge originates from a `MESSAGE:` record node.
 *
 * An edge a `MESSAGE` node sources is the sender's record (reply, thread, ticket, tag, and session
 * links): `decayGlobalTopology` neither decays nor prunes it, and `getInboundStructuralSupport`
 * counts it as total rather than decaying support.
 * @param {Object} edge `{source}` as cached or stored.
 * @returns {Boolean}
 */
export function isMessageRecordEdge(edge) {
    return typeof edge?.source === 'string' && edge.source.startsWith(MESSAGE_ID_PREFIX);
}

/**
 * @summary Normalizes raw graph or frontmatter label arrays into trimmed lowercase strings.
 * @param {Array<*>} [labels=[]] Raw label values.
 * @returns {String[]} Lowercase label names.
 */
export function normalizeLabels(labels = []) {
    return Array.isArray(labels)
        ? labels.map(label => String(label).trim().toLowerCase()).filter(Boolean)
        : [];
}

/**
 * @summary Resolves the steerable graph node type from explicit metadata or canonical node-id prefix.
 * @param {Object} nodeData Parsed graph node payload.
 * @returns {String}
 */
export function getComputedRecommendationNodeType(nodeData) {
    const explicit = String(nodeData?.type || nodeData?.properties?.type || '').toUpperCase();
    if (explicit) return explicit;

    const nodeId = String(nodeData?.id || '');
    if (nodeId.startsWith('discussion-')) return 'DISCUSSION';
    if (nodeId.startsWith('issue-'))      return 'ISSUE';
    return '';
}

/**
 * @summary Reads bare GitHub logins of the plane's internal members (`agent` and `human` `AgentIdentity` nodes).
 *
 * Until the cutover activates selection by subject, `formerLogins` count as members too. After it, a
 * released login confers no member weight on whoever registers it, and no stored ticket still names a
 * former login: GitHub reports a renamed account's history under its current login (#1814).
 *
 * Accepts either a direct `better-sqlite3` handle (`db.prepare`) or a `GraphService`-like wrapper
 * (`graphService.db.storage.db`). Degrades safely to an empty `Set` (invoking `onError` when supplied)
 * if the store, its activation record or the `AgentIdentity` query is unavailable, keeping community
 * emphasis disabled rather than inverting into boosting every ticket.
 *
 * @param {Object|null|undefined} graphOrDb Direct `better-sqlite3` handle or `GraphService` carrier.
 * @param {Function} [onError] Optional callback invoked when reading `AgentIdentity` nodes fails.
 * @returns {Set<String>}
 */
export function readInternalAuthorLogins(graphOrDb, onError) {
    try {
        const sqliteDb = typeof graphOrDb?.prepare === 'function'
            ? graphOrDb
            : graphOrDb?.db?.storage?.db;

        return new Set(memberLoginsOf(readAgentIdentityNodes(sqliteDb), {formerLogins: !isSubjectSelectionActive(sqliteDb)}));
    } catch (error) {
        onError?.(error);
        return new Set();
    }
}

/**
 * @summary Determines whether a ticket author qualifies as an external community author.
 *
 * Returns `true` only when `author` is non-empty, `internalAuthorLogins` is non-empty, and `author`
 * is absent from `internalAuthorLogins`. Requiring a non-empty registry ensures an unreadable plane
 * degrades safely (community emphasis off) rather than treating every ticket as community-authored.
 *
 * @param {String|null|undefined} author Bare GitHub login on the work item.
 * @param {Set<String>} [internalAuthorLogins] Bare logins of the plane's internal members ({@link readInternalAuthorLogins}).
 * @returns {Boolean}
 */
export function isCommunityAuthor(author, internalAuthorLogins) {
    return Boolean(author) && Boolean(internalAuthorLogins?.size > 0) && !internalAuthorLogins.has(author);
}

/**
 * @summary Computes read-time structural emphasis for `ISSUE` candidates (`+0.5` triaged community, `+1.0` `bug`).
 * @param {Object} nodeData Parsed graph node payload.
 * @param {Set<String>} [internalAuthorLogins] Plane internal author logins; empty disables community emphasis.
 * @returns {Number}
 */
export function getComputedIssueEmphasisMultiplier(nodeData, internalAuthorLogins) {
    if (getComputedRecommendationNodeType(nodeData) !== 'ISSUE') return 1.0;

    const author = nodeData?.properties?.author ?? nodeData?.author ?? null,
          labels = normalizeLabels(nodeData?.properties?.labels || nodeData?.labels);

    let multiplier = 1.0;

    if (isCommunityAuthor(author, internalAuthorLogins) && labels.length > 0) {
        multiplier += 0.5;
    }

    if (labels.includes('bug')) {
        multiplier += 1.0;
    }

    return multiplier;
}

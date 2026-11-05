import {normalizeAgentIdentityNodeId} from './normalizeAgentIdentityNodeId.mjs';

/**
 * @module Neo.ai.graph.agentIdentityParticipation
 * @summary A seat's participation, read where an operator records it: the AgentIdentity node in the plane's graph
 * store, the rows `who_is_online` reads. Every plane-side reader that gates on participation (wake delivery, the
 * heartbeat's targets, issue focus) takes it from here, so a bench recorded on the node reaches all of them, and no
 * reader falls back to the identity roots. Membership is read the same way: the plane's nodes, not a roster, say who
 * its agents and its people are.
 */

const MEMBER_ACCOUNT_TYPES = new Set(['agent', 'human']);

/**
 * @summary Every AgentIdentity node record in a graph store.
 *
 * The predicate is the graph store's `idx_nodes_label` expression, so a poll reads it through that index instead of
 * scanning `Nodes`; the same index rejects a row whose data does not parse, at write.
 * @param {Object} db better-sqlite3 handle.
 * @returns {Object[]} Parsed `{id, properties}` records.
 * @throws {Error} When the store cannot answer the query, or there is no store to ask.
 */
export function readAgentIdentityNodes(db) {
    if (!db) {
        throw new Error('no graph store to read the identity nodes from')
    }

    return db.prepare(`SELECT data FROM Nodes WHERE json_extract(data, '$.label') = 'AgentIdentity'`).all()
        .map(row => JSON.parse(row.data))
}

/**
 * @summary One node's participation status: the one it records, and `active` when it records none.
 * @param {Object} node An AgentIdentity `{id, properties}` record.
 * @returns {String}
 */
export function participationStatusOf(node) {
    return node.properties?.participationStatus || 'active'
}

/**
 * @summary Canonical identity → participation status, from AgentIdentity node records ({@link participationStatusOf}).
 * @param {Object[]} nodes `{id, properties}` records.
 * @returns {Map<String,String>}
 */
export function participationByIdentity(nodes) {
    return new Map(nodes.map(node => [normalizeAgentIdentityNodeId(node.id), participationStatusOf(node)]))
}

/**
 * @summary The plane's agents: canonical identities of the nodes whose `accountType` is `agent`. A human owner is no
 * agent, and a node that records no account type is no member at all.
 * @param {Object[]} nodes `{id, properties}` records.
 * @returns {String[]}
 */
export function agentIdentitiesOf(nodes) {
    return nodes.filter(node => node.properties?.accountType === 'agent').map(node => normalizeAgentIdentityNodeId(node.id))
}

/**
 * @summary The bare GitHub logins of the plane's members, its agents and its people, as their nodes record them:
 * `githubLogin`, else the node id, which a signed-in principal's node is keyed by. With `formerLogins`, every
 * earlier login a node keeps is included too.
 * @param {Object[]} nodes `{id, properties}` records.
 * @param {Object} [options]
 * @param {Boolean} [options.formerLogins=false]
 * @returns {String[]}
 */
export function memberLoginsOf(nodes, {formerLogins = false} = {}) {
    return [...new Set(nodes
        .filter(node => MEMBER_ACCOUNT_TYPES.has(node.properties?.accountType))
        .flatMap(node => [node.properties.githubLogin ?? node.id, ...(formerLogins ? node.properties.formerLogins ?? [] : [])])
        .filter(login => typeof login === 'string' && login)
        .map(login => login.replace(/^@/, '')))]
}

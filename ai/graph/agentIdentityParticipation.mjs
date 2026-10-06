import {normalizeAgentIdentityNodeId} from './normalizeAgentIdentityNodeId.mjs';

/**
 * @module Neo.ai.graph.agentIdentityParticipation
 * @summary A seat's participation, read where an operator records it: the AgentIdentity node in the plane's graph
 * store, the rows `who_is_online` reads. Every plane-side reader that gates on participation (wake delivery, the
 * heartbeat's targets, issue focus) takes it from here, so a bench recorded on the node reaches all of them, and no
 * reader falls back to the identity roots.
 */

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
 * @summary Canonical identity → participation status, from AgentIdentity node records; a node that records none is
 * `active`.
 * @param {Object[]} nodes `{id, properties}` records.
 * @returns {Map<String,String>}
 */
export function participationByIdentity(nodes) {
    return new Map(nodes.map(node => [
        normalizeAgentIdentityNodeId(node.id),
        node.properties?.participationStatus || 'active'
    ]))
}

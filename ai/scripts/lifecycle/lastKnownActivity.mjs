/**
 * @summary One read of a seat's last known activity: the newest of the three stamps the plane holds
 * for an identity — its newest `AGENT_MEMORY`, its newest `AGENT_TURN_PRESENCE` beacon and its
 * newest outbound `MESSAGE`.
 *
 * The idle detectors keyed on memory alone, and memory lands at the turn boundary: a seat deep in a
 * long tool loop saves nothing until the turn ends, and a fresh session has saved nothing yet, so both
 * read as idle to a memory-only detector while they are the busiest seats on the plane. The presence
 * hooks stamp the turn start and every tool call where they are wired, and every seat's outbound
 * message is activity by definition; the newest of the three is what "last known activity" means.
 *
 * Pure over an injected `better-sqlite3` handle: no Neo import, no config read, no write. Both
 * detectors (`checkSunsetted.mjs`, `checkAllAgentIdle.mjs`) and the nudge dispatcher call it, so the
 * idle predicate has one definition. The memory read keeps the legacy-row fallback (`name: 'Memory:
 * <iso>'`) because the all-idle detector runs without `checkSunsetted`'s update-on-read migration.
 *
 * @module ai/scripts/lifecycle/lastKnownActivity
 */

/**
 * The stamp kinds a read can name as the winner, in the order they are consulted.
 * @type {String[]}
 */
export const ACTIVITY_SOURCES = Object.freeze(['memory', 'turn-presence', 'message']);

/**
 * @summary Parses an ISO stamp to epoch milliseconds, or `null` when it is absent or unparseable.
 * @param {String|null|undefined} value
 * @returns {Number|null}
 * @private
 */
function toMs(value) {
    const ms = Date.parse(value ?? '');

    return Number.isFinite(ms) ? ms : null
}

/**
 * @summary The identity's newest memory stamp and the session it came from.
 * @param {Object} db Open `better-sqlite3` handle on the graph store.
 * @param {String} identity Canonical `@<identity>`.
 * @returns {{at: String|null, sessionId: String}}
 * @private
 */
function readNewestMemory(db, identity) {
    const row = db.prepare(`
        SELECT json_extract(data, '$.properties.timestamp') AS timestampField,
               json_extract(data, '$.properties.name')      AS nameField,
               json_extract(data, '$.properties.sessionId') AS sessionIdField
        FROM Nodes
        WHERE json_extract(data, '$.label') = 'AGENT_MEMORY'
          AND (json_extract(data, '$.properties.agentIdentity') = ? OR json_extract(data, '$.properties.userId') = ?)
        ORDER BY COALESCE(json_extract(data, '$.properties.timestamp'), json_extract(data, '$.properties.name')) DESC
        LIMIT 1
    `).get(identity, identity);

    if (!row) return {at: null, sessionId: ''};

    const legacy = row.nameField?.match(/^Memory:\s+(.+)$/)?.[1];

    return {at: row.timestampField || legacy || null, sessionId: row.sessionIdField || ''}
}

/**
 * @summary The identity's newest turn-presence stamp: the last progress beacon, else the turn start.
 * @param {Object} db
 * @param {String} identity
 * @returns {String|null}
 * @private
 */
function readNewestPresence(db, identity) {
    const row = db.prepare(`
        SELECT COALESCE(json_extract(data, '$.properties.lastProgressAt'), json_extract(data, '$.properties.startedAt')) AS at
        FROM Nodes
        WHERE json_extract(data, '$.label') = 'AGENT_TURN_PRESENCE'
          AND json_extract(data, '$.properties.agentIdentity') = ?
        ORDER BY at DESC
        LIMIT 1
    `).get(identity);

    return row?.at || null
}

/**
 * @summary The identity's newest outbound message stamp (its `SENT_BY` edge names the sender).
 * @param {Object} db
 * @param {String} identity
 * @returns {String|null}
 * @private
 */
function readNewestOutboundMessage(db, identity) {
    const row = db.prepare(`
        SELECT json_extract(n.data, '$.properties.sentAt') AS at
        FROM Edges e
        JOIN Nodes n ON n.id = e.source
        WHERE e.type = 'SENT_BY'
          AND e.target IN (?, ?)
          AND json_extract(n.data, '$.label') = 'MESSAGE'
        ORDER BY at DESC
        LIMIT 1
    `).get(identity, identity.replace(/^@/, ''));

    return row?.at || null
}

/**
 * @summary Reads the identity's last known activity and names the stamp that won.
 *
 * @param {Object} db Open `better-sqlite3` handle on the graph store.
 * @param {String} identity Canonical `@<identity>`.
 * @param {Object} [options]
 * @param {Number} [options.now=Date.now()] Injected clock for the age fields.
 * @returns {{identity: String, lastActivityAt: String|null, lastActivityAtMs: Number|null,
 *     lastActivitySource: String|null, ageMs: Number|null, lastMemoryAt: String|null,
 *     lastMemoryAtMs: Number|null, lastMemoryAgeMs: Number|null, lastSessionId: String}}
 *     Every stamp absent → the `null` fields; the memory half rides along for callers that still
 *     report memory age or need the origin session.
 */
export function readLastKnownActivity(db, identity, {now = Date.now()} = {}) {
    if (typeof db?.prepare !== 'function') {
        throw new Error('readLastKnownActivity requires an open graph database handle')
    }
    if (!identity) {
        throw new Error('readLastKnownActivity requires an agent identity')
    }

    const memory = readNewestMemory(db, identity);
    const stamps = [
        {source: 'memory',        at: memory.at},
        {source: 'turn-presence', at: readNewestPresence(db, identity)},
        {source: 'message',       at: readNewestOutboundMessage(db, identity)}
    ]
        .map(stamp => ({...stamp, atMs: toMs(stamp.at)}))
        .filter(stamp => stamp.atMs !== null);

    const newest         = stamps.reduce((best, stamp) => (!best || stamp.atMs > best.atMs ? stamp : best), null);
    const lastMemoryAtMs = toMs(memory.at);

    return {
        identity,
        lastActivityAt    : newest?.at ?? null,
        lastActivityAtMs  : newest?.atMs ?? null,
        lastActivitySource: newest?.source ?? null,
        ageMs             : newest ? Math.max(0, now - newest.atMs) : null,
        lastMemoryAt      : memory.at,
        lastMemoryAtMs,
        lastMemoryAgeMs   : lastMemoryAtMs !== null ? Math.max(0, now - lastMemoryAtMs) : null,
        lastSessionId     : memory.sessionId
    }
}

import {activeWakeSubscriptionStatusSql} from '../../services/memory-core/wakeSubscriptionStatusPolicy.mjs';
import {SUNSET_SUCCESSOR_TAG}            from './sessionRotation.mjs';

/**
 * @module ai/daemons/wake/sunsetReceipt
 * @summary The graph reads and the one record write behind a session rotation: a seat's sunset
 * receipt, the turns and sessions around it, and the routes that can rotate a seat.
 *
 * Pure over an injected `better-sqlite3` handle: no Neo import, no config read, and no import of a
 * store package. Memory Core's wake hold reads it, so it must stay off the static path that the
 * host-barrel guard keeps free of store handles (`hostBarrelImportReach.spec.mjs`).
 *
 * @see ai/daemons/wake/sessionRotation.mjs
 * @see ai/daemons/orchestrator/scheduling/sessionRotation.mjs
 */

/** @summary A message id without its `MESSAGE:` prefix, so a marker's `inReplyTo` matches in either form. */
const bareMessageId = id => String(id ?? '').replace(/^MESSAGE:/, '');

/**
 * @summary The plane's whole read of one seat's sunset receipt, for the rotation lane and the wake hold.
 *
 * The receipt is the seat's NEWEST self-addressed message sent at or after `sinceIso`, successor markers
 * aside, and only when that message is a sunset handover: any newer self-message that is not one (a
 * rescinding note) turns the rotation off. A seat that wrote no self-message in the range has no receipt.
 * The successor is the earliest marker whose `inReplyTo` names the receipt; a marker replying to any
 * other message changes nothing.
 *
 * The session reads key on the receipt's time. The old session is the one that saved the seat's newest
 * memory at or before the receipt. A prompted turn is a turn-presence interval started after the receipt
 * without a wake-submit nonce: a prompt that a person or a fresh session submitted, never a typed wake.
 *
 * @param {Object} db Open `better-sqlite3` handle on the graph store.
 * @param {String} identity Canonical `@<identity>`.
 * @param {Object} options
 * @param {String} options.sinceIso Oldest `sentAt` a receipt may carry.
 * @param {String} [options.nowIso=new Date().toISOString()] The clock a live turn is read against.
 * @returns {Object|null} `{receipt, oldSessionId, successor, promptedTurnAt, liveTurnUntil,
 * lastRequestedAt}`, or `null` without a receipt. `receipt` is `{id, sentAt, focusItemsReceipt,
 * sessionRotation}`; `successor` is `{id, sentAt, sessionId}` or `null`, its `sessionId` the one of the
 * seat's first memory at or after the marker (`null` until that memory lands, since the marker carries
 * none); `liveTurnUntil` is when a turn begun by the receipt's time stops counting as live (the turn that
 * wrote it, until `add_memory` closes it); `lastRequestedAt` is the newest rotation request among the
 * seat's OTHER self-messages in the range.
 */
export function readSunsetReceipt(db, identity, {sinceIso, nowIso = new Date().toISOString()}) {
    const bare     = identity.replace(/^@/, ''),
          messages = db.prepare(`
              SELECT id, data FROM Nodes
              WHERE id LIKE 'MESSAGE:%'
                AND json_extract(data, '$.properties.sentAt') >= ?
                AND json_extract(data, '$.properties.from') IN (?, ?)
                AND json_extract(data, '$.properties.to') IN (?, ?)
              ORDER BY json_extract(data, '$.properties.sentAt') DESC, id DESC
          `).all(sinceIso, identity, bare, identity, bare).map(row => ({id: row.id, properties: JSON.parse(row.data).properties || {}})),
          isMarker = message => !!message.properties.taggedConcepts?.includes(SUNSET_SUCCESSOR_TAG),
          newest   = messages.find(message => !isMarker(message));

    if (!newest?.properties.taggedConcepts?.includes('sunset-protocol-handover')) return null;

    // newest first, so the earliest reply is the last match
    const marker = messages.filter(message => isMarker(message) && bareMessageId(message.properties.inReplyTo) === bareMessageId(newest.id)).at(-1);

    // The node id is `AGENT_TURN_PRESENCE:<identity>:<turnId>`, so a key range on the primary index
    // reads one seat's intervals without scanning every seat's.
    const turnRange = [`AGENT_TURN_PRESENCE:${identity}:`, `AGENT_TURN_PRESENCE:${identity};`],
          {sentAt}  = newest.properties,
          memory    = db.prepare(`
              SELECT json_extract(data, '$.properties.sessionId') AS sessionId
              FROM Nodes
              WHERE json_extract(data, '$.label') = 'AGENT_MEMORY'
                AND json_extract(data, '$.properties.agentIdentity') = ?
                AND json_extract(data, '$.properties.timestamp') <= ?
              ORDER BY json_extract(data, '$.properties.timestamp') DESC
              LIMIT 1
          `).get(identity, sentAt),
          oldSessionId = memory?.sessionId || null,
          successorMemory = marker && db.prepare(`
              SELECT json_extract(data, '$.properties.sessionId') AS sessionId
              FROM Nodes
              WHERE json_extract(data, '$.label') = 'AGENT_MEMORY'
                AND json_extract(data, '$.properties.agentIdentity') = ?
                AND json_extract(data, '$.properties.timestamp') >= ?
              ORDER BY json_extract(data, '$.properties.timestamp') ASC
              LIMIT 1
          `).get(identity, marker.properties.sentAt),
          promptedTurn = db.prepare(`
              SELECT MIN(json_extract(data, '$.properties.startedAt')) AS at
              FROM Nodes
              WHERE id >= ? AND id < ?
                AND json_extract(data, '$.properties.startedAt') > ?
                AND json_extract(data, '$.properties.wakeSubmitNonce') IS NULL
          `).get(...turnRange, sentAt),
          liveTurn = db.prepare(`
              SELECT MAX(json_extract(data, '$.properties.expiresAt')) AS until
              FROM Nodes
              WHERE id >= ? AND id < ?
                AND json_extract(data, '$.properties.startedAt') <= ?
                AND COALESCE(json_extract(data, '$.properties.status'), 'active') = 'active'
                AND json_extract(data, '$.properties.expiresAt') > ?
          `).get(...turnRange, sentAt, nowIso);

    const requestedAts = messages.filter(message => message !== newest).map(message => message.properties.sessionRotation?.requestedAt).filter(Boolean);

    return {
        receipt: {
            id               : newest.id,
            sentAt,
            focusItemsReceipt: newest.properties.focusItemsReceipt ?? null,
            sessionRotation  : newest.properties.sessionRotation ?? null
        },
        oldSessionId,
        successor      : marker ? {id: marker.id, sentAt: marker.properties.sentAt, sessionId: successorMemory?.sessionId || null} : null,
        promptedTurnAt : promptedTurn?.at || null,
        liveTurnUntil  : liveTurn?.until || null,
        lastRequestedAt: requestedAts.sort().at(-1) || null
    }
}

/**
 * @summary Counts the direct messages other senders addressed to a seat inside a span: the ones a wake
 * hold kept from its old session.
 * @param {Object} db
 * @param {String} identity Canonical `@<identity>`.
 * @param {Object} span
 * @param {String} span.afterIso Exclusive start.
 * @param {String} span.untilIso Inclusive end.
 * @returns {Number}
 */
export function countDirectMessagesBetween(db, identity, {afterIso, untilIso}) {
    return db.prepare(`
        SELECT COUNT(DISTINCT n.id) AS count
        FROM Edges e
        JOIN Nodes n ON n.id = e.source
        WHERE e.type = 'SENT_TO'
          AND e.target = ?
          AND json_extract(n.data, '$.properties.sentAt') > ?
          AND json_extract(n.data, '$.properties.sentAt') <= ?
          AND json_extract(n.data, '$.properties.from') NOT IN (?, ?)
    `).get(identity, afterIso, untilIso, identity, identity.replace(/^@/, '')).count
}

/**
 * @summary The active `SESSION_ROTATE` routes: one per seat the Fleet armed for rotation.
 * @param {Object} db
 * @returns {Object[]} `{id, properties}` WAKE_SUBSCRIPTION records.
 */
export function getActiveSessionRotateRoutes(db) {
    return db.prepare(`
        SELECT id, data
        FROM Nodes
        WHERE json_extract(data, '$.label') = 'WAKE_SUBSCRIPTION'
          AND json_extract(data, '$.properties.trigger') = 'SESSION_ROTATE'
          AND ${activeWakeSubscriptionStatusSql()}
    `).all().map(row => ({id: row.id, properties: JSON.parse(row.data).properties || {}}))
}

/**
 * @summary Records a receipt's rotation state on the handover node, field-only like the receipt count.
 * @param {Object} db
 * @param {String} id Handover message id.
 * @param {Object} record The `sessionRotation` record.
 */
export function writeSessionRotation(db, id, record) {
    db.prepare("UPDATE Nodes SET data = json_set(data, '$.properties.sessionRotation', json(?)) WHERE id = ?")
        .run(JSON.stringify(record), id)
}

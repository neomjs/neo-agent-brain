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
 * How far apart the writer's `add_memory` and the interval it closes may land and still be one close. The
 * two writes are one tool call: measured 1–2 ms apart (2026-11-14), so the bound only absorbs a slow store.
 * @type {Number}
 */
export const WRITER_CLOSE_SKEW_MS = 5 * 1000;

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
 * memory at or before the receipt.
 *
 * **The receipt's turn ends at its writer's close.** One turn leaves several intervals whose turn ids never
 * join (the prompt's, a tool-progress beacon's, the one `add_memory` closes), and presence names no session,
 * so an interval alone cannot say whose turn it was. The writer's `add_memory` can: its memory lands within
 * {@link WRITER_CLOSE_SKEW_MS} of the `terminal` interval it closes, under the writer's Memory Core session
 * (the old session). The close is the earliest such interval at or after the receipt; any other close is
 * unattributed and authorizes nothing. A session first seen after the receipt attributes nothing either: it
 * may be the writer's reconnect or a new session, so the turn then waits on presence alone.
 * - Before the close, the turn is live while any interval is, since an interval opened after the receipt may
 *   still be the writer's own tail.
 * - After it, the turn holds nothing. A prompted turn is then an interval, without a wake-submit nonce,
 *   that started after the receipt and is not the writer's tail (closed with it), or that progressed after
 *   the close: a person or another session, never a typed wake.
 * - At any time, a memory after the receipt from a session that was already writing before it is another
 *   live session of the seat, and reads as a prompt.
 * - With no close and nothing live, a prompted turn is one started after the receipt.
 *
 * @param {Object} db Open `better-sqlite3` handle on the graph store.
 * @param {String} identity Canonical `@<identity>`.
 * @param {Object} options
 * @param {String} options.sinceIso Oldest `sentAt` a receipt may carry.
 * @param {String} [options.nowIso=new Date().toISOString()] The clock a live turn is read against.
 * @returns {Object|null} `{receipt, oldSessionId, successor, promptedTurnAt, liveTurnUntil,
 * lastRequestedAt}`, or `null` without a receipt. `receipt` is `{id, sentAt, focusItemsReceipt,
 * sessionRotation}`; `successor` is the marker's `{id, sentAt}` or `null`, and names no session, since
 * the marker carries no sender session and a memory saved after it may be another session's;
 * `liveTurnUntil` is the latest `expiresAt` among the unexpired active intervals while the receipt's
 * turn has no close, else `null`; `lastRequestedAt` is the newest rotation request among the seat's
 * OTHER self-messages in the range.
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
          memories     = db.prepare(`
              SELECT json_extract(data, '$.properties.timestamp') AS at, json_extract(data, '$.properties.sessionId') AS sessionId
              FROM Nodes
              WHERE json_extract(data, '$.label') = 'AGENT_MEMORY'
                AND json_extract(data, '$.properties.agentIdentity') = ?
                AND json_extract(data, '$.properties.timestamp') >= ?
          `).all(identity, sinceIso),
          // Only the writer's own session attributes a close. One first seen after the receipt may be the
          // writer's reconnect or a new session, so it neither closes the turn nor refuses it.
          before       = new Set(memories.filter(row => row.at <= sentAt).map(row => row.sessionId)),
          after        = memories.filter(row => row.at > sentAt),
          writerSaves  = after.filter(row => row.sessionId === oldSessionId).map(row => Date.parse(row.at)),
          otherSaveAt  = after.filter(row => row.sessionId !== oldSessionId && before.has(row.sessionId)).map(row => row.at).sort()[0] || null,
          intervals    = db.prepare(`
              SELECT json_extract(data, '$.properties.startedAt') AS startedAt,
                     json_extract(data, '$.properties.lastProgressAt') AS lastProgressAt,
                     COALESCE(json_extract(data, '$.properties.status'), 'active') AS status,
                     json_extract(data, '$.properties.expiresAt') AS expiresAt,
                     json_extract(data, '$.properties.wakeSubmitNonce') AS nonce
              FROM Nodes
              WHERE id >= ? AND id < ?
                AND COALESCE(json_extract(data, '$.properties.lastProgressAt'), json_extract(data, '$.properties.startedAt')) >= ?
          `).all(...turnRange, sinceIso),
          savedBy      = at => writerSaves.some(save => Math.abs(Date.parse(at) - save) <= WRITER_CLOSE_SKEW_MS),
          closedAt     = intervals.filter(row => row.status === 'terminal' && row.lastProgressAt >= sentAt && savedBy(row.lastProgressAt))
                                  .map(row => row.lastProgressAt).sort()[0] || null,
          liveUntil    = closedAt ? null : intervals.filter(row => row.status === 'active' && row.expiresAt > nowIso)
                                                    .map(row => row.expiresAt).sort().at(-1) || null,
          prompted     = intervals.filter(row => !row.nonce).flatMap(row => {
              if (!closedAt) return liveUntil || !(row.startedAt > sentAt) ? [] : [row.startedAt];

              const writersTail = row.status === 'terminal' && savedBy(row.lastProgressAt);

              return [
                  ...(row.startedAt > sentAt && !writersTail ? [row.startedAt] : []),
                  ...(Date.parse(row.lastProgressAt) > Date.parse(closedAt) + WRITER_CLOSE_SKEW_MS ? [row.lastProgressAt] : [])
              ]
          }),
          promptedAt   = [...prompted, ...(otherSaveAt ? [otherSaveAt] : [])].sort()[0] || null;

    const requestedAts = messages.filter(message => message !== newest).map(message => message.properties.sessionRotation?.requestedAt).filter(Boolean);

    return {
        receipt: {
            id               : newest.id,
            sentAt,
            focusItemsReceipt: newest.properties.focusItemsReceipt ?? null,
            sessionRotation  : newest.properties.sessionRotation ?? null
        },
        oldSessionId,
        successor      : marker ? {id: marker.id, sentAt: marker.properties.sentAt} : null,
        promptedTurnAt : promptedAt || null,
        liveTurnUntil  : liveUntil || null,
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

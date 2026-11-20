import {activeWakeSubscriptionStatusSql}                from '../../services/memory-core/wakeSubscriptionStatusPolicy.mjs';
import {SUNSET_SUCCESSOR_TAG, TERMINAL_ROTATION_STATES} from './sessionRotation.mjs';

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

/** @summary When a rotation stopped being open: its settle stamp, or its request when a settled record has none. */
const settledAt = rotation => rotation.completedAt || rotation.refusedAt || rotation.incompleteAt ||
    (TERMINAL_ROTATION_STATES.includes(rotation.state) ? rotation.requestedAt : null);

/** @summary Whether a rotation was open at `iso`: requested by then, and not settled before it. */
const isOpenAt = (rotation, iso) => !!rotation?.requestedAt && rotation.requestedAt <= iso && (!settledAt(rotation) || iso <= settledAt(rotation));

/**
 * @summary Parses the sunset subject's focus count without accepting truncated or unsafe numbers.
 * @param {String} subject
 * @returns {{named: Number, placed: Number}|null}
 */
export function parseFocusItemsReceipt(subject) {
    const match = typeof subject === 'string' && subject.match(/\bfocus items: (\d+), (\d+) placed\b/);

    if (!match) return null;

    const named = Number(match[1]), placed = Number(match[2]);

    return Number.isSafeInteger(named) && Number.isSafeInteger(placed) && placed <= named
        ? {named, placed}
        : null;
}

/**
 * How far apart the writer's `add_memory` and the interval it closes may land and still be one close. The
 * two writes are one tool call: measured 1–2 ms apart (2026-11-14), so the bound only absorbs a slow store.
 * @type {Number}
 */
export const WRITER_CLOSE_SKEW_MS = 5 * 1000;

/**
 * @summary The longest writer stamp value the store keeps, in characters. A hook stamp is a short hash or
 * turn id; anything longer is not one.
 * @type {Number}
 */
export const WRITER_STAMP_MAX_CHARS = 128;

/**
 * @summary The writer stamp a write keeps: the `writerKey` and `writerTurn` the seat's harness hook adds to
 * `add_message` and `add_memory`, each only as a non-empty string within {@link WRITER_STAMP_MAX_CHARS}.
 * A missing or malformed value leaves the write unstamped, and an unstamped write keeps today's verdict.
 * @param {Object} [stamp]
 * @param {*} [stamp.writerKey] A hash of seat and harness session; it never carries the session id itself.
 * @param {*} [stamp.writerTurn] The turn id the turn's presence interval also carries.
 * @returns {{writerKey?: String, writerTurn?: String}}
 */
export function writerStamp({writerKey, writerTurn} = {}) {
    const valid = value => typeof value === 'string' && value.length > 0 && value.length <= WRITER_STAMP_MAX_CHARS;

    return {...(valid(writerKey) ? {writerKey} : {}), ...(valid(writerTurn) ? {writerTurn} : {})}
}

/**
 * @summary The plane's whole read of one seat's sunset receipt, for the rotation lane and the wake hold.
 *
 * The receipt is the seat's NEWEST self-addressed message sent at or after `sinceIso`, successor markers
 * aside, and only when that message is a sunset handover: any newer self-message that is not one (a
 * rescinding note) turns the rotation off. A seat that wrote no self-message in the range has no receipt.
 * An amendment is no new receipt: a handover sent while an earlier one's rotation was open (requested,
 * not yet settled) and before that rotation's first successor marker folds into it. An open rotation
 * is returned before any later receipt, so a later handover never strands it. The successor is the
 * earliest marker whose `inReplyTo` names the receipt or one of its amendments; a marker replying to any
 * other message changes nothing.
 *
 * A handover sent after a requested rotation's successor marker has a predecessor: the old session may
 * still write, and no Memory Core id proves which generation did (a reconnect mints a new one, and a fresh
 * session can inherit the old one).
 *
 * The receipt count is the summary lane's stamp, else the subject's own, else `'missing'`: a deferred
 * summary run never holds a rotation.
 *
 * The session reads key on the receipt's time. The old session is the one that saved the seat's newest
 * memory at or before the receipt. Without a predecessor, the receipt's own stamp (`originSessionId`, set at
 * the tool boundary) names it instead, which covers a reconnect before the close. With one, the stamp may be
 * the predecessor's late writer, so it never releases a live turn.
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
 * **A stamped writer attributes its own close** ({@link releaseByWriterStamp}): when the handover and a save
 * of its turn carry the hook's writer stamp, that save is the close whatever session it came under, and the
 * prompt and liveness evidence is re-read against it. Without the stamp, the reading above stands.
 *
 * @param {Object} db Open `better-sqlite3` handle on the graph store.
 * @param {String} identity Canonical `@<identity>`.
 * @param {Object} options
 * @param {String} options.sinceIso Oldest `sentAt` a receipt may carry.
 * @param {String} [options.nowIso=new Date().toISOString()] The clock a live turn is read against.
 * @returns {Object|null} `{receipt, oldSessionId, successor, promptedTurnAt, liveTurnUntil, writerClosedAt,
 * lastRequestedAt, predecessor}`, or `null` without a receipt. `receipt` is `{id, sentAt, focusItemsReceipt,
 * sessionRotation}`; `successor` is the marker's `{id, sentAt}` or `null`, and names no session, since
 * the marker carries no sender session and a memory saved after it may be another session's;
 * `liveTurnUntil` is the latest `expiresAt` among the unexpired active intervals while the receipt's
 * turn has no close, else `null`; `writerClosedAt` is that close, else `null`; `lastRequestedAt` is the
 * newest rotation request among the seat's
 * OTHER self-messages in the range; `predecessor` is `{successorAt}` for a receipt sent after a requested
 * rotation's successor marker, else `null`.
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
          isMarker   = message => !!message.properties.taggedConcepts?.includes(SUNSET_SUCCESSOR_TAG),
          isHandover = message => !!message.properties.taggedConcepts?.includes('sunset-protocol-handover'),
          notes      = messages.filter(message => !isMarker(message)),
          newest     = notes[0];

    if (!newest || !isHandover(newest)) return null;

    // Walk the newest run of handovers (another self-message ends it) oldest first. A handover sent while
    // the current receipt's rotation is open, and before its first successor marker, amends it; a same-writer
    // handover sent before any rotation request folds into the current receipt (re-pointing `receipt` to the
    // newest turn so writer-stamp close stays on the turn that actually saved); any other handover starts a
    // receipt of its own. One sent after a requested rotation's marker has a predecessor that may still write,
    // so its writer must differ provably from that rotation's old session.
    const runEnd     = notes.findIndex(message => !isHandover(message)),
          run        = (runEnd === -1 ? notes : notes.slice(0, runEnd)).toReversed(),
          markers    = messages.filter(isMarker).toReversed(),
          firstReply = ids => markers.find(message => ids.has(bareMessageId(message.properties.inReplyTo))) || null;

    let receipt = null, chain = null, marker = null, predecessor = null, predecessorMarker = null, open = null;

    for (const handover of run) {
        const at = handover.properties.sentAt;

        if (receipt && isOpenAt(receipt.properties.sessionRotation, at) && !(marker && marker.properties.sentAt <= at)) {
            chain.add(bareMessageId(handover.id));
            marker = firstReply(chain);
            continue
        }

        const rotation = receipt?.properties.sessionRotation;

        const receiptKey = receipt && writerStamp(receipt.properties).writerKey,
              sameWriter = Boolean(receiptKey) && receiptKey === writerStamp(handover.properties).writerKey;

        if (receipt && !rotation?.requestedAt && sameWriter && !(marker && marker.properties.sentAt <= at)) {
            receipt = handover;
            chain.add(bareMessageId(handover.id));
            marker  = firstReply(chain);
            continue
        }

        if (rotation?.requestedAt) {
            if (!TERMINAL_ROTATION_STATES.includes(rotation.state)) open = {receipt, chain, marker};
            // a request that found no successor ends the lineage; one that did is the next receipt's predecessor
            predecessor       = marker && marker.properties.sentAt <= at ? {successorAt: marker.properties.sentAt} : null;
            predecessorMarker = predecessor ? marker : null
        }

        receipt = handover;
        chain   = new Set([bareMessageId(handover.id)]);
        marker  = firstReply(chain)
    }

    // an open rotation settles first: a later receipt waits for it
    if (open) ({receipt, chain, marker} = open), predecessor = null, predecessorMarker = null;

    // The node id is `AGENT_TURN_PRESENCE:<identity>:<turnId>`, so a key range on the primary index
    // reads one seat's intervals without scanning every seat's.
    const turnRange = [`AGENT_TURN_PRESENCE:${identity}:`, `AGENT_TURN_PRESENCE:${identity};`],
          {sentAt}  = receipt.properties,
          memory    = db.prepare(`
              SELECT json_extract(data, '$.properties.sessionId') AS sessionId
              FROM Nodes
              WHERE json_extract(data, '$.label') = 'AGENT_MEMORY'
                AND json_extract(data, '$.properties.agentIdentity') = ?
                AND json_extract(data, '$.properties.timestamp') <= ?
              ORDER BY json_extract(data, '$.properties.timestamp') DESC
              LIMIT 1
          `).get(identity, sentAt),
          oldSessionId = (!predecessor && receipt.properties.originSessionId) || memory?.sessionId || null,
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
                     json_extract(data, '$.properties.wakeSubmitNonce') AS nonce,
                     json_extract(data, '$.properties.turnId') AS turnId,
                     json_extract(data, '$.properties.writerKey') AS writerKey
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

    const requestedAts = messages.filter(message => message !== receipt).map(message => message.properties.sessionRotation?.requestedAt).filter(Boolean),
          stamped      = releaseByWriterStamp(db, identity, {receipt, predecessorMarker, intervals, sinceIso, nowIso});

    return {
        receipt: {
            id               : receipt.id,
            sentAt,
            focusItemsReceipt: receipt.properties.focusItemsReceipt ?? parseFocusItemsReceipt(receipt.properties.subject) ?? 'missing',
            sessionRotation  : receipt.properties.sessionRotation ?? null
        },
        oldSessionId,
        successor      : marker ? {id: marker.id, sentAt: marker.properties.sentAt, originSessionId: marker.properties.originSessionId ?? null} : null,
        promptedTurnAt : stamped ? stamped.promptedAt : promptedAt || null,
        liveTurnUntil  : stamped ? stamped.liveTurnUntil : liveUntil || null,
        writerClosedAt : stamped ? stamped.closedAt : closedAt,
        lastRequestedAt: requestedAts.sort().at(-1) || null,
        predecessor
    }
}

/**
 * @summary Attributes a receipt's close by its writer's stamp, where the session reads cannot: the
 * `writerKey` and `writerTurn` the seat's harness hook stamps on `add_message` and `add_memory`
 * ({@link writerStamp}).
 *
 * The close is a save of the handover's own turn, by the handover's writer. After a predecessor, that writer
 * must be the one that sent the predecessor's successor marker, and every write of the seat since that marker
 * must carry its key: an unstamped write cannot prove a sole writer. Once attributed, the prompt evidence is read
 * against that close. A write from a later turn is a prompt unless its turn is a typed wake (its interval carries
 * a nonce), and so is any other non-wake interval that started after the receipt or progressed after the close.
 * The writer's own turn is exempt by id. The writer's turn is live, holding the release, only through another
 * open interval that progressed while the writer's turn ran: a session's turns are sequential, so an open
 * interval of the same writer key that started at or before the writer's turn (`startedAt <= ownStart`) is
 * history whatever its last progress (covering async `PostToolUse` settlement across turns), while a
 * different-key or unstamped interval holds the release from `ownStart` onward and one last seen before the
 * writer's turn began is history.
 *
 * Anything short of that, a missing stamp included, returns `null` and the reading stays today's.
 * @param {Object} db Open `better-sqlite3` handle on the graph store.
 * @param {String} identity Canonical `@<identity>`.
 * @param {Object} reading
 * @param {Object} reading.receipt The receipt message `{id, properties}`.
 * @param {Object|null} reading.predecessorMarker The predecessor's successor marker, or `null` without one.
 * @param {Object[]} reading.intervals The seat's turn intervals in range.
 * @param {String} reading.sinceIso
 * @param {String} reading.nowIso
 * @returns {{closedAt: String, promptedAt: String|null, liveTurnUntil: String|null}|null}
 * @protected
 */
export function releaseByWriterStamp(db, identity, {receipt, predecessorMarker, intervals, sinceIso, nowIso}) {
    const {writerKey: key, writerTurn: turn} = writerStamp(receipt.properties);
    if (!key || !turn) return null;

    const bare   = identity.replace(/^@/, ''),
          sentAt = receipt.properties.sentAt,
          writes = [
              ...db.prepare(`
                  SELECT json_extract(data, '$.properties.sentAt') AS at, 0 AS save,
                         json_extract(data, '$.properties.writerKey') AS writerKey, json_extract(data, '$.properties.writerTurn') AS writerTurn
                  FROM Nodes
                  WHERE id LIKE 'MESSAGE:%' AND json_extract(data, '$.properties.from') IN (?, ?)
                    AND json_extract(data, '$.properties.sentAt') >= ? AND json_extract(data, '$.properties.sentAt') <= ?
              `).all(identity, bare, sinceIso, nowIso),
              ...db.prepare(`
                  SELECT json_extract(data, '$.properties.timestamp') AS at, 1 AS save,
                         json_extract(data, '$.properties.writerKey') AS writerKey, json_extract(data, '$.properties.writerTurn') AS writerTurn
                  FROM Nodes
                  WHERE json_extract(data, '$.label') = 'AGENT_MEMORY' AND json_extract(data, '$.properties.agentIdentity') = ?
                    AND json_extract(data, '$.properties.timestamp') >= ? AND json_extract(data, '$.properties.timestamp') <= ?
              `).all(identity, sinceIso, nowIso)
          ].map(row => ({at: row.at, save: row.save === 1, ...writerStamp(row)})),
          closedAt = writes.filter(write => write.save && write.writerKey === key && write.writerTurn === turn && write.at >= sentAt)
                           .map(write => write.at).sort()[0];

    if (!closedAt) return null;

    if (predecessorMarker) {
        const markAt = predecessorMarker.properties.sentAt;

        if (writerStamp(predecessorMarker.properties).writerKey !== key) return null;
        if (writes.some(write => write.at > markAt && write.writerKey !== key)) return null
    }

    const wakeTurns  = new Set(intervals.filter(row => row.nonce && row.turnId).map(row => row.turnId)),
          laterWrite = writes.filter(write => write.at > sentAt && write.writerTurn !== turn && !wakeTurns.has(write.writerTurn)).map(write => write.at),
          others     = intervals.filter(row => !row.nonce && row.turnId !== turn),
          laterTurn  = others.flatMap(row => [
              ...(row.startedAt > sentAt ? [row.startedAt] : []),
              ...(Date.parse(row.lastProgressAt) > Date.parse(closedAt) + WRITER_CLOSE_SKEW_MS ? [row.lastProgressAt] : [])
          ]),
          ownStart   = intervals.find(row => row.turnId === turn)?.startedAt
                    || writes.filter(write => write.writerKey === key && write.writerTurn === turn).map(write => write.at).sort()[0]
                    || sentAt;

    return {
        closedAt,
        promptedAt   : [...laterWrite, ...laterTurn].sort()[0] || null,
        liveTurnUntil: others.filter(row =>
            row.status === 'active'
            && row.expiresAt > nowIso
            && row.lastProgressAt >= ownStart
            && !(writerStamp(row).writerKey === key && row.startedAt <= ownStart)
        ).map(row => row.expiresAt).sort().at(-1) || null
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

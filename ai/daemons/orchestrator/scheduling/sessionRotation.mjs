import {
    countDirectMessagesBetween,
    getActiveSessionRotateRoutes,
    readSunsetReceipt,
    writeSessionRotation
} from '../../wake/sunsetReceipt.mjs';
import {
    buildRotationEnvelope,
    buildRotationPrompt,
    decideRotation,
    rotationEventId
} from '../../wake/sessionRotation.mjs';

/**
 * @module ai/daemons/orchestrator/scheduling/sessionRotation
 * @summary Container-plane lane that turns a seat's sunset handover into a fresh session: it reads
 * each rotatable seat's receipt, sends one signed `session/rotate` envelope per receipt to the seat's
 * `SESSION_ROTATE` route, and records every step on the handover node.
 *
 * Contract:
 * - **Authority class:** `container-plane`, because the receipt, the turn presence and the session
 *   memories are all in the graph. The host's wake receiver opens the session; this lane only asks.
 * - **One request per receipt:** the event id is `session-rotate:<receipt id>`, written to the receipt
 *   before the send. A send the receiver never accepted is sent again under the same id, so a retry is
 *   the receiver's duplicate rather than a second session.
 * - **Guards** ({@link decideRotation}): a prompt or a successor marker after the receipt refuses it, and
 *   so does a second request of one seat inside the minimum interval. The refusal and its reason are
 *   recorded. The handover's receipt count (`focusItemsReceipt`) must be consumed first.
 * - **Records:** `requested`, `completed` (the successor marker, both session ids and the messages the
 *   wake hold kept; the new id is `null` until the fresh session's first memory lands),
 *   `refused`, `incomplete` (the window passed). Each one is a log line, and the record stays on the
 *   handover node's `sessionRotation`.
 */

/**
 * @summary Runs one pass over every seat with an active rotation route.
 * @param {Object} options
 * @param {Object} options.db Open `better-sqlite3` handle on the graph store.
 * @param {Function} options.deliver `(subscription, envelope) => Promise<'delivered'|'skipped'|'failed'>`.
 * @param {Object} options.operatorPresence `{mode, until}` for the fresh session's prompt.
 * @param {Number} options.windowMs How long a receipt may wait for its fresh session.
 * @param {Number} options.minIntervalMs Minimum time between two requests of one seat.
 * @param {Function} options.writeLog `(level, message)`.
 * @param {Number} [options.now=Date.now()]
 * @returns {Promise<{requested: Number, completed: Number, refused: Number, incomplete: Number, waiting: Number}>}
 */
export async function runSessionRotation({db, deliver, operatorPresence, windowMs, minIntervalMs, writeLog, now = Date.now()}) {
    const nowIso   = new Date(now).toISOString(),
          sinceIso = new Date(now - 2 * windowMs - minIntervalMs).toISOString(),
          outcome  = {requested: 0, completed: 0, refused: 0, incomplete: 0, waiting: 0},
          routes   = new Map(getActiveSessionRotateRoutes(db).map(route => [route.properties.agentIdentity, route]));

    for (const [identity, route] of routes) {
        const read     = readSunsetReceipt(db, identity, {sinceIso, nowIso}),
              verdict  = decideRotation({read, now, windowMs, minIntervalMs}),
              receipt  = read?.receipt,
              rotation = receipt?.sessionRotation;

        if (verdict.action === 'none') continue;

        if (verdict.action === 'wait') {
            outcome.waiting++;
            continue
        }

        if (verdict.action === 'refuse') {
            // a refused re-send keeps its event id and its failed attempt on the record
            writeSessionRotation(db, receipt.id, {
                ...rotation,
                state       : 'refused',
                reason      : verdict.reason,
                refusedAt   : nowIso,
                oldSessionId: read.oldSessionId,
                ...(verdict.reason === 'minimum-interval'
                    ? {nextEligibleAt: new Date(Date.parse(read.lastRequestedAt) + minIntervalMs).toISOString()}
                    : {})
            });
            writeLog('INFO', `[Orchestrator] session-rotation: refused for ${identity} (${verdict.reason}), receipt ${receipt.id}`);
            outcome.refused++;
            continue
        }

        if (verdict.action === 'incomplete') {
            writeSessionRotation(db, receipt.id, {...rotation, state: 'incomplete', reason: verdict.reason, incompleteAt: nowIso});
            writeLog('ERROR', `[Orchestrator] session-rotation: incomplete for ${identity} (${verdict.reason}), receipt ${receipt.id}`);
            outcome.incomplete++;
            continue
        }

        if (verdict.action === 'complete') {
            const {id: successorMessageId, sentAt, sessionId} = read.successor,
                  heldMessages                                = countDirectMessagesBetween(db, identity, {afterIso: receipt.sentAt, untilIso: sentAt});

            writeSessionRotation(db, receipt.id, {...rotation, state: 'completed', completedAt: nowIso, successorMessageId, newSessionId: sessionId, heldMessages});
            writeLog('INFO', `[Orchestrator] session-rotation: completed for ${identity}, session ${rotation.oldSessionId} → ${sessionId ?? 'unsaved'}, successor ${successorMessageId}, receipt ${receipt.id}, ${heldMessages} held message(s)`);
            outcome.completed++;
            continue
        }

        // `request`: the id is on the receipt before the envelope leaves, so no failure path below can
        // produce a second request for this receipt under another id.
        const record = rotation || {
            state         : 'requested',
            eventId       : rotationEventId(receipt.id),
            subscriptionId: route.id,
            oldSessionId  : read.oldSessionId,
            requestedAt   : nowIso
        };

        writeSessionRotation(db, receipt.id, record);

        const delivery = await deliver(route, buildRotationEnvelope({
            subscription    : route,
            receiptMessageId: receipt.id,
            oldSessionId    : record.oldSessionId,
            prompt          : buildRotationPrompt({agentIdentity: identity, receiptMessageId: receipt.id, operatorPresence}),
            emittedAt       : nowIso
        }));

        writeSessionRotation(db, receipt.id, delivery === 'delivered'
            ? {...record, deliveredAt: nowIso}
            : {...record, lastDelivery: delivery, lastAttemptAt: nowIso});

        writeLog(delivery === 'delivered' ? 'INFO' : 'WARN',
            `[Orchestrator] session-rotation: requested for ${identity} (${delivery}), session ${record.oldSessionId}, receipt ${receipt.id}`);
        outcome.requested++
    }

    return outcome
}

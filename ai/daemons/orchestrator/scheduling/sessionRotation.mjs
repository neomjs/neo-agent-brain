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
 *   recorded.
 * - **Records:** `requested`, `completed` (the successor marker, the old session id and the messages the
 *   wake hold kept; `newSessionId` stays `null`, because the marker names no sender session),
 *   `refused`, `incomplete` (the window passed). Each one is a log line, and the record stays on the
 *   handover node's `sessionRotation`.
 * - **The hold reaches the receiver:** the envelope carries `holdUntil`, the receipt's `sentAt` plus the
 *   window, so a receiver waiting on a locked screen never types after the plane stopped holding the
 *   seat's wakes.
 * - **`incomplete` is told:** the plane cannot read the receiver's records, so a rotation that failed on the
 *   host surfaces only here, and an ERROR line alone reaches nobody. One `defect-note:` per receipt carries
 *   the seat, the handover and the prompt that starts the seat by hand.
 */

/**
 * @summary Composes the defect note for a receipt the plane recorded `incomplete`.
 * @param {Object} options
 * @param {String} options.identity The seat.
 * @param {Object} options.receipt The handover: `{id, sentAt}`.
 * @param {Object} [options.rotation] Its `sessionRotation` record, absent when nothing was requested.
 * @param {String} options.reason The verdict's reason.
 * @param {Number} options.windowMs
 * @param {String} options.prompt The first prompt a fresh session takes.
 * @returns {{subject: String, body: String, taggedConcepts: String[]}}
 */
export function composeIncompleteRotationNote({identity, receipt, rotation, reason, windowMs, prompt}) {
    return {
        subject: `defect-note: session rotation broke ${identity}: no fresh session within ${Math.round(windowMs / 60000)} min of its sunset handover ${receipt.id}`,
        body   : [
            `The plane recorded the rotation incomplete (${reason}).`,
            `- handover: ${receipt.id}, sent ${receipt.sentAt}`,
            `- rotation: requested ${rotation?.requestedAt ?? 'never'}, delivered ${rotation?.deliveredAt ?? 'never'}`,
            '',
            'Start the seat by hand: a new session in its window, with this first prompt:',
            prompt
        ].join('\n'),
        taggedConcepts: ['defect-note', 'session-rotation']
    }
}

/**
 * @summary Runs one pass over every seat with an active rotation route.
 * @param {Object} options
 * @param {Object} options.db Open `better-sqlite3` handle on the graph store.
 * @param {Function} options.deliver `(subscription, envelope) => Promise<'delivered'|'skipped'|'failed'>`.
 * @param {Object} options.operatorPresence `{mode, until}` for the fresh session's prompt.
 * @param {Number} options.windowMs How long a receipt may wait for its fresh session.
 * @param {Number} options.minIntervalMs Minimum time between two requests of one seat.
 * @param {Function} options.writeLog `(level, message)`.
 * @param {Function} [options.publishDefectNote] `(note) => Promise`, the mailbox publisher an `incomplete`
 *   record's note goes through.
 * @param {Number} [options.now=Date.now()]
 * @returns {Promise<{requested: Number, completed: Number, refused: Number, incomplete: Number, waiting: Number}>}
 */
export async function runSessionRotation({db, deliver, operatorPresence, windowMs, minIntervalMs, writeLog, publishDefectNote, now = Date.now()}) {
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
            // the one wait nothing else surfaces: an unattributable receipt after a predecessor's marker
            if (verdict.reason === 'writer-close-pending') {
                writeLog('INFO', `[Orchestrator] session-rotation: pending for ${identity} (${verdict.reason}), receipt ${receipt.id}`);
            }
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

            // `incomplete` is terminal, so this branch runs once per receipt and so does its note.
            try {
                await publishDefectNote?.(composeIncompleteRotationNote({
                    identity, receipt, rotation, windowMs,
                    reason: verdict.reason,
                    prompt: buildRotationPrompt({agentIdentity: identity, receiptMessageId: receipt.id, operatorPresence})
                }));
            } catch (error) {
                writeLog('WARN', `[Orchestrator] session-rotation: the incomplete note for ${identity} failed (${error.message}), receipt ${receipt.id}`);
            }
            continue
        }

        if (verdict.action === 'complete') {
            const {id: successorMessageId, sentAt} = read.successor,
                  heldMessages                     = countDirectMessagesBetween(db, identity, {afterIso: receipt.sentAt, untilIso: sentAt});

            writeSessionRotation(db, receipt.id, {...rotation, state: 'completed', completedAt: nowIso, successorMessageId, newSessionId: null, heldMessages});
            writeLog('INFO', `[Orchestrator] session-rotation: completed for ${identity}, session ${rotation.oldSessionId} → successor ${successorMessageId}, receipt ${receipt.id}, ${heldMessages} held message(s)`);
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
            emittedAt       : nowIso,
            holdUntil       : new Date(Date.parse(receipt.sentAt) + windowMs).toISOString()
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

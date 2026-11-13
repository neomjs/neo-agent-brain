import RequestContextService                                            from '../../mcp/server/shared/services/RequestContextService.mjs';
import GraphService                                                     from './GraphService.mjs';
import MailboxService, {isHumanOperatorIdentity, resolvePrincipalClass} from './MailboxService.mjs';
import WakeSubscriptionService                                          from './WakeSubscriptionService.mjs';
import {SYSTEM_SENDER}                                                  from '../../graph/mailboxRoots.mjs';
import {normalizeAgentIdentityNodeId}                                   from '../../graph/normalizeAgentIdentityNodeId.mjs';
import {composeOpenWorkWake, validateOpenWorkObservation}               from '../fleet/openWorkWakeMessage.mjs';
import {ownOpenWorkOf, writeOpenWorkCopy}                               from './openWorkCopyStore.mjs';

/**
 * @module ai/services/memory-core/openWorkWakeIntake
 * @summary The plane's intake for the Fleet's open-work wakes. The Fleet producer runs host-side, in the operator's
 * verified session, and submits one bounded observation per wake. The plane composes the message and sends it as
 * `@system`, so the wake reads as a system observation: not the operator's own message, not operator steering, and
 * not first in its recipient's drain. `add_message` cannot reach this sender, and this intake accepts no text.
 * The same session reads back whether each admitted wake arrived, which is what certifies a silent holder.
 *
 * The same session publishes the projection's copy after each pulse ({@link publishOpenWorkCopy}), and each seat
 * reads its own entry ({@link readOwnOpenWork}); the store is `openWorkCopyStore.mjs`.
 *
 * One wake is one task, so a repeated admission answers the first receipt instead of writing again. The Fleet retries
 * a submission whose answer it lost, and that write may already have landed. The record lives in this process: a
 * plane restart between a lost answer and its retry can still write a wake twice.
 */

const
    // The most wake messages one delivery read answers
    MAX_MESSAGE_IDS = 100,
    // The admissions a repeat can answer, newest last: days of wakes at the Fleet's pace
    MAX_ADMISSIONS  = 2000,
    admissions      = new Map();

/**
 * @summary Forget every admission, so the next one of the same wake writes again.
 */
export function resetOpenWorkWakeAdmissions() {
    admissions.clear()
}

/**
 * @summary The verified caller, admitted only when it is the Fleet's human operator: the gate every host-to-plane
 * open-work write passes, the wakes and the copy alike.
 * @param {String} surface The calling function, for an unavailable graph.
 * @param {String} action What the caller asked to do, for an unbound identity.
 * @param {String} [admitted='open-work wakes are'] What the refusal names as admitted.
 * @returns {{db: Object, operator: String}} The graph and the operator's identity node id.
 * @private
 */
function operatorOf(surface, action, admitted = 'open-work wakes are') {
    const
        db     = GraphService.requireDb(surface),
        caller = RequestContextService.getAgentIdentityNodeId();

    if (!caller) {
        throw RequestContextService.unboundIdentityError(action)
    }

    const operator = normalizeAgentIdentityNodeId(caller);

    if (!isHumanOperatorIdentity(db, operator)) {
        throw new Error(`Refused: ${admitted} admitted from the Fleet's human operator only, not from ${operator}.`)
    }

    return {db, operator}
}

/**
 * @summary Admits one open-work observation from the Fleet's human operator, composes its wake and sends it as
 * `@system`. The caller, the observation and the recipient are all checked before anything is written. The caller
 * is recorded as `task.observedBy`, read from the verified request identity, never from the arguments. A repeat of
 * the same wake answers the first receipt.
 * @param {Object} args `{repo, number, head, kind, episode, to, failedChecks, unblocks, holder}`, per `validateOpenWorkObservation`.
 * @returns {Promise<Object>} The `addMessage` receipt; its `messageId` is what {@link readOpenWorkWakeDelivery} answers for.
 */
export async function admitOpenWorkWake(args) {
    const
        {db, operator: observedBy} = operatorOf('admitOpenWorkWake', 'admit an open-work wake'),
        {observation, errors}      = validateOpenWorkObservation(args);

    if (errors.length) {
        throw new Error(`Refused open-work observation: ${errors.join('; ')}.`)
    }

    if (!['agent', 'human'].includes(resolvePrincipalClass(db, observation.to)) || !MailboxService.isReachableTarget(observation.to)) {
        throw new Error(`Refused open-work observation: ${observation.to} is not a registered agent or human identity.`)
    }

    const {task, ...message} = composeOpenWorkWake(observation);

    // A repeat answers the first receipt, even while that write is in flight; a failed write keeps nothing
    if (admissions.has(task.id)) return admissions.get(task.id);

    const admission = RequestContextService.run(
        {agentIdentityNodeId: SYSTEM_SENDER.id, principalClass: 'system', sessionId: 'open-work-wakes'},
        () => MailboxService.addMessage({...message, task: {...task, observedBy}}, {deferProjection: true})
    );

    admissions.set(task.id, admission);
    admission.catch(() => admissions.get(task.id) === admission && admissions.delete(task.id));
    admissions.size > MAX_ADMISSIONS && admissions.delete(admissions.keys().next().value);

    return admission
}

/**
 * @summary Answers, to the Fleet's human operator, whether each admitted wake arrived: one verdict per message from
 * the wake receiver's own dispatch records (`WakeSubscriptionService#readMessageDelivery`).
 * @param {Object} args
 * @param {String[]} args.messageIds 1 to 100 wake message ids, as {@link admitOpenWorkWake}'s receipt names them.
 * @returns {Promise<{deliveryReadable: Boolean, deliveryReadReason: String, messages: Object}>}
 */
export async function readOpenWorkWakeDelivery({messageIds} = {}) {
    operatorOf('readOpenWorkWakeDelivery', 'read open-work wake delivery');

    if (!Array.isArray(messageIds) || messageIds.length < 1 || messageIds.length > MAX_MESSAGE_IDS ||
        messageIds.some(id => typeof id !== 'string' || !/^MESSAGE:[\w-]{1,100}$/.test(id))) {
        throw new Error(`Refused: messageIds must be 1 to ${MAX_MESSAGE_IDS} wake message ids.`)
    }

    return WakeSubscriptionService.readMessageDelivery(messageIds)
}

/**
 * @summary Publishes the Fleet's open-work copy from the Fleet's human operator. The verified caller is the
 * publisher, so the publication replaces only that publisher's entries. A tracked identity the graph does not hold
 * as an agent is refused and named; a malformed publication writes nothing.
 * @param {Object} args `{observedAt, coverage, reason, tracked, seats}`, per `openWorkCopyStore#writeOpenWorkCopy`.
 * @returns {Promise<{publishedAt: String, tracked: Number, refused: Array<{seat: String, reason: String}>}>}
 */
export async function publishOpenWorkCopy(args) {
    const {db, operator} = operatorOf('publishOpenWorkCopy', 'publish the open-work copy', 'the open-work copy is');

    return writeOpenWorkCopy(operator, args, {isAgent: seat => resolvePrincipalClass(db, seat) === 'agent'})
}

/**
 * @summary The caller's own open work from the plane's copy, with its freshness. It binds to the verified identity
 * and takes no seat, so no caller reads another seat's work.
 * @returns {Promise<Object>} `openWorkCopyStore#ownOpenWorkOf`'s answer for the caller.
 */
export async function readOwnOpenWork() {
    const caller = RequestContextService.getAgentIdentityNodeId();

    if (!caller) {
        throw RequestContextService.unboundIdentityError('read own open work')
    }

    return ownOpenWorkOf(normalizeAgentIdentityNodeId(caller))
}

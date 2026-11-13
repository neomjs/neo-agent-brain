import RequestContextService                                            from '../../mcp/server/shared/services/RequestContextService.mjs';
import GraphService                                                     from './GraphService.mjs';
import MailboxService, {isHumanOperatorIdentity, resolvePrincipalClass} from './MailboxService.mjs';
import WakeSubscriptionService                                          from './WakeSubscriptionService.mjs';
import {SYSTEM_SENDER}                                                  from '../../graph/mailboxRoots.mjs';
import {normalizeAgentIdentityNodeId}                                   from '../../graph/normalizeAgentIdentityNodeId.mjs';
import {composeOpenWorkWake, validateOpenWorkObservation}               from '../fleet/openWorkWakeMessage.mjs';

/**
 * @module ai/services/memory-core/openWorkWakeIntake
 * @summary The plane's intake for the Fleet's open-work wakes. The Fleet producer runs host-side, in the operator's
 * verified session, and submits one bounded observation per wake. The plane composes the message and sends it as
 * `@system`, so the wake reads as a system observation: not the operator's own message, not operator steering, and
 * not first in its recipient's drain. `add_message` cannot reach this sender, and this intake accepts no text.
 * The same session reads back whether each admitted wake arrived, which is what certifies a silent holder.
 */

/** @summary The most wake messages one delivery read answers. */
const MAX_MESSAGE_IDS = 100;

/**
 * @summary The verified caller, admitted only when it is the Fleet's human operator.
 * @param {String} surface The calling function, for an unavailable graph.
 * @param {String} action What the caller asked to do, for an unbound identity.
 * @returns {{db: Object, operator: String}} The graph and the operator's identity node id.
 * @private
 */
function operatorOf(surface, action) {
    const
        db     = GraphService.requireDb(surface),
        caller = RequestContextService.getAgentIdentityNodeId();

    if (!caller) {
        throw RequestContextService.unboundIdentityError(action)
    }

    const operator = normalizeAgentIdentityNodeId(caller);

    if (!isHumanOperatorIdentity(db, operator)) {
        throw new Error(`Refused: open-work wakes are admitted from the Fleet's human operator only, not from ${operator}.`)
    }

    return {db, operator}
}

/**
 * @summary Admits one open-work observation from the Fleet's human operator, composes its wake and sends it as
 * `@system`. The caller, the observation and the recipient are all checked before anything is written. The caller
 * is recorded as `task.observedBy`, read from the verified request identity, never from the arguments.
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

    return RequestContextService.run(
        {agentIdentityNodeId: SYSTEM_SENDER.id, principalClass: 'system', sessionId: 'open-work-wakes'},
        () => MailboxService.addMessage({...message, task: {...task, observedBy}}, {deferProjection: true})
    )
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

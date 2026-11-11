import RequestContextService                                          from '../../mcp/server/shared/services/RequestContextService.mjs';
import GraphService                                                   from './GraphService.mjs';
import MailboxService, {isHumanOperatorIdentity, resolvePrincipalClass} from './MailboxService.mjs';
import {SYSTEM_SENDER}                                                from '../../graph/mailboxRoots.mjs';
import {normalizeAgentIdentityNodeId}                                 from '../../graph/normalizeAgentIdentityNodeId.mjs';
import {composeOpenWorkWake, validateOpenWorkObservation}             from '../fleet/openWorkWakeMessage.mjs';

/**
 * @module ai/services/memory-core/openWorkWakeIntake
 * @summary The plane's intake for the Fleet's open-work wakes. The Fleet producer runs host-side, in the operator's
 * verified session, and submits one bounded observation per wake. The plane composes the message and sends it as
 * `@system`, so the wake reads as a system observation: not the operator's own message, not operator steering, and
 * not first in its recipient's drain. `add_message` cannot reach this sender, and this intake accepts no text.
 */

/**
 * @summary Admits one open-work observation from the Fleet's human operator, composes its wake and sends it as
 * `@system`. The caller, the observation and the recipient are all checked before anything is written. The caller
 * is recorded as `task.observedBy`, read from the verified request identity, never from the arguments.
 * @param {Object} args `{repo, number, head, kind, episode, to, failedChecks}`, per `validateOpenWorkObservation`.
 * @returns {Promise<Object>} The `addMessage` receipt.
 */
export async function admitOpenWorkWake(args) {
    const
        db     = GraphService.requireDb('admitOpenWorkWake'),
        caller = RequestContextService.getAgentIdentityNodeId();

    if (!caller) {
        throw RequestContextService.unboundIdentityError('admit an open-work wake')
    }

    const observedBy = normalizeAgentIdentityNodeId(caller);

    if (!isHumanOperatorIdentity(db, observedBy)) {
        throw new Error(`Refused: open-work wakes are admitted from the Fleet's human operator only, not from ${observedBy}.`)
    }

    const {observation, errors} = validateOpenWorkObservation(args);

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

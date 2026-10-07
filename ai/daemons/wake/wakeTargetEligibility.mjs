import {normalizeAgentIdentityNodeId} from '../../graph/normalizeAgentIdentityNodeId.mjs';

/**
 * @module Neo.ai.daemons.wake.wakeTargetEligibility
 * @summary May an identity RECEIVE a wake: the daemon's delivery permission, over the participation each
 * identity node records.
 *
 * Extracted from the wake daemon rather than copied, so the rule has one home. Participation is the identity
 * node's fact, which an operator records for their own seats; the daemon reads it from its graph store once per
 * poll cycle (`ai/graph/agentIdentityParticipation.mjs`), the same rows `who_is_online` reads.
 *
 * Receive-permission is deliberately permissive: an identity without a node stays eligible, so forks and
 * local custom agents keep working. It is not a census of the seats that ought to hold a route; the receiver
 * manifest builder takes that list from its caller.
 */

/**
 * @summary Whether a wake subscription target may receive wake delivery now.
 *
 * Three answers, because two of them ask for different handling. `eligible`: deliver. `benched`: the node
 * records a non-active participation, so queued and retried work for it is dropped. `unread`: no participation
 * read answered, so queued and retried work waits for one. An identity without a node is `eligible`.
 * @param {String} identity Agent identity.
 * @param {Map<String,String>|null} participation From {@link participationByIdentity}; `null` when unread.
 * @returns {'eligible'|'benched'|'unread'}
 */
export function wakeTargetPermission(identity, participation) {
    if (!participation) return 'unread';
    if (!identity) return 'eligible';

    const participationStatus = participation.get(normalizeAgentIdentityNodeId(identity));

    return !participationStatus || participationStatus === 'active' ? 'eligible' : 'benched'
}

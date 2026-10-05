import {normalizeAgentIdentityNodeId} from '../../graph/normalizeAgentIdentityNodeId.mjs';

/**
 * @module Neo.ai.daemons.wake.wakeTargetEligibility
 * @summary May an identity RECEIVE a wake: the daemon's delivery permission, over the participation each
 * identity node records.
 *
 * Extracted from the wake daemon rather than copied, so the rule has one home. Participation is the identity
 * node's fact, which an operator records for their own seats; the daemon reads the nodes from its graph store
 * once per poll cycle (`getAgentIdentityNodes` in `queries.mjs`), the same rows `who_is_online` reads.
 *
 * Receive-permission is deliberately permissive: an identity without a node stays eligible, so forks and
 * local custom agents keep working. It is not a census of the seats that ought to hold a route; the receiver
 * manifest builder takes that list from its caller.
 */

/**
 * @summary Canonical identity → participation status, from AgentIdentity node records.
 * @param {Object[]} nodes `{id, properties}` records.
 * @returns {Map<String,String>}
 */
export function participationByIdentity(nodes) {
    return new Map(nodes.map(node => [
        normalizeAgentIdentityNodeId(node.id),
        node.properties?.participationStatus || 'active'
    ]))
}

/**
 * @summary True when a wake subscription target may receive wake delivery.
 *
 * An identity without a node stays eligible. One whose node records a non-active participation is filtered
 * before coalescing, so it never creates delivery attempts or retries. Without a participation read, nothing
 * is eligible.
 * @param {String} identity Agent identity.
 * @param {Map<String,String>|null} participation From {@link participationByIdentity}; `null` when unread.
 * @returns {Boolean}
 */
export function isWakeTargetEligible(identity, participation) {
    if (!participation) return false;
    if (!identity) return true;

    const participationStatus = participation.get(normalizeAgentIdentityNodeId(identity));

    return !participationStatus || participationStatus === 'active'
}

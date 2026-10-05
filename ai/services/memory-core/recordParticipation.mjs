/**
 * @module ai/services/memory-core/recordParticipation
 * @summary The one write of an identity's participation decision: `active` or `operator_benched` on the
 * plane's `AgentIdentity` node, with the operator's reason, its date and who decided.
 *
 * A recorded decision outranks the seed. The seeder leaves the {@link PARTICIPATION_FIELDS} of a node that
 * carries `participationDecidedBy` alone, and the Memory Core's sign-in refresh never writes participation
 * on an existing node. Identity-wide authority is the caller's to hold: today only the plane host has it
 * (`ai/scripts/fleet/participation.mjs`), because one seat's operator must never decide for an identity
 * that other seats share.
 */

/**
 * @type {String[]}
 */
export const PARTICIPATION_DECISIONS = Object.freeze(['active', 'operator_benched']);

/**
 * The node fields a decision owns.
 * @type {String[]}
 */
export const PARTICIPATION_FIELDS = Object.freeze([
    'participationStatus', 'statusReason', 'since', 'reactivationTrigger', 'participationDecidedBy'
]);

/**
 * @summary A node's participation fields, absent ones as `null`.
 * @param {Object} properties
 * @returns {Object}
 */
export function readParticipation(properties) {
    return Object.fromEntries(PARTICIPATION_FIELDS.map(field => [field, properties?.[field] ?? null]))
}

/**
 * @summary Records one participation decision on an identity node, or reports what it would record.
 *
 * Re-recording the decision a node already carries writes nothing, so `since` keeps the date the decision
 * began.
 * @param {Object} options
 * @param {Object} options.graphService A GraphService exposing `getNodeRecord` and `upsertGlobalNode`.
 * @param {String} options.identityId The node id, e.g. `@neo-kimi-iris`.
 * @param {String} options.status One of {@link PARTICIPATION_DECISIONS}.
 * @param {String|null} [options.reason=null] Required for a bench; a return to `active` clears it.
 * @param {String} options.actor Who decided, e.g. `os-user:tobiu`.
 * @param {Boolean} [options.apply=false] Write; without it the result only says what would change.
 * @param {Date} [options.now=new Date()]
 * @returns {Object} `{ok: true, applied, unchanged, identity, before, after}`, or `{ok: false, refused, reason}`.
 */
export function recordParticipation({graphService, identityId, status, reason = null, actor, apply = false, now = new Date()}) {
    const statusReason = status === 'active' ? null : (typeof reason === 'string' ? reason.trim() : '');

    if (!PARTICIPATION_DECISIONS.includes(status)) {
        return {ok: false, refused: 'unknown-status', reason: `the status must be one of ${PARTICIPATION_DECISIONS.join(', ')}`}
    }

    if (status === 'operator_benched' && !statusReason) {
        return {ok: false, refused: 'no-reason', reason: 'a bench needs the operator\'s reason'}
    }

    if (typeof actor !== 'string' || !actor) {
        return {ok: false, refused: 'no-actor', reason: 'a decision names who made it'}
    }

    const node = graphService.getNodeRecord({id: identityId});

    if (!node) {
        return {ok: false, refused: 'unknown-identity', reason: `no node ${identityId}`}
    }

    if (node.type !== 'AgentIdentity') {
        return {ok: false, refused: 'not-an-identity', reason: `${identityId} is a ${node.type} node`}
    }

    const before    = readParticipation(node.properties),
          unchanged = before.participationDecidedBy !== null && before.participationStatus === status &&
                      before.statusReason === statusReason,
          after     = unchanged ? before : {
              participationStatus   : status,
              statusReason,
              since                 : now.toISOString(),
              reactivationTrigger   : null,
              participationDecidedBy: actor
          };

    if (apply && !unchanged) {
        graphService.upsertGlobalNode({id: identityId, type: 'AgentIdentity', properties: after})
    }

    return {ok: true, applied: apply && !unchanged, unchanged, identity: identityId, before, after}
}

export default recordParticipation;

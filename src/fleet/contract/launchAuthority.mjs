/**
 * @module src/fleet/contract/launchAuthority
 * @summary Whether this fleet may launch a seat, as a predicate over a registry row and the seat's
 * participation, and nothing else.
 *
 * It lives beside the rest of the Fleet contract rather than inside the registry service because the
 * spawn path has to ask it too: the provisioning composer runs between admission and spawn, and
 * reaching a service to re-ask would pull AiConfig and a Neo class into a chain that deliberately has
 * neither. One predicate, one home, every caller. Participation arrives as an input because it is the
 * seat's identity node's fact, which the caller reads from the plane.
 */

/**
 * @summary Why this fleet may not start a seat, or `null` when it may. A seat released to its own harness
 * by an explicit act (`external` with a `launchOwnerSince`) runs there, and a process record the fleet kept
 * from an earlier run is history, not permission to launch it again. A definition that never had an
 * ownership act answers `null`, so its process record stays its only start gate. A seat whose identity the
 * operator benched is refused with the operator's date and reason.
 * @param {Object|null} definition A registry definition, public or internal.
 * @param {Object|null} [participation=null] `{status, reason, since}` as the seat's identity node records it;
 *     `null` when the read did not answer or holds no record, which is no refusal.
 * @returns {String|null}
 */
export function launchRefusalOf(definition, participation = null) {
    if (definition?.launchOwner === 'external' && definition.launchOwnerSince) {
        return 'released to its own harness: adopt it to start it here'
    }

    const {status, reason, since} = participation ?? {};

    if (!status || status === 'active') return null;

    const decided = status === 'operator_benched' ? 'benched by the operator' : `marked ${status}`,
          date    = typeof since === 'string' && since ? ` on ${since.slice(0, 10)}` : '';

    return `${decided}${date}${reason ? `: ${reason}` : ''}`
}

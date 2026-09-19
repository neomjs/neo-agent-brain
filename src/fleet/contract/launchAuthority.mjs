/**
 * @module src/fleet/contract/launchAuthority
 * @summary Whether this fleet may launch a seat, as a predicate over a registry row and nothing else.
 *
 * It lives beside the rest of the Fleet contract rather than inside the registry service because the
 * spawn path has to ask it too: the provisioning composer runs between admission and spawn, and
 * reaching a service to re-ask would pull AiConfig and a Neo class into a chain that deliberately has
 * neither. One predicate, one home, both callers.
 */

/**
 * @summary Why this fleet may not start a seat, or `null` when it may. A seat released to its own harness
 * by an explicit act (`external` with a `launchOwnerSince`) runs there, and a process record the fleet kept
 * from an earlier run is history, not permission to launch it again. A definition that never had an
 * ownership act answers `null`, so its process record stays its only start gate.
 * @param {Object|null} definition A registry definition, public or internal.
 * @returns {String|null}
 */
export function launchRefusalOf(definition) {
    return definition?.launchOwner === 'external' && definition.launchOwnerSince
        ? 'released to its own harness: adopt it to start it here'
        : null
}

/**
 * @module ai/services/fleet/forgeProviders
 * @summary The names a stranger reads for the forges a plane admits PATs from. Ids stay lowercase on the wire, in
 * registry records and in receipts; every sentence a card or a refusal shows says `GitHub` or `GitLab`. Free of Neo
 * imports, so the host-side setup effects and the plane-side registry speak the same words.
 */

/**
 * The display name of each forge id the plane's auth modes admit.
 * @type {Readonly<Object<String, String>>}
 */
export const FORGE_PROVIDER_NAMES = Object.freeze({github: 'GitHub', gitlab: 'GitLab'});

/**
 * The words for a forge the sentence cannot name yet: the plane is not running, or its auth mode admits no PAT.
 * @type {String}
 */
export const ANY_FORGE_NAME = 'GitHub or GitLab';

/**
 * @summary The display name of a forge id. An id outside the map prints as it is, never silently as GitHub.
 * @param {String} id
 * @returns {String}
 */
export function forgeProviderName(id) {
    return Object.hasOwn(FORGE_PROVIDER_NAMES, id) ? FORGE_PROVIDER_NAMES[id] : id
}

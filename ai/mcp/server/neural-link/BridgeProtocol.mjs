/**
 * @summary Protocol contract shared by the Neural Link Bridge and agent-side
 * ConnectionService.
 *
 * A running Bridge must emit this stamp during agent registration before the
 * agent-side service treats the connection as fresh. Older Bridge processes do
 * not know this frame, which lets local e2e runs fail loudly instead of binding
 * stale behavior from a long-lived `:8081` process.
 */
export const BRIDGE_INFO_TYPE = 'bridge_info';

/** @summary Read-only verifier response; never an agent registration or a server-authentication proof. */
export const BRIDGE_VERIFIER_TYPE = 'bridge_verifier';

/**
 * @summary Monotonic Bridge protocol version for agent-side freshness checks.
 * Bump this or `BRIDGE_PROTOCOL_FEATURES` whenever the Bridge's agent-facing
 * behavior changes in a way clients must not accept from stale long-lived processes.
 * @type {Number}
 */
export const BRIDGE_PROTOCOL_VERSION = 1;

/**
 * @summary Current protocol capabilities that stale local bridges must prove.
 * @type {String[]}
 */
export const BRIDGE_PROTOCOL_FEATURES = Object.freeze([
    'agent-message-sidecar',
    'fleet-test-role-auth'
]);

/**
 * @summary Error code used when a running Bridge is reachable but not fresh.
 * @type {String}
 */
export const STALE_BRIDGE_ERROR_CODE = 'NEURAL_LINK_STALE_BRIDGE';

/**
 * @summary Creates the Bridge freshness payload emitted to newly-connected agents.
 * @returns {Object}
 */
export function createBridgeInfoPayload() {
    return {
        type           : BRIDGE_INFO_TYPE,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        features       : [...BRIDGE_PROTOCOL_FEATURES]
    };
}

/**
 * @summary Describes the cached verifier used by the running Bridge's token gate.
 * @param {String|null} publicKeySha256 SHA-256 of SPKI DER, or null for legacy unauthenticated mode.
 * @returns {Object}
 */
export function createBridgeVerifierPayload(publicKeySha256) {
    return {
        ...createBridgeInfoPayload(),
        type    : BRIDGE_VERIFIER_TYPE,
        authMode: publicKeySha256 === null ? 'legacy' : 'ed25519',
        publicKeySha256
    }
}

/**
 * @summary Checks the closed verifier response against the original signing authority.
 * This detects drift under loopback/same-UID custody; an unsigned response cannot authenticate a server.
 * @param {Object} payload Parsed, bounded JSON response.
 * @param {String} publicKeySha256 Original SPKI DER fingerprint.
 * @returns {Boolean}
 */
export function isBridgeVerifierPayloadFresh(payload, publicKeySha256) {
    return !!payload && Object.getPrototypeOf(payload) === Object.prototype &&
        Object.keys(payload).sort().join(',') === 'authMode,features,protocolVersion,publicKeySha256,type' &&
        payload.type === BRIDGE_VERIFIER_TYPE && payload.authMode === 'ed25519' &&
        typeof publicKeySha256 === 'string' && /^[a-f0-9]{64}$/.test(publicKeySha256) &&
        payload.publicKeySha256 === publicKeySha256 &&
        isBridgeInfoPayloadFresh({...payload, type: BRIDGE_INFO_TYPE})
}

/**
 * @summary Returns true when a Bridge freshness payload matches the current protocol.
 * @param {Object} payload
 * @returns {Boolean}
 */
export function isBridgeInfoPayloadFresh(payload) {
    return payload?.type === BRIDGE_INFO_TYPE &&
           payload.protocolVersion === BRIDGE_PROTOCOL_VERSION &&
           Array.isArray(payload.features) &&
           BRIDGE_PROTOCOL_FEATURES.every(feature => payload.features.includes(feature))
}

/**
 * @summary Creates a typed stale-Bridge error for ConnectionService control flow.
 * @param {String} message
 * @returns {Error}
 */
export function createStaleBridgeError(message) {
    const error = new Error(message);
    error.code  = STALE_BRIDGE_ERROR_CODE;
    return error
}

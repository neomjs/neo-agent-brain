/**
 * @module src/fleet/contract/wire
 * @summary Canonical Fleet wire vocabulary, negotiation and finite request/response envelopes.
 *
 * These helpers describe transport mechanics, not authorization. Servers still validate the
 * authenticated viewer and method-specific input before dispatching. Unknown methods, incompatible
 * protocol offers and malformed responses fail closed. No service, credential or runtime is imported.
 */

/** @type {ReadonlyArray<String>} */
export const FLEET_WIRE_METHODS = Object.freeze([
    'defineAgent', 'configureAgent', 'setRepo', 'setAvatar', 'listAgents', 'getAgent',
    'startAgent', 'stopAgent', 'restartAgent', 'removeAgent', 'fleetStatus', 'fleetRuntimeStatus',
    'getBootIdentity', 'fleetActivity', 'fleetHistory', 'fleetMemories', 'fleetSessionMemories', 'fleetRoster', 'fleetMailboxMirror', 'connectTenant', 'listTenants',
    'composeOperatorMessage', 'markFleetCaughtUp', 'resolveViewerIdentity', 'fleetWakeRoutes', 'fleetTasks',
    'fleetDeploymentState'
]);

/**
 * @summary Protocol versions this Fleet service can select, newest first. A client offers one or
 * more versions and the server selects the first common member before method policy or bridge
 * execution. Version 1 introduces explicit capability offers and closed response states.
 * @type {Number[]}
 */
export const FLEET_WIRE_PROTOCOL_VERSIONS = Object.freeze([1]);

/**
 * @summary Client-safe protocol capabilities implemented by this authority. These are wire
 * mechanics only — never identity, bearer, ownership, authorization, or lifecycle policy.
 * @type {String[]}
 */
export const FLEET_WIRE_CAPABILITIES = Object.freeze([
    'method-schema-v1',
    'closed-response-states-v1'
]);

/**
 * @summary Capabilities a client must offer for the current server contract to be usable.
 * Kept distinct from the full capability catalog so future additive capabilities can remain
 * optional without silently widening the minimum client contract.
 * @type {String[]}
 */
export const FLEET_WIRE_REQUIRED_CAPABILITIES = Object.freeze([
    'method-schema-v1',
    'closed-response-states-v1'
]);

/**
 * @summary The finite top-level response-state vocabulary. Domain outcomes such as an admission
 * rejection remain inside result; these states describe only the wire/dispatch layer.
 * @type {Readonly<Record<String, String>>}
 */
export const FLEET_WIRE_RESPONSE_STATES = Object.freeze({
    degraded             : 'degraded',
    ok                   : 'ok',
    operationFailed      : 'operation-failed',
    refused              : 'refused',
    unsupportedCapability: 'unsupported-capability',
    unsupportedMethod    : 'unsupported-method',
    unsupportedProtocol  : 'unsupported-protocol'
});

/**
 * @summary Executable vocabulary for the request offer, selected contract, and response envelope.
 * It is intentionally structural rather than a duplicate of server-side domain validators.
 * @type {Readonly<Object>}
 */
export const FLEET_WIRE_ENVELOPE_SCHEMA = Object.freeze({
    offer: Object.freeze({
        required: Object.freeze(['versions', 'capabilities'])
    }),
    request: Object.freeze({
        required: Object.freeze(['method', 'protocol']),
        optional: Object.freeze(['params'])
    }),
    response: Object.freeze({
        required       : Object.freeze(['ok', 'state', 'protocol']),
        successRequired: Object.freeze(['result']),
        failureRequired: Object.freeze(['error']),
        optional       : Object.freeze(['degraded'])
    }),
    selection: Object.freeze({
        required: Object.freeze(['version', 'capabilities'])
    })
});

const
    MAX_PROTOCOL_CAPABILITIES = 64,
    MAX_PROTOCOL_TOKEN_LENGTH = 100,
    MAX_PROTOCOL_VERSIONS     = 16,
    MAX_WIRE_DEGRADED_LENGTH  = 100,
    MAX_WIRE_ERROR_LENGTH     = 300,
    responseStates            = new Set(Object.values(FLEET_WIRE_RESPONSE_STATES));

/**
 * @summary Identifies a plain record-shaped wire value without accepting arrays or null.
 * @param {*} value
 * @returns {Boolean}
 * @private
 */
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @summary Creates the current client offer. Fresh arrays keep callers from mutating the frozen
 * authority or sharing mutable offer state between concurrent requests.
 * @returns {{capabilities: String[], versions: Number[]}}
 */
export function createFleetWireOffer() {
    return {
        capabilities: [...FLEET_WIRE_CAPABILITIES],
        versions    : [...FLEET_WIRE_PROTOCOL_VERSIONS]
    }
}

/**
 * @summary Creates the server's selected-contract stamp.
 * @param {Number} [version=FLEET_WIRE_PROTOCOL_VERSIONS[0]]
 * @param {String[]} [capabilities=FLEET_WIRE_CAPABILITIES]
 * @returns {{capabilities: String[], version: Number}}
 */
export function createFleetWireProtocolStamp(
    version = FLEET_WIRE_PROTOCOL_VERSIONS[0],
    capabilities = FLEET_WIRE_CAPABILITIES
) {
    return {
        capabilities: [...capabilities],
        version
    }
}

/**
 * @summary Selects one compatible Fleet wire contract from a client offer. Unknown additive
 * capabilities are ignored; every required capability must be present. The result is bounded and
 * carries no caller-authored values except a selected member of the server-owned catalogs.
 * @param {Object} offer
 * @returns {{ok: Boolean, protocol: Object, state: String, error: (String|undefined)}}
 */
export function selectFleetWireContract(offer) {
    const
        versionsValid = Array.isArray(offer?.versions) &&
            offer.versions.length > 0 &&
            offer.versions.length <= MAX_PROTOCOL_VERSIONS &&
            offer.versions.every(version => Number.isInteger(version) && version > 0),
        version = versionsValid
            ? FLEET_WIRE_PROTOCOL_VERSIONS.find(candidate => offer.versions.includes(candidate))
            : undefined;

    if (version === undefined) {
        return {
            error   : 'fleet: unsupported wire protocol',
            ok      : false,
            protocol: createFleetWireProtocolStamp(),
            state   : FLEET_WIRE_RESPONSE_STATES.unsupportedProtocol
        }
    }

    const capabilitiesValid = Array.isArray(offer?.capabilities) &&
        offer.capabilities.length <= MAX_PROTOCOL_CAPABILITIES &&
        offer.capabilities.every(capability => typeof capability === 'string' &&
            capability.length > 0 && capability.length <= MAX_PROTOCOL_TOKEN_LENGTH) &&
        new Set(offer.capabilities).size === offer.capabilities.length;

    if (!capabilitiesValid) {
        return {
            error   : 'fleet: unsupported wire capability offer',
            ok      : false,
            protocol: createFleetWireProtocolStamp(version),
            state   : FLEET_WIRE_RESPONSE_STATES.unsupportedCapability
        }
    }

    const
        offered = new Set(offer.capabilities),
        missing = FLEET_WIRE_REQUIRED_CAPABILITIES.filter(capability => !offered.has(capability));

    if (missing.length > 0) {
        return {
            error   : 'fleet: missing required wire capabilities: ' + missing.join(', '),
            ok      : false,
            protocol: createFleetWireProtocolStamp(version),
            state   : FLEET_WIRE_RESPONSE_STATES.unsupportedCapability
        }
    }

    return {
        ok      : true,
        protocol: createFleetWireProtocolStamp(
            version,
            FLEET_WIRE_CAPABILITIES.filter(capability => offered.has(capability))
        ),
        state: FLEET_WIRE_RESPONSE_STATES.ok
    }
}

/**
 * @summary Creates a client request with a main/client-owned protocol offer. The method must come
 * from the public operation vocabulary; callers cannot use this helper to mint a wider surface.
 * @param {String} method
 * @param {*} params
 * @param {Object} [protocol=createFleetWireOffer()]
 * @returns {{method: String, params: *, protocol: Object}}
 */
export function createFleetWireRequest(method, params, protocol = createFleetWireOffer()) {
    if (!FLEET_WIRE_METHODS.includes(method)) {
        throw new TypeError("fleet: method '" + method + "' is not on the client contract")
    }

    return {
        method,
        params,
        protocol: {
            capabilities: Array.isArray(protocol?.capabilities) ? [...protocol.capabilities] : protocol?.capabilities,
            versions    : Array.isArray(protocol?.versions) ? [...protocol.versions] : protocol?.versions
        }
    }
}

/**
 * @summary Creates one finite Fleet wire response. Success is derived from the state rather than
 * accepted as a second caller-controlled truth.
 * @param {String} state One of {@link FLEET_WIRE_RESPONSE_STATES}.
 * @param {Object} [options]
 * @param {String} [options.degraded]
 * @param {String} [options.error]
 * @param {Object} [options.protocol=createFleetWireProtocolStamp()]
 * @param {*} [options.result]
 * @returns {Object}
 */
export function createFleetWireResponse(state, {
    degraded,
    error,
    protocol = createFleetWireProtocolStamp(),
    result
} = {}) {
    if (!responseStates.has(state)) {
        throw new TypeError("fleet: unknown wire response state '" + state + "'")
    }

    if (!isRecord(protocol) ||
        !Number.isInteger(protocol.version) || protocol.version < 1 ||
        !Array.isArray(protocol.capabilities) ||
        protocol.capabilities.length > MAX_PROTOCOL_CAPABILITIES ||
        !protocol.capabilities.every(capability => typeof capability === 'string' &&
            capability.length > 0 && capability.length <= MAX_PROTOCOL_TOKEN_LENGTH) ||
        new Set(protocol.capabilities).size !== protocol.capabilities.length) {
        throw new TypeError('fleet: invalid selected wire protocol stamp')
    }

    const
        ok       = state === FLEET_WIRE_RESPONSE_STATES.ok,
        envelope = {
            ok,
            state,
            protocol: createFleetWireProtocolStamp(protocol.version, protocol.capabilities)
        };

    if (ok) {
        if (result === undefined) {
            throw new TypeError('fleet: successful wire response requires a result')
        }

        envelope.result = result
    } else {
        envelope.error = typeof error === 'string' && error
            ? error.slice(0, MAX_WIRE_ERROR_LENGTH)
            : 'fleet: request failed';

        if (typeof degraded === 'string' && degraded) {
            envelope.degraded = degraded.slice(0, MAX_WIRE_DEGRADED_LENGTH)
        }
    }

    return envelope
}

/**
 * @summary Validates a server envelope against the offer this client sent. Unsupported
 * version/capability states may advertise the server's current stamp; every other state must carry
 * a contract the client actually offered.
 * @param {Object} envelope
 * @param {Object} [offer=createFleetWireOffer()]
 * @returns {{error: (String|undefined), ok: Boolean}}
 */
export function inspectFleetWireResponse(envelope, offer = createFleetWireOffer()) {
    const
        responseKeys  = new Set(Object.values(FLEET_WIRE_ENVELOPE_SCHEMA.response).flat()),
        selectionKeys = new Set(FLEET_WIRE_ENVELOPE_SCHEMA.selection.required),
        state         = envelope?.state;

    if (!isRecord(envelope) ||
        Object.keys(envelope).some(key => !responseKeys.has(key)) ||
        !responseStates.has(state) ||
        envelope.ok !== (state === FLEET_WIRE_RESPONSE_STATES.ok) ||
        (state === FLEET_WIRE_RESPONSE_STATES.ok &&
            (!Object.hasOwn(envelope, 'result') || envelope.result === undefined ||
                Object.hasOwn(envelope, 'error') || Object.hasOwn(envelope, 'degraded'))) ||
        (state !== FLEET_WIRE_RESPONSE_STATES.ok &&
            (typeof envelope.error !== 'string' || envelope.error.length === 0 ||
                envelope.error.length > MAX_WIRE_ERROR_LENGTH || Object.hasOwn(envelope, 'result'))) ||
        (state === FLEET_WIRE_RESPONSE_STATES.degraded &&
            (typeof envelope.degraded !== 'string' || envelope.degraded.length === 0 ||
                envelope.degraded.length > MAX_WIRE_DEGRADED_LENGTH)) ||
        (state !== FLEET_WIRE_RESPONSE_STATES.degraded && Object.hasOwn(envelope, 'degraded')) ||
        !isRecord(envelope.protocol) ||
        Object.keys(envelope.protocol).some(key => !selectionKeys.has(key)) ||
        !Number.isInteger(envelope.protocol.version) || envelope.protocol.version < 1 ||
        !Array.isArray(envelope.protocol.capabilities) ||
        envelope.protocol.capabilities.length > MAX_PROTOCOL_CAPABILITIES ||
        !envelope.protocol.capabilities.every(capability => typeof capability === 'string' &&
            capability.length > 0 && capability.length <= MAX_PROTOCOL_TOKEN_LENGTH) ||
        new Set(envelope.protocol.capabilities).size !== envelope.protocol.capabilities.length) {
        return {error: 'fleet: malformed wire response', ok: false}
    }

    const negotiationRefusal = [
        FLEET_WIRE_RESPONSE_STATES.unsupportedCapability,
        FLEET_WIRE_RESPONSE_STATES.unsupportedProtocol
    ].includes(envelope.state);

    if (!negotiationRefusal) {
        if (!Array.isArray(offer?.versions) ||
            !Array.isArray(offer?.capabilities) ||
            !offer.versions.includes(envelope.protocol.version)) {
            return {error: 'fleet: response selected an unoffered wire protocol', ok: false}
        }

        const
            offeredCapabilities = new Set(offer?.capabilities),
            selected            = new Set(envelope.protocol.capabilities);

        if (FLEET_WIRE_REQUIRED_CAPABILITIES.some(capability => !selected.has(capability))) {
            return {error: 'fleet: response omitted a required wire capability', ok: false}
        }

        if (envelope.protocol.capabilities.some(capability => !offeredCapabilities.has(capability))) {
            return {error: 'fleet: response selected an unoffered wire capability', ok: false}
        }
    }

    return {ok: true}
}

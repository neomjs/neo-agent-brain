import {createFleetRegistryBridge}  from './createFleetRegistryBridge.mjs';
import {normalizeSecureMcpEndpoint} from './mcpWireParsing.mjs';

/**
 * The static transport-failure message handed to the wire bridge, so an unreachable plane is told
 * apart from a plane that answered with a refusal.
 * @type {String}
 */
const UNREACHABLE = 'fleet: the plane did not answer';

/**
 * @module ai/services/fleet/planeFleetClient
 * @summary The containerized plane's fleet surface, as the host relay reaches it in plane mode: a seat
 * is defined on the plane first, because the plane owns a seat's definition and its operator; the relay
 * only applies what the plane answered.
 *
 * It presents the **fleet-surface credential** (`fleet.planeAdmissionBearer`) and never a plane-minted
 * MC bearer: the credential-class ledger forbids that at `/fleet`, and the boot entry asserts the two are
 * distinct mints unless the plane bearer is the operator's declared forge PAT
 * (`assertFleetPlaneAdmissionBearerClass`). Without a credential, every call refuses with that reason and
 * sends nothing.
 *
 * Zero config reads: the boot entry (`devFleetServer.mjs`) resolves the leaves at its use site and
 * injects them. The envelope is {@link createFleetRegistryBridge}'s versioned wire; this module owns the
 * transport and the mapping of its outcomes only.
 */

/**
 * @summary Create the plane fleet client. Construction validates the endpoint and sends nothing.
 * @param {Object}   options
 * @param {String}   options.baseUrl     The plane base; the client addresses `<baseUrl>/fleet`.
 * @param {String}   options.credential  The fleet-surface credential; empty refuses every call unsent.
 * @param {Function} [options.fetchImpl] Injection seam for tests; defaults to the global `fetch`.
 * @returns {{defineAgent: Function}}
 * @throws {TypeError} When `<baseUrl>/fleet` fails the shared secure-endpoint policy.
 */
export function createPlaneFleetClient({baseUrl, credential, fetchImpl = globalThis.fetch}) {
    const endpoint = normalizeSecureMcpEndpoint(`${String(baseUrl ?? '').replace(/\/+$/, '')}/fleet`);

    if (!endpoint) {
        throw new TypeError('createPlaneFleetClient: the plane fleet endpoint must be https, or http on loopback, with no credentials in the URL')
    }

    const bridge = createFleetRegistryBridge(async request => {
        const response = await fetchImpl(endpoint, {
            method : 'POST',
            headers: {Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json'},
            body   : JSON.stringify(request)
        });

        return response.json()
    }, {transportFailureMessage: UNREACHABLE});

    return {
        /**
         * @summary Define a seat on the plane, which records its operator from its own admission.
         * @param {Object} definition The operator's definition, credential included.
         * @returns {Promise<Object>} `{status: 'defined', definition}` carrying the plane's public answer,
         *     `{status: 'rejected', reason}` in the plane's own words (or because it answered no definition),
         *     or `{status: 'unavailable', reason}`.
         */
        async defineAgent(definition) {
            if (!credential) {
                return {status: 'rejected', reason: 'This connection can\'t add agents on the plane: reconnect the plane with your own GitHub or GitLab PAT. (No fleet-surface credential is declared: neither fleet.planeAdmissionBearer nor a forge-PAT fleet.planeBearerClass.)'}
            }

            try {
                const answer = await bridge.defineAgent(definition);

                if (answer?.status === 'rejected') {
                    return answer
                }

                return answer && typeof answer === 'object'
                    ? {status: 'defined', definition: answer}
                    : {status: 'rejected', reason: 'the plane answered without a definition'}
            } catch (error) {
                return error.message === UNREACHABLE
                    ? {status: 'unavailable', reason: `the plane did not answer at ${endpoint}`}
                    : {status: 'rejected', reason: error.message}
            }
        }
    }
}

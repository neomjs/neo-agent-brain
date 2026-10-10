import crypto                      from 'node:crypto';
import {LAUNCH_ADMISSION_OUTCOMES} from '../../../src/fleet/contract/launchAdmission.mjs';

/**
 * @module ai/services/fleet/mcpLaunchAdmission
 * @summary The wire between Fleet's MCP launcher and the issuer it redeems from: native MCP launch
 * admission. A profile row carries a grant `<id>.<secret>`. The secret never crosses the
 * wire. A request proves possession with an HMAC over a fresh nonce, and the issuer signs its answer with
 * the same secret. A process that binds a dead issuer's port can therefore neither learn the grant nor
 * hand the launcher an environment. Pure: only `node:crypto` and the Body-safe vocabulary, so the
 * launcher loads nothing else before its target starts.
 */

/**
 * @summary The row env slot holding the issuer's loopback origin, `http://127.0.0.1:<port>`.
 * @type {String}
 */
export const LAUNCH_ISSUER_ENV_VAR = 'NEO_FLEET_LAUNCH_ISSUER';

/**
 * @summary The row env slot holding one server's grant, `<id>.<secret>`. The launcher removes it from the
 * target's environment.
 * @type {String}
 */
export const LAUNCH_GRANT_ENV_VAR = 'NEO_FLEET_LAUNCH_GRANT';

/**
 * @summary The one path the issuer answers.
 * @type {String}
 */
export const LAUNCH_ADMISSION_PATH = '/fleet/mcp-launch/v1';

/**
 * @summary Upper bound for a request or an answer body, in bytes.
 * @type {Number}
 */
export const LAUNCH_ADMISSION_MAX_BYTES = 64 * 1024;

/**
 * @summary Classify a proof's transport observation before its diagnostic wording is composed.
 * @param {Boolean} ok Whether this response proved the requested fact.
 * @param {Number} [status] Absent when the transport did not answer.
 * @returns {'proved'|'refused'|'unanswered'}
 */
export function httpProofVerdict(ok, status) {
    return ok ? 'proved' : status === undefined || status === 429 || status >= 500 && status <= 599 ? 'unanswered' : 'refused'
}

const
    PROTOCOL       = 'neo-fleet-mcp-launch/v1',
    TOKEN_PATTERN  = /^[A-Za-z0-9_-]{22,128}$/,
    SERVER_PATTERN = /^[a-z][a-z0-9-]{0,63}$/,
    LOGIN_PATTERN  = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/,
    ENV_NAME       = /^[A-Z][A-Z0-9_]*$/,
    // Slots no admitted environment may set: they would change how the target process itself runs.
    PROCESS_CONTROL = new Set(['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'PATH', 'HOME', 'SHELL', 'TMPDIR', LAUNCH_ISSUER_ENV_VAR, LAUNCH_GRANT_ENV_VAR]);

/**
 * @summary Mint one grant: an opaque id and a 256-bit secret, both base64url.
 * @returns {{id: String, secret: String, capability: String}}
 */
export function mintLaunchGrant() {
    const
        id     = crypto.randomBytes(16).toString('base64url'),
        secret = crypto.randomBytes(32).toString('base64url');

    return {id, secret, capability: `${id}.${secret}`}
}

/**
 * @param {*} value A row's grant slot.
 * @returns {{id: String, secret: String}|null} `null` for anything but one well-formed grant.
 */
export function parseLaunchCapability(value) {
    const [id, secret, ...rest] = typeof value === 'string' ? value.split('.') : [];

    return !rest.length && TOKEN_PATTERN.test(id ?? '') && TOKEN_PATTERN.test(secret ?? '') ? {id, secret} : null
}

/**
 * @summary Whether a name may carry an admitted value into the target's environment.
 * @param {String} name
 * @returns {Boolean}
 */
export function isAdmissibleEnvName(name) {
    return ENV_NAME.test(name) && !PROCESS_CONTROL.has(name) && !/^(?:LD|DYLD)_/.test(name)
}

/**
 * @param {*} value
 * @returns {Boolean} Whether a value is a validated forge login, the identity a row and a grant carry.
 */
export function isLaunchIdentity(value) {
    return typeof value === 'string' && LOGIN_PATTERN.test(value)
}

/**
 * @summary The request a launcher sends: the grant id, the server and identity its row names, a fresh
 * nonce, and an HMAC proving it holds the grant's secret.
 * @param {Object} options
 * @param {{id: String, secret: String}} options.grant
 * @param {String} options.server Canonical MCP catalog key.
 * @param {String} options.identity The row's literal forge login.
 * @param {String} [options.nonce] Test seam; a fresh 256-bit nonce by default.
 * @returns {{grant: String, server: String, identity: String, nonce: String, proof: String}}
 */
export function createLaunchRequest({grant, server, identity, nonce = crypto.randomBytes(32).toString('base64url')}) {
    return {grant: grant.id, server, identity, nonce, proof: requestProof(grant.secret, {grant: grant.id, server, identity, nonce})}
}

/**
 * @summary Validate a request's shape. The proof is checked separately, against the grant it names.
 * @param {*} body Parsed JSON.
 * @returns {{grant: String, server: String, identity: String, nonce: String, proof: String}|null}
 */
export function parseLaunchRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

    const {grant, server, identity, nonce, proof, ...rest} = body;

    return !Object.keys(rest).length && TOKEN_PATTERN.test(grant ?? '') && SERVER_PATTERN.test(server ?? '') &&
        isLaunchIdentity(identity) && TOKEN_PATTERN.test(nonce ?? '') && TOKEN_PATTERN.test(proof ?? '')
        ? {grant, server, identity, nonce, proof}
        : null
}

/**
 * @param {String} secret The grant's secret.
 * @param {Object} request A parsed request.
 * @returns {Boolean} Whether the request's proof was made with this secret.
 */
export function verifyLaunchRequest(secret, request) {
    return safeEqual(requestProof(secret, request), request.proof)
}

/**
 * @summary An answer signed with the grant's secret, binding the request's nonce. Only an issuer that holds
 * the grant can produce it.
 * @param {String} secret
 * @param {Object} request The parsed request being answered.
 * @param {Object} payload `{outcome, code?, reason?, env?, args?}`.
 * @returns {Object}
 */
export function signLaunchResponse(secret, request, payload) {
    return {...payload, mac: responseMac(secret, request, payload)}
}

/**
 * @summary Check an answer against the grant and the request it answers.
 * @param {String} secret
 * @param {Object} request The request the launcher sent.
 * @param {*} response Parsed JSON answer.
 * @returns {Object|null} The payload without its MAC, or `null` when the answer is unsigned or forged.
 */
export function verifyLaunchResponse(secret, request, response) {
    if (!response || typeof response !== 'object' || Array.isArray(response) || typeof response.mac !== 'string') return null;

    const {mac, ...payload} = response;

    return safeEqual(responseMac(secret, request, payload), mac) ? payload : null
}

/**
 * @summary An unsigned refusal, for a request whose grant is unknown or unproved: such a caller cannot
 * check a signature, and nothing it could learn needs one.
 * @param {String} code A `LAUNCH_ADMISSION_REFUSALS` value.
 * @returns {{outcome: String, code: String}}
 */
export function launchRefusal(code) {
    return {outcome: LAUNCH_ADMISSION_OUTCOMES.REFUSED, code}
}

/** @private */
function requestProof(secret, {grant, server, identity, nonce}) {
    return hmac(secret, [PROTOCOL, 'request', grant, server, identity, nonce].join('\n'))
}

/** @private */
function responseMac(secret, {grant, nonce}, payload) {
    return hmac(secret, [PROTOCOL, 'response', grant, nonce, canonicalJson(payload)].join('\n'))
}

/** @private */
function hmac(secret, text) {
    return crypto.createHmac('sha256', secret).update(text, 'utf8').digest('base64url')
}

/** @private */
function safeEqual(expected, actual) {
    const a = Buffer.from(String(expected)), b = Buffer.from(String(actual));

    return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * @summary JSON with sorted keys at every level, so both ends sign the same bytes. An `undefined` member is
 * left out, as `JSON.stringify` leaves it out of the body the other end parses.
 * @param {*} value
 * @returns {String}
 * @private
 */
function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
            .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
    }

    return JSON.stringify(value ?? null)
}

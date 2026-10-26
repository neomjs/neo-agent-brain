import {createHash, createPublicKey} from 'node:crypto';
import {stringifyCanonicalJson} from '../../shared/canonicalJson.mjs';
import {isSetupRunId} from '../../fleet/setupRunRecord.mjs';

/**
 * @module ai/services/memory-core/helpers/identityPublicationBoot
 * @summary Compiles resolved MC boot data without admitting a reservation or installing trust.
 *
 * The closed v1 descriptor contains target {planeId, dataRoot}, issuer, reservation
 * {attemptId, kid, originRunId}, and explicit trust: null or [{kid, publicKey}]. Public keys
 * are canonical unpadded base64url SPKI DER. Fingerprints are derived, never caller assertions.
 * The original reservation remains present when trust is supplied; public overlap keys do not
 * acquire generation or recovery authority through this compiler.
 */

/** @summary Creates a value-free diagnostic safe for malformed configuration containing secrets. */
function invalid(reason) {
    const error = new Error(`Identity publication boot: ${reason}`);
    error.code = 'IDENTITY_PUBLICATION_BOOT_INVALID';
    return error;
}

/** @summary Requires an exact object shape after strict JSON detachment. */
function exactKeys(value, keys, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
        throw invalid(`${name} has missing or unsupported fields.`);
    }
}

/** @summary Requires explicit identifiers without normalization or coercion. */
function identifier(value, name) {
    if (typeof value !== 'string' || !value || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw invalid(`${name} must be a nonempty, unpadded string without control characters.`);
    }
}

/**
 * @summary Decodes one public-only canonical Ed25519 SPKI; private-key coercion is forbidden.
 * @param {String} encoded Canonical unpadded base64url DER.
 * @returns {{key: import('node:crypto').KeyObject, fingerprint: String}}
 */
function publicKey(encoded) {
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
        throw invalid('publicKey must be canonical base64url Ed25519 SPKI DER.');
    }

    try {
        const bytes = Buffer.from(encoded, 'base64url');
        if (bytes.toString('base64url') !== encoded) throw new Error();
        const key = createPublicKey({key: bytes, format: 'der', type: 'spki'});

        if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519' ||
            !key.export({format: 'der', type: 'spki'}).equals(bytes)) throw new Error();

        return {key, fingerprint: `sha256:${createHash('sha256').update(bytes).digest('hex')}`};
    } catch {
        throw invalid('publicKey must be canonical base64url Ed25519 SPKI DER.');
    }
}

/**
 * @summary Decodes canonical JSON text without lossy duplicate-key acceptance or value-bearing errors.
 * @param {String} value Atomic resolved configuration text.
 * @returns {*} Parsed JSON data; shape and target checks belong to the compiler.
 */
export function decodeIdentityPublicationBootJson(value) {
    try {
        if (typeof value !== 'string') throw new Error();
        const parsed = JSON.parse(value);
        if (stringifyCanonicalJson(parsed) !== value) throw new Error();
        return parsed;
    } catch {
        throw invalid('expected canonical JSON text.');
    }
}

/**
 * @summary Validates one resolved, target-bound boot descriptor and detaches its public trust.
 *
 * Call after custom configuration loads, with independently resolved served plane/root values.
 * Null alone means unprovisioned; malformed values never fall back. Returned records are frozen;
 * the caller owns the new KeyObject Map and must not expose it as mutable public state.
 * Durable lineage, same-kid byte binding, restore fencing and phase reconciliation are NOT proved
 * here. In particular, reserve-only input cannot clear previously consumed trust or a fence.
 * @param {String|null} value Resolved MC-owned canonical JSON text leaf.
 * @param {Object} target Independently resolved served target.
 * @param {String} target.planeId Served plane identity, not a path-derived key.
 * @param {String} target.dataRoot Served data root, compared exactly as corroborating evidence.
 * @returns {Object|null} {descriptor, publicKeys}, or null when unprovisioned.
 */
export function compileIdentityPublicationBoot(value, {planeId, dataRoot}) {
    if (value === null) return null;
    const descriptor = decodeIdentityPublicationBootJson(value);
    if (descriptor === null) return null;
    identifier(planeId, 'served planeId');
    identifier(dataRoot, 'served dataRoot');

    exactKeys(descriptor, ['version', 'target', 'issuer', 'reservation', 'trust'], 'descriptor');
    if (descriptor.version !== 1) throw invalid('unsupported descriptor version.');
    exactKeys(descriptor.target, ['planeId', 'dataRoot'], 'target');
    identifier(descriptor.target.planeId, 'target planeId');
    identifier(descriptor.target.dataRoot, 'target dataRoot');
    if (descriptor.target.planeId !== planeId || descriptor.target.dataRoot !== dataRoot) {
        throw invalid('target does not match the served plane identity and data root.');
    }
    identifier(descriptor.issuer, 'issuer');
    exactKeys(descriptor.reservation, ['attemptId', 'kid', 'originRunId'], 'reservation');
    for (const name of ['attemptId', 'kid', 'originRunId']) identifier(descriptor.reservation[name], name);
    if (!isSetupRunId(descriptor.reservation.originRunId)) {
        throw invalid('originRunId must identify a supported host setup run.');
    }

    const publicKeys = new Map();
    if (descriptor.trust !== null) {
        if (!Array.isArray(descriptor.trust) || descriptor.trust.length === 0) {
            throw invalid('trust must be null or a nonempty public-key set.');
        }

        descriptor.trust = descriptor.trust.map(entry => {
            exactKeys(entry, ['kid', 'publicKey'], 'trust entry');
            identifier(entry.kid, 'trust kid');
            if (publicKeys.has(entry.kid)) throw invalid('duplicate trust kid.');
            const {key, fingerprint} = publicKey(entry.publicKey);
            publicKeys.set(entry.kid, key);
            return Object.freeze({...entry, fingerprint});
        }).sort((left, right) => left.kid < right.kid ? -1 : left.kid > right.kid ? 1 : 0);

        if (!publicKeys.has(descriptor.reservation.kid)) {
            throw invalid('trust does not contain the reserved kid.');
        }
        Object.freeze(descriptor.trust);
    }

    Object.freeze(descriptor.target);
    Object.freeze(descriptor.reservation);
    return Object.freeze({descriptor: Object.freeze(descriptor), publicKeys});
}

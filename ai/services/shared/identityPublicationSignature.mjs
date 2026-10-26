import crypto                   from 'node:crypto';
import {stringifyCanonicalJson} from './canonicalJson.mjs';
import {IDENTITY_PUBLICATION_LIMITS, IDENTITY_PUBLICATION_MAX_OPERATION_BYTES,
    isIdentityPublicationIdentifier} from './identityPublicationOperation.mjs';

/**
 * @module ai/services/shared/identityPublicationSignature
 * @summary Authenticates the fixed identity-family-publication envelope without granting graph-write authority.
 * Shared by the Fleet/MC protocol; no config, service, secret custody or generic signing API lives here.
 */

/** @type {String} Fixed signed purpose; not caller-selectable. */
export const IDENTITY_PUBLICATION_PURPOSE = 'identity-family-publication';

/** @type {String} Fixed Ed25519 signature domain, followed by one zero byte before the payload. */
export const IDENTITY_PUBLICATION_DOMAIN = 'neo.identity-family-publication.v1';

/** @type {Number} Exactly five minutes on the composition's shared wall clock. */
export const IDENTITY_PUBLICATION_VALIDITY_MS = 300000;

/** @type {String} Compact signed text bypasses the SDK's smaller ordinary JSON parser. */
export const IDENTITY_PUBLICATION_MEDIA_TYPE = 'application/vnd.neo.identity-family-publication';

/** @summary Derives a tenant-independent signed payload bound from fixed v1 grammar caps. */
function maximumPayloadBytes() {
    const id    = 'x'.repeat(IDENTITY_PUBLICATION_LIMITS.identifierBytes - 2);
    const shell = {audience: id, issuer: id, kid: id, version: 1, purpose: IDENTITY_PUBLICATION_PURPOSE,
        issuedAt : Number.MAX_SAFE_INTEGER - IDENTITY_PUBLICATION_VALIDITY_MS,
        expiresAt: Number.MAX_SAFE_INTEGER, operation: null};
    return Buffer.byteLength(stringifyCanonicalJson(shell), 'utf8') - 4 + IDENTITY_PUBLICATION_MAX_OPERATION_BYTES;
}

/** @type {Number} Unpadded base64url payload, one dot and the fixed 64-byte Ed25519 signature. */
export const IDENTITY_PUBLICATION_MAX_COMPACT_BYTES = Math.ceil(maximumPayloadBytes() * 4 / 3) + 1 + 86;

const ENVELOPE_KEYS = Object.freeze(['audience', 'expiresAt', 'issuedAt', 'issuer', 'kid', 'operation', 'purpose', 'version']);

/**
 * @summary Decodes one unpadded base64url segment only when its spelling is canonical.
 * @param {String} segment Encoded bytes.
 * @returns {Buffer|null} Decoded bytes or null.
 */
function decodeSegment(segment) {
    if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;

    const bytes = Buffer.from(segment, 'base64url');

    return bytes.length && bytes.toString('base64url') === segment ? bytes : null;
}

/**
 * @summary Freezes parsed JSON so authenticated fields cannot be changed between validation and admission.
 * @param {*} value Parsed plain JSON.
 * @returns {*} The same recursively frozen value.
 */
function freezeJson(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freezeJson);
        Object.freeze(value);
    }

    return value;
}

/**
 * @summary Verifies bytes, fixed envelope claims, current trust and the exact delivery window.
 *
 * An authenticated result is NOT an admitted operation. The MC-owned caller must validate its closed
 * operation variant, check durable issuer/fence state and perform receipt lookup/CAS in its physical
 * admission transaction. This helper deliberately does not interpret a baseline or correction.
 * Public keys and expected target/issuer come from the verifier's consumed trust generation, never
 * from request content. The caller supplies its current shared-clock reading for every delivery,
 * including retries; there is no expired-token or previous-trust bypass.
 *
 * @param {String} token Two unpadded base64url segments, payload.signature.
 * @param {Object} options Verifier-owned inputs.
 * @param {String} options.audience Expected plane audience.
 * @param {String} options.issuer Expected stable Fleet issuer.
 * @param {Map<String, import('node:crypto').KeyObject>} options.publicKeys That issuer's trusted public keys by kid.
 * @param {Number} options.now Current Unix wall-clock milliseconds.
 * @returns {Object} authenticated false with a code, or authenticated true with immutable envelope and canonicalPayload.
 */
export function verifyIdentityPublicationSignature(token, {audience, issuer, publicKeys, now} = {}) {
    const refuse = code => ({authenticated: false, code});

    if (!isIdentityPublicationIdentifier(audience) || !isIdentityPublicationIdentifier(issuer) ||
        !(publicKeys instanceof Map) || !Number.isSafeInteger(now) || now < 0) {
        return refuse('verifier-unavailable');
    }

    if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > IDENTITY_PUBLICATION_MAX_COMPACT_BYTES) {
        return refuse('malformed-envelope');
    }

    const parts = token.split('.');
    if (parts.length !== 2) return refuse('malformed-envelope');

    const payload   = decodeSegment(parts[0]);
    const signature = decodeSegment(parts[1]);
    if (!payload || !signature || signature.length !== 64) return refuse('malformed-envelope');

    let canonicalPayload, envelope;

    try {
        const text = new TextDecoder('utf-8', {fatal: true}).decode(payload);
        envelope = JSON.parse(text);
        canonicalPayload = stringifyCanonicalJson(envelope);

        if (!payload.equals(Buffer.from(canonicalPayload, 'utf8'))) return refuse('noncanonical-envelope');
    } catch {
        return refuse('malformed-envelope');
    }

    if (!envelope || Array.isArray(envelope) || typeof envelope !== 'object' ||
        Object.keys(envelope).sort().join(',') !== ENVELOPE_KEYS.join(',') ||
        envelope.version !== 1 || envelope.purpose !== IDENTITY_PUBLICATION_PURPOSE ||
        !['audience', 'issuer', 'kid'].every(key => isIdentityPublicationIdentifier(envelope[key])) ||
        !envelope.operation || Array.isArray(envelope.operation) || typeof envelope.operation !== 'object' ||
        !Number.isSafeInteger(envelope.issuedAt) || envelope.issuedAt < 0 ||
        !Number.isSafeInteger(envelope.expiresAt) ||
        envelope.expiresAt - envelope.issuedAt !== IDENTITY_PUBLICATION_VALIDITY_MS) {
        return refuse('malformed-envelope');
    }

    if (envelope.audience !== audience || envelope.issuer !== issuer) return refuse('untrusted-envelope');

    const publicKey = publicKeys.get(envelope.kid);
    if (!(publicKey instanceof crypto.KeyObject) || publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
        return refuse('untrusted-envelope');
    }

    try {
        const signedBytes = Buffer.concat([Buffer.from(IDENTITY_PUBLICATION_DOMAIN + '\0', 'utf8'), payload]);

        if (!crypto.verify(null, signedBytes, publicKey, signature)) return refuse('invalid-signature');
    } catch {
        return refuse('invalid-signature');
    }

    if (envelope.issuedAt > now || now >= envelope.expiresAt) return refuse('outside-validity');

    return {authenticated: true, envelope: freezeJson(envelope), canonicalPayload};
}

import crypto                   from 'node:crypto';
import {stringifyCanonicalJson} from './canonicalJson.mjs';

/**
 * @module ai/services/shared/identityPublicationKeys
 * @summary Domain-separated record keys for admitted family history and Fleet dispatch custody.
 * These functions encode already-admitted identity/provenance; knowing a key grants no authority.
 * Provider/API-base normalization belongs to authentication, not to a later key lookup.
 */

/** @type {String} Reserved family record-id namespace, including lineage and receipts. */
export const FAMILY_RECORD_PREFIX = 'identity-family-';
/** @type {String} Reserved graph label/relation namespace owned by typed family admission. */
export const FAMILY_GRAPH_TYPE_PREFIX = 'IDENTITY_FAMILY_';

/**
 * @summary Requires an explicit non-empty identity component without coercion or normalization.
 * @param {*} value Identity component.
 * @param {String} name Field name for the refusal.
 * @returns {String} Unchanged component.
 */
function identityPart(value, name) {
    if (typeof value !== 'string' || !value || value.trim() !== value) {
        throw new TypeError(name + ' must be an explicit non-empty identity string.');
    }

    return value;
}

/**
 * @summary Selects the stable provider namespace and subject; mutable usernames are never a fallback.
 * @param {Object} subject AuthService-stamped provider facts.
 * @returns {String[]} Provider, API base and stable user ID.
 */
function subjectTuple(subject) {
    return ['authProvider', 'providerBaseUrl', 'providerUserId'].map(field => {
        if (!subject || !Object.hasOwn(subject, field)) {
            throw new TypeError('A publication subject requires its own ' + field + '.');
        }

        return identityPart(subject[field], field);
    });
}

/**
 * @summary Hashes one canonical tuple under a fixed record-kind domain, yielding a path-safe key.
 * @param {String} kind Internal record-kind selector, never supplied by a request.
 * @param {Array} tuple Validated identity components.
 * @returns {String} A fixed prefix and lowercase SHA-256 digest; raw principals never enter paths.
 */
function recordKey(kind, tuple) {
    const digest = crypto.createHash('sha256')
        .update('neo.identity-family.' + kind + '.v1\0', 'utf8')
        .update(stringifyCanonicalJson(tuple), 'utf8')
        .digest('hex');

    return FAMILY_RECORD_PREFIX + kind + '-' + digest;
}

/**
 * @summary Names one immutable admitted binding incarnation, independent of seat-key or login renames.
 * @param {Object} options
 * @param {String} options.planeId Admitted plane identity.
 * @param {Object} options.subject Stable provider/base/user-id facts.
 * @param {String} options.incarnation Opaque binding incarnation; remove/recreate must mint another.
 * @returns {String} Membership record key.
 */
export function familyMembershipKey({planeId, subject, incarnation} = {}) {
    return recordKey('membership', [
        identityPart(planeId, 'planeId'), subjectTuple(subject), identityPart(incarnation, 'incarnation')
    ]);
}

/**
 * @summary Selects the per-identity serialized queue without tying it to one binding or mutable login.
 * @param {Object} options
 * @param {String} options.planeId Admitted plane identity.
 * @param {Object} options.subject Stable provider/base/user-id facts.
 * @returns {String} Queue key in a domain separate from membership records.
 */
export function familyQueueKey({planeId, subject} = {}) {
    return recordKey('queue', [identityPart(planeId, 'planeId'), subjectTuple(subject)]);
}

/**
 * @summary Names an operation receipt across re-signing and key rotation under the stable issuer.
 * @param {Object} options
 * @param {String} options.planeId Admitted plane identity.
 * @param {String} options.issuer Stable Fleet issuer, not a signing kid.
 * @param {String} options.operationId Durable logical operation identity.
 * @returns {String} Receipt record key; logical digest conflicts are checked by its owner.
 */
export function familyReceiptKey({planeId, issuer, operationId} = {}) {
    return recordKey('receipt', [
        identityPart(planeId, 'planeId'), identityPart(issuer, 'issuer'), identityPart(operationId, 'operationId')
    ]);
}

/**
 * @summary Names one explicit operator act's retained retry custody, never its canonical family fact.
 * The target incarnation and logical contents live in this record; changing them must conflict,
 * not select a fresh key. Losing a client token creates another act and cannot imply a retry.
 * @param {Object} options
 * @param {String} options.planeId Admitted plane identity.
 * @param {String} options.principal Server-stamped operator principal.
 * @param {String} options.seatId The act's original seat key.
 * @param {String} options.retryToken The client's retained opaque token for this explicit act.
 * @returns {String} Fleet intent key.
 */
export function familyIntentKey({planeId, principal, seatId, retryToken} = {}) {
    return recordKey('intent', [
        identityPart(planeId, 'planeId'), identityPart(principal, 'principal'),
        identityPart(seatId, 'seatId'), identityPart(retryToken, 'retryToken')
    ]);
}

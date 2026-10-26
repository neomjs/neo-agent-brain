import {createHash}             from 'node:crypto';
import {stringifyCanonicalJson} from './canonicalJson.mjs';

/**
 * @module ai/services/shared/identityPublicationOperation
 * @summary Closed logical operations shared by Fleet issuance and MC admission.
 * Validation supplies no authorization, membership, revision, family or removal truth.
 * Those state-dependent checks remain with their service owners and physical transaction.
 */

/** @type {Object} Fixed v1 encoded-field bounds and supported complete-plane binding count. */
export const IDENTITY_PUBLICATION_LIMITS = Object.freeze({
    identifierBytes: 256, providerBaseBytes: 2048, familyBytes: 256,
    modelBytes     : 512, reasonBytes: 2048, baselineBindings: 128
});

const COMMON      = ['kind', 'operationId', 'effectiveAt'];
const TARGET      = ['binding', 'expectedMembershipRevision', 'expectedAdmissionRevision'];
const DECLARATION = ['family', 'model', 'newFamily', 'operatorPrincipal', 'unattestedReason'];
const LIMIT       = IDENTITY_PUBLICATION_LIMITS;

/** @summary Carries one field-addressed refusal without coercing input or echoing provenance. */
function invalid(field, reason) {
    throw Object.assign(new TypeError(reason), {field});
}

/** @summary Requires exactly the named own enumerable data fields on a plain record. */
function record(value, keys, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        invalid(field, 'Expected a plain record.');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== keys.length ||
        Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key))) {
        invalid(field, 'Unexpected or missing field.');
    }
    for (const key of keys) {
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
            invalid(field + '.' + key, 'Expected an own enumerable data field.');
        }
    }
}

/** @summary Caps the encoded JSON string itself, including escaping, without normalizing its value. */
function text(value, field, bytes = LIMIT.identifierBytes, trimmed = true) {
    if (typeof value !== 'string' || !value.trim() || !value.isWellFormed() ||
        (trimmed && value.trim() !== value) ||
        /[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(JSON.stringify(value), 'utf8') > bytes) {
        invalid(field, 'Expected a nonempty, well-formed string within its encoded-byte limit.');
    }
}

/** @summary Checks a fixed-profile identifier; it never normalizes a value or reads configuration. */
export function isIdentityPublicationIdentifier(value) {
    try {
        text(value, 'identifier');
        return true;
    } catch {
        return false;
    }
}

/** @summary Derives the largest logical JSON shape from the same encoded caps as validation. */
function maximumOperationBytes() {
    const id      = 'x'.repeat(LIMIT.identifierBytes - 2), reason = 'x'.repeat(LIMIT.reasonBytes - 2);
    const binding = {subject: {authProvider: id, providerBaseUrl: 'x'.repeat(LIMIT.providerBaseBytes - 2),
        providerUserId: id, providerUsername: id}, seatId: id, incarnation: id};
    const common = {operationId: id, effectiveAt: Number.MAX_SAFE_INTEGER};
    const target = {...common, binding, expectedMembershipRevision: Number.MAX_SAFE_INTEGER,
        expectedAdmissionRevision: Number.MAX_SAFE_INTEGER};
    const declaration = {...target, family: 'x'.repeat(LIMIT.familyBytes - 2), model: null,
        newFamily: false, operatorPrincipal: id, unattestedReason: reason};
    const size     = value => Buffer.byteLength(stringifyCanonicalJson(value), 'utf8');
    const baseline = size({...common, kind: 'baseline', expectedPlaneRevision: 0, bindings: []}) +
        LIMIT.baselineBindings * size(binding) + Math.max(0, LIMIT.baselineBindings - 1);
    const attested = {...declaration, model: 'x'.repeat(LIMIT.modelBytes - 2), unattestedReason: null};
    return Math.max(baseline, size({...target, kind: 'bind'}), size({...target, kind: 'rekey', newSeatId: id}),
        size({...target, kind: 'retire', removal: {operationId: id, completedAt: Number.MAX_SAFE_INTEGER, outcome: 'removed'}}),
        ...[declaration, attested].flatMap(value => [size({...value, kind: 'confirm'}),
            size({...value, kind: 'correct', targetAdmissionId: id, reason})]));
}

/** @type {Number} Maximum canonical operation bytes across all six fixed-profile variants. */
export const IDENTITY_PUBLICATION_MAX_OPERATION_BYTES = maximumOperationBytes();


/** @summary Requires an explicit nonnegative safe integer for revision and shared-clock values. */
function integer(value, field) {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
        invalid(field, 'Expected a nonnegative safe integer.');
    }
}

/** @summary Validates stable provider facts separately from the mutable display/alias username. */
function binding(value, field) {
    record(value, ['subject', 'seatId', 'incarnation'], field);
    record(value.subject, ['authProvider', 'providerBaseUrl', 'providerUserId', 'providerUsername'], field + '.subject');
    for (const key of ['authProvider', 'providerUserId', 'providerUsername']) {
        text(value.subject[key], field + '.subject.' + key);
    }
    text(value.subject.providerBaseUrl, field + '.subject.providerBaseUrl', LIMIT.providerBaseBytes);
    text(value.seatId, field + '.seatId');
    text(value.incarnation, field + '.incarnation');
}

/** @summary Refuses sparse, accessor-bearing or decorated arrays before inspecting bounded entries. */
function baseline(values) {
    if (!Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype) {
        invalid('bindings', 'Expected a complete dense binding array.');
    }
    if (values.length > LIMIT.baselineBindings) {
        const entry  = Object.getOwnPropertyDescriptor(values, LIMIT.baselineBindings);
        const value  = entry && Object.hasOwn(entry, 'value') ? entry.value : null;
        const seat   = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'seatId') : null;
        const seatId = seat && Object.hasOwn(seat, 'value') && isIdentityPublicationIdentifier(seat.value) ? seat.value : null;
        throw Object.assign(new TypeError('Complete baseline exceeds the supported plane size; correct or retire the excess binding and recapture.'), {
            code   : 'baseline-capacity-exceeded', field: 'bindings[' + LIMIT.baselineBindings + ']',
            details: Object.freeze({seatCount: values.length, limit: LIMIT.baselineBindings,
                entryIndex: LIMIT.baselineBindings, seatId, remedy: 'correct-or-retire'})
        });
    }
    const descriptors = Object.getOwnPropertyDescriptors(values);
    if (Reflect.ownKeys(descriptors).length !== values.length + 1) {
        invalid('bindings', 'Expected a dense undecorated array.');
    }
    const seats = new Set(), incarnations = new Set();
    for (let index = 0; index < values.length; index++) {
        const descriptor = descriptors[index], field = 'bindings[' + index + ']';
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
            invalid(field, 'Expected an own enumerable entry.');
        }
        const value = descriptor.value;
        binding(value, field);
        const {authProvider, providerBaseUrl, providerUserId} = value.subject;
        const identity                                        = stringifyCanonicalJson([authProvider, providerBaseUrl, providerUserId, value.incarnation]);
        if (seats.has(value.seatId) || incarnations.has(identity)) {
            invalid(field, 'Duplicate seat or stable-subject incarnation in the complete baseline.');
        }
        seats.add(value.seatId);
        incarnations.add(identity);
    }
}

/** @summary Requires explicit model evidence or an admission-level reason for literal null. */
function declaration(value) {
    text(value.family, 'family', LIMIT.familyBytes, false);
    if (typeof value.newFamily !== 'boolean') invalid('newFamily', 'Expected explicit introduction intent.');
    text(value.operatorPrincipal, 'operatorPrincipal');
    if (value.model === null) {
        text(value.unattestedReason, 'unattestedReason', LIMIT.reasonBytes);
    } else {
        text(value.model, 'model', LIMIT.modelBytes);
        if (value.unattestedReason !== null) {
            invalid('unattestedReason', 'An attested model requires an explicit null unattested reason.');
        }
    }
}

/** @summary Freezes the detached admitted shape, never the caller's objects. */
function freeze(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

/**
 * @summary Validates all six closed logical variants and derives their delivery-independent digest.
 * Baseline's expectedPlaneRevision is zero; other revisions are scoped to the bound stable subject.
 * The caller must separately verify signature/current trust/expiry, then consult the receipt before
 * state-dependent checks. A valid result neither permits a write nor claims a complete live census.
 * @param {*} value Candidate logical operation, never a signed envelope.
 * @returns {Object} A detached frozen operation and digest, or a field-addressed validation refusal.
 */
export function validateIdentityPublicationOperation(value) {
    try {
        const kindDescriptor = value && typeof value === 'object' ?
            Object.getOwnPropertyDescriptor(value, 'kind') : null;
        const kind = kindDescriptor && Object.hasOwn(kindDescriptor, 'value') ? kindDescriptor.value : null;
        let keys;
        switch (kind) {
            case 'baseline': keys = [...COMMON, 'expectedPlaneRevision', 'bindings']; break;
            case 'bind': keys = [...COMMON, ...TARGET]; break;
            case 'retire': keys = [...COMMON, ...TARGET, 'removal']; break;
            case 'rekey': keys = [...COMMON, ...TARGET, 'newSeatId']; break;
            case 'confirm': keys = [...COMMON, ...TARGET, ...DECLARATION]; break;
            case 'correct': keys = [...COMMON, ...TARGET, ...DECLARATION, 'targetAdmissionId', 'reason']; break;
            default: invalid('kind', 'Expected baseline, bind, retire, rekey, confirm or correct.');
        }
        record(value, keys, 'operation');
        text(value.operationId, 'operationId');
        integer(value.effectiveAt, 'effectiveAt');
        if (kind === 'baseline') {
            integer(value.expectedPlaneRevision, 'expectedPlaneRevision');
            if (value.expectedPlaneRevision !== 0) invalid('expectedPlaneRevision', 'Baseline requires the initial plane revision.');
            baseline(value.bindings);
        } else {
            binding(value.binding, 'binding');
            integer(value.expectedMembershipRevision, 'expectedMembershipRevision');
            integer(value.expectedAdmissionRevision, 'expectedAdmissionRevision');
        }
        if (kind === 'retire') {
            record(value.removal, ['operationId', 'completedAt', 'outcome'], 'removal');
            text(value.removal.operationId, 'removal.operationId');
            integer(value.removal.completedAt, 'removal.completedAt');
            if (value.removal.outcome !== 'removed' || value.removal.completedAt > value.effectiveAt) {
                invalid('removal', 'Retirement requires a completed removal no later than its effective time.');
            }
        }
        if (kind === 'rekey') {
            text(value.newSeatId, 'newSeatId');
            if (value.newSeatId === value.binding.seatId) invalid('newSeatId', 'Re-key requires a different seat key.');
        }
        if (kind === 'confirm' || kind === 'correct') declaration(value);
        if (kind === 'correct') {
            text(value.targetAdmissionId, 'targetAdmissionId');
            text(value.reason, 'reason', LIMIT.reasonBytes);
        }
        const canonicalOperation = stringifyCanonicalJson(value);
        const digest             = createHash('sha256').update('neo.identity-family.logical-operation.v1\0', 'utf8')
            .update(canonicalOperation, 'utf8').digest('hex');
        return Object.freeze({valid: true, operation: freeze(JSON.parse(canonicalOperation)), canonicalOperation, digest});
    } catch (error) {
        return Object.freeze({valid: false, code: error.code ?? 'invalid-operation', field: error.field ?? 'operation',
            reason: error.message, ...(error.details ? {details: error.details} : {})});
    }
}

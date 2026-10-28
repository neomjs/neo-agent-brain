import {test, expect}                                                      from '@playwright/test';
import {createHash}                                                        from 'node:crypto';
import {IDENTITY_PUBLICATION_LIMITS, validateIdentityPublicationOperation} from '../../../../../../ai/services/shared/identityPublicationOperation.mjs';

const subject = {authProvider: 'github', providerBaseUrl: 'https://api.github.com',
    providerUserId: 'stable-42', providerUsername: 'outside-seat'};
const target = {subject, seatId: 'seat-a', incarnation: 'incarnation-a'};

/** @summary Builds protocol fixtures without a live service, credential, graph or filesystem. */
function operation(kind = 'confirm') {
    const common = {kind, operationId: 'logical-act-a', effectiveAt: 1700000000000};
    if (kind === 'baseline') return {...common, expectedPlaneRevision: 0, bindings: [structuredClone(target)]};
    const bound = {...common, binding: structuredClone(target), expectedMembershipRevision: 3, expectedAdmissionRevision: 7};
    if (kind === 'bind') return bound;
    if (kind === 'retire') return {...bound, removal: {operationId: 'removal-a', completedAt: common.effectiveAt, outcome: 'removed'}};
    if (kind === 'rekey') return {...bound, newSeatId: 'renamed-seat'};
    const declaration = {...bound, family: 'new family', model: null, newFamily: true,
        operatorPrincipal: 'owner:connection:stable-person', unattestedReason: 'No bound model proposal.'};
    return kind === 'correct' ? {...declaration, targetAdmissionId: 'earlier-declaration', reason: 'Original act misstated the family.'} : declaration;
}

/** @summary Asserts a refusal names its field and never returns an admission or partial operation. */
function refused(input, field) {
    const result = validateIdentityPublicationOperation(input);
    expect(result.valid).toBe(false);
    expect(result.field).toBe(field);
    expect(result).not.toHaveProperty('operation');
    expect(result).not.toHaveProperty('accepted');
    expect(result).not.toHaveProperty('digest');
}

for (const kind of ['baseline', 'bind', 'retire', 'rekey', 'confirm', 'correct']) {
    test(kind + ' validates a detached immutable logical operation without granting authority', () => {
        const input = operation(kind), answer = validateIdentityPublicationOperation(input);
        expect(answer.valid).toBe(true);
        expect(answer.operation).toEqual(input);
        expect(answer.operation).not.toBe(input);
        expect(Object.isFrozen(answer.operation)).toBe(true);
        const nested = kind === 'baseline' ? answer.operation.bindings[0] : answer.operation.binding;
        expect(Object.isFrozen(nested.subject)).toBe(true);
        expect(answer).not.toHaveProperty('accepted');
        expect(answer).not.toHaveProperty('receipt');
        expect(Object.isFrozen(input)).toBe(false);
        expect(answer.digest).toBe(createHash('sha256').update('neo.identity-family.logical-operation.v1\0')
            .update(answer.canonicalOperation).digest('hex'));
    });
}

test('variant smuggling, graph permission flags and envelope claims are not logical fields', () => {
    for (const [kind, patch] of [
        ['bind', {family: 'gpt'}], ['baseline', {operatorPrincipal: 'forged'}],
        ['confirm', {targetAdmissionId: 'arbitrary'}], ['retire', {newSeatId: 'other'}],
        ['correct', {admitted: true}], ['rekey', {issuer: 'fleet', issuedAt: 1}]
    ]) refused({...operation(kind), ...patch}, 'operation');
});

test('missing required null, intent and revision fields are not defaulted', () => {
    for (const field of ['model', 'unattestedReason', 'newFamily', 'expectedMembershipRevision', 'expectedAdmissionRevision']) {
        const value = operation(); delete value[field]; refused(value, 'operation');
    }
});

test('null model remains literal and needs an admission-level reason', () => {
    const value = operation();
    expect(validateIdentityPublicationOperation(value).operation.model).toBeNull();
    refused({...value, unattestedReason: null}, 'unattestedReason');
    refused({...value, model: undefined}, 'model');
    refused({...value, model: 'observed-model'}, 'unattestedReason');
    expect(validateIdentityPublicationOperation({...value, model: 'observed-model', unattestedReason: null}).valid).toBe(true);
});

test('exact family vocabulary includes prototype names and the literal unknown family', () => {
    for (const family of ['unknown', '__proto__', 'constructor', 'toString', 'A New Family', '  literal family  ']) {
        const answer = validateIdentityPublicationOperation({...operation(), family});
        expect(answer.valid).toBe(true);
        expect(answer.operation.family).toBe(family);
    }
    refused({...operation(), newFamily: 'true'}, 'newFamily');
});

test('username is display data and cannot substitute for the stable provider subject', () => {
    for (const key of ['authProvider', 'providerBaseUrl', 'providerUserId']) {
        const value = operation(); delete value.binding.subject[key];
        refused(value, 'binding.subject');
    }
    const value = operation(); value.binding.subject.providerUserId = '';
    refused(value, 'binding.subject.providerUserId');
    value.binding.subject.providerUserId = ' stable-42 ';
    refused(value, 'binding.subject.providerUserId');
    const renamed = operation(); renamed.binding.subject.providerUsername = 'renamed-login';
    expect(validateIdentityPublicationOperation(renamed).operation.binding.subject.providerUserId).toBe('stable-42');
});

test('retirement requires the completed removal outcome, never grant revocation or a future cleanup', () => {
    for (const outcome of ['revoked', 'pending', 'unknown', null]) {
        const value = operation('retire'); value.removal.outcome = outcome; refused(value, 'removal');
    }
    const value = operation('retire'); value.removal.completedAt = value.effectiveAt + 1;
    refused(value, 'removal');
});

test('re-key is one exact binding plus a distinct key, not a changed subject or fresh incarnation', () => {
    const value = operation('rekey');
    refused({...value, newSeatId: value.binding.seatId}, 'newSeatId');
    refused({...value, newIncarnation: 'replacement'}, 'operation');
    refused({...value, newSubject: {...subject, providerUserId: 'another'}}, 'operation');
});

test('correction names its immutable target and reason; current-state shorthand refuses', () => {
    const value = operation('correct');
    refused({...value, targetAdmissionId: null}, 'targetAdmissionId');
    refused({...value, reason: ''}, 'reason');
    const missing = {...value}; delete missing.targetAdmissionId; refused(missing, 'operation');
});

test('baseline is complete-or-refused, preserves an explicit empty set and rejects duplicate bindings', () => {
    expect(validateIdentityPublicationOperation({...operation('baseline'), bindings: []}).valid).toBe(true);
    const value = operation('baseline');
    value.bindings.push(structuredClone(value.bindings[0]));
    refused(value, 'bindings[1]');
    value.bindings[1].seatId = 'another-key';
    value.bindings[1].subject.providerUsername = 'renamed-login';
    refused(value, 'bindings[1]');
    value.bindings[1].incarnation = 'fresh-incarnation';
    expect(validateIdentityPublicationOperation(value).valid).toBe(true);
    value.bindings[1].subject.providerUserId = 'different-subject';
    value.bindings[1].seatId = value.bindings[0].seatId;
    refused(value, 'bindings[1]');
});

test('baseline cardinality refusal never returns a truncated prefix', () => {
    const make  = count => Array.from({length: count}, (_, i) => ({...structuredClone(target), seatId: 'seat-' + i, incarnation: 'inc-' + i}));
    const value = operation('baseline');
    value.bindings = make(IDENTITY_PUBLICATION_LIMITS.baselineBindings);
    expect(validateIdentityPublicationOperation(value).operation.bindings).toHaveLength(value.bindings.length);
    value.bindings.push({...structuredClone(target), seatId: 'overflow', incarnation: 'overflow'});
    refused(value, 'bindings[' + IDENTITY_PUBLICATION_LIMITS.baselineBindings + ']');
    expect(validateIdentityPublicationOperation(value)).toMatchObject({code: 'baseline-capacity-exceeded',
        details: {seatCount: 129, limit: 128, entryIndex: 128, seatId: 'overflow', remedy: 'correct-or-retire'}});
});

test('all revisions and clocks reject coercion, fractional, unsafe and negative numbers', () => {
    for (const field of ['effectiveAt', 'expectedMembershipRevision', 'expectedAdmissionRevision']) {
        for (const bad of [-1, -0, .5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1']) {
            refused({...operation(), [field]: bad}, field);
        }
    }
    refused({...operation('baseline'), expectedPlaneRevision: 1}, 'expectedPlaneRevision');
    refused({...operation('baseline'), expectedPlaneRevision: -0}, 'expectedPlaneRevision');
});

test('encoded-byte limits account for escaping and Unicode without truncation or normalization', () => {
    const cap = IDENTITY_PUBLICATION_LIMITS.familyBytes;
    expect(validateIdentityPublicationOperation({...operation(), family: 'x'.repeat(cap - 2)}).valid).toBe(true);
    refused({...operation(), family: 'x'.repeat(cap - 1)}, 'family');
    const quoted = '"'.repeat((cap - 2) / 2);
    expect(Buffer.byteLength(JSON.stringify(quoted))).toBe(cap);
    expect(validateIdentityPublicationOperation({...operation(), family: quoted}).valid).toBe(true);
    refused({...operation(), family: quoted + '"'}, 'family');
    for (const bad of ['\ud800', '\udfff', 'line\nfeed', 'nul\0byte', '\t']) {
        refused({...operation(), family: bad}, 'family');
    }
    const family = '🙂'.repeat(Math.floor((cap - 2) / 4));
    expect(validateIdentityPublicationOperation({...operation(), family}).operation.family).toBe(family);
});

test('getters, inherited fields, symbols and sparse/decorated arrays cannot execute or disappear', () => {
    let   calls = 0;
    const value = operation();
    Object.defineProperty(value, 'kind', {get() { calls++; return 'confirm'; }, enumerable: true});
    refused(value, 'kind'); expect(calls).toBe(0);
    const nested = operation();
    Object.defineProperty(nested.binding.subject, 'providerUserId', {get() { calls++; return 'stable-42'; }, enumerable: true});
    refused(nested, 'binding.subject.providerUserId'); expect(calls).toBe(0);
    refused(Object.assign(Object.create({accepted: true}), operation()), 'operation');
    const symbol    = operation(); symbol[Symbol('authority')] = true; refused(symbol, 'operation');
    const sparse    = operation('baseline'); sparse.bindings = new Array(1); refused(sparse, 'bindings');
    const decorated = operation('baseline'); decorated.bindings.authority = true; refused(decorated, 'bindings');
    const accessor  = operation('baseline');
    Object.defineProperty(accessor.bindings, 0, {get() {calls++; return target;}, enumerable: true});
    refused(accessor, 'bindings[0]'); expect(calls).toBe(0);
});

test('logical digest is stable across object key order and changes with intent, not delivery fields', () => {
    const value     = operation('correct'), first = validateIdentityPublicationOperation(value);
    const reordered = Object.fromEntries(Object.entries(value).reverse());
    expect(validateIdentityPublicationOperation(reordered).digest).toBe(first.digest);
    for (const patch of [{family: 'other'}, {model: 'model', unattestedReason: null},
        {targetAdmissionId: 'another'}, {operatorPrincipal: 'owner:other:person'},
        {expectedMembershipRevision: 4}, {effectiveAt: value.effectiveAt + 1}]) {
        expect(validateIdentityPublicationOperation({...value, ...patch}).digest).not.toBe(first.digest);
    }
    refused({...value, signature: 'delivery-signature'}, 'operation');
});

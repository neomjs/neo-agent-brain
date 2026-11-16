import {test, expect} from '@playwright/test';
import crypto         from 'node:crypto';
import {
    FAMILY_GRAPH_TYPE_PREFIX,
    FAMILY_RECORD_PREFIX,
    familyAdmissionKey,
    familyIntentKey,
    familyLineageHead,
    familyLineageKey,
    familyMembershipKey,
    familyPlaneStateKey,
    familyQueueKey,
    familyReceiptKey,
    familySubjectStateKey
} from '../../../../../../ai/services/shared/identityPublicationKeys.mjs';

const subject = Object.freeze({authProvider: 'github', providerBaseUrl: 'https://api.github.com', providerUserId: '42'});
const binding = Object.freeze({planeId: 'plane-a', subject, incarnation: 'binding-a'});

test.describe('identity publication deterministic record keys', () => {
    test('reserved record and graph namespaces retain their distinct protocol spellings', () => {
        expect(FAMILY_RECORD_PREFIX).toBe('identity-family-');
        expect(FAMILY_GRAPH_TYPE_PREFIX).toBe('IDENTITY_FAMILY_');
        expect(familyMembershipKey(binding)).toMatch(/^identity-family-membership-[a-f0-9]{64}$/);
    });

    test('plane and subject state keys bind their declared namespaces', () => {
        const plane = familyPlaneStateKey({planeId: 'plane-a', issuer: 'first'});
        expect(familyPlaneStateKey({planeId: 'plane-a', issuer: 'second'})).toBe(plane);
        expect(familyPlaneStateKey({planeId: 'plane-b'})).not.toBe(plane);
        const scoped = familySubjectStateKey(binding);
        expect(familySubjectStateKey({...binding, subject: {...subject, providerUsername: 'renamed'}})).toBe(scoped);
        expect(familySubjectStateKey({...binding, subject: {...subject, providerUserId: '43'}})).not.toBe(scoped);
        expect(familySubjectStateKey({...binding, planeId: 'plane-b'})).not.toBe(scoped);
        expect(new Set([plane, scoped, familyQueueKey(binding), familyMembershipKey(binding)]).size).toBe(4);
        expect(() => familySubjectStateKey({...binding, subject: Object.create(subject)})).toThrow(TypeError);
    });

    test('admission keys separate confirmations, corrections and delivery receipts', () => {
        const act          = {planeId: 'plane-a', issuer: 'fleet-a', operationId: 'act-a'};
        const confirmation = familyAdmissionKey({...act, kind: 'confirm'});
        const correction   = familyAdmissionKey({...act, kind: 'correct'});
        expect(new Set([confirmation, correction, familyReceiptKey(act)]).size).toBe(3);
        expect(familyAdmissionKey({...act, kind: 'confirm', operationId: 'act-b'})).not.toBe(confirmation);
        expect(familyAdmissionKey({...act, kind: 'confirm', issuer: 'fleet-b'})).not.toBe(confirmation);
        for (const kind of ['baseline', 'bind', 'retire', 'rekey', null, undefined]) {
            expect(() => familyAdmissionKey({...act, kind})).toThrow(TypeError);
        }
    });

    test('lineage identity stays plane-scoped across issuer generations', () => {
        const lineage = familyLineageKey({planeId: 'plane-a', issuer: 'first'});
        expect(familyLineageKey({planeId: 'plane-a', issuer: 'second'})).toBe(lineage);
        expect(familyLineageKey({planeId: 'plane-b'})).not.toBe(lineage);
        expect(familyPlaneStateKey({planeId: 'plane-a'})).not.toBe(lineage);
        expect(() => familyLineageKey({})).toThrow(TypeError);
    });

    test('lineage heads bind the exact reservation and explicit fingerprint', () => {
        const reservation = {attemptId: 'attempt-a', kid: 'key-a', originRunId: 'run-a'};
        const input       = {planeId: 'plane-a', issuer: 'fleet-a', reservation, fingerprint: null};
        const head        = familyLineageHead(input);
        for (const key of ['attemptId', 'kid', 'originRunId']) {
            expect(familyLineageHead({...input, reservation: {...reservation, [key]: 'other'}})).not.toBe(head);
        }
        expect(familyLineageHead({...input, planeId: 'plane-b'})).not.toBe(head);
        expect(familyLineageHead({...input, issuer: 'fleet-b'})).not.toBe(head);
        expect(familyLineageHead({...input, fingerprint: 'sha256:' + 'a'.repeat(64)})).not.toBe(head);
        expect(familyLineageHead({...input, reservation: Object.assign(Object.create(null), reservation)})).toBe(head);
        for (const fingerprint of [undefined, '', 'sha256:' + 'A'.repeat(64), 'sha256:short']) {
            expect(() => familyLineageHead({...input, fingerprint})).toThrow(TypeError);
        }
    });

    test('lineage reservation identity refuses inherited or missing fields', () => {
        const reservation = {attemptId: 'attempt-a', kid: 'key-a', originRunId: 'run-a'};
        const input       = {planeId: 'plane-a', issuer: 'fleet-a', fingerprint: null};
        expect(() => familyLineageHead({...input, reservation: Object.create(reservation)})).toThrow(TypeError);
        for (const key of ['attemptId', 'kid', 'originRunId']) {
            const partial = {...reservation};
            delete partial[key];
            expect(() => familyLineageHead({...input, reservation: partial})).toThrow(TypeError);
            Object.setPrototypeOf(partial, {[key]: reservation[key]});
            expect(() => familyLineageHead({...input, reservation: partial})).toThrow(TypeError);
        }
        expect(() => familyLineageHead({...input, reservation: null})).toThrow(TypeError);
    });

    test('binds the published tuple and domain to fixed bytes', () => {
        const expected = crypto.createHash('sha256')
            .update('neo.identity-family.membership.v1\0["plane-a",["github","https://api.github.com","42"],"binding-a"]')
            .digest('hex');

        expect(familyMembershipKey(binding)).toBe('identity-family-membership-' + expected);
    });

    test('login and same-incarnation seat re-key cannot rename membership or its queue', () => {
        const renamed = {...binding, seatId: 'new-seat', subject: {...subject, providerUsername: 'new-login'}};
        const before  = {...binding, seatId: 'old-seat', subject: {...subject, providerUsername: 'old-login'}};

        expect(familyMembershipKey(before)).toBe(familyMembershipKey(renamed));
        expect(familyQueueKey(before)).toBe(familyQueueKey(renamed));
        expect(familyMembershipKey({...binding, incarnation: 'replacement'})).not.toBe(familyMembershipKey(binding));
        expect(familyQueueKey({...binding, incarnation: 'replacement'})).toBe(familyQueueKey(binding));
    });

    test('separates identical user IDs across plane, provider and API namespaces', () => {
        const variants = [
            binding,
            {...binding, planeId: 'plane-b'},
            {...binding, subject: {...subject, authProvider: 'gitlab'}},
            {...binding, subject: {...subject, providerBaseUrl: 'https://forge.example/api/v4'}},
            {...binding, subject: {...subject, providerUserId: '43'}}
        ];

        expect(new Set(variants.map(familyMembershipKey)).size).toBe(variants.length);
        expect(new Set(variants.map(familyQueueKey)).size).toBe(variants.length);
    });

    test('domains and tuple boundaries cannot be confused by concatenated identifiers', () => {
        const receiptA = familyReceiptKey({planeId: 'a:b', issuer: 'c', operationId: 'd'});
        const receiptB = familyReceiptKey({planeId: 'a', issuer: 'b:c', operationId: 'd'});
        const intentA  = familyIntentKey({planeId: 'a', principal: 'b:c', seatId: 'd', retryToken: 'e'});
        const intentB  = familyIntentKey({planeId: 'a', principal: 'b', seatId: 'c:d', retryToken: 'e'});

        expect(receiptA).not.toBe(receiptB);
        expect(intentA).not.toBe(intentB);
        const keys = [familyMembershipKey(binding), familyQueueKey(binding), receiptA, intentA];
        expect(new Set(keys).size).toBe(4);
        expect(new Set(keys.map(key => key.slice(-64))).size).toBe(4);
        keys.forEach(key => expect(key).toMatch(/^identity-family-[a-z]+-[0-9a-f]{64}$/));
    });

    test('receipt identity survives delivery re-signing and kid rotation', () => {
        const operation = {planeId: 'plane-a', issuer: 'fleet-a', operationId: 'op-a'};
        const first     = familyReceiptKey({...operation, kid: 'old', issuedAt: 1, expiresAt: 300001});
        const resigned  = familyReceiptKey({...operation, kid: 'new', issuedAt: 300001, expiresAt: 600001});

        expect(first).toBe(resigned);
        expect(familyReceiptKey({...operation, issuer: 'other-fleet'})).not.toBe(first);
        expect(familyReceiptKey({...operation, operationId: 'op-b'})).not.toBe(first);
    });

    test('retry intent binds the authenticated principal and original act, not later contents', () => {
        const act = {planeId: 'plane-a', principal: 'owner:connection:42', seatId: 'seat-a', retryToken: 'retry-a'};
        const key = familyIntentKey({...act, incarnation: 'old', family: 'gpt'});

        expect(familyIntentKey({...act, incarnation: 'new', family: 'claude'})).toBe(key);
        for (const field of ['planeId', 'principal', 'seatId', 'retryToken']) {
            expect(familyIntentKey({...act, [field]: 'other'})).not.toBe(key);
        }
    });

    test('prototype-named and Unicode components stay opaque data', () => {
        const key = familyIntentKey({planeId: 'p/../p', principal: '__proto__', seatId: 'constructor', retryToken: 'é:token'});

        expect(key).toMatch(/^identity-family-intent-[0-9a-f]{64}$/);
        expect(key).not.toContain('__proto__');
        expect(familyQueueKey({...binding, subject: {...subject, providerUserId: 'é'}}))
            .not.toBe(familyQueueKey({...binding, subject: {...subject, providerUserId: 'e\u0301'}}));
    });

    test('missing stable subject metadata never falls back to username or inherited fields', () => {
        for (const field of Object.keys(subject)) {
            const partial = {...subject, providerUsername: '42'};
            delete partial[field];
            expect(() => familyMembershipKey({...binding, subject: partial})).toThrow(TypeError);
        }
        expect(() => familyQueueKey({...binding, subject: Object.create(subject)})).toThrow(TypeError);
        expect(() => familyQueueKey({...binding, subject: {...subject, providerUserId: 42}})).toThrow(TypeError);
        expect(() => familyQueueKey({...binding, subject: null})).toThrow(TypeError);
    });

    test('required components refuse absent, empty, padded or coerced values', () => {
        for (const value of [undefined, null, '', ' ', ' padded', 'padded ', 42, false]) {
            expect(() => familyMembershipKey({...binding, incarnation: value})).toThrow(TypeError);
            expect(() => familyQueueKey({...binding, planeId: value})).toThrow(TypeError);
            expect(() => familyReceiptKey({planeId: 'p', issuer: value, operationId: 'o'})).toThrow(TypeError);
            expect(() => familyIntentKey({planeId: 'p', principal: 'owner', seatId: 's', retryToken: value})).toThrow(TypeError);
        }
    });
});

import {test, expect} from '@playwright/test';
import crypto         from 'node:crypto';
import {
    familyIntentKey,
    familyMembershipKey,
    familyQueueKey,
    familyReceiptKey
} from '../../../../../../ai/services/shared/identityPublicationKeys.mjs';

const subject = Object.freeze({authProvider: 'github', providerBaseUrl: 'https://api.github.com', providerUserId: '42'});
const binding = Object.freeze({planeId: 'plane-a', subject, incarnation: 'binding-a'});

test.describe('identity publication deterministic record keys', () => {
    test('binds the published tuple and domain to fixed bytes', () => {
        const expected = crypto.createHash('sha256')
            .update('neo.identity-family.membership.v1\0["plane-a",["github","https://api.github.com","42"],"binding-a"]')
            .digest('hex');

        expect(familyMembershipKey(binding)).toBe('identity-family-membership-' + expected);
    });

    test('login and same-incarnation seat re-key cannot rename membership or its queue', () => {
        const renamed = {...binding, seatId: 'new-seat', subject: {...subject, providerUsername: 'new-login'}};
        const before = {...binding, seatId: 'old-seat', subject: {...subject, providerUsername: 'old-login'}};

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
        const intentA = familyIntentKey({planeId: 'a', principal: 'b:c', seatId: 'd', retryToken: 'e'});
        const intentB = familyIntentKey({planeId: 'a', principal: 'b', seatId: 'c:d', retryToken: 'e'});

        expect(receiptA).not.toBe(receiptB);
        expect(intentA).not.toBe(intentB);
        const keys = [familyMembershipKey(binding), familyQueueKey(binding), receiptA, intentA];
        expect(new Set(keys).size).toBe(4);
        expect(new Set(keys.map(key => key.slice(-64))).size).toBe(4);
        keys.forEach(key => expect(key).toMatch(/^identity-family-[a-z]+-[0-9a-f]{64}$/));
    });

    test('receipt identity survives delivery re-signing and kid rotation', () => {
        const operation = {planeId: 'plane-a', issuer: 'fleet-a', operationId: 'op-a'};
        const first = familyReceiptKey({...operation, kid: 'old', issuedAt: 1, expiresAt: 300001});
        const resigned = familyReceiptKey({...operation, kid: 'new', issuedAt: 300001, expiresAt: 600001});

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

import {test, expect}                from '@playwright/test';
import crypto                        from 'node:crypto';
import {stringifyCanonicalJson}      from '../../../../../../ai/services/shared/canonicalJson.mjs';
import {IDENTITY_PUBLICATION_LIMITS} from '../../../../../../ai/services/shared/identityPublicationOperation.mjs';
import {
    IDENTITY_PUBLICATION_DOMAIN,
    IDENTITY_PUBLICATION_PURPOSE,
    IDENTITY_PUBLICATION_VALIDITY_MS,
    verifyIdentityPublicationSignature
} from '../../../../../../ai/services/shared/identityPublicationSignature.mjs';

const first  = crypto.generateKeyPairSync('ed25519');
const second = crypto.generateKeyPairSync('ed25519');
const now    = 1700000000000;
const trust  = {audience: 'plane-a', issuer: 'fleet-a', publicKeys: new Map([['key-a', first.publicKey]]), now};

/** @summary Fixture data; operation semantics deliberately remain outside the signature verifier. */
function envelope(patch = {}) {
    return {
        audience : 'plane-a', expiresAt: now + 300000, issuedAt: now, issuer: 'fleet-a', kid: 'key-a',
        operation: {kind: 'confirm', model: null, operationId: 'act-1'},
        purpose  : 'identity-family-publication', version: 1, ...patch
    };
}

/** @summary Independent signer using the literal protocol prefix, including its one zero byte. */
function signText(text, key = first.privateKey, prefix = 'neo.identity-family-publication.v1\0') {
    const bytes     = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
    const signature = crypto.sign(null, Buffer.concat([Buffer.from(prefix, 'utf8'), bytes]), key);

    return bytes.toString('base64url') + '.' + signature.toString('base64url');
}

/** @summary Signs the fixture's canonical bytes without using a production signing helper. */
function signed(patch = {}, key = first.privateKey) {
    return signText(stringifyCanonicalJson(envelope(patch)), key);
}

test.describe('identity publication fixed signature profile', () => {
    test('fixed envelope identifiers obey the same encoded-byte grammar as the operation profile', () => {
        const oversized = 'x'.repeat(IDENTITY_PUBLICATION_LIMITS.identifierBytes - 1);
        for (const field of ['audience', 'issuer', 'kid']) {
            expect(verifyIdentityPublicationSignature(signed({[field]: oversized}), trust).code).toBe('malformed-envelope');
        }
        for (const field of ['audience', 'issuer']) {
            expect(verifyIdentityPublicationSignature(signed(), {...trust, [field]: oversized}).code).toBe('verifier-unavailable');
        }
    });

    test('pins the domain, purpose and validity independently', () => {
        expect(IDENTITY_PUBLICATION_DOMAIN).toBe('neo.identity-family-publication.v1');
        expect(IDENTITY_PUBLICATION_PURPOSE).toBe('identity-family-publication');
        expect(IDENTITY_PUBLICATION_VALIDITY_MS).toBe(300000);
    });

    test('authenticates exact canonical bytes and freezes their complete value', () => {
        const answer = verifyIdentityPublicationSignature(signed(), trust);

        expect(answer.authenticated).toBe(true);
        expect(answer.envelope.operation.model).toBeNull();
        expect(answer.canonicalPayload).toBe(stringifyCanonicalJson(envelope()));
        expect(Object.isFrozen(answer.envelope)).toBe(true);
        expect(Object.isFrozen(answer.envelope.operation)).toBe(true);
        expect(() => {answer.envelope.operation.kind = 'retire';}).toThrow(TypeError);
        expect(answer).not.toHaveProperty('accepted');
    });

    test('does not claim to validate or admit an operation variant', () => {
        const answer = verifyIdentityPublicationSignature(signed({operation: {unrecognized: true}}), trust);

        expect(answer.authenticated).toBe(true);
        expect(answer).not.toHaveProperty('receipt');
        expect(answer).not.toHaveProperty('accepted');
    });

    test('enforces the exact shared-clock half-open delivery interval', () => {
        const token = signed();

        expect(verifyIdentityPublicationSignature(token, {...trust, now: now - 1}).code).toBe('outside-validity');
        expect(verifyIdentityPublicationSignature(token, trust).authenticated).toBe(true);
        expect(verifyIdentityPublicationSignature(token, {...trust, now: now + 299999}).authenticated).toBe(true);
        expect(verifyIdentityPublicationSignature(token, {...trust, now: now + 300000}).code).toBe('outside-validity');
        expect(verifyIdentityPublicationSignature(token, {...trust, now: now + 300001}).code).toBe('outside-validity');
    });

    for (const [name, patch] of [
        ['wrong purpose', {purpose: 'bridge-token'}], ['wrong version', {version: 2}],
        ['short validity', {expiresAt: now + 299999}], ['long validity', {expiresAt: now + 300001}],
        ['fractional time', {issuedAt: now + .5, expiresAt: now + 300000.5}],
        ['string time', {issuedAt: String(now)}], ['negative time', {issuedAt: -1, expiresAt: 299999}],
        ['unsafe time', {issuedAt: Number.MAX_SAFE_INTEGER, expiresAt: Number.MAX_SAFE_INTEGER + 300000}],
        ['empty key id', {kid: ''}], ['array operation', {operation: []}], ['null operation', {operation: null}],
        ['algorithm negotiation', {algorithm: 'Ed25519'}], ['caller public key', {publicKey: 'not-trust'}]
    ]) {
        test('refuses ' + name + ' even with a valid signature', () => {
            expect(verifyIdentityPublicationSignature(signed(patch), trust).authenticated).toBe(false);
        });
    }

    test('requires every envelope field and rejects a primitive root', () => {
        for (const field of Object.keys(envelope())) {
            const value = envelope();
            delete value[field];
            expect(verifyIdentityPublicationSignature(signText(stringifyCanonicalJson(value)), trust).authenticated, field).toBe(false);
        }
        for (const value of [null, true, 1, 'payload', []]) {
            expect(verifyIdentityPublicationSignature(signText(stringifyCanonicalJson(value)), trust).authenticated).toBe(false);
        }
    });

    test('binds audience and issuer before selecting one exact trusted key', () => {
        for (const patch of [{audience: 'plane-b'}, {issuer: 'fleet-b'}, {kid: 'unknown'}, {kid: 'toString'}]) {
            expect(verifyIdentityPublicationSignature(signed(patch), trust).code).toBe('untrusted-envelope');
        }

        const overlap = {...trust, publicKeys: new Map([['key-a', first.publicKey], ['key-b', second.publicKey]])};
        expect(verifyIdentityPublicationSignature(signed({kid: 'key-b'}, second.privateKey), overlap).authenticated).toBe(true);
        expect(verifyIdentityPublicationSignature(signed({}, second.privateKey), overlap).code).toBe('invalid-signature');
        expect(verifyIdentityPublicationSignature(signed({kid: 'constructor'}),
            {...trust, publicKeys: new Map([['constructor', first.publicKey]])}).authenticated).toBe(true);
    });

    test('a retry rechecks current trust and current delivery time', () => {
        const token = signed();
        expect(verifyIdentityPublicationSignature(token, trust).authenticated).toBe(true);
        expect(verifyIdentityPublicationSignature(token, {...trust, publicKeys: new Map()}).code).toBe('untrusted-envelope');
        expect(verifyIdentityPublicationSignature(token, {...trust, now: now + 300000}).code).toBe('outside-validity');
        const resigned = signed({issuedAt: now + 300000, expiresAt: now + 600000});
        expect(verifyIdentityPublicationSignature(resigned, {...trust, now: now + 300000}).authenticated).toBe(true);
    });

    test('does not accept private or differently typed keys as verifier trust', () => {
        const rsa = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
        for (const key of [first.privateKey, rsa.publicKey, null, {type: 'public', asymmetricKeyType: 'ed25519'}]) {
            expect(verifyIdentityPublicationSignature(signed(), {...trust, publicKeys: new Map([['key-a', key]])}).authenticated).toBe(false);
        }
    });

    test('refuses a key wrapper masquerading as a public KeyObject', () => {
        const disguised = {type: 'public', asymmetricKeyType: 'ed25519', key: first.privateKey};

        expect(verifyIdentityPublicationSignature(signed(), {...trust, publicKeys: new Map([['key-a', disguised]])}).authenticated)
            .toBe(false);
    });

    test('refuses unavailable verifier inputs without reading an ambient clock', () => {
        for (const patch of [{now: undefined}, {now: NaN}, {now: Infinity}, {now: -1}, {now: now + .5},
            {audience: ''}, {issuer: ''}, {publicKeys: {}}, {publicKeys: null}]) {
            expect(verifyIdentityPublicationSignature(signed(), {...trust, ...patch}).code).toBe('verifier-unavailable');
        }
        expect(verifyIdentityPublicationSignature(signed()).code).toBe('verifier-unavailable');
    });

    test('detects payload tampering and rejects a valid signature over a different domain', () => {
        const token   = signed(), parts = token.split('.');
        const changed = Buffer.from(stringifyCanonicalJson(envelope({operation: {kind: 'correct'}}))).toString('base64url');
        expect(verifyIdentityPublicationSignature(changed + '.' + parts[1], trust).code).toBe('invalid-signature');
        for (const prefix of ['', 'neo.identity-family-publication.v1', 'neo.identity-family-publication.v1\0\0', 'bridge-token\0']) {
            expect(verifyIdentityPublicationSignature(signText(stringifyCanonicalJson(envelope()), first.privateKey, prefix), trust).code)
                .toBe('invalid-signature');
        }
    });

    test('rejects duplicate keys, whitespace and reordered bytes even when signed', () => {
        const text            = stringifyCanonicalJson(envelope());
        const duplicate       = text.replace('"version":1', '"version":0,"version":1');
        const nestedDuplicate = text.replace('"model":null', '"model":"old","model":null');
        const reordered       = JSON.stringify(Object.fromEntries(Object.entries(envelope()).reverse()));

        for (const payload of [' ' + text, text + '\n', duplicate, nestedDuplicate, reordered]) {
            expect(verifyIdentityPublicationSignature(signText(payload), trust).code).toBe('noncanonical-envelope');
        }
    });

    test('rejects noncanonical base64url and extra segments', () => {
        const token          = signed(), [payload, signature] = token.split('.');
        const alphabet       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        const tail           = alphabet[alphabet.indexOf(signature.at(-1)) ^ 1];
        const changedPadBits = signature.slice(0, -1) + tail;

        expect(Buffer.from(changedPadBits, 'base64url')).toEqual(Buffer.from(signature, 'base64url'));
        for (const value of [payload + '=.' + signature, payload + '.' + signature + '=', payload + '.' + changedPadBits,
            token + '.extra', '.' + signature, payload + '.', token.replace('.', '..'), ' ' + token, null, {}]) {
            expect(verifyIdentityPublicationSignature(value, trust).code).toBe('malformed-envelope');
        }
    });

    test('rejects malformed UTF-8 and short signatures', () => {
        const invalidUtf8 = Buffer.from([0xc3, 0x28]);
        expect(verifyIdentityPublicationSignature(signText(invalidUtf8), trust).code).toBe('malformed-envelope');
        const [payload] = signed().split('.');
        expect(verifyIdentityPublicationSignature(payload + '.' + Buffer.alloc(63).toString('base64url'), trust).code)
            .toBe('malformed-envelope');
    });
});

import {test, expect}                                  from '@playwright/test';
import {createHash, generateKeyPairSync}               from 'node:crypto';
import {compileIdentityPublicationBoot as compileText} from '../../../../../../../ai/services/memory-core/helpers/identityPublicationBoot.mjs';
import {stringifyCanonicalJson}                        from '../../../../../../../ai/services/shared/canonicalJson.mjs';
import {isSetupRunId, setupRecordPath}                 from '../../../../../../../ai/services/fleet/setupRunRecord.mjs';
import {IDENTITY_PUBLICATION_LIMITS}                   from '../../../../../../../ai/services/shared/identityPublicationOperation.mjs';

const first  = generateKeyPairSync('ed25519');
const second = generateKeyPairSync('ed25519');
const target = {planeId: 'plane-a', dataRoot: '/data/plane-a'};
const origin = '123e4567-e89b-42d3-a456-426614174000';
const spki   = key => key.export({format: 'der', type: 'spki'}).toString('base64url');

/** @summary Encodes fixture descriptors into the actual atomic configuration carrier. */
const compileIdentityPublicationBoot = (value, servedTarget) => compileText(stringifyCanonicalJson(value), servedTarget);

/** @summary Supplies a complete reservation-only fixture, never live provisioning data. */
function reserved() {
    return {version: 1, target: {...target}, issuer: 'fleet-a',
        reservation: {attemptId: 'attempt-a', kid: 'key-a', originRunId: origin}, trust: null};
}

/** @summary Adds public-only trust to the original reservation. */
function bound() {
    return {...reserved(), trust: [{kid: 'key-a', publicKey: spki(first.publicKey)}]};
}

test('reservation has no fingerprint or public key; null alone means unprovisioned', () => {
    expect(compileIdentityPublicationBoot(null, target)).toBeNull();
    const value = compileIdentityPublicationBoot(reserved(), target);
    expect(value.descriptor).toEqual(reserved());
    expect(value.publicKeys.size).toBe(0);
    for (const malformed of [undefined, false, '', {}, reserved()]) {
        expect(() => compileText(malformed, target)).toThrow('Identity publication boot:');
    }
});

test('wire-profile identifiers refuse at compilation before reservation or trust consumption', () => {
    const oversized = 'x'.repeat(IDENTITY_PUBLICATION_LIMITS.identifierBytes - 1);
    for (const field of ['planeId', 'issuer', 'kid', 'trustKid']) {
        const input = bound(), served = {...target};
        if (field === 'planeId') input.target.planeId = served.planeId = oversized;
        else if (field === 'issuer') input.issuer = oversized;
        else if (field === 'kid') input.reservation.kid = oversized;
        else input.trust[0].kid = oversized;
        expect(() => compileIdentityPublicationBoot(input, served)).toThrow('fixed wire-profile identifier grammar');
    }
});

test('compares independently served identity and root, never descriptor fields with themselves', () => {
    for (const served of [{...target, planeId: 'other'}, {...target, dataRoot: '/other'},
        {dataRoot: target.dataRoot}, {planeId: target.planeId}]) {
        expect(() => compileIdentityPublicationBoot(reserved(), served)).toThrow();
    }
});

test('derives a public fingerprint and permits overlap under the original issuer', () => {
    const input = bound();
    input.trust.push({kid: 'key-b', publicKey: spki(second.publicKey)});
    input.trust.reverse();
    const value = compileIdentityPublicationBoot(input, target);
    const bytes = first.publicKey.export({type: 'spki', format: 'der'});
    expect(value.descriptor.trust.map(entry => entry.kid)).toEqual(['key-a', 'key-b']);
    expect(value.descriptor.trust[0].fingerprint).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    expect(value.publicKeys.get('key-a').equals(first.publicKey)).toBe(true);
    expect(value.publicKeys.get('key-b').type).toBe('public');
    expect(value.descriptor.reservation.originRunId).toBe(origin);
    expect(input.trust[0]).not.toHaveProperty('fingerprint');
});

test('same kid with changed bytes yields different evidence, not a durable admission verdict', () => {
    const firstValue  = compileIdentityPublicationBoot(bound(), target);
    const replacement = bound();
    replacement.trust[0].publicKey = spki(second.publicKey);
    const next = compileIdentityPublicationBoot(replacement, target);
    expect(next.descriptor.trust[0].fingerprint).not.toBe(firstValue.descriptor.trust[0].fingerprint);
    expect(next).not.toHaveProperty('admitted');
});

test('origin run references must be resolvable by the supported host record owner', () => {
    for (const originRunId of ['run-a', '123e4567-e89b-72d3-a456-426614174000']) {
        const input = reserved();
        input.reservation.originRunId = originRunId;
        expect(() => compileIdentityPublicationBoot(input, target)).toThrow('originRunId');
    }
    const input = reserved();
    input.reservation.originRunId = origin.toUpperCase();
    const value = compileIdentityPublicationBoot(input, target).descriptor.reservation.originRunId;
    expect(value).toBe(origin.toUpperCase());
    expect(isSetupRunId(value)).toBe(true);
    expect(setupRecordPath('/fixture/setup', value)).toBe(`/fixture/setup/${value}.json`);
});

test('compiled records and keys are detached from later input mutation', () => {
    const input = bound();
    const value = compileIdentityPublicationBoot(input, target);
    input.target.planeId = 'other';
    input.reservation.originRunId = 'other';
    input.trust[0].publicKey = spki(second.publicKey);
    input.trust.length = 0;
    expect(value.descriptor.target).toEqual(target);
    expect(value.descriptor.reservation.originRunId).toBe(origin);
    expect(value.publicKeys.get('key-a').equals(first.publicKey)).toBe(true);
    for (const item of [value, value.descriptor, value.descriptor.target, value.descriptor.reservation,
        value.descriptor.trust, value.descriptor.trust[0]]) expect(Object.isFrozen(item)).toBe(true);
});

test('closed shapes reject missing fields, private material and asserted fingerprints', () => {
    for (const path of [[], ['target'], ['reservation'], ['trust', 0]]) {
        const input  = bound();
        const object = path.reduce((value, key) => value[key], input);
        object.fingerprint = 'sha256:' + 'a'.repeat(64);
        expect(() => compileIdentityPublicationBoot(input, target)).toThrow('unsupported fields');
    }
    for (const field of ['attemptId', 'kid', 'originRunId']) {
        for (const invalid of ['', ' padded ', null, 9, 'a\u0000b']) {
            const input = reserved();
            input.reservation[field] = invalid;
            expect(() => compileIdentityPublicationBoot(input, target)).toThrow(field);
        }
    }
    const input = reserved();
    input.reservation.privateKey = 'secret-marker';
    expect(() => compileIdentityPublicationBoot(input, target)).toThrow('unsupported fields');
    delete input.reservation.privateKey;
    delete input.reservation.originRunId;
    expect(() => compileIdentityPublicationBoot(input, target)).toThrow('missing');
    expect(() => compileIdentityPublicationBoot({...reserved(), version: 2}, target)).toThrow('version');
});

test('duplicate kids and absent selected trust cannot be hidden by Map construction', () => {
    for (const trust of [[], {}, [{kid: 'key-b', publicKey: spki(first.publicKey)}],
        [{kid: 'key-a', publicKey: spki(first.publicKey)}, {kid: 'key-a', publicKey: spki(second.publicKey)}]]) {
        expect(() => compileIdentityPublicationBoot({...reserved(), trust}, target)).toThrow();
    }
});

test('private encodings, key wrappers, non-Ed25519 and noncanonical DER all refuse', () => {
    const other       = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
    const publicBytes = first.publicKey.export({type: 'spki', format: 'der'});
    for (const encoded of [
        first.privateKey.export({type: 'pkcs8', format: 'der'}).toString('base64url'),
        first.privateKey.export({type: 'pkcs8', format: 'pem'}),
        {key: 'private-marker', type: 'public'}, spki(other.publicKey), spki(first.publicKey) + '=',
        Buffer.concat([publicBytes, Buffer.from([0])]).toString('base64url'), 'secret-marker'
    ]) {
        const input = bound();
        input.trust[0].publicKey = encoded;
        let error;
        try {compileIdentityPublicationBoot(input, target);} catch (caught) {error = caught;}
        expect(error?.code).toBe('IDENTITY_PUBLICATION_BOOT_INVALID');
        expect(error.message).not.toContain('secret-marker');
        expect(error.message).not.toContain('PRIVATE KEY');
    }
});

test('non-text programmatic overrides are rejected without executing accessors', () => {
    let   executed = false;
    const input    = reserved();
    Object.defineProperty(input, 'issuer', {enumerable: true, get() {executed = true; return 'fleet-a';}});
    expect(() => compileText(input, target)).toThrow('canonical JSON text');
    expect(executed).toBe(false);
    expect(() => compileText(new Map(), target)).toThrow('canonical JSON text');
});

test('programmatic text cannot bypass canonical or duplicate-key refusal', () => {
    for (const text of ['{"issuer":"first","issuer":"last"}', '{"reservation":{"kid":"first","kid":"last"}}',
        stringifyCanonicalJson(reserved()) + ' ', '{"version":1e400}']) {
        expect(() => compileText(text, target)).toThrow('canonical JSON text');
    }
});

test('prototype-named identifiers remain exact data', () => {
    const input = bound();
    input.issuer = '__proto__';
    input.reservation.kid = 'constructor';
    input.trust[0].kid = 'constructor';
    const value = compileIdentityPublicationBoot(input, target);
    expect(value.descriptor.issuer).toBe('__proto__');
    expect(value.publicKeys.get('constructor').equals(first.publicKey)).toBe(true);
});

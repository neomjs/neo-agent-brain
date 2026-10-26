import Neo from 'neo.mjs/src/Neo.mjs';
import * as core from 'neo.mjs/src/core/_export.mjs';
import {test, expect} from '@playwright/test';
import ConfigProvider, {createConfigProxy} from '../../../../../../../ai/ConfigProvider.mjs';
import ConfigBase from '../../../../../../../ai/mcp/server/memory-core/configBase.mjs';
import {stringifyCanonicalJson} from '../../../../../../../ai/services/shared/canonicalJson.mjs';
import {compileIdentityPublicationBoot} from '../../../../../../../ai/services/memory-core/helpers/identityPublicationBoot.mjs';

const name = 'NEO_IDENTITY_PUBLICATION_BOOT';
const leaf = ConfigBase.config.data.identityPublicationBoot;
const target = {planeId: 'plane-a', dataRoot: '/data/plane-a'};
const descriptor = {version: 1, target, issuer: 'fleet-a',
    reservation: {attemptId: 'attempt-a', kid: 'key-a', originRunId: '123e4567-e89b-42d3-a456-426614174000'}, trust: null};

test('the MC-owned leaf has an explicit unprovisioned default and one env decoder', () => {
    expect(leaf.default).toBeNull();
    expect(leaf.env).toBe(name);
    expect(leaf.type).toBe('string');
    expect(leaf.parse(name, {env: {}})).toBeUndefined();
    expect(leaf.parse(name, {env: {[name]: 'null'}})).toBe('null');
});

test('actual ConfigProvider construction resolves the descriptor through the declared leaf', () => {
    const previous = process.env[name];
    let provider;
    try {
        process.env[name] = stringifyCanonicalJson(descriptor);
        provider = createConfigProxy(Neo.create(ConfigProvider, {data: {identityPublicationBoot: leaf}}));
        expect(compileIdentityPublicationBoot(provider.identityPublicationBoot, target).descriptor).toEqual(descriptor);
    } finally {
        provider?.destroy();
        if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
    }
});

test('malformed, empty, duplicate or noncanonical env bytes throw without echoing input', () => {
    const canonical = stringifyCanonicalJson(descriptor);
    for (const raw of ['', 'secret-marker', canonical + ' ', '{"issuer":"secret-marker","issuer":"fleet-a"}',
        '{"value":1e400}', JSON.stringify(descriptor, null, 2)]) {
        let error;
        try {leaf.parse(name, {env: {[name]: raw}});} catch (caught) {error = caught;}
        expect(error?.message).toContain('expected canonical identity-publication boot JSON');
        expect(error.message).not.toContain('secret-marker');
    }
});

test('resolved text still needs closed shape and served-target validation', () => {
    const decoded = leaf.parse(name, {env: {[name]: '{"version":1}'}});
    expect(() => compileIdentityPublicationBoot(decoded, target)).toThrow('missing');
    expect(() => compileIdentityPublicationBoot(stringifyCanonicalJson(descriptor), {...target, dataRoot: '/other'})).toThrow('target');
});

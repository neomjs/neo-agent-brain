import {expect, test} from '@playwright/test';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import {createSeatPatOwner, createSeatPlaneOwner, createTenantBearerOwner, isLaunchCredentialBinding,
    restoreLaunchCredentialOwner, servedPlaneBinding, createResidentMcpInputOwner, isResidentMcpBinding, createBridgeTokenOwner} from '../../../../../../ai/services/fleet/launchCredentialOwners.mjs';

let root;
test.beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'credential-owner-'))); });
test.afterEach(() => { fs.rmSync(root, {recursive: true, force: true}); });

/** @summary A local owner with mutable test facts, recording secret reads separately from selector checks. */
function fixture() {
    const state = {root, agent: {id: 'seat', githubUsername: 'seat-login'}, pat: 'fixture-pat', bearer: 'fixture-plane',
        endpoint: 'https://plane.example.test', plane: {id: 'plane-a', dataRoot: '/data'}, reads: [], proofs: []};
    state.registry = {getDataDir: () => state.root, getDefinition: () => state.agent, getAgent: () => state.agent,
        resolveCredential: id => { state.reads.push(['pat', id]); return state.pat; }};
    state.tenantService = {getDataDir: () => state.root,
        resolveMcpResources       : tenantId => ({tenantId, endpoint: state.endpoint}),
        resolveMcpCredential      : id => { state.reads.push(['tenant', id]); return state.bearer; },
        resolveSeatPlaneCredential: () => { state.reads.push(['seat-plane']); return {credential: state.bearer, plane: state.plane}; },
        probeSeatPlaneCredential  : async args => { state.proofs.push(args); return {verdict: 'proved'}; }};
    return state;
}

test('the original PAT owner survives credential rotation but refuses a different store or identity', async () => {
    const state = fixture(), prove = async ({credential}) => ({verdict: credential === state.pat ? 'proved' : 'refused'});
    const owner = createSeatPatOwner({registry: state.registry, agent: state.agent, proveForgeAccount: prove});
    expect(isLaunchCredentialBinding(owner.binding)).toBe(true);
    expect(JSON.stringify(owner.binding)).not.toContain(state.pat);
    state.pat = 'rotated-pat';
    const restored = restoreLaunchCredentialOwner(owner.binding, {registry: state.registry, proveForgeAccount: prove});
    expect(restored.resolve()).toBe('rotated-pat');
    expect(await restored.prove('rotated-pat')).toEqual({verdict: 'proved'});
    state.reads.length = 0;
    state.agent = {...state.agent, githubUsername: 'another-seat'};
    expect(owner.resolve()).toBeNull();
    expect(state.reads).toEqual([]);
    expect(() => restoreLaunchCredentialOwner(owner.binding, {registry: state.registry})).toThrow(/changed or is unavailable/);
    state.agent.githubUsername = 'seat-login';
    state.root = fs.realpathSync(path.dirname(root));
    expect(owner.resolve()).toBeNull();
});

test('a credential proof cannot overtake an owner change', async () => {
    const state = fixture();
    let finish;
    const waiting = new Promise(resolve => finish = resolve);
    const owner   = createSeatPatOwner({registry: state.registry, agent: state.agent, proveForgeAccount: () => waiting});
    const proof   = owner.prove(state.pat);
    state.agent = {...state.agent, githubUsername: 'different'};
    finish({verdict: 'proved'});
    expect(await proof).toEqual({verdict: 'refused'});
});

test('Bridge renewal keeps its original signer and re-proves the captured port without retaining a token', async () => {
    const state = fixture();
    state.authority = {version: 1, source: 'registry-file', registryRoot: root, publicKeySha256: 'a'.repeat(64)};
    const original = structuredClone(state.authority), renewals = [], probes = [];
    state.registry.getBridgeSigningAuthority = () => state.authority;
    state.registry.renewBridgeToken = (id, authority) => {
        renewals.push({id, authority});
        return {token: `fresh-token-${renewals.length}`};
    };
    const probeVerifier = async options => { probes.push(options); return {verdict: 'proved'}; };
    const owner         = createBridgeTokenOwner({registry: state.registry, agent: state.agent, authority: original, probeVerifier});
    const restored      = restoreLaunchCredentialOwner(owner.binding, {registry: state.registry, probeVerifier});
    expect(restored.resolve()).toBe('fresh-token-1');
    expect(restored.resolve()).toBe('fresh-token-2');
    expect(renewals).toEqual([{id: 'seat', authority: original}, {id: 'seat', authority: original}]);
    expect(await restored.prove('fresh-token-2', {port: 12345, timeoutMs: 1000})).toEqual({verdict: 'proved'});
    expect(probes[0]).toMatchObject({port: 12345, publicKeySha256: original.publicKeySha256, timeoutMs: 1000});
    expect(JSON.stringify(restored.binding)).not.toContain('fresh-token');
    expect(isLaunchCredentialBinding({...restored.binding, token: 'forbidden'})).toBe(false);
    state.authority = {...state.authority, publicKeySha256: 'b'.repeat(64)};
    expect(restored.resolve()).toBeNull();
    expect(await restored.prove('fresh-token-2', {port: 12345})).toEqual({verdict: 'refused'});
    expect(renewals).toHaveLength(2);
    expect(probes).toHaveLength(1);
    expect(() => createBridgeTokenOwner({registry: null, agent: state.agent, authority: original})).toThrow(TypeError);
    expect(() => createBridgeTokenOwner({registry: {...state.registry, getDataDir: () => path.dirname(root)}, agent: state.agent, authority: original})).toThrow(/Launch credential owner binding is invalid/);
    expect(() => restoreLaunchCredentialOwner(owner.binding, {registry: state.registry, probeVerifier})).toThrow(/changed or is unavailable/);
});

test('a live Bridge proof cannot overtake a signer-source change', async () => {
    const state = fixture();
    state.authority = {version: 1, source: 'registry-file', registryRoot: root, publicKeySha256: 'a'.repeat(64)};
    state.registry.getBridgeSigningAuthority = () => state.authority;
    let finish;
    const owner = createBridgeTokenOwner({registry: state.registry, agent: state.agent, authority: state.authority,
        probeVerifier: () => new Promise(resolve => finish = resolve)});
    const proof = owner.prove('fixture-token', {port: 12345, timeoutMs: 1000});
    state.authority = {...state.authority, source: 'config'};
    finish({verdict: 'proved'});
    expect(await proof).toEqual({verdict: 'refused'});
});

test('tenant recovery keeps the original endpoint and served plane, without a registry-PAT fallback', async () => {
    const state = fixture();
    const owner = createTenantBearerOwner({tenantService: state.tenantService, agentId: 'seat', tenantId: 'tenant-a',
        endpoint: state.endpoint, expectedIdentity: '@seat-login', provenPlane: state.plane});
    const restored = restoreLaunchCredentialOwner(owner.binding, {tenantService: state.tenantService, registry: state.registry});
    expect(restored.resolve()).toBe(state.bearer);
    await restored.prove(state.bearer);
    expect(state.proofs[0]).toMatchObject({planeBase: state.endpoint, expectedPlane: {id: 'plane-a', dataRoot: '/data'}, expectedIdentity: '@seat-login'});
    state.bearer = null;
    expect(restored.resolve()).toBeNull();
    expect(state.reads.some(([kind]) => kind === 'pat')).toBe(false);
    state.endpoint = 'https://another.example.test';
    state.reads.length = 0;
    expect(owner.resolve()).toBeNull();
    expect(state.reads).toEqual([]);
    expect(() => restoreLaunchCredentialOwner(owner.binding, {tenantService: state.tenantService})).toThrow(/changed or is unavailable/);
});

test('a default-plane credential cannot follow a binding moved to another served plane', async () => {
    const state = fixture();
    const owner = createSeatPlaneOwner({tenantService: state.tenantService, agentId: 'seat', planeBase: state.endpoint,
        expectedIdentity: '@seat-login', provenPlane: state.plane});
    expect(owner.resolve()).toBe(state.bearer);
    state.plane = {id: 'plane-b', dataRoot: '/other'};
    expect(owner.resolve()).toBeNull();
    expect(await owner.prove(state.bearer)).toEqual({verdict: 'refused'});
    expect(state.proofs).toEqual([]);
    state.root = fs.realpathSync(path.dirname(root));
    state.reads.length = 0;
    expect(owner.resolve()).toBeNull();
    expect(state.reads).toEqual([]);
});

test('incomplete or secret-bearing metadata never becomes recovery authority', () => {
    const state = fixture();
    const owner = createTenantBearerOwner({tenantService: state.tenantService, agentId: 'seat', tenantId: 'tenant-a',
        endpoint: state.endpoint, expectedIdentity: '@seat-login'});
    expect(() => restoreLaunchCredentialOwner(owner.binding, {tenantService: state.tenantService})).toThrow(/incomplete/);
    expect(isLaunchCredentialBinding({...owner.binding, credential: 'secret'})).toBe(false);
    expect(isLaunchCredentialBinding({...owner.binding, endpoint: 'https://user:secret@plane.example.test'})).toBe(false);
    expect(servedPlaneBinding({resources: {'memory-core': {plane: state.plane}, 'knowledge-base': {plane: {...state.plane}}}})).toEqual(state.plane);
    expect(servedPlaneBinding({resources: {'memory-core': {plane: state.plane}, 'knowledge-base': {plane: {id: 'other', dataRoot: '/data'}}}})).toBeNull();
});

test('resident inputs rotate within the original config owner without gaining previously absent slots', () => {
    const binding = {version: 1, kind: 'resident-config', server: 'memory-core', plane: {id: 'plane-a', dataRoot: root},
        providers: {model: 'openAiCompatible', embedding: 'openAiCompatible', ask: null}};
    const current = {binding: structuredClone(binding), env: {NEO_OPENAI_COMPATIBLE_API_KEY: 'original-key'}};
    const owner   = createResidentMcpInputOwner({binding, names: Object.keys(current.env), read: () => current});
    expect(owner.read()).toEqual(current.env);
    current.env.NEO_OPENAI_COMPATIBLE_API_KEY = 'rotated-key';
    current.env.GEMINI_API_KEY = 'newly-present-key';
    expect(owner.read()).toEqual({NEO_OPENAI_COMPATIBLE_API_KEY: 'rotated-key'});
    expect(JSON.stringify({binding: owner.binding, names: owner.names})).not.toMatch(/original-key|rotated-key/);
    current.binding.providers.model = 'gemini';
    expect(owner.read()).toBeNull();
    current.binding = {...binding, plane: {...binding.plane, id: 'other-plane'}};
    expect(owner.matches()).toBe(false);
    expect(isResidentMcpBinding({...binding, env: current.env})).toBe(false);
});

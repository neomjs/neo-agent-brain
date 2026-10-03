import {setup} from '../../../../setup.mjs';

setup({
    neoConfig: {unitTestMode: true},
    appConfig: {name: 'ForgeConnectionRegistryTest'}
});

import {test, expect} from '@playwright/test';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import ForgeConnectionRegistryService, {normalizeEndpoint} from '../../../../../../ai/services/fleet/ForgeConnectionRegistryService.mjs';
import {dispatchFleetS1Request, FLEET_METHOD_SCOPE_CLASSES} from '../../../../../../ai/services/fleet/fleetServerPolicy.mjs';
import {createFleetWireRequest}                             from '../../../../../../src/fleet/contract/wire.mjs';

/**
 * @summary The governed-identity witness, rounds 1 and 2, held against the real registry: the
 * principal survives aliases and renames, unknown endpoints get none, only the plane-local path
 * mutates, and a store that cannot be trusted is never repaired.
 */
test.describe('ForgeConnectionRegistryService — the plane-governed owner principal', () => {
    const
        registry = ForgeConnectionRegistryService,
        ADMIN    = {actor: 'plane-admin', apply: true},
        A        = {authProvider: 'gitlab', providerBaseUrl: 'https://gitlab.example.com', providerUserId: '42'},
        B        = {...A, providerBaseUrl: 'https://git.example.org'},   // the same forge after a reverse-proxy move
        C        = {...A, providerBaseUrl: 'https://gitlab.other.net'},  // an unrelated forge, same numeric user id
        resolve  = facts => registry.resolveOwner(facts),
        storeOf  = () => path.join(registry.getDataDir(), 'forge-connections.json'),
        bytes    = () => fs.readFileSync(storeOf(), 'utf8'),
        // a client's request for a connection change, through the real wire dispatcher
        client   = method => dispatchFleetS1Request(
            {method, params: {endpoint: C.providerBaseUrl}, protocol: createFleetWireRequest('listAgents').protocol},
            {},
            {ownerPrincipal: 'owner:any:1'}
        );

    let dir;

    test.beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-connections-'));
        registry.dataDir = dir
    });

    test.afterEach(() => {
        registry.dataDir = null;
        fs.rmSync(dir, {recursive: true, force: true})
    });

    test('the v1 endpoint floor: case, a default port and trailing slashes are not identity', () => {
        for (const alias of ['HTTPS://GitLab.Example.com', 'https://gitlab.example.com:443', 'https://gitlab.example.com/', 'https://gitlab.example.com//']) {
            expect(normalizeEndpoint(alias), alias).toBe('https://gitlab.example.com')
        }

        // the scheme value, a non-default port and the path stay identity-bearing
        expect(normalizeEndpoint('http://gitlab.example.com')).toBe('http://gitlab.example.com');
        expect(normalizeEndpoint('https://gitlab.example.com:8443')).toBe('https://gitlab.example.com:8443');
        expect(normalizeEndpoint('https://example.com/GitLab/')).toBe('https://example.com/GitLab');

        // credentials, a query or a fragment make no endpoint
        for (const value of ['https://user:pw@gitlab.example.com', 'https://gitlab.example.com/?a=1', 'https://gitlab.example.com/#x', 'not a url', '', null]) {
            expect(normalizeEndpoint(value), String(value)).toBeNull()
        }
    });

    test('round 1: aliases and renames keep the principal; unknown endpoints get none; forges stay apart', () => {
        registry.initialize(ADMIN);

        const conn = registry.register({...ADMIN, authProvider: 'gitlab', endpoint: A.providerBaseUrl}).connectionId,
              pA   = resolve(A).principal;

        expect(pA).toBe(`owner:${conn}:42`);
        expect(resolve({...A, providerBaseUrl: 'HTTPS://GitLab.Example.com:443/'}).principal, 'syntax aliases keep A').toBe(pA);
        expect(resolve({...A, providerUsername: 'renamed-login'}).principal, 'a login rename keeps A').toBe(pA);
        expect(resolve({...A, providerUserId: undefined}).state, 'a missing user id refuses').toBe('refused');
        expect(resolve(B).state, 'B unknown: no principal before approval').toBe('unregistered');
        expect(resolve(C).state, 'C unknown: no principal before approval').toBe('unregistered');

        registry.approveAlias({...ADMIN, connectionId: conn, endpoint: B.providerBaseUrl});

        expect(resolve(B).principal, 'an approved same-forge move keeps A').toBe(pA);
        expect(resolve(C).state, 'the unrelated forge C stays isolated').toBe('unregistered');

        const connC = registry.register({...ADMIN, authProvider: 'gitlab', endpoint: C.providerBaseUrl}).connectionId;

        expect(resolve(C).principal, 'C registered: its own principal').toBe(`owner:${connC}:42`);
        expect(registry.approveAlias({...ADMIN, connectionId: conn, endpoint: C.providerBaseUrl}).refused, 'an alias asserting C into A').toBe('endpoint-already-bound');
        expect(new Set([resolve(A).principal, resolve(C).principal]).size, 'same numeric id, two forges: two owners').toBe(2)
    });

    test('round 2: only the plane-local path mutates, and a store it cannot trust is never repaired', async () => {
        expect(resolve(A).state, 'an absent store is uninitialized').toBe('uninitialized');
        expect(fs.readdirSync(dir), 'resolving creates nothing').toEqual([]);

        // no wire verb names a connection: a client's register, alias or init is refused before any registry
        expect(Object.keys(FLEET_METHOD_SCOPE_CLASSES).filter(method => /forge|connection/i.test(method))).toEqual([]);

        for (const method of ['initForgeConnections', 'registerForgeConnection', 'approveForgeAlias']) {
            expect((await client(method)).ok, method).toBe(false)
        }

        expect(fs.readdirSync(dir), 'a client changed nothing').toEqual([]);
        expect(registry.initialize(ADMIN).ok, 'only the plane admin initializes the store').toBe(true);

        const conn = registry.register({...ADMIN, authProvider: 'gitlab', endpoint: A.providerBaseUrl}).connectionId,
              pA   = resolve(A).principal;

        expect(resolve(A).state, 'the admin registers A; A is admitted').toBe('admitted');
        expect((await client('approveForgeAlias')).ok, 'an alias request for unknown C without authority').toBe(false);
        expect(resolve(C).state).toBe('unregistered');

        expect(registry.approveAlias({...ADMIN, connectionId: conn, endpoint: B.providerBaseUrl}).connectionId).toBe(conn);
        expect(resolve(B).principal, 'the authorized same-forge alias B keeps A').toBe(pA);

        const good    = bytes(),
              corrupt = '{"schema":1,"version":';

        fs.writeFileSync(storeOf(), corrupt);

        expect(resolve(A).state, 'a corrupt store refuses admission').toBe('unavailable');
        expect(registry.initialize(ADMIN).refused).toBe('store-unavailable');
        expect(registry.register({...ADMIN, authProvider: 'gitlab', endpoint: C.providerBaseUrl}).refused).toBe('store-unavailable');
        expect(bytes(), 'and is never replaced').toBe(corrupt);

        fs.writeFileSync(storeOf(), good);

        expect(registry.register({...ADMIN, authProvider: 'gitlab', endpoint: B.providerBaseUrl}).refused).toBe('endpoint-already-bound');
        expect(bytes(), 'a refused mutation leaves the store as it was').toBe(good);

        expect(registry.detach({...ADMIN, endpoint: B.providerBaseUrl}).ok).toBe(true);
        expect(resolve(B).state, 'a detached endpoint resolves nobody').toBe('unregistered');
        expect(registry.register({...ADMIN, authProvider: 'gitlab', endpoint: B.providerBaseUrl}).refused, 'and never binds again').toBe('endpoint-tombstoned');

        expect(JSON.parse(bytes()).tombstones[B.providerBaseUrl], 'the tombstone is store data').toBe(conn);
        expect(registry.approveAlias({...ADMIN, connectionId: conn, endpoint: B.providerBaseUrl}).refused).toBe('endpoint-tombstoned');
        expect(resolve(A).principal, 'A keeps its principal through all of it').toBe(pA)
    });

    test('round 2 control: the admin\'s approval binds C, so the refusal above is the gate', () => {
        registry.initialize(ADMIN);

        const conn = registry.register({...ADMIN, authProvider: 'gitlab', endpoint: A.providerBaseUrl}).connectionId;

        expect(registry.approveAlias({...ADMIN, connectionId: conn, endpoint: C.providerBaseUrl}).connectionId).toBe(conn);
        expect(resolve(C).principal).toBe(`owner:${conn}:42`)
    });

    test('a store that fails its integrity check is unavailable and left as it is', () => {
        registry.initialize(ADMIN);
        registry.register({...ADMIN, authProvider: 'github', endpoint: 'https://github.com'});

        const store = JSON.parse(bytes()),
              id    = Object.keys(store.connections)[0];

        for (const broken of [
            {...store, bindings: {'https://github.com': 'no-such-connection'}},
            // a reference is a string before any key lookup: an array coerces to a key, an object may throw
            {...store, bindings: {'https://github.com': [id]}},
            {...store, bindings: {'https://github.com': {toString: null}}},
            {...store, bindings: {}, tombstones: {'https://github.com': 42}},
            {...store, version: store.version + 1},
            {...store, tombstones: {'https://github.com': id}},
            {...store, bindings: {'HTTPS://GitHub.com/': id}},
            {...store, connections: {[id]: {authProvider: 'bitbucket'}}}
        ]) {
            const text = JSON.stringify(broken);

            fs.writeFileSync(storeOf(), text);
            expect(resolve({authProvider: 'github', providerBaseUrl: 'https://github.com', providerUserId: '1'}).state).toBe('unavailable');
            expect(bytes()).toBe(text)
        }
    });

    test('mutations are dry runs unless applied, serialized by a lock, and append one event each', () => {
        expect(registry.initialize({actor: 'plane-admin'})).toEqual({ok: true, applied: false, version: 1});
        expect(fs.readdirSync(dir), 'a dry init writes nothing').toEqual([]);

        registry.initialize(ADMIN);

        const first  = registry.register({...ADMIN, authProvider: 'github', endpoint: 'https://github.com'}),
              before = bytes();

        expect(registry.register({actor: 'plane-admin', authProvider: 'gitlab', endpoint: 'https://gitlab.com'})).toMatchObject({ok: true, applied: false});
        expect(bytes(), 'a dry run reports and writes nothing').toBe(before);

        fs.writeFileSync(path.join(dir, 'forge-connections.lock'), '');

        expect(registry.register({...ADMIN, authProvider: 'gitlab', endpoint: 'https://gitlab.com'}).refused, 'a held lock refuses').toBe('busy');
        expect(bytes()).toBe(before);

        fs.rmSync(path.join(dir, 'forge-connections.lock'));
        registry.detach({...ADMIN, endpoint: 'https://github.com'});

        const second = registry.register({...ADMIN, authProvider: 'gitlab', endpoint: 'https://gitlab.com'}),
              store  = JSON.parse(bytes());

        expect(second.connectionId, 'ids are random and never recycled').not.toBe(first.connectionId);
        expect(second.connectionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(store.events.map(event => event.op)).toEqual(['init', 'register', 'detach', 'register']);
        expect(store.events.every(event => event.actor === 'plane-admin')).toBe(true);
        expect(store.version).toBe(4);
        expect(fs.existsSync(path.join(dir, 'forge-connections.lock')), 'the lock is released').toBe(false);
        expect(fs.statSync(storeOf()).mode & 0o777, 'owner-only').toBe(0o600)
    });
});

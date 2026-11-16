import {test, expect} from '@playwright/test';
import {spawnSync}    from 'node:child_process';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';

const serverUrl = new URL('../../../../../../../ai/mcp/server/github-workflow/Server.mjs', import.meta.url).href;

test('GitHub boot owns a real identity-bound client and keeps unavailable family input optional', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'neo-family-reader-')));
    try {
        const roots = Object.fromEntries(['local', 'remote', 'different', 'inherited'].map(name => [name, path.join(root, name)]));
        for (const directory of Object.values(roots)) fs.mkdirSync(directory);
        const script = `
        import assert from 'node:assert/strict';
        import {registerHooks} from 'node:module';
        const Neo = (await import('neo.mjs/src/Neo.mjs')).default;
        await import('neo.mjs/src/core/_export.mjs');
        const calls = [], target = {planeId: 'declared-remote', dataRoot: ${JSON.stringify(roots.remote)}};
        assert.notEqual(target.planeId, process.env.NEO_PLANE_ID);
        assert.notEqual(target.dataRoot, process.env.NEO_PLANE_DATA_ROOT);
        let health = 'healthy', permission = 'WRITE', actualIdentity = '@fresh-reader', actualTarget = target, deleteWait = null;
        globalThis.fixtureConfig = {seat: {planeBase: 'https://plane.example', planeBearer: 'seat-token', planeTarget: [target.planeId, target.dataRoot]}};
        globalThis.fixtureRepository = {viewerLogin: 'stale-viewer', async fetchAndCacheViewerPermission() {
            calls.push('fresh-viewer');
            if (permission) this.viewerLogin = 'fresh-reader';
            return permission;
        }};
        globalThis.fetch = async (url, init = {}) => {
            assert.equal(String(url), 'https://plane.example/mc/mcp');
            assert.equal(new Headers(init.headers).get('authorization'), 'Bearer seat-token');
            if (init.method === 'GET') return new Response(null, {status: 405});
            if (init.method === 'DELETE') {calls.push('delete'); await deleteWait; return new Response('{}', {headers: {'content-type': 'application/json'}});}
            const body = JSON.parse(init.body);
            if (body.method === 'notifications/initialized') return new Response(null, {status: 202});
            let result;
            if (body.method === 'initialize') result = {protocolVersion: body.params.protocolVersion, capabilities: {tools: {}}, serverInfo: {name: 'fixture', version: '1'}};
            else {
                const name = body.params.name; calls.push(name);
                result = {structuredContent: name === 'list_permissions' ? {identity: actualIdentity} :
                    name === 'healthcheck' ? {plane: {id: actualTarget.planeId, dataRoot: actualTarget.dataRoot}} :
                    {state: 'unavailable', code: 'membership-unknown'}, content: []};
                if (name === 'healthcheck') assert.deepEqual(body.params.arguments, {scope: 'plane'});
            }
            return new Response(JSON.stringify({jsonrpc: '2.0', id: body.id, result}), {
                headers: {'content-type': 'application/json', 'mcp-session-id': 'fixture-session'}
            });
        };
        const serverUrl = ${JSON.stringify(serverUrl)};
        const replacements = new Map([
            ['./config.mjs', 'export default globalThis.fixtureConfig'],
            ['./logger.mjs', 'export default {info(){},warn(){},error(){}}'],
            ['../../../services/github-workflow/RepositoryService.mjs', 'export default globalThis.fixtureRepository'],
            ['../../../services/github-workflow/SyncService.mjs', 'export default {async ready(){}}'],
            ['../../../services/github-workflow/HealthService.mjs', 'export default {}'],
            ['./toolService.mjs', 'export const createGitHubToolService=()=>({buildToolCatalog:()=>[],listTools:()=>[],callTool:()=>{},destroy(){}})']
        ]);
        const hooks = registerHooks({resolve(specifier, context, nextResolve) {
            if (context.parentURL === serverUrl && replacements.has(specifier)) {
                return {url: 'data:text/javascript,' + encodeURIComponent(replacements.get(specifier)), shortCircuit: true};
            }
            return nextResolve(specifier, context);
        }});
        const Server = (await import(serverUrl)).default;
        const Fixture = Neo.setupClass(class extends Server {
            static config = {className: 'Neo.test.family.GitHubClientBootstrap1511'};
            async loadCustomConfig() {}
            createMcpServer() {return {};}
            async runHealthcheckAndLogStatus() {return {status: health};}
            async connectTransport() {calls.push('ordinary-transport');}
            startHeapObservation() {}
            startResolvedConfigReport() {}
        });
        let server;
        const create = async () => {server = Neo.create(Fixture); await server.ready(); await server.identityPublicationConnection; return server;};
        const close = async () => {await server.closeIdentityPublicationClient?.(); server.destroy();};
        try {
            await create();
            assert.equal(server.identityPublicationState?.state, 'bound');
            assert.equal(server.identityPublicationClient.expectedIdentity, '@fresh-reader');
            assert.equal(calls.filter(value => value === 'list_permissions').length, 1);
            assert.equal(calls.filter(value => value === 'healthcheck').length, 1);
            assert.ok(calls.indexOf('fresh-viewer') < calls.indexOf('list_permissions'));
            assert.ok(calls.includes('ordinary-transport'));
            const beforeForeign = calls.length;
            assert.deepEqual(await server.readFamilySourceForViewer({login: 'different-viewer'}),
                {state: 'unavailable', code: 'family-source-viewer-mismatch'});
            assert.equal(calls.length, beforeForeign, 'a mismatched operation viewer cannot read through the existing client');
            assert.deepEqual(await server.readFamilySourceForViewer({login: 'fresh-reader'}),
                {state: 'unavailable', code: 'membership-unknown'});
            assert.deepEqual(await server.readIdentityPublicationSnapshot(), {state: 'unavailable', code: 'membership-unknown'});
            let releaseDelete, secondClosed = false;
            deleteWait = new Promise(resolve => {releaseDelete = resolve;});
            const firstClose = server.closeIdentityPublicationClient();
            const secondClose = server.closeIdentityPublicationClient().then(() => {secondClosed = true;});
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(secondClosed, false, 'every Server closer must await the owned client teardown');
            releaseDelete();
            await Promise.all([firstClose, secondClose]);
            deleteWait = null;
            await close(); assert.ok(calls.includes('delete'));

            for (const planeTarget of [null, [], ['changed'], '{', '{"planeId":"changed"}', {planeId:'mixed', dataRoot:${JSON.stringify(roots.inherited)}}]) {
                calls.length = 0;
                globalThis.fixtureConfig.seat.planeTarget = planeTarget;
                await create();
                assert.equal(server.identityPublicationState?.state, 'unavailable');
                assert.equal(server.identityPublicationClient, null);
                assert.equal(calls.includes('list_permissions'), false);
                assert.ok(calls.includes('ordinary-transport'));
                await close();
            }
            globalThis.fixtureConfig.seat.planeTarget = [target.planeId, target.dataRoot];
            permission = null; calls.length = 0;
            await create();
            assert.equal(server.identityPublicationState?.code, 'family-source-viewer-unavailable');
            assert.equal(calls.includes('list_permissions'), false);
            assert.ok(calls.includes('ordinary-transport'));
            await close();

            permission = 'WRITE'; actualTarget = {...target, dataRoot: ${JSON.stringify(roots.different)}}; calls.length = 0;
            await create();
            assert.equal(server.identityPublicationState?.code, 'plane-binding-unavailable');
            assert.ok(calls.includes('ordinary-transport'));
            await close();

            actualTarget = target; actualIdentity = '@other'; calls.length = 0;
            await create();
            assert.equal(server.identityPublicationState?.code, 'viewer-binding-unavailable');
            assert.equal(calls.includes('healthcheck'), false);
            await close();

            actualIdentity = '@fresh-reader';
            await create();
            const originalClose = server.closeIdentityPublicationClient.bind(server);
            let closeCalls = 0, catchReached, releaseCatch;
            const reached = new Promise(resolve => {catchReached = resolve;});
            const paused = new Promise(resolve => {releaseCatch = resolve;});
            server.closeIdentityPublicationClient = () => {
                if (++closeCalls === 2) {catchReached(); return paused;}
                return originalClose();
            };
            globalThis.fixtureConfig.seat.planeBearer = ' malformed-whitespace ';
            const refreshing = server.afterHealthcheck({status: 'healthy'});
            await reached;
            const connection = server.identityPublicationConnection;
            server.destroy();
            const stateAfterDestroy = server.identityPublicationState;
            releaseCatch(); await refreshing; await connection;
            assert.equal(server.identityPublicationState, stateAfterDestroy, 'a late catch cannot resurrect Server state');
            server = null;

            globalThis.fixtureConfig.seat.planeBearer = 'seat-token';
            await create(); await server.closeIdentityPublicationClient();
            let unhandled = 0;
            const onUnhandled = () => {unhandled++;};
            process.on('unhandledRejection', onUnhandled);
            server.closeIdentityPublicationClient = () => Promise.reject(new Error('teardown refusal'));
            server.destroy(); server = null;
            await new Promise(resolve => setImmediate(resolve));
            process.off('unhandledRejection', onUnhandled);
            assert.equal(unhandled, 0, 'destroy owns its asynchronous close failure');
            console.log('PASS: actual Server boot, fresh viewer, owned SDK client, optional source refusals and cleanup');
        } finally {if (server && !server.isDestroyed) await close(); hooks.deregister();}
        `;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8', timeout: 20000,
            env: {...process.env, NEO_PLANE_ID: 'family-reader-fixture', NEO_PLANE_DATA_ROOT: roots.local}});
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain('PASS: actual Server boot');
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});

/** @summary Holds one real SDK connection phase without importing any live provider or plane. */
function heldConnectionScript(root, phase, destroy) {
    return `
        import assert from 'node:assert/strict';
        import {registerHooks} from 'node:module';
        const Neo = (await import('neo.mjs/src/Neo.mjs')).default;
        await import('neo.mjs/src/core/_export.mjs');
        const phase = ${JSON.stringify(phase)}, destroy = ${JSON.stringify(destroy)};
        const target = {planeId: 'held-reader-fixture', dataRoot: ${JSON.stringify(root)}};
        const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
        const entered = deferred(), release = deferred(), ordinary = deferred(), calls = [];
        const within = async (promise, message) => {
            let timer;
            try {return await Promise.race([promise, new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error(message)), 2000);
            })]);} finally {clearTimeout(timer);}
        };
        globalThis.fixtureConfig = {seat: {planeBase: 'https://held-plane.example', planeBearer: 'fixture-reader-token',
            planeTarget: [target.planeId, target.dataRoot]}};
        globalThis.fixtureRepository = {viewerLogin: 'old-viewer', async fetchAndCacheViewerPermission() {
            calls.push('fresh-viewer'); this.viewerLogin = 'held-reader'; return 'WRITE';
        }};
        globalThis.fetch = async (url, init = {}) => {
            assert.equal(String(url), 'https://held-plane.example/mc/mcp');
            assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-reader-token');
            if (init.method === 'GET') return new Response(null, {status: 405});
            if (init.method === 'DELETE') {calls.push('delete'); return new Response('{}', {headers: {'content-type': 'application/json'}});}
            const body = JSON.parse(init.body);
            if (body.method === 'notifications/initialized') return new Response(null, {status: 202});
            const name = body.method === 'initialize' ? 'initialize' : body.params.name;
            calls.push(name);
            if (name === phase) {entered.resolve(); await release.promise;}
            const result = name === 'initialize'
                ? {protocolVersion: body.params.protocolVersion, capabilities: {tools: {}}, serverInfo: {name: 'held-fixture', version: '1'}}
                : {structuredContent: name === 'list_permissions' ? {identity: '@held-reader'} :
                    name === 'healthcheck' ? {plane: {id: target.planeId, dataRoot: target.dataRoot}} :
                    {state: 'unavailable', code: 'membership-unknown'}, content: []};
            if (name === 'healthcheck') assert.deepEqual(body.params.arguments, {scope: 'plane'});
            return new Response(JSON.stringify({jsonrpc: '2.0', id: body.id, result}), {
                headers: {'content-type': 'application/json', 'mcp-session-id': 'held-fixture-session'}
            });
        };
        const serverUrl = ${JSON.stringify(serverUrl)};
        const replacements = new Map([
            ['./config.mjs', 'export default globalThis.fixtureConfig'],
            ['./logger.mjs', 'export default {info(){},warn(){},error(){}}'],
            ['../../../services/github-workflow/RepositoryService.mjs', 'export default globalThis.fixtureRepository'],
            ['../../../services/github-workflow/SyncService.mjs', 'export default {async ready(){}}'],
            ['../../../services/github-workflow/HealthService.mjs', 'export default {}'],
            ['./toolService.mjs', 'export const createGitHubToolService=()=>({buildToolCatalog:()=>[],listTools:()=>[],callTool:()=>{},destroy(){}})']
        ]);
        const hooks = registerHooks({resolve(specifier, context, nextResolve) {
            if (context.parentURL === serverUrl && replacements.has(specifier)) {
                return {url: 'data:text/javascript,' + encodeURIComponent(replacements.get(specifier)), shortCircuit: true};
            }
            return nextResolve(specifier, context);
        }});
        let server, boot, reads = [];
        try {
            const Server = (await import(serverUrl)).default;
            const Fixture = Neo.setupClass(class extends Server {
                static config = {className: 'Neo.test.family.GitHubHeldConnection1511'};
                async loadCustomConfig() {}
                createMcpServer() {return {};}
                async runHealthcheckAndLogStatus() {return {status: 'healthy'};}
                async connectTransport() {calls.push('ordinary-transport'); ordinary.resolve();}
                startHeapObservation() {}
                startResolvedConfigReport() {}
            });
            server = Neo.create(Fixture); boot = server.ready();
            await within(entered.promise, 'optional MC connection never reached held phase ' + phase);
            let readsSettled = 0;
            reads = [server.readIdentityPublicationSnapshot(), server.readIdentityPublicationSnapshot()];
            for (const read of reads) read.then(() => {readsSettled++;}, () => {readsSettled++;});
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(readsSettled, 0, 'family reads must not fabricate an observation before the held proof');
            assert.equal(calls.filter(name => name === 'initialize').length, 1);
            assert.equal(calls.filter(name => name === phase).length, 1);
            assert.equal(calls.includes('get_identity_publication_snapshot'), false);
            if (destroy) {
                const transportsBefore = calls.filter(name => name === 'ordinary-transport').length;
                const connection = server.identityPublicationConnection;
                server.destroy();
                const stateAfterDestroy = server.identityPublicationState, clientAfterDestroy = server.identityPublicationClient;
                release.resolve();
                await within(Promise.allSettled([boot, connection, ...reads]), 'destroyed reader did not settle after release');
                await new Promise(resolve => setImmediate(resolve));
                assert.equal(server.identityPublicationState, stateAfterDestroy, 'late proof rewrote destroyed Server state');
                assert.equal(server.identityPublicationClient, clientAfterDestroy, 'late proof reopened a destroyed reader');
                assert.equal(calls.filter(name => name === 'ordinary-transport').length, transportsBefore,
                    'optional MC completion reopened ordinary transport after destruction');
                assert.equal(calls.includes('get_identity_publication_snapshot'), false);
            } else {
                await within(ordinary.promise, 'optional MC ' + phase + ' blocked ordinary GitHub transport');
                await within(boot, 'ordinary GitHub boot did not settle while MC was held');
                assert.ok(server.identityPublicationConnection instanceof Promise, 'Server owns the observed connection promise');
                release.resolve();
                const result = await within(Promise.all([server.identityPublicationConnection, ...reads]), 'released MC proof did not settle');
                assert.equal(server.identityPublicationState.state, 'bound');
                for (const value of result.slice(1)) assert.deepEqual(value, {state: 'unavailable', code: 'membership-unknown'});
                for (const name of ['initialize', 'list_permissions', 'healthcheck']) {
                    assert.equal(calls.filter(value => value === name).length, 1, 'shared initialization duplicated ' + name);
                }
                assert.equal(calls.filter(name => name === 'ordinary-transport').length, 1);
            }
        } finally {
            release.resolve();
            await Promise.allSettled([boot, ...reads]);
            if (server && !server.isDestroyed) {await server.closeIdentityPublicationClient(); server.destroy();}
            hooks.deregister();
        }
    `;
}

for (const phase of ['initialize', 'list_permissions', 'healthcheck']) {
    for (const destroy of [false, true]) {
        test((destroy ? 'destroy before held MC ' : 'held MC ') + phase + (destroy ? ' releases' : ' does not block ordinary GitHub transport'), () => {
            const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'neo-held-family-reader-')));
            try {
                const result = spawnSync(process.execPath, ['--input-type=module', '-e', heldConnectionScript(root, phase, destroy)],
                    {encoding: 'utf8', timeout: 15000, env: {...process.env, NEO_PLANE_ID: 'held-reader-local', NEO_PLANE_DATA_ROOT: root}});
                expect(result.error).toBeUndefined();
                expect(result.status, result.stdout + result.stderr).toBe(0);
            } finally {fs.rmSync(root, {recursive: true, force: true});}
        });
    }
}

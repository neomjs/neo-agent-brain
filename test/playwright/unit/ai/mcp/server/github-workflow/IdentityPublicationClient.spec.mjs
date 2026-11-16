import {test, expect} from '@playwright/test';
import {spawnSync}    from 'node:child_process';

const serverUrl = new URL('../../../../../../../ai/mcp/server/github-workflow/Server.mjs', import.meta.url).href;

test('GitHub boot owns a real identity-bound client and keeps unavailable family input optional', () => {
    const script = `
        import assert from 'node:assert/strict';
        import {registerHooks} from 'node:module';
        const Neo = (await import('neo.mjs/src/Neo.mjs')).default;
        await import('neo.mjs/src/core/_export.mjs');
        const calls = [], target = {planeId: 'declared-remote', dataRoot: '/remote/root'};
        let health = 'healthy', permission = 'WRITE', actualIdentity = '@fresh-reader', actualTarget = target, deleteWait = null;
        globalThis.fixtureConfig = {seat: {planeBase: 'https://plane.example', planeBearer: 'seat-token', planeTarget: JSON.stringify(target)}};
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
            ['./toolService.mjs', 'export const buildToolCatalog=()=>[], listTools=()=>[], callTool=()=>{}']
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
        const create = async () => {server = Neo.create(Fixture); await server.ready(); return server;};
        const close = async () => {await server.closeIdentityPublicationClient?.(); server.destroy();};
        try {
            await create();
            assert.equal(server.identityPublicationState?.state, 'bound');
            assert.equal(server.identityPublicationClient.expectedIdentity, '@fresh-reader');
            assert.equal(calls.filter(value => value === 'list_permissions').length, 1);
            assert.equal(calls.filter(value => value === 'healthcheck').length, 1);
            assert.ok(calls.indexOf('fresh-viewer') < calls.indexOf('list_permissions'));
            assert.ok(calls.includes('ordinary-transport'));
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

            for (const planeTarget of [null, '{', '{"planeId":"changed"}', {planeId:'mixed', dataRoot:'/inherited'}]) {
                calls.length = 0;
                globalThis.fixtureConfig.seat.planeTarget = planeTarget;
                await create();
                assert.equal(server.identityPublicationState?.state, 'unavailable');
                assert.equal(server.identityPublicationClient, null);
                assert.equal(calls.includes('list_permissions'), false);
                assert.ok(calls.includes('ordinary-transport'));
                await close();
            }
            globalThis.fixtureConfig.seat.planeTarget = JSON.stringify(target);
            permission = null; calls.length = 0;
            await create();
            assert.equal(server.identityPublicationState?.code, 'family-source-viewer-unavailable');
            assert.equal(calls.includes('list_permissions'), false);
            assert.ok(calls.includes('ordinary-transport'));
            await close();

            permission = 'WRITE'; actualTarget = {...target, dataRoot: '/different'}; calls.length = 0;
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
            server.destroy();
            const stateAfterDestroy = server.identityPublicationState;
            releaseCatch(); await refreshing;
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
        env: {...process.env, NEO_PLANE_ID: 'family-reader-fixture', NEO_PLANE_DATA_ROOT: '/private/tmp/neo-family-reader-fixture'}});
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('PASS: actual Server boot');
});

import {expect, test}        from '@playwright/test';
import {spawnSync}           from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir}              from 'node:os';
import {join}                from 'node:path';

const rootUrl = new URL('../../../../../../../', import.meta.url).href;

/**
 * @summary Runs the real MC boot, HTTP and registered-tool composition in a separate fixture process.
 * Only unrelated startup collaborators and the graph mount are substituted. Publication helpers,
 * OpenAPI validation, tool mapping, service generation and auth/transport execute their production code.
 */
function compositionScript(root, scenario) {
    return `
        import assert from 'node:assert/strict';
        import {registerHooks} from 'node:module';
        import {readFileSync} from 'node:fs';
        import {generateKeyPairSync, sign} from 'node:crypto';
        import {parse} from 'acorn';
        import Database from 'better-sqlite3';
        import {Client} from '@modelcontextprotocol/sdk/client/index.js';
        import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
        const rootUrl = ${JSON.stringify(rootUrl)}, scenario = ${JSON.stringify(scenario)};
        const url = path => new URL(path, rootUrl).href;
        await import('neo.mjs/src/Neo.mjs');
        await import('neo.mjs/src/core/_export.mjs');
        const RequestContextService = (await import(url('ai/mcp/server/shared/services/RequestContextService.mjs'))).default;
        const {stringifyCanonicalJson: canonical} = await import(url('ai/services/shared/canonicalJson.mjs'));
        const {IDENTITY_PUBLICATION_LIMITS: caps} = await import(url('ai/services/shared/identityPublicationOperation.mjs'));
        const {IDENTITY_PUBLICATION_MAX_COMPACT_BYTES} = await import(url('ai/services/shared/identityPublicationSignature.mjs'));
        const {compileFoundingFamilySeed} = await import(url('ai/graph/identityFoundingSeed.mjs'));
        const {consumeIdentityPublicationBoot, readIdentityPublicationLineage} = await import(url('ai/services/memory-core/helpers/identityPublicationLineage.mjs'));
        const {admitIdentityPublication, readIdentityPublicationSnapshot} = await import(url('ai/services/memory-core/helpers/identityPublicationAdmission.mjs'));
        const {installIdentityFoundingSource} = await import(url('ai/services/memory-core/helpers/identityFoundingStorage.mjs'));
        const {fenceIdentityPublication} = await import(url('ai/services/memory-core/helpers/identityPublicationFence.mjs'));
        const db = new Database(':memory:');
        db.exec('CREATE TABLE Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL); CREATE TABLE Edges (id TEXT PRIMARY KEY, user_id TEXT, source TEXT, target TEXT, type TEXT, data TEXT NOT NULL);');
        const fill = (bytes, prefix = '') => {
            const room = bytes - 2 - prefix.length;
            return prefix + '"'.repeat(Math.floor(room / 2)) + (room % 2 ? 'x' : '');
        };
        const maximumId = fill(caps.identifierBytes), capacity = scenario === 'capacity';
        const target = {planeId: capacity ? maximumId : 'http-composition-fixture', dataRoot: ${JSON.stringify(root)}};
        const key = generateKeyPairSync('ed25519');
        const reserve = {version: 1, target, issuer: capacity ? maximumId : 'fixture-fleet', reservation: {
            attemptId: 'fixture-attempt', kid: capacity ? maximumId : 'fixture-key', originRunId: '123e4567-e89b-42d3-a456-426614174000'}, trust: null};
        const reserveText = canonical(reserve), boundText = canonical({...reserve,
            trust: [{kid: reserve.reservation.kid, publicKey: key.publicKey.export({type: 'spki', format: 'der'}).toString('base64url')}]});
        const seedFor = family => compileFoundingFamilySeed({identities: [{id: '@founder', type: 'AgentIdentity',
            properties: {accountType: 'agent', modelFamily: family}}], subjects: [{identityKey: '@founder',
            subject: {authProvider: 'github', providerBaseUrl: 'https://api.github.com', providerUserId: 'founder'}}]});
        const seed = seedFor('gpt');
        const foundingText = canonical({sourceRevision: 'fixture-reviewed-source', seed});
        const config = {identityPublicationBoot: null, identityPublicationFounding: null,
            plane: {id: target.planeId, dataRoot: target.dataRoot}, transport: 'streamable-http',
            mcpHttpHost: '127.0.0.1', mcpListenHost: '127.0.0.1', mcpHttpPort: 0,
            fleet: {cockpitOrigins: ['http://127.0.0.1:8080']}, orchestrator: {wakeDispatch: {}},
            auth: {mode: 'github-pat', githubApiBaseUrl: 'https://forge.fixture', patCacheTtlSeconds: 60,
                patStaleGraceSeconds: 0, patDiskCachePath: '', patValidationTimeoutMs: 1000,
                allowedUsers: [], pinFirstProviderSubject: false, host: null, issuerUrl: null, trustProxyIdentity: false}};
        let consumes = 0, installs = 0, receivedToken = null, walCalls = 0, graphUnavailable = false, planeAssertions = 0;
        const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
        const installedSignal = deferred();
        let graphHold = null, pendingBoot = null;
        const within = async (promise, message) => {
            let timer;
            try {
                return await Promise.race([promise, new Promise((resolve, reject) => {
                    timer = setTimeout(() => reject(new Error(message)), 2000);
                })]);
            } finally {clearTimeout(timer);}
        };
        const startup = [];
        const noop = new Proxy({}, {get: (_target, property) => property === 'then' ? undefined : () => undefined});
        const health = new Proxy({
            recordStartupDependency: (name, state) => startup.push({name, state}),
            ensureHealthy: () => {throw new Error('fixture embedder unavailable');}
        }, {get: (object, property) => object[property] ?? noop[property]});
        const graph = new Proxy({
            async ready() {
                if (graphUnavailable) throw new Error('fixture graph unavailable');
                if (graphHold) {
                    graphHold.entered.resolve();
                    await graphHold.release.promise;
                    graphHold.settled.resolve();
                }
            },
            consumeIdentityPublicationBoot(text, resolvedTarget) {
                consumes++; assert.deepEqual(resolvedTarget, target);
                return consumeIdentityPublicationBoot(db, text, resolvedTarget);
            },
            installIdentityFoundingSource(options) {
                installs++;
                const result = installIdentityFoundingSource(db, options);
                installedSignal.resolve();
                return result;
            },
            admitIdentityPublication(token, options) {
                receivedToken = token;
                assert.deepEqual(options.target, target);
                assert.equal(Object.hasOwn(options, 'clock'), false);
                return admitIdentityPublication(graphUnavailable ? null : db, token, options);
            },
            readIdentityPublicationSnapshot: options => readIdentityPublicationSnapshot(graphUnavailable ? null : db, options),
            readIdentityPublicationLineage: (text, resolvedTarget) => readIdentityPublicationLineage(graphUnavailable ? null : db, text, resolvedTarget)
        }, {get: (object, property) => object[property] ?? noop[property]});
        const memory = new Proxy({addMemory: async () => {walCalls++; return {fixtureWalReached: true};}},
            {get: (object, property) => object[property] ?? noop[property]});
        const permissions = new Proxy({listPermissions: async () => ({identity: '@' + RequestContextService.getUserId()})},
            {get: (object, property) => object[property] ?? noop[property]});
        Object.assign(globalThis, {compositionConfig: config, compositionGraph: graph, compositionHealth: health,
            compositionMemory: memory, compositionPermissions: permissions, compositionNoop: noop});

        const serverUrl = url('ai/mcp/server/memory-core/Server.mjs');
        const toolsUrl = url('ai/mcp/server/memory-core/toolService.mjs');
        const serviceUrl = url('ai/services/memory-core/IdentityPublicationService.mjs');
        const keep = new Set(['../BaseServer.mjs', './toolService.mjs', '../../ToolService.mjs',
            '../shared/services/AuthService.mjs', '../shared/services/AuthMiddleware.mjs',
            '../shared/services/RequestContextService.mjs', '../../../services/memory-core/IdentityPublicationService.mjs']);
        const stubs = new Map();
        for (const parent of [serverUrl, toolsUrl]) {
            const ast = parse(readFileSync(new URL(parent), 'utf8'), {ecmaVersion: 'latest', sourceType: 'module'});
            for (const declaration of ast.body.filter(node => node.type === 'ImportDeclaration')) {
                const specifier = declaration.source.value;
                if (!specifier.startsWith('.') || keep.has(specifier)) continue;
                const expression = name => {
                    if (specifier.endsWith('config.mjs') || name === 'Memory_Config') return 'globalThis.compositionConfig';
                    if (specifier.endsWith('/GraphService.mjs') || name === 'Memory_GraphService') return 'globalThis.compositionGraph';
                    if ((specifier.endsWith('/HealthService.mjs') && name === 'default') || name === 'Memory_HealthService') return 'globalThis.compositionHealth';
                    if (specifier.endsWith('/MemoryService.mjs')) return 'globalThis.compositionMemory';
                    if (specifier.endsWith('/PermissionService.mjs')) return 'globalThis.compositionPermissions';
                    if (name === 'hostedCommunityToolNames') return 'new Set()';
                    if (name === 'getHostedCommunityBoundaryRejection') return '() => null';
                    if (name === 'areHostedCommunityToolsVisible') return '() => true';
                    return name === 'default' || specifier.endsWith('/services.mjs') ? 'globalThis.compositionNoop' : '() => undefined';
                };
                const code = declaration.specifiers.map(item => {
                    if (item.type === 'ImportDefaultSpecifier') return 'export default ' + expression('default') + ';';
                    const name = item.imported.name;
                    return 'export const ' + name + ' = ' + expression(name) + ';';
                }).join(';');
                stubs.set(parent + '|' + specifier, code);
            }
        }
        stubs.set(serviceUrl + '|../../mcp/server/memory-core/config.mjs', 'export default globalThis.compositionConfig;');
        stubs.set(serviceUrl + '|./GraphService.mjs', 'export default globalThis.compositionGraph;');
        const hooks = registerHooks({resolve(specifier, context, nextResolve) {
            const code = stubs.get(context.parentURL + '|' + specifier);
            return code === undefined ? nextResolve(specifier, context) :
                {url: 'data:text/javascript,' + encodeURIComponent(code), shortCircuit: true};
        }});
        const actualFetch = globalThis.fetch, actualNow = Date.now;
        globalThis.fetch = async (input, options) => {
            const address = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
            if (address.href === 'https://forge.fixture/user') return new Response(JSON.stringify({id: 42, login: 'fixture-operator'}), {status: 200});
            assert.equal(address.hostname, '127.0.0.1', 'fixture refuses every other network destination');
            return actualFetch(input, options);
        };
        let transport, server, client, qualified;
        const bytes = () => db.prepare('SELECT * FROM Nodes ORDER BY id').all();
        const token = (operation, patch = {}) => {
            const now = Date.now(), payload = Buffer.from(canonical({version: 1,
                purpose: 'identity-family-publication', audience: target.planeId, issuer: reserve.issuer, kid: reserve.reservation.kid,
                issuedAt: now, expiresAt: now + 300000, operation, ...patch}));
            return payload.toString('base64url') + '.' + sign(null,
                Buffer.concat([Buffer.from('neo.identity-family-publication.v1\\0'), payload]), key.privateKey).toString('base64url');
        };
        try {
            const Server = (await import(serverUrl)).default;
            class CompositionServer extends Server {
                static config = {className: 'Test.Unit.MemoryCore.IdentityPublicationCompositionServer'};
                async boot() {}
                startHeapObservation() {}
                startResolvedConfigReport() {}
                assertPlaneIdentity() {planeAssertions++; return super.assertPlaneIdentity();}
            }
            Neo.setupClass(CompositionServer);
            transport = (await import(url('ai/mcp/server/shared/services/TransportService.mjs'))).default;
            const service = (await import(serviceUrl)).default;
            const {createIdentityPublicationClient} = await import(url('ai/services/shared/identityPublicationClient.mjs'));
            const stop = async () => {
                await qualified?.close(); qualified?.destroy(); qualified = null;
                await client?.close(); client = null;
                for (const mcp of transport.mcpServers.values()) await mcp.close();
                await server?.mcpServer?.close();
                if (transport.httpServer?.listening) await new Promise(resolve => transport.httpServer.close(resolve));
                transport.httpServer = null; transport.transports.clear(); transport.mcpServers.clear();
                server?.destroy(); server = null;
            };
            const boot = async (bootText, founding = null) => {
                await stop();
                server = Neo.create(CompositionServer);
                await server.ready();
                Object.assign(server, {aiConfig: config, logger: noop,
                    loadCustomConfig: async () => {config.identityPublicationBoot = bootText; config.identityPublicationFounding = founding;},
                    getPlaneMembers: () => {
                        const location = target.dataRoot + (scenario === 'incoherent-plane' ? '-stale' : '') + '/graph.sqlite';
                        return [{path: 'storagePaths.graph', resolved: location, default: location}];
                    },
                    runHealthcheckAndLogStatus: async () => {}, logSiblingConcurrency() {},
                    buildRequestContext: async auth => ({userId: auth.userId, username: auth.username})});
                await Server.prototype.boot.call(server);
            };
            const post = async compact => {
                const response = await actualFetch('http://127.0.0.1:' + transport.httpServer.address().port + '/identity/family-publications', {
                    method: 'POST', headers: {'content-type': 'application/vnd.neo.identity-family-publication'}, body: compact});
                return {status: response.status, body: await response.json()};
            };
            const connect = async () => {
                client = new Client({name: 'publication-composition-fixture', version: '1'}, {capabilities: {}});
                await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + transport.httpServer.address().port + '/mcp'),
                    {requestInit: {headers: {Authorization: 'Bearer fixture-pat'}}}));
            };
            const read = async (name, args = {}) => client.callTool({name, arguments: args});
            const baseline = {kind: 'baseline', operationId: 'baseline', effectiveAt: Date.now(), expectedPlaneRevision: 0, bindings: []};

            if (scenario === 'unsupported') {
                config.authMiddleware = () => {};
                await assert.rejects(boot(boundText, foundingText), /standard github-pat profile/);
                assert.equal(consumes, 0); assert.equal(installs, 0); assert.deepEqual(bytes(), []);
                assert.equal(transport.httpServer, null);
            } else if (scenario === 'wrong-target') {
                await assert.rejects(boot(canonical({...reserve, target: {...target, planeId: 'wrong'}})), /target does not match/);
                assert.equal(consumes, 0); assert.deepEqual(bytes(), []);
            } else if (scenario === 'incoherent-plane') {
                await assert.rejects(boot(boundText, foundingText), /partially-moved plane fails closed/);
                assert.equal(planeAssertions, 1);
                assert.equal(consumes, 0); assert.equal(installs, 0); assert.deepEqual(bytes(), []);
                assert.equal(server.mcpServer, null);
                assert.equal(transport.httpServer, null);
            } else if (scenario === 'unprovisioned') {
                await boot(null);
                assert.equal(planeAssertions, 0, 'unprovisioned startup acquires no new early gate');
                await connect();
                for (const name of ['get_identity_publication_snapshot', 'get_identity_publication_lineage']) {
                    assert.equal((await read(name)).structuredContent.code, 'publication-not-provisioned');
                }
                assert.equal((await read('consume_identity_publication_boot', {bootText: boundText})).isError, true);
                assert.equal((await post(token(baseline))).status, 401);
                assert.equal(consumes, 0); assert.equal(installs, 0); assert.deepEqual(bytes(), []);
            } else if (scenario === 'held-ready' || scenario === 'destroy-before-ready') {
                await boot(reserveText);
                assert.equal(consumes, 1);
                consumes = 0; installs = 0;
                const before = bytes();
                graphHold = {entered: deferred(), release: deferred(), settled: deferred()};
                pendingBoot = boot(boundText, foundingText);
                await within(graphHold.entered.promise, 'publication did not reach the held graph readiness');
                assert.equal(consumes, 0); assert.equal(installs, 0);
                if (scenario === 'held-ready') {
                    await within(pendingBoot, 'pending graph readiness blocked the WAL-local HTTP listener');
                    await connect();
                    assert.equal((await read('get_identity_publication_snapshot')).structuredContent.state, 'unavailable');
                    assert.equal((await post(token(baseline))).status, 503);
                    const wal = await read('add_memory', {prompt: 'fixture', decisionContext: 'fixture', response: 'fixture'});
                    assert.equal(wal.isError, false, JSON.stringify(wal)); assert.equal(walCalls, 1);
                    assert.equal(consumes, 0); assert.equal(installs, 0);
                    assert.deepEqual(bytes(), before);
                    graphHold.release.resolve();
                    await within(installedSignal.promise, 'released graph never completed trusted publication startup');
                    assert.equal(consumes, 1); assert.equal(installs, 1);
                    assert.equal((await read('get_identity_publication_lineage')).structuredContent.state, 'bound');
                    assert.equal((await post(token(baseline))).status, 201);
                    assert.equal((await read('get_identity_publication_snapshot')).structuredContent.state, 'available');
                } else {
                    server.destroy();
                    graphHold.release.resolve();
                    await within(graphHold.settled.promise, 'graph readiness did not settle after release');
                    await within(pendingBoot.catch(() => {}), 'destroyed server boot did not settle');
                    await new Promise(resolve => setImmediate(resolve));
                    assert.equal(consumes, 0, 'destroyed server consumed lineage after graph readiness');
                    assert.equal(installs, 0, 'destroyed server installed founding input after graph readiness');
                    assert.deepEqual(bytes(), before);
                }
            } else if (scenario === 'degraded') {
                graphUnavailable = true;
                await boot(boundText, foundingText);
                assert.equal(consumes, 0); assert.equal(installs, 0);
                assert.ok(startup.some(item => item.name === 'identity-publication' && item.state === 'degraded'));
                await connect();
                assert.equal((await read('get_identity_publication_snapshot')).structuredContent.code, 'publication-boot-unavailable');
                const wal = await read('add_memory', {prompt: 'fixture', decisionContext: 'fixture', response: 'fixture', sessionId: 'fixture-session'});
                assert.equal(wal.isError, false, JSON.stringify(wal)); assert.equal(walCalls, 1);
                assert.equal((await post(token(baseline))).status, 503);
                assert.deepEqual(bytes(), []);
            } else if (capacity) {
                await boot(reserveText);
                await boot(boundText, foundingText);
                await connect();
                // Maximal wire timestamps can remain finite Dates; this is the trusted fixture clock.
                Date.now = () => 8640000000000000 - 300000;
                const operation = {kind: 'baseline', operationId: maximumId, effectiveAt: Date.now(), expectedPlaneRevision: 0,
                    bindings: Array.from({length: caps.baselineBindings}, (_, index) => ({
                        subject: {authProvider: maximumId, providerBaseUrl: fill(caps.providerBaseBytes),
                            providerUserId: maximumId, providerUsername: maximumId},
                        seatId: fill(caps.identifierBytes, 'seat-' + index), incarnation: fill(caps.identifierBytes, 'inc-' + index)
                    }))};
                const compact = token(operation), before = bytes();
                assert.equal(Buffer.byteLength(compact), 588887);
                assert.equal(Buffer.byteLength(compact), IDENTITY_PUBLICATION_MAX_COMPACT_BYTES);
                assert.equal((await post(compact + 'x')).status, 413);
                assert.equal((await post(compact.slice(0, -1) + (compact.endsWith('A') ? 'B' : 'A'))).status, 401);
                assert.deepEqual(bytes(), before);
                const accepted = await post(compact);
                assert.equal(accepted.status, 201, JSON.stringify(accepted));
                assert.equal(accepted.body.receipt.bindingIds.length, 128);
                assert.equal(receivedToken, compact);
                const result = (await read('get_identity_publication_snapshot')).structuredContent;
                assert.equal(result.state, 'available');
                assert.deepEqual(result.snapshot.counts, {subjects: 2, admittedSubjects: 1, memberships: 128, declarations: 0, corrections: 0});
                assert.equal(result.snapshot.subjects.flatMap(subject => subject.bindings).length, 128);
                const retained = bytes();
                assert.equal((await post(compact)).body.state, 'idempotent');
                assert.deepEqual(bytes(), retained);
                qualified = createIdentityPublicationClient({baseUrl: 'http://127.0.0.1:' + transport.httpServer.address().port + '/mcp',
                    credential: 'fixture-pat', expectedIdentity: '@fixture-operator', expectedTarget: target});
                assert.deepEqual(await qualified.readSnapshot(), result);
            } else {
                await boot(reserveText);
                assert.equal(planeAssertions, 1, 'coherent provisioned placement reaches the existing assertion');
                await connect();
                const reserved = (await read('get_identity_publication_lineage')).structuredContent;
                assert.equal(reserved.state, 'reserved'); assert.equal(reserved.fingerprint, null);
                assert.equal(reserved.reservation.originRunId, reserve.reservation.originRunId);
                const reserveBytes = bytes();
                assert.equal((await post(token(baseline))).status, 401);
                assert.deepEqual(bytes(), reserveBytes);

                await boot(boundText, foundingText);
                await connect();
                assert.equal((await read('get_identity_publication_lineage')).structuredContent.state, 'bound');
                assert.equal((await read('get_identity_publication_snapshot')).structuredContent.code, 'membership-unknown');
                const before = bytes();
                assert.equal((await post('ordinary-pat-is-not-a-publication')).status, 401);
                for (const patch of [{audience: 'wrong'}, {purpose: 'bridge'}, {clock: 0}, {target},
                    {issuedAt: 0, expiresAt: 300000}]) assert.equal((await post(token(baseline, patch))).status, 401);
                assert.deepEqual(bytes(), before);
                const compact = token(baseline), accepted = await post(compact);
                assert.equal(accepted.status, 201); assert.equal(accepted.body.state, 'accepted');
                assert.equal(receivedToken, compact);
                assert.equal((await post(compact)).body.state, 'idempotent');
                const snapshot = (await read('get_identity_publication_snapshot')).structuredContent;
                assert.equal(snapshot.state, 'available'); assert.deepEqual(snapshot.snapshot.target, target);
                assert.deepEqual(snapshot.snapshot.founding, seed); assert.equal(snapshot.snapshot.counts.subjects, 1);
                assert.equal(snapshot.snapshot.counts.admittedSubjects, 0);
                const clientOptions = {baseUrl: 'http://127.0.0.1:' + transport.httpServer.address().port + '/mcp',
                    credential: 'fixture-pat', expectedIdentity: '@fixture-operator', expectedTarget: target};
                qualified = createIdentityPublicationClient(clientOptions);
                assert.deepEqual(await qualified.connect(), {state: 'bound'});
                assert.deepEqual(await qualified.readSnapshot(), snapshot);
                const wrongPlane = createIdentityPublicationClient({...clientOptions, expectedTarget: {...target, dataRoot: target.dataRoot + '/wrong'}});
                try {assert.equal((await wrongPlane.connect()).state, 'unavailable');}
                finally {await wrongPlane.close(); wrongPlane.destroy();}
                const retained = bytes();
                for (const args of [{target: {planeId: 'wrong'}}, {clock: 0}, {bootText: reserveText}]) {
                    assert.equal((await read('get_identity_publication_snapshot', args)).isError, true);
                    assert.equal((await read('get_identity_publication_lineage', args)).isError, true);
                }
                assert.deepEqual(bytes(), retained);
                await boot(boundText, canonical({sourceRevision: 'new-reference-same-seed', seed}));
                await connect();
                assert.deepEqual((await read('get_identity_publication_snapshot')).structuredContent, snapshot);
                assert.deepEqual(bytes(), retained);

                await boot(boundText, canonical({sourceRevision: 'different-reviewed-candidate', seed: seedFor('claude')}));
                await connect();
                assert.equal((await read('get_identity_publication_snapshot')).structuredContent.code, 'founding-source-conflict');
                assert.equal((await read('get_identity_publication_lineage')).structuredContent.state, 'bound');
                assert.equal((await post(compact)).body.code, 'founding-source-conflict');
                assert.deepEqual(bytes(), retained);
                await boot(boundText, foundingText);
                await connect();
                assert.deepEqual((await read('get_identity_publication_snapshot')).structuredContent, snapshot);

                const lineage = db.prepare("SELECT id, data FROM Nodes WHERE json_extract(data, '$.label') = 'IDENTITY_FAMILY_LINEAGE'").get();
                db.prepare('UPDATE Nodes SET user_id = ? WHERE id = ?').run('foreign-owner', lineage.id);
                const corrupted = bytes();
                assert.equal((await post(compact)).body.code, 'publication-history-unavailable');
                assert.equal((await read('get_identity_publication_snapshot')).structuredContent.code, 'publication-history-unavailable');
                assert.deepEqual(bytes(), corrupted);
                db.prepare('UPDATE Nodes SET user_id = NULL WHERE id = ?').run(lineage.id);
                db.transaction(() => fenceIdentityPublication(db, {...target, operation: 'fixture-restore', source: 'fixture'})).immediate();
                const fenced = bytes();
                assert.equal((await post(compact)).body.code, 'publication-restore-fenced');
                assert.equal((await read('get_identity_publication_snapshot')).structuredContent.code, 'publication-restore-fenced');
                assert.equal((await read('get_identity_publication_lineage')).structuredContent.state, 'fenced');
                assert.deepEqual(bytes(), fenced);
                assert.ok(installs > 0);
            }
            await stop(); service.destroy();
        } finally {
            graphHold?.release.resolve();
            await pendingBoot?.catch(() => {});
            await qualified?.close(); qualified?.destroy();
            await client?.close();
            if (transport?.httpServer?.listening) await new Promise(resolve => transport.httpServer.close(resolve));
            server?.destroy();
            hooks.deregister(); db.close(); globalThis.fetch = actualFetch; Date.now = actualNow;
        }
    `;
}

for (const scenario of ['supported', 'capacity', 'unsupported', 'wrong-target', 'incoherent-plane', 'unprovisioned', 'held-ready', 'destroy-before-ready', 'degraded']) {
    test('production identity publication composition: ' + scenario, () => {
        const root = mkdtempSync(join(tmpdir(), 'neo-publication-composition-'));
        try {
            const result = spawnSync(process.execPath, ['--input-type=module', '--eval', compositionScript(root, scenario)],
                {encoding: 'utf8', timeout: 25000});
            expect(result.error).toBeUndefined();
            expect(result.status, result.stderr + result.stdout).toBe(0);
        } finally {rmSync(root, {recursive: true, force: true});}
    });
}

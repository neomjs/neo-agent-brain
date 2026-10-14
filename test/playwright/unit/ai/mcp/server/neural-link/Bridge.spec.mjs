import {setup} from '../../../../../setup.mjs';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : 'BridgeHandshakeAuthTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}        from '@playwright/test';
import crypto                from 'crypto';
import {WebSocketServer}     from 'ws';
import {once}                from 'node:events';
import {probeBridgeVerifier} from '../../../../../../../ai/services/fleet/probeBridgeVerifier.mjs';

import Neo       from 'neo.mjs/src/Neo.mjs';
import * as core from 'neo.mjs/src/core/_export.mjs';
import Bridge    from '../../../../../../../ai/mcp/server/neural-link/Bridge.mjs';
import {
    BRIDGE_INFO_TYPE,
    BRIDGE_PROTOCOL_FEATURES,
    BRIDGE_PROTOCOL_VERSION,
    createBridgeInfoPayload,
    createBridgeVerifierPayload,
    isBridgeVerifierPayloadFresh,
    isBridgeInfoPayloadFresh
} from '../../../../../../../ai/mcp/server/neural-link/BridgeProtocol.mjs';

const {privateKey, publicKey} = crypto.generateKeyPairSync('ed25519');

// Sign a token the way FleetRegistryService.mintBridgeToken does (Ed25519 over the payload bytes).
const sign = (agentId, expiresAt = Date.now() + 3_600_000) => {
    const p = Buffer.from(JSON.stringify({agentId, expiresAt}));
    return `${p.toString('base64url')}.${crypto.sign(null, p, privateKey).toString('base64url')}`;
};

// A minimal WebSocket stand-in — handleConnection / registerAgent only touch close / on / send / readyState.
// `on` records each handler under `this.handlers` so a test can synthetically fire e.g. the 'close' handler.
const makeWs  = () => ({readyState: 1, closed: null, sent: [], handlers: {}, on(event, handler) {this.handlers[event] = handler}, send(d) {this.sent.push(d)}, close(code, reason) {this.closed = {code, reason}}, terminate() {}});
const makeReq = query => ({url: `/?${query}`, headers: {host: '127.0.0.1:8081'}});

test.describe('Bridge listener boundary (#15187)', () => {
    test('rejects wildcard and non-loopback bind hosts before opening a listener', async () => {
        await expect(Bridge.startServer({host: '0.0.0.0', port: 8081}))
            .rejects.toThrow('literal loopback host');
        await expect(Bridge.startServer({host: '192.0.2.1', port: 8081}))
            .rejects.toThrow('literal loopback host')
    })
});

test.describe('Bridge.handleConnection — agent handshake auth (#13172)', () => {
    test.beforeEach(() => {
        // isolate the singleton's connection maps + configure fleet mode (a verify key is present)
        Bridge.agents          = new Map();
        Bridge.apps            = new Map();
        Bridge.bridgePublicKey = publicKey;
    });

    test('SECURITY: a valid token binds the SIGNED agentId, ignoring a spoofed ?id=', () => {
        const ws = makeWs();
        Bridge.handleConnection(ws, makeReq(`role=agent&id=agent-b&token=${sign('agent-a')}`));

        expect(Bridge.agents.has('agent-a')).toBe(true);  // the signature decides identity
        expect(Bridge.agents.has('agent-b')).toBe(false); // the spoofed ?id= claim is ignored
        expect(ws.closed).toBe(null);
    });

    test('SECURITY: a missing / malformed / expired token closes 1008 and registers nothing', () => {
        const bad = [
            'role=agent&id=agent-a',                                          // missing token
            'role=agent&id=agent-a&token=not-a-token',                        // malformed
            `role=agent&id=agent-a&token=${sign('agent-a', Date.now() - 1)}`, // expired
            `role=agent&id=agent-a&token=${sign('agent-a').slice(0, -4)}AAAA` // tampered signature
        ];
        for (const q of bad) {
            Bridge.agents = new Map();
            const ws = makeWs();
            Bridge.handleConnection(ws, makeReq(q));
            expect(ws.closed?.code).toBe(1008);
            expect(Bridge.agents.size).toBe(0);
        }
    });

    test('the app / default connection path is unaffected by agent auth', () => {
        const ws = makeWs();
        Bridge.handleConnection(ws, makeReq('id=app-1&appName=Colors')); // no role → app
        expect(Bridge.apps.has('app-1')).toBe(true);
        expect(ws.closed).toBe(null);
    });

    test('test-role connections cannot replace an authenticated agent without a valid token', () => {
        const existing = makeWs(), app = makeWs();
        Bridge.agents.set('agent-a', existing);
        Bridge.apps.set('app-1', app);
        for (const token of [null, 'malformed', sign('agent-a', Date.now() - 1), sign('agent-a').slice(0, -4) + 'AAAA']) {
            const ws = makeWs();
            Bridge.handleConnection(ws, makeReq(`role=test&id=agent-a${token === null ? '' : `&token=${token}`}`));
            expect(ws.closed?.code).toBe(1008);
            expect(Bridge.agents.get('agent-a')).toBe(existing);
            expect(Bridge.agents.size).toBe(1);
            expect(Bridge.apps.get('app-1')).toBe(app);
            expect(app.sent).toEqual([]);
            expect(ws.handlers).toEqual({});
            expect(ws.sessionId).toBeUndefined();
        }
    });

    test('a valid test-role token binds the signed identity instead of the query claim', () => {
        const ws = makeWs();
        Bridge.handleConnection(ws, makeReq(`role=test&id=impostor&token=${sign('agent-a')}`));
        expect(Bridge.agents.get('agent-a')).toBe(ws);
        expect(Bridge.agents.has('impostor')).toBe(false);
        expect(ws.closed).toBeNull();
    });

    test('no configured key → legacy unauthenticated path registers the ?id= claim (no-FM dev)', () => {
        Bridge.bridgePublicKey = null;
        for (const role of ['agent', 'test']) {
            const ws = makeWs();
            Bridge.handleConnection(ws, makeReq(`role=${role}&id=legacy-agent`));
            expect(Bridge.agents.get('legacy-agent')).toBe(ws);
            expect(ws.closed).toBe(null);
        }
    });
});

test.describe('Bridge protocol freshness stamp (#13299)', () => {
    test.beforeEach(() => {
        Bridge.agents = new Map();
        Bridge.apps   = new Map();
    });

    test('createBridgeInfoPayload exposes the current Bridge protocol contract', () => {
        const payload = createBridgeInfoPayload();

        expect(payload).toEqual({
            type           : BRIDGE_INFO_TYPE,
            protocolVersion: BRIDGE_PROTOCOL_VERSION,
            features       : [...BRIDGE_PROTOCOL_FEATURES]
        });
        expect(isBridgeInfoPayloadFresh(payload)).toBe(true);
        expect(isBridgeInfoPayloadFresh({...payload, protocolVersion: 0})).toBe(false);
        expect(isBridgeInfoPayloadFresh({...payload, features: []})).toBe(false);
        expect(isBridgeInfoPayloadFresh({...payload, features: ['agent-message-sidecar']})).toBe(false);
    });

    test('registerAgent sends bridge_info before ordinary agent notifications', () => {
        const ws = makeWs();
        Bridge.registerAgent('agent-a', ws);

        const firstFrame = JSON.parse(ws.sent[0]);

        expect(isBridgeInfoPayloadFresh(firstFrame)).toBe(true);
        expect(JSON.parse(ws.sent[1]).type).toBe('agent_connected');
    });
});

test.describe('Bridge read-only verifier (#980)', () => {
    test('the actual handler and probe agree over a disposable socket without touching active maps', async () => {
        Bridge.bridgePublicKey = publicKey;
        const existing = makeWs();
        Bridge.agents = new Map([['existing', existing]]);
        Bridge.apps = new Map();
        const server = new WebSocketServer({host: '127.0.0.1', port: 0});
        server.on('connection', (socket, request) => Bridge.handleConnection(socket, request));
        await once(server, 'listening');
        try {
            const publicKeySha256 = crypto.createHash('sha256').update(publicKey.export({format: 'der', type: 'spki'})).digest('hex');
            expect(await probeBridgeVerifier({port: server.address().port, publicKeySha256, timeoutMs: 1000}))
                .toEqual({verdict: 'proved'});
            expect(Bridge.agents).toEqual(new Map([['existing', existing]]));
            expect(Bridge.apps.size).toBe(0);
            expect(existing.sent).toEqual([]);
        } finally {
            server.clients.forEach(socket => socket.terminate());
            await new Promise(resolve => server.close(resolve));
        }
    });

    test('reports the cached token gate without registration, replay or session creation', () => {
        const existing = makeWs(), app = makeWs(), probe = makeWs();
        Bridge.agents = new Map([['agent-a', existing]]);
        Bridge.apps = new Map([['app-a', app]]);
        Bridge.bridgePublicKey = publicKey;
        const fingerprint = crypto.createHash('sha256').update(publicKey.export({format: 'der', type: 'spki'})).digest('hex');
        Bridge.handleConnection(probe, makeReq('role=verifier'));
        expect(probe.sent.map(JSON.parse)).toEqual([createBridgeVerifierPayload(fingerprint)]);
        expect(isBridgeVerifierPayloadFresh(JSON.parse(probe.sent[0]), fingerprint)).toBe(true);
        expect(Bridge.verifyAgentToken(sign('agent-a'))).toBe('agent-a');
        expect(probe.closed.code).toBe(1000);
        expect(probe.sessionId).toBeUndefined();
        expect(probe.handlers).toEqual({});
        expect(Bridge.agents).toEqual(new Map([['agent-a', existing]]));
        expect(Bridge.apps).toEqual(new Map([['app-a', app]]));
        expect(existing.sent).toEqual([]);
        expect(app.sent).toEqual([]);
    });

    test('legacy mode is explicit and extra request parameters cannot enter a registration path', () => {
        Bridge.bridgePublicKey = null;
        Bridge.agents = new Map();
        Bridge.apps = new Map();
        const legacy = makeWs();
        Bridge.handleConnection(legacy, makeReq('role=verifier'));
        expect(legacy.sent.map(JSON.parse)).toEqual([createBridgeVerifierPayload(null)]);
        for (const extra of ['id=seat', 'token=secret', 'role=agent', 'appWorkerId=app']) {
            const probe = makeWs();
            Bridge.handleConnection(probe, makeReq(`role=verifier&${extra}`));
            expect(probe.closed.code).toBe(1008);
            expect(probe.sent).toEqual([]);
        }
        expect(Bridge.agents.size).toBe(0);
        expect(Bridge.apps.size).toBe(0);
    });
});

test.describe('Bridge.handleAgentMessage — agent-message sidecar emit', () => {
    test.beforeEach(() => {
        Bridge.agents = new Map();
        Bridge.apps   = new Map();
    });

    test('registerAgent stamps a non-empty string sessionId on the agent socket', () => {
        const ws = makeWs();
        Bridge.registerAgent('agent-a', ws);

        expect(typeof ws.sessionId).toBe('string');
        expect(ws.sessionId.length).toBeGreaterThan(0);
    });

    test('handleAgentMessage forwards the message wrapped in the Bridge-stamped sidecar', () => {
        const appWs   = makeWs();
        const agentWs = makeWs();

        Bridge.apps.set('app-1', appWs);
        Bridge.registerAgent('agent-a', agentWs); // stamps agentWs.sessionId

        Bridge.handleAgentMessage('agent-a', Buffer.from(JSON.stringify({
            target : 'app-1',
            message: {id: 1, method: 'x'}
        })));

        const frame = JSON.parse(appWs.sent.at(-1));

        expect(frame.type).toBe('agent_message');
        expect(frame.agentId).toBe('agent-a');
        expect(frame.sessionId).toBe(agentWs.sessionId);
        expect(frame.message).toEqual({id: 1, method: 'x'});
    });

    test('agent disconnect broadcasts an agent_disconnected frame (with sessionId) to apps', () => {
        const appWs   = makeWs();
        const agentWs = makeWs();

        Bridge.apps.set('app-1', appWs);
        Bridge.registerAgent('agent-a', agentWs);

        const sessionId = agentWs.sessionId;

        agentWs.handlers.close(); // synthetically fire the recorded 'close' handler

        const frame = appWs.sent.map(JSON.parse).find(f => f.type === 'agent_disconnected');

        expect(frame).toBeTruthy();
        expect(frame.agentId).toBe('agent-a');
        expect(frame.sessionId).toBe(sessionId);
    });
});

test.describe('Bridge — an Agent that joins later learns what connected Apps announced (#953)', () => {
    // An App announces itself once per socket open; every frame below arrives before the late Agent joins
    const fromApp  = (id, method, params) => Bridge.handleAppMessage(id, Buffer.from(JSON.stringify({jsonrpc: '2.0', method, params})));
    const replayOf = (agentWs, appWorkerId) => agentWs.sent.map(JSON.parse)
        .filter(frame => frame.type === 'app_message' && frame.appWorkerId === appWorkerId)
        .map(frame => frame.message);

    test.beforeEach(() => {
        Bridge.agents   = new Map();
        Bridge.apps     = new Map();
        Bridge.appState = new Map();
    });

    test('app_connected is followed by the registration and each open window, never by history', () => {
        Bridge.registerApp('app-1', makeWs(), 'agentos');
        fromApp('app-1', 'register',         {appWorkerId: 'app-1', environment: 'development', isSharedWorker: true});
        fromApp('app-1', 'window_connected', {windowId: 'w1', appName: 'AgentOS'});
        fromApp('app-1', 'console_log',      {message: 'history'});
        fromApp('app-1', 'window_connected', {windowId: 'w2', appName: 'AgentOS'});

        const agentWs = makeWs();
        Bridge.registerAgent('agent-late', agentWs);

        const types  = agentWs.sent.map(JSON.parse).map(frame => frame.type),
              replay = replayOf(agentWs, 'app-1');

        expect(types.indexOf('app_connected')).toBeLessThan(types.indexOf('app_message'));
        expect(replay.map(message => message.method)).toEqual(['register', 'window_connected', 'window_connected']);
        expect(replay[0].params.environment).toBe('development');
        expect(replay.slice(1).map(message => message.params.windowId)).toEqual(['w1', 'w2'])
    });

    test('a window closed before the join is not replayed', () => {
        Bridge.registerApp('app-1', makeWs(), 'agentos');
        fromApp('app-1', 'window_connected',    {windowId: 'w1'});
        fromApp('app-1', 'window_connected',    {windowId: 'w2'});
        fromApp('app-1', 'window_disconnected', {windowId: 'w1'});

        const agentWs = makeWs();
        Bridge.registerAgent('agent-late', agentWs);

        expect(replayOf(agentWs, 'app-1').map(message => message.params.windowId)).toEqual(['w2'])
    });

    test('a reconnect under the same id starts afresh, and the replaced socket closing evicts nothing', () => {
        const replaced = makeWs(), successor = makeWs(), earlyAgent = makeWs();

        Bridge.registerAgent('agent-early', earlyAgent);
        Bridge.registerApp('app-1', replaced, 'agentos');
        fromApp('app-1', 'register',         {environment: 'before'});
        fromApp('app-1', 'window_connected', {windowId: 'w-before'});

        Bridge.registerApp('app-1', successor, 'agentos');
        replaced.handlers.close(); // the replaced socket's close lands after its successor registered
        fromApp('app-1', 'register',         {environment: 'after'});
        fromApp('app-1', 'window_connected', {windowId: 'w-after'});

        const lateAgent = makeWs();
        Bridge.registerAgent('agent-late', lateAgent);

        expect(Bridge.apps.get('app-1')).toBe(successor);
        expect(earlyAgent.sent.map(JSON.parse).some(frame => frame.type === 'app_disconnected')).toBe(false);
        expect(replayOf(lateAgent, 'app-1').map(message => message.params.environment ?? message.params.windowId))
            .toEqual(['after', 'w-after'])
    });

    test('a replaced socket\'s late messages reach neither the replay nor the Agents; the successor\'s still do', () => {
        const
            replaced   = makeWs(),
            successor  = makeWs(),
            earlyAgent = makeWs(),
            // through the handler each socket installed, the path a late frame takes
            say        = (ws, method, params) => ws.handlers.message(Buffer.from(JSON.stringify({jsonrpc: '2.0', method, params})));

        Bridge.registerAgent('agent-early', earlyAgent);
        Bridge.registerApp('app-1', replaced, 'agentos');
        Bridge.registerApp('app-1', successor, 'agentos');
        say(successor, 'register',         {environment: 'after'});
        say(successor, 'window_connected', {windowId: 'w-after'});

        const relayed = earlyAgent.sent.length;

        say(replaced, 'register',            {environment: 'stale'});
        say(replaced, 'window_connected',    {windowId: 'w-stale'});
        say(replaced, 'window_disconnected', {windowId: 'w-after'});

        expect(earlyAgent.sent.length, 'nothing the replaced socket said was relayed').toBe(relayed);

        say(successor, 'window_connected', {windowId: 'w-after-2'}); // the positive control: the successor still speaks

        const lateAgent = makeWs();
        Bridge.registerAgent('agent-late', lateAgent);

        expect(replayOf(lateAgent, 'app-1').map(message => message.params.environment ?? message.params.windowId))
            .toEqual(['after', 'w-after', 'w-after-2'])
    });

    test('the App leaving drops what it announced', () => {
        const appWs = makeWs();

        Bridge.registerApp('app-1', appWs, 'agentos');
        fromApp('app-1', 'window_connected', {windowId: 'w1'});
        appWs.handlers.close();

        const agentWs = makeWs();
        Bridge.registerAgent('agent-late', agentWs);

        expect(Bridge.appState.has('app-1')).toBe(false);
        expect(agentWs.sent.map(JSON.parse).some(frame => frame.appWorkerId === 'app-1')).toBe(false)
    });

    test('the late Agent\'s ConnectionService folds the replay into a reachable session', async () => {
        const {default: ConnectionService} = await import('../../../../../../../ai/services/neural-link/ConnectionService.mjs');

        Bridge.registerApp('app-953', makeWs(), 'agentos');
        fromApp('app-953', 'register',         {appWorkerId: 'app-953', environment: 'development', isSharedWorker: true});
        fromApp('app-953', 'window_connected', {windowId: 'w1', appName: 'AgentOS'});
        fromApp('app-953', 'window_connected', {windowId: 'w2', appName: 'AgentOS'});

        const agentWs = makeWs();
        Bridge.registerAgent('agent-late', agentWs);

        try {
            agentWs.sent.forEach(frame => ConnectionService.handleBridgeMessage(Buffer.from(frame)));

            const session = ConnectionService.sessionData.get('app-953');

            expect(session.environment).toBe('development');
            expect([...session.windows.keys()]).toEqual(['w1', 'w2'])
        } finally {
            ConnectionService.sessionData.delete('app-953')
        }
    });
});

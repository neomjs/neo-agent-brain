import {setup} from '../../../../setup.mjs';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : 'ConnectionServiceTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}                                     from '@playwright/test';
import {spawn}                                            from 'child_process';
import crypto                                             from 'crypto';
import fs                                                 from 'fs';
import net                                                from 'net';
import {once}                                             from 'node:events';
import os                                                 from 'os';
import path                                               from 'path';
import {fileURLToPath}                                    from 'url';
import {WebSocketServer}                                  from 'ws';
import Neo                                                from 'neo.mjs/src/Neo.mjs';
import * as core                                          from 'neo.mjs/src/core/_export.mjs';
import Bridge                                             from '../../../../../../ai/mcp/server/neural-link/Bridge.mjs';
import {createBridgeInfoPayload, STALE_BRIDGE_ERROR_CODE} from '../../../../../../ai/mcp/server/neural-link/BridgeProtocol.mjs';

/**
 * @summary Unit coverage for Neural Link connection freshness and Bridge process boundaries.
 *
 * Most tests stub `connectToBridge` / `spawnBridge`; the socket-close cases use an ephemeral loopback
 * WebSocketServer with the real freshness handshake. Importing the singleton is safe because `unitTestMode`
 * suppresses auto-connect. No test reaches or spawns the live Bridge.
 */
test.describe('Neo.ai.services.neural-link.ConnectionService — bridge freshness gate (#13299)', () => {
    const rpcClients = [];
    let BRIDGE_CWD_MISSING_SCRIPT, BRIDGE_NPM_SCRIPT, ConnectionService, getBridgeStdioLogPath, logBridgePayload,
        normalizeBridgePayloadDebugMaxChars, stringifyBridgePayloadForDebug,
        TARGET_DISCONNECTED_ERROR_CODE, BRIDGE_CLOSED_ERROR_CODE,
        originalBridgeTokenEnv, originalConnectToBridge, originalCreateBridgeUrl, originalCwd,
        originalOpenBridgeLogFile, originalReconnectDelayMs, originalRefreshEnvFn,
        originalSpawnBridge, originalSpawnBridgeProcess, originalStopBridgeProcess;
    const localBridgeServers = new Set();

    test.beforeAll(async () => {
        const module = await import('../../../../../../ai/services/neural-link/ConnectionService.mjs');

        BRIDGE_CWD_MISSING_SCRIPT            = module.BRIDGE_CWD_MISSING_SCRIPT;
        BRIDGE_NPM_SCRIPT                    = module.BRIDGE_NPM_SCRIPT;
        TARGET_DISCONNECTED_ERROR_CODE        = module.TARGET_DISCONNECTED_ERROR_CODE;
        BRIDGE_CLOSED_ERROR_CODE              = module.BRIDGE_CLOSED_ERROR_CODE;
        ConnectionService                    = module.default;
        getBridgeStdioLogPath                = module.getBridgeStdioLogPath;
        logBridgePayload                     = module.logBridgePayload;
        normalizeBridgePayloadDebugMaxChars  = module.normalizeBridgePayloadDebugMaxChars;
        stringifyBridgePayloadForDebug       = module.stringifyBridgePayloadForDebug;
    });

    test.beforeEach(() => {
        originalBridgeTokenEnv     = process.env.NEO_FLEET_BRIDGE_TOKEN;
        originalConnectToBridge    = ConnectionService.connectToBridge;
        originalCreateBridgeUrl    = ConnectionService.createBridgeUrl;
        originalCwd                = ConnectionService.cwd;
        originalOpenBridgeLogFile  = ConnectionService.openBridgeLogFile;
        originalReconnectDelayMs   = ConnectionService.reconnectDelayMs;
        originalRefreshEnvFn       = ConnectionService.refreshEnvFn;
        originalSpawnBridge        = ConnectionService.spawnBridge;
        originalSpawnBridgeProcess = ConnectionService.spawnBridgeProcess;
        originalStopBridgeProcess  = ConnectionService.stopBridgeProcess;
        delete process.env.NEO_FLEET_BRIDGE_TOKEN;
        ConnectionService.clearReconnectTimer();
        ConnectionService.bridgeSocket               = null;
        ConnectionService.bridgeProcess              = null;
        ConnectionService.spawnedBridgePort          = null;
        ConnectionService.bridgeToken                = null;
        ConnectionService.hasAttemptedInitialConnect = false;
        ConnectionService.manualDisconnect           = false;
        ConnectionService.activeAgents.clear();
        ConnectionService.pendingRequests.clear();
        ConnectionService.sessionData.clear();
    });

    test.afterEach(async () => {
        ConnectionService.manualDisconnect = true;
        ConnectionService.clearReconnectTimer();
        rpcClients.splice(0).forEach(client => {
            client.pendingRequests.forEach(pending => clearTimeout(pending.timeout));
            client.pendingRequests.clear();
        });
        ConnectionService.pendingRequests.forEach(pending => clearTimeout(pending.timeout));
        ConnectionService.pendingRequests.clear();
        ConnectionService.sessionData.clear();
        ConnectionService.activeAgents.clear();
        if (ConnectionService.bridgeSocket?.readyState === 1) ConnectionService.bridgeSocket.close();
        ConnectionService.bridgeSocket               = null;
        ConnectionService.bridgeProcess              = null;
        ConnectionService.spawnedBridgePort          = null;
        ConnectionService.bridgeToken                = null;
        ConnectionService.hasAttemptedInitialConnect = false;
        ConnectionService.manualDisconnect           = false;
        ConnectionService.connectToBridge            = originalConnectToBridge;
        ConnectionService.createBridgeUrl            = originalCreateBridgeUrl;
        ConnectionService.cwd                        = originalCwd;
        ConnectionService.openBridgeLogFile          = originalOpenBridgeLogFile;
        ConnectionService.reconnectDelayMs           = originalReconnectDelayMs;
        ConnectionService.refreshEnvFn               = originalRefreshEnvFn;
        ConnectionService.spawnBridge                = originalSpawnBridge;
        ConnectionService.spawnBridgeProcess         = originalSpawnBridgeProcess;
        ConnectionService.stopBridgeProcess          = originalStopBridgeProcess;
        if (originalBridgeTokenEnv === undefined) delete process.env.NEO_FLEET_BRIDGE_TOKEN;
        else process.env.NEO_FLEET_BRIDGE_TOKEN = originalBridgeTokenEnv;
        await Promise.all([...localBridgeServers].map(async server => {
            server.clients.forEach(socket => socket.terminate());
            await new Promise(resolve => server.close(() => resolve()))
        }));
        localBridgeServers.clear()
    });

    test('builds the Bridge URL from an explicit port and encoded fleet token', () => {
        const url = ConnectionService.createBridgeUrl({
            agentId: 'agent-test',
            port   : 19081,
            token  : 'token with spaces'
        });

        expect(url).toBe('ws://127.0.0.1:19081/?role=agent&id=agent-test&token=token+with+spaces');
    });

    /** @summary Exercises the real RPC methods with client-local state and captured outbound frames. */
    function createRpcClient() {
        const client = Object.create(ConnectionService);
        Object.assign(client, {
            pendingRequests: new Map(),
            sessionData    : new Map([['app-a', {}], ['app-b', {}]]),
            sent           : []
        });
        client.bridgeSocket = {send: payload => client.sent.push(JSON.parse(payload))};
        rpcClients.push(client);
        return client;
    }

    /** @summary Starts a fresh in-process Bridge endpoint; this never spawns the managed Bridge. */
    async function startLocalBridge() {
        const sockets = [],
            server    = new WebSocketServer({host: '127.0.0.1', port: 0});

        server.on('connection', socket => {
            sockets.push(socket);
            socket.send(JSON.stringify(createBridgeInfoPayload()))
        });

        await once(server, 'listening');

        localBridgeServers.add(server);

        return {server, sockets, url: `ws://127.0.0.1:${server.address().port}`}
    }

    /** @summary Observes resolution/rejection without leaving an unhandled promise during teardown. */
    function observe(promise, onSettle=() => {}) {
        return promise.then(
            value => { onSettle(); return {value} },
            error => { onSettle(); return {error} }
        )
    }

    for (const peerTarget of ['app-a', 'app-b']) {
        test(`broadcast replies stay with their caller when the peer targets ${peerTarget}`, async () => {
            const owner     = createRpcClient(), peer = createRpcClient();
            const ownerCall = owner.call('app-a', 'owner'), peerCall = peer.call(peerTarget, 'peer');
            const ownerId   = owner.sent[0].message.id, peerId = peer.sent[0].message.id;

            expect(ownerId).not.toBe(peerId);
            owner.handleAppMessage(peerTarget, {id: peerId, result: 'peer-result'});
            peer.handleAppMessage(peerTarget, {id: peerId, result: 'peer-result'});
            expect(owner.pendingRequests.has(ownerId)).toBe(true);
            owner.handleAppMessage('app-a', {id: ownerId, result: 'owner-result'});
            peer.handleAppMessage('app-a', {id: ownerId, result: 'owner-result'});
            await expect(ownerCall).resolves.toBe('owner-result');
            await expect(peerCall).resolves.toBe('peer-result');
            expect(owner.pendingRequests.size + peer.pendingRequests.size).toBe(0);
        });
    }

    test('disconnect error codes are stable public contracts', () => {
        expect(TARGET_DISCONNECTED_ERROR_CODE).toBe('NEURAL_LINK_TARGET_DISCONNECTED');
        expect(BRIDGE_CLOSED_ERROR_CODE).toBe('NEURAL_LINK_BRIDGE_CLOSED')
    });

    test('a foreign app cannot consume a matching request ID with a result or error', async () => {
        const client = createRpcClient(), call = client.call('app-a', 'owned');
        const id     = client.sent[0].message.id;

        client.handleAppMessage('app-b', {id, result: 'foreign'});
        expect(client.pendingRequests.has(id)).toBe(true);
        client.handleAppMessage('app-b', {id, error: {message: 'foreign error'}});
        expect(client.pendingRequests.has(id)).toBe(true);
        const rejection = expect(call).rejects.toThrow('owned error');
        client.handleAppMessage('app-a', {id, error: {message: 'owned error'}});
        await rejection;
        expect(client.pendingRequests.size).toBe(0);
    });

    test('notifications and late replies do not consume another live call', async () => {
        const client = createRpcClient(), notifications = [];
        client.handleNotification = (sessionId, message) => notifications.push({sessionId, message});
        const first = client.call('app-a', 'first'), firstId = client.sent[0].message.id;
        client.handleAppMessage('app-a', {id: firstId, result: 'first'});
        await expect(first).resolves.toBe('first');
        const second       = client.call('app-a', 'second'), secondId = client.sent[1].message.id;
        const notification = {method: 'console_log', params: {message: 'observation'}};

        client.handleAppMessage('app-a', {id: firstId, result: 'late'});
        client.handleAppMessage('app-b', notification);
        expect(notifications).toEqual([{sessionId: 'app-b', message: notification}]);
        expect(client.pendingRequests.has(secondId)).toBe(true);
        client.handleAppMessage('app-a', {id: secondId, result: 'second'});
        await expect(second).resolves.toBe('second');
    });

    test('app_disconnected rejects only that session’s pending RPCs once and clears their timers', async () => {
        const client             = createRpcClient(),
            originalSetTimeout   = globalThis.setTimeout,
            originalClearTimeout = globalThis.clearTimeout,
            timers               = new Map(),
            cleared              = new Set();
        let timerId       = 0,
            a1Settlements = 0,
            a2Settlements = 0;

        globalThis.setTimeout = callback => {
            const id = ++timerId;
            timers.set(id, callback);
            return id
        };
        globalThis.clearTimeout = id => { cleared.add(id) };

        try {
            const a1    = observe(client.call('app-a', 'first'), () => a1Settlements++),
                a1Id    = client.sent[0].message.id,
                a1Timer = client.pendingRequests.get(a1Id).timeout,
                a2      = observe(client.call('app-a', 'second'), () => a2Settlements++),
                a2Id    = client.sent[1].message.id,
                a2Timer = client.pendingRequests.get(a2Id).timeout,
                b       = observe(client.call('app-b', 'survives')),
                bId     = client.sent[2].message.id,
                bTimer  = client.pendingRequests.get(bId).timeout;

            client.handleBridgeMessage(Buffer.from(JSON.stringify({type: 'app_disconnected', appWorkerId: 'app-a'})));

            expect(client.pendingRequests.has(a1Id)).toBe(false);
            expect(client.pendingRequests.has(a2Id)).toBe(false);
            expect(client.pendingRequests.has(bId)).toBe(true);
            expect(cleared).toEqual(new Set([a1Timer, a2Timer]));
            expect(cleared.has(bTimer)).toBe(false);

            const [a1Result, a2Result] = await Promise.all([a1, a2]);
            expect(a1Result.error).toMatchObject({code: TARGET_DISCONNECTED_ERROR_CODE, sessionId: 'app-a'});
            expect(a2Result.error).toMatchObject({code: TARGET_DISCONNECTED_ERROR_CODE, sessionId: 'app-a'});

            // A repeated disconnect and late replies are idempotent; the sibling's request remains live.
            client.handleBridgeMessage(Buffer.from(JSON.stringify({type: 'app_disconnected', appWorkerId: 'app-a'})));
            client.handleAppMessage('app-a', {id: a1Id, result: 'late-first'});
            client.handleAppMessage('app-a', {id: a2Id, result: 'late-second'});
            timers.get(a1Timer)();
            timers.get(a2Timer)();
            await Promise.resolve();
            expect(a1Settlements).toBe(1);
            expect(a2Settlements).toBe(1);
            expect(client.pendingRequests.has(bId)).toBe(true);

            client.handleAppMessage('app-b', {id: bId, result: 'survived'});
            await expect(b).resolves.toMatchObject({value: 'survived'});
            expect(cleared.has(bTimer)).toBe(true)
        } finally {
            globalThis.setTimeout = originalSetTimeout;
            globalThis.clearTimeout = originalClearTimeout;
            for (const [id, pending] of client.pendingRequests) {
                cleared.add(pending.timeout);
                pending.reject(new Error('test cleanup'));
                client.pendingRequests.delete(id)
            }
        }
    });

    test('an actual Bridge close settles pending calls after stop nulled the current socket', async () => {
        const bridge             = await startLocalBridge(),
            originalSetTimeout   = globalThis.setTimeout,
            originalClearTimeout = globalThis.clearTimeout,
            cleared              = new Set(),
            observedTimers       = new Set();
        let socket;

        ConnectionService.createBridgeUrl = () => bridge.url;

        try {
            await ConnectionService.connectToBridge();
            socket = ConnectionService.bridgeSocket;
            ConnectionService.handleAppConnected('app-a');
            ConnectionService.handleAppConnected('app-b');

            // Keep real timers, but remember the two RPC deadlines so the close handler's cleanup is observable.
            globalThis.setTimeout = (callback, delay, ...args) => {
                const timer = originalSetTimeout(callback, delay, ...args);
                observedTimers.add(timer);
                return timer
            };
            globalThis.clearTimeout = timer => {
                observedTimers.has(timer) && cleared.add(timer);
                return originalClearTimeout(timer)
            };

            const a          = observe(ConnectionService.call('app-a', 'pending-a')),
                aId          = [...ConnectionService.pendingRequests].find(([, pending]) => pending.sessionId === 'app-a')[0],
                aTimer       = ConnectionService.pendingRequests.get(aId).timeout,
                b            = observe(ConnectionService.call('app-b', 'pending-b')),
                bId          = [...ConnectionService.pendingRequests].find(([, pending]) => pending.sessionId === 'app-b')[0],
                bTimer       = ConnectionService.pendingRequests.get(bId).timeout,
                socketClosed = new Promise(resolve => socket.once('close', resolve));

            expect(observedTimers.has(aTimer)).toBe(true);
            expect(observedTimers.has(bTimer)).toBe(true);

            await ConnectionService.manageConnection({action: 'stop'});
            expect(ConnectionService.bridgeSocket).toBeNull(); // stop retires the field before the close event
            await socketClosed;

            expect(ConnectionService.pendingRequests.size).toBe(0);
            expect(cleared.has(aTimer)).toBe(true);
            expect(cleared.has(bTimer)).toBe(true);
            const [aResult, bResult] = await Promise.all([a, b]);
            expect(aResult.error).toMatchObject({code: BRIDGE_CLOSED_ERROR_CODE});
            expect(bResult.error).toMatchObject({code: BRIDGE_CLOSED_ERROR_CODE})
        } finally {
            globalThis.setTimeout = originalSetTimeout;
            globalThis.clearTimeout = originalClearTimeout;
            if (socket?.readyState === 1) socket.terminate();
        }
    });

    test('a retired socket close cannot reject calls on its replacement socket', async () => {
        const bridge             = await startLocalBridge(),
            originalSetTimeout   = globalThis.setTimeout,
            originalClearTimeout = globalThis.clearTimeout,
            cleared              = new Set(),
            observedTimers       = new Set();
        let firstSocket, secondSocket;

        ConnectionService.createBridgeUrl = () => bridge.url;

        try {
            await ConnectionService.connectToBridge();
            firstSocket = ConnectionService.bridgeSocket;
            ConnectionService.handleAppConnected('app-a');

            globalThis.setTimeout = (callback, delay, ...args) => {
                const timer = originalSetTimeout(callback, delay, ...args);
                observedTimers.add(timer);
                return timer
            };
            globalThis.clearTimeout = timer => {
                observedTimers.has(timer) && cleared.add(timer);
                return originalClearTimeout(timer)
            };

            const a    = observe(ConnectionService.call('app-a', 'old-socket')),
                aId    = [...ConnectionService.pendingRequests].find(([, pending]) => pending.sessionId === 'app-a')[0],
                aTimer = ConnectionService.pendingRequests.get(aId).timeout;

            await ConnectionService.connectToBridge();
            secondSocket = ConnectionService.bridgeSocket;
            expect(secondSocket).not.toBe(firstSocket);
            ConnectionService.handleAppConnected('app-b');

            const serverSecondMessage = new Promise(resolve => bridge.sockets[1].once('message', data => resolve(JSON.parse(data.toString())))),
                b                     = observe(ConnectionService.call('app-b', 'new-socket')),
                bId                   = [...ConnectionService.pendingRequests].find(([, pending]) => pending.sessionId === 'app-b')[0],
                bTimer                = ConnectionService.pendingRequests.get(bId).timeout,
                oldSocketClosed       = new Promise(resolve => firstSocket.once('close', resolve));

            const bEnvelope = await serverSecondMessage;
            expect(observedTimers.has(aTimer)).toBe(true);
            expect(observedTimers.has(bTimer)).toBe(true);

            bridge.sockets[0].close(1000, 'retire old Bridge socket');
            await oldSocketClosed;

            expect(ConnectionService.bridgeSocket).toBe(secondSocket);
            expect(ConnectionService.pendingRequests.has(bId)).toBe(true);
            await expect(a).resolves.toMatchObject({error: {code: BRIDGE_CLOSED_ERROR_CODE}});
            expect(cleared.has(aTimer)).toBe(true);

            bridge.sockets[1].send(JSON.stringify({
                type       : 'app_message',
                appWorkerId: 'app-b',
                message    : {id: bEnvelope.message.id, result: 'replacement-survived'}
            }));
            await expect(b).resolves.toMatchObject({value: 'replacement-survived'});
            expect(cleared.has(bTimer)).toBe(true)
        } finally {
            globalThis.setTimeout = originalSetTimeout;
            globalThis.clearTimeout = originalClearTimeout;
            if (firstSocket?.readyState === 1) firstSocket.terminate();
            if (secondSocket?.readyState === 1) secondSocket.terminate()
        }
    });

    test('the existing timeout still rejects and cleans a connected silent target', async () => {
        const client = createRpcClient(), originalSetTimeout = globalThis.setTimeout;
        let expire, timer, call;
        try {
            globalThis.setTimeout = (callback, delay) => {
                expire = callback;
                return timer = originalSetTimeout(() => {}, delay);
            };
            call = client.call('app-a', 'pending');
        } finally {
            globalThis.setTimeout = originalSetTimeout;
        }
        expect(client.bridgeSocket, 'the silent App has a live Bridge route').toBeTruthy();
        const rejection = expect(call).rejects.toThrow('Request timed out');
        expire();
        clearTimeout(timer);
        await rejection;
        expect(client.pendingRequests.size).toBe(0);
    });

    test('resolves Bridge stdio logs only under the injected Neural Link log directory', () => {
        const logDir = path.resolve(os.tmpdir(), `nl-bridge-stdio-path-${process.pid}`);

        expect(getBridgeStdioLogPath({logPath: logDir}))
            .toBe(path.join(logDir, 'neural-link-bridge-stdio.log'));
        expect(() => getBridgeStdioLogPath({
            cwd       : '/repo',
            logPath   : '',
            neoRootDir: '/repo'
        })).toThrow(/aiConfig\.logPath/);
        expect(() => getBridgeStdioLogPath({logPath: '  '})).toThrow(/aiConfig\.logPath/);
    });

    test('fails before opening or spawning when the injected log directory is absent', async () => {
        let opened = false, spawned = false;

        ConnectionService.openBridgeLogFile = () => {
            opened = true;
        };
        ConnectionService.spawnBridgeProcess = () => {
            spawned = true;
        };

        await expect(ConnectionService.spawnBridge({
            logPath       : '',
            neoRootDir    : '/real-seat',
            startupDelayMs: 0
        })).rejects.toThrow(/aiConfig\.logPath/);

        expect(opened).toBe(false);
        expect(spawned).toBe(false);
    });

    test('writes Bridge stdio only inside an injected overlay path on a real-dir seat', () => {
        const
            seatRoot         = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-bridge-real-seat-')),
            canonicalLogPath = path.join(seatRoot, '.neo-ai-data', 'logs'),
            overlayLogDir    = path.join(seatRoot, '.neo-ai-data-overlay', 'logs'),
            overlayLogPath   = getBridgeStdioLogPath({logPath: overlayLogDir}),
            fd               = ConnectionService.openBridgeLogFile(overlayLogPath);

        fs.closeSync(fd);

        try {
            expect(fs.existsSync(overlayLogDir)).toBe(true);
            expect(fs.existsSync(overlayLogPath)).toBe(true);
            expect(fs.existsSync(canonicalLogPath)).toBe(false);
        } finally {
            fs.rmSync(seatRoot, {recursive: true, force: true});
        }
    });

    test('wires spawned Bridge stdio to the configured log file without launching it (#13899)', async () => {
        const logDir = path.resolve(os.tmpdir(), `nl-bridge-stdio-spawn-${process.pid}-${Date.now()}`);

        let openedPath, spawnCall, unrefCalled = false;

        ConnectionService.openBridgeLogFile = filePath => {
            openedPath = filePath;
            return 42
        };
        ConnectionService.spawnBridgeProcess = (command, args, options) => {
            spawnCall = {command, args, options};

            return {
                unref() {
                    unrefCalled = true
                },
                // A real `spawn()` returns a ChildProcess, which IS an EventEmitter — the production
                // path subscribes to 'error' because a spawn failure arrives as an event rather than
                // a throw. A double without `once` models a boundary that cannot fail the way the
                // real one does, so it stayed green while production had no failure path at all.
                once() {}
            }
        };

        // A real caller's cwd comes from the MCP entrypoint's `--cwd`. This arm previously supplied
        // none and still spawned, because `this.cwd || process.cwd()` invented one — the test relied
        // on the very fallback that put `/` in front of `npm run`.
        ConnectionService.cwd = '/real-seat';

        await ConnectionService.spawnBridge({logPath: logDir, startupDelayMs: 0});

        expect(spawnCall.options.cwd, 'the entrypoint-supplied cwd reaches the spawn').toBe('/real-seat');
        expect(openedPath).toBe(path.join(logDir, 'neural-link-bridge-stdio.log'));
        expect(path.basename(openedPath)).not.toBe('bridge.log');
        expect(spawnCall.command).toBe('npm');
        expect(spawnCall.args).toEqual(['run', 'ai:server-neural-link']);
        expect(spawnCall.options.stdio).toEqual(['ignore', 42, 42]);
        expect(unrefCalled).toBe(true);
    });

    /**
     * @summary An unresolved working directory must fail loudly, never substitute one.
     *
     * `this.cwd || process.cwd()` looked like a sensible default and was a wrong-value substitution.
     * A GUI-launched MCP server has `process.cwd() === '/'`, so `npm run` looked for `/package.json`,
     * the Bridge never started, and the resulting ECONNREFUSED took the whole server down — the seat
     * lost every Neural Link tool for the session. The cwd IS supplied, by the entrypoint's `--cwd`;
     * the singleton is just constructed at import and an auto-connect can outrun that assignment.
     *
     * The error names the missing input, where `/` named nothing and
     * surfaced as an ENOENT three layers away.
     */
    test('#16429: an unresolved cwd fails with a named error and spawns nothing', async () => {
        const logDir = path.resolve(os.tmpdir(), `nl-bridge-nocwd-${process.pid}-${Date.now()}`);

        let spawned = false;

        ConnectionService.openBridgeLogFile   = () => 42;
        ConnectionService.spawnBridgeProcess  = () => { spawned = true };
        ConnectionService.cwd                 = null;

        await expect(ConnectionService.spawnBridge({logPath: logDir, startupDelayMs: 0}))
            .rejects.toThrow(/`cwd` is unresolved/);

        expect(spawned, 'no process is launched against an invented directory').toBe(false);
    });

    test('#16429: spawnBridge HONORS startupDelayMs instead of a hardcoded wait', async () => {
        // The body ignored its own parameter and always waited 2000ms, so every caller's value was
        // silently discarded and the contract could not be tested. Measured Bridge bind is ~498ms —
        // this is a correctness fix, not a latency one.
        const logDir = path.resolve(os.tmpdir(), `nl-bridge-delay-${process.pid}-${Date.now()}`);

        ConnectionService.openBridgeLogFile  = () => 42;
        // `once` is part of the real boundary: spawn returns an EventEmitter and the production path
        // subscribes to 'error'. See the fuller note on the double above.
        ConnectionService.spawnBridgeProcess = () => ({unref() {}, once() {}});
        ConnectionService.cwd                = '/real-seat';

        const startedAt = Date.now();

        await ConnectionService.spawnBridge({logPath: logDir, startupDelayMs: 0});

        // Generous bound: the point is that it does not wait the discarded 2000ms literal.
        expect(Date.now() - startedAt, 'a 0ms delay must not wait two seconds').toBeLessThan(500);
    });

    test('logs bridge receives as bounded metadata when debug is disabled (#13473)', () => {
        const
            largeResult = `payload-${'x'.repeat(500)}`,
            calls       = [],
            testLogger  = {
                debug: (...args) => calls.push({level: 'debug', text: args.join(' ')}),
                info : (...args) => calls.push({level: 'info',  text: args.join(' ')})
            };

        logBridgePayload({
            type       : 'app_message',
            appWorkerId: 'app-worker-1',
            message    : {
                id    : 42,
                method: 'get_component_tree',
                result: {
                    tree: largeResult
                }
            }
        }, {
            logger  : testLogger,
            debug   : false,
            maxChars: 80
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].level).toBe('info');
        expect(calls[0].text).toContain('type=app_message');
        expect(calls[0].text).toContain('appWorkerId=app-worker-1');
        expect(calls[0].text).toContain('messageId=42');
        expect(calls[0].text).toContain('method=get_component_tree');
        expect(calls[0].text).toContain('payloadBytes=');
        expect(calls[0].text).not.toContain(largeResult);
        expect(calls[0].text).not.toContain('result');
    });

    test('caps full bridge payload detail behind opt-in debug logging (#13473)', () => {
        const
            largeValue = `debug-${'y'.repeat(300)}`,
            calls      = [],
            testLogger = {
                debug: (...args) => calls.push({level: 'debug', text: args.join(' ')}),
                info : (...args) => calls.push({level: 'info',  text: args.join(' ')})
            };

        logBridgePayload({
            type       : 'app_message',
            appWorkerId: 'app-worker-2',
            message    : {
                id    : 7,
                method: 'inspect',
                result: {largeValue}
            }
        }, {
            logger  : testLogger,
            debug   : true,
            maxChars: 90
        });

        expect(calls.map(call => call.level)).toEqual(['info', 'debug']);
        expect(calls[1].text).toContain('[ConnectionService] Bridge payload ');
        expect(calls[1].text).toContain('... [truncated ');
        expect(calls[1].text.length).toBeLessThan(170);
        expect(calls[1].text).not.toContain('y'.repeat(120));
    });

    test('serializes circular debug payloads without throwing (#13473)', () => {
        const circular = {type: 'app_message'};
        circular.self = circular;

        expect(() => stringifyBridgePayloadForDebug(circular, 40)).not.toThrow();
        expect(stringifyBridgePayloadForDebug(circular, 40)).toBe('[object Object]');
    });

    test('fails loudly instead of shadowing the AiConfig debug payload cap default (#13473)', () => {
        expect(() => normalizeBridgePayloadDebugMaxChars(undefined)).toThrow(/bridgePayloadDebugMaxChars/);
        expect(() => normalizeBridgePayloadDebugMaxChars(0)).toThrow(/bridgePayloadDebugMaxChars/);
    });

    test('spawns a Bridge only when the first connection attempt is a missing listener', async () => {
        let attempts = 0,
            spawned  = false;

        ConnectionService.connectToBridge = async () => {
            attempts++;

            if (attempts === 1) {
                throw new Error('connect ECONNREFUSED 127.0.0.1:8081')
            }
        };
        ConnectionService.spawnBridge = async () => {
            spawned = true;
        };

        await ConnectionService.ensureBridgeAndConnect();

        expect(attempts).toBe(2);
        expect(spawned).toBe(true);
    });

    test('ensureBridgeAndConnect short-circuits when bridgeSocket is already open and coalesces concurrent callers', async () => {
        let attempts = 0,
            spawned  = false,
            releaseConnect;

        ConnectionService.bridgeSocket    = {readyState: 1, close() {}};
        ConnectionService.connectToBridge = async () => { attempts++ };
        ConnectionService.spawnBridge     = async () => { spawned = true };

        await ConnectionService.ensureBridgeAndConnect();
        expect(attempts).toBe(0);
        expect(spawned).toBe(false);

        ConnectionService.bridgeSocket    = null;
        ConnectionService.connectToBridge = async () => {
            attempts++;
            await new Promise(resolve => { releaseConnect = resolve });
            ConnectionService.bridgeSocket = {readyState: 1, close() {}};
        };

        const first  = ConnectionService.ensureBridgeAndConnect(),
              second = ConnectionService.ensureBridgeAndConnect();

        expect(attempts).toBe(1);
        releaseConnect();
        await Promise.all([first, second]);
        expect(attempts).toBe(1);
        expect(spawned).toBe(false);
    });

    test('fails loudly instead of spawning over a reachable stale Bridge', async () => {
        let   spawned    = false;
        const staleError = new Error('Stale Neural Link Bridge on port 8081: missing bridge_info freshness handshake.');
        staleError.code  = STALE_BRIDGE_ERROR_CODE;

        ConnectionService.connectToBridge = async () => {
            throw staleError
        };
        ConnectionService.spawnBridge = async () => {
            spawned = true;
        };

        await expect(ConnectionService.ensureBridgeAndConnect()).rejects.toThrow(/Stale Neural Link Bridge/);

        expect(spawned).toBe(false);
    });

    /**
     * A start whose spawn died answered with the socket: `connect ECONNREFUSED 127.0.0.1:8081`. The cause the `exit`
     * listener had recorded (`BRIDGE_EXIT_1`, from `npm run` finding no script) reached `healthcheck` only, so
     * `manage_connection start` pointed an agent at a port instead of at its `--cwd`.
     */
    test('a start whose spawn recorded a failure reports it, with the refused socket as the cause', async () => {
        const refused = new Error('connect ECONNREFUSED 127.0.0.1:8081');

        ConnectionService.cwd             = '/some/workspace';
        ConnectionService.connectToBridge = async () => { throw refused };
        ConnectionService.spawnBridge     = async () => { ConnectionService.lastSpawnFailure = 'BRIDGE_EXIT_1' };

        try {
            const error = await ConnectionService.ensureBridgeAndConnect().catch(caught => caught);

            expect(error.code, 'the recorded code, not the socket\'s').toBe('BRIDGE_EXIT_1');
            expect(error.message).toContain('BRIDGE_EXIT_1');
            expect(error.message, 'the script that ran').toContain(`npm run ${BRIDGE_NPM_SCRIPT}`);
            expect(error.message, 'where it ran').toContain('/some/workspace');
            expect(error.message, 'the rule --cwd has to meet').toContain('ADR-0040');
            expect(error.cause, 'the socket error stays reachable').toBe(refused)
        } finally {
            ConnectionService.lastSpawnFailure = null
        }
    });

    test('with no recorded spawn failure, a start passes the connection error through untouched', async () => {
        const refused = new Error('connect ECONNREFUSED 127.0.0.1:8081');

        ConnectionService.lastSpawnFailure = null;
        ConnectionService.connectToBridge  = async () => { throw refused };
        ConnectionService.spawnBridge      = async () => {};

        await expect(ConnectionService.ensureBridgeAndConnect()).rejects.toBe(refused)
    });

    /**
     * `--cwd` names the Agent OS runtime root. Handed a target workspace instead, `npm run` exits 1 there with
     * `Missing script`. The manifest says so before anything is spawned.
     */
    test('a cwd whose package.json lacks the Bridge script is a finding before any spawn, and the spawn refuses', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-cwd-workspace-'));

        let spawned = false;

        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({scripts: {start: 'node .'}}));

        ConnectionService.openBridgeLogFile  = () => 42;
        ConnectionService.spawnBridgeProcess = () => { spawned = true };
        ConnectionService.cwd                = root;

        try {
            expect(ConnectionService.getCwdFinding()).toBe(BRIDGE_CWD_MISSING_SCRIPT);
            expect(ConnectionService.getStatus().cwdFinding, 'on the status, with no spawn attempted').toBe(BRIDGE_CWD_MISSING_SCRIPT);

            const {default: HealthService} = await import('../../../../../../ai/services/neural-link/HealthService.mjs'),
                  health                   = await HealthService.healthcheck();

            expect(health.bridge.cwdFinding, 'healthcheck names it before anything failed').toBe(BRIDGE_CWD_MISSING_SCRIPT);
            expect(JSON.stringify(health.bridge), 'a code, never the path').not.toContain(root);

            await expect(ConnectionService.spawnBridge({logPath: root, startupDelayMs: 0}))
                .rejects.toThrow(new RegExp(`defines no \`${BRIDGE_NPM_SCRIPT}\` script[\\s\\S]*ADR-0040`));

            expect(spawned, 'no process is launched where the script cannot run').toBe(false)
        } finally {
            fs.rmSync(root, {force: true, recursive: true})
        }
    });

    test('a cwd that defines the script, an unassigned one and an unreadable one are no finding', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-cwd-runtime-root-'));

        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({scripts: {[BRIDGE_NPM_SCRIPT]: 'node bridge.mjs'}}));

        try {
            ConnectionService.cwd = root;
            expect(ConnectionService.getCwdFinding(), 'the runtime root').toBeNull();

            ConnectionService.cwd = null;
            expect(ConnectionService.getCwdFinding(), 'the ordinary boot order').toBeNull();

            // Its spawn fails with ENOENT, and that attribution stays the spawn's
            ConnectionService.cwd = path.join(root, 'absent');
            expect(ConnectionService.getCwdFinding(), 'no manifest was read').toBeNull();
            expect(ConnectionService.getStatus().cwdFinding).toBeNull()
        } finally {
            fs.rmSync(root, {force: true, recursive: true})
        }
    });

    test('a session row says what the app runs and who addressed it, and the resolver gets the same facts', () => {
        const me = ConnectionService.agentId;

        ConnectionService.handleAppConnected('app-x', 'avatarLab', null);
        ConnectionService.handleNotification('app-x', {method: 'register', params: {appWorkerId: 'app-x', environment: 'development', isSharedWorker: false, userAgent: 'Chromium/156'}});
        ConnectionService.handleAppAddressed({appWorkerId: 'app-x', agentId: 'agent-grace', at: 1_000, first: true});
        ConnectionService.handleAppAddressed({appWorkerId: 'app-x', agentId: me,            at: 2_000, first: false});
        ConnectionService.handleAppAddressed({appWorkerId: 'app-x', agentId: me,            at: 3_000, first: false});
        // what the Bridge replays to a server joining late, and a session nobody drove
        ConnectionService.handleAppConnected('app-y', 'agentos', {first: {agentId: 'agent-ada', at: 500}, last: {agentId: 'agent-ada', at: 500}, agents: [{agentId: 'agent-ada', count: 1, lastAt: 500}]});
        ConnectionService.handleAppConnected('app-z', 'portal');
        ConnectionService.handleAppAddressed({appWorkerId: 'unknown', agentId: me, at: 4_000, first: true}); // no session, no throw

        const rows = Object.fromEntries(ConnectionService.getStatus().sessions.map(row => [row.id, row]));

        expect(rows['app-x']).toMatchObject({
            appName         : 'avatarLab', environment: 'development', isSharedWorker: false, userAgent: 'Chromium/156',
            firstAddressedBy: {agentId: 'agent-grace', at: 1_000}, lastAddressedBy: {agentId: me, at: 3_000},
            addressedBy     : ['agent-grace', me], addressedByMe: true
        });
        expect(rows['app-y']).toMatchObject({lastAddressedBy: {agentId: 'agent-ada', at: 500}, addressedBy: ['agent-ada'], addressedByMe: false});
        expect(rows['app-z']).toMatchObject({appName: 'portal', firstAddressedBy: null, lastAddressedBy: null, addressedBy: [], addressedByMe: false});
        expect(ConnectionService.describeSessions().find(session => session.id === 'app-x'))
            .toEqual({id: 'app-x', appName: 'avatarLab', lastAddressedBy: {agentId: me, at: 3_000}})
    });

    /** @summary Starts an in-process keyed Bridge delegating to `Bridge.handleConnection` with an Ed25519 keypair. */
    async function startKeyedBridge() {
        const
            {privateKey, publicKey} = crypto.generateKeyPairSync('ed25519'),
            signToken               = (agentId, expiresAt = Date.now() + 60_000) => {
                const payload = Buffer.from(JSON.stringify({agentId, expiresAt}));
                return `${payload.toString('base64url')}.${crypto.sign(null, payload, privateKey).toString('base64url')}`
            },
            server = new WebSocketServer({host: '127.0.0.1', port: 0});

        Bridge.agents          = new Map();
        Bridge.agentSockets    = new Map();
        Bridge.apps            = new Map();
        Bridge.bridgePublicKey = publicKey;

        server.on('connection', (socket, request) => Bridge.handleConnection(socket, request));
        await once(server, 'listening');
        localBridgeServers.add(server);

        return {port: server.address().port, server, signToken}
    }

    test('when a keyed Bridge restarts after the initial NEO_FLEET_BRIDGE_TOKEN has expired, ConnectionService refreshes its token, clears stale sessionData/activeAgents, and automatically reconnects (#1215)', async () => {
        const
            keyed        = await startKeyedBridge(),
            initialToken = keyed.signToken('neo-opus-vega', Date.now() + 80),
            renewedToken = keyed.signToken('neo-opus-vega', Date.now() + 60_000),
            refreshCalls = [];

        process.env.NEO_FLEET_BRIDGE_TOKEN = initialToken;
        ConnectionService.reconnectDelayMs = 20;
        ConnectionService.createBridgeUrl  = ({
            agentId = ConnectionService.agentId,
            token   = ConnectionService.bridgeToken || process.env.NEO_FLEET_BRIDGE_TOKEN
        } = {}) => originalCreateBridgeUrl.call(ConnectionService, {agentId, port: keyed.port, token});
        ConnectionService.refreshEnvFn     = async () => {
            refreshCalls.push('refresh');
            return {NEO_FLEET_BRIDGE_TOKEN: renewedToken}
        };

        await ConnectionService.ensureBridgeAndConnect();
        expect(Bridge.agents.has('neo-opus-vega')).toBe(true);

        ConnectionService.handleAppConnected('app-stale', 'Portal');
        ConnectionService.handleAgentConnected('peer-stale');
        expect(ConnectionService.sessionData.has('app-stale')).toBe(true);
        expect(ConnectionService.activeAgents.has('peer-stale')).toBe(true);

        // Wait for initialToken (> 80 ms) to expire, then simulate a Bridge restart dropping all sockets.
        await new Promise(resolve => setTimeout(resolve, 110));
        const closed = new Promise(resolve => ConnectionService.bridgeSocket.once('close', resolve));
        keyed.server.clients.forEach(socket => socket.terminate());
        Bridge.agents.clear();
        Bridge.agentSockets.clear();
        await closed;

        expect(ConnectionService.sessionData.size).toBe(0);
        expect(ConnectionService.activeAgents.size).toBe(0);

        await expect.poll(() => Bridge.agents.has('neo-opus-vega'), {timeout: 2000}).toBe(true);
        expect(ConnectionService.getStatus().bridgeConnected).toBe(true);
        expect(ConnectionService.bridgeToken).toBe(renewedToken);
        expect(process.env.NEO_FLEET_BRIDGE_TOKEN).toBe(renewedToken);
        expect(refreshCalls.length).toBeGreaterThanOrEqual(1)
    });

    test('manageConnection start after token expiry refreshes NEO_FLEET_BRIDGE_TOKEN and connects; stop suppresses auto-reconnect until start is called again (#1215)', async () => {
        const
            keyed        = await startKeyedBridge(),
            expiredToken = keyed.signToken('neo-opus-vega', Date.now() - 1_000),
            renewedToken = keyed.signToken('neo-opus-vega', Date.now() + 60_000);
        let refreshes = 0;

        process.env.NEO_FLEET_BRIDGE_TOKEN = expiredToken;
        ConnectionService.reconnectDelayMs = 20;
        ConnectionService.createBridgeUrl  = ({
            agentId = ConnectionService.agentId,
            token   = ConnectionService.bridgeToken || process.env.NEO_FLEET_BRIDGE_TOKEN
        } = {}) => originalCreateBridgeUrl.call(ConnectionService, {agentId, port: keyed.port, token});
        ConnectionService.refreshEnvFn     = async () => {
            refreshes++;
            return {NEO_FLEET_BRIDGE_TOKEN: renewedToken}
        };

        await expect(ConnectionService.manageConnection({action: 'start'})).resolves.toEqual({
            message: 'Neural Link Bridge started and connected successfully.'
        });
        expect(refreshes).toBe(1);
        expect(ConnectionService.bridgeToken).toBe(renewedToken);
        expect(Bridge.agents.has('neo-opus-vega')).toBe(true);

        ConnectionService.handleAppConnected('app-1', 'Portal');
        ConnectionService.handleAgentConnected('peer-1');

        await ConnectionService.manageConnection({action: 'stop'});
        expect(ConnectionService.manualDisconnect).toBe(true);
        expect(ConnectionService.reconnectTimer).toBeNull();
        expect(ConnectionService.sessionData.size).toBe(0);
        expect(ConnectionService.activeAgents.size).toBe(0);

        await new Promise(resolve => setTimeout(resolve, 60));
        expect(ConnectionService.getStatus().bridgeConnected).toBe(false);
        expect(ConnectionService.reconnectTimer).toBeNull();

        await expect(ConnectionService.manageConnection({action: 'start'})).resolves.toEqual({
            message: 'Neural Link Bridge started and connected successfully.'
        });
        expect(ConnectionService.manualDisconnect).toBe(false);
        expect(ConnectionService.getStatus().bridgeConnected).toBe(true)
    });

    test('when connectToBridge is rejected with 1008 or when NEO_FLEET_BRIDGE_TOKEN is present, ensureBridgeAndConnect never spawns an unkeyed Bridge (#1215)', async () => {
        const
            keyed        = await startKeyedBridge(),
            expiredToken = keyed.signToken('neo-opus-vega', Date.now() - 1_000);
        let spawned = 0;

        ConnectionService.spawnBridge        = async () => { spawned++ };
        ConnectionService.spawnBridgeProcess = () => { spawned++ };
        ConnectionService.refreshEnvFn       = async () => null;
        ConnectionService.createBridgeUrl    = ({
            agentId = ConnectionService.agentId,
            token   = ConnectionService.bridgeToken || process.env.NEO_FLEET_BRIDGE_TOKEN
        } = {}) => originalCreateBridgeUrl.call(ConnectionService, {agentId, port: keyed.port, token});

        // 1. Keyed Bridge rejects with 1008 (expired token, no refresh available) -> never spawns Bridge
        process.env.NEO_FLEET_BRIDGE_TOKEN = expiredToken;
        await expect(ConnectionService.ensureBridgeAndConnect()).rejects.toMatchObject({
            authenticationFailed: true,
            closeCode           : 1008
        });
        expect(spawned).toBe(0);

        // 2. Fleet-token-managed seat receives ECONNREFUSED while Bridge is restarting -> never spawns unkeyed Bridge
        ConnectionService.connectToBridge = async () => {
            throw new Error('connect ECONNREFUSED 127.0.0.1:8081')
        };
        await expect(ConnectionService.ensureBridgeAndConnect()).rejects.toThrow('ECONNREFUSED');
        expect(spawned).toBe(0)
    });

    /** @summary Allocates an available loopback TCP port and releases the probe listener immediately. */
    async function getFreeLoopbackPort() {
        const probe = net.createServer();

        probe.listen(0, '127.0.0.1');
        await once(probe, 'listening');

        const {port} = probe.address();

        await new Promise(resolve => probe.close(resolve));
        return port
    }

    test('manageConnection stop terminates a detached npm-spawned Bridge process group, waits until the Bridge port closes, and rejects if the port remains open (#1302)', async () => {
        const
            root    = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-stop-spawned-bridge-')),
            pidFile = path.join(root, 'bridge-child.pid'),
            port    = await getFreeLoopbackPort();

        // Reproduce the exact detached `npm run ai:server-neural-link` -> `node bridge.mjs` hierarchy:
        // `npm` is the detached process-group leader (`ConnectionService.bridgeProcess.pid`), while the
        // actual TCP listener lives in its child `node` process (`bridgePid !== bridgeProcess.pid`).
        fs.writeFileSync(path.join(root, 'bridge.mjs'), [
            "import fs from 'node:fs';",
            "import net from 'node:net';",
            'const port = Number(process.env.NEO_NL_PORT);',
            'const server = net.createServer();',
            "server.listen(port, '127.0.0.1', () => {",
            `    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
            '});',
            "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
            "process.on('SIGINT',  () => server.close(() => process.exit(0)));"
        ].join('\n'));
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
            name   : 'nl-spawned-bridge-fixture',
            private: true,
            type   : 'module',
            scripts: {
                [BRIDGE_NPM_SCRIPT]: 'node ./bridge.mjs'
            }
        }));

        ConnectionService.cwd = root;

        let bridgePid = null;

        try {
            await ConnectionService.spawnBridge({logPath: root, port, startupDelayMs: 50});

            await expect.poll(
                () => ConnectionService.isBridgePortListening({port}),
                {timeout: 5000}
            ).toBe(true);

            bridgePid = Number(fs.readFileSync(pidFile, 'utf8').trim());
            expect(Number.isInteger(bridgePid) && bridgePid > 0).toBe(true);
            expect(bridgePid, 'listener runs in the child of `npm`, not the `npm` wrapper PID itself')
                .not.toBe(ConnectionService.bridgeProcess.pid);

            const stopReply = await ConnectionService.manageConnection({action: 'stop'});

            expect(stopReply).toEqual({message: 'Neural Link Bridge stopped.'});
            expect(ConnectionService.bridgeProcess).toBeNull();
            expect(await ConnectionService.isBridgePortListening({port})).toBe(false);
            expect(() => process.kill(bridgePid, 0)).toThrow();

            // Non-vacuity / truthfulness guard: if a port remains open after stop attempts complete,
            // `manageConnection({action: 'stop'})` must reject instead of claiming the Bridge stopped.
            const stuckServer = net.createServer();
            stuckServer.listen(0, '127.0.0.1');
            await once(stuckServer, 'listening');
            const stuckPort = stuckServer.address().port;

            try {
                ConnectionService.bridgeProcess     = {kill() {}};
                ConnectionService.spawnedBridgePort = stuckPort;
                ConnectionService.stopBridgeProcess = originalStopBridgeProcess.bind(ConnectionService);

                await expect(
                    ConnectionService.stopBridgeProcess(ConnectionService.bridgeProcess, {
                        pollIntervalMs: 20,
                        port          : stuckPort,
                        sigkillAfterMs: 40,
                        timeoutMs     : 100
                    })
                ).rejects.toThrow(`Failed to stop Neural Link Bridge: port ${stuckPort} is still listening.`);
            } finally {
                await new Promise(resolve => stuckServer.close(resolve))
            }
        } finally {
            if (bridgePid) {
                try { process.kill(bridgePid, 'SIGKILL') } catch {}
            }
            if (ConnectionService.bridgeProcess?.pid) {
                try { process.kill(-ConnectionService.bridgeProcess.pid, 'SIGKILL') } catch {}
            }
            fs.rmSync(root, {force: true, recursive: true})
        }
    });

    test('manageConnection stop never stops an already-running external Bridge that this server did not spawn (#1302)', async () => {
        const
            externalBridge = await startLocalBridge(),
            externalPort   = externalBridge.server.address().port;

        ConnectionService.createBridgeUrl = () => externalBridge.url;

        await ConnectionService.ensureBridgeAndConnect();

        expect(ConnectionService.getStatus().bridgeConnected).toBe(true);
        expect(ConnectionService.bridgeProcess, 'external Bridge was found running, not spawned here').toBeNull();
        expect(await ConnectionService.isBridgePortListening({port: externalPort})).toBe(true);

        const reply = await ConnectionService.manageConnection({action: 'stop'});

        expect(reply).toEqual({
            message: 'Disconnected. Bridge process was not managed by this session (not killed).'
        });
        expect(ConnectionService.getStatus().bridgeConnected).toBe(false);
        expect(
            await ConnectionService.isBridgePortListening({port: externalPort}),
            'external Bridge must remain listening after client disconnect'
        ).toBe(true);
    });

    test('run-bridge.mjs shuts down cleanly and releases its port on SIGTERM (#1302)', async () => {
        const
            runBridgePath = fileURLToPath(new URL('../../../../../../ai/mcp/server/neural-link/run-bridge.mjs', import.meta.url)),
            logDir        = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-run-bridge-sigterm-')),
            port          = await getFreeLoopbackPort(),
            child         = spawn(process.execPath, [runBridgePath], {
                env: {
                    ...process.env,
                    NEO_NL_LOG_PATH: logDir,
                    NEO_NL_PORT    : String(port),
                    UNIT_TEST_MODE : 'true'
                },
                stdio: ['ignore', 'pipe', 'pipe']
            });

        try {
            await expect.poll(
                () => ConnectionService.isBridgePortListening({port}),
                {timeout: 8000}
            ).toBe(true);

            const exitPromise = once(child, 'exit');

            child.kill('SIGTERM');

            const [code] = await exitPromise;

            expect(code).toBe(0);
            expect(await ConnectionService.isBridgePortListening({port})).toBe(false);
        } finally {
            try { child.kill('SIGKILL') } catch {}
            fs.rmSync(logDir, {force: true, recursive: true})
        }
    });
});

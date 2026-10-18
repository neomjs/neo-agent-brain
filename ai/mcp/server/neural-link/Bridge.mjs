import {WebSocketServer}                                      from 'ws';
import crypto                                                 from 'crypto';
import Base                                                   from 'neo.mjs/src/core/Base.mjs';
import logger                                                 from './logger.mjs';
import {createBridgeInfoPayload, createBridgeVerifierPayload} from './BridgeProtocol.mjs';
import {verifyBridgeToken}                                    from './verifyBridgeToken.mjs';

/**
 * @summary The central WebSocket Hub (Bridge) for Neural Link.
 *
 * This standalone service runs as a background process and acts as a message broker between:
 * 1.  **Apps (Browsers):** Running Neo.mjs applications (App Workers).
 * 2.  **Agents (MCP Servers):** AI Agents that want to inspect/control the apps.
 *
 * It listens on a single WebSocket port (default 8081). Clients identify their role via the
 * `role` query parameter ('app' or 'agent').
 *
 * **Routing Logic:**
 * - **App -> Agents:** Messages from an App are broadcast to ALL connected Agents.
 * - **Agent -> App:** Agents must wrap their message in a routing envelope:
 *   `{ target: 'appWorkerId', message: { ...jsonrpc... } }`
 *
 * @class Neo.ai.mcp.server.neural-link.Bridge
 * @extends Neo.core.Base
 * @singleton
 */
class Bridge extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.mcp.server.neural-link.Bridge'
         * @protected
         */
        className: 'Neo.ai.mcp.server.neural-link.Bridge',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * Active Agent sessions (MCP Servers) mapped to their newest open WebSocket.
     * Map<agentId, WebSocket>
     */
    agents = new Map()
    /**
     * All currently open WebSockets per Agent identity, in registration order.
     * Map<agentId, Set<WebSocket>>
     */
    agentSockets = new Map()
    /**
     * Active App sessions (Browsers).
     * Map<appWorkerId, WebSocket>
     */
    apps = new Map()
    /**
     * What each connected App announced about itself: its last `register` message and one `window_connected`
     * message per open window. An App sends both once per socket open, so an Agent that joins later learns them
     * only from this replay. Logs and events are history, not state, and are never kept.
     * `addressed` is who drove the App: the first and the last Agent with a timestamp, and each Agent's count.
     * The Bridge is the one party that sees every Agent → App message, so peers sharing an App instance learn
     * whose scene they are joining; access itself stays shared by design.
     * Map<appWorkerId, {register: Object|null, windows: Map<windowId, Object>, addressed: Object|null}>
     */
    appState = new Map()
    /**
     * WebSocket Server instance.
     */
    wss = null

    /**
     * @summary Returns true when a WebSocket is still live (CONNECTING or OPEN, readyState <= 1).
     * @param {WebSocket|Object|null} ws
     * @returns {Boolean}
     */
    #isSocketLive(ws) {
        return Boolean(ws) && typeof ws.readyState === 'number' && ws.readyState <= 1;
    }

    /**
     * @summary Returns the live socket set for `id` from `this.agentSockets`, pruning closed entries.
     * @param {String} id
     * @returns {Set<WebSocket>}
     */
    #getAgentSocketSet(id) {
        let sockets = this.agentSockets.get(id);

        if (!sockets) {
            sockets = new Set();
            this.agentSockets.set(id, sockets);
        }

        for (const candidate of sockets) {
            if (!this.#isSocketLive(candidate)) {
                sockets.delete(candidate);
            }
        }

        return sockets;
    }

    /**
     * @summary Completes class initialization without claiming a network listener.
     * Network binding belongs to the standalone entrypoint so it can
     * finish config freshness checks and optional overlay loading before starting the Bridge.
     * @returns {Promise<void>}
     */
    async initAsync() {
        await super.initAsync()
    }

    /**
     * @summary Starts the WebSocket server on the entrypoint-supplied loopback host and port.
     * @param {Object} options
     * @param {String} options.host Entrypoint-supplied literal loopback host.
     * @param {Number} options.port Entrypoint-supplied Bridge listener port.
     * @returns {Promise<void>}
     */
    async startServer({host, port} = {}) {
        if (host !== '127.0.0.1' && host !== '::1') {
            throw new TypeError('Bridge.startServer() requires a literal loopback host.')
        }

        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new TypeError('Bridge.startServer() requires an integer TCP port in the range 1..65535.')
        }

        if (this.wss) {
            logger.warn('Bridge: WebSocket Server is already running.');
            return;
        }

        return new Promise((resolve, reject) => {
            const wss = new WebSocketServer({host, port});

            wss.on('listening', () => {
                logger.info(`Bridge: Listening on ${host}:${port}`);
                this.wss = wss;

                wss.on('connection', (ws, req) => this.handleConnection(ws, req));
                wss.on('error',      (err)     => logger.error('Bridge: Server Error:', err));

                resolve();
            });

            wss.on('error', (err) => {
                logger.error('Bridge: Startup Error:', err);
                reject(err);
            });
        });
    }

    /**
     * Stops the server.
     */
    async stopServer() {
        if (!this.wss) return;

        logger.info('Bridge: Stopping server...');

        this.agentSockets.forEach(sockets => sockets.forEach(ws => ws.terminate()));
        this.agents.forEach(ws => ws.terminate());
        this.apps.forEach(ws => ws.terminate());

        this.agentSockets.clear();
        this.agents.clear();
        this.apps.clear();
        this.appState.clear();

        return new Promise((resolve) => {
            this.wss.close(() => {
                logger.info('Bridge: Stopped.');
                this.wss = null;
                resolve();
            });
        });
    }

    /**
     * Lazily-resolved Ed25519 **public** verify key from `NEO_FLEET_BRIDGE_PUBLIC_KEY` (a trusted,
     * harness/operator-set SPKI PEM — never agent-supplied). `undefined` = not yet resolved, `null` =
     * no key configured (legacy unauthenticated dev mode), else the `crypto.KeyObject`.
     * @member {Object|null} bridgePublicKey
     * @protected
     */
    bridgePublicKey = undefined

    /**
     * @summary Resolve (once, cached) the Bridge's token-verify public key, or null when unset.
     * @returns {Object|null}
     * @protected
     */
    getBridgePublicKey() {
        if (this.bridgePublicKey === undefined) {
            const pem = process.env.NEO_FLEET_BRIDGE_PUBLIC_KEY;
            this.bridgePublicKey = pem ? crypto.createPublicKey(pem) : null;
        }
        return this.bridgePublicKey;
    }

    /**
     * @summary Verify a presented signed Bridge token; return the **signed** agentId or null.
     *
     * Thin wrapper over the pure {@link verifyBridgeToken} (kept Bridge-free so the security gate is
     * unit-testable without the WebSocket singleton — mirrors `src/ai/parseAgentEnvelope.mjs`). The
     * returned identity is the FM-signed `agentId`, trusted from the signature, never the `?id=` claim.
     * @param {String} token `<base64url(payload)>.<base64url(signature)>`.
     * @returns {String|null}
     * @protected
     */
    verifyAgentToken(token) {
        return verifyBridgeToken(token, this.getBridgePublicKey());
    }

    /**
     * Handles new connections.
     * @param {WebSocket} ws
     * @param {IncomingMessage} req
     */
    handleConnection(ws, req) {
        try {
            const url     = new URL(req.url, `http://${req.headers.host}`);
            const role    = url.searchParams.get('role'); // 'app' or 'agent'
            const id      = url.searchParams.get('id') || url.searchParams.get('appWorkerId'); // Support legacy param
            const appName = url.searchParams.get('appName');
            const token   = url.searchParams.get('token');

            if (role === 'verifier') {
                // Deliberately id-less: an older Bridge refuses this before its registration paths.
                if (url.pathname !== '/' || url.searchParams.size !== 1) {
                    ws.close(1008, 'Verifier request must contain only its role');
                    return;
                }
                const key = this.getBridgePublicKey();
                if (key && key.asymmetricKeyType !== 'ed25519') {
                    ws.close(1011, 'Unsupported verifier key');
                    return;
                }
                const fingerprint = key ? crypto.createHash('sha256')
                    .update(key.export({type: 'spki', format: 'der'})).digest('hex') : null;
                ws.send(JSON.stringify(createBridgeVerifierPayload(fingerprint)));
                ws.close(1000, 'Verifier response complete');
                return;
            }

            if (!id) {
                logger.warn('Bridge: Connection rejected. No ID provided.');
                ws.close(1008, 'ID required');
                return;
            }

            if (role === 'agent' || role === 'test') {
                // Authenticate the agent when a verify key is provisioned (fleet mode): the identity
                // is the agentId SIGNED into the token, never the untrusted `?id=` query claim (the
                // spoofing hole this closes). Both roles enter the same agent map and require the
                // same proof. With no key configured (no-FM dev), fall back to the
                // legacy unauthenticated path — auth and multi-writer enforcement are a matched pair.
                if (this.getBridgePublicKey()) {
                    const verifiedId = this.verifyAgentToken(token);
                    if (!verifiedId) {
                        logger.warn('Bridge: Agent connection rejected — invalid or missing token.');
                        ws.close(1008, 'Authentication required');
                        return;
                    }
                    this.registerAgent(verifiedId, ws);
                } else {
                    this.registerAgent(id, ws);
                }
            } else {
                // Default to app if no role specified (backward compatibility)
                this.registerApp(id, ws, appName);
            }

        } catch (err) {
            logger.error('Bridge: Connection error:', err);
            ws.close(1011, 'Internal Error');
        }
    }

    /**
     * @summary Registers an Agent connection; all live connections under an id remain routable and receive broadcasts,
     * while `this.agents.get(id)` tracks the newest live connection. The per-id `Set` in `this.agentSockets` preserves
     * insertion order, which defines "most recent". Closing any connection promotes the most recent remaining open
     * connection under that id and announces `agent_disconnected` to Agents only when the last open connection for
     * that id closes. Apps still hear every connection's close, keyed by its `sessionId`.
     * @param {String} id
     * @param {WebSocket} ws
     */
    registerAgent(id, ws) {
        logger.info(`Bridge: Agent connected [${id}]`);

        const sockets = this.#getAgentSocketSet(id);
        sockets.delete(ws);
        sockets.add(ws);
        this.agents.set(id, ws);

        // A stable, Bridge-authoritative per-connection id (minted here, lives for the connection's
        // lifetime) stamped into the agent_message sidecar + the disconnect notice, so the app-side
        // write-guard can key locks on the (agentId, sessionId) pair.
        ws.sessionId = crypto.randomUUID();

        ws.on('message', (data)         => this.handleAgentMessage(id, data, ws));
        ws.on('close',   (code, reason) => {
            const reasonText = reason?.toString() || 'none';
            logger.info(`Bridge: Agent disconnected [${id}] (code=${code ?? 'none'}, reason=${reasonText})`);

            const activeSet = this.agentSockets.get(id);
            activeSet?.delete(ws);

            const remaining = activeSet
                ? [...activeSet].filter(candidate => candidate !== ws && this.#isSocketLive(candidate))
                : [];
            const nextActive = remaining.at(-1) || null;

            if (nextActive) {
                this.agents.set(id, nextActive);
            } else {
                this.agentSockets.delete(id);
                if (this.agents.get(id) === ws) {
                    this.agents.delete(id);
                    this.broadcastToAgents({
                        type   : 'agent_disconnected',
                        agentId: id
                    });
                }
            }

            // Lets the app-side write-guard release locks held by the now-dead writer; idempotent so a
            // blanket app broadcast is safe.
            this.broadcastToApps({
                type     : 'agent_disconnected',
                agentId  : id,
                sessionId: ws.sessionId
            });
        });
        ws.on('error', (err) => logger.error(`Bridge: Agent error [${id}]`, err));

        this.sendBridgeInfo(ws);

        // Notify other agents
        this.broadcastToAgents({
            type   : 'agent_connected',
            agentId: id
        });

        // Notify the new Agent of all already-connected apps, each followed by what it announced before this Agent
        // joined: without its registration and windows, the Agent sees the app connected but cannot reach it
        for (const [appWorkerId, appWs] of this.apps.entries()) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type     : 'app_connected',
                    appWorkerId,
                    appName  : appWs.appName || 'Unknown',
                    addressed: this.addressedOf(appWorkerId)
                }));

                for (const message of this.replayOf(appWorkerId)) {
                    ws.send(JSON.stringify({type: 'app_message', appWorkerId, message}))
                }
            }
        }
    }

    /**
     * @summary The messages that bring an Agent joining now up to date on one App: its last registration, then
     * one `window_connected` per open window.
     * @param {String} appWorkerId
     * @returns {Object[]}
     * @protected
     */
    replayOf(appWorkerId) {
        const state = this.appState.get(appWorkerId);

        return state ? [...(state.register ? [state.register] : []), ...state.windows.values()] : []
    }

    /**
     * @summary Records that an Agent addressed an App, for the peers who share it.
     * The first addresser is the closest the Bridge comes to "who opened it": a page a seat's browser opened
     * announces no seat, and the Agent that drives it first usually is that seat.
     * @param {String} appWorkerId
     * @param {String} agentId
     * @param {Number} [at=Date.now()]
     * @returns {Object|null} `{agentId, at, first}`, or null for an App the Bridge does not hold
     * @protected
     */
    rememberAddressed(appWorkerId, agentId, at = Date.now()) {
        const state = this.appState.get(appWorkerId);

        if (!state) return null;

        const stamp = {agentId, at},
              first = !state.addressed;

        state.addressed ??= {first: stamp, last: stamp, agents: new Map()};
        state.addressed.last = stamp;

        const entry = state.addressed.agents.get(agentId) ?? {count: 0, lastAt: at};

        entry.count++;
        entry.lastAt = at;
        state.addressed.agents.set(agentId, entry);

        return {agentId, at, first}
    }

    /**
     * @summary A plain snapshot of who addressed an App, as `app_connected` carries it to an Agent joining later.
     * @param {String} appWorkerId
     * @returns {Object|null} `{first, last, agents: [{agentId, count, lastAt}]}`, or null while nobody addressed it
     * @protected
     */
    addressedOf(appWorkerId) {
        const addressed = this.appState.get(appWorkerId)?.addressed;

        return addressed ? {
            first : addressed.first,
            last  : addressed.last,
            agents: [...addressed.agents].map(([agentId, {count, lastAt}]) => ({agentId, count, lastAt}))
        } : null
    }

    /**
     * @summary Keeps what an App announces about itself, for Agents that join later.
     * A `register` replaces the previous one; `window_connected` and `window_disconnected` maintain the open
     * windows by `windowId`. Every other message is history and only passes through.
     * @param {String} appId
     * @param {Object} message A JSON-RPC message from the App
     * @protected
     */
    rememberAppState(appId, message) {
        const state    = this.appState.get(appId),
              windowId = message?.params?.windowId;

        if (!state) return;

        if (message.method === 'register') {
            state.register = message
        } else if (message.method === 'window_connected' && windowId) {
            state.windows.set(windowId, message)
        } else if (message.method === 'window_disconnected' && windowId) {
            state.windows.delete(windowId)
        }
    }

    /**
     * @summary Sends the freshness/protocol stamp expected by current agent clients.
     * @param {WebSocket} ws
     */
    sendBridgeInfo(ws) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(createBridgeInfoPayload()))
        }
    }

    /**
     * @param {String} id
     * @param {WebSocket} ws
     * @param {String} [appName='Unknown']
     */
    registerApp(id, ws, appName='Unknown') {
        logger.info(`Bridge: App connected [${id}] (${appName})`);

        // Handle reconnects: Close old socket if exists
        if (this.apps.has(id)) {
            logger.warn(`Bridge: Closing stale connection for App [${id}]`);
            this.apps.get(id).terminate();
        }

        ws.appName = appName;
        this.apps.set(id, ws);
        // A new socket announces itself anew: nothing the replaced one said carries over
        this.appState.set(id, {register: null, windows: new Map(), addressed: null});

        // Only the socket registered under an id speaks for that App. A socket replaced by a reconnect can still
        // deliver a message or its close after its successor registered: neither may overwrite or evict the successor
        ws.on('message', (data)         => this.apps.get(id) === ws && this.handleAppMessage(id, data));
        ws.on('close',   (code, reason) => {
            if (this.apps.get(id) !== ws) return;

            const reasonText = reason?.toString() || 'none';
            logger.info(`Bridge: App disconnected [${id}] (${appName}) (code=${code ?? 'none'}, reason=${reasonText})`);
            this.apps.delete(id);
            this.appState.delete(id);
            this.broadcastToAgents({
                type       : 'app_disconnected',
                appWorkerId: id
            });
        });
        ws.on('error', (err) => logger.error(`Bridge: App error [${id}]`, err));

        // Notify agents of new app
        this.broadcastToAgents({
            type       : 'app_connected',
            appWorkerId: id,
            appName,
            addressed  : null
        });
    }

    /**
     * Handles message from an Agent.
     * Expects: { target: 'appWorkerId', message: { ... } }
     * @param {String} agentId
     * @param {Buffer} data
     * @param {WebSocket} [senderWs=null]
     */
    handleAgentMessage(agentId, data, senderWs = null) {
        try {
            const payload = JSON.parse(data.toString());

            if (!payload.target || !payload.message) {
                logger.warn(`Bridge: Invalid message format from Agent [${agentId}]`);
                return;
            }

            const agentWs = senderWs || this.agents.get(agentId);
            const appWs   = this.apps.get(payload.target);

            if (appWs) {
                // Forward, wrapping the message in the Bridge-stamped sidecar (the app-side Client unwraps it)
                appWs.send(JSON.stringify({
                    type     : 'agent_message',
                    agentId,
                    sessionId: agentWs?.sessionId,
                    message  : payload.message
                }));

                // Every Agent, the sender included, learns who is in this App now
                const addressed = this.rememberAddressed(payload.target, agentId);

                addressed && this.broadcastToAgents({type: 'app_addressed', appWorkerId: payload.target, ...addressed});
            } else {
                logger.warn(`Bridge: Target App [${payload.target}] not found for Agent [${agentId}]`);

                // If the message is a request (has an id), send an immediate error response
                if (agentWs && payload.message?.id) {
                    agentWs.send(JSON.stringify({
                        type       : 'app_message',
                        appWorkerId: payload.target,
                        message    : {
                            id   : payload.message.id,
                            error: {
                                code   : -32000,
                                message: `Target App [${payload.target}] not found`
                            }
                        }
                    }));
                }
            }

        } catch (err) {
            logger.error(`Bridge: Error handling Agent message [${agentId}]`, err);
        }
    }

    /**
     * Handles message from an App.
     * Broadcasts to all Agents wrapped in an envelope.
     * @param {String} appId
     * @param {Buffer} data
     */
    handleAppMessage(appId, data) {
        try {
            // Validate it's JSON (App always sends JSON)
            const message = JSON.parse(data.toString());

            message && this.rememberAppState(appId, message);

            this.broadcastToAgents({
                type       : 'app_message',
                appWorkerId: appId,
                message    : message
            });

        } catch (err) {
            logger.error(`Bridge: Error handling App message [${appId}]`, err);
        }
    }

    /**
     * Sends a message to all connected Agent sockets across all active Agent identities.
     * @param {Object} payload
     */
    broadcastToAgents(payload) {
        const data = JSON.stringify(payload);

        for (const sockets of this.agentSockets.values()) {
            for (const ws of sockets) {
                if (this.#isSocketLive(ws)) {
                    ws.send(data);
                }
            }
        }
    }

    /**
     * Sends a message to all connected Apps.
     * @param {Object} payload
     */
    broadcastToApps(payload) {
        const data = JSON.stringify(payload);
        for (const ws of this.apps.values()) {
            ws.send(data);
        }
    }
}

export default Neo.setupClass(Bridge);

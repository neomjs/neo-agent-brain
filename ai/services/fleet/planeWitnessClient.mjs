/**
 * @module ai/services/fleet/planeWitnessClient
 * @summary The first run's client for the served plane's Memory Core — the three calls the `verify` effect
 * makes (`add_memory`, `query_recent_turns`, `query_raw_memories`) over the official MCP SDK's Streamable
 * HTTP transport with the run's consented plane credential as the bearer, each call bounded by a timeout.
 *
 * Deliberately not the Fleet server's `planeMailboxClient`: that client proves a boot-resolved viewer
 * identity on every session (the single-viewer invariant), while the first run holds no identity yet —
 * the credential IS the operator's, and the plane answers under whatever subject it validates. This client
 * proves nothing and replays nothing: an error envelope whose code is one the plane answers BEFORE accepting
 * a write ({@link PRE_ACCEPTANCE_REFUSAL_CODES}) throws with `refused: true` so the effect settles the attempt;
 * every other error — a transport failure, a timeout, the service's catch-all `MEMORY_ADD_ERROR` — throws
 * without it, and the effect treats it as ambiguous (a lost acknowledgement), never as a reason to write again.
 *
 * Same endpoint boundary as every plane client (`normalizeSecureMcpEndpoint`): http/https only, no
 * URL-embedded credentials, TLS off-loopback. Reads no config: `baseUrl` and `credential` arrive from the
 * run (the target endpoint and the consented file).
 */

import {Client}                        from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {PLANE_MEMORY_CORE_PATH, normalizeSecureMcpEndpoint, readMcpToolResultPayload} from './mcpWireParsing.mjs';

/**
 * One bounded call; the plane's own embed and WAL load decides the ceiling (measured 2026-08-02: initialize
 * ~17 s under load).
 * @type {Number}
 */
export const DEFAULT_CALL_TIMEOUT_MS = 60000;

/**
 * The error codes a Memory Core tool answers BEFORE accepting a write — the validation gate and the identity
 * gate. Only these settle a witness attempt as refused: `MEMORY_ADD_ERROR` is the service's catch-all for a
 * failure anywhere on the acceptance path (a WAL append whose close rejected after the bytes landed reaches it
 * too), so it is ambiguous by construction and the effect reconciles it through a positive read instead.
 * @type {Set<String>}
 */
export const PRE_ACCEPTANCE_REFUSAL_CODES = new Set(['MEMORY_VALIDATION_ERROR', 'MISSING_AGENT_IDENTITY', 'INVALID_PARAMETERS']);

/**
 * @summary The error a tool result flagged `isError` becomes. A code from {@link PRE_ACCEPTANCE_REFUSAL_CODES}
 * marks a refusal the plane answered before acceptance (`error.refused === true`); any other error envelope
 * is ambiguous — the plane failed somewhere on the way, and a row may or may not exist — so it carries the
 * code (`error.code`) and no `refused` flag.
 * @param {String} name
 * @param {Object} result
 * @returns {Error}
 */
export function toolError(name, result) {
    const
        envelope = result?.structuredContent && typeof result.structuredContent === 'object' ? result.structuredContent : null,
        text     = result?.content?.find?.(item => item?.type === 'text')?.text,
        code     = typeof envelope?.code === 'string' ? envelope.code : null,
        message  = envelope?.message ?? envelope?.error ?? (typeof text === 'string' && text.trim() ? text.trim().slice(0, 300) : 'the tool answered isError without a message'),
        refused  = code !== null && PRE_ACCEPTANCE_REFUSAL_CODES.has(code),
        error    = new Error(`plane ${name} ${refused ? 'refused' : 'failed'}${code ? ` (${code})` : ''}: ${message}`);

    if (refused) {
        error.refused = true;
    }

    if (code) {
        error.code = code;
    }

    return error;
}

/**
 * @summary Creates the client. Nothing leaves before the first call; every call connects a session once
 * and reuses it; `close()` terminates it.
 * @param {Object} options
 * @param {String}   options.endpoint The plane endpoint (`http://127.0.0.1:3102`); the Memory Core route is composed below it.
 * @param {String}   [options.credential] The consented plane credential; empty omits the Authorization header.
 * @param {Number}   [options.timeoutMs=DEFAULT_CALL_TIMEOUT_MS]
 * @param {Function} [options.createSession] Test seam: `() => {client, transport}` with SDK-compatible shapes.
 * @returns {{addMemory: Function, recentTurns: Function, recall: Function, close: Function}}
 */
export function createPlaneWitnessClient({endpoint, credential = '', timeoutMs = DEFAULT_CALL_TIMEOUT_MS, createSession = null}) {
    const baseUrl = normalizeSecureMcpEndpoint(`${String(endpoint).replace(/\/+$/, '')}${PLANE_MEMORY_CORE_PATH}`);

    if (!baseUrl) {
        throw new Error('planeWitnessClient refused the endpoint: http/https only, no URL-embedded credentials, and TLS is required for non-loopback hosts.');
    }

    const buildSession = createSession || (() => ({
        transport: new StreamableHTTPClientTransport(new URL(baseUrl), {requestInit: {headers: credential ? {Authorization: `Bearer ${credential}`} : {}}}),
        client   : new Client({name: 'neo-first-run-witness', version: '1'}, {capabilities: {}})
    }));

    let session = null;

    const bounded = (promise, label) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`plane ${label} timed out after ${timeoutMs} ms`)), timeoutMs);

        promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) });
    });

    async function callTool(name, args) {
        if (!session) {
            const candidate = buildSession();

            await bounded(candidate.client.connect(candidate.transport), 'connect');
            session = candidate;
        }

        const result = await bounded(session.client.callTool({name, arguments: args}), name);

        if (result?.isError) {
            throw toolError(name, result);
        }

        const payload = readMcpToolResultPayload(result);

        if (payload === null) {
            throw new Error(`plane ${name} answered a malformed payload`);
        }

        return payload;
    }

    return {
        /**
         * @param {{prompt: String, thought: String, response: String}} content
         * @returns {Promise<{id: String, sessionId: String, timestamp: String, visibility: Object}>} what the plane answered.
         */
        addMemory: content => callTool('add_memory', {...content, toolsUsed: ['first-run-verify'], amountToolCalls: 0}),
        /**
         * @param {{limit: Number}} options
         * @returns {Promise<{count: Number, turns: Object[], nextCursor: Object|null}>}
         */
        recentTurns: ({limit}) => callTool('query_recent_turns', {agentIdentity: '@me', detail: 'full', limit}),
        /**
         * @param {{query: String, limit: Number}} options
         * @returns {Promise<{count: Number, results: Object[]}>}
         */
        recall: ({query, limit}) => callTool('query_raw_memories', {query, nResults: limit}),
        async close() {
            const candidate = session;

            session = null;

            if (!candidate) return;

            try { await candidate.transport?.terminateSession?.() } catch { /* reaped or unreachable */ }
            try { await candidate.client?.close?.() }               catch { /* already closed */ }
        }
    };
}

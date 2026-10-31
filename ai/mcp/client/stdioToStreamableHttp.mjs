#!/usr/bin/env node

import {StreamableHTTPClientTransport}     from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StdioServerTransport}              from '@modelcontextprotocol/sdk/server/stdio.js';
import {ErrorCode, InitializeResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {Command}                           from 'commander';
import {isDeepStrictEqual}                 from 'node:util';
import {isEntryModule}                     from '../../services/shared/isEntryModule.mjs';

const
    RECOVERED_MESSAGE       = 'Neo MCP bridge kept its session after a transport error.',
    RENEWING_MESSAGE        = 'Neo MCP bridge is renewing its remote session.',
    REQUEST_FAILURE_MESSAGE = 'Neo MCP bridge could not deliver the request.',
    RESUMING_MESSAGE        = 'Neo MCP bridge is resuming its remote session.',
    RUNTIME_FAILURE_MESSAGE = 'Neo MCP bridge transport failed.',
    SESSION_ENDING_CODES    = new Set([-1, 401, 403]),
    STARTUP_FAILURE_MESSAGE = 'Neo MCP bridge failed to start.';

/**
 * @summary Mark one fixed, locally-authored bridge configuration diagnostic as safe for stderr.
 */
class BridgeConfigurationError extends Error {
    /**
     * @summary Create a trusted configuration failure before transport startup.
     * @param {String} message Fixed local diagnostic without raw endpoint or bearer material.
     */
    constructor(message) {
        super(message);

        this.name = 'BridgeConfigurationError'
    }
}

/** @summary Refuse a replacement handshake that changes the local client's negotiated contract. */
class BridgeProtocolError extends Error {}

/**
 * @summary Build the fail-loud CLI grammar for Neo's deliberately narrow local bridge.
 * The bearer value is read from an inherited environment slot and never accepted on argv.
 * @returns {Command}
 */
export function createProgram() {
    return new Command()
        .name('neo-mcp-stdio-to-streamable-http')
        .description('Bridge one local stdio MCP client to one Streamable HTTP endpoint.')
        .requiredOption('--url <url>', 'Streamable HTTP MCP endpoint')
        .requiredOption('--token-env <name>', 'Inherited environment variable holding the bearer token')
}

/**
 * @summary Parse and validate the public, non-secret bridge arguments.
 * @param {String[]} argv Argument vector without the Node executable or script path.
 * @returns {{endpoint: URL, tokenEnv: String}}
 */
export function parseArgs(argv) {
    const program = createProgram()
        .configureOutput({writeErr: () => {}})
        .exitOverride();

    program.parse(argv, {from: 'user'});

    const
        {url, tokenEnv} = program.opts();
    let endpoint;

    try {
        endpoint = new URL(url)
    } catch {
        throw new BridgeConfigurationError('Bridge endpoint must be a valid URL.')
    }

    if (!['http:', 'https:'].includes(endpoint.protocol)) {
        throw new BridgeConfigurationError("Bridge endpoint protocol must be 'http:' or 'https:'.")
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
        throw new BridgeConfigurationError(
            'Bridge token environment slot must be a valid environment variable name.'
        )
    }

    return {endpoint, tokenEnv}
}

/**
 * @summary Select the only startup detail permitted to cross the executable stderr boundary.
 * @param {*} error Startup rejection.
 * @returns {String}
 */
export function getStartupFailureMessage(error) {
    return error instanceof BridgeConfigurationError
        ? error.message
        : STARTUP_FAILURE_MESSAGE
}

/**
 * @summary Name a transport error with a fixed, locally-authored cause.
 * SDK and remote messages can carry endpoint or response text, so only this vocabulary crosses the
 * stderr boundary: the SDK's stream-recovery messages by prefix, then its HTTP status `code`.
 * @param {*} error
 * @returns {String}
 */
export function getBridgeErrorCause(error) {
    if (error instanceof BridgeProtocolError) return 'protocol-mismatch';
    const message = typeof error?.message === 'string' ? error.message : '';

    if (message.startsWith('SSE stream disconnected'))       return 'sse-disconnect';
    if (message.startsWith('Failed to reconnect'))           return 'sse-reconnect-failed';
    if (message.startsWith('Maximum reconnection attempts')) return 'sse-reconnect-exhausted';
    if (error?.code === -1)                                  return 'unexpected-content-type';
    if (Number.isInteger(error?.code) && error.code >= 100 && error.code <= 599) return `http-${error.code}`;
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'timeout';
    if (error instanceof TypeError)                          return 'network';

    return 'unknown'
}

/**
 * @summary Keep a local MCP connection while resuming, or else replacing, a lost remote HTTP session.
 * Lost requests receive an error with an unknown outcome and are never replayed. A retired session the
 * server may still hold is resumed by its id on the next traffic, with no handshake; only a session the
 * server refused (404), or one that never reached a session id, joins a bounded initialization flight
 * using the original client parameters and protocol contract. A lost notification keeps the session:
 * it cannot be answered, and a renewal would spend the server-side session for nothing. Idle SSE
 * reconnects stay with the SDK; auth, protocol and local failures stay terminal.
 * @param {Object} options
 * @param {Object} options.localTransport Stdio-facing server transport.
 * @param {Object} options.remoteTransport Initial HTTP client transport.
 * @param {Function} [options.createRemoteTransport] Creates an HTTP transport: with no argument a fresh
 *     one, given a session id one that resumes that session.
 * @param {Number} [options.reinitializeTimeoutMs=10000] Bounds one replacement handshake.
 * @param {Function} [options.onError] Receives terminal reports.
 * @param {Function} [options.onRecovered] Receives survived-error reports.
 * @returns {Promise<{close: Function}>}
 */
export async function bridgeTransports({
    localTransport,
    remoteTransport,
    createRemoteTransport,
    reinitializeTimeoutMs = 10000,
    onError     = error => process.stderr.write(`${error.message}\n`),
    onRecovered = error => process.stderr.write(`${error.message}\n`)
}) {
    const
        pending        = new Map(),
        serverRequests = new Map(),
        claimedErrors  = new WeakSet(),
        reportedErrors = new WeakSet();
    let
        current,
        closePromise = null,
        initializeRequest,
        initializeResult,
        initializationFlight = null,
        initialized = false,
        resumeSessionId = null,
        sequence = 0,
        terminalErrorReported = false;

    const report = (reporter, text, error) => {
        try {
            reporter(new Error(`${text} Cause: ${getBridgeErrorCause(error)}.`))
        } catch {
            // Reporting must never prevent cleanup.
        }
    };

    const close = ({terminate=true} = {}) => {
        if (closePromise) return closePromise;

        const generation = current;
        current = null;
        generation?.handshake?.reject(new Error('Bridge closed.'));

        closePromise = Promise.resolve().then(async () => {
            if (terminate) {
                try {
                    await generation?.transport.terminateSession?.()
                } catch {
                    // Remote termination is best-effort on an already-requested shutdown.
                }
            }
            await Promise.allSettled([localTransport.close(), generation?.transport.close()])
        });
        return closePromise
    };

    const fail = error => {
        if (terminalErrorReported || closePromise) return;

        terminalErrorReported = true;
        report(onError, RUNTIME_FAILURE_MESSAGE, error);
        void close({terminate: false})
    };

    const answerFailure = (id, request, error, unknown=false) => {
        if (closePromise || pending.get(id) !== request) return;

        pending.delete(id);
        return localTransport.send({
            jsonrpc: '2.0',
            id,
            error  : {
                code   : ErrorCode.InternalError,
                message: `${REQUEST_FAILURE_MESSAGE} Cause: ${getBridgeErrorCause(error)}.`,
                ...(unknown ? {data: {outcome: 'unknown'}} : {})
            }
        })
    };

    const retire = (generation, error, {refused=false} = {}) => {
        if (!generation || current !== generation || closePromise) return;

        // A refused session is gone on the server; any other retirement may leave it alive there, so
        // the next flight carries its id and lets the first request prove it.
        resumeSessionId = refused ? null : (generation.transport.sessionId ?? null);
        current = null;
        generation.handshake?.reject(error);
        // Fence before close(): the SDK invokes onclose synchronously and aborted sends reject later.
        generation.transport.onmessage = generation.transport.onerror = generation.transport.onclose = undefined;
        for (const [id, owner] of serverRequests) {
            if (owner.generation === generation) serverRequests.delete(id)
        }
        for (const [id, request] of pending) {
            if (request.generation === generation) {
                Promise.resolve(answerFailure(id, request, error, request.sent)).catch(fail)
            }
        }
        report(onRecovered, resumeSessionId ? RESUMING_MESSAGE : RENEWING_MESSAGE, error);
        void Promise.resolve().then(() => generation.transport.close()).catch(() => {})
    };

    const isTerminal = error => !initialized || error instanceof BridgeProtocolError || SESSION_ENDING_CODES.has(error?.code);

    const onRemoteError = (generation, error) => {
        if (current !== generation || closePromise) return;
        if (isTerminal(error)) return fail(error);

        const cause = getBridgeErrorCause(error);
        if (error?.code === 404) return retire(generation, error, {refused: true});
        if (cause === 'sse-reconnect-exhausted' ||
            cause === 'sse-disconnect' && (generation.handshake || [...pending.values()].some(
                request => request.generation === generation
            ))) return retire(generation, error);

        setTimeout(() => {
            const tracked = error !== null && typeof error === 'object';
            if (current !== generation || closePromise ||
                tracked && (claimedErrors.has(error) || reportedErrors.has(error))) return;

            tracked && reportedErrors.add(error);
            report(onRecovered, RECOVERED_MESSAGE, error)
        }, 0)
    };

    const wire = transport => {
        const generation = {transport, handshake: null, serverIds: new Map()};
        current = generation;

        transport.onerror = error => onRemoteError(generation, error);
        transport.onclose = () => {
            if (current === generation) void close({terminate: false})
        };
        transport.onmessage = message => {
            if (current !== generation || closePromise) return;

            const isResponse = Object.hasOwn(message, 'id') &&
                (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'));

            if (isResponse && generation.handshake?.id === message.id) {
                const parsed = InitializeResultSchema.safeParse(message.result);
                if (!parsed.success || parsed.data.protocolVersion !== initializeResult.protocolVersion ||
                    !isDeepStrictEqual(parsed.data.capabilities, initializeResult.capabilities)) {
                    // A replacement cannot silently change the contract already seen by the local client.
                    const error = new BridgeProtocolError('Incompatible initialization response.');
                    generation.handshake.reject(error);
                    fail(error);
                    return
                }
                transport.setProtocolVersion?.(parsed.data.protocolVersion);
                generation.handshake.resolve();
                return
            }

            if (isResponse) {
                const request = pending.get(message.id);
                if (request?.generation !== generation) return;
                pending.delete(message.id);

                if (!initialized && message.id === initializeRequest?.id) {
                    if (typeof message.result?.protocolVersion === 'string') {
                        initialized = true;
                        initializeResult = structuredClone(message.result);
                        transport.setProtocolVersion?.(message.result.protocolVersion)
                    }
                    initializeRequest = {...initializeRequest, id: undefined}
                }
            }
            if (Object.hasOwn(message, 'id') && typeof message.method === 'string') {
                // A restarted server may reuse its counter while the local client still handles an old request.
                const id = `neo-bridge-server-${++sequence}`;
                serverRequests.set(id, {generation, originalId: message.id});
                generation.serverIds.set(message.id, id);
                message = {...message, id}
            } else if (message.method === 'notifications/cancelled') {
                const id = generation.serverIds.get(message.params?.requestId);
                if (id === undefined) return;
                message = {...message, params: {...message.params, requestId: id}}
            }
            Promise.resolve().then(() => {
                if (current === generation && !closePromise) return localTransport.send(message)
            }).catch(fail)
        };
        return generation
    };

    const ensureRemote = () => {
        if (initializationFlight) return initializationFlight;
        if (current) return Promise.resolve(current);

        initializationFlight = Promise.resolve().then(async () => {
            let generation, timer;
            try {
                if (closePromise) throw new Error('Bridge closed.');
                if (resumeSessionId) {
                    // The server may still hold the retired session: carry its id and the negotiated
                    // protocol, open the stream, and let the first forwarded request prove it. A 404 there
                    // retires this generation as refused, so the next flight runs the fresh initialize below.
                    generation = wire(createRemoteTransport(resumeSessionId));
                    generation.transport.setProtocolVersion?.(initializeResult.protocolVersion);
                    await generation.transport.start();
                    if (current !== generation || closePromise) throw new Error('Bridge closed.');
                    return generation
                }
                generation = wire(createRemoteTransport());
                const ready = new Promise((resolve, reject) => {
                    generation.handshake = {id: `neo-bridge-initialize-${++sequence}`, resolve, reject}
                }), timeout = new Promise((_, reject) => {
                    timer = setTimeout(() => reject(Object.assign(new Error('Initialization timed out.'), {
                        name: 'TimeoutError'
                    })), reinitializeTimeoutMs)
                });
                // Attach the rejection handler before start/send can report a transport error.
                const sent = Promise.resolve().then(async () => {
                    await generation.transport.start();
                    if (current !== generation || closePromise) throw new Error('Bridge closed.');
                    await generation.transport.send({
                        ...initializeRequest,
                        id    : generation.handshake.id,
                        params: structuredClone(initializeRequest.params)
                    })
                });
                await Promise.race([timeout, Promise.all([ready, sent]).then(async () => {
                    if (current !== generation || closePromise) throw new Error('Bridge closed.');
                    await generation.transport.send({jsonrpc: '2.0', method: 'notifications/initialized'})
                })]);
                if (current !== generation || closePromise) throw new Error('Bridge closed.');
                generation.handshake = null;
                return generation
            } catch (error) {
                if (isTerminal(error)) fail(error);
                else if (generation) retire(generation, error, {refused: error?.code === 404});
                throw error
            } finally {
                clearTimeout(timer)
            }
        }).finally(() => { initializationFlight = null });
        return initializationFlight
    };

    localTransport.onmessage = message => {
        if (closePromise) return;
        if (!initialized && message.method === 'server/discover' && Object.hasOwn(message, 'id')) {
            Promise.resolve().then(() => localTransport.send({
                jsonrpc: '2.0', id: message.id, error: {code: ErrorCode.MethodNotFound, message: 'Method not found'}
            })).catch(fail);
            return
        }

        const
            isRequest  = Object.hasOwn(message, 'id') && typeof message.method === 'string',
            isResponse = Object.hasOwn(message, 'id') &&
                (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')),
            responseOwner = isResponse ? serverRequests.get(message.id) : null,
            request = {generation: initializationFlight ? null : current, sent: false},
            cancelledId = message.method === 'notifications/cancelled' ? message.params?.requestId : undefined;

        if (isResponse) {
            serverRequests.delete(message.id);
            if (!responseOwner || responseOwner.generation !== current) return;
            current.serverIds.delete(responseOwner.originalId);
            message = {...message, id: responseOwner.originalId}
        }
        if (!initialized && message.method === 'initialize' && isRequest) initializeRequest = structuredClone(message);
        if (isRequest) pending.set(message.id, request);

        // The first handshake stays transparent; later handshakes are internal.
        const remoteReady = isResponse ? Promise.resolve(responseOwner.generation) :
            initialized ? ensureRemote() : Promise.resolve(current);
        remoteReady.then(async generation => {
            if (closePromise) return;
            if (current !== generation) {
                if (isRequest) return answerFailure(message.id, request, new Error('Remote retired before send.'));
                return
            }
            request.generation = generation;
            request.sent = true;
            await generation.transport.send(message);
            if (cancelledId !== undefined) pending.delete(cancelledId)
        }).catch(error => {
            if (error !== null && typeof error === 'object') claimedErrors.add(error);
            if (closePromise) return;
            if (isTerminal(error)) return fail(error);
            if (request.generation && current !== request.generation) return;
            if (request.generation && error?.code === 404) return retire(request.generation, error, {refused: true});
            report(onRecovered, RECOVERED_MESSAGE, error);
            // A lost notification cannot be answered; the session is kept, exactly as for a lost request.
            if (!isRequest) return;
            return answerFailure(message.id, request, error, request.sent)
        }).catch(fail)
    };
    localTransport.onerror = fail;
    localTransport.onclose = () => void close();
    const initial = wire(remoteTransport);
    try {
        await initial.transport.start();
        await localTransport.start()
    } catch (error) {
        await close({terminate: false});
        throw error
    }
    return {close: () => close()}
}

/**
 * @summary Start the fixed-bearer stdio-to-Streamable-HTTP bridge.
 * @param {Object} options
 * @param {URL} options.endpoint
 * @param {String} options.token Bearer value read from the inherited environment only.
 * @param {Object} [options.localTransport]
 * @param {Object} [options.remoteTransport]
 * @param {Function} [options.onError]
 * @returns {Promise<{close: Function}>}
 */
export async function startBridge({
    endpoint,
    token,
    localTransport = new StdioServerTransport(),
    remoteTransport = null,
    onError
}) {
    if (typeof token !== 'string' || token.length === 0) {
        throw new BridgeConfigurationError('Bridge bearer environment slot is missing or empty.')
    }

    const createRemoteTransport = sessionId => new StreamableHTTPClientTransport(endpoint, {
        sessionId,
        requestInit: {
            headers: {Authorization: `Bearer ${token}`}
        }
    });

    return bridgeTransports({localTransport, remoteTransport: remoteTransport || createRemoteTransport(), createRemoteTransport, onError})
}

/**
 * @summary CLI entrypoint. Only public endpoint and environment-slot name cross argv.
 * @param {String[]} [argv]
 * @param {Object} [env]
 * @returns {Promise<{close: Function}>}
 */
export async function main(argv=process.argv.slice(2), env=process.env) {
    const
        {endpoint, tokenEnv} = parseArgs(argv),
        token                = env[tokenEnv];

    if (typeof token !== 'string' || token.length === 0) {
        throw new BridgeConfigurationError('Bridge bearer environment slot is missing or empty.')
    }

    const
        bridge               = await startBridge({
            endpoint,
            token,
            onError: report => {
                process.exitCode = 1;
                process.stderr.write(`${report.message}\n`)
            }
        });

    const close = () => void bridge.close();

    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    process.stdin.once('end', close);

    return bridge
}

if (isEntryModule(import.meta.url)) {
    main().catch(error => {
        if (error?.code !== 'commander.helpDisplayed') {
            process.stderr.write(`${getStartupFailureMessage(error)}\n`)
        }
        process.exitCode = error?.code === 'commander.helpDisplayed' ? 0 : 1
    })
}

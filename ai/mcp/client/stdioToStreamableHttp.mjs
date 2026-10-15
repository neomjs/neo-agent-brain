#!/usr/bin/env node

import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StdioServerTransport}          from '@modelcontextprotocol/sdk/server/stdio.js';
import {ErrorCode}                     from '@modelcontextprotocol/sdk/types.js';
import {Command}                       from 'commander';
import {pathToFileURL}                 from 'node:url';

const
    RECOVERED_MESSAGE       = 'Neo MCP bridge kept its session after a transport error.',
    REQUEST_FAILURE_MESSAGE = 'Neo MCP bridge could not deliver the request.',
    RUNTIME_FAILURE_MESSAGE = 'Neo MCP bridge transport failed.',
    SESSION_ENDING_CODES    = new Set([-1, 401, 403, 404]),
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
 * @summary Wire two MCP SDK transports, declining unsupported discovery before an HTTP session exists.
 * A stdio client may probe `server/discover` before initialization. This bridge does not implement
 * discovery: answer MethodNotFound locally so the client can initialize instead of losing its
 * connection to the HTTP transport's pre-session refusal. Initialized traffic remains transparent.
 * Initialization responses propagate the negotiated protocol version into the HTTP transport.
 *
 * After initialization the bridge survives what costs no message. The SDK reconnects a dropped
 * standalone GET stream itself, and a POST response stream exists only while a request is pending
 * (the plane keeps no event store, so it cannot resume); a delivered cancellation retires its request.
 * The SDK reports an error to `onerror` before it rejects the send that raised it or retries the
 * stream that lost it, so `onerror` closes only on what is terminal by itself — any failure before
 * initialization, exhausted reconnection, a stream drop with a request pending — and reports anything
 * else as survived one task later, unless a send claimed it first. A request whose delivery fails is
 * answered locally with a JSON-RPC error; a session or auth refusal, or a local transport error,
 * closes both sides exactly once, as does any close. Every report names its cause.
 * @param {Object} options
 * @param {Object} options.localTransport Stdio-facing server transport.
 * @param {Object} options.remoteTransport Streamable-HTTP-facing client transport.
 * @param {Function} [options.onError] Receives the terminal report.
 * @param {Function} [options.onRecovered] Receives each survived error's report.
 * @returns {Promise<{close: Function}>}
 */
export async function bridgeTransports({
    localTransport,
    remoteTransport,
    onError     = error => process.stderr.write(`${error.message}\n`),
    onRecovered = error => process.stderr.write(`${error.message}\n`)
}) {
    const pendingRequestIds = new Set();
    let
        closePromise          = null,
        initializeRequestId,
        initialized           = false,
        terminalErrorReported = false;

    const close = ({terminate=true} = {}) => {
        if (closePromise) return closePromise;

        closePromise = Promise.resolve().then(async () => {
            if (terminate) {
                try {
                    await remoteTransport.terminateSession?.()
                } catch {
                    // Session termination is best-effort during an already-requested shutdown.
                }
            }

            await Promise.allSettled([
                localTransport.close(),
                remoteTransport.close()
            ])
        });

        return closePromise
    };

    const report = (reporter, text, error) => {
        try {
            reporter(new Error(`${text} Cause: ${getBridgeErrorCause(error)}.`))
        } catch {
            // A reporter failure must never prevent transport cleanup.
        }
    };

    const fail = error => {
        if (terminalErrorReported || closePromise) return;

        terminalErrorReported = true;
        report(onError, RUNTIME_FAILURE_MESSAGE, error);

        void close({terminate: false})
    };

    // The SDK hands an error to `onerror` BEFORE it rejects the send that raised it or retries the stream
    // that lost it, and may hand the same object twice. So `onerror` decides only what is terminal on its
    // own; anything else waits one task, letting a send rejection claim its error, and is reported as
    // survived once, unless it was claimed or the bridge closed meanwhile.
    const claimedErrors  = new WeakSet(),
          reportedErrors = new WeakSet();

    const isTerminalRemoteError = error => {
        const cause = getBridgeErrorCause(error);

        // a session or auth refusal ends the session whichever request met it, a stream GET included
        return !initialized || SESSION_ENDING_CODES.has(error?.code) || cause === 'sse-reconnect-exhausted' ||
            (cause === 'sse-disconnect' && pendingRequestIds.size > 0)
    };

    const onRemoteError = error => {
        if (isTerminalRemoteError(error)) return fail(error);

        setTimeout(() => {
            const tracked = error !== null && typeof error === 'object';

            if (closePromise || tracked && (claimedErrors.has(error) || reportedErrors.has(error))) return;

            tracked && reportedErrors.add(error);
            report(onRecovered, RECOVERED_MESSAGE, error)
        }, 0)
    };

    localTransport.onmessage = message => {
        if (!initialized && message.method === 'server/discover' && Object.hasOwn(message, 'id')) {
            Promise.resolve()
                .then(() => localTransport.send({
                    jsonrpc: '2.0',
                    id     : message.id,
                    error  : {code: ErrorCode.MethodNotFound, message: 'Method not found'}
                }))
                .catch(fail);
            return
        }

        const
            isRequest   = Object.hasOwn(message, 'id') && typeof message.method === 'string',
            // a delivered cancellation may legitimately never be answered, so its request stops being pending
            cancelledId = message.method === 'notifications/cancelled' ? message.params?.requestId : undefined;

        if (message.method === 'initialize' && Object.hasOwn(message, 'id')) {
            initializeRequestId = message.id
        }

        if (isRequest) pendingRequestIds.add(message.id);

        Promise.resolve()
            .then(() => remoteTransport.send(message))
            .then(() => {
                if (cancelledId !== undefined) pendingRequestIds.delete(cancelledId)
            }, error => {
                if (error !== null && typeof error === 'object') claimedErrors.add(error);

                // a send aborted by the bridge's own close is no survived error
                if (closePromise) return;

                if (!initialized || !isRequest || SESSION_ENDING_CODES.has(error?.code)) return fail(error);

                pendingRequestIds.delete(message.id);
                report(onRecovered, RECOVERED_MESSAGE, error);

                return localTransport.send({
                    jsonrpc: '2.0',
                    id     : message.id,
                    error  : {
                        code   : ErrorCode.InternalError,
                        message: `${REQUEST_FAILURE_MESSAGE} Cause: ${getBridgeErrorCause(error)}.`
                    }
                })
            })
            .catch(fail)
    };
    remoteTransport.onmessage = message => {
        if (Object.hasOwn(message, 'id') && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
            pendingRequestIds.delete(message.id)
        }

        const isInitializeResponse =
            initializeRequestId !== undefined &&
            Object.hasOwn(message, 'id') &&
            message.id === initializeRequestId &&
            (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'));

        if (isInitializeResponse) {
            initializeRequestId = undefined;

            if (typeof message.result?.protocolVersion === 'string') {
                initialized = true;
                remoteTransport.setProtocolVersion?.(message.result.protocolVersion)
            }
        }

        Promise.resolve()
            .then(() => localTransport.send(message))
            .catch(fail)
    };
    localTransport.onerror  = fail;
    remoteTransport.onerror = onRemoteError;
    localTransport.onclose  = () => void close();
    remoteTransport.onclose = () => void close({terminate: false});

    try {
        await remoteTransport.start();
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

    remoteTransport ||= new StreamableHTTPClientTransport(endpoint, {
        requestInit: {
            headers: {Authorization: `Bearer ${token}`}
        }
    });

    return bridgeTransports({localTransport, remoteTransport, onError})
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        if (error?.code !== 'commander.helpDisplayed') {
            process.stderr.write(`${getStartupFailureMessage(error)}\n`)
        }
        process.exitCode = error?.code === 'commander.helpDisplayed' ? 0 : 1
    })
}

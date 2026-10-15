import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {expect, test}                  from '@playwright/test';
import {spawn, spawnSync}              from 'node:child_process';
import {once}                          from 'node:events';
import {createServer}                  from 'node:http';
import {createInterface}               from 'node:readline';
import {fileURLToPath}                 from 'node:url';
import {
    bridgeTransports,
    createProgram,
    getBridgeErrorCause,
    getStartupFailureMessage,
    parseArgs,
    startBridge
} from '../../../../../../ai/mcp/client/stdioToStreamableHttp.mjs';

const BRIDGE_ENTRYPOINT = fileURLToPath(
    new URL('../../../../../../ai/mcp/client/stdioToStreamableHttp.mjs', import.meta.url)
);

class FakeTransport {
    closed = 0
    messages = []
    protocolVersion = null
    started = 0
    terminated = 0

    async close() {
        this.closed++;
        this.onclose?.()
    }

    async send(message) {
        this.messages.push(message)
    }

    setProtocolVersion(value) {
        this.protocolVersion = value
    }

    async start() {
        this.started++
    }

    async terminateSession() {
        this.terminated++
    }
}

/** @summary Let every queued bridge promise chain and deferred survival report settle. */
const flush = () => new Promise(resolve => setTimeout(resolve, 5));

/** @summary An error shaped like the SDK's `StreamableHTTPError`: an HTTP status on `code`. */
const httpError = (code, text) => Object.assign(new Error(`Streamable HTTP error: ${text}`), {code});

/** @summary Run one bridge with recording reporters and complete its handshake. */
async function startInitializedBridge() {
    const
        errors    = [],
        recovered = [],
        local     = new FakeTransport(),
        remote    = new FakeTransport(),
        bridge    = await bridgeTransports({
            localTransport : local,
            remoteTransport: remote,
            onError        : error => errors.push(error.message),
            onRecovered    : error => recovered.push(error.message)
        });

    local.onmessage({jsonrpc: '2.0', id: 'init', method: 'initialize', params: {}});
    remote.onmessage({jsonrpc: '2.0', id: 'init', result: {protocolVersion: '2025-11-25'}});
    await flush();

    return {bridge, errors, local, recovered, remote}
}

/** @summary Read one bridge protocol response while surfacing premature child exit and bounding hangs. */
async function readBridgeMessage(lines, child) {
    let timeout;

    try {
        return await Promise.race([
            lines.next().then(({done, value}) => {
                if (done) throw new Error('Bridge closed stdout before the expected response.');

                return JSON.parse(value)
            }),
            once(child, 'close').then(([code]) => {
                throw new Error(`Bridge exited (${code}) before the expected response.`)
            }),
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error('Timed out waiting for a bridge response.')), 3000)
            })
        ])
    } finally {
        clearTimeout(timeout)
    }
}

test.describe('stdioToStreamableHttp', () => {
    test('parses only an HTTP endpoint plus an environment-slot name', () => {
        const result = parseArgs([
            '--url',
            'https://mcp.example.test/mc/mcp',
            '--token-env',
            'NEO_MCP_REMOTE_TOKEN'
        ]);

        expect(result.endpoint.href).toBe('https://mcp.example.test/mc/mcp');
        expect(result.tokenEnv).toBe('NEO_MCP_REMOTE_TOKEN')
    });

    test('rejects unknown options, missing values, invalid protocols, and invalid env names', () => {
        expect(() => parseArgs([
            '--url',
            'https://mcp.example.test/mc/mcp',
            '--token-env',
            'NEO_MCP_REMOTE_TOKEN',
            '--token',
            'secret'
        ])).toThrow(/unknown option/i);
        expect(() => parseArgs([
            '--url',
            'https://mcp.example.test/mc/mcp',
            '--token-env'
        ])).toThrow(/argument missing/i);
        expect(() => parseArgs([
            '--url',
            'file:///tmp/mcp',
            '--token-env',
            'NEO_MCP_REMOTE_TOKEN'
        ])).toThrow(/endpoint protocol/);
        expect(() => parseArgs([
            '--url',
            'https://mcp.example.test/mc/mcp',
            '--token-env',
            'not valid'
        ])).toThrow(/environment variable name/)
    });

    test('exposes deterministic help without starting a bridge', () => {
        const
            output  = [],
            program = createProgram()
                .configureOutput({writeOut: value => output.push(value)})
                .exitOverride();
        let error;

        try {
            program.parse(['--help'], {from: 'user'})
        } catch (caught) {
            error = caught
        }

        expect(error?.code).toBe('commander.helpDisplayed');
        expect(output.join('')).toContain('--token-env <name>')
    });

    test('only closed local configuration errors cross the startup diagnostic boundary', () => {
        const
            reflectedBearer = 'remote body echoed Bearer must-not-print',
            getParseError   = argv => {
                try {
                    parseArgs(argv)
                } catch (error) {
                    return error
                }
            },
            localError = getParseError([
                '--url',
                'not a url',
                '--token-env',
                'NEO_MCP_REMOTE_TOKEN'
            ]);

        expect(getStartupFailureMessage(localError)).toBe('Bridge endpoint must be a valid URL.');
        expect(getStartupFailureMessage(new Error(reflectedBearer))).toBe('Neo MCP bridge failed to start.');
        expect(getStartupFailureMessage({message: reflectedBearer})).toBe('Neo MCP bridge failed to start.');
        expect(getStartupFailureMessage(null)).toBe('Neo MCP bridge failed to start.')
    });

    test('forwards both directions, binds the negotiated protocol, and closes once', async () => {
        const
            errors = [],
            local  = new FakeTransport(),
            remote = new FakeTransport(),
            bridge = await bridgeTransports({
                localTransport : local,
                remoteTransport: remote,
                onError        : error => errors.push(error)
            }),
            initialize = {
                jsonrpc: '2.0',
                id     : 7,
                method : 'initialize',
                params : {}
            },
            response = {
                jsonrpc: '2.0',
                id     : 7,
                result : {protocolVersion: '2025-11-25'}
            },
            reusedId = {
                jsonrpc: '2.0',
                id     : 7,
                result : {protocolVersion: 'poisoned-reused-id'}
            };

        local.onmessage(initialize);
        remote.onmessage(response);
        remote.onmessage(reusedId);
        await Promise.resolve();

        expect(remote.started).toBe(1);
        expect(local.started).toBe(1);
        expect(remote.messages).toEqual([initialize]);
        expect(local.messages).toEqual([response, reusedId]);
        expect(remote.protocolVersion).toBe('2025-11-25');
        expect(errors).toEqual([]);

        await bridge.close();
        await bridge.close();

        expect(remote.terminated).toBe(1);
        expect(local.closed).toBe(1);
        expect(remote.closed).toBe(1)
    });

    test('answers discovery locally before initialize and forwards it after a successful initialize', async () => {
        const
            errors                   = [],
            local                    = new FakeTransport(),
            remote                   = new FakeTransport(),
            bridge                   = await bridgeTransports({localTransport: local, remoteTransport: remote, onError: error => errors.push(error)}),
            discoverBeforeInitialize = {jsonrpc: '2.0', id: 0, method: 'server/discover', params: {}},
            initialize               = {jsonrpc: '2.0', id: 1, method: 'initialize', params: {}},
            discoverAfterInitialize  = {jsonrpc: '2.0', id: 2, method: 'server/discover', params: {}};

        local.onmessage(discoverBeforeInitialize);
        await Promise.resolve();

        expect(local.messages).toEqual([{jsonrpc: '2.0', id: 0, error: {code: -32601, message: 'Method not found'}}]);
        expect(remote.messages).toEqual([]);
        expect([local.closed, remote.closed]).toEqual([0, 0]);

        local.onmessage(initialize);
        await Promise.resolve();
        remote.onmessage({jsonrpc: '2.0', id: 1, result: {protocolVersion: '2025-11-25'}});
        await Promise.resolve();
        local.onmessage(discoverAfterInitialize);
        await Promise.resolve();

        expect(remote.messages).toEqual([initialize, discoverAfterInitialize]);
        expect(remote.protocolVersion).toBe('2025-11-25');
        expect(errors).toEqual([]);
        expect([local.closed, remote.closed]).toEqual([0, 0]);

        await bridge.close()
    });

    test('an initialize error consumes the marker before a reused response id', async () => {
        const
            local  = new FakeTransport(),
            remote = new FakeTransport();

        await bridgeTransports({
            localTransport : local,
            remoteTransport: remote
        });

        local.onmessage({
            jsonrpc: '2.0',
            id     : 'initialize-1',
            method : 'initialize',
            params : {}
        });
        remote.onmessage({
            jsonrpc: '2.0',
            id     : 'initialize-1',
            error  : {code: -32603, message: 'initialization failed'}
        });
        remote.onmessage({
            jsonrpc: '2.0',
            id     : 'initialize-1',
            result : {protocolVersion: 'poisoned-reused-id'}
        });
        await Promise.resolve();

        expect(remote.protocolVersion).toBeNull()
    });

    test('a graceful close absorbs a termination failure and still closes both transports once', async () => {
        const
            errors = [],
            local  = new FakeTransport(),
            remote = new FakeTransport();

        remote.terminateSession = async () => {
            remote.terminated++;
            remote.onerror(new Error('remote response containing a secret'));
            throw new Error('remote response containing a secret')
        };

        const bridge = await bridgeTransports({
            localTransport : local,
            remoteTransport: remote,
            onError        : error => errors.push(error)
        });

        await bridge.close();

        expect(remote.terminated).toBe(1);
        expect(local.closed).toBe(1);
        expect(remote.closed).toBe(1);
        expect(errors).toEqual([])
    });

    test('names causes from a fixed vocabulary, never from error text', () => {
        const abort = new Error('This operation was aborted, Bearer must-not-print');

        abort.name = 'AbortError';

        expect(getBridgeErrorCause(new Error('SSE stream disconnected: TypeError: terminated'))).toBe('sse-disconnect');
        expect(getBridgeErrorCause(new Error('Failed to reconnect SSE stream: Bad Gateway'))).toBe('sse-reconnect-failed');
        expect(getBridgeErrorCause(new Error('Maximum reconnection attempts (2) exceeded.'))).toBe('sse-reconnect-exhausted');
        expect(getBridgeErrorCause(Object.assign(new Error('Error POSTing to endpoint: Bearer must-not-print'), {code: 503}))).toBe('http-503');
        expect(getBridgeErrorCause(Object.assign(new Error('Unexpected content type'), {code: -1}))).toBe('unexpected-content-type');
        expect(getBridgeErrorCause(new TypeError('fetch failed'))).toBe('network');
        expect(getBridgeErrorCause(abort)).toBe('timeout');
        expect(getBridgeErrorCause(new Error('Bearer must-not-print'))).toBe('unknown');
        expect(getBridgeErrorCause(undefined)).toBe('unknown')
    });

    test('survives a dropped stream with nothing pending and keeps forwarding', async () => {
        const
            {bridge, errors, local, recovered, remote} = await startInitializedBridge(),
            later                                      = {jsonrpc: '2.0', method: 'notifications/tools/list_changed'};

        remote.onerror(new Error('SSE stream disconnected: TypeError: terminated'));
        local.onmessage({jsonrpc: '2.0', id: 3, method: 'tools/list', params: {}});
        remote.onerror(new Error('Failed to reconnect SSE stream: Bad Gateway'));
        remote.onmessage(later);
        await flush();

        expect(errors).toEqual([]);
        expect(recovered).toEqual([
            'Neo MCP bridge kept its session after a transport error. Cause: sse-disconnect.',
            'Neo MCP bridge kept its session after a transport error. Cause: sse-reconnect-failed.'
        ]);
        expect(remote.messages.at(-1).id).toBe(3);
        expect(local.messages.at(-1)).toEqual(later);
        expect(local.closed).toBe(0);

        await bridge.close()
    });

    test('a dropped stream while a request is pending closes the bridge with its cause', async () => {
        const {errors, local, recovered, remote} = await startInitializedBridge();

        local.onmessage({jsonrpc: '2.0', id: 9, method: 'tools/call', params: {name: 'add_memory'}});
        await flush();
        remote.onerror(new Error('SSE stream disconnected: TypeError: terminated'));
        await flush();

        expect(recovered).toEqual([]);
        expect(errors).toEqual(['Neo MCP bridge transport failed. Cause: sse-disconnect.']);
        expect(local.closed).toBe(1);
        expect(remote.closed).toBe(1)
    });

    test('exhausted reconnection and a refused session still close the bridge, each naming its cause', async () => {
        const exhausted = await startInitializedBridge();

        exhausted.remote.onerror(new Error('Maximum reconnection attempts (2) exceeded.'));
        await flush();

        expect(exhausted.errors).toEqual(['Neo MCP bridge transport failed. Cause: sse-reconnect-exhausted.']);
        expect(exhausted.local.closed).toBe(1);

        const refused = await startInitializedBridge();

        refused.remote.send = async () => {
            const error = httpError(404, 'Error POSTing to endpoint: Session not found');

            refused.remote.onerror(error);
            throw error
        };
        refused.local.onmessage({jsonrpc: '2.0', id: 4, method: 'tools/call', params: {}});
        await flush();

        expect(refused.errors).toEqual(['Neo MCP bridge transport failed. Cause: http-404.']);
        expect(refused.local.closed).toBe(1)
    });

    test('a request whose delivery fails is answered locally while the session stays open', async () => {
        const {bridge, errors, local, recovered, remote} = await startInitializedBridge();

        remote.send = async message => {
            if (message.id === 11) {
                const error = httpError(502, 'Error POSTing to endpoint: Bearer must-not-print');

                // the SDK's order: onerror first, then the rejection
                remote.onerror(error);
                throw error
            }

            remote.messages.push(message)
        };
        local.onmessage({jsonrpc: '2.0', id: 11, method: 'tools/call', params: {}});
        local.onmessage({jsonrpc: '2.0', id: 12, method: 'tools/call', params: {}});
        await flush();

        expect(local.messages.at(-1)).toEqual({
            jsonrpc: '2.0',
            id     : 11,
            error  : {code: -32603, message: 'Neo MCP bridge could not deliver the request. Cause: http-502.'}
        });
        expect(remote.messages.at(-1).id).toBe(12);
        expect(recovered).toEqual(['Neo MCP bridge kept its session after a transport error. Cause: http-502.']);
        expect(errors).toEqual([]);
        expect(JSON.stringify(local.messages)).not.toContain('must-not-print');
        expect(local.closed).toBe(0);

        await bridge.close()
    });

    test('a retried reconnect survives in the SDK order, and only exhaustion closes', async () => {
        for (const [raw, cause] of [
            [httpError(502, 'Failed to open SSE stream: Bad Gateway'), 'http-502'],
            [new TypeError('fetch failed'),                            'network']
        ]) {
            const {errors, local, recovered, remote} = await startInitializedBridge();

            // one failed reconnect attempt as the SDK reports it: the raw error, then its wrapper, then a retry
            remote.onerror(raw);
            remote.onerror(new Error(`Failed to reconnect SSE stream: ${raw.message}`));
            await flush();

            expect(errors).toEqual([]);
            expect(recovered).toEqual([
                `Neo MCP bridge kept its session after a transport error. Cause: ${cause}.`,
                'Neo MCP bridge kept its session after a transport error. Cause: sse-reconnect-failed.'
            ]);
            expect(local.closed).toBe(0);

            remote.onerror(new Error('Maximum reconnection attempts (2) exceeded.'));
            await flush();

            expect(errors).toEqual(['Neo MCP bridge transport failed. Cause: sse-reconnect-exhausted.']);
            expect(local.closed).toBe(1)
        }
    });

    test('a session or auth refusal on the stream GET closes, with no survival report', async () => {
        for (const code of [401, 403, 404]) {
            const {errors, local, recovered, remote} = await startInitializedBridge();

            remote.onerror(httpError(code, 'Failed to open SSE stream: refused'));
            await flush();

            expect(errors).toEqual([`Neo MCP bridge transport failed. Cause: http-${code}.`]);
            expect(recovered).toEqual([]);
            expect(local.closed).toBe(1)
        }
    });

    test('a pending send aborted by the close reports nothing after it', async () => {
        const {errors, local, recovered, remote} = await startInitializedBridge();
        let abortPending;

        remote.send = message => message.id === 8
            ? new Promise((resolve, reject) => {
                abortPending = () => reject(Object.assign(new Error('This operation was aborted'), {name: 'AbortError'}))
            })
            : Promise.resolve().then(() => {
                const error = httpError(404, 'Error POSTing to endpoint: Session not found');

                remote.onerror(error);
                throw error
            });
        local.onmessage({jsonrpc: '2.0', id: 8, method: 'tools/call', params: {}});
        local.onmessage({jsonrpc: '2.0', id: 9, method: 'tools/call', params: {}});
        await flush();
        abortPending();
        await flush();

        expect(errors).toEqual(['Neo MCP bridge transport failed. Cause: http-404.']);
        expect(recovered).toEqual([]);
        expect(local.messages.some(message => message.id === 8)).toBe(false);
        expect(local.closed).toBe(1)
    });

    test('a session, auth or protocol refusal on a request stays terminal in the SDK order', async () => {
        for (const [code, cause] of [[401, 'http-401'], [403, 'http-403'], [-1, 'unexpected-content-type']]) {
            const {errors, local, recovered, remote} = await startInitializedBridge();

            remote.send = async () => {
                const error = httpError(code, 'refused');

                remote.onerror(error);
                throw error
            };
            local.onmessage({jsonrpc: '2.0', id: 7, method: 'tools/call', params: {}});
            await flush();

            expect(errors).toEqual([`Neo MCP bridge transport failed. Cause: ${cause}.`]);
            expect(recovered).toEqual([]);
            expect(local.closed).toBe(1)
        }
    });

    test('a delivered cancellation retires its request, while a live request still makes a drop terminal', async () => {
        const
            drop      = () => new Error('SSE stream disconnected: TypeError: terminated'),
            cancelled = await startInitializedBridge(),
            live      = await startInitializedBridge();

        for (const {local} of [cancelled, live]) {
            local.onmessage({jsonrpc: '2.0', id: 5, method: 'tools/call', params: {}});
            local.onmessage({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 5}})
        }

        live.local.onmessage({jsonrpc: '2.0', id: 6, method: 'tools/call', params: {}});
        await flush();
        cancelled.remote.onerror(drop());
        live.remote.onerror(drop());
        await flush();

        expect(cancelled.errors).toEqual([]);
        expect(cancelled.local.closed).toBe(0);
        expect(live.errors).toEqual(['Neo MCP bridge transport failed. Cause: sse-disconnect.']);
        expect(live.local.closed).toBe(1);

        await cancelled.bridge.close()
    });

    test('with the real SDK client, a 502 on the GET stream or on one request keeps the session and a 404 ends it', async () => {
        const server = createServer(async (request, response) => {
            if (request.method === 'GET') {
                response.writeHead(502).end();
                return
            }

            let body = '';

            for await (const chunk of request) body += chunk;

            const message = JSON.parse(body);

            if (message.method === 'initialize') {
                response.writeHead(200, {'content-type': 'application/json', 'mcp-session-id': 'session-1'}).end(JSON.stringify({
                    jsonrpc: '2.0', id: message.id,
                    result : {protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {name: 'fixture', version: '1.0.0'}}
                }))
            } else if (!Object.hasOwn(message, 'id')) {
                response.writeHead(202).end()
            } else if (message.id === 2) {
                response.writeHead(502).end('Bad Gateway')
            } else if (message.id === 3) {
                response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({jsonrpc: '2.0', id: 3, result: {tools: []}}))
            } else {
                response.writeHead(404).end('Session not found')
            }
        });

        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

        const
            errors    = [],
            recovered = [],
            local     = new FakeTransport(),
            remote    = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)),
            answer    = id => local.messages.find(message => message.id === id);

        try {
            await bridgeTransports({
                localTransport : local,
                remoteTransport: remote,
                onError        : error => errors.push(error.message),
                onRecovered    : error => recovered.push(error.message)
            });

            local.onmessage({jsonrpc: '2.0', id: 1, method: 'initialize', params: {
                protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'fixture', version: '1.0.0'}
            }});
            await expect.poll(() => answer(1)).toBeTruthy();
            local.onmessage({jsonrpc: '2.0', method: 'notifications/initialized'});
            await expect.poll(() => recovered.length).toBe(1);

            local.onmessage({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}});
            await expect.poll(() => answer(2)).toBeTruthy();
            local.onmessage({jsonrpc: '2.0', id: 3, method: 'tools/list', params: {}});
            await expect.poll(() => answer(3)).toBeTruthy();

            expect(errors).toEqual([]);
            expect(local.closed).toBe(0);
            expect(answer(2).error.message).toBe('Neo MCP bridge could not deliver the request. Cause: http-502.');
            expect(answer(3).result).toEqual({tools: []});
            // the GET's 502 reaches onerror twice as one object and is reported once; the request's 502 once, by its send
            expect(recovered).toEqual([
                'Neo MCP bridge kept its session after a transport error. Cause: http-502.',
                'Neo MCP bridge kept its session after a transport error. Cause: http-502.'
            ]);

            local.onmessage({jsonrpc: '2.0', id: 4, method: 'tools/list', params: {}});
            await expect.poll(() => errors).toEqual(['Neo MCP bridge transport failed. Cause: http-404.']);
            expect(local.closed).toBe(1);
            expect(recovered).toHaveLength(2)
        } finally {
            await remote.close().catch(() => {});
            await new Promise(resolve => server.close(resolve))
        }
    });

    test('closes both sides when partial startup fails', async () => {
        const
            local  = new FakeTransport(),
            remote = new FakeTransport();

        local.start = async () => {
            local.started++;
            throw new Error('stdio unavailable')
        };

        await expect(bridgeTransports({
            localTransport : local,
            remoteTransport: remote
        })).rejects.toThrow(/stdio unavailable/);

        expect(remote.started).toBe(1);
        expect(local.started).toBe(1);
        expect(local.closed).toBe(1);
        expect(remote.closed).toBe(1)
    });

    test('rejects an absent bearer before either transport starts', async () => {
        const
            local  = new FakeTransport(),
            remote = new FakeTransport();

        await expect(startBridge({
            endpoint       : new URL('https://mcp.example.test/mc/mcp'),
            token          : '',
            localTransport : local,
            remoteTransport: remote
        })).rejects.toThrow(/missing or empty/);

        expect(local.started).toBe(0);
        expect(remote.started).toBe(0)
    });

    test('reports bounded local CLI configuration failures without echoing secret-shaped input', () => {
        const
            secretShapedUrl   = 'not-a-url-with-secret-shaped-input',
            tokenShapedSlot   = 'ghp_SENTINEL_TOKEN_ENV_VALUE',
            unknownTokenValue = 'SENTINEL_ARGV_TOKEN_VALUE',
            subprocessEnv     = Object.fromEntries(
                Object.entries(process.env).filter(([key]) => !['FORCE_COLOR', 'NO_COLOR'].includes(key))
            ),
            cases             = [{
                args: [
                    '--url',
                    'https://mcp.example.test/mc/mcp',
                    '--token-env',
                    tokenShapedSlot
                ],
                expected: 'Bridge bearer environment slot is missing or empty.',
                env     : Object.fromEntries(
                    Object.entries(subprocessEnv).filter(([key]) => key !== tokenShapedSlot)
                )
            }, {
                args: [
                    '--url',
                    secretShapedUrl,
                    '--token-env',
                    'NEO_MCP_REMOTE_TOKEN'
                ],
                expected: 'Bridge endpoint must be a valid URL.'
            }, {
                args: [
                    '--url',
                    'file:///private/secret-shaped-path',
                    '--token-env',
                    'NEO_MCP_REMOTE_TOKEN'
                ],
                expected: "Bridge endpoint protocol must be 'http:' or 'https:'."
            }, {
                args: [
                    '--url',
                    'https://mcp.example.test/mc/mcp',
                    '--token-env',
                    'invalid secret-shaped slot'
                ],
                expected: 'Bridge token environment slot must be a valid environment variable name.'
            }, {
                args: [
                    '--url',
                    'https://mcp.example.test/mc/mcp',
                    '--token-env',
                    'NEO_MCP_REMOTE_TOKEN',
                    `--token=${unknownTokenValue}`
                ],
                expected: 'Neo MCP bridge failed to start.'
            }, {
                args: [
                    '--url',
                    'https://mcp.example.test/mc/mcp'
                ],
                expected: 'Neo MCP bridge failed to start.'
            }, {
                args: [
                    '--url',
                    'https://mcp.example.test/mc/mcp',
                    '--token-env'
                ],
                expected: 'Neo MCP bridge failed to start.'
            }];

        for (const fixture of cases) {
            const result = spawnSync(process.execPath, [BRIDGE_ENTRYPOINT, ...fixture.args], {
                encoding: 'utf8',
                env     : fixture.env || {...subprocessEnv, NEO_MCP_REMOTE_TOKEN: 'must-not-print'}
            });

            expect(result.status).toBe(1);
            expect(result.stderr).toBe(`${fixture.expected}\n`);
            expect(result.stderr).not.toContain(secretShapedUrl);
            expect(result.stderr).not.toContain('/private/secret-shaped-path');
            expect(result.stderr).not.toContain('invalid secret-shaped slot');
            expect(result.stderr).not.toContain(tokenShapedSlot);
            expect(result.stderr).not.toContain(unknownTokenValue);
            expect(result.stderr).not.toContain('must-not-print')
        }
    })

    test('a reflected bearer response produces one sanitized error and exits nonzero', async () => {
        const
            token  = 'reflected-bearer-must-not-leak',
            server = createServer((request, response) => {
                response.statusCode = 500;
                response.end(`remote body echoed ${request.headers.authorization}`)
            });

        await new Promise((resolve, reject) => {
            server.listen(0, '127.0.0.1', resolve);
            server.once('error', reject)
        });

        const
            endpoint = `http://127.0.0.1:${server.address().port}/mcp`,
            child    = spawn(process.execPath, [
                BRIDGE_ENTRYPOINT,
                '--url',
                endpoint,
                '--token-env',
                'NEO_REFLECTED_BEARER'
            ], {
                env  : {...process.env, NEO_REFLECTED_BEARER: token},
                stdio: ['pipe', 'pipe', 'pipe']
            });
        let stderr = '';

        child.stderr.on('data', chunk => {
            stderr += chunk
        });
        child.stdin.on('error', () => {});
        child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id     : 1,
            method : 'initialize',
            params : {
                capabilities : {},
                clientInfo   : {name: 'negative-fixture', version: '1.0.0'},
                protocolVersion: '2025-11-25'
            }
        })}\n`);

        try {
            const [code] = await once(child, 'close');

            expect(code).toBe(1);
            expect(stderr).not.toContain(token);
            expect(stderr).not.toContain('remote body echoed');
            expect(stderr.match(/Neo MCP bridge transport failed\./g)).toHaveLength(1);
            expect(stderr).toContain('Neo MCP bridge transport failed. Cause: http-500.')
        } finally {
            await new Promise(resolve => server.close(resolve))
        }
    })

    test('the executable rejects pre-initialize discovery locally then completes an HTTP handshake', async () => {
        const
            token    = 'inert-loopback-fixture-token',
            requests = [],
            server   = createServer(async (request, response) => {
                if (request.method === 'GET') {
                    response.writeHead(405);
                    response.end();
                    return
                }
                if (request.method === 'DELETE') {
                    response.writeHead(200);
                    response.end();
                    return
                }
                if (request.method !== 'POST') {
                    response.writeHead(405);
                    response.end();
                    return
                }

                const chunks = [];

                for await (const chunk of request) chunks.push(chunk);

                const message = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
                      method  = message?.method,
                      session = request.headers['mcp-session-id'];

                requests.push({method, id: message?.id, session});

                const sendJson = (status, body, headers = {}) => {
                    response.writeHead(status, {'content-type': 'application/json', ...headers});
                    response.end(JSON.stringify(body))
                };

                if (request.headers.authorization !== `Bearer ${token}`) {
                    sendJson(401, {jsonrpc: '2.0', id: message?.id ?? null, error: {code: -32000, message: 'Unauthorized'}});
                    return
                }

                if (method === 'initialize') {
                    sendJson(200, {
                        jsonrpc: '2.0', id: message.id,
                        result : {protocolVersion: '2025-11-25', capabilities: {tools: {}}, serverInfo: {name: 'loopback-fixture', version: '1.0.0'}}
                    }, {'mcp-session-id': 'inert-session'});
                    return
                }

                if (session !== 'inert-session') {
                    sendJson(400, {jsonrpc: '2.0', id: message?.id ?? null, error: {code: -32000, message: 'Session required'}});
                    return
                }

                if (method === 'notifications/initialized') {
                    response.writeHead(202);
                    response.end();
                    return
                }

                if (method === 'tools/list') {
                    sendJson(200, {jsonrpc: '2.0', id: message.id, result: {tools: [{name: 'fixture_tool', description: 'Inert loopback tool', inputSchema: {type: 'object', properties: {}}}]}});
                    return
                }

                // Model a real Streamable HTTP server that refuses discovery without initialization.
                sendJson(400, {jsonrpc: '2.0', id: message?.id ?? null, error: {code: -32601, message: 'Method not found'}})
            });

        await new Promise((resolve, reject) => {
            server.listen(0, '127.0.0.1', resolve);
            server.once('error', reject)
        });

        const
            endpoint = `http://127.0.0.1:${server.address().port}/mcp`,
            child    = spawn(process.execPath, [BRIDGE_ENTRYPOINT, '--url', endpoint, '--token-env', 'NEO_LOOPBACK_FIXTURE_TOKEN'], {
                env: {
                    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !['FORCE_COLOR', 'NO_COLOR'].includes(key))),
                    NEO_LOOPBACK_FIXTURE_TOKEN: token
                },
                stdio: ['pipe', 'pipe', 'pipe']
            }),
            stdout = createInterface({input: child.stdout}),
            lines = stdout[Symbol.asyncIterator]();
        let stderr = '';

        child.stderr.on('data', chunk => { stderr += chunk });

        try {
            child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id: 1, method: 'server/discover', params: {}})}\n`);
            expect(await readBridgeMessage(lines, child)).toEqual({jsonrpc: '2.0', id: 1, error: {code: -32601, message: 'Method not found'}});

            child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id: 2, method: 'initialize', params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'fixture-client', version: '1.0.0'}}})}\n`);
            expect(await readBridgeMessage(lines, child)).toMatchObject({jsonrpc: '2.0', id: 2, result: {protocolVersion: '2025-11-25'}});

            child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'})}\n`);
            child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id: 3, method: 'tools/list', params: {}})}\n`);
            expect(await readBridgeMessage(lines, child)).toEqual({jsonrpc: '2.0', id: 3, result: {tools: [{name: 'fixture_tool', description: 'Inert loopback tool', inputSchema: {type: 'object', properties: {}}}]}});

            expect(requests.map(({method}) => method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
            expect(requests[0].session).toBeUndefined();
            expect(requests.slice(1).every(({session}) => session === 'inert-session')).toBe(true);
            expect(stderr).toBe('');

            child.stdin.end();
            const [exitCode] = await once(child, 'close');
            expect(exitCode).toBe(0)
        } finally {
            if (child.exitCode === null && child.signalCode === null) {
                child.stdin.end();
                let   childClosed = false, killTimer;
                const closed      = once(child, 'close').then(() => { childClosed = true });

                await Promise.race([
                    closed,
                    new Promise(resolve => {
                        killTimer = setTimeout(resolve, 1000)
                    })
                ]);
                clearTimeout(killTimer);

                if (!childClosed) {
                    child.kill('SIGTERM');
                    await closed
                }
            }

            stdout.close();
            await new Promise(resolve => server.close(resolve))
        }
    })
});

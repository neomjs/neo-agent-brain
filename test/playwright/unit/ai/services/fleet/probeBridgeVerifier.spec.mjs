import {expect, test}                from '@playwright/test';
import {WebSocketServer}             from 'ws';
import {createServer}                from 'node:http';
import {once}                        from 'node:events';
import {probeBridgeVerifier}         from '../../../../../../ai/services/fleet/probeBridgeVerifier.mjs';
import {createBridgeVerifierPayload} from '../../../../../../ai/mcp/server/neural-link/BridgeProtocol.mjs';

const fingerprint = 'a'.repeat(64);
let servers;
test.beforeEach(() => { servers = []; });
test.afterEach(async () => {
    for (const server of servers) {
        server.clients?.forEach(socket => socket.terminate());
        await new Promise(resolve => server.close(resolve));
    }
});

/** @summary Disposable loopback endpoint; never the host's running Bridge. */
async function fixture(handler) {
    const server = new WebSocketServer({host: '127.0.0.1', port: 0});
    servers.push(server);
    server.on('connection', handler);
    await once(server, 'listening');
    return {port: server.address().port, publicKeySha256: fingerprint, timeoutMs: 1000};
}

test('proves only the captured port and sends neither identity nor bearer', async () => {
    let request;
    const options = await fixture((socket, req) => {
        request = req.url;
        socket.send(JSON.stringify(createBridgeVerifierPayload(fingerprint)));
    });
    expect(await probeBridgeVerifier(options)).toEqual({verdict: 'proved'});
    expect(request).toBe('/?role=verifier');
});

test('refuses legacy mode, another key, stale protocol, extra fields, malformed and binary responses', async () => {
    let response;
    const options = await fixture(socket => socket.send(response));
    const valid   = createBridgeVerifierPayload(fingerprint);
    for (const candidate of [
        createBridgeVerifierPayload(null), createBridgeVerifierPayload('b'.repeat(64)),
        {...valid, protocolVersion: 0}, {...valid, features: ['agent-message-sidecar']},
        {...valid, secret: 'must-not-escape'}, null, 'not-json', Buffer.from(JSON.stringify(valid))
    ]) {
        response = Buffer.isBuffer(candidate) ? candidate : typeof candidate === 'string' ? candidate : JSON.stringify(candidate);
        expect(await probeBridgeVerifier(options)).toEqual({verdict: 'refused', reason: 'bridge-verifier-mismatch'});
    }
});

test('old id-required servers refuse without registration and silent endpoints time out', async () => {
    const old = await fixture(socket => socket.close(1008, 'ID required'));
    expect(await probeBridgeVerifier(old)).toEqual({verdict: 'refused', reason: 'bridge-verifier-unsupported'});
    const silent = await fixture(() => {});
    expect(await probeBridgeVerifier({...silent, timeoutMs: 30})).toEqual({verdict: 'unanswered', reason: 'timeout'});
});

test('abort closes an open probe and pre-aborted requests never connect', async () => {
    const controller = new AbortController();
    let   connected  = 0, closed;
    const options    = await fixture(socket => {
        connected++;
        closed = once(socket, 'close');
        controller.abort();
    });
    expect(await probeBridgeVerifier({...options, signal: controller.signal})).toEqual({verdict: 'unanswered', reason: 'aborted'});
    await closed;
    expect(await probeBridgeVerifier({...options, signal: controller.signal})).toEqual({verdict: 'unanswered', reason: 'aborted'});
    expect(connected).toBe(1);
});

test('bounds payloads and does not follow redirects', async () => {
    const oversized = await fixture(socket => socket.send('x'.repeat(2049)));
    expect((await probeBridgeVerifier(oversized)).verdict).not.toBe('proved');
    let   targetHits = 0;
    const target     = await fixture(socket => { targetHits++; socket.send(JSON.stringify(createBridgeVerifierPayload(fingerprint))); });
    const redirect   = createServer((req, res) => {
        res.writeHead(302, {Location: `ws://127.0.0.1:${target.port}/?role=verifier`});
        res.end();
    });
    servers.push(redirect);
    redirect.listen(0, '127.0.0.1');
    await once(redirect, 'listening');
    expect((await probeBridgeVerifier({...target, port: redirect.address().port})).verdict).not.toBe('proved');
    expect(targetHits).toBe(0);
});

test('invalid port, authority or deadline cannot select a default endpoint', async () => {
    for (const patch of [{port: 0}, {port: '8081'}, {port: 65536}, {publicKeySha256: null}, {timeoutMs: 0}, {timeoutMs: 10001}]) {
        expect(await probeBridgeVerifier({port: 1, publicKeySha256: fingerprint, timeoutMs: 100, ...patch}))
            .toEqual({verdict: 'refused', reason: 'bridge-verifier-input'});
    }
});

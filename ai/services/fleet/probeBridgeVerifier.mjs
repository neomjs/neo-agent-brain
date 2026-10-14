import WebSocket                      from 'ws';
import {isBridgeVerifierPayloadFresh} from '../../mcp/server/neural-link/BridgeProtocol.mjs';

/**
 * @summary Reads the verifier at the exact loopback port captured for a managed MCP child.
 * Never sends a credential, registers an agent, follows a redirect or starts/replaces a Bridge.
 * This is a configuration-drift check under same-UID custody, not cryptographic server authentication.
 * @param {Object} options
 * @param {Number} options.port Port from the same resolved export delivered to the child.
 * @param {String} options.publicKeySha256 Original SPKI DER fingerprint.
 * @param {Number} options.timeoutMs Caller-owned deadline, bounded to ten seconds.
 * @param {AbortSignal} [options.signal] Admission cancellation.
 * @returns {Promise<Object>} A bounded proved/refused/unanswered verdict without remote data or errors.
 */
export async function probeBridgeVerifier({port, publicKeySha256, timeoutMs, signal} = {}) {
    if (!Number.isInteger(port) || port < 1 || port > 65535 ||
        typeof publicKeySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(publicKeySha256) ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) {
        return {verdict: 'refused', reason: 'bridge-verifier-input'}
    }
    if (signal?.aborted) return {verdict: 'unanswered', reason: 'aborted'};

    return new Promise(resolve => {
        let socket, timer, settled = false;
        const finish = result => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            // Keep the error listener: terminating a CONNECTING socket emits an asynchronous error.
            if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
            resolve(result);
        };
        const abort = () => finish({verdict: 'unanswered', reason: 'aborted'});
        try {
            socket = new WebSocket(`ws://127.0.0.1:${port}/?role=verifier`, {
                followRedirects  : false,
                perMessageDeflate: false,
                maxPayload       : 2048,
                handshakeTimeout : timeoutMs
            });
            socket.on('error', () => finish({verdict: 'unanswered', reason: 'bridge-verifier-unavailable'}));
            socket.on('close', code => finish(code === 1008
                ? {verdict: 'refused', reason: 'bridge-verifier-unsupported'}
                : {verdict: 'unanswered', reason: 'bridge-verifier-unavailable'}));
            socket.on('message', (data, binary) => {
                let payload;
                try { if (!binary) payload = JSON.parse(data.toString()); } catch {}
                finish(isBridgeVerifierPayloadFresh(payload, publicKeySha256)
                    ? {verdict: 'proved'}
                    : {verdict: 'refused', reason: 'bridge-verifier-mismatch'});
            });
            timer = setTimeout(() => finish({verdict: 'unanswered', reason: 'timeout'}), timeoutMs);
            signal?.addEventListener('abort', abort, {once: true});
            if (signal?.aborted) abort();
        } catch {
            finish({verdict: 'unanswered', reason: 'bridge-verifier-unavailable'});
        }
    })
}

import {test, expect}                                           from '@playwright/test';
import {createServer}                                           from 'node:http';
import Neo                                                      from 'neo.mjs/src/Neo.mjs';
import * as core                                                from 'neo.mjs/src/core/_export.mjs';
import OpenAiCompatible                                         from '../../../../../ai/provider/OpenAiCompatible.mjs';
import {PROVIDER_STREAM_ERROR_CODE, REASONING_ONLY_RESPONSE_CODE} from '../../../../../ai/provider/createStreamFailureError.mjs';

/**
 * @summary `OpenAiCompatible.stream()` names the two endings that used to arrive as an empty string.
 *
 * LM Studio answers a JSON schema it cannot compile with an error frame inside a 200 stream, and it
 * serves Qwen3.6 with every token on `delta.reasoning_content`; both left `generate()` resolving to
 * `''` with nothing thrown, so the Tri-Vector extractor filed them as `context-overflow`. The stream
 * now throws a coded error for each, and the controls pin the endings that must stay silent.
 *
 * Tests drive a real local HTTP server, like the Ollama sibling: the behaviour lives in how frames
 * are consumed, not in the arguments `fetch` receives.
 */

/**
 * @summary Starts a throwaway SSE server on an ephemeral port.
 * @param {Function} handler
 * @returns {Promise<Object>} The listening server.
 */
function serve(handler) {
    return new Promise(resolve => {
        const server = createServer(handler);
        server.listen(0, () => resolve(server))
    })
}

const sse            = payload => `data: ${JSON.stringify(payload)}\n\n`,
      reasoningFrame = text => sse({choices: [{delta: {reasoning_content: text}}]}),
      contentFrame   = text => sse({choices: [{delta: {content: text}}]}),
      finishFrame    = reason => sse({choices: [{delta: {}, finish_reason: reason}]}),
      hostOf         = server => `http://127.0.0.1:${server.address().port}`,
      provider       = server => Neo.create(OpenAiCompatible, {host: hostOf(server), modelName: 'probe-model'});

/**
 * @summary Serves the given SSE frames once, then closes the response.
 * @param {String[]} frames
 * @returns {Promise<Object>} The listening server.
 */
function serveFrames(frames) {
    return serve((request, response) => {
        response.writeHead(200, {'Content-Type': 'text/event-stream'});
        frames.forEach(frame => response.write(frame));
        response.write('data: [DONE]\n\n');
        response.end()
    })
}

/**
 * @summary Consumes a stream to its end.
 * @param {AsyncGenerator<String>} generator
 * @returns {Promise<String[]>} Every yielded chunk.
 */
async function drain(generator) {
    const chunks = [];

    for await (const chunk of generator) {
        chunks.push(chunk)
    }

    return chunks
}

/**
 * @summary Resolves to the error a promise rejects with, or null when it settles.
 * @param {Promise} promise
 * @returns {Promise<Error|null>}
 */
async function rejectionOf(promise) {
    try {
        await promise;
        return null
    } catch (error) {
        return error
    }
}

const reasoning = ['{"a2a_version": "1.0", ', '"session_artifact": {"feature_namespace": null}}'];

test('a reasoning-only stream throws REASONING_ONLY_RESPONSE with the byte count, never an empty answer', async () => {
    const server = await serveFrames([...reasoning.map(reasoningFrame), finishFrame('length')]);

    try {
        const error = await rejectionOf(drain(provider(server).stream('x', {operationLabel: 'probe'})));

        expect(error, 'the caller must not receive an empty answer').not.toBeNull();
        expect(error.code).toBe(REASONING_ONLY_RESPONSE_CODE);
        expect(error.reasoningBytes).toBe(Buffer.byteLength(reasoning.join(''), 'utf8'));
        expect(error.finishReason).toBe('length');
        expect(error.message).toContain(`${error.reasoningBytes} bytes on the reasoning channel`);
        expect(error.message, 'the reasoning text itself stays out of the error').not.toContain('session_artifact')
    } finally {
        server.close()
    }
});

test('generate() surfaces the same failure instead of resolving to an empty string', async () => {
    const server = await serveFrames([...reasoning.map(reasoningFrame), finishFrame('length')]);

    try {
        const error = await rejectionOf(provider(server).generate('x', {operationLabel: 'probe'}));

        expect(error?.code).toBe(REASONING_ONLY_RESPONSE_CODE)
    } finally {
        server.close()
    }
});

test('an error frame inside a 200 stream throws PROVIDER_STREAM_ERROR carrying the provider message', async () => {
    // LM Studio's MLX structured-output engine, refusing a schema whose `type` is an array.
    const message = "Error in iterating prediction stream: ValueError: 'type' must be a string",
          server  = await serveFrames([sse({error: {message}})]);

    try {
        const error = await rejectionOf(drain(provider(server).stream('x', {operationLabel: 'probe'})));

        expect(error, 'a refused request is not an empty answer').not.toBeNull();
        expect(error.code).toBe(PROVIDER_STREAM_ERROR_CODE);
        expect(error.providerMessage).toBe(message);
        expect(error.message).toContain('probe failed inside the stream');
        expect(error.message).toContain(message)
    } finally {
        server.close()
    }
});

test('reasoning followed by content is an ordinary answer, and onProviderChunk still sees both channels', async () => {
    const server = await serveFrames([reasoningFrame('thinking'), contentFrame('{"ok":'), contentFrame('true}'), finishFrame('stop')]),
          frames = [];

    try {
        const chunks = await drain(provider(server).stream('x', {onProviderChunk: frame => frames.push(frame)}));

        expect(chunks.join('')).toBe('{"ok":true}');
        expect(frames.filter(frame => frame.reasoning).map(frame => frame.reasoning)).toEqual(['thinking'])
    } finally {
        server.close()
    }
});

// The reasoning byte count must be exact whatever shape the body takes: compact JSON parses as a line AND
// sits in the whole-body buffer, so a naive gate counted it twice (reviewer's falsifier: 'éx' → 6, not 3).
const reasoningText = 'éx', reasoningBytes = Buffer.byteLength(reasoningText, 'utf8');

for (const [shape, body] of [
    ['compact JSON, no trailing newline', JSON.stringify({choices: [{message: {reasoning_content: reasoningText}}]})],
    ['compact JSON, trailing newline',    JSON.stringify({choices: [{message: {reasoning_content: reasoningText}}]}) + '\n'],
    ['pretty JSON',                       JSON.stringify({choices: [{message: {reasoning_content: reasoningText}}]}, null, 2)],
    ['SSE',                               reasoningFrame(reasoningText) + finishFrame('length') + 'data: [DONE]\n\n']
]) {
    test(`reasoning bytes are counted exactly once for a ${shape} body`, async () => {
        const frames = [],
              server = await serve((request, response) => { response.writeHead(200, {'Content-Type': 'application/json'}); response.end(body) });

        try {
            const error = await rejectionOf(drain(provider(server).stream('x', {operationLabel: 'probe', onProviderChunk: frame => frames.push(frame)})));

            expect(error?.code).toBe(REASONING_ONLY_RESPONSE_CODE);
            expect(error.reasoningBytes, 'the UTF-8 byte count of the reasoning text, once').toBe(reasoningBytes);
            expect(frames.filter(frame => frame.reasoning).length, 'each logical frame reaches the callback once').toBe(1)
        } finally {
            server.close()
        }
    });
}

test('a stream with neither content nor reasoning still ends silently — that ending belongs to the caller', async () => {
    const server = await serveFrames([finishFrame('stop')]);

    try {
        const chunks = await drain(provider(server).stream('x'));

        expect(chunks).toEqual([])
    } finally {
        server.close()
    }
});

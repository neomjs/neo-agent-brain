import {expect, test} from '@playwright/test';
import {presets}                                                                      from '../../../../../../ai/services/fleet/placementPresets.mjs';
import {CHAT_MAX_TOKENS, VALIDATION_CANARY, hostReachable, probeValidation, validationPlan} from '../../../../../../ai/services/fleet/providerValidation.mjs';

// The validation probe over fetch doubles: the two HTTP contracts each preset declares, from this host, fresh.

const preset = id => presets.find(row => row.id === id);

const response = (status, body) => ({ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body)});

/** A fetch whose answers are keyed by URL suffix; every request is recorded with its parsed body and headers. */
function fetchDouble(answers) {
    const calls = [];

    return {
        calls,
        fetchFn: async (url, init) => {
            calls.push({url, headers: init.headers, body: JSON.parse(init.body)});

            const key = Object.keys(answers).find(suffix => url.endsWith(suffix));

            return key ? answers[key] : response(404, {error: 'no route'});
        }
    };
}

test.describe('providerValidation', () => {
    test('the plan reads each preset\'s env: hosted = Gemini\'s OpenAI-compatible chat + native embedContent with the key; local = LM Studio for both with docker\'s host name read as loopback; a hosted plan without a key is refused', () => {
        const hosted = validationPlan(preset('hosted'), {providerKey: 'key-1'});

        expect(hosted.refusal).toBeNull();
        expect(hosted.chat).toEqual({url: 'https://generativelanguage.googleapis.com/v1beta/openai/v1/chat/completions', model: 'gemini-3.8-flash', headers: {'content-type': 'application/json', authorization: 'Bearer key-1'}, reasoningEffort: 'low'});
        expect(hosted.embedding).toEqual({kind: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent', model: 'gemini-embedding-001', headers: {'content-type': 'application/json', 'x-goog-api-key': 'key-1'}});

        const local = validationPlan(preset('local-small'));

        expect(local.refusal).toBeNull();
        expect(local.chat.url).toBe('http://127.0.0.1:1234/v1/chat/completions');
        expect(local.chat.headers).toEqual({'content-type': 'application/json'});
        expect(local.embedding).toMatchObject({kind: 'openAiCompatible', url: 'http://127.0.0.1:1234/v1/embeddings', model: 'text-embedding-qwen3-embedding-0.6b'});
        expect(validationPlan(preset('local-full')).embedding.model).toBe('text-embedding-qwen3-embedding-8b');

        expect(validationPlan(preset('hosted')).refusal).toBe('the hosted embedder needs the consented provider key');
        expect(validationPlan({id: 'odd', env: {}}).refusal).toBe("preset 'odd' declares no OpenAI-compatible chat host or model");
        expect(validationPlan({id: 'odd', env: {NEO_LOCAL_AGENT_OS_PROVIDER_HOST: 'http://h', NEO_LOCAL_AGENT_OS_MODEL: 'm', NEO_EMBEDDING_PROVIDER: 'ollama'}}).refusal).toContain('does not speak (ollama)');
        expect(hostReachable('http://host.docker.internal:1234')).toBe('http://127.0.0.1:1234');
        expect(hostReachable(undefined)).toBeNull();
    });

    test('AC-1: one chat completion and one embedding per call, answered fresh, with the observed dimension; the shape is evaluateValidation\'s; no vector body survives', async () => {
        const
            {calls, fetchFn} = fetchDouble({
                '/v1/chat/completions': response(200, {choices: [{message: {content: 'ready'}}]}),
                ':embedContent'       : response(200, {embedding: {values: new Array(3072).fill(0.1)}})
            }),
            result = await probeValidation({preset: preset('hosted'), providerKey: 'key-1', fetchFn});

        expect(result.provider).toEqual({ok: true, model: 'gemini-3.8-flash', reason: null});
        expect(result.embedding).toEqual({ok: true, dimension: 3072, reason: null});
        expect(result.bound).toContain('not the plane\'s active route');
        expect(calls.map(call => call.url)).toEqual(['https://generativelanguage.googleapis.com/v1beta/openai/v1/chat/completions', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent']);
        expect(calls[0].body).toEqual({model: 'gemini-3.8-flash', messages: [{role: 'user', content: 'Answer with the single word: ready'}], max_tokens: CHAT_MAX_TOKENS, temperature: 0, reasoning_effort: 'low'});
        expect(CHAT_MAX_TOKENS).toBe(64);
        expect(calls[1].body).toEqual({content: {parts: [{text: VALIDATION_CANARY}]}});
        expect(JSON.stringify(result)).not.toContain('0.1,0.1');

        // a second evaluation is a second pair of calls: nothing is cached or read back
        await probeValidation({preset: preset('hosted'), providerKey: 'key-1', fetchFn});
        expect(calls).toHaveLength(4);
    });

    test('a local preset embeds through /v1/embeddings; each refusing call is a reason, never a throw, and the other call still answers', async () => {
        const
            local = fetchDouble({'/v1/chat/completions': response(200, {choices: [{message: {content: 'ready'}}]}), '/v1/embeddings': response(200, {data: [{embedding: new Array(1024).fill(0)}]})}),
            good  = await probeValidation({preset: preset('local-small'), fetchFn: local.fetchFn});

        expect(good).toMatchObject({provider: {ok: true, model: 'google/gemma-4-26b-a4b'}, embedding: {ok: true, dimension: 1024}});
        expect(local.calls[1].body).toEqual({model: 'text-embedding-qwen3-embedding-0.6b', input: VALIDATION_CANARY});

        const
            down = fetchDouble({'/v1/chat/completions': response(503, {error: 'loading'}), '/v1/embeddings': response(200, {data: [{}]})}),
            bad  = await probeValidation({preset: preset('local-small'), fetchFn: down.fetchFn});

        expect(bad.provider).toEqual({ok: false, model: 'google/gemma-4-26b-a4b', reason: expect.stringContaining('failed: HTTP 503')});
        expect(bad.embedding).toEqual({ok: false, dimension: null, reason: 'the embedding answered without a vector'});

        const thrown = await probeValidation({preset: preset('local-small'), fetchFn: async () => { throw new Error('ECONNREFUSED') }});

        expect(thrown.provider.reason).toContain('ECONNREFUSED');
        expect(thrown.embedding.reason).toContain('ECONNREFUSED');

        // a refused plan makes no call at all
        const none = fetchDouble({});

        expect(await probeValidation({preset: preset('hosted'), fetchFn: none.fetchFn})).toMatchObject({provider: {ok: false, reason: 'the hosted embedder needs the consented provider key'}, embedding: {ok: false}});
        expect(none.calls).toEqual([]);
    });
});

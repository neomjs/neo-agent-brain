import {expect, test} from '@playwright/test';
import {PLANE_MEMORY_CORE_PATH}                                       from '../../../../../../ai/services/fleet/mcpWireParsing.mjs';
import {DEFAULT_CALL_TIMEOUT_MS, PRE_ACCEPTANCE_REFUSAL_CODES, createPlaneWitnessClient, toolError} from '../../../../../../ai/services/fleet/planeWitnessClient.mjs';

// The witness client over an SDK-shaped session double: the three calls' arguments, refusal vs ambiguity, bounds.

function sessionDouble(answers, {connectError = null} = {}) {
    const calls = {connect: 0, tools: [], terminated: 0, closed: 0};

    return {
        calls,
        createSession: () => ({
            transport: {terminateSession: async () => { calls.terminated++ }},
            client   : {
                connect : async () => { calls.connect++; if (connectError) throw connectError },
                callTool: async ({name, arguments: args}) => {
                    calls.tools.push({name, args});

                    const answer = answers[name];

                    if (answer instanceof Error) throw answer;
                    if (typeof answer === 'function') return answer(args);

                    return answer;
                },
                close: async () => { calls.closed++ }
            }
        })
    };
}

const json = payload => ({content: [{type: 'text', text: JSON.stringify(payload)}]});

test.describe('planeWitnessClient', () => {
    test('the three calls carry the effect\'s arguments to the plane\'s tools over one connected session; close terminates it', async () => {
        const
            {calls, createSession} = sessionDouble({
                add_memory        : json({id: 'mem-1', sessionId: 'sess-1', timestamp: 't', visibility: {recencyQueryable: true}}),
                query_recent_turns: json({count: 1, turns: [{id: 'mem-1'}], nextCursor: null}),
                query_raw_memories: json({count: 1, results: [{id: 'mem-1'}]})
            }),
            client = createPlaneWitnessClient({endpoint: 'http://127.0.0.1:3102/', credential: 'pat', createSession});

        expect(await client.addMemory({prompt: 'p', thought: 't', response: 'r'})).toEqual({id: 'mem-1', sessionId: 'sess-1', timestamp: 't', visibility: {recencyQueryable: true}});
        expect(await client.recentTurns({limit: 20})).toEqual({count: 1, turns: [{id: 'mem-1'}], nextCursor: null});
        expect(await client.recall({query: 'mk', limit: 20})).toEqual({count: 1, results: [{id: 'mem-1'}]});

        expect(calls.connect).toBe(1);
        expect(calls.tools).toEqual([
            {name: 'add_memory',         args: {prompt: 'p', thought: 't', response: 'r', toolsUsed: ['first-run-verify'], amountToolCalls: 0}},
            {name: 'query_recent_turns', args: {agentIdentity: '@me', detail: 'full', limit: 20}},
            {name: 'query_raw_memories', args: {query: 'mk', nResults: 20}}
        ]);

        await client.close();
        expect(calls).toMatchObject({terminated: 1, closed: 1});
        await client.close();
        expect(calls).toMatchObject({terminated: 1, closed: 1});
        expect(PLANE_MEMORY_CORE_PATH).toBe('/mc/mcp');
    });

    test('only a pre-acceptance code is a REFUSAL (error.refused); the service\'s catch-all MEMORY_ADD_ERROR, a code-less isError, a transport failure, a malformed payload and a timeout are ambiguous (no flag)', async () => {
        const
            envelope = (code, message) => ({isError: true, structuredContent: {error: 'Failed to add memory', message, code}, content: [{type: 'text', text: `Tool Error: Failed to add memory. Message: ${message}`}]}),
            at       = answers => createPlaneWitnessClient({endpoint: 'http://127.0.0.1:3102', createSession: sessionDouble(answers).createSession});

        // the validation gate and the identity gate answer before any row exists: refused, settled
        await expect(at({add_memory: envelope('MEMORY_VALIDATION_ERROR', 'Rejected empty/below-minimum field(s): thought')}).addMemory({prompt: 'p'})).rejects.toMatchObject({refused: true, code: 'MEMORY_VALIDATION_ERROR', message: 'plane add_memory refused (MEMORY_VALIDATION_ERROR): Rejected empty/below-minimum field(s): thought'});
        await expect(at({add_memory: envelope('MISSING_AGENT_IDENTITY', 'no identity')}).addMemory({prompt: 'p'})).rejects.toMatchObject({refused: true, code: 'MISSING_AGENT_IDENTITY'});
        // the catch-all: a WAL append whose close rejected after the bytes landed reaches it — a row may exist, so it is ambiguous
        const catchAll = await at({add_memory: envelope('MEMORY_ADD_ERROR', 'EIO: close')}).addMemory({prompt: 'p'}).catch(error => error);

        expect(catchAll).toMatchObject({code: 'MEMORY_ADD_ERROR', message: 'plane add_memory failed (MEMORY_ADD_ERROR): EIO: close'});
        expect(catchAll).not.toHaveProperty('refused');
        // an isError without a code is ambiguous too
        const codeless = await at({add_memory: {isError: true, content: [{type: 'text', text: 'tenant has no write grant'}]}}).addMemory({prompt: 'p'}).catch(error => error);

        expect(codeless.message).toBe('plane add_memory failed: tenant has no write grant');
        expect(codeless).not.toHaveProperty('refused');
        expect(PRE_ACCEPTANCE_REFUSAL_CODES.has('MEMORY_ADD_ERROR')).toBe(false);

        const transport = sessionDouble({add_memory: new Error('fetch failed')});

        await expect(createPlaneWitnessClient({endpoint: 'http://127.0.0.1:3102', createSession: transport.createSession}).addMemory({prompt: 'p'})).rejects.toMatchObject({message: 'fetch failed'});
        await expect(createPlaneWitnessClient({endpoint: 'http://127.0.0.1:3102', createSession: transport.createSession}).addMemory({prompt: 'p'})).rejects.not.toHaveProperty('refused');

        const malformed = sessionDouble({add_memory: {content: [{type: 'text', text: 'not json'}]}});

        await expect(createPlaneWitnessClient({endpoint: 'http://127.0.0.1:3102', createSession: malformed.createSession}).addMemory({prompt: 'p'})).rejects.toMatchObject({message: 'plane add_memory answered a malformed payload'});

        const hanging = sessionDouble({add_memory: () => new Promise(() => {})});

        await expect(createPlaneWitnessClient({endpoint: 'http://127.0.0.1:3102', timeoutMs: 20, createSession: hanging.createSession}).addMemory({prompt: 'p'})).rejects.toMatchObject({message: 'plane add_memory timed out after 20 ms'});

        const unreachable = sessionDouble({}, {connectError: new Error('ECONNREFUSED')});

        await expect(createPlaneWitnessClient({endpoint: 'http://127.0.0.1:3102', createSession: unreachable.createSession}).recentTurns({limit: 1})).rejects.toMatchObject({message: 'ECONNREFUSED'});

        expect(toolError('x', {isError: true}).message).toBe('plane x failed: the tool answered isError without a message');
        expect(DEFAULT_CALL_TIMEOUT_MS).toBe(60000);
    });

    test('the endpoint boundary is the shared one: plain http off loopback and an embedded credential are refused before any request', () => {
        expect(() => createPlaneWitnessClient({endpoint: 'http://plane.example.com:3102'})).toThrow('planeWitnessClient refused the endpoint');
        expect(() => createPlaneWitnessClient({endpoint: 'https://user:pw@plane.example.com'})).toThrow('planeWitnessClient refused the endpoint');
        expect(() => createPlaneWitnessClient({endpoint: 'https://plane.example.com', createSession: () => ({})})).not.toThrow();
    });
});

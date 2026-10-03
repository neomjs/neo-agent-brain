import {expect, test} from '@playwright/test';
import {PLANE_MEMORY_CORE_PATH}                                       from '../../../../../../ai/services/fleet/mcpWireParsing.mjs';
import {DEFAULT_CALL_TIMEOUT_MS, createPlaneWitnessClient, refusalError} from '../../../../../../ai/services/fleet/planeWitnessClient.mjs';

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

    test('a tool result the plane flags isError is a REFUSAL (error.refused); a transport failure, a malformed payload and a timeout are ambiguous (no flag)', async () => {
        const
            refusing = sessionDouble({add_memory: {isError: true, content: [{type: 'text', text: 'tenant has no write grant'}]}}),
            client   = createPlaneWitnessClient({endpoint: 'http://127.0.0.1:3102', createSession: refusing.createSession});

        await expect(client.addMemory({prompt: 'p'})).rejects.toMatchObject({refused: true, message: 'plane add_memory refused: tenant has no write grant'});

        const transport = sessionDouble({add_memory: new Error('fetch failed')});

        await expect(createPlaneWitnessClient({endpoint: 'http://127.0.0.1:3102', createSession: transport.createSession}).addMemory({prompt: 'p'})).rejects.toMatchObject({message: 'fetch failed'});
        await expect(createPlaneWitnessClient({endpoint: 'http://127.0.0.1:3102', createSession: transport.createSession}).addMemory({prompt: 'p'})).rejects.not.toHaveProperty('refused');

        const malformed = sessionDouble({add_memory: {content: [{type: 'text', text: 'not json'}]}});

        await expect(createPlaneWitnessClient({endpoint: 'http://127.0.0.1:3102', createSession: malformed.createSession}).addMemory({prompt: 'p'})).rejects.toMatchObject({message: 'plane add_memory answered a malformed payload'});

        const hanging = sessionDouble({add_memory: () => new Promise(() => {})});

        await expect(createPlaneWitnessClient({endpoint: 'http://127.0.0.1:3102', timeoutMs: 20, createSession: hanging.createSession}).addMemory({prompt: 'p'})).rejects.toMatchObject({message: 'plane add_memory timed out after 20 ms'});

        const unreachable = sessionDouble({}, {connectError: new Error('ECONNREFUSED')});

        await expect(createPlaneWitnessClient({endpoint: 'http://127.0.0.1:3102', createSession: unreachable.createSession}).recentTurns({limit: 1})).rejects.toMatchObject({message: 'ECONNREFUSED'});

        expect(refusalError('x', {isError: true}).message).toBe('plane x refused: the tool answered isError without a message');
        expect(DEFAULT_CALL_TIMEOUT_MS).toBe(60000);
    });

    test('the endpoint boundary is the shared one: plain http off loopback and an embedded credential are refused before any request', () => {
        expect(() => createPlaneWitnessClient({endpoint: 'http://plane.example.com:3102'})).toThrow('planeWitnessClient refused the endpoint');
        expect(() => createPlaneWitnessClient({endpoint: 'https://user:pw@plane.example.com'})).toThrow('planeWitnessClient refused the endpoint');
        expect(() => createPlaneWitnessClient({endpoint: 'https://plane.example.com', createSession: () => ({})})).not.toThrow();
    });
});

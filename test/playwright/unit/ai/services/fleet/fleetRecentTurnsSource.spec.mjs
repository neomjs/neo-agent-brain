import {expect, test}                 from '@playwright/test';
import {createFleetRecentTurnsSource} from '../../../../../../ai/services/fleet/fleetRecentTurnsSource.mjs';

const HEALTHY_RESULT = {
    count: 2,
    turns: [
        {id: 'turn-2', sessionId: '258e3158-432b-49ad-9cbe-b1568e69e7d1', timestamp: '2026-10-03T06:35:51.562Z', projectionPending: false, summary: 'Confirmed the ledger delivery and outlined the current lanes.', summaryFallback: false},
        {id: 'turn-1', sessionId: '6f7d14a3-e126-4b47-888f-fc28c748ae83', timestamp: '2026-10-02T21:08:57.099Z', projectionPending: false, summary: 'Pushed the data layer as a checkpoint.', summaryFallback: false}
    ],
    nextCursor   : {timestamp: '2026-10-02T21:08:57.099Z', id: 'turn-1'},
    memorySharing: {policy: 'team', clamped: false}
};

function harness({viewer='@neo-fable', now='2026-10-03T07:00:00.000Z', result=HEALTHY_RESULT} = {}) {
    const calls = [],
          state = {viewer, now, result};

    const source = createFleetRecentTurnsSource({
        queryRecentTurns: async args => {
            calls.push(args);

            if (state.result instanceof Error) {
                throw state.result
            }

            return state.result
        },
        resolveViewerIdentity: () => state.viewer,
        now                  : () => new Date(state.now)
    });

    return {calls, source, state}
}

test.describe('fleetRecentTurnsSource — a seat\'s newest public turn summaries for the viewer', () => {
    test('construction refuses missing collaborators', () => {
        expect(() => createFleetRecentTurnsSource()).toThrow(TypeError);
        expect(() => createFleetRecentTurnsSource({queryRecentTurns: async () => ({})})).toThrow(TypeError);
        expect(() => createFleetRecentTurnsSource({resolveViewerIdentity: () => '@a'})).toThrow(TypeError)
    });

    test('a healthy read asks once for the seat\'s public summaries under the team policy and passes the answer through under a wired capability', async () => {
        const {calls, source} = harness(),
              result          = await source.readRecentTurns({agentIdentity: '@neo-opus-ada'});

        expect(calls).toEqual([{agentIdentity: '@neo-opus-ada', memorySharing: 'team', detail: 'summary', limit: 20}]);
        expect(result.turns).toBe(HEALTHY_RESULT.turns);
        expect(result).toEqual({
            capability   : {state: 'wired', capturedAt: '2026-10-03T07:00:00.000Z'},
            viewer       : '@neo-fable',
            target       : '@neo-opus-ada',
            page         : {limit: 20, before: null},
            turns        : HEALTHY_RESULT.turns,
            count        : 2,
            nextCursor   : {timestamp: '2026-10-02T21:08:57.099Z', id: 'turn-1'},
            memorySharing: {policy: 'team', clamped: false}
        })
    });

    test('the source decides the read\'s shape: no client-chosen policy, detail, projection or viewer reaches the operation', async () => {
        const {calls, source} = harness();

        await source.readRecentTurns({agentIdentity: '@neo-opus-ada', memorySharing: 'legacy', detail: 'full', projection: 'private', viewerIdentity: '@smuggled'});

        expect(calls[0]).toEqual({agentIdentity: '@neo-opus-ada', memorySharing: 'team', detail: 'summary', limit: 20})
    });

    test('the target is a canonical identity and paging is validated, never coerced; the operation\'s own cursor rides back unchanged', async () => {
        const {calls, source} = harness();

        for (const agentIdentity of [undefined, '', 'neo-opus-ada', '@', '@a b', '../../etc/passwd', 42]) {
            await expect(source.readRecentTurns({agentIdentity})).rejects.toThrow('canonical @identity')
        }

        await expect(source.readRecentTurns({agentIdentity: '@neo-opus-ada', limit: 0})).rejects.toThrow('limit');
        await expect(source.readRecentTurns({agentIdentity: '@neo-opus-ada', limit: 51})).rejects.toThrow('limit');
        await expect(source.readRecentTurns({agentIdentity: '@neo-opus-ada', limit: 2.5})).rejects.toThrow('limit');

        for (const before of ['turn-1', {id: 'turn-1'}, {timestamp: 'yesterday', id: 'turn-1'}, {timestamp: '2026-10-02T21:08:57.099Z', id: ''}]) {
            await expect(source.readRecentTurns({agentIdentity: '@neo-opus-ada', before})).rejects.toThrow('cursor')
        }

        expect(calls, 'nothing was asked for a refused request').toHaveLength(0);

        const page = await source.readRecentTurns({agentIdentity: '@neo-opus-ada', limit: 5, before: {...HEALTHY_RESULT.nextCursor, smuggled: true}});

        expect(calls.at(-1)).toEqual({agentIdentity: '@neo-opus-ada', memorySharing: 'team', detail: 'summary', limit: 5, before: HEALTHY_RESULT.nextCursor});
        expect(page.page).toEqual({limit: 5, before: HEALTHY_RESULT.nextCursor})
    });

    test('an unbound viewer identity refuses the read before the operation is called', async () => {
        const {calls, source, state} = harness();

        state.viewer = null;
        await expect(source.readRecentTurns({agentIdentity: '@neo-opus-ada'})).rejects.toThrow('canonical viewer identity');
        expect(calls).toHaveLength(0)
    });

    test('an operation failure lands as an honest unavailable envelope carrying the redacted detail', async () => {
        const {source, state} = harness(),
              warns           = [],
              origWarn        = console.warn;

        state.result = new Error('read blew up: token ghp_0123456789012345678901234567890123 leaked');
        console.warn = (...args) => warns.push(args.join(' '));

        try {
            const result = await source.readRecentTurns({agentIdentity: '@neo-opus-ada'});

            expect(result.capability).toMatchObject({state: 'unavailable', reason: 'recent-turns-read-failed', capturedAt: '2026-10-03T07:00:00.000Z'});
            expect(result.capability.detail).toContain('read blew up');
            expect(result.capability.detail).not.toContain('ghp_0123456789012345678901234567890123');
            expect(result).toMatchObject({viewer: '@neo-fable', target: '@neo-opus-ada', turns: [], count: 0, nextCursor: null, memorySharing: null});
            expect(warns.some(line => line.includes('recent turns read failed (@neo-opus-ada)') && !line.includes('ghp_0123456789012345678901234567890123'))).toBe(true)
        } finally {
            console.warn = origWarn
        }
    });

    test('an unrecognized payload is unavailable; a plane that clamps the policy answers a wired empty page that says so', async () => {
        const {source, state} = harness();

        state.result = {rows: 'not-the-contract'};

        const unrecognized = await source.readRecentTurns({agentIdentity: '@neo-opus-ada'});

        expect(unrecognized.capability).toMatchObject({state: 'unavailable', reason: 'recent-turns-payload-unrecognized'});
        expect(unrecognized.turns).toEqual([]);

        state.result = {count: 0, turns: [], nextCursor: null, memorySharing: {policy: 'private', clamped: true}};

        const clamped = await source.readRecentTurns({agentIdentity: '@neo-opus-ada'});

        expect(clamped.capability.state).toBe('wired');
        expect(clamped).toMatchObject({turns: [], count: 0, nextCursor: null, memorySharing: {policy: 'private', clamped: true}})
    })
});

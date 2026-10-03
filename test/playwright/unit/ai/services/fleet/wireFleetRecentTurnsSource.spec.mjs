import {test, expect}               from '@playwright/test';
import Neo                          from 'neo.mjs/src/Neo.mjs';
import * as core                    from 'neo.mjs/src/core/_export.mjs';
import FleetControlBridge           from '../../../../../../ai/services/fleet/FleetControlBridge.mjs';
import {wireFleetRecentTurnsSource} from '../../../../../../ai/services/fleet/wireFleetRecentTurnsSource.mjs';

/**
 * @summary The recent-turns wiring installs the source with the operation and the viewer resolver it
 * was handed, and the bridge verb passes that source's envelope through. The entrypoint's own call is
 * the running fleet server's concern; this pins the forwarding and the unwired answer.
 */
test.describe('Neo.ai.services.fleet.wireFleetRecentTurnsSource', () => {
    test('a missing required collaborator leaves the bridge unwired', () => {
        const bridge = {recentTurnsSource: 'UNTOUCHED'};

        expect(wireFleetRecentTurnsSource({bridge, resolveViewerIdentity: () => '@viewer'})).toBeNull();
        expect(wireFleetRecentTurnsSource({bridge, queryRecentTurns: async () => ({})})).toBeNull();
        expect(bridge.recentTurnsSource).toBe('UNTOUCHED')
    });

    test('the operation, the viewer resolver and the clock reach the source', () => {
        const
            bridge           = {},
            queryRecentTurns = async () => ({}),
            resolveViewer    = () => '@viewer',
            now              = () => new Date(0),
            created          = {readRecentTurns() {}};
        let captured = null;

        const result = wireFleetRecentTurnsSource({
            bridge,
            queryRecentTurns,
            resolveViewerIdentity: resolveViewer,
            now,
            createSource         : options => { captured = options; return created }
        });

        expect(result).toBe(created);
        expect(bridge.recentTurnsSource).toBe(created);
        expect(captured).toEqual({queryRecentTurns, resolveViewerIdentity: resolveViewer, now})
    });

    test('the bridge verb names an unwired source unavailable, and passes a wired source\'s envelope through', async () => {
        const previous = FleetControlBridge.recentTurnsSource;

        try {
            FleetControlBridge.recentTurnsSource = null;

            expect(FleetControlBridge.fleetRecentTurns({agentIdentity: '@neo-opus-ada'})).toEqual({
                capability   : {state: 'unavailable', reason: 'fleet recent-turns source not wired'},
                viewer       : null,
                target       : '@neo-opus-ada',
                page         : {limit: null, before: null},
                turns        : [],
                count        : 0,
                nextCursor   : null,
                memorySharing: null
            });

            const
                calls  = [],
                answer = {count: 1, turns: [{id: 'turn-1', summary: 'Claimed the lane.'}], nextCursor: null, memorySharing: {policy: 'team', clamped: false}};

            wireFleetRecentTurnsSource({
                queryRecentTurns     : async args => { calls.push(args); return answer },
                resolveViewerIdentity: () => '@neo-fable',
                now                  : () => new Date('2026-10-03T07:00:00.000Z')
            });

            const envelope = await FleetControlBridge.fleetRecentTurns({agentIdentity: '@neo-opus-ada', limit: 5});

            expect(calls).toEqual([{agentIdentity: '@neo-opus-ada', memorySharing: 'team', detail: 'summary', limit: 5}]);
            expect(envelope).toMatchObject({
                capability   : {state: 'wired', capturedAt: '2026-10-03T07:00:00.000Z'},
                viewer       : '@neo-fable',
                target       : '@neo-opus-ada',
                turns        : answer.turns,
                memorySharing: {policy: 'team', clamped: false}
            })
        } finally {
            FleetControlBridge.recentTurnsSource = previous
        }
    })
});

import {expect, test}                      from '@playwright/test';
import {createFleetActivityReadSource}     from '../../../../../../ai/services/fleet/fleetActivityComposer.mjs';
import {readFleetRotationActivitySnapshot} from '../../../../../../ai/services/fleet/fleetRotationActivityAdapter.mjs';
import {createFleetWakeRoutesSource}       from '../../../../../../ai/services/fleet/fleetWakeRoutesSource.mjs';
import {FLEET_COCKPIT_SOURCES}             from '../../../../../../src/fleet/contract/cockpit.mjs';

const NOW = () => Date.parse('2026-11-14T01:00:00.000Z');

const seat = (agentId, rotation) => ({agentId, rotation});

const read = (seats, options = {}) => readFleetRotationActivitySnapshot({readWakeRoutes: async () => ({seats}), now: NOW, ...options});

test.describe('fleetRotationActivityAdapter — the rotation slot of the Fleet activity history', () => {
    test('each seat with a record is one event, newest first, identified by its receipt and state; quiet seats emit nothing', async () => {
        const snapshot = await read([
            seat('ada',  {state: 'completed', reason: null, receiptId: 'MESSAGE:r1', decidedAt: '2026-11-14T00:30:00.000Z', oldSessionId: 's-old', newSessionId: 's-new', nextEligibleAt: null}),
            seat('clio', {state: 'refused', reason: 'minimum-interval', receiptId: 'MESSAGE:r2', decidedAt: '2026-11-14T00:40:00.000Z', oldSessionId: 's-c', newSessionId: null, nextEligibleAt: '2026-11-14T02:00:00.000Z'}),
            seat('vega', {state: 'none', reason: null}),
            seat('grace', {state: 'unobserved', reason: null})
        ]);

        expect(snapshot.capability).toEqual({source: FLEET_COCKPIT_SOURCES.rotation, state: 'wired', confidence: 'observed', capturedAt: '2026-11-14T01:00:00.000Z', reason: null});
        expect(snapshot.events.map(event => [event.eventId, event.type, event.agentId, event.occurredAt])).toEqual([
            [`${FLEET_COCKPIT_SOURCES.rotation}:MESSAGE:r2:refused`,   'session-rotation', 'clio', '2026-11-14T00:40:00.000Z'],
            [`${FLEET_COCKPIT_SOURCES.rotation}:MESSAGE:r1:completed`, 'session-rotation', 'ada',  '2026-11-14T00:30:00.000Z']
        ]);
        expect(snapshot.events[1].payload).toEqual({receiptId: 'MESSAGE:r1', state: 'completed', reason: null, oldSessionId: 's-old', newSessionId: 's-new', nextEligibleAt: null});

        const limited = await read([
            seat('ada',  {state: 'requested', receiptId: 'MESSAGE:r3', decidedAt: '2026-11-14T00:50:00.000Z'}),
            seat('clio', {state: 'requested', receiptId: 'MESSAGE:r4', decidedAt: '2026-11-14T00:55:00.000Z'})
        ], {limit: 1});

        expect(limited.events.map(event => event.agentId)).toEqual(['clio'])
    });

    test('a plane that reports no rotations is blind, never quiet: every seat unobserved degrades the slot', async () => {
        const snapshot = await read([seat('ada', {state: 'unobserved', reason: null}), seat('clio', {state: 'unobserved', reason: null})]);

        expect(snapshot.capability).toMatchObject({state: 'degraded', confidence: 'none', reason: 'the plane reports no rotations'});
        expect(snapshot.events).toEqual([]);
        expect((await read([])).capability.state).toBe('wired')
    });

    test('an unknown rotation degrades the slot and names its seats, and the readable seats still answer', async () => {
        const snapshot = await read([
            seat('ada',  {state: 'unknown', reason: 'subscription scan failed'}),
            seat('clio', {state: 'unknown', reason: 'subscription scan failed'}),
            seat('vega', {state: 'requested', receiptId: 'MESSAGE:r5', decidedAt: '2026-11-14T00:10:00.000Z'})
        ]);

        expect(snapshot.capability).toMatchObject({state: 'degraded', confidence: 'partial', reason: 'rotation unknown for ada, clio: subscription scan failed'});
        expect(snapshot.events.map(event => event.agentId)).toEqual(['vega'])
    });

    test('an answer without seats throws, so the composer degrades the slot with that reason', async () => {
        await expect(readFleetRotationActivitySnapshot({readWakeRoutes: async () => ({capability: {}}), now: NOW})).rejects.toThrow('the wake-routes answer carries no seats')
    });

    test('a roster the wake-routes source cannot read degrades the slot and the composite; an empty roster stays quiet and a readable record still answers', async () => {
        const
            record  = {state: 'completed', reason: null, receiptId: 'MESSAGE:r9', decidedAt: '2026-11-14T00:45:00.000Z', oldSessionId: 's-old', newSessionId: 's-new'},
            wired   = async () => ({capability: {source: 'fleet:a2a', state: 'wired', confidence: 'observed'}, counts: [], events: []}),
            through = async listAgents => {
                const {readWakeRoutes} = createFleetWakeRoutesSource({
                    listAgents,
                    resolveViewerIdentity             : () => '@e2e-operator',
                    listActiveSubscriptionObservations: () => [{identity: '@neo-fable-clio', lastPollAt: null, rotation: record}],
                    resolveDeliveryLiveness           : () => ({alive: true, reason: null}),
                    resolveTerminalDeliveryFailures   : () => ({state: 'observed', reason: null, byIdentity: new Map()}),
                    readPresence                      : () => ({agents: []}),
                    now                               : () => new Date(NOW())
                });

                return {
                    slot     : await readFleetRotationActivitySnapshot({readWakeRoutes, now: NOW}),
                    composite: (await createFleetActivityReadSource({
                        readA2ASnapshot     : wired,
                        readPrLaneSnapshot  : wired,
                        readRotationSnapshot: () => readFleetRotationActivitySnapshot({readWakeRoutes, now: NOW})
                    }).readActivitySnapshot()).capability
                }
            };

        for (const [listAgents, cause] of [[() => { throw new Error('registry unavailable') }, 'registry unavailable'], [() => ({rows: 'not an array'}), 'unreadable']]) {
            const {slot, composite} = await through(listAgents);

            expect(slot.capability).toMatchObject({state: 'degraded', confidence: 'none'});
            expect(slot.capability.reason).toMatch(/^the wake-routes read observed nothing: /);
            expect(slot.capability.reason).toContain(cause);
            expect(slot.events).toEqual([]);
            expect(composite.state).toBe('degraded');
            expect(composite.reason).toContain('the wake-routes read observed nothing')
        }

        const empty = await through(() => []);

        expect(empty.slot.capability).toMatchObject({state: 'wired', confidence: 'observed', reason: null});
        expect(empty.composite.state).toBe('wired');

        const readable = await through(() => [{id: 'clio', githubUsername: 'neo-fable-clio'}]);

        expect(readable.slot.capability.state).toBe('wired');
        expect(readable.slot.events.map(event => event.eventId)).toEqual([`${FLEET_COCKPIT_SOURCES.rotation}:MESSAGE:r9:completed`]);
        expect(readable.composite.state).toBe('wired')
    });
});

import {test, expect} from '@playwright/test';

import {
    createCapacityThrottleReader,
    throttleStateFromCapacity
} from '../../../../../../ai/services/fleet/capacityThrottleState.mjs';
import {readFleetThrottleStateSnapshot} from '../../../../../../ai/services/fleet/fleetThrottleStateAdapter.mjs';

const
    NOW     = Date.parse('2026-06-19T12:00:00.000Z'),
    AHEAD   = '2026-06-25T19:00:00.000Z',
    PASSED  = '2026-06-19T11:00:00.000Z',
    window  = (kind, percentUsed, extra = {}) => ({kind, model: null, percentUsed, resetsAt: null, observedAt: '2026-06-19T11:30:00.000Z', stale: false, ...extra}),
    reading = (windows, extra = {}) => ({state: 'observed', model: null, windows, ...extra});

test.describe('capacityThrottleState', () => {
    test('a binding window at 100 % is rate-limited, below it none, and a capped model binds only the seat running it', () => {
        expect(throttleStateFromCapacity(reading([window('five-hour', 30), window('weekly', 91)]), NOW)).toBe('none');
        expect(throttleStateFromCapacity(reading([window('five-hour', 30), window('weekly', 100, {resetsAt: AHEAD})]), NOW)).toBe('rate-limited');

        const fableExhausted = [window('weekly', 70), window('weekly-model', 100, {model: 'fable', resetsAt: AHEAD})];

        expect(throttleStateFromCapacity(reading(fableExhausted, {model: 'claude-fable-5-2'}), NOW)).toBe('rate-limited');
        expect(throttleStateFromCapacity(reading(fableExhausted, {model: 'claude-opus-5-5'}), NOW)).toBe('none');
        // A seat that never said which model it runs is bound by the all-models windows only.
        expect(throttleStateFromCapacity(reading(fableExhausted), NOW)).toBe('none')
    });

    test('an unobserved or stale reading, or one whose only binding window has reset since, answers unknown', () => {
        expect(throttleStateFromCapacity(undefined, NOW)).toBe('unknown');
        expect(throttleStateFromCapacity({state: 'unobserved'}, NOW)).toBe('unknown');
        expect(throttleStateFromCapacity({...reading([window('weekly', 100)]), state: 'stale'}, NOW)).toBe('unknown');
        expect(throttleStateFromCapacity(reading([window('weekly', 100, {stale: true})]), NOW)).toBe('unknown');
        // The week reset at 11:00; a 100 % observed before it says nothing about now.
        expect(throttleStateFromCapacity(reading([window('weekly', 100, {resetsAt: PASSED})]), NOW)).toBe('unknown')
    });

    test('the adapter gets one verdict per registered seat from a single presence read per snapshot', async () => {
        let reads = 0;

        // The injected reader judges at call time, so its reset lies ahead of the real clock.
        const tomorrow     = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
              readPresence = async () => {
            reads++;

            return {agents: [
                {identity: '@neo-out',  capacity: reading([window('weekly', 100, {resetsAt: tomorrow})])},
                {identity: '@neo-fine', capacity: reading([window('weekly', 40)])},
                {identity: '@neo-dark', capacity: {state: 'unobserved'}}
            ]}
        };

        const resolveThrottleState = createCapacityThrottleReader(readPresence),
              snapshot             = await readFleetThrottleStateSnapshot({
                  agents: [{id: 'neo-out'}, {id: 'seat-fine', githubUsername: 'neo-fine'}, {id: 'neo-dark'}, {id: 'neo-unrostered'}],
                  resolveThrottleState
              });

        expect(Object.fromEntries(snapshot.states.map(row => [row.agentId, row.throttle]))).toEqual({
            'neo-out': 'rate-limited', 'seat-fine': 'none', 'neo-dark': 'unknown', 'neo-unrostered': 'unknown'
        });
        expect(reads).toBe(1);

        // The same reader's next snapshot, one task later, reads fresh.
        await new Promise(resolve => setTimeout(resolve, 5));
        await readFleetThrottleStateSnapshot({agents: [{id: 'neo-out'}], resolveThrottleState});
        expect(reads).toBe(2)
    })
});

import {test, expect} from '@playwright/test';

import {
    createCapacityThrottleReader,
    exhaustedUntil,
    exhaustedUntilOf,
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

    test('a rate-limited seat waits until the latest reset of its full binding windows, and only a named reset starts a wait (#1653)', () => {
        const LATER = '2026-06-26T07:00:00.000Z';

        expect(exhaustedUntil(reading([window('five-hour', 100, {resetsAt: AHEAD}), window('weekly', 100, {resetsAt: LATER})]), NOW)).toBe(Date.parse(LATER));
        // A full window with a reset ahead binds; one that has reset since, or one below 100 %, says nothing
        expect(exhaustedUntil(reading([window('weekly', 100, {resetsAt: AHEAD}), window('five-hour', 100, {resetsAt: PASSED})]), NOW)).toBe(Date.parse(AHEAD));
        expect(exhaustedUntil(reading([window('weekly', 99, {resetsAt: AHEAD})]), NOW)).toBe(null);
        // No resetsAt, a stale or unobserved reading: rate-limited perhaps, but no wait can start
        expect(throttleStateFromCapacity(reading([window('weekly', 100)]), NOW)).toBe('rate-limited');
        expect(exhaustedUntil(reading([window('weekly', 100)]), NOW)).toBe(null);
        expect(exhaustedUntil(reading([window('weekly', 100, {resetsAt: AHEAD, stale: true})]), NOW)).toBe(null);
        expect(exhaustedUntil({...reading([window('weekly', 100, {resetsAt: AHEAD})]), state: 'stale'}, NOW)).toBe(null);
        expect(exhaustedUntil({state: 'unobserved'}, NOW)).toBe(null);
        // A capped model makes only the seat that runs it wait
        const fableOut = [window('weekly-model', 100, {model: 'fable', resetsAt: AHEAD})];
        expect(exhaustedUntil(reading(fableOut, {model: 'claude-fable-5-2'}), NOW)).toBe(Date.parse(AHEAD));
        expect(exhaustedUntil(reading(fableOut, {model: 'claude-opus-5-5'}), NOW)).toBe(null)
    });

    test('the presence answer maps each waiting seat by identity, reading its pool\'s newest windows (#1653)', () => {
        const presence = {
            agents: [
                {identity: '@neo-out',    capacity: reading([window('weekly', 100, {resetsAt: AHEAD})])},
                // its own sample is older, but the account it shares already reports the week exhausted
                {identity: '@neo-pooled', capacity: reading([window('weekly', 60, {resetsAt: AHEAD})], {poolKey: 'team-1'})},
                {identity: '@neo-fine',   capacity: reading([window('weekly', 40, {resetsAt: AHEAD})])},
                {identity: '@neo-dark',   capacity: {state: 'unobserved'}},
                {capacity: reading([window('weekly', 100, {resetsAt: AHEAD})])}
            ],
            pools: {'team-1': {windows: [window('weekly', 100, {resetsAt: AHEAD})]}}
        };

        expect(exhaustedUntilOf(presence, NOW)).toEqual({'@neo-out': Date.parse(AHEAD), '@neo-pooled': Date.parse(AHEAD)});
        for (const answer of [null, {}, {agents: []}]) expect(exhaustedUntilOf(answer, NOW)).toEqual({})
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

import {expect, test}              from '@playwright/test';
import {createFleetOpenWorkSource} from '../../../../../../ai/services/fleet/fleetOpenWorkSource.mjs';

const
    OBSERVED = '2026-10-02T10:00:00.000Z',
    review   = {reviewer: '@neo-gpt', state: 'CHANGES_REQUESTED', onHead: true},
    row      = (number=7, observedAt=OBSERVED) => ({
        key  : `acme/app#${number}`, repo: 'acme/app', number, head: 'a1', ci: 'red', verdict: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', draft: false,
        owner: {kind: 'seat', seat: '@neo-opus-ada'}, requested: ['@neo-gpt', 'login:outsider', 'team:acme/core'], reviews: [review], observedAt
    }),
    state    = (overrides={}, rows=[row()]) => ({snapshot: {rows: Object.fromEntries(rows.map(item => [item.key, item]))}, observedAt: OBSERVED, coverage: 'complete', reason: null, ...overrides}),
    at       = minutes => () => Date.parse(OBSERVED) + minutes * 60000,
    source   = (producerState, minutes=1) => createFleetOpenWorkSource({producer: {getState: () => producerState}, now: at(minutes)});

test.describe('fleetOpenWorkSource — each seat\'s open work under the producer\'s own freshness (#760)', () => {
    test('a fresh pulse answers the owner\'s PR and the requested reviewer\'s review; a login or team is no seat', () => {
        const
            {state: freshness, seats, unobserved} = source(state()).readOpenWork(),
            summary                               = {repo: 'acme/app', number: 7, head: 'a1', ci: 'red', verdict: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', draft: false, reviews: [review], observedAt: OBSERVED, stale: false};

        expect(freshness).toBe('ok');
        expect(unobserved).toBe(0);
        expect(seats).toEqual({
            '@neo-opus-ada': {authored: [summary], reviewing: []},
            '@neo-gpt'     : {authored: [], reviewing: [summary]}
        })
    });

    test('one seat reads its own lists, empty under the same envelope when it holds nothing', () => {
        expect(source(state()).readOpenWork({seat: '@neo-opus-vega'})).toMatchObject({state: 'ok', seats: {'@neo-opus-vega': {authored: [], reviewing: []}}})
    });

    test('a stopped producer reads stale, then unavailable, never as no open work', () => {
        expect(source(state(), 10).readOpenWork().state).toBe('stale');
        expect(source(state({coverage: 'stale'})).readOpenWork().state).toBe('stale');
        expect(source(state(), 120).readOpenWork()).toMatchObject({state: 'unavailable', seats: {}});
        expect(source({snapshot: null, observedAt: null, coverage: 'unavailable', reason: null}).readOpenWork().state).toBe('unavailable')
    });

    test('a row partial pulses carried is aged by its own observation: stale, then out of the projection and counted', () => {
        // a complete pulse at 10:00 saw both rows; a partial one at 11:10 saw only the first; read at 11:11
        const
            partial = state({observedAt: '2026-10-02T11:10:00.000Z', coverage: 'partial'}, [row(7, '2026-10-02T11:10:00.000Z'), row(8)]),
            read    = source(partial, 71).readOpenWork();

        expect(read).toMatchObject({state: 'ok', coverage: 'partial', unobserved: 1});
        expect(read.seats['@neo-opus-ada'].authored.map(({number, stale}) => [number, stale])).toEqual([[7, false]]);

        // ten minutes after its last observation a carried row is still shown, marked stale
        const carried = source(state({observedAt: '2026-10-02T10:10:00.000Z', coverage: 'partial'}, [row(8)]), 11).readOpenWork();

        expect(carried.seats['@neo-opus-ada'].authored.map(({number, stale}) => [number, stale])).toEqual([[8, true]])
    });

    test('a partial pulse is still answered, and says so', () => {
        expect(source(state({coverage: 'partial'})).readOpenWork()).toMatchObject({state: 'ok', coverage: 'partial'})
    });
});

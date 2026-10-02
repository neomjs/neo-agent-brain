import {expect, test}              from '@playwright/test';
import {createFleetOpenWorkSource} from '../../../../../../ai/services/fleet/fleetOpenWorkSource.mjs';

const
    OBSERVED = '2026-10-02T10:00:00.000Z',
    row      = {key: 'acme/app#7', repo: 'acme/app', number: 7, head: 'a1', ci: 'red', verdict: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', draft: false,
                owner: {kind: 'seat', seat: '@neo-opus-ada'}, requested: ['@neo-gpt', 'login:outsider', 'team:acme/core']},
    state    = (overrides={}) => ({snapshot: {rows: {[row.key]: row}}, observedAt: OBSERVED, coverage: 'complete', reason: null, ...overrides}),
    after    = minutes => () => Date.parse(OBSERVED) + minutes * 60000,
    source   = (producerState, minutes=1) => createFleetOpenWorkSource({producer: {getState: () => producerState}, now: after(minutes)});

test.describe('fleetOpenWorkSource — each seat\'s open work under the producer\'s own freshness (#760)', () => {
    test('a fresh pulse answers the owner\'s PR and the requested reviewer\'s review; a login or team is no seat', () => {
        const {state: freshness, seats} = source(state()).readOpenWork();
        const summary                   = {repo: 'acme/app', number: 7, head: 'a1', ci: 'red', verdict: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', draft: false};

        expect(freshness).toBe('ok');
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

    test('a partial pulse is still answered, and says so', () => {
        expect(source(state({coverage: 'partial'})).readOpenWork()).toMatchObject({state: 'ok', coverage: 'partial'})
    });
});

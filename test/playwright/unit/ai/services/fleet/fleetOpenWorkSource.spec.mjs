import {expect, test}              from '@playwright/test';
import {createFleetOpenWorkSource} from '../../../../../../ai/services/fleet/fleetOpenWorkSource.mjs';
import {normalizePullRequest}      from '../../../../../../ai/services/fleet/openWorkReducer.mjs';

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
            {state: freshness, seats, unobserved, awaitingMerge} = source(state()).readOpenWork(),
            summary = {repo: 'acme/app', number: 7, head: 'a1', ci: 'red', verdict: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', draft: false, reviews: [review], observedAt: OBSERVED, stale: false,
                holder: {role: 'author', ids: ['@neo-opus-ada']}};

        expect(freshness).toBe('ok');
        expect(unobserved).toBe(0);
        expect(seats).toEqual({
            '@neo-opus-ada': {authored: [summary], reviewing: []},
            '@neo-gpt'     : {authored: [], reviewing: [summary]}
        });
        expect(awaitingMerge).toEqual([])
    });

    test('awaitingMerge lists every row the operator holds, whoever owns it; a PR no seat owns is in no seat\'s lists (#779)', () => {
        const
            approved = (number, owner) => ({...row(number), ci: 'green', verdict: 'APPROVED', owner, requested: [], reviews: [{reviewer: '@neo-gpt', state: 'APPROVED', onHead: true}]}),
            read     = source(state({}, [
                approved(1, {kind: 'seat', seat: '@neo-opus-ada'}),
                approved(2, {kind: 'outside', seat: null, login: 'contributor'}),
                approved(3, {kind: 'unowned', seat: null, login: 'neo-gpt'}),
                row(4)
            ])).readOpenWork();

        expect(read.awaitingMerge.map(({number, holder}) => [number, holder.role])).toEqual([[1, 'operator'], [2, 'operator'], [3, 'operator']]);
        expect(read.seats['@neo-opus-ada'].authored.map(({number}) => number)).toEqual([1, 4]);
        // one seat's read still answers the operator's queue
        expect(source(state({}, [approved(2, {kind: 'outside', seat: null})])).readOpenWork({seat: '@neo-opus-vega'}).awaitingMerge.map(({number}) => number)).toEqual([2])
    });

    test('an awaiting-merge row ages by its own observation, and an unavailable projection awaits nothing (#779)', () => {
        const
            approved = (number, observedAt) => ({...row(number, observedAt), ci: 'green', verdict: 'APPROVED', requested: [], reviews: [{reviewer: '@neo-gpt', state: 'APPROVED', onHead: true}]}),
            partial  = state({observedAt: '2026-10-02T11:10:00.000Z', coverage: 'partial'}, [approved(7, '2026-10-02T11:10:00.000Z'), approved(8, '2026-10-02T11:00:00.000Z'), approved(9)]),
            read     = source(partial, 71).readOpenWork();

        // read at 11:11: 7 is current, 8 was last seen 11 minutes ago, 9 is past the unavailable bound
        expect(read.awaitingMerge.map(({number, stale}) => [number, stale])).toEqual([[7, false], [8, true]]);
        expect(read.unobserved).toBe(1);
        expect(source(state({}, [approved(7)]), 120).readOpenWork()).toMatchObject({state: 'unavailable', awaitingMerge: []})
    });

    test('a review list the producer read truncated keeps its visible approval out of awaitingMerge (#779)', () => {
        const
            identities = {byLogin: login => ({'neo-opus-ada': '@neo-opus-ada', 'neo-gpt': '@neo-gpt'})[login] ?? null, byName: name => ({Ada: '@neo-opus-ada'})[name] ?? null},
            // one visible approval of the head; `hasNextPage` says whether more reviews went unread
            node       = hasNextPage => ({
                number: 9, headRefOid: 'h9', reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', isDraft: false,
                body: 'Authored by Ada (Claude Opus 5.5, Claude Code).', author: {login: 'neo-opus-ada'}, repository: {nameWithOwner: 'acme/app'},
                reviewRequests: {pageInfo: {hasNextPage: false}, nodes: []},
                latestReviews : {pageInfo: {hasNextPage}, nodes: [{author: {login: 'neo-gpt'}, state: 'APPROVED', commit: {oid: 'h9'}}]},
                commits       : {nodes: [{commit: {oid: 'h9', statusCheckRollup: {state: 'SUCCESS'}}}]}
            }),
            read       = hasNextPage => source(state({}, [{...normalizePullRequest(node(hasNextPage), identities), observedAt: OBSERVED}])).readOpenWork();

        expect(read(false).awaitingMerge.map(({number, holder}) => [number, holder.role])).toEqual([[9, 'operator']]);
        expect(read(true).awaitingMerge).toEqual([]);
        expect(read(true).seats['@neo-opus-ada'].authored.map(({holder}) => holder)).toEqual([{role: 'unknown', ids: []}])
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

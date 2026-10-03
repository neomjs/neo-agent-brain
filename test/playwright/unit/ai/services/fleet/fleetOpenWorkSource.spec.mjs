import {expect, test}              from '@playwright/test';
import {createFleetOpenWorkSource} from '../../../../../../ai/services/fleet/fleetOpenWorkSource.mjs';
import {normalizePullRequest}      from '../../../../../../ai/services/fleet/openWorkReducer.mjs';

const
    OBSERVED = '2026-10-02T10:00:00.000Z',
    review   = {reviewer: '@neo-gpt', state: 'CHANGES_REQUESTED', onHead: true},
    row      = (number=7, observedAt=OBSERVED) => ({
        key  : `acme/app#${number}`, repo: 'acme/app', number, title: 'fix: the head goes green', head: 'a1', ci: 'red', verdict: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', draft: false,
        owner: {kind: 'seat', seat: '@neo-opus-ada'}, requested: ['@neo-gpt', 'login:outsider', 'team:acme/core'], reviews: [review], observedAt
    }),
    state    = (overrides={}, rows=[row()]) => ({snapshot: {rows: Object.fromEntries(rows.map(item => [item.key, item]))}, observedAt: OBSERVED, coverage: 'complete', reason: null, ...overrides}),
    at       = minutes => () => Date.parse(OBSERVED) + minutes * 60000,
    source   = (producerState, minutes=1) => createFleetOpenWorkSource({producer: {getState: () => producerState}, now: at(minutes)});

test.describe('fleetOpenWorkSource — each seat\'s open work under the producer\'s own freshness (#760)', () => {
    test('a fresh pulse answers the owner\'s PR and the requested reviewer\'s review; a login or team is no seat', () => {
        const {state: freshness, seats, unobserved, awaitingMerge} = source(state()).readOpenWork();

        const summary = {repo: 'acme/app', number: 7, title: 'fix: the head goes green', head: 'a1', ci: 'red', verdict: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', draft: false, reviews: [review], observedAt: OBSERVED, stale: false,
            holder: {role: 'author', ids: ['@neo-opus-ada']}};

        expect(freshness).toBe('ok');
        expect(unobserved).toBe(0);
        expect(seats).toEqual({
            '@neo-opus-ada': {authored: [summary], reviewing: []},
            '@neo-gpt'     : {authored: [], reviewing: [summary]}
        });
        expect(awaitingMerge).toEqual([])
    });

    test('a row stored before the snapshot carried titles answers with a null title', () => {
        const {title, ...untitled} = row();

        expect(source(state({}, [untitled])).readOpenWork().seats['@neo-opus-ada'].authored[0].title).toBeNull()
    });

    test('awaitingMerge lists every row the operator holds, whoever owns it; a PR no seat owns is in no seat\'s lists (#779)', () => {
        const
            approval = {reviewer: '@neo-gpt', state: 'APPROVED', onHead: true},
            approved = (number, owner) => ({...row(number), ci: 'green', verdict: 'APPROVED', owner, requested: [], reviews: [approval], opinions: [approval]}),
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
            approval = {reviewer: '@neo-gpt', state: 'APPROVED', onHead: true},
            approved = (number, observedAt) => ({...row(number, observedAt), ci: 'green', verdict: 'APPROVED', requested: [], reviews: [approval], opinions: [approval]}),
            partial  = state({observedAt: '2026-10-02T11:10:00.000Z', coverage: 'partial'}, [approved(7, '2026-10-02T11:10:00.000Z'), approved(8, '2026-10-02T11:00:00.000Z'), approved(9)]),
            read     = source(partial, 71).readOpenWork();

        // read at 11:11: 7 is current, 8 was last seen 11 minutes ago, 9 is past the unavailable bound
        expect(read.awaitingMerge.map(({number, stale}) => [number, stale])).toEqual([[7, false], [8, true]]);
        expect(read.unobserved).toBe(1);
        expect(source(state({}, [approved(7)]), 120).readOpenWork()).toMatchObject({state: 'unavailable', awaitingMerge: []})
    });

    test('the producer\'s rows: a list read short keeps an approval out of awaitingMerge, a later comment does not hide one (#779)', () => {
        const
            identities = {byLogin: login => ({'neo-opus-ada': '@neo-opus-ada', 'neo-gpt': '@neo-gpt'})[login] ?? null, byName: name => ({Ada: '@neo-opus-ada'})[name] ?? null},
            approval   = {author: {login: 'neo-gpt'}, state: 'APPROVED', commit: {oid: 'h9'}},
            // the reviewer's latest review and latest opinion of the head; `more…` says a list went unread past its page
            node       = ({latest=approval, opinion=approval, moreReviews=false, moreOpinions=false}={}) => ({
                number: 9, headRefOid: 'h9', reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', isDraft: false,
                body: 'Authored by Ada (Claude Opus 5.5, Claude Code).', author: {login: 'neo-opus-ada'}, repository: {nameWithOwner: 'acme/app'},
                reviewRequests          : {pageInfo: {hasNextPage: false}, nodes: []},
                latestReviews           : {pageInfo: {hasNextPage: moreReviews}, nodes: [latest]},
                latestOpinionatedReviews: {pageInfo: {hasNextPage: moreOpinions}, nodes: [opinion]},
                commits                 : {nodes: [{commit: {oid: 'h9', statusCheckRollup: {state: 'SUCCESS'}}}]}
            }),
            read       = overrides => source(state({}, [{...normalizePullRequest(node(overrides), identities), observedAt: OBSERVED}])).readOpenWork(),
            awaiting   = overrides => read(overrides).awaitingMerge.map(({number, holder}) => [number, holder.role]),
            commented  = {...approval, state: 'COMMENTED'};

        expect(awaiting()).toEqual([[9, 'operator']]);
        // more reviews or opinions went unread: the approval cannot be shown to stand alone
        expect(awaiting({moreReviews: true})).toEqual([]);
        expect(awaiting({moreOpinions: true})).toEqual([]);
        expect(read({moreReviews: true}).seats['@neo-opus-ada'].authored.map(({holder}) => holder)).toEqual([{role: 'unknown', ids: []}]);
        // the reviewer approved, then commented on the same head: the latest review is the comment
        expect(awaiting({latest: commented})).toEqual([[9, 'operator']]);
        // a change request survives a later comment the same way, and keeps the PR out of the queue
        expect(awaiting({latest: commented, opinion: {...approval, state: 'CHANGES_REQUESTED'}})).toEqual([])
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

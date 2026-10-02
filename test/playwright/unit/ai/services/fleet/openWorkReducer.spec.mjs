import {expect, test} from '@playwright/test';
import {
    normalizePullRequest,
    normalizeTerminal,
    reduceOpenWork
} from '../../../../../../ai/services/fleet/openWorkReducer.mjs';

const identities = {
    byLogin: login => ({'neo-opus-ada': '@neo-opus-ada', 'neo-gpt': '@neo-gpt', 'neo-gpt-emmy': '@neo-gpt-emmy'})[login] ?? null,
    byName : name  => ({Ada: '@neo-opus-ada', Euclid: '@neo-gpt', Emmy: '@neo-gpt-emmy'})[name] ?? null
};

/**
 * @summary One open search node in the query's shape.
 * @param {Object} [overrides]
 * @returns {Object}
 */
function node({number=7, head='a1', rollup='SUCCESS', verdict='REVIEW_REQUIRED', reviewers=['neo-gpt'], partial=false, body='Authored by Ada (Claude Opus 5, Claude Code).', login='neo-opus-ada'}={}) {
    return {
        number,
        headRefOid    : head,
        reviewDecision: verdict,
        mergeable     : 'MERGEABLE',
        isDraft       : false,
        body,
        author        : {login},
        repository    : {nameWithOwner: 'acme/app'},
        reviewRequests: {pageInfo: {hasNextPage: partial}, nodes: reviewers.map(reviewer => ({requestedReviewer: {__typename: 'User', login: reviewer}}))},
        commits       : {nodes: [{commit: {oid: head, statusCheckRollup: {state: rollup}}}]}
    }
}

/**
 * @summary Reduce a sequence of observations from a baseline, returning every pulse's transitions.
 * @param {Object[][]} pulses Each pulse's open nodes.
 * @returns {Object[][]}
 */
function run(pulses) {
    let previous = null;

    return pulses.map((nodes, index) => {
        const next = reduceOpenWork({
            previous,
            observed: {rows: nodes.map(item => normalizePullRequest(item, identities)), complete: true},
            terminal: {rows: [], complete: true},
            since   : null,
            id      : `p${index}`
        });

        previous = next;
        return next.transitions
    })
}

test.describe('openWorkReducer — transitions, never a holder-only diff (#760)', () => {
    test('the first pulse is the baseline, and an identical poll observes nothing', () => {
        expect(run([[node()], [node()], [node()]])).toEqual([[], [], []])
    });

    test('a verdict that changes under a red head is one transition, though the holder stays the author', () => {
        const [, changed] = run([[node({rollup: 'FAILURE', verdict: 'CHANGES_REQUESTED'})], [node({rollup: 'FAILURE', verdict: 'APPROVED'})]]);

        expect(changed.map(({kind, from, to}) => [kind, from, to])).toEqual([['verdict', 'CHANGES_REQUESTED', 'APPROVED']])
    });

    test('red, green, red on one head is two red episodes, each its own identity', () => {
        const
            pulses = run([[node()], [node({rollup: 'FAILURE'})], [node()], [node({rollup: 'FAILURE'})]]),
            reds   = pulses.flat().filter(change => change.kind === 'ci' && change.to === 'red');

        expect(reds).toHaveLength(2);
        expect(new Set(reds.map(change => change.id)).size).toBe(2)
    });

    test('two requested reviewers are two requests, and a truncated request list removes no one', () => {
        const [, requested] = run([[node({reviewers: []})], [node({reviewers: ['neo-gpt', 'neo-gpt-emmy']})]]);

        expect(requested.map(({kind, to}) => [kind, to])).toEqual([['review-requested', '@neo-gpt'], ['review-requested', '@neo-gpt-emmy']]);

        const [, truncated] = run([[node({reviewers: ['neo-gpt', 'neo-gpt-emmy']})], [node({reviewers: ['neo-gpt'], partial: true})]]);

        expect(truncated).toEqual([])
    });

    test('a PR opened after the baseline is an opened transition', () => {
        const [, opened] = run([[node()], [node(), node({number: 8})]]);

        expect(opened.map(({key, kind}) => [key, kind])).toEqual([['acme/app#8', 'opened']])
    });
});

test.describe('openWorkReducer — merges come from the terminal read, never from absence (#760)', () => {
    const
        baseline = reduceOpenWork({previous: null, observed: {rows: [normalizePullRequest(node(), identities)], complete: true}, terminal: {rows: [], complete: true}, since: null, id: 'p0'}),
        merged   = normalizeTerminal({number: 7, headRefOid: 'a1', state: 'MERGED', mergedAt: '2026-10-02T10:05:00Z', body: 'Authored by Ada (Claude).', author: {login: 'neo-opus-ada'}, repository: {nameWithOwner: 'acme/app'}}, identities);

    test('a PR missing from the open read is not a merge, and stays while a read was partial', () => {
        const next = reduceOpenWork({previous: baseline, observed: {rows: [], complete: false}, terminal: {rows: [], complete: true}, since: '2026-10-02T10:00:00Z', id: 'p1'});

        expect(next.transitions).toEqual([]);
        expect(Object.keys(next.rows)).toEqual(['acme/app#7'])
    });

    test('the terminal read records the merge once, even when the next pulse reads it again', () => {
        const
            first = reduceOpenWork({previous: baseline, observed: {rows: [], complete: true}, terminal: {rows: [merged], complete: true}, since: '2026-10-02T10:00:00Z', id: 'p1'}),
            again = reduceOpenWork({previous: first, observed: {rows: [], complete: true}, terminal: {rows: [merged], complete: true}, since: '2026-10-02T10:00:00Z', id: 'p2'});

        expect(first.transitions.map(({key, kind, owner}) => [key, kind, owner.seat])).toEqual([['acme/app#7', 'merged', '@neo-opus-ada']]);
        expect(first.rows).toEqual({});
        expect(again.transitions).toEqual([])
    });

    test('a merge older than the watermark was an earlier pulse\'s, and a PR merged between pulses is still recorded', () => {
        const
            old    = reduceOpenWork({previous: baseline, observed: {rows: [normalizePullRequest(node(), identities)], complete: true}, terminal: {rows: [{...merged, key: 'acme/app#3', at: '2026-10-02T09:00:00Z'}], complete: true}, since: '2026-10-02T10:00:00Z', id: 'p1'}),
            unseen = reduceOpenWork({previous: baseline, observed: {rows: [normalizePullRequest(node(), identities)], complete: true}, terminal: {rows: [{...merged, key: 'acme/app#9', number: 9}], complete: true}, since: '2026-10-02T10:00:00Z', id: 'p1'});

        expect(old.transitions).toEqual([]);
        expect(unseen.transitions.map(({key, kind}) => [key, kind])).toEqual([['acme/app#9', 'merged']])
    });
});

test.describe('openWorkReducer — the owner is the body line, never a silent login (#760)', () => {
    test('a resolvable line names the seat; an org account without one is unowned; any other account is outside', () => {
        expect(normalizePullRequest(node(), identities).owner).toEqual({kind: 'seat', seat: '@neo-opus-ada', login: 'neo-opus-ada'});
        expect(normalizePullRequest(node({body: 'No author line here.'}), identities).owner).toEqual({kind: 'unowned', seat: null, login: 'neo-opus-ada'});
        expect(normalizePullRequest(node({body: '', login: 'dependabot'}), identities).owner).toEqual({kind: 'outside', seat: null, login: 'dependabot'})
    });
});

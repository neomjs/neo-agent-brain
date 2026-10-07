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
function node({number=7, head='a1', rollup='SUCCESS', verdict='REVIEW_REQUIRED', reviewers=['neo-gpt'], partial=false, requests=true, reviews=[],
               body='Authored by Ada (Claude Opus 5, Claude Code).', login='neo-opus-ada', title}={}) {
    return {
        number,
        ...(title === undefined ? {} : {title}),
        headRefOid    : head,
        reviewDecision: verdict,
        mergeable     : 'MERGEABLE',
        isDraft       : false,
        body,
        author        : {login},
        repository    : {nameWithOwner: 'acme/app'},
        reviewRequests: requests ? {pageInfo: {hasNextPage: partial}, nodes: reviewers.map(reviewer => ({requestedReviewer: {__typename: 'User', login: reviewer}}))} : undefined,
        latestReviews : {pageInfo: {hasNextPage: false}, nodes: reviews},
        // each reviewer's standing approval or change request among the latest reviews
        latestOpinionatedReviews: {pageInfo: {hasNextPage: false}, nodes: reviews.filter(review => ['APPROVED', 'CHANGES_REQUESTED'].includes(review.state))},
        commits       : {nodes: [{commit: {oid: head, statusCheckRollup: {state: rollup}}}]}
    }
}

/**
 * @summary Reduce a sequence of observations from a baseline.
 * @param {Object[][]} pulses Each pulse's open nodes.
 * @returns {{transitions: Object[][], states: Object[]}}
 */
function run(pulses) {
    let previous = null;

    const states = pulses.map((nodes, index) => {
        const rows = nodes.map(item => normalizePullRequest(item, identities));

        return previous = reduceOpenWork({
            previous,
            observed: {rows, complete: true},
            terminal: {rows: [], complete: true},
            since   : null,
            id      : `p${index}`
        })
    });

    return {transitions: states.map(state => state.transitions), states}
}

test.describe('openWorkReducer — a row names its pull request by title', () => {
    test('the title is carried with its whitespace collapsed, a missing or blank one is null, and a retitled PR is no transition', () => {
        expect(normalizePullRequest(node({title: '  fix:\n the  head\tgoes green  '}), identities).title).toBe('fix: the head goes green');
        expect(normalizePullRequest(node(), identities).title).toBeNull();
        expect(normalizePullRequest(node({title: ' \n '}), identities).title).toBeNull();

        expect(run([[node({title: 'first words'})], [node({title: 'second words'})]]).transitions[1]).toEqual([])
    })
});

test.describe('openWorkReducer — transitions, never a holder-only diff (#760)', () => {
    test('the first pulse is the baseline, and an identical poll observes nothing', () => {
        expect(run([[node()], [node()], [node()]]).transitions).toEqual([[], [], []])
    });

    test('a verdict that changes under a red head is one transition, though the holder stays the author', () => {
        const [, changed] = run([[node({rollup: 'FAILURE', verdict: 'CHANGES_REQUESTED'})], [node({rollup: 'FAILURE', verdict: 'APPROVED'})]]).transitions;

        expect(changed.map(({kind, from, to}) => [kind, from, to])).toEqual([['verdict', 'CHANGES_REQUESTED', 'APPROVED']])
    });

    test('red, green, red on one head is two red episodes, each its own identity', () => {
        const reds = run([[node()], [node({rollup: 'FAILURE'})], [node()], [node({rollup: 'FAILURE'})]]).transitions.flat()
            .filter(change => change.kind === 'ci' && change.to === 'red');

        expect(reds).toHaveLength(2);
        expect(new Set(reds.map(change => change.id)).size).toBe(2)
    });

    test('two requested reviewers are two requests', () => {
        const [, requested] = run([[node({reviewers: []})], [node({reviewers: ['neo-gpt', 'neo-gpt-emmy']})]]).transitions;

        expect(requested.map(({kind, to}) => [kind, to])).toEqual([['review-requested', '@neo-gpt'], ['review-requested', '@neo-gpt-emmy']])
    });

    test('a truncated request list keeps the last complete baseline: unchanged invents nothing, a genuine removal is one', () => {
        const
            both      = ['neo-gpt', 'neo-gpt-emmy'],
            unchanged = run([[node({reviewers: both})], [node({reviewers: ['neo-gpt-emmy'], partial: true})], [node({reviewers: both})]]),
            removed   = run([[node({reviewers: both})], [node({reviewers: ['neo-gpt-emmy'], partial: true})], [node({reviewers: ['neo-gpt-emmy']})]]);

        expect(unchanged.transitions).toEqual([[], [], []]);
        // the partial pulse still projects both reviewers
        expect(unchanged.states[1].rows['acme/app#7'].requested).toEqual(['@neo-gpt', '@neo-gpt-emmy']);
        expect(removed.transitions[2].map(({kind, from}) => [kind, from])).toEqual([['review-removed', '@neo-gpt']])
    });

    test('a missing request list is unknown, never empty: the row is partial and removes no one', () => {
        const row = normalizePullRequest(node({requests: false}), identities);

        expect(row).toMatchObject({requested: [], requestsComplete: false, partial: true});
        expect(run([[node()], [node({requests: false})]]).transitions[1]).toEqual([])
    });

    test('a complete list holding an item that names no reviewer is unknown: the row is partial and removes no one', () => {
        const
            unnamed = {...node(), reviewRequests: {pageInfo: {hasNextPage: false}, nodes: [{requestedReviewer: null}, null]}},
            ghost   = {...node(), latestReviews: {pageInfo: {hasNextPage: false}, nodes: [{state: 'APPROVED', author: null, commit: {oid: 'a1'}}]}};

        expect(normalizePullRequest(unnamed, identities)).toMatchObject({requested: [], requestsComplete: false, partial: true});
        expect(run([[node({reviewers: ['neo-gpt', 'neo-gpt-emmy']})], [unnamed]]).transitions[1]).toEqual([]);
        expect(normalizePullRequest(ghost, identities)).toMatchObject({reviews: [], requestsComplete: true, partial: true})
    });

    test('a PR opened after the baseline is an opened transition with the reviews already requested on it, and every observed row carries its pulse', () => {
        const {transitions, states} = run([[node()], [node(), node({number: 8})]]);

        expect(transitions[1].map(({key, kind, to}) => [key, kind, to])).toEqual([['acme/app#8', 'opened', 'open'], ['acme/app#8', 'review-requested', '@neo-gpt']]);
        expect(Object.values(states[1].rows).map(row => row.observedAt)).toEqual(['p1', 'p1'])
    });

    test('a row first seen after a read that missed pages is no opened transition; its requested reviews are still reported', () => {
        const
            rows     = numbers => numbers.map(number => normalizePullRequest(node({number}), identities)),
            baseline = reduceOpenWork({previous: null, observed: {rows: rows([7]), complete: false}, terminal: {rows: [], complete: true}, since: null, id: 'p0'}),
            next     = reduceOpenWork({previous: baseline, observed: {rows: rows([7, 8]), complete: true}, terminal: {rows: [], complete: true}, since: null, id: 'p1'});

        expect(next.transitions.map(({key, kind, to}) => [key, kind, to])).toEqual([['acme/app#8', 'review-requested', '@neo-gpt']])
    });

    test('a verdict names the reviewers whose standing opinion became it, a dismissal names none, and a push carries the verdict it landed on (#919)', () => {
        const
            review        = (state, oid) => [{state, author: {login: 'neo-gpt'}, commit: {oid}}],
            {transitions} = run([
                [node({verdict: 'REVIEW_REQUIRED'})],
                [node({verdict: 'CHANGES_REQUESTED', reviews: review('CHANGES_REQUESTED', 'a1')})],
                [node({head: 'b2', verdict: 'CHANGES_REQUESTED', reviews: review('CHANGES_REQUESTED', 'a1')})],
                [node({head: 'b2', verdict: 'APPROVED', reviews: review('APPROVED', 'b2')})],
                [node({head: 'b2', verdict: 'REVIEW_REQUIRED'})]
            ]),
            pick          = list => list.map(({kind, to, by, verdict}) => ({kind, to, ...(by ? {by} : {}), ...(verdict !== undefined ? {verdict} : {})}));

        expect(transitions.slice(1).map(pick)).toEqual([
            [{kind: 'verdict', to: 'CHANGES_REQUESTED', by: ['@neo-gpt']}],
            [{kind: 'head', to: 'b2', verdict: 'CHANGES_REQUESTED'}],
            [{kind: 'verdict', to: 'APPROVED', by: ['@neo-gpt']}],
            [{kind: 'verdict', to: 'REVIEW_REQUIRED', by: []}]
        ])
    });

    test('a re-approval on the current head names its reviewer, and opinions a read did not cover name no one (#919)', () => {
        const
            approval = oid => [{state: 'APPROVED', author: {login: 'neo-gpt'}, commit: {oid}}],
            cut      = item => ({...item, latestOpinionatedReviews: {...item.latestOpinionatedReviews, pageInfo: {hasNextPage: true}}}),
            verdicts = pulses => run(pulses).transitions.slice(1).map(list => list.filter(({kind}) => kind === 'verdict').map(({to, by}) => ({to, by}))),
            reduce   = (previous, item, id) => reduceOpenWork({previous, observed: {rows: [normalizePullRequest(item, identities)], complete: true}, terminal: {rows: [], complete: true}, since: null, id});

        // the standing approval judged an older commit, and the reviewer approves the current head again
        expect(verdicts([[node({head: 'b2', verdict: 'REVIEW_REQUIRED', reviews: approval('a1')})], [node({head: 'b2', verdict: 'APPROVED', reviews: approval('b2')})]]))
            .toEqual([[{to: 'APPROVED', by: ['@neo-gpt']}]]);
        // the earlier read cut its opinions at the first page, so the approval may have stood unseen
        expect(verdicts([[cut(node({verdict: 'REVIEW_REQUIRED'}))], [node({verdict: 'APPROVED', reviews: approval('a1')})]]))
            .toEqual([[{to: 'APPROVED', by: []}]]);

        // a row saved before opinions carried their coverage holds no such fact
        const saved = reduce(null, node({verdict: 'REVIEW_REQUIRED'}), 'p0');

        delete saved.rows['acme/app#7'].opinionsComplete;
        expect(reduce(saved, node({verdict: 'APPROVED', reviews: approval('a1')}), 'p1').transitions.filter(({kind}) => kind === 'verdict').map(({by}) => by)).toEqual([[]]);

        // control: a push and an approval in one pulse are both observed
        expect(run([[node({verdict: 'CHANGES_REQUESTED', reviews: [{state: 'CHANGES_REQUESTED', author: {login: 'neo-gpt'}, commit: {oid: 'a1'}}]})], [node({head: 'b2', verdict: 'APPROVED', reviews: approval('b2')})]])
            .transitions[1].filter(({kind}) => kind === 'head' || kind === 'verdict').map(({kind, verdict, by}) => kind === 'head' ? {kind, verdict} : {kind, by}))
            .toEqual([{kind: 'head', verdict: 'CHANGES_REQUESTED'}, {kind: 'verdict', by: ['@neo-gpt']}])
    });

    test('each reviewer\'s latest review is kept, and whether it judged the current head', () => {
        const row = normalizePullRequest(node({head: 'b2', reviews: [
            {state: 'APPROVED', author: {login: 'neo-gpt'}, commit: {oid: 'b2'}},
            {state: 'CHANGES_REQUESTED', author: {login: 'neo-gpt-emmy'}, commit: {oid: 'a1'}}
        ]}), identities);

        expect(row.reviews).toEqual([
            {reviewer: '@neo-gpt', state: 'APPROVED', onHead: true},
            {reviewer: '@neo-gpt-emmy', state: 'CHANGES_REQUESTED', onHead: false}
        ])
    });
});

test.describe('openWorkReducer — merges come from the terminal read, never from absence (#760)', () => {
    const
        base     = () => reduceOpenWork({previous: null, observed: {rows: [normalizePullRequest(node(), identities)], complete: true}, terminal: {rows: [], complete: true}, since: null, id: 'p0'}),
        terminal = (state, at, number=7) => normalizeTerminal({number, headRefOid: 'a1', state, mergedAt: state === 'MERGED' ? at : null, closedAt: at, body: 'Authored by Ada (Claude).', author: {login: 'neo-opus-ada'}, repository: {nameWithOwner: 'acme/app'}}, identities),
        pulse    = (previous, {open=[], ended=[], observedComplete=true, id}) => reduceOpenWork({
            previous, observed: {rows: open.map(item => normalizePullRequest(item, identities)), complete: observedComplete}, terminal: {rows: ended, complete: true}, since: '2026-10-02T10:00:00Z', id
        });

    test('a PR missing from the open read is not a merge, and stays with its own observation time while a read was partial', () => {
        const next = pulse(base(), {observedComplete: false, id: 'p1'});

        expect(next.transitions).toEqual([]);
        expect(next.rows['acme/app#7'].observedAt).toBe('p0')
    });

    test('a PR missing from complete reads with no terminal row leaves as vanished, never as a close', () => {
        expect(pulse(base(), {id: 'p1'})).toMatchObject({transitions: [], rows: {}, vanished: ['acme/app#7']})
    });

    test('a row a missed seat could have read carries through complete reads, and one first seen after the miss is no opened (#916)', () => {
        const
            euclid = number => node({number, body: 'Authored by Euclid (GPT 5, Codex).', login: 'neo-gpt', reviewers: []}),
            reduce = (previous, open, missed, id) => reduceOpenWork({
                previous, observed: {rows: open.map(item => normalizePullRequest(item, identities)), complete: true, missed}, terminal: {rows: [], complete: true}, since: null, id
            }),
            p0     = reduce(null, [node(), euclid(9)], [], 'p0'),
            p1     = reduce(p0, [node()], ['@neo-gpt'], 'p1'),
            p2     = reduce(p1, [node(), euclid(9), euclid(10), node({number: 8, reviewers: []})], [], 'p2'),
            p3     = reduce(p2, [node(), euclid(10), node({number: 8, reviewers: []})], [], 'p3');

        expect(p1).toMatchObject({transitions: [], vanished: [], missed: ['@neo-gpt']});
        expect(p1.rows['acme/app#9'].observedAt).toBe('p0');
        // Euclid's new row may only have been unread; Ada's was not, so it opened
        expect(p2.transitions.map(({key, kind}) => [key, kind])).toEqual([['acme/app#8', 'opened']]);
        // control: once the seat reads every page again, absence is evidence
        expect(p3.vanished).toEqual(['acme/app#9'])
    });

    test('the terminal read records the merge once, even when the next pulse reads it again', () => {
        const
            merged = terminal('MERGED', '2026-10-02T10:05:00Z'),
            first  = pulse(base(), {ended: [merged], id: 'p1'}),
            again  = pulse(first, {ended: [merged], id: 'p2'});

        expect(first.transitions.map(({key, kind, owner}) => [key, kind, owner.seat])).toEqual([['acme/app#7', 'merged', '@neo-opus-ada']]);
        expect(first.rows).toEqual({});
        expect(again.transitions).toEqual([])
    });

    test('close, reopen, close under a held watermark: two closes, each once, each replay deduped', () => {
        const
            closed1  = pulse(base(), {ended: [terminal('CLOSED', '2026-10-02T10:05:00Z')], id: 'p1'}),
            reopened = pulse(closed1, {open: [node()], id: 'p2'}),
            closed2  = pulse(reopened, {ended: [terminal('CLOSED', '2026-10-02T10:20:00Z')], id: 'p3'}),
            replay   = pulse(closed2, {ended: [terminal('CLOSED', '2026-10-02T10:20:00Z')], id: 'p4'});

        expect([closed1, reopened, closed2, replay].map(state => state.transitions.map(({kind}) => kind))).toEqual([['closed'], ['opened', 'review-requested'], ['closed'], []])
    });

    test('a merge older than the watermark was an earlier pulse\'s, and a PR merged between pulses is still recorded', () => {
        const
            old    = pulse(base(), {open: [node()], ended: [terminal('MERGED', '2026-10-02T09:00:00Z', 3)], id: 'p1'}),
            unseen = pulse(base(), {open: [node()], ended: [terminal('MERGED', '2026-10-02T10:05:00Z', 9)], id: 'p1'});

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

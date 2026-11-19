import {expect, test}          from '@playwright/test';
import {holderOf, responderOf} from '../../../../../../ai/services/fleet/openWorkHolder.mjs';

const CI_HEAD          = 'a'.repeat(40), CI_KEY = '1'.repeat(64);
const ciEvidence       = (extra = {}) => ({head: CI_HEAD, key: CI_KEY, failedChecks: ['unit'], ...extra});
const ciClassification = (kind, extra = {}) => ({head: CI_HEAD, evidenceKey: CI_KEY, kind,
    maintainer: '@neo-opus-grace', receiptUrl: 'https://github.com/acme/app/pull/7#issuecomment-101', ...extra});

const
    seat    = {kind: 'seat', seat: '@neo-opus-ada', login: 'neo-opus-ada'},
    outside = {kind: 'outside', seat: null, login: 'contributor'},
    review  = (state, onHead=true) => ({reviewer: '@neo-gpt', state, onHead}),
    // an approval or change request is both the reviewer's latest review and their latest opinion
    judged  = (state, onHead=true) => ({reviews: [review(state, onHead)], opinions: [review(state, onHead)]}),
    // a fully read row: every issue the PR closes was read, and none is blocked
    row     = overrides => ({ci: 'green', verdict: null, mergeable: 'MERGEABLE', draft: false, owner: seat, requested: [], reviews: [], opinions: [],
        blockedTargets: [], targetsComplete: true, ...overrides});

test.describe('openWorkHolder — the shared holder and next-action kind, first match wins (#761)', () => {
    test('an eligible outside PR routes to rotation for triage-outside when finished and untouched, or approve-runs when runs await approval (#1008)', () => {
        expect(holderOf(row({owner: outside}))).toEqual({role: 'rotation', kind: 'triage-outside', ids: []});
        expect(holderOf(row({owner: outside, ci: 'red'}))).toEqual({role: 'rotation', kind: 'triage-outside', ids: []});
        expect(holderOf(row({owner: outside, ci: 'pending'}))).toEqual({role: 'none', kind: null, ids: []});
        expect(holderOf(row({owner: outside, ci: 'pending', runApproval: 'action_required'})))
            .toEqual({role: 'rotation', kind: 'approve-runs', ids: []});
        expect(holderOf(row({owner: outside, ci: 'red', runApproval: 'action_required', reviews: [review('COMMENTED')]})))
            .toEqual({role: 'rotation', kind: 'approve-runs', ids: []});
        expect(holderOf(row({owner: outside, requested: ['@neo-gpt']}))).toEqual({role: 'reviewer', kind: 'review', ids: ['@neo-gpt']});
        // A comment counts as engagement for triage-outside, and gives an outside author no seat-owned routing action.
        expect(holderOf(row({owner: outside, reviews: [review('COMMENTED')]}))).toEqual({role: 'none', kind: null, ids: []});
        // Drafts, bots, and maintainer associations do not produce outside rotation actions.
        expect(holderOf(row({owner: outside, draft: true, runApproval: 'action_required'}))).toEqual({role: 'none', kind: null, ids: []});
        expect(holderOf(row({owner: outside, bot: true}))).toEqual({role: 'none', kind: null, ids: []});
        expect(holderOf(row({owner: outside, authorType: 'Bot', runApproval: 'action_required'}))).toEqual({role: 'none', kind: null, ids: []});
        for (const authorAssociation of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
            expect(holderOf(row({owner: outside, authorAssociation}))).toEqual({role: 'none', kind: null, ids: []});
            expect(holderOf(row({owner: outside, authorAssociation, runApproval: 'action_required'}))).toEqual({role: 'none', kind: null, ids: []})
        }
    });

    test('a bot\'s review is no touch: an outside row reviewed on its head only by a bot still goes to the rotation (#1629)', () => {
        const bot = {reviewer: 'login:copilot-pull-request-reviewer', state: 'COMMENTED', onHead: true, bot: true};

        expect(holderOf(row({owner: outside, reviews: [bot]}))).toEqual({role: 'rotation', kind: 'triage-outside', ids: []});
        expect(holderOf(row({owner: outside, ci: 'red', reviews: [bot]}))).toEqual({role: 'rotation', kind: 'triage-outside', ids: []});
        // a seat's comment beside the bot's is still engagement
        expect(holderOf(row({owner: outside, reviews: [bot, review('COMMENTED')]}))).toEqual({role: 'none', kind: null, ids: []})
    });

    test('red CI on a mergeable head keeps the repair action across verdicts', () => {
        const repair = {role: 'author', kind: 'repair-ci', ids: ['@neo-opus-ada']};

        expect(holderOf(row({ci: 'red'}))).toEqual(repair);
        expect(holderOf(row({ci: 'red', ...judged('APPROVED')}))).toEqual(repair);
        expect(holderOf(row({ci: 'red', ...judged('CHANGES_REQUESTED')}))).toEqual(repair);
        expect(holderOf(row({ci: 'red', owner: {kind: 'unowned', seat: null, login: 'neo-gpt'}})))
            .toEqual({role: 'author', kind: 'repair-ci', ids: []})
    });

    test('pending CI retains a positive on-head change request, including on a partial row', () => {
        for (const partial of [false, true]) {
            expect(holderOf(row({ci: 'pending', ...judged('CHANGES_REQUESTED'), partial})))
                .toEqual({role: 'author', kind: 'address-changes', ids: ['@neo-opus-ada']});
            expect(holderOf(row({ci: 'pending', ...judged('CHANGES_REQUESTED', false), partial})))
                .toEqual({role: partial ? 'unknown' : 'none', kind: null, ids: []})
        }
    });

    test('the same author has distinct actions through pending, red, green, then red on one head', () => {
        expect(['pending', 'red', 'green', 'red'].map(ci => holderOf(row({head: 'h1', ci}))))
            .toEqual([
                {role: 'none', kind: null, ids: []},
                {role: 'author', kind: 'repair-ci', ids: ['@neo-opus-ada']},
                {role: 'author', kind: 'route-review', ids: ['@neo-opus-ada']},
                {role: 'author', kind: 'repair-ci', ids: ['@neo-opus-ada']}
            ])
    });

    test('a change request the author has pushed past, with the review requested again, is the reviewer\'s', () => {
        expect(holderOf(row({verdict: 'CHANGES_REQUESTED', ...judged('CHANGES_REQUESTED', false), requested: ['@neo-gpt']})))
            .toEqual({role: 'reviewer', kind: 'review', ids: ['@neo-gpt']})
    });

    test('a green head with reviews requested is each requested reviewer\'s before the merge chip', () => {
        expect(holderOf(row({requested: ['@neo-gpt', 'team:acme/core']})))
            .toEqual({role: 'reviewer', kind: 'review', ids: ['@neo-gpt', 'team:acme/core']});
        expect(holderOf(row({...judged('APPROVED'), requested: ['@neo-gpt']})))
            .toEqual({role: 'reviewer', kind: 'review', ids: ['@neo-gpt']})
    });

    test('a current approval and a confirmed conflict route integration before a requested review', () => {
        const conflict = {...judged('APPROVED'), mergeable: 'CONFLICTING', requested: ['@neo-gpt']};

        expect(holderOf(row(conflict))).toEqual({role: 'author', kind: 'rebase', ids: ['@neo-opus-ada']});
        const red = {...conflict, ci: 'red'}, repair = {role: 'author', kind: 'repair-ci', ids: [seat.seat]};
        expect(holderOf(row(red))).toEqual({role: 'author', kind: 'rebase', ids: [seat.seat]});
        expect(holderOf(row({...red, owner: {kind: 'unowned', seat: null, login: 'org-user'}})))
            .toEqual({role: 'author', kind: 'rebase', ids: []});
        for (const reviewer of [{bot: true}, {reviewer: seat.seat}, {reviewer: 'login:outside'}]) {
            expect(holderOf(row({...red, opinions: [{...red.opinions[0], ...reviewer}]}))).toEqual(repair)
        }
        for (const overrides of [{draft: true}, {partial: true}, judged('APPROVED', false),
            {opinions: [...red.opinions, {...review('CHANGES_REQUESTED'), reviewer: '@peer'}]}]) {
            expect(holderOf(row({...red, ...overrides}))).toEqual(repair)
        }
        expect(holderOf(row({...conflict, ...judged('CHANGES_REQUESTED')})))
            .toEqual({role: 'author', kind: 'address-changes', ids: ['@neo-opus-ada']});
        expect(holderOf(row({...conflict, ...judged('APPROVED', false)})))
            .toEqual({role: 'reviewer', kind: 'review', ids: ['@neo-gpt']});
        expect(holderOf(row({...conflict, ci: 'pending'}))).toEqual({role: 'none', kind: null, ids: []});
        expect(holderOf(row({...conflict, partial: true}))).toEqual({role: 'unknown', kind: null, ids: []})
    });

    test('review routing belongs to a green non-draft PR without an on-head opinion or request, owned by a seat or by no seat (#807)', () => {
        const routing = {role: 'author', kind: 'route-review', ids: ['@neo-opus-ada']};

        expect(holderOf(row({}))).toEqual(routing);
        expect(holderOf(row({reviews: [review('COMMENTED')]}))).toEqual(routing);
        for (const state of ['APPROVED', 'CHANGES_REQUESTED']) {
            expect(holderOf(row({verdict: state, ...judged(state, false)}))).toEqual(routing)
        }

        expect(holderOf(row({draft: true}))).toEqual({role: 'none', kind: null, ids: []});
        // an unowned org PR owes the same routing, with nobody to hold it: the wake path escalates it
        expect(holderOf(row({owner: {kind: 'unowned', seat: null, login: 'neo-gpt'}})))
            .toEqual({role: 'author', kind: 'route-review', ids: []});
        expect(holderOf(row({owner: {kind: 'unowned', seat: null, login: 'neo-gpt'}, draft: true})))
            .toEqual({role: 'none', kind: null, ids: []});
        expect(holderOf(row({owner: {kind: 'seat', seat: null, login: 'neo-opus-ada'}})))
            .toEqual({role: 'none', kind: null, ids: []});
        expect(holderOf(row({ci: 'pending'}))).toEqual({role: 'none', kind: null, ids: []});
        expect(holderOf(row({ci: null}))).toEqual({role: 'none', kind: null, ids: []})
    });

    test('a green, mergeable head approved on the head is the operator\'s merge chip, and names nobody', () => {
        expect(holderOf(row({verdict: 'APPROVED', ...judged('APPROVED')})))
            .toEqual({role: 'operator', kind: 'merge', ids: []})
    });

    test('a head that reports no CI is the operator\'s merge chip only when GitHub calls it CLEAN, approved on the head, with no review requested (#1221)', () => {
        const
            approved = {ci: null, verdict: 'APPROVED', ...judged('APPROVED')},
            merge    = {role: 'operator', kind: 'merge', ids: []},
            none     = {role: 'none', kind: null, ids: []};

        expect(holderOf(row({...approved, mergeState: 'CLEAN'}))).toEqual(merge);

        for (const mergeState of ['BLOCKED', 'UNSTABLE', 'BEHIND', 'UNKNOWN', null, undefined]) {
            expect(holderOf(row({...approved, mergeState}))).toEqual(none)
        }

        // CLEAN where the repository requires no review is not readiness without an approval on the head
        expect(holderOf(row({ci: null, mergeState: 'CLEAN'}))).toEqual(none);
        expect(holderOf(row({ci: null, mergeState: 'CLEAN', ...judged('APPROVED', false)}))).toEqual(none);
        expect(holderOf(row({...approved, mergeState: 'CLEAN', requested: ['@neo-gpt']}))).toEqual(none);
        expect(holderOf(row({...approved, mergeState: 'CLEAN', draft: true}))).toEqual(none);
        expect(holderOf(row({...approved, mergeState: 'CLEAN', mergeable: 'UNKNOWN'}))).toEqual(none);
        expect(holderOf(row({...approved, mergeState: 'CLEAN', partial: true}))).toEqual({role: 'unknown', kind: null, ids: []});

        // a change request on the head stays the author's, a pending head waits for its CI, and the green path ignores the merge state
        expect(holderOf(row({ci: null, mergeState: 'CLEAN', ...judged('CHANGES_REQUESTED')})))
            .toEqual({role: 'author', kind: 'address-changes', ids: ['@neo-opus-ada']});
        expect(holderOf(row({...approved, ci: 'pending', mergeState: 'CLEAN'}))).toEqual(none);
        expect(holderOf(row({...approved, ci: 'green', mergeState: 'BLOCKED'}))).toEqual(merge)
    });

    test('an opinion survives the reviewer\'s later comment: the opinion list decides, not the latest review', () => {
        const commented = {reviews: [review('COMMENTED')]};

        expect(holderOf(row({...commented, opinions: [review('APPROVED')]}))).toEqual({role: 'operator', kind: 'merge', ids: []});
        expect(holderOf(row({...commented, opinions: [review('CHANGES_REQUESTED')]})))
            .toEqual({role: 'author', kind: 'address-changes', ids: ['@neo-opus-ada']});
        expect(holderOf(row({...judged('APPROVED'), opinions: undefined}))).toEqual({role: 'unknown', kind: null, ids: []})
    });

    test('a draft or unknown mergeability does not offer an approved head for merge or review routing', () => {
        const approved = {verdict: 'APPROVED', ...judged('APPROVED')};

        expect(holderOf(row({...approved, draft: true}))).toEqual({role: 'none', kind: null, ids: []});
        expect(holderOf(row({...approved, mergeable: 'UNKNOWN'}))).toEqual({role: 'none', kind: null, ids: []});
        expect(holderOf(row({ci: 'pending', ...approved}))).toEqual({role: 'none', kind: null, ids: []})
    });

    test('a partial read decides only on positive evidence; an absence a missing page could hold is unknown', () => {
        const unknown = {role: 'unknown', kind: null, ids: []};

        expect(holderOf(row({verdict: 'APPROVED', ...judged('APPROVED'), partial: true}))).toEqual(unknown);
        expect(holderOf(row({owner: outside, partial: true}))).toEqual(unknown);
        expect(holderOf(row({requested: ['@neo-gpt'], partial: true}))).toEqual(unknown);
        expect(holderOf(row({partial: true}))).toEqual(unknown);
        expect(holderOf(row({ci: 'red', partial: true}))).toEqual({role: 'author', kind: 'repair-ci', ids: ['@neo-opus-ada']});
        expect(holderOf(row({owner: outside, ci: 'red', partial: true}))).toEqual({role: 'rotation', kind: 'repair-ci', ids: []});
        expect(holderOf(row({...judged('CHANGES_REQUESTED'), partial: true})))
            .toEqual({role: 'author', kind: 'address-changes', ids: ['@neo-opus-ada']})
    });
});

test.describe('openWorkHolder — an outside PR pushed past a seat\'s review is that seat\'s Round 2 (#1642)', () => {
    const
        A      = '@neo-gpt',
        B      = '@neo-gpt-euclid',
        C      = '@neo-opus-vega',
        by     = (reviewer, state, onHead=false) => ({reviewer, state, onHead}),
        pushed = overrides => row({owner: outside, ...overrides}),
        past   = (reviewer, state) => ({reviews: [by(reviewer, state)], opinions: [by(reviewer, state)]});

    test('past a seat\'s review, a red outside head needs maintainer classification and a green one returns to its reviewer (AC-1)', () => {
        for (const state of ['CHANGES_REQUESTED', 'APPROVED']) {
            expect(holderOf(pushed({ci: 'pending', ...past(B, state)})), state).toEqual({role: 'none', kind: null, ids: []});
            expect(holderOf(pushed({ci: 'red', ...past(B, state)})), state).toEqual({role: 'rotation', kind: 'repair-ci', ids: []});
            expect(holderOf(pushed({...past(B, state)})), state).toEqual({role: 'reviewer', kind: 'review', ids: [B]})
        }
    });

    test('a comment alone names its seat, and a requested seat joins a change request (AC-2)', () => {
        expect(holderOf(pushed({reviews: [by(A, 'COMMENTED')]}))).toEqual({role: 'reviewer', kind: 'review', ids: [A]});
        expect(holderOf(pushed({requested: [C], ...past(B, 'CHANGES_REQUESTED')}))).toEqual({role: 'reviewer', kind: 'review', ids: [C, B]});
        // a stale approval is no blocker: a review a maintainer requested stands alone beside it
        expect(holderOf(pushed({requested: [C], ...past(B, 'APPROVED')}))).toEqual({role: 'reviewer', kind: 'review', ids: [C]})
    });

    test('A commented and B requested changes on H1: H2 is B\'s, nobody\'s once B comments on it while A\'s comment remains, and H3 is B\'s again (AC-2)', () => {
        const
            stands = [by(B, 'CHANGES_REQUESTED')],
            onH2   = [by(A, 'COMMENTED'), by(B, 'COMMENTED', true)];

        expect(holderOf(pushed({reviews: [by(A, 'COMMENTED'), by(B, 'CHANGES_REQUESTED')], opinions: stands}))).toEqual({role: 'reviewer', kind: 'review', ids: [B]});
        expect(holderOf(pushed({reviews: onH2, opinions: stands}))).toEqual({role: 'none', kind: null, ids: []});
        expect(holderOf(pushed({requested: [C], reviews: onH2, opinions: stands})), 'a requested seat still holds it').toEqual({role: 'reviewer', kind: 'review', ids: [C]});
        expect(holderOf(pushed({reviews: [by(A, 'COMMENTED'), by(B, 'COMMENTED')], opinions: stands}))).toEqual({role: 'reviewer', kind: 'review', ids: [B]})
    });

    test('with no seat on an earlier head an outside PR stays untouched, and run approval, a seat\'s own PR and an approval on the new head keep their routes (AC-3)', () => {
        const login = by('login:tobiu', 'CHANGES_REQUESTED');

        expect(holderOf(pushed({reviews: [login], opinions: [login]}))).toEqual({role: 'rotation', kind: 'triage-outside', ids: []});
        expect(holderOf(pushed({reviews: [{...by('login:copilot', 'COMMENTED'), bot: true}]}))).toEqual({role: 'rotation', kind: 'triage-outside', ids: []});
        expect(holderOf(pushed({ci: 'pending', runApproval: 'action_required', ...past(B, 'CHANGES_REQUESTED')})))
            .toEqual({role: 'rotation', kind: 'approve-runs', ids: []});
        // a seat's own PR keeps route-review: its author answers the review before requesting it again
        expect(holderOf(row({...past(B, 'CHANGES_REQUESTED')}))).toEqual({role: 'author', kind: 'route-review', ids: ['@neo-opus-ada']});
        expect(holderOf(pushed({reviews: [by(A, 'APPROVED', true)], opinions: [by(A, 'APPROVED', true), by(B, 'CHANGES_REQUESTED')]})))
            .toEqual({role: 'operator', kind: 'merge', ids: []});
        expect(holderOf(pushed({...past(B, 'CHANGES_REQUESTED'), partial: true}))).toEqual({role: 'unknown', kind: null, ids: []})
    });
});

test.describe('openWorkHolder — a Round-2 comment that keeps a change request leaves the author its action (#1851)', () => {
    const
        B      = '@neo-gpt-euclid',
        C      = '@neo-opus-vega',
        by     = (reviewer, state, onHead=false) => ({reviewer, state, onHead}),
        stands = [by(B, 'CHANGES_REQUESTED')],
        // B requested changes on an earlier head, then reviewed this one with a comment: the request still stands
        round2 = {reviews: [by(B, 'CHANGES_REQUESTED'), by(B, 'COMMENTED', true)], opinions: stands};

    test('a seat that reviewed this head and kept its change request leaves the author addressing it (AC-1)', () => {
        expect(holderOf(row(round2))).toEqual({role: 'author', kind: 'address-changes', ids: ['@neo-opus-ada']});
        expect(holderOf(row({...round2, owner: {kind: 'unowned'}}))).toEqual({role: 'author', kind: 'address-changes', ids: []})
    });

    test('a head pushed past the comment, a re-request, an approval on the head and an outside PR keep their routes (AC-2 to AC-4)', () => {
        expect(holderOf(row({reviews: [by(B, 'CHANGES_REQUESTED'), by(B, 'COMMENTED')], opinions: stands})), 'pushed past it')
            .toEqual({role: 'author', kind: 'route-review', ids: ['@neo-opus-ada']});
        expect(holderOf(row({...round2, requested: [B]})), 're-requested on this head').toEqual({role: 'reviewer', kind: 'review', ids: [B]});
        expect(holderOf(row({reviews: [...round2.reviews, by(C, 'APPROVED', true)], opinions: [...stands, by(C, 'APPROVED', true)]})), 'approved on the head')
            .toEqual({role: 'operator', kind: 'merge', ids: []});
        expect(holderOf(row({...round2, owner: outside})), 'an outside PR').toEqual({role: 'none', kind: null, ids: []})
    });
});

test.describe('openWorkHolder — an outside PR that names a model needs an approval from another lab', () => {
    const
        CLAUDE   = '@neo-opus-vega',
        GPT      = '@neo-gpt',
        families = {[CLAUDE]: 'claude', [GPT]: 'gpt'},
        approved = reviewer => ({reviews: [{reviewer, state: 'APPROVED', onHead: true}], opinions: [{reviewer, state: 'APPROVED', onHead: true}]}),
        named    = overrides => row({owner: outside, disclosedFamilies: ['claude'], ...overrides}),
        merge    = {role: 'operator', kind: 'merge', ids: []},
        review   = {role: 'rotation', kind: 'review', ids: []};

    test('a same-lab head approval leaves the review to a rotation seat; another lab\'s approval ends it', () => {
        expect(holderOf(named(approved(CLAUDE)), {seatFamilies: families})).toEqual(review);
        expect(holderOf(named(approved(GPT)), {seatFamilies: families})).toEqual(merge)
    });

    test('without the seats\' families, or from a seat of unknown family, no approval is verified', () => {
        // the wake round's first pass has no family map: an approval it cannot verify still plans, so the round reads
        // the families and decides again instead of settling on an approved head
        expect(holderOf(named(approved(GPT)))).toEqual(review);
        expect(holderOf(named(approved('@neo-new-seat')), {seatFamilies: families})).toEqual(review)
    });

    test('an outside PR that names nothing, and a member\'s PR, keep their routes', () => {
        expect(holderOf(named({disclosedFamilies: [], ...approved(CLAUDE)}), {seatFamilies: families})).toEqual(merge);
        expect(holderOf(named({authorAssociation: 'MEMBER', ...approved(CLAUDE)}), {seatFamilies: families})).toEqual(merge);
        expect(holderOf(row({disclosedFamilies: ['claude'], ...approved(CLAUDE)}), {seatFamilies: families})).toEqual(merge)
    });

    test('a same-lab approval past a seat\'s change request leaves that seat its Round 2', () => {
        const pr = named({
            reviews : [{reviewer: GPT, state: 'CHANGES_REQUESTED', onHead: false}, {reviewer: CLAUDE, state: 'APPROVED', onHead: true}],
            opinions: [{reviewer: GPT, state: 'CHANGES_REQUESTED', onHead: false}, {reviewer: CLAUDE, state: 'APPROVED', onHead: true}]
        });

        expect(holderOf(pr, {seatFamilies: families})).toEqual({role: 'reviewer', kind: 'review', ids: [GPT]})
    })
});

test.describe('openWorkHolder — a close target still blocked holds the merge for its author (#1768)', () => {
    const
        approved = overrides => row({...judged('APPROVED'), ...overrides}),
        blocked  = {blockedTargets: ['neomjs/neo-pro#275']},
        held     = {role: 'author', kind: 'await-prerequisite', ids: ['@neo-opus-ada'], targets: ['neomjs/neo-pro#275']};

    test('an approved, green head whose close target has an open blocker is its author\'s, never the operator\'s merge (AC-1)', () => {
        expect(holderOf(approved(blocked))).toEqual(held);
        expect(holderOf(approved({ci: null, mergeState: 'CLEAN', ...blocked}))).toEqual(held);
        // an outside author holds no seat, so the hold names nobody
        expect(holderOf(approved({owner: outside, ...blocked}))).toEqual({...held, ids: []})
    });

    test('once the blocker closes, the next read hands the head to the merge (AC-2)', () => {
        expect(holderOf(approved({blockedTargets: [], targetsComplete: true}))).toEqual({role: 'operator', kind: 'merge', ids: []})
    });

    test('a target list the read did not finish never certifies the merge, though a blocked target it read still holds it (AC-4)', () => {
        // a row stored before the read existed carries neither field: its other actions stand, its merge does not
        const {blockedTargets, targetsComplete, ...stored} = approved();

        expect(holderOf(approved({targetsComplete: false}))).toEqual({role: 'unknown', kind: null, ids: []});
        expect(holderOf(stored)).toEqual({role: 'unknown', kind: null, ids: []});
        expect(holderOf({...stored, ci: 'red'})).toEqual({role: 'author', kind: 'repair-ci', ids: ['@neo-opus-ada']});
        expect(holderOf(approved({...blocked, targetsComplete: false}))).toEqual(held)
    });

    test('the hold replaces only the merge: a red head, a conflict and a draft keep their holders', () => {
        expect(holderOf(approved({...blocked, ci: 'red'}))).toEqual({role: 'author', kind: 'repair-ci', ids: ['@neo-opus-ada']});
        expect(holderOf(approved({...blocked, mergeable: 'CONFLICTING'}))).toEqual({role: 'author', kind: 'rebase', ids: ['@neo-opus-ada']});
        expect(holderOf(approved({...blocked, draft: true}))).toEqual({role: 'none', kind: null, ids: []})
    })
});

test.describe('openWorkHolder — scoped outside CI ownership', () => {
    const outsideRed = (extra = {}) => row({repo: 'acme/app', number: 7, head: CI_HEAD, owner: outside,
        ci: 'red', reviews: [review('COMMENTED')], ciRepairEvidence: ciEvidence(), ...extra});
    const rotation = {role: 'rotation', kind: 'repair-ci', ids: []};

    test('an engaged outside red head stays with maintainers until a current content decision', () => {
        expect(holderOf(outsideRed())).toEqual(rotation);
        expect(holderOf(outsideRed({ciRepairClassification: ciClassification('mechanical')}))).toEqual(rotation);
        expect(holderOf(outsideRed({ciRepairClassification: ciClassification('content')})))
            .toEqual({role: 'author', kind: 'repair-ci', ids: []});
    });

    test('partial outside CI investigation uses positive red evidence while preserving visible author packets', () => {
        expect(holderOf(outsideRed({partial: true, ciRepairEvidence: null, opinions: undefined}))).toEqual(rotation);
        expect(holderOf(outsideRed({partial: true, reviews: null, requested: null, opinions: undefined}))).toEqual(rotation);
        expect(holderOf(outsideRed({partial: true, opinions: undefined, ciRepairClassification: ciClassification('content')})))
            .toEqual({role: 'author', kind: 'repair-ci', ids: []});
        expect(holderOf(outsideRed({partial: true, opinions: undefined, ciRepairClassification: ciClassification('mechanical')}))).toEqual(rotation);
        expect(holderOf(outsideRed({partial: true, reviews: undefined, opinions: [review('CHANGES_REQUESTED')],
            ciRepairClassification: ciClassification('mechanical')})))
            .toEqual({role: 'author', kind: 'address-changes', ids: []});
        expect(holderOf(outsideRed({ci: 'green', partial: true, ...judged('APPROVED'), mergeable: 'CONFLICTING'})))
            .toEqual({role: 'unknown', kind: null, ids: []});
    });

    test('malformed, foreign and stale classification or unread evidence remains unclassified', () => {
        for (const patch of [
            {head: 'b'.repeat(40)}, {evidenceKey: '2'.repeat(64)}, {kind: 'unknown'},
            {maintainer: 'login:maintainer'}, {maintainer: '@with space'},
            {receiptUrl: 'https://github.com/other/app/pull/7#issuecomment-101'},
            {receiptUrl: 'https://user:secret@github.com/acme/app/pull/7#issuecomment-101'},
            {receiptUrl: 'https://github.com/acme/app/pull/7#pullrequestreview-101'}
        ]) {
            expect(holderOf(outsideRed({ciRepairClassification: ciClassification('content', patch)}))).toEqual(rotation);
        }
        for (const ciRepairEvidence of [null, ciEvidence({head: 'other'}), ciEvidence({key: 'bad'}),
            ciEvidence({failedChecks: []}), ciEvidence({failedChecks: [null]}), ciEvidence({failedChecks: new Array(1)})]) {
            expect(holderOf(outsideRed({ciRepairEvidence, ciRepairClassification: ciClassification('content')}))).toEqual(rotation);
        }
    });

    test('only a resolved non-bot on-head change request preserves the existing author packet ahead of CI', () => {
        for (const ciRepairClassification of [null, ciClassification('mechanical')]) {
            expect(holderOf(outsideRed({...judged('CHANGES_REQUESTED'), ciRepairClassification})))
                .toEqual({role: 'author', kind: 'address-changes', ids: []});
        }
        for (const opinion of [review('CHANGES_REQUESTED', false),
            {...review('CHANGES_REQUESTED'), bot: true}, {...review('CHANGES_REQUESTED'), reviewer: 'login:outside'}]) {
            expect(holderOf(outsideRed({opinions: [opinion]}))).toEqual(rotation);
        }
        expect(holderOf(outsideRed({...judged('CHANGES_REQUESTED'), partial: true})))
            .toEqual({role: 'author', kind: 'address-changes', ids: []});
    });

    test('a verified active classification is a maintainer touch, while initial triage and run approval remain first', () => {
        expect(holderOf(outsideRed({reviews: []}))).toEqual({role: 'rotation', kind: 'triage-outside', ids: []});
        expect(holderOf(outsideRed({reviews: [], ciRepairClassification: ciClassification('mechanical')}))).toEqual(rotation);
        expect(holderOf(outsideRed({reviews: [], ciRepairClassification: ciClassification('content')})))
            .toEqual({role: 'author', kind: 'repair-ci', ids: []});
        expect(holderOf(outsideRed({runApproval: 'action_required', ciRepairClassification: ciClassification('content')})))
            .toEqual({role: 'rotation', kind: 'approve-runs', ids: []});
        expect(holderOf(outsideRed({ci: 'green', reviews: [], ciRepairClassification: ciClassification('mechanical')})))
            .toEqual({role: 'rotation', kind: 'triage-outside', ids: []});
    });

    test('an admitted current-head touch survives unread or changed evidence without authorizing stale content', () => {
        const source = {provider: 'github', apiBase: 'https://api.github.com', repo: 'acme/app', prId: 'PR_7', number: 7};
        const touch  = {head: CI_HEAD, commentId: 'COMMENT_101', maintainer: '@neo-opus-grace',
            receiptUrl: 'https://github.com/acme/app/pull/7#issuecomment-101', source,
            author    : {id: 'USER_GRACE', kind: 'User', login: 'neo-opus-grace'}};
        const ciRepairRead = {head: CI_HEAD, source, touch};
        for (const ciRepairEvidence of [null, ciEvidence({key: '2'.repeat(64)})]) {
            expect(holderOf(outsideRed({reviews: [], ciRepairEvidence, ciRepairRead,
                ciRepairClassification: ciClassification('content')}))).toEqual(rotation);
        }
        expect(holderOf(outsideRed({ci: 'green', reviews: [], ciRepairRead, ciRepairClassification: ciClassification('mechanical')})))
            .toEqual({role: 'rotation', kind: 'triage-outside', ids: []});
        expect(holderOf(outsideRed({head: undefined, reviews: [], ciRepairEvidence: null,
            ciRepairRead: {...ciRepairRead, head: undefined, touch: {...touch, head: undefined}}})))
            .toEqual({role: 'rotation', kind: 'triage-outside', ids: []});
        for (const patch of [{head: 'stale'}, {maintainer: 'login:outside'}, {source: {...source, prId: 'FOREIGN'}},
            {author: {...touch.author, kind: 'Bot'}}]) {
            expect(holderOf(outsideRed({reviews: [], ciRepairEvidence: null,
                ciRepairRead: {...ciRepairRead, touch: {...touch, ...patch}}})))
                .toEqual({role: 'rotation', kind: 'triage-outside', ids: []});
        }
    });

    test('native spelling and display-only limits do not invalidate an admitted classification', () => {
        expect(holderOf(outsideRed({ciRepairClassification: ciClassification('content', {maintainer: '@Maintainer.one_two'})})))
            .toEqual({role: 'author', kind: 'repair-ci', ids: []});
        expect(holderOf(outsideRed({ciRepairEvidence: ciEvidence({failedChecks: ['   ', 'unit\noriginal', 'x'.repeat(121)]}),
            ciRepairClassification: ciClassification('content')})))
            .toEqual({role: 'author', kind: 'repair-ci', ids: []});
    });

    test('approved outside conflicts use the rotation without changing native, incomplete or review gates', () => {
        const approved = {...judged('APPROVED'), ci: 'green', mergeable: 'CONFLICTING'};
        const red      = {...approved, ci: 'red'};
        for (const conflict of [approved, red]) {
            expect(holderOf(outsideRed(conflict))).toEqual({role: 'rotation', kind: 'rebase', ids: []})
        }
        // Integration changes the head. Any real failing check that survives it still needs repair.
        expect(holderOf(outsideRed({...red, mergeable: 'MERGEABLE'}))).toEqual(rotation);
        expect(holderOf(outsideRed({...red, runApproval: 'action_required'}))).toEqual({role: 'rotation', kind: 'approve-runs', ids: []});
        expect(holderOf(outsideRed({...red, disclosedFamilies: ['gpt']}), {seatFamilies: {'@neo-gpt': 'gpt'}})).toEqual(rotation);
        expect(holderOf(outsideRed({...red, opinions: [...red.opinions, {...review('CHANGES_REQUESTED'), reviewer: '@peer'}]})))
            .toEqual({role: 'author', kind: 'address-changes', ids: []});
        expect(holderOf(row(approved))).toEqual({role: 'author', kind: 'rebase', ids: ['@neo-opus-ada']});
        expect(holderOf(outsideRed({...approved, partial: true}))).toEqual({role: 'unknown', kind: null, ids: []});
        expect(holderOf(outsideRed({...approved, ...judged('APPROVED', false)}))).toEqual({role: 'reviewer', kind: 'review', ids: ['@neo-gpt']});
        expect(holderOf(row({ci: 'red', ...judged('CHANGES_REQUESTED'), ciRepairEvidence: ciEvidence(),
            ciRepairClassification: ciClassification('content')})))
            .toEqual({role: 'author', kind: 'repair-ci', ids: ['@neo-opus-ada']});
        for (const extra of [{draft: true}, {bot: true}, {authorType: 'Bot'}, {authorAssociation: 'MEMBER'}]) {
            expect(holderOf(outsideRed(extra)).role).not.toBe('rotation');
        }
    });
});

test.describe('openWorkHolder — an outside comment owes a reply, beside the holder (#1630)', () => {
    const
        turn  = (minute, by, member = false, bot = false) => ({at: `2026-11-11T10:${String(minute).padStart(2, '0')}:00Z`, by, member, ...(bot ? {bot: true} : {})}),
        them  = minute => turn(minute, 'login:contributor'),
        us    = (minute, by = '@neo-gpt') => turn(minute, by, true),
        reply = (role, ids, minute) => ({role, kind: 'respond-comment', ids, episode: turn(minute).at});

    test('the earliest outside turn after the latest member turn is owed; a member reply ends it and a later outside turn opens another (AC-2)', () => {
        expect(responderOf(row({turns: []}))).toBeNull();
        expect(responderOf(row({turns: [us(1)]}))).toBeNull();
        expect(responderOf(row({turns: [them(1), us(2)]}))).toBeNull();
        expect(responderOf(row({turns: [us(1), them(2), them(3)]}))).toEqual(reply('author', ['@neo-opus-ada'], 2));
        expect(responderOf(row({turns: [us(1), them(2), us(3), them(4)]}))).toEqual(reply('author', ['@neo-opus-ada'], 4));

        // a bot's turn is neither a question nor an answer
        expect(responderOf(row({turns: [them(1), turn(2, 'login:ci', false, true)]}))).toEqual(reply('author', ['@neo-opus-ada'], 1));
        expect(responderOf(row({turns: [us(1), turn(2, 'login:ci', false, true)]}))).toBeNull();

        // no conversation read, a draft or a bot's PR owes nothing
        expect(responderOf(row({}))).toBeNull();
        expect(responderOf(row({draft: true, turns: [them(1)]}))).toBeNull();
        expect(responderOf(row({bot: true, turns: [them(1)]}))).toBeNull();

        // turns an instant already covers are not owed again; a later one is
        expect(responderOf(row({turns: [them(1)]}), {since: turn(1).at})).toBeNull();
        expect(responderOf(row({turns: [them(1), them(3)]}), {since: turn(2).at})).toEqual(reply('author', ['@neo-opus-ada'], 3))
    });

    test('a turn whose author is gone is no outside human, and a held episode outlives a page that slid past it', () => {
        // GitHub may name no author: such a turn is neither a question nor an answer, while a member turn still counts
        expect(responderOf(row({turns: [us(1), turn(2, null)]}))).toBeNull();
        expect(responderOf(row({turns: [us(1), turn(2, null), them(3)]}))).toEqual(reply('author', ['@neo-opus-ada'], 3));
        expect(responderOf(row({turns: [them(1), turn(2, null, true)]}))).toBeNull();

        // ten later outside turns pushed the held one off the page, and no member turn shows: still the held episode
        const slid = Array.from({length: 10}, (_, i) => them(i + 2));
        expect(responderOf(row({turns: slid}), {held: turn(1).at})).toEqual(reply('author', ['@neo-opus-ada'], 1));
        expect(responderOf(row({turns: slid})), 'nothing held').toEqual(reply('author', ['@neo-opus-ada'], 2));

        // a member turn after the held one ends it, and the next outside turn opens another
        expect(responderOf(row({turns: [...slid.slice(2), us(12)]}), {held: turn(1).at})).toBeNull();
        expect(responderOf(row({turns: [...slid.slice(3), us(12), them(13)]}), {held: turn(1).at})).toEqual(reply('author', ['@neo-opus-ada'], 13))
    });

    test('a seat\'s own PR is its author\'s to answer, whatever else holds it (AC-3)', () => {
        for (const overrides of [{ci: 'red'}, judged('APPROVED'), judged('CHANGES_REQUESTED'), {requested: ['@neo-gpt']}]) {
            expect(responderOf(row({...overrides, turns: [them(1)]}))).toEqual(reply('author', ['@neo-opus-ada'], 1))
        }
    });

    test('an outside PR goes to the seat that spoke last, then a requested seat, then a seat that judged it, and otherwise the rotation (AC-1, AC-2)', () => {
        const pr = overrides => row({owner: outside, ...overrides});

        expect(responderOf(pr({turns: [us(1, '@neo-gpt-euclid'), us(2), them(3)], requested: ['@neo-opus-vega']})))
            .toEqual(reply('reviewer', ['@neo-gpt'], 3));
        // a repository member without a seat answers, yet names nobody a wake can reach
        expect(responderOf(pr({turns: [turn(1, 'login:tobiu', true), them(2)], requested: ['@neo-opus-vega']})))
            .toEqual(reply('reviewer', ['@neo-opus-vega'], 2));
        expect(responderOf(pr({turns: [them(1)], ci: 'red', ...judged('CHANGES_REQUESTED', false)})))
            .toEqual(reply('reviewer', ['@neo-gpt'], 1));
        expect(responderOf(pr({turns: [them(1)], ci: 'red'}))).toEqual(reply('rotation', [], 1));
        expect(responderOf(pr({turns: [them(1)], reviews: [{reviewer: 'login:copilot', state: 'COMMENTED', onHead: true, bot: true}]})))
            .toEqual(reply('rotation', [], 1))
    });
});

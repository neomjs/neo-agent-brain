import {setup} from '../../../../setup.mjs';

const appName = 'LifecycleAdmissionTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

/**
 * The admission/exclusion matrix. The exclusions carry as much weight as the admissions: a row that
 * does not truly need action teaches peers to ignore the surface, which is how the route's fixture
 * rows failed.
 */
test.describe('lifecycleAdmission — the five stages and their exclusions', () => {
    let admitOwnPrRepair, admitOwnPrReviewerRouting, admitRequestedReview, admitClaimedTask,
        admitDirectMessage, collectLifecycleItems, hasCurrentHeadClosingReview, normalizeClocks;

    const ME   = '@neo-opus-ada',
          PEER = '@neo-gpt',
          HEAD = 'head-2',
          OLD  = 'head-1';

    // Provider timestamps remain metadata; these fixtures explicitly declare current-head clocks.
    const sourcePr = (overrides = {}) => ({
        id             : 'pr-15231',
        authorId       : ME,
        state          : 'OPEN',
        isDraft        : false,
        headSha        : HEAD,
        headCommittedAt: '2026-07-16T08:00:00.000Z',
        mergeable      : true,
        checks         : [{name: 'unit', required: true, conclusion: 'SUCCESS', headSha: HEAD, completedAt: '2026-07-16T09:30:00.000Z'}],
        reviews        : [],
        reviewRequests : [],
        url            : 'https://github.com/neomjs/neo/pull/15231',
        mergeableSince : '2026-07-16T09:00:00.000Z',
        checkedAt      : '2026-07-16T10:00:00.000Z',
        repairActionableSince: '2026-07-16T09:00:00.000Z',
        repairActionableSinceHeadSha: HEAD,
        repairActionableSinceClockBasis: 'transition',
        reviewableSince: '2026-07-16T09:30:00.000Z',
        reviewableSinceHeadSha: HEAD,
        reviewableSinceClockBasis: 'transition',
        ...overrides,
        reviewRequests: (overrides.reviewRequests || []).map(request => typeof request === 'object' ? {
            actionableSince: request.requestedAt, headSha: HEAD, clockBasis: 'transition', ...request
        } : request)
    });

    // What the collector hands the predicates.
    const ownPr = (overrides = {}) => normalizeClocks(sourcePr(overrides));

    test.beforeAll(async () => {
        ({
            admitOwnPrRepair, admitOwnPrReviewerRouting, admitRequestedReview, admitClaimedTask,
            admitDirectMessage, collectLifecycleItems, hasCurrentHeadClosingReview
        } = await import('../../../../../../ai/services/graph/lifecycleAdmission.mjs'));
        ({normalizeLifecycleClocks: normalizeClocks} = await import('../../../../../../ai/services/graph/lifecycleAdmission.mjs'));
    });

    test('stage 1 admits a current-head CHANGES_REQUESTED, a failed REQUIRED check, and a merge conflict', () => {
        expect(admitOwnPrRepair({pr: ownPr({reviews: [{state: 'CHANGES_REQUESTED', commitSha: HEAD, submittedAt: '2026-07-16T09:00:00.000Z'}]}), agentId: ME}).kind)
            .toBe('changes-requested');
        expect(admitOwnPrRepair({pr: ownPr({checks: [{name: 'unit', required: true, conclusion: 'FAILURE', headSha: HEAD, completedAt: '2026-07-16T09:10:00.000Z'}]}), agentId: ME}).kind)
            .toBe('failed-required-check');
        expect(admitOwnPrRepair({pr: ownPr({mergeable: false}), agentId: ME}).kind).toBe('merge-conflict');
        // a clean head is not a repair
        expect(admitOwnPrRepair({pr: ownPr(), agentId: ME})).toBeNull();
    });

    test('EXCLUSION — pending/running CI is a wait, not a repair', () => {
        // "CI is running" must never manufacture a row; only a FAILED required check is actionable.
        const pending = ownPr({checks: [{name: 'unit', required: true, conclusion: null, headSha: HEAD}]});

        expect(admitOwnPrRepair({pr: pending, agentId: ME})).toBeNull();
        // ...and it is not reviewable either: required checks have not passed yet
        expect(admitOwnPrReviewerRouting({pr: pending, agentId: ME})).toBeNull();
    });

    test('EXCLUSION — an OPTIONAL check failing is not a repair trigger', () => {
        // otherwise every advisory linter invents an obligation
        const optionalFail = ownPr({checks: [
            {name: 'unit',     required: true,  conclusion: 'SUCCESS', headSha: HEAD, completedAt: '2026-07-16T09:30:00.000Z'},
            {name: 'advisory', required: false, conclusion: 'FAILURE', headSha: HEAD, completedAt: '2026-07-16T09:40:00.000Z'}
        ]});

        expect(admitOwnPrRepair({pr: optionalFail, agentId: ME})).toBeNull();
        // it stays cleanly reviewable
        expect(admitOwnPrReviewerRouting({pr: optionalFail, agentId: ME})).not.toBeNull();
    });

    test('EXCLUSION — an APPROVED PR awaiting the human merge gate is NOT the agent\'s move', () => {
        // merge is human-only; listing it would ask for an action the agent must never take
        const approved = ownPr({reviews: [{state: 'APPROVED', commitSha: HEAD, authorId: PEER}]});

        expect(admitOwnPrReviewerRouting({pr: approved, agentId: ME})).toBeNull();
        expect(admitOwnPrRepair({pr: approved, agentId: ME})).toBeNull();
    });

    test('EXCLUSION — a draft PR is not yet anyone\'s obligation', () => {
        const draft = ownPr({isDraft: true, reviews: [{state: 'CHANGES_REQUESTED', commitSha: HEAD, submittedAt: '2026-07-16T09:00:00.000Z'}]});

        expect(admitOwnPrRepair({pr: draft, agentId: ME})).toBeNull();
        expect(admitOwnPrReviewerRouting({pr: draft, agentId: ME})).toBeNull();
        expect(admitRequestedReview({pr: {...draft, reviewRequests: [{login: ME, requestedAt: '2026-07-16T09:45:00.000Z'}]}, agentId: ME})).toBeNull();
    });

    test('an OLD-head verdict does not close the current head — the code changed underneath it', () => {
        const staleVerdict = ownPr({reviews: [{state: 'APPROVED', commitSha: OLD, authorId: PEER}]});

        expect(hasCurrentHeadClosingReview(staleVerdict)).toBe(false);
        // so the PR still needs a reviewer on THIS head
        expect(admitOwnPrReviewerRouting({pr: staleVerdict, agentId: ME})).not.toBeNull();
        // and a stale CHANGES_REQUESTED is likewise not a current-head repair
        expect(admitOwnPrRepair({pr: ownPr({reviews: [{state: 'CHANGES_REQUESTED', commitSha: OLD, submittedAt: '2026-07-16T08:30:00.000Z'}]}), agentId: ME})).toBeNull();
    });

    test('stage 2 excludes a PR that already has an outstanding review request — someone has it', () => {
        expect(admitOwnPrReviewerRouting({pr: ownPr({reviewRequests: [{login: PEER, requestedAt: '2026-07-16T09:45:00.000Z'}]}), agentId: ME})).toBeNull();
        expect(admitOwnPrReviewerRouting({pr: ownPr(), agentId: ME}).kind).toBe('needs-reviewer');
    });

    test('stage 3 admits a live request to me and discharges on ANY current-head verdict', () => {
        const requested = ownPr({authorId: PEER, reviewRequests: [{login: ME, requestedAt: '2026-07-16T09:45:00.000Z'}]});

        expect(admitRequestedReview({pr: requested, agentId: ME}).stage).toBe('requested-review');
        // my verdict on the CURRENT head discharges it
        expect(admitRequestedReview({
            pr: {...requested, reviews: [{state: 'APPROVED', commitSha: HEAD, authorId: ME}]}, agentId: ME
        })).toBeNull();
        // my verdict on an OLD head does not — the head moved underneath it
        expect(admitRequestedReview({
            pr: {...requested, reviews: [{state: 'APPROVED', commitSha: OLD, authorId: ME}]}, agentId: ME
        })).not.toBeNull();
        // Closure is defined by the HEAD, not the verdict's author: a peer's current-head decision
        // closes it too. (This assertion previously demanded the opposite — an author-is-me rule the
        // contract never contained, which kept a request live after the head was already closed.)
        expect(admitRequestedReview({
            pr: {...requested, reviews: [{state: 'APPROVED', commitSha: HEAD, authorId: PEER}]}, agentId: ME
        })).toBeNull();
    });

    test('stage 4 admits only a CLAIMED task in an action-requiring state', () => {
        const task = {id: 't-1', ownerId: ME, state: 'InputRequired', actionableSince: '2026-07-16T09:00:00.000Z', clockBasis: 'transition'};

        expect(admitClaimedTask({task, agentId: ME}).stage).toBe('claimed-a2a-task');
        // EXCLUSION: an unclaimed broadcast has no owner — awareness never becomes an obligation
        expect(admitClaimedTask({task: {...task, ownerId: null}, agentId: ME})).toBeNull();
        // EXCLUSION: another agent's claimed task is never mine
        expect(admitClaimedTask({task: {...task, ownerId: PEER}, agentId: ME})).toBeNull();
        // EXCLUSION: a terminal task has ended
        expect(admitClaimedTask({task: {...task, state: 'Completed'}, agentId: ME})).toBeNull();
        // EXCLUSION: a non-actionable live state is awareness, not an obligation
        expect(admitClaimedTask({task: {...task, state: 'Working'}, agentId: ME})).toBeNull();
    });

    test('stage 5 admits an unread DIRECT message; broadcasts and read messages are excluded', () => {
        const message = {messageId: 'm-1', to: ME, readAt: null, sentAt: '2026-07-16T09:00:00.000Z', clockBasis: 'transition'};

        expect(admitDirectMessage({message, agentId: ME}).stage).toBe('direct-message');
        expect(admitDirectMessage({message: {...message, readAt: '2026-07-16T09:30:00.000Z'}, agentId: ME})).toBeNull();
        // a broadcast is awareness — otherwise every peer's announcement becomes my todo
        expect(admitDirectMessage({message: {...message, to: 'AGENT:*'}, agentId: ME})).toBeNull();
        expect(admitDirectMessage({message: {...message, to: PEER}, agentId: ME})).toBeNull();
    });

    test('never-foreign: another agent\'s PR never admits an own-PR stage', () => {
        const peerPr = ownPr({authorId: PEER, reviews: [{state: 'CHANGES_REQUESTED', commitSha: HEAD, submittedAt: '2026-07-16T09:00:00.000Z'}]});

        expect(admitOwnPrRepair({pr: peerPr, agentId: ME})).toBeNull();
        expect(admitOwnPrReviewerRouting({pr: peerPr, agentId: ME})).toBeNull();
    });

    test('collectLifecycleItems runs every stage over the source records', () => {
        const items = collectLifecycleItems({
            agentId: ME,
            prs    : [
                ownPr({id: 'pr-a', reviews: [{state: 'CHANGES_REQUESTED', commitSha: HEAD, submittedAt: '2026-07-16T09:00:00.000Z'}]}),
                ownPr({id: 'pr-b', authorId: PEER, reviewRequests: [{login: ME, requestedAt: '2026-07-16T09:45:00.000Z'}]})
            ],
            tasks   : [{id: 't-1', ownerId: ME, state: 'InputRequired', actionableSince: '2026-07-16T09:00:00.000Z', clockBasis: 'transition'}],
            messages: [{messageId: 'm-1', to: ME, readAt: null, sentAt: '2026-07-16T09:00:00.000Z', clockBasis: 'transition'}]
        });

        expect(items.map(entry => entry.stage).sort()).toEqual(
            ['claimed-a2a-task', 'direct-message', 'own-pr-repair', 'requested-review']
        );
    });

    test('a merge-conflicted PR with GREEN checks enters repair only — the stages are exclusive in fact', () => {
        // The prose claimed mutual exclusion; a merge conflict falsified it. Each stage tested a
        // different subset of the blockers, so a conflicted-but-green PR satisfied "needs repair" AND
        // "cleanly reviewable" at once, and the peer saw one PR twice.
        const conflicted = ownPr({mergeable: false});

        expect(admitOwnPrRepair({pr: conflicted, agentId: ME}).kind).toBe('merge-conflict');
        expect(admitOwnPrReviewerRouting({pr: conflicted, agentId: ME})).toBeNull();

        const stages = collectLifecycleItems({agentId: ME, prs: [conflicted]}).map(entry => entry.stage);
        expect(stages).toEqual(['own-pr-repair']);
    });

    test('a PEER\'s current-head verdict closes MY requested review — closure is by head, not by author', () => {
        // An author-is-me restriction invented a rule the contract does not have: it kept the request
        // live after the current head was already closed, manufacturing an obligation.
        const pr = ownPr({
            authorId      : PEER,
            reviewRequests: [{login: ME, requestedAt: '2026-07-16T09:45:00.000Z'}],
            reviews       : [{state: 'APPROVED', authorId: PEER, commitSha: HEAD}]
        });

        expect(admitRequestedReview({pr, agentId: ME})).toBeNull();

        // ...but an OLDER-head verdict cannot close the current head — the code changed underneath it.
        const stale = ownPr({
            authorId      : PEER,
            reviewRequests: [{login: ME, requestedAt: '2026-07-16T09:45:00.000Z'}],
            reviews       : [{state: 'APPROVED', authorId: PEER, commitSha: OLD}]
        });

        expect(admitRequestedReview({pr: stale, agentId: ME}).stage).toBe('requested-review');
    });

    test('a clock whose source provenance names a DIFFERENT head fails loud', () => {
        // Normalization preserves the declaration; admission must reject its stale head proof.
        const withCurrentHeadReview = sourcePr({
            reviews: [{state: 'CHANGES_REQUESTED', commitSha: HEAD, submittedAt: '2026-07-16T09:00:00.000Z'}]
        });

        expect(() => admitOwnPrRepair({
            pr: {
                ...withCurrentHeadReview,
                repairActionableSince       : '2026-07-16T09:00:00.000Z',
                repairActionableSinceHeadSha: OLD
            },
            agentId: ME
        })).toThrow(/current head/);

        // an absent clock is equally a source-contract violation, not a silent drop
        expect(() => admitOwnPrRepair({
            pr     : {...withCurrentHeadReview, repairActionableSince: undefined, repairActionableSinceHeadSha: HEAD},
            agentId: ME
        })).toThrow(/repairActionableSince.actionableSince must be a parseable timestamp/);
    });

    test('an OLD-head failed check neither blocks nor clears the current head', () => {
        // The predicates read every raw check while the derivation filtered to head, so an old-head
        // failure produced repairReason=failed-required-check AND allRequiredChecksPass=false AND
        // repairSince=null — three answers from two views of the same rows. A check names the head it
        // ran against; one naming an OLDER head describes code that no longer exists.
        const mixed = ownPr({
            checks: [
                {name: 'unit', required: true, conclusion: 'FAILURE', headSha: OLD,  completedAt: '2026-07-16T08:10:00.000Z'},
                {name: 'unit', required: true, conclusion: 'SUCCESS', headSha: HEAD, completedAt: '2026-07-16T09:30:00.000Z'}
            ]
        });

        expect(admitOwnPrRepair({pr: mixed, agentId: ME})).toBeNull();
        expect(admitOwnPrReviewerRouting({pr: mixed, agentId: ME}).kind).toBe('needs-reviewer');
    });

    test('an UNPROVENANCED check is not assumed current — scope must be provable', () => {
        // The reviewer's falsifier: an unprovenanced FAILED required check plus a current-head SUCCESS
        // yielded failed-required-check and suppressed reviewer routing — blocking a head the check may
        // never have run against. "The source did not say" is not proof of anything, and treating a
        // missing headSha as current was a guess wearing a convenience's clothes.
        const unprovenanced = ownPr({
            checks: [
                {name: 'unit', required: true, conclusion: 'FAILURE'},
                {name: 'unit', required: true, conclusion: 'SUCCESS', headSha: HEAD, completedAt: '2026-07-16T09:30:00.000Z'}
            ]
        });

        expect(admitOwnPrRepair({pr: unprovenanced, agentId: ME})).toBeNull();
        expect(admitOwnPrReviewerRouting({pr: unprovenanced, agentId: ME}).kind).toBe('needs-reviewer');

        // A source that cannot stamp each check may ATTEST its snapshot is current-head-only. Same fact,
        // asserted by the party that can actually know it, and visible in the record rather than assumed
        // in the filter.
        const attested = ownPr({
            checksAreCurrentHeadSnapshot: true,
            checks                      : [{name: 'unit', required: true, conclusion: 'FAILURE', completedAt: '2026-07-16T09:10:00.000Z'}]
        });

        expect(admitOwnPrRepair({pr: attested, agentId: ME}).kind).toBe('failed-required-check');
    });

    test('source clock declarations are preserved rather than recalculated from provider facts', () => {
        const pr = ownPr({
            headCommittedAt: '2026-07-16T08:00:00.000Z',
            reviewableSince: '2026-07-16T12:00:00.000Z',
            reviewableSinceClockBasis: 'transition'
        });
        expect(admitOwnPrReviewerRouting({pr, agentId: ME})).toMatchObject({
            actionableSince: '2026-07-16T12:00:00.000Z', clockBasis: 'transition'
        });
    });

    test('zero-required checks and a previously created SHA use the source-proven activation clock', () => {
        const pr = ownPr({checks: [], headCommittedAt: '2026-07-16T08:00:00.000Z',
            reviewableSince: '2026-07-16T12:00:00.000Z'});
        expect(admitOwnPrReviewerRouting({pr, agentId: ME}).actionableSince).toBe('2026-07-16T12:00:00.000Z');
    });

    test('same-head re-entry retains its declared observation basis instead of evergreen green', () => {
        const pr = ownPr({reviewableSince: '2026-07-16T12:00:00.000Z',
            reviewableSinceClockBasis: 'observation'});
        expect(admitOwnPrReviewerRouting({pr, agentId: ME})).toMatchObject({
            actionableSince: '2026-07-16T12:00:00.000Z', clockBasis: 'observation'
        });
    });

    test('target-specific declarations retain undated requests without borrowing another target date', () => {
        const pr = ownPr({authorId: PEER, reviewRequests: [
            {login: ME, requestedAt: '2026-07-16T09:00:00.000Z', actionableSince: null,
                clockBasis: 'unavailable', clockReason: 'head activation is undated'},
            {login: PEER, requestedAt: '2026-07-16T11:00:00.000Z'}
        ]});
        expect(admitRequestedReview({pr, agentId: ME})).toMatchObject({
            actionableSince: null, clockBasis: 'unavailable', clockReason: 'head activation is undated'
        });
        expect(admitRequestedReview({pr, agentId: PEER}).actionableSince).toBe('2026-07-16T11:00:00.000Z');
    });

    test('raw request creation does not replace the source-declared later head activation', () => {
        const pr = ownPr({authorId: PEER, reviewRequests: [{
            login: ME, requestedAt: '2026-07-16T09:00:00.000Z',
            actionableSince: '2026-07-16T12:00:00.000Z'
        }]});
        expect(admitRequestedReview({pr, agentId: ME}).actionableSince).toBe('2026-07-16T12:00:00.000Z');
    });

    test('a head move rejects prior declarations until the source supplies the new head', () => {
        const pr = ownPr({headSha: OLD});
        expect(() => collectLifecycleItems({agentId: ME, prs: [pr]})).toThrow(/current head/);
        const fresh = ownPr({headSha: OLD, reviewableSinceHeadSha: OLD,
            reviewableSince: null, reviewableSinceClockBasis: 'unavailable',
            reviewableSinceClockReason: 'new head entry is undated'});
        expect(collectLifecycleItems({agentId: ME, prs: [fresh]})[0].actionableSince).toBeNull();
    });

    test('unavailable clock knowledge does not relax existing lifecycle eligibility', () => {
        const unavailable = {reviewableSince: null, reviewableSinceClockBasis: 'unavailable',
            reviewableSinceClockReason: 'history unavailable'};
        for (const overrides of [{state: 'CLOSED'}, {isDraft: true}, {authorId: PEER},
            {checks: [{headSha: HEAD, required: true, conclusion: null}]}]) {
            expect(collectLifecycleItems({agentId: ME, prs: [ownPr({...unavailable, ...overrides})]})).toEqual([]);
        }
    });

    test('an explicitly unavailable current-head clock retains an eligible routing obligation', () => {
        const pr = sourcePr({
            reviewableSince: null, reviewableSinceHeadSha: HEAD,
            reviewableSinceClockBasis: 'unavailable', reviewableSinceClockReason: 'request withdrawal is undated'
        });
        expect(collectLifecycleItems({agentId: ME, prs: [pr]})).toMatchObject([{
            stage: 'own-pr-reviewer-routing', actionableSince: null,
            clockBasis: 'unavailable', clockReason: 'request withdrawal is undated', headSha: HEAD
        }]);
    });

    test('Task and direct-message unavailable declarations remain visible without changing eligibility', () => {
        const clock = {actionableSince: null, clockBasis: 'unavailable', clockReason: 'source transition unavailable'};
        expect(admitClaimedTask({task: {id: 't-undated', ownerId: ME, state: 'InputRequired', ...clock}, agentId: ME}))
            .toMatchObject(clock);
        expect(admitDirectMessage({message: {messageId: 'm-undated', to: ME, readAt: null, sentAt: null,
            clockBasis: 'unavailable', clockReason: clock.clockReason}, agentId: ME})).toMatchObject(clock);
    });

    test('green checks and commit creation never fill an omitted source clock', () => {
        expect(() => collectLifecycleItems({agentId: ME, prs: [sourcePr({reviewableSince: undefined, reviewableSinceClockBasis: undefined})]})).toThrow(/clock|reviewableSince/);
    });

    test('a stale-head unavailable declaration is an error, never a dated fallback', () => {
        expect(() => collectLifecycleItems({agentId: ME, prs: [sourcePr({
            reviewableSince: null, reviewableSinceHeadSha: OLD,
            reviewableSinceClockBasis: 'unavailable', reviewableSinceClockReason: 'history unavailable'
        })]})).toThrow(/current head|different head/);
    });

    test('archived and retracted direct messages are removed — unread is not the only clearing', () => {
        // Both are unread forever. Keying on readAt alone pins them to the frontier permanently, and a
        // row that cannot be cleared teaches the reader to ignore the surface.
        const base = {messageId: 'm-1', to: ME, readAt: null, sentAt: '2026-07-16T09:00:00.000Z', clockBasis: 'transition'};

        expect(admitDirectMessage({message: base, agentId: ME}).stage).toBe('direct-message');
        expect(admitDirectMessage({message: {...base, archivedAt: '2026-07-16T09:30:00.000Z'}, agentId: ME})).toBeNull();

        // The LIVE shape: MailboxService emits `retracted: true` (a boolean) and blanks the body to a
        // placeholder. The previous check tested an invented `retractedAt` timestamp, so it never fired
        // on a real row — the exclusion existed only in the spec's imagination.
        expect(admitDirectMessage({message: {...base, retracted: true}, agentId: ME})).toBeNull();
        // a compatibility shape a caller may still pass
        expect(admitDirectMessage({message: {...base, retractedAt: '2026-07-16T09:30:00.000Z'}, agentId: ME})).toBeNull();
        // and `retracted: false` is not a retraction
        expect(admitDirectMessage({message: {...base, retracted: false}, agentId: ME}).stage).toBe('direct-message');
    });
});

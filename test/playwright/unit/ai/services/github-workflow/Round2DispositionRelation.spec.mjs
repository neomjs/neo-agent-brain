import {setup}        from '../../../../setup.mjs';
import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : 'Round2DispositionRelationTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

/**
 * The Round-2 RELATION: whether a disposition-shaped body is a disposition OF the round it cites. The shape tier proves a
 * body is disposition-shaped; @neo-gpt then showed a shaped body with a plausible review id and an invented RA-999 still
 * passed, because "is this a disposition of that round" is a claim about two documents. These arms drive the relation
 * directly, and they live in their own spec so the Brain's curated unit run executes them.
 */
test.describe('Neo.ai.services.github-workflow.PullRequestService — the Round-2 disposition relation', () => {
    const REVIEW_ORIGIN_SESSION_ID = '8c622ae9-0ef1-4bf1-9a27-5dfe228b4fac';

    let getRound2DispositionRelationFailure;

    test.beforeAll(async () => {
        ({getRound2DispositionRelationFailure} = await import('../../../../../../ai/services/github-workflow/PullRequestService.mjs'));
    });

    const PRIOR_RC = {
        author: {login: 'neo-gpt'},
        body  : ['# PR Review Summary', '', '### 📋 Required Actions', '',
                      '- [ ] make the tier semantic', '- [ ] update the stale predecessors'].join('\n'),
        id         : 'PRR_prior',
        state      : 'CHANGES_REQUESTED',
        submittedAt: '2026-08-15T10:00:00Z',
        url        : 'https://github.com/neomjs/neo/pull/1#pullrequestreview-1'
    };

    const round2With = rows => [
        '# PR Review — Round 2 (disposition only)', '', '**Status:** Approved', '',
        '### ⚓ Anchor',
        '* **Round-1 Review ID:** PRR_prior',
        `* **Origin Session ID:** ${REVIEW_ORIGIN_SESSION_ID}`, '',
        '### 📋 Disposition', '',
        '| # | Required Action | Disposition | Evidence |', '|---|---|---|---|',
        ...rows, '',
        '### 🔚 Verdict', '', 'Approve'
    ].join('\n');

    // neo#19125's shape: two reviewers requested changes, and the one with the OLDER RC dispositions it
    const LATER_RC_OF_ANOTHER_REVIEWER = {
        author     : {login: 'neo-opus-vega'},
        body       : ['# PR Review Summary', '', '### 📋 Required Actions', '', '- [ ] a later reviewer\'s only action'].join('\n'),
        databaseId : 2,
        id         : 'PRR_later',
        state      : 'CHANGES_REQUESTED',
        submittedAt: '2026-08-15T12:00:00Z',
        url        : 'https://github.com/neomjs/neo/pull/1#pullrequestreview-2'
    };

    const BOTH_ACTIONS_ADDRESSED = ['| RA-1 | make the tier semantic | ADDRESSED | done |',
                                    '| RA-2 | update the stale predecessors | ADDRESSED | done |'];

    // The cited RC under the ids the shape gate's own table uses (`PullRequestService.spec`, #380)
    const CITED_RC  = {...PRIOR_RC, databaseId: 5256218531, id: 'PRR_123', url: 'https://github.com/neomjs/neo/pull/1#pullrequestreview-5256218531'},
          CITE_LINK = '[5256218531](https://github.com/neomjs/neo/pull/1#pullrequestreview-5256218531)',
          citing    = value => round2With(BOTH_ACTIONS_ADDRESSED).replace('* **Round-1 Review ID:** PRR_prior', `* **Round-1 Review ID:**${value}`);

    test('#455: a Round 2 dispositions the review it cites, not the newest RC from another reviewer', () => {
        const failure = getRound2DispositionRelationFailure({
            body   : round2With(BOTH_ACTIONS_ADDRESSED),
            reviews: [PRIOR_RC, LATER_RC_OF_ANOTHER_REVIEWER],
            state  : 'APPROVED'
        });

        expect(failure, 'the body cites PRR_prior; the later RC is not its round').toBeNull()
    });

    test('#455: every Round-1 Review ID form the shape gate accepts selects the cited review', () => {
        for (const value of [
            ` ${CITE_LINK} · **Author Response:** IC_456`,
            ' PRR_123 · **Author Response:** IC_456',
            ' `PRR_123` · **Author Response:** IC_456',
            ' 5256218531',
            ' https://github.com/neomjs/neo/pull/1#pullrequestreview-5256218531',
            ` PRR_123 (${CITE_LINK})`
        ]) {
            const failure = getRound2DispositionRelationFailure({
                body   : citing(value),
                reviews: [CITED_RC, LATER_RC_OF_ANOTHER_REVIEWER],
                state  : 'APPROVED'
            });

            expect.soft(failure, value).toBeNull()
        }
    });

    test('#455: a Round 2 citing no RC on the pull request is refused, and the refusal names what it cited', () => {
        const failure = getRound2DispositionRelationFailure({
            body   : round2With(BOTH_ACTIONS_ADDRESSED).replace('* **Round-1 Review ID:** PRR_prior', '* **Round-1 Review ID:** PRR_unknown'),
            reviews: [PRIOR_RC, LATER_RC_OF_ANOTHER_REVIEWER],
            state  : 'APPROVED'
        });

        expect(failure?.code).toBe('PR_REVIEW_TEMPLATE_VALIDATION_FAILED');
        expect(failure.message).toContain('PRR_unknown')
    });

    test('#455: a link whose label names the cited RC but whose URL targets no RC is refused, naming the URL\'s id', () => {
        const failure = getRound2DispositionRelationFailure({
            body   : citing(' [5256218531](https://github.com/neomjs/neo/pull/1#pullrequestreview-9999999)'),
            reviews: [CITED_RC, LATER_RC_OF_ANOTHER_REVIEWER],
            state  : 'APPROVED'
        });

        expect(failure?.code, 'a matching label does not admit an unknown target').toBe('PR_REVIEW_TEMPLATE_VALIDATION_FAILED');
        expect(failure.message).toContain('9999999')
    });

    test('#455: references naming two different rounds are refused in either order of history', () => {
        // The node id names the cited RC; the link names the other reviewer's. Order must never pick one.
        for (const reviews of [[CITED_RC, LATER_RC_OF_ANOTHER_REVIEWER], [LATER_RC_OF_ANOTHER_REVIEWER, CITED_RC]]) {
            const failure = getRound2DispositionRelationFailure({
                body : citing(' PRR_123 ([2](https://github.com/neomjs/neo/pull/1#pullrequestreview-2))'),
                reviews,
                state: 'APPROVED'
            });

            expect.soft(failure?.code, reviews.map(review => review.id).join(' → ')).toBe('PR_REVIEW_TEMPLATE_VALIDATION_FAILED');
            expect.soft(failure?.message).toContain('2 different')
        }
    });

    test('#455: the cited round is found whatever the order of history — the reversed control', () => {
        const failure = getRound2DispositionRelationFailure({
            body   : round2With(BOTH_ACTIONS_ADDRESSED),
            reviews: [LATER_RC_OF_ANOTHER_REVIEWER, PRIOR_RC],
            state  : 'APPROVED'
        });

        expect(failure).toBeNull()
    });

    test('#17178: an invented action is refused — the row must exist in the prior round', () => {
        const failure = getRound2DispositionRelationFailure({
            body   : round2With(['| RA-1 | make the tier semantic | ADDRESSED | done |',
                                 '| RA-2 | update the stale predecessors | ADDRESSED | done |',
                                 '| RA-999 | an action no round raised | ADDRESSED | done |']),
            reviews: [PRIOR_RC],
            state  : 'APPROVED'
        });

        expect(failure?.code, "@neo-gpt's exact-head falsifier").toBe('PR_REVIEW_TEMPLATE_VALIDATION_FAILED');
        expect(failure.message).toContain('appears in the table but not in the prior round');
    });

    test('#17178: a reworded action is refused — verbatim is what stops a demand being softened', () => {
        const failure = getRound2DispositionRelationFailure({
            body   : round2With(['| RA-1 | make the tier a bit more semantic | ADDRESSED | done |',
                                 '| RA-2 | update the stale predecessors | ADDRESSED | done |']),
            reviews: [PRIOR_RC],
            state  : 'APPROVED'
        });

        expect(failure?.code).toBe('PR_REVIEW_TEMPLATE_VALIDATION_FAILED');
        expect(failure.message, 'it names the drift rather than just refusing').toContain('carry it verbatim');
    });

    /**
     * The third live specimen: a prior action quoted correctly, with its markdown stripped.
     * `**RA-1 (scope):** make the tier semantic` became `RA-1 (scope): make the tier semantic`.
     *
     * The byte-verbatim rule is right and is not being relaxed — it is what stops a Round 2 quietly
     * softening the demand it claims to discharge. The defect is that the rule is unstated and its
     * violation unnamed: the refusal prints both strings, and when the only difference is emphasis
     * the two render nearly identically, so the author is told to "carry it verbatim" while looking
     * at what appears to be a verbatim copy.
     */
    const PRIOR_RC_WITH_MARKDOWN = {
        ...PRIOR_RC,
        body: ['# PR Review Summary', '', '### 📋 Required Actions', '',
               '- [ ] **make the tier semantic** so the label survives a rename'].join('\n')
    };

    test('#17354: a quote differing only in formatting is told so, not just "carry it verbatim"', () => {
        const failure = getRound2DispositionRelationFailure({
            body   : round2With(['| RA-1 | make the tier semantic so the label survives a rename | ADDRESSED | done |']),
            reviews: [PRIOR_RC_WITH_MARKDOWN],
            state  : 'APPROVED'
        });

        expect(failure?.code).toBe('PR_REVIEW_TEMPLATE_VALIDATION_FAILED');
        expect(failure.message, 'the refusal names formatting as the difference')
            .toMatch(/formatting|emphasis|markdown/i)
    });

    test('#17354: a genuinely reworded action is NOT excused as formatting — the non-vacuity control', () => {
        // Without this, a fix that labels every verbatim mismatch "formatting" passes the arm above
        // while telling an author who softened a demand that they merely mis-styled it.
        const failure = getRound2DispositionRelationFailure({
            body   : round2With(['| RA-1 | make the tier a bit more semantic | ADDRESSED | done |',
                                 '| RA-2 | update the stale predecessors | ADDRESSED | done |']),
            reviews: [PRIOR_RC],
            state  : 'APPROVED'
        });

        expect(failure.message, 'real drift keeps the verbatim demand').toContain('carry it verbatim');
        expect(failure.message, 'and is not excused as styling').not.toMatch(/only in formatting/i)
    });

    test('#17178: a dropped action is refused — omission must not retire a demand', () => {
        const failure = getRound2DispositionRelationFailure({
            body   : round2With(['| RA-1 | make the tier semantic | ADDRESSED | done |']),
            reviews: [PRIOR_RC],
            state  : 'APPROVED'
        });

        expect(failure?.code).toBe('PR_REVIEW_TEMPLATE_VALIDATION_FAILED');
        expect(failure.message).toContain("against the prior round's 2");
    });

    /**
     * The count in the refusal is DERIVED from the parse, and it was reported as if it were an
     * observation. A cell reading `**ADDRESSED** — and answered better than the action asked` carries
     * its verdict, but the extractor matches a cell that IS the verb, so the row is dropped silently
     * and the author is told they dispositioned nothing. That accuses them of the wrong mistake: they
     * wrote the row, and the message sends them to write it again rather than to unwrap the cell.
     */
    test('#17354: an unparseable disposition cell is named, not counted as absent', () => {
        const failure = getRound2DispositionRelationFailure({
            body: round2With([
                '| RA-1 | make the tier semantic | **ADDRESSED** — and answered better than the action asked | done |',
                '| RA-2 | name the anchors | ADDRESSED | done |'
            ]),
            reviews: [PRIOR_RC],
            state  : 'APPROVED'
        });

        expect(failure?.code).toBe('PR_REVIEW_TEMPLATE_VALIDATION_FAILED');

        // The defect is the cell, so the refusal must say so.
        expect(failure.message, 'the refusal names the unreadable cell')
            .toMatch(/could not be read|unparseable|unreadable/i);

        // And it must NOT claim the author dispositioned fewer actions than they wrote. Asserted
        // separately because a fix that only appends a hint would leave the false accusation standing.
        expect(failure.message, 'no derived count is presented as an observation')
            .not.toContain("dispositions 1 action(s) against the prior round's 2");
    });

    test('#17354: a genuinely short table still reports the count — the non-vacuity control', () => {
        // Without this, a fix that deletes the count message entirely passes the arm above. A table
        // that parses cleanly and is simply missing a row must still be told so.
        const failure = getRound2DispositionRelationFailure({
            body   : round2With(['| RA-1 | make the tier semantic | ADDRESSED | done |']),
            reviews: [PRIOR_RC],
            state  : 'APPROVED'
        });

        expect(failure.message, 'a clean short table keeps the count').toContain("against the prior round's 2");
        expect(failure.message, 'and is not blamed on a parse failure').not.toMatch(/could not be read/i)
    });

    test('#17178: a STILL_OPEN round submitted as APPROVED is refused', () => {
        // The second exact-head falsifier: an APPROVED round carrying a STILL_OPEN silently discharges
        // the item it just declared unresolved.
        const failure = getRound2DispositionRelationFailure({
            body   : round2With(['| RA-1 | make the tier semantic | ADDRESSED | done |',
                                 '| RA-2 | update the stale predecessors | STILL_OPEN | not yet |']),
            reviews: [PRIOR_RC],
            state  : 'APPROVED'
        });

        expect(failure?.code).toBe('PR_REVIEW_TEMPLATE_VALIDATION_FAILED');
        expect(failure.message).toContain('must be COMMENT');
    });

    test('#17178: the same STILL_OPEN round as COMMENT is accepted — the state the format prescribes', () => {
        const failure = getRound2DispositionRelationFailure({
            body   : round2With(['| RA-1 | make the tier semantic | ADDRESSED | done |',
                                 '| RA-2 | update the stale predecessors | STILL_OPEN | not yet |']),
            reviews: [PRIOR_RC],
            state  : 'COMMENT'
        });

        expect(failure, 'COMMENT preserves the original RC and spends no budget').toBeNull();
    });

    test('#17178: a faithful, fully discharged round is accepted', () => {
        const failure = getRound2DispositionRelationFailure({
            body   : round2With(['| RA-1 | make the tier semantic | ADDRESSED | done |',
                                 '| RA-2 | update the stale predecessors | DEFENDED | argued and accepted |']),
            reviews: [PRIOR_RC],
            state  : 'APPROVED'
        });

        expect(failure, 'the positive control — the relation is not reject-everything').toBeNull();
    });

    test('#17178: a Round 2 with no prior CHANGES_REQUESTED to disposition is refused', () => {
        const failure = getRound2DispositionRelationFailure({
            body   : round2With(['| RA-1 | make the tier semantic | ADDRESSED | done |']),
            reviews: [{...PRIOR_RC, state: 'COMMENTED'}],
            state  : 'APPROVED'
        });

        expect(failure?.code, 'a first review cannot wear the Round-2 H1').toBe('PR_REVIEW_TEMPLATE_VALIDATION_FAILED');
        expect(failure.message).toContain('no submitted');
    });

    /**
     * The micro form (guide §6.4) has no Required Actions heading: a micro `CHANGES_REQUESTED` carries its actions as a
     * checklist under a bold Findings label. The relation read none of them, so choosing the micro form for a
     * mechanical PR silently removed that PR's ordinary Round 2.
     */
    const microRc = findings => ({
        ...PRIOR_RC,
        body: ['# PR Micro-Review', '', '**Class:** mechanical — test-only', '', '**Verdict:** Request Changes', '',
               '**Glance:** the counter samples the DOM after the batch.', '', ...findings, '',
               '- **Origin Session ID:** 4412eba5-6723-412d-a1c5-d9b2c22aff69'].join('\n')
    });

    const PRIOR_MICRO_RC = microRc(['**Findings:**', '- [ ] **P2 — make the oracle retain transient mounts.** Replay the records.']);

    test('#378: a Round 2 over a micro review dispositions its Findings checklist', () => {
        const failure = getRound2DispositionRelationFailure({
            body   : round2With(['| RA-1 | **P2 — make the oracle retain transient mounts.** Replay the records. | ADDRESSED | replayed |']),
            reviews: [PRIOR_MICRO_RC],
            state  : 'APPROVED'
        });

        expect(failure, 'the micro checklist is the prior round\'s action packet').toBeNull();
    });

    test('#378: over a micro review, a reworded or invented action is still refused', () => {
        const reworded = getRound2DispositionRelationFailure({
            body   : round2With(['| RA-1 | make the oracle keep transient mounts | ADDRESSED | replayed |']),
            reviews: [PRIOR_MICRO_RC],
            state  : 'APPROVED'
        });

        expect(reworded?.code).toBe('PR_REVIEW_TEMPLATE_VALIDATION_FAILED');
        expect(reworded.message).toContain('carry it verbatim');

        const invented = getRound2DispositionRelationFailure({
            body   : round2With(['| RA-1 | **P2 — make the oracle retain transient mounts.** Replay the records. | ADDRESSED | replayed |',
                                 '| RA-2 | an action no round raised | ADDRESSED | done |']),
            reviews: [PRIOR_MICRO_RC],
            state  : 'APPROVED'
        });

        expect(invented?.code).toBe('PR_REVIEW_TEMPLATE_VALIDATION_FAILED');
    });

    test('#378: a micro review whose Findings are None still gives a Round 2 nothing to disposition', () => {
        const failure = getRound2DispositionRelationFailure({
            body   : round2With(['| RA-1 | make the tier semantic | ADDRESSED | done |']),
            reviews: [microRc(['**Findings:** None.'])],
            state  : 'APPROVED'
        });

        expect(failure?.code).toBe('PR_REVIEW_TEMPLATE_VALIDATION_FAILED');
        expect(failure.message).toContain('lists no Required Actions');
    });
});

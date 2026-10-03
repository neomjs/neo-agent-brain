import {test, expect}           from '@playwright/test'
import {collisionPreventionTag} from '../../../../../../ai/services/shared/a2aCollisionTags.mjs'

/**
 * @summary Contract suite for the shared collision-tag reader — the structural rules both consumers
 * (the wake guard, fleet activity) depend on: declared concepts beat prose, a tag counts only inside
 * a segment-opening bracket run, and the vocabulary is exercised ONLY through the reader.
 */
test.describe('a2aCollisionTags — the structural reader', () => {
    test('taggedConcepts wins over prose and needs no subject at all', () => {
        expect(collisionPreventionTag({subject: 'anything at all', taggedConcepts: ['lane-claim']}))
            .toBe('lane-claim');
        expect(collisionPreventionTag({subject: '', taggedConcepts: ['  Review-Claim  ']}))
            .toBe('review-claim');
        expect(collisionPreventionTag({subject: 'the [lane-claim] guard in prose', taggedConcepts: ['unrelated']}))
            .toBeNull()
    });

    test('a tag counts inside a segment-opening bracket run, leading or not', () => {
        expect(collisionPreventionTag({subject: '[lane-claim][#15919] T1 wake-side'}))
            .toBe('lane-claim');
        expect(collisionPreventionTag({subject: '[ticket-created][lane-claim][#15900] ai:config-print'}))
            .toBe('lane-claim');
        expect(collisionPreventionTag({subject: '[merged][PR #15926] film lane 3 landed · [lane-claim][#15925] regex copy'}))
            .toBe('lane-claim')
    });

    test('prose mentions never count — the IS-vs-MENTIONS boundary', () => {
        expect(collisionPreventionTag({subject: '[falsifier-positive][D#15904] the [lane-claim] guard is ^-anchored'}))
            .toBeNull();
        expect(collisionPreventionTag({subject: 'a subject discussing [lane-claim] mid-sentence'}))
            .toBeNull();
        expect(collisionPreventionTag({subject: '[ticket-created ×2][#15933 + #15934] lane 4 claimed'}))
            .toBeNull()
    });

    // Real claim subjects, verbatim up to the first `·`: a signature mark may open the segment, and a
    // bracket may combine the tag with others.
    test('a claim behind a signature mark or inside a combined bracket counts', () => {
        for (const subject of [
            '🖖 [lane-claim] Institution #508 build (System service cards read in full), FM v1 leaf under #505',
            '⚖️ [lane-claim] Brain #811 (the open-work row summary carries the PR title), Clio\'s planner leaf, offered to me',
            '🌿 [lane-claim] Institution #510 (the Golden Path reads in full), Clio\'s planner leaf, assigned to me',
            '🪢 [lane-claim + PR-open · DRAFT] neo #19383 (Resolves #19382, docs; the planner\'s leaf, assigned to me)',
            '[ticket-created + lane-claim] neo #19368 the planner leaf',
            '⚖️ [lane-claim, BEFORE the edits] Brain #750 (routed to me by Clio)',
            '🪢 [back online · lane-claim] neo #19186 re-scoped and mine',
            '[lane-claim → PR-open] Brain #621 (from Eos\'s list) → PR #677'
        ]) {
            expect(collisionPreventionTag({subject}), subject).toBe('lane-claim')
        }

        expect(collisionPreventionTag({subject: '🖖 [claim-corrected] Institution #508 is free again'})).toBe('claim-corrected')
    });

    test('marks, combined brackets and words around a tag do not turn a mention into a claim', () => {
        for (const subject of [
            'Re: [lane-claim] Institution #508 build',
            '📜 [leaf · planner] Institution #509 waits on the lane-claim',
            '🖖 [installed window · taken] row 4 walk',
            '[not a lane-claim] just a note',
            '[lane-claim released] Brain #750',
            '🖖 the [lane-claim] guard reads subjects'
        ]) {
            expect(collisionPreventionTag({subject}), subject).toBeNull()
        }
    });

    test('the vocabulary is reachable only through the reader — all four canonical names', () => {
        // The Set itself is private by contract (a mutable export lets any importer veto the
        // class globally); the four canonical names pin today's vocabulary via the public API.
        for (const tag of ['lane-claim', 'review-claim', 'claim-corrected', 'drive-claimed']) {
            expect(collisionPreventionTag({subject: `[${tag}][#1] x`})).toBe(tag)
        }

        expect(collisionPreventionTag({subject: '[not-a-tag][#1] x'})).toBeNull();
        expect(collisionPreventionTag({})).toBeNull()
    });
});

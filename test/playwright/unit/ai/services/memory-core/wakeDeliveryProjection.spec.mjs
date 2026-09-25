import {expect, test}           from '@playwright/test';
import {projectWakeDelivery}    from '../../../../../../ai/services/memory-core/wakeDeliveryProjection.mjs';

/**
 * The defect this projects: a wake subscription whose dispatches all fail still reports itself
 * armed and deliverable, because every surface projects the seat's INTENT (`status: 'active'`,
 * `armed: true`) and nothing projects the receiver's OUTCOME. For nineteen days one seat read
 * healthy on every surface while 114 consecutive dispatches failed — the records were correct and
 * complete the whole time, and no surface existed on which they could appear.
 *
 * So the contract under test is the loud direction: an unobserved or unreadable delivery state
 * must read `unknown`, never `delivered` and never `reachable`. A projection that cannot be wrong
 * is not an instrument, it is a decoration.
 */

const at = (state, extra = {}) => ({
    recordKey         : `k-${state}-${extra.acceptedAt || ''}`,
    subscriptionId    : 'WAKE_SUB:sub-a',
    state,
    acceptedAt        : '2026-09-25T00:00:00.000Z',
    dispatchFinishedAt: '2026-09-25T00:00:01.000Z',
    ...extra
});

test.describe('projectWakeDelivery — per-subscription delivery outcome', () => {

    test('AC-3 · a failing streak is projected with the receiver\'s own outcomeReason', () => {
        // Red-first shape: one `failed` record must MOVE the projection. A reader that ignored
        // `state` would report this seat exactly as it reports the healthy one below.
        const records = [
            at('delivered', {acceptedAt: '2026-09-24T00:00:00.000Z', dispatchFinishedAt: '2026-09-24T00:00:01.000Z'}),
            at('failed', {
                acceptedAt        : '2026-09-25T00:00:00.000Z',
                dispatchFinishedAt: '2026-09-25T00:00:01.000Z',
                outcomeReason     : "opencode-server envelope requires 'agentIdentity'"
            }),
            at('failed', {
                acceptedAt        : '2026-09-25T00:01:00.000Z',
                dispatchFinishedAt: '2026-09-25T00:01:01.000Z',
                outcomeReason     : "opencode-server envelope requires 'agentIdentity'"
            })
        ];

        const projected = projectWakeDelivery(records)['WAKE_SUB:sub-a'];

        expect(projected.state, 'a trailing failure streak is undeliverable, whatever the intent says').toBe('unreachable');
        expect(projected.consecutiveFailures, 'both trailing failures are counted, not just the last').toBe(2);
        expect(projected.lastOutcomeReason, 'the reason is the receiver\'s, verbatim — not a paraphrase').toBe("opencode-server envelope requires 'agentIdentity'");
        expect(projected.lastDeliveredAt, 'the last success is still reported; the seat is not written off').toBe('2026-09-24T00:00:01.000Z');
        expect(projected.lastAttemptedAt, 'the most recent ATTEMPT is reported even while failing').toBe('2026-09-25T00:01:01.000Z');
    });

    test('AC-3 · a success after failures clears the streak but keeps the failure as history', () => {
        const projected = projectWakeDelivery([
            at('failed', {acceptedAt: '2026-09-25T00:00:00.000Z', outcomeReason: 'connection-refused'}),
            at('delivered', {acceptedAt: '2026-09-25T00:05:00.000Z', dispatchFinishedAt: '2026-09-25T00:05:01.000Z'})
        ])['WAKE_SUB:sub-a'];

        expect(projected.state).toBe('reachable');
        expect(projected.consecutiveFailures, 'a delivery RESETS the streak — otherwise a healed seat stays red forever').toBe(0);
        // `state` + `consecutiveFailures` answer "now"; the two `last*` fields answer "last known
        // fact of each kind" and are deliberately asymmetric with them. A recovered seat that
        // forgets WHY it was broken cannot be diagnosed, and `lastDeliveredAt` is already reported
        // through a failing streak for the same reason — dropping the reason on recovery while
        // keeping the timestamp would make the pair disagree about what they are for.
        expect(projected.lastOutcomeReason, 'retained as history, not as a current fault').toBe('connection-refused');
        expect(projected.lastDeliveredAt).toBe('2026-09-25T00:05:01.000Z');
    });

    test('AC-5 · non-vacuity control: the signal is neither permanently red nor permanently green', () => {
        // Without this arm every other arm passes on a payload that is uninformatively constant.
        // The defect #17647's AC-4 was written to catch is a constant-health payload, and a streak
        // counter hardwired to 1 would sail every other assertion in this file.
        const healthy = projectWakeDelivery([
            at('delivered', {acceptedAt: '2026-09-25T00:00:00.000Z', dispatchFinishedAt: '2026-09-25T00:00:01.000Z'})
        ])['WAKE_SUB:sub-a'];

        expect(healthy.state, 'a delivered dispatch is the ONLY thing that may read reachable').toBe('reachable');
        expect(healthy.consecutiveFailures).toBe(0);
        expect(healthy.lastOutcomeReason).toBeNull();
        expect(healthy.lastDeliveredAt).toBe('2026-09-25T00:00:01.000Z');
    });

    test('AC-4 · no records at all is unknown, never healthy', () => {
        // The loud direction. "No dispatch has ever been attempted" is not evidence of reachability,
        // and reporting it as reachable is the same conflation that let this stay invisible: a
        // payload that cannot be wrong cannot inform.
        expect(projectWakeDelivery([])).toEqual({});

        const empty = projectWakeDelivery([at('pending', {subscriptionId: 'WAKE_SUB:sub-b'})])['WAKE_SUB:sub-b'];

        expect(empty.state, 'a still-pending dispatch proves nothing about delivery').toBe('unknown');
        expect(empty.consecutiveFailures, 'pending is not a failure — no attempt has concluded').toBe(0);
        expect(empty.lastDeliveredAt).toBeNull();
    });

    test('`skipped` is a decision and `unknown` is an unlanded dispatch — only one of them is a failure', () => {
        // Both are real populations on a live receiver (439 and 247 records respectively at the
        // time of writing), so collapsing them into "failed" would manufacture an alarm, and
        // collapsing them into "delivered" would hide one. `skipped` means the receiver chose not
        // to dispatch; `unknown` means a dispatch was attempted and its fate is not recorded —
        // which is the same epistemic state as a failure for a reachability question.
        const skipped = projectWakeDelivery([at('skipped')])['WAKE_SUB:sub-a'];
        expect(skipped.state, 'a skip is the receiver exercising judgement, not an undelivered wake').not.toBe('unreachable');
        expect(skipped.consecutiveFailures).toBe(0);

        const unknown = projectWakeDelivery([
            at('unknown', {outcomeReason: 'receiver-restarted-during-non-idempotent-dispatch'})
        ])['WAKE_SUB:sub-a'];
        expect(unknown.state, 'an unrecorded dispatch fate is not a delivery').toBe('unreachable');
        expect(unknown.consecutiveFailures).toBe(1);
    });

    test('subscriptions are projected independently — one broken seat cannot mask a healthy one', () => {
        const projected = projectWakeDelivery([
            at('delivered', {subscriptionId: 'WAKE_SUB:healthy'}),
            at('failed', {subscriptionId: 'WAKE_SUB:broken', outcomeReason: 'envelope-refused'})
        ]);

        expect(projected['WAKE_SUB:healthy'].state).toBe('reachable');
        expect(projected['WAKE_SUB:broken'].state).toBe('unreachable');
    });

    test('the streak is ordered by ATTEMPT time, not by acceptance time', () => {
        // A digest that queues several events can be accepted before an earlier-accepted record
        // finishes dispatching. Ordering by `acceptedAt` would read the streak backwards and
        // report a recovered seat as broken.
        const projected = projectWakeDelivery([
            at('failed', {
                acceptedAt        : '2026-09-25T00:10:00.000Z',
                dispatchFinishedAt: '2026-09-25T00:10:05.000Z',
                outcomeReason     : 'later-attempt-failed'
            }),
            at('delivered', {
                acceptedAt        : '2026-09-25T00:00:00.000Z',
                dispatchFinishedAt: '2026-09-25T00:20:00.000Z'
            })
        ])['WAKE_SUB:sub-a'];

        expect(projected.state, 'the later FINISHING dispatch is the latest attempt').toBe('reachable');
        expect(projected.consecutiveFailures).toBe(0);
    });

    test('a malformed record degrades to unknown rather than being counted or trusted', () => {
        // The receiver's own reader refuses to guess a malformed record into a replayable state.
        // A projection that silently dropped one would under-report a real streak; one that
        // counted it as a success would over-report health. Neither is honest.
        const projected = projectWakeDelivery([
            at('delivered', {acceptedAt: '2026-09-25T00:00:00.000Z', dispatchFinishedAt: '2026-09-25T00:00:01.000Z'}),
            {subscriptionId: 'WAKE_SUB:sub-a', state: null, acceptedAt: '2026-09-25T00:09:00.000Z'}
        ])['WAKE_SUB:sub-a'];

        expect(projected.state).toBe('unknown');
        expect(projected.consecutiveFailures, 'an unreadable record is not a failure and not a success').toBe(0);
    });
});

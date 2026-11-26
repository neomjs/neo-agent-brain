import crypto                     from 'node:crypto';
import fs                         from 'node:fs/promises';
import os                         from 'node:os';
import path                       from 'node:path';
import {expect, test}             from '@playwright/test';
import {createWakeReceiver}       from '../../../../../../ai/daemons/wake/receiver.mjs';
import {enrollNativeWake}         from '../../../../../../ai/daemons/wake/fleetPrimarySessionWake.mjs';
import {WakeReceiverState}        from '../../../../../../ai/daemons/wake/receiverState.mjs';
import {SPOOL_CONTENTION_REASONS} from '../../../../../../ai/daemons/wake/primaryWakeSpool.mjs';
import {
    projectIdentityWakeReachability,
    projectMessageDelivery,
    projectPullRouteVerdict,
    projectWakeDelivery,
    projectWakeDeliveryStages,
    projectWakeRecordStage,
    PULL_ROUTE_SILENCE_MS
} from '../../../../../../ai/services/memory-core/wakeDeliveryProjection.mjs';

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
        // The defect this guards is a constant-health payload, and a streak counter hardwired to 1
        // would sail every other assertion in this file.
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

    test('`skipped` is transparent to the failure streak — a lone skip proves nothing', () => {
        // Both are real populations on a live receiver (439 and 247 records respectively at the
        // time of writing). `skipped` is the receiver choosing not to dispatch a digest.
        const skipped = projectWakeDelivery([at('skipped')])['WAKE_SUB:sub-a'];
        expect(skipped.state, 'a lone skip is not an attempt and not a delivery, so it resolves nothing').toBe('unknown');
        expect(skipped.consecutiveFailures).toBe(0);
    });

    test('`skipped` is transparent in the other direction too: it cannot ERASE a failure streak', () => {
        // The arm that matters. A skip carries no evidence about reachability, so it must neither
        // count against a seat nor excuse one. Before this was pinned, three failures followed by a
        // skip read `unknown / 0` — which means a seat failing every real attempt while skipping
        // digests in between would read healthy-ish between failures. That is this ticket's own
        // failure mode pointed the other way, and it is invisible unless an arm interleaves the two.
        const projected = projectWakeDelivery([
            at('skipped', {acceptedAt: '2026-09-25T00:03:00.000Z', dispatchFinishedAt: '2026-09-25T00:03:01.000Z'}),
            at('failed', {acceptedAt: '2026-09-25T00:02:00.000Z', dispatchFinishedAt: '2026-09-25T00:02:01.000Z', outcomeReason: 'a'}),
            at('failed', {acceptedAt: '2026-09-25T00:01:00.000Z', dispatchFinishedAt: '2026-09-25T00:01:01.000Z', outcomeReason: 'b'}),
            at('failed', {acceptedAt: '2026-09-25T00:00:00.000Z', dispatchFinishedAt: '2026-09-25T00:00:01.000Z', outcomeReason: 'c'})
        ])['WAKE_SUB:sub-a'];

        expect(projected.state, 'the newest record is a skip, and a skip decides nothing').toBe('unreachable');
        expect(projected.consecutiveFailures, 'all three real failures still count — the skip neither adds nor excuses').toBe(3);
        expect(projected.lastOutcomeReason, 'the most recent FAILURE reason survives the skip').toBe('a');
        expect(projected.lastAttemptedAt, 'the receiver genuinely was asked, most recently by the skip').toBe('2026-09-25T00:03:01.000Z');
    });

    // A skip may carry its cause; the projection must read it as it reads any skip.
    test('a skip that names its cause still decides nothing, and its reason is never the failure reason', () => {
        const reason = 'instance-unresolved: No running Claude instance found',
              lone   = projectWakeDelivery([at('skipped', {outcomeReason: reason})])['WAKE_SUB:sub-a'],
              after  = projectWakeDelivery([
                  at('skipped', {acceptedAt: '2026-09-25T00:01:00.000Z', dispatchFinishedAt: '2026-09-25T00:01:01.000Z', outcomeReason: reason}),
                  at('failed', {acceptedAt: '2026-09-25T00:00:00.000Z', dispatchFinishedAt: '2026-09-25T00:00:01.000Z', outcomeReason: 'a'})
              ])['WAKE_SUB:sub-a'];

        expect(lone).toMatchObject({state: 'unknown', consecutiveFailures: 0, lastOutcomeReason: null});
        expect(after).toMatchObject({state: 'unreachable', consecutiveFailures: 1, lastOutcomeReason: 'a'});
    });

    test('a delivery followed only by a run of skips is no longer evidence that a wake lands', () => {
        const minute = n => `2026-09-25T00:0${n}:01.000Z`,
            records  = n => [at('delivered', {dispatchFinishedAt: minute(0)}),
                ...Array.from({length: n}, (_, i) => at('skipped', {acceptedAt: minute(i + 1), dispatchFinishedAt: minute(i + 1)}))],
            stale = projectWakeDelivery(records(3))['WAKE_SUB:sub-a'];

        expect(stale.state, 'the run retires the delivery as evidence, without claiming a failure').toBe('unknown');
        expect(stale).toMatchObject({consecutiveSkips: 3, consecutiveFailures: 0, lastDeliveredAt: minute(0), lastAttemptedAt: minute(3)});
        // The control: a shorter run still decides nothing, and a later delivery closes the run
        expect(projectWakeDelivery(records(2))['WAKE_SUB:sub-a']).toMatchObject({state: 'reachable', consecutiveSkips: 2});
        expect(projectWakeDelivery([...records(3), at('delivered', {acceptedAt: minute(4), dispatchFinishedAt: minute(4)})])['WAKE_SUB:sub-a'])
            .toMatchObject({state: 'reachable', consecutiveSkips: 0});
        // A run after failures still cannot erase them
        expect(projectWakeDelivery([at('failed', {outcomeReason: 'a'}), ...records(3).slice(1)])['WAKE_SUB:sub-a'])
            .toMatchObject({state: 'unreachable', consecutiveFailures: 1, consecutiveSkips: 3})
    });

    test('source-events-already-handled skips preserve reachable after a delivery while context-gate skips still trip STALE_SKIP_RUN', () => {
        const stamp      = n => `2026-09-25T00:${String(n).padStart(2, '0')}:01.000Z`,
              settledRun = [
                  at('delivered', {acceptedAt: stamp(0), dispatchFinishedAt: stamp(0)}),
                  ...Array.from({length: 10}, (_, index) => at('skipped', {
                      acceptedAt        : stamp(index + 1),
                      dispatchFinishedAt: stamp(index + 1),
                      outcomeReason     : 'source-events-already-handled'
                  }))
              ],
              gateRun = [
                  at('delivered', {acceptedAt: stamp(0), dispatchFinishedAt: stamp(0)}),
                  ...Array.from({length: 3}, (_, index) => at('skipped', {
                      acceptedAt        : stamp(index + 1),
                      dispatchFinishedAt: stamp(index + 1),
                      outcomeReason     : 'context-gate:active'
                  }))
              ];

        expect(projectWakeDelivery(settledRun)['WAKE_SUB:sub-a']).toMatchObject({
            state              : 'reachable',
            consecutiveFailures: 0,
            consecutiveSkips   : 0,
            lastDeliveredAt    : stamp(0),
            lastAttemptedAt    : stamp(10)
        });
        expect(projectWakeDelivery(gateRun)['WAKE_SUB:sub-a']).toMatchObject({
            state           : 'unknown',
            consecutiveSkips: 3
        });
        expect(projectWakeDelivery([
            at('failed', {acceptedAt: stamp(0), dispatchFinishedAt: stamp(0), outcomeReason: 'socket-hangup'}),
            ...settledRun.slice(1, 5)
        ])['WAKE_SUB:sub-a']).toMatchObject({
            state              : 'unreachable',
            consecutiveFailures: 1,
            consecutiveSkips   : 0,
            lastOutcomeReason  : 'socket-hangup'
        });
    });

    test('a delivery is an attempt, so `lastAttemptedAt` never predates `lastDeliveredAt`', () => {
        const projected = projectWakeDelivery([
            at('failed', {outcomeReason: 'connection-refused'}),
            at('delivered', {acceptedAt: '2026-09-25T00:05:00.000Z', dispatchFinishedAt: '2026-09-25T00:05:01.000Z'})
        ])['WAKE_SUB:sub-a'];

        expect(projected.lastAttemptedAt).toBe('2026-09-25T00:05:01.000Z');
        expect(projected.lastDeliveredAt).toBe('2026-09-25T00:05:01.000Z')
    });

    test('`unknown` state IS a failure — an unlanded dispatch is not a delivery', () => {
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

test.describe('projectIdentityWakeReachability — one seat across its routes', () => {
    const
        verdicts = {
            ok   : {state: 'reachable',   consecutiveFailures: 0, lastOutcomeReason: null,         lastAttemptedAt: '2026-10-01T10:00:00.000Z'},
            older: {state: 'unreachable', consecutiveFailures: 4, lastOutcomeReason: 'old reason', lastAttemptedAt: '2026-10-01T09:00:00.000Z'},
            newer: {state: 'unreachable', consecutiveFailures: 2, lastOutcomeReason: 'new reason', lastAttemptedAt: '2026-10-01T11:00:00.000Z'},
            quiet: {state: 'unknown',     consecutiveFailures: 0, lastOutcomeReason: null,         lastAttemptedAt: null}
        },
        active    = (...ids) => ids.map(id => ({id})),
        withdrawn = (id, refusal) => ({id, withdrawn: true, ...(refusal ? {refusal} : {})});

    test('one route that lands makes the seat reachable, whatever its other routes do', () => {
        expect(projectIdentityWakeReachability(active('older', 'ok', 'newer'), verdicts)).toEqual({state: 'reachable'});
        expect(projectIdentityWakeReachability([...active('ok'), withdrawn('older', 'not-in-receiver-manifest')], verdicts))
            .toEqual({state: 'reachable'});
    });

    test('with every active route concluded failing the seat is undeliverable, with the newest failing route\'s reason and streak', () => {
        expect(projectIdentityWakeReachability(active('older', 'newer'), verdicts))
            .toEqual({state: 'undeliverable', reason: 'new reason', consecutiveFailures: 2});
    });

    test('a failing route beside one the receiver never concluded keeps the seat unknown: one failure is not evidence about every route', () => {
        // The mixed cases: a failed route with an unknown sibling, and with a sibling that has no
        // records at all. Before this arm both read undeliverable, and the pure spec pinned that.
        for (const ids of [['older', 'newer', 'quiet'], ['newer', 'absent'], ['quiet', 'older']]) {
            expect(projectIdentityWakeReachability(active(...ids), verdicts), JSON.stringify(ids)).toEqual({state: 'unknown'});
        }
    });

    test('a route never concluded, a route with no records and no route at all read unknown, never reachable', () => {
        for (const ids of [['quiet'], ['absent'], []]) {
            expect(projectIdentityWakeReachability(active(...ids), verdicts), JSON.stringify(ids)).toEqual({state: 'unknown'});
        }
    });

    test('a refusal concludes its route, over the receiver\'s older records for it (#837)', () => {
        // the receiver writes no record for a route it refuses, so a delivered record is older than the refusal
        expect(projectIdentityWakeReachability([{id: 'ok', refusal: 'not-in-receiver-manifest'}], verdicts))
            .toEqual({state: 'undeliverable', reason: 'not-in-receiver-manifest'});
    });

    test('a seat whose every route was withdrawn reads withdrawn, and names the refusal only when every route carries it (#837)', () => {
        expect(projectIdentityWakeReachability([withdrawn('older'), withdrawn('newer')], verdicts)).toEqual({state: 'withdrawn'});
        expect(projectIdentityWakeReachability([withdrawn('older', 'not-in-receiver-manifest'), withdrawn('newer')], verdicts))
            .toEqual({state: 'withdrawn'});
        expect(projectIdentityWakeReachability([withdrawn('older', 'not-in-receiver-manifest')], verdicts))
            .toEqual({state: 'withdrawn', reason: 'not-in-receiver-manifest'});
        // an active route the receiver never concluded might still deliver, so it outranks a withdrawn sibling
        expect(projectIdentityWakeReachability([...active('quiet'), withdrawn('older')], verdicts)).toEqual({state: 'unknown'});
    });
});

test.describe('projectMessageDelivery — did one particular wake arrive?', () => {
    // A digest carries every message it coalesced in `sourceEventIds`, and one message can ride several routes
    const carrying = (state, sourceEventIds, finishedAt = '2026-11-13T00:00:01.000Z') =>
        at(state, {recordKey: `k-${state}-${sourceEventIds.join()}-${finishedAt}`, sourceEventIds, dispatchFinishedAt: finishedAt});

    test('a message inside a delivered digest reads delivered, at that dispatch', () => {
        expect(projectMessageDelivery([carrying('delivered', ['MESSAGE:a', 'MESSAGE:b'])], ['MESSAGE:b']))
            .toEqual({'MESSAGE:b': {state: 'delivered', at: '2026-11-13T00:00:01.000Z'}});
    });

    test('failed, skipped and absent stay distinct, and none of them reads delivered', () => {
        expect(projectMessageDelivery([carrying('failed', ['MESSAGE:f']), carrying('skipped', ['MESSAGE:s'])],
            ['MESSAGE:f', 'MESSAGE:s', 'MESSAGE:none'])).toEqual({
            'MESSAGE:f'   : {state: 'failed',      at: '2026-11-13T00:00:01.000Z'},
            'MESSAGE:s'   : {state: 'skipped',     at: '2026-11-13T00:00:01.000Z'},
            'MESSAGE:none': {state: 'undelivered', at: null}
        });
    });

    test('one delivery among several attempts is enough, and its time is the first delivery', () => {
        expect(projectMessageDelivery([
            carrying('delivered', ['MESSAGE:m'], '2026-11-13T02:00:00.000Z'),
            carrying('failed',    ['MESSAGE:m'], '2026-11-13T03:00:00.000Z'),
            carrying('delivered', ['MESSAGE:m'], '2026-11-13T01:00:00.000Z')
        ], ['MESSAGE:m'])).toEqual({'MESSAGE:m': {state: 'delivered', at: '2026-11-13T01:00:00.000Z'}});
    });

    test('without a delivery, a fate still open outranks a concluded failure: the wake may yet land', () => {
        for (const open of ['pending', 'dispatching', 'unknown', null]) {
            expect(projectMessageDelivery([carrying('failed', ['MESSAGE:m']), carrying(open, ['MESSAGE:m'])], ['MESSAGE:m'])['MESSAGE:m'].state,
                String(open)).toBe('unknown')
        }
    });

    test('records that could not be read leave every message unknown, never undelivered', () => {
        expect(projectMessageDelivery(null, ['MESSAGE:m'])).toEqual({'MESSAGE:m': {state: 'unknown', at: null}});
        expect(projectMessageDelivery([], ['MESSAGE:m']), 'a readable, empty directory is a measured absence')
            .toEqual({'MESSAGE:m': {state: 'undelivered', at: null}});
    });

    test('a record speaks only for the messages it carries, and an inherited key is no message', () => {
        expect(projectMessageDelivery([at('delivered'), carrying('delivered', ['constructor'])], ['MESSAGE:m', 'toString']))
            .toEqual({'MESSAGE:m': {state: 'undelivered', at: null}, toString: {state: 'undelivered', at: null}});
    });
});

/**
 * A pull route has no dispatcher, so no receiver record ever concludes it: its seat polls it. Its own
 * last poll and the seat's turn presence conclude it instead, so a seat left without a listener (a crash,
 * a killed process, a failed turn no rewake cures) reads deaf instead of `unknown`.
 */
test.describe('projectPullRouteVerdict — a pull route concluded by its own poll', () => {
    const
        NOW        = Date.parse('2026-11-13T12:00:00.000Z'),
        polledAgo  = ms => new Date(NOW - ms).toISOString(),
        stale      = polledAgo(PULL_ROUTE_SILENCE_MS + 1),
        inProgress = {fresh: true},
        finished   = {fresh: false};

    test('a poll inside the silence bound reads reachable', () => {
        expect(projectPullRouteVerdict({lastPollAt: polledAgo(PULL_ROUTE_SILENCE_MS), now: NOW})).toEqual({state: 'reachable'})
    });

    test('a stale poll during a fresh turn reads reachable: the seat handed its listener to that turn', () => {
        expect(projectPullRouteVerdict({lastPollAt: stale, presence: inProgress, now: NOW})).toEqual({state: 'reachable'})
    });

    test('a stale poll with no turn in progress reads unreachable and names the last poll', () => {
        for (const presence of [null, finished]) {
            expect(projectPullRouteVerdict({lastPollAt: stale, presence, now: NOW}), JSON.stringify(presence)).toEqual({
                state            : 'unreachable',
                lastAttemptedAt  : stale,
                lastOutcomeReason: `listener silent: no poll since ${stale} and no turn in progress`
            })
        }
    });

    test('a route that never polled stays unconcluded', () => {
        expect(projectPullRouteVerdict({lastPollAt: null, now: NOW})).toBe(null)
    });

    test('a pull-only seat whose route is silent reads undeliverable, and stays unknown beside a route nobody concluded', () => {
        const silent = projectPullRouteVerdict({lastPollAt: stale, now: NOW});

        expect(projectIdentityWakeReachability([{id: 'pull'}], {pull: silent}))
            .toEqual({state: 'undeliverable', reason: silent.lastOutcomeReason, consecutiveFailures: undefined});
        expect(projectIdentityWakeReachability([{id: 'pull'}, {id: 'push'}], {pull: silent})).toEqual({state: 'unknown'})
    })
});

test.describe('projectWakeRecordStage & projectWakeDeliveryStages — stage and split-latency reporting', () => {
    test('distinguishes waiting-for-policy, waiting-for-chat-boundary, waiting-for-receipt, and delivered without settling on host ack', () => {
        const policyQueue = {
            'MESSAGE:policy': {
                subscriptionId: 'WAKE_SUB:sub-a',
                sentAt        : '2026-11-15T09:00:00.000Z',
                firstQueuedAt : '2026-11-15T09:00:00.010Z',
                priority      : 'normal',
                urgent        : false
            }
        };

        const boundaryRecord = {
            recordKey      : 'a'.repeat(64),
            subscriptionId : 'WAKE_SUB:sub-a',
            sourceEventIds : ['MESSAGE:active-turn'],
            state          : 'pending',
            urgent         : true,
            sourceSentAt   : '2026-11-15T09:00:00.000Z',
            firstQueuedAt  : '2026-11-15T09:00:00.005Z',
            emittedAt      : '2026-11-15T09:00:00.055Z',
            acceptedAt     : '2026-11-15T09:00:00.070Z',
            hostStagedAt   : '2026-11-15T09:00:00.075Z',
            waitStage      : 'waiting-for-chat-boundary',
            deferReason    : 'native-recipient:active-turn-adapter-unavailable',
            namedDependency: '#1741'
        };

        const hostAckOnlyRecord = {
            recordKey        : 'b'.repeat(64),
            subscriptionId   : 'WAKE_SUB:sub-a',
            sourceEventIds   : ['MESSAGE:host-ack-only'],
            state            : 'pending',
            urgent           : true,
            sourceSentAt     : '2026-11-15T09:00:00.000Z',
            acceptedAt       : '2026-11-15T09:00:00.060Z',
            hostStagedAt     : '2026-11-15T09:00:00.065Z',
            nativeInitiatedAt: '2026-11-15T09:00:00.080Z',
            nativeStatus     : 'unknown',
            waitStage        : 'waiting-for-receipt',
            deferReason      : 'native-recipient:receipt-unproven'
        };

        const deliveredRecord = {
            recordKey          : 'c'.repeat(64),
            subscriptionId     : 'WAKE_SUB:sub-a',
            sourceEventIds     : ['MESSAGE:settled'],
            state              : 'delivered',
            urgent             : true,
            sourceSentAt       : '2026-11-15T09:00:00.000Z',
            firstQueuedAt      : '2026-11-15T09:00:00.004Z',
            emittedAt          : '2026-11-15T09:00:00.054Z',
            acceptedAt         : '2026-11-15T09:00:00.064Z',
            hostStagedAt       : '2026-11-15T09:00:00.066Z',
            nativeInitiatedAt  : '2026-11-15T09:00:00.090Z',
            recipientObservedAt: '2026-11-15T09:00:00.214Z',
            dispatchFinishedAt : '2026-11-15T09:00:00.220Z',
            waitStage          : 'delivered'
        };

        const stages = projectWakeDeliveryStages(
            [boundaryRecord, hostAckOnlyRecord, deliveredRecord],
            {
                messageIds: ['MESSAGE:policy', 'MESSAGE:active-turn', 'MESSAGE:host-ack-only', 'MESSAGE:settled'],
                policyQueue,
                now       : '2026-11-15T09:00:01.000Z'
            }
        );

        expect(stages['MESSAGE:policy']).toMatchObject({
            stage            : 'waiting-for-policy',
            settled          : false,
            eventToHostMs    : null,
            hostToRecipientMs: null,
            policyWaitMs     : 990
        });

        expect(stages['MESSAGE:active-turn']).toMatchObject({
            stage            : 'waiting-for-chat-boundary',
            settled          : false,
            urgent           : true,
            reason           : 'native-recipient:active-turn-adapter-unavailable',
            dependency       : '#1741',
            eventToHostMs    : 70,
            hostToRecipientMs: null,
            totalLatencyMs   : null
        });

        expect(stages['MESSAGE:host-ack-only']).toMatchObject({
            stage             : 'waiting-for-receipt',
            settled           : false,
            urgent            : true,
            reason            : 'native-recipient:receipt-unproven',
            eventToHostMs     : 60,
            hostToRecipientMs : null,
            chatBoundaryWaitMs: 20,
            receiptWaitMs     : 920,
            totalLatencyMs    : null
        });

        expect(projectWakeRecordStage(deliveredRecord)).toMatchObject({
            stage             : 'delivered',
            settled           : true,
            urgent            : true,
            dependency        : null,
            policyWaitMs      : 50,
            eventToHostMs     : 64,
            hostToRecipientMs : 150,
            chatBoundaryWaitMs: 26,
            receiptWaitMs     : 124,
            totalLatencyMs    : 214
        });
        expect(stages['MESSAGE:settled'].settled).toBe(true);
    });

    test('AC-4(a) — spool-contention deferrals map to waiting-for-spool with null hostStagedAt and null chatBoundaryWaitMs', () => {
        for (const deferReason of SPOOL_CONTENTION_REASONS) {
            const stage = projectWakeRecordStage({
                recordKey        : `rec-${deferReason}`,
                subscriptionId   : 'WAKE_SUB:spool',
                sourceEventIds   : ['MESSAGE:spool-wait'],
                state            : 'pending',
                urgent           : deferReason === 'earlier urgent native wake outstanding',
                sourceSentAt     : '2026-11-15T09:00:00.000Z',
                acceptedAt       : '2026-11-15T09:00:00.050Z',
                dispatchStartedAt: '2026-11-15T09:00:00.060Z',
                waitStage        : 'waiting-for-spool',
                deferReason
            }, {now: '2026-11-15T09:00:01.000Z'});

            expect(stage, deferReason).toMatchObject({
                stage             : 'waiting-for-spool',
                settled           : false,
                reason            : deferReason,
                chatBoundaryWaitMs: null,
                receiptWaitMs     : null,
                timestamps        : {
                    acceptedAt       : '2026-11-15T09:00:00.050Z',
                    hostStagedAt     : null,
                    nativeInitiatedAt: null
                }
            });
        }
    });

    test('AC-4(c) — receiver accept -> projectWakeDeliveryStages round-trip preserves ISO firstQueuedAt and finite policyWaitMs', async () => {
        const dir        = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-roundtrip-'));
        const signingKey = crypto.randomBytes(32).toString('hex');
        const t0         = Date.parse('2026-11-15T09:00:00.000Z');
        let receiver, server;

        try {
            const state = new WakeReceiverState({stateDir: path.join(dir, 'state')});
            await state.init();

            const manifestPath = path.join(dir, 'manifest.json');
            const subId        = 'WAKE_SUB:roundtrip';
            const manifest     = {
                schemaVersion: 1,
                routes       : {
                    [subId]: {
                        agentIdentity        : '@roundtrip',
                        signingKey,
                        admits               : 'wake/digest',
                        harnessTargetMetadata: {adapter: 'osascript', appName: 'Codex'},
                        adapterConfig        : {attemptTimeoutMs: 1000}
                    }
                }
            };
            await fs.writeFile(manifestPath, JSON.stringify(manifest), {mode: 0o600});

            receiver = createWakeReceiver({
                manifest,
                state,
                manifestPath,
                clock   : () => t0 + 75,
                dispatch: async () => 'delivered',
                logger  : {log(){}, warn(){}, error(){}}
            });
            server = receiver.server;
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            const url = `http://127.0.0.1:${server.address().port}/wake`;

            const sentAt   = new Date(t0 - 1_000).toISOString();
            const envelope = {
                schemaVersion : '1.0',
                eventType     : 'wake/digest',
                eventId       : 'wake-digest:rt-iso',
                agentIdentity : '@roundtrip',
                subscriptionId: subId,
                payload       : {
                    totalEvents       : 1,
                    sourceEventIds    : ['MESSAGE:roundtrip-1'],
                    firstQueuedAt     : new Date(t0).toISOString(),
                    urgent            : true,
                    earliestSentAt    : sentAt,
                    latestUrgentSentAt: sentAt,
                    messageSentAt     : {'MESSAGE:roundtrip-1': sentAt},
                    breakdown         : {sent_to_me: {count: 1, highestPriority: 'high', latest: {priority: 'high', sentAt}}}
                },
                emittedAt: new Date(t0 + 50).toISOString()
            };
            const body      = JSON.stringify(envelope),
                  signature = crypto.createHmac('sha256', signingKey).update(body).digest('hex');

            const response = await fetch(url, {
                method : 'POST',
                headers: {
                    'content-type'              : 'application/json',
                    'x-neo-wake-subscription-id': subId,
                    'x-neo-wake-event-id'       : envelope.eventId,
                    'x-neo-wake-schema-version' : '1.0',
                    'x-neo-wake-signature'      : signature
                },
                body
            });
            expect(response.status).toBe(202);
            await receiver.drain();

            const recordFiles = (await fs.readdir(state.recordsDir)).filter(name => name.endsWith('.json'));
            const records     = await Promise.all(
                recordFiles.map(async name => JSON.parse(await fs.readFile(path.join(state.recordsDir, name), 'utf8')))
            );
            const messageStages = projectWakeDeliveryStages(records, {
                messageIds : ['MESSAGE:roundtrip-1'],
                policyQueue: []
            });
            expect(messageStages['MESSAGE:roundtrip-1']).toMatchObject({
                stage       : 'delivered',
                settled     : true,
                urgent      : true,
                policyWaitMs: 50,
                timestamps  : {
                    sourceSentAt : sentAt,
                    firstQueuedAt: new Date(t0).toISOString(),
                    emittedAt    : new Date(t0 + 50).toISOString(),
                    acceptedAt   : new Date(t0 + 75).toISOString()
                }
            });
        } finally {
            if (server) await new Promise(resolve => server.close(resolve));
            await fs.rm(dir, {recursive: true, force: true});
        }
    });

    test('AC-4(d) — per-message messageSentAt avoids cross-contamination and urgent digests without map prefer latestUrgentSentAt', () => {
        const earlyNormal = '2026-11-15T08:50:00.000Z',
              lateUrgent  = '2026-11-15T09:00:00.000Z';

        const coalescedRecord = {
            recordKey         : 'rec-coalesced',
            subscriptionId    : 'WAKE_SUB:mix',
            sourceEventIds    : ['MESSAGE:early-normal', 'MESSAGE:late-urgent'],
            state             : 'delivered',
            urgent            : true,
            acceptedAt        : '2026-11-15T09:00:01.000Z',
            dispatchFinishedAt: '2026-11-15T09:00:01.200Z',
            envelope          : {
                emittedAt: '2026-11-15T09:00:00.050Z',
                payload  : {
                    earliestSentAt    : earlyNormal,
                    latestUrgentSentAt: lateUrgent,
                    messageSentAt     : {
                        'MESSAGE:early-normal': earlyNormal,
                        'MESSAGE:late-urgent' : lateUrgent
                    },
                    breakdown: {sent_to_me: {count: 2, highestPriority: 'high', latest: {priority: 'high', sentAt: lateUrgent}}}
                }
            }
        };

        const stages = projectWakeDeliveryStages([coalescedRecord], {
            messageIds: ['MESSAGE:early-normal', 'MESSAGE:late-urgent']
        });
        expect(stages['MESSAGE:early-normal'].timestamps.sourceSentAt).toBe(earlyNormal);
        expect(stages['MESSAGE:late-urgent'].timestamps.sourceSentAt).toBe(lateUrgent);
        expect(stages['MESSAGE:early-normal'].totalLatencyMs).toBe(601_200);
        expect(stages['MESSAGE:late-urgent'].totalLatencyMs).toBe(1_200);

        const legacyUrgentNoMap = projectWakeRecordStage({
            recordKey     : 'rec-legacy-urgent',
            subscriptionId: 'WAKE_SUB:mix',
            sourceEventIds: ['MESSAGE:late-urgent'],
            state         : 'pending',
            urgent        : true,
            acceptedAt    : '2026-11-15T09:00:01.000Z',
            envelope      : {
                payload: {
                    earliestSentAt    : earlyNormal,
                    latestUrgentSentAt: lateUrgent,
                    breakdown         : {sent_to_me: {count: 2, highestPriority: 'high', latest: {priority: 'high', sentAt: lateUrgent}}}
                }
            }
        });
        expect(legacyUrgentNoMap.timestamps.sourceSentAt).toBe(lateUrgent);
    });

    test('AC-4(e) — policyQueue arrays merge deterministically across subscriptions and respect boolean urgent: false on expired high', () => {
        const stages = projectWakeDeliveryStages([], {
            messageIds : ['MESSAGE:shared', 'MESSAGE:expired-high'],
            policyQueue: [
                {
                    messageId     : 'MESSAGE:shared',
                    subscriptionId: 'WAKE_SUB:sub-a',
                    firstQueuedAt : '2026-11-15T09:00:10.000Z',
                    sentAt        : '2026-11-15T09:00:00.000Z',
                    priority      : 'normal',
                    urgent        : false
                },
                {
                    messageId     : 'MESSAGE:shared',
                    subscriptionId: 'WAKE_SUB:sub-b',
                    firstQueuedAt : '2026-11-15T09:00:05.000Z',
                    sentAt        : null,
                    priority      : 'high',
                    urgent        : true
                },
                {
                    messageId     : 'MESSAGE:expired-high',
                    subscriptionId: 'WAKE_SUB:sub-a',
                    firstQueuedAt : '2026-11-15T09:00:00.000Z',
                    sentAt        : '2026-11-15T07:00:00.000Z',
                    priority      : 'high',
                    urgent        : false
                }
            ],
            now: '2026-11-15T09:00:20.000Z'
        });

        expect(stages['MESSAGE:shared']).toMatchObject({
            stage       : 'waiting-for-policy',
            urgent      : true,
            policyWaitMs: 15_000,
            timestamps  : {
                firstQueuedAt: '2026-11-15T09:00:05.000Z',
                sourceSentAt : '2026-11-15T09:00:00.000Z'
            }
        });
        expect(stages['MESSAGE:expired-high']).toMatchObject({
            stage : 'waiting-for-policy',
            urgent: false
        });
    });

    test('AC-4(f) — unknown or unrecognized record states map to unknown without leaking into open receipt waits, and settled terminal outcomes win over receipt deferReasons', () => {
        const unknownStage = projectWakeRecordStage({
            recordKey     : 'rec-unknown',
            subscriptionId: 'WAKE_SUB:x',
            sourceEventIds: ['MESSAGE:u1'],
            state         : 'unknown',
            urgent        : true,
            nativeStatus  : 'unknown',
            deferReason   : 'native-recipient:receipt-unproven',
            waitStage     : 'waiting-for-receipt',
            acceptedAt    : '2026-11-15T09:00:00.050Z'
        });
        expect(unknownStage).toMatchObject({
            stage     : 'unknown',
            settled   : false,
            urgent    : true,
            reason    : 'native-recipient:receipt-unproven',
            timestamps: {acceptedAt: '2026-11-15T09:00:00.050Z'}
        });

        const weirdStage = projectWakeRecordStage({
            recordKey     : 'rec-weird',
            subscriptionId: 'WAKE_SUB:x',
            sourceEventIds: ['MESSAGE:u2'],
            state         : 'unrecognized-state',
            deferReason   : 'native-recipient:receipt-unproven'
        });
        expect(weirdStage.stage).toBe('unknown');

        const failedAfterReceipt = projectWakeRecordStage({
            recordKey     : 'rec-failed',
            subscriptionId: 'WAKE_SUB:x',
            sourceEventIds: ['MESSAGE:f1'],
            state         : 'failed',
            nativeStatus  : 'unknown',
            deferReason   : 'native-recipient:receipt-unproven',
            outcomeReason : 'transport-error'
        });
        expect(failedAfterReceipt).toMatchObject({stage: 'failed', reason: 'transport-error'});

        const stages = projectWakeDeliveryStages([{
            recordKey     : 'rec-unknown-2',
            subscriptionId: 'WAKE_SUB:x',
            sourceEventIds: ['MESSAGE:u1'],
            state         : 'unknown',
            outcomeReason : 'corrupt-record'
        }], {messageIds: ['MESSAGE:u1']});
        expect(stages['MESSAGE:u1'].stage).toBe('unknown');
    });

    test('AC-4(g) — receiver native stalled-hold transition persists holdStartedAt and projectWakeRecordStage surfaces holdAgeMs (#1854)', async () => {
        const dir        = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-stalled-hold-'));
        const signingKey = crypto.randomBytes(32).toString('hex');
        const t0         = Date.parse('2026-11-25T10:00:00.000Z');
        let receiver;

        try {
            const state = new WakeReceiverState({stateDir: path.join(dir, 'state')});
            await state.init();
            const manifestPath = path.join(dir, 'manifest.json');
            const subId        = 'WAKE_SUB:stalled';
            const route        = {
                agentIdentity        : '@stalled-seat',
                signingKey,
                admits               : 'wake/digest',
                harnessTargetMetadata: {adapter: 'primary-session'},
                adapterConfig        : {primarySession: {agentId: 'stalled-seat', family: 'antigravity'}}
            };
            const manifest = {schemaVersion: 1, routes: {[subId]: route}};
            await fs.writeFile(manifestPath, JSON.stringify(manifest), {mode: 0o600});
            await enrollNativeWake({manifestPath, stateDir: state.stateDir, agentId: 'stalled-seat', family: 'antigravity'});

            const accepted = (await state.accept({
                subscriptionId: subId,
                eventId       : 'evt-stalled-1',
                sourceEventIds: ['MESSAGE:stalled-1'],
                acceptedAt    : new Date(t0).toISOString(),
                envelope      : {
                    schemaVersion : '1.0',
                    eventType     : 'wake/digest',
                    eventId       : 'evt-stalled-1',
                    agentIdentity : '@stalled-seat',
                    subscriptionId: subId,
                    emittedAt     : new Date(t0).toISOString(),
                    payload       : {
                        totalEvents   : 1,
                        sourceEventIds: ['MESSAGE:stalled-1'],
                        urgent        : true,
                        earliestSentAt: new Date(t0 - 500).toISOString(),
                        breakdown     : {sent_to_me: {count: 1, highestPriority: 'high', latest: {priority: 'high', sentAt: new Date(t0 - 500).toISOString()}}}
                    }
                },
                route
            })).record;

            let delivered = false;
            receiver = createWakeReceiver({
                manifest,
                state,
                manifestPath,
                clock          : () => t0 + 20 * 60 * 1000,
                dispatchPrimary: async () => delivered
                    ? {
                        status   : 'delivered',
                        recipient: {
                            seat      : '@stalled-seat',
                            generation: '601:birth',
                            threadId  : crypto.randomUUID(),
                            recordKey : accepted.recordKey,
                            nonce     : crypto.randomUUID()
                        }
                    }
                    : {
                        status                : 'pending',
                        reason                : 'native-recipient:stalled-active-turn',
                        dependency            : '#1741',
                        holdStartedAt         : '2026-11-25T10:01:00.000Z',
                        lastTranscriptGrowthAt: '2026-11-25T10:04:00.000Z'
                    },
                logger: {log(){}, warn(){}, error(){}}
            });

            await receiver.drain();
            const heldRecord = await state.read(accepted.recordKey);
            const heldStage  = projectWakeRecordStage(heldRecord, {now: '2026-11-25T10:21:00.000Z'});
            expect(heldStage).toMatchObject({
                stage     : 'waiting-for-chat-boundary',
                settled   : false,
                urgent    : true,
                reason    : 'native-recipient:stalled-active-turn',
                dependency: '#1741',
                holdAgeMs : 20 * 60 * 1000,
                timestamps: {
                    holdStartedAt         : '2026-11-25T10:01:00.000Z',
                    lastTranscriptGrowthAt: '2026-11-25T10:04:00.000Z'
                }
            });

            delivered = true;
            await receiver.drain();
            const settledRecord = await state.read(accepted.recordKey);
            expect(settledRecord.holdStartedAt).toBeNull();
            expect(settledRecord.lastTranscriptGrowthAt).toBeNull();
            const settledStage = projectWakeRecordStage(settledRecord, {now: '2026-11-25T10:22:00.000Z'});
            expect(settledStage).toMatchObject({
                stage     : 'delivered',
                settled   : true,
                holdAgeMs : null,
                timestamps: {
                    holdStartedAt         : null,
                    lastTranscriptGrowthAt: null
                }
            });
        } finally {
            await fs.rm(dir, {recursive: true, force: true});
        }
    });
});

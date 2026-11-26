/**
 * @summary Projects the wake receiver's own dispatch records into delivery verdicts: per subscription, per identity and
 * per wake message.
 *
 * **The gap this fills:** every wake surface in the substrate projects the seat's *intent* —
 * `status: 'active'`, `armed: true`, `harnessTarget: 'a2a-webhook'` — and none of them projected the
 * receiver's *outcome*. Those are different questions, and the difference is invisible until a wake
 * stops landing: a subscription can be unambiguously armed, correctly routed, correctly signed, and
 * still have every single dispatch fail. That combination read healthy on every surface for
 * nineteen days while one seat accumulated 114 consecutive failures, because no surface existed on
 * which a failure could appear. The records were correct and complete the whole time; nothing
 * projected them.
 *
 * **The rule is the loud direction, and it is inherited rather than invented.** `wakeSubscriptionStatusPolicy`
 * settled the *absent* case as `absent ⇒ active`, justified as failing in the loud direction. That
 * reasoning does not reach a row that is present, active, and unreachable — the row is
 * unambiguous there, and unambiguous is not the same as reachable. So this projection refuses to
 * resolve in the healthy direction on absence of evidence: no records, a still-pending dispatch, a
 * malformed record, and a state it does not recognise all read `unknown`. `reachable` is earned by
 * an observed `delivered` record and nothing else.
 *
 * **Pure by construction, and that is the whole testability story.** This module does no I/O — it
 * takes records and returns a verdict — so the projection's semantics are unit-testable without a
 * receiver, a filesystem, or a running daemon. The filesystem reader lives in the caller. That
 * split is deliberate: the interesting question is what a set of records *means*, and that question
 * should not require a live process to answer.
 *
 * @module ai/services/memory-core/wakeDeliveryProjection
 */

import {SPOOL_CONTENTION_REASONS}     from '../../daemons/wake/primaryWakeSpool.mjs';
import {SOURCE_EVENTS_HANDLED_REASON} from './wakeCoalescePolicy.mjs';

export {SOURCE_EVENTS_HANDLED_REASON};

/**
 * States that count against a subscription. `failed` is a concluded non-delivery; `unknown` is a
 * dispatch whose fate was never recorded (the receiver restarted mid-dispatch), which for a
 * reachability question is the same epistemic state — we do not know it landed.
 *
 * `skipped` appears in neither set, and that is the load-bearing decision rather than an omission.
 * A skip is the receiver declining to dispatch a digest, so it is neither an attempt nor a delivery
 * and carries no evidence either way. Counting it would manufacture an alarm on a healthy seat;
 * letting it CLOSE a failure streak would erase the evidence before it, so a seat failing every real
 * attempt while skipping digests in between would read healthy-ish between failures. It is
 * transparent to the streak in both directions.
 */
const FAILURE_STATES = new Set(['failed', 'unknown']);

/** Skips newer than the last delivery that retire it as evidence: the route reads `unknown`, never `unreachable`. */
const STALE_SKIP_RUN = 3;

/**
 * @summary The order in which attempts concluded, falling back through the fields a record may carry.
 *
 * `dispatchFinishedAt` is attempt order, which is what a streak is about. `acceptedAt` is queue
 * order and is NOT the same: a digest carrying several events can be accepted before an
 * earlier-accepted record finishes dispatching, so ordering a streak by `acceptedAt` reads it
 * backwards and reports a recovered seat as broken. `updatedAt` sits between them as the
 * receiver's own last-write stamp.
 *
 * @param {Object} record
 * @returns {String} An ISO timestamp, or the empty string when the record carries none.
 */
function attemptTime(record) {
    return String(record.dispatchFinishedAt || record.updatedAt || record.acceptedAt || '');
}

/**
 * @summary Builds the empty verdict — the shape every unreadable outcome degrades to.
 * @returns {{state: String, consecutiveFailures: Number, consecutiveSkips: Number, lastOutcomeReason: String|null, lastDeliveredAt: String|null, lastAttemptedAt: String|null}}
 */
function unknownVerdict() {
    return {
        state              : 'unknown',
        consecutiveFailures: 0,
        consecutiveSkips   : 0,
        lastOutcomeReason  : null,
        lastDeliveredAt    : null,
        lastAttemptedAt    : null
    };
}

/**
 * @summary Projects receiver dispatch records into one delivery verdict per subscription.
 *
 * A subscription is `unreachable` when its most recent attempts concluded `failed` or `unknown`,
 * `reachable` when a `delivered` record is observed with no failure and fewer than
 * `STALE_SKIP_RUN` skips after it, and `unknown` in every other case — including the empty case.
 * `consecutiveFailures` counts the trailing run of non-delivering conclusions, so a single later
 * success returns it to 0 and a seat that recovers stops reading broken; `consecutiveSkips` counts
 * the skips newer than any conclusion.
 *
 * Records for different subscriptions never interact: one broken seat cannot mask a healthy one,
 * and a healthy one cannot clear a broken one's streak.
 *
 * @param {Array<Object>} [records=[]] Receiver records, in any order. Each needs `subscriptionId`
 * and `state`; a record carrying neither a known `state` nor a conclusive timestamp is treated as
 * unreadable and degrades that subscription to `unknown` rather than being counted or trusted.
 * @returns {Object.<String, {state: String, consecutiveFailures: Number, consecutiveSkips: Number, lastOutcomeReason: String|null, lastDeliveredAt: String|null, lastAttemptedAt: String|null}>}
 * Verdict keyed by `subscriptionId`; an empty input yields an empty object rather than a synthetic
 * entry, so "no subscriptions have any evidence" stays distinguishable from "a subscription is fine".
 */
export function projectWakeDelivery(records = []) {
    const bySubscription = new Map();

    for (const record of Array.isArray(records) ? records : []) {
        const subscriptionId = record?.subscriptionId;

        if (typeof subscriptionId !== 'string' || subscriptionId.length === 0) continue;

        if (!bySubscription.has(subscriptionId)) {
            bySubscription.set(subscriptionId, []);
        }

        bySubscription.get(subscriptionId).push(record);
    }

    const projected = {};

    for (const [subscriptionId, subscriptionRecords] of bySubscription) {
        // Newest conclusion first, so the streak is the leading run and no sort comparator has to
        // be re-derived against the ascending order the receiver's own reader returns.
        const ordered = [...subscriptionRecords].sort((left, right) =>
            attemptTime(right).localeCompare(attemptTime(left))
        );

        const verdict      = unknownVerdict();
        let   sawDelivered = false,
            leadingUnknown = false,
            streakOpen     = true;

        for (const record of ordered) {
            const state = record?.state;
            const when  = attemptTime(record) || null;

            if (state === 'delivered') {
                sawDelivered = true;
                verdict.lastDeliveredAt ??= when;
                verdict.lastAttemptedAt ??= when;
                streakOpen    = false;
                continue;
            }

            if (state === 'skipped') {
                // TRANSPARENT, deliberately, and this is the semantic most worth arguing about. A skip
                // is the receiver choosing not to dispatch a digest — it is neither an attempt nor a
                // success, so it carries NO evidence about reachability. It must therefore neither add
                // to the streak nor close it: a seat that fails every real attempt and skips a digest
                // now and then would otherwise read healthy-ish between failures, which is this whole
                // ticket's failure mode pointed the other way. `lastAttemptedAt` still moves, because
                // the receiver genuinely was asked — that is a fact about the receiver, not about
                // whether a wake can land.
                verdict.lastAttemptedAt ??= when;

                if (record.outcomeReason !== SOURCE_EVENTS_HANDLED_REASON && !sawDelivered && verdict.consecutiveFailures === 0) {
                    verdict.consecutiveSkips++;
                }

                continue;
            }

            if (FAILURE_STATES.has(state)) {
                verdict.lastAttemptedAt ??= when;
                // The FIRST failure seen is the most recent one, so the reason is claimed once —
                // otherwise a repeated reason is harmless but a CHANGING one would report the
                // oldest, which is the least useful thing to send an operator.
                verdict.lastOutcomeReason ??= record.outcomeReason || null;

                if (streakOpen) {
                    verdict.consecutiveFailures++;
                }

                continue;
            }

            // `pending`, malformed, or a state this projection does not recognise. None of them is
            // a failure and none is a success, and — critically — none of them may be resolved by
            // whatever happened BEFORE it. A leading unreadable record means the most recent
            // dispatch has no known fate, and an older success is not evidence about a later
            // attempt. Stop here: nothing further back can speak to it.
            leadingUnknown = true;
            break;
        }

        if (leadingUnknown) {
            verdict.state = 'unknown';
        } else if (verdict.consecutiveFailures > 0) {
            verdict.state = 'unreachable';
        } else if (sawDelivered) {
            verdict.state = verdict.consecutiveSkips < STALE_SKIP_RUN ? 'reachable' : 'unknown';
        }

        projected[subscriptionId] = verdict;
    }

    return projected;
}

/**
 * How strongly one record speaks for a message nothing delivered: a fate still open (a pending, unrecognised or
 * receiver-restart `unknown` record) outranks a concluded `failed`, which outranks a `skipped`.
 */
const MESSAGE_RANK = {undelivered: 0, skipped: 1, failed: 2, unknown: 3, delivered: 4};

/**
 * @summary Projects receiver dispatch records into one verdict per wake message: did this particular wake arrive?
 * @description A wake message's id is its source event id (`CoalescingEngineService#_getSourceEventId`), so a record
 * speaks for every message in its `sourceEventIds`: one digest can carry several messages, and one message can ride
 * several routes. One `delivered` record is enough, and the verdict keeps the first delivery. Without one, a fate
 * still open reads `unknown`, since the wake may yet land; otherwise `failed` outranks `skipped`. A message in no
 * record reads `undelivered`. Records that could not be read (`null`) leave every message `unknown`: a question that
 * could not be asked has no negative answer.
 * @param {Object[]|null} records Receiver records in any order, or null when they could not be read.
 * @param {String[]} [messageIds=[]]
 * @returns {Object.<String, {state: 'delivered'|'failed'|'skipped'|'unknown'|'undelivered', at: String|null}>}
 * Keyed by message id; `at` is the first delivery, or the newest attempt when nothing delivered.
 */
export function projectMessageDelivery(records, messageIds = []) {
    const verdicts = Object.fromEntries(messageIds.filter(id => typeof id === 'string' && id.length > 0)
        .map(id => [id, {state: Array.isArray(records) ? 'undelivered' : 'unknown', at: null}]));

    for (const record of Array.isArray(records) ? records : []) {
        const
            state = Object.hasOwn(MESSAGE_RANK, record?.state) && record.state !== 'undelivered' ? record.state : 'unknown',
            when  = attemptTime(record) || null;

        for (const id of Array.isArray(record?.sourceEventIds) ? record.sourceEventIds : []) {
            if (!Object.hasOwn(verdicts, id)) continue;

            const verdict = verdicts[id];

            if (MESSAGE_RANK[state] > MESSAGE_RANK[verdict.state]) {
                verdicts[id] = {state, at: when}
            } else if (state === verdict.state && when && (!verdict.at ||
                (state === 'delivered' ? when < verdict.at : when > verdict.at))) {
                verdict.at = when
            }
        }
    }

    return verdicts
}

/**
 * @summary How long a pull route may go without a poll before its seat counts as having no listener. A
 * live listener polls every 15 s and backs off to two minutes at most, and its re-arm after a failed turn
 * waits two minutes at most, so five silent minutes are no back-off of a live listener.
 * @type {Number}
 */
export const PULL_ROUTE_SILENCE_MS = 5 * 60 * 1000;

/**
 * @summary The verdict for a pull route, which no receiver record concludes: its seat polls it.
 *
 * A poll inside {@link PULL_ROUTE_SILENCE_MS} reads reachable. So does a stale poll while the seat's turn
 * presence is fresh, because a seat hands its listener to the turn a wake started and polls again when
 * that turn ends. A stale poll with no turn in progress is a seat with no listener: a crashed or killed
 * session, or a failed turn whose error no rewake cures. A route that never polled stays unconcluded.
 * @param {Object} [options]
 * @param {String|null} [options.lastPollAt] The route's last authenticated poll.
 * @param {Object|null} [options.presence] The seat's newest active turn, `{fresh}`, as
 *     `TurnPresenceService#getFreshTurnPresence` returns it.
 * @param {Number|Date} [options.now=Date.now()]
 * @param {Number} [options.silenceMs=PULL_ROUTE_SILENCE_MS]
 * @returns {Object|null} A verdict {@link projectIdentityWakeReachability} reads, or `null` when unconcluded.
 */
export function projectPullRouteVerdict({lastPollAt, presence, now = Date.now(), silenceMs = PULL_ROUTE_SILENCE_MS} = {}) {
    const polledAt = Date.parse(lastPollAt ?? '');

    if (!Number.isFinite(polledAt)) return null;

    if (new Date(now).getTime() - polledAt <= silenceMs || presence?.fresh) return {state: 'reachable'};

    return {
        state            : 'unreachable',
        lastAttemptedAt  : lastPollAt,
        lastOutcomeReason: `listener silent: no poll since ${lastPollAt} and no turn in progress`
    }
}

/**
 * @summary Joins one identity's wake routes to their delivery verdicts: can a wake reach this seat?
 * One route that lands is enough, so any `reachable` route makes the seat `reachable`.
 * `undeliverable` is a claim about EVERY active route, so it needs every one of them concluded
 * `unreachable`; the newest failing route lends its reason and streak. A route the receiver refused
 * as unknown is concluded by that refusal, over the receiver's own records for it: the receiver
 * records nothing it refuses, so they are older. A route the receiver never concluded — no record
 * at all, or an `unknown` verdict — might still deliver, so one such route keeps the seat `unknown`
 * whatever its siblings did. No route at all is `unknown` too: the loud direction never resolves to
 * healthy on absence of evidence. A seat whose every route the sender withdrew is `withdrawn` until
 * its owner resumes one, and names the refusal when every route carries it: resuming alone re-sends
 * to a receiver that refuses the route.
 * @param {Object[]} routes The identity's routes, `{id, withdrawn?, refusal?}`.
 * @param {Object} verdicts {@link projectWakeDelivery}'s output.
 * @returns {{state: 'reachable'|'undeliverable'|'unknown'|'withdrawn', reason?: String|null, consecutiveFailures?: Number}}
 */
export function projectIdentityWakeReachability(routes = [], verdicts = {}) {
    const
        active = routes.filter(route => !route.withdrawn),
        own    = active.map(route => route.refusal ? {state: 'unreachable', lastOutcomeReason: route.refusal} : verdicts[route.id] ?? null);

    if (own.some(verdict => verdict?.state === 'reachable')) {
        return {state: 'reachable'}
    }

    if (active.length === 0 && routes.length > 0) {
        return routes.every(route => route.refusal) ? {state: 'withdrawn', reason: routes[0].refusal} : {state: 'withdrawn'}
    }

    // Failure evidence on one route says nothing about a sibling the receiver never concluded.
    if (own.length === 0 || own.some(verdict => verdict?.state !== 'unreachable')) {
        return {state: 'unknown'}
    }

    const [newest] = own.sort((left, right) =>
        String(right.lastAttemptedAt ?? '').localeCompare(String(left.lastAttemptedAt ?? ''))
    );

    return {state: 'undeliverable', reason: newest.lastOutcomeReason, consecutiveFailures: newest.consecutiveFailures}
}

const STAGE_RANK = Object.freeze({
    undelivered                : 0,
    skipped                    : 1,
    failed                     : 2,
    unknown                    : 3,
    'waiting-for-policy'       : 4,
    'waiting-for-spool'        : 5,
    'waiting-for-chat-boundary': 6,
    'waiting-for-receipt'      : 7,
    delivered                  : 8
});

const ACTIVE_TURN_UNAVAILABLE_REASON = 'native-recipient:active-turn-adapter-unavailable';
const ACTIVE_TURN_DEPENDENCY_ID      = '#1741';

function parseEpochMs(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
    if (typeof value === 'string' && value.length > 0) {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null
    }
    return null
}

function toIsoOrNull(value) {
    const ms = parseEpochMs(value);
    return ms === null ? null : new Date(ms).toISOString()
}

function diffMs(startValue, endValue) {
    const startMs = parseEpochMs(startValue),
          endMs   = parseEpochMs(endValue);
    if (startMs === null || endMs === null) return null;
    return Math.max(0, endMs - startMs)
}

function emptyStageEntry(stage, overrides = {}) {
    return {
        stage,
        settled           : stage === 'delivered',
        urgent            : false,
        reason            : null,
        dependency        : null,
        eventToHostMs     : null,
        hostToRecipientMs : null,
        policyWaitMs      : null,
        chatBoundaryWaitMs: null,
        holdAgeMs         : null,
        receiptWaitMs     : null,
        totalLatencyMs    : null,
        timestamps        : {
            sourceSentAt          : null,
            firstQueuedAt         : null,
            emittedAt             : null,
            acceptedAt            : null,
            hostStagedAt          : null,
            holdStartedAt         : null,
            lastTranscriptGrowthAt: null,
            nativeInitiatedAt     : null,
            recipientObservedAt   : null
        },
        ...overrides
    }
}

/**
 * @summary Projects one receiver record into explicit wait-stage, hold age, and separate event-to-host / host-to-recipient latencies.
 * @param {Object} record Receiver record snapshot.
 * @param {Object} [options]
 * @param {Number|String|Date|null} [options.now=null] Optional observation clock for open wait durations.
 * @param {String|null}             [options.messageId=null] Target message id for per-message `messageSentAt` resolution.
 * @param {String|Number|Date|null} [options.fallbackSentAt=null] Fallback timestamp from policy queue snapshot.
 * @returns {Object} Stage verdict distinguishing spool contention, chat-boundary holds (with `holdStartedAt` / `holdAgeMs`), unproven host sends, and recipient-settled delivery.
 */
export function projectWakeRecordStage(record, {now = null, messageId = null, fallbackSentAt = null} = {}) {
    if (!record || typeof record !== 'object') {
        return emptyStageEntry('unknown', {reason: 'record-unreadable'})
    }

    const
        payload  = record.envelope?.payload,
        sentToMe = payload?.breakdown?.sent_to_me,
        urgent   = Boolean(record.urgent ?? (
            payload?.urgent === true ||
            sentToMe?.highestPriority === 'high' ||
            sentToMe?.latest?.priority === 'high'
        )),
        perMessageSentAt  = (messageId && payload?.messageSentAt?.[messageId]) || fallbackSentAt,
        digestSentAt      = urgent
            ? (payload?.latestUrgentSentAt || payload?.earliestSentAt)
            : (payload?.earliestSentAt || payload?.latestUrgentSentAt),
        sourceSentAt      = toIsoOrNull(
            perMessageSentAt || record.sourceSentAt || digestSentAt || sentToMe?.latest?.sentAt
        ),
        firstQueuedAt     = toIsoOrNull(record.firstQueuedAt ?? payload?.firstQueuedAt),
        emittedAt         = toIsoOrNull(record.emittedAt || record.envelope?.emittedAt),
        acceptedAt        = toIsoOrNull(record.acceptedAt),
        deferReason       = record.deferReason || null,
        outcomeReason     = record.outcomeReason || null,
        spoolBlocked      = record.waitStage === 'waiting-for-spool' || SPOOL_CONTENTION_REASONS.includes(deferReason),
        hostStagedAt      = toIsoOrNull(spoolBlocked ? record.hostStagedAt : (record.hostStagedAt || record.dispatchStartedAt)),
        nativeInitiatedAt = toIsoOrNull(record.nativeInitiatedAt),
        isOpenState       = record.state === 'pending' || record.state === 'dispatching',
        awaitingReceipt   = isOpenState && (
            record.waitStage === 'waiting-for-receipt' ||
            record.nativeStatus === 'unknown' ||
            deferReason === 'native-recipient:receipt-unproven' ||
            deferReason === 'awaiting-receipt'
        );

    let stage;
    if (record.state === 'delivered') {
        stage = 'delivered';
    } else if (record.state === 'failed') {
        stage = 'failed';
    } else if (record.state === 'skipped') {
        stage = 'skipped';
    } else if (!isOpenState) {
        stage = 'unknown';
    } else if (awaitingReceipt) {
        stage = 'waiting-for-receipt';
    } else if (spoolBlocked) {
        stage = 'waiting-for-spool';
    } else {
        stage = 'waiting-for-chat-boundary';
    }

    const
        settled             = stage === 'delivered',
        recipientObservedAt = settled
            ? toIsoOrNull(record.recipientObservedAt || record.dispatchFinishedAt || record.updatedAt)
            : null,
        holdStartedAt          = stage === 'waiting-for-chat-boundary' ? toIsoOrNull(record.holdStartedAt) : null,
        lastTranscriptGrowthAt = holdStartedAt ? toIsoOrNull(record.lastTranscriptGrowthAt) : null,
        holdAgeMs              = holdStartedAt && now !== null ? diffMs(holdStartedAt, now) : null,
        dependency             = settled
            ? null
            : (record.namedDependency || (deferReason === ACTIVE_TURN_UNAVAILABLE_REASON ? ACTIVE_TURN_DEPENDENCY_ID : null)),
        reason                 = settled ? null : (outcomeReason || deferReason || null),
        eventToHostMs          = diffMs(sourceSentAt, acceptedAt),
        hostToRecipientMs      = settled ? diffMs(acceptedAt, recipientObservedAt) : null,
        totalLatencyMs         = settled ? diffMs(sourceSentAt, recipientObservedAt) : null,
        policyWaitMs           = diffMs(firstQueuedAt || sourceSentAt, emittedAt || acceptedAt);

    let chatBoundaryWaitMs = null;
    if (nativeInitiatedAt && acceptedAt) {
        chatBoundaryWaitMs = diffMs(acceptedAt, nativeInitiatedAt);
    } else if (settled && recipientObservedAt && acceptedAt) {
        chatBoundaryWaitMs = diffMs(acceptedAt, recipientObservedAt);
    } else if (stage === 'waiting-for-chat-boundary' && now !== null && acceptedAt) {
        chatBoundaryWaitMs = diffMs(acceptedAt, now);
    }

    let receiptWaitMs = null;
    if (settled && recipientObservedAt && nativeInitiatedAt) {
        receiptWaitMs = diffMs(nativeInitiatedAt, recipientObservedAt);
    } else if (stage === 'waiting-for-receipt' && now !== null) {
        receiptWaitMs = diffMs(nativeInitiatedAt || hostStagedAt || acceptedAt, now);
    }

    return {
        stage,
        settled,
        urgent,
        reason,
        dependency,
        eventToHostMs,
        hostToRecipientMs,
        policyWaitMs,
        chatBoundaryWaitMs,
        holdAgeMs,
        receiptWaitMs,
        totalLatencyMs,
        timestamps: {
            sourceSentAt,
            firstQueuedAt,
            emittedAt,
            acceptedAt,
            hostStagedAt,
            holdStartedAt,
            lastTranscriptGrowthAt,
            nativeInitiatedAt,
            recipientObservedAt
        }
    }
}

function normalizePolicyQueue(policyQueue) {
    const byMessage = new Map();
    if (!policyQueue || typeof policyQueue !== 'object') return byMessage;

    const mergeEntry = (id, entry) => {
        if (typeof id !== 'string' || id.length === 0 || !entry || typeof entry !== 'object') return;
        const prev = byMessage.get(id);
        if (!prev) {
            byMessage.set(id, entry);
            return
        }

        const
            prevQueuedMs  = parseEpochMs(prev.firstQueuedAt),
            nextQueuedMs  = parseEpochMs(entry.firstQueuedAt),
            firstQueuedAt = prevQueuedMs === null
                ? entry.firstQueuedAt
                : (nextQueuedMs !== null && nextQueuedMs < prevQueuedMs ? entry.firstQueuedAt : prev.firstQueuedAt),
            prevUrgent    = typeof prev.urgent === 'boolean' ? prev.urgent : prev.priority === 'high',
            nextUrgent    = typeof entry.urgent === 'boolean' ? entry.urgent : entry.priority === 'high';

        byMessage.set(id, {
            ...prev,
            firstQueuedAt,
            sentAt  : prev.sentAt || entry.sentAt || null,
            priority: prev.priority === 'high' || entry.priority === 'high' ? 'high' : (prev.priority || entry.priority || 'normal'),
            urgent  : prevUrgent || nextUrgent
        });
    };

    if (Array.isArray(policyQueue)) {
        for (const item of policyQueue) {
            const ids = Array.isArray(item?.sourceEventIds) ? item.sourceEventIds : (item?.messageId ? [item.messageId] : []);
            for (const id of ids) {
                mergeEntry(id, item);
            }
        }
        return byMessage
    }

    for (const [id, entry] of Object.entries(policyQueue)) {
        mergeEntry(id, entry);
    }
    return byMessage
}

/**
 * @summary Projects per-message wake stages across coalescing policy queues and host receiver records.
 * @param {Object[]|null} records Receiver records, or null when unreadable.
 * @param {Object} [options]
 * @param {String[]} [options.messageIds=[]] Target message ids; defaults to ids present in `records` and `policyQueue`.
 * @param {Object|Object[]} [options.policyQueue={}] Pending coalescing policy snapshot keyed by message id.
 * @param {Number|String|Date|null} [options.now=null] Optional observation clock for open wait durations.
 * @returns {Object<String, Object>} Stage and split-latency projection keyed by message id.
 */
export function projectWakeDeliveryStages(records, {messageIds = [], policyQueue = {}, now = null} = {}) {
    const
        policyByMessage = normalizePolicyQueue(policyQueue),
        targetIds       = new Set(
            Array.isArray(messageIds) && messageIds.length > 0
                ? messageIds.filter(id => typeof id === 'string' && id.length > 0)
                : [
                    ...policyByMessage.keys(),
                    ...(Array.isArray(records)
                        ? records.flatMap(r => Array.isArray(r?.sourceEventIds) ? r.sourceEventIds : [])
                        : [])
                ].filter(id => typeof id === 'string' && id.length > 0)
        ),
        projected       = {};

    if (records === null) {
        for (const id of targetIds) {
            projected[id] = emptyStageEntry('unknown', {reason: 'records-unreadable'});
        }
        return projected
    }

    for (const id of targetIds) {
        const policyEntry = policyByMessage.get(id);
        if (policyEntry) {
            const
                sourceSentAt  = toIsoOrNull(policyEntry.sentAt || policyEntry.sourceSentAt),
                firstQueuedAt = toIsoOrNull(policyEntry.firstQueuedAt),
                policyStart   = firstQueuedAt || sourceSentAt;
            projected[id] = emptyStageEntry('waiting-for-policy', {
                urgent      : typeof policyEntry.urgent === 'boolean' ? policyEntry.urgent : policyEntry.priority === 'high',
                reason      : policyEntry.reason || 'coalescing-policy-hold',
                policyWaitMs: now !== null && policyStart ? diffMs(policyStart, now) : null,
                timestamps  : {
                    sourceSentAt,
                    firstQueuedAt,
                    emittedAt             : null,
                    acceptedAt            : null,
                    hostStagedAt          : null,
                    holdStartedAt         : null,
                    lastTranscriptGrowthAt: null,
                    nativeInitiatedAt     : null,
                    recipientObservedAt   : null
                }
            });
        } else {
            projected[id] = emptyStageEntry('undelivered');
        }
    }

    for (const record of Array.isArray(records) ? records : []) {
        for (const id of Array.isArray(record?.sourceEventIds) ? record.sourceEventIds : []) {
            if (!targetIds.has(id)) continue;

            const policyEntry    = policyByMessage.get(id),
                  fallbackSentAt = policyEntry?.sentAt || policyEntry?.sourceSentAt || null,
                  candidate      = projectWakeRecordStage(record, {now, messageId: id, fallbackSentAt}),
                  rank           = STAGE_RANK[candidate.stage] ?? 0,
                  existing       = projected[id],
                  existingRank   = STAGE_RANK[existing.stage] ?? 0;

            if (rank > existingRank) {
                projected[id] = candidate;
            } else if (rank === existingRank && candidate.stage === 'delivered') {
                const leftAt  = candidate.timestamps.recipientObservedAt || '',
                      rightAt = existing.timestamps.recipientObservedAt || '';
                if (leftAt && (!rightAt || leftAt < rightAt)) {
                    projected[id] = candidate;
                }
            } else if (rank === existingRank) {
                const leftAt  = attemptTime(record),
                      rightAt = existing.timestamps.acceptedAt || '';
                if (leftAt && leftAt >= rightAt) {
                    projected[id] = candidate;
                }
            }
        }
    }

    return projected
}

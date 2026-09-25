/**
 * @summary Projects the wake receiver's own dispatch records into a per-subscription delivery verdict.
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
 * @returns {{state: String, consecutiveFailures: Number, lastOutcomeReason: String|null, lastDeliveredAt: String|null, lastAttemptedAt: String|null}}
 */
function unknownVerdict() {
    return {
        state              : 'unknown',
        consecutiveFailures: 0,
        lastOutcomeReason  : null,
        lastDeliveredAt    : null,
        lastAttemptedAt    : null
    };
}

/**
 * @summary Projects receiver dispatch records into one delivery verdict per subscription.
 *
 * A subscription is `unreachable` when its most recent attempts concluded `failed` or `unknown`,
 * `reachable` when a `delivered` record is observed and nothing failed after it, and `unknown` in
 * every other case — including the empty case. `consecutiveFailures` counts the trailing run of
 * non-delivering conclusions, so a single later success returns it to 0 and a seat that recovers
 * stops reading broken.
 *
 * Records for different subscriptions never interact: one broken seat cannot mask a healthy one,
 * and a healthy one cannot clear a broken one's streak.
 *
 * @param {Array<Object>} [records=[]] Receiver records, in any order. Each needs `subscriptionId`
 * and `state`; a record carrying neither a known `state` nor a conclusive timestamp is treated as
 * unreadable and degrades that subscription to `unknown` rather than being counted or trusted.
 * @returns {Object.<String, {state: String, consecutiveFailures: Number, lastOutcomeReason: String|null, lastDeliveredAt: String|null, lastAttemptedAt: String|null}>}
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

        const verdict = unknownVerdict();
        let sawDelivered  = false,
            leadingUnknown = false,
            streakOpen     = true;

        for (const record of ordered) {
            const state = record?.state;
            const when  = attemptTime(record) || null;

            if (state === 'delivered') {
                sawDelivered = true;
                verdict.lastDeliveredAt ??= when;
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
            verdict.state = 'reachable';
        }

        projected[subscriptionId] = verdict;
    }

    return projected;
}

/**
 * @summary Pure policy for the wake receiver's delivery-time context gate: whether a
 * signed wake digest may be injected into the target session NOW, or must wait for the session to
 * shrink or rotate.
 *
 * **The failure mode this guards (the budget cliff):** injecting a wake into a marathon session
 * starts a turn that re-processes the session's entire context. Measured cross-harness
 * (cross-harness harness-ledger measurement, 2026-08-08): 61% of one seat's lifetime processed tokens came from turns above
 * 500K context, and a provider prompt-cache TTL cliff (~30–60 min idle on K3; 5m/1h on Anthropic)
 * means a stale large session re-bills that context at ~0% cache hits. One wake delivered into a
 * >1h-idle ~700K session moved a weekly budget 97% → 100% in a single turn. The wake is only a
 * notification — the A2A mailbox stays the authority — so deferring the notification never loses
 * the message.
 *
 * **Why the policy reads CURRENT state only:** the probe always evaluates the session as it is
 * NOW, so both flush conditions collapse into the size read — a compacted session reports a small
 * context, and a rotated (fresh) session reports a fresh boot's context. There is deliberately NO
 * time-based flush: a session that stays large forever must never receive the deferred wake,
 * because flushing into a stale large session is precisely the cliff event. The provider warm
 * window is therefore documented rationale here, not a consumed input: delivering a
 * sub-threshold wake immediately already beats any warm-window deadline, and a deferred wake must
 * outlast any window.
 *
 * **Unknown context fails OPEN** (deliver + loud warn): a probe that cannot read the session must
 * never silently withhold coordination — silent non-delivery is the dead-realm failure mode. The gate
 * exists to shave the cliff, not to become a second mailbox.
 *
 * **The active-session skip (idle-only wakes):** an idle-out nudge exists to end an idle stretch,
 * so a probe that shows the target session active within `activeWithinMs` says there is no stretch
 * to end — the nudge is skipped, terminally, never parked for later (a nudge held until the seat
 * goes quiet would land on a seat that already moved; the detector raises a fresh one then). Only a
 * wake whose every event is an idle-out pulse may be skipped. Message, task and permission wakes
 * carry content; so does a GitHub mention or review request, which rides the same heartbeat-pulse
 * transport under its own `github-notification.` pulse-id prefix — transport kind alone does not
 * say whether a wake carries content, the pulse sources do, and a producer that does not report
 * them, or a source this policy does not know, is delivered. The skip is live only where an
 * adapter has a probe (`opencode-server`, the Kimi wire ledger); for the adapters whose probe
 * returns `null`, the detector's own activity read (`lastKnownActivity.mjs`) is the guard that
 * keeps a working or fresh session from being nudged.
 *
 * Kept pure (no timers, fs, or fetch) so the policy is unit-testable in isolation, mirroring
 * `flushDeferPolicy.mjs`.
 *
 * @module ai/daemons/wake/contextGatePolicy
 */

/**
 * The pulse-id prefix of an idle-out nudge (`<source>.<base64url-JSON>`): the one heartbeat-pulse
 * source that is a reminder rather than content. Owned here because this policy is what reads it;
 * the pulse builder (`idleOutPulseSummary.mjs`) and the renderers import it from here.
 * @type {String}
 */
export const IDLE_OUT_PULSE_SOURCE = 'idle-out-nudge';

/**
 * Default size ceiling, in tokens (last assistant turn's `input + cache.read`), above which a
 * wake defers. Sized from the 2026-08-08 telemetry: sub-250K turns are rounding error (~7.5% of
 * lifetime processed tokens), while the 500K–1M band alone carried 61% — so the gate sits at the
 * top of the cheap band, not at the cliff's edge.
 * @type {Number}
 */
export const DEFAULT_CONTEXT_GATE_MAX_TOKENS = 250_000;

/**
 * Default warn level, in tokens, at which a delivered wake logs that the session is approaching
 * the gate. A seat that sees this warning should sunset before the next wake defers.
 * @type {Number}
 */
export const DEFAULT_CONTEXT_GATE_WARN_TOKENS = 200_000;

/**
 * Default window, in milliseconds, within which a probed session counts as active for the
 * heartbeat-only skip. It equals the idle threshold the detector nudges at: a seat active more
 * recently than that has no idle stretch to end.
 * @type {Number}
 */
export const DEFAULT_CONTEXT_GATE_ACTIVE_WITHIN_MS = 30 * 60 * 1000;

/**
 * @summary Whether a signed wake digest carries nothing but idle-out pulses — the one class of
 * wake the active-session skip may end, read from the envelope's structured breakdown rather
 * than from the rendered digest text.
 *
 * The heartbeat bucket's `sources` tally (`CoalescingEngineService._buildDigestEnvelope`) counts
 * every pulse by its pulse-id prefix, so a GitHub notification coalesced behind a newer idle pulse
 * is seen, not only the bucket's `latest` pointer. A bucket without the tally comes from a producer
 * that predates it; its content is unknown and the wake is delivered.
 * @param {Object} envelope A `wake/digest` envelope (`payload.breakdown` buckets by event kind).
 * @returns {Boolean}
 */
export function isIdleOnlyEnvelope(envelope) {
    const breakdown = envelope?.payload?.breakdown,
          heartbeat = breakdown?.heartbeat_pulse;

    if (!heartbeat || !(heartbeat.count > 0)) return false;

    if (breakdown.sent_to_me?.count > 0 ||
        breakdown.task_state_changed?.count > 0 ||
        breakdown.permission_granted?.count > 0) return false;

    const idleOutCount = heartbeat.sources?.[IDLE_OUT_PULSE_SOURCE];

    return Number.isInteger(idleOutCount) && idleOutCount === heartbeat.count
}

/**
 * @summary Evaluates one wake against the target session's probed context.
 *
 * @param {Object}        opts
 * @param {Object|null}   opts.probe               Probe result: `{contextTokens, lastActivityAt,
 *   sessionId}`, or `null` when the adapter cannot read the session.
 * @param {Number}        opts.maxContextTokens    Defer above this size (T1).
 * @param {Number}        opts.warnContextTokens   Warn-and-deliver at or above this size (T2).
 * @param {Boolean}       [opts.idleOnly=false]      The wake carries idle-out pulses only (see
 *   {@link isIdleOnlyEnvelope}); only such a wake may be skipped for an active session.
 * @param {Number|null}   [opts.activeWithinMs=null] Skip an idle-only wake whose probed
 *   `lastActivityAt` is younger than this; absent or non-positive disables the skip.
 * @param {Number}        [opts.now=Date.now()]     Injected clock for the activity age.
 * @returns {{action: 'deliver'|'defer'|'skip', gateOutcome: 'unknown'|'within'|'warn'|'deferred'|'active-session',
 *   contextTokens: Number|null, activeAgoMs: Number}} `activeAgoMs` only on a skip.
 */
export function evaluateContextGate({
    probe,
    maxContextTokens,
    warnContextTokens,
    idleOnly       = false,
    activeWithinMs = null,
    now            = Date.now()
}) {
    if (!probe || !Number.isFinite(probe.contextTokens)) {
        return {action: 'deliver', gateOutcome: 'unknown', contextTokens: null};
    }

    const {contextTokens} = probe;

    if (idleOnly && Number.isFinite(activeWithinMs) && activeWithinMs > 0 && Number.isFinite(probe.lastActivityAt)) {
        const activeAgoMs = now - probe.lastActivityAt;

        if (activeAgoMs >= 0 && activeAgoMs < activeWithinMs) {
            return {action: 'skip', gateOutcome: 'active-session', contextTokens, activeAgoMs};
        }
    }

    if (contextTokens > maxContextTokens) {
        return {action: 'defer', gateOutcome: 'deferred', contextTokens};
    }
    if (contextTokens >= warnContextTokens) {
        return {action: 'deliver', gateOutcome: 'warn', contextTokens};
    }

    return {action: 'deliver', gateOutcome: 'within', contextTokens};
}

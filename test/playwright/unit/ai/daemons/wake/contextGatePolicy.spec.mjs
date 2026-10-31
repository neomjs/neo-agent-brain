import {test, expect} from '@playwright/test';
import {
    DEFAULT_CONTEXT_GATE_ACTIVE_WITHIN_MS,
    DEFAULT_CONTEXT_GATE_MAX_TOKENS,
    DEFAULT_CONTEXT_GATE_WARN_TOKENS,
    evaluateContextGate,
    isIdleOnlyEnvelope
} from '../../../../../../ai/daemons/wake/contextGatePolicy.mjs';

test.describe('ai/daemons/wake/contextGatePolicy (#16682 budget-cliff guard)', () => {
    const limits = {
        maxContextTokens : DEFAULT_CONTEXT_GATE_MAX_TOKENS,
        warnContextTokens: DEFAULT_CONTEXT_GATE_WARN_TOKENS
    };
    const probe = contextTokens => ({contextTokens, lastActivityAt: 1_786_190_000_000, sessionId: 'ses_test'});

    test.describe('evaluateContextGate', () => {
        test('defers above the max threshold — the cliff turn never starts', () => {
            const gate = evaluateContextGate({probe: probe(limits.maxContextTokens + 1), ...limits});

            expect(gate).toEqual({
                action       : 'defer',
                gateOutcome  : 'deferred',
                contextTokens: limits.maxContextTokens + 1
            });
        });

        test('delivers at the max threshold boundary (defer is strictly greater-than)', () => {
            const gate = evaluateContextGate({probe: probe(limits.maxContextTokens), ...limits});

            expect(gate.action).toBe('deliver');
            expect(gate.gateOutcome).toBe('warn');
        });

        test('warns but delivers inside the warn band — the seat sees the approach', () => {
            const gate = evaluateContextGate({probe: probe(limits.warnContextTokens), ...limits});

            expect(gate).toMatchObject({action: 'deliver', gateOutcome: 'warn'});
        });

        test('delivers quietly below the warn band', () => {
            const gate = evaluateContextGate({probe: probe(limits.warnContextTokens - 1), ...limits});

            expect(gate).toMatchObject({action: 'deliver', gateOutcome: 'within'});
        });

        test('a fresh-boot-sized context always delivers — rotation flushes a deferral by construction', () => {
            const gate = evaluateContextGate({probe: probe(60_000), ...limits});

            expect(gate).toMatchObject({action: 'deliver', gateOutcome: 'within'});
        });

        test('unknown context fails OPEN — never silently withheld (#16526 lesson)', () => {
            for (const probeValue of [null, undefined, {}, {contextTokens: Number.NaN}]) {
                const gate = evaluateContextGate({probe: probeValue ?? null, ...limits});

                expect(gate).toEqual({action: 'deliver', gateOutcome: 'unknown', contextTokens: null});
            }
        });

        test('there is no time-based flush: a session that stays large defers forever', () => {
            // The probe always reads CURRENT state, so a stale-but-still-large session keeps
            // deferring no matter how old the wake is — flushing into it would be the 97→100%
            // cliff event this module exists to prevent.
            const ancient = {contextTokens: 700_000, lastActivityAt: 1, sessionId: 'ses_old'};

            expect(evaluateContextGate({probe: ancient, ...limits}).action).toBe('defer');
        });
    });

    test.describe('the active-session skip (idle-only wakes)', () => {
        const NOW      = Date.parse('2026-10-30T20:00:00.000Z');
        const MIN      = 60 * 1000;
        const skipOpts = {...limits, idleOnly: true, activeWithinMs: DEFAULT_CONTEXT_GATE_ACTIVE_WITHIN_MS, now: NOW};
        const active   = agoMs => ({contextTokens: 80_000, lastActivityAt: NOW - agoMs, sessionId: 'ses_active'});

        test('the default window equals the idle threshold the detector nudges at', () => {
            expect(DEFAULT_CONTEXT_GATE_ACTIVE_WITHIN_MS).toBe(30 * MIN);
        });

        test('an idle-only wake into a session active inside the window is skipped, not deferred', () => {
            expect(evaluateContextGate({probe: active(5 * MIN), ...skipOpts})).toEqual({
                action: 'skip', gateOutcome: 'active-session', contextTokens: 80_000, activeAgoMs: 5 * MIN
            });
        });

        test('an active session over the gate is still skipped: there is no idle stretch to end later', () => {
            const probe = {contextTokens: 700_000, lastActivityAt: NOW - 2 * MIN, sessionId: 'ses_busy'};

            expect(evaluateContextGate({probe, ...skipOpts}).action).toBe('skip');
        });

        test('a session quiet for the whole window delivers (or defers by size) as before', () => {
            expect(evaluateContextGate({probe: active(30 * MIN), ...skipOpts})).toMatchObject({action: 'deliver', gateOutcome: 'within'});
            expect(evaluateContextGate({probe: active(45 * MIN), ...skipOpts})).toMatchObject({action: 'deliver', gateOutcome: 'within'});
        });

        test('a wake that carries content is never skipped, whatever the activity', () => {
            expect(evaluateContextGate({probe: active(1 * MIN), ...skipOpts, idleOnly: false})).toMatchObject({action: 'deliver'});
        });

        test('no window, an unknown probe, or a probe without an activity stamp disables the skip', () => {
            expect(evaluateContextGate({probe: active(1 * MIN), ...skipOpts, activeWithinMs: null})).toMatchObject({action: 'deliver'});
            expect(evaluateContextGate({probe: active(1 * MIN), ...skipOpts, activeWithinMs: 0})).toMatchObject({action: 'deliver'});
            expect(evaluateContextGate({probe: null, ...skipOpts})).toEqual({action: 'deliver', gateOutcome: 'unknown', contextTokens: null});
            expect(evaluateContextGate({probe: {contextTokens: 80_000, lastActivityAt: null}, ...skipOpts})).toMatchObject({action: 'deliver', gateOutcome: 'within'});
        });
    });

    test.describe('isIdleOnlyEnvelope', () => {
        const envelope = breakdown => ({payload: {totalEvents: 1, breakdown}});
        const idle     = (count, extra = {}) => ({count, latest: {pulseId: 'idle-out-nudge.x'}, sources: {'idle-out-nudge': count}, ...extra});

        test('true only when every heartbeat pulse is an idle-out pulse and nothing else rides along', () => {
            expect(isIdleOnlyEnvelope(envelope({heartbeat_pulse: idle(2)}))).toBe(true);
            expect(isIdleOnlyEnvelope(envelope({heartbeat_pulse: idle(1), sent_to_me: {count: 0}, task_state_changed: {count: 0}, permission_granted: {count: 0}}))).toBe(true);
        });

        test('a GitHub notification pulse is content, even coalesced behind a newer idle pulse', () => {
            // The bucket's `latest` points at the idle pulse; the tally still shows the notification.
            const mixed = {count: 2, latest: {pulseId: 'idle-out-nudge.x'}, sources: {'idle-out-nudge': 1, 'github-notification': 1}};

            expect(isIdleOnlyEnvelope(envelope({heartbeat_pulse: mixed}))).toBe(false);
            expect(isIdleOnlyEnvelope(envelope({heartbeat_pulse: {count: 1, latest: {pulseId: 'github-notification.y'}, sources: {'github-notification': 1}}}))).toBe(false);
        });

        test('unknown content is never skipped: no tally (an older producer), an unknown source, or a count the tally does not cover', () => {
            expect(isIdleOnlyEnvelope(envelope({heartbeat_pulse: {count: 2, latest: {pulseId: 'idle-out-nudge.x'}}}))).toBe(false);
            expect(isIdleOnlyEnvelope(envelope({heartbeat_pulse: {count: 1, sources: {unknown: 1}}}))).toBe(false);
            expect(isIdleOnlyEnvelope(envelope({heartbeat_pulse: {count: 2, sources: {'idle-out-nudge': 1}}}))).toBe(false);
        });

        test('false once any content event rides along, and for envelopes without a breakdown', () => {
            expect(isIdleOnlyEnvelope(envelope({heartbeat_pulse: idle(1), sent_to_me: {count: 1}}))).toBe(false);
            expect(isIdleOnlyEnvelope(envelope({heartbeat_pulse: idle(1), task_state_changed: {count: 1}}))).toBe(false);
            expect(isIdleOnlyEnvelope(envelope({heartbeat_pulse: idle(1), permission_granted: {count: 1}}))).toBe(false);
            expect(isIdleOnlyEnvelope(envelope({sent_to_me: {count: 1}}))).toBe(false);
            expect(isIdleOnlyEnvelope({payload: {}})).toBe(false);
            expect(isIdleOnlyEnvelope(null)).toBe(false);
        });
    });
});

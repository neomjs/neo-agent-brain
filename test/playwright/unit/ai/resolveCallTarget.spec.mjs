import {test, expect}      from '@playwright/test';
import {resolveCallTarget} from '../../../../ai/services/neural-link/resolveCallTarget.mjs';

// Pure function — imported directly (not via the Bridge-connected ConnectionService singleton), so the
// suite has no host-runtime side effects and each case is fully isolated.
test.describe('resolveCallTarget (Neural Link auto-targeting deprecation)', () => {
    test('honors an explicit target regardless of the live-session count', () => {
        expect(resolveCallTarget('s2', ['s1', 's2', 's3'])).toBe('s2');
        // explicit wins even with zero live sessions — the Bridge owns existence checks
        expect(resolveCallTarget('only', [])).toBe('only');
    });

    test('resolves implicitly to the single live session (back-compat)', () => {
        expect(resolveCallTarget(null,      ['solo'])).toBe('solo');
        expect(resolveCallTarget(undefined, ['solo'])).toBe('solo');
    });

    test('throws the no-sessions error when none are live and no target is given', () => {
        expect(() => resolveCallTarget(null, [])).toThrow(/No active App Worker sessions/);
    });

    test('denies silent auto-targeting when more than one session is live', () => {
        expect(() => resolveCallTarget(null, ['a', 'b'])).toThrow(/explicit/i);
        expect(() => resolveCallTarget(null, ['a', 'b', 'c'])).toThrow(/Auto-targeting is disabled/);
    });

    test('the boundary is strictly greater-than-one (1 implicit, 2 explicit-required)', () => {
        expect(() => resolveCallTarget(null, ['a'])).not.toThrow();
        expect(() => resolveCallTarget(null, ['a', 'b'])).toThrow();
    });

    test('the refusal names each live session: its id, its app and who addressed it last, or untouched', () => {
        const rows = [
            {id: 'fm-1',  appName: 'AgentOS',   lastAddressedBy: {agentId: 'agent-ada', at: Date.now() - 5_000}},
            {id: 'lab-2', appName: 'avatarLab', lastAddressedBy: null},
            {id: 'bare-3'}
        ];

        expect(() => resolveCallTarget(null, rows))
            .toThrow(/Live: fm-1 · AgentOS · last addressed by agent-ada \d+s ago; lab-2 · avatarLab · untouched; bare-3 · unknown app · untouched/);
        // rows resolve like ids: one live row implicitly, an explicit target always
        expect(resolveCallTarget(null, rows.slice(0, 1))).toBe('fm-1');
        expect(resolveCallTarget('lab-2', rows)).toBe('lab-2');
    });
});

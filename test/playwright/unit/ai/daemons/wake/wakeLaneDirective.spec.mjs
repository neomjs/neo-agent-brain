import {test, expect} from '@playwright/test';
import WAKE_LANE_DIRECTIVE, {
    WAKE_DEFER_DIRECTIVE,
    WAKE_LANE_DIRECTIVE as named,
    selectWakeDirective
} from '../../../../../../ai/daemons/wake/wakeLaneDirective.mjs';

/**
 * @summary Coverage for the standing lifecycle-first wake-lane directive the wake daemon appends to
 * pure-heartbeat digests.
 *
 * Pins the lifecycle-first ordering so the discussion / ticket / source wording cannot silently drift
 * back to backlog-first. Asserts the three routing examples (own red/unstable PR · requested
 * review/re-review · peer-green scarce cross-family reviewer) appear and precede the plan's next step,
 * the never-idle invariant and its mirror (no minted lane) hold, and the prose is harness-agnostic.
 */
test.describe('ai/daemons/wake/wakeLaneDirective (#13118)', () => {
    test('default export equals the named export', () => {
        expect(WAKE_LANE_DIRECTIVE).toBe(named);
    });

    test('leads lifecycle-first, not backlog-first (AC1)', () => {
        expect(WAKE_LANE_DIRECTIVE.startsWith('Directive — lifecycle-first')).toBe(true);

        const lifecycleIdx = WAKE_LANE_DIRECTIVE.indexOf('lifecycle');
        const planIdx      = WAKE_LANE_DIRECTIVE.indexOf('accepted plan');

        expect(lifecycleIdx).toBeGreaterThanOrEqual(0);
        expect(planIdx).toBeGreaterThan(lifecycleIdx);
        // must NOT open with the old backlog-first 'claim an unclaimed lane' framing
        expect(WAKE_LANE_DIRECTIVE.slice(0, 60)).not.toContain('claim an unclaimed lane');
    });

    test('covers the three #13118 routing tiers (AC2 / AC7)', () => {
        expect(WAKE_LANE_DIRECTIVE, 'own red/unstable/stuck CI PR').toContain('red / unstable / stuck');
        expect(WAKE_LANE_DIRECTIVE, 'requested review/re-review').toContain('requested reviewer');
        expect(WAKE_LANE_DIRECTIVE, 'peer PRs you blocked').toContain('REQUEST_CHANGES');
        expect(WAKE_LANE_DIRECTIVE, 'scarce cross-family reviewer').toContain('scarce viable cross-family reviewer');
    });

    test('the accepted plan\'s next step, then the ranked proposal, are ordered AFTER the lifecycle queue', () => {
        const scarceIdx   = WAKE_LANE_DIRECTIVE.indexOf('scarce viable cross-family reviewer'); // last lifecycle tier
        const planIdx     = WAKE_LANE_DIRECTIVE.indexOf('next unresolved step of the accepted plan');
        const proposalIdx = WAKE_LANE_DIRECTIVE.indexOf('ranked proposal');

        expect(scarceIdx).toBeGreaterThanOrEqual(0);
        expect(planIdx).toBeGreaterThan(scarceIdx);
        expect(proposalIdx).toBeGreaterThan(planIdx);
    });

    test('asserts a hard never-idle invariant — no "legitimate idle terminals" escape-hatch (#13195)', () => {
        // The prior escape-hatch enumeration WAS the idle-loophole (agents steered toward the labelled
        // exits by defining their work to zero); it is intentionally removed in favour of a hard invariant.
        expect(WAKE_LANE_DIRECTIVE).toMatch(/never idle out/i);
        expect(WAKE_LANE_DIRECTIVE).toContain('never mint a lane'); // the mirror: no lane minted to avoid idling
        expect(WAKE_LANE_DIRECTIVE).not.toMatch(/legitimate idle terminal|verified-empty|blocked-state/);
        expect(WAKE_LANE_DIRECTIVE).not.toMatch(/ALWAYS more to do|fresh unclaimed lane|survey the open backlog/);
    });

    test('is harness-agnostic prose — no harness-specific names (AC6)', () => {
        expect(WAKE_LANE_DIRECTIVE).not.toMatch(/claude|codex|gemini|antigravity/i);
    });
});

/**
 * @summary The own-lane-first directive for content wakes, and the one rule that picks a digest's directive.
 *
 * A working seat reads a normal-priority wake as its next task. The directive keeps its lane first,
 * names the release point that keeps a waiting lane from idling the seat out, and stays short because it
 * rides every content wake.
 */
test.describe('ai/daemons/wake/wakeLaneDirective — own lane first (#1628)', () => {
    test('keeps the current lane first, with its own next step and its release point named', () => {
        expect(WAKE_DEFER_DIRECTIVE.startsWith('Directive — own lane first')).toBe(true);
        expect(WAKE_DEFER_DIRECTIVE, 'a wake about the lane is its next step').toContain('unless one of them is that step');
        expect(WAKE_DEFER_DIRECTIVE, 'nothing is lost by finishing first').toContain('they wait in your inbox');
        expect(WAKE_DEFER_DIRECTIVE, 'a waiting lane releases the seat').toContain('waits on someone else');
        expect(WAKE_DEFER_DIRECTIVE).toContain('lifecycle order');
    });

    test('is harness-agnostic and stays short: it rides every content wake', () => {
        expect(WAKE_DEFER_DIRECTIVE).not.toMatch(/claude|codex|gemini|antigravity/i);
        expect(WAKE_DEFER_DIRECTIVE.length).toBeLessThan(WAKE_LANE_DIRECTIVE.length / 2);
    });

    test('selectWakeDirective: content defers below high priority, a pure heartbeat gets the lifecycle directive', () => {
        for (const priority of ['low', 'normal']) {
            expect(selectWakeDirective({content: true, heartbeat: false, priority}), priority).toBe(WAKE_DEFER_DIRECTIVE);
            expect(selectWakeDirective({content: true, heartbeat: true,  priority}), `${priority} + heartbeat`).toBe(WAKE_DEFER_DIRECTIVE);
        }

        expect(selectWakeDirective({content: true,  heartbeat: false, priority: 'high'})).toBeNull();
        expect(selectWakeDirective({content: true,  heartbeat: true,  priority: 'high'})).toBeNull();
        expect(selectWakeDirective({content: false, heartbeat: true,  priority: 'normal'})).toBe(WAKE_LANE_DIRECTIVE);
        expect(selectWakeDirective({content: false, heartbeat: false, priority: 'normal'})).toBeNull();
    });
});

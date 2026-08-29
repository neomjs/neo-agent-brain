import {test, expect}     from '@playwright/test';
import Neo                from 'neo.mjs/src/Neo.mjs';
import * as core          from 'neo.mjs/src/core/_export.mjs';
import EmbeddingAdmission from '../../../../../../../ai/services/memory-core/helpers/EmbeddingAdmission.mjs';

// The embedding lane's single admission gate. Pure (no I/O, no config import): the budget arrives as a
// resolver so the read stays at the caller's use site, which is what lets one gate serve two provider
// lanes reading two different config leaves.
//
// Every assertion below targets a property `ai/provider/InteractiveBatchQueue.mjs` cannot express —
// weight, a live budget, cancellation, and a synchronous uncontended path. That is the whole reason
// this is a second primitive rather than a wider first one.

/** A budget resolver whose value the test can move between admission decisions. */
function liveBudget(initial) {
    const box = {value: initial};

    return Object.assign(() => box.value, {set: next => { box.value = next }})
}

/** The service supplies a real abort error; the gate only needs a factory. */
function abortError(signal, label) {
    return Object.assign(new Error(`aborted: ${label ?? 'unlabelled'}`), {name: 'AbortError'})
}

function gate(budget) {
    return new EmbeddingAdmission({resolveBudget: liveBudget(budget), createAbortError: abortError})
}

/** Lets a queued caller reach its `await` before the test proceeds. */
const tick = () => new Promise(resolve => setImmediate(resolve));

test.describe('EmbeddingAdmission — weighted, live-budget, abort-aware admission', () => {
    test('admits by WEIGHT, not by item count', () => {
        const admission = gate(4);

        // One POST carrying three inputs costs three of the four task units, not one of four slots.
        expect(admission.tryAcquire({weight: 3})).toBe(true);
        expect(admission.inFlight).toBe(3);

        // A second three-unit post would reach six against a budget of four.
        expect(admission.tryAcquire({weight: 3})).toBe(false);
        expect(admission.inFlight).toBe(3)
    });

    test('idle bypass admits a request heavier than the entire budget', () => {
        const admission = gate(2);

        // Without this, a 10-input post against a budget of 2 waits forever on a gate only it wants —
        // a stall manufactured by the admission control itself.
        expect(admission.tryAcquire({weight: 10})).toBe(true);
        expect(admission.inFlight).toBe(10)
    });

    test('batch is capped one unit below the budget so interactive work finds a slot', () => {
        const admission = gate(4);

        expect(admission.tryAcquire({weight: 1, priority: 'batch'})).toBe(true);
        expect(admission.tryAcquire({weight: 2, priority: 'batch'})).toBe(true);   // 3 <= 4-1

        // A fourth batch unit would consume the headroom interactive work is reserved.
        expect(admission.tryAcquire({weight: 1, priority: 'batch'})).toBe(false);

        // The same unit, interactive, may use the whole budget.
        expect(admission.tryAcquire({weight: 1, priority: 'interactive'})).toBe(true);
        expect(admission.inFlight).toBe(4)
    });

    test('the reservation holds ACROSS callers, not per call', () => {
        const admission = gate(4);

        // The defect this replaces: two callers each satisfying their own reservation while jointly
        // overshooting the budget. Measured historically as two callers at width 3 offering six tasks
        // against a budget of four.
        expect(admission.tryAcquire({weight: 3, priority: 'batch'})).toBe(true);
        expect(admission.tryAcquire({weight: 3, priority: 'batch'})).toBe(false);
        expect(admission.inFlight).toBe(3)
    });

    test('the budget is re-read on every decision, so raising it takes effect immediately', () => {
        const resolveBudget = liveBudget(1),
              admission     = new EmbeddingAdmission({resolveBudget, createAbortError: abortError});

        expect(admission.tryAcquire({weight: 1})).toBe(true);
        expect(admission.tryAcquire({weight: 1})).toBe(false);

        resolveBudget.set(4);

        // No rebuild, no wake — the next attempt simply reads the current number.
        expect(admission.tryAcquire({weight: 1})).toBe(true);
        expect(admission.inFlight).toBe(2)
    });

    test('an unusable budget fails LOUD on the first decision, never falls back to 1', () => {
        const admission = new EmbeddingAdmission({resolveBudget: () => 0, createAbortError: abortError});

        // Resolved before the idle bypass on purpose: a misconfigured lane must not lie dormant until
        // it happens to contend. A quiet fallback to 1 reports healthy while ignoring the deployment.
        expect(() => admission.tryAcquire({weight: 1})).toThrow(/positive integer/);

        const nonNumeric = new EmbeddingAdmission({resolveBudget: () => 'four', createAbortError: abortError});

        expect(() => nonNumeric.tryAcquire({weight: 1})).toThrow(/positive integer/)
    });

    test('constructing with a budget VALUE instead of a resolver is refused', () => {
        // A captured number is the freeze this primitive exists to avoid.
        expect(() => new EmbeddingAdmission({resolveBudget: 4, createAbortError: abortError}))
            .toThrow(/must be a function/)
    });

    test('tryAcquire is synchronous — the uncontended path never yields', () => {
        const admission = gate(2),
              result    = admission.tryAcquire({weight: 1});

        // Returning a promise here would re-time every caller's cancellation relative to its own abort.
        expect(typeof result).toBe('boolean');
        expect(result).toBe(true)
    });

    test('a queued caller that aborts rejects and leaves no waiter behind', async () => {
        const admission  = gate(1),
              controller = new AbortController();

        expect(admission.tryAcquire({weight: 1})).toBe(true);

        const queued = admission.acquire({weight: 1, signal: controller.signal, label: 'probe'});

        await tick();
        expect(admission.waiting).toBe(1);

        controller.abort();

        await expect(queued).rejects.toThrow(/aborted: probe/);
        expect(admission.waiting).toBe(0)
    });

    test('a caller already aborted before queueing rejects without occupying the queue', async () => {
        const admission  = gate(1),
              controller = new AbortController();

        expect(admission.tryAcquire({weight: 1})).toBe(true);
        controller.abort();

        await expect(admission.acquire({weight: 1, signal: controller.signal, label: 'pre'}))
            .rejects.toThrow(/aborted: pre/);
        expect(admission.waiting).toBe(0)
    });

    test('a consumed wake is HANDED ON when its caller aborts, never dropped', async () => {
        const admission  = gate(1),
              controller = new AbortController(),
              order      = [];

        expect(admission.tryAcquire({weight: 1})).toBe(true);

        const b = admission.acquire({weight: 1, signal: controller.signal, label: 'b'})
                  .then(() => order.push('b-admitted'), () => order.push('b-rejected')),
              c = admission.acquire({weight: 1, label: 'c'}).then(() => order.push('c-admitted'));

        await tick();
        expect(admission.waiting).toBe(2);

        // The release selects B and clears B's abort listener, so this abort lands on B's own retry
        // rather than on its waiter. B holds a wake it can no longer use.
        admission.release({weight: 1});
        controller.abort();

        await Promise.allSettled([b, c]);

        // Without the handoff, B's wake evaporates and C waits forever behind an empty gate.
        expect(order).toEqual(['b-rejected', 'c-admitted']);
        expect(admission.waiting).toBe(0)
    });

    test('release wakes interactive work ahead of longer-waiting batch work', async () => {
        const admission = gate(1),
              order     = [];

        expect(admission.tryAcquire({weight: 1})).toBe(true);

        const batch       = admission.acquire({weight: 1, priority: 'batch'}).then(() => order.push('batch')),
              interactive = admission.acquire({weight: 1, priority: 'interactive'}).then(() => order.push('interactive'));

        await tick();
        expect(admission.waiting).toBe(2);

        // Selection happens when the slot FREES, not when the queue was built.
        admission.release({weight: 1});
        await tick();

        expect(order).toEqual(['interactive']);

        admission.release({weight: 1});
        await Promise.allSettled([batch, interactive]);

        expect(order).toEqual(['interactive', 'batch'])
    });

    test('release returns exactly the weight it was given and never drives in-flight negative', () => {
        const admission = gate(8);

        admission.tryAcquire({weight: 5});
        expect(admission.inFlight).toBe(5);

        admission.release({weight: 5});
        expect(admission.inFlight).toBe(0);

        // A release wired to every settlement arm can be reached twice on a racing abort; the floor is
        // what stops that from leaking budget upward into a permanently-open gate.
        admission.release({weight: 5});
        expect(admission.inFlight).toBe(0)
    });

    test('canAdmit answers without taking; admit takes without re-deciding', () => {
        const admission = gate(4);

        // The queued path genuinely needs check-then-act: a post it declines stays QUEUED, so taking
        // weight at the check would be a slot briefly held for a task that never ran.
        expect(admission.canAdmit({weight: 3})).toBe(true);
        expect(admission.inFlight).toBe(0);

        admission.admit({weight: 3});
        expect(admission.inFlight).toBe(3);

        expect(admission.canAdmit({weight: 3})).toBe(false);
        expect(admission.inFlight).toBe(3)
    });

    test('the batch ceiling and idle bypass hold through canAdmit too', () => {
        const admission = gate(4);

        admission.admit({weight: 1});

        expect(admission.canAdmit({weight: 3, priority: 'batch'})).toBe(false);
        expect(admission.canAdmit({weight: 2, priority: 'batch'})).toBe(true);
        expect(admission.canAdmit({weight: 3, priority: 'interactive'})).toBe(true);

        // Same rule, one implementation — this is what stops the queued and native paths from
        // agreeing only by coincidence.
        expect(gate(2).canAdmit({weight: 99})).toBe(true)
    });

    test('canAdmit fails closed on an unusable budget, like tryAcquire', () => {
        const admission = new EmbeddingAdmission({resolveBudget: () => 0, createAbortError: abortError});

        expect(() => admission.canAdmit({weight: 1})).toThrow(/positive integer/)
    });

    test('weights are normalised to at least one unit', () => {
        expect(EmbeddingAdmission.normaliseWeight(0)).toBe(1);
        expect(EmbeddingAdmission.normaliseWeight(-3)).toBe(1);
        expect(EmbeddingAdmission.normaliseWeight(undefined)).toBe(1);
        expect(EmbeddingAdmission.normaliseWeight(2.7)).toBe(2);
        expect(EmbeddingAdmission.normaliseWeight(4)).toBe(4)
    })
});

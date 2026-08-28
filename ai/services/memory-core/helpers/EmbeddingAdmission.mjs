/**
 * @summary The embedding lane's single admission gate — weighted, priority-aware, and abort-aware.
 *
 * One primitive replaces the two that `TextEmbeddingService` grew independently: a weighted worker
 * queue for the OpenAI-compatible path and a counting semaphore for the native Ollama path. They
 * solved the same problem — *may this request start now?* — for two providers, and diverged on every
 * answer: one counted tasks, the other requests; one preferred interactive work, the other was FIFO;
 * one read its budget live, the other did too but from a different leaf.
 *
 * **This is deliberately NOT `ai/provider/InteractiveBatchQueue.mjs`, and the difference is the point.**
 * That queue owns its tasks: callers hand it a thunk and it decides when to run them, one item to one
 * slot, against a capacity frozen at construction. This gate owns nothing — callers keep their own
 * execution and ask only whether they may proceed. The embedding lane needs the second shape because
 * of four properties the first cannot express without becoming it:
 *
 * 1. **Weight.** One OpenAI-compatible POST of N inputs costs N provider tasks, not one slot. The
 *    capacity unit is a task (see {@link module:ai/services/memory-core/helpers/embeddingDispatchPlan}),
 *    so admitting by item count silently multiplies offered work by the request width.
 * 2. **A live budget.** The cap is re-read on every admission decision. Raising it takes effect on the
 *    next attempt rather than requiring the gate to be rebuilt — which a constructor-captured number
 *    cannot do, and which ADR 0019 §5.1 wants anyway (read at the use site, never a threaded value).
 * 3. **Cancellation.** An embedding caller carries an `AbortSignal` and may leave while queued. A gate
 *    that cannot observe that either strands the caller or re-times its cancellation.
 * 4. **A synchronous uncontended path.** When a slot is free the caller must proceed *without* an
 *    `await`. An unconditional await re-times every caller's cancellation relative to its own abort,
 *    which is why the Ollama path took the synchronous branch and why this gate keeps it.
 *
 * Routing embedding traffic through the item-counting queue would have required teaching it all four,
 * and its two existing consumers — `buildChatModel` and `SearchService` — use none of them. Two
 * genuinely different contracts do not need a shared abstraction between them.
 *
 * @module ai/services/memory-core/helpers/EmbeddingAdmission
 */

/**
 * @summary A weighted admission gate over a live, externally-resolved budget.
 *
 * @class EmbeddingAdmission
 */
export default class EmbeddingAdmission {
    /**
     * @summary Resolves the current budget in weight units. Called on EVERY admission decision.
     * @type {Function}
     * @private
     */
    #resolveBudget = null;

    /**
     * @summary Builds the rejection a queued caller receives when its signal aborts.
     * @type {Function}
     * @private
     */
    #createAbortError = null;

    /**
     * @summary Weight currently admitted and not yet released.
     * @type {Number}
     * @private
     */
    #inFlight = 0;

    /**
     * @summary Callers awaiting a slot. Interactive entries are woken before batch ones; within a
     * priority, insertion order holds.
     * @type {Object[]}
     * @private
     */
    #waiters = [];

    /**
     * @summary Creates a gate over a budget the caller resolves.
     *
     * `resolveBudget` is a FUNCTION, never a number, and the distinction is load-bearing: a number
     * captured here would freeze the deployment's declared width at construction, which is the exact
     * defect that let a lane allocate for four slots and run two. Passing a resolver keeps the read at
     * the use site — the caller's thunk reads its own reactive config leaf when asked — so this module
     * imports no config of its own and two lanes can name two different leaves.
     *
     * @param {Object} options
     * @param {Function} options.resolveBudget `() => Number` — the current budget in weight units.
     *     Expected to THROW on a value it cannot honour rather than substituting a default; a lane
     *     that quietly falls back to 1 reports healthy while ignoring what the deployment declared.
     * @param {Function} options.createAbortError `(signal, label) => Error` — the rejection handed to a
     *     queued caller whose signal fires.
     */
    constructor({resolveBudget, createAbortError}) {
        if (typeof resolveBudget !== 'function') {
            throw new TypeError('EmbeddingAdmission: resolveBudget must be a function, so the budget stays live')
        }

        if (typeof createAbortError !== 'function') {
            throw new TypeError('EmbeddingAdmission: createAbortError must be a function')
        }

        this.#resolveBudget    = resolveBudget;
        this.#createAbortError = createAbortError
    }

    /**
     * @summary Weight admitted and not yet released, for observability and assertions.
     * @returns {Number}
     */
    get inFlight() {
        return this.#inFlight
    }

    /**
     * @summary Callers currently queued, for observability and assertions.
     * @returns {Number}
     */
    get waiting() {
        return this.#waiters.length
    }

    /**
     * @summary Admits immediately, or reports that the caller must wait. NEVER returns a promise.
     *
     * The synchronous return is the contract, not an optimisation: an uncontended caller proceeds
     * without an `await`, so its cancellation keeps its own timing rather than being re-sequenced
     * behind a microtask.
     *
     * **Idle bypass.** Nothing in flight always admits, whatever the weight. Without it a request
     * heavier than the entire budget could never be admitted and would wait forever on a gate that
     * only it wanted — a stall produced by the admission control rather than by contention.
     *
     * **Asymmetric ceiling.** Batch work is capped one unit below the budget so a single-task
     * interactive request finds a slot to take rather than a queue to wait behind. The reservation is
     * enforced HERE, against total in-flight weight, and that placement is the fix rather than a
     * detail: a per-call reservation is sound for one caller and silently false for two, since each
     * satisfies its own reservation while they jointly overshoot the budget the reservation protects.
     *
     * @param {Object} [options]
     * @param {Number} [options.weight=1] Weight units this caller consumes.
     * @param {'interactive'|'batch'} [options.priority='interactive'] Lane priority.
     * @returns {Boolean} `true` when admitted — the caller MUST later {@link release} the same weight.
     * @throws {TypeError} Propagated from `resolveBudget` when the configured budget is unusable.
     */
    tryAcquire({weight = 1, priority = 'interactive'} = {}) {
        if (!this.canAdmit({weight, priority})) return false;

        this.admit({weight});

        return true
    }

    /**
     * @summary Whether a request of this shape would be admitted right now. Takes NOTHING.
     *
     * Separate from {@link admit} because one caller genuinely needs check-then-act: a queue that
     * selects among waiting posts must ask whether the one it picked would fit *before* committing to
     * dispatch it, and it may then decline and leave the post queued. A caller with no such selection
     * step should use {@link tryAcquire}, which composes the two without the gap.
     *
     * @param {Object} [options]
     * @param {Number} [options.weight=1] Weight units the request would consume.
     * @param {'interactive'|'batch'} [options.priority='interactive'] Lane priority.
     * @returns {Boolean}
     * @throws {TypeError} Propagated from `resolveBudget` when the configured budget is unusable.
     */
    canAdmit({weight = 1, priority = 'interactive'} = {}) {
        const units = EmbeddingAdmission.normaliseWeight(weight);

        // Resolved BEFORE the idle bypass on purpose: a misconfigured budget must fail loud on the
        // very first decision, not lie dormant until the lane happens to contend.
        const budget = this.#resolveBudget();

        if (!Number.isInteger(budget) || budget < 1) {
            throw new TypeError(`EmbeddingAdmission: resolveBudget must yield a positive integer; received ${JSON.stringify(budget)}`)
        }

        if (this.#inFlight === 0) return true;

        const ceiling = priority === 'interactive' ? budget : Math.max(budget - 1, 1);

        return this.#inFlight + units <= ceiling
    }

    /**
     * @summary Takes weight the caller has already established it may take.
     *
     * Pairs with {@link canAdmit}. Unconditional by design: a gate that silently re-decided here would
     * make the caller's own check meaningless and hide the disagreement.
     *
     * @param {Object} [options]
     * @param {Number} [options.weight=1] Weight units to take.
     * @returns {void}
     */
    admit({weight = 1} = {}) {
        this.#inFlight += EmbeddingAdmission.normaliseWeight(weight)
    }

    /**
     * @summary Waits until admitted, or rejects when the caller's signal aborts.
     *
     * Safe to call directly — the first loop iteration attempts admission itself. The reason callers
     * still lead with {@link tryAcquire} is the synchronous uncontended path: reaching an `await` at
     * all is what re-times a caller's cancellation, so the fast path must not be entered. On return
     * the caller holds `weight` units and owes a {@link release}.
     *
     * Re-checks the budget on every iteration rather than trusting the value that queued the caller.
     * A raised cap wakes nobody — nothing watches the config — but the next attempt, whether a fresh
     * caller or a woken waiter, reads the current number.
     *
     * @param {Object} options
     * @param {Number} [options.weight=1] Weight units this caller consumes.
     * @param {'interactive'|'batch'} [options.priority='interactive'] Lane priority.
     * @param {AbortSignal} [options.signal] Caller-owned cancellation.
     * @param {String} [options.label] Bounded diagnostic label passed to `createAbortError`.
     * @param {Function} [options.onPhase] `(phase: String) => void` — observability only; never
     *     allowed to affect admission.
     * @returns {Promise<void>}
     */
    async acquire({weight = 1, priority = 'interactive', signal, label, onPhase} = {}) {
        // Tracks whether this caller is holding a wake it has not yet converted into a slot. A caller
        // can abort after a release selected it but before its retry runs; the wake it consumed must
        // reach the next waiter rather than evaporating and stranding the queue.
        let consumedWake = false;

        while (true) {
            let admitted;

            try {
                this.#throwIfAborted(signal, label);
                admitted = this.tryAcquire({weight, priority})
            } catch (error) {
                if (consumedWake) this.#wakeNext();
                throw error
            }

            if (admitted) return;

            onPhase?.('awaiting-admission');

            consumedWake = false;
            await this.#waitForWake({priority, signal, label, onPhase});
            consumedWake = true
        }
    }

    /**
     * @summary Returns weight to the gate and wakes the next eligible caller.
     *
     * Must be wired to EVERY settlement arm — success, throw, and abort alike. A release that only ran
     * on success would leak the budget down to zero after N failures and stall the lane completely,
     * turning an admission control into an outage with no error of its own.
     *
     * @param {Object} [options]
     * @param {Number} [options.weight=1] The same weight that was admitted.
     * @returns {void}
     */
    release({weight = 1} = {}) {
        this.#inFlight = Math.max(0, this.#inFlight - EmbeddingAdmission.normaliseWeight(weight));
        this.#wakeNext()
    }

    /**
     * @summary Normalises a caller-supplied weight to a positive integer count of units.
     * @param {*} weight Raw weight, typically an input-array length.
     * @returns {Number} At least one.
     */
    static normaliseWeight(weight) {
        const units = Number(weight);

        return Number.isFinite(units) ? Math.max(1, Math.floor(units)) : 1
    }

    /**
     * @summary Wakes the longest-waiting interactive caller, else the longest-waiting batch caller.
     *
     * Selection happens when a slot FREES rather than when the queue was built, so an interactive
     * caller that arrived while batch work was running still overtakes it.
     * @returns {void}
     * @private
     */
    #wakeNext() {
        let index = this.#waiters.findIndex(waiter => waiter.priority === 'interactive');

        if (index === -1) index = 0;

        const waiter = this.#waiters.splice(index, 1)[0];

        if (!waiter) return;

        waiter.cleanup();
        waiter.resolve()
    }

    /**
     * @summary Parks the caller until {@link #wakeNext} selects it, or its signal aborts.
     * @param {Object} options
     * @param {'interactive'|'batch'} options.priority Lane priority.
     * @param {AbortSignal} [options.signal] Caller-owned cancellation.
     * @param {String} [options.label] Bounded diagnostic label.
     * @param {Function} [options.onPhase] Observability hook.
     * @returns {Promise<void>}
     * @private
     */
    #waitForWake({priority, signal, label, onPhase}) {
        return new Promise((resolve, reject) => {
            let settled = false;

            const waiter  = {priority},
                  cleanup = () => signal?.removeEventListener('abort', onAbort),
                  settle  = (fn, value) => {
                      if (settled) return;

                      settled = true;
                      cleanup();
                      fn(value)
                  },
                  onAbort = () => {
                      const index = this.#waiters.indexOf(waiter);

                      if (index !== -1) this.#waiters.splice(index, 1);

                      onPhase?.('caller-aborted-awaiting-admission');
                      settle(reject, this.#createAbortError(signal, label))
                  };

            waiter.cleanup = cleanup;
            waiter.resolve = () => settle(resolve);

            this.#waiters.push(waiter);
            signal?.addEventListener('abort', onAbort, {once: true});

            if (signal?.aborted) onAbort()
        })
    }

    /**
     * @summary Throws the caller's own abort error when its signal has already fired.
     * @param {AbortSignal} [signal] Caller-owned cancellation.
     * @param {String} [label] Bounded diagnostic label.
     * @returns {void}
     * @private
     */
    #throwIfAborted(signal, label) {
        if (signal?.aborted) throw this.#createAbortError(signal, label)
    }
}

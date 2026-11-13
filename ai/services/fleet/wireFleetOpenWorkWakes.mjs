/**
 * @module ai/services/fleet/wireFleetOpenWorkWakes
 * @summary Persist holder-action admissions before submitting them to the already verified plane, which composes
 * each wake and sends it as `@system` (`openWorkWakeMessage.mjs`). The existing producer invokes this callback; it
 * owns cadence. The entrypoint owns enablement. An admitted attempt is never proof of delivery.
 *
 * A failed submission is submitted again on a later round, five attempts at most. The plane answers a repeat of one
 * wake with its first receipt, so a retry after a lost answer writes nothing new. A refused submission is never
 * retried. An admission keeps its intake receipt's message id, and only the receiver's record of that message, read
 * back from the plane, can certify its holder silent.
 */
import path                                              from 'path';
import {exhaustedUntilOf}                                from './capacityThrottleState.mjs';
import {OPEN_WORK_FAILED_CHECKS}                         from '../github-workflow/queries/openWorkQueries.mjs';
import {fileStore, seatReaders}                          from './wireFleetOpenWorkSource.mjs';
import {HOLDER_SILENT_MS, planOpenWorkWakes, wakeGateOf} from './openWorkWakes.mjs';
import {OPEN_WORK_HOLDER_KINDS}                          from './openWorkWakeMessage.mjs';
import {openWorkFreshness}                               from './openWorkFreshness.mjs';

const
    ROUTES_TTL_MS     = 5 * 60 * 1000,
    // The plane's bound on one delivery read (`read_open_work_wake_delivery`)
    DELIVERY_READ_MAX = 100,
    MESSAGE_ID        = /^MESSAGE:[\w-]{1,100}$/,
    // Submissions per wake: a few rounds of a slow or restarting plane
    RETRY_LIMIT       = 5,
    // The plane's answer to an observation it will never admit; retrying it changes nothing
    REFUSED           = /\bRefused\b/;

/**
 * @summary A wake's or slot's count of failed submissions: absent before the first failure.
 * @param {*} value
 * @returns {Boolean}
 * @private
 */
function validAttempts(value) {
    return Number.isSafeInteger(value) && value >= 1 && value <= RETRY_LIMIT
}

/**
 * @summary The record one more failed submission leaves: re-armed with the count, or kept once the count is spent.
 * @param {Object} record A holding entry or a merge wake.
 * @param {Object} [rearm] What re-arms the record for the next round, e.g. `{status: 'pending'}`.
 * @returns {Object}
 * @private
 */
function failedOnce(record, rearm = {}) {
    const attempts = (record.attempts ?? 0) + 1;
    return attempts < RETRY_LIMIT ? {...record, ...rearm, attempts} : {...record, attempts}
}

/**
 * @summary An intake receipt's message id, or null for an id-less or malformed receipt.
 * @param {*} value
 * @returns {String|null}
 * @private
 */
function messageIdOf(value) {
    return typeof value === 'string' && MESSAGE_ID.test(value) ? value : null
}

/** @summary The check-run conclusions and status states that fail a head; pending, stale, neutral and skipped do not. */
const FAILING = new Set(['ACTION_REQUIRED', 'CANCELLED', 'ERROR', 'FAILURE', 'STARTUP_FAILURE', 'TIMED_OUT']);

const REFUSAL_REASONS = [
    ['the producer observation is not fresh', 'producer-not-fresh'],
    ['no version-one observation history', 'observation-history-missing'],
    ['the latest telemetry does not represent', 'latest-observation-mismatch'],
    ['less than 24 elapsed hours', 'observation-window-short'],
    ['malformed or unordered pulse telemetry', 'pulse-telemetry-invalid'],
    ['a pulse has unattributed or unknown query cost', 'query-cost-unattributed'],
    ['a pulse has unknown query cost without classified attempts', 'query-cost-unclassified'],
    ['pending: a failed query has no declared operational estimate', 'query-estimate-missing'],
    ['pending: unattributed attempts have no known endpoint window or query estimate', 'unattributed-window-pending'],
    ['a pulse has malformed seat coverage', 'seat-coverage-invalid'],
    ['a participating seat has an incomplete', 'seat-read-incomplete'],
    ['the outside pull-request read is missing or incomplete', 'outside-read-incomplete'],
    ['a pulse repeats a seat coverage identity', 'seat-coverage-duplicate'],
    ['a query has missing, malformed or unknown quota evidence', 'quota-evidence-unknown'],
    ['one issuer quota window reports conflicting', 'quota-limits-conflict'],
    ['seat reads have no complete attributed', 'seat-cost-unattributed'],
    ['the latest pulse does not cover', 'current-readers-uncovered'],
    ['the issuer quota window prefix is not retained', 'quota-prefix-missing'],
    ['the observation window contains a gap', 'observation-gap'],
    ['the retained observation window is no longer fresh', 'observation-window-stale'],
    ['an issuer exceeded 20%', 'quota-share-exceeded']
];
const REFUSAL_CODES = new Set([...REFUSAL_REASONS.map(([, code]) => code), 'certification-refused']);

/**
 * @summary Only bounded static reason codes enter diagnostics or persisted history.
 * @param {Object} gate
 * @returns {String}
 * @private
 */
function refusalCode(gate) {
    const reason = typeof gate?.reason === 'string' ? gate.reason : '';
    return REFUSAL_REASONS.find(([prefix]) => reason.startsWith(prefix))?.[1] ?? 'certification-refused'
}

/**
 * @summary The failing checks in one {@link OPEN_WORK_FAILED_CHECKS} answer: check runs by name, commit
 * statuses by context. A head keeps every run of a re-run check, and GitHub's rollup still counts a
 * superseded failure, so only each check's latest run decides; a queued run, not yet started, is the latest.
 * @param {Object|null} data
 * @returns {String[]|null} The names; null when the answer holds no rollup or more checks than its page.
 */
export function failedChecksOf(data) {
    const
        contexts = data?.repository?.object?.statusCheckRollup?.contexts,
        latest   = new Map(),
        started  = node => node.startedAt ? Date.parse(node.startedAt) : Infinity;

    if (!Array.isArray(contexts?.nodes) || contexts.pageInfo?.hasNextPage !== false) return null;

    for (const node of contexts.nodes) {
        const
            key   = JSON.stringify([node?.checkSuite?.workflowRun?.workflow?.name ?? null, node?.name ?? node?.context]),
            prior = latest.get(key);

        if (!prior || started(node) >= started(prior)) latest.set(key, node)
    }

    return [...latest.values()].filter(node => FAILING.has(node?.conclusion ?? node?.state)).map(node => node.name ?? node.context)
}

/**
 * @summary The observation the plane's open-work intake admits for one wake: tokens only, never text.
 * @param {Object} wake The planner's admission.
 * @param {String[]|null} failedChecks A `repair-ci` wake's failing checks; null when unread or another kind.
 * @returns {Object} The `admit_open_work_wake` arguments.
 * @private
 */
function observationOf(wake, failedChecks) {
    const {repo, number, head, kind, episode, to, unblocks, holder} = wake;

    return {repo, number, head, kind, episode, to, failedChecks, ...(kind === 'unblocked' ? {unblocks} : {}),
        ...(OPEN_WORK_HOLDER_KINDS.has(kind) ? {holder} : {})}
}

/**
 * @summary Validate retained certification structure, without re-running its historical cost policy.
 * Missing receipts remain possible on legacy activations and injected test gates; present receipts
 * name their exact protocol. Issuer reset times are not constrained by the client's activation clock.
 * @param {Object} receipt
 * @param {Number} activatedAt Epoch milliseconds.
 * @returns {Boolean}
 * @private
 */
function validCertification(receipt, activatedAt) {
    const
        object   = value => value && typeof value === 'object' && !Array.isArray(value),
        text     = value => typeof value === 'string' && value.trim().length > 0,
        amount   = value => Number.isSafeInteger(value) && value >= 0,
        positive = value => Number.isFinite(value) && value >= 1,
        date     = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)),
        endpoint = value => {
            if (!text(value)) return false;
            try {
                const url = new URL(value);
                return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
            } catch { return false }
        };

    if (!object(receipt) || receipt.version !== 1 || receipt.policy !== 'open-work-operational-estimate-v1' ||
        !object(receipt.window) || !date(receipt.window.start) || !date(receipt.window.end) || !date(receipt.window.retainedFrom) ||
        Date.parse(receipt.window.retainedFrom) > Date.parse(receipt.window.start) ||
        Date.parse(receipt.window.start) >= Date.parse(receipt.window.end) ||
        Date.parse(receipt.window.end) > activatedAt ||
        !Array.isArray(receipt.estimates) || !Array.isArray(receipt.buckets)) return false;

    return receipt.estimates.every(value => object(value) && endpoint(value.apiBase) && text(value.queryHash) &&
        positive(value.formulaCost) && positive(value.reservePerCall) &&
        (value.maxMeasuredCost === null || Number.isFinite(value.maxMeasuredCost) && value.maxMeasuredCost >= 0)) &&
        receipt.buckets.every(value => object(value) && endpoint(value.apiBase) && text(value.viewerId) && date(value.resetAt) &&
            amount(value.limit) && value.limit > 0 &&
            ['measured', 'estimated', 'unattributed', 'estimatedCalls', 'unattributedCalls'].every(key => amount(value[key])) &&
            ['operational-estimate', 'reported-user-total'].includes(value.decision) &&
            (value.userTotal === null || object(value.userTotal) && date(value.userTotal.at) &&
                amount(value.userTotal.used) && amount(value.userTotal.remaining)) &&
            (value.decision !== 'reported-user-total' || value.userTotal !== null))
}

/**
 * @summary Refuse malformed persisted history instead of overwriting it as a fresh baseline.
 * @param {Object|null} ledger
 * @param {Number} now Epoch milliseconds for activation timestamp validation.
 * @private
 */
function validateLedger(ledger, now) {
    if (ledger === null) return;
    const
        object = value => value && typeof value === 'object' && !Array.isArray(value),
        text   = value => typeof value === 'string' && value.length > 0,
        // An escalation's holder is part of its identity, and never its recipient
        holder = value => OPEN_WORK_HOLDER_KINDS.has(value.kind)
            ? value.role === 'rotation' && text(value.holder) && value.holder.startsWith('@') && value.holder !== value.to
            : !Object.hasOwn(value, 'holder'),
        wake   = value => object(value) && text(value.repo) && Number.isInteger(value.number) && value.number > 0 &&
            text(value.head) && text(value.to) && value.to.startsWith('@') && text(value.kind) &&
            text(value.episode) && text(value.reason) && ['author', 'reviewer', 'rotation', 'assignee'].includes(value.role) &&
            value.pr === `${value.repo}#${value.number}` && holder(value) &&
            value.key === JSON.stringify([value.repo, value.number, value.head, value.to, value.kind, value.episode,
                ...(value.holder ? [value.holder] : [])]);

    if (!object(ledger) || !text(ledger.pulse) || !Number.isFinite(Date.parse(ledger.pulse)) ||
        !object(ledger.holding) || !object(ledger.pendingMerges) || !object(ledger.baselines) ||
        Object.hasOwn(ledger, 'activation') && (!object(ledger.activation) || ledger.activation.version !== 1 ||
            !text(ledger.activation.at) || !/^\d{4}-\d{2}-\d{2}T/.test(ledger.activation.at) ||
            !Number.isFinite(Date.parse(ledger.activation.at)) || Date.parse(ledger.activation.at) > now ||
            Object.hasOwn(ledger.activation, 'certification') &&
                !validCertification(ledger.activation.certification, Date.parse(ledger.activation.at))) ||
        ledger.certificationRefusal != null && !REFUSAL_CODES.has(ledger.certificationRefusal) ||
        Object.entries(ledger.holding).some(([slot, entry]) => !object(entry) || !wake(entry.wake) ||
            !['baseline', 'pending', 'admitted'].includes(entry.status) ||
            Object.hasOwn(entry, 'messageId') && (entry.status !== 'admitted' || !messageIdOf(entry.messageId)) ||
            Object.hasOwn(entry, 'attempts') && !validAttempts(entry.attempts) ||
            slot !== JSON.stringify([entry.wake.repo, entry.wake.number, entry.wake.head,
                entry.wake.role === 'rotation' ? 'rotation' : entry.wake.to, entry.wake.kind,
                ...(entry.wake.holder ? [entry.wake.holder] : [])])) ||
        Object.entries(ledger.pendingMerges).some(([id, value]) => !wake(value) ||
            Object.hasOwn(value, 'attempts') && !validAttempts(value.attempts) ||
            !(value.kind === 'post-merge' && id === value.episode || value.kind === 'unblocked' && id === value.key && text(value.unblocks))) ||
        Object.values(ledger.baselines).some(value => !text(value))) {
        throw new Error('Malformed open-work wake ledger; existing history preserved')
    }
}

/**
 * @summary Keep the newest queued snapshot without losing terminal observations that arrived before it.
 * @param {Object|null} queued
 * @param {Object} incoming
 * @returns {Object}
 * @private
 */
function queueObservation(queued, incoming) {
    if (!queued) return structuredClone(incoming);
    const latest    = Date.parse(incoming.observedAt) >= Date.parse(queued.observedAt) ? incoming : queued,
        transitions = new Map();

    for (const entry of [...(queued.transitions ?? []), ...(incoming.transitions ?? [])]) {
        transitions.set(JSON.stringify([entry.id, entry.key, entry.head, entry.kind, entry.pulse]), entry)
    }

    return structuredClone({...latest, transitions: [...transitions.values()]})
}

/**
 * @summary Test the source observation at the current effect boundary, never at an earlier await.
 * @param {Object} state
 * @param {Number} now
 * @returns {Boolean}
 * @private
 */
function freshObservation(state, now) {
    return !!state?.snapshot?.rows && ['complete', 'partial'].includes(state.coverage) &&
        openWorkFreshness(state.observedAt, {now}) === 'ok'
}

/**
 * @summary An open action also needs its own row's fresh evidence; a merge's action needs the producer.
 * @param {Object} wake
 * @param {Object} state
 * @param {Number} now
 * @returns {Boolean}
 * @private
 */
function freshWake(wake, state, now) {
    return freshObservation(state, now) && (wake.kind === 'post-merge' || wake.kind === 'unblocked' ||
        openWorkFreshness(state.snapshot.rows[wake.pr]?.observedAt, {now}) === 'ok')
}

/**
 * @summary Create one serial post-pulse consumer. Route skips remain pending; admission is persisted
 * before any submission. Freshness is checked after route/persistence waits and before each submission;
 * an expired reservation remains admitted but submits nothing. stop() refuses new work, drops queued
 * work and awaits the active round. Certification latches in the ledger; later gate refusals cannot
 * erase it or pending actions. The enablement getter still guards every submission boundary.
 * @param {Object} options
 * @param {{load: Function, save: Function}} options.store Durable ledger; only absence returns null.
 * @param {Function} options.admitWake `(observation) → Promise`: the same verified plane's open-work intake,
 *     injected by the entrypoint. The plane composes the wake and sends it as `@system`.
 * @param {Function} [options.readUndeliverable] Seat-to-nullable-reason map; membership means unreachable.
 *     An unreadable or absent whole map means unknown.
 * @param {Function} [options.readExhausted] Seat to the epoch milliseconds its plan resets, read with the route map
 *     and cached with it. The rotation passes those seats over until then; an unreadable map passes nobody over.
 * @param {Function} [options.now] Epoch milliseconds.
 * @param {Number} [options.routesTtlMs] Short cache duration for the existing route read.
 * @param {Function} [options.gateOf] Test seam; production uses wakeGateOf's measured observation gate.
 * @param {Function} [options.isEnabled] The entrypoint's live permission to send; no config is read here.
 * @param {Array<String|Object>|Function} [options.rotationSeats] Participating native seats for rotation actions.
 * @param {Function} [options.readFailedChecks] `(wake) → Promise<String[]|null>`: a `repair-ci` wake's failing
 *     checks, read once before its send. A throw or null sends the wake with the names unknown.
 * @param {Function} [options.readDelivery] `(messageIds) → Promise<{messages}>`: the same verified plane's delivery
 *     read, asked about every admitted holder wake first observed at least `HOLDER_SILENT_MS` ago, at most
 *     `DELIVERY_READ_MAX` ids per call. A throw or an absent answer reads that call's messages unknown, so none of
 *     them is certified silent.
 * @param {Object} [options.log] Bounded diagnostics; sender error contents are never logged.
 * @returns {Function} Post-pulse callback with an async stop() method; persistence errors reject.
 */
export function createOpenWorkWakeRound({store, admitWake, readUndeliverable = async () => null, readExhausted = async () => null,
    now = Date.now, routesTtlMs = ROUTES_TTL_MS, gateOf = wakeGateOf, isEnabled = () => true, rotationSeats, readFailedChecks = null,
    readDelivery = null, log = console}) {
    let running = null, queued = null, stopped = false, routes = null;

    /** @summary A failed names read is names-unknown, never a lost wake. */
    const failedChecksFor = async wake => {
        try { return await readFailedChecks?.(wake) ?? null } catch { return null }
    };

    /**
     * @summary The delivery verdicts of every admitted holder wake old enough to have gone silent, read each round in
     * batches of the plane's bound, oldest first: a fixed first batch would starve every wake behind it. A wake is
     * delivered no earlier than its action was first observed, so a younger one is never asked about. A batch whose
     * read fails leaves only its own wakes unknown.
     */
    const deliveriesOf = async (ledger, time) => {
        const ids = Object.values(ledger?.holding ?? {})
            .filter(entry => entry.status === 'admitted' && entry.wake.role !== 'rotation' && entry.messageId &&
                Date.parse(entry.wake.episode) <= time - HOLDER_SILENT_MS)
            .sort((left, right) => left.wake.episode.localeCompare(right.wake.episode))
            .map(entry => entry.messageId);

        if (!ids.length || typeof readDelivery !== 'function') return null;

        const verdicts = {};

        for (let start = 0; start < ids.length; start += DELIVERY_READ_MAX) {
            try {
                const messages = (await readDelivery(ids.slice(start, start + DELIVERY_READ_MAX)))?.messages;
                if (messages && typeof messages === 'object' && !Array.isArray(messages)) Object.assign(verdicts, messages)
            } catch { /* this batch's wakes stay unknown */ }
        }

        return verdicts
    };

    /** @summary Read the route projection and the plan resets only when a plan has eligible work. */
    async function routeMap() {
        const time = now();
        if (!routes || time < routes.at || time - routes.at >= routesTtlMs) {
            const settled        = read => Promise.resolve().then(read).catch(() => null),
                [map, exhausted] = await Promise.all([settled(readUndeliverable), settled(readExhausted)]),
                plain            = (value, valid) => value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(valid) ? value : null;

            routes = {at: time, map: plain(map, reason => reason === null || typeof reason === 'string'), exhausted: plain(exhausted, Number.isFinite)}
        }
        return routes
    }

    /** @summary Persist certification once, then admit fresh actions while the entrypoint permits effects. */
    async function run(state) {
        if (isEnabled() !== true) return {admitted: 0, disabled: true};
        const stored = await store.load(), time = now();
        if (isEnabled() !== true) return {admitted: 0, disabled: true};
        validateLedger(stored, time);
        // Evidence refusal is not a quiet-policy baseline: pending routes must survive source loss.
        if (!freshObservation(state, time)) return {admitted: 0};
        const pending = stored && (Object.values(stored.holding).some(entry => entry.status === 'pending') ||
            Object.keys(stored.pendingMerges).length > 0);

        if (stored && (Date.parse(state?.observedAt) < Date.parse(stored.pulse) ||
            state?.observedAt === stored.pulse && !pending)) return {admitted: 0};

        let activation = stored?.activation, certificationRefusal = null, persisted = stored;
        if (!activation) {
            const gate = gateOf(state, {now: time});
            if (gate?.holds === true) {
                activation = {version: 1, at: new Date(time).toISOString()};
                if (Object.hasOwn(gate, 'certification')) {
                    let receipt;
                    try { receipt = structuredClone(gate.certification) } catch {
                        throw new Error('Malformed open-work wake certification; activation refused')
                    }
                    if (!validCertification(receipt, time)) {
                        throw new Error('Malformed open-work wake certification; activation refused')
                    }
                    activation.certification = receipt
                }
            } else certificationRefusal = refusalCode(gate)
        }

        /** @summary Log only a durable activation or a changed static refusal code, including across restarts. */
        const persist = async value => {
            if (JSON.stringify(value) === JSON.stringify(persisted)) return;
            const activated = !persisted?.activation && value.activation,
                refused     = !value.activation && value.certificationRefusal !== persisted?.certificationRefusal;
            await store.save(value);
            persisted = value;
            if (activated) log.info?.('[fleet] open-work wakes activated');
            else if (refused) log.info?.('[fleet] open-work wakes await certification', {reason: value.certificationRefusal})
        };
        const withCertification = value => ({
            ...value, ...(activation ? {activation} : {}), certificationRefusal
        });
        const first    = Date.parse(state?.pulses?.[0]?.at),
            ledger     = stored && !stored.activation && Number.isFinite(first) && Date.parse(stored.pulse) < first ? null : stored,
            roster     = typeof rotationSeats === 'function' ? rotationSeats() : rotationSeats,
            deliveries = await deliveriesOf(ledger, time),
            args       = {state, ledger, deliveries, ...(roster !== undefined ? {rotationSeats: roster} : {})};
        let plan = planOpenWorkWakes({...args, now: time, quiet: !activation}), expired = 0;

        // A newly proven certification survives a later route timeout; this write admits no send.
        if (activation && !stored?.activation && stored && plan.wakes.length) {
            if (isEnabled() !== true) return {admitted: 0, disabled: true};
            await persist(withCertification(stored))
        }

        if (plan.wakes.length) {
            if (isEnabled() !== true) return {admitted: 0, disabled: true};
            const {map, exhausted} = await routeMap(), preparedAt = now();
            if (isEnabled() !== true) return {admitted: 0, disabled: true};
            expired = plan.wakes.filter(wake => !freshWake(wake, state, preparedAt)).length;
            if (!freshObservation(state, preparedAt)) return {admitted: 0, expired};
            plan = planOpenWorkWakes({...args, now: preparedAt, quiet: !activation, exhaustedUntil: exhausted, routeOf: seat =>
                map && Object.hasOwn(map, seat) ? 'unreachable' : 'unknown'})
        }

        if (!plan.ledger) return {admitted: 0, expired};
        if (isEnabled() !== true) return {admitted: 0, disabled: true};
        await persist(withCertification(plan.ledger));

        let sendErrors = 0, disabled = false;
        const
            receipts = new Map(),
            failed   = new Set(),
            slotOf   = new Map(Object.values(plan.ledger.holding).map(entry => [entry.wake.key, entry]));

        for (const wake of plan.wakes) {
            // the names read awaits, so enablement and freshness are tested after it, at the send
            const failedChecks = wake.kind === 'repair-ci' && isEnabled() === true ? await failedChecksFor(wake) : null;
            if (isEnabled() !== true) {
                disabled = true;
                break
            }
            if (!freshWake(wake, state, now())) {
                expired++;
                continue
            }
            try {
                const messageId = messageIdOf((await admitWake(observationOf(wake, failedChecks)))?.messageId);
                messageId && receipts.set(wake.key, messageId)
            } catch (error) {
                sendErrors++;
                const
                    refused = REFUSED.test(String(error?.message ?? '')),
                    spent   = !refused && failedOnce(slotOf.get(wake.key) ?? wake).attempts >= RETRY_LIMIT;

                refused || failed.add(wake.key);
                log.error?.(`[fleet] open-work wake attempt failed or is ambiguous; ${refused ? 'refused, not retried' : spent ? 'attempts spent' : 'retried on a later round'}`,
                    {pr: wake.pr.slice(0, 160), kind: wake.kind.slice(0, 40)})
            }
        }

        // One save keeps every receipt on its admitted slot, the id its delivery is read back by, and re-arms each failed
        // submission until its attempts are spent: a holding slot as pending, a merge wake among the pending merges
        if (receipts.size || failed.size) {
            const merges = plan.wakes.filter(wake => failed.has(wake.key) && !slotOf.has(wake.key))
                .map(wake => failedOnce(wake)).filter(wake => wake.attempts < RETRY_LIMIT);

            await persist(withCertification({
                ...plan.ledger,
                holding: Object.fromEntries(Object.entries(plan.ledger.holding).map(([slot, entry]) => [slot,
                    receipts.has(entry.wake.key) ? {...entry, messageId: receipts.get(entry.wake.key)} :
                        failed.has(entry.wake.key) ? failedOnce(entry, {status: 'pending'}) : entry])),
                pendingMerges: {...plan.ledger.pendingMerges,
                    ...Object.fromEntries(merges.map(wake => [wake.kind === 'post-merge' ? wake.episode : wake.key, wake]))}
            }))
        }

        return {admitted: plan.wakes.length, expired, sendErrors, quiet: !activation, reason: certificationRefusal,
            ...(disabled ? {disabled: true} : {})}
    }

    /** @summary Consume the latest queued observation after the active send settles, without overlap. */
    const onPulse = state => {
        if (stopped) return Promise.resolve({admitted: 0, stopped: true});
        queued = queueObservation(queued, state);
        if (!running) {
            running = (async () => {
                let result;
                while (queued && !stopped) {
                    const next = queued;
                    queued = null;
                    result = await run(next)
                }
                return result
            })().finally(() => { running = null })
        }
        return running
    };

    /** @summary Let the entrypoint await the active sender before closing its verified plane client. */
    onPulse.stop = () => {
        stopped = true;
        queued = null;
        return running ?? Promise.resolve()
    };

    return onPulse
}

/**
 * @summary Read a `repair-ci` wake's failing checks as its author seat, with that seat's own PAT from the
 * producer's {@link seatReaders}: one {@link OPEN_WORK_FAILED_CHECKS} request per call.
 * @param {Object} options
 * @param {Function} options.listDefinitions `() → Object[]`, the registry's definitions.
 * @param {Function} options.resolveCredential `(agentId) → String|null`, the seat's PAT.
 * @param {Function} [options.createQuery] `(token) → query`; the GitHub call by default.
 * @returns {Function} `(wake) → Promise<String[]|null>`; null for a seat without a readable PAT.
 * @private
 */
function failedChecksReader({listDefinitions, resolveCredential, createQuery}) {
    const readers = seatReaders({listDefinitions, resolveCredential, ...(createQuery ? {createQuery} : {})});

    return async ({to, repo, head}) => {
        const
            query         = (await readers()).find(reader => reader.seat === to)?.query,
            [owner, name] = repo.split('/');

        return query ? failedChecksOf(await query(OPEN_WORK_FAILED_CHECKS, {owner, name, oid: head})) : null
    }
}

/**
 * @summary The round's route map from the Fleet's verbose presence answer: each seat whose wake reads `undeliverable`,
 * with the receiver's last reason. The verbose answer carries the wake state per row, never the terse report's
 * top-level map. Null when no row holds a readable wake state, so unreadable records read unknown, never reachable.
 * @param {Object|null} presence A verbose `who_is_online` payload: `{agents: [{identity, wake: {state, reason}}]}`.
 * @returns {Object<String,String|null>|null}
 */
export function undeliverableOf(presence) {
    const rows = Array.isArray(presence?.agents) ? presence.agents : [];

    if (!rows.some(row => typeof row?.wake?.state === 'string' && row.wake.state !== 'unknown')) return null;

    return Object.fromEntries(rows
        .filter(row => typeof row?.identity === 'string' && row.wake?.state === 'undeliverable')
        .map(row => [row.identity, typeof row.wake.reason === 'string' ? row.wake.reason : null]))
}

/**
 * @summary Bind the existing producer callback to a ledger beside its state file; never start a poller.
 * @param {Object} options
 * @param {{getDataDir: Function, listAgents: Function, resolveCredential: Function}} options.registry Fleet-owned
 *     durable root, and the seats whose PATs read a `repair-ci` wake's failing checks.
 * @param {Function} options.admitWake The already verified plane's open-work intake.
 * @param {Function} [options.readPresence] The Fleet's shared verbose presence read; one answer per route refresh
 *     gives the route map and the plan resets.
 * @param {Function} [options.readDelivery] The same verified plane's delivery read of admitted wakes, by message id.
 * @param {Function} [options.now]
 * @param {Function} [options.gateOf] Test seam only.
 * @param {Function} [options.isEnabled] Live entrypoint enablement, checked at effect boundaries.
 * @param {Array<String|Object>|Function} [options.rotationSeats]
 * @param {Function} [options.createQuery] `(token) → query`; replaces the GitHub call (tests).
 * @param {Object} [options.log]
 * @returns {Function|null} onPulse with stop(), or null without the required registry/intake.
 */
export function wireFleetOpenWorkWakes({registry, admitWake, readPresence, readDelivery, now, gateOf, isEnabled, rotationSeats, createQuery, log} = {}) {
    if (typeof registry?.getDataDir !== 'function' || typeof admitWake !== 'function') return null;
    let presence = null;
    // The refresh asks both readers at once, so one answer serves both; the next refresh reads fresh
    const answer = () => presence ??= Promise.resolve().then(readPresence).finally(() => setTimeout(() => { presence = null }, 0));
    return createOpenWorkWakeRound({
        store           : fileStore(path.join(registry.getDataDir(), 'open-work-wakes.json')),
        readFailedChecks: failedChecksReader({
            listDefinitions  : () => registry.listAgents?.() ?? [],
            resolveCredential: id => registry.resolveCredential?.(id) ?? null,
            createQuery
        }),
        ...(typeof readPresence === 'function' ? {
            readUndeliverable: async () => undeliverableOf(await answer()),
            readExhausted    : async () => exhaustedUntilOf(await answer(), (now ?? Date.now)())
        } : {}),
        admitWake, readDelivery, now, gateOf, isEnabled, rotationSeats, log
    })
}

export default wireFleetOpenWorkWakes;

/**
 * @module ai/services/fleet/openWorkWakes
 * @summary Pure holder-action planning over the existing producer state. The caller persists the
 * returned ledger before attempting a send; "admitted" means that attempt was reserved, never delivered.
 *
 * Open episodes bind the full head, native seat and action kind. An author on another head owes a
 * different action even if the kind is unchanged. Incomplete or stale evidence preserves the prior
 * holding; it cannot invent a departure and then a second arrival. First and quiet observations
 * baseline without a backlog burst; an unread row defers that baseline once, bound to its full head.
 * The external gate decides quiet; this module neither polls nor sends.
 *
 * A skipped merge keeps its original observation and payload until its route answers, even after the
 * transition leaves the producer's bounded history. Admitted merges need no permanent seen set: the
 * saved pulse excludes their original observations on the next round.
 */
import {openWorkFreshness} from './fleetOpenWorkSource.mjs';
import {holderOf}          from './openWorkHolder.mjs';

const REASONS = Object.freeze({
    'repair-ci'      : 'CI is red on your head',
    'address-changes': 'changes are requested on your head',
    rebase           : 'your approved head has conflicts to rebase',
    review           : 'your review is due on the current head',
    'route-review'   : 'CI is green; request a reviewer for your head',
    'post-merge'     : 'your pull request was merged'
});

/**
 * @summary A source identity that can bind a wake, without shortening its head.
 * @param {Object} row
 * @returns {Boolean}
 * @private
 */
function hasIdentity(row) {
    return typeof row?.repo === 'string' && row.repo.length > 0 &&
        Number.isInteger(row.number) && row.number > 0 &&
        row.key === `${row.repo}#${row.number}` && typeof row.head === 'string' && row.head.length > 0
}

/**
 * @summary One stable task identity and its action-specific payload.
 * @param {Object} row
 * @param {String} seat
 * @param {String} role
 * @param {String} kind
 * @param {String} episode The first observation of the open action, or the terminal observation id.
 * @returns {Object}
 * @private
 */
function wakeOf(row, seat, role, kind, episode) {
    return {
        key: JSON.stringify([row.repo, row.number, row.head, seat, kind, episode]),
        to : seat, pr: row.key, repo: row.repo, number: row.number, head: row.head,
        role, kind, episode, reason: REASONS[kind]
    }
}

/**
 * @summary Plan eligible attempts, retaining skipped routes and refusing incomplete open-row evidence.
 * @param {Object} options
 * @param {Object} options.state The producer state, including snapshot, observation and transitions.
 * @param {Object|null} options.ledger Previous {pulse, holding, pendingMerges, baselines}; null starts a quiet baseline.
 * @param {Number} options.now Epoch milliseconds.
 * @param {Function} [options.routeOf] Native seat to reachable, unreachable or unknown; only unreachable skips.
 * @param {Boolean} [options.quiet=false] Baseline the observed actions without admitting sends.
 * @returns {{wakes: Object[], ledger: Object|null}} Inputs are never mutated.
 */
export function planOpenWorkWakes({state, ledger, now, routeOf = () => 'unknown', quiet = false}) {
    const
        wakes   = [],
        holding = Object.fromEntries(Object.entries(ledger?.holding ?? {}).map(([key, entry]) =>
            [key, quiet && entry.status === 'pending' ? {...entry, status: 'baseline'} : entry])),
        pendingMerges = quiet ? {} : {...(ledger?.pendingMerges ?? {})},
        baselines     = {...(ledger?.baselines ?? {})},
        previousPulse = ledger?.pulse ? Date.parse(ledger.pulse) : -Infinity,
        pulse         = Date.parse(state?.observedAt),
        baseline      = !ledger || quiet;

    if (!state?.snapshot?.rows || !['complete', 'partial'].includes(state.coverage) ||
        openWorkFreshness(state.observedAt, {now}) !== 'ok' || pulse < previousPulse) {
        return {wakes, ledger: ledger ?? null}
    }

    const
        decided = new Set(),
        current = new Set(),
        ended   = new Set(),
        native  = seat => typeof seat === 'string' && seat.startsWith('@') && seat.length > 1;

    for (const row of Object.values(state.snapshot.rows)) {
        if (!hasIdentity(row)) continue;

        if (row.partial !== false || openWorkFreshness(row.observedAt, {now}) !== 'ok' ||
            !Array.isArray(row.requested) || !Array.isArray(row.reviews) || !Array.isArray(row.opinions)) {
            if (baseline) baselines[row.key] = row.head;
            continue
        }

        const holder = holderOf(row);

        if (holder.role === 'unknown') {
            if (baseline) baselines[row.key] = row.head;
            continue
        }

        const rowBaseline = baseline || baselines[row.key] === row.head;

        delete baselines[row.key];
        decided.add(row.key);

        const seats = holder.role === 'reviewer' ||
            holder.role === 'author' && row.owner?.kind === 'seat'
            ? holder.ids.filter(native) : [];

        for (const seat of seats) {
            if (!REASONS[holder.kind]) continue;

            const
                slot  = JSON.stringify([row.repo, row.number, row.head, seat, holder.kind]),
                prior = holding[slot],
                entry = prior ?? {wake: wakeOf(row, seat, holder.role, holder.kind, state.observedAt), status: rowBaseline ? 'baseline' : 'pending'};

            current.add(slot);
            holding[slot] = entry;

            if (!rowBaseline && entry.status === 'pending' && routeOf(seat) !== 'unreachable') {
                holding[slot] = {...entry, status: 'admitted'};
                wakes.push(entry.wake)
            }
        }
    }

    for (const transition of state.transitions ?? []) {
        const observed = Date.parse(transition.pulse);

        if (!Number.isFinite(observed) || observed <= previousPulse || observed > pulse ||
            !hasIdentity(transition) || !['merged', 'closed'].includes(transition.kind)) continue;

        const open = state.snapshot.rows[transition.key];

        // A retained close may precede the currently observed reopening.
        if (!open || Date.parse(open.observedAt) <= observed) ended.add(transition.key);

        if (baseline || transition.kind !== 'merged' || transition.owner?.kind !== 'seat' ||
            !native(transition.owner.seat) || typeof transition.id !== 'string' || !transition.id) continue;

        pendingMerges[transition.id] ??= wakeOf(transition, transition.owner.seat, 'author', 'post-merge', transition.id)
    }

    for (const [slot, entry] of Object.entries(holding)) {
        const pr = entry.wake.pr;

        if (ended.has(pr) || decided.has(pr) && !current.has(slot) ||
            !Object.hasOwn(state.snapshot.rows, pr) && (state.coverage === 'complete' || state.snapshot.closed?.[pr])) {
            delete holding[slot]
        }
    }

    for (const pr of Object.keys(baselines)) {
        if (ended.has(pr) || !Object.hasOwn(state.snapshot.rows, pr) &&
            (state.coverage === 'complete' || state.snapshot.closed?.[pr])) delete baselines[pr]
    }

    if (!baseline) {
        for (const [id, wake] of Object.entries(pendingMerges)) {
            if (routeOf(wake.to) === 'unreachable') continue;

            wakes.push(wake);
            delete pendingMerges[id]
        }
    }

    return {wakes, ledger: {pulse: state.observedAt, holding, pendingMerges, baselines}}
}

const
    QUOTA_HOUR_MS = 60 * 60 * 1000,
    OBSERVE_MS    = 24 * QUOTA_HOUR_MS,
    QUOTA_SHARE   = 0.2;

/**
 * @summary Validate a retained seat receipt, then require its owed reads when it is in the observed day.
 * @param {Object} seat
 * @param {Boolean} owesWindow
 * @returns {String|null} A refusal, or null.
 * @private
 */
function seatReceiptFailure(seat, owesWindow) {
    const
        count = value => Number.isInteger(value) && value >= 0,
        read  = value => value === null || value && typeof value.complete === 'boolean' && count(value.rows);

    if (!seat || typeof seat.seat !== 'string' || !/^@[a-z\d][a-z\d-]*$/i.test(seat.seat) ||
        typeof seat.benched !== 'boolean' || !['complete', 'partial', 'failed', 'credential-unread'].includes(seat.outcome) ||
        !read(seat.authored) || !read(seat.held) || !read(seat.terminal) ||
        seat.terminal !== null && typeof seat.terminal.required !== 'boolean') {
        return 'a pulse has malformed seat coverage'
    }

    if (owesWindow && !seat.benched && (seat.outcome !== 'complete' ||
        seat.authored?.complete !== true || seat.held?.complete !== true ||
        !seat.terminal || seat.terminal.required && !seat.terminal.complete)) {
        return 'a participating seat has an incomplete or unsuccessful owed read'
    }

    return null
}

/**
 * @summary Read one fully attributed quota receipt. Remaining is diagnostic; missing cost is not zero.
 * @param {Object} quota
 * @param {Number} started
 * @param {Number} finished
 * @returns {Object|null} The validated quota window, or null.
 * @private
 */
function quotaReceipt(quota, started, finished) {
    const
        natural = value => Number.isInteger(value) && value >= 0,
        first   = Date.parse(quota?.firstAt),
        last    = Date.parse(quota?.lastAt),
        reset   = Date.parse(quota?.resetAt);
    let apiBase;

    try {
        if (typeof quota?.apiBase !== 'string') return null;
        const url = new URL(quota.apiBase);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
        apiBase = url.href.replace(/\/+$/, '')
    } catch {
        return null
    }

    if (typeof quota.viewerId !== 'string' || !quota.viewerId || /\s/.test(quota.viewerId) ||
        !natural(quota.limit) || quota.limit === 0 || !natural(quota.cost) ||
        !natural(quota.calls) || quota.calls === 0 || !natural(quota.failed) || quota.failed > quota.calls ||
        quota.unknown !== false || typeof quota.firstAt !== 'string' || typeof quota.lastAt !== 'string' ||
        typeof quota.resetAt !== 'string' || !Number.isFinite(first) || !Number.isFinite(last) || !Number.isFinite(reset) ||
        first < started || last > finished || last < first ||
        quota.remaining != null && (!natural(quota.remaining) || quota.remaining > quota.limit)) return null;

    return {
        key  : JSON.stringify([apiBase, quota.viewerId, reset]),
        start: reset - QUOTA_HOUR_MS, reset, last, limit: quota.limit, cost: quota.cost, calls: quota.calls
    }
}

/**
 * @summary Certify the measured observation day and each issuer's complete intersecting quota windows.
 * A sample count never stands in for elapsed time. Prefix costs before the day's cutoff still belong
 * to an intersecting quota window, so its coverage must begin at or before that window's start.
 * A delayed receipt in the day also selects its returned issuer window, even if that window has ended.
 * Older pre-telemetry pulses are not evidence; a fresh version-one tail must establish the whole day.
 * @param {Object} state The producer state with ordered version-one pulse receipts.
 * @param {Object} options
 * @param {Number} options.now Epoch milliseconds.
 * @returns {{holds: Boolean, reason: String|null}} This gate evaluates evidence only; it never enables wakes.
 */
export function wakeGateOf(state, {now}) {
    const refuse = reason => ({holds: false, reason});

    if (!Number.isFinite(now) || !state || !['complete', 'partial'].includes(state.coverage) ||
        openWorkFreshness(state.observedAt, {now}) !== 'ok') return refuse('the producer observation is not fresh');

    if (!Array.isArray(state.pulses) || !state.pulses.length) return refuse('no version-one observation history');

    const
        pulses = state.pulses.slice(state.pulses.findLastIndex(pulse => pulse?.telemetryVersion !== 1) + 1),
        end    = Date.parse(state.observedAt),
        start  = end - OBSERVE_MS,
        times  = pulses.map(pulse => Date.parse(pulse.at));

    if (!pulses.length || times.at(-1) !== end) return refuse('the latest telemetry does not represent the producer observation');
    if (!Number.isFinite(times[0]) || times[0] > start) return refuse('less than 24 elapsed hours of version-one observations');

    const quotas = new Map();
    let   anchor = start;

    for (let index = 0; index < pulses.length; index++) {
        const
            pulse    = pulses[index],
            observed = times[index],
            finished = Date.parse(pulse.finishedAt);

        if (typeof pulse.at !== 'string' || typeof pulse.finishedAt !== 'string' ||
            !Number.isFinite(observed) || !Number.isFinite(finished) || observed > finished || finished > now ||
            index > 0 && (observed <= times[index - 1] || observed < Date.parse(pulses[index - 1].finishedAt)) ||
            !Number.isFinite(pulse.intervalMs) || pulse.intervalMs <= 0 ||
            !Array.isArray(pulse.quota) || !Array.isArray(pulse.seats) ||
            pulse.costUnknown != null && typeof pulse.costUnknown !== 'boolean') return refuse('malformed or unordered pulse telemetry');

        if (pulse.costUnknown === true) return refuse('a pulse has unattributed or unknown query cost');

        const seen         = new Set();
        let   minimumCalls = 0, calls = 0;

        for (const seat of pulse.seats) {
            const error = seatReceiptFailure(seat, observed >= start);
            if (error) return refuse(error);
            if (seen.has(seat.seat)) return refuse('a pulse repeats a seat coverage identity');
            seen.add(seat.seat);
            minimumCalls += Math.max(
                Number(seat.authored !== null) + Number(seat.held !== null) + Number(seat.terminal?.required === true),
                Number(seat.outcome === 'failed')
            )
        }

        for (const receipt of pulse.quota) {
            const quota = quotaReceipt(receipt, observed, finished);
            if (!quota) return refuse('a query has missing, malformed or unknown quota evidence');
            calls += quota.calls;

            const bucket = quotas.get(quota.key);
            if (bucket && bucket.limit !== quota.limit) return refuse('one issuer quota window reports conflicting measured limits');
            quotas.set(quota.key, {
                start   : quota.start, limit: quota.limit, cost: (bucket?.cost ?? 0) + quota.cost,
                selected: bucket?.selected || quota.last >= start || quota.reset > start && quota.start <= end
            })
        }

        if (calls < minimumCalls) return refuse('seat reads have no complete attributed query-cost receipts')
    }

    const charged = [...quotas.values()].filter(bucket => bucket.selected);
    for (const bucket of charged) anchor = Math.min(anchor, bucket.start);

    const latestSeats = new Set(pulses.at(-1).seats.map(seat => seat.seat));
    if (!state.readers || typeof state.readers !== 'object' || Array.isArray(state.readers) ||
        Object.keys(state.readers).some(login => !latestSeats.has(`@${login}`))) {
        return refuse('the latest pulse does not cover the current producer readers')
    }

    const first = times.findLastIndex(time => time <= anchor);
    if (first < 0) return refuse(`the issuer quota window prefix is not retained: required start ${new Date(anchor).toISOString()} precedes ${pulses[0].at}`);

    for (let index = first + 1; index < times.length; index++) {
        if (openWorkFreshness(pulses[index - 1].at, {now: times[index]}) !== 'ok') {
            return refuse('the observation window contains a gap beyond the shared freshness bound')
        }
    }

    if (openWorkFreshness(pulses.at(-1).finishedAt, {now}) !== 'ok') return refuse('the retained observation window is no longer fresh');

    for (const {cost, limit} of charged) {
        if (cost > QUOTA_SHARE * limit) return refuse('an issuer exceeded 20% of its measured hourly GraphQL limit')
    }

    return {holds: true, reason: null}
}

export default planOpenWorkWakes;

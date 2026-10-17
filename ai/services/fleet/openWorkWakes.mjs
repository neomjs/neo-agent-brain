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
import {createHash}            from 'node:crypto';
import {openWorkFreshness}     from './fleetOpenWorkSource.mjs';
import {holderOf}              from './openWorkHolder.mjs';
import {OPEN_WORK_QUERY_COSTS} from '../github-workflow/queries/openWorkQueries.mjs';

const REASONS = Object.freeze({
    'repair-ci'       : 'CI is red on your head',
    'address-changes' : 'changes are requested on your head',
    rebase            : 'your approved head has conflicts to rebase',
    review            : 'your review is due on the current head',
    'route-review'    : 'CI is green; request a reviewer for your head',
    'triage-outside'  : 'an untouched outside contributor pull request has finished CI',
    'approve-runs'    : 'an outside contributor pull request has workflow runs awaiting approval',
    'post-merge'      : 'your pull request was merged'
});

/**
 * @summary Human-readable reason for a wake action kind.
 * @param {String} kind
 * @returns {String|null}
 */
export const reasonOf = kind => REASONS[kind] ?? null;

/**
 * @summary Deterministic rotation seat selection from the participating roster, advancing to the first reachable seat.
 * @param {Object} row
 * @param {String} kind
 * @param {String[]} roster
 * @param {Function} routeOf
 * @returns {String|null}
 * @private
 */
function pickRotationSeat(row, kind, roster, routeOf) {
    if (!roster.length) return null;
    const
        digest = createHash('sha256').update(JSON.stringify([row.repo, row.number, row.head, kind])).digest(),
        offset = digest.readUInt32BE(0) % roster.length;

    for (let index = 0; index < roster.length; index++) {
        const seat = roster[(offset + index) % roster.length];
        if (routeOf(seat) !== 'unreachable') return seat
    }

    return null
}

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
 * @param {Array<String|Object>} [options.rotationSeats] Participating native seats (or pulse seat records) for rotation actions.
 * @param {Boolean} [options.quiet=false] Baseline the observed actions without admitting sends.
 * @returns {{wakes: Object[], ledger: Object|null}} Inputs are never mutated.
 */
export function planOpenWorkWakes({state, ledger, now, routeOf = () => 'unknown', rotationSeats, quiet = false}) {
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
        native  = seat => typeof seat === 'string' && seat.startsWith('@') && seat.length > 1,
        roster  = [...new Set((Array.isArray(rotationSeats) ? rotationSeats : state?.pulses?.at(-1)?.seats ?? [])
            .filter(item => typeof item === 'string' ? native(item) : !item?.benched && native(item?.seat))
            .map(item => typeof item === 'string' ? item : item.seat))];

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

        if (holder.role === 'rotation' && REASONS[holder.kind]) {
            const
                slot    = JSON.stringify([row.repo, row.number, row.head, 'rotation', holder.kind]),
                prior   = holding[slot],
                episode = prior?.wake?.episode ?? state.observedAt;

            current.add(slot);
            if (prior?.status === 'admitted' || prior?.status === 'baseline') {
                holding[slot] = prior;
                continue
            }
            if (rowBaseline) {
                const seat = pickRotationSeat(row, holder.kind, roster, () => 'unknown') ?? prior?.wake?.to ?? roster[0] ?? '@rotation';
                holding[slot] = {wake: wakeOf(row, seat, 'rotation', holder.kind, episode), status: 'baseline'};
                continue
            }
            const seat = pickRotationSeat(row, holder.kind, roster, routeOf);
            if (seat) {
                const wake = wakeOf(row, seat, 'rotation', holder.kind, episode);
                holding[slot] = {wake, status: 'admitted'};
                wakes.push(wake)
            } else {
                const fallback = prior?.wake?.to ?? roster[0] ?? '@rotation';
                holding[slot] = {wake: wakeOf(row, fallback, 'rotation', holder.kind, episode), status: 'pending'}
            }
            continue
        }

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
 * @summary Validate every retained seat receipt, requiring successful reads for current participating seats.
 * @param {Object} seat
 * @param {Boolean} latest Whether this receipt names the current roster and its latest read capability.
 * @returns {String|null} A refusal, or null.
 * @private
 */
function seatReceiptFailure(seat, latest) {
    const
        count = value => Number.isInteger(value) && value >= 0,
        read  = value => value === null || value && typeof value.complete === 'boolean' && count(value.rows);

    if (!seat || typeof seat.seat !== 'string' || !/^@[a-z\d][a-z\d-]*$/i.test(seat.seat) ||
        typeof seat.benched !== 'boolean' || !['complete', 'partial', 'failed', 'credential-unread'].includes(seat.outcome) ||
        !read(seat.authored) || !read(seat.held) || !read(seat.terminal) ||
        seat.terminal !== null && typeof seat.terminal.required !== 'boolean') {
        return 'a pulse has malformed seat coverage'
    }

    if (latest && !seat.benched && (seat.outcome !== 'complete' ||
        seat.authored?.complete !== true || seat.held?.complete !== true ||
        !seat.terminal || seat.terminal.required && !seat.terminal.complete)) {
        return 'a participating seat has an incomplete or unsuccessful owed read'
    }

    return null
}

/**
 * @summary Validate one compact query receipt without inventing an issuer, reset window or missing cost.
 * @param {Object} quota
 * @param {Number} started
 * @param {Number} finished
 * @param {Number} pulseIndex Order within the retained observation history.
 * @returns {Object|null} The validated quota window, or null.
 * @private
 */
function quotaReceipt(quota, started, finished, pulseIndex) {
    const
        natural    = value => Number.isSafeInteger(value) && value >= 0,
        first      = Date.parse(quota?.firstAt),
        last       = Date.parse(quota?.lastAt),
        attempt    = Date.parse(quota?.firstAttemptAt ?? quota?.firstAt),
        reset      = quota?.resetAt === null ? null : Date.parse(quota?.resetAt),
        legacy     = quota?.reported === undefined,
        reported   = legacy || quota.reported,
        attributed = typeof quota?.viewerId === 'string' && !!quota.viewerId &&
            !/\s/.test(quota.viewerId) && Number.isFinite(reset) && natural(quota.limit) && quota.limit > 0,
        zeroCostFailedCalls = quota?.zeroCostFailedCalls ?? (quota?.cost === 0 ? quota.failed : 0);
    let apiBase;

    try {
        if (typeof quota?.apiBase !== 'string') return null;
        const url = new URL(quota.apiBase);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
        apiBase = url.href.replace(/\/+$/, '')
    } catch {
        return null
    }

    if (!natural(quota.cost) || typeof quota.unknown !== 'boolean' ||
        !natural(quota.calls) || quota.calls === 0 || !natural(quota.failed) || quota.failed > quota.calls ||
        typeof quota.firstAt !== 'string' || typeof quota.lastAt !== 'string' ||
        !Number.isFinite(first) || !Number.isFinite(last) || !Number.isFinite(attempt) ||
        attempt < started || first < attempt || last > finished || last < first ||
        quota.resetAt !== null && (typeof quota.resetAt !== 'string' || !Number.isFinite(reset)) ||
        quota.viewerId !== null && (typeof quota.viewerId !== 'string' || !quota.viewerId || /\s/.test(quota.viewerId)) ||
        quota.limit !== null && (!natural(quota.limit) || quota.limit === 0) ||
        quota.remaining != null && (!natural(quota.remaining) || attributed && quota.remaining > quota.limit) ||
        !natural(zeroCostFailedCalls) || zeroCostFailedCalls > quota.failed) return null;

    if (legacy) {
        if (!attributed || quota.unknown !== false) return null;
    } else if (typeof quota.reported !== 'boolean' || !/^[a-f\d]{64}$/.test(quota.queryHash ?? '') ||
        !natural(quota.firstOrdinal) || quota.firstOrdinal < 1 || !natural(quota.lastOrdinal) ||
        quota.lastOrdinal < quota.firstOrdinal || quota.lastOrdinal - quota.firstOrdinal + 1 < quota.calls ||
        ![0, quota.calls].includes(quota.failed) || quota.unknown !== (!attributed || !reported) ||
        reported && (!natural(quota.maxMeasuredCost) || quota.maxMeasuredCost > quota.cost || quota.maxMeasuredCost * quota.calls < quota.cost) ||
        !reported && (quota.cost !== 0 || quota.maxMeasuredCost !== null || quota.failed !== quota.calls || zeroCostFailedCalls !== 0)) return null;

    if (!attributed && quota.failed !== quota.calls) return null;

    return {
        apiBase, viewerId: quota.viewerId, attributed, reported, queryHash: quota.queryHash ?? null,
        key            : attributed ? JSON.stringify([apiBase, quota.viewerId, reset]) : null,
        start          : reset === null ? null : reset - QUOTA_HOUR_MS, reset, first: attempt, last,
        limit          : quota.limit, cost: quota.cost, calls: quota.calls, failed: quota.failed, zeroCostFailedCalls,
        maxMeasuredCost: legacy ? null : quota.maxMeasuredCost,
        order          : [pulseIndex, legacy ? null : quota.lastOrdinal],
        userTotal      : !legacy && attributed && reported && !quota.failed && quota.remaining != null
            ? {at: quota.lastAt, used: quota.limit - quota.remaining, remaining: quota.remaining, order: [pulseIndex, quota.lastOrdinal]} : null
    }
}

/** @summary Preserve uncertain within-pulse order for legacy aggregates; never let an older total cover a later call. */
function latestOrder(left, right) {
    if (!left || right[0] > left[0]) return right;
    if (right[0] < left[0]) return left;
    return [left[0], left[1] === null || right[1] === null ? null : Math.max(left[1], right[1])]
}

/** @summary A successful response covers its own call and every earlier ordered observer attempt. */
function coversOrder(success, latest) {
    return success[0] > latest[0] || success[0] === latest[0] && success[1] !== null && latest[1] !== null && success[1] >= latest[1]
}

/**
 * @summary Certify one operational-estimate window, retaining measured, estimated and unattributed charges separately.
 * A sample count never stands in for elapsed time. Prefix costs before the day's cutoff still belong
 * to an intersecting quota window, so its coverage must begin at or before that window's start.
 * A delayed receipt in the day also selects its returned issuer window, even if that window has ended.
 * Older pre-telemetry pulses are not evidence; a fresh version-one tail must establish the whole day.
 * Gaps owe no reads. The latest complete read proves each current participating seat's capability
 * within that window; earlier unsuccessful reads do not erase it, but all recorded costs still count.
 * @param {Object} state The producer state with ordered version-one pulse receipts.
 * @param {Object} options
 * @param {Number} options.now Epoch milliseconds.
 * @returns {{holds: Boolean, reason: String|null, certification?: Object}} A policy receipt, never a mathematical failed-cost bound or live enablement.
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

    const quotas = new Map(), attempts = [], estimates = new Map();
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

        if (pulse.outside != null && (typeof pulse.outside !== 'object' || Array.isArray(pulse.outside) ||
            typeof pulse.outside.complete !== 'boolean' || !Number.isInteger(pulse.outside.rows) || pulse.outside.rows < 0)) {
            return refuse('a pulse has malformed seat coverage')
        }
        if (index === pulses.length - 1 && (!pulse.outside || pulse.outside.complete !== true)) {
            return refuse('the outside pull-request read is missing or incomplete')
        }

        const seen         = new Set();
        let   minimumCalls = 0, calls = 0, unpricedCalls = 0;

        for (const seat of pulse.seats) {
            const error = seatReceiptFailure(seat, index === pulses.length - 1);
            if (error) return refuse(error);
            if (seen.has(seat.seat)) return refuse('a pulse repeats a seat coverage identity');
            seen.add(seat.seat);
            minimumCalls += Math.max(
                Number(seat.authored !== null) + Number(seat.held !== null) +
                    Number(seat.terminal?.required === true && (seat.terminal.complete || seat.terminal.rows > 0)),
                Number(seat.outcome === 'failed')
            )
        }

        for (const receipt of pulse.quota) {
            const quota = quotaReceipt(receipt, observed, finished, index);
            if (!quota) return refuse('a query has missing, malformed or unknown quota evidence');
            calls += quota.calls;
            unpricedCalls += quota.reported ? 0 : quota.calls;
            attempts.push(quota);

            const metadata = OPEN_WORK_QUERY_COSTS.find(item => item.queryHash === quota.queryHash);
            if (metadata) {
                const key    = JSON.stringify([quota.apiBase, quota.queryHash]),
                    estimate = estimates.get(key) ?? {apiBase: quota.apiBase, ...metadata, maxMeasuredCost: null, reservePerCall: metadata.formulaCost};
                if (quota.reported && quota.maxMeasuredCost !== null) estimate.maxMeasuredCost = Math.max(estimate.maxMeasuredCost ?? 0, quota.maxMeasuredCost);
                estimate.reservePerCall = Math.max(1, estimate.formulaCost, estimate.maxMeasuredCost ?? 0);
                estimates.set(key, estimate)
            }

            if (!quota.attributed) continue;

            const bucket = quotas.get(quota.key);
            if (bucket && bucket.limit !== quota.limit) return refuse('one issuer quota window reports conflicting measured limits');
            const next = bucket ?? {apiBase: quota.apiBase, viewerId: quota.viewerId, reset: quota.reset,
                start         : quota.start, limit: quota.limit, measured: 0, estimated: 0, unattributed: 0,
                estimatedCalls: 0, unattributedCalls: 0, selected: false, latest: null, userTotal: null};
            next.measured += quota.reported ? quota.cost : 0;
            next.latest = latestOrder(next.latest, quota.order);
            next.selected ||= quota.last >= start || quota.reset > start && quota.start <= end;
            if (quota.userTotal && (!next.userTotal || coversOrder(quota.userTotal.order, next.userTotal.order))) next.userTotal = quota.userTotal;
            quotas.set(quota.key, next)
        }

        if (pulse.costUnknown != null && pulse.costUnknown !== (unpricedCalls > 0)) return refuse('a pulse has unknown query cost without classified attempts');
        if (calls < minimumCalls) return refuse('seat reads have no complete attributed query-cost receipts')
    }

    for (const attempt of attempts) {
        const estimate = estimates.get(JSON.stringify([attempt.apiBase, attempt.queryHash]));
        if (attempt.attributed) {
            const count = attempt.reported ? attempt.zeroCostFailedCalls : attempt.calls;
            if (!count) continue;
            if (!estimate) return refuse('pending: a failed query has no declared operational estimate');
            const bucket = quotas.get(attempt.key);
            bucket.estimated += count * estimate.reservePerCall;
            bucket.estimatedCalls += count;
        } else {
            const matches = [...quotas.values()].filter(bucket => bucket.apiBase === attempt.apiBase &&
                bucket.start <= attempt.last && bucket.reset > attempt.first && (bucket.selected || attempt.last >= start));
            if (!matches.length && attempt.last < start) continue;
            if (!estimate || !matches.length) return refuse('pending: unattributed attempts have no known endpoint window or query estimate');
            // A compact range may straddle a reset; charge its whole reserve to every intersecting window.
            const reserve = Math.max(attempt.cost, attempt.calls * estimate.reservePerCall);
            for (const bucket of matches) {
                bucket.unattributed += reserve;
                bucket.unattributedCalls += attempt.calls;
                bucket.latest = latestOrder(bucket.latest, attempt.order);
                bucket.selected = true;
            }
        }
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

    if (openWorkFreshness(pulses.at(-1).finishedAt, {now}) !== 'ok') return refuse('the retained observation window is no longer fresh');

    const certified = [];
    for (const bucket of charged) {
        const total         = bucket.measured + bucket.estimated + bucket.unattributed,
            observedTotal   = bucket.userTotal && coversOrder(bucket.userTotal.order, bucket.latest) ? bucket.userTotal : null,
            withinUserTotal = observedTotal && observedTotal.used <= QUOTA_SHARE * bucket.limit;
        if (!withinUserTotal && total > QUOTA_SHARE * bucket.limit) return refuse('an issuer exceeded 20% under the declared operational-estimate policy');
        certified.push({apiBase: bucket.apiBase, viewerId: bucket.viewerId, resetAt: new Date(bucket.reset).toISOString(), limit: bucket.limit,
            measured      : bucket.measured, estimated: bucket.estimated, unattributed: bucket.unattributed,
            estimatedCalls: bucket.estimatedCalls, unattributedCalls: bucket.unattributedCalls,
            decision      : withinUserTotal ? 'reported-user-total' : 'operational-estimate',
            userTotal     : observedTotal ? {at: observedTotal.at, used: observedTotal.used, remaining: observedTotal.remaining} : null})
    }

    return {holds: true, reason: null, certification: {
        version  : 1, policy: 'open-work-operational-estimate-v1',
        window   : {start: new Date(start).toISOString(), end: new Date(end).toISOString(), retainedFrom: pulses[0].at},
        estimates: [...estimates.values()], buckets: certified
    }}
}

export default planOpenWorkWakes;

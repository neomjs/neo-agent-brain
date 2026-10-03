/**
 * @module ai/services/fleet/openWorkWakes
 * @summary The wake path's pure half: from one open-work observation and the wakes already sent, the
 * seats that newly hold a pull request's next action, and what must be escalated instead of woken.
 * No fetch, no clock, no mailbox; the wiring owns the sending, this module owns who and when.
 *
 * **Episodes live in the ledger, not in the observation.** A seat is woken when it holds a PR's next
 * action ({@link module:ai/services/fleet/openWorkHolder}) and the ledger has no open entry for that
 * (PR, role, seat); the entry closes when the seat stops holding. So a head that goes red, green, then
 * red again wakes its author twice, a verdict changing under a red head wakes no one, and an identical
 * observation sends nothing. The entry is the dedupe: the caller persists the ledger BEFORE it sends,
 * so a crash between the two re-plans against the entry and never wakes twice. A wake can be lost to
 * that crash, never doubled, because a missed wake is caught by the next read and a doubled one costs a
 * turn.
 *
 * **No ledger means a baseline.** The first plan records who holds what and wakes no one, so turning
 * the path on never wakes every current holder at once. A quiet round does the same over an existing
 * ledger: it keeps the ledger current and wakes no one, so the round after it wakes only what changed.
 *
 * **Wakes switch on only inside the observed day's bounds** ({@link wakeGateOf}): a full retained day
 * of the producer's pulses, its complete pulses cheap, and no seat's pull requests changing faster
 * than an hourly bound. Outside them every round is quiet.
 *
 * **What is not a wake.** The operator's merge-ready rows are the awaiting-merge list's, not a pager.
 * The rotation resolves through `seatsForRepo`, a seat whose route is `unreachable` is skipped and
 * escalated, an org PR with no resolvable author is escalated as unowned, and a holder still holding
 * `silentAfterMs` after its wake is escalated as silent. Escalations are records: no lead is declared
 * anywhere yet, so nothing is woken for them.
 */
import {holderOf}     from './openWorkHolder.mjs';
import {PULSE_WINDOW} from './openWorkProducer.mjs';

/**
 * @summary How long a woken holder may keep holding before it is escalated as silent: the four-hour
 * primary-reviewer window the pull-request workflow already grants.
 * @type {Number}
 */
export const SILENT_AFTER_MS = 4 * 60 * 60 * 1000;

/**
 * @summary How long a merged or unowned record stays in the ledger, so the terminal read's catch-up
 * window cannot replay it.
 * @type {Number}
 */
export const RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @summary The switch-on bounds, from the first observe-only day (16 h, 920 pulses): a complete pulse
 * cost 2–3 points, and the busiest seat's pull requests changed 27 times in their busiest hour.
 * `pulses` is the producer's retained day; `costP95` and `seatHourly` leave room above what was seen.
 * @type {{pulses: Number, costP95: Number, seatHourly: Number}}
 */
export const SWITCH_ON_BOUNDS = Object.freeze({pulses: PULSE_WINDOW, costP95: 10, seatHourly: 60});

/**
 * @summary The words a wake carries for each way of holding a PR.
 * @type {Object}
 */
const REASONS = Object.freeze({
    red     : 'CI is red on your head',
    changes : 'changes are requested on your head',
    review  : 'your review is due on the current head',
    rotation: 'an outside contributor\'s pull request needs a maintainer',
    merged  : 'your pull request was merged'
});

/**
 * @summary The seats a holder names, as woken targets. A reviewer named as a login or a team has no
 * seat to wake, and the rotation resolves to one seat of the repository's maintainers, turning by PR.
 * @param {Object} row An open snapshot row.
 * @param {{role: String, ids: String[]}} holder
 * @param {Function} seatsForRepo `(repo) => String[]`, the seats that work on a repository.
 * @returns {String[]}
 * @private
 */
function seatsOf(row, holder, seatsForRepo) {
    if (holder.role === 'author' || holder.role === 'reviewer') {
        return holder.ids.filter(id => id.startsWith('@'))
    }

    if (holder.role === 'rotation') {
        const seats = [...new Set(seatsForRepo(row.repo) ?? [])].sort();

        return seats.length ? [seats[row.number % seats.length]] : []
    }

    return []
}

/**
 * @summary Why a seat holds a row, in the words its wake carries.
 * @param {Object} row
 * @param {String} role
 * @returns {String}
 * @private
 */
function reasonOf(row, role) {
    if (role === 'author') {
        return row.ci === 'red' ? REASONS.red : REASONS.changes
    }

    return role === 'reviewer' ? REASONS.review : REASONS.rotation
}

/**
 * @summary Whether wakes may switch on, judged over the producer's retained pulses. Until the day is
 * full there is nothing to judge, so a new install observes a day before it wakes anyone; a day with
 * no complete pulse is not evidence either way, so it holds nothing open.
 * @param {Object[]} pulses The producer's retained pulses (`{at, cost, coverage, transitions}`), oldest first.
 * @param {{pulses: Number, costP95: Number, seatHourly: Number}} [bounds=SWITCH_ON_BOUNDS]
 * @returns {{holds: Boolean, reason: String|null}}
 */
export function wakeGateOf(pulses = [], {pulses: day, costP95, seatHourly} = SWITCH_ON_BOUNDS) {
    if (pulses.length < day) {
        return {holds: false, reason: `${pulses.length} of the day's ${day} pulses observed`}
    }

    const
        costs  = pulses.filter(pulse => pulse.coverage === 'complete').map(pulse => pulse.cost).sort((a, b) => a - b),
        cost   = costs[Math.floor(0.95 * (costs.length - 1))],
        hourly = {};

    if (!costs.length) {
        return {holds: false, reason: 'no complete pulse in the day'}
    }

    if (cost > costP95) {
        return {holds: false, reason: `a complete pulse cost ${cost} points at the 95th percentile, above ${costP95}`}
    }

    for (const {at, transitions = {}} of pulses) {
        for (const [seat, count] of Object.entries(transitions)) {
            const key = `${seat} in the hour from ${at.slice(0, 13)}:00Z`;

            hourly[key] = (hourly[key] ?? 0) + count;

            if (hourly[key] > seatHourly) {
                return {holds: false, reason: `${hourly[key]} transitions for ${key}, above ${seatHourly}`}
            }
        }
    }

    return {holds: true, reason: null}
}

/**
 * @summary Plans one round of wakes. Pure: the caller persists the returned ledger, then sends the
 * returned wakes.
 * @param {Object}   options
 * @param {Object}   options.snapshot The producer's current snapshot (`{rows}`).
 * @param {Object[]} [options.transitions=[]] This pulse's transitions; a `merged` one wakes its author.
 * @param {Object|null} options.ledger The previous ledger, or `null` before the first plan.
 * @param {Number}   options.now Epoch milliseconds.
 * @param {Function} options.seatsForRepo `(repo) => String[]`.
 * @param {Function} [options.routeOf] `(seat) => 'reachable'|'unreachable'|'unknown'`; only `unreachable` skips.
 * @param {Number}   [options.silentAfterMs=SILENT_AFTER_MS]
 * @param {Boolean}  [options.quiet=false] Keep the ledger current and wake or escalate nothing.
 * @returns {{wakes: Object[], escalations: Object[], ledger: Object}}
 */
export function planOpenWorkWakes({snapshot, transitions = [], ledger, now, seatsForRepo, routeOf = () => 'unknown', silentAfterMs = SILENT_AFTER_MS, quiet = false}) {
    const
        baseline    = !ledger || quiet,
        holding     = {...(ledger?.holding ?? {})},
        records     = Object.fromEntries(Object.entries(ledger?.records ?? {}).filter(([, record]) => now - record.at < RECORD_RETENTION_MS)),
        wakes       = [],
        escalations = [],
        current     = new Set();

    for (const row of Object.values(snapshot?.rows ?? {})) {
        const holder = holderOf(row);

        if (row.owner?.kind === 'unowned' && !records[`unowned:${row.key}`]) {
            records[`unowned:${row.key}`] = {at: now};
            baseline || escalations.push({kind: 'unowned', pr: row.key, login: row.owner.login})
        }

        for (const seat of seatsOf(row, holder, seatsForRepo)) {
            const
                key   = `${row.key}:${holder.role}:${seat}`,
                entry = holding[key];

            current.add(key);

            if (baseline) {
                holding[key] = entry ?? {head: row.head, sentAt: null, at: now};
                continue
            }

            // an open episode is handled: woken, or holding since the baseline; only a skipped one retries
            if (entry && !entry.skipped) {
                if (entry.sentAt && !entry.escalatedAt && now - entry.sentAt >= silentAfterMs) {
                    holding[key] = {...entry, escalatedAt: now};
                    escalations.push({kind: 'silent-holder', pr: row.key, seat, role: holder.role, sentAt: entry.sentAt})
                }

                continue
            }

            if (routeOf(seat) === 'unreachable') {
                // re-checked every round: the seat is woken once its route answers again
                entry?.skipped || escalations.push({kind: 'dead-route', pr: row.key, seat, role: holder.role});
                holding[key] = {head: row.head, sentAt: null, skipped: 'unreachable', at: entry?.at ?? now};
                continue
            }

            holding[key] = {head: row.head, sentAt: now, at: now};
            wakes.push({key, to: seat, pr: row.key, repo: row.repo, number: row.number, head: row.head, role: holder.role, reason: reasonOf(row, holder.role)})
        }
    }

    // a seat that no longer holds closes its episode; holding again later is a new one
    Object.keys(holding).forEach(key => current.has(key) || delete holding[key]);

    for (const transition of transitions) {
        const seat = transition.owner?.kind === 'seat' ? transition.owner.seat : null;

        if (transition.kind !== 'merged' || !seat || records[`merged:${transition.key}`]) continue;

        records[`merged:${transition.key}`] = {at: now};

        if (!baseline && routeOf(seat) !== 'unreachable') {
            wakes.push({key: `${transition.key}:merged:${seat}`, to: seat, pr: transition.key, repo: transition.repo, number: transition.number, head: transition.head, role: 'author', reason: REASONS.merged})
        }
    }

    return {wakes, escalations, ledger: {holding, records}}
}

export default planOpenWorkWakes;

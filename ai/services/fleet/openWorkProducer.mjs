/**
 * @module ai/services/fleet/openWorkProducer
 * @summary The open-work producer: each pulse reads the open pull requests of the repositories the
 * Fleet's seats work on, and the ones closed in its catch-up window, reduces them against its last
 * snapshot ({@link module:ai/services/fleet/openWorkReducer}), and keeps a bounded window of the
 * transitions with each pulse's cost. It is observe-only: it holds no mailbox client and wakes no one.
 *
 * Pulses never overlap: a pulse asked for while one runs is that same pulse, so an older read never
 * lands over a newer one. Coverage is honest:
 * - a search answer without its page structure is a failed read, never an empty one;
 * - the open read restarts each pulse and is `partial` when its page budget runs out;
 * - the terminal read is a fixed window of close times that resumes its cursor across pulses and
 *   restarts, so a backlog larger than one budget reaches its tail, and the watermark moves only once
 *   the window completes. It moves to an overlap before the window's end, because GitHub's search
 *   index can lag a close past the pulse that should have read it. The close markers dedupe the re-reads;
 * - a PR that leaves complete reads with no terminal row is recorded as `vanished` on its pulse. The
 *   `closed:` qualifier cannot reach some PRs closed without merging;
 * - a failed read keeps the snapshot under `stale` (`unavailable` without one), under a constant
 *   reason and a `redactReadFailure` detail, and its pulse records what the answered requests cost.
 *
 * Saved state that exists but cannot be read leaves the producer `unavailable`, and nothing is saved
 * over it until it reads again.
 */

import {OPEN_WORK_SNAPSHOT, OPEN_WORK_TERMINAL}                  from '../github-workflow/queries/openWorkQueries.mjs';
import {normalizePullRequest, normalizeTerminal, reduceOpenWork} from './openWorkReducer.mjs';
import {redactReadFailure}                                       from './redactReadFailure.mjs';

const
    /** @summary Search pages per read and pulse. */
    PAGE_BUDGET       = 4,
    /** @summary Transitions retained; a reader behind them reads a coverage gap. */
    TRANSITION_WINDOW = 500,
    /** @summary A 25-hour quota prefix plus its predecessor at the standard one-minute cadence. */
    PULSE_WINDOW      = 1502,
    PULSE_HISTORY_MS  = 25 * 60 * 60 * 1000,
    /** @summary How far each terminal window reaches back past the previous one's end. */
    OVERLAP_MS        = 10 * 60 * 1000,
    /** @summary A producer that has never pulsed. */
    FRESH             = Object.freeze({
        snapshot: null, observedAt: null, coverage: 'unavailable', watermark: null, window: null, reason: null, detail: null, transitions: [], pulses: []
    });

/**
 * @summary GitHub's search date qualifiers take whole seconds.
 * @param {String} iso
 * @returns {String}
 * @private
 */
const searchTime = iso => iso.replace(/\.\d+Z$/, 'Z');

/**
 * @summary An ISO time moved by `ms`.
 * @param {String} iso
 * @param {Number} ms
 * @returns {String}
 * @private
 */
const shift = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();

/**
 * @summary Adds one attempted page to a compact issuer/window bucket; absent measurements stay unknown.
 * @param {Object} tally Pulse totals and compact quota buckets, updated in place.
 * @param {String|null} apiBase The issuing endpoint, never a credential.
 * @param {Object|null} data The answer's or failure's retained viewer and rate-limit fields.
 * @param {Boolean} failed Whether this attempt failed transport or page validation.
 * @param {String} at The response observation time in ISO format.
 * @returns {void}
 */
function recordQuota(tally, apiBase, data, failed, at) {
    const
        measured  = value => Number.isInteger(value) && value >= 0 ? value : null,
        rate      = data?.rateLimit,
        viewerId  = typeof data?.viewer?.id === 'string' && data.viewer.id.trim() ? data.viewer.id : null,
        cost      = measured(rate?.cost),
        limit     = measured(rate?.limit) || null,
        resetAt   = typeof rate?.resetAt === 'string' && Number.isFinite(Date.parse(rate.resetAt)) ? new Date(rate.resetAt).toISOString() : null,
        remaining = measured(rate?.remaining);
    let endpoint = null;

    try {
        const url = new URL(apiBase);
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) endpoint = url.href.replace(/\/$/, '');
    } catch {}

    let bucket = tally.quota.find(row => row.apiBase === endpoint && row.viewerId === viewerId && row.resetAt === resetAt && row.limit === limit);

    if (!bucket) {
        tally.quota.push(bucket = {apiBase: endpoint, viewerId, resetAt, limit, cost: 0, calls: 0, failed: 0, unknown: false, firstAt: at, lastAt: at, remaining});
    }
    bucket.calls++;
    bucket.failed += Number(failed);
    bucket.lastAt = at;
    bucket.remaining = remaining;
    bucket.unknown ||= !endpoint || !viewerId || !limit || !resetAt || cost === null;
    if (cost === null) {
        tally.costUnknown = true;
    } else {
        bucket.cost += cost;
        tally.cost += cost;
    }
}

/**
 * @summary Read one search across its pages, from a cursor, up to the budget. Each answered request
 * adds its cost and page to `tally` before the next is sent, so a failed read still counts them.
 * @param {Object}   options
 * @param {Function} options.query      `(text, variables) → data`.
 * @param {String}   options.text       The GraphQL query.
 * @param {String}   options.search     The search string.
 * @param {String|null} [options.cursor] Where a previous pulse stopped.
 * @param {Number}   options.pageBudget
 * @param {Object} options.tally Compact measured cost buckets and answered-page count.
 * @param {String|null} options.apiBase The issuing endpoint, never a credential.
 * @param {Function} options.stamp Response clock within this pulse.
 * @param {Object} options.progress Seat read completion and answered row count, including failure prefixes.
 * @returns {Promise<{nodes: Object[], complete: Boolean, cursor: String|null}>}
 * @throws {Error} When an answer lacks its search page structure.
 * @private
 */
async function readSearch({query, text, search, cursor = null, pageBudget, tally, apiBase, stamp, progress}) {
    const nodes = [];

    for (let pages = 0; pages < pageBudget; pages++) {
        let data, failed = true;
        try {
            data = await query(text, {query: search, cursor});
            tally.pages++;
            const page = data?.search;
            if (!Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean') throw new Error('the search answered without its page structure');
            nodes.push(...page.nodes.filter(node => node?.number != null));
            progress.rows = nodes.length;
            progress.complete = !page.pageInfo.hasNextPage;
            failed = false;
            if (!page.pageInfo.hasNextPage) return {nodes, complete: true, cursor: null};
            cursor = page.pageInfo.endCursor;
        } catch (error) {
            data ??= error?.quota;
            throw error;
        } finally {
            recordQuota(tally, apiBase, data, failed, stamp());
        }
    }

    return {nodes, complete: false, cursor}
}

/**
 * @summary Transitions per owning seat; an unowned or outside PR counts under its kind.
 * @param {Object[]} transitions
 * @returns {Object}
 * @private
 */
function countBySeat(transitions) {
    return transitions.reduce((counts, {owner}) => {
        const key = owner?.seat ?? owner?.kind ?? 'outside';

        counts[key] = (counts[key] ?? 0) + 1;
        return counts
    }, {})
}

/**
 * @summary The coverage reason for the seats a pulse could not read, each with its next step. Only a
 * refused PAT (HTTP 401) asks for a new token; any other failure may pass on its own, so its next step
 * is the next pulse.
 * @param {String[]} unread Seats without a readable PAT.
 * @param {Object[]} [failed] `{seat, refused}` per seat whose read failed.
 * @returns {String|null}
 * @private
 */
function unreadReason(unread, failed = []) {
    const
        parts   = [],
        each    = list => list.length > 1 ? 'each' : 'it',
        refused = failed.filter(read => read.refused).map(read => read.seat),
        retried = failed.filter(read => !read.refused).map(read => read.seat);

    unread.length  && parts.push(`${unread.join(', ')} ${unread.length > 1 ? 'have' : 'has'} no readable PAT: connect again with a current token for ${each(unread)}`);
    refused.length && parts.push(`GitHub refused the PAT of ${refused.join(', ')}: connect again with a current token for ${each(refused)}`);
    retried.length && parts.push(`the GitHub read failed for ${retried.join(', ')}: the next pulse reads again`);

    return parts.length ? parts.join('; ') : null
}

/**
 * @summary Create the producer. Each seat reads its own work with its own PAT, the Fleet's observe
 * read: the open pull requests it authored or holds a review request on, and the
 * ones it authored that closed in its catch-up window. One seat's PAT never reads another seat's
 * work, so every row was read as the seat it belongs to. A seat without a readable PAT, or whose read
 * fails, leaves the pulse `partial` and is named with its next step; its rows carry, never vanish. A
 * benched seat owes no coverage: it reads when it can, and a read it misses only carries its rows.
 * @param {Object}   options
 * @param {Function} options.readers    `() → Promise<{seat: String, login: String, query: Function|null, benched: Boolean}[]>`:
 *     each seat with its GitHub login and its GraphQL call `(text, variables) → Promise<data>`, null
 *     when the seat has no readable PAT, and whether the operator benched it.
 * @param {Function} options.repos      `() → Promise<String[]>`, the `owner/repo` slugs the seats work on.
 * @param {{byName: Function, byLogin: Function}} options.identities Resolve a social name or a login to a seat.
 * @param {Function} [options.now]      Clock.
 * @param {{load: Function, save: Function}|null} [options.store] Carries the state across a restart;
 *     `load` answers null for no saved state and throws for state it cannot read.
 * @param {Number}   [options.pageBudget]
 * @param {Number}   [options.transitionWindow]
 * @param {Number|null} [options.pulseWindow] Explicit count-only history cap; otherwise retain the elapsed quota prefix.
 * @param {Number} [options.intervalMs] The existing producer cadence, recorded for gap assessment.
 * @param {Number}   [options.overlapMs]
 * @returns {{pulse: Function, getState: Function}}
 */
export function createOpenWorkProducer({
    readers,
    repos,
    identities,
    now              = () => new Date(),
    store            = null,
    pageBudget       = PAGE_BUDGET,
    transitionWindow = TRANSITION_WINDOW,
    pulseWindow      = null,
    intervalMs       = 60000,
    overlapMs        = OVERLAP_MS
}) {
    let state = FRESH, loadFailure = null, running = null;

    const load = () => {
        try {
            state       = store?.load?.() ?? FRESH;
            loadFailure = null
        } catch (error) {
            loadFailure = error
        }
    };

    const commit = (next, pulse) => {
        let pulses = [...state.pulses, pulse];
        if (pulseWindow === null) {
            const
                cutoff = Date.parse(pulse.at) - PULSE_HISTORY_MS,
                first  = pulses.findIndex(row => Date.parse(row.at) >= cutoff);
            if (first > 0) pulses = pulses.slice(first - 1);
        }
        state = {...state, ...next, pulses: pulses.slice(-(pulseWindow ?? PULSE_WINDOW))};
        store?.save?.(state);
        return state
    };

    load();

    async function run() {
        loadFailure && load();

        if (loadFailure) {
            return state = {...FRESH, reason: 'the saved open-work state could not be read', detail: redactReadFailure(loadFailure)}
        }

        const
            at      = now().toISOString(),
            started = performance.now(),
            stamp   = () => new Date(Date.parse(at) + performance.now() - started).toISOString(),
            finish  = (next, pulse) => commit(next, {telemetryVersion: 1, intervalMs, finishedAt: stamp(), quota: [], seats: [], costUnknown: false, ...pulse}),
            slugs   = [...new Set(await repos())].sort();

        if (!slugs.length) {
            return finish({coverage: state.snapshot ? 'stale' : 'unavailable', reason: 'no seat works on a GitHub repository', detail: null}, {at, failed: true, cost: 0, pages: 0})
        }

        const
            scope         = slugs.map(slug => `repo:${slug}`).join(' '),
            tally         = {cost: 0, pages: 0, costUnknown: false, quota: []},
            seats         = await readers(),
            unread        = seats.filter(seat => !seat.query).map(seat => seat.seat),
            reads         = [],
            coverageSeats = seats.map(({seat, query, benched}) => ({seat, benched: !!benched, outcome: query ? 'failed' : 'credential-unread', authored: null, held: null, terminal: null}));

        for (const {seat, login, query, apiBase} of seats.filter(seat => seat.query)) {
            // a seat's terminal window and watermark are its own; a saved single watermark seeds them
            const
                mark         = state.readers?.[login] ?? {watermark: state.watermark ?? null, window: null},
                resume       = mark.window?.scope === scope && mark.window.since === mark.watermark,
                window       = state.snapshot && mark.watermark ? (resume ? mark.window : {scope, since: mark.watermark, until: at, cursor: null}) : null,
                open         = (search, progress) => readSearch({query, text: OPEN_WORK_SNAPSHOT, search: `is:pr is:open archived:false ${search} ${scope}`, pageBudget, tally, apiBase, stamp, progress}),
                coverageSeat = coverageSeats.find(row => row.seat === seat);

            try {
                coverageSeat.terminal = {required: !!window, complete: !window, rows: 0};
                const authored = await open(`author:${login}`, coverageSeat.authored = {complete: false, rows: 0});
                const held     = await open(`review-requested:${login}`, coverageSeat.held = {complete: false, rows: 0});
                const ended    = window
                        ? await readSearch({query, text: OPEN_WORK_TERMINAL, search: `is:pr is:closed closed:${searchTime(window.since)}..${searchTime(window.until)} author:${login} ${scope}`, cursor: window.cursor, pageBudget, tally, apiBase, stamp, progress: coverageSeat.terminal})
                        : {nodes: [], complete: true, cursor: null};
                coverageSeat.outcome = authored.complete && held.complete && ended.complete ? 'complete' : 'partial';

                reads.push({seat, login, mark, window, nodes: [...authored.nodes, ...held.nodes], complete: authored.complete && held.complete, ended})
            } catch (error) {
                // a message-less error still failed: without the fallback it would count as answered
                reads.push({seat, failure: redactReadFailure(error) ?? 'the read failed without a message', refused: error?.status === 401})
            }
        }

        const
            answered = reads.filter(read => !read.failure),
            failed   = reads.filter(read => read.failure);

        if (!answered.length) {
            return finish({
                coverage: state.snapshot ? 'stale' : 'unavailable',
                reason  : unreadReason(unread, failed) ?? 'no seat has a GitHub login',
                detail  : failed[0]?.failure ?? null
            }, {at, failed: true, ...tally, seats: coverageSeats})
        }

        const
            benched  = new Set(seats.filter(seat => seat.benched).map(seat => seat.seat)),
            owes     = seat => !benched.has(seat),
            missed   = [...unread, ...reads.filter(read => read.failure || !read.complete || !read.ended.complete).map(read => read.seat)].filter(seat => !owes(seat)),
            byKey    = rows => [...new Map(rows.map(row => [row.key, row])).values()],
            rows     = byKey(answered.flatMap(read => read.nodes).map(node => normalizePullRequest(node, identities))),
            terminal = {rows: byKey(answered.flatMap(read => read.ended.nodes).map(node => normalizeTerminal(node, identities))), complete: !failed.some(read => owes(read.seat)) && answered.every(read => !owes(read.seat) || read.ended.complete)},
            complete = !unread.some(owes) && !failed.some(read => owes(read.seat)) && answered.every(read => !owes(read.seat) || read.complete),
            // a seat unread or failed this pulse keeps its mark for when it reads again, and one with no mark yet holds
            // the boundary it would inherit now, so a seat that did read cannot carry the aggregate past a close the
            // other has not read; a seat no longer registered drops out
            marks    = Object.fromEntries(seats
                .map(({login}) => [login, state.readers?.[login] ?? (state.watermark ? {watermark: state.watermark, window: null} : null)])
                .filter(([login, mark]) => login && mark));

        for (const {login, mark, window, ended} of answered) {
            const reached = window && shift(window.until, -overlapMs);

            // the first pulse starts a seat's watermark; a window moves it, never backwards, once the window completes
            marks[login] = {
                watermark: window ? (ended.complete && reached > mark.watermark ? reached : mark.watermark) : shift(at, -overlapMs),
                window   : window && !ended.complete ? {...window, cursor: ended.cursor} : null
            }
        }

        const
            // the earliest seat's watermark bounds what is still closing, and seeds a seat that joins later
            watermark = Object.values(marks).map(mark => mark.watermark).filter(Boolean).sort()[0] ?? null,
            next      = reduceOpenWork({previous: state.snapshot, observed: {rows, complete, missed}, terminal, since: state.watermark ?? null, id: at}),
            coverage  = complete && !rows.some(row => row.partial) && terminal.complete ? 'complete' : 'partial';

        return finish({
            snapshot   : {rows: next.rows, closed: next.closed, complete: next.complete, missed: next.missed},
            observedAt : at,
            coverage,
            readers    : marks,
            watermark,
            window     : null,
            reason     : unreadReason(unread.filter(owes), failed.filter(read => owes(read.seat))),
            detail     : failed[0]?.failure ?? null,
            transitions: [...state.transitions, ...next.transitions].slice(-transitionWindow)
        }, {at, ...tally, seats: coverageSeats, coverage, transitions: countBySeat(next.transitions), vanished: next.vanished, ...(unread.length || failed.length ? {unread: [...unread, ...failed.map(read => read.seat)]} : {})})
    }

    return {
        /**
         * @summary One pulse. A pulse asked for while one runs is that pulse.
         * @returns {Promise<Object>} the state after the pulse.
         */
        pulse   : () => running ??= run().finally(() => { running = null }),
        getState: () => state
    }
}

// the declared retained window: a reader behind it reads a coverage gap (producerPrLaneEvents)
export {TRANSITION_WINDOW};

export default createOpenWorkProducer;

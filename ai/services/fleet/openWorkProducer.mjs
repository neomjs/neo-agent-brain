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
    /** @summary Pulses retained: a day at a one-minute cadence, the observe-only day's record. */
    PULSE_WINDOW      = 1440,
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
 * @summary Read one search across its pages, from a cursor, up to the budget. Each answered request
 * adds its cost and page to `tally` before the next is sent, so a failed read still counts them.
 * @param {Object}   options
 * @param {Function} options.query      `(text, variables) → data`.
 * @param {String}   options.text       The GraphQL query.
 * @param {String}   options.search     The search string.
 * @param {String|null} [options.cursor] Where a previous pulse stopped.
 * @param {Number}   options.pageBudget
 * @param {{cost: Number, pages: Number}} options.tally
 * @returns {Promise<{nodes: Object[], complete: Boolean, cursor: String|null}>}
 * @throws {Error} When an answer lacks its search page structure.
 * @private
 */
async function readSearch({query, text, search, cursor = null, pageBudget, tally}) {
    const nodes = [];

    for (let pages = 0; pages < pageBudget; pages++) {
        const {rateLimit, search: page} = await query(text, {query: search, cursor}) ?? {};

        tally.pages++;
        tally.cost += rateLimit?.cost ?? 0;

        if (!Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean') {
            throw new Error('the search answered without its page structure')
        }

        nodes.push(...page.nodes.filter(node => node?.number != null));

        if (!page.pageInfo.hasNextPage) return {nodes, complete: true, cursor: null};

        cursor = page.pageInfo.endCursor
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
 * @summary The coverage reason for the seats a pulse could not read, each with its next step.
 * @param {String[]} unread Seats without a readable PAT.
 * @param {String[]} failed Seats whose read failed.
 * @returns {String|null}
 * @private
 */
function unreadReason(unread, failed) {
    const parts = [];

    unread.length && parts.push(`${unread.join(', ')} ${unread.length > 1 ? 'have' : 'has'} no readable PAT: connect again with a current token for ${unread.length > 1 ? 'each' : 'it'}`);
    failed.length && parts.push(`the GitHub read failed for ${failed.join(', ')}`);

    return parts.length ? parts.join('; ') : null
}

/**
 * @summary Create the producer. Each seat reads its own work with its own PAT, the Fleet's observe
 * read: the open pull requests it authored or holds a review request on, and the
 * ones it authored that closed in its catch-up window. One seat's PAT never reads another seat's
 * work, so every row was read as the seat it belongs to. A seat without a readable PAT, or whose read
 * fails, leaves the pulse `partial` and is named with its next step; its rows carry, never vanish.
 * @param {Object}   options
 * @param {Function} options.readers    `() → Promise<{seat: String, login: String, query: Function|null}[]>`:
 *     each seat with its GitHub login and its GraphQL call `(text, variables) → Promise<data>`, null
 *     when the seat has no readable PAT.
 * @param {Function} options.repos      `() → Promise<String[]>`, the `owner/repo` slugs the seats work on.
 * @param {{byName: Function, byLogin: Function}} options.identities Resolve a social name or a login to a seat.
 * @param {Function} [options.now]      Clock.
 * @param {{load: Function, save: Function}|null} [options.store] Carries the state across a restart;
 *     `load` answers null for no saved state and throws for state it cannot read.
 * @param {Number}   [options.pageBudget]
 * @param {Number}   [options.transitionWindow]
 * @param {Number}   [options.pulseWindow]
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
    pulseWindow      = PULSE_WINDOW,
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
        state = {...state, ...next, pulses: [...state.pulses, pulse].slice(-pulseWindow)};
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
            at    = now().toISOString(),
            slugs = [...new Set(await repos())].sort();

        if (!slugs.length) {
            return commit({coverage: state.snapshot ? 'stale' : 'unavailable', reason: 'no seat works on a GitHub repository', detail: null}, {at, failed: true, cost: 0, pages: 0})
        }

        const
            scope  = slugs.map(slug => `repo:${slug}`).join(' '),
            tally  = {cost: 0, pages: 0},
            seats  = await readers(),
            unread = seats.filter(seat => !seat.query).map(seat => seat.seat),
            reads  = [];

        for (const {seat, login, query} of seats.filter(seat => seat.query)) {
            // a seat's terminal window and watermark are its own; a saved single watermark seeds them
            const
                mark   = state.readers?.[login] ?? {watermark: state.watermark ?? null, window: null},
                resume = mark.window?.scope === scope && mark.window.since === mark.watermark,
                window = state.snapshot && mark.watermark ? (resume ? mark.window : {scope, since: mark.watermark, until: at, cursor: null}) : null,
                open   = search => readSearch({query, text: OPEN_WORK_SNAPSHOT, search: `is:pr is:open archived:false ${search} ${scope}`, pageBudget, tally});

            try {
                const
                    authored = await open(`author:${login}`),
                    held     = await open(`review-requested:${login}`),
                    ended    = window
                        ? await readSearch({query, text: OPEN_WORK_TERMINAL, search: `is:pr is:closed closed:${searchTime(window.since)}..${searchTime(window.until)} author:${login} ${scope}`, cursor: window.cursor, pageBudget, tally})
                        : {nodes: [], complete: true, cursor: null};

                reads.push({seat, login, mark, window, nodes: [...authored.nodes, ...held.nodes], complete: authored.complete && held.complete, ended})
            } catch (error) {
                reads.push({seat, failure: redactReadFailure(error)})
            }
        }

        const
            answered = reads.filter(read => !read.failure),
            failed   = reads.filter(read => read.failure);

        if (!answered.length) {
            return commit({
                coverage: state.snapshot ? 'stale' : 'unavailable',
                reason  : failed.length ? 'the GitHub read failed' : unreadReason(unread, []) ?? 'no seat has a GitHub login',
                detail  : failed.length ? unreadReason(unread, failed.map(read => read.seat)) + `: ${failed[0].failure}` : null
            }, {at, failed: true, ...tally, ...(failed.length ? {costUnknown: true} : {})})
        }

        const
            byKey    = rows => [...new Map(rows.map(row => [row.key, row])).values()],
            rows     = byKey(answered.flatMap(read => read.nodes).map(node => normalizePullRequest(node, identities))),
            terminal = {rows: byKey(answered.flatMap(read => read.ended.nodes).map(node => normalizeTerminal(node, identities))), complete: !failed.length && answered.every(read => read.ended.complete)},
            complete = !unread.length && !failed.length && answered.every(read => read.complete),
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
            next      = reduceOpenWork({previous: state.snapshot, observed: {rows, complete}, terminal, since: state.watermark ?? null, id: at}),
            coverage  = complete && !rows.some(row => row.partial) && terminal.complete ? 'complete' : 'partial';

        return commit({
            snapshot   : {rows: next.rows, closed: next.closed, complete: next.complete},
            observedAt : at,
            coverage,
            readers    : marks,
            watermark,
            window     : null,
            reason     : unreadReason(unread, failed.map(read => read.seat)),
            detail     : failed[0]?.failure ?? null,
            transitions: [...state.transitions, ...next.transitions].slice(-transitionWindow)
        }, {at, ...tally, coverage, transitions: countBySeat(next.transitions), vanished: next.vanished, ...(unread.length || failed.length ? {unread: [...unread, ...failed.map(read => read.seat)]} : {})})
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

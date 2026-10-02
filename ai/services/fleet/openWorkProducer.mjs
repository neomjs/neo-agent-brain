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
 *   restarts, so a backlog larger than one budget reaches its tail, and the watermark moves to the
 *   window's end only once the window completes;
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
 * @summary Create the producer.
 * @param {Object}   options
 * @param {Function} options.query      `(text, variables) → Promise<data>`, a GitHub GraphQL call.
 * @param {Function} options.repos      `() → Promise<String[]>`, the `owner/repo` slugs the seats work on.
 * @param {{byName: Function, byLogin: Function}} options.identities Resolve a social name or a login to a seat.
 * @param {Function} [options.now]      Clock.
 * @param {{load: Function, save: Function}|null} [options.store] Carries the state across a restart;
 *     `load` answers null for no saved state and throws for state it cannot read.
 * @param {Number}   [options.pageBudget]
 * @param {Number}   [options.transitionWindow]
 * @param {Number}   [options.pulseWindow]
 * @returns {{pulse: Function, getState: Function}}
 */
export function createOpenWorkProducer({
    query,
    repos,
    identities,
    now              = () => new Date(),
    store            = null,
    pageBudget       = PAGE_BUDGET,
    transitionWindow = TRANSITION_WINDOW,
    pulseWindow      = PULSE_WINDOW
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
            resume = state.window?.scope === scope && state.window.since === state.watermark,
            window = state.snapshot && state.watermark ? (resume ? state.window : {scope, since: state.watermark, until: at, cursor: null}) : null;
        let open, ended;

        try {
            open  = await readSearch({query, text: OPEN_WORK_SNAPSHOT, search: `is:pr is:open archived:false ${scope}`, pageBudget, tally});
            ended = window
                ? await readSearch({query, text: OPEN_WORK_TERMINAL, search: `is:pr is:closed closed:${searchTime(window.since)}..${searchTime(window.until)} ${scope}`, cursor: window.cursor, pageBudget, tally})
                : {nodes: [], complete: true, cursor: null}
        } catch (error) {
            return commit({coverage: state.snapshot ? 'stale' : 'unavailable', reason: 'the GitHub read failed', detail: redactReadFailure(error)}, {at, failed: true, ...tally, costUnknown: true})
        }

        const
            rows     = open.nodes.map(node => normalizePullRequest(node, identities)),
            observed = {rows, complete: open.complete && !rows.some(row => row.partial)},
            terminal = {rows: ended.nodes.map(node => normalizeTerminal(node, identities)), complete: ended.complete},
            next     = reduceOpenWork({previous: state.snapshot, observed, terminal, since: state.watermark, id: at}),
            complete = observed.complete && terminal.complete;

        return commit({
            snapshot  : {rows: next.rows, closed: next.closed},
            observedAt: at,
            coverage  : complete ? 'complete' : 'partial',
            // the first complete open read starts the watermark; a window moves it once the window completes
            watermark  : window ? (ended.complete ? window.until : state.watermark) : (observed.complete ? at : null),
            window     : window && !ended.complete ? {...window, cursor: ended.cursor} : null,
            reason     : null,
            detail     : null,
            transitions: [...state.transitions, ...next.transitions].slice(-transitionWindow)
        }, {at, ...tally, coverage: complete ? 'complete' : 'partial', transitions: countBySeat(next.transitions)})
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

export default createOpenWorkProducer;

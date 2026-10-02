/**
 * @module ai/services/fleet/openWorkProducer
 * @summary The open-work producer: each pulse reads the open pull requests of the repositories the
 * Fleet's seats work on, and the ones merged or closed since its watermark, reduces them against its
 * last snapshot ({@link module:ai/services/fleet/openWorkReducer}), and keeps a bounded window of the
 * transitions with each pulse's cost. It is observe-only: it holds no mailbox client and wakes no one.
 *
 * Coverage is honest. A page the budget cuts off, a truncated review-request list or a terminal read
 * cut short makes the pulse `partial`, and the watermark stays at the last complete pulse, so the next
 * pulse re-reads what this one missed. A failed read keeps the last snapshot under `stale`, or reads
 * `unavailable` without one; its reason is constant, and its detail goes through `redactReadFailure`,
 * as every fleet source's does. The injected store carries the state across a restart.
 */

import {OPEN_WORK_SNAPSHOT, OPEN_WORK_TERMINAL}                  from '../github-workflow/queries/openWorkQueries.mjs';
import {normalizePullRequest, normalizeTerminal, reduceOpenWork} from './openWorkReducer.mjs';
import {redactReadFailure}                                       from './redactReadFailure.mjs';

const
    /** @summary Search pages per read before the pulse is partial. */
    PAGE_BUDGET       = 4,
    /** @summary Transitions retained; a reader behind them reads a coverage gap. */
    TRANSITION_WINDOW = 500,
    /** @summary Pulses retained: a day at a one-minute cadence, the observe-only day's record. */
    PULSE_WINDOW      = 1440;

/**
 * @summary Read one search across its pages, up to the budget.
 * @param {Function} query `(text, variables) → data`.
 * @param {String} text The GraphQL query.
 * @param {String} search The search string.
 * @param {Number} pageBudget
 * @returns {Promise<{nodes: Object[], complete: Boolean, cost: Number, pages: Number}>}
 * @private
 */
async function readSearch(query, text, search, pageBudget) {
    const nodes  = [];
    let   cursor = null, cost = 0, pages = 0;

    while (pages < pageBudget) {
        const {rateLimit, search: page} = await query(text, {query: search, cursor});

        pages++;
        cost += rateLimit?.cost ?? 0;
        nodes.push(...(page?.nodes ?? []).filter(node => node?.number != null));

        if (!page?.pageInfo?.hasNextPage) return {nodes, complete: true, cost, pages};

        cursor = page.pageInfo.endCursor
    }

    return {nodes, complete: false, cost, pages}
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
 * @param {{load: Function, save: Function}|null} [options.store] Carries the state across a restart.
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
    let state = store?.load?.() ?? {snapshot: null, observedAt: null, coverage: 'unavailable', watermark: null, reason: null, transitions: [], pulses: []};

    const commit = (next, pulse) => {
        state = {...state, ...next, pulses: [...state.pulses, pulse].slice(-pulseWindow)};
        store?.save?.(state);
        return state
    };

    /**
     * @summary One pulse: read, reduce, record.
     * @returns {Promise<Object>} the state after the pulse.
     */
    async function pulse() {
        const
            at    = now().toISOString(),
            slugs = [...new Set(await repos())].sort();

        if (!slugs.length) {
            return commit({coverage: state.snapshot ? 'stale' : 'unavailable', reason: 'no seat works on a GitHub repository'}, {at, failed: true})
        }

        const scope = slugs.map(slug => `repo:${slug}`).join(' ');
        let open, ended;

        try {
            open  = await readSearch(query, OPEN_WORK_SNAPSHOT, `is:pr is:open archived:false ${scope}`, pageBudget);
            ended = state.snapshot && state.watermark
                ? await readSearch(query, OPEN_WORK_TERMINAL, `is:pr is:closed updated:>=${state.watermark} ${scope}`, pageBudget)
                : {nodes: [], complete: true, cost: 0, pages: 0}
        } catch (error) {
            return commit({coverage: state.snapshot ? 'stale' : 'unavailable', reason: 'the GitHub read failed', detail: redactReadFailure(error)}, {at, failed: true})
        }

        const
            rows     = open.nodes.map(node => normalizePullRequest(node, identities)),
            observed = {rows, complete: open.complete && !rows.some(row => row.partial)},
            terminal = {rows: ended.nodes.map(node => normalizeTerminal(node, identities)), complete: ended.complete},
            next     = reduceOpenWork({previous: state.snapshot, observed, terminal, since: state.watermark, id: at}),
            complete = observed.complete && terminal.complete;

        return commit({
            snapshot   : {rows: next.rows, closed: next.closed},
            observedAt : at,
            coverage   : complete ? 'complete' : 'partial',
            watermark  : complete ? at : state.watermark,
            reason     : null,
            detail     : null,
            transitions: [...state.transitions, ...next.transitions].slice(-transitionWindow)
        }, {at, cost: open.cost + ended.cost, pages: open.pages + ended.pages, coverage: complete ? 'complete' : 'partial', transitions: countBySeat(next.transitions)})
    }

    return {pulse, getState: () => state}
}

export default createOpenWorkProducer;

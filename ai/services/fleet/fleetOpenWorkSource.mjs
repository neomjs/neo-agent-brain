/**
 * @module ai/services/fleet/fleetOpenWorkSource
 * @summary Each seat's open work, projected from the open-work producer's state: the pull requests it
 * owns (CI, verdict, mergeability) and the ones whose review is requested of it. Every row names who
 * holds its next action ({@link module:ai/services/fleet/openWorkHolder}), and `awaitingMerge` lists
 * the rows the operator holds, whoever owns them: a PR no seat owns is in no seat's lists.
 *
 * The envelope carries the producer's freshness, never this read's: `ok` within the stale bound after
 * the producer's last pulse, `stale` past it or after a failed pulse, and `unavailable` before any
 * pulse answered or once the last answer is too old to show. A partial pulse says so in `coverage`.
 * A stopped producer therefore reads stale, then unavailable, and never "no open work".
 *
 * Each row keeps its own age too: a row partial pulses carried without observing it is `stale` past
 * the stale bound, and past the unavailable bound it leaves the projection and is counted in
 * `unobserved`, never shown as current work.
 */

import {holderOf} from './openWorkHolder.mjs';

const
    /** @summary Past this since the last pulse, the projection is stale. */
    STALE_AFTER_MS       = 5 * 60 * 1000,
    /** @summary Past this, the last answer is too old to show. */
    UNAVAILABLE_AFTER_MS = 60 * 60 * 1000;

/**
 * @summary The part of a row a holder acts on, with its title, when it was last observed and who holds
 * it. A row stored before the snapshot carried titles reads `null`.
 * @param {Object} row
 * @param {Boolean} stale
 * @returns {Object}
 * @private
 */
function summaryOf(row, stale) {
    const {repo, number, title, head, ci, verdict, mergeable, draft, reviews, observedAt} = row;

    return {repo, number, title: title ?? null, head, ci, verdict, mergeable, draft, reviews: reviews ?? [], observedAt, stale, holder: holderOf(row)}
}

/**
 * @summary Project the producer's state into the per-seat envelope.
 * @param {Object|null} state The producer's state.
 * @param {Object}   options
 * @param {Function} options.now `() → epoch ms`.
 * @param {Number}   [options.staleAfterMs]
 * @param {Number}   [options.unavailableAfterMs]
 * @returns {{state: 'ok'|'stale'|'unavailable', observedAt: String|null, coverage: String, reason: String|null,
 *     detail: String|null, unobserved: Number, seats: Object, awaitingMerge: Object[]}}
 */
export function projectOpenWork(state, {now, staleAfterMs = STALE_AFTER_MS, unavailableAfterMs = UNAVAILABLE_AFTER_MS}) {
    const
        ageOf         = at => at ? now() - Date.parse(at) : Infinity,
        ageMs         = ageOf(state?.observedAt),
        seats         = {},
        awaitingMerge = [],
        seat          = id => seats[id] ??= {authored: [], reviewing: []};

    if (ageMs > unavailableAfterMs) {
        return {state: 'unavailable', observedAt: state?.observedAt ?? null, coverage: 'unavailable', reason: state?.reason ?? null, detail: state?.detail ?? null, unobserved: 0, seats, awaitingMerge}
    }

    let unobserved = 0;

    for (const row of Object.values(state.snapshot?.rows ?? {})) {
        const rowAgeMs = ageOf(row.observedAt);

        if (rowAgeMs > unavailableAfterMs) {
            unobserved++;
            continue
        }

        const summary = summaryOf(row, rowAgeMs > staleAfterMs);

        row.owner?.seat && seat(row.owner.seat).authored.push(summary);
        row.requested.filter(id => id.startsWith('@')).forEach(id => seat(id).reviewing.push(summary));
        summary.holder.role === 'operator' && awaitingMerge.push(summary)
    }

    return {
        state     : ageMs > staleAfterMs || state.coverage === 'stale' ? 'stale' : 'ok',
        observedAt: state.observedAt,
        coverage  : state.coverage,
        reason    : state.reason ?? null,
        detail    : state.detail ?? null,
        unobserved,
        seats,
        awaitingMerge
    }
}

/**
 * @summary The Fleet bridge's open-work source over one producer.
 * @param {Object}   options
 * @param {{getState: Function}} options.producer
 * @param {Function} [options.now]
 * @param {Number}   [options.staleAfterMs]
 * @param {Number}   [options.unavailableAfterMs]
 * @returns {{readOpenWork: Function}}
 */
export function createFleetOpenWorkSource({producer, now = () => Date.now(), ...bounds}) {
    return {
        /**
         * @summary One seat's open work, or every seat's, under the producer's envelope. The
         * operator's `awaitingMerge` is answered either way.
         * @param {Object} [params]
         * @param {String} [params.seat] A seat id such as `@neo-opus-ada`.
         * @returns {Object}
         */
        readOpenWork({seat = null} = {}) {
            const projection = projectOpenWork(producer.getState(), {now, ...bounds});

            return seat
                ? {...projection, seats: {[seat]: projection.seats[seat] ?? {authored: [], reviewing: []}}}
                : projection
        }
    }
}

export default createFleetOpenWorkSource;

/**
 * @module ai/services/fleet/fleetOpenWorkSource
 * @summary Each seat's open work, projected from the open-work producer's state: the pull requests it
 * owns (CI, verdict, mergeability) and the ones whose review is requested of it.
 *
 * The envelope carries the producer's freshness, never this read's: `ok` within the stale bound after
 * the producer's last pulse, `stale` past it or after a failed pulse, and `unavailable` before any
 * pulse answered or once the last answer is too old to show. A partial pulse says so in `coverage`.
 * A stopped producer therefore reads stale, then unavailable, and never "no open work".
 */

const
    /** @summary Past this since the last pulse, the projection is stale. */
    STALE_AFTER_MS       = 5 * 60 * 1000,
    /** @summary Past this, the last answer is too old to show. */
    UNAVAILABLE_AFTER_MS = 60 * 60 * 1000;

/**
 * @summary The part of a row a holder acts on.
 * @param {Object} row
 * @returns {Object}
 * @private
 */
function summaryOf({repo, number, head, ci, verdict, mergeable, draft}) {
    return {repo, number, head, ci, verdict, mergeable, draft}
}

/**
 * @summary Project the producer's state into the per-seat envelope.
 * @param {Object|null} state The producer's state.
 * @param {Object}   options
 * @param {Function} options.now `() → epoch ms`.
 * @param {Number}   [options.staleAfterMs]
 * @param {Number}   [options.unavailableAfterMs]
 * @returns {{state: 'ok'|'stale'|'unavailable', observedAt: String|null, coverage: String, reason: String|null, detail: String|null, seats: Object}}
 */
export function projectOpenWork(state, {now, staleAfterMs = STALE_AFTER_MS, unavailableAfterMs = UNAVAILABLE_AFTER_MS}) {
    const
        ageMs = state?.observedAt ? now() - Date.parse(state.observedAt) : Infinity,
        seats = {},
        seat  = id => seats[id] ??= {authored: [], reviewing: []};

    if (ageMs > unavailableAfterMs) {
        return {state: 'unavailable', observedAt: state?.observedAt ?? null, coverage: 'unavailable', reason: state?.reason ?? null, detail: state?.detail ?? null, seats}
    }

    for (const row of Object.values(state.snapshot?.rows ?? {})) {
        row.owner?.seat && seat(row.owner.seat).authored.push(summaryOf(row));
        row.requested.filter(id => id.startsWith('@')).forEach(id => seat(id).reviewing.push(summaryOf(row)))
    }

    return {
        state     : ageMs > staleAfterMs || state.coverage === 'stale' ? 'stale' : 'ok',
        observedAt: state.observedAt,
        coverage  : state.coverage,
        reason    : state.reason ?? null,
        detail    : state.detail ?? null,
        seats
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
         * @summary One seat's open work, or every seat's, under the producer's envelope.
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

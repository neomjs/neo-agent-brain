/**
 * @module ai/services/fleet/openWorkFreshness
 * @summary The open-work projection's age bounds, shared by the host's projection and the plane's copy of it.
 * Plain data, no I/O: the plane imports it without the host's GitHub-facing modules.
 */

/** @summary Past this since an observation, open work is stale. */
export const STALE_AFTER_MS = 5 * 60 * 1000;

/** @summary Past this, an observation is too old to show. */
export const UNAVAILABLE_AFTER_MS = 60 * 60 * 1000;

/**
 * @summary Classify an observation with the projection's shared timestamp bounds.
 * @param {String|null} observedAt
 * @param {Object} options
 * @param {Number} options.now Epoch milliseconds.
 * @param {Number} [options.staleAfterMs]
 * @param {Number} [options.unavailableAfterMs]
 * @returns {'ok'|'stale'|'unavailable'} Missing, invalid or future observations are unavailable.
 */
export function openWorkFreshness(observedAt, {now, staleAfterMs = STALE_AFTER_MS, unavailableAfterMs = UNAVAILABLE_AFTER_MS}) {
    const age = now - Date.parse(observedAt);

    return !Number.isFinite(age) || age < 0 || age > unavailableAfterMs
        ? 'unavailable'
        : age > staleAfterMs ? 'stale' : 'ok'
}

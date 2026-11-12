/**
 * @module ai/services/fleet/capacityThrottleState
 * @summary The throttle axis's producer: the verdict a seat's plan-capacity reading supports.
 *
 * A seat is `rate-limited` while a window that binds it sits at 100 %: the 5-hour window, the weekly
 * all-models window, or a weekly window that caps the model the seat runs. It is `none` below that.
 * It is `unknown` when the reading is unobserved or stale, or when no binding window is still
 * current, because a percent observed before its window reset says nothing about now. The reading is
 * the one `who_is_online` projects per seat, so the axis needs no second source and no credential.
 */
import {presenceIdentityForAgent} from './fleetPresenceStateAdapter.mjs';

/**
 * @summary Maps one seat's capacity reading onto the throttle taxonomy.
 *
 * A capped-model window binds a seat whose model names that model (`claude-fable-5-2` runs `fable`);
 * a seat with no reported model is bound by the all-models windows only, so a capped model's
 * exhaustion never takes out a seat that runs another one.
 *
 * @param {Object|undefined} capacity A `who_is_online` row's `capacity`.
 * @param {Number|Date|String} [now=Date.now()] Clock source.
 * @returns {'rate-limited'|'none'|'unknown'}
 */
export function throttleStateFromCapacity(capacity, now = Date.now()) {
    if (capacity?.state !== 'observed' || !Array.isArray(capacity.windows)) return 'unknown';

    const
        nowMs     = new Date(now).getTime(),
        seatModel = String(capacity.model ?? '').toLowerCase(),
        binding   = capacity.windows.filter(window =>
            !window.stale &&
            (!window.resetsAt || Date.parse(window.resetsAt) > nowMs) &&
            (window.kind !== 'weekly-model' || (seatModel !== '' && seatModel.includes(String(window.model).toLowerCase())))
        );

    if (!binding.length) return 'unknown';

    return binding.some(window => window.percentUsed >= 100) ? 'rate-limited' : 'none'
}

/**
 * @summary Builds the `resolveThrottleState` reader the throttle adapter injects, over the Fleet's
 * presence reader.
 *
 * The adapter asks once per agent, in sequence, within one snapshot. The reader therefore keeps one
 * presence answer while those calls settle and drops it on the next task, so a snapshot costs one
 * read, and the next snapshot reads fresh. Seats join on the presence identity, as presence does.
 *
 * @param {Function} readPresence `() => Promise<Object>` resolving to a verbose `who_is_online` answer.
 * @returns {Function} `(agent) => Promise<'rate-limited'|'none'|'unknown'>`
 */
export function createCapacityThrottleReader(readPresence) {
    let rows = null;

    const read = () => rows ??= readPresence()
        .then(payload => new Map((payload?.agents ?? []).map(row => [row.identity, row.capacity])))
        .finally(() => setTimeout(() => { rows = null }, 0));

    return async agent => throttleStateFromCapacity((await read()).get(presenceIdentityForAgent(agent)))
}

export default throttleStateFromCapacity;

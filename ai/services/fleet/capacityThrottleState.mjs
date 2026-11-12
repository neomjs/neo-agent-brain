/**
 * @module ai/services/fleet/capacityThrottleState
 * @summary The throttle axis's producer: the verdict a seat's plan-capacity reading supports.
 *
 * A seat is `rate-limited` while a window that binds it sits at 100 %: the 5-hour window, the weekly
 * all-models window, or a weekly window that caps the model the seat runs. It is `none` below that.
 * It is `unknown` when the reading is unobserved or stale, or when no binding window is still
 * current, because a percent observed before its window reset says nothing about now. The reading is
 * the one `who_is_online` projects per seat, with its pool's newest windows (`pools`), so the axis
 * needs no second source and no credential. The same windows say until when a rate-limited seat
 * waits (`exhaustedUntil`), which the open-work rotation reads to pass the seat over until then.
 */
import {presenceIdentityForAgent} from './fleetPresenceStateAdapter.mjs';

/**
 * @summary The windows of an observed reading that bind its seat now.
 *
 * A capped-model window binds a seat whose model names that model (`claude-fable-5-2` runs `fable`);
 * a seat with no reported model is bound by the all-models windows only, so a capped model's
 * exhaustion never takes out a seat that runs another one. A stale window, or one that has reset
 * since it was observed, binds nobody.
 *
 * @param {Object|undefined} capacity A `who_is_online` row's `capacity`.
 * @param {Number|Date|String} now Clock source.
 * @returns {Object[]|null} Null for an unobserved or stale reading.
 * @private
 */
function bindingWindows(capacity, now) {
    if (capacity?.state !== 'observed' || !Array.isArray(capacity.windows)) return null;

    const
        nowMs     = new Date(now).getTime(),
        seatModel = String(capacity.model ?? '').toLowerCase();

    return capacity.windows.filter(window =>
        !window.stale &&
        (!window.resetsAt || Date.parse(window.resetsAt) > nowMs) &&
        (window.kind !== 'weekly-model' || (seatModel !== '' && seatModel.includes(String(window.model).toLowerCase())))
    )
}

/**
 * @summary Maps one seat's capacity reading onto the throttle taxonomy.
 * @param {Object|undefined} capacity A `who_is_online` row's `capacity`.
 * @param {Number|Date|String} [now=Date.now()] Clock source.
 * @returns {'rate-limited'|'none'|'unknown'}
 */
export function throttleStateFromCapacity(capacity, now = Date.now()) {
    const binding = bindingWindows(capacity, now);

    if (!binding?.length) return 'unknown';

    return binding.some(window => window.percentUsed >= 100) ? 'rate-limited' : 'none'
}

/**
 * @summary The instant a rate-limited seat can act again, as far as its reading can tell.
 *
 * The latest `resetsAt` among the binding windows at 100 %. A full window without a `resetsAt`
 * names no end, so it never starts a wait, and neither does an unobserved or stale reading.
 *
 * @param {Object|undefined} capacity A `who_is_online` row's `capacity`.
 * @param {Number|Date|String} [now=Date.now()] Clock source.
 * @returns {Number|null} Epoch milliseconds, or null when the reading names no wait.
 */
export function exhaustedUntil(capacity, now = Date.now()) {
    const resets = (bindingWindows(capacity, now) ?? [])
        .filter(window => window.percentUsed >= 100 && window.resetsAt)
        .map(window => Date.parse(window.resetsAt))
        .filter(Number.isFinite);

    return resets.length ? Math.max(...resets) : null
}

/**
 * @summary Each seat of a verbose `who_is_online` answer that waits for a reset, with that instant.
 *
 * Seats key by their presence identity, as the route map does (`undeliverableOf`), and read their
 * pool's newest windows. A seat that names no wait is absent.
 *
 * @param {Object|null} presence `{agents: [{identity, capacity}], pools}`.
 * @param {Number|Date|String} [now=Date.now()] Clock source.
 * @returns {Object<String, Number>} Seat identity to epoch milliseconds.
 */
export function exhaustedUntilOf(presence, now = Date.now()) {
    const result = {};

    for (const row of Array.isArray(presence?.agents) ? presence.agents : []) {
        if (typeof row?.identity !== 'string') continue;

        const until = exhaustedUntil(withPoolWindows(row.capacity, presence.pools?.[row.capacity?.poolKey]), now);

        if (until !== null) result[row.identity] = until
    }

    return result
}

/**
 * @summary A seat's observed reading with its pool's newest windows in place of its own: every window
 * is the account's, so a member that sampled an hour ago reads the week another member found exhausted.
 *
 * The pool's windows are the newest fresh ones any member reported, the seat's own included. The seat
 * keeps its model, so a capped model still binds only the seats that run it. A stale or unobserved
 * reading stays as it is: the seat may have left the pool since.
 *
 * @param {Object|undefined} capacity A `who_is_online` row's `capacity`.
 * @param {Object|undefined} pool The answer's `pools` entry for that reading's `poolKey`.
 * @returns {Object|undefined}
 */
export function withPoolWindows(capacity, pool) {
    if (capacity?.state !== 'observed' || !pool?.windows?.length) return capacity;

    const key     = window => `${window.kind}:${window.model ?? ''}`,
          windows = new Map(capacity.windows.map(window => [key(window), window]));

    pool.windows.forEach(window => windows.set(key(window), window));

    return {...capacity, windows: [...windows.values()]}
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
        .then(payload => new Map((payload?.agents ?? []).map(row => [
            row.identity,
            withPoolWindows(row.capacity, payload.pools?.[row.capacity?.poolKey])
        ])))
        .finally(() => setTimeout(() => { rows = null }, 0));

    return async agent => throttleStateFromCapacity((await read()).get(presenceIdentityForAgent(agent)))
}

export default throttleStateFromCapacity;

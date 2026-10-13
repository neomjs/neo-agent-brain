/**
 * @module ai/services/fleet/wireFleetOpenWorkWakes
 * @summary Persist holder-action admissions before sending through the already verified plane.
 * The existing producer invokes this callback; it owns cadence. The entrypoint owns enablement.
 * An admitted attempt is never proof of delivery, and an ambiguous send is never replayed.
 */
import path                            from 'path';
import {fileStore}                     from './wireFleetOpenWorkSource.mjs';
import {planOpenWorkWakes, wakeGateOf} from './openWorkWakes.mjs';
import {openWorkFreshness}             from './fleetOpenWorkSource.mjs';

const ROUTES_TTL_MS = 5 * 60 * 1000;

/**
 * @summary Describe the observed action and retain its complete task identity for live revalidation.
 * @param {Object} wake The planner's admission.
 * @returns {Object} Payload for the injected same-plane add_message sender.
 */
export function wakeMessageOf(wake) {
    return {
        to     : wake.to,
        subject: `[open-work:${wake.kind}] ${wake.pr}: observed ${wake.reason}`,
        body   : `https://github.com/${wake.repo}/pull/${wake.number}\nHead: ${wake.head}\n` +
            `Observed action: ${wake.kind} — ${wake.reason}.\nEpisode: ${wake.episode}\n\n` +
            'Re-check the live pull request, head, checks and review state before acting. ' +
            'This message describes a producer observation, not a guarantee of the current state.',
        relatedTickets: [wake.pr],
        task          : {
            id  : `open-work:${wake.key}`, state: 'Submitted', producerRole: 'fleet-open-work',
            kind: wake.kind, head: wake.head, episode: wake.episode
        }
    }
}

/**
 * @summary Refuse malformed persisted history instead of overwriting it as a fresh baseline.
 * @param {Object|null} ledger
 * @private
 */
function validateLedger(ledger) {
    if (ledger === null) return;
    const
        object = value => value && typeof value === 'object' && !Array.isArray(value),
        text   = value => typeof value === 'string' && value.length > 0,
        wake   = value => object(value) && text(value.repo) && Number.isInteger(value.number) && value.number > 0 &&
            text(value.head) && text(value.to) && value.to.startsWith('@') && text(value.kind) &&
            text(value.episode) && text(value.reason) && ['author', 'reviewer'].includes(value.role) &&
            value.pr === `${value.repo}#${value.number}` &&
            value.key === JSON.stringify([value.repo, value.number, value.head, value.to, value.kind, value.episode]);

    if (!object(ledger) || !text(ledger.pulse) || !Number.isFinite(Date.parse(ledger.pulse)) ||
        !object(ledger.holding) || !object(ledger.pendingMerges) || !object(ledger.baselines) ||
        Object.entries(ledger.holding).some(([slot, entry]) => !object(entry) || !wake(entry.wake) ||
            !['baseline', 'pending', 'admitted'].includes(entry.status) ||
            slot !== JSON.stringify([entry.wake.repo, entry.wake.number, entry.wake.head, entry.wake.to, entry.wake.kind])) ||
        Object.entries(ledger.pendingMerges).some(([id, value]) => !wake(value) || value.kind !== 'post-merge' || id !== value.episode) ||
        Object.values(ledger.baselines).some(value => !text(value))) {
        throw new Error('Malformed open-work wake ledger; existing history preserved')
    }
}

/**
 * @summary Keep the newest queued snapshot without losing terminal observations that arrived before it.
 * @param {Object|null} queued
 * @param {Object} incoming
 * @returns {Object}
 * @private
 */
function queueObservation(queued, incoming) {
    if (!queued) return structuredClone(incoming);
    const latest    = Date.parse(incoming.observedAt) >= Date.parse(queued.observedAt) ? incoming : queued,
        transitions = new Map();

    for (const entry of [...(queued.transitions ?? []), ...(incoming.transitions ?? [])]) {
        transitions.set(JSON.stringify([entry.id, entry.key, entry.head, entry.kind, entry.pulse]), entry)
    }

    return structuredClone({...latest, transitions: [...transitions.values()]})
}

/**
 * @summary Test the source observation at the current effect boundary, never at an earlier await.
 * @param {Object} state
 * @param {Number} now
 * @returns {Boolean}
 * @private
 */
function freshObservation(state, now) {
    return !!state?.snapshot?.rows && ['complete', 'partial'].includes(state.coverage) &&
        openWorkFreshness(state.observedAt, {now}) === 'ok'
}

/**
 * @summary An open action also needs its own row's fresh evidence; a terminal action needs the producer.
 * @param {Object} wake
 * @param {Object} state
 * @param {Number} now
 * @returns {Boolean}
 * @private
 */
function freshWake(wake, state, now) {
    return freshObservation(state, now) && (wake.kind === 'post-merge' ||
        openWorkFreshness(state.snapshot.rows[wake.pr]?.observedAt, {now}) === 'ok')
}

/**
 * @summary Create one serial post-pulse consumer. Route skips remain pending; admission is persisted
 * before any sender call. Freshness is checked after route/persistence waits and before each send;
 * an expired reservation remains admitted but sends nothing. stop() refuses new work, drops queued
 * work and awaits the active round.
 * @param {Object} options
 * @param {{load: Function, save: Function}} options.store Durable ledger; only absence returns null.
 * @param {Function} options.sendMessage Same verified plane's sender, injected by the entrypoint.
 * @param {Function} [options.readUndeliverable] Seat-to-nullable-reason map; membership means unreachable.
 *     An unreadable or absent whole map means unknown.
 * @param {Function} [options.now] Epoch milliseconds.
 * @param {Number} [options.routesTtlMs] Short cache duration for the existing route read.
 * @param {Function} [options.gateOf] Test seam; production uses wakeGateOf's measured observation gate.
 * @param {Object} [options.log] Bounded diagnostics; sender error contents are never logged.
 * @returns {Function} Post-pulse callback with an async stop() method; persistence errors reject.
 */
export function createOpenWorkWakeRound({store, sendMessage, readUndeliverable = async () => null,
    now = Date.now, routesTtlMs = ROUTES_TTL_MS, gateOf = wakeGateOf, log = console}) {
    let running = null, queued = null, stopped = false, routes = null;

    /** @summary Read the existing route projection only when a plan has eligible work. */
    async function routeMap() {
        const time = now();
        if (!routes || time < routes.at || time - routes.at >= routesTtlMs) {
            let map;
            try { map = await readUndeliverable() } catch { map = null }
            routes = {at: time, map: map && typeof map === 'object' && !Array.isArray(map) &&
                Object.values(map).every(reason => reason === null || typeof reason === 'string') ? map : null}
        }
        return routes.map
    }

    /** @summary Plan one fresh observation or retry its still-pending routes, then reserve before effects. */
    async function run(state) {
        const stored = await store.load();
        validateLedger(stored);
        const time = now();
        // Evidence refusal is not a quiet-policy baseline: pending routes must survive source loss.
        if (!freshObservation(state, time)) return {admitted: 0};
        const pending = stored && (Object.values(stored.holding).some(entry => entry.status === 'pending') ||
            Object.keys(stored.pendingMerges).length > 0);

        if (stored && (Date.parse(state?.observedAt) < Date.parse(stored.pulse) ||
            state?.observedAt === stored.pulse && !pending)) return {admitted: 0};

        const first = Date.parse(state?.pulses?.[0]?.at),
            ledger  = stored && Number.isFinite(first) && Date.parse(stored.pulse) < first ? null : stored,
            args    = {state, ledger};
        let gate    = gateOf(state, {now: time}),
            plan    = planOpenWorkWakes({...args, now: time, quiet: !gate.holds}),
            expired = 0;

        if (plan.wakes.length) {
            const map = await routeMap(), preparedAt = now();
            expired = plan.wakes.filter(wake => !freshWake(wake, state, preparedAt)).length;
            if (!freshObservation(state, preparedAt)) return {admitted: 0, expired};
            gate = gateOf(state, {now: preparedAt});
            plan = planOpenWorkWakes({...args, now: preparedAt, quiet: !gate.holds, routeOf: seat =>
                map && Object.hasOwn(map, seat) ? 'unreachable' : 'unknown'})
        }

        if (!plan.ledger || JSON.stringify(plan.ledger) === JSON.stringify(stored)) return {admitted: 0, expired};
        await store.save(plan.ledger);

        let sendErrors = 0;
        for (const wake of plan.wakes) {
            if (!freshWake(wake, state, now())) {
                expired++;
                continue
            }
            try { await sendMessage(wakeMessageOf(wake)) } catch {
                sendErrors++;
                log.error?.('[fleet] open-work wake attempt failed or is ambiguous; admission retained',
                    {pr: wake.pr.slice(0, 160), kind: wake.kind.slice(0, 40)})
            }
        }

        return {admitted: plan.wakes.length, expired, sendErrors, quiet: !gate.holds, reason: gate.reason}
    }

    /** @summary Consume the latest queued observation after the active send settles, without overlap. */
    const onPulse = state => {
        if (stopped) return Promise.resolve({admitted: 0, stopped: true});
        queued = queueObservation(queued, state);
        if (!running) {
            running = (async () => {
                let result;
                while (queued && !stopped) {
                    const next = queued;
                    queued = null;
                    result = await run(next)
                }
                return result
            })().finally(() => { running = null })
        }
        return running
    };

    /** @summary Let the entrypoint await the active sender before closing its verified plane client. */
    onPulse.stop = () => {
        stopped = true;
        queued = null;
        return running ?? Promise.resolve()
    };

    return onPulse
}

/**
 * @summary Bind the existing producer callback to a ledger beside its state file; never start a poller.
 * @param {Object} options
 * @param {{getDataDir: Function}} options.registry Fleet-owned durable root.
 * @param {Function} options.sendMessage Already verified same-plane sender.
 * @param {Function} [options.readUndeliverable]
 * @param {Function} [options.now]
 * @param {Function} [options.gateOf] Test seam only.
 * @param {Object} [options.log]
 * @returns {Function|null} onPulse with stop(), or null without the required registry/sender.
 */
export function wireFleetOpenWorkWakes({registry, sendMessage, readUndeliverable, now, gateOf, log} = {}) {
    if (typeof registry?.getDataDir !== 'function' || typeof sendMessage !== 'function') return null;
    return createOpenWorkWakeRound({
        store: fileStore(path.join(registry.getDataDir(), 'open-work-wakes.json')),
        sendMessage, readUndeliverable, now, gateOf, log
    })
}

export default wireFleetOpenWorkWakes;

/**
 * @module ai/services/fleet/wireFleetOpenWorkWakes
 * @summary The wake path's sending half: after each open-work pulse, plan a round
 * ({@link module:ai/services/fleet/openWorkWakes}), write the ledger, then send each wake as a
 * task-bearing message from the viewer the plane verified at boot. The entrypoint decides whether it
 * runs at all; this module reads no config.
 *
 * A round plans only an observation it has not planned (`ledger.pulse`), so a failed pulse, which
 * keeps the last observation, sends nothing twice. The ledger is written before the first send, and a
 * failed send is logged, never retried: whether it landed is unknown, and a doubled wake costs a turn
 * while a lost one is caught by the next holder change. A ledger file that exists but cannot be read
 * stops every round, so it is never overwritten and never mistaken for a first round; one older than
 * the producer's retained day (the path was switched off) is replaced by a baseline, so switching it
 * back on wakes no backlog.
 *
 * Routes are read only when a round has a wake to send: `who_is_online`'s `undeliverable` map names
 * the seats no wake reaches, and is absent when the receiver's records cannot be read, so absence
 * never reads reachable. That map is per seat, so it can skip a dead route but never certifies that a
 * particular wake was delivered.
 */

import path                            from 'path';
import {fileStore, githubSlugsOf}       from './wireFleetOpenWorkSource.mjs';
import {planOpenWorkWakes, wakeGateOf}  from './openWorkWakes.mjs';

/**
 * @summary How long one routes answer serves the rounds after it.
 * @type {Number}
 */
const ROUTES_TTL_MS = 5 * 60 * 1000;

/**
 * @summary The seats that work on a repository: each definition whose working or other
 * repositories include it, as `@<githubUsername>`.
 * @param {Function} listDefinitions `() → Object[]`, read at each lookup.
 * @returns {Function} `(repo) → String[]`.
 */
export function seatsForRepoOf(listDefinitions) {
    return repo => listDefinitions()
        .filter(definition => definition.githubUsername && githubSlugsOf([definition]).includes(repo))
        .map(definition => `@${String(definition.githubUsername).replace(/^@/, '')}`)
}

/**
 * @summary One wake as an `add_message` payload. The task block names the producer and the holding,
 * and makes the message wake by construction: the mailbox never suppresses a direct task message.
 * @param {Object} wake A planned wake.
 * @returns {Object}
 */
export function wakeMessageOf(wake) {
    const head = String(wake.head ?? '').slice(0, 7);

    return {
        to            : wake.to,
        subject       : `[open-work] ${wake.pr}: ${wake.reason}`,
        body          : `https://github.com/${wake.repo}/pull/${wake.number} (head ${head}): ${wake.reason}.\n\n` +
            'The Fleet\'s open-work producer sends this once each time you start holding this pull request\'s next action.',
        relatedTickets: [wake.pr],
        task          : {id: `open-work:${wake.key}@${head}`, state: 'Submitted'}
    }
}

/**
 * @summary Create the round the producer runs after each pulse. A round asked for while one runs is
 * skipped: the next one plans everything observed since the ledger's last pulse.
 * @param {Object}   options
 * @param {{load: Function, save: Function}} options.store The ledger; `load` answers null for none and throws for one it cannot read.
 * @param {Function} options.send `(message) → Promise`, an `add_message` call.
 * @param {Function} options.seatsForRepo `(repo) → String[]`.
 * @param {Function} [options.readUndeliverable] `() → Promise<Object|null>`: seat → reason, or null when unknown.
 * @param {Function} [options.now] Epoch milliseconds.
 * @param {Number}   [options.routesTtlMs]
 * @param {Object}   [options.log]
 * @returns {Function} `(state) → Promise<void>`, never rejecting.
 */
export function createOpenWorkWakeRound({store, send, seatsForRepo, readUndeliverable = async () => null, now = Date.now, routesTtlMs = ROUTES_TTL_MS, log = console}) {
    let running = null, routes = null;

    const undeliverable = async () => {
        if (!routes || now() - routes.at >= routesTtlMs) {
            routes = {at: now(), map: await readUndeliverable().catch(() => null)}
        }

        return routes.map
    };

    async function run(state) {
        const stored = store.load();

        if (!state?.snapshot || !state.observedAt || stored?.pulse >= state.observedAt) return;

        const
            at     = now(),
            // a ledger the retained day no longer reaches was switched off: it baselines again
            ledger = stored && stored.pulse >= state.pulses?.[0]?.at ? stored : null,
            gate   = wakeGateOf(state.pulses),
            args   = {
                snapshot   : state.snapshot,
                transitions: state.transitions.filter(transition => !ledger || transition.pulse > ledger.pulse),
                ledger,
                now        : at,
                seatsForRepo,
                quiet      : !gate.holds
            };
        let plan = planOpenWorkWakes(args);

        if (plan.wakes.length) {
            const map = await undeliverable();

            plan = planOpenWorkWakes({...args, routeOf: seat => !map ? 'unknown' : Object.hasOwn(map, seat) ? 'unreachable' : 'reachable'})
        }

        stored?.gate?.holds === gate.holds || log.info(`[fleet] open-work wakes ${gate.holds ? 'switched on' : `stay quiet: ${gate.reason}`}`);

        store.save({...plan.ledger, pulse: state.observedAt, gate});

        for (const wake of plan.wakes) {
            await send(wakeMessageOf(wake)).catch(error => log.error(`[fleet] open-work wake to ${wake.to} on ${wake.pr} failed:`, error?.message ?? error))
        }
    }

    return state => running ??= run(state)
        .catch(error => log.error('[fleet] open-work wake round failed:', error?.message ?? error))
        .finally(() => { running = null })
}

/**
 * @summary The round for a Fleet server: its ledger beside the producer's state file, and the
 * rotation's seats from the registry.
 * @param {Object}   options
 * @param {{listAgents: Function, getDataDir: Function}} options.registry
 * @param {Function} options.send
 * @param {Function} [options.readUndeliverable]
 * @returns {Function|null} The `onPulse` round, or null without a registry or a sender.
 */
export function wireFleetOpenWorkWakes({registry, send, readUndeliverable} = {}) {
    if (typeof registry?.listAgents !== 'function' || typeof registry.getDataDir !== 'function' || typeof send !== 'function') {
        return null
    }

    return createOpenWorkWakeRound({
        store       : fileStore(path.join(registry.getDataDir(), 'open-work-wakes.json')),
        send,
        seatsForRepo: seatsForRepoOf(() => registry.listAgents()),
        ...(readUndeliverable ? {readUndeliverable} : {})
    })
}

export default wireFleetOpenWorkWakes;

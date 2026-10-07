/**
 * @module ai/services/fleet/wireFleetOpenWorkSource
 * @summary Wire the open-work producer into a Fleet server: each seat's GitHub reads with that seat's
 * own PAT, the repositories the registry's seats work on, the seat identities, a state file beside
 * the registry, the pulse cadence, and the bridge's `fleetOpenWork` source.
 *
 * A seat's PAT comes from the Fleet's credential store (`resolveCredential`), the credential ledger's
 * declared observe read. A token the entrypoint passes in (the process's `GH_TOKEN`-class environment) is the
 * explicit override for headless and dev runs: every seat then reads with it. A seat without a
 * readable PAT still wires, and the pulse names it with its next step.
 *
 * A login resolves to a seat from the registry first (`@<githubUsername>`), then from `identityRoots`,
 * so another operator's seats resolve from their own registry. The PR body's social name resolves
 * through `identityRoots`.
 *
 * A seat's participation is its identity node's, read through the roster's presence read: a benched
 * seat owes the pulse no coverage.
 */

import fs                                          from 'fs';
import path                                        from 'path';
import FleetControlBridge                          from './FleetControlBridge.mjs';
import {IDENTITIES}                                from '../../graph/identityRoots.mjs';
import {createFleetOpenWorkSource}                 from './fleetOpenWorkSource.mjs';
import {createOpenWorkProducer}                    from './openWorkProducer.mjs';
import {participationOf, presenceIdentityForAgent} from './fleetPresenceStateAdapter.mjs';
import {writeFileAtomicSync}                       from '../shared/atomicFileWrite.mjs';

/** @summary The pulse cadence: one search a minute stays far inside GitHub's GraphQL budget. */
const PULSE_MS = 60 * 1000;

/**
 * @summary Resolve a social name (through `roots`) or a login (the registry's seats, then `roots`) to a seat.
 * @param {Function} listDefinitions `() → Object[]`, read at each lookup.
 * @param {Object[]} [roots=IDENTITIES]
 * @returns {{byName: Function, byLogin: Function}}
 */
export function seatIdentities(listDefinitions, roots = IDENTITIES) {
    const bare = login => String(login ?? '').replace(/^@/, '');

    return {
        byName : name  => roots.find(root => root.name === name)?.id ?? null,
        byLogin: login => listDefinitions().some(definition => bare(definition.githubUsername) === login)
            ? `@${login}`
            : roots.find(root => bare(root.properties?.githubLogin) === login)?.id ?? null
    }
}

/**
 * @summary The GitHub repositories the seats work on: each working repository and other repository
 * without a non-GitHub `forge`.
 * @param {Object[]} definitions
 * @returns {String[]} `owner/repo` slugs.
 */
export function githubSlugsOf(definitions) {
    return definitions.flatMap(({metadata}) => [metadata?.repo, ...(metadata?.repos ?? [])])
        .filter(repo => repo?.repoSlug && (repo.forge ?? 'github') === 'github')
        .map(repo => repo.repoSlug)
}

/**
 * @summary The identities whose node records the operator's bench. A read that fails, or a row that
 * names no status, benches no one, so participation nobody could read stays owed.
 * @param {Function|null} readPresence `() → Promise<{agents: Object[]}>`, the `who_is_online` read.
 * @returns {Promise<Set<String>>} `@<login>` identities.
 */
export async function benchedIdentities(readPresence) {
    try {
        const {agents} = await readPresence?.() ?? {};

        return new Set((Array.isArray(agents) ? agents : [])
            .filter(row => participationOf(row).status === 'operator_benched')
            .map(row => row.identity))
    } catch {
        return new Set()
    }
}

/**
 * @summary The seats that read GitHub, each with its own GraphQL call: every GitHub seat in the
 * registry, reading with its PAT from the Fleet's credential store, or with the override when the
 * entrypoint passed one. A seat without either reads nothing, and its `query` is null.
 * @param {Object}   options
 * @param {Function} options.listDefinitions   `() → Object[]`, the registry's definitions.
 * @param {Function} options.resolveCredential `(agentId) → String|null`, the seat's PAT.
 * @param {String|null} [options.override]     The headless/dev token every seat then reads with.
 * @param {Function} [options.createQuery]     `(token) → query`; the GitHub call by default.
 * @param {Function|null} [options.readPresence] The `who_is_online` read ({@link benchedIdentities}), each pulse.
 * @returns {Function} `() → Promise<{seat: String, login: String, query: Function|null, benched: Boolean}[]>`
 */
export function seatReaders({listDefinitions, resolveCredential, override = null, createQuery = token => createGithubGraphqlQuery({token}), readPresence = null}) {
    return async () => {
        const benched = await benchedIdentities(readPresence);

        return listDefinitions()
            .filter(definition => definition.githubUsername && (definition.forge ?? 'github') === 'github')
            .map(definition => {
                const
                    login = String(definition.githubUsername).replace(/^@/, ''),
                    token = override || resolveCredential(definition.id);

                return {seat: `@${login}`, login, query: token ? createQuery(token) : null, benched: benched.has(presenceIdentityForAgent(definition))}
            })
    }
}

/**
 * @summary One GitHub GraphQL call. A missing token, an HTTP failure or a GraphQL error throws, and
 * the producer records it as a failed read. An HTTP failure carries its `status`, so a refused PAT
 * (401) is told apart from a read that may pass on the next pulse.
 * @param {Object}   options
 * @param {String|null} options.token
 * @param {Function} [options.fetchImpl]
 * @param {String}   [options.apiBase]
 * @param {Number}   [options.timeoutMs]
 * @returns {Function} `(query, variables) → Promise<data>`.
 */
export function createGithubGraphqlQuery({token, fetchImpl = globalThis.fetch, apiBase = 'https://api.github.com', timeoutMs = 30000}) {
    return async (query, variables) => {
        if (!token) throw new Error('no GitHub token for this read');

        const
            response = await fetchImpl(`${apiBase}/graphql`, {
                method : 'POST',
                headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
                body   : JSON.stringify({query, variables}),
                signal : AbortSignal.timeout(timeoutMs)
            }),
            payload  = await response.json().catch(() => null);

        if (!response.ok || payload?.errors?.length || !payload?.data) {
            throw Object.assign(new Error(`GitHub GraphQL answered ${response.status}: ${payload?.errors?.[0]?.message ?? 'no data'}`), {status: response.status})
        }

        return payload.data
    }
}

/**
 * @summary The producer's state as one JSON file, written atomically. Only an absent file is a first
 * pulse; a file that exists but cannot be read or parsed throws, so its history is never overwritten.
 * @param {String} filePath
 * @returns {{load: Function, save: Function}}
 */
export function fileStore(filePath) {
    return {
        load() {
            let text;

            try {
                text = fs.readFileSync(filePath, 'utf8')
            } catch (error) {
                if (error.code === 'ENOENT') return null;
                throw error
            }

            return JSON.parse(text)
        },
        save: state => writeFileAtomicSync(filePath, JSON.stringify(state))
    }
}

/**
 * @summary Wire the producer and the bridge's source, take the first pulse, and keep pulsing.
 * @param {Object}   options
 * @param {String|null} [options.token]   The headless/dev override the entrypoint resolved from its
 *     environment; every seat reads with it. Null on an installed Fleet, where each seat reads with its own PAT.
 * @param {{listAgents: Function, getDataDir: Function, resolveCredential: Function}} options.registry
 * @param {Number}   [options.pulseMs]
 * @param {Object}   [options.bridge]
 * @param {Function} [options.query]      Replaces every seat's GitHub call, credential included (tests).
 * @param {Function} [options.createQuery] `(token) → query`; replaces the GitHub call per token (tests).
 * @param {Function} [options.readPresence] The roster's `who_is_online` read; without it no seat is benched.
 * @param {Function} [options.now]
 * @returns {{producer: Object, source: Object, stop: Function}|null} null without a registry.
 */
export function wireFleetOpenWorkSource({token = null, registry, pulseMs = PULSE_MS, bridge = FleetControlBridge, query, createQuery, readPresence = null, now} = {}) {
    if (typeof registry?.listAgents !== 'function' || typeof registry.getDataDir !== 'function') {
        return null
    }

    const
        listDefinitions = () => registry.listAgents(),
        producer        = createOpenWorkProducer({
            readers   : seatReaders({
                listDefinitions,
                resolveCredential: id => query ? 'injected' : registry.resolveCredential?.(id) ?? null,
                override         : token,
                readPresence,
                ...(query ? {createQuery: () => query} : createQuery ? {createQuery} : {})
            }),
            repos     : async () => githubSlugsOf(listDefinitions()),
            identities: seatIdentities(listDefinitions),
            store     : fileStore(path.join(registry.getDataDir(), 'open-work.json')),
            ...(now ? {now} : {})
        }),
        pulse           = () => producer.pulse().catch(error => console.error('[fleet] open-work pulse failed:', error)),
        timer           = setInterval(pulse, pulseMs);

    timer.unref?.();
    bridge.openWorkSource = createFleetOpenWorkSource({producer});
    pulse();

    return {producer, source: bridge.openWorkSource, stop: () => clearInterval(timer)}
}

export default wireFleetOpenWorkSource;

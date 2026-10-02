/**
 * @module ai/services/fleet/wireFleetOpenWorkSource
 * @summary Wire the open-work producer into a Fleet server: its GitHub reads, the repositories the
 * registry's seats work on, the seat identities, a state file beside the registry, the pulse cadence,
 * and the bridge's `fleetOpenWork` source.
 *
 * A login resolves to a seat from the registry first (`@<githubUsername>`), then from `identityRoots`,
 * so another operator's seats resolve from their own registry. The PR body's social name resolves
 * through `identityRoots`. A server without a GitHub token still wires: every pulse answers its reason.
 */

import fs                          from 'fs';
import path                        from 'path';
import FleetControlBridge          from './FleetControlBridge.mjs';
import {IDENTITIES}                from '../../graph/identityRoots.mjs';
import {createFleetOpenWorkSource} from './fleetOpenWorkSource.mjs';
import {createOpenWorkProducer}    from './openWorkProducer.mjs';
import {writeFileAtomicSync}       from '../shared/atomicFileWrite.mjs';

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
 * @summary One GitHub GraphQL call. A missing token, an HTTP failure or a GraphQL error throws, and
 * the producer records it as a failed read.
 * @param {Object}   options
 * @param {String|null} options.token
 * @param {Function} [options.fetchImpl]
 * @param {String}   [options.apiBase]
 * @param {Number}   [options.timeoutMs]
 * @returns {Function} `(query, variables) → Promise<data>`.
 */
export function createGithubGraphqlQuery({token, fetchImpl = globalThis.fetch, apiBase = 'https://api.github.com', timeoutMs = 30000}) {
    return async (query, variables) => {
        if (!token) throw new Error('no GitHub token: the Fleet server reads GH_TOKEN or GITHUB_TOKEN');

        const
            response = await fetchImpl(`${apiBase}/graphql`, {
                method : 'POST',
                headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
                body   : JSON.stringify({query, variables}),
                signal : AbortSignal.timeout(timeoutMs)
            }),
            payload  = await response.json().catch(() => null);

        if (!response.ok || payload?.errors?.length || !payload?.data) {
            throw new Error(`GitHub GraphQL answered ${response.status}: ${payload?.errors?.[0]?.message ?? 'no data'}`)
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
 * @param {String|null} options.token     The GitHub token the entrypoint resolved.
 * @param {{listAgents: Function, getDataDir: Function}} options.registry
 * @param {Number}   [options.pulseMs]
 * @param {Object}   [options.bridge]
 * @param {Function} [options.query]      Replaces the GitHub call (tests).
 * @param {Function} [options.now]
 * @returns {{producer: Object, source: Object, stop: Function}|null} null without a registry.
 */
export function wireFleetOpenWorkSource({token, registry, pulseMs = PULSE_MS, bridge = FleetControlBridge, query, now} = {}) {
    if (typeof registry?.listAgents !== 'function' || typeof registry.getDataDir !== 'function') {
        return null
    }

    const
        listDefinitions = () => registry.listAgents(),
        producer        = createOpenWorkProducer({
            query     : query ?? createGithubGraphqlQuery({token}),
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

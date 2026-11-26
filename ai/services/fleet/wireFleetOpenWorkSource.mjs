/**
 * @module ai/services/fleet/wireFleetOpenWorkSource
 * @summary Wire the open-work producer into a Fleet server: each seat's GitHub reads with that seat's
 * own PAT, the repositories the registry's seats work on, the seat identities, a state file beside
 * the registry, the pulse cadence, and the bridge's `fleetOpenWork` source.
 *
 * A seat's PAT comes from the Fleet's credential store (`resolveCredential`), the credential ledger's
 * declared observe read. No process-wide token reads for every seat: it would charge every seat's
 * reads to one account's quota. A seat without a readable PAT still wires, and the pulse names it
 * with its next step.
 *
 * A login resolves to a seat from the registry first (`@<githubUsername>`), then from the plane's
 * identity rows, so another operator's seats resolve from their own registry and plane. The PR body's
 * social name resolves through the same rows.
 *
 * A seat's participation is its identity node's, read through the roster's presence read: a benched
 * seat owes the pulse no coverage. That one read per pulse also supplies the identity rows.
 */

import fs                                                       from 'fs';
import path                                                     from 'path';
import AiConfig                                                 from '../../config.mjs';
import boundRosterRead                                          from './boundRosterRead.mjs';
import FleetControlBridge                                       from './FleetControlBridge.mjs';
import {createFleetOpenWorkSource}                              from './fleetOpenWorkSource.mjs';
import {createOpenWorkProducer}                                 from './openWorkProducer.mjs';
import {participationOf, presenceIdentityForAgent}              from './fleetPresenceStateAdapter.mjs';
import {attachCredentialRefusal, classifyHttpCredentialRefusal} from './seatGitIdentity.mjs';
import {writeFileAtomicSync}                                    from '../shared/atomicFileWrite.mjs';

/** @summary The existing pulse cadence; measured quota evidence determines whether it fits each issuer. */
const PULSE_MS = 60 * 1000;

/**
 * @summary Resolve a social name (through the plane's identity rows) or a login (the registry's seats, then the
 * rows) to a seat. Distinct identities may carry one name, so a shared name resolves only to the one whose
 * handle is the author's login; row order is no evidence of authorship.
 * @param {Function} listDefinitions `() → Object[]`, read at each lookup.
 * @param {Function} [identityRows] `() → Object[]|null`: the plane's `who_is_online` rows (`{identity, name}`), or `null` when unanswered.
 * @returns {{complete: Function, byName: Function, byLogin: Function}} `complete()`, `byName(name, login)` and `byLogin(login)`
 */
export function seatIdentities(listDefinitions, identityRows = () => []) {
    const
        bare = login => String(login ?? '').replace(/^@/, ''),
        rows = () => {
            const current = identityRows();

            return Array.isArray(current) ? current : null
        };

    return {
        complete: () => rows() !== null,
        byName  : (name, login) => {
            const current = rows();

            if (!current) return null;

            const seats = [...new Set(current.filter(row => row.name === name).map(row => row.identity).filter(Boolean))];

            return seats.length === 1 ? seats[0] : seats.find(seat => bare(seat) === login) ?? null
        },
        byLogin : login => listDefinitions().some(definition => bare(definition.githubUsername) === login)
            ? `@${login}`
            : rows()?.find(row => bare(row.identity) === login)?.identity ?? null
    }
}

/**
 * @summary Each seat's model family, from the verbose presence answer whose rows carry the plane's identity facts.
 * A row without a family is left out, so its seat stays eligible for a pick and verifies no approval. The open-work
 * projection and the wake round both decide with it, so they agree on whose turn a pull request is.
 * @param {Object} presence The verbose `who_is_online` answer.
 * @returns {Object<String,String>|null} Seat to family; `null` when the answer holds no rows.
 */
export function familiesOf(presence) {
    if (!Array.isArray(presence?.agents)) return null;

    return Object.fromEntries(presence.agents
        .filter(row => typeof row?.identity === 'string' && typeof row.family === 'string' && row.family.length > 0)
        .map(row => [row.identity, row.family]))
}

/**
 * @summary The seats the Fleet's verbose presence answer shows no sign of acting: presence `dark`, and a wake that is
 * not `reachable`, since a receiver whose route lands can open a dark seat's session. Empty when unreadable. The
 * projection and the wake round both read it, so a dark author's PR holds no place in either one's merge line.
 * @param {Object|null} presence A verbose `who_is_online` payload: `{agents: [{identity, state, wake: {state}}]}`.
 * @returns {String[]}
 */
export function absentOf(presence) {
    const rows = Array.isArray(presence?.agents) ? presence.agents : [];

    return rows.filter(row => typeof row?.identity === 'string' && row.state === 'dark' && row.wake?.state !== 'reachable')
        .map(row => row.identity)
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
 * registry, reading with its PAT from the Fleet's credential store. A seat without one reads
 * nothing, and its `query` is null.
 * @param {Object}   options
 * @param {Function} options.listDefinitions   `() → Object[]`, the registry's definitions.
 * @param {Function} options.resolveCredential `(agentId) → String|null`, the seat's PAT.
 * @param {String} [options.apiBase] The endpoint represented by each reader's quota observations.
 * @param {Function} [options.createQuery]     `(token) → query`; the GitHub call by default.
 * @param {Function|null} [options.readPresence] The `who_is_online` read ({@link benchedIdentities}), each pulse.
 * @returns {Function} `() → Promise<{seat: String, login: String, apiBase: String, query: Function|null, benched: Boolean}[]>`
 */
export function seatReaders({listDefinitions, resolveCredential, apiBase = 'https://api.github.com', createQuery = token => createGithubGraphqlQuery({token, apiBase}), readPresence = null}) {
    return async () => {
        const
            benched = await benchedIdentities(readPresence),
            queries = new Map();

        return listDefinitions()
            .filter(definition => definition.githubUsername && (definition.forge ?? 'github') === 'github')
            .map(definition => {
                const
                    login = String(definition.githubUsername).replace(/^@/, ''),
                    token = resolveCredential(definition.id);
                let query = null;

                if (token) {
                    query = queries.get(token);
                    if (!query) {
                        query = createQuery(token);
                        queries.set(token, query)
                    }
                }

                return {seat: `@${login}`, login, apiBase, query, benched: benched.has(presenceIdentityForAgent(definition))}
            })
    }
}

const TOKEN_EXPIRATION_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\s*(?:(UTC|Z)|([+-])(\d{2}):?(\d{2}))$/i;

/**
 * @summary Read a header case-insensitively from a Fetch `Headers` instance or a plain object fixture.
 * @param {Object|null} headers
 * @param {String}      name
 * @returns {String|null}
 * @private
 */
function readHeader(headers, name) {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(name);
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === target) return typeof value === 'string' ? value : null
    }
    return null
}

/**
 * @summary Parse GitHub's `GitHub-Authentication-Token-Expiration` response header into an ISO-8601 UTC string,
 * accepting `YYYY-MM-DD HH:MM:SS UTC`, `YYYY-MM-DD HH:MM:SS ±HHMM`, and ISO-8601 UTC defensively and returning
 * `null` for anything else (absent or unparseable, never a guessed date).
 * @param {*} raw
 * @returns {String|null}
 */
export function parseGithubTokenExpiration(raw) {
    if (typeof raw !== 'string') return null;
    const match = raw.trim().match(TOKEN_EXPIRATION_PATTERN);
    if (!match) return null;

    const
        year       = Number(match[1]),
        month      = Number(match[2]),
        day        = Number(match[3]),
        hour       = Number(match[4]),
        minute     = Number(match[5]),
        second     = Number(match[6]),
        ms         = match[7] ? Number(match[7].padEnd(3, '0')) : 0,
        sign       = match[9] ?? null,
        offHours   = sign ? Number(match[10]) : 0,
        offMinutes = sign ? Number(match[11]) : 0;

    if (offHours > 23 || offMinutes > 59) return null;

    const
        baseUtcMs = Date.UTC(year, month - 1, day, hour, minute, second, ms),
        check     = new Date(baseUtcMs);

    if (
        !Number.isFinite(baseUtcMs) ||
        check.getUTCFullYear() !== year ||
        check.getUTCMonth() !== month - 1 ||
        check.getUTCDate() !== day ||
        check.getUTCHours() !== hour ||
        check.getUTCMinutes() !== minute ||
        check.getUTCSeconds() !== second
    ) {
        return null
    }

    const offsetMs = sign ? (sign === '+' ? 1 : -1) * (offHours * 60 + offMinutes) * 60000 : 0;
    return new Date(baseUtcMs - offsetMs).toISOString()
}

/**
 * @summary One GitHub GraphQL call. A missing token, an HTTP failure or a GraphQL error throws, and
 * the producer records it as a failed read. The error carries its HTTP `status`, GitHub's error
 * `type` as `code`, and a wire-classified `credentialRefusal` (`attachCredentialRefusal`), while
 * answered `data` carries a non-enumerable `tokenExpiresAt` ISO-8601 string (`null` when the token
 * has no expiry or an unparseable header).
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
            const
                value = name => {
                    const raw = readHeader(response.headers, name);
                    return raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
                },
                rate                  = payload?.data?.rateLimit,
                reset                 = value('x-ratelimit-reset'),
                quota                 = {viewer: {id: payload?.data?.viewer?.id ?? null}, rateLimit: {
                    cost     : Number.isFinite(rate?.cost) ? rate.cost : null,
                    limit    : rate?.limit ?? value('x-ratelimit-limit'),
                    remaining: rate?.remaining ?? value('x-ratelimit-remaining'),
                    resetAt  : rate?.resetAt ?? (reset !== null && Number.isFinite(new Date(reset * 1000).getTime()) ? new Date(reset * 1000).toISOString() : null)
                }},
                detailText            = payload?.errors?.[0]?.message
                    ?? (typeof payload?.message === 'string' && payload.message.trim() ? payload.message.trim() : null)
                    ?? 'no data',
                message               = `GitHub GraphQL answered ${response.status}: ${detailText}`,
                hasInsufficientScopes = Array.isArray(payload?.errors) &&
                    payload.errors.some(entry => entry?.type === 'INSUFFICIENT_SCOPES'),
                classified            = hasInsufficientScopes
                    ? {cause: 'insufficient-capability', verdict: 'refused', status: response.status}
                    : !response.ok
                        ? classifyHttpCredentialRefusal({status: response.status, headers: response.headers, body: payload})
                        : {cause: 'transport-unavailable', verdict: 'unanswered', status: response.status};

            throw attachCredentialRefusal(
                Object.assign(
                    new Error(message),
                    {
                        status : response.status,
                        code   : payload?.errors?.[0]?.type ?? null,
                        verdict: classified.verdict,
                        quota
                    }
                ),
                {
                    surface: 'forge',
                    cause  : classified.cause,
                    verdict: classified.verdict,
                    status : classified.status,
                    reason : message
                }
            )
        }

        Object.defineProperty(payload.data, 'tokenExpiresAt', {
            value       : parseGithubTokenExpiration(readHeader(response.headers, 'github-authentication-token-expiration')),
            enumerable  : false,
            configurable: true
        });

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
 * @param {{listAgents: Function, getDataDir: Function, resolveCredential: Function}} options.registry
 * @param {Number}   [options.pulseMs]
 * @param {Object}   [options.bridge]
 * @param {Function} [options.query]      Replaces every seat's GitHub call, credential included (tests).
 * @param {Function} [options.createQuery] `(token) → query`; replaces the GitHub call per token (tests).
 * @param {Function} [options.readPresence] The roster's `who_is_online` read; without it no seat is benched.
 * @param {Number}   [options.presenceTimeoutMs=AiConfig.fleet.rosterAxisTimeoutMs] Axis timeout bounding `readPresence` via {@link module:ai/services/fleet/boundRosterRead} so a slow plane serves retained presence while younger than `AiConfig.fleet.rosterRetainedMaxAgeMs`, and expires past it.
 * @param {Function} [options.now]
 * @param {String} [options.apiBase] Existing query endpoint, recorded with quota evidence.
 * @param {Function|null} [options.onPulse] Awaited after the existing pulse; concurrent rounds share it.
 * @returns {{producer: Object, source: Object, pulse: Function, stop: Function}|null} null without a registry.
 */
export function wireFleetOpenWorkSource({
    registry,
    pulseMs           = PULSE_MS,
    bridge            = FleetControlBridge,
    query,
    createQuery,
    readPresence      = null,
    presenceTimeoutMs = AiConfig.fleet.rosterAxisTimeoutMs,
    now,
    apiBase           = 'https://api.github.com',
    onPulse           = null
} = {}) {
    if (typeof registry?.listAgents !== 'function' || typeof registry.getDataDir !== 'function') {
        return null
    }

    // the pulse's presence read keeps its rows only while younger than `rosterRetainedMaxAgeMs`; a timeout or
    // failed read leaves valid retained rows in place so GitHub reads are never stalled behind mc-server
    let running = null, stopped = false, retainedPresence = null;
    const
        clock = typeof now === 'function' ? now : Date.now,
        nowMs = () => {
            const value = clock();

            return typeof value === 'number' ? value : new Date(value).getTime()
        },
        currentIdentityRows = () => !readPresence ? []
            : retainedPresence && nowMs() - retainedPresence.settledAtMs <= AiConfig.fleet.rosterRetainedMaxAgeMs
                ? retainedPresence.payload.agents
                : null,
        recordPresence      = (payload, settledAtMs = nowMs()) => {
            if (Array.isArray(payload?.agents)) {
                retainedPresence = {payload, settledAtMs}
            }
        },
        listDefinitions     = () => registry.listAgents(),
        readRows            = readPresence && (Number.isFinite(presenceTimeoutMs) && presenceTimeoutMs > 0
            ? boundRosterRead(readPresence, 'open-work presence', presenceTimeoutMs, {
                maxRetainedAgeMs: AiConfig.fleet.rosterRetainedMaxAgeMs,
                now             : clock,
                readRetained    : () => retainedPresence,
                writeRetained   : recordPresence
            })
            : async () => {
                const report = await readPresence();

                recordPresence(report);
                return report
            }),
        producer            = createOpenWorkProducer({
            readers   : seatReaders({
                listDefinitions,
                resolveCredential: id => query ? 'injected' : registry.resolveCredential?.(id) ?? null,
                apiBase,
                readPresence     : readRows,
                ...(query ? {createQuery: () => query} : createQuery ? {createQuery} : {})
            }),
            repos     : async () => githubSlugsOf(listDefinitions()),
            identities: seatIdentities(listDefinitions, currentIdentityRows),
            store     : fileStore(path.join(registry.getDataDir(), 'open-work.json')),
            intervalMs: pulseMs,
            ...(now ? {now} : {})
        }),
        pulse               = () => stopped ? (running ?? Promise.resolve(producer.getState())) :
            running ??= producer.pulse().then(async state => { await onPulse?.(state); return state })
                .catch(error => console.error('[fleet] open-work pulse failed:', error)).finally(() => { running = null }),
        timer               = setInterval(pulse, pulseMs);

    timer.unref?.();
    // the pulse's last unexpired presence rows give the projection the families and absent seats the wake round
    // decides with
    bridge.openWorkSource = createFleetOpenWorkSource({
        producer,
        ...(now ? {now: nowMs} : {}),
        seatFamilies: () => {
            const rows = currentIdentityRows();

            return rows?.length ? familiesOf({agents: rows}) : null
        },
        absentSeats: () => {
            const rows = currentIdentityRows();

            return rows?.length ? absentOf({agents: rows}) : null
        }
    });
    pulse();

    return {
        producer, source: bridge.openWorkSource, pulse,
        /** @summary Stops admission and awaits the existing pulse and callback before its dependencies close. */
        stop() {
            stopped = true;
            clearInterval(timer);
            return running ?? Promise.resolve(producer.getState())
        }
    }
}

export default wireFleetOpenWorkSource;

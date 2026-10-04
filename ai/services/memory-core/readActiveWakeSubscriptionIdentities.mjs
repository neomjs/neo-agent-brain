/**
 * @module ai/services/memory-core/readActiveWakeSubscriptionIdentities
 * @summary The trusted observation source for the fleet's wake axis: one bulk scan of
 * ACTIVE wake subscriptions, returning per-identity observations — administrative READ-observation
 * under the calling process's own authority, deliberately NOT the caller-owner management API
 * (which derives its owner from the request context and must never be impersonated).
 *
 * It lives beside the graph it reads: the memory-core owns WAKE_SUBSCRIPTION truth, and BOTH
 * consumers take the scan from here — the fleet dev-server's in-process mode (host plane, its own
 * graph handle) and the wake-subscription service's fleet-identities telemetry action (the
 * containerized plane, serving the same scan over MCP). One query, two processes, no second copy
 * free to drift.
 *
 * The observation is deliberately REDACTED to the fleet-disclosure class: the holder identity plus
 * the most recent observational `lastPollAt` across that identity's active subscriptions — a
 * timestamp only, never the client-held watermark, never endpoint/filter/key-adjacent row
 * properties. Owner-only material stays behind the caller-owner `list` action.
 *
 * The graph service loads lazily per call: the fleet server pays the memory-core import cost only
 * when a roster read actually needs wake truth, and a fresh scan per snapshot means no long-lived
 * cache to go stale. Any failure — import, init, scan — THROWS, and the wake adapter converts that
 * into honest per-row `unknown` under a degraded capability; this module never fabricates an empty
 * fleet.
 *
 * Durable-first by construction: the fleet server is a SEPARATE PROCESS from the MCP server that
 * writes subscriptions, so the graph's in-memory `nodes.items` cache holds only what THIS process
 * happened to load — a cross-process reader that trusts it would report a subscribed agent as
 * `off`, fabricating the exact blind-switch the S2 axis exists to catch. SQLite is the only shared
 * truth, so the durable query is the production path; the cache scan survives solely as an
 * injected-double seam for tests.
 */

import {
    activeWakeSubscriptionStatusSql,
    isActiveWakeSubscriptionStatus,
    resolvedWakeSubscriptionStatusSql,
    WAKE_SUBSCRIPTION_DEFAULT_STATUS
} from './wakeSubscriptionStatusPolicy.mjs';

/**
 * The status the sender writes when it withdraws a route (`WebhookDeliveryService#_markDegraded`).
 * @type {String}
 */
const WITHDRAWN_STATUS = 'degraded'

/**
 * The durable fleet-wide ACTIVE-subscription query. Mirrors the established WAKE_SUBSCRIPTION
 * durable read (`WakeSubscriptionService#_reconcileDuplicateSubscriptions`) minus its owner
 * predicate — this reader is fleet-wide by design. The status predicate is derived from the shared
 * policy rather than hand-written, so this SQL reader and the JS scan below cannot express
 * different meanings for a missing `status`.
 *
 * `MAX(lastPollAt)` aggregates the ISO-8601 stamp lexicographically — correct for UTC ISO strings
 * — and yields NULL for identities no poll has ever touched: absence stays absence.
 */
const ACTIVE_OBSERVATIONS_SQL = `
    SELECT json_extract(data, '$.properties.agentIdentity') AS agentIdentity,
           MAX(json_extract(data, '$.properties.lastPollAt')) AS lastPollAt
    FROM Nodes
    WHERE json_extract(data, '$.label') = 'WAKE_SUBSCRIPTION'
      AND ${activeWakeSubscriptionStatusSql()}
    GROUP BY agentIdentity
`

/**
 * The durable fleet-wide wake routes, one row per subscription and nothing aggregated: the join key
 * between an identity and the wake receiver's per-subscription dispatch records. A route is an
 * active subscription or one the sender withdrew, which its owner can resume; a retired row is no
 * route. `refusal` is the receiver's last refusal of the route, as the sender recorded it.
 */
const ROUTES_SQL = `
    SELECT id,
           json_extract(data, '$.properties.agentIdentity') AS agentIdentity,
           ${resolvedWakeSubscriptionStatusSql()} = '${WITHDRAWN_STATUS}' AS withdrawn,
           json_extract(data, '$.properties.lastRefusal') AS refusal
    FROM Nodes
    WHERE json_extract(data, '$.label') = 'WAKE_SUBSCRIPTION'
      AND ${resolvedWakeSubscriptionStatusSql()} IN ('${WAKE_SUBSCRIPTION_DEFAULT_STATUS}', '${WITHDRAWN_STATUS}')
`

/**
 * @summary The graph's two read surfaces, once its async init has settled: the durable SQLite handle
 * (production) and the in-process node cache (the test-double seam).
 * @param {Object|null} graphService
 * @returns {Promise<{sqlite: Object|undefined, items: Object[]|undefined}>}
 * @private
 */
async function graphReadSurfaces(graphService) {
    const service = graphService || (await import('./GraphService.mjs')).default

    // `db` is populated by async init, not by module import: reading it straight off the fresh
    // import yields undefined. `ready()` is the ONLY architecture-compliant external wait —
    // `core.Base` triggers `initAsync()` itself during `Neo.create()`, so awaiting that method from
    // out here would run it a second time (`src/core/Base.mjs`). Mirrors `WakeSubscriptionService`.
    await service.ready()

    return {sqlite: service.db?.storage?.db, items: service.db?.nodes?.items}
}

/**
 * @summary Scan the graph for ACTIVE wake subscriptions and return one redacted observation per
 * holder identity: `{identity, lastPollAt}` with `lastPollAt` null until an authenticated poll has
 * stamped one of that identity's subscriptions.
 * @param {Object} [options]
 * @param {Object} [options.graphService] Injectable service exposing `ready()` + `db`; defaults to
 *     the memory-core `GraphService` singleton, imported lazily.
 * @returns {Promise<Object[]>} `[{identity: String, lastPollAt: String|null}]` (deduplicated).
 * @throws {Error} When no read surface is reachable — the adapter maps this to honest `unknown`.
 */
export async function readActiveWakeSubscriptionObservations({graphService = null} = {}) {
    const {sqlite, items} = await graphReadSurfaces(graphService)

    if (sqlite) {
        return sqlite.prepare(ACTIVE_OBSERVATIONS_SQL)
            .all()
            .filter(row => typeof row.agentIdentity === 'string' && row.agentIdentity !== '')
            .map(row => ({
                identity  : row.agentIdentity,
                lastPollAt: typeof row.lastPollAt === 'string' && row.lastPollAt !== '' ? row.lastPollAt : null
            }))
    }

    // Test-double seam only: an injected service with no SQLite handle. Never the production path —
    // see the module note on cross-process cache truth.
    if (!items) {
        throw new Error('wake subscription scan: graph read surface unavailable')
    }

    const observations = new Map()

    for (const node of items) {
        if (node.label !== 'WAKE_SUBSCRIPTION') continue

        const props = node.properties || {}

        if (isActiveWakeSubscriptionStatus(props.status) && typeof props.agentIdentity === 'string' && props.agentIdentity !== '') {
            const
                held    = observations.get(props.agentIdentity) ?? null,
                stamped = typeof props.lastPollAt === 'string' && props.lastPollAt !== '' ? props.lastPollAt : null

            // The same MAX aggregation as the durable query: the most recent stamp across the
            // identity's active subscriptions wins; null never overwrites an observed stamp.
            observations.set(
                props.agentIdentity,
                held !== null && (stamped === null || held >= stamped) ? held : stamped
            )
        }
    }

    return [...observations].map(([identity, lastPollAt]) => ({identity, lastPollAt}))
}

/**
 * @summary The wake routes of every holder identity: what joins a roster row to the wake receiver's
 * per-subscription dispatch records, and what tells a seat whose every route was withdrawn from one
 * that never subscribed. Same durable-first rule as {@link readActiveWakeSubscriptionObservations}.
 * The routes serve the projection that reads them in-process; they are not part of the redacted
 * observation the fleet serves.
 * @param {Object} [options]
 * @param {Object} [options.graphService] Injectable service exposing `ready()` + `db`; defaults to
 *     the memory-core `GraphService` singleton, imported lazily.
 * @returns {Promise<Map<String, Object[]>>} identity → its routes, `{id, withdrawn, refusal}`.
 * @throws {Error} When no read surface is reachable.
 */
export async function readWakeRoutesByIdentity({graphService = null} = {}) {
    const
        {sqlite, items} = await graphReadSurfaces(graphService),
        byIdentity      = new Map(),
        add             = (identity, id, withdrawn, refusal) => {
            if (typeof identity === 'string' && identity !== '' && typeof id === 'string' && id !== '') {
                byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), {id, withdrawn: Boolean(withdrawn), refusal: refusal || null}])
            }
        }

    if (sqlite) {
        for (const row of sqlite.prepare(ROUTES_SQL).all()) add(row.agentIdentity, row.id, row.withdrawn, row.refusal)

        return byIdentity
    }

    // the test-double seam, as above
    if (!items) {
        throw new Error('wake subscription scan: graph read surface unavailable')
    }

    for (const node of items) {
        const status = node.properties?.status

        if (node.label === 'WAKE_SUBSCRIPTION' && (isActiveWakeSubscriptionStatus(status) || status === WITHDRAWN_STATUS)) {
            add(node.properties?.agentIdentity, node.id, status === WITHDRAWN_STATUS, node.properties?.lastRefusal)
        }
    }

    return byIdentity
}

/**
 * @summary Scan the graph for ACTIVE wake subscriptions and return their holder identities — the
 * membership-only projection of {@link readActiveWakeSubscriptionObservations}, kept for consumers
 * that need no recency.
 * @param {Object} [options]
 * @param {Object} [options.graphService] Injectable service exposing `ready()` + `db`; defaults to
 *     the memory-core `GraphService` singleton, imported lazily.
 * @returns {Promise<String[]>} The wake identities holding an active subscription (deduplicated).
 * @throws {Error} When no read surface is reachable — the adapter maps this to honest `unknown`.
 */
export async function readActiveWakeSubscriptionIdentities({graphService = null} = {}) {
    return (await readActiveWakeSubscriptionObservations({graphService})).map(observation => observation.identity)
}

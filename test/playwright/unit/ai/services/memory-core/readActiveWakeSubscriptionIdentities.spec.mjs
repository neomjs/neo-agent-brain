import {setup} from '../../../../setup.mjs'

const appName = 'ReadActiveWakeSubscriptionIdentitiesTest'

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
})

import {test, expect} from '@playwright/test'
import Database       from 'better-sqlite3'
import Neo            from 'neo.mjs/src/Neo.mjs'
import * as core      from 'neo.mjs/src/core/_export.mjs'

import {readActiveWakeSubscriptionIdentities,
        readActiveWakeSubscriptionObservations,
        readWakeRoutesByIdentity} from '../../../../../../ai/services/memory-core/readActiveWakeSubscriptionIdentities.mjs'

/**
 * Models the `core.Base` contract this reader depends on: `db` does NOT exist until async init has
 * settled, and `ready()` is the only sanctioned external wait — `initAsync()` is framework-triggered
 * and running it from outside would execute it twice. The double therefore exposes `ready()` ONLY,
 * so a reader that reaches for `initAsync()` fails loud here instead of duplicating init in prod.
 */
function graphServiceDouble({rows = null, items = null, initError = null} = {}) {
    let db = null

    const statements = []

    return {
        statements,
        async ready() {
            if (initError) throw new Error(initError)

            db = {
                // the rotate-route query answers no routes, so every seat's rotation reads none
                ...(rows  && {storage: {db: {prepare(sql) { statements.push(sql); return {all: () => sql.includes('SESSION_ROTATE') ? [] : rows} }}}}),
                ...(items && {nodes  : {items}})
            }
        },
        get db() { return db }
    }
}

test.describe('readActiveWakeSubscriptionIdentities — the fleet wake axis bulk read', () => {
    test('reads DURABLE SQLite truth, not the in-process node cache — the cross-process invariant', async () => {
        // The cache carries a stale/partial projection; SQLite carries shared truth. A fleet server
        // in its own process must report the latter, or a subscribed agent renders `off`.
        const service = graphServiceDouble({
            rows : [{agentIdentity: '@neo-opus-grace'}, {agentIdentity: '@neo-gpt'}],
            items: [{label: 'WAKE_SUBSCRIPTION', properties: {status: 'active', agentIdentity: '@stale-cache-only'}}]
        })

        const identities = await readActiveWakeSubscriptionIdentities({graphService: service})

        expect(identities).toEqual(['@neo-opus-grace', '@neo-gpt'])
        expect(identities).not.toContain('@stale-cache-only')
    })

    test('the durable query is scoped to ACTIVE wake subscriptions — the contract, not just the result', async () => {
        const service = graphServiceDouble({rows: []})

        await readActiveWakeSubscriptionIdentities({graphService: service})

        const [sql] = service.statements

        expect(sql).toContain("json_extract(data, '$.label') = 'WAKE_SUBSCRIPTION'")
        expect(sql).toContain("COALESCE(json_extract(data, '$.properties.status'), 'active') = 'active'")
    })

    test('awaits service readiness before reading db — the pre-init read surface is absent by contract', async () => {
        const service = graphServiceDouble({rows: [{agentIdentity: '@neo-opus-grace'}]})

        expect(service.db).toBe(null)

        await expect(readActiveWakeSubscriptionIdentities({graphService: service})).resolves.toEqual(['@neo-opus-grace'])
    })

    test('waits via ready(), NEVER initAsync() — the framework already ran it; a second run duplicates init', async () => {
        // `core.Base`: initAsync is triggered during Neo.create(). Awaiting it from a consumer runs
        // it twice — a fatal-duplication class the guard inside GraphService would quietly absorb,
        // which is precisely why this needs a pin rather than a passing test.
        const service = graphServiceDouble({rows: [{agentIdentity: '@neo-opus-grace'}]})

        let initAsyncCalls = 0

        service.initAsync = async () => { initAsyncCalls++ }

        await readActiveWakeSubscriptionIdentities({graphService: service})

        expect(initAsyncCalls).toBe(0)
    })

    test('malformed identities are dropped, never emitted as phantom subscribers', async () => {
        const service = graphServiceDouble({
            rows: [{agentIdentity: '@neo-opus-grace'}, {agentIdentity: null}, {agentIdentity: ''}, {agentIdentity: 42}]
        })

        expect(await readActiveWakeSubscriptionIdentities({graphService: service})).toEqual(['@neo-opus-grace'])
    })

    test('falls back to an injected cache double only when no SQLite handle exists', async () => {
        const service = graphServiceDouble({
            items: [
                {label: 'WAKE_SUBSCRIPTION', properties: {status: 'active', agentIdentity: '@neo-opus-grace'}},
                {label: 'WAKE_SUBSCRIPTION', properties: {status: 'retired', agentIdentity: '@retired'}},
                {label: 'WAKE_SUBSCRIPTION', properties: {agentIdentity: '@status-absent-means-active'}},
                {label: 'AGENT_IDENTITY',    properties: {status: 'active', agentIdentity: '@wrong-label'}}
            ]
        })

        expect(await readActiveWakeSubscriptionIdentities({graphService: service}))
            .toEqual(['@neo-opus-grace', '@status-absent-means-active'])
    })

    test('an unreachable graph THROWS — the adapter owns the degrade, this module never fabricates an empty fleet', async () => {
        await expect(readActiveWakeSubscriptionIdentities({graphService: graphServiceDouble({})}))
            .rejects.toThrow('graph read surface unavailable')
    })

    test('a failing init propagates — an un-initialised graph is not an empty fleet', async () => {
        await expect(readActiveWakeSubscriptionIdentities({graphService: graphServiceDouble({initError: 'graph init failed'})}))
            .rejects.toThrow('graph init failed')
    })
})

test.describe('readActiveWakeSubscriptionObservations — the redacted poll-recency projection', () => {
    test('the durable query aggregates recency in SQL: one row per identity, MAX(lastPollAt), the ISO-lexicographic contract', async () => {
        const service = graphServiceDouble({rows: []})

        await readActiveWakeSubscriptionObservations({graphService: service})

        const [sql] = service.statements

        expect(sql).toContain("MAX(json_extract(data, '$.properties.lastPollAt')) AS lastPollAt")
        expect(sql).toContain('GROUP BY agentIdentity')
        // the pull columns read the route's trigger AND transport, never the stamp alone
        expect(sql).toContain("(json_extract(data, '$.properties.trigger') = 'SENT_TO_ME' AND json_extract(data, '$.properties.harnessTarget') = 'none')")
        expect(sql).toContain('AS pullRoute,')
        expect(sql).toContain('AS pullRouteLastPollAt')
    })

    test('durable rows carry the stamp when present and null when no poll ever landed — absence stays absence', async () => {
        const service = graphServiceDouble({
            rows: [
                {agentIdentity: '@neo-fable-clio', lastPollAt: '2026-08-14T15:00:00.000Z', pullRoute: 1,    pullRouteLastPollAt: '2026-08-14T15:00:00.000Z'},
                {agentIdentity: '@neo-opus-vega',  lastPollAt: '2026-08-14T15:00:00.000Z', pullRoute: 1,    pullRouteLastPollAt: null},
                {agentIdentity: '@neo-gpt-emmy',   lastPollAt: '2026-08-14T15:00:00.000Z', pullRoute: 0,    pullRouteLastPollAt: null},
                {agentIdentity: '@neo-opus-ada',   lastPollAt: null,                       pullRoute: null, pullRouteLastPollAt: null}
            ]
        })

        expect(await readActiveWakeSubscriptionObservations({graphService: service})).toEqual([
            {identity: '@neo-fable-clio', lastPollAt: '2026-08-14T15:00:00.000Z', pullRoute: {lastPollAt: '2026-08-14T15:00:00.000Z'}, rotation: null},
            {identity: '@neo-opus-vega',  lastPollAt: '2026-08-14T15:00:00.000Z', pullRoute: {lastPollAt: null},                       rotation: null},
            {identity: '@neo-gpt-emmy',   lastPollAt: '2026-08-14T15:00:00.000Z', pullRoute: null,                                     rotation: null},
            {identity: '@neo-opus-ada',   lastPollAt: null,                       pullRoute: null,                                     rotation: null}
        ])
    })

    test('the cache-seam fallback aggregates like the SQL: the most recent stamp across an identity wins, null never overwrites it, and the pull stamp reads pull routes only', async () => {
        const
            push    = {trigger: 'SENT_TO_ME',         harnessTarget: 'a2a-webhook'},
            pull    = {trigger: 'SENT_TO_ME',         harnessTarget: 'none'},
            task    = {trigger: 'TASK_STATE_CHANGED', harnessTarget: 'none'},
            service = graphServiceDouble({
                items: [
                    {label: 'WAKE_SUBSCRIPTION', properties: {...pull, status: 'active', agentIdentity: '@two-routes', lastPollAt: '2026-08-14T09:00:00.000Z'}},
                    {label: 'WAKE_SUBSCRIPTION', properties: {...push, status: 'active', agentIdentity: '@two-routes', lastPollAt: '2026-08-14T15:00:00.000Z'}},
                    {label: 'WAKE_SUBSCRIPTION', properties: {...pull, status: 'active', agentIdentity: '@two-routes'}},
                    {label: 'WAKE_SUBSCRIPTION', properties: {...task, status: 'active', agentIdentity: '@task-poller', lastPollAt: '2026-08-14T15:00:00.000Z'}},
                    {label: 'WAKE_SUBSCRIPTION', properties: {...pull, status: 'active', agentIdentity: '@never-polled'}}
                ]
            })

        expect(await readActiveWakeSubscriptionObservations({graphService: service})).toEqual([
            {identity: '@two-routes',   lastPollAt: '2026-08-14T15:00:00.000Z', pullRoute: {lastPollAt: '2026-08-14T09:00:00.000Z'}},
            {identity: '@task-poller',  lastPollAt: '2026-08-14T15:00:00.000Z', pullRoute: null},
            {identity: '@never-polled', lastPollAt: null,                       pullRoute: {lastPollAt: null}}
        ])
    })

    test('the identities read IS the observation projection — one scan, no second contract free to drift', async () => {
        const service = graphServiceDouble({
            rows: [
                {agentIdentity: '@neo-fable-clio', lastPollAt: '2026-08-14T15:00:00.000Z'},
                {agentIdentity: '@neo-opus-ada',   lastPollAt: null}
            ]
        })

        expect(await readActiveWakeSubscriptionIdentities({graphService: service}))
            .toEqual(['@neo-fable-clio', '@neo-opus-ada'])
    })
})

test.describe('readWakeRoutesByIdentity — the join to the receiver records', () => {
    test('reads one durable row per active or withdrawn route, grouped by holder, with its refusal, its pull flag and its last poll, nothing aggregated in SQL', async () => {
        const service = graphServiceDouble({
            rows: [
                {id: 'WAKE_SUB:a', agentIdentity: '@neo-opus-vega', withdrawn: 0, refusal: null, pull: 0, lastPollAt: null},
                {id: 'WAKE_SUB:b', agentIdentity: '@neo-opus-vega', withdrawn: 1, refusal: 'not-in-receiver-manifest', pull: 0, lastPollAt: null},
                {id: 'WAKE_SUB:c', agentIdentity: '@neo-gpt-emmy',  withdrawn: 0, refusal: null, pull: 1, lastPollAt: '2026-11-13T09:48:31.000Z'},
                {id: 'WAKE_SUB:d', agentIdentity: '',               withdrawn: 0, refusal: null, pull: 0, lastPollAt: null}
            ]
        })

        expect(await readWakeRoutesByIdentity({graphService: service})).toEqual(new Map([
            ['@neo-opus-vega', [
                {id: 'WAKE_SUB:a', withdrawn: false, refusal: null, pull: false, lastPollAt: null},
                {id: 'WAKE_SUB:b', withdrawn: true,  refusal: 'not-in-receiver-manifest', pull: false, lastPollAt: null}
            ]],
            ['@neo-gpt-emmy',  [{id: 'WAKE_SUB:c', withdrawn: false, refusal: null, pull: true, lastPollAt: '2026-11-13T09:48:31.000Z'}]]
        ]))

        const [sql] = service.statements

        expect(sql).toContain("json_extract(data, '$.label') = 'WAKE_SUBSCRIPTION'")
        expect(sql).toContain("COALESCE(json_extract(data, '$.properties.status'), 'active') IN ('active', 'degraded')")
        expect(sql).toContain("json_extract(data, '$.properties.harnessTarget')")
        expect(sql).toContain("json_extract(data, '$.properties.lastPollAt')")
        expect(sql).not.toContain('GROUP BY')
    })

    test('the cache seam keeps the same predicate — a retired row is no route — and no read surface throws', async () => {
        const service = graphServiceDouble({
            items: [
                {id: 'WAKE_SUB:live',    label: 'WAKE_SUBSCRIPTION', properties: {status: 'active',   agentIdentity: '@neo-opus-vega'}},
                {id: 'WAKE_SUB:gone',    label: 'WAKE_SUBSCRIPTION', properties: {status: 'degraded', agentIdentity: '@neo-opus-vega', lastRefusal: 'not-in-receiver-manifest'}},
                {id: 'WAKE_SUB:retired', label: 'WAKE_SUBSCRIPTION', properties: {status: 'retired',  agentIdentity: '@neo-opus-vega'}},
                {id: 'WAKE_SUB:pull',    label: 'WAKE_SUBSCRIPTION', properties: {status: 'active',   agentIdentity: '@neo-opus-vega', trigger: 'SENT_TO_ME', harnessTarget: 'none', lastPollAt: '2026-11-13T09:48:31.000Z'}},
                {id: 'MESSAGE:x',        label: 'MESSAGE',           properties: {agentIdentity: '@neo-opus-vega'}}
            ]
        })

        expect(await readWakeRoutesByIdentity({graphService: service})).toEqual(new Map([['@neo-opus-vega', [
            {id: 'WAKE_SUB:live', withdrawn: false, refusal: null, pull: false, lastPollAt: null},
            {id: 'WAKE_SUB:gone', withdrawn: true,  refusal: 'not-in-receiver-manifest', pull: false, lastPollAt: null},
            {id: 'WAKE_SUB:pull', withdrawn: false, refusal: null, pull: true, lastPollAt: '2026-11-13T09:48:31.000Z'}
        ]]]))

        await expect(readWakeRoutesByIdentity({graphService: graphServiceDouble()}))
            .rejects.toThrow('graph read surface unavailable')
    })
})

/**
 * Over a real graph store: a seat's rotation is the decision on its newest sunset receipt, read for the seats armed
 * with a `SESSION_ROTATE` route.
 */
test.describe('readActiveWakeSubscriptionObservations — each armed seat\'s rotation (#1692)', () => {
    const
        hoursAgo = hours => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString(),
        graph    = () => {
            const db = new Database(':memory:')

            db.exec(`
                CREATE TABLE Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL);
                CREATE TABLE Edges (id TEXT PRIMARY KEY, user_id TEXT, source TEXT NOT NULL, target TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
            `)

            return db
        },
        insert   = (db, id, label, properties) => db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, ?, ?)').run(id, null, JSON.stringify({id, label, type: label, properties})),
        route    = (db, identity, trigger) => insert(db, `WAKE_SUB:${identity}:${trigger}`, 'WAKE_SUBSCRIPTION', {agentIdentity: identity, trigger, status: 'active', harnessTarget: 'a2a-webhook'}),
        receipt  = (db, id, identity, sentAt, sessionRotation) => insert(db, id, 'MESSAGE', {
            from: identity, to: identity, sentAt, taggedConcepts: ['sunset-protocol-handover'], ...(sessionRotation ? {sessionRotation} : {})
        }),
        observe  = async db => Object.fromEntries((await readActiveWakeSubscriptionObservations({graphService: {ready: async () => {}, db: {storage: {db}}}}))
            .map(observation => [observation.identity, observation.rotation]))

    test('the decision on an armed seat\'s newest receipt, stamped by its own state; an unarmed seat, an undecided receipt and a day-old one read none', async () => {
        const
            db             = graph(),
            completedAt    = hoursAgo(1),
            refusedAt      = hoursAgo(2),
            nextEligibleAt = hoursAgo(-1)

        ;['@done', '@refused', '@undecided', '@stale'].forEach(identity => route(db, identity, 'SESSION_ROTATE'))
        route(db, '@unarmed', 'SENT_TO_ME')

        receipt(db, 'MESSAGE:done',      '@done',      hoursAgo(3),  {state: 'completed', eventId: 'e1', oldSessionId: 's-old', requestedAt: hoursAgo(3), completedAt, newSessionId: 's-new', heldMessages: 2})
        receipt(db, 'MESSAGE:refused',   '@refused',   hoursAgo(3),  {state: 'refused', reason: 'minimum-interval', oldSessionId: 's-1', refusedAt, nextEligibleAt})
        receipt(db, 'MESSAGE:undecided', '@undecided', hoursAgo(1),  null)
        receipt(db, 'MESSAGE:stale',     '@stale',     hoursAgo(25), {state: 'completed', completedAt: hoursAgo(24.5), oldSessionId: 'a', newSessionId: 'b'})
        receipt(db, 'MESSAGE:unarmed',   '@unarmed',   hoursAgo(1),  {state: 'completed', completedAt: hoursAgo(1), oldSessionId: 'a', newSessionId: 'b'})

        expect(await observe(db)).toEqual({
            '@done'     : {state: 'completed', reason: null, receiptId: 'MESSAGE:done', decidedAt: completedAt, oldSessionId: 's-old', newSessionId: 's-new', nextEligibleAt: null},
            '@refused'  : {state: 'refused', reason: 'minimum-interval', receiptId: 'MESSAGE:refused', decidedAt: refusedAt, oldSessionId: 's-1', newSessionId: null, nextEligibleAt},
            '@undecided': null,
            '@stale'    : null,
            '@unarmed'  : null
        })
    })

    test('a receipt that cannot be read reads as a rotation of no known state, for its own seat alone', async () => {
        const db = graph(), requestedAt = hoursAgo(1)

        route(db, '@broken', 'SESSION_ROTATE')
        route(db, '@fine', 'SESSION_ROTATE')
        // a self-message whose concepts are not a list: the receipt read throws on it
        insert(db, 'MESSAGE:broken', 'MESSAGE', {from: '@broken', to: '@broken', sentAt: hoursAgo(1), taggedConcepts: 7})
        receipt(db, 'MESSAGE:fine', '@fine', hoursAgo(1), {state: 'requested', requestedAt, oldSessionId: 's'})

        const rotations = await observe(db)

        expect(rotations['@broken']).toEqual({state: null})
        expect(rotations['@fine']).toEqual({state: 'requested', reason: null, receiptId: 'MESSAGE:fine', decidedAt: requestedAt, oldSessionId: 's', newSessionId: null, nextEligibleAt: null})
    })
})

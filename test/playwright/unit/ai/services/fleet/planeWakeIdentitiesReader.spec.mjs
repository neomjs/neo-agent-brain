import {setup} from '../../../../setup.mjs'

const appName = 'PlaneWakeIdentitiesReaderTest'

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
import Neo            from 'neo.mjs/src/Neo.mjs'
import * as core      from 'neo.mjs/src/core/_export.mjs'

import {createPlaneWakeIdentitiesReader,
        createPlaneWakeObservationsReader} from '../../../../../../ai/services/fleet/planeWakeIdentitiesReader.mjs'
import {readFleetWakeStateSnapshot}        from '../../../../../../ai/services/fleet/fleetWakeStateAdapter.mjs'

/**
 * The client→reader→adapter composition witnesses. The proven plane client returns PARSED tool
 * payloads (its own spec proves a structured tool result resolves to the plain payload), so these
 * fixtures speak exactly that contract — and pin the double-parse class in both directions: the
 * reader must accept the parsed shape and must NOT quietly unwrap a wire envelope.
 */
test.describe('planeWakeIdentitiesReader — the plane-mode client→adapter composition', () => {
    const wired = {
        resolveDeliveryLiveness        : () => ({alive: true, reason: null}),
        resolveTerminalDeliveryFailures: () => ({state: 'observed', reason: null, byIdentity: new Map()})
    }

    test('a healthy PARSED payload — the shape the proven client returns — reaches the adapter as on-rows', async () => {
        const calls  = []
        const reader = createPlaneWakeIdentitiesReader({
            callTool: async (name, args) => {
                calls.push([name, args])
                return {identities: ['@neo-gpt']}
            }
        })

        const {capability, states} = await readFleetWakeStateSnapshot({
            agents                          : [{id: 'euclid', githubUsername: 'neo-gpt'}, {id: 'vega', githubUsername: 'neo-opus-vega'}],
            listActiveSubscriptionIdentities: reader,
            ...wired
        })

        expect(calls).toEqual([['manage_wake_subscription', {action: 'fleet-identities'}]])
        expect(capability).toMatchObject({state: 'wired', confidence: 'observed'})
        expect(states.map(row => row.wake)).toEqual(['on', 'off'])
    })

    test('the regression pin: a WIRE-ENVELOPE shape is rejected — re-adding an envelope parse upstream inverts the contract and this witness reds', async () => {
        const reader = createPlaneWakeIdentitiesReader({
            callTool: async () => ({structuredContent: {identities: ['@neo-gpt']}})
        })

        const {states} = await readFleetWakeStateSnapshot({
            agents                          : [{id: 'euclid', githubUsername: 'neo-gpt'}],
            listActiveSubscriptionIdentities: reader,
            ...wired
        })

        expect(states[0]).toMatchObject({wake: 'unknown', confidence: 'none'})
        expect(states[0].reason).toBe('plane wake fleet-identities answer unreadable')
    })

    test('a refused plane call degrades honestly — the refusal reason survives into the row, no empty-fleet fabrication', async () => {
        const reader = createPlaneWakeIdentitiesReader({
            callTool: async () => { throw new Error('plane manage_wake_subscription failed: HTTP 401') }
        })

        const {capability, states} = await readFleetWakeStateSnapshot({
            agents                          : [{id: 'euclid', githubUsername: 'neo-gpt'}],
            listActiveSubscriptionIdentities: reader,
            ...wired
        })

        expect(capability.state).toBe('degraded')
        expect(states[0].wake).toBe('unknown')
        expect(states[0].reason).toContain('plane manage_wake_subscription failed')
    })

    test('a payload without a top-level identities array throws the named contract error', async () => {
        const reader = createPlaneWakeIdentitiesReader({callTool: async () => ({})})

        await expect(reader()).rejects.toThrow('plane wake fleet-identities answer unreadable')
    })
})

test.describe('planeWakeObservationsReader — the redacted recency projection over the same read', () => {
    test('observations rows pass through normalized: identity, lastPollAt and pullRoute only, empty stamps become null, junk rows are dropped', async () => {
        const reader = createPlaneWakeObservationsReader({
            callTool: async (name, args) => {
                expect([name, args]).toEqual(['manage_wake_subscription', {action: 'fleet-identities'}])

                return {
                    identities  : ['@neo-gpt', '@neo-opus-vega', '@neo-opus-ada'],
                    observations: [
                        {identity: '@neo-gpt',       lastPollAt: '2026-08-14T15:00:00.000Z', pullRoute: null},
                        {identity: '@neo-opus-vega', lastPollAt: '',                         pullRoute: {lastPollAt: '', endpoint: 'never forwarded'}},
                        {identity: '@neo-opus-ada',  lastPollAt: '2026-08-14T15:00:00.000Z', pullRoute: 1},
                        {identity: '',               lastPollAt: '2026-08-14T15:00:00.000Z'},
                        {lastPollAt: '2026-08-14T15:00:00.000Z'}
                    ]
                }
            }
        })

        expect(await reader()).toEqual([
            {identity: '@neo-gpt',       lastPollAt: '2026-08-14T15:00:00.000Z', pullRoute: null},
            {identity: '@neo-opus-vega', lastPollAt: null,                       pullRoute: {lastPollAt: null}},
            // a bare flag is out of contract: no pull route, never one
            {identity: '@neo-opus-ada',  lastPollAt: '2026-08-14T15:00:00.000Z', pullRoute: null}
        ])
    })

    test('the deployment-lag fallback: an identities-only or recency-only plane answers no pull route — honest absence, never a broken read', async () => {
        const read = payload => createPlaneWakeObservationsReader({callTool: async () => payload})()

        expect(await read({identities: ['@neo-gpt']})).toEqual([{identity: '@neo-gpt', lastPollAt: null, pullRoute: null}])
        expect(await read({identities: ['@neo-gpt'], observations: [{identity: '@neo-gpt', lastPollAt: '2026-08-14T15:00:00.000Z'}]}))
            .toEqual([{identity: '@neo-gpt', lastPollAt: '2026-08-14T15:00:00.000Z', pullRoute: null}])
    })

    test('a payload with neither observations nor identities throws the same named contract error as the sibling', async () => {
        const reader = createPlaneWakeObservationsReader({callTool: async () => ({})})

        await expect(reader()).rejects.toThrow('plane wake fleet-identities answer unreadable')
    })
})

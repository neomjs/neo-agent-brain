import {setup} from '../../../../setup.mjs'

const appName = 'FleetCockpitStatusTest'

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

import {createFleetCockpitEvent, createFleetCockpitEventId, createFleetCockpitStatus} from '../../../../../../ai/services/fleet/fleetCockpitStatus.mjs';
import {FLEET_COCKPIT_EVENT_TYPES, FLEET_COCKPIT_SOURCES}                             from '../../../../../../src/fleet/contract/cockpit.mjs';
import {SEAT_LIFECYCLE_ROW_FALLBACK}                                                  from '../../../../../../src/fleet/contract/seatLifecycle.mjs';

// Brain-side producer constants, imported HERE only: the module under test is a pure Body map that
// must never import `ai/`. The spec is the one place both sides may meet — which is what lets it
// pin the duplicated source labels against drift.
import {THROTTLE_SOURCE_LABEL} from '../../../../../../ai/services/fleet/fleetThrottleStateAdapter.mjs'
import {WAKE_SOURCE_LABEL}     from '../../../../../../ai/services/fleet/fleetWakeStateAdapter.mjs'

// Same both-sides-meet licence as the labels above, for the one assertion that has to span the whole
// chain. The never-launched-reads-benched defect was invisible to every single-layer test because each
// layer was correct on its own terms — the producer reported what it was asked, the assembler wired
// what it was handed, the display rendered its input faithfully. Only the composition was a lie.

test.describe('fleetCockpitStatus - Body-side cockpit DTO contract', () => {
    test('passes identity display facts through from assembler-enriched agents — nulls when un-enriched (never guessed)', () => {
        const snapshot = createFleetCockpitStatus({
            agents: [
                {id: 'neo-gpt', githubUsername: 'neo-gpt', family: 'gpt', engineTag: 'GPT-5.6 Sol'},
                {id: 'guest', githubUsername: 'guest-gh'}
            ]
        })

        expect(snapshot.rows[0]).toMatchObject({id: 'neo-gpt', family: 'gpt', engineTag: 'GPT-5.6 Sol'})
        // un-enriched -> explicit nulls: the cockpit renders unclassified / tagless, never a guess
        expect(snapshot.rows[1]).toMatchObject({id: 'guest', family: null, engineTag: null})
    })

    test('folds the display-name chain in the CARD-CONTRACT order: displayName -> name -> githubUsername -> id', () => {
        const snapshot = createFleetCockpitStatus({
            agents: [
                {id: 'full',  githubUsername: 'full-gh',  name: 'Full Name',  displayName: 'Chosen'},
                {id: 'named', githubUsername: 'named-gh', name: 'Named'},
                {id: 'login', githubUsername: 'login-gh'},
                {id: 'bare'}
            ]
        })

        // one folded field, resolved Brain-side ONCE — the Body name slot consumes it and never
        // re-implements the chain (a view-side copy would be a second truth that drifts)
        expect(snapshot.rows.map(row => row.displayName)).toEqual(['Chosen', 'Named', 'login-gh', 'bare'])
    })

    test('hoists assembler-stamped launch truth — tri-state null when un-stamped, never derived in this pure map', () => {
        const snapshot = createFleetCockpitStatus({
            agents: [
                {id: 'desk', launchable: true, launchRefusal: 'released to its own harness: adopt it to start it here', authMode: 'in-app'},
                {id: 'bare'}
            ]
        })

        // the Brain-side assembler (fleetRoster) is the ONLY deriver; this Body-pure map hoists
        // the stamped facts like the identity facts above — absent stays an honest null
        // ("not read back yet"), never a guessed boolean
        expect(snapshot.rows[0]).toMatchObject({id: 'desk', launchable: true, launchRefusal: 'released to its own harness: adopt it to start it here', authMode: 'in-app'})
        expect(snapshot.rows[1]).toMatchObject({id: 'bare', launchable: null, launchRefusal: null, authMode: null})
    })

    test('hoists the assembler-stamped open-lane count — the roster DTO owns the field; un-stamped stays an honest null, never a fabricated zero', () => {
        const snapshot = createFleetCockpitStatus({
            agents: [
                {id: 'busy'},
                {id: 'counted', openLaneCount: 23}
            ]
        })

        // same tri-state contract as `launchable`: a Brain-side enricher stamps the count; this
        // pure map only hoists it, and a missing stamp reaches the cockpit as null (no badge)
        expect(snapshot.rows[0]).toMatchObject({id: 'busy', openLaneCount: null})
        expect(snapshot.rows[1]).toMatchObject({id: 'counted', openLaneCount: 23})
    })

    test('stamps each row with its newest attributable activity instant — events + presence, invalid/unattributed ignored', () => {
        const snapshot = createFleetCockpitStatus({
            agents: [
                {id: 'presence-wins'},
                {id: 'event-wins'},
                {id: 'presence-only'},
                {id: 'unobserved'}
            ],
            events: [
                {type: 'a2a-activity', source: FLEET_COCKPIT_SOURCES.a2a, agentId: 'presence-wins', occurredAt: '2026-08-22T10:00:00.000Z'},
                {type: 'a2a-activity', source: FLEET_COCKPIT_SOURCES.a2a, agentId: 'presence-wins', occurredAt: '2026-08-22T12:00:00.000Z'},
                {type: 'a2a-activity', source: FLEET_COCKPIT_SOURCES.a2a, agentId: 'presence-wins', occurredAt: 'not-an-instant'},
                {type: 'pr-activity', source: FLEET_COCKPIT_SOURCES.githubPr, agentId: 'event-wins', occurredAt: '2026-08-22T14:00:00+02:00'},
                {type: 'a2a-activity', source: FLEET_COCKPIT_SOURCES.a2a, occurredAt: '2026-08-23T23:59:59.000Z'}
            ],
            presenceStatus: [
                {agentId: 'presence-wins', presence: 'online', lastSeenAt: '2026-08-22T13:00:00.000Z'},
                {agentId: 'event-wins', presence: 'online', lastSeenAt: '2026-08-22T11:00:00.000Z'},
                {agentId: 'presence-only', presence: 'idle', lastSeenAt: '2026-08-22T09:00:00.000Z'},
                {agentId: 'unobserved', presence: 'unknown', lastSeenAt: 'invalid'}
            ]
        })

        expect(snapshot.rows.map(row => [row.id, row.lastActivityAt])).toEqual([
            ['presence-wins', '2026-08-22T13:00:00.000Z'],
            // Preserve the producer's original parseable string; the assembler compares instants,
            // but never reformats a passthrough fact.
            ['event-wins', '2026-08-22T14:00:00+02:00'],
            ['presence-only', '2026-08-22T09:00:00.000Z'],
            ['unobserved', null]
        ])
    })

    test('composes runtimeStatus onto row lifecycle — observed process truth when present, honest not-wired when absent', () => {
        const snapshot = createFleetCockpitStatus({
            agents       : [{id: 'alice'}, {id: 'bob'}, {id: 'carol'}],
            runtimeStatus: [
                {agentId: 'alice', state: 'running', running: true, confidence: 'observed'},
                {agentId: 'carol', running: false, confidence: 'observed'}
            ]
        })

        expect(snapshot.rows[0].lifecycle).toMatchObject({source: FLEET_COCKPIT_SOURCES.runtime, state: 'running', confidence: 'observed'})
        expect(snapshot.rows[0].sources.runtime).toMatchObject({state: 'wired', confidence: 'observed'})

        // no runtime entry -> the DTO's own placeholder-never-renders-as-fact discipline
        expect(snapshot.rows[1].lifecycle).toMatchObject({state: 'not-wired', confidence: 'none'})
        expect(snapshot.rows[1].sources.runtime).toMatchObject({state: 'not-wired', confidence: 'none'})

        // a supervised row that names no state carries the contract's fallback word, never a state a control acts on
        expect(snapshot.rows[2].lifecycle).toMatchObject({source: FLEET_COCKPIT_SOURCES.runtime, state: SEAT_LIFECYCLE_ROW_FALLBACK, confidence: 'observed'})
    })

    test('carries the last start\'s per-repository outcome from the runtime row — null before a start', () => {
        const
            repos    = [{repoSlug: 'neomjs/neo-agent-brain', state: 'prepared'}, {repoSlug: 'neomjs/missing', state: 'failed', reason: 'clone failed'}],
            snapshot = createFleetCockpitStatus({
                agents       : [{id: 'alice'}, {id: 'bob'}, {id: 'carol'}],
                runtimeStatus: [
                    {agentId: 'alice', state: 'running', running: true, confidence: 'observed', repos},
                    {agentId: 'bob',   state: 'running', running: true, confidence: 'observed'}
                ]
            })

        expect(snapshot.rows.map(row => row.repoOutcomes)).toEqual([repos, null, null])
    })

    test("carries what the last start did about each checkout's dependencies from the runtime row — null before a start", () => {
        const
            dependencies = [{repoSlug: 'neomjs/neo', state: 'installed'}, {repoSlug: 'neomjs/neo-agent-brain', state: 'unverified'}],
            snapshot     = createFleetCockpitStatus({
                agents       : [{id: 'alice'}, {id: 'bob'}],
                runtimeStatus: [{agentId: 'alice', state: 'running', running: true, confidence: 'observed', dependencies}]
            })

        expect(snapshot.rows.map(row => row.dependencyOutcomes)).toEqual([dependencies, null])
    })

    test('carries where a desktop seat\'s session opened from the runtime row — null for every other row', () => {
        const
            sessionFolder = {state: 'wrong', expected: '/agents/alice/neomjs/neo', observed: '/old/neo'},
            snapshot      = createFleetCockpitStatus({
                agents       : [{id: 'alice'}, {id: 'bob'}],
                runtimeStatus: [
                    {agentId: 'alice', state: 'running', running: true, confidence: 'observed', sessionFolder},
                    {agentId: 'bob',   state: 'running', running: true, confidence: 'observed'}
                ]
            })

        expect(snapshot.rows.map(row => row.sessionFolder)).toEqual([sessionFolder, null])
    })

    test('carries why a seat exited without a Stop from the runtime row — null for every other row', () => {
        const
            exitReason = {state: 'harness-update', exitedAt: '2026-10-15T12:26:13.450Z', logPath: '/tmp/main.log', matchedLine: '2026-10-15 14:26:13 [info] beforeQuitForUpdate'},
            snapshot   = createFleetCockpitStatus({
                agents       : [{id: 'alice'}, {id: 'bob'}],
                runtimeStatus: [
                    {agentId: 'alice', state: 'stopped', running: false, confidence: 'observed', exitReason},
                    {agentId: 'bob',   state: 'stopped', running: false, confidence: 'observed'}
                ]
            })

        expect(snapshot.rows.map(row => row.exitReason)).toEqual([exitReason, null])
    })

    test('carries unresolved helper cleanup and its failureReason from the runtime row onto the roster row (#1074)', () => {
        const
            failureReason = 'Codex Desktop helper cleanup failed: ambiguous profile-owned process identity (pid 4242); refusing cleanup.',
            spawnReason   = 'the seat process could not be spawned: ENOENT',
            snapshot      = createFleetCockpitStatus({
                agents       : [{id: 'alice'}, {id: 'bob'}, {id: 'carol'}],
                runtimeStatus: [
                    {agentId: 'alice', state: 'failed', running: false, confidence: 'observed', cleanupUnresolved: true, failureReason},
                    {agentId: 'bob',   state: 'stopped', running: false, confidence: 'observed'},
                    // a cleanup-free failed record (a spawn that threw) names why the same way
                    {agentId: 'carol', state: 'failed', running: false, confidence: 'observed', failureReason: spawnReason}
                ]
            })

        expect(snapshot.rows.map(row => ({
            cleanupUnresolved: row.cleanupUnresolved,
            failureReason    : row.failureReason
        }))).toEqual([
            {cleanupUnresolved: true,  failureReason},
            {cleanupUnresolved: false, failureReason: null},
            {cleanupUnresolved: false, failureReason: spawnReason}
        ])
    })

    test('carries the Git identity the last start resolved from the runtime row — null before a start', () => {
        const
            derived  = {state: 'derived', source: 'commit-email', name: 'Alice', email: 'alice@example.test'},
            snapshot = createFleetCockpitStatus({
                agents       : [{id: 'alice'}, {id: 'bob'}, {id: 'carol'}],
                runtimeStatus: [
                    {agentId: 'alice', state: 'running', running: true, confidence: 'observed', gitIdentity: derived},
                    {agentId: 'bob',   state: 'stopped', running: false, confidence: 'observed', gitIdentity: {state: 'mismatch', source: 'public', name: 'Bob', email: 'bob@example.test'}}
                ]
            })

        expect(snapshot.rows.map(row => row.gitIdentity)).toEqual([derived, {state: 'mismatch', source: 'public', name: 'Bob', email: 'bob@example.test'}, null])
    })

    test('keeps the seat generation and installed selection distinct without inventing either', () => {
        const runtimeGeneration   = {id: 'a'.repeat(64), pin: 'unknown'}, installedGeneration = {state: 'observed', id: 'b'.repeat(64)},
            nextRuntimeGeneration = {id: 'c'.repeat(64)};
        const snapshot = createFleetCockpitStatus({agents: [{id: 'alice'}, {id: 'bob'}], runtimeStatus: [
            {agentId: 'alice', state: 'running', running: true, confidence: 'observed', runtimeGeneration, installedGeneration, nextRuntimeGeneration}
        ]});
        expect(snapshot.rows[0]).toMatchObject({runtimeGeneration, installedGeneration, nextRuntimeGeneration});
        expect(snapshot.rows[1]).toMatchObject({runtimeGeneration: null, installedGeneration: null, nextRuntimeGeneration: null});
    });

    test('an unmanaged runtime row is NOT wired — row-existence is a roster fact, not a supervision fact (#17305)', () => {
        const snapshot = createFleetCockpitStatus({
            agents       : [{id: 'grace'}],
            runtimeStatus: [{
                agentId   : 'grace',
                state     : 'unmanaged',
                running   : false,
                confidence: 'none',
                reason    : 'no fleet process record: this agent runs outside fleet supervision'
            }]
        })

        // A row came back, so the pre-fix mapping called this `wired` and published the row's state
        // as session truth — which is how a `benched / offline` verdict rendered over seats the fleet
        // never launched. Supervision is keyed on holding a process record, not on answering.
        expect(snapshot.rows[0].sources.runtime).toMatchObject({state: 'not-wired', confidence: 'none'})
        expect(snapshot.rows[0].sources.runtime.state).not.toBe('wired')

        // The producer's own cause survives instead of being overwritten by the axis-level
        // "pending the wire method" default — that default describes a missing WIRE, this describes a
        // present producer that observes nothing for this agent.
        expect(snapshot.rows[0].sources.runtime.reason).toBe('no fleet process record: this agent runs outside fleet supervision')

        expect(snapshot.rows[0].lifecycle).toMatchObject({state: 'not-wired', confidence: 'none'})
    })

    test('a REAL stopped record stays wired and keeps stopped — the operator-benched fact remains observable (#17305)', () => {
        const snapshot = createFleetCockpitStatus({
            agents       : [{id: 'alice'}],
            runtimeStatus: [{agentId: 'alice', state: 'stopped', running: false, confidence: 'observed'}]
        })

        // The negative control for the fix: without it, a genuine fleet-managed stop would be
        // laundered into the same not-wired bucket and the one verdict Fleet IS entitled to make
        // would disappear.
        expect(snapshot.rows[0].sources.runtime).toMatchObject({state: 'wired', confidence: 'observed'})
        expect(snapshot.rows[0].lifecycle).toMatchObject({state: 'stopped', confidence: 'observed'})
    })

    test('an inferred stop — a fleet-launched seat with no record — stamps lifecycle and runtime source as one pair', () => {
        const snapshot = createFleetCockpitStatus({
            agents       : [{id: 'cockpit'}],
            runtimeStatus: [{agentId: 'cockpit', state: 'stopped', running: false, confidence: 'inferred', reason: 'no fleet process record: this fleet is the seat\'s only launcher, so it is stopped'}]
        })

        const {lifecycle, sources} = snapshot.rows[0]

        // The cockpit reads the two as one fact and marks the runtime invalid when their source or
        // confidence differ, so an inferred stop must reach both, never the lifecycle alone
        expect(lifecycle).toEqual({source: FLEET_COCKPIT_SOURCES.runtime, state: 'stopped', confidence: 'inferred'})
        expect(sources.runtime).toMatchObject({source: lifecycle.source, state: 'wired', confidence: lifecycle.confidence})
    })

    test('composes roster and repo status with explicit source labels', () => {
        const snapshot = createFleetCockpitStatus({
            agents: [{
                id            : 'alice',
                githubUsername: 'alice-gh',
                harnessType   : 'codex',
                metadata      : {
                    repo: {repoSlug: 'neomjs/neo'}
                }
            }],
            fleetStatus: [{
                agentId           : 'alice',
                configured        : true,
                repoSlug          : 'neomjs/neo',
                state             : 'checkout',
                provisioningAction: 'reuse'
            }]
        })

        expect(snapshot.sources).toEqual(FLEET_COCKPIT_SOURCES)
        expect(snapshot.rows).toHaveLength(1)
        expect(snapshot.rows[0]).toMatchObject({
            id            : 'alice',
            githubUsername: 'alice-gh',
            harnessType   : 'codex',
            repoStatus    : {
                agentId : 'alice',
                repoSlug: 'neomjs/neo',
                state   : 'checkout'
            },
            sources: {
                roster: {
                    source: FLEET_COCKPIT_SOURCES.roster,
                    state : 'wired'
                },
                repoStatus: {
                    source: FLEET_COCKPIT_SOURCES.repoStatus,
                    state : 'wired'
                }
            }
        })
    })

    test('derives avatarUrl from the GitHub account (setAvatar override wins; null only without a username)', () => {
        const snapshot = createFleetCockpitStatus({
            agents: [{
                id            : 'vega',
                githubUsername: 'neo-opus-vega',
                metadata      : {avatarUrl: 'https://cdn.neomjs.com/avatars/vega.png'}
            }, {
                id            : 'grace',
                githubUsername: 'neo-opus-grace'
            }, {
                id: 'ghost'
            }],
            fleetStatus: []
        })

        // an explicit metadata.avatarUrl (FleetManager.setAvatar) is the override — it wins
        expect(snapshot.rows[0].avatarUrl).toBe('https://cdn.neomjs.com/avatars/vega.png')
        // no explicit avatar → derived from the agent's GitHub account, a small sized fetch (not the full-res avatar)
        expect(snapshot.rows[1].avatarUrl).toBe('https://github.com/neo-opus-grace.png?size=80')
        // no username to derive from → null (never undefined, never a malformed URL — a clean bindable contract)
        expect(snapshot.rows[2].avatarUrl).toBeNull()
    })

    test('marks runtime and activity adapters as not wired instead of inventing state', () => {
        const snapshot = createFleetCockpitStatus({
            agents     : [{id: 'alice', githubUsername: 'alice-gh'}],
            fleetStatus: []
        })

        expect(snapshot.capabilities.activity).toMatchObject({
            source: FLEET_COCKPIT_SOURCES.activity,
            state : 'not-wired'
        })
        expect(snapshot.capabilities.runtime).toMatchObject({
            source: FLEET_COCKPIT_SOURCES.runtime,
            state : 'not-wired'
        })
        expect(snapshot.rows[0].repoStatus).toBeNull()
        expect(snapshot.rows[0].sources.repoStatus).toMatchObject({
            source: FLEET_COCKPIT_SOURCES.repoStatus,
            state : 'missing'
        })
        expect(snapshot.rows[0].lifecycle).toMatchObject({
            source: FLEET_COCKPIT_SOURCES.runtime,
            state : 'not-wired'
        })
    })

    test('strips secret-shaped fields from rows and events recursively', () => {
        const snapshot = createFleetCockpitStatus({
            agents: [{
                id             : 'alice',
                credential     : 'ghp_secret',
                credentialState: 'stored',
                metadata       : {
                    repo        : {repoSlug: 'neomjs/neo'},
                    privateToken: 'secret'
                }
            }],
            fleetStatus: [{
                agentId   : 'alice',
                repoPath  : '/tmp/fleet/alice',
                state     : 'checkout',
                signingKey: 'secret'
            }],
            events: [{
                type   : 'lifecycle-request',
                source : FLEET_COCKPIT_SOURCES.lifecycle,
                agentId: 'alice',
                payload: {
                    id       : 'alice',
                    bridgePAT: 'ghp_secret',
                    nested   : {
                        password: 'secret'
                    }
                }
            }]
        })

        const serialized = JSON.stringify(snapshot)

        expect(serialized).toContain('alice')
        expect(serialized).toContain('credentialState')
        expect(serialized).toContain('repoPath')
        expect(serialized).not.toContain('ghp_secret')
        expect(serialized).not.toContain('signingKey')
        expect(serialized).not.toContain('privateToken')
        expect(serialized).not.toContain('bridgePAT')
        expect(serialized).not.toContain('password')
    })

    test('normalizes only the bounded lifecycle and bridge event classes', () => {
        const events = FLEET_COCKPIT_EVENT_TYPES.map(type => createFleetCockpitEvent({
            type,
            source : type.startsWith('bridge') ? FLEET_COCKPIT_SOURCES.roster : FLEET_COCKPIT_SOURCES.lifecycle,
            agentId: 'alice'
        }))

        expect(events.map(event => event.type)).toEqual([...FLEET_COCKPIT_EVENT_TYPES])
    })

    test('source-qualifies event identity so same-number PR and issue facts never alias', () => {
        expect(createFleetCockpitEventId(FLEET_COCKPIT_SOURCES.githubPr, 17575))
            .toBe(`${FLEET_COCKPIT_SOURCES.githubPr}:17575`);
        expect(createFleetCockpitEventId(FLEET_COCKPIT_SOURCES.githubIssue, 17575))
            .toBe(`${FLEET_COCKPIT_SOURCES.githubIssue}:17575`);
        expect(createFleetCockpitEventId(FLEET_COCKPIT_SOURCES.githubPr, null)).toBeNull()
    });

    test('rejects source-less or unsupported events', () => {
        expect(() => createFleetCockpitEvent({type: 'lifecycle-request'})).toThrow('source is required')
        expect(() => createFleetCockpitEvent({type: 'free-form', source: FLEET_COCKPIT_SOURCES.lifecycle})).toThrow('unsupported event type')
    })

    // The wake row's `state` is CLOSED over the S2 four-state taxonomy. The wiring fact belongs to
    // the capability + `sources.wake`; leaking it into the observation field would hand every
    // consumer a fifth value it never agreed to switch on.
    test('an unwired wake producer reads unknown/none in the ROW, and not-wired only in the wiring axes', () => {
        const snapshot = createFleetCockpitStatus({agents: [{id: 'grace', githubUsername: 'neo-opus-grace'}]}),
              row      = snapshot.rows[0]

        expect(row.wake).toEqual({
            source    : FLEET_COCKPIT_SOURCES.wake,
            state     : 'unknown',
            confidence: 'none',
            reason    : 'wake-state producer not wired'
        })
        expect(row.sources.wake).toMatchObject({state: 'not-wired', confidence: 'none'})
        expect(snapshot.capabilities.wake).toMatchObject({state: 'not-wired'})
    })

    // The presence row holds the identical closed-enum discipline: absence of a producer is
    // `unknown` in the observation field; the wiring fact lives only in capability + sources.
    test('an unwired presence producer reads unknown/none in the ROW, and not-wired only in the wiring axes', () => {
        const snapshot = createFleetCockpitStatus({agents: [{id: 'clio', githubUsername: 'neo-fable-clio'}]}),
              row      = snapshot.rows[0]

        expect(row.presence).toEqual({
            source    : FLEET_COCKPIT_SOURCES.presence,
            state     : 'unknown',
            confidence: 'none',
            lastSeenAt: null,
            reason    : 'presence producer not wired'
        })
        expect(row.sources.presence).toMatchObject({state: 'not-wired', confidence: 'none'})
        expect(snapshot.capabilities.presence).toMatchObject({state: 'not-wired'})
    })

    test('a wired presence row travels WHOLE — band, recency, confidence, never re-derived', () => {
        const snapshot = createFleetCockpitStatus({
            agents        : [{id: 'clio', githubUsername: 'neo-fable-clio'}],
            presenceStatus: [{
                agentId   : 'clio',
                presence  : 'online',
                lastSeenAt: '2026-08-09T11:00:00.000Z',
                confidence: 'observed',
                source    : FLEET_COCKPIT_SOURCES.presence
            }],
            capabilities: {presence: {source: FLEET_COCKPIT_SOURCES.presence, state: 'wired', confidence: 'observed'}}
        })

        expect(snapshot.rows[0].presence).toEqual({
            source    : FLEET_COCKPIT_SOURCES.presence,
            state     : 'online',
            confidence: 'observed',
            lastSeenAt: '2026-08-09T11:00:00.000Z'
        })
        expect(snapshot.rows[0].sources.presence).toMatchObject({state: 'wired', confidence: 'observed'})
        expect(snapshot.capabilities.presence).toMatchObject({state: 'wired'})
    })

    test('the beacon facet rides the presence axis untouched when it is one of the closed facets; an older producer without it leaves the row without it; an out-of-set word is dropped, never admitted (#318)', () => {
        const row        = beacon => ({agentId: 'clio', presence: 'fresh', lastSeenAt: null, confidence: 'observed', source: FLEET_COCKPIT_SOURCES.presence, ...(beacon !== undefined && {beacon})})
        const presenceOf = beacon => createFleetCockpitStatus({
            agents        : [{id: 'clio', githubUsername: 'neo-fable-clio'}],
            presenceStatus: [row(beacon)],
            capabilities  : {presence: {source: FLEET_COCKPIT_SOURCES.presence, state: 'wired', confidence: 'observed'}}
        }).rows[0].presence

        for (const facet of ['fresh', 'stale', 'absent', 'unobserved']) {
            expect(presenceOf(facet)).toEqual({source: FLEET_COCKPIT_SOURCES.presence, state: 'fresh', confidence: 'observed', lastSeenAt: null, beacon: facet})
        }

        // an older Brain sends no facet: the row carries none — the consumer keeps its fallback
        expect(presenceOf(undefined)).not.toHaveProperty('beacon')
        // an open enum never leaks to every consumer
        expect(presenceOf('glowing')).not.toHaveProperty('beacon')
        expect(presenceOf(null)).not.toHaveProperty('beacon')
    })

    test('a degraded presence capability carries its typed reasonCode to the DTO intact — supplied object wins whole', () => {
        const snapshot = createFleetCockpitStatus({
            agents      : [{id: 'clio', githubUsername: 'neo-fable-clio'}],
            capabilities: {presence: {
                source    : FLEET_COCKPIT_SOURCES.presence,
                state     : 'degraded',
                confidence: 'none',
                reason    : 'plane who_is_online failed: session lost and plane identity mismatch',
                reasonCode: 'viewer-binding-unavailable'
            }}
        })

        // the binding-signal chain's last hop: the adapter's typed code reaches the cockpit DTO
        // unchanged — C3 renders "binding unavailable" from THIS field, never from prose-matching
        expect(snapshot.capabilities.presence).toMatchObject({
            state     : 'degraded',
            reasonCode: 'viewer-binding-unavailable'
        })
    })

    test('an unwired throttle producer reads unknown/none in the ROW, not-wired only in the wiring axes', () => {
        const snapshot = createFleetCockpitStatus({agents: [{id: 'grace'}]}),
              row      = snapshot.rows[0]

        expect(row.throttle).toEqual({
            source    : FLEET_COCKPIT_SOURCES.throttle,
            state     : 'unknown',
            confidence: 'none',
            reason    : 'throttle-state producer not wired'
        })
        expect(row.sources.throttle).toMatchObject({state: 'not-wired', confidence: 'none'})
        expect(snapshot.capabilities.throttle).toMatchObject({state: 'not-wired'})
    })

    test('throttle row state stays inside its closed taxonomy — absence included', () => {
        const snapshot = createFleetCockpitStatus({
            agents        : [{id: 'a'}, {id: 'b'}, {id: 'c'}, {id: 'd'}],
            throttleStatus: [
                {agentId: 'a', throttle: 'none',         confidence: 'observed'},
                {agentId: 'b', throttle: 'overage',      confidence: 'observed'},
                {agentId: 'c', throttle: 'rate-limited', confidence: 'observed'}
                // 'd' has no producer row — absence must read unknown, never a fifth value.
            ]
        })

        expect(snapshot.rows.map(row => row.throttle.state)).toEqual(['none', 'overage', 'rate-limited', 'unknown'])

        for (const row of snapshot.rows) {
            expect(['none', 'overage', 'rate-limited', 'unknown']).toContain(row.throttle.state)
        }
    })

    test('the Body-side source labels MATCH the Brain-side producer constants — a split would silently orphan every row', () => {
        // These are duplicated by design (this pure Body map never imports `ai/`), so matching
        // today is not the same as pinned: the join keys rows by this exact string.
        expect(FLEET_COCKPIT_SOURCES.wake).toBe(WAKE_SOURCE_LABEL)
        expect(FLEET_COCKPIT_SOURCES.throttle).toBe(THROTTLE_SOURCE_LABEL)
    })

    test('wake row state stays inside the four-state taxonomy for every producer answer, wired or not', () => {
        const agents   = [{id: 'grace'}, {id: 'vega'}, {id: 'euclid'}, {id: 'ada'}],
              snapshot = createFleetCockpitStatus({
                  agents,
                  wakeStatus: [
                      {agentId: 'grace',  wake: 'on',        confidence: 'observed'},
                      {agentId: 'vega',   wake: 'suppressed', confidence: 'observed'},
                      {agentId: 'euclid', wake: 'unknown',    confidence: 'none', reason: 'graph offline'}
                      // 'ada' has no producer row at all — absence must read unknown.
                  ]
              })

        expect(snapshot.rows.map(row => row.wake.state)).toEqual(['on', 'suppressed', 'unknown', 'unknown'])

        for (const row of snapshot.rows) {
            expect(['on', 'off', 'suppressed', 'unknown']).toContain(row.wake.state)
        }
    })

    test.describe('the lane sources (#1046)', () => {
        const capturedAt = '2026-10-15T12:00:00.000Z',
              a2aWired   = {source: FLEET_COCKPIT_SOURCES.a2a, state: 'wired', confidence: 'observed', reason: null, capturedAt, policy: 'team', scanned: 50},
              forgeWired = {source: FLEET_COCKPIT_SOURCES.commentLane, state: 'wired', confidence: 'observed', reason: null, capturedAt},
              entry      = (agentId, occurredAt, subject, collisionTag = 'lane-claim') => ({agentId, collisionTag, messageId: `MESSAGE:${agentId}@${occurredAt}`, occurredAt, subject}),
              fact       = (agentId, occurredAt, issue, title = 'a ticket') => ({agentId, issue, line: `${issue} ${title}`, occurredAt}),
              lanes      = ({a2a = a2aWired, entries = [], forge = forgeWired, claims = [], assignments = []} = {}) => ({
                  a2a  : {capability: a2a, entries},
                  forge: forge && {capability: forge, claims, assignments}
              });

        test('an A2A claim joins its seat by the sender login, never the registry key, newest first in any order', () => {
            const entries = [
                entry('neo-gpt', '2026-10-02T09:00:00.000Z', '[lane-claim] older'),
                entry('neo-opus-ada', '2026-10-02T09:15:00.000Z', '[lane-claim] engine'),
                entry('neo-gpt', '2026-10-02T11:30:00+02:00', '[lane-claim] fleet'),
                entry('seat-1', '2026-10-02T09:45:00.000Z', '[lane-claim] wrong registry join')
            ];

            for (const order of [entries, [...entries].reverse(), [entries[2], entries[0], entries[3], entries[1]]]) {
                const snapshot = createFleetCockpitStatus({
                    agents    : [
                        {id: 'seat-1', githubUsername: 'neo-gpt'},
                        {id: 'neo-gpt', githubUsername: 'someone-else'},
                        {id: 'neo-opus-ada'},
                        {id: 'seat-2', githubUsername: 'neo-opus-ada'}
                    ],
                    laneStatus: lanes({entries: order})
                });

                expect(snapshot.rows.map(row => [row.laneLine, row.laneClaimedAt, row.laneSource])).toEqual([
                    ['[lane-claim] fleet', '2026-10-02T11:30:00+02:00', {source: FLEET_COCKPIT_SOURCES.a2a, confidence: 'observed'}],
                    [null, null, null],
                    [null, null, null],
                    ['[lane-claim] engine', '2026-10-02T09:15:00.000Z', {source: FLEET_COCKPIT_SOURCES.a2a, confidence: 'observed'}]
                ]);
                expect(snapshot.capabilities.lane).toEqual(a2aWired);
                expect(snapshot.capabilities.forgeLane).toEqual(forgeWired);
                expect(snapshot.rows[0].sources.lane).toEqual({source: FLEET_COCKPIT_SOURCES.a2a, state: 'wired', confidence: 'observed', reason: null});
                expect(snapshot.rows[0].sources.forgeLane).toEqual({source: FLEET_COCKPIT_SOURCES.commentLane, state: 'wired', confidence: 'observed', reason: null});
                expect(snapshot.events).toEqual([]);
            }
        });

        test('malformed entries and facts cannot displace a valid claim', () => {
            const valid    = entry('neo-gpt', '2026-10-02T09:00:00.000Z', '[lane-claim] valid'),
                  late     = entry('neo-gpt', '2026-10-02T09:50:00.000Z', '[lane-claim] invalid'),
                  lateFact = fact('neo-gpt', '2026-10-02T09:55:00.000Z', 'neo#1'),
                  snapshot = createFleetCockpitStatus({
                      agents    : [{id: 'seat', githubUsername: 'neo-gpt'}],
                      laneStatus: lanes({
                          entries: [
                              valid,
                              {...late, occurredAt: 'not-an-instant'},
                              {...late, occurredAt: null},
                              {...late, subject: '  '},
                              {...late, subject: {text: 'not a subject'}},
                              {...late, collisionTag: 'review-claim'},
                              {...late, agentId: '@neo-gpt'},
                              null
                          ],
                          claims     : [{...lateFact, line: '  '}, {...lateFact, occurredAt: 'not-an-instant'}, {...lateFact, agentId: '@neo-gpt'}, null],
                          assignments: [{...lateFact, line: null}]
                      })
                  });

            expect(snapshot.rows[0]).toMatchObject({
                laneLine: '[lane-claim] valid', laneClaimedAt: valid.occurredAt, laneSource: {source: FLEET_COCKPIT_SOURCES.a2a},
                sources : {lane: {state: 'wired'}}
            });
        });

        test('a wired source with no claim for a seat reads no lane; nothing held is a named not-wired fact, never a registry lane', () => {
            const empty = createFleetCockpitStatus({
                agents    : [{id: 'seat', githubUsername: 'neo-gpt', laneLine: 'old registry value', statusReason: 'benched'}],
                laneStatus: lanes()
            });

            expect(empty.rows[0]).toMatchObject({
                laneLine: null, laneClaimedAt: null, laneSource: null,
                sources : {lane: {state: 'wired', confidence: 'observed', reason: null}, forgeLane: {state: 'wired'}}
            });

            const none = createFleetCockpitStatus({
                agents      : [{id: 'seat', githubUsername: 'neo-gpt', laneLine: 'old registry value'}],
                capabilities: {lane: a2aWired}
            });

            expect(none.rows[0]).toMatchObject({
                laneLine: null, laneClaimedAt: null, laneSource: null,
                sources : {
                    lane     : {source: FLEET_COCKPIT_SOURCES.a2a, state: 'not-wired', confidence: 'none', reason: 'no lane observation held in this process yet'},
                    forgeLane: {source: FLEET_COCKPIT_SOURCES.commentLane, state: 'not-wired', confidence: 'none', reason: 'no PR/lane read held in this process yet'}
                }
            });
            expect(none.capabilities.lane).toEqual({...none.rows[0].sources.lane, capturedAt: null, policy: null, scanned: null});
            expect(none.capabilities.forgeLane).toEqual({...none.rows[0].sources.forgeLane, capturedAt: null});
        });

        test('a failed or invalid source carries its bounded cause and lends nothing', () => {
            const reason   = '  the lane observer read failed: ' + 'x'.repeat(250) + '  ',
                  snapshot = createFleetCockpitStatus({
                      agents    : [{id: 'seat', githubUsername: 'neo-gpt'}],
                      laneStatus: lanes({
                          a2a    : {...a2aWired, state: 'bogus', reason},
                          entries: [entry('neo-gpt', capturedAt, '[lane-claim] unadmitted')],
                          forge  : {source: FLEET_COCKPIT_SOURCES.commentLane, state: 'degraded', confidence: 'none', reason: 'the PR/lane read answered no lane facts', capturedAt},
                          claims : []
                      })
                  });

            expect(snapshot.rows[0]).toMatchObject({
                laneLine: null, laneSource: null,
                sources : {
                    lane     : {state: 'degraded', confidence: 'none', reason: reason.trim().slice(0, 200)},
                    forgeLane: {state: 'degraded', confidence: 'none', reason: 'the PR/lane read answered no lane facts'}
                }
            });
            expect(createFleetCockpitStatus({agents: [{id: 'seat', githubUsername: 'neo-gpt'}], laneStatus: {a2a: {entries: [entry('neo-gpt', capturedAt, '[lane-claim] unadmitted')]}}}).rows[0])
                .toMatchObject({laneLine: null, sources: {lane: {state: 'degraded', reason: 'held lane source has no valid capability'}}});
        });

        test('under a narrower policy the forge fills the line, and the clamped A2A source lends what it admitted and says so (AC-1b, AC-2)', () => {
            const clamped  = {...a2aWired, state: 'degraded', confidence: 'none', policy: 'private', reason: "the 'private' sharing policy shows other seats' broadcasts only through inbox grants"},
                  snapshot = createFleetCockpitStatus({
                      agents    : [{id: 'gpt', githubUsername: 'neo-gpt'}, {id: 'ada', githubUsername: 'neo-opus-ada'}, {id: 'vega', githubUsername: 'neo-opus-vega'}],
                      laneStatus: lanes({
                          a2a    : clamped,
                          entries: [entry('neo-opus-ada', '2026-10-15T09:47:00.000Z', '[lane-claim] Brain #1041')],
                          claims : [fact('neo-gpt', '2026-10-15T09:15:00.000Z', 'neo-stage#39', 'Stage avatar')]
                      })
                  });

            expect(snapshot.rows.map(row => [row.laneLine, row.laneSource])).toEqual([
                ['neo-stage#39 Stage avatar', {source: FLEET_COCKPIT_SOURCES.commentLane, confidence: 'observed'}],
                ['[lane-claim] Brain #1041', {source: FLEET_COCKPIT_SOURCES.a2a, confidence: 'observed'}],
                [null, null]
            ]);
            expect(snapshot.rows[2].sources.lane, 'a seat without a line is never an empty wired fact').toEqual({
                source: FLEET_COCKPIT_SOURCES.a2a, state: 'degraded', confidence: 'none', reason: clamped.reason
            });
            expect(snapshot.capabilities.lane).toMatchObject({state: 'degraded', policy: 'private', reason: clamped.reason});
        });

        test('the newest explicit claim wins across sources, a newer release ends a forge claim, and an assignment fills only a seat with no standing claim (AC-3)', () => {
            const at       = minutes => new Date(Date.parse('2026-10-15T09:00:00.000Z') + minutes * 60000).toISOString(),
                  snapshot = createFleetCockpitStatus({
                      agents    : ['a', 'b', 'c', 'd', 'e', 'f'].map(login => ({id: login, githubUsername: login})),
                      laneStatus: lanes({
                          entries    : [
                              entry('a', at(1), '[lane-claim] a over A2A'),
                              entry('b', at(2), '[lane-claim] b over A2A'),
                              entry('c', at(2), '[claim-corrected] c is free', 'claim-corrected'),
                              entry('e', at(1), '[lane-claim] e over A2A'),
                              entry('f', at(2), '[claim-corrected] f is free', 'claim-corrected')
                          ],
                          claims     : [fact('a', at(2), 'neo#2', 'a on the forge'), fact('b', at(1), 'neo#1', 'b on the forge'), fact('c', at(1), 'neo#3', 'c on the forge')],
                          assignments: [fact('d', at(5), 'neo#4', 'd assigned'), fact('e', at(9), 'neo#5', 'e assigned, touched since'), fact('f', at(9), 'neo#6', 'f assigned')]
                      })
                  });

            expect(snapshot.rows.map(row => [row.laneLine, row.laneClaimedAt, row.laneSource?.confidence ?? null])).toEqual([
                ['neo#2 a on the forge', at(2), 'observed'],
                ['[lane-claim] b over A2A', at(2), 'observed'],
                [null, null, null],
                ['neo#4 d assigned', null, 'inferred'],
                ['[lane-claim] e over A2A', at(1), 'observed'],
                ['neo#6 f assigned', null, 'inferred']
            ]);
        });

        test('a GitLab seat reads its forge lane source not-wired and no GitHub forge fact; an A2A claim still fills its line (AC-1c)', () => {
            const gitlab   = {forge: 'gitlab', forgeHost: 'https://gitlab.example.com'},
                  snapshot = createFleetCockpitStatus({
                      agents    : [{id: 'lab', githubUsername: 'neo-lab', ...gitlab}, {id: 'lab-a2a', githubUsername: 'neo-lab-two', ...gitlab}],
                      laneStatus: lanes({
                          entries    : [entry('neo-lab-two', capturedAt, '[lane-claim] over A2A')],
                          claims     : [fact('neo-lab', capturedAt, 'neo#7')],
                          assignments: [fact('neo-lab', capturedAt, 'neo#8'), fact('neo-lab-two', '2026-10-15T13:00:00.000Z', 'neo#9')]
                      })
                  });

            expect(snapshot.rows.map(row => row.laneLine)).toEqual([null, '[lane-claim] over A2A']);
            expect(snapshot.rows[0].sources.forgeLane).toEqual({
                source: FLEET_COCKPIT_SOURCES.commentLane, state: 'not-wired', confidence: 'none', reason: 'no GitLab lane reader yet'
            });
            expect(snapshot.rows[1].sources.lane.state).toBe('wired');
        });

        test('broadcasts and forge facts reach the card through the real adapters and wiring: kept past the page, ended by a release (AC-1, AC-3)', async () => {
            const [{wireFleetActivityReadSource}, {createFleetActivityReadSource, FLEET_LANE_OBSERVATION_INTERVAL}, {createFleetPrLaneActivitySnapshot}] = await Promise.all([
                      import('../../../../../../ai/services/fleet/wireFleetActivityReadSource.mjs'),
                      import('../../../../../../ai/services/fleet/fleetActivityComposer.mjs'),
                      import('../../../../../../ai/services/fleet/fleetPrLaneActivityAdapter.mjs')
                  ]),
                  summary = (from, sentAt, subject) => ({messageId: `MESSAGE:${from}@${sentAt}`, from, to: 'AGENT:*', sentAt, subject}),
                  pages   = [
                      [summary('@neo-opus-grace', '2026-10-03T16:57:26.460Z', '🖖 [lane-claim] Institution #508 build'),
                       summary('@neo-opus-ada',   '2026-10-03T12:49:28.018Z', '⚖️ [lane-claim] Brain #811 (the open-work row summary carries the PR title)')],
                      [summary('@neo-gpt',        '2026-10-03T18:25:05.804Z', 'Row state: substrate · Euclid · blocked')],
                      [summary('@neo-opus-ada',   '2026-10-03T18:40:00.000Z', '⚖️ [claim-corrected] Brain #811 merged, the lane is free')]
                  ],
                  issue   = {
                      repoSlug: 'neo-agent-brain', number: 1046,
                      meta    : {id: 1046, title: 'Roster lanes', state: 'OPEN', assignees: ['neo-gpt'], createdAt: '2026-10-03T10:00:00.000Z', updatedAt: '2026-10-03T18:30:00.000Z'},
                      content : '# Roster lanes\n\n### @neo-gpt - 2026-10-03T18:20:00Z\n\n[lane-claim] taking it\n'
                  };
            let   at   = Date.parse('2026-10-03T18:45:00.000Z'),
                  page = pages[0];
            // the operator's own mailbox holds none of the broadcasts; the team observation holds them all
            const listMessages = async args => {
                      const messages = args.observer ? page : [];
                      return {
                          messages, totalCount: messages.length, truncated: false, nextOffset: null, limit: args.limit, offset: args.offset ?? 0,
                          ...(args.observer && {observation: {admissionKey: 'key', clamped: false, planeId: 'plane', policy: 'team', scope: args.observer.scope, viewer: '@tobiu'}})
                      }
                  },
                  source = wireFleetActivityReadSource({
                      bridge               : {},
                      createSource         : options => createFleetActivityReadSource({...options, now: () => at}),
                      listMessages,
                      readPrLane           : async () => createFleetPrLaneActivitySnapshot({issues: [issue]}),
                      resolveViewerIdentity: () => '@tobiu'
                  }),
                  lanesNow = () => createFleetCockpitStatus({
                      agents    : [{id: 'ada', githubUsername: 'neo-opus-ada'}, {id: 'grace', githubUsername: 'neo-opus-grace'}, {id: 'gpt', githubUsername: 'neo-gpt'}],
                      laneStatus: source.readHeldLaneSnapshot()
                  }).rows.map(row => row.laneLine),
                  observe  = async next => {
                      page = next;
                      at  += FLEET_LANE_OBSERVATION_INTERVAL;
                      await source.readActivitySnapshot()
                  };

            await source.readActivitySnapshot();
            expect(lanesNow()).toEqual([
                '⚖️ [lane-claim] Brain #811 (the open-work row summary carries the PR title)', '🖖 [lane-claim] Institution #508 build', 'neo-agent-brain#1046 Roster lanes'
            ]);

            await observe(pages[1]);
            expect(lanesNow(), 'claims outlive the page that carried them').toEqual([
                '⚖️ [lane-claim] Brain #811 (the open-work row summary carries the PR title)', '🖖 [lane-claim] Institution #508 build', 'neo-agent-brain#1046 Roster lanes'
            ]);

            await observe(pages[2]);
            expect(lanesNow()).toEqual([null, '🖖 [lane-claim] Institution #508 build', 'neo-agent-brain#1046 Roster lanes']);
        });
    });
})

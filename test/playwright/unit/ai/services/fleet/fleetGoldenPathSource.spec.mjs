import {expect, test}     from '@playwright/test';
import fs                 from 'fs-extra';
import os                 from 'os';
import path               from 'path';
import Neo                from 'neo.mjs/src/Neo.mjs';
import * as core          from 'neo.mjs/src/core/_export.mjs';
import FleetControlBridge from '../../../../../../ai/services/fleet/FleetControlBridge.mjs';
import {
    createFleetGoldenPathSource,
    projectComputedRoute,
    reduceComputedRouteAnswer
} from '../../../../../../ai/services/fleet/fleetGoldenPathSource.mjs';
import {wireFleetGoldenPathSource}                          from '../../../../../../ai/services/fleet/wireFleetGoldenPathSource.mjs';
import {FLEET_METHOD_SCOPE_CLASSES, FLEET_S1_METHOD_POLICY} from '../../../../../../ai/services/fleet/fleetServerPolicy.mjs';
import {readSandmanHandoff}                                 from '../../../../../../ai/services/memory-core/helpers/sandmanHandoffStore.mjs';
import {FLEET_WIRE_METHODS}                                 from '../../../../../../src/fleet/contract/wire.mjs';

const
    NOW    = '2026-09-25T15:00:00.000Z',
    NOW_MS = Date.parse(NOW),
    ROUTE  = '/plane/handoff/computed-route.json';

/**
 * @summary A `computed-route.v1` sidecar as the synthesizer writes it — two ranked items, fresh
 * for another hour at the fixture clock.
 * @param {Object} [overrides]
 * @returns {Object}
 */
function sidecar(overrides = {}) {
    return {
        schemaVersion     : 'computed-route.v1',
        status            : 'fresh',
        notAuthority      : true,
        capturedAt        : '2026-09-25T14:30:00.000Z',
        expiresAt         : '2026-09-25T16:30:00.000Z',
        routeVersion      : 'route-v3',
        sourceManifestHash: 'a1b2c3d4',
        sourceWatermark   : '2026-09-25T14:30:00.000Z:42',
        provenance        : {producer: 'GoldenPathSynthesizer', runId: 'run-7', algorithmVersion: 'gp-2.1', citations: []},
        freshness         : {status: 'fresh', checkedAt: '2026-09-25T14:30:00.000Z', expiresAt: '2026-09-25T16:30:00.000Z'},
        route             : {
            kind : 'computed-ranked',
            items: [
                {id: 'issue:19220', title: 'The film\'s capture mode births 146 px wide vessels', score: 8.06, rank: 1, citations: [{id: 'pull:19224'}]},
                {id: 'issue:19186', title: 'A vessel parked over another popup shows the stand-in mask', score: 4.3, rank: 2, citations: []}
            ]
        },
        ...overrides
    }
}

/**
 * @summary An admission as the contract answers it when the projection gate is off.
 * @returns {Object}
 */
function gateDisabledAdmission() {
    return {admitted: true, fallback: 'current', reasonCode: 'projection-gate-disabled', requiredFacets: ['issues', 'discussions'], staleFacets: []}
}

/**
 * @summary The `get_computed_route` operation's answer for a served sidecar.
 * @param {Object} [overrides]
 * @returns {Object}
 */
function answer(overrides = {}) {
    return {status: 'available', reason: null, details: null, path: ROUTE, mtimeMs: 1790000000000, route: sidecar(), admission: gateDisabledAdmission(), ...overrides}
}

/**
 * @summary The REM verb's shape at the fixture clock.
 * @returns {Object}
 */
function remState() {
    return {undigested: 990, digested: 1010, sessionNodes: 4769, topologyConflicts: 0, recentCycles: []}
}

/**
 * @summary A handoff containing one strategic section followed by a separate level-two section.
 * @param {Object} [overrides]
 * @returns {Object}
 */
function handoffResult(overrides = {}) {
    return {
        content: [
            '# Sandman handoff',
            '',
            'Opening context.',
            '',
            '## Computed Golden Path (Strategic Recommendation)',
            '',
            'Captured at: 2026-09-25 14:30 UTC',
            '',
            'This recommendation is human-readable producer output.',
            '',
            '### Evidence',
            '',
            '- issue:19220 — Keep this nested content.',
            '',
            '## Current Release / Incident Focus',
            '',
            'Do not include this next section.'
        ].join('\n'),
        mtimeMs     : NOW_MS - 120_000,
        ageMs       : 120_000,
        staleAfterMs: 3_600_000,
        stale       : false,
        reason      : null,
        ...overrides
    }
}

function createSource(overrides = {}) {
    return createFleetGoldenPathSource({
        getComputedRoute   : async () => answer(),
        getRemPipelineState: async () => remState(),
        now                : () => NOW_MS,
        ...overrides
    })
}

test.describe('fleet golden path source — the route axis', () => {
    test('a served sidecar is passed through under the producer\'s own status, items in producer order', () => {
        const axis = reduceComputedRouteAnswer(answer(), NOW_MS);

        expect(axis.state).toBe('wired');
        expect(axis.route).toMatchObject({
            schemaVersion: 'computed-route.v1',
            status       : 'fresh',
            capturedAt   : '2026-09-25T14:30:00.000Z',
            expiresAt    : '2026-09-25T16:30:00.000Z',
            expired      : false,
            routeVersion : 'route-v3',
            provenance   : {producer: 'GoldenPathSynthesizer', runId: 'run-7', algorithmVersion: 'gp-2.1'},
            kind         : 'computed-ranked'
        });
        expect(axis.route.items.map(item => [item.rank, item.id, item.score, item.citations.length])).toEqual([
            [1, 'issue:19220', 8.06, 1],
            [2, 'issue:19186', 4.3, 0]
        ]);
        expect(axis.admission).toEqual(gateDisabledAdmission())
    });

    test('an expired sidecar is still the producer\'s route, and says so — nothing is re-ranked or dropped', () => {
        const route = projectComputedRoute(sidecar(), Date.parse('2026-09-25T18:00:00.000Z'));

        expect(route.expired).toBe(true);
        expect(route.status).toBe('fresh');
        expect(route.items).toHaveLength(2)
    });

    test('the operation\'s typed statuses become degraded reasons with their detail, never an empty route', () => {
        expect(reduceComputedRouteAnswer(answer({status: 'missing', reason: 'route-not-found', route: null}), NOW_MS))
            .toMatchObject({state: 'degraded', reason: 'route-not-found', route: null});

        expect(reduceComputedRouteAnswer(answer({status: 'unreadable', reason: 'route-read-failed', details: {message: 'EACCES'}, route: null}), NOW_MS))
            .toMatchObject({state: 'degraded', reason: 'route-read-failed', detail: 'EACCES', route: null});

        const invalid = reduceComputedRouteAnswer(answer({status: 'invalid', reason: 'route-contract-invalid', details: {errors: ['schemaVersion must be "computed-route.v1"']}, route: null}), NOW_MS);

        expect(invalid).toMatchObject({state: 'degraded', reason: 'route-contract-invalid', route: null});
        expect(invalid.detail).toContain('schemaVersion');

        expect(reduceComputedRouteAnswer({}, NOW_MS)).toMatchObject({state: 'degraded', reason: 'route-answer-malformed', route: null, admission: null})
    })
});

test.describe('fleet golden path source — the envelope', () => {
    test('a served route reads as a wired envelope carrying the route, the admission and the REM counts', async () => {
        const envelope = await createSource().readGoldenPath();

        expect(envelope.capability).toEqual({state: 'wired', capturedAt: NOW});
        expect(envelope.route.items).toHaveLength(2);
        expect(envelope.admission).toEqual(gateDisabledAdmission());
        expect(envelope.rem).toEqual({undigested: 990, digested: 1010, recentCycles: 0});
        expect(envelope.sources).toMatchObject({
            route    : {state: 'wired', reason: null},
            admission: {state: 'current', reason: 'projection-gate-disabled'},
            rem      : {state: 'wired', reason: null}
        })
    });

    test('a withheld admission rides the envelope as the contract gave it, never re-stated', async () => {
        const withheld = {admitted: false, fallback: 'last-known-good', reasonCode: 'freshness-sla-breached', requiredFacets: ['issues', 'discussions'], staleFacets: []},
              envelope = await createSource({getComputedRoute: async () => answer({admission: withheld})}).readGoldenPath();

        expect(envelope.admission).toEqual(withheld);
        expect(envelope.sources.admission).toEqual({state: 'withheld', reason: 'freshness-sla-breached'});
        expect(envelope.capability.state).toBe('wired')
    });

    test('a missing sidecar degrades the envelope with the operation\'s reason while the other axes still answer', async () => {
        const envelope = await createSource({getComputedRoute: async () => answer({status: 'missing', reason: 'route-not-found', route: null})}).readGoldenPath();

        expect(envelope.capability).toEqual({state: 'degraded', capturedAt: NOW, reason: 'route-not-found'});
        expect(envelope.route).toBe(null);
        expect(envelope.admission).toEqual(gateDisabledAdmission());
        expect(envelope.rem).toEqual({undigested: 990, digested: 1010, recentCycles: 0})
    });

    test('a failing route read is its own unavailable axis: no route, no admission, the detail redacted', async () => {
        const envelope = await createSource({getComputedRoute: async () => {throw new Error('plane unreachable: Authorization: Bearer abc123')}}).readGoldenPath();

        expect(envelope.capability).toEqual({state: 'unavailable', capturedAt: NOW, reason: 'route-read-failed'});
        expect(envelope.route).toBe(null);
        expect(envelope.admission).toBe(null);
        expect(envelope.sources.admission).toEqual({state: 'unavailable', reason: 'route-read-failed'});
        expect(envelope.sources.route.detail).not.toContain('abc123');
        expect(envelope.rem).toEqual({undigested: 990, digested: 1010, recentCycles: 0})
    });

    test('a failing REM read is its own unavailable axis; the route still passes through', async () => {
        const envelope = await createSource({getRemPipelineState: async () => {throw new Error('plane unreachable: Authorization: Bearer abc123')}}).readGoldenPath();

        expect(envelope.capability.state).toBe('wired');
        expect(envelope.rem).toBe(null);
        expect(envelope.sources.rem).toMatchObject({state: 'unavailable', reason: 'rem-read-failed'});
        expect(envelope.sources.rem.detail).not.toContain('abc123')
    });

    test('the complete handoff section is preserved verbatim through nested headings and stops before the next level-two section', async () => {
        const input    = handoffResult(),
              start    = input.content.indexOf('## Computed Golden Path (Strategic Recommendation)'),
              end      = input.content.indexOf('## Current Release / Incident Focus'),
              expected = input.content.slice(start, end),
              envelope = await createSource({getSandmanHandoff: async () => input}).readGoldenPath();

        expect(envelope.handoff).toEqual({
            markdown    : expected,
            mtimeMs     : input.mtimeMs,
            ageMs       : input.ageMs,
            staleAfterMs: input.staleAfterMs,
            stale       : false,
            reason      : null
        });
        expect(envelope.handoff.markdown).toContain('### Evidence');
        expect(envelope.handoff.markdown).not.toContain('Current Release / Incident Focus');
        expect(envelope.sources.handoff).toEqual({state: 'available', reason: null})
    });

    test('requests sections: "all" from the real readSandmanHandoff store so the section-only default does not null payload.content', async () => {
        const dir      = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-golden-path-handoff-')),
              filePath = path.join(dir, 'sandman_handoff.md'),
              input    = handoffResult();

        await fs.writeFile(filePath, input.content, 'utf8');

        try {
            const envelope = await createSource({
                getSandmanHandoff: args => readSandmanHandoff({filePath, now: NOW_MS, ...args})
            }).readGoldenPath();

            expect(envelope.sources.handoff).toEqual({state: 'available', reason: null});
            expect(envelope.handoff.reason).toBeNull();
            expect(envelope.handoff.markdown).toContain('## Computed Golden Path (Strategic Recommendation)');
            expect(envelope.handoff.markdown).toContain('### Evidence');
            expect(envelope.handoff.markdown).not.toContain('Current Release / Incident Focus')
        } finally {
            await fs.remove(dir)
        }
    });

    test('handoff staleness is independent of the computed-route capability and preserves the producer file update time', async () => {
        const envelope = await createSource({
            getSandmanHandoff: async () => handoffResult({stale: true, ageMs: 4_000_000, staleAfterMs: 3_600_000})
        }).readGoldenPath();

        expect(envelope.capability.state).toBe('wired');
        expect(envelope.route.items).toHaveLength(2);
        expect(envelope.handoff).toMatchObject({mtimeMs: NOW_MS - 120_000, ageMs: 4_000_000, staleAfterMs: 3_600_000, stale: true, reason: null});
        expect(envelope.sources.handoff).toEqual({state: 'stale', reason: null})
    });

    test('a missing section is explicit while route, admission, REM and file freshness remain available', async () => {
        const envelope = await createSource({
            getSandmanHandoff: async () => handoffResult({content: '# Legacy handoff without the strategic section'})
        }).readGoldenPath();

        expect(envelope.handoff).toEqual({
            markdown    : null,
            mtimeMs     : NOW_MS - 120_000,
            ageMs       : 120_000,
            staleAfterMs: 3_600_000,
            stale       : false,
            reason      : 'handoff-section-not-found'
        });
        expect(envelope.sources.handoff).toEqual({state: 'degraded', reason: 'handoff-section-not-found'});
        expect(envelope.capability.state).toBe('wired');
        expect(envelope.route.items).toHaveLength(2);
        expect(envelope.rem.undigested).toBe(990)
    });

    test('unavailable and throwing handoff reads are explicit, and an older caller without the operation keeps route and REM alive', async () => {
        const unavailable = await createSource({
                  getSandmanHandoff: async () => ({content: null, mtimeMs: null, ageMs: null, staleAfterMs: 3_600_000, stale: true, reason: 'handoff-path-unconfigured'})
              }).readGoldenPath(),
              failed = await createSource({getSandmanHandoff: async () => {throw new Error('handoff unavailable')}}).readGoldenPath(),
              legacy = await createSource().readGoldenPath();

        expect(unavailable.handoff).toMatchObject({markdown: null, reason: 'handoff-path-unconfigured', stale: true});
        expect(unavailable.sources.handoff).toEqual({state: 'unavailable', reason: 'handoff-path-unconfigured'});
        expect(failed.handoff).toMatchObject({markdown: null, reason: 'handoff-read-failed'});
        expect(failed.sources.handoff).toEqual({state: 'unavailable', reason: 'handoff-read-failed'});
        expect(legacy.handoff).toMatchObject({markdown: null, reason: 'handoff-source-unwired'});
        expect(legacy.sources.handoff).toEqual({state: 'unavailable', reason: 'handoff-source-unwired'});
        for (const envelope of [unavailable, failed, legacy]) {
            expect(envelope.capability.state).toBe('wired');
            expect(envelope.route.items).toHaveLength(2);
            expect(envelope.rem.undigested).toBe(990)
        }
    });

    test('the source refuses to exist without both operations', () => {
        expect(() => createFleetGoldenPathSource({getRemPipelineState: async () => ({})})).toThrow(/getComputedRoute/);
        expect(() => createFleetGoldenPathSource({getComputedRoute: async () => ({})})).toThrow(/getRemPipelineState/)
    })
});

test.describe('fleet golden path — the bridge and the wire', () => {
    test('the bridge answers an honest unavailable envelope while no source is wired, and the source once one is', async () => {
        const bridge = Object.create(FleetControlBridge);

        bridge.goldenPathSource = null;

        expect(bridge.fleetGoldenPath()).toEqual({
            capability: {state: 'unavailable', reason: 'fleet golden path source not wired'},
            admission : null,
            route     : null,
            rem       : null,
            sources   : {}
        });

        const wired = wireFleetGoldenPathSource({
            getComputedRoute   : async () => answer(),
            getRemPipelineState: async () => remState(),
            now                : () => NOW_MS,
            bridge,
            createSource       : options => createSource(options)
        });

        expect(wired).toBe(bridge.goldenPathSource);
        await expect(bridge.fleetGoldenPath()).resolves.toMatchObject({capability: {state: 'wired'}})
    });

    test('the wiring refuses without both operations and leaves the slot alone', () => {
        const bridge = {goldenPathSource: null};

        expect(wireFleetGoldenPathSource({getRemPipelineState: async () => ({}), bridge})).toBe(null);
        expect(wireFleetGoldenPathSource({getComputedRoute: async () => ({}), bridge})).toBe(null);
        expect(bridge.goldenPathSource).toBe(null)
    });

    test('handoff wiring forwards only its existing Memory Core operation and remains optional for legacy callers', async () => {
        let receivedArgs;

        const bridge = {goldenPathSource: null};

        wireFleetGoldenPathSource({
            getComputedRoute   : async () => answer(),
            getRemPipelineState: async () => remState(),
            getSandmanHandoff  : async args => {
                receivedArgs = args;

                return handoffResult()
            },
            now: () => NOW_MS,
            bridge
        });

        await bridge.goldenPathSource.readGoldenPath();

        expect(receivedArgs).toEqual({sections: 'all'});

        const legacyBridge = {goldenPathSource: null};

        expect(wireFleetGoldenPathSource({
            getComputedRoute   : async () => answer(),
            getRemPipelineState: async () => remState(),
            bridge             : legacyBridge
        })).toBe(legacyBridge.goldenPathSource);
        await expect(legacyBridge.goldenPathSource.readGoldenPath()).resolves.toMatchObject({
            capability: {state: 'wired'},
            handoff   : {reason: 'handoff-source-unwired'}
        })
    });

    test('fleetGoldenPath is a classified read-observe wire verb awaiting the S3 viewer projection, like fleetTasks', () => {
        expect(FLEET_WIRE_METHODS).toContain('fleetGoldenPath');
        expect(FLEET_METHOD_SCOPE_CLASSES.fleetGoldenPath).toBe('read-observe');
        expect(FLEET_S1_METHOD_POLICY.fleetGoldenPath).toBe(FLEET_S1_METHOD_POLICY.fleetTasks)
    })
});

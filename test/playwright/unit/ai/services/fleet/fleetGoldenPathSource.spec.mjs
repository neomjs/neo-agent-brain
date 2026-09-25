import {expect, test} from '@playwright/test';
import FleetControlBridge from '../../../../../../ai/services/fleet/FleetControlBridge.mjs';
import {
    createFleetGoldenPathSource,
    projectComputedRoute,
    readComputedRouteAxis,
    readProjectionAdmission
} from '../../../../../../ai/services/fleet/fleetGoldenPathSource.mjs';
import {wireFleetGoldenPathSource} from '../../../../../../ai/services/fleet/wireFleetGoldenPathSource.mjs';
import {FLEET_METHOD_SCOPE_CLASSES, FLEET_S1_METHOD_POLICY} from '../../../../../../ai/services/fleet/fleetServerPolicy.mjs';
import {FLEET_WIRE_METHODS} from '../../../../../../src/fleet/contract/wire.mjs';

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
 * @summary File seams over one in-memory sidecar; `text === null` means the file is absent.
 * @param {String|null} text
 * @returns {{exists: Function, readFile: Function}}
 */
function fileSeams(text) {
    return {
        exists  : file => file === ROUTE && text !== null,
        readFile: file => {
            if (file !== ROUTE || text === null) throw new Error(`ENOENT ${file}`);
            return text
        }
    }
}

/**
 * @summary The REM verb's shape at the fixture clock.
 * @returns {Object}
 */
function remState() {
    return {undigested: 990, digested: 1010, sessionNodes: 4769, topologyConflicts: 0, recentCycles: []}
}

/**
 * @summary An admission as the contract answers it when the projection gate is off.
 * @returns {Object}
 */
function gateDisabledAdmission() {
    return {admitted: true, fallback: 'current', reasonCode: 'projection-gate-disabled', requiredFacets: ['issues', 'discussions'], staleFacets: []}
}

function createSource(overrides = {}) {
    return createFleetGoldenPathSource({
        routePath          : ROUTE,
        getRemPipelineState: async () => remState(),
        readAdmission      : async () => gateDisabledAdmission(),
        now                : () => NOW_MS,
        ...fileSeams(JSON.stringify(sidecar())),
        ...overrides
    })
}

test.describe('fleet golden path source — the sidecar axis', () => {
    test('a contract-valid sidecar is passed through under the producer\'s own status, items in producer order', () => {
        const axis = readComputedRouteAxis(ROUTE, {...fileSeams(JSON.stringify(sidecar())), nowMs: NOW_MS});

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
        ])
    });

    test('an expired sidecar is still the producer\'s route, and says so — nothing is re-ranked or dropped', () => {
        const route = projectComputedRoute(sidecar(), Date.parse('2026-09-25T18:00:00.000Z'));

        expect(route.expired).toBe(true);
        expect(route.status).toBe('fresh');
        expect(route.items).toHaveLength(2)
    });

    test('a missing, unreadable or contract-invalid sidecar is a degraded axis with its reason, never an empty route', () => {
        expect(readComputedRouteAxis(ROUTE, {...fileSeams(null), nowMs: NOW_MS}))
            .toMatchObject({state: 'degraded', reason: 'route-sidecar-missing', route: null});

        expect(readComputedRouteAxis(ROUTE, {...fileSeams('{not json'), nowMs: NOW_MS}))
            .toMatchObject({state: 'degraded', reason: 'route-sidecar-unreadable', route: null});

        const invalid = readComputedRouteAxis(ROUTE, {...fileSeams(JSON.stringify(sidecar({schemaVersion: 'computed-route.v0'}))), nowMs: NOW_MS});

        expect(invalid).toMatchObject({state: 'degraded', reason: 'route-sidecar-invalid', route: null});
        expect(invalid.detail).toContain('schemaVersion')
    })
});

test.describe('fleet golden path source — the admission axis', () => {
    test('the production read resolves its own projection leaves; under the test profile the gate is off and admits by the contract\'s own word', async () => {
        // the receipt seam must not be consulted while the gate is off — a read that reached it would throw here
        await expect(readProjectionAdmission({readReceipt: async () => {throw new Error('receipt read while the gate is off')}}))
            .resolves.toEqual(gateDisabledAdmission())
    });

    test('a withheld admission rides the envelope as the contract gave it, never re-stated', async () => {
        const withheld = {admitted: false, fallback: 'last-known-good', reasonCode: 'freshness-sla-breached', requiredFacets: ['issues', 'discussions'], staleFacets: []},
              envelope = await createSource({readAdmission: async () => withheld}).readGoldenPath();

        expect(envelope.admission).toEqual(withheld);
        expect(envelope.sources.admission).toEqual({state: 'withheld', reason: 'freshness-sla-breached'});
        expect(envelope.capability.state).toBe('wired')
    })
});

test.describe('fleet golden path source — the envelope', () => {
    test('a valid sidecar reads as a wired envelope carrying the route, the admission and the REM counts', async () => {
        const envelope = await createSource().readGoldenPath();

        expect(envelope.capability).toEqual({state: 'wired', capturedAt: NOW});
        expect(envelope.route.items).toHaveLength(2);
        expect(envelope.admission).toMatchObject({admitted: true, reasonCode: 'projection-gate-disabled'});
        expect(envelope.rem).toEqual({undigested: 990, digested: 1010, recentCycles: 0});
        expect(envelope.sources).toMatchObject({
            route    : {state: 'wired', reason: null},
            admission: {state: 'current', reason: 'projection-gate-disabled'},
            rem      : {state: 'wired', reason: null}
        })
    });

    test('a missing sidecar degrades the envelope with the axis reason while the other axes still answer', async () => {
        const envelope = await createSource(fileSeams(null)).readGoldenPath();

        expect(envelope.capability).toEqual({state: 'degraded', capturedAt: NOW, reason: 'route-sidecar-missing'});
        expect(envelope.route).toBe(null);
        expect(envelope.rem).toEqual({undigested: 990, digested: 1010, recentCycles: 0})
    });

    test('a failing REM read is its own unavailable axis; the route still passes through', async () => {
        const envelope = await createSource({getRemPipelineState: async () => {throw new Error('plane unreachable: Authorization: Bearer abc123')}}).readGoldenPath();

        expect(envelope.capability.state).toBe('wired');
        expect(envelope.rem).toBe(null);
        expect(envelope.sources.rem).toMatchObject({state: 'unavailable', reason: 'rem-read-failed'});
        expect(envelope.sources.rem.detail).not.toContain('abc123')
    });

    test('the source refuses to exist without a route path or a REM operation', () => {
        expect(() => createFleetGoldenPathSource({routePath: '', getRemPipelineState: async () => ({})})).toThrow(/routePath/);
        expect(() => createFleetGoldenPathSource({routePath: ROUTE})).toThrow(/getRemPipelineState/)
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
            routePath          : ROUTE,
            getRemPipelineState: async () => remState(),
            now                : () => NOW_MS,
            bridge,
            createSource       : options => createSource(options)
        });

        expect(wired).toBe(bridge.goldenPathSource);
        await expect(bridge.fleetGoldenPath()).resolves.toMatchObject({capability: {state: 'wired'}})
    });

    test('the wiring refuses without a route path or a REM operation and leaves the slot alone', () => {
        const bridge = {goldenPathSource: null};

        expect(wireFleetGoldenPathSource({routePath: '', getRemPipelineState: async () => ({}), bridge})).toBe(null);
        expect(wireFleetGoldenPathSource({routePath: ROUTE, bridge})).toBe(null);
        expect(bridge.goldenPathSource).toBe(null)
    });

    test('fleetGoldenPath is a classified read-observe wire verb awaiting the S3 viewer projection, like fleetTasks', () => {
        expect(FLEET_WIRE_METHODS).toContain('fleetGoldenPath');
        expect(FLEET_METHOD_SCOPE_CLASSES.fleetGoldenPath).toBe('read-observe');
        expect(FLEET_S1_METHOD_POLICY.fleetGoldenPath).toBe(FLEET_S1_METHOD_POLICY.fleetTasks)
    })
});

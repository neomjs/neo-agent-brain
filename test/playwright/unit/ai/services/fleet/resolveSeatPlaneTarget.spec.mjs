import {test, expect} from '@playwright/test';

import {listHarnessTypes}       from '../../../../../../src/fleet/contract/harnessTypes.mjs';
import {planeMcpResources}      from '../../../../../../ai/services/fleet/mcpWireParsing.mjs';
import {resolveSeatPlaneTarget} from '../../../../../../ai/services/fleet/resolveSeatPlaneTarget.mjs';

/**
 * Where a seat's Memory Core and Knowledge Base live (`ai/services/fleet/resolveSeatPlaneTarget.mjs`).
 * The harness families are enumerated from the Fleet contract, never restated, so a family added there
 * is covered here without anyone teaching this spec about it.
 */

const
    PLANE  = 'http://127.0.0.1:3102',
    REMOTE = listHarnessTypes().filter(entry => entry.tenantMcpTarget).map(entry => entry.type),
    LOCAL  = listHarnessTypes().filter(entry => !entry.tenantMcpTarget).map(entry => entry.type),
    TENANT = Object.freeze({kind: 'tenant', tenantId: 'plane.example.com-1a2b3c4d'});

test.describe('resolveSeatPlaneTarget — a seat\'s memories live where its peers read them', () => {
    test('the contract still has families on both sides, so neither arm below is vacuous', () => {
        expect(REMOTE.length).toBeGreaterThan(0);
        expect(LOCAL).toContain('antigravity');
    });

    test('every remote-capable family on a Fleet that serves a plane reaches that plane', () => {
        for (const harnessType of REMOTE) {
            expect(resolveSeatPlaneTarget({target: null, harnessType, planeBase: PLANE})).toEqual({
                kind     : 'plane',
                endpoint : PLANE,
                resources: {'memory-core': {url: `${PLANE}/mc/mcp`}, 'knowledge-base': {url: `${PLANE}/kb/mcp`}}
            });
        }
    });

    test('the plane is addressed by its canonical endpoint, so one plane has one set of URLs', () => {
        expect(resolveSeatPlaneTarget({target: null, harnessType: 'codex', planeBase: ' http://127.0.0.1:3102/ '}))
            .toMatchObject({endpoint: PLANE, resources: planeMcpResources(PLANE)});
    });

    test('a seat bound to a connected tenant keeps it, with or without a Fleet plane', () => {
        for (const planeBase of [PLANE, '']) {
            expect(resolveSeatPlaneTarget({target: TENANT, harnessType: 'codex-desktop', planeBase})).toEqual(TENANT);
        }
    });

    test('a Fleet that serves no plane keeps the per-seat store, and says why', () => {
        for (const planeBase of ['', undefined, null]) {
            expect(resolveSeatPlaneTarget({target: null, harnessType: 'claude-code', planeBase})).toEqual({
                kind  : 'resident',
                reason: 'the Fleet serves no plane, and own mode serves no Memory Core or Knowledge Base endpoint yet'
            });
        }
    });

    test('a family that cannot reach a remote Memory Core keeps its own store, named by its family', () => {
        for (const harnessType of LOCAL) {
            expect(resolveSeatPlaneTarget({target: null, harnessType, planeBase: PLANE})).toEqual({
                kind  : 'resident',
                reason: `${harnessType} cannot reach a remote Memory Core, so its memories stay on this seat`
            });
        }
    });

    test('a declared plane that is not a secure MCP endpoint refuses the start rather than forking memory', () => {
        for (const planeBase of ['http://plane.example.com', 'https://user:secret@plane.example.com', 'not a url', 'ftp://127.0.0.1']) {
            expect(resolveSeatPlaneTarget({target: null, harnessType: 'codex', planeBase})).toEqual({
                kind  : 'refused',
                reason: 'fleet.planeBase is not a secure MCP endpoint, and a private per-seat store is no fallback'
            });
        }
    });
});

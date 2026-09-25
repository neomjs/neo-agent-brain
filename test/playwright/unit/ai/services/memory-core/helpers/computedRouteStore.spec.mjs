import {test, expect}  from '@playwright/test';
import {execFile}      from 'node:child_process';
import fs              from 'fs-extra';
import os              from 'os';
import path            from 'path';
import {fileURLToPath} from 'node:url';
import {promisify}     from 'node:util';

import {readComputedRoute} from '../../../../../../../ai/services/memory-core/helpers/computedRouteStore.mjs';

/**
 * @summary A `computed-route.v1` sidecar as the synthesizer writes it.
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
        route             : {kind: 'computed-ranked', items: [{id: 'issue:19220', title: 'The film\'s capture mode births 146 px wide vessels', score: 8.06, rank: 1, citations: []}]},
        ...overrides
    }
}

async function withSidecar(text, run) {
    const dir      = await fs.mkdtemp(path.join(os.tmpdir(), 'computed-route-store-')),
          filePath = path.join(dir, 'computed-route.json');

    text !== null && await fs.writeFile(filePath, text, 'utf8');

    try {
        return await run(filePath, dir)
    } finally {
        await fs.remove(dir)
    }
}

test.describe('computedRouteStore — the route half of get_computed_route', () => {
    test('a contract-valid sidecar is served as written, with the gate-disabled admission', async () => {
        await withSidecar(JSON.stringify(sidecar()), async filePath => {
            const read = await readComputedRoute({filePath, projectionEnabled: false});

            expect(read).toMatchObject({status: 'available', reason: null, details: null, path: filePath});
            expect(read.mtimeMs).toBeGreaterThan(0);
            expect(read.route).toEqual(sidecar());
            expect(read.admission).toMatchObject({admitted: true, fallback: 'current', reasonCode: 'projection-gate-disabled'})
        })
    });

    test('a missing, oversized, unreadable or contract-invalid sidecar is a typed status with a stable reason, never a throw', async () => {
        await withSidecar(null, async filePath => {
            expect(await readComputedRoute({filePath, projectionEnabled: false})).toMatchObject({status: 'missing', reason: 'route-not-found', route: null})
        });

        await withSidecar(JSON.stringify(sidecar()), async filePath => {
            expect(await readComputedRoute({filePath, projectionEnabled: false, maxBytes: 16})).toMatchObject({status: 'unreadable', reason: 'route-too-large', route: null})
        });

        await withSidecar('{not json', async filePath => {
            expect(await readComputedRoute({filePath, projectionEnabled: false})).toMatchObject({status: 'unreadable', reason: 'route-read-failed', route: null})
        });

        await withSidecar(JSON.stringify(sidecar({schemaVersion: 'computed-route.v0'})), async filePath => {
            const read = await readComputedRoute({filePath, projectionEnabled: false});

            expect(read).toMatchObject({status: 'invalid', reason: 'route-contract-invalid', route: null});
            expect(read.details.errors.join(' ')).toContain('schemaVersion')
        });

        expect(await readComputedRoute({filePath: '', projectionEnabled: false})).toMatchObject({status: 'missing', reason: 'route-path-unconfigured', route: null})
    });

    test('with the gate on, an absent or unreadable receipt withholds by the contract\'s own reason and the route still serves', async () => {
        await withSidecar(JSON.stringify(sidecar()), async filePath => {
            const absent = await readComputedRoute({filePath, projectionEnabled: true, receiptPath: '/plane/receipt.json', sourceRepository: 'neomjs/neo', sourceRef: 'dev', readReceipt: async () => null});

            expect(absent.status).toBe('available');
            expect(absent.admission.admitted).toBe(false);
            expect(absent.admission.fallback).toBe('last-known-good');
            expect(typeof absent.admission.reasonCode).toBe('string');

            const unreadable = await readComputedRoute({filePath, projectionEnabled: true, receiptPath: '/plane/receipt.json', sourceRepository: 'neomjs/neo', sourceRef: 'dev', readReceipt: async () => {throw new Error('EACCES')}});

            expect(unreadable.admission).toMatchObject({admitted: false, fallback: 'last-known-good'})
        })
    });

    test('the MCP dispatch derives the sidecar from the Memory Core handoff path and serves it through get_computed_route', async () => {
        const dir         = await fs.mkdtemp(path.join(os.tmpdir(), 'computed-route-binding-')),
              handoffPath = path.join(dir, 'handoff.md'),
              routePath   = path.join(dir, 'computed-route.json');

        await fs.writeFile(handoffPath, '# handoff\n', 'utf8');
        await fs.writeFile(routePath, JSON.stringify(sidecar()), 'utf8');

        try {
            const {stdout} = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
                import 'neo.mjs/src/Neo.mjs';
                import 'neo.mjs/src/core/_export.mjs';
                const {callTool} = await import('./ai/mcp/server/memory-core/toolService.mjs');
                const result = await callTool('get_computed_route', {});
                console.log('ROUTE=' + JSON.stringify(result));
                process.exit(0);
            `], {
                cwd     : fileURLToPath(new URL('../../../../../../../', import.meta.url)),
                encoding: 'utf8',
                timeout : 15_000,
                env     : {...process.env, UNIT_TEST_MODE: 'true', NEO_HANDOFF_FILE_PATH_TEST: handoffPath}
            });
            const read = JSON.parse(stdout.split('\n').find(line => line.startsWith('ROUTE=')).slice(6));

            expect(read).toMatchObject({status: 'available', reason: null, path: routePath});
            expect(read.route.route.items).toHaveLength(1);
            expect(read.admission).toMatchObject({admitted: true, reasonCode: 'projection-gate-disabled'})
        } finally {
            await fs.remove(dir)
        }
    })
});

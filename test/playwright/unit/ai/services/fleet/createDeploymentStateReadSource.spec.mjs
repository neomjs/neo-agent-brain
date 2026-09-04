import {test, expect}                    from '@playwright/test';
import Neo                               from 'neo.mjs/src/Neo.mjs';
import * as core                         from 'neo.mjs/src/core/_export.mjs';
import {mkdir, mkdtemp, writeFile, rm}   from 'node:fs/promises';
import {tmpdir}                          from 'node:os';
import path                              from 'node:path';
import {createDeploymentStateReadSource} from '../../../../../../ai/services/fleet/createDeploymentStateReadSource.mjs';
import {
    createDeploymentStateSnapshot,
    readDeploymentStateSnapshot,
    writeDeploymentStateSnapshot
} from '../../../../../../ai/services/memory-core/helpers/deploymentStateBridgeStore.mjs';

const
    NOW         = 1_700_000_000_000,
    STALE_AFTER = 120_000,
    MAX_BYTES   = 256 * 1024,
    serviceRow  = () => ({
        schemaVersion : 1,
        recordType    : 'deployment-service-state',
        serviceKey    : 'mc-server',
        observedAt    : NOW,
        status        : {status: 'available', disposition: 'below'},
        memoryPressure: {disposition: 'below', reason: null, receipt: null},
        resolvedConfig: {dataDir: '/app/.neo-ai-data/private'},
        inspect       : {containerId: 'abc123'},
        restartChurn  : {baseline: 'available', detecting: true},
        classification: null,
        diagnosis     : null
    }),
    // the producer's own envelope: what the orchestrator writes, not a hand-shaped stand-in
    producerSnapshot = ({generatedAt = NOW} = {}) => createDeploymentStateSnapshot({generatedAt, services: [serviceRow()]});

test.describe('createDeploymentStateReadSource — the fleet-server adapter over the Memory Core\'s snapshot reader', () => {
    let dir, filePath;

    test.beforeEach(async () => {
        dir      = await mkdtemp(path.join(tmpdir(), 'neo-deployment-state-read-'));
        filePath = path.join(dir, 'snapshot.json')
    });

    test.afterEach(async () => {
        await rm(dir, {recursive: true, force: true})
    });

    const source = (overrides = {}) => createDeploymentStateReadSource({
        path        : filePath,
        staleAfterMs: STALE_AFTER,
        maxBytes    : MAX_BYTES,
        now         : () => NOW,
        ...overrides
    });

    test('a fresh producer envelope projects OK, aged on its own generatedAt, redacted', async () => {
        await writeDeploymentStateSnapshot({filePath, snapshot: producerSnapshot()});

        const projection = await source().produceDeploymentState();

        expect(projection.state).toBe('ok');
        expect(projection.reason).toBeNull();
        expect(projection.generatedAt).toBe(NOW);
        expect(projection.ageMs).toBe(0);
        expect(projection.services.map(service => service.serviceKey)).toEqual(['mc-server']);
        expect(projection.services[0]).not.toHaveProperty('resolvedConfig');
        expect(projection.services[0]).not.toHaveProperty('inspect')
    });

    test('a retained envelope copied into place now still reads STALE — the file clock renews nothing', async () => {
        // generatedAt is ten minutes old; the file itself is written this instant
        await writeDeploymentStateSnapshot({filePath, snapshot: producerSnapshot({generatedAt: NOW - 600_000})});

        const projection = await source().produceDeploymentState();

        expect(projection.state).toBe('stale');
        expect(projection.ageMs).toBe(600_000);
        expect(projection.generatedAt).toBe(NOW - 600_000);
        expect(projection.services).toHaveLength(1)
    });

    test('an envelope missing its sections is the reader\'s DEGRADED verdict, projected as unavailable under that reason', async () => {
        await writeFile(filePath, '{}');

        const
            oracle     = await readDeploymentStateSnapshot({filePath, now: NOW, staleAfterMs: STALE_AFTER, maxBytes: MAX_BYTES}),
            projection = await source().produceDeploymentState();

        expect(oracle.status).toBe('degraded');
        expect(oracle.reason).toBe('snapshot-section-missing');
        expect(projection).toMatchObject({state: 'unavailable', reason: 'snapshot-section-missing', services: []})
    });

    test('a directory at the path is a FAILED read, distinguishable from an absent file', async () => {
        await mkdir(filePath);

        const projection = await source().produceDeploymentState();

        expect(projection.state).toBe('unavailable');
        expect(projection.reason).toBe('snapshot-read-failed')
    });

    test('absent, oversized, corrupt and unconfigured each carry the reader\'s own reason — never a fabricated plane', async () => {
        expect(await source().produceDeploymentState()).toMatchObject({state: 'unavailable', reason: 'snapshot-missing', services: []});

        await writeDeploymentStateSnapshot({filePath, snapshot: producerSnapshot()});
        expect(await source({maxBytes: 16}).produceDeploymentState()).toMatchObject({state: 'unavailable', reason: 'snapshot-too-large'});

        await writeFile(filePath, '{not json');
        expect(await source().produceDeploymentState()).toMatchObject({state: 'unavailable', reason: 'snapshot-read-failed'});

        expect(await source({path: ''}).produceDeploymentState()).toMatchObject({state: 'unavailable', reason: 'snapshot-path-unconfigured'})
    });

    test('the reader seam receives the resolved leaves and the source clock; an available verdict is projected as handed back', async () => {
        const seen = [];

        const projection = await source({
            readImpl: async options => {
                seen.push(options);
                return {status: 'available', ageMs: 5, snapshot: producerSnapshot(), reason: null}
            }
        }).produceDeploymentState();

        expect(seen).toEqual([{filePath, now: NOW, staleAfterMs: STALE_AFTER, maxBytes: MAX_BYTES}]);
        expect(projection.state).toBe('ok');
        expect(projection.ageMs).toBe(5)
    });

    test('a reader that answers nothing usable is a failed read, and every unavailable result is a FRESH object', async () => {
        const
            nothing = source({readImpl: async () => null}),
            a       = await nothing.produceDeploymentState(),
            b       = await nothing.produceDeploymentState();

        expect(a.reason).toBe('snapshot-read-failed');
        a.services.push('mutated');
        expect(b.services).toEqual([]);
        expect(b).not.toBe(a)
    });

    test('the shape is observe-only: no actuator rides the source', () => {
        expect(Object.keys(source())).toEqual(['produceDeploymentState'])
    });
});

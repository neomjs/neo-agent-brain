import {test, expect}           from '@playwright/test';
import Neo                      from 'neo.mjs/src/Neo.mjs';
import * as core                from 'neo.mjs/src/core/_export.mjs';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir}                 from 'node:os';
import path                     from 'node:path';
import {
    createDeploymentStateReadSource,
    DEPLOYMENT_STATE_READ_REASONS,
    readDeploymentStateSnapshotFile
} from '../../../../../../ai/services/fleet/createDeploymentStateReadSource.mjs';

const snapshotFixture = () => ({
    generatedAt: 1000,
    services   : [{
        schemaVersion : 1,
        recordType    : 'deployment-service-state',
        serviceKey    : 'mc-server',
        observedAt    : 1000,
        status        : {status: 'available', disposition: 'below'},
        memoryPressure: {disposition: 'below', reason: null, receipt: null},
        resolvedConfig: {dataDir: '/app/.neo-ai-data/private'},
        inspect       : {containerId: 'abc123'},
        restartChurn  : {baseline: 'available', detecting: true},
        classification: null,
        diagnosis     : null
    }]
});

test.describe('createDeploymentStateReadSource — the fleet-server reader over the orchestrator\'s snapshot file (#314)', () => {
    test('produceDeploymentState projects the snapshot the reader hands back, aged on the file\'s own clock', async () => {
        const seen   = [];
        const source = createDeploymentStateReadSource({
            path        : '/plane/deployment-state/snapshot.json',
            staleAfterMs: 120000,
            maxBytes    : 256 * 1024,
            now         : () => 61000,
            readImpl    : async ({path, maxBytes}) => { seen.push([path, maxBytes]); return {snapshot: snapshotFixture(), mtimeMs: 1000}; }
        });

        const result = await source.produceDeploymentState();

        expect(seen).toEqual([['/plane/deployment-state/snapshot.json', 256 * 1024]]); // the reader is pointed at the leaf values
        expect(result.state).toBe('ok');
        expect(result.ageMs).toBe(60000);
        expect(result.services.map(row => row.serviceKey)).toEqual(['mc-server']);
    });

    test('an old file reads STALE with its age — never silently current', async () => {
        const source = createDeploymentStateReadSource({
            path    : '/p', staleAfterMs: 120000, maxBytes: 1024, now: () => 500000,
            readImpl: async () => ({snapshot: snapshotFixture(), mtimeMs: 1000})
        });

        const result = await source.produceDeploymentState();

        expect(result.state).toBe('stale');
        expect(result.ageMs).toBe(499000);
        expect(result.services).toHaveLength(1); // the last known picture still renders, marked stale
    });

    test('the reader\'s named reasons land as UNAVAILABLE with that reason and no services — never a fabricated plane', async () => {
        for (const reason of Object.values(DEPLOYMENT_STATE_READ_REASONS)) {
            const source = createDeploymentStateReadSource({path: '/p', staleAfterMs: 1, maxBytes: 1, readImpl: async () => ({reason})});
            const result = await source.produceDeploymentState();

            expect(result.state).toBe('unavailable');
            expect(result.reason).toBe(reason);
            expect(result.services).toEqual([]);
        }
    });

    test('a reader that returns nothing usable is unreadable, and each unavailable result is a FRESH object', async () => {
        const source = createDeploymentStateReadSource({path: '/p', staleAfterMs: 1, maxBytes: 1, readImpl: async () => null});

        const a = await source.produceDeploymentState();
        expect(a.state).toBe('unavailable');
        expect(a.reason).toBe(DEPLOYMENT_STATE_READ_REASONS.unreadable);

        a.reason = 'mutated';
        const b = await source.produceDeploymentState();
        expect(b.reason).toBe(DEPLOYMENT_STATE_READ_REASONS.unreadable); // b is unaffected by mutating a
    });

    test('the shape is observe-only: no actuator rides the source', async () => {
        const source = createDeploymentStateReadSource({path: '/p', staleAfterMs: 1, maxBytes: 1, readImpl: async () => null});
        const result = await source.produceDeploymentState();

        expect(Object.keys(source)).toEqual(['produceDeploymentState']);
        expect(result).not.toHaveProperty('restart');
    });

    test.describe('readDeploymentStateSnapshotFile — the real file reader, byte-bound and fail-soft', () => {
        let dir;

        test.beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'neo-deployment-state-')); });
        test.afterEach(async () => { await rm(dir, {recursive: true, force: true}); });

        test('reads a well-formed snapshot with its mtime', async () => {
            const file = path.join(dir, 'snapshot.json');
            await writeFile(file, JSON.stringify(snapshotFixture()));

            const read = await readDeploymentStateSnapshotFile({path: file, maxBytes: 256 * 1024});

            expect(read.snapshot.services[0].serviceKey).toBe('mc-server');
            expect(typeof read.mtimeMs).toBe('number');
        });

        test('an absent file is the absent reason, never a throw', async () => {
            expect(await readDeploymentStateSnapshotFile({path: path.join(dir, 'missing.json'), maxBytes: 1024}))
                .toEqual({reason: DEPLOYMENT_STATE_READ_REASONS.absent});
        });

        test('a file over maxBytes is refused UNPARSED — the too-large reason', async () => {
            const file = path.join(dir, 'snapshot.json');
            await writeFile(file, JSON.stringify(snapshotFixture()));

            expect(await readDeploymentStateSnapshotFile({path: file, maxBytes: 16}))
                .toEqual({reason: DEPLOYMENT_STATE_READ_REASONS.tooLarge});
        });

        test('corrupt JSON and a non-object document are the unreadable reason', async () => {
            const corrupt = path.join(dir, 'corrupt.json'),
                  scalar  = path.join(dir, 'scalar.json');
            await writeFile(corrupt, '{"generatedAt": ');
            await writeFile(scalar, '42');

            expect(await readDeploymentStateSnapshotFile({path: corrupt, maxBytes: 1024})).toEqual({reason: DEPLOYMENT_STATE_READ_REASONS.unreadable});
            expect(await readDeploymentStateSnapshotFile({path: scalar, maxBytes: 1024})).toEqual({reason: DEPLOYMENT_STATE_READ_REASONS.unreadable});
        });
    });
});

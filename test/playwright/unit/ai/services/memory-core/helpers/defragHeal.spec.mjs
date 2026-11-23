import {test, expect} from '@playwright/test';
import fs             from 'fs-extra';
import os             from 'node:os';
import path           from 'node:path';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import {
    createDefragHealOperation,
    estimateRequiredShadowBytes,
    inspectAndHashKbBundle,
    measureChromaDiskHeadroom,
    streamKbBundleIntoCollection,
    validateCanonicalCollectionAgainstBundle,
    waitForChromaHeartbeat,
    waitForKbWriteDrainAck
} from '../../../../../../../ai/services/memory-core/helpers/defragHeal.mjs';
import {dispatchHeal} from '../../../../../../../ai/services/memory-core/helpers/healActionDispatch.mjs';
import {
    clearDefragState,
    listCollectionIds,
    rewriteCollectionViaShadowPromotion,
    writeDefragState
} from '../../../../../../../ai/scripts/maintenance/defragChromaDB.mjs';
import {
    createBundlePayloadWriteStream,
    endBundlePayload
} from '../../../../../../../ai/services/shared/bundlePayload.mjs';
import {
    acquireHeavyMaintenanceLease,
    releaseHeavyMaintenanceLease,
    withHeavyMaintenanceLease
} from '../../../../../../../ai/daemons/orchestrator/services/heavyMaintenanceLeasePrimitives.mjs';
import {createKbWriteGate} from '../../../../../../../ai/services/knowledge-base/helpers/kbWriteGate.mjs';

const KB_COLLECTION = 'neo-knowledge-base';
const DIM           = 4;
const NOW           = 1_795_400_000_000;

/**
 * @summary Writes a genuine brotli-compressed Knowledge Base backup bundle fixture on disk.
 * @param {Object} options
 * @param {String} options.rootDir Temporary parent directory.
 * @param {Array<Object>} options.rows KB rows (`{id, embedding, metadata, document}`).
 * @param {Array<Object>} [options.integrityOverride] Optional custom `bundle-meta.integrity` array.
 * @returns {Promise<{bundleRoot: String, meta: Object}>}
 */
async function createTempKbBundle({rootDir, rows, integrityOverride = null}) {
    const bundleRoot = path.join(rootDir, `backup-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
          kbDir      = path.join(bundleRoot, 'kb'),
          payload    = path.join(kbDir, 'kb-backup-fixture.jsonl.br');

    await fs.ensureDir(kbDir);

    const writer = createBundlePayloadWriteStream(payload);
    for (const row of rows) {
        writer.write(`${JSON.stringify(row)}\n`);
    }
    await endBundlePayload(writer);

    const integrity = integrityOverride ?? [
        {subsystem: 'kb',    status: rows.length > 0 ? 'pass' : 'empty', sourceCount: rows.length, bundleCount: rows.length},
        {subsystem: 'mc',    status: 'pass', sourceCount: 10, bundleCount: 10},
        {subsystem: 'graph', status: 'pass', sourceCount: 20, bundleCount: 20}
    ];

    const meta = {
        schemaVersion: 1,
        createdAt    : new Date(NOW).toISOString(),
        integrity
    };

    await fs.writeJson(path.join(bundleRoot, 'bundle-meta.json'), meta, {spaces: 2});

    return {bundleRoot, meta};
}

/**
 * @summary In-memory Chroma client double supporting `createCollection`, `getCollection`, `deleteCollection`,
 * `modify({name})`, `add`, `upsert`, `delete`, `get`, and `count` across a simulated restart boundary.
 * @param {Object} [initialRowsByName={}] Initial collection map `name -> Array<{id, embedding, metadata, document}>`.
 * @returns {Object}
 */
function createMockChroma(initialRowsByName = {}) {
    const store = new Map();

    const makeHandle = initialName => {
        let currentName = initialName;

        return {
            get name() {
                return currentName;
            },
            async count() {
                const rows = store.get(currentName);
                if (!rows) throw new Error(`Collection ${currentName} does not exist`);
                return rows.size;
            },
            async add({ids = [], embeddings = [], metadatas = [], documents} = {}) {
                const rows = store.get(currentName);
                if (!rows) throw new Error(`Collection ${currentName} does not exist`);
                for (let i = 0; i < ids.length; i++) {
                    rows.set(ids[i], {
                        id       : ids[i],
                        embedding: embeddings[i],
                        metadata : metadatas[i] ?? {},
                        document : documents ? documents[i] : null
                    });
                }
            },
            async upsert(payload) {
                return this.add(payload);
            },
            async delete({ids = []} = {}) {
                const rows = store.get(currentName);
                if (!rows) throw new Error(`Collection ${currentName} does not exist`);
                for (const id of ids) {
                    rows.delete(id);
                }
            },
            async get({ids = null, limit = 2000, offset = 0, include = ['embeddings', 'metadatas', 'documents']} = {}) {
                const rows = store.get(currentName);
                if (!rows) throw new Error(`Collection ${currentName} does not exist`);

                const entries = ids
                    ? ids.filter(id => rows.has(id)).map(id => rows.get(id))
                    : Array.from(rows.values()).slice(offset, offset + limit);

                const result = {ids: entries.map(entry => entry.id)};
                if (include.includes('embeddings')) result.embeddings = entries.map(entry => entry.embedding);
                if (include.includes('metadatas'))  result.metadatas  = entries.map(entry => entry.metadata);
                if (include.includes('documents'))  result.documents  = entries.map(entry => entry.document);
                return result;
            },
            async modify({name: nextName} = {}) {
                const rows = store.get(currentName);
                if (!rows) throw new Error(`Collection ${currentName} does not exist`);
                if (store.has(nextName)) throw new Error(`Collection ${nextName} already exists`);
                store.delete(currentName);
                store.set(nextName, rows);
                currentName = nextName;
            }
        };
    };

    for (const [name, rows] of Object.entries(initialRowsByName)) {
        const map = new Map();
        for (const row of rows) {
            map.set(row.id, {...row});
        }
        store.set(name, map);
    }

    return {
        store,
        async heartbeat() {
            return {'nanosecond heartbeat': NOW};
        },
        async createCollection({name}) {
            if (store.has(name)) {
                throw new Error(`Collection ${name} already exists`);
            }
            store.set(name, new Map());
            return makeHandle(name);
        },
        async getCollection({name}) {
            if (!store.has(name)) {
                const err = new Error(`Collection ${name} does not exist.`);
                err.name  = 'ChromaNotFoundError';
                throw err;
            }
            return makeHandle(name);
        },
        async deleteCollection({name}) {
            if (!store.has(name)) {
                throw new Error(`Collection ${name} does not exist.`);
            }
            store.delete(name);
        }
    };
}

function sampleRows() {
    return [
        {id: 'kb-1', embedding: [0.1, 0.2, 0.3, 0.4], metadata: {source: 'src/Neo.mjs'},       document: null},
        {id: 'kb-2', embedding: [0.5, 0.6, 0.7, 0.8], metadata: {source: 'src/core/Base.mjs'}, document: null},
        {id: 'kb-3', embedding: [0.9, 0.1, 0.2, 0.3], metadata: {source: 'src/data/Store.mjs'}, document: null}
    ];
}

function bloatedObservation(overrides = {}) {
    return {
        status          : 'ok',
        collection      : KB_COLLECTION,
        dimension       : DIM,
        vectorSegmentIds: ['11111111-1111-4111-8111-111111111111'],
        hnswOccupancy   : 10,
        liveCount       : 3,
        deadElementCount: 7,
        deadFraction    : 0.7,
        ...overrides
    };
}

test.describe('Neo.ai.services.memory-core.helpers.defragHeal', () => {
    let tempRoot;

    test.beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-defrag-heal-spec-'));
    });

    test.afterEach(async () => {
        if (tempRoot) {
            await fs.remove(tempRoot);
        }
    });

    test('executes full fenced KB defrag pipeline in strict order and integrates with dispatchHeal anti-thrash', async () => {
        const rows      = sampleRows(),
              chroma    = createMockChroma({[KB_COLLECTION]: rows}),
              leasePath = path.join(tempRoot, 'lease', 'heavy-maintenance-lease.json'),
              statePath = path.join(tempRoot, 'defrag-state', 'kb.json'),
              writeGate = createKbWriteGate({leasePath}),
              events    = [],
              runs      = [];

        let drainPolls = 0;

        const defragOp = createDefragHealOperation({
            getExpectedCollection: () => KB_COLLECTION,
            readDeadElements     : async () => {
                events.push('read-dead-elements');
                return {observation: bloatedObservation(), gcDefragThreshold: 0.2};
            },
            withWriterFence: async task => {
                const outcome = await withHeavyMaintenanceLease(
                    async acquisition => {
                        events.push(`lease-acquired:${acquisition.lease.kbWriteExclusive}`);
                        return task({lease: acquisition.lease});
                    },
                    {
                        owner           : 'defrag-heal',
                        reason          : 'kb-store-bloat-defrag',
                        kbWriteExclusive: true,
                        leasePath,
                        staleAfterMs    : 60_000
                    }
                );
                events.push('lease-released');
                return outcome.result;
            },
            probeKbWriteGate: async () => {
                drainPolls += 1;
                const realGate = await writeGate.getHealthStatus();
                events.push(`probe-write-gate:${drainPolls}:${realGate.gate}`);
                // Simulate one in-flight KB write draining on the second poll
                return drainPolls === 1 ? {...realGate, inFlightWrites: 1} : realGate;
            },
            writeBackupBundle: async () => {
                events.push('write-backup-bundle');
                return createTempKbBundle({rootDir: tempRoot, rows});
            },
            checkFreeDisk: async () => {
                events.push('check-free-disk');
                return {ok: true, freeBytes: 10_000_000, requiredBytes: 100_000};
            },
            promoteShadow: async ({collectionName, bundleRoot, kbDir, sourceIds, bundleSha, expectedDimension, now}) => {
                events.push('promote-shadow');
                return rewriteCollectionViaShadowPromotion({
                    client      : chroma,
                    collectionName,
                    sourceIds,
                    loadShadowFn: ({collection}) => streamKbBundleIntoCollection({
                        kbDir,
                        collection,
                        expectedDimension: DIM,
                        batchSize        : 2
                    }),
                    embeddingFunction: {},
                    statePath,
                    stateBase        : {bundleSha, bundleRoot, expectedDimension},
                    timestamp        : now,
                    log              : () => {},
                    warn             : () => {}
                });
            },
            readAttemptState : async () => (await fs.pathExists(statePath)) ? fs.readJson(statePath) : null,
            writeAttemptState: state => writeDefragState({statePath, state}),
            clearAttemptState: () => clearDefragState({statePath}),
            restartService   : async serviceKey => {
                // Verify both lease AND durable state marker remain on disk through both restarts
                expect(await fs.pathExists(leasePath)).toBe(true);
                expect(await fs.pathExists(statePath)).toBe(true);
                events.push(`restart:${serviceKey}`);
            },
            waitForChromaReady: async () => {
                events.push('wait-chroma-ready');
            },
            revalidateCanonical: async ({collectionName, expectedIds, sampleRow}) => {
                events.push('revalidate-canonical');
                const collection = await chroma.getCollection({name: collectionName});
                return validateCanonicalCollectionAgainstBundle({
                    collection,
                    expectedIds,
                    sampleRow,
                    listIdsFn: listCollectionIds
                });
            },
            restoreFromBundle  : async () => {
                events.push('restore-from-bundle');
            },
            drainPollIntervalMs: 0,
            sleep              : async () => {}
        });

        const firstOutcome = await dispatchHeal({
            action        : 'defrag',
            collection    : KB_COLLECTION,
            now           : NOW,
            recentRuns    : runs,
            healOperations: {defrag: defragOp},
            recordRun     : async attempt => { runs.push(attempt); }
        });

        expect(firstOutcome.status).toBe('healed');
        expect(firstOutcome.detail).toMatchObject({
            collection         : KB_COLLECTION,
            expectedCount      : 3,
            observedCount      : 3,
            deadFractionBefore : 0.7,
            hnswOccupancyBefore: 10,
            liveCountBefore    : 3,
            parkingDeleted     : true
        });
        expect(firstOutcome.detail.bundleSha).toMatch(/^[0-9a-f]{64}$/);
        expect(runs).toHaveLength(1);
        expect(await fs.pathExists(leasePath)).toBe(false);
        expect(await fs.pathExists(statePath)).toBe(false);

        expect(events).toEqual([
            'read-dead-elements',
            'lease-acquired:true',
            'probe-write-gate:1:closed',
            'probe-write-gate:2:closed',
            'write-backup-bundle',
            'check-free-disk',
            'promote-shadow',
            'restart:chroma',
            'wait-chroma-ready',
            'revalidate-canonical',
            'restart:kb-server',
            'lease-released'
        ]);

        // Anti-thrash cooldown holds an immediate repeat run
        const secondOutcome = await dispatchHeal({
            action        : 'defrag',
            collection    : KB_COLLECTION,
            now           : NOW + 1_000,
            recentRuns    : runs,
            healOperations: {defrag: defragOp},
            recordRun     : async attempt => { runs.push(attempt); }
        });

        expect(secondOutcome.status).toBe('thrash-cooldown');
    });

    test('returns unsafe-input for any target other than the KB collection and mutates nothing', async () => {
        const touched = [];
        const op      = createDefragHealOperation({
            getExpectedCollection: () => KB_COLLECTION,
            readDeadElements     : async () => { touched.push('read'); return {}; },
            withWriterFence      : async () => { touched.push('fence'); },
            probeKbWriteGate     : async () => { touched.push('probe'); },
            writeBackupBundle    : async () => { touched.push('backup'); },
            checkFreeDisk        : async () => { touched.push('disk'); },
            promoteShadow        : async () => { touched.push('promote'); },
            restartService       : async () => { touched.push('restart'); },
            revalidateCanonical  : async () => { touched.push('revalidate'); },
            restoreFromBundle    : async () => { touched.push('restore'); }
        });

        for (const invalidTarget of ['neo-agent-sessions', 'neo-agent-memory', 'other', '', null]) {
            const outcome = await op({collection: invalidTarget, now: NOW});
            expect(outcome.status).toBe('unsafe-input');
            expect(outcome.detail.reason).toBe('unsupported-defrag-target');
        }

        expect(touched).toEqual([]);
    });

    test('defers without acquiring lease or mutating when dead-element ratio is at/below threshold or unverified', async () => {
        const mutations   = [];
        let   observation = bloatedObservation({deadFraction: 0.2, deadElementCount: 2});

        const op = createDefragHealOperation({
            getExpectedCollection: () => KB_COLLECTION,
            readDeadElements     : async () => ({observation, gcDefragThreshold: 0.2}),
            withWriterFence      : async () => { mutations.push('fence'); },
            probeKbWriteGate     : async () => { mutations.push('probe'); },
            writeBackupBundle    : async () => { mutations.push('backup'); },
            checkFreeDisk        : async () => { mutations.push('disk'); },
            promoteShadow        : async () => { mutations.push('promote'); },
            restartService       : async () => { mutations.push('restart'); },
            revalidateCanonical  : async () => { mutations.push('revalidate'); },
            restoreFromBundle    : async () => { mutations.push('restore'); }
        });

        const atThreshold = await op({collection: KB_COLLECTION, now: NOW});
        expect(atThreshold).toMatchObject({
            status: 'deferred',
            detail: {reason: 'below-defrag-threshold', deadFraction: 0.2, gcDefragThreshold: 0.2}
        });

        observation     = {status: 'unverified', reason: 'hot-rollback-journal'};
        const hotSqlite = await op({collection: KB_COLLECTION, now: NOW});
        expect(hotSqlite).toMatchObject({
            status: 'deferred',
            detail: {
                reason           : 'dead-element-observation-unavailable',
                observationStatus: 'unverified',
                observationReason: 'hot-rollback-journal'
            }
        });

        expect(mutations).toEqual([]);
    });

    test('defers and mutates nothing when lease is held or kb-server drain acknowledgement times out', async () => {
        const leasePath = path.join(tempRoot, 'contended', 'heavy-maintenance-lease.json'),
              mutations = [];

        const external = await acquireHeavyMaintenanceLease({
            leasePath,
            owner       : 'backup',
            reason      : 'scheduled',
            staleAfterMs: 60_000
        });
        expect(external.acquired).toBe(true);

        let fakeClock = NOW;

        const op = createDefragHealOperation({
            getExpectedCollection: () => KB_COLLECTION,
            readDeadElements     : async () => ({observation: bloatedObservation(), gcDefragThreshold: 0.2}),
            withWriterFence      : async task => {
                const outcome = await withHeavyMaintenanceLease(
                    acquisition => task({lease: acquisition.lease}),
                    {
                        owner           : 'defrag-heal',
                        reason          : 'kb-store-bloat-defrag',
                        kbWriteExclusive: true,
                        leasePath,
                        staleAfterMs    : 60_000
                    }
                );
                return outcome.status === 'completed'
                    ? outcome.result
                    : {status: 'deferred', detail: {reason: 'writer-fence-not-acquired', holder: outcome.lease?.owner ?? null}};
            },
            probeKbWriteGate   : async () => ({gate: 'closed', leaseId: 'wrong-lease-id', inFlightWrites: 0}),
            writeBackupBundle  : async () => { mutations.push('backup'); },
            checkFreeDisk      : async () => { mutations.push('disk'); },
            promoteShadow      : async () => { mutations.push('promote'); },
            restartService     : async () => { mutations.push('restart'); },
            revalidateCanonical: async () => { mutations.push('revalidate'); },
            restoreFromBundle  : async () => { mutations.push('restore'); },
            drainTimeoutMs     : 1_000,
            drainPollIntervalMs: 250,
            clock              : () => fakeClock,
            sleep              : async ms => { fakeClock += ms; }
        });

        // 1. Contended lease -> deferred before probing kb-server
        const heldOutcome = await op({collection: KB_COLLECTION, now: NOW});
        expect(heldOutcome).toMatchObject({
            status: 'deferred',
            detail: {reason: 'writer-fence-not-acquired', holder: 'backup'}
        });

        await releaseHeavyMaintenanceLease({leasePath, token: external.lease.token});

        // 2. Lease acquired, but kb-server reports wrong leaseId -> deferred + lease released, zero mutations
        const unackedOutcome = await op({collection: KB_COLLECTION, now: NOW});
        expect(unackedOutcome).toMatchObject({
            status: 'deferred',
            detail: {reason: 'kb-write-drain-unacknowledged', timeoutMs: 1_000}
        });
        expect(await fs.pathExists(leasePath)).toBe(false);
        expect(mutations).toEqual([]);
    });

    test('gates rename on bundle integrity (never status: success) and defers when free disk is insufficient', async () => {
        const rows      = sampleRows(),
              mutations = [];

        let integrityOverride = [
            {subsystem: 'kb',    status: 'empty', sourceCount: 0, bundleCount: 0},
            {subsystem: 'mc',    status: 'pass',  sourceCount: 5, bundleCount: 5},
            {subsystem: 'graph', status: 'pass',  sourceCount: 5, bundleCount: 5}
        ];
        let freeBytes = 100;

        const op = createDefragHealOperation({
            getExpectedCollection: () => KB_COLLECTION,
            readDeadElements     : async () => ({observation: bloatedObservation(), gcDefragThreshold: 0.2}),
            withWriterFence      : task => task({lease: {leaseId: 'lease-1'}}),
            probeKbWriteGate     : async () => ({gate: 'closed', leaseId: 'lease-1', inFlightWrites: 0}),
            writeBackupBundle    : async () => ({
                status: 'success',
                ...(await createTempKbBundle({rootDir: tempRoot, rows: integrityOverride ? [] : rows, integrityOverride}))
            }),
            checkFreeDisk: async ({liveCount, dimension}) => {
                const requiredBytes = estimateRequiredShadowBytes({liveCount, dimension});
                return {ok: freeBytes >= requiredBytes, freeBytes, requiredBytes};
            },
            promoteShadow      : async () => { mutations.push('promote'); },
            restartService     : async () => { mutations.push('restart'); },
            revalidateCanonical: async () => { mutations.push('revalidate'); },
            restoreFromBundle  : async () => { mutations.push('restore'); }
        });

        const emptyBundleOutcome = await op({collection: KB_COLLECTION, now: NOW});
        expect(emptyBundleOutcome).toMatchObject({
            status: 'failed',
            detail: {reason: 'bundle-integrity-check-failed', restorable: false}
        });
        expect(mutations).toEqual([]);

        // Valid bundle, insufficient free disk -> deferred before shadow creation, sha recorded
        integrityOverride         = null;
        const lowDiskOutcome = await op({collection: KB_COLLECTION, now: NOW});
        expect(lowDiskOutcome.status).toBe('deferred');
        expect(lowDiskOutcome.detail.reason).toBe('insufficient-free-disk-for-shadow');
        expect(lowDiskOutcome.detail.bundleSha).toMatch(/^[0-9a-f]{64}$/);
        expect(mutations).toEqual([]);
    });

    test('restores from bundle and records failed with both counts when store reports 0 rows after restart (#66 shape)', async () => {
        const rows      = sampleRows(),
              chroma    = createMockChroma({[KB_COLLECTION]: rows}),
              leasePath = path.join(tempRoot, 'zero-after-restart', 'heavy-maintenance-lease.json'),
              statePath = path.join(tempRoot, 'defrag-state', 'kb-zero.json'),
              events    = [];

        const op = createDefragHealOperation({
            getExpectedCollection: () => KB_COLLECTION,
            readDeadElements     : async () => ({observation: bloatedObservation(), gcDefragThreshold: 0.2}),
            withWriterFence      : async task => {
                const outcome = await withHeavyMaintenanceLease(
                    acquisition => task({lease: acquisition.lease}),
                    {
                        owner           : 'defrag-heal',
                        reason          : 'kb-store-bloat-defrag',
                        kbWriteExclusive: true,
                        leasePath,
                        staleAfterMs    : 60_000
                    }
                );
                events.push('lease-released');
                return outcome.result;
            },
            probeKbWriteGate : async () => createKbWriteGate({leasePath}).getHealthStatus(),
            writeBackupBundle: () => createTempKbBundle({rootDir: tempRoot, rows}),
            checkFreeDisk    : async () => ({ok: true, freeBytes: 10_000_000, requiredBytes: 10_000}),
            promoteShadow    : async ({collectionName, bundleRoot, kbDir, sourceIds, bundleSha, expectedDimension, now}) => {
                return rewriteCollectionViaShadowPromotion({
                    client           : chroma,
                    collectionName,
                    sourceIds,
                    loadShadowFn     : ({collection}) => streamKbBundleIntoCollection({kbDir, collection, expectedDimension: DIM}),
                    embeddingFunction: {},
                    statePath,
                    stateBase        : {bundleSha, bundleRoot, expectedDimension},
                    timestamp        : now,
                    log              : () => {},
                    warn             : () => {}
                });
            },
            readAttemptState : async () => (await fs.pathExists(statePath)) ? fs.readJson(statePath) : null,
            writeAttemptState: state => writeDefragState({statePath, state}),
            clearAttemptState: () => clearDefragState({statePath}),
            restartService   : async serviceKey => {
                events.push(`restart:${serviceKey}`);
                if (serviceKey === 'chroma') {
                    // Simulate post-restart data loss: Chroma restart discards the promoted rows, leaving an empty 0-row store.
                    chroma.store.set(KB_COLLECTION, new Map());
                }
            },
            revalidateCanonical: async ({collectionName, expectedIds, sampleRow}) => {
                const collection = await chroma.getCollection({name: collectionName});
                return validateCanonicalCollectionAgainstBundle({
                    collection,
                    expectedIds,
                    sampleRow,
                    listIdsFn: listCollectionIds
                });
            },
            restoreFromBundle: async ({kbDir}) => {
                events.push('restore-from-bundle');
                const collection = await chroma.getCollection({name: KB_COLLECTION});
                await streamKbBundleIntoCollection({kbDir, collection, expectedDimension: DIM});
            }
        });

        const outcome = await op({collection: KB_COLLECTION, now: NOW});

        expect(outcome.status).toBe('failed');
        expect(outcome.detail).toMatchObject({
            reason        : 'post-restart-count-mismatch',
            collection    : KB_COLLECTION,
            expectedCount : 3,
            observedCount : 0,
            missingIdCount: 3,
            extraIdCount  : 0,
            restored      : true
        });
        expect(outcome.detail.bundleSha).toMatch(/^[0-9a-f]{64}$/);

        // Bundle restore brought all 3 records back before kb-server restarted and before lease released
        const restoredCollection = await chroma.getCollection({name: KB_COLLECTION});
        expect(await restoredCollection.count()).toBe(3);
        expect(await listCollectionIds({collection: restoredCollection})).toEqual(['kb-1', 'kb-2', 'kb-3']);
        expect(events).toEqual([
            'restart:chroma',
            'restore-from-bundle',
            'restart:kb-server',
            'lease-released'
        ]);
    });

    test('detects post-restart id-set mismatch at equal count, deletes stray ids, and restores canonical rows', async () => {
        const rows   = sampleRows(),
              chroma = createMockChroma({[KB_COLLECTION]: rows});

        const op = createDefragHealOperation({
            getExpectedCollection: () => KB_COLLECTION,
            readDeadElements     : async () => ({observation: bloatedObservation(), gcDefragThreshold: 0.2}),
            withWriterFence      : task => task({lease: {leaseId: 'lease-id-mismatch'}}),
            probeKbWriteGate     : async () => ({gate: 'closed', leaseId: 'lease-id-mismatch', inFlightWrites: 0}),
            writeBackupBundle    : () => createTempKbBundle({rootDir: tempRoot, rows}),
            checkFreeDisk        : async () => ({ok: true, freeBytes: 10_000_000, requiredBytes: 10_000}),
            promoteShadow        : async () => ({shadowName: 's', parkingName: 'p', parkingDeleted: true}),
            restartService       : async serviceKey => {
                if (serviceKey === 'chroma') {
                    // Same count (3), wrong ID set ('kb-3' replaced by 'kb-stray')
                    const map = chroma.store.get(KB_COLLECTION);
                    map.delete('kb-3');
                    map.set('kb-stray', {id: 'kb-stray', embedding: [0.1, 0.1, 0.1, 0.1], metadata: {}, document: null});
                }
            },
            revalidateCanonical: async ({collectionName, expectedIds, sampleRow}) => {
                const collection = await chroma.getCollection({name: collectionName});
                return validateCanonicalCollectionAgainstBundle({
                    collection,
                    expectedIds,
                    sampleRow,
                    listIdsFn: listCollectionIds
                });
            },
            restoreFromBundle: async ({kbDir, extraIds}) => {
                const collection = await chroma.getCollection({name: KB_COLLECTION});
                if (extraIds.length > 0) {
                    await collection.delete({ids: extraIds});
                }
                await streamKbBundleIntoCollection({kbDir, collection, expectedDimension: DIM});
            }
        });

        const outcome = await op({collection: KB_COLLECTION, now: NOW});

        expect(outcome).toMatchObject({
            status: 'failed',
            detail: {
                reason        : 'post-restart-id-set-mismatch',
                expectedCount : 3,
                observedCount : 3,
                missingIdCount: 1,
                extraIdCount  : 1,
                restored      : true
            }
        });

        const collection = await chroma.getCollection({name: KB_COLLECTION});
        expect((await listCollectionIds({collection})).sort()).toEqual(['kb-1', 'kb-2', 'kb-3']);
    });

    test('measureChromaDiskHeadroom and waitForChromaHeartbeat honor disk bounds and readiness polling', async () => {
        const segmentId  = '22222222-2222-4222-8222-222222222222',
              segmentDir = path.join(tempRoot, segmentId);

        await fs.ensureDir(segmentDir);
        await fs.writeFile(path.join(segmentDir, 'data_level0.bin'), Buffer.alloc(4096));

        const headroomOk = await measureChromaDiskHeadroom({
            dataDir         : tempRoot,
            liveCount       : 2,
            dimension       : DIM,
            hnswOccupancy   : 4,
            vectorSegmentIds: [segmentId],
            fsModule        : {
                readdir: (...args) => fs.promises.readdir(...args),
                stat   : (...args) => fs.promises.stat(...args),
                statfs : async () => ({bavail: 1000, bsize: 4096})
            }
        });
        expect(headroomOk.ok).toBe(true);

        const headroomLow = await measureChromaDiskHeadroom({
            dataDir         : tempRoot,
            liveCount       : 2,
            dimension       : DIM,
            hnswOccupancy   : 4,
            vectorSegmentIds: [segmentId],
            fsModule        : {
                readdir: (...args) => fs.promises.readdir(...args),
                stat   : (...args) => fs.promises.stat(...args),
                statfs : async () => ({bavail: 1, bsize: 512})
            }
        });
        expect(headroomLow.ok).toBe(false);
        expect(headroomLow.reason).toBe('insufficient-free-disk-for-shadow');

        let attempts = 0;
        await waitForChromaHeartbeat({
            heartbeatFn   : async () => {
                if (++attempts < 3) throw new Error('ECONNREFUSED');
            },
            timeoutMs     : 5_000,
            pollIntervalMs: 0,
            sleep         : async () => {}
        });
        expect(attempts).toBe(3);

        const bundle = await createTempKbBundle({rootDir: tempRoot, rows: sampleRows()});
        const info   = await inspectAndHashKbBundle({bundleRoot: bundle.bundleRoot, meta: bundle.meta, expectedDimension: DIM});
        expect(info.ok).toBe(true);
        expect(info.expectedCount).toBe(3);

        const drainTimeout = await waitForKbWriteDrainAck({
            leaseId         : 'lease-a',
            probeKbWriteGate: async () => ({gate: 'open', leaseId: null, inFlightWrites: 0}),
            timeoutMs       : 0,
            pollIntervalMs  : 0,
            sleep           : async () => {}
        });
        expect(drainTimeout.acknowledged).toBe(false);
    });

    test('post-promotion throws refresh kb-server before lease release, preserve bundle anchor in dispatchHeal, and reconcile on the next run', async () => {
        const scenarios = [
            {
                name             : 'chroma-restart',
                expectedReason   : 'chroma-restart-failed',
                failChromaRestart: true,
                postRecoveryEmpty: false
            },
            {
                name             : 'chroma-readiness',
                expectedReason   : 'chroma-readiness-failed',
                failReadiness    : true,
                postRecoveryEmpty: true
            },
            {
                name             : 'post-restart-revalidation',
                expectedReason   : 'post-restart-revalidation-failed',
                failRevalidation : true,
                postRecoveryEmpty: false
            }
        ];

        for (const scenario of scenarios) {
            const rows      = sampleRows(),
                  chroma    = createMockChroma({[KB_COLLECTION]: rows}),
                  leasePath = path.join(tempRoot, scenario.name, 'heavy-maintenance-lease.json'),
                  statePath = path.join(tempRoot, scenario.name, 'knowledge-base-heal.json'),
                  events    = [],
                  runs      = [];

            let faultActive = true;

            const op = createDefragHealOperation({
                getExpectedCollection: () => KB_COLLECTION,
                readDeadElements     : async () => {
                    events.push('read-dead-elements');
                    // On Run 2 after promotion, simulate post-swap 0% dead elements (or 0 live rows) to prove
                    // durable reconciliation is not skipped by the threshold/empty pre-gates.
                    return faultActive
                        ? {observation: bloatedObservation(), gcDefragThreshold: 0.2}
                        : {
                            observation      : bloatedObservation({
                                hnswOccupancy   : scenario.postRecoveryEmpty ? 0 : 3,
                                liveCount       : scenario.postRecoveryEmpty ? 0 : 3,
                                deadElementCount: 0,
                                deadFraction    : 0
                            }),
                            gcDefragThreshold: 0.2
                        };
                },
                withWriterFence: async task => {
                    const outcome = await withHeavyMaintenanceLease(
                        acquisition => task({lease: acquisition.lease}),
                        {
                            owner           : 'defrag-heal',
                            reason          : 'kb-store-bloat-defrag',
                            kbWriteExclusive: true,
                            leasePath,
                            staleAfterMs    : 60_000
                        }
                    );
                    events.push('lease-released');
                    return outcome.result;
                },
                probeKbWriteGate : async () => createKbWriteGate({leasePath}).getHealthStatus(),
                writeBackupBundle: () => createTempKbBundle({rootDir: tempRoot, rows}),
                checkFreeDisk    : async () => ({ok: true, freeBytes: 10_000_000, requiredBytes: 10_000}),
                promoteShadow    : async ({collectionName, bundleRoot, kbDir, sourceIds, bundleSha, expectedDimension, now}) => {
                    events.push('promote-shadow');
                    return rewriteCollectionViaShadowPromotion({
                        client           : chroma,
                        collectionName,
                        sourceIds,
                        loadShadowFn     : ({collection}) => streamKbBundleIntoCollection({kbDir, collection, expectedDimension: DIM}),
                        embeddingFunction: {},
                        statePath,
                        stateBase        : {bundleSha, bundleRoot, expectedDimension},
                        timestamp        : now,
                        log              : () => {},
                        warn             : () => {}
                    });
                },
                readAttemptState : async () => (await fs.pathExists(statePath)) ? fs.readJson(statePath) : null,
                writeAttemptState: state => writeDefragState({statePath, state}),
                clearAttemptState: () => clearDefragState({statePath}),
                restartService   : async serviceKey => {
                    expect(await fs.pathExists(leasePath)).toBe(true);
                    events.push(`restart:${serviceKey}`);
                    if (serviceKey === 'chroma') {
                        if (faultActive && scenario.failChromaRestart) {
                            throw new Error('runtime-access-disabled');
                        }
                        if (scenario.postRecoveryEmpty) {
                            chroma.store.set(KB_COLLECTION, new Map());
                        }
                    }
                },
                waitForChromaReady: async () => {
                    events.push('wait-chroma-ready');
                    if (faultActive && scenario.failReadiness) {
                        throw new Error('Chroma did not become ready within 30000ms after restart');
                    }
                },
                revalidateCanonical: async ({collectionName, expectedIds, sampleRow}) => {
                    events.push('revalidate-canonical');
                    if (faultActive && scenario.failRevalidation) {
                        throw new Error('Chroma get failed: ECONNRESET');
                    }
                    const collection = await chroma.getCollection({name: collectionName});
                    return validateCanonicalCollectionAgainstBundle({
                        collection,
                        expectedIds,
                        sampleRow,
                        listIdsFn: listCollectionIds
                    });
                },
                restoreFromBundle: async ({kbDir}) => {
                    events.push('restore-from-bundle');
                    const collection = await chroma.getCollection({name: KB_COLLECTION});
                    await streamKbBundleIntoCollection({kbDir, collection, expectedDimension: DIM});
                }
            });

            const firstDispatch = await dispatchHeal({
                action        : 'defrag',
                collection    : KB_COLLECTION,
                now           : NOW,
                recentRuns    : runs,
                healOperations: {defrag: op},
                recordRun     : async attempt => { runs.push(attempt); }
            });

            expect(firstDispatch.status).toBe('failed');
            expect(firstDispatch.detail).toMatchObject({
                reason              : scenario.expectedReason,
                failedStep          : scenario.name,
                collection          : KB_COLLECTION,
                expectedCount       : 3,
                postRestartValidated: false,
                kbServerRestarted   : true
            });
            expect(firstDispatch.detail.bundleSha).toMatch(/^[0-9a-f]{64}$/);
            expect(typeof firstDispatch.detail.bundleRoot).toBe('string');

            // kb-server restart MUST precede lease release on every post-promotion throw
            const kbRestartIdx    = events.lastIndexOf('restart:kb-server'),
                  leaseReleaseIdx = events.lastIndexOf('lease-released');
            expect(kbRestartIdx).toBeGreaterThan(-1);
            expect(kbRestartIdx).toBeLessThan(leaseReleaseIdx);

            // Durable state marker remains on disk carrying the restore anchor
            expect(await fs.pathExists(statePath)).toBe(true);
            const persisted = await fs.readJson(statePath);
            expect(persisted).toMatchObject({
                phase     : 'post-promotion-unverified',
                failedStep: scenario.name,
                bundleSha : firstDispatch.detail.bundleSha,
                bundleRoot: firstDispatch.detail.bundleRoot
            });

            // Run 2 after cooldown reconciles from the durable attempt state without re-running promoteShadow
            faultActive  = false;
            events.length = 0;

            const secondDispatch = await dispatchHeal({
                action        : 'defrag',
                collection    : KB_COLLECTION,
                now           : NOW + 600_001,
                recentRuns    : runs,
                healOperations: {defrag: op},
                recordRun     : async attempt => { runs.push(attempt); }
            });

            expect(events).not.toContain('promote-shadow');
            expect(events).not.toContain('read-dead-elements');

            if (scenario.postRecoveryEmpty) {
                expect(secondDispatch.status).toBe('failed');
                expect(secondDispatch.detail).toMatchObject({
                    reason                      : 'post-restart-count-mismatch',
                    failedStep                  : 'post-restart-validation',
                    expectedCount               : 3,
                    observedCount               : 0,
                    restored                    : true,
                    kbServerRestarted           : true,
                    reconciledInterruptedAttempt: true
                });
                const restoredCol = await chroma.getCollection({name: KB_COLLECTION});
                expect(await restoredCol.count()).toBe(3);
            } else {
                expect(secondDispatch.status).toBe('healed');
                expect(secondDispatch.detail).toMatchObject({
                    collection                  : KB_COLLECTION,
                    expectedCount               : 3,
                    observedCount               : 3,
                    bundleSha                   : firstDispatch.detail.bundleSha,
                    bundleRoot                  : firstDispatch.detail.bundleRoot,
                    reconciledInterruptedAttempt: true
                });
                // Refused chroma-restart retries restart:chroma on Run 2; readiness/revalidation throws do not re-bounce chroma
                if (scenario.failChromaRestart) {
                    expect(events).toContain('restart:chroma');
                } else {
                    expect(events).not.toContain('restart:chroma');
                }
            }

            expect(await fs.pathExists(statePath)).toBe(false);
            expect(events.lastIndexOf('restart:kb-server')).toBeLessThan(events.lastIndexOf('lease-released'));
        }
    });
});

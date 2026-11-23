import {test, expect}                  from '@playwright/test';
import Database                        from 'better-sqlite3';
import fs                              from 'node:fs/promises';
import os                              from 'node:os';
import path                            from 'node:path';
import Neo                             from 'neo.mjs/src/Neo.mjs';
import * as core                       from 'neo.mjs/src/core/_export.mjs';
import AiConfig                        from '../../../../../../../ai/config.template.mjs';
import kbConfig                        from '../../../../../../../ai/mcp/server/knowledge-base/config.template.mjs';
import {Orchestrator}                  from '../../../../../../../ai/daemons/orchestrator/Orchestrator.mjs';
import {DataIntegrityDiagnosisService} from '../../../../../../../ai/daemons/orchestrator/services/DataIntegrityDiagnosisService.mjs';
import {
    CHROMA_159_MIGRATIONS,
    HNSW_HEADER_BYTE_LENGTH,
    HNSW_PERSISTENCE_VERSION
} from '../../../../../../../ai/daemons/orchestrator/services/kbDeadElementDiagnosis.mjs';
import {
    createLiveKbDeadElementGatherer,
    inspectChromaStoreRuntimeBinding,
    readKbDeadElementObservation,
    readLiveKbDeadElements,
    readSqliteRegistryReadOnly,
    SQLITE_ROLLBACK_JOURNAL_MAGIC
} from '../../../../../../../ai/daemons/orchestrator/services/kbDeadElementGatherer.mjs';

void core;

const KB_COLLECTION_ID = '8a49c911-3d21-4eb0-a822-6c7a09c9b143';
const KB_VECTOR_SEG_ID = 'c71d29ae-0d58-4a34-9c66-4f8c1d18a901';
const VECTOR_DIM       = 1024;
const OBSERVED_AT      = 1732345000000;

function writeHeaderBuffer({
    curElementCount = 253_743n,
    maxElements     = 300_000n,
    dimension       = VECTOR_DIM,
    maxM0           = 32n
} = {}) {
    const buf         = Buffer.alloc(HNSW_HEADER_BYTE_LENGTH),
          offsetData  = 4n + maxM0 * 4n,
          labelOffset = offsetData + BigInt(dimension) * 4n,
          sizeData    = labelOffset + 8n;

    buf.writeInt32LE(HNSW_PERSISTENCE_VERSION, 0);
    buf.writeBigUInt64LE(0n, 4);
    buf.writeBigUInt64LE(maxElements, 12);
    buf.writeBigUInt64LE(curElementCount, 20);
    buf.writeBigUInt64LE(sizeData, 28);
    buf.writeBigUInt64LE(labelOffset, 36);
    buf.writeBigUInt64LE(offsetData, 44);
    buf.writeInt32LE(3, 52);
    buf.writeUInt32LE(0, 56);
    buf.writeBigUInt64LE(16n, 60);
    buf.writeBigUInt64LE(maxM0, 68);
    buf.writeBigUInt64LE(16n, 76);
    buf.writeDoubleLE(0.36067376022224085, 84);
    buf.writeBigUInt64LE(100n, 92);

    return buf;
}

async function seedChroma159Store(rootDir, {
    curElementCount       = 253_743n,
    vectorCheckpointSeqId = 500,
    queuedTailRows        = 0,
    collectionName        = kbConfig.collectionName,
    databaseName          = kbConfig.chromaDatabase
} = {}) {
    const sqlitePath = path.join(rootDir, 'chroma.sqlite3'),
          segmentDir = path.join(rootDir, KB_VECTOR_SEG_ID),
          db         = new Database(sqlitePath);

    try {
        db.pragma('journal_mode = DELETE');
        db.exec(`
            CREATE TABLE migrations (dir TEXT NOT NULL, version INTEGER NOT NULL, filename TEXT, sql TEXT, hash TEXT);
            CREATE TABLE databases (id TEXT PRIMARY KEY, name TEXT NOT NULL, tenant_id TEXT NOT NULL);
            CREATE TABLE collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, dimension INTEGER, database_id TEXT NOT NULL);
            CREATE TABLE segments (id TEXT PRIMARY KEY, type TEXT NOT NULL, scope TEXT NOT NULL, collection TEXT NOT NULL);
            CREATE TABLE max_seq_id (segment_id TEXT PRIMARY KEY, seq_id BLOB NOT NULL);
            CREATE TABLE embeddings_queue (seq_id INTEGER PRIMARY KEY, topic TEXT NOT NULL, id TEXT NOT NULL);
        `);

        const insertMig = db.prepare('INSERT INTO migrations (dir, version) VALUES (?, ?)');
        for (const [dir, version] of Object.entries(CHROMA_159_MIGRATIONS)) {
            insertMig.run(dir, version);
        }

        db.prepare('INSERT INTO databases (id, name, tenant_id) VALUES (?, ?, ?)')
            .run('db-default-id', databaseName, 'default_tenant');
        db.prepare('INSERT INTO collections (id, name, dimension, database_id) VALUES (?, ?, ?, ?)')
            .run(KB_COLLECTION_ID, collectionName, VECTOR_DIM, 'db-default-id');
        db.prepare('INSERT INTO segments (id, type, scope, collection) VALUES (?, ?, ?, ?)')
            .run('meta-seg-1', 'urn:chroma:segment/metadata/sqlite', 'METADATA', KB_COLLECTION_ID);
        db.prepare('INSERT INTO segments (id, type, scope, collection) VALUES (?, ?, ?, ?)')
            .run(KB_VECTOR_SEG_ID, 'urn:chroma:segment/vector/hnsw-local-persisted', 'VECTOR', KB_COLLECTION_ID);
        db.prepare('INSERT INTO max_seq_id (segment_id, seq_id) VALUES (?, ?)')
            .run(KB_VECTOR_SEG_ID, vectorCheckpointSeqId);

        const insertQueue = db.prepare('INSERT INTO embeddings_queue (seq_id, topic, id) VALUES (?, ?, ?)');
        for (let i = 1; i <= queuedTailRows; i++) {
            insertQueue.run(
                vectorCheckpointSeqId + i,
                `persistent://default/default/${KB_COLLECTION_ID}`,
                `doc-${i}`
            );
        }
    } finally {
        db.close();
    }

    await fs.mkdir(segmentDir, {recursive: true});
    await fs.writeFile(path.join(segmentDir, 'header.bin'), writeHeaderBuffer({curElementCount}));

    return {sqlitePath, segmentDir};
}

function fakeRuntimeAccess({
    chromaImage  = 'chromadb/chroma:1.5.9',
    chromaVolume = 'neo-agent-os_chroma-data',
    selfVolume   = 'neo-agent-os_chroma-data',
    selfReadOnly = true,
    dataDir
} = {}) {
    return {
        configValues: {allowedServices: ['chroma', 'orchestrator']},
        async readObserve({serviceKey, operation}) {
            expect(operation).toBe('inspect');
            if (serviceKey === 'chroma') {
                return {
                    proof: {target: {composeProject: 'neo-agent-os', serviceKey: 'chroma', containerId: 'chroma-cid-1'}},
                    data : {
                        Id    : 'chroma-cid-1',
                        State : {Running: true},
                        Config: {Image: chromaImage, Labels: {'com.docker.compose.project': 'neo-agent-os'}},
                        Mounts: [{Name: chromaVolume, Destination: '/data', RW: true}]
                    }
                };
            }
            return {
                proof: {target: {composeProject: 'neo-agent-os', serviceKey: 'orchestrator', containerId: 'orch-cid-1'}},
                data : {
                    Id    : 'orch-cid-1',
                    State : {Running: true},
                    Mounts: [{Name: selfVolume, Destination: dataDir, RW: !selfReadOnly}]
                }
            };
        }
    };
}

test.describe('kbDeadElementGatherer — read-only Chroma 1.5.9 observation & isolation (#1434)', () => {
    let tmpDir;

    test.beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-kb-dead-elements-'));
    });

    test.afterEach(async () => {
        if (tmpDir) {
            await fs.rm(tmpDir, {recursive: true, force: true});
        }
    });

    test('AC-3 & ADR-0019: reads AiConfig/kbConfig at gatherer use site, opens SQLite read-only + 100-byte header.bin, and emits bloated diagnosis with zero DB copy', async () => {
        const {sqlitePath}     = await seedChroma159Store(tmpDir, {curElementCount: 253_743n}),
              beforeStat       = await fs.stat(sqlitePath),
              fsCalls          = [],
              observedLiveArgs = [],
              trackedFs        = new Proxy(fs, {
                  get(target, prop) {
                      if (prop === 'copyFile' || prop === 'cp') {
                          return async (...args) => {
                              fsCalls.push([prop, ...args]);
                              return target[prop](...args);
                          };
                      }
                      const value = target[prop];
                      return typeof value === 'function' ? value.bind(target) : value;
                  }
              });

        const runtimeAccessService = fakeRuntimeAccess({dataDir: tmpDir}),
              kbChromaManager      = {
                  async getKnowledgeBaseCollection() {
                      return {
                          id   : KB_COLLECTION_ID,
                          count: async () => 86_560
                      };
                  }
              },
              gatherer = createLiveKbDeadElementGatherer({
                  serviceId        : 'mc-server',
                  kbChromaManager,
                  runtimeAccessService,
                  readObservationFn: liveArgs => {
                      observedLiveArgs.push(liveArgs);
                      return readKbDeadElementObservation({
                          ...liveArgs,
                          dataDir     : tmpDir,
                          endpointHost: 'chroma',
                          endpointPort: 8000,
                          fsModule    : trackedFs
                      });
                  }
              });

        const outcome   = await gatherer(OBSERVED_AT),
              afterStat = await fs.stat(sqlitePath),
              entries   = await fs.readdir(tmpDir);

        expect(observedLiveArgs).toHaveLength(1);
        expect(observedLiveArgs[0]).toMatchObject({
            dataDir       : AiConfig.engines.chroma.dataDir,
            endpointHost  : AiConfig.engines.chroma.host,
            endpointPort  : AiConfig.engines.chroma.port,
            collectionName: kbConfig.collectionName,
            databaseName  : kbConfig.chromaDatabase
        });
        expect(fsCalls).toEqual([]);
        expect(afterStat.size).toBe(beforeStat.size);
        expect(entries.sort()).toEqual([KB_VECTOR_SEG_ID, 'chroma.sqlite3'].sort());
        expect(outcome).toMatchObject({
            status          : 'bloated',
            collection      : kbConfig.collectionName,
            hnswOccupancy   : 253_743,
            liveCount       : 86_560,
            deadElementCount: 167_183
        });
        expect(outcome.diagnosis).toMatchObject({
            recoveryClass: 'data-integrity',
            source       : 'data-integrity-kb-dead-elements-monitor'
        });

        // Below threshold on the same store (liveCount = 240,000 → deadFraction ~0.054 <= 0.10) → clean, null diagnosis.
        const cleanGatherer = createLiveKbDeadElementGatherer({
            serviceId      : 'mc-server',
            runtimeAccessService,
            kbChromaManager: {
                async getKnowledgeBaseCollection() {
                    return {id: KB_COLLECTION_ID, count: async () => 240_000};
                }
            },
            readObservationFn   : liveArgs => readKbDeadElementObservation({
                ...liveArgs,
                dataDir     : tmpDir,
                endpointHost: 'chroma',
                endpointPort: 8000
            })
        });
        expect(await cleanGatherer(OBSERVED_AT)).toMatchObject({
            status   : 'clean',
            diagnosis: null
        });
    });

    test('AC-3: settles as unverified on a hot rollback journal header or SQLITE_READONLY_ROLLBACK without mutating journal', async () => {
        const {sqlitePath} = await seedChroma159Store(tmpDir),
              journalPath  = `${sqlitePath}-journal`,
              hotJournal   = Buffer.alloc(28);

        SQLITE_ROLLBACK_JOURNAL_MAGIC.copy(hotJournal, 0);
        hotJournal.writeInt32BE(4, 8);
        await fs.writeFile(journalPath, hotJournal);

        let   openCalled     = false;
        const hotObservation = await readKbDeadElementObservation({
            dataDir             : tmpDir,
            endpointHost        : 'chroma',
            endpointPort        : 8000,
            collectionName      : kbConfig.collectionName,
            databaseName        : kbConfig.chromaDatabase,
            runtimeAccessService: fakeRuntimeAccess({dataDir: tmpDir}),
            kbChromaManager     : {async getKnowledgeBaseCollection() { return {id: KB_COLLECTION_ID, count: async () => 86_560}; }},
            openDatabaseFn      : () => {
                openCalled = true;
                throw new Error('should not open SQLite when hot journal header is present');
            }
        });

        expect(openCalled).toBe(false);
        expect(hotObservation).toEqual({status: 'unverified', reason: 'hot-rollback-journal'});
        expect(await fs.readFile(journalPath)).toEqual(hotJournal);

        // Zeroed PERSIST-mode journal header (bytes 0..27 = 0x00) is NOT hot → proceeds cleanly; mid-open SQLITE_READONLY_ROLLBACK → unverified.
        const zeroedPersistJournal = Buffer.alloc(28, 0);
        await fs.writeFile(journalPath, zeroedPersistJournal);

        const cleanWithPersistJournal = await readSqliteRegistryReadOnly({
            sqlitePath,
            collectionName: kbConfig.collectionName,
            databaseName  : kbConfig.chromaDatabase
        });
        expect(cleanWithPersistJournal.journalState).toBe('clean');

        const rollbackErr = Object.assign(new Error('attempt to write a readonly database'), {code: 'SQLITE_READONLY_ROLLBACK'});
        const raceHot     = await readSqliteRegistryReadOnly({
            sqlitePath,
            collectionName: kbConfig.collectionName,
            databaseName  : kbConfig.chromaDatabase,
            openDatabaseFn: () => { throw rollbackErr; }
        });
        expect(raceHot).toEqual({journalState: 'hot', journalReason: 'SQLITE_READONLY_ROLLBACK'});

        await expect(readSqliteRegistryReadOnly({sqlitePath, databaseName: kbConfig.chromaDatabase}))
            .rejects.toThrow(/collectionName is required/);
        await expect(readSqliteRegistryReadOnly({sqlitePath, collectionName: kbConfig.collectionName}))
            .rejects.toThrow(/databaseName is required/);
    });

    test('AC-3: runtime binding rejects writable mount, EACCES unverified mount, mismatched volume, non-1.5.9 image, or missing collection/database scalars as unknown', async () => {
        await seedChroma159Store(tmpDir);
        const kbChromaManager = {
                  async getKnowledgeBaseCollection() {
                      return {id: KB_COLLECTION_ID, count: async () => 86_560};
                  }
              },
              scalarBase      = {
                  dataDir       : tmpDir,
                  endpointHost  : 'chroma',
                  endpointPort  : 8000,
                  collectionName: kbConfig.collectionName,
                  databaseName  : kbConfig.chromaDatabase,
                  kbChromaManager
              };

        expect(await readKbDeadElementObservation({
            ...scalarBase,
            collectionName      : undefined,
            runtimeAccessService: fakeRuntimeAccess({dataDir: tmpDir})
        })).toEqual({status: 'unknown', reason: 'missing-collection-name'});

        expect(await readKbDeadElementObservation({
            ...scalarBase,
            databaseName        : undefined,
            runtimeAccessService: fakeRuntimeAccess({dataDir: tmpDir})
        })).toEqual({status: 'unknown', reason: 'missing-database-name'});

        const writableMount = await readKbDeadElementObservation({
            ...scalarBase,
            runtimeAccessService: fakeRuntimeAccess({dataDir: tmpDir, selfReadOnly: false})
        });
        expect(writableMount).toEqual({status: 'unknown', reason: 'store-mount-not-readonly'});

        const mismatchedVolume = await readKbDeadElementObservation({
            ...scalarBase,
            runtimeAccessService: fakeRuntimeAccess({dataDir: tmpDir, selfVolume: 'wrong-volume'})
        });
        expect(mismatchedVolume).toEqual({status: 'unknown', reason: 'volume-identity-mismatch'});

        const wrongVersion = await readKbDeadElementObservation({
            ...scalarBase,
            runtimeAccessService: fakeRuntimeAccess({dataDir: tmpDir, chromaImage: 'chromadb/chroma:1.6.0'})
        });
        expect(wrongVersion).toEqual({status: 'unknown', reason: 'unsupported-chroma-version'});

        // Fallback without self-inspect: EROFS verifies :ro mount; EACCES records writeRefused without claiming :ro mount.
        const noSelfInspectRuntime = {
            configValues: {allowedServices: ['chroma']},
            async readObserve() {
                return {
                    proof: {target: {composeProject: 'neo-agent-os', serviceKey: 'chroma', containerId: 'chroma-cid-1'}},
                    data : {
                        Id    : 'chroma-cid-1',
                        State : {Running: true},
                        Config: {Image: 'chromadb/chroma:1.5.9'},
                        Mounts: [{Name: 'neo-agent-os_chroma-data', Destination: '/data', RW: true}]
                    }
                };
            }
        };
        const erofsBinding = await inspectChromaStoreRuntimeBinding({
            runtimeAccessService: noSelfInspectRuntime,
            dataDir             : tmpDir,
            endpointHost        : 'chroma',
            endpointPort        : 8000,
            fsModule            : {
                async access(_target, mode) {
                    if (mode === 2) throw Object.assign(new Error('EROFS'), {code: 'EROFS'});
                }
            }
        });
        expect(erofsBinding).toMatchObject({readOnlyMountVerified: true, writeRefused: true});

        const eaccesBinding = await inspectChromaStoreRuntimeBinding({
            runtimeAccessService: noSelfInspectRuntime,
            dataDir             : tmpDir,
            endpointHost        : 'chroma',
            endpointPort        : 8000,
            fsModule            : {
                async access(_target, mode) {
                    if (mode === 2) throw Object.assign(new Error('EACCES'), {code: 'EACCES'});
                }
            }
        });
        expect(eaccesBinding).toMatchObject({
            readOnlyMountVerified: false,
            writeRefused         : true,
            reason               : 'store-mount-write-refused-unverified'
        });

        const missingRuntime = await inspectChromaStoreRuntimeBinding({runtimeAccessService: null, dataDir: tmpDir});
        expect(missingRuntime).toEqual({readOnlyMountVerified: false, reason: 'runtime-access-unavailable'});
    });

    test('AC-5: coverage probe failure (sqlite3 ENOENT) does not block KB dead-element defrag classification and runs zero coverage-class heals', async () => {
        await seedChroma159Store(tmpDir, {curElementCount: 253_743n});

        const runtimeAccessService = fakeRuntimeAccess({dataDir: tmpDir}),
              kbGatherer           = createLiveKbDeadElementGatherer({
                  serviceId      : 'mc-server',
                  runtimeAccessService,
                  kbChromaManager: {
                      async getKnowledgeBaseCollection() {
                          return {id: KB_COLLECTION_ID, count: async () => 86_560};
                      }
                  },
                  readObservationFn   : liveArgs => readKbDeadElementObservation({
                      ...liveArgs,
                      dataDir     : tmpDir,
                      endpointHost: 'chroma',
                      endpointPort: 8000
                  })
              }),
              orchestratorHarness  = {
                  dataIntegrityServiceId            : 'mc-server',
                  dataIntegrityCoverageGatherer     : async () => { throw new Error('spawn sqlite3 ENOENT'); },
                  dataIntegrityKbDeadElementGatherer: kbGatherer
              },
              evidenceGatherer     = Object.getOwnPropertyDescriptor(
                  Orchestrator.prototype,
                  'dataIntegrityEvidenceGatherer'
              ).get.call(orchestratorHarness);

        const appliedHeals = [],
              liftedFences = [],
              service      = Neo.create(DataIntegrityDiagnosisService, {
                  serviceId       : 'mc-server',
                  nowFn           : () => OBSERVED_AT,
                  evidenceGatherer,
                  liftQuarantine  : async collection => { liftedFences.push(collection); return true; },
                  recoveryActuator: {
                      async applyHeal(call) {
                          appliedHeals.push(call);
                          return {status: 'deferred', reason: 'deferred: no heal operation wired'};
                      }
                  }
              });

        const decision = await service.gatherAndDiagnose();

        expect(decision.status).toBe('healed');
        expect(decision.probes).toMatchObject({
            coverage      : {status: 'probe-unavailable', probeError: 'spawn sqlite3 ENOENT'},
            kbDeadElements: {
                status          : 'bloated',
                collection      : kbConfig.collectionName,
                hnswOccupancy   : 253_743,
                liveCount       : 86_560,
                deadElementCount: 167_183
            }
        });
        expect(decision.classifications).toEqual([
            expect.objectContaining({
                collection    : kbConfig.collectionName,
                mode          : 'store-bloat',
                terminalAction: 'defrag'
            })
        ]);
        expect(appliedHeals).toHaveLength(1);
        expect(appliedHeals[0]).toMatchObject({
            action    : 'defrag',
            collection: kbConfig.collectionName,
            now       : OBSERVED_AT
        });
        expect(liftedFences).toEqual([]);

        // All-probes-failed control: when coverage throws AND KB dead-element gatherer fails I/O, sweep settles as probe-unavailable.
        const allFailedHarness = {
                  dataIntegrityServiceId            : 'mc-server',
                  dataIntegrityCoverageGatherer     : async () => { throw new Error('spawn sqlite3 ENOENT'); },
                  dataIntegrityKbDeadElementGatherer: async () => ({
                      status    : 'probe-unavailable',
                      probeError: 'connect ECONNREFUSED 127.0.0.1:8000',
                      diagnosis : null
                  })
              },
              allFailedGatherer = Object.getOwnPropertyDescriptor(
                  Orchestrator.prototype,
                  'dataIntegrityEvidenceGatherer'
              ).get.call(allFailedHarness),
              allFailedService  = Neo.create(DataIntegrityDiagnosisService, {
                  serviceId       : 'mc-server',
                  nowFn           : () => OBSERVED_AT,
                  evidenceGatherer: allFailedGatherer,
                  recoveryActuator: {async applyHeal() { throw new Error('must not heal on probe-unavailable'); }}
              }),
              allFailedDecision = await allFailedService.gatherAndDiagnose();

        expect(allFailedDecision).toMatchObject({
            status: 'probe-unavailable',
            heals : []
        });
        expect(allFailedDecision.probeError).toContain('spawn sqlite3 ENOENT');

        // Shared use-site reader + pending unverified-defrag-attempt re-diagnosis even when store is clean or unknown
        const capturedArgs = [];
        const liveRead     = await readLiveKbDeadElements({
            kbChromaManager     : {},
            runtimeAccessService: {},
            readObservationFn   : args => {
                capturedArgs.push(args);
                return {status: 'ok', collection: kbConfig.collectionName, hnswOccupancy: 100, liveCount: 100, deadElementCount: 0, deadFraction: 0};
            }
        });
        expect(liveRead.gcDefragThreshold).toBe(AiConfig.knowledgeBase.gcDefragThreshold);
        expect(capturedArgs).toEqual([
            expect.objectContaining({
                dataDir       : AiConfig.engines.chroma.dataDir,
                endpointHost  : AiConfig.engines.chroma.host,
                endpointPort  : AiConfig.engines.chroma.port,
                collectionName: kbConfig.collectionName,
                databaseName  : kbConfig.chromaDatabase
            })
        ]);

        const pendingGatherer = createLiveKbDeadElementGatherer({
            serviceId               : 'mc-server',
            kbChromaManager         : {},
            runtimeAccessService    : {},
            readObservationFn       : async () => ({status: 'unknown', reason: 'kb-collection-missing'}),
            readPendingDefragAttempt: async () => ({
                phase    : 'post-promotion-unverified',
                bundleSha: 'a'.repeat(64)
            })
        });
        const pendingOutcome = await pendingGatherer(OBSERVED_AT);
        expect(pendingOutcome).toMatchObject({
            status    : 'bloated',
            collection: kbConfig.collectionName
        });
        expect(pendingOutcome.diagnosis.evidenceFacts).toEqual([
            expect.objectContaining({
                type      : 'store-bloat',
                signal    : 'unverified-defrag-attempt',
                collection: kbConfig.collectionName,
                phase     : 'post-promotion-unverified'
            })
        ]);
    });
});

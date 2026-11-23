import {setup} from '../../../../../setup.mjs';

const appName = 'KBWriteGateUnitTest';

setup({
    neoConfig: {
        allowVdomUpdatesInTests: false,
        unitTestMode           : true,
        useDomApiRenderer      : false
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import fs             from 'fs-extra';
import os             from 'node:os';
import path           from 'node:path';
import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import {
    buildLeasePayload
} from '../../../../../../../ai/daemons/orchestrator/services/heavyMaintenanceLeasePrimitives.mjs';
import {
    KB_MAINTENANCE_IN_PROGRESS,
    createKbWriteGate,
    isKbMaintenanceInProgressError
} from '../../../../../../../ai/services/knowledge-base/helpers/kbWriteGate.mjs';

test.describe.configure({mode: 'serial'});

function createTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function makeChunk(index, overrides = {}) {
    const hash = String(index).padStart(64, 'a');
    return {
        id        : `neo-shared:neomjs/neo-agent-brain:${hash}`,
        hash,
        type      : 'guide',
        name      : `Guide-${index}`,
        sourcePath: `learn/guide-${index}.md`,
        repoSlug  : 'neomjs/neo-agent-brain',
        tenantId  : 'neo-shared',
        visibility: 'team',
        content   : `Knowledge Base write-gate test content ${index}`,
        ...overrides
    };
}

test.describe('kbWriteGate — KB defrag & maintenance write fence (#1435)', () => {
    let ChromaManager,
        DatabaseLifecycleService,
        DatabaseService,
        HealthService,
        IngestionService,
        TextEmbeddingService,
        VectorService,
        ingestSourceFilesViaMcp,
        callTool;

    let originalClient,
        originalGetCollection,
        originalDeleteCollection,
        originalGetDbStatus,
        originalEmbedTexts,
        originalHealthGate,
        originalIngestionGate,
        originalVectorGate;

    test.beforeAll(async () => {
        ChromaManager            = (await import('../../../../../../../ai/services/knowledge-base/ChromaManager.mjs')).default;
        DatabaseLifecycleService = (await import('../../../../../../../ai/services/knowledge-base/DatabaseLifecycleService.mjs')).default;
        DatabaseService          = (await import('../../../../../../../ai/services/knowledge-base/DatabaseService.mjs')).default;
        HealthService            = (await import('../../../../../../../ai/services/knowledge-base/HealthService.mjs')).default;
        IngestionService         = (await import('../../../../../../../ai/services/knowledge-base/IngestionService.mjs')).default;
        TextEmbeddingService     = (await import('../../../../../../../ai/services/memory-core/TextEmbeddingService.mjs')).default;
        VectorService            = (await import('../../../../../../../ai/services/knowledge-base/VectorService.mjs')).default;
        ingestSourceFilesViaMcp  = (await import('../../../../../../../ai/mcp/server/knowledge-base/ingestSourceFilesTool.mjs')).ingestSourceFilesViaMcp;
        callTool                 = (await import('../../../../../../../ai/mcp/server/knowledge-base/toolService.mjs')).callTool;

        originalClient           = ChromaManager.client;
        originalGetCollection    = ChromaManager.getKnowledgeBaseCollection;
        originalDeleteCollection = ChromaManager.deleteCollection;
        originalGetDbStatus      = DatabaseLifecycleService.getDatabaseStatus;
        originalEmbedTexts       = TextEmbeddingService.embedTexts;
        originalHealthGate       = HealthService.writeGate;
        originalIngestionGate    = IngestionService.writeGate;
        originalVectorGate       = VectorService.writeGate;
    });

    test.afterEach(() => {
        ChromaManager.client                       = originalClient;
        ChromaManager.getKnowledgeBaseCollection   = originalGetCollection;
        ChromaManager.deleteCollection             = originalDeleteCollection;
        DatabaseLifecycleService.getDatabaseStatus = originalGetDbStatus;
        TextEmbeddingService.embedTexts            = originalEmbedTexts;
        HealthService.writeGate                    = originalHealthGate;
        IngestionService.writeGate                 = originalIngestionGate;
        VectorService.writeGate                    = originalVectorGate;
        HealthService.clearEmbeddingProbeProducer();
        HealthService.clearCache();
    });

    test('AC-1 (upsert class): every KB upsert site refuses with KB_MAINTENANCE_IN_PROGRESS and writes nothing while a KB-exclusive lease is held', async () => {
        const tempDir   = createTempDir('kb-write-gate-upsert');
        const leasePath = path.join(tempDir, 'heavy-maintenance-lease.json');
        const now       = new Date('2026-11-23T09:00:00.000Z');

        try {
            const gate = createKbWriteGate({
                leasePath,
                now                  : () => now,
                malformedRetryDelayMs: 0
            });
            VectorService.writeGate = gate;

            let   upsertCalls   = 0;
            const spyCollection = {
                name  : 'spy-kb-upsert',
                upsert: async () => {
                    upsertCalls += 1;
                }
            };

            await fs.writeJson(leasePath, buildLeasePayload({
                owner           : 'defrag',
                reason          : 'kb-store-bloat',
                kbWriteExclusive: true,
                leaseId         : 'lease-upsert-1435',
                bootId          : 'orchestrator-container-id',
                pid             : 999999,
                staleAfterMs    : 60_000,
                now,
                token           : 'secret-token-upsert'
            }));

            // 1. persistIsolationEmbeddings
            await expect(VectorService.persistIsolationEmbeddings({
                collection: spyCollection,
                inputs    : [{chunk: makeChunk(1), text: 'text-1'}],
                embeddings: [[0.1, 0.2, 0.3]]
            })).rejects.toMatchObject({
                code     : KB_MAINTENANCE_IN_PROGRESS,
                retryable: true,
                leaseId  : 'lease-upsert-1435',
                owner    : 'defrag'
            });
            expect(upsertCalls).toBe(0);

            // 2. embedChunks pre-provider gate (zero embedding API calls, zero Chroma upserts)
            let providerCalls = 0;
            TextEmbeddingService.embedTexts = async texts => {
                providerCalls += 1;
                return texts.map((_, idx) => [idx + 1, 0, 0]);
            };

            await expect(VectorService.embedChunks({
                collection     : spyCollection,
                chunksToProcess: [makeChunk(2)]
            })).rejects.toMatchObject({
                code     : KB_MAINTENANCE_IN_PROGRESS,
                retryable: true,
                leaseId  : 'lease-upsert-1435'
            });
            expect(providerCalls).toBe(0);
            expect(upsertCalls).toBe(0);

            // 3. Lease acquired MID-EMBEDDING (after embedTexts starts, before collection.upsert):
            //    verifies the inner collection.upsert gate AND that catch(err) rethrows immediately without retries.
            await fs.remove(leasePath);
            TextEmbeddingService.embedTexts = async texts => {
                providerCalls += 1;
                await fs.writeJson(leasePath, buildLeasePayload({
                    owner           : 'defrag',
                    kbWriteExclusive: true,
                    leaseId         : 'lease-mid-flight-1435',
                    bootId          : 'orchestrator-container-id',
                    pid             : 999999,
                    staleAfterMs    : 60_000,
                    now,
                    token           : 'secret-token-mid'
                }));
                return texts.map(() => [0.5, 0.5, 0.5]);
            };

            await expect(VectorService.embedChunks({
                collection     : spyCollection,
                chunksToProcess: [makeChunk(3)]
            })).rejects.toMatchObject({
                code     : KB_MAINTENANCE_IN_PROGRESS,
                retryable: true,
                leaseId  : 'lease-mid-flight-1435'
            });
            expect(providerCalls).toBe(1);
            expect(upsertCalls).toBe(0);

            // 4. Carried-prefix upsert on cooperative yield when lease activates mid-provider batch
            await fs.remove(leasePath);
            TextEmbeddingService.embedTexts = async () => {
                await fs.writeJson(leasePath, buildLeasePayload({
                    owner           : 'defrag',
                    kbWriteExclusive: true,
                    leaseId         : 'lease-carried-1435',
                    bootId          : 'orchestrator-container-id',
                    pid             : 999999,
                    staleAfterMs    : 60_000,
                    now,
                    token           : 'secret-token-carried'
                }));
                const yieldErr = new Error('cooperative yield');
                yieldErr.code                = 'EMBEDDING_BATCH_YIELDED';
                yieldErr.embeddings          = [[0.9, 0.1, 0.2]];
                yieldErr.completedTextCount  = 1;
                yieldErr.completedChunkCount = 1;
                yieldErr.totalChunkCount     = 2;
                throw yieldErr;
            };

            await expect(VectorService.embedChunks({
                collection     : spyCollection,
                chunksToProcess: [makeChunk(4), makeChunk(5)]
            })).rejects.toMatchObject({
                code     : KB_MAINTENANCE_IN_PROGRESS,
                retryable: true,
                leaseId  : 'lease-carried-1435'
            });
            expect(upsertCalls).toBe(0);
            expect(gate.getInFlightWrites()).toBe(0);
        } finally {
            await fs.remove(tempDir);
        }
    });

    test('AC-1 (delete class): IngestionService delete, VectorService stale/replaced deletes, and deleteCollection refuse with KB_MAINTENANCE_IN_PROGRESS', async () => {
        const tempDir   = createTempDir('kb-write-gate-delete');
        const leasePath = path.join(tempDir, 'heavy-maintenance-lease.json');
        const jsonlPath = path.join(tempDir, 'corpus.jsonl');
        const now       = new Date('2026-11-23T09:05:00.000Z');

        try {
            const gate = createKbWriteGate({
                leasePath,
                now                  : () => now,
                malformedRetryDelayMs: 0
            });
            IngestionService.writeGate = gate;
            VectorService.writeGate    = gate;

            await fs.writeJson(leasePath, buildLeasePayload({
                owner           : 'defrag',
                kbWriteExclusive: true,
                leaseId         : 'lease-delete-1435',
                bootId          : 'orchestrator-container-id',
                pid             : 888888,
                staleAfterMs    : 60_000,
                now,
                token           : 'secret-token-delete'
            }));

            let deleteCalls           = 0;
            let deleteCollectionCalls = 0;

            const spyCollection = {
                name : 'spy-kb-delete',
                count: async () => 1,
                get  : async ({offset = 0} = {}) => offset === 0
                    ? {
                        ids      : ['stale-row-1'],
                        metadatas: [{
                            tenantId  : 'neo-shared',
                            repoSlug  : 'neomjs/neo-agent-brain',
                            sourcePath: 'learn/removed.md',
                            type      : 'guide',
                            hash      : 'b'.repeat(64)
                        }]
                    }
                    : {ids: [], metadatas: []},
                delete: async () => {
                    deleteCalls += 1;
                },
                upsert: async () => {
                    throw new Error('upsert should not be called');
                }
            };

            ChromaManager.getKnowledgeBaseCollection = async () => spyCollection;
            ChromaManager.deleteCollection           = async () => {
                deleteCollectionCalls += 1;
            };

            // 1. IngestionService.applyDeletionSignals
            await expect(IngestionService.applyDeletionSignals({
                deleted      : [{sourcePath: 'learn/removed.md', repoSlug: 'neomjs/neo-agent-brain'}],
                tenantContext: {tenantId: 'neo-shared', repoSlug: 'neomjs/neo-agent-brain'},
                summary      : {errors: []}
            })).rejects.toMatchObject({
                code     : KB_MAINTENANCE_IN_PROGRESS,
                retryable: true,
                leaseId  : 'lease-delete-1435'
            });
            expect(deleteCalls).toBe(0);

            // 2. VectorService.embed stale-row delete (`deleteStale: true`, empty incoming JSONL => idsToDelete = ['stale-row-1'])
            await fs.writeFile(jsonlPath, '', 'utf8');
            await expect(VectorService.embed(jsonlPath, {
                viaMcp       : false,
                deleteStale  : true,
                staleStrategy: 'delete-upfront',
                tenantContext: {tenantId: 'neo-shared', repoSlug: 'neomjs/neo-agent-brain', visibility: 'team'}
            })).rejects.toMatchObject({
                code     : KB_MAINTENANCE_IN_PROGRESS,
                retryable: true,
                leaseId  : 'lease-delete-1435'
            });
            expect(deleteCalls).toBe(0);

            // 3. VectorService.embed replaced-row delete (`replaceSourceRevisions: true` where new chunk is already present in Chroma)
            const currentChunk = makeChunk(10, {sourcePath: 'learn/replaced.md'});
            await fs.writeFile(jsonlPath, `${JSON.stringify(currentChunk)}\n`, 'utf8');
            ChromaManager.getKnowledgeBaseCollection = async () => ({
                ...spyCollection,
                get: async ({offset = 0} = {}) => offset === 0
                    ? {
                        ids      : [currentChunk.id, 'old-profile-row-id'],
                        metadatas: [
                            {
                                tenantId   : 'neo-shared',
                                repoSlug   : 'neomjs/neo-agent-brain',
                                sourcePath : 'learn/replaced.md',
                                profileName: 'brain-core',
                                hash       : currentChunk.hash
                            },
                            {
                                tenantId   : 'neo-shared',
                                repoSlug   : 'neomjs/neo-agent-brain',
                                sourcePath : 'learn/replaced.md',
                                profileName: 'brain-core',
                                hash       : 'c'.repeat(64)
                            }
                        ]
                    }
                    : {ids: [], metadatas: []}
            });

            await expect(VectorService.embed(jsonlPath, {
                viaMcp                : false,
                deleteStale           : false,
                replaceSourceRevisions: true,
                tenantContext         : {tenantId: 'neo-shared', repoSlug: 'neomjs/neo-agent-brain', visibility: 'team'}
            })).rejects.toMatchObject({
                code     : KB_MAINTENANCE_IN_PROGRESS,
                retryable: true,
                leaseId  : 'lease-delete-1435'
            });
            expect(deleteCalls).toBe(0);

            // 4. VectorService.deleteCollection
            await expect(VectorService.deleteCollection({
                confirmation: 'CONFIRM_PRODUCTION_DESTRUCTIVE_AI_SUBSTRATE'
            })).rejects.toMatchObject({
                code     : KB_MAINTENANCE_IN_PROGRESS,
                retryable: true,
                leaseId  : 'lease-delete-1435'
            });
            expect(deleteCollectionCalls).toBe(0);
            expect(gate.getInFlightWrites()).toBe(0);
        } finally {
            await fs.remove(tempDir);
        }
    });

    test('AC-2: writes proceed unchanged when no lease exists, when a non-KB-exclusive lease is held, or when an exclusive lease has expired', async () => {
        const tempDir   = createTempDir('kb-write-gate-open');
        const leasePath = path.join(tempDir, 'heavy-maintenance-lease.json');
        const now       = new Date('2026-11-23T09:10:00.000Z');

        try {
            const gate = createKbWriteGate({
                leasePath,
                now                  : () => now,
                malformedRetryDelayMs: 0
            });
            IngestionService.writeGate = gate;
            VectorService.writeGate    = gate;

            const upserted      = [];
            const deleted       = [];
            const spyCollection = {
                name: 'spy-open',
                get : async () => ({
                    ids      : ['row-del-1'],
                    metadatas: [{tenantId: 'neo-shared', repoSlug: 'neomjs/neo-agent-brain', sourcePath: 'a.md'}]
                }),
                upsert: async ({ids}) => { upserted.push(...ids); },
                delete: async ({ids}) => { deleted.push(...ids); }
            };
            ChromaManager.getKnowledgeBaseCollection = async () => spyCollection;

            // Case 1: missing lease file
            await VectorService.persistIsolationEmbeddings({
                collection: spyCollection,
                inputs    : [{chunk: makeChunk(1), text: 't1'}],
                embeddings: [[1, 0, 0]]
            });
            expect(upserted).toHaveLength(1);

            // Case 2: active backup lease WITHOUT kbWriteExclusive
            await fs.writeJson(leasePath, buildLeasePayload({
                owner       : 'backup',
                reason      : 'scheduled-backup',
                bootId      : 'orchestrator-container-id',
                pid         : 777777,
                staleAfterMs: 60_000,
                now,
                token       : 'backup-token'
            }));

            expect(await gate.getHealthStatus()).toEqual({
                gate          : 'open',
                leaseId       : null,
                inFlightWrites: 0
            });

            const deletedCount = await IngestionService.applyDeletionSignals({
                deleted      : [{sourcePath: 'a.md', repoSlug: 'neomjs/neo-agent-brain'}],
                tenantContext: {tenantId: 'neo-shared', repoSlug: 'neomjs/neo-agent-brain'},
                summary      : {errors: []}
            });
            expect(deletedCount).toBe(1);
            expect(deleted).toEqual(['row-del-1']);

            // Case 3: expired KB-exclusive lease
            await fs.writeJson(leasePath, buildLeasePayload({
                owner           : 'defrag',
                kbWriteExclusive: true,
                leaseId         : 'expired-lease-id',
                bootId          : 'orchestrator-container-id',
                pid             : 777777,
                staleAfterMs    : 1_000,
                now             : new Date(now.getTime() - 5_000),
                token           : 'expired-token'
            }));

            await VectorService.persistIsolationEmbeddings({
                collection: spyCollection,
                inputs    : [{chunk: makeChunk(2), text: 't2'}],
                embeddings: [[0, 1, 0]]
            });
            expect(upserted).toHaveLength(2);
        } finally {
            await fs.remove(tempDir);
        }
    });

    test('AC-3 & AC-4: HealthService reports live writeGate across the 5-minute cache, returns inFlightWrites to 0 on success and failure, and reads the lease strictly read-only', async () => {
        const tempDir   = createTempDir('kb-write-gate-health');
        const leasePath = path.join(tempDir, 'heavy-maintenance-lease.json');
        const now       = new Date('2026-11-23T09:15:00.000Z');

        try {
            let   fsReads            = 0;
            const readOnlyEnforcedFs = new Proxy(fs, {
                get(target, prop) {
                    if (prop === 'readFile') {
                        return (...args) => {
                            fsReads += 1;
                            return target.readFile(...args);
                        };
                    }
                    throw new Error(`Forbidden filesystem access on :ro lease mount: String(${String(prop)})`);
                }
            });

            const gate = createKbWriteGate({
                leasePath,
                fsModule             : readOnlyEnforcedFs,
                now                  : () => now,
                malformedRetryDelayMs: 0
            });
            HealthService.writeGate = gate;

            let heartbeatCalls = 0;
            ChromaManager.client = {
                heartbeat: async () => {
                    heartbeatCalls += 1;
                    return {};
                }
            };
            ChromaManager.getKnowledgeBaseCollection   = async () => ({count: async () => 42});
            DatabaseLifecycleService.getDatabaseStatus = () => ({running: false, pid: null, managed: false});

            await HealthService.startEmbeddingProbe({
                cadenceMs    : 60_000,
                scheduler    : () => 0,
                clearSchedule: () => {},
                keyFor       : () => 'mock-provider:3',
                runProbe     : async () => ({
                    status            : 'healthy',
                    provider          : 'mock-provider',
                    dimensions        : 3,
                    expectedDimensions: 3,
                    durationMs        : 1
                })
            });

            // 1. Populate the 5-minute healthy cache with no lease present
            const initialHealth = await HealthService.healthcheck();
            expect(initialHealth.status).toBe('healthy');
            expect(initialHealth.writeGate).toEqual({
                gate          : 'open',
                leaseId       : null,
                inFlightWrites: 0
            });
            expect(heartbeatCalls).toBe(1);

            // 2. Start an in-flight write while gate is open, then acquire KB-exclusive lease BEFORE write settles
            let releaseInFlightWrite;
            const writeBlocked = new Promise(resolve => { releaseInFlightWrite = resolve; });
            let writeEntered;
            const enteredPromise = new Promise(resolve => { writeEntered = resolve; });

            const pendingWrite = gate.runWrite('upsert-batch', async () => {
                writeEntered();
                await writeBlocked;
                return 'landed';
            });
            await enteredPromise;

            await fs.writeJson(leasePath, buildLeasePayload({
                owner           : 'defrag',
                kbWriteExclusive: true,
                leaseId         : 'public-drain-lease-id',
                bootId          : 'orchestrator-container',
                pid             : 1,
                staleAfterMs    : 60_000,
                now,
                token           : 'do-not-leak-release-token'
            }));

            // Healthcheck hits the 5-minute healthy cache (heartbeatCalls stays 1!) yet reports LIVE closed gate + inFlightWrites: 1
            const drainingHealth = await HealthService.healthcheck();
            expect(heartbeatCalls).toBe(1);
            expect(drainingHealth.status).toBe('healthy');
            expect(drainingHealth.writeGate).toEqual({
                gate          : 'closed',
                leaseId       : 'public-drain-lease-id',
                inFlightWrites: 1
            });
            expect(JSON.stringify(drainingHealth)).not.toContain('do-not-leak-release-token');

            releaseInFlightWrite();
            await expect(pendingWrite).resolves.toBe('landed');

            // Coordinator now sees gate closed for its leaseId AND inFlightWrites === 0
            const drainedHealth = await HealthService.healthcheck();
            expect(drainedHealth.writeGate).toEqual({
                gate          : 'closed',
                leaseId       : 'public-drain-lease-id',
                inFlightWrites: 0
            });

            // 3. Remove lease, verify a FAILED write also returns inFlightWrites to 0
            await fs.remove(leasePath);
            await expect(gate.runWrite('failing-write', async () => {
                expect((await HealthService.healthcheck()).writeGate.inFlightWrites).toBe(1);
                throw new Error('simulated Chroma storage error');
            })).rejects.toThrow('simulated Chroma storage error');

            const postFailureHealth = await HealthService.healthcheck();
            expect(postFailureHealth.writeGate).toEqual({
                gate          : 'open',
                leaseId       : null,
                inFlightWrites: 0
            });
            expect(fsReads).toBeGreaterThan(0);
        } finally {
            await fs.remove(tempDir);
        }
    });

    test('AC-5: MCP callers (ingest_source_files and manage_knowledge_base) receive retryable KB_MAINTENANCE_IN_PROGRESS payloads naming the window', async () => {
        const tempDir   = createTempDir('kb-write-gate-mcp');
        const leasePath = path.join(tempDir, 'heavy-maintenance-lease.json');
        const now       = new Date('2026-11-23T09:20:00.000Z');

        try {
            const gate = createKbWriteGate({
                leasePath,
                now                  : () => now,
                malformedRetryDelayMs: 0
            });
            IngestionService.writeGate = gate;
            VectorService.writeGate    = gate;

            const lease = buildLeasePayload({
                owner           : 'defrag',
                kbWriteExclusive: true,
                leaseId         : 'mcp-window-lease-1435',
                bootId          : 'orchestrator-container',
                pid             : 1,
                staleAfterMs    : 120_000,
                now,
                token           : 'secret-mcp-release-token'
            });
            await fs.writeJson(leasePath, lease);

            ChromaManager.getKnowledgeBaseCollection = async () => ({
                name: 'spy-mcp',
                get : async () => ({
                    ids      : ['row-1'],
                    metadatas: [{tenantId: 'neo-shared', repoSlug: 'neomjs/neo-agent-brain', sourcePath: 'learn/old.md'}]
                }),
                delete: async () => {
                    throw new Error('Chroma delete must not execute while closed');
                },
                upsert: async () => {
                    throw new Error('Chroma upsert must not execute while closed');
                }
            });
            ChromaManager.deleteCollection = async () => {
                throw new Error('Chroma deleteCollection must not execute while closed');
            };

            // 1. ingest_source_files via MCP facade
            const ingestPayload = await ingestSourceFilesViaMcp({
                tenantId: 'neo-shared',
                repoSlug: 'neomjs/neo-agent-brain',
                files   : [],
                deleted : [{sourcePath: 'learn/old.md', repoSlug: 'neomjs/neo-agent-brain'}]
            });

            expect(ingestPayload).toMatchObject({
                error    : 'Knowledge Base maintenance window in progress',
                code     : KB_MAINTENANCE_IN_PROGRESS,
                retryable: true,
                leaseId  : 'mcp-window-lease-1435',
                owner    : 'defrag',
                expiresAt: lease.expiresAt
            });
            expect(ingestPayload.message).toContain('maintenance window');
            expect(ingestPayload.message).toContain('mcp-window-lease-1435');
            expect(JSON.stringify(ingestPayload)).not.toContain('secret-mcp-release-token');

            // Direct non-MCP service callers still receive the thrown retryable Error (no silent checkpoint advance)
            let directThrown = null;
            try {
                await IngestionService.ingestSourceFiles({
                    tenantId: 'neo-shared',
                    repoSlug: 'neomjs/neo-agent-brain',
                    viaMcp  : false,
                    files   : [],
                    deleted : [{sourcePath: 'learn/old.md', repoSlug: 'neomjs/neo-agent-brain'}]
                });
            } catch (error) {
                directThrown = error;
            }
            expect(isKbMaintenanceInProgressError(directThrown)).toBe(true);
            expect(directThrown.retryable).toBe(true);

            // 2. manage_knowledge_base via MCP (`viaMcp: true`)
            const managePayload = await DatabaseService.manageKnowledgeBase({
                action      : 'delete',
                viaMcp      : true,
                confirmation: 'CONFIRM_PRODUCTION_DESTRUCTIVE_AI_SUBSTRATE'
            });

            expect(managePayload).toMatchObject({
                error    : 'Knowledge Base maintenance window in progress',
                code     : KB_MAINTENANCE_IN_PROGRESS,
                retryable: true,
                leaseId  : 'mcp-window-lease-1435',
                owner    : 'defrag',
                expiresAt: lease.expiresAt
            });
            expect(JSON.stringify(managePayload)).not.toContain('secret-mcp-release-token');

            // 3. Tool handbook surfaces KB_MAINTENANCE_IN_PROGRESS for both MCP tools
            const ingestHandbook = await callTool('get_mcp_tool_handbook', {toolId: 'ingest_source_files'});
            const manageHandbook = await callTool('get_mcp_tool_handbook', {toolId: 'manage_knowledge_base'});
            expect(JSON.stringify(ingestHandbook)).toContain('KB_MAINTENANCE_IN_PROGRESS');
            expect(JSON.stringify(manageHandbook)).toContain('KB_MAINTENANCE_IN_PROGRESS');
        } finally {
            await fs.remove(tempDir);
        }
    });
});

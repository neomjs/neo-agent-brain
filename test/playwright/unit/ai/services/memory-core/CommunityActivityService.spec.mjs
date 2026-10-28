import {setup} from '../../../../setup.mjs';

setup({
    neoConfig: {unitTestMode: true},
    appConfig: {
        name             : 'CommunityActivityServiceTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import Ajv            from 'ajv';
import * as yaml      from 'js-yaml';

import RequestContextService                     from '../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';
import {buildOutputZodSchema}                   from '../../../../../../ai/mcp/validation/openApiValidator.mjs';
import {admitClaimedTask, collectLifecycleItems} from '../../../../../../ai/services/graph/lifecycleAdmission.mjs';
import {isActionableComputedRecommendation}      from '../../../../../../ai/services/graph/computedGoldenPathRouting.mjs';
import {bindCommunityCoverage, COMMUNITY_COVERAGE_CONTRACTS, validateCommunityCoverage} from '../../../../../../ai/services/memory-core/communityCoverageContract.mjs';
import {assembleIssueBatch}                      from '../../../../../../ai/services/github-workflow/community/assembleIssueBatch.mjs';
import {reconcileIssueActivity}                  from '../../../../../../ai/services/github-workflow/community/githubIssueReconciliation.mjs';
import {reconcilePullRequestActivity}            from '../../../../../../ai/services/github-workflow/community/githubPullRequestReconciliation.mjs';
import {reconcileDiscussionActivity}             from '../../../../../../ai/services/github-workflow/community/githubDiscussionReconciliation.mjs';
import {discussionToObservations}                from '../../../../../../ai/services/github-workflow/community/githubDiscussionObservations.mjs';

test.describe('Neo.ai.services.memory-core.CommunityActivityService', () => {
    let ActivityService, AdmissionService, GraphService, MailboxService, SourceRegistryService;
    let Database, registryDb, admissionDb, activityDb, testDbPath, tempRoot;
    let originalActivityDb, originalAdmissionDb, originalAttentionPolicy, originalGraphStorageDb, originalLocalSubjectId, originalRegistryDb;
    let originalEnv;
    let originalContentAdapter;

    const
        SUBJECT = 'community-tenant',
        WINDOW  = {
            windowEnd  : '2026-09-20T00:00:00.000Z',
            windowStart: '2026-09-19T00:00:00.000Z'
        },
        SOURCE  = {
            canonicalProviderHost: 'github.com',
            displayLocator       : 'neomjs/neo',
            provider             : 'github',
            providerResourceId   : 'neomjs/neo',
            resourceKind         : 'repository'
        },
        ATTENTION_POLICY = {
            recordedActorDispositions: {},
            responseBearingKinds     : ['issue.comment', 'discussion.comment', 'pull_request.comment'],
            rosteredActorIds         : []
        },
        observation = (providerEntityId, occurredAt, over = {}) => ({
            actorId             : `external-${providerEntityId}`,
            actorKind           : 'user',
            occurredAt,
            occurrenceCoordinate: `${providerEntityId}:created`,
            occurrenceKind      : 'issue.comment',
            providerEntityId,
            sourceAssociation   : 'NONE',
            ...over
        }),
        batchAt = (sourceInstanceId, observations, {
            baseCheckpointVersion = 0,
            baseInventoryHash     = null,
            batchId               = `batch-${Date.now()}-${Math.random()}`,
            nextInventoryHash     = `inventory-${batchId}`,
            coverage,
            registrationEpoch     = 2,
            resourceFamily        = 'issues'
        } = {}) => ({
            adapterSchemaVersion      : COMMUNITY_COVERAGE_CONTRACTS[resourceFamily].contract.adapterSchemaVersion,
            baseCheckpointVersion,
            baseInventoryHash,
            batchId,
            coverage                  : coverage ?? bindCommunityCoverage(resourceFamily, {complete: true, fromBasis: 'genesis', toBasis: 'to'}),
            nextInventoryHash,
            nextProviderState         : {cursor: batchId},
            observations,
            providerStateSchemaVersion: COMMUNITY_COVERAGE_CONTRACTS[resourceFamily].contract.providerStateSchemaVersion,
            registrationEpoch,
            resourceFamily,
            schemaVersion             : 'community-activity-batch.v1',
            sourceInstanceId
        });

    function activeSource(overrides = {}) {
        const {sourceInstanceId} = SourceRegistryService.register({...SOURCE, ...overrides});

        SourceRegistryService.transitionLifecycle(sourceInstanceId, 'PROVISIONED', {
            expectedEpoch: 1,
            expectedState: 'REQUESTED'
        });
        SourceRegistryService.transitionLifecycle(sourceInstanceId, 'ACTIVE', {
            expectedEpoch: 2,
            expectedState: 'PROVISIONED'
        });

        return sourceInstanceId
    }

    function admit(sourceInstanceId, observations, options) {
        return AdmissionService.admitBatch(batchAt(sourceInstanceId, observations, options))
    }

    async function inTenant(callback) {
        return RequestContextService.run({userId: SUBJECT}, callback)
    }

    test.beforeAll(async () => {
        originalEnv = {
            NEO_MEMORY_DB_PATH_TEST: process.env.NEO_MEMORY_DB_PATH_TEST,
            UNIT_TEST_MODE         : process.env.UNIT_TEST_MODE
        };
        process.env.UNIT_TEST_MODE          = 'true';
        Database = (await import('better-sqlite3')).default;

        SourceRegistryService = (await import('../../../../../../ai/services/memory-core/SourceRegistryService.mjs')).default;
        AdmissionService      = (await import('../../../../../../ai/services/memory-core/CommunityBatchAdmissionService.mjs')).default;
        ActivityService       = (await import('../../../../../../ai/services/memory-core/CommunityActivityService.mjs')).default;
        GraphService          = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        MailboxService        = (await import('../../../../../../ai/services/memory-core/MailboxService.mjs')).default;

        await Promise.all([
            SourceRegistryService.ready(),
            AdmissionService.ready(),
            ActivityService.ready(),
            GraphService.ready(),
            MailboxService.ready()
        ]);

        originalActivityDb      = ActivityService.db;
        originalRegistryDb      = SourceRegistryService.db;
        originalAdmissionDb     = AdmissionService.db;
        originalGraphStorageDb  = GraphService.db?.storage?.db || null;
        originalLocalSubjectId  = SourceRegistryService.localSubjectId;
        originalAttentionPolicy = AdmissionService.attentionPolicy;
        originalContentAdapter  = ActivityService.contentAdapter;
    });

    test.beforeEach(async () => {
        tempRoot   = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'neo-community-activity-'));
        testDbPath = path.join(tempRoot, 'memory-core.sqlite');
        process.env.NEO_MEMORY_DB_PATH_TEST = testDbPath;

        registryDb  = new Database(testDbPath, {verbose: null});
        admissionDb = new Database(testDbPath, {verbose: null});
        activityDb  = new Database(testDbPath, {verbose: null});
        registryDb.pragma('journal_mode = WAL');
        registryDb.pragma('busy_timeout = 5000');
        admissionDb.pragma('busy_timeout = 5000');
        activityDb.pragma('busy_timeout = 5000');

        SourceRegistryService.set({db: registryDb});
        AdmissionService.set({db: admissionDb});
        ActivityService.set({db: activityDb, contentAdapter: null});
        SourceRegistryService.ensureSchema();
        AdmissionService.ensureSchema();
        ActivityService.ensureSchema();
        if (GraphService.db?.storage) {
            GraphService.db.storage.db = activityDb;
            GraphService.db.nodes.clear();
            GraphService.db.edges.clear();
            GraphService.db.adjacency?.clear?.();
        }
        SourceRegistryService.localSubjectId = SUBJECT;
        AdmissionService.attentionPolicy     = ATTENTION_POLICY;
    });

    test.afterEach(async () => {
        ActivityService.set({db: originalActivityDb, contentAdapter: originalContentAdapter});
        SourceRegistryService.set({db: originalRegistryDb, localSubjectId: originalLocalSubjectId});
        AdmissionService.set({db: originalAdmissionDb, attentionPolicy: originalAttentionPolicy});
        if (GraphService.db?.storage) {
            GraphService.db.storage.db = originalGraphStorageDb;
            GraphService.db.nodes.clear();
            GraphService.db.edges.clear();
            GraphService.db.adjacency?.clear?.();
        }
        activityDb.close();
        registryDb.close();
        admissionDb.close();
        await fs.promises.rm(tempRoot, {force: true, recursive: true});
    });

    test.afterAll(() => {
        Object.entries(originalEnv).forEach(([key, value]) => {
            value === undefined ? delete process.env[key] : (process.env[key] = value)
        });
    });

    test('uses half-open occurredAt bounds and excludes popularity-shaped rows', async () => {
        const sourceId = activeSource();

        const admitted = admit(sourceId, [
            observation('before', '2026-09-18T23:59:59.999Z'),
            observation('start',  '2026-09-19T00:00:00.000Z'),
            observation('inside', '2026-09-19T12:00:00.000Z'),
            observation('end',    '2026-09-20T00:00:00.000Z')
        ]);

        expect(admitted.status).toBe('accepted');

        const result = await inTenant(() => ActivityService.query({
            limit      : 20,
            windowEnd  : '2026-09-20T00:00:00.000Z',
            windowStart: '2026-09-19T00:00:00.000Z'
        }));

        expect(new Set(result.items.map(item => item.providerEntityId))).toEqual(new Set(['start', 'inside']));

        const popularity = observation('star', '2026-09-19T13:00:00.000Z', {
            occurrenceKind: 'repository.starred'
        });
        expect(admit(sourceId, [observation('popularity-seed', '2026-09-19T13:00:00.000Z')], {
            baseCheckpointVersion: admitted.receipt.nextCheckpointVersion,
            baseInventoryHash    : admitted.receipt.nextInventoryHash
        }).status).toBe('accepted');
        const popularityRow = admissionDb.prepare(
            'SELECT occurrence_identity FROM mc_community_observation WHERE provider_entity_id = ?'
        ).get('popularity-seed');
        admissionDb.prepare(
            `UPDATE mc_community_observation
             SET occurrence_kind = ?, attention_disposition = ?
             WHERE occurrence_identity = ?`
        ).run(popularity.occurrenceKind, 'eligible', popularityRow.occurrence_identity);

        const afterPopularity = await inTenant(() => ActivityService.query({
            limit      : 20,
            windowEnd  : '2026-09-20T00:00:00.000Z',
            windowStart: '2026-09-19T00:00:00.000Z'
        }));

        expect(afterPopularity.items.some(item => item.providerEntityId === 'popularity-seed')).toBe(false);
        expect(afterPopularity.coverage.totalResolved).toBe(result.coverage.totalResolved);
        await expect(inTenant(() => ActivityService.markSeen({sourceEventId: popularityRow.occurrence_identity})))
            .resolves.toMatchObject({status: 'ineligible'});
        await expect(inTenant(() => ActivityService.getContent({sourceEventId: popularityRow.occurrence_identity})))
            .resolves.toMatchObject({status: 'unknown'});
        expect(admissionDb.prepare('SELECT count(*) AS count FROM mc_community_seen').get().count).toBe(0);
    });

    test('continues same-batch rows with the admitted-sequence plus row-id tuple', async () => {
        const sourceId = activeSource();

        expect(admit(sourceId, [
            observation('first', '2026-09-19T10:00:00.000Z'),
            observation('second', '2026-09-19T10:00:00.000Z')
        ]).status).toBe('accepted');

        const first = await inTenant(() => ActivityService.query({
            ...WINDOW,
            limit: 1
        }));
        const second = await inTenant(() => ActivityService.query({
            ...WINDOW,
            cursor: first.nextCursor,
            limit : 1
        }));

        expect(first.items).toHaveLength(1);
        expect(second.items).toHaveLength(1);
        expect(new Set([first.items[0].providerEntityId, second.items[0].providerEntityId]))
            .toEqual(new Set(['first', 'second']));
    });

    test('keeps an admission after page one outside the fixed snapshot cutoff', async () => {
        const sourceId       = activeSource();
        const firstAdmission = admit(sourceId, [
            observation('page-one', '2026-09-19T10:00:00.000Z'),
            observation('page-two', '2026-09-19T10:01:00.000Z')
        ]);
        const first = await inTenant(() => ActivityService.query({...WINDOW, limit: 1}));

        expect(admit(sourceId, [observation('later-batch', '2026-09-19T10:02:00.000Z')], {
            baseCheckpointVersion: firstAdmission.receipt.nextCheckpointVersion,
            baseInventoryHash    : firstAdmission.receipt.nextInventoryHash
        }).status).toBe('accepted');

        const second = await inTenant(() => ActivityService.query({
            ...WINDOW,
            cursor: first.nextCursor,
            limit : 10
        }));

        expect(second.items).toHaveLength(1);
        expect(['page-one', 'page-two']).toContain(second.items[0].providerEntityId);
        expect(second.items.some(item => item.providerEntityId === 'later-batch')).toBe(false);
    });

    test('seen is idempotent per viewer and does not change the source manifest', async () => {
        const sourceId = activeSource();
        admit(sourceId, [observation('seen-event', '2026-09-19T10:00:00.000Z')]);

        const receiptsBefore    = admissionDb.prepare('SELECT * FROM mc_community_batch_receipt').all();
        const checkpointsBefore = admissionDb.prepare('SELECT * FROM mc_community_checkpoint').all();
        const before            = await RequestContextService.run({userId: SUBJECT, agentIdentityNodeId: '@viewer-a'}, () =>
            ActivityService.query({...WINDOW, limit: 10})
        );
        const firstSeen = await RequestContextService.run({userId: SUBJECT, agentIdentityNodeId: '@viewer-a'}, () =>
            ActivityService.markSeen({sourceEventId: before.items[0].sourceEventId})
        );
        const secondSeen = await RequestContextService.run({userId: SUBJECT, agentIdentityNodeId: '@viewer-a'}, () =>
            ActivityService.markSeen({sourceEventId: before.items[0].sourceEventId})
        );
        const after = await RequestContextService.run({userId: SUBJECT, agentIdentityNodeId: '@viewer-a'}, () =>
            ActivityService.query({...WINDOW, limit: 10})
        );

        expect(firstSeen.status).toBe('seen');
        expect(secondSeen.status).toBe('seen');
        expect(after.items[0].seen).toBe(true);
        expect(after.sourceManifestHash).toBe(before.sourceManifestHash);
        expect(after.coverage.totalResolved).toBe(before.coverage.totalResolved);
        expect(admissionDb.prepare('SELECT count(*) AS count FROM mc_community_seen').get().count).toBe(1);
        expect(admissionDb.prepare('SELECT * FROM mc_community_batch_receipt').all()).toEqual(receiptsBefore);
        expect(admissionDb.prepare('SELECT * FROM mc_community_checkpoint').all()).toEqual(checkpointsBefore);

        const otherViewer = await RequestContextService.run({userId: SUBJECT, agentIdentityNodeId: '@viewer-b'}, () =>
            ActivityService.query({...WINDOW, limit: 10})
        );

        expect(otherViewer.sourceManifestHash).toBe(before.sourceManifestHash);
        expect(otherViewer.items[0].seen).toBe(false);
    });

    test('discards content when source registration changes during the adapter read', async () => {
        const sourceId       = activeSource();
        const firstAdmission = admit(sourceId, [observation('content-event', '2026-09-19T10:00:00.000Z')]);

        let releaseAdapter;
        const adapterStarted = new Promise(resolve => {
            ActivityService.contentAdapter = {
                read: async () => {
                    resolve();
                    await new Promise(release => { releaseAdapter = release });
                    return {
                        citation    : {contentVersion: 'current-provider-read'},
                        contentTrust: {sourceRelative: 'OWNER', tier: 'repo-trusted'},
                        content     : {body: {sanitized: 'transient prose'}},
                        status      : 'available'
                    }
                }
            }
        });

        const listed         = await inTenant(() => ActivityService.query({...WINDOW, limit: 10}));
        const contentPromise = inTenant(() => ActivityService.getContent({sourceEventId: listed.items[0].sourceEventId}));

        await adapterStarted;
        SourceRegistryService.transitionLifecycle(sourceId, 'REVOKED', {
            expectedEpoch: 2,
            expectedState: 'ACTIVE'
        });
        releaseAdapter();

        await expect(contentPromise).resolves.toMatchObject({
            notAuthority : true,
            sourceEventId: listed.items[0].sourceEventId,
            status       : 'inaccessible'
        });

        const reprovisioned = sourceId;
        SourceRegistryService.transitionLifecycle(reprovisioned, 'PROVISIONED', {
            expectedEpoch: 2,
            expectedState: 'REVOKED'
        });
        SourceRegistryService.transitionLifecycle(reprovisioned, 'ACTIVE', {
            expectedEpoch: 3,
            expectedState: 'PROVISIONED'
        });
        expect(admit(reprovisioned, [observation('reprovisioned-event', '2026-09-19T10:00:00.000Z')], {
            baseCheckpointVersion: firstAdmission.receipt.nextCheckpointVersion,
            baseInventoryHash    : firstAdmission.receipt.nextInventoryHash,
            registrationEpoch    : 3
        }).status).toBe('accepted');
        ActivityService.contentAdapter = {read: async () => ({
            content     : {body: {sanitized: 'current prose'}},
            status      : 'available',
            notAuthority: true
        })};

        const reprovisionedPage    = await inTenant(() => ActivityService.query({...WINDOW, limit: 10}));
        const reprovisionedContent = await inTenant(() => ActivityService.getContent({
            sourceEventId: reprovisionedPage.items.find(item => item.providerEntityId === 'reprovisioned-event').sourceEventId
        }));

        expect(reprovisionedContent.status).toBe('available');
        await expect(inTenant(() => ActivityService.getContent({sourceEventId: listed.items[0].sourceEventId})))
            .resolves.toMatchObject({status: 'available'});

        let releaseRefresh;
        const refreshStarted = new Promise(resolve => {
            ActivityService.contentAdapter = {
                read: async () => {
                    resolve();
                    await new Promise(release => { releaseRefresh = release });
                    return {content: {body: {sanitized: 'stale grant'}}, status: 'available'}
                }
            }
        });
        const refreshEvent   = reprovisionedPage.items.find(item => item.providerEntityId === 'reprovisioned-event');
        const refreshPromise = inTenant(() => ActivityService.getContent({sourceEventId: refreshEvent.sourceEventId}));

        await refreshStarted;
        SourceRegistryService.register({...SOURCE, grantRef: 'refreshed-grant'});
        releaseRefresh();

        await expect(refreshPromise).resolves.toMatchObject({
            notAuthority : true,
            sourceEventId: refreshEvent.sourceEventId,
            status       : 'inaccessible'
        });
    });

    test('qualifies empty public counts only after all three actual producers exhaust and their batches are admitted', async () => {
        const sourceId = activeSource(), calls = [], pageInfo = {hasNextPage: false, endCursor: null};
        const page = (name, nodes) => async ({cursor}) => {
            expect(cursor).toBeNull();
            calls.push(name);
            return {...nodes, pageInfo, totalCount: 0}
        };
        const unexpectedChild = async () => { throw new Error('An empty family must not request a child connection') };
        const results = {
            issues: await reconcileIssueActivity({
                fetchIssuesPage: page('issues', {issues: []}),
                fetchCommentsPage: unexpectedChild, fetchTimelinePage: unexpectedChild
            }),
            pulls: await reconcilePullRequestActivity({
                fetchPullRequestsPage: page('pulls', {pullRequests: []}),
                fetchCensusPage: page('pulls-census', {pullRequests: []}),
                fetchReviewCommentSnapshot: async () => {
                    calls.push('pulls-inline-census');
                    return {reviewCommentsByPullRequestNumber: new Map(), failuresByPullRequestNumber: new Map()}
                },
                exhaustConversation: unexpectedChild, fetchTimelinePage: unexpectedChild,
                fetchContentEditHeads: unexpectedChild, fetchContentEditsPage: unexpectedChild,
                verifyContentEntities: unexpectedChild
            }),
            discussions: await reconcileDiscussionActivity({
                fetchDiscussionsPage: page('discussions', {discussions: []}),
                fetchCensusPage: page('discussions-census', {discussions: []}),
                fetchCommentsPage: unexpectedChild, fetchRepliesPage: unexpectedChild,
                fetchContentEditHeads: unexpectedChild, fetchContentEditsPage: unexpectedChild,
                verifyContentEntities: unexpectedChild
            })
        };
        expect(calls).toEqual(['issues', 'pulls', 'pulls-inline-census', 'pulls-census', 'discussions', 'discussions-census']);

        for (const [resourceFamily, runnerResult] of Object.entries(results)) {
            expect(runnerResult.observations).toEqual([]);
            expect(validateCommunityCoverage(runnerResult.coverage, {resourceFamily}).qualified).toBe(true);
            const {adapterSchemaVersion, providerStateSchemaVersion} = COMMUNITY_COVERAGE_CONTRACTS[resourceFamily].contract;
            const batch = assembleIssueBatch({sourceInstanceId: sourceId, resourceFamily, registrationEpoch: 2,
                baseCheckpointVersion: 0, baseInventoryHash: null, runnerResult, currentInventory: [],
                batchId: `empty-producer-${resourceFamily}`, observedAt: WINDOW.windowStart,
                adapterSchemaVersion, providerStateSchemaVersion});
            expect(batch.coverage).toEqual(runnerResult.coverage);
            const admitted = await inTenant(() => AdmissionService.admitBatch(batch));
            expect(admitted.status).toBe('accepted');
            expect(admitted.receipt.coverage).toEqual(runnerResult.coverage);
            const counts = await inTenant(() => ActivityService.projectAttentionCounts({sourceInstanceIds: [sourceId]}));
            expect(counts.count).toBe(0);
            expect(counts.status).toBe(resourceFamily === 'discussions' ? 'empty' : 'degraded');
        }

        const counts = await inTenant(() => ActivityService.projectAttentionCounts({sourceInstanceIds: [sourceId]}));
        expect(counts.coverage).toMatchObject({degraded: false, sourceCount: 1, completeSourceCount: 1});
        for (const family of counts.sources[0].families) {
            expect(family).toMatchObject({complete: true, qualified: true, qualificationReason: null, gapCount: 0});
            expect(family.contract).toEqual(COMMUNITY_COVERAGE_CONTRACTS[family.resourceFamily].contract);
            expect(family.providerLimitations).toEqual(COMMUNITY_COVERAGE_CONTRACTS[family.resourceFamily].providerLimitations);
        }
        const document = yaml.load(fs.readFileSync('ai/mcp/server/memory-core/openapi.yaml', 'utf8'));
        const ajv = new Ajv({allErrors: true, strict: false, validateFormats: false});
        ajv.addSchema({components: document.components}, 'producer-empty-community-api');
        const validate = ajv.compile({$ref: 'producer-empty-community-api#/components/schemas/CommunityActivityAttentionCountsResponse'});
        expect(validate(counts), JSON.stringify(validate.errors)).toBe(true);
        const outputSchema = buildOutputZodSchema(document, document.paths['/community/activity/attention-counts'].post);
        expect(outputSchema.parse(counts)).toEqual(counts);

        const observed = await inTenant(() => ActivityService.observeStewardWake({sourceInstanceIds: [sourceId]}));
        expect(observed.attentionCounts).toMatchObject({status: 'empty', count: 0, coverage: {degraded: false}});
        expect(observed.evaluation).toMatchObject({stewardVacant: true, shadowWouldWake: false, shouldWake: false});
        expect(activityDb.prepare('SELECT COUNT(*) AS n FROM mc_community_task_binding').get().n).toBe(0);
    });

    test('legacy complete receipts remain unqualified and later bound admissions do not strengthen an older public snapshot', async () => {
        const sourceId = activeSource(), legacyReceipts = [], legacyPayloads = [], boundPayloads = [];
        const storedReceipt = receiptId => admissionDb.prepare(
            'SELECT receipt_id, digest, coverage FROM mc_community_batch_receipt WHERE receipt_id = ?'
        ).get(receiptId);
        for (const resourceFamily of Object.keys(COMMUNITY_COVERAGE_CONTRACTS)) {
            const rows = resourceFamily === 'issues' ? [
                observation('legacy-first', '2026-09-19T10:00:00Z'),
                observation('legacy-second', '2026-09-19T11:00:00Z')
            ] : [];
            const batch = batchAt(sourceId, rows, {resourceFamily, batchId: `retained-legacy-${resourceFamily}`,
                coverage: {fromBasis: 'genesis', toBasis: 'legacy-end', complete: true}});
            const admitted = await inTenant(() => AdmissionService.admitBatch(batch));
            expect(admitted.status).toBe('accepted');
            legacyReceipts.push(admitted.receipt.receiptId);
            legacyPayloads.push({batch, receipt: admitted.receipt, stored: storedReceipt(admitted.receipt.receiptId)});
        }
        const before = await inTenant(() => ActivityService.projectAttentionCounts({sourceInstanceIds: [sourceId]}));
        expect(before).toMatchObject({status: 'degraded', count: 2});
        expect(before.coverage.degradedReasons).toContain('legacy-coverage-unqualified');
        expect(before.sources[0].families.every(family => family.complete && !family.qualified &&
            family.qualificationReason === 'legacy-coverage-unqualified' && family.contract === null)).toBe(true);
        const query = { ...WINDOW, limit: 1, sourceInstanceIds: [sourceId] };
        const first = await inTenant(() => ActivityService.query(query));
        expect(first.items).toHaveLength(1);
        expect(first.nextCursor).toBeTruthy();

        for (const resourceFamily of Object.keys(COMMUNITY_COVERAGE_CONTRACTS)) {
            const checkpoint = AdmissionService.getCheckpoint(sourceId, resourceFamily);
            const batch = batchAt(sourceId, [], {resourceFamily, batchId: `retained-bound-${resourceFamily}`,
                baseCheckpointVersion: checkpoint.checkpointVersion, baseInventoryHash: checkpoint.inventoryHash});
            const admitted = await inTenant(() => AdmissionService.admitBatch(batch));
            expect(admitted.status).toBe('accepted');
            boundPayloads.push({batch, receipt: admitted.receipt, stored: storedReceipt(admitted.receipt.receiptId)});
        }
        const after = await inTenant(() => ActivityService.projectAttentionCounts({sourceInstanceIds: [sourceId]}));
        expect(after).toMatchObject({status: 'fresh', count: 2});
        expect(after.sources[0].families.every(family => family.qualified)).toBe(true);

        const continued = await inTenant(() => ActivityService.query({...query, cursor: first.nextCursor}));
        expect(continued.snapshot).toBe(first.snapshot);
        expect(continued.items).toHaveLength(1);
        expect(continued.items[0].sourceEventId).not.toBe(first.items[0].sourceEventId);
        expect(continued.coverage.sources[0].families.every(family => !family.qualified &&
            family.qualificationReason === 'legacy-coverage-unqualified' && legacyReceipts.includes(family.receiptId))).toBe(true);

        const checkpoints = () => Object.fromEntries(Object.keys(COMMUNITY_COVERAGE_CONTRACTS)
            .map(resourceFamily => [resourceFamily, AdmissionService.getCheckpoint(sourceId, resourceFamily)]));
        const advancedCheckpoints = checkpoints();
        expect(Object.values(advancedCheckpoints).every(checkpoint => checkpoint.checkpointVersion === 2)).toBe(true);
        for (const retained of legacyPayloads) {
            const replay = await inTenant(() => AdmissionService.admitBatch(retained.batch));
            expect(replay).toMatchObject({status: 'idempotent', digest: retained.stored.digest});
            expect(replay.receipt).toEqual(retained.receipt);
            expect(storedReceipt(retained.receipt.receiptId)).toEqual(retained.stored);
            expect(checkpoints()).toEqual(advancedCheckpoints);
        }

        const bound = boundPayloads[0], changedKnownBatch = structuredClone(bound.batch);
        changedKnownBatch.coverage.providerLimitations.pop();
        const changedReplay = await inTenant(() => AdmissionService.admitBatch(changedKnownBatch));
        expect(changedReplay).toMatchObject({status: 'conflict', reason: 'DIGEST_MISMATCH'});
        expect(changedReplay.digest).not.toBe(bound.stored.digest);
        expect(changedReplay.receipt).toEqual(bound.receipt);
        expect(storedReceipt(bound.receipt.receiptId)).toEqual(bound.stored);

        const freshInvalidTuple = batchAt(sourceId, [], {batchId: 'fresh-invalid-coverage-tuple',
            baseCheckpointVersion: advancedCheckpoints.issues.checkpointVersion,
            baseInventoryHash: advancedCheckpoints.issues.inventoryHash});
        freshInvalidTuple.adapterSchemaVersion = 'github-issue.unknown';
        expect(await inTenant(() => AdmissionService.admitBatch(freshInvalidTuple))).toMatchObject({
            status: 'conflict', reason: 'COVERAGE_INVALID', errors: expect.arrayContaining(['COVERAGE_CONTRACT_MISMATCH'])
        });
        expect(checkpoints()).toEqual(advancedCheckpoints);
        for (const retained of [...legacyPayloads, ...boundPayloads]) {
            expect(storedReceipt(retained.receipt.receiptId)).toEqual(retained.stored);
        }
        expect(admissionDb.prepare('SELECT COUNT(*) AS count FROM mc_community_batch_receipt').get().count).toBe(6);
    });

    test('refuses incomplete, extra, duplicate, wrong-family and unknown declarations before storing coverage', async () => {
        const sourceId = activeSource();
        const cases = [
            ['missing binding', coverage => { delete coverage.contract }, 'COVERAGE_CONTRACT_REQUIRED'],
            ['missing binding field', coverage => { delete coverage.contract.adapterSchemaVersion }, 'COVERAGE_CONTRACT_MISMATCH'],
            ['extra binding field', coverage => { coverage.contract.extra = 'unsupported' }, 'COVERAGE_CONTRACT_MISMATCH'],
            ['wrong family', coverage => { coverage.contract.resourceFamily = 'pulls' }, 'COVERAGE_CONTRACT_MISMATCH'],
            ['unknown generation', coverage => { coverage.contract.schemaVersion = 'community-coverage.unknown' }, 'COVERAGE_CONTRACT_MISMATCH'],
            ['unknown family', coverage => { coverage.contract.resourceFamily = 'unknown' }, 'COVERAGE_CONTRACT_UNRECOGNIZED'],
            ['missing limitation', coverage => { coverage.providerLimitations.pop() }, 'COVERAGE_LIMITATIONS_MISMATCH'],
            ['extra limitation', coverage => { coverage.providerLimitations.push({axis: 'extra', reason: 'unsupported'}) }, 'COVERAGE_LIMITATIONS_MISMATCH'],
            ['duplicate limitation', coverage => { coverage.providerLimitations[1] = {...coverage.providerLimitations[0]} }, 'COVERAGE_LIMITATIONS_MISMATCH']
        ];
        for (const [label, mutate, error] of cases) {
            const coverage = bindCommunityCoverage('issues', {fromBasis: 'genesis', toBasis: 'end', complete: true});
            mutate(coverage);
            expect(validateCommunityCoverage(coverage, {resourceFamily: 'issues'}), label).toMatchObject({
                valid: false, qualified: false, errors: expect.arrayContaining([error])
            });
            const result = await inTenant(() => admit(sourceId, [], {coverage}));
            expect(result, label).toMatchObject({status: 'conflict', reason: 'COVERAGE_INVALID', errors: expect.arrayContaining([error])});
            expect(AdmissionService.getCheckpoint(sourceId, 'issues'), label).toBeNull();
        }
        expect(admissionDb.prepare('SELECT COUNT(*) AS count FROM mc_community_batch_receipt').get().count).toBe(0);
    });

    test('requires current-epoch evidence in every family after an actual source reprovision', async () => {
        const sourceId = activeSource();
        for (const resourceFamily of Object.keys(COMMUNITY_COVERAGE_CONTRACTS)) {
            expect((await inTenant(() => admit(sourceId, [], {resourceFamily}))).status).toBe('accepted');
        }
        const before = await inTenant(() => ActivityService.projectAttentionCounts({sourceInstanceIds: [sourceId]}));
        expect(before.status).toBe('empty');
        const snapshot = before.coverage.snapshot;
        SourceRegistryService.transitionLifecycle(sourceId, 'REVOKED', {expectedState: 'ACTIVE', expectedEpoch: 2});
        SourceRegistryService.transitionLifecycle(sourceId, 'PROVISIONED', {expectedState: 'REVOKED', expectedEpoch: 2});
        SourceRegistryService.transitionLifecycle(sourceId, 'ACTIVE', {expectedState: 'PROVISIONED', expectedEpoch: 3});
        const stale = await inTenant(() => ActivityService.projectAttentionCounts({sourceInstanceIds: [sourceId]}));
        expect(stale).toMatchObject({status: 'degraded', count: 0});
        expect(stale.sources[0].families.every(family => family.complete && !family.qualified &&
            family.qualificationReason === 'source-coverage-epoch-stale')).toBe(true);

        for (const resourceFamily of Object.keys(COMMUNITY_COVERAGE_CONTRACTS)) {
            const checkpoint = AdmissionService.getCheckpoint(sourceId, resourceFamily);
            const result = await inTenant(() => admit(sourceId, [], {resourceFamily, registrationEpoch: 3,
                baseCheckpointVersion: checkpoint.checkpointVersion, baseInventoryHash: checkpoint.inventoryHash}));
            expect(result.status).toBe('accepted');
            const current = await inTenant(() => ActivityService.projectAttentionCounts({sourceInstanceIds: [sourceId]}));
            expect(current.status).toBe(resourceFamily === 'discussions' ? 'empty' : 'degraded');
        }
        const historical = ActivityService.readCoverage({tenantId: SUBJECT, ids: [sourceId], snapshot});
        expect(historical[0].families.every(family => !family.qualified && family.qualificationReason === 'source-coverage-epoch-stale')).toBe(true);
    });

    test('labels the eligible admitted historical slice without resolving unknown closes or reclassifying stored actors', async () => {
        const sourceId = activeSource();
        AdmissionService.attentionPolicy = {...ATTENTION_POLICY,
            responseBearingKinds: [...ATTENTION_POLICY.responseBearingKinds, 'discussion.reply'],
            recordedActorDispositions: {'reviewed-unknown': 'eligible'}};
        const author = {login: 'external-discussion-human', __typename: 'User'};
        const reply = (id, time) => ({id, createdAt: `2026-09-19T${time}:00Z`, author, authorAssociation: 'NONE'});
        const comment = (id, time, replies = []) => ({...reply(id, time), replies});
        const discussion = {id: 'metric-discussion', createdAt: '2026-09-19T09:00:00Z',
            updatedAt: '2026-09-19T12:05:00Z', author, authorAssociation: 'NONE', closed: false,
            comments: [
                comment('metric-pre', '10:00', [reply('metric-pre-reply', '10:05'), reply('metric-late-reply', '12:05')]),
                comment('metric-claimed', '10:10'), comment('metric-middle', '10:45'), comment('metric-late', '12:00')
            ]};
        const publish = (resourceFamily, rows) => {
            const checkpoint = AdmissionService.getCheckpoint(sourceId, resourceFamily);
            const result = admit(sourceId, rows, {resourceFamily,
                baseCheckpointVersion: checkpoint?.checkpointVersion ?? 0, baseInventoryHash: checkpoint?.inventoryHash ?? null});
            expect(result.status).toBe('accepted');
            return result
        };
        await inTenant(() => {
            publish('issues', [
                observation('metric-unknown-response', '2026-09-19T09:00:00Z', {actorId: 'unreviewed-response', actorKind: 'unknown'}),
                observation('metric-unknown-label', '2026-09-19T09:05:00Z', {actorId: 'unreviewed-label', actorKind: 'unknown', occurrenceKind: 'issue.labeled'}),
                observation('metric-bot', '2026-09-19T09:10:00Z', {actorKind: 'bot'}),
                observation('metric-reviewed', '2026-09-19T09:15:00Z', {actorId: 'reviewed-unknown', actorKind: 'unknown'})
            ]);
            publish('pulls', []);
            publish('discussions', discussionToObservations(discussion));
        });
        const page = await inTenant(() => ActivityService.query({...WINDOW, limit: 30, sourceInstanceIds: [sourceId]}));
        const toClaim = page.items.find(item => item.providerEntityId === 'metric-claimed');
        expect(toClaim).toBeDefined();
        const claimed = await RequestContextService.run({userId: SUBJECT, agentIdentityNodeId: '@community-metric-reader'}, () =>
            ActivityService.claimTask({sourceEventId: toClaim.sourceEventId}));
        expect(claimed.created).toBe(true);
        const read = () => inTenant(() => ActivityService.projectAttentionCounts({sourceInstanceIds: [sourceId]}));
        const before = await read();
        expect(before).toMatchObject({count: 6, measurement: {
            population: 'eligible-admitted', claimedExcludedCount: 1, unreviewedActorExcludedCount: 2,
            responseBearingUnreviewedActorExcludedCount: null,
            historicalSlice: {basis: 'eligible-unclaimed-discussion-items-at-latest-unattributed-closure',
                label: 'latest admitted closure; reopen not observable', count: 0, invalidClosureTimes: 0}
        }});

        await inTenant(() => publish('discussions', discussionToObservations({...discussion,
            closed: true, closedAt: '2026-09-19T11:00:00Z'})));
        const after = await read();
        expect(after).toMatchObject({count: before.count, status: 'fresh', measurement: {
            population: 'eligible-admitted', unreviewedActorExcludedCount: 3,
            responseBearingUnreviewedActorExcludedCount: null,
            historicalSlice: {count: 3, invalidClosureTimes: 0}
        }});
        const afterPage = await inTenant(() => ActivityService.query({...WINDOW, limit: 30, sourceInstanceIds: [sourceId]}));
        expect(afterPage.items.some(item => item.providerEntityId === 'metric-late-reply')).toBe(true);

        await inTenant(() => publish('discussions', discussionToObservations({...discussion,
            closed: true, closedAt: '2026-09-19T10:30:00Z'})));
        expect((await read()).measurement.historicalSlice.count).toBe(3);
        await inTenant(() => publish('discussions', discussionToObservations({...discussion,
            updatedAt: '2026-09-19T13:00:00Z', closed: false})));
        const reopened = await read();
        expect(reopened).toMatchObject({count: before.count, measurement: {
            unreviewedActorExcludedCount: 5, responseBearingUnreviewedActorExcludedCount: null,
            historicalSlice: {count: 3, invalidClosureTimes: 0}
        }});
        const retained = activityDb.prepare(`SELECT occurrence_kind, attention_disposition, attention_reason
            FROM mc_community_observation WHERE tenant_id = ? AND source_instance_id = ? AND provider_entity_id = ?`)
            .get(SUBJECT, sourceId, 'metric-unknown-label');
        expect(retained).toEqual({occurrence_kind: 'issue.labeled', attention_disposition: 'ineligible',
            attention_reason: 'actor-kind-not-reviewed-fail-closed'});
        AdmissionService.attentionPolicy = {...ATTENTION_POLICY, responseBearingKinds: [],
            recordedActorDispositions: {'unreviewed-response': 'eligible', 'unreviewed-label': 'eligible'}};
        const changedPolicy = await read();
        expect(changedPolicy.count).toBe(reopened.count);
        expect(changedPolicy.measurement).toEqual(reopened.measurement);
    });

    test('keeps invalid unattributed-closure metrics unknown and isolated by source and tenant', async () => {
        const sourceA = activeSource({displayLocator: 'metrics/a', providerResourceId: 'metrics/a'});
        const sourceB = activeSource({displayLocator: 'metrics/b', providerResourceId: 'metrics/b'});
        const rows = invalid => [
            observation('shared-comment-id', '2026-09-19T10:00:00Z', {occurrenceKind: 'discussion.comment', parentProviderEntityId: 'shared-root-id'}),
            observation('shared-root-id', '2026-09-19T11:00:00Z', {occurrenceKind: 'discussion.closed',
                occurrenceCoordinate: 'shared-root-id:closed:valid', actorKind: 'unknown', actorId: null}),
            ...(invalid ? [observation('shared-root-id', 'not-a-time', {occurrenceKind: 'discussion.closed',
                occurrenceCoordinate: 'shared-root-id:closed:invalid', actorKind: 'unknown', actorId: null})] : [])
        ];
        const populate = (sourceId, invalid) => {
            for (const resourceFamily of Object.keys(COMMUNITY_COVERAGE_CONTRACTS)) {
                const admitted = admit(sourceId, resourceFamily === 'discussions' ? rows(invalid) : [], {resourceFamily});
                expect(admitted.status).toBe('accepted');
            }
        };
        await inTenant(() => { populate(sourceA, false); populate(sourceB, true) });
        const foreignTenant = 'community-metric-foreign';
        const previousSubject = SourceRegistryService.localSubjectId;
        let foreignSource;
        try {
            SourceRegistryService.localSubjectId = foreignTenant;
            foreignSource = activeSource({displayLocator: 'metrics/foreign', providerResourceId: 'metrics/foreign'});
            await RequestContextService.run({userId: foreignTenant}, () => populate(foreignSource, true));
        } finally {
            SourceRegistryService.localSubjectId = previousSubject;
        }
        const a = await inTenant(() => ActivityService.projectAttentionCounts({sourceInstanceIds: [sourceA]}));
        expect(a).toMatchObject({count: 1, measurement: {unreviewedActorExcludedCount: 1,
            historicalSlice: {count: 1, invalidClosureTimes: 0}}});
        const b = await inTenant(() => ActivityService.projectAttentionCounts({sourceInstanceIds: [sourceB]}));
        expect(b).toMatchObject({count: 1, measurement: {unreviewedActorExcludedCount: 2,
            historicalSlice: {count: null, invalidClosureTimes: 1}}});
        const own = await inTenant(() => ActivityService.projectAttentionCounts());
        expect(own.coverage.sourceCount).toBe(2);
        expect(own).toMatchObject({count: 2, measurement: {historicalSlice: {count: null, invalidClosureTimes: 1}}});
        const foreign = await RequestContextService.run({userId: foreignTenant}, () => ActivityService.projectAttentionCounts());
        expect(foreign.coverage.sourceCount).toBe(1);
        expect(foreign).toMatchObject({count: 1, measurement: {historicalSlice: {count: null, invalidClosureTimes: 1}}});
        await expect(inTenant(() => ActivityService.projectAttentionCounts({sourceInstanceIds: [foreignSource]})))
            .rejects.toThrow('COMMUNITY_SOURCE_NOT_OWNED');
    });

    test('keeps real coverage gaps and unsupported source families degraded', async () => {
        const sourceId  = activeSource(),
              unknownId = activeSource({
                  canonicalProviderHost: 'gitlab.com',
                  displayLocator       : 'example/project',
                  provider             : 'gitlab',
                  providerResourceId   : 'example/project'
              });

        admit(sourceId, [observation('coverage-event', '2026-09-19T10:00:00.000Z')], {
            coverage: {
                complete : false,
                fromBasis: 'from',
                gaps     : [{axis: 'comments', reason: 'provider-gap'}],
                toBasis  : 'to'
            }
        });

        const result        = await inTenant(() => ActivityService.query({...WINDOW, limit: 10}));
        const unknownSource = result.coverage.sources.find(source => source.sourceInstanceId === unknownId);

        expect(result.coverage.degraded).toBe(true);
        expect(result.coverage.degradedReasons).toEqual(expect.arrayContaining([
            'source-coverage-incomplete',
            'source-coverage-unknown',
            'source-unsupported'
        ]));
        expect(unknownSource.degradedReasons).toContain('source-unsupported');
    });

    test('reports invalid durable occurrence time and keeps default reads provider-free', async () => {
        const sourceId = activeSource();
        admit(sourceId, [observation('invalid-time', '2026-09-19T10:00:00.000Z'),
            observation('valid-metadata', '2026-09-19T11:00:00.000Z')]);
        admissionDb.prepare('UPDATE mc_community_observation SET occurred_at = ? WHERE provider_entity_id = ?')
            .run('not-a-date', 'invalid-time');

        let adapterCalls = 0;
        ActivityService.contentAdapter = {read: async () => {
            adapterCalls++;
            return {status: 'available', content: {body: {sanitized: 'must not be read'}}}
        }};

        const result = await inTenant(() => ActivityService.query({...WINDOW, limit: 10}));

        expect(result.coverage.invalidTimes).toBe(1);
        expect(result.coverage.degraded).toBe(true);
        expect(result.items.map(item => item.providerEntityId)).toEqual(['valid-metadata']);
        expect(adapterCalls).toBe(0);
        expect(result.synthesis).toBeNull();
        expect(JSON.stringify(result)).not.toContain('title');
        expect(JSON.stringify(result)).not.toContain('body');
        expect(JSON.stringify(result)).not.toContain('excerpt');
    });

    test('requires a bound viewer even when local tenant fallback exists', async () => {
        const sourceId = activeSource();
        admit(sourceId, [observation('viewer-event', '2026-09-19T10:00:00.000Z')]);

        await expect(ActivityService.markSeen({sourceEventId: 'missing-event'}))
            .rejects.toThrow('COMMUNITY_SEEN_CONTEXT_REQUIRED');
    });

    test('requires explicit tombstone evidence and never fetches deleted content', async () => {
        const sourceId = activeSource();
        admit(sourceId, [
            observation('tombstone-event', '2026-09-19T10:00:00.000Z', {
                absence         : 'deleted',
                deletionEvidence: {deletedAt: '2026-09-19T11:00:00.000Z', tombstoneId: 't-1'}
            }),
            observation('no-evidence-event', '2026-09-19T10:01:00.000Z')
        ]);
        admissionDb.prepare('UPDATE mc_community_observation SET absence = ?, deletion_evidence = NULL WHERE provider_entity_id = ?')
            .run('deleted', 'no-evidence-event');

        let adapterCalls = 0;
        ActivityService.contentAdapter = {read: async () => {
            adapterCalls++;
            return {status: 'available', content: {body: {sanitized: 'current'}}}
        }};
        const listed     = await inTenant(() => ActivityService.query({...WINDOW, limit: 10}));
        const tombstone  = listed.items.find(item => item.providerEntityId === 'tombstone-event');
        const noEvidence = listed.items.find(item => item.providerEntityId === 'no-evidence-event');

        await expect(inTenant(() => ActivityService.getContent({sourceEventId: tombstone.sourceEventId})))
            .resolves.toMatchObject({sourceEventId: tombstone.sourceEventId, status: 'deleted'});
        await expect(inTenant(() => ActivityService.getContent({sourceEventId: noEvidence.sourceEventId})))
            .resolves.toMatchObject({sourceEventId: noEvidence.sourceEventId, status: 'available'});
        expect(adapterCalls).toBe(1);
    });

    test('later non-attention deletion evidence explains an earlier attention handle', async () => {
        const sourceId = activeSource(),
              first    = admit(sourceId, [observation('deleted-later', '2026-09-19T10:00:00Z')]),
              page     = await inTenant(() => ActivityService.query({...WINDOW, limit: 10}));

        expect(admit(sourceId, [observation('deleted-later', '2026-09-19T11:00:00Z', {
            occurrenceKind: 'issue.deleted', occurrenceCoordinate: 'later-tombstone',
            actorId       : 'internal', absence: 'deleted', deletionEvidence: {deletedAt: '2026-09-19T11:00:00Z'}
        })], {baseCheckpointVersion: first.receipt.nextCheckpointVersion,
            baseInventoryHash: first.receipt.nextInventoryHash}).status).toBe('accepted');

        let calls = 0;
        ActivityService.contentAdapter = {read: () => { calls++; return {status: 'unknown'} }};
        await expect(inTenant(() => ActivityService.getContent({sourceEventId: page.items[0].sourceEventId})))
            .resolves.toMatchObject({status: 'deleted'});
        expect(calls).toBe(0);
        expect((await inTenant(() => ActivityService.query({...WINDOW, limit: 10}))).items).toHaveLength(1);
    });

    test('real query, seen and current-content outputs satisfy the published OpenAPI response schemas', async () => {
        const document = yaml.load(fs.readFileSync(new URL('../../../../../../ai/mcp/server/memory-core/openapi.yaml', import.meta.url), 'utf8')),
              ajv      = new Ajv({allErrors: true, strict: false, validateFormats: false});

        ajv.addSchema({components: document.components}, 'community-api');

        const assertSchema = (name, value) => {
            const validate = ajv.compile({$ref: `community-api#/components/schemas/${name}`});
            expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
        };
        const sourceId = activeSource();
        admit(sourceId, [observation('schema-event', '2026-09-19T10:00:00Z')]);

        const page = await inTenant(() => ActivityService.query({...WINDOW, limit: 10}));
        assertSchema('CommunityActivityQueryResponse', page);
        assertSchema('CommunityActivitySeenResponse', await inTenant(() => ActivityService.markSeen({sourceEventId: page.items[0].sourceEventId})));

        const adapter = (await import('../../../../../../ai/services/github-workflow/GitHubCommunityContentService.mjs')).default;
        ActivityService.contentAdapter = {read: options => adapter.read({...options, graphqlService: {
            query: async () => ({node: {__typename: 'IssueComment', id: 'schema-event',
                repository: {nameWithOwner: 'neomjs/neo'}, url: 'https://github.com/neomjs/neo/issues/1#issuecomment-1',
                updatedAt : '2026-09-19T10:00:00Z',
                body      : 'I can provide a hosted MCP endpoint. https://external.example/content', authorAssociation: 'NONE'}})
        }})};
        const content = await inTenant(() => ActivityService.getContent({sourceEventId: page.items[0].sourceEventId}));
        expect(content.status).toBe('available');
        assertSchema('CommunityActivityContentResponse', content);
        expect(content.content.body).toContain('QUARANTINED_URL');
        expect(content.contentTrust).toEqual({
            tier      : 'external', sourceRelative: 'NONE', wasModified: true,
            redactions: [{at: 'body', type: 'url', domain: 'external.example'}],
            signals   : [{at: 'body', id: 'external-endpoint-offer',
                note: 'offer to stand up an external endpoint / index our repo (external-infra-on-our-content)'}]
        });
        expect(JSON.stringify(content)).not.toContain('https://external.example');
    });

    test('wrong tenants cannot reuse cursors, read content, or mark events seen', async () => {
        const sourceId = activeSource();
        admit(sourceId, [
            observation('tenant-event', '2026-09-19T10:00:00.000Z'),
            observation('tenant-event-2', '2026-09-19T10:01:00.000Z')
        ]);

        const ownerPage = await RequestContextService.run({userId: SUBJECT}, () =>
            ActivityService.query({...WINDOW, limit: 1})
        );

        await expect(RequestContextService.run({userId: 'other-tenant'}, () =>
            ActivityService.query({...WINDOW, cursor: ownerPage.nextCursor, limit: 1})
        )).rejects.toThrow(/COMMUNITY_CURSOR_(INVALID|SCOPE_MISMATCH)/);

        const foreignContent = await RequestContextService.run({userId: 'other-tenant'}, () =>
            ActivityService.getContent({sourceEventId: ownerPage.items[0].sourceEventId})
        );
        const foreignSeen = await RequestContextService.run({userId: 'other-tenant'}, () =>
            ActivityService.markSeen({sourceEventId: ownerPage.items[0].sourceEventId})
        );
        const foreignPage = await RequestContextService.run({userId: 'other-tenant'}, () =>
            ActivityService.query({...WINDOW, limit: 1})
        );

        expect(foreignContent.status).toBe('unknown');
        expect(foreignSeen.status).toBe('ineligible');
        expect(foreignPage.items).toEqual([]);
    });

    test('rejects invalid dates and malformed cursors before reading a page', async () => {
        activeSource();

        await expect(inTenant(() => ActivityService.query({
            ...WINDOW,
            limit      : 1,
            windowStart: 'not-a-date'
        }))).rejects.toThrow(/parseable windowStart/);

        await expect(inTenant(() => ActivityService.query({
            ...WINDOW,
            cursor: '%%%not-a-cursor%%%',
            limit : 1
        }))).rejects.toThrow('COMMUNITY_CURSOR_INVALID');
    });

    test('AC1–AC9: binds eligible community events to canonical A2A Tasks with atomic transactions, idempotency, crash safety, and fail-closed RBAC (#102)', async () => {
        const sourceId = activeSource();

        expect(admit(sourceId, [
            observation('eligible-comment', '2026-09-19T12:00:00.000Z', {
                occurrenceKind        : 'issue.comment',
                parentProviderEntityId: '19129'
            }),
            observation('popularity-star', '2026-09-19T12:05:00.000Z'),
            observation('deleted-comment', '2026-09-19T12:10:00.000Z', {
                absence         : 'deleted',
                deletionEvidence: {deletedAt: '2026-09-19T12:11:00.000Z', tombstoneId: 't-1'}
            })
        ]).status).toBe('accepted');

        // Corrupt the popularity row to repository.starred + eligible in SQLite so we prove claimTask enforces response-bearing kind checks too.
        const starRow = activityDb.prepare(`
            SELECT occurrence_identity FROM mc_community_observation
            WHERE tenant_id = ? AND provider_entity_id = 'popularity-star'
        `).get(SUBJECT);
        const deletedRow = activityDb.prepare(`
            SELECT occurrence_identity FROM mc_community_observation
            WHERE tenant_id = ? AND provider_entity_id = 'deleted-comment'
        `).get(SUBJECT);
        activityDb.prepare(`
            UPDATE mc_community_observation
            SET occurrence_kind = 'repository.starred', attention_disposition = 'eligible'
            WHERE tenant_id = ? AND occurrence_identity = ?
        `).run(SUBJECT, starRow.occurrence_identity);

        const listed = await inTenant(() => ActivityService.query({...WINDOW, limit: 10}));
        expect(new Set(listed.items.map(entry => entry.providerEntityId))).toEqual(new Set(['deleted-comment', 'eligible-comment']));
        const item = listed.items.find(entry => entry.providerEntityId === 'eligible-comment');

        // AC8: Unclaimed community items remain outside LifecycleFrontier and Golden Path ranking.
        const unclaimedTasks = await inTenant(() => ActivityService.listClaimedTasks());
        expect(unclaimedTasks).toEqual([]);
        expect(collectLifecycleItems({
            agentId: '@neo-gemini-maryam',
            tasks  : unclaimedTasks
        })).toEqual([]);
        expect(admitClaimedTask({
            agentId: '@neo-gemini-maryam',
            task   : item
        })).toBeNull();
        expect(isActionableComputedRecommendation({
            action       : 'community_observation',
            notAuthority : true,
            sourceEventId: item.sourceEventId
        })).toBe(false);

        // AC7: Seen state, count projection, and provider delivery ids cannot authorize claim.
        await RequestContextService.run({agentIdentityNodeId: '@neo-gemini-maryam', userId: SUBJECT}, async () => {
            await ActivityService.markSeen({sourceEventId: item.sourceEventId});
        });
        expect(activityDb.prepare('SELECT COUNT(*) AS count FROM mc_community_task_binding').get().count).toBe(0);

        const unknownAttempt = await RequestContextService.run({
            agentIdentityNodeId: '@neo-gemini-maryam',
            userId             : SUBJECT
        }, () => ActivityService.claimTask({sourceEventId: 'provider-delivery-id-not-an-occurrence'}));
        expect(unknownAttempt).toMatchObject({
            created     : false,
            notAuthority: true,
            status      : 'ineligible',
            task        : null,
            taskId      : null
        });

        // AC1: Popularity and tombstoned rows cannot be claimed.
        const starAttempt = await RequestContextService.run({
            agentIdentityNodeId: '@neo-gemini-maryam',
            userId             : SUBJECT
        }, () => ActivityService.claimTask({sourceEventId: starRow.occurrence_identity}));
        expect(starAttempt.status).toBe('ineligible');
        expect(starAttempt.taskId).toBeNull();

        const deletedAttempt = await RequestContextService.run({
            agentIdentityNodeId: '@neo-gemini-maryam',
            userId             : SUBJECT
        }, () => ActivityService.claimTask({sourceEventId: deletedRow.occurrence_identity}));
        expect(deletedAttempt.status).toBe('deleted');
        expect(deletedAttempt.taskId).toBeNull();

        // AC4: Every injected crash point rolls back binding, Nodes, Edges, and GraphLog atomically.
        for (const crashPoint of ['after-binding-insert', 'after-node-insert', 'after-edges-insert', 'before-commit']) {
            await expect(RequestContextService.run({
                agentIdentityNodeId: '@neo-gemini-maryam',
                userId             : SUBJECT
            }, () => ActivityService.claimTask({
                crashPoint,
                sourceEventId: item.sourceEventId
            }))).rejects.toThrow(/COMMUNITY_CLAIM_CRASH_/);

            expect(activityDb.prepare('SELECT COUNT(*) AS count FROM mc_community_task_binding').get().count, crashPoint).toBe(0);
            expect(activityDb.prepare("SELECT COUNT(*) AS count FROM Nodes WHERE json_extract(data, '$.label') = 'MESSAGE'").get().count, crashPoint).toBe(0);
            expect(activityDb.prepare('SELECT COUNT(*) AS count FROM Edges').get().count, crashPoint).toBe(0);
            expect(activityDb.prepare('SELECT COUNT(*) AS count FROM GraphLog').get().count, crashPoint).toBe(0);
        }

        // AC3 & AC5: Concurrent claim callers and retries after a lost response receive the same canonical Task.
        const [firstClaim, concurrentClaim] = await Promise.all([
            RequestContextService.run({
                agentIdentityNodeId: '@neo-gemini-maryam',
                userId             : SUBJECT
            }, () => ActivityService.claimTask({sourceEventId: item.sourceEventId})),
            RequestContextService.run({
                agentIdentityNodeId: '@neo-gpt-euclid',
                userId             : SUBJECT
            }, () => ActivityService.claimTask({sourceEventId: item.sourceEventId}))
        ]);

        expect(firstClaim.status).toBe('claimed');
        expect(firstClaim.created).toBe(true);
        expect(firstClaim.notAuthority).toBe(false);
        expect(firstClaim.taskId).toMatch(/^MESSAGE:/);
        expect(firstClaim.claimedBy).toBe('@neo-gemini-maryam');
        expect(firstClaim.task).toEqual({
            assignee              : '@neo-gemini-maryam',
            id                    : firstClaim.taskId,
            occurrenceKind        : 'issue.comment',
            parentProviderEntityId: '19129',
            providerEntityId      : 'eligible-comment',
            sourceEventId         : item.sourceEventId,
            sourceInstanceId      : sourceId,
            state                 : 'Working'
        });

        expect(concurrentClaim).toEqual({
            ...firstClaim,
            created: false
        });

        const retryClaim = await RequestContextService.run({
            agentIdentityNodeId: '@neo-gemini-maryam',
            userId             : SUBJECT
        }, () => ActivityService.claimTask({sourceEventId: item.sourceEventId}));
        expect(retryClaim).toEqual({
            ...firstClaim,
            created: false
        });

        // AC2: Unique constraints prevent more than one taskId for one scoped sourceEventId or reusing a taskId.
        expect(() => activityDb.prepare(`
            INSERT INTO mc_community_task_binding (
                tenant_id, occurrence_identity, source_instance_id, task_id, claimed_by, claimed_at
            ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(SUBJECT, item.sourceEventId, sourceId, 'MESSAGE:duplicate-task', '@neo-opus-ada', '2026-09-19T12:20:00.000Z'))
            .toThrow(/UNIQUE constraint failed/);

        expect(() => activityDb.prepare(`
            INSERT INTO mc_community_task_binding (
                tenant_id, occurrence_identity, source_instance_id, task_id, claimed_by, claimed_at
            ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(SUBJECT, 'other-occurrence', sourceId, firstClaim.taskId, '@neo-opus-ada', '2026-09-19T12:20:00.000Z'))
            .toThrow(/UNIQUE constraint failed/);

        // Validate OpenAPI schema compliance for CommunityActivityClaimResponse.
        const openApiDoc = yaml.load(fs.readFileSync(
            path.resolve(process.cwd(), 'ai/mcp/server/memory-core/openapi.yaml'),
            'utf8'
        ));
        const ajv = new Ajv({allErrors: true, strict: false, validateFormats: false});
        for (const [name, schema] of Object.entries(openApiDoc.components.schemas)) {
            ajv.addSchema(schema, `#/components/schemas/${name}`);
        }
        const validateClaim = ajv.getSchema('#/components/schemas/CommunityActivityClaimResponse');
        expect(validateClaim(firstClaim), JSON.stringify(validateClaim.errors)).toBe(true);
        expect(validateClaim(unknownAttempt), JSON.stringify(validateClaim.errors)).toBe(true);

        // AC8 (post-claim): Only committed claimed Tasks can enter LifecycleFrontier predicates.
        const claimedTasks = await inTenant(() => ActivityService.listClaimedTasks({
            checkedAt: '2026-09-19T12:30:00.000Z'
        }));
        expect(claimedTasks).toHaveLength(1);
        expect(admitClaimedTask({
            actionableStates: new Set(['Working', 'InputRequired', 'AuthRequired']),
            agentId         : '@neo-gemini-maryam',
            task            : claimedTasks[0]
        })?.subjectId).toBe(firstClaim.taskId);

        // AC6: Existing MailboxService assignment/RBAC/state-transition rules take over after commit.
        await expect(RequestContextService.run({
            agentIdentityNodeId: '@neo-gpt-euclid',
            userId             : SUBJECT
        }, () => MailboxService.transitionTask({
            newState: 'Completed',
            taskId  : firstClaim.taskId
        }))).rejects.toThrow(/neither originator nor assignee/);

        // AC9: Cross-tenant transition attempts fail closed even when the Task node is in the GraphService cache.
        await expect(RequestContextService.run({
            agentIdentityNodeId: '@neo-gemini-maryam',
            userId             : 'other-tenant'
        }, () => MailboxService.transitionTask({
            newState: 'Completed',
            taskId  : firstClaim.taskId
        }))).rejects.toThrow(`Task not found: ${firstClaim.taskId}`);

        const transitioned = await RequestContextService.run({
            agentIdentityNodeId: '@neo-gemini-maryam',
            userId             : SUBJECT
        }, () => MailboxService.transitionTask({
            expectedCurrentState: 'Working',
            newState            : 'Completed',
            taskId              : firstClaim.taskId
        }));
        expect(transitioned.success).toBe(true);
        expect(transitioned.task.state).toBe('Completed');

        const reloadedClaim = await RequestContextService.run({
            agentIdentityNodeId: '@neo-gemini-maryam',
            userId             : SUBJECT
        }, () => ActivityService.claimTask({sourceEventId: item.sourceEventId}));
        expect(reloadedClaim.task.state).toBe('Completed');

        // AC9: Cross-tenant and revoked-source claim attempts fail closed.
        SourceRegistryService.localSubjectId = null;
        const crossTenantClaim = await RequestContextService.run({
            agentIdentityNodeId: '@neo-opus-ada',
            userId             : 'other-tenant'
        }, () => ActivityService.claimTask({sourceEventId: item.sourceEventId}));
        expect(crossTenantClaim).toMatchObject({
            created     : false,
            notAuthority: true,
            status      : 'ineligible',
            task        : null,
            taskId      : null
        });

        SourceRegistryService.localSubjectId = SUBJECT;
        SourceRegistryService.transitionLifecycle(sourceId, 'REVOKED', {
            expectedEpoch: 2,
            expectedState: 'ACTIVE'
        });

        const revokedClaim = await RequestContextService.run({
            agentIdentityNodeId: '@neo-gemini-maryam',
            userId             : SUBJECT
        }, () => ActivityService.claimTask({sourceEventId: item.sourceEventId}));
        expect(revokedClaim).toMatchObject({
            created         : false,
            notAuthority    : true,
            sourceInstanceId: sourceId,
            status          : 'inaccessible',
            task            : null,
            taskId          : null
        });
    });

    test('projects bounded tenant attention counts query-only per AC6, preserves watermark monotonicity past 56 sources, and isolates popularity noise from human signal (#101)', async () => {
        const {PROJECTION_CHANNEL_SLOTS} = await import(
            '../../../../../../ai/services/memory-core/hookProjectionLease.mjs'
        );

        const serviceSource = fs.readFileSync(
            path.resolve(process.cwd(), 'ai/services/memory-core/CommunityActivityService.mjs'),
            'utf8'
        );
        expect(serviceSource).not.toMatch(/from\s+['"]node:fs['"]|writeFileSync|renameSync/);
        expect(Object.keys(PROJECTION_CHANNEL_SLOTS)).toEqual(['lifecycle-frontier', 'computed-route']);

        const noSourceCounts = await inTenant(() => ActivityService.projectAttentionCounts());
        expect(noSourceCounts.status).toBe('missing');
        expect(noSourceCounts.count).toBe(0);
        expect(noSourceCounts.oldestOccurredAt).toBeNull();
        expect(noSourceCounts.notAuthority).toBe(true);
        expect(noSourceCounts.coverage.degraded).toBe(true);
        expect(noSourceCounts.coverage.degradedReasons).toContain('no-registered-sources');

        const sourceA = activeSource({
                  displayLocator      : 'neomjs/neo-a',
                  providerCapabilities: {issues: true, pullRequests: true},
                  providerResourceId  : 'neomjs/neo-a'
              }),
              sourceB = activeSource({
                  displayLocator      : 'neomjs/neo-b',
                  providerCapabilities: {issues: true, pullRequests: true},
                  providerResourceId  : 'neomjs/neo-b'
              });

        SourceRegistryService.localSubjectId = 'foreign-tenant';
        const foreignSource = activeSource({displayLocator: 'foreign/repo', providerResourceId: 'foreign/repo'});
        await RequestContextService.run({userId: 'foreign-tenant'}, () => AdmissionService.admitBatch(
            batchAt(foreignSource, [observation('foreign-1', '2026-09-19T01:00:00.000Z')])
        ));
        SourceRegistryService.localSubjectId = SUBJECT;

        await expect(inTenant(() => ActivityService.projectAttentionCounts({
            sourceInstanceIds: [foreignSource]
        }))).rejects.toThrow('COMMUNITY_SOURCE_NOT_OWNED');

        await expect(inTenant(() => ActivityService.projectAttentionCounts({
            sourceInstanceIds: ['']
        }))).rejects.toThrow('COMMUNITY_SOURCE_FILTER_INVALID');

        await expect(inTenant(() => ActivityService.projectAttentionCounts({
            sourceInstanceIds: []
        }))).rejects.toThrow('COMMUNITY_SOURCE_FILTER_INVALID');

        AdmissionService.attentionPolicy = {
            ...ATTENTION_POLICY,
            recordedActorDispositions: {'external-repeat-human': 'eligible'}
        };

        const noiseFlood = Array.from({length: 12}, (_, index) => observation(
            `noise-${index + 1}`,
            `2026-09-19T02:${String(index).padStart(2, '0')}:00.000Z`,
            {
                occurrenceKind: ['star.created', 'repo.forked', 'watch.started', 'issue.labeled'][index % 4]
            }
        ));

        const firstTimeHuman = observation('first-time-human-1', '2026-09-19T03:00:00.000Z', {
            actorId               : 'external-first-timer',
            occurrenceKind        : 'issue.comment',
            parentProviderEntityId: '20119',
            sourceAssociation     : 'FIRST_TIME_CONTRIBUTOR'
        });

        const repeatHuman = observation('repeat-human-1', '2026-09-19T04:00:00.000Z', {
            actorId               : 'external-repeat-human',
            occurrenceKind        : 'discussion.comment',
            parentProviderEntityId: '19835',
            sourceAssociation     : 'NONE'
        });

        const deletedHuman = observation('deleted-human-1', '2026-09-19T02:30:00.000Z', {
            absence          : 'deleted',
            deletionEvidence : {deletedAt: '2026-09-19T02:31:00.000Z', reason: 'user-deleted'},
            occurrenceKind   : 'issue.comment',
            sourceAssociation: 'NONE'
        });

        await inTenant(() => AdmissionService.admitBatch(
            batchAt(sourceA, [...noiseFlood, firstTimeHuman, repeatHuman, deletedHuman], {
                batchId       : 'batch-101-issues',
                resourceFamily: 'issues'
            })
        ));

        const degradedMissingFamilies = await inTenant(() => ActivityService.projectAttentionCounts({
            sourceInstanceIds: [sourceA]
        }));
        expect(degradedMissingFamilies.status).toBe('degraded');
        expect(degradedMissingFamilies.count).toBe(2);
        expect(degradedMissingFamilies.oldestOccurredAt).toBe('2026-09-19T03:00:00.000Z');
        expect(degradedMissingFamilies.coverage.degradedReasons).toContain('source-coverage-unknown');

        await inTenant(() => AdmissionService.admitBatch(
            batchAt(sourceA, [], {batchId: 'batch-101-pulls', resourceFamily: 'pulls'})
        ));
        await inTenant(() => AdmissionService.admitBatch(
            batchAt(sourceA, [], {batchId: 'batch-101-discussions', resourceFamily: 'discussions'})
        ));

        for (const resourceFamily of ['issues', 'pulls', 'discussions']) {
            await inTenant(() => AdmissionService.admitBatch(
                batchAt(sourceB, [], {batchId: `batch-101-b-${resourceFamily}`, resourceFamily})
            ));
        }

        const emptySourceB = await inTenant(() => ActivityService.projectAttentionCounts({
            sourceInstanceIds: [sourceB]
        }));
        expect(emptySourceB.status).toBe('empty');
        expect(emptySourceB.count).toBe(0);
        expect(emptySourceB.oldestOccurredAt).toBeNull();
        expect(emptySourceB.coverage.degraded).toBe(false);

        const freshSourceA = await inTenant(() => ActivityService.projectAttentionCounts({
            sourceInstanceIds: [sourceA]
        }));
        expect(freshSourceA.status).toBe('fresh');
        expect(freshSourceA.notAuthority).toBe(true);
        expect(freshSourceA.count).toBe(2);
        expect(freshSourceA.oldestOccurredAt).toBe('2026-09-19T03:00:00.000Z');
        expect(freshSourceA.coverage.degraded).toBe(false);
        expect(freshSourceA.measurement).toMatchObject({
            claimedExcludedCount     : 0,
            eligibleUnclaimedCount   : 2,
            ineligibleExcludedCount  : 13,
            totalAdmittedObservations: 15,
            attentionAmplification   : {
                numerator  : 2,
                denominator: 15,
                ratio      : 2 / 15
            }
        });
        expect(freshSourceA.measurement.payloadBytes).toBeGreaterThan(100);
        expect(freshSourceA.measurement.payloadBytes).toBeLessThan(8192);
        for (const counts of [freshSourceA, noSourceCounts, emptySourceB, degradedMissingFamilies]) {
            expect(counts.measurement.payloadBytes).toBe(Buffer.byteLength(JSON.stringify(counts), 'utf8'));
        }

        const serialized = JSON.stringify(freshSourceA);
        expect(serialized).not.toContain('external-first-timer');
        expect(serialized).not.toContain('external-repeat-human');
        expect(serialized).not.toContain('first-time-human-1');
        expect(freshSourceA).not.toHaveProperty('items');
        expect(freshSourceA).not.toHaveProperty('ranking');
        expect(freshSourceA).not.toHaveProperty('recommendedOwner');
        expect(freshSourceA).not.toHaveProperty('threshold');

        const openApiDoc = yaml.load(fs.readFileSync(
            path.resolve(process.cwd(), 'ai/mcp/server/memory-core/openapi.yaml'),
            'utf8'
        ));
        const ajv = new Ajv({allErrors: true, strict: false, validateFormats: false});
        for (const [name, schema] of Object.entries(openApiDoc.components.schemas)) {
            ajv.addSchema(schema, `#/components/schemas/${name}`);
        }
        const validateCounts = ajv.getSchema('#/components/schemas/CommunityActivityAttentionCountsResponse');
        expect(validateCounts(freshSourceA), JSON.stringify(validateCounts.errors)).toBe(true);
        expect(validateCounts(noSourceCounts), JSON.stringify(validateCounts.errors)).toBe(true);

        const page          = await inTenant(() => ActivityService.query({...WINDOW, limit: 10, sourceInstanceIds: [sourceA]}));
        const firstTimeItem = page.items.find(entry => entry.providerEntityId === 'first-time-human-1');
        expect(firstTimeItem).toBeDefined();

        await RequestContextService.run({
            agentIdentityNodeId: '@neo-gemini-maryam',
            userId             : SUBJECT
        }, () => ActivityService.markSeen({sourceEventId: firstTimeItem.sourceEventId}));

        const afterSeenCounts = await inTenant(() => ActivityService.projectAttentionCounts({
            sourceInstanceIds: [sourceA]
        }));
        expect(afterSeenCounts).toEqual(freshSourceA);

        await RequestContextService.run({
            agentIdentityNodeId: '@neo-gemini-maryam',
            userId             : SUBJECT
        }, () => ActivityService.claimTask({sourceEventId: firstTimeItem.sourceEventId}));

        const afterClaimCounts = await inTenant(() => ActivityService.projectAttentionCounts({
            sourceInstanceIds: [sourceA]
        }));
        expect(afterClaimCounts.count).toBe(1);
        expect(afterClaimCounts.oldestOccurredAt).toBe('2026-09-19T04:00:00.000Z');
        expect(afterClaimCounts.measurement.claimedExcludedCount).toBe(1);
        expect(afterClaimCounts.sourceWatermark > freshSourceA.sourceWatermark).toBe(true);

        const epochMs = Date.parse('2026-10-26T22:00:00.000Z');
        while (registryDb.prepare('SELECT COUNT(*) AS count FROM mc_source_registration WHERE tenant_id = ?').get(SUBJECT).count < 55) {
            const idx = registryDb.prepare('SELECT COUNT(*) AS count FROM mc_source_registration WHERE tenant_id = ?').get(SUBJECT).count + 1;
            activeSource({
                displayLocator    : `neomjs/scale-${idx}`,
                providerResourceId: `neomjs/scale-${idx}`
            });
        }
        registryDb.prepare('UPDATE mc_source_registration SET updated_at = ? WHERE tenant_id = ?').run(epochMs, SUBJECT);

        const countsAt55 = await inTenant(() => ActivityService.projectAttentionCounts());
        expect(countsAt55.coverage.sourceCount).toBe(55);
        expect(countsAt55.sourceWatermark).toMatch(/^seq:\d{16}:claims:\d{16}:reg:\d{16}:\d{16}$/);

        activeSource({
            displayLocator    : 'neomjs/scale-56',
            providerResourceId: 'neomjs/scale-56'
        });
        registryDb.prepare('UPDATE mc_source_registration SET updated_at = ? WHERE tenant_id = ?').run(epochMs, SUBJECT);

        const countsAt56 = await inTenant(() => ActivityService.projectAttentionCounts());
        expect(countsAt56.coverage.sourceCount).toBe(56);
        expect(countsAt56.sourceWatermark).toMatch(/^seq:\d{16}:claims:\d{16}:reg:\d{16}:\d{16}$/);
        expect(countsAt56.sourceWatermark > countsAt55.sourceWatermark).toBe(true);
    });
});

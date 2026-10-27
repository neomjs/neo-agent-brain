import {setup} from '../../../../setup.mjs';

setup({
    neoConfig: {unitTestMode: true},
    appConfig: {
        name             : 'CommunityAuthorityChainE2ETest',
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

import memoryCoreConfig                          from '../../../../../../ai/mcp/server/memory-core/config.template.mjs';
import RequestContextService                     from '../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';
import {createTransportVisibleToolFacade}        from '../../../../../../ai/mcp/server/memory-core/toolService.mjs';
import CommunityReconciliationService            from '../../../../../../ai/daemons/orchestrator/services/CommunityReconciliationService.mjs';
import GitHubCommunityContentService             from '../../../../../../ai/services/github-workflow/GitHubCommunityContentService.mjs';
import {issueToObservations}                     from '../../../../../../ai/services/github-workflow/community/githubIssueObservations.mjs';
import {pullRequestToObservations}               from '../../../../../../ai/services/github-workflow/community/githubPullRequestObservations.mjs';
import {discussionToObservations}                from '../../../../../../ai/services/github-workflow/community/githubDiscussionObservations.mjs';
import {admitClaimedTask, collectLifecycleItems} from '../../../../../../ai/services/graph/lifecycleAdmission.mjs';
import {isActionableComputedRecommendation}      from '../../../../../../ai/services/graph/computedGoldenPathRouting.mjs';
import {BATCH_SCHEMA_VERSION, validateBatch}     from '../../../../../../ai/services/memory-core/communityBatchContract.mjs';
import {snapshotAiConfig}                        from './util.mjs';

const TEST_NAMES = [
    'AC1: enforces strict multi-tenant and multi-source isolation across registration, admission, query, seen, claim, counts, and steward wake',
    'AC2: preserves sourceInstanceId across repository rename and grant rotation while fencing revoked and stale registration epochs',
    'AC3: converges without loss or duplicate history across crash before/after admission receipt and lost-response retry',
    'AC4: admits identical canonical batches and receipts across local direct and hosted authenticated MCP paths while rejecting forged authority',
    'AC5: proves coverage, explicit gaps, immutable revisions, tombstones, and uncertain vs deleted absence across Issue, PR/review, and Discussion fixtures',
    'AC6: keeps automatic rows, counts, and wakes prose-free while applying source-relative trust on explicit drill-down',
    'AC7: guarantees atomic rollback on fault injection and produces one sourceEventId-to-taskId binding and one canonical Task under concurrent claims',
    'AC8: excludes unclaimed community activity from LifecycleFrontier and prevents community history from entering Nodes, Edges, or GraphLog before claim',
    'AC9: keeps degraded sources visible across Bird View, attention counts, and steward wakes without normalizing to complete, empty, or fresh',
    'AC10: publishes a criterion-to-test matrix mapping OQ1-OQ10, the three STEP_BACK gates, and AC1-AC12 to executable tests in this suite',
    'AC11: filters popularity telemetry, bots, unreviewed actor kinds, and rostered activity in an end-to-end noise-flood fixture so only the external response-bearing item counts',
    'AC12: resolves existing external attention items on internal close/resolve or tombstone occurrences without minting a second attention item or Task while preserving post-close external replies'
];

test.describe.configure({mode: 'serial'});

test.describe('Community-activity end-to-end authority chain', () => {
    let ActivityService, AdmissionService, Database, GraphService, MailboxService, SourceRegistryService;
    let activityDb, admissionDb, registryDb, tempRoot, testDbPath;
    let originalActivityDb, originalAdmissionDb, originalAttentionPolicy, originalContentAdapter,
        originalGraphStorageDb, originalLocalSubjectId, originalRegistryDb;

    const
        TENANT_ALPHA = 'tenant-alpha',
        TENANT_BETA  = 'tenant-beta',
        WINDOW       = {
            windowEnd  : '2026-09-20T00:00:00.000Z',
            windowStart: '2026-09-19T00:00:00.000Z'
        },
        ATTENTION_POLICY = {
            recordedActorDispositions: {},
            responseBearingKinds     : [
                'issue.opened',
                'issue.comment',
                'pull_request.opened',
                'pull_request.comment',
                'pull_request.review-submitted',
                'pull_request.review-comment',
                'discussion.opened',
                'discussion.comment',
                'discussion.reply'
            ],
            rosteredActorIds: ['maintainer-alpha', 'maintainer-beta', 'steward-agent-1', 'steward-agent-2']
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
            adapterSchemaVersion      = 'github-issue.v1',
            baseCheckpointVersion     = 0,
            baseInventoryHash         = null,
            batchId                   = `batch-${Date.now()}-${Math.random()}`,
            coverage                  = {complete: true, fromBasis: 'c0', toBasis: 'c1'},
            nextInventoryHash         = `inv-${batchId}`,
            nextProviderState         = {cursor: batchId},
            providerStateSchemaVersion = 'github-state.v1',
            registrationEpoch         = 2,
            resourceFamily            = 'issues'
        } = {}) => ({
            adapterSchemaVersion,
            baseCheckpointVersion,
            baseInventoryHash,
            batchId,
            coverage,
            nextInventoryHash,
            nextProviderState,
            observations,
            providerStateSchemaVersion,
            registrationEpoch,
            resourceFamily,
            schemaVersion: BATCH_SCHEMA_VERSION,
            sourceInstanceId
        });

    function registerActiveSource(tenantId, repoSlug, overrides = {}) {
        const reg = SourceRegistryService.registerForTenant(tenantId, {
            canonicalProviderHost: 'github.com',
            displayLocator       : repoSlug,
            grantRef             : `grant:${tenantId}:${repoSlug}`,
            provider             : 'github',
            providerCapabilities : {discussions: true, issues: true, pullRequests: true},
            providerResourceId   : `repo:${repoSlug}`,
            resourceKind         : 'repository',
            ...overrides
        }, {actorId: `operator:${tenantId}`});

        SourceRegistryService.transitionLifecycleForTenant(tenantId, reg.sourceInstanceId, 'PROVISIONED', {
            actorId      : `operator:${tenantId}`,
            expectedEpoch: 1,
            expectedState: 'REQUESTED'
        });

        return SourceRegistryService.transitionLifecycleForTenant(tenantId, reg.sourceInstanceId, 'ACTIVE', {
            actorId      : `operator:${tenantId}`,
            expectedEpoch: 2,
            expectedState: 'PROVISIONED'
        })
    }

    async function inTenant(tenantId, fn, extraContext = {}) {
        return RequestContextService.run({userId: tenantId, ...extraContext}, fn)
    }

    async function admitAllFamilies(tenantId, sourceInstanceId, familyObservations = {}, registrationEpoch = 2) {
        const receipts = {};
        for (const family of ['issues', 'pulls', 'discussions']) {
            const obs = familyObservations[family] || [];
            receipts[family] = await inTenant(tenantId, () => AdmissionService.admitBatch(
                batchAt(sourceInstanceId, obs, {
                    batchId       : `seed-${sourceInstanceId}-${family}`,
                    registrationEpoch,
                    resourceFamily: family
                })
            ));
        }
        return receipts
    }

    test.beforeAll(async () => {
        Database              = (await import('better-sqlite3')).default;
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
        originalAdmissionDb     = AdmissionService.db;
        originalRegistryDb      = SourceRegistryService.db;
        originalGraphStorageDb  = GraphService.db?.storage?.db || null;
        originalLocalSubjectId  = SourceRegistryService.localSubjectId;
        originalAttentionPolicy = AdmissionService.attentionPolicy;
        originalContentAdapter  = ActivityService.contentAdapter;
    });

    test.beforeEach(async () => {
        tempRoot   = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'neo-community-e2e-'));
        testDbPath = path.join(tempRoot, 'memory-core.sqlite');

        registryDb  = new Database(testDbPath, {verbose: null});
        admissionDb = new Database(testDbPath, {verbose: null});
        activityDb  = new Database(testDbPath, {verbose: null});

        for (const db of [registryDb, admissionDb, activityDb]) {
            db.pragma('journal_mode = WAL');
            db.pragma('busy_timeout = 5000');
        }

        SourceRegistryService.set({db: registryDb, localSubjectId: null});
        AdmissionService.set({db: admissionDb, attentionPolicy: ATTENTION_POLICY});
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
    });

    test.afterEach(async () => {
        ActivityService.set({db: originalActivityDb, contentAdapter: originalContentAdapter});
        AdmissionService.set({db: originalAdmissionDb, attentionPolicy: originalAttentionPolicy});
        SourceRegistryService.set({db: originalRegistryDb, localSubjectId: originalLocalSubjectId});

        if (GraphService.db?.storage) {
            GraphService.db.storage.db = originalGraphStorageDb;
            GraphService.db.nodes.clear();
            GraphService.db.edges.clear();
            GraphService.db.adjacency?.clear?.();
        }

        activityDb.close();
        admissionDb.close();
        registryDb.close();
        await fs.promises.rm(tempRoot, {force: true, recursive: true});
    });

    test(TEST_NAMES[0], async () => {
        const alphaRepo1 = registerActiveSource(TENANT_ALPHA, 'acme-org/widgets'),
              alphaRepo2 = registerActiveSource(TENANT_ALPHA, 'acme-org/platform'),
              betaRepo1  = registerActiveSource(TENANT_BETA, 'acme-org/widgets');

        expect(alphaRepo1.sourceInstanceId).not.toBe(betaRepo1.sourceInstanceId);

        await admitAllFamilies(TENANT_ALPHA, alphaRepo1.sourceInstanceId, {
            issues: [observation('alpha-issue-1', '2026-09-19T10:00:00.000Z')]
        });
        await admitAllFamilies(TENANT_ALPHA, alphaRepo2.sourceInstanceId, {
            discussions: [observation('alpha-disc-1', '2026-09-19T11:00:00.000Z', {occurrenceKind: 'discussion.comment'})]
        });
        await admitAllFamilies(TENANT_BETA, betaRepo1.sourceInstanceId, {
            pulls: [observation('beta-pr-1', '2026-09-19T12:00:00.000Z', {occurrenceKind: 'pull_request.comment'})]
        });

        const alphaRegs = await inTenant(TENANT_ALPHA, () => SourceRegistryService.listRegistrations()),
              betaRegs  = await inTenant(TENANT_BETA, () => SourceRegistryService.listRegistrations());

        expect(alphaRegs.map(r => r.sourceInstanceId).sort()).toEqual(
            [alphaRepo1.sourceInstanceId, alphaRepo2.sourceInstanceId].sort()
        );
        expect(betaRegs.map(r => r.sourceInstanceId)).toEqual([betaRepo1.sourceInstanceId]);
        expect(await inTenant(TENANT_BETA, () => SourceRegistryService.getRegistration(alphaRepo1.sourceInstanceId))).toBeNull();

        const crossAdmit = await inTenant(TENANT_BETA, () => AdmissionService.admitBatch(
            batchAt(alphaRepo1.sourceInstanceId, [observation('forged', '2026-09-19T13:00:00.000Z')])
        ));
        expect(crossAdmit).toMatchObject({status: 'conflict', reason: 'REGISTRATION_NOT_ADMISSIBLE'});

        const alphaPage1 = await inTenant(TENANT_ALPHA, () => ActivityService.query({...WINDOW, limit: 1}), {
                  agentIdentityNodeId: '@steward-alpha'
              }),
              betaPage   = await inTenant(TENANT_BETA, () => ActivityService.query({...WINDOW, limit: 10}), {
                  agentIdentityNodeId: '@steward-beta'
              });

        expect(alphaPage1.coverage.totalResolved).toBe(2);
        expect(betaPage.items.map(i => i.providerEntityId)).toEqual(['beta-pr-1']);

        await expect(inTenant(TENANT_BETA, () => ActivityService.query({
            ...WINDOW,
            cursor: alphaPage1.nextCursor,
            limit : 1
        }))).rejects.toThrow(/COMMUNITY_CURSOR_(INVALID|SCOPE_MISMATCH)/);

        await expect(inTenant(TENANT_BETA, () => ActivityService.projectAttentionCounts({
            sourceInstanceIds: [alphaRepo1.sourceInstanceId]
        }))).rejects.toThrow('COMMUNITY_SOURCE_NOT_OWNED');

        const alphaEventId = alphaPage1.items[0].sourceEventId;

        const betaSeen = await inTenant(TENANT_BETA, () => ActivityService.markSeen({sourceEventId: alphaEventId}), {
                  agentIdentityNodeId: '@steward-beta'
              }),
              betaClaim = await inTenant(TENANT_BETA, () => ActivityService.claimTask({sourceEventId: alphaEventId}), {
                  agentIdentityNodeId: '@steward-beta'
              });

        expect(betaSeen.status).toBe('ineligible');
        expect(betaClaim.status).toBe('ineligible');
        expect(betaClaim.taskId).toBeNull();

        const alphaCounts = await inTenant(TENANT_ALPHA, () => ActivityService.projectAttentionCounts()),
              betaCounts  = await inTenant(TENANT_BETA, () => ActivityService.projectAttentionCounts());

        expect(alphaCounts).toMatchObject({status: 'fresh', count: 2});
        expect(betaCounts).toMatchObject({status: 'fresh', count: 1});

        const restoreLeaseTtl = snapshotAiConfig(memoryCoreConfig, {
            'communityStewardWake.stewardLeaseTtlMs': 1_590_000
        });

        try {
            const alphaLease = await inTenant(TENANT_ALPHA, () => ActivityService.acquireStewardLease({
                      holderPrincipal: 'steward:tenant-alpha:seat-1',
                      now            : 1000
                  })),
                  betaWakeWithAlphaProof = await inTenant(TENANT_BETA, () => ActivityService.evaluateStewardWake({
                      holderProof: {
                          fencingEpoch: alphaLease.fencingEpoch,
                          token       : alphaLease.token
                      },
                      now: 1000
                  }));

            expect(alphaLease.acquired).toBe(true);
            expect(betaWakeWithAlphaProof).toMatchObject({
                reason    : 'lease-not-held',
                shouldWake: false
            });
        } finally {
            restoreLeaseTtl()
        }
    });

    test(TEST_NAMES[1], async () => {
        const initial = registerActiveSource(TENANT_ALPHA, 'acme-org/legacy-name');

        await inTenant(TENANT_ALPHA, () => AdmissionService.admitBatch(
            batchAt(initial.sourceInstanceId, [observation('pre-rename', '2026-09-19T10:00:00.000Z')], {
                batchId: 'b-initial'
            })
        ));

        const renamedAndRotated = SourceRegistryService.registerForTenant(TENANT_ALPHA, {
            canonicalProviderHost: 'github.com',
            displayLocator       : 'acme-org/renamed-repo',
            grantRef             : 'grant:rotated-v2',
            provider             : 'github',
            providerResourceId   : 'repo:acme-org/legacy-name',
            resourceKind         : 'repository'
        }, {actorId: `operator:${TENANT_ALPHA}`});

        expect(renamedAndRotated.sourceInstanceId).toBe(initial.sourceInstanceId);
        expect(renamedAndRotated.displayLocator).toBe('acme-org/renamed-repo');
        expect(renamedAndRotated.grantRef).toBe('grant:rotated-v2');
        expect(renamedAndRotated.lifecycleState).toBe('ACTIVE');
        expect(renamedAndRotated.registrationEpoch).toBe(2);

        SourceRegistryService.transitionLifecycleForTenant(TENANT_ALPHA, initial.sourceInstanceId, 'REVOKED', {
            actorId      : `operator:${TENANT_ALPHA}`,
            expectedEpoch: 2,
            expectedState: 'ACTIVE'
        });

        const revokedWrite = await inTenant(TENANT_ALPHA, () => AdmissionService.admitBatch(
            batchAt(initial.sourceInstanceId, [observation('revoked-attempt', '2026-09-19T10:05:00.000Z')], {
                batchId              : 'b-revoked',
                baseCheckpointVersion: 1,
                baseInventoryHash    : 'inv-b-initial',
                registrationEpoch    : 2
            })
        ));
        expect(revokedWrite).toMatchObject({status: 'conflict', reason: 'REGISTRATION_NOT_ADMISSIBLE'});

        SourceRegistryService.transitionLifecycleForTenant(TENANT_ALPHA, initial.sourceInstanceId, 'PROVISIONED', {
            actorId      : `operator:${TENANT_ALPHA}`,
            expectedEpoch: 2,
            expectedState: 'REVOKED'
        });
        const reactivated = SourceRegistryService.transitionLifecycleForTenant(TENANT_ALPHA, initial.sourceInstanceId, 'ACTIVE', {
            actorId      : `operator:${TENANT_ALPHA}`,
            expectedEpoch: 3,
            expectedState: 'PROVISIONED'
        });
        expect(reactivated.registrationEpoch).toBe(3);
        expect(reactivated.sourceInstanceId).toBe(initial.sourceInstanceId);

        const staleEpochWrite = await inTenant(TENANT_ALPHA, () => AdmissionService.admitBatch(
            batchAt(initial.sourceInstanceId, [observation('stale-epoch', '2026-09-19T10:10:00.000Z')], {
                batchId              : 'b-stale-epoch',
                baseCheckpointVersion: 1,
                baseInventoryHash    : 'inv-b-initial',
                registrationEpoch    : 2
            })
        ));
        expect(staleEpochWrite).toMatchObject({status: 'conflict', reason: 'REGISTRATION_NOT_ADMISSIBLE'});

        const freshEpochWrite = await inTenant(TENANT_ALPHA, () => AdmissionService.admitBatch(
            batchAt(initial.sourceInstanceId, [observation('post-reprovision', '2026-09-19T10:15:00.000Z')], {
                batchId              : 'b-epoch-3',
                baseCheckpointVersion: 1,
                baseInventoryHash    : 'inv-b-initial',
                registrationEpoch    : 3
            })
        ));
        expect(freshEpochWrite.status).toBe('accepted');
        expect(freshEpochWrite.checkpoint.checkpointVersion).toBe(2);
    });

    test(TEST_NAMES[2], async () => {
        const source               = registerActiveSource(TENANT_ALPHA, 'acme-org/widgets');
        let   crashBeforeAdmission = true,
              loseResponseAfterCommit = true;
        const batchIds = ['batch-run-1', 'batch-run-2'];

        const faultInjectedAdmission = {
            getCheckpoint   : (...args) => AdmissionService.getCheckpoint(...args),
            getReceipt      : (...args) => AdmissionService.getReceipt(...args),
            listObservations: (...args) => AdmissionService.listObservations(...args),
            admitBatch(batchPayload) {
                if (crashBeforeAdmission) {
                    crashBeforeAdmission = false;
                    throw new Error('simulated crash before admission transaction')
                }
                const committed = AdmissionService.admitBatch(batchPayload);
                if (loseResponseAfterCommit) {
                    loseResponseAfterCommit = false;
                    throw new Error('simulated lost response after SQLite commit')
                }
                return committed
            }
        };

        const reconciler = {
            reconcile: async ({admissionService, batchId, resourceFamily, sourceInstanceId}) => {
                const cp = admissionService.getCheckpoint(sourceInstanceId, resourceFamily);
                return admissionService.admitBatch(batchAt(sourceInstanceId, [
                    observation('crash-safe-1', '2026-09-19T10:00:00.000Z'),
                    observation('crash-safe-2', '2026-09-19T10:05:00.000Z')
                ], {
                    baseCheckpointVersion: cp?.checkpointVersion ?? 0,
                    baseInventoryHash    : cp?.inventoryHash ?? null,
                    batchId,
                    registrationEpoch    : source.registrationEpoch,
                    resourceFamily
                }))
            }
        };

        await inTenant(TENANT_ALPHA, async () => {
            const firstRun = await CommunityReconciliationService.runOnce({
                admissionService    : faultInjectedAdmission,
                maxAdmissionAttempts: 3,
                reconcilers         : {issues: reconciler},
                registryService     : SourceRegistryService,
                uuid                : () => batchIds.shift()
            });

            const issueOutcome = firstRun.results.find(r => r.resourceFamily === 'issues');
            expect(issueOutcome).toMatchObject({
                attempts         : 3,
                checkpointVersion: 1,
                status           : 'idempotent'
            });

            expect(AdmissionService.listObservations(source.sourceInstanceId)).toHaveLength(2);
            expect(admissionDb.prepare('SELECT COUNT(*) AS c FROM mc_community_batch_receipt').get().c).toBe(1);

            const secondRun = await CommunityReconciliationService.runOnce({
                admissionService    : AdmissionService,
                maxAdmissionAttempts: 1,
                reconcilers         : {issues: reconciler},
                registryService     : SourceRegistryService,
                uuid                : () => batchIds.shift()
            });

            expect(secondRun.results.find(r => r.resourceFamily === 'issues')).toMatchObject({
                attempts         : 1,
                checkpointVersion: 2,
                status           : 'accepted'
            });
            expect(AdmissionService.listObservations(source.sourceInstanceId)).toHaveLength(2);
        });
    });

    test(TEST_NAMES[3], async () => {
        const source       = registerActiveSource(TENANT_ALPHA, 'acme-org/widgets'),
              hostedFacade = createTransportVisibleToolFacade({resolveTransport: () => 'streamable-http'}),
              stdioFacade  = createTransportVisibleToolFacade({resolveTransport: () => 'stdio'}),
              canonical    = batchAt(source.sourceInstanceId, [
                  observation('parity-1', '2026-09-19T10:00:00.000Z'),
                  observation('parity-2', '2026-09-19T10:05:00.000Z')
              ], {batchId: 'parity-batch-1'});

        const localResult = await inTenant(TENANT_ALPHA, () => AdmissionService.admitBatch(canonical));
        expect(localResult.status).toBe('accepted');

        const {registrationEpoch, sourceInstanceId, ...authorityFreeBatch} = canonical;
        const hostedEnvelope                                               = {
            batch : authorityFreeBatch,
            source: {
                canonicalProviderHost: 'github.com',
                providerResourceId   : 'repo:acme-org/widgets',
                resourceKind         : 'repository'
            }
        };

        const hostedResult = await inTenant(TENANT_ALPHA, () =>
            hostedFacade.callTool('admit_community_batch', hostedEnvelope)
        );

        expect(hostedResult.status).toBe('idempotent');
        expect(hostedResult.digest).toBe(localResult.digest);
        expect(hostedResult.receipt.receiptId).toBe(localResult.receipt.receiptId);
        expect(hostedResult.health).toMatchObject({
            code             : 'COMMUNITY_SOURCE_READY',
            ready            : true,
            registrationEpoch: 2,
            sourceInstanceId : source.sourceInstanceId
        });

        await expect(stdioFacade.callTool('admit_community_batch', hostedEnvelope)).rejects.toThrow(/streamable-http/);

        const wrongTenantHosted = await inTenant(TENANT_BETA, () =>
            hostedFacade.callTool('admit_community_batch', hostedEnvelope)
        );
        expect(wrongTenantHosted).toMatchObject({
            code  : 'COMMUNITY_SOURCE_NOT_FOUND',
            reason: 'REGISTRATION_NOT_ADMISSIBLE',
            status: 'conflict'
        });

        const forgedHosted = {
            ...hostedEnvelope,
            batch: {...authorityFreeBatch, registrationEpoch: 2}
        };
        const forgedResult = await inTenant(TENANT_ALPHA, () =>
            hostedFacade.callTool('admit_community_batch', forgedHosted)
        );
        expect(forgedResult).toMatchObject({
            code  : 'COMMUNITY_BATCH_ENVELOPE_INVALID',
            status: 'conflict'
        });
    });

    test(TEST_NAMES[4], async () => {
        const source = registerActiveSource(TENANT_ALPHA, 'acme-org/widgets');

        const issueObs = issueToObservations({
            author           : {__typename: 'User', login: 'external-issue-author'},
            authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
            comments         : [{
                author           : {__typename: 'User', login: 'external-commenter'},
                authorAssociation: 'NONE',
                createdAt        : '2026-09-19T10:10:00.000Z',
                id               : 'IC_10',
                lastEditedAt     : '2026-09-19T10:15:00.000Z'
            }],
            createdAt: '2026-09-19T10:00:00.000Z',
            id       : 'I_10',
            timeline : [{
                __typename: 'LabeledEvent',
                actor     : {__typename: 'User', login: 'maintainer-alpha'},
                createdAt : '2026-09-19T10:12:00.000Z',
                id        : 'LE_10'
            }]
        });

        const prObs = pullRequestToObservations({
            author           : {__typename: 'User', login: 'external-pr-author'},
            authorAssociation: 'CONTRIBUTOR',
            comments         : [],
            contentEdits     : [{
                editedAt: '2026-09-19T11:05:00.000Z',
                editor  : {__typename: 'User', login: 'external-pr-author'},
                id      : 'UCE_PR_1'
            }],
            createdAt     : '2026-09-19T11:00:00.000Z',
            id            : 'PR_20',
            lastEditedAt  : '2026-09-19T11:05:00.000Z',
            reviewComments: [],
            reviews       : [{
                author           : {__typename: 'User', login: 'external-reviewer'},
                authorAssociation: 'NONE',
                contentEdits     : [],
                createdAt        : '2026-09-19T11:10:00.000Z',
                id               : 'PRR_20',
                state            : 'DISMISSED',
                submittedAt      : '2026-09-19T11:10:00.000Z'
            }],
            timeline: [{
                __typename         : 'ReviewDismissedEvent',
                actor              : {__typename: 'User', login: 'maintainer-beta'},
                createdAt          : '2026-09-19T11:20:00.000Z',
                id                 : 'RDE_20',
                previousReviewState: 'CHANGES_REQUESTED',
                review             : {id: 'PRR_20'}
            }]
        });

        const discussionObs = discussionToObservations({
            author           : {__typename: 'User', login: 'external-disc-author'},
            authorAssociation: 'NONE',
            comments         : [{
                author           : {__typename: 'User', login: 'external-disc-commenter'},
                authorAssociation: 'NONE',
                contentEdits     : [],
                createdAt        : '2026-09-19T12:10:00.000Z',
                deletedAt        : '2026-09-19T12:20:00.000Z',
                id               : 'DC_30',
                replies          : [{
                    author           : {__typename: 'User', login: 'external-disc-replier'},
                    authorAssociation: 'NONE',
                    contentEdits     : [{
                        editedAt: '2026-09-19T12:16:00.000Z',
                        editor  : {__typename: 'User', login: 'external-disc-replier'},
                        id      : 'UCE_DR_30'
                    }],
                    createdAt   : '2026-09-19T12:15:00.000Z',
                    id          : 'DR_30',
                    lastEditedAt: '2026-09-19T12:16:00.000Z'
                }]
            }],
             contentEdits: [],
            createdAt: '2026-09-19T12:00:00.000Z',
            id       : 'D_30'
        });

        expect((await inTenant(TENANT_ALPHA, () => AdmissionService.admitBatch(
            batchAt(source.sourceInstanceId, issueObs, {batchId: 'b-issues', resourceFamily: 'issues'})
        ))).status).toBe('accepted');

        expect((await inTenant(TENANT_ALPHA, () => AdmissionService.admitBatch(
            batchAt(source.sourceInstanceId, prObs, {
                batchId       : 'b-pulls',
                coverage      : {complete: false, fromBasis: 'p0', gaps: [{axis: 'review-comments', reason: 'rate-limited'}], toBasis: 'p1'},
                resourceFamily: 'pulls'
            })
        ))).status).toBe('accepted');

        expect((await inTenant(TENANT_ALPHA, () => AdmissionService.admitBatch(
            batchAt(source.sourceInstanceId, discussionObs, {batchId: 'b-discussions', resourceFamily: 'discussions'})
        ))).status).toBe('accepted');

        const replyHistory = await inTenant(TENANT_ALPHA, () =>
            AdmissionService.listObservations(source.sourceInstanceId, {providerEntityId: 'DR_30'})
        );
        expect(replyHistory.map(r => r.occurrenceKind)).toEqual(['discussion.reply', 'discussion.reply-edited']);
        expect(replyHistory[1].revisionOf).toBe('DR_30:created');

        const page = await inTenant(TENANT_ALPHA, () => ActivityService.query({...WINDOW, limit: 25}));
        expect(page.coverage.degraded).toBe(true);
        expect(page.coverage.degradedReasons).toContain('source-coverage-incomplete');

        const deletedCommentItem = page.items.find(i => i.providerEntityId === 'DC_30'),
              liveReplyItem      = page.items.find(i => i.providerEntityId === 'DR_30');

        let adapterCalls = 0;
        ActivityService.contentAdapter = {
            read: async () => {
                adapterCalls++;
                throw new Error('provider network timeout')
            }
        };

        const deletedRead   = await inTenant(TENANT_ALPHA, () => ActivityService.getContent({sourceEventId: deletedCommentItem.sourceEventId})),
              uncertainRead = await inTenant(TENANT_ALPHA, () => ActivityService.getContent({sourceEventId: liveReplyItem.sourceEventId}));

        expect(deletedRead).toMatchObject({notAuthority: true, status: 'deleted'});
        expect(uncertainRead).toMatchObject({notAuthority: true, status: 'unknown'});
        expect(adapterCalls).toBe(1);
    });

    test(TEST_NAMES[5], async () => {
        const repoMember   = registerActiveSource(TENANT_ALPHA, 'acme-org/member-repo'),
              repoExternal = registerActiveSource(TENANT_ALPHA, 'acme-org/external-repo');

        const proseBatchValidation = validateBatch(batchAt(repoMember.sourceInstanceId, [
            observation('prose-attempt', '2026-09-19T10:00:00.000Z', {
                body : 'untrusted body text',
                title: 'untrusted title'
            })
        ]));
        expect(proseBatchValidation.valid).toBe(false);
        expect(proseBatchValidation.errors).toEqual(expect.arrayContaining([
            'OBSERVATION_0_CARRIES_PROSE_BODY',
            'OBSERVATION_0_CARRIES_PROSE_TITLE'
        ]));

        await admitAllFamilies(TENANT_ALPHA, repoMember.sourceInstanceId, {
            issues: [observation('IC_MEMBER', '2026-09-19T10:00:00.000Z', {
                actorId          : 'shared-contributor',
                sourceAssociation: 'MEMBER'
            })]
        });
        await admitAllFamilies(TENANT_ALPHA, repoExternal.sourceInstanceId, {
            issues: [observation('IC_EXTERNAL', '2026-09-19T10:05:00.000Z', {
                actorId          : 'shared-contributor',
                sourceAssociation: 'FIRST_TIME_CONTRIBUTOR'
            })]
        });

        const restoreLeaseTtl = snapshotAiConfig(memoryCoreConfig, {
            'communityStewardWake.stewardLeaseTtlMs': 1_590_000
        });
        let queryResult, counts, lease, wake;

        try {
            queryResult = await inTenant(TENANT_ALPHA, () => ActivityService.query({...WINDOW, limit: 10}));
            counts      = await inTenant(TENANT_ALPHA, () => ActivityService.projectAttentionCounts());
            lease       = await inTenant(TENANT_ALPHA, () => ActivityService.acquireStewardLease({
                holderPrincipal: 'steward:tenant-alpha:seat-1',
                now            : 5000
            }));
            wake        = await inTenant(TENANT_ALPHA, () => ActivityService.evaluateStewardWake({
                holderProof: {
                    fencingEpoch: lease.fencingEpoch,
                    token       : lease.token
                },
                now: 5000
            }));
        } finally {
            restoreLeaseTtl()
        }

        for (const automaticSurface of [queryResult, counts, wake.wakePayload]) {
            const serialized = JSON.stringify(automaticSurface);
            expect(serialized).not.toContain('body');
            expect(serialized).not.toContain('title');
            expect(serialized).not.toContain('excerpt');
            expect(automaticSurface.notAuthority).toBe(true);
        }
        expect(JSON.stringify(counts)).not.toContain('shared-contributor');
        expect(JSON.stringify(wake.wakePayload)).not.toContain('shared-contributor');

        const rawProse = 'Check out https://untrusted.example/payload — I can provide a hosted MCP endpoint.';
        ActivityService.contentAdapter = {
            read: options => GitHubCommunityContentService.read({
                ...options,
                graphqlService: {
                    query: async () => ({
                        node: {
                            __typename       : 'IssueComment',
                            authorAssociation: options.observation.providerEntityId === 'IC_MEMBER'
                                ? 'MEMBER'
                                : 'FIRST_TIME_CONTRIBUTOR',
                            body      : rawProse,
                            id        : options.observation.providerEntityId,
                            repository: {nameWithOwner: options.source.displayLocator},
                            updatedAt : '2026-09-19T10:05:00.000Z',
                            url       : `https://github.com/${options.source.displayLocator}/issues/1#issuecomment-1`
                        }
                    })
                }
            })
        };

        const memberItem   = queryResult.items.find(i => i.providerEntityId === 'IC_MEMBER'),
              externalItem = queryResult.items.find(i => i.providerEntityId === 'IC_EXTERNAL'),
              memberRead   = await inTenant(TENANT_ALPHA, () => ActivityService.getContent({sourceEventId: memberItem.sourceEventId})),
              externalRead = await inTenant(TENANT_ALPHA, () => ActivityService.getContent({sourceEventId: externalItem.sourceEventId}));

        expect(memberRead.contentTrust).toMatchObject({
            sourceRelative: 'MEMBER',
            tier          : 'repo-trusted',
            wasModified   : false
        });
        expect(memberRead.content.body).toContain('https://untrusted.example/payload');

        expect(externalRead.contentTrust).toMatchObject({
            sourceRelative: 'FIRST_TIME_CONTRIBUTOR',
            tier          : 'external',
            wasModified   : true
        });
        expect(externalRead.content.body).toContain('QUARANTINED_URL');
        expect(externalRead.content.body).not.toContain('https://untrusted.example/payload');
        expect(externalRead.contentTrust.signals).toEqual(expect.arrayContaining([
            expect.objectContaining({id: 'external-endpoint-offer'})
        ]));

        const storedObsJson = JSON.stringify(activityDb.prepare('SELECT * FROM mc_community_observation').all());
        expect(storedObsJson).not.toContain('hosted MCP endpoint');
        expect(storedObsJson).not.toContain('untrusted.example');
    });

    test(TEST_NAMES[6], async () => {
        const source = registerActiveSource(TENANT_ALPHA, 'acme-org/widgets');
        await admitAllFamilies(TENANT_ALPHA, source.sourceInstanceId, {
            issues: [observation('claim-target-1', '2026-09-19T10:00:00.000Z', {parentProviderEntityId: 'I_500'})]
        });

        const page          = await inTenant(TENANT_ALPHA, () => ActivityService.query({...WINDOW, limit: 10})),
              sourceEventId = page.items[0].sourceEventId;

        for (const crashPoint of ['after-binding-insert', 'after-node-insert', 'after-edges-insert', 'before-commit']) {
            await expect(inTenant(TENANT_ALPHA, () => ActivityService.claimTask({
                crashPoint,
                sourceEventId
            }), {agentIdentityNodeId: '@steward-alpha'})).rejects.toThrow(/COMMUNITY_CLAIM_CRASH_/);

            expect(activityDb.prepare('SELECT COUNT(*) AS c FROM mc_community_task_binding').get().c).toBe(0);
            expect(activityDb.prepare("SELECT COUNT(*) AS c FROM Nodes WHERE json_extract(data, '$.label') = 'MESSAGE'").get().c).toBe(0);
            expect(activityDb.prepare('SELECT COUNT(*) AS c FROM Edges').get().c).toBe(0);
            expect(activityDb.prepare('SELECT COUNT(*) AS c FROM GraphLog').get().c).toBe(0);
        }

        const [claimA, claimB] = await Promise.all([
            inTenant(TENANT_ALPHA, () => ActivityService.claimTask({sourceEventId}), {
                agentIdentityNodeId: '@steward-alpha'
            }),
            inTenant(TENANT_ALPHA, () => ActivityService.claimTask({sourceEventId}), {
                agentIdentityNodeId: '@steward-gamma'
            })
        ]);

        expect(claimA.status).toBe('claimed');
        expect(claimA.created).toBe(true);
        expect(claimA.notAuthority).toBe(false);
        expect(claimA.taskId).toMatch(/^MESSAGE:/);
        expect(claimB).toEqual({...claimA, created: false});

        expect(activityDb.prepare('SELECT COUNT(*) AS c FROM mc_community_task_binding').get().c).toBe(1);
        expect(activityDb.prepare("SELECT COUNT(*) AS c FROM Nodes WHERE json_extract(data, '$.label') = 'MESSAGE'").get().c).toBe(1);

        await expect(inTenant(TENANT_ALPHA, () => MailboxService.transitionTask({
            newState: 'Completed',
            taskId  : claimA.taskId
        }), {agentIdentityNodeId: '@steward-gamma'})).rejects.toThrow(/neither originator nor assignee/);

        const completed = await inTenant(TENANT_ALPHA, () => MailboxService.transitionTask({
            expectedCurrentState: 'Working',
            newState            : 'Completed',
            taskId              : claimA.taskId
        }), {agentIdentityNodeId: '@steward-alpha'});

        expect(completed.success).toBe(true);
        expect(completed.task.state).toBe('Completed');
    });

    test(TEST_NAMES[7], async () => {
        const source = registerActiveSource(TENANT_ALPHA, 'acme-org/widgets');
        await admitAllFamilies(TENANT_ALPHA, source.sourceInstanceId, {
            issues: [observation('frontier-event-1', '2026-09-19T10:00:00.000Z')]
        });

        const page = await inTenant(TENANT_ALPHA, () => ActivityService.query({...WINDOW, limit: 10}), {
            agentIdentityNodeId: '@steward-alpha'
        });
        await inTenant(TENANT_ALPHA, () => ActivityService.markSeen({sourceEventId: page.items[0].sourceEventId}), {
            agentIdentityNodeId: '@steward-alpha'
        });
        await inTenant(TENANT_ALPHA, () => ActivityService.projectAttentionCounts());

        expect(activityDb.prepare('SELECT COUNT(*) AS c FROM Nodes').get().c).toBe(0);
        expect(activityDb.prepare('SELECT COUNT(*) AS c FROM Edges').get().c).toBe(0);
        expect(activityDb.prepare('SELECT COUNT(*) AS c FROM GraphLog').get().c).toBe(0);

        const unclaimedTasks = await inTenant(TENANT_ALPHA, () => ActivityService.listClaimedTasks());
        expect(unclaimedTasks).toEqual([]);
        expect(collectLifecycleItems({agentId: '@steward-alpha', tasks: unclaimedTasks})).toEqual([]);
        expect(admitClaimedTask({agentId: '@steward-alpha', task: page.items[0]})).toBeNull();
        expect(isActionableComputedRecommendation({
            action       : 'community_observation',
            notAuthority : true,
            sourceEventId: page.items[0].sourceEventId
        })).toBe(false);

        const claimed = await inTenant(TENANT_ALPHA, () => ActivityService.claimTask({
            sourceEventId: page.items[0].sourceEventId
        }), {agentIdentityNodeId: '@steward-alpha'});

        const claimedTasks = await inTenant(TENANT_ALPHA, () => ActivityService.listClaimedTasks({
            checkedAt: '2026-09-19T12:00:00.000Z'
        }));
        expect(claimedTasks).toHaveLength(1);
        expect(admitClaimedTask({
            actionableStates: new Set(['Working', 'InputRequired', 'AuthRequired']),
            agentId         : '@steward-alpha',
            task            : claimedTasks[0]
        })?.subjectId).toBe(claimed.taskId);
    });

    test(TEST_NAMES[8], async () => {
        const partialSource     = registerActiveSource(TENANT_ALPHA, 'acme-org/partial-repo'),
              unsupportedSource = registerActiveSource(TENANT_ALPHA, 'acme-org/gitlab-repo', {
                  canonicalProviderHost: 'gitlab.com',
                  provider             : 'gitlab'
              });

        await inTenant(TENANT_ALPHA, () => AdmissionService.admitBatch(
            batchAt(partialSource.sourceInstanceId, [], {
                batchId       : 'partial-issues-only',
                coverage      : {complete: false, fromBasis: 'a', gaps: [{axis: 'timeline', reason: 'timeout'}], toBasis: 'b'},
                resourceFamily: 'issues'
            })
        ));

        const page         = await inTenant(TENANT_ALPHA, () => ActivityService.query({...WINDOW, limit: 10})),
              counts       = await inTenant(TENANT_ALPHA, () => ActivityService.projectAttentionCounts()),
              degradedWake = await inTenant(TENANT_ALPHA, () => ActivityService.evaluateStewardWake({now: 5000}));

        expect(page.coverage.degraded).toBe(true);
        expect(counts.status).toBe('degraded');
        expect(counts.count).toBe(0);
        expect(counts.coverage.degraded).toBe(true);
        expect(degradedWake).toMatchObject({
            coverageStatus: 'degraded',
            reason        : 'coverage-degraded',
            shouldWake    : false
        });
        expect(counts.coverage.degradedReasons).toEqual(expect.arrayContaining([
            'source-coverage-incomplete',
            'source-coverage-unknown',
            'source-unsupported'
        ]));

        const unsupportedEntry = counts.sources.find(s => s.sourceInstanceId === unsupportedSource.sourceInstanceId);
        expect(unsupportedEntry.degraded).toBe(true);
        expect(unsupportedEntry.degradedReasons).toContain('source-unsupported');
    });

    test(TEST_NAMES[9], () => {
        const matrixPath = path.resolve(
            process.cwd(),
            'learn/agentos/measurements/community-authority-chain-criteria-matrix.md'
        );
        expect(fs.existsSync(matrixPath)).toBe(true);

        const content = fs.readFileSync(matrixPath, 'utf8');

        for (let oq = 1; oq <= 10; oq++) {
            expect(content).toContain(`| OQ${oq} |`);
        }
        for (let sb = 1; sb <= 3; sb++) {
            expect(content).toContain(`| STEP_BACK-${sb} |`);
        }
        for (let ac = 1; ac <= 12; ac++) {
            expect(content).toContain(`| AC${ac} |`);
        }
        for (const testName of TEST_NAMES) {
            expect(content).toContain(testName);
        }
    });

    test(TEST_NAMES[10], async () => {
        const source = registerActiveSource(TENANT_ALPHA, 'acme-org/widgets');

        for (const popularityKind of [
            'repository.starred',
            'repository.unstarred',
            'repository.forked',
            'repository.watched',
            'repository.unwatched'
        ]) {
            const res = await inTenant(TENANT_ALPHA, () => AdmissionService.admitBatch(
                batchAt(source.sourceInstanceId, [
                    observation(`pop-${popularityKind}`, '2026-09-19T09:00:00.000Z', {occurrenceKind: popularityKind})
                ])
            ));
            expect(res.status).toBe('conflict');
            expect(res.errors).toContain('OBSERVATION_0_POPULARITY_TELEMETRY_OUT_OF_SCOPE');
        }

        const noiseAndSignal = [
            observation('rostered-open', '2026-09-19T10:00:00.000Z', {
                actorId       : 'maintainer-alpha',
                occurrenceKind: 'issue.opened'
            }),
            observation('rostered-comment', '2026-09-19T10:01:00.000Z', {
                actorId       : 'steward-agent-1',
                occurrenceKind: 'issue.comment'
            }),
            observation('bot-comment', '2026-09-19T10:02:00.000Z', {
                actorId       : 'github-actions[bot]',
                actorKind     : 'bot',
                occurrenceKind: 'issue.comment'
            }),
            observation('org-actor', '2026-09-19T10:03:00.000Z', {
                actorId       : 'acme-org',
                actorKind     : 'organization',
                occurrenceKind: 'issue.comment'
            }),
            observation('unknown-actor', '2026-09-19T10:04:00.000Z', {
                actorId       : null,
                actorKind     : 'unknown',
                occurrenceKind: 'issue.comment'
            }),
            observation('non-response-label', '2026-09-19T10:05:00.000Z', {
                actorId       : 'external-labeler',
                occurrenceKind: 'issue.labeled'
            }),
            observation('real-external-signal', '2026-09-19T10:06:00.000Z', {
                actorId          : 'external-contributor-1',
                occurrenceKind   : 'issue.comment',
                sourceAssociation: 'FIRST_TIME_CONTRIBUTOR'
            })
        ];

        await admitAllFamilies(TENANT_ALPHA, source.sourceInstanceId, {issues: noiseAndSignal});

        const page   = await inTenant(TENANT_ALPHA, () => ActivityService.query({...WINDOW, limit: 20})),
              counts = await inTenant(TENANT_ALPHA, () => ActivityService.projectAttentionCounts());

        expect(page.items.map(i => i.providerEntityId)).toEqual(['real-external-signal']);
        expect(counts.status).toBe('fresh');
        expect(counts.count).toBe(1);
        expect(counts.measurement).toMatchObject({
            claimedExcludedCount     : 0,
            eligibleUnclaimedCount   : 1,
            ineligibleExcludedCount  : 6,
            totalAdmittedObservations: 7
        });
    });

    test(TEST_NAMES[11], async () => {
        const source = registerActiveSource(TENANT_ALPHA, 'acme-org/widgets');

        const baseIssue = {
            author           : {__typename: 'User', login: 'external-issue-opener'},
            authorAssociation: 'NONE',
            comments         : [{
                author           : {__typename: 'User', login: 'external-issue-commenter'},
                authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
                createdAt        : '2026-09-19T10:05:00.000Z',
                id               : 'IC_900_1'
            }],
            createdAt: '2026-09-19T10:00:00.000Z',
            id       : 'I_900',
            timeline : []
        };

        const baseDiscussion = {
            author           : {__typename: 'User', login: 'external-disc-opener'},
            authorAssociation: 'NONE',
            comments         : [{
                author           : {__typename: 'User', login: 'external-disc-commenter'},
                authorAssociation: 'CONTRIBUTOR',
                contentEdits     : [],
                createdAt        : '2026-09-19T10:15:00.000Z',
                id               : 'DC_900_1',
                replies          : [{
                    author           : {__typename: 'User', login: 'external-disc-replier'},
                    authorAssociation: 'NONE',
                    contentEdits     : [],
                    createdAt        : '2026-09-19T10:20:00.000Z',
                    id               : 'DR_900_1'
                }]
            }],
            contentEdits: [],
            createdAt   : '2026-09-19T10:10:00.000Z',
            id          : 'D_900'
        };

        const basePr = {
            author           : {__typename: 'User', login: 'external-pr-opener'},
            authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
            comments         : [],
            contentEdits     : [],
            createdAt        : '2026-09-19T10:25:00.000Z',
            id               : 'PR_900',
            reviewComments   : [],
            reviews          : [{
                author           : {__typename: 'User', login: 'external-pr-reviewer'},
                authorAssociation: 'NONE',
                contentEdits     : [],
                createdAt        : '2026-09-19T10:30:00.000Z',
                id               : 'PRR_900_1',
                state            : 'COMMENTED',
                submittedAt      : '2026-09-19T10:30:00.000Z'
            }],
            timeline: []
        };

        const firstBatch = await admitAllFamilies(TENANT_ALPHA, source.sourceInstanceId, {
            discussions: discussionToObservations(baseDiscussion),
            issues     : issueToObservations(baseIssue),
            pulls      : pullRequestToObservations(basePr)
        });

        const initialCounts = await inTenant(TENANT_ALPHA, () => ActivityService.projectAttentionCounts()),
              initialPage   = await inTenant(TENANT_ALPHA, () => ActivityService.query({...WINDOW, limit: 20}));

        // 2 issue items (I_900, IC_900_1) + 3 discussion items (D_900, DC_900_1, DR_900_1) + 2 PR items (PR_900, PRR_900_1) = 7
        expect(initialCounts).toMatchObject({count: 7, status: 'fresh'});

        // Claim I_900 before close so we can prove post-close claim replay returns the existing binding
        const issueOpenItem = initialPage.items.find(i => i.providerEntityId === 'I_900'),
              initialClaim  = await inTenant(TENANT_ALPHA, () => ActivityService.claimTask({
                  sourceEventId: issueOpenItem.sourceEventId
              }), {agentIdentityNodeId: '@steward-alpha'});

        expect(initialClaim).toMatchObject({created: true, status: 'claimed'});

        const afterClaimCounts = await inTenant(TENANT_ALPHA, () => ActivityService.projectAttentionCounts());
        expect(afterClaimCounts).toMatchObject({count: 6, status: 'fresh'});

        // A bot close does NOT resolve the issue's external comment
        const botCloseReceipt = await inTenant(TENANT_ALPHA, () => AdmissionService.admitBatch(
            batchAt(source.sourceInstanceId, issueToObservations({
                ...baseIssue,
                timeline: [{
                    __typename: 'ClosedEvent',
                    actor     : {__typename: 'Bot', login: 'stale-bot[bot]'},
                    createdAt : '2026-09-19T10:45:00.000Z',
                    id        : 'CE_900_BOT'
                }]
            }), {
                baseCheckpointVersion: firstBatch.issues.receipt.nextCheckpointVersion,
                baseInventoryHash    : firstBatch.issues.receipt.nextInventoryHash,
                batchId              : 'b-bot-close-issue',
                resourceFamily       : 'issues'
            })
        ));
        expect(botCloseReceipt.status).toBe('accepted');

        const afterBotCloseCounts = await inTenant(TENANT_ALPHA, () => ActivityService.projectAttentionCounts());
        expect(afterBotCloseCounts).toMatchObject({count: 6, status: 'fresh'});

        // Rostered Issue/PR closes resolve their items; reconciled Discussion closure (fetched closed + closedAt only) emits an unknown closer and stays counted
        const issueCloseReceipt = await inTenant(TENANT_ALPHA, () => AdmissionService.admitBatch(
            batchAt(source.sourceInstanceId, issueToObservations({
                ...baseIssue,
                timeline: [{
                    __typename: 'ClosedEvent',
                    actor     : {__typename: 'User', login: 'steward-agent-1'},
                    createdAt : '2026-09-19T11:00:00.000Z',
                    id        : 'CE_900_ROSTERED'
                }]
            }), {
                baseCheckpointVersion: botCloseReceipt.receipt.nextCheckpointVersion,
                baseInventoryHash    : botCloseReceipt.receipt.nextInventoryHash,
                batchId              : 'b-rostered-close-issue',
                resourceFamily       : 'issues'
            })
        ));
        expect(issueCloseReceipt.status).toBe('accepted');

        const discussionCloseReceipt = await inTenant(TENANT_ALPHA, () => AdmissionService.admitBatch(
            batchAt(source.sourceInstanceId, discussionToObservations({
                ...baseDiscussion,
                closed   : true,
                closedAt : '2026-09-19T11:05:00.000Z',
                updatedAt: '2026-09-19T11:05:00.000Z'
            }), {
                baseCheckpointVersion: firstBatch.discussions.receipt.nextCheckpointVersion,
                baseInventoryHash    : firstBatch.discussions.receipt.nextInventoryHash,
                batchId              : 'b-reconciled-close-discussion',
                resourceFamily       : 'discussions'
            })
        ));
        expect(discussionCloseReceipt.status).toBe('accepted');

        const prCloseReceipt = await inTenant(TENANT_ALPHA, () => AdmissionService.admitBatch(
            batchAt(source.sourceInstanceId, pullRequestToObservations({
                ...basePr,
                timeline: [{
                    __typename: 'ClosedEvent',
                    actor     : {__typename: 'User', login: 'steward-agent-1'},
                    createdAt : '2026-09-19T11:10:00.000Z',
                    id        : 'PRCE_900_ROSTERED'
                }]
            }), {
                baseCheckpointVersion: firstBatch.pulls.receipt.nextCheckpointVersion,
                baseInventoryHash    : firstBatch.pulls.receipt.nextInventoryHash,
                batchId              : 'b-rostered-close-pr',
                resourceFamily       : 'pulls'
            })
        ));
        expect(prCloseReceipt.status).toBe('accepted');

        const storedDiscussionClose = activityDb.prepare(
            "SELECT actor_id, actor_kind, source_association FROM mc_community_observation WHERE occurrence_kind = 'discussion.closed'"
        ).get();
        expect(storedDiscussionClose).toEqual({
            actor_id          : null,
            actor_kind        : 'unknown',
            source_association: null
        });

        const afterCloseCounts = await inTenant(TENANT_ALPHA, () => ActivityService.projectAttentionCounts()),
              afterClosePage   = await inTenant(TENANT_ALPHA, () => ActivityService.query({...WINDOW, limit: 20}));

        // Issue and PR external items resolved to 0; Discussion's 3 items (D_900, DC_900_1, DR_900_1) stay counted because closer is unknown
        expect(afterCloseCounts).toMatchObject({
            count           : 3,
            oldestOccurredAt: '2026-09-19T10:10:00.000Z',
            status          : 'fresh'
        });
        expect(afterClosePage.items.some(i => i.occurrenceKind.endsWith('.closed'))).toBe(false);
        expect(activityDb.prepare('SELECT COUNT(*) AS c FROM mc_community_task_binding').get().c).toBe(1);
        expect(activityDb.prepare("SELECT COUNT(*) AS c FROM Nodes WHERE json_extract(data, '$.label') = 'MESSAGE'").get().c).toBe(1);

        // Replaying claimTask after the entity closes returns the existing binding with 1 binding row
        const replayedClaim = await inTenant(TENANT_ALPHA, () => ActivityService.claimTask({
            sourceEventId: issueOpenItem.sourceEventId
        }), {agentIdentityNodeId: '@steward-beta'});

        expect(replayedClaim).toEqual({...initialClaim, created: false});
        expect(activityDb.prepare('SELECT COUNT(*) AS c FROM mc_community_task_binding').get().c).toBe(1);

        // Post-close external comment on the closed issue still surfaces as fresh attention (+1 -> count 4)
        const postCloseReplyReceipt = await inTenant(TENANT_ALPHA, () => AdmissionService.admitBatch(
            batchAt(source.sourceInstanceId, issueToObservations({
                ...baseIssue,
                comments: [
                    ...baseIssue.comments,
                    {
                        author           : {__typename: 'User', login: 'external-followup'},
                        authorAssociation: 'NONE',
                        createdAt        : '2026-09-19T12:00:00.000Z',
                        id               : 'IC_900_POST_CLOSE'
                    }
                ],
                timeline: [{
                    __typename: 'ClosedEvent',
                    actor     : {__typename: 'User', login: 'steward-agent-1'},
                    createdAt : '2026-09-19T11:00:00.000Z',
                    id        : 'CE_900_ROSTERED'
                }]
            }), {
                baseCheckpointVersion: issueCloseReceipt.receipt.nextCheckpointVersion,
                baseInventoryHash    : issueCloseReceipt.receipt.nextInventoryHash,
                batchId              : 'b-post-close-reply',
                resourceFamily       : 'issues'
            })
        ));
        expect(postCloseReplyReceipt.status).toBe('accepted');

        const postCloseCounts = await inTenant(TENANT_ALPHA, () => ActivityService.projectAttentionCounts());
        expect(postCloseCounts).toMatchObject({
            count           : 4,
            oldestOccurredAt: '2026-09-19T10:10:00.000Z',
            status          : 'fresh'
        });

        // Reopening the closed Issue via issueToObservations restores its pre-close unclaimed comment (+1 -> count 5)
        const issueReopenReceipt = await inTenant(TENANT_ALPHA, () => AdmissionService.admitBatch(
            batchAt(source.sourceInstanceId, issueToObservations({
                ...baseIssue,
                comments: [
                    ...baseIssue.comments,
                    {
                        author           : {__typename: 'User', login: 'external-followup'},
                        authorAssociation: 'NONE',
                        createdAt        : '2026-09-19T12:00:00.000Z',
                        id               : 'IC_900_POST_CLOSE'
                    }
                ],
                timeline: [
                    {
                        __typename: 'ClosedEvent',
                        actor     : {__typename: 'User', login: 'steward-agent-1'},
                        createdAt : '2026-09-19T11:00:00.000Z',
                        id        : 'CE_900_ROSTERED'
                    },
                    {
                        __typename: 'ReopenedEvent',
                        actor     : {__typename: 'User', login: 'steward-agent-1'},
                        createdAt : '2026-09-19T12:30:00.000Z',
                        id        : 'RE_900_ROSTERED'
                    }
                ]
            }), {
                baseCheckpointVersion: postCloseReplyReceipt.receipt.nextCheckpointVersion,
                baseInventoryHash    : postCloseReplyReceipt.receipt.nextInventoryHash,
                batchId              : 'b-reopen-issue',
                resourceFamily       : 'issues'
            })
        ));
        expect(issueReopenReceipt.status).toBe('accepted');

        const afterReopenCounts = await inTenant(TENANT_ALPHA, () => ActivityService.projectAttentionCounts());
        expect(afterReopenCounts).toMatchObject({
            count           : 5,
            oldestOccurredAt: '2026-09-19T10:05:00.000Z',
            status          : 'fresh'
        });
    });
});

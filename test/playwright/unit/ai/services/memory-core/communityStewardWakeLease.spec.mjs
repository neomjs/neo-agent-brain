import {setup} from '../../../../setup.mjs';

const appName = 'CommunityStewardWakeLeaseTest';

setup({
    neoConfig: {
        allowVnodeSimple: true,
        unitTestMode    : true,
        useDomApi       : false
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}                 from '@playwright/test';
import fs                             from 'node:fs';
import os                             from 'node:os';
import path                           from 'node:path';
import Database                       from 'better-sqlite3';
import Neo                            from 'neo.mjs/src/Neo.mjs';
import * as core                      from 'neo.mjs/src/core/_export.mjs';
import memoryCoreConfig               from '../../../../../../ai/mcp/server/memory-core/config.template.mjs';
import CommunityActivityService       from '../../../../../../ai/services/memory-core/CommunityActivityService.mjs';
import CommunityBatchAdmissionService from '../../../../../../ai/services/memory-core/CommunityBatchAdmissionService.mjs';
import GraphService                   from '../../../../../../ai/services/memory-core/GraphService.mjs';
import MailboxService                 from '../../../../../../ai/services/memory-core/MailboxService.mjs';
import SourceRegistryService          from '../../../../../../ai/services/memory-core/SourceRegistryService.mjs';
import RequestContextService          from '../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';
import {
    CALIBRATED_STEWARD_WAKE_POLICY,
    CALIBRATED_STEWARD_WAKE_REPORT_ID,
    COMMUNITY_STEWARD_WAKE_SCHEMA_VERSION,
    REQUIRED_LIVE_STEWARD_THRESHOLD_KEYS,
    acquireStewardWakeLease,
    assertCountOnlyWakePayload,
    releaseStewardWakeLease,
    resolveValidatedStewardWakePolicy,
    validateTenantScopedPrincipal
} from '../../../../../../ai/services/memory-core/communityStewardWakeLease.mjs';

const ATTENTION_POLICY = {
    recordedActorDispositions: {},
    responseBearingKinds     : ['issue.comment', 'discussion.comment', 'pull_request.comment'],
    rosteredActorIds         : []
};

const TEST_MEASURED_LIVE_POLICY = Object.freeze({
    maxWakePayloadBytes      : 1_024,
    minUnclaimedEligibleCount: 1,
    stewardActivation        : true,
    stewardLeaseTtlMs        : 1_590_000,
    vacancyFallbackCooldownMs: 795_000,
    wakeAmplificationCap     : 1,
    wakeCoalesceWindowMs     : 397_500
});

function makeObservation(providerEntityId, occurredAt, over = {}) {
    return {
        actorId             : `external-${providerEntityId}`,
        actorKind           : 'user',
        occurredAt,
        occurrenceCoordinate: `${providerEntityId}:created`,
        occurrenceKind      : 'issue.comment',
        providerEntityId,
        sourceAssociation   : 'NONE',
        ...over
    }
}

function batchAt(sourceInstanceId, observations, {
    baseCheckpointVersion = 0,
    baseInventoryHash     = null,
    batchId               = `batch-${Date.now()}-${Math.random()}`,
    coverage              = {complete: true, fromBasis: 'from', toBasis: 'to'},
    nextInventoryHash     = `inventory-${batchId}`,
    registrationEpoch     = 2,
    resourceFamily        = 'issues'
} = {}) {
    return {
        adapterSchemaVersion      : 'github-issue.v1',
        baseCheckpointVersion,
        baseInventoryHash,
        batchId,
        coverage,
        nextInventoryHash,
        nextProviderState         : {cursor: batchId},
        observations,
        providerStateSchemaVersion: 'github-issue-state.v1',
        registrationEpoch,
        resourceFamily,
        schemaVersion             : 'community-activity-batch.v1',
        sourceInstanceId
    }
}

function registerActiveGitHubSource(tenantId, owner, repo) {
    const prevSubject = SourceRegistryService.localSubjectId;
    SourceRegistryService.localSubjectId = tenantId;

    try {
        return RequestContextService.run({userId: tenantId}, () => {
            const {sourceInstanceId} = SourceRegistryService.register({
                canonicalProviderHost: 'github.com',
                displayLocator       : `${owner}/${repo}`,
                provider             : 'github',
                providerResourceId   : `${owner}/${repo}`,
                resourceKind         : 'repository'
            });
            SourceRegistryService.transitionLifecycle(sourceInstanceId, 'PROVISIONED', {
                expectedEpoch: 1,
                expectedState: 'REQUESTED'
            });
            return SourceRegistryService.transitionLifecycle(sourceInstanceId, 'ACTIVE', {
                expectedEpoch: 2,
                expectedState: 'PROVISIONED'
            })
        })
    } finally {
        SourceRegistryService.localSubjectId = prevSubject
    }
}

function admitCompleteBaseline(tenantId, sourceInstanceId, issueObservations) {
    const prevSubject = SourceRegistryService.localSubjectId;
    SourceRegistryService.localSubjectId = tenantId;

    try {
        return RequestContextService.run({userId: tenantId}, () => {
            CommunityBatchAdmissionService.admitBatch(batchAt(sourceInstanceId, issueObservations, {
                batchId       : `${sourceInstanceId}-issues-1`,
                resourceFamily: 'issues'
            }));
            CommunityBatchAdmissionService.admitBatch(batchAt(sourceInstanceId, [], {
                batchId       : `${sourceInstanceId}-pulls-1`,
                resourceFamily: 'pulls'
            }));
            CommunityBatchAdmissionService.admitBatch(batchAt(sourceInstanceId, [], {
                batchId       : `${sourceInstanceId}-discussions-1`,
                resourceFamily: 'discussions'
            }))
        })
    } finally {
        SourceRegistryService.localSubjectId = prevSubject
    }
}

async function inTenant(tenantId, callback) {
    const prevSubject = SourceRegistryService.localSubjectId;
    SourceRegistryService.localSubjectId = tenantId;

    try {
        return await RequestContextService.run({
            agentIdentityNodeId: 'AGENT:@fixture-steward-1',
            principalClass     : 'agent',
            userId             : tenantId
        }, callback)
    } finally {
        SourceRegistryService.localSubjectId = prevSubject
    }
}

test.describe('communityStewardWakeLease', () => {
    let db,
        originalActivityDb,
        originalAdmissionDb,
        originalAttentionPolicy,
        originalGraphStorageDb,
        originalLocalSubjectId,
        originalRegistryDb,
        tmpDir;

    test.beforeEach(async () => {
        await Promise.all([
            CommunityActivityService.ready(),
            CommunityBatchAdmissionService.ready(),
            SourceRegistryService.ready(),
            GraphService.ready(),
            MailboxService.ready()
        ]);

        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-steward-wake-lease-'));
        db     = new Database(path.join(tmpDir, 'steward-wake.sqlite'));

        originalActivityDb      = CommunityActivityService.db;
        originalAdmissionDb     = CommunityBatchAdmissionService.db;
        originalRegistryDb      = SourceRegistryService.db;
        originalLocalSubjectId  = SourceRegistryService.localSubjectId;
        originalAttentionPolicy = CommunityBatchAdmissionService.attentionPolicy;
        originalGraphStorageDb  = GraphService.db?.storage?.db || null;

        CommunityActivityService.db                    = db;
        CommunityBatchAdmissionService.db              = db;
        SourceRegistryService.db                       = db;
        CommunityBatchAdmissionService.attentionPolicy = ATTENTION_POLICY;

        SourceRegistryService.ensureSchema();
        CommunityBatchAdmissionService.ensureSchema();
        CommunityActivityService.ensureSchema();

        if (GraphService.db?.storage) {
            GraphService.db.storage.db = db;
            GraphService.db.nodes.clear();
            GraphService.db.edges.clear();
            GraphService.db.adjacency?.clear?.()
        }
    });

    test.afterEach(() => {
        CommunityActivityService.db                    = originalActivityDb;
        CommunityBatchAdmissionService.db              = originalAdmissionDb;
        SourceRegistryService.db                       = originalRegistryDb;
        SourceRegistryService.localSubjectId           = originalLocalSubjectId;
        CommunityBatchAdmissionService.attentionPolicy = originalAttentionPolicy;

        if (GraphService.db?.storage) {
            GraphService.db.storage.db = originalGraphStorageDb;
            GraphService.db.nodes.clear();
            GraphService.db.edges.clear();
            GraphService.db.adjacency?.clear?.()
        }

        if (db) db.close();
        if (tmpDir) fs.rmSync(tmpDir, {force: true, recursive: true})
    });

    test('keeps AiConfig and calibrated thresholds unset by default in shadow mode and requires all numeric leaves for live activation', () => {
        expect(memoryCoreConfig.communityStewardWake).toEqual({
            maxWakePayloadBytes      : null,
            minUnclaimedEligibleCount: null,
            stewardActivation        : false,
            stewardLeaseTtlMs        : null,
            vacancyFallbackCooldownMs: null,
            wakeAmplificationCap     : null,
            wakeCoalesceWindowMs     : null
        });

        expect(CALIBRATED_STEWARD_WAKE_POLICY).toEqual({
            calibrationReportId       : CALIBRATED_STEWARD_WAKE_REPORT_ID,
            disposition               : 'shadow-only steward experiment authorized; activation thresholds unset until its window',
            maxWakePayloadBytes       : null,
            minUnclaimedEligibleCount : null,
            mode                      : 'shadow',
            shadowExperimentAuthorized: true,
            stewardActivation         : false,
            stewardLeaseTtlMs         : null,
            vacancyFallbackCooldownMs : null,
            wakeAmplificationCap      : null,
            wakeCoalesceWindowMs      : null
        });

        const defaultResolved = resolveValidatedStewardWakePolicy();
        expect(defaultResolved.mode).toBe('shadow');
        expect(defaultResolved.stewardActivation).toBe(false);

        expect(() => resolveValidatedStewardWakePolicy({shadowExperimentAuthorized: false}))
            .toThrow('COMMUNITY_STEWARD_WAKE_NOT_AUTHORIZED');
        expect(() => resolveValidatedStewardWakePolicy({calibrationReportId: 'untrusted-report'}))
            .toThrow('COMMUNITY_STEWARD_WAKE_NOT_AUTHORIZED');

        for (const key of REQUIRED_LIVE_STEWARD_THRESHOLD_KEYS) {
            expect(() => resolveValidatedStewardWakePolicy({
                ...TEST_MEASURED_LIVE_POLICY,
                [key]: null
            })).toThrow(`COMMUNITY_STEWARD_POLICY_THRESHOLD_UNSET:${key}`);

            expect(() => resolveValidatedStewardWakePolicy({
                ...TEST_MEASURED_LIVE_POLICY,
                [key]: 0
            })).toThrow(`COMMUNITY_STEWARD_POLICY_INVALID:${key}`);
        }

        const liveResolved = resolveValidatedStewardWakePolicy(TEST_MEASURED_LIVE_POLICY);
        expect(liveResolved.mode).toBe('live');
        expect(liveResolved.stewardActivation).toBe(true);
    });

    test('rejects all-resident broadcasts, global Neo maintainer roster handles, and cross-tenant principals', () => {
        expect(() => validateTenantScopedPrincipal('AGENT:*', 'tenant-alpha'))
            .toThrow('COMMUNITY_STEWARD_ALL_RESIDENT_BROADCAST_FORBIDDEN');
        expect(() => validateTenantScopedPrincipal('*', 'tenant-alpha'))
            .toThrow('COMMUNITY_STEWARD_ALL_RESIDENT_BROADCAST_FORBIDDEN');
        expect(() => validateTenantScopedPrincipal({broadcast: true, principalId: 'steward-1'}, 'tenant-alpha'))
            .toThrow('COMMUNITY_STEWARD_ALL_RESIDENT_BROADCAST_FORBIDDEN');
        expect(() => validateTenantScopedPrincipal('@neo-opus-grace', 'tenant-alpha'))
            .toThrow('COMMUNITY_STEWARD_GLOBAL_ROSTER_FORBIDDEN');
        expect(() => validateTenantScopedPrincipal('@neo-gemini-maryam', 'tenant-alpha'))
            .toThrow('COMMUNITY_STEWARD_GLOBAL_ROSTER_FORBIDDEN');
        expect(() => validateTenantScopedPrincipal({principalId: 'seat-1', scope: 'global-roster'}, 'tenant-alpha'))
            .toThrow('COMMUNITY_STEWARD_GLOBAL_ROSTER_FORBIDDEN');
        expect(() => validateTenantScopedPrincipal({principalId: 'steward-beta', tenantId: 'tenant-beta'}, 'tenant-alpha'))
            .toThrow('COMMUNITY_STEWARD_CROSS_TENANT_FORBIDDEN');

        expect(validateTenantScopedPrincipal(
            {principalId: 'steward:tenant-alpha:primary', tenantId: 'tenant-alpha'},
            'tenant-alpha'
        )).toEqual({
            principalId: 'steward:tenant-alpha:primary',
            tenantId   : 'tenant-alpha'
        });
    });

    test('runs in shadow mode by default: records steward vacancy and would-be coalesced count-only wakes while sending none', async () => {
        const srcAlpha = registerActiveGitHubSource('tenant-alpha', 'org-a', 'repo-a');
        const t0       = Date.parse('2026-10-26T22:00:00.000Z');

        admitCompleteBaseline('tenant-alpha', srcAlpha.sourceInstanceId, [
            makeObservation('comment:shadow-1', '2026-10-26T12:01:00.000Z'),
            makeObservation('comment:shadow-2', '2026-10-26T12:02:00.000Z')
        ]);

        await inTenant('tenant-alpha', async () => {
            const shadowVacantNoTarget = await CommunityActivityService.evaluateStewardWake({
                now: t0
            });
            expect(shadowVacantNoTarget).toMatchObject({
                mode           : 'shadow',
                notAuthority   : true,
                reason         : 'steward-vacant-no-fallback-target',
                shadowWouldWake: false,
                shouldWake     : false,
                stewardVacant  : true
            });

            const shadowVacancyObservation = await CommunityActivityService.evaluateStewardWake({
                now                  : t0 + 5_000,
                vacancyFallbackTarget: {
                    principalId: 'steward:tenant-alpha:oncall-fallback',
                    tenantId   : 'tenant-alpha'
                }
            });
            expect(shadowVacancyObservation).toMatchObject({
                mode           : 'shadow',
                notAuthority   : true,
                reason         : 'shadow-vacancy-would-wake',
                routingMode    : 'vacancy-fallback',
                shadowWouldWake: true,
                shouldWake     : false,
                stewardVacant  : true
            });
            expect(shadowVacancyObservation.wakePayload).toMatchObject({
                calibrationReportId: CALIBRATED_STEWARD_WAKE_REPORT_ID,
                count              : 2,
                coverageStatus     : 'fresh',
                mode               : 'shadow',
                notAuthority       : true,
                oldestOccurredAt   : '2026-10-26T12:01:00.000Z',
                routingMode        : 'vacancy-fallback',
                schemaVersion      : COMMUNITY_STEWARD_WAKE_SCHEMA_VERSION,
                sourceCount        : 1,
                targetPrincipalId  : 'steward:tenant-alpha:oncall-fallback',
                tenantId           : 'tenant-alpha'
            });

            const stateRow = db.prepare(
                'SELECT vacancy_count, shadow_would_wake_count, max_shadow_payload_bytes FROM mc_community_steward_wake_state WHERE lease_scope_key = ?'
            ).get(shadowVacancyObservation.leaseScopeKey);

            expect(stateRow).toMatchObject({
                shadow_would_wake_count: 1,
                vacancy_count          : 2
            });
            expect(stateRow.max_shadow_payload_bytes).toBe(shadowVacancyObservation.payloadBytes);
        });
    });

    test('manages lease acquisition, contention, expiry reclaim, release, and stale-holder rejection', async () => {
        const srcAlpha = registerActiveGitHubSource('tenant-alpha', 'org-a', 'repo-a');
        const srcBeta  = registerActiveGitHubSource('tenant-beta', 'org-b', 'repo-b');
        const t0       = Date.parse('2026-10-26T22:00:00.000Z');
        const ttlMs    = TEST_MEASURED_LIVE_POLICY.stewardLeaseTtlMs;

        expect(() => acquireStewardWakeLease({
            db,
            holderPrincipal  : 'steward:tenant-alpha:seat-1',
            now              : t0,
            sourceInstanceIds: [srcAlpha.sourceInstanceId],
            tenantId         : 'tenant-alpha'
        })).toThrow('COMMUNITY_STEWARD_POLICY_THRESHOLD_UNSET:stewardLeaseTtlMs');

        expect(() => acquireStewardWakeLease({
            db,
            holderPrincipal  : 'steward:tenant-alpha:seat-1',
            leaseTtlMs       : ttlMs,
            now              : t0,
            sourceInstanceIds: [srcBeta.sourceInstanceId],
            tenantId         : 'tenant-alpha'
        })).toThrow('COMMUNITY_SOURCE_NOT_OWNED');

        const firstLease = acquireStewardWakeLease({
            db,
            holderPrincipal  : 'steward:tenant-alpha:seat-1',
            leaseTtlMs       : ttlMs,
            now              : t0,
            sourceInstanceIds: [srcAlpha.sourceInstanceId],
            tenantId         : 'tenant-alpha'
        });

        expect(firstLease).toMatchObject({
            acquired         : true,
            contention       : false,
            expiresAt        : t0 + ttlMs,
            fencingEpoch     : 1,
            holderPrincipalId: 'steward:tenant-alpha:seat-1',
            notAuthority     : true,
            reclaimed        : false,
            state            : 'held',
            tenantId         : 'tenant-alpha'
        });
        expect(typeof firstLease.token).toBe('string');

        const rawRow = db.prepare('SELECT holder_token_hash FROM mc_community_steward_lease WHERE lease_scope_key = ?')
            .get(firstLease.leaseScopeKey);
        expect(rawRow.holder_token_hash).not.toBe(firstLease.token);

        const contended = acquireStewardWakeLease({
            db,
            holderPrincipal  : 'steward:tenant-alpha:seat-2',
            leaseTtlMs       : ttlMs,
            now              : t0 + 60_000,
            sourceInstanceIds: [srcAlpha.sourceInstanceId],
            tenantId         : 'tenant-alpha'
        });

        expect(contended).toMatchObject({
            acquired         : false,
            contention       : true,
            fencingEpoch     : 1,
            holderPrincipalId: 'steward:tenant-alpha:seat-1',
            retryAfterMs     : ttlMs - 60_000,
            state            : 'held'
        });
        expect(contended.token).toBeUndefined();

        const reclaimed = acquireStewardWakeLease({
            db,
            holderPrincipal  : 'steward:tenant-alpha:seat-2',
            leaseTtlMs       : ttlMs,
            now              : t0 + ttlMs,
            sourceInstanceIds: [srcAlpha.sourceInstanceId],
            tenantId         : 'tenant-alpha'
        });

        expect(reclaimed).toMatchObject({
            acquired         : true,
            contention       : false,
            fencingEpoch     : 2,
            holderPrincipalId: 'steward:tenant-alpha:seat-2',
            reclaimed        : true,
            state            : 'held'
        });

        const staleRelease = releaseStewardWakeLease({
            db,
            fencingEpoch     : firstLease.fencingEpoch,
            sourceInstanceIds: [srcAlpha.sourceInstanceId],
            tenantId         : 'tenant-alpha',
            token            : firstLease.token
        });
        expect(staleRelease).toMatchObject({
            released: false,
            reason  : 'superseded-epoch'
        });

        const wrongTokenRelease = releaseStewardWakeLease({
            db,
            fencingEpoch     : reclaimed.fencingEpoch,
            sourceInstanceIds: [srcAlpha.sourceInstanceId],
            tenantId         : 'tenant-alpha',
            token            : 'wrong-token'
        });
        expect(wrongTokenRelease).toMatchObject({
            released: false,
            reason  : 'foreign-token'
        });

        const validRelease = releaseStewardWakeLease({
            db,
            fencingEpoch     : reclaimed.fencingEpoch,
            sourceInstanceIds: [srcAlpha.sourceInstanceId],
            tenantId         : 'tenant-alpha',
            token            : reclaimed.token
        });
        expect(validRelease).toMatchObject({
            fencingEpoch: 2,
            released    : true
        });
    });

    test('emits count-only bounded wakes when live policy leaves are supplied, enforces amplification caps and vacancy cooldown, and preserves Task claim as sole ownership authority', async () => {
        const srcAlpha = registerActiveGitHubSource('tenant-alpha', 'org-a', 'repo-a');
        const t0       = Date.parse('2026-10-26T22:00:00.000Z');

        admitCompleteBaseline('tenant-alpha', srcAlpha.sourceInstanceId, [
            makeObservation('comment:1001', '2026-10-26T12:01:00.000Z'),
            makeObservation('comment:1002', '2026-10-26T12:02:00.000Z', {
                occurrenceKind   : 'discussion.comment',
                sourceAssociation: 'FIRST_TIME_CONTRIBUTOR'
            })
        ]);

        await inTenant('tenant-alpha', async () => {
            const noFallback = await CommunityActivityService.evaluateStewardWake({
                now   : t0,
                policy: TEST_MEASURED_LIVE_POLICY
            });
            expect(noFallback).toMatchObject({
                mode      : 'live',
                reason    : 'steward-vacant-no-fallback-target',
                shouldWake: false
            });

            const vacancyWake = await CommunityActivityService.evaluateStewardWake({
                now                  : t0,
                policy               : TEST_MEASURED_LIVE_POLICY,
                vacancyFallbackTarget: {
                    principalId: 'steward:tenant-alpha:oncall-fallback',
                    tenantId   : 'tenant-alpha'
                }
            });

            expect(vacancyWake.shouldWake).toBe(true);
            expect(vacancyWake.mode).toBe('live');
            expect(vacancyWake.routingMode).toBe('vacancy-fallback');
            expect(vacancyWake.payloadBytes).toBeLessThanOrEqual(TEST_MEASURED_LIVE_POLICY.maxWakePayloadBytes);
            expect(vacancyWake.wakePayload).toMatchObject({
                calibrationReportId: CALIBRATED_STEWARD_WAKE_REPORT_ID,
                coalesceWindowMs   : TEST_MEASURED_LIVE_POLICY.wakeCoalesceWindowMs,
                count              : 2,
                coverageStatus     : 'fresh',
                mode               : 'live',
                notAuthority       : true,
                oldestOccurredAt   : '2026-10-26T12:01:00.000Z',
                routingMode        : 'vacancy-fallback',
                schemaVersion      : COMMUNITY_STEWARD_WAKE_SCHEMA_VERSION,
                sourceCount        : 1,
                targetPrincipalId  : 'steward:tenant-alpha:oncall-fallback',
                tenantId           : 'tenant-alpha'
            });

            expect(() => assertCountOnlyWakePayload({
                ...vacancyWake.wakePayload,
                title: 'Forbidden prose title'
            }, TEST_MEASURED_LIVE_POLICY.maxWakePayloadBytes))
                .toThrow(/COMMUNITY_STEWARD_WAKE_PROSE_OR_AUTHORITY_FORBIDDEN:title/);

            expect(() => assertCountOnlyWakePayload(vacancyWake.wakePayload, 32))
                .toThrow(/COMMUNITY_STEWARD_WAKE_PAYLOAD_TOO_LARGE/);

            const bindingCountAfterWake = db.prepare('SELECT count(*) AS count FROM mc_community_task_binding').get().count;
            expect(bindingCountAfterWake).toBe(0);

            const duplicateWatermark = await CommunityActivityService.evaluateStewardWake({
                now                  : t0 + 10_000,
                policy               : TEST_MEASURED_LIVE_POLICY,
                vacancyFallbackTarget: {
                    principalId: 'steward:tenant-alpha:oncall-fallback',
                    tenantId   : 'tenant-alpha'
                }
            });
            expect(duplicateWatermark).toMatchObject({
                reason    : 'watermark-already-woken',
                shouldWake: false
            });

            const bird = await CommunityActivityService.query({
                limit      : 10,
                windowEnd  : '2026-10-26T13:00:00.000Z',
                windowStart: '2026-10-26T12:00:00.000Z'
            });
            const sortedItems = [...bird.items].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
            const claimed     = await CommunityActivityService.claimTask({
                sourceEventId: sortedItems[0].sourceEventId
            });
            expect(claimed.status).toBe('claimed');

            const vacancyCooldownSuppressed = await CommunityActivityService.evaluateStewardWake({
                now                  : t0 + 450_000,
                policy               : TEST_MEASURED_LIVE_POLICY,
                vacancyFallbackTarget: {
                    principalId: 'steward:tenant-alpha:oncall-fallback',
                    tenantId   : 'tenant-alpha'
                }
            });
            expect(vacancyCooldownSuppressed).toMatchObject({
                reason    : 'vacancy-fallback-cooldown',
                shouldWake: false
            });

            const lease = await CommunityActivityService.acquireStewardLease({
                holderPrincipal: 'steward:tenant-alpha:leased-1',
                now            : t0 + 450_000,
                policy         : TEST_MEASURED_LIVE_POLICY
            });
            expect(lease.acquired).toBe(true);

            const leasedWake = await CommunityActivityService.evaluateStewardWake({
                holderProof: {
                    fencingEpoch: lease.fencingEpoch,
                    token       : lease.token
                },
                now   : t0 + 450_000,
                policy: TEST_MEASURED_LIVE_POLICY
            });
            expect(leasedWake).toMatchObject({
                mode       : 'live',
                reason     : 'leased-steward-wake',
                routingMode: 'leased-steward',
                shouldWake : true
            });
            expect(leasedWake.wakePayload).toMatchObject({
                count            : 1,
                oldestOccurredAt : '2026-10-26T12:02:00.000Z',
                targetPrincipalId: 'steward:tenant-alpha:leased-1'
            });

            const staleHolderAttempt = await CommunityActivityService.evaluateStewardWake({
                holderProof: {
                    fencingEpoch: lease.fencingEpoch - 1,
                    token       : lease.token
                },
                now   : t0 + 460_000,
                policy: TEST_MEASURED_LIVE_POLICY
            });
            expect(staleHolderAttempt).toMatchObject({
                reason    : 'stale-lease-holder',
                shouldWake: false
            });

            await CommunityActivityService.claimTask({
                sourceEventId: sortedItems[1].sourceEventId
            });

            const emptyAfterAllClaimed = await CommunityActivityService.evaluateStewardWake({
                now   : t0 + 900_000,
                policy: TEST_MEASURED_LIVE_POLICY
            });
            expect(emptyAfterAllClaimed).toMatchObject({
                coverageStatus: 'empty',
                reason        : 'coverage-empty',
                shouldWake    : false
            });
        });
    });

    test('suppresses wake when count coverage is degraded or missing and isolates tenants', async () => {
        const srcIncomplete = registerActiveGitHubSource('tenant-degraded', 'org-d', 'repo-d');
        const t0            = Date.parse('2026-10-26T22:00:00.000Z');

        await inTenant('tenant-degraded', async () => {
            CommunityBatchAdmissionService.admitBatch(batchAt(
                srcIncomplete.sourceInstanceId,
                [makeObservation('comment:901', '2026-10-26T12:01:00.000Z')],
                {
                    batchId       : 'degraded-issues-1',
                    resourceFamily: 'issues'
                }
            ));

            await CommunityActivityService.acquireStewardLease({
                holderPrincipal: 'steward:tenant-degraded:seat-1',
                now            : t0,
                policy         : TEST_MEASURED_LIVE_POLICY
            });

            const degradedVerdict = await CommunityActivityService.evaluateStewardWake({
                now   : t0,
                policy: TEST_MEASURED_LIVE_POLICY
            });
            expect(degradedVerdict).toMatchObject({
                coverageStatus: 'degraded',
                reason        : 'coverage-degraded',
                shouldWake    : false
            });
        });

        await inTenant('tenant-missing', async () => {
            const missingVerdict = await CommunityActivityService.evaluateStewardWake({
                now   : t0,
                policy: TEST_MEASURED_LIVE_POLICY
            });
            expect(missingVerdict).toMatchObject({
                coverageStatus: 'missing',
                reason        : 'coverage-missing',
                shouldWake    : false
            });
        });
    });
});

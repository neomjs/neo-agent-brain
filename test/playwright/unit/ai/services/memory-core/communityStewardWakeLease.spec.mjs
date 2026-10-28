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
import {snapshotAiConfig}             from './util.mjs';
import {runOperatorWindow}            from '../../../../../../ai/scripts/maintenance/observeCommunitySteward.mjs';
import {bindCommunityCoverage, COMMUNITY_COVERAGE_CONTRACTS} from '../../../../../../ai/services/memory-core/communityCoverageContract.mjs';
import {
    COMMUNITY_STEWARD_WAKE_SCHEMA_VERSION,
    REQUIRED_LIVE_STEWARD_THRESHOLD_KEYS,
    acquireStewardWakeLease,
    assertCountOnlyWakePayload,
    evaluateStewardWake,
    releaseStewardWakeLease,
    resolveValidatedStewardWakePolicy,
    validateTenantScopedPrincipal
} from '../../../../../../ai/services/memory-core/communityStewardWakeLease.mjs';

const ATTENTION_POLICY = {
    recordedActorDispositions: {},
    responseBearingKinds     : ['issue.comment', 'discussion.comment', 'pull_request.comment'],
    rosteredActorIds         : []
};

const TEST_MEASURED_LIVE_LEAVES = Object.freeze({
    'communityStewardWake.maxWakePayloadBytes'      : 1_024,
    'communityStewardWake.minUnclaimedEligibleCount': 1,
    'communityStewardWake.stewardActivation'        : true,
    'communityStewardWake.stewardLeaseTtlMs'        : 1_590_000,
    'communityStewardWake.vacancyFallbackCooldownMs': 795_000,
    'communityStewardWake.wakeAmplificationCap'     : 1,
    'communityStewardWake.wakeCoalesceWindowMs'     : 397_500
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
    coverage,
    nextInventoryHash     = `inventory-${batchId}`,
    registrationEpoch     = 2,
    resourceFamily        = 'issues'
} = {}) {
    const contract = COMMUNITY_COVERAGE_CONTRACTS[resourceFamily].contract;

    return {
        adapterSchemaVersion      : contract.adapterSchemaVersion,
        baseCheckpointVersion,
        baseInventoryHash,
        batchId,
        coverage                  : coverage ?? bindCommunityCoverage(resourceFamily, {
            complete: true, fromBasis: 'genesis', toBasis: 'to'
        }),
        nextInventoryHash,
        nextProviderState         : {cursor: batchId},
        observations,
        providerStateSchemaVersion: contract.providerStateSchemaVersion,
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
            expect(CommunityBatchAdmissionService.admitBatch(batchAt(sourceInstanceId, issueObservations, {
                batchId       : `${sourceInstanceId}-issues-1`,
                resourceFamily: 'issues'
            })).status).toBe('accepted');
            expect(CommunityBatchAdmissionService.admitBatch(batchAt(sourceInstanceId, [], {
                batchId       : `${sourceInstanceId}-pulls-1`,
                resourceFamily: 'pulls'
            })).status).toBe('accepted');
            expect(CommunityBatchAdmissionService.admitBatch(batchAt(sourceInstanceId, [], {
                batchId       : `${sourceInstanceId}-discussions-1`,
                resourceFamily: 'discussions'
            })).status).toBe('accepted')
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

    test('reads AiConfig leaves at the use site, keeps thresholds unset by default in shadow mode, requires all numeric leaves for live activation, and ignores caller overrides', async () => {
        expect(memoryCoreConfig.communityStewardWake).toEqual({
            maxWakePayloadBytes      : null,
            minUnclaimedEligibleCount: null,
            stewardActivation        : false,
            stewardLeaseTtlMs        : null,
            vacancyFallbackCooldownMs: null,
            wakeAmplificationCap     : null,
            wakeCoalesceWindowMs     : null
        });

        const defaultResolved = resolveValidatedStewardWakePolicy();
        expect(defaultResolved).toEqual({
            maxWakePayloadBytes      : null,
            minUnclaimedEligibleCount: null,
            mode                     : 'shadow',
            stewardActivation        : false,
            stewardLeaseTtlMs        : null,
            vacancyFallbackCooldownMs: null,
            wakeAmplificationCap     : null,
            wakeCoalesceWindowMs     : null
        });

        const ignoredCallerArg = resolveValidatedStewardWakePolicy({
            maxWakePayloadBytes      : 1_024,
            minUnclaimedEligibleCount: 1,
            stewardActivation        : true,
            stewardLeaseTtlMs        : 60_000,
            vacancyFallbackCooldownMs: 60_000,
            wakeAmplificationCap     : 1,
            wakeCoalesceWindowMs     : 60_000
        });
        expect(ignoredCallerArg.mode).toBe('shadow');
        expect(ignoredCallerArg.stewardActivation).toBe(false);

        for (const key of REQUIRED_LIVE_STEWARD_THRESHOLD_KEYS) {
            const restoreMissing = snapshotAiConfig(memoryCoreConfig, {
                ...TEST_MEASURED_LIVE_LEAVES,
                [`communityStewardWake.${key}`]: null
            });
            try {
                expect(() => resolveValidatedStewardWakePolicy())
                    .toThrow(`COMMUNITY_STEWARD_POLICY_THRESHOLD_UNSET:${key}`);
            } finally {
                restoreMissing()
            }

            const restoreInvalid = snapshotAiConfig(memoryCoreConfig, {
                ...TEST_MEASURED_LIVE_LEAVES,
                [`communityStewardWake.${key}`]: 0
            });
            try {
                expect(() => resolveValidatedStewardWakePolicy())
                    .toThrow(`COMMUNITY_STEWARD_POLICY_INVALID:${key}`);
            } finally {
                restoreInvalid()
            }
        }

        const restoreLive = snapshotAiConfig(memoryCoreConfig, TEST_MEASURED_LIVE_LEAVES);
        try {
            const liveResolved = resolveValidatedStewardWakePolicy();
            expect(liveResolved.mode).toBe('live');
            expect(liveResolved.stewardActivation).toBe(true);
        } finally {
            restoreLive()
        }

        const srcAlpha = registerActiveGitHubSource('tenant-alpha', 'org-a', 'repo-a');
        admitCompleteBaseline('tenant-alpha', srcAlpha.sourceInstanceId, [
            makeObservation('comment:override-test-1', '2026-10-26T12:01:00.000Z')
        ]);

        await inTenant('tenant-alpha', async () => {
            await expect(CommunityActivityService.acquireStewardLease({
                holderPrincipal  : 'steward:tenant-alpha:seat-1',
                leaseTtlMs       : 60_000,
                now              : 1_000,
                policy           : {stewardActivation: true, stewardLeaseTtlMs: 60_000},
                stewardActivation: true
            })).rejects.toThrow('COMMUNITY_STEWARD_POLICY_THRESHOLD_UNSET:stewardLeaseTtlMs');

            const shadowDespiteOverride = await CommunityActivityService.evaluateStewardWake({
                now   : 1_000,
                policy: {
                    maxWakePayloadBytes      : 1_024,
                    minUnclaimedEligibleCount: 1,
                    stewardActivation        : true,
                    stewardLeaseTtlMs        : 60_000,
                    vacancyFallbackCooldownMs: 60_000,
                    wakeAmplificationCap     : 1,
                    wakeCoalesceWindowMs     : 60_000
                },
                stewardActivation    : true,
                vacancyFallbackTarget: {
                    principalId: 'steward:tenant-alpha:oncall-fallback',
                    tenantId   : 'tenant-alpha'
                }
            });

            expect(shadowDespiteOverride).toMatchObject({
                mode           : 'shadow',
                reason         : 'shadow-vacancy-would-wake',
                shadowWouldWake: true,
                shouldWake     : false
            });
        });
    });

    test('positively enforces server-derived tenant scope on steward principals and rejects broadcasts, unscoped global handles, and cross-tenant spoofing', () => {
        expect(() => validateTenantScopedPrincipal('AGENT:*', 'tenant-alpha'))
            .toThrow('COMMUNITY_STEWARD_ALL_RESIDENT_BROADCAST_FORBIDDEN');
        expect(() => validateTenantScopedPrincipal('*', 'tenant-alpha'))
            .toThrow('COMMUNITY_STEWARD_ALL_RESIDENT_BROADCAST_FORBIDDEN');
        expect(() => validateTenantScopedPrincipal({broadcast: true, principalId: 'steward:tenant-alpha:seat-1'}, 'tenant-alpha'))
            .toThrow('COMMUNITY_STEWARD_ALL_RESIDENT_BROADCAST_FORBIDDEN');

        expect(() => validateTenantScopedPrincipal('@neo-opus-grace', 'tenant-alpha'))
            .toThrow('COMMUNITY_STEWARD_GLOBAL_ROSTER_FORBIDDEN');
        expect(() => validateTenantScopedPrincipal('@neo-gemini-maryam', 'tenant-alpha'))
            .toThrow('COMMUNITY_STEWARD_GLOBAL_ROSTER_FORBIDDEN');
        expect(() => validateTenantScopedPrincipal('@neo-fable-mnemosyne', 'tenant-alpha'))
            .toThrow('COMMUNITY_STEWARD_GLOBAL_ROSTER_FORBIDDEN');
        expect(() => validateTenantScopedPrincipal('unscoped-seat-1', 'tenant-alpha'))
            .toThrow('COMMUNITY_STEWARD_GLOBAL_ROSTER_FORBIDDEN');
        expect(() => validateTenantScopedPrincipal({principalId: 'seat-1', scope: 'global-roster'}, 'tenant-alpha'))
            .toThrow('COMMUNITY_STEWARD_GLOBAL_ROSTER_FORBIDDEN');

        expect(() => validateTenantScopedPrincipal({principalId: 'steward:tenant-beta:seat-1', tenantId: 'tenant-beta'}, 'tenant-alpha'))
            .toThrow('COMMUNITY_STEWARD_CROSS_TENANT_FORBIDDEN');
        expect(() => validateTenantScopedPrincipal({principalId: 'steward:tenant-beta:seat-1', tenantId: 'tenant-alpha'}, 'tenant-alpha'))
            .toThrow('COMMUNITY_STEWARD_CROSS_TENANT_FORBIDDEN');

        RequestContextService.run({userId: 'tenant-alpha'}, () => {
            expect(() => validateTenantScopedPrincipal('steward:tenant-beta:seat-1', 'tenant-beta'))
                .toThrow('COMMUNITY_STEWARD_CROSS_TENANT_FORBIDDEN');
        });

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
                coalesceWindowMs : null,
                count            : 2,
                coverageStatus   : 'fresh',
                mode             : 'shadow',
                notAuthority     : true,
                oldestOccurredAt : '2026-10-26T12:01:00.000Z',
                routingMode      : 'vacancy-fallback',
                schemaVersion    : COMMUNITY_STEWARD_WAKE_SCHEMA_VERSION,
                sourceCount      : 1,
                targetPrincipalId: 'steward:tenant-alpha:oncall-fallback',
                tenantId         : 'tenant-alpha'
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

    test('reports non-integer or negative attentionCounts.count as degraded-unclaimed-count with count: null and leaves shadow tallies untouched', () => {
        const t0 = Date.parse('2026-10-26T22:00:00.000Z');

        for (const badCount of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) {
            const verdict = evaluateStewardWake({
                attentionCounts: {
                    count          : badCount,
                    coverage       : {sourceCount: 1},
                    notAuthority   : true,
                    sourceWatermark: 'seq:1',
                    status         : 'fresh'
                },
                db,
                now                  : t0,
                tenantId             : 'tenant-alpha',
                vacancyFallbackTarget: 'steward:tenant-alpha:oncall-fallback'
            });

            expect(verdict).toMatchObject({
                count          : null,
                coverageStatus : 'degraded',
                mode           : 'shadow',
                notAuthority   : true,
                reason         : 'degraded-unclaimed-count',
                shouldWake     : false
            });
            for (const key of ['stewardVacant', 'shadowWouldWake', 'wakePayload', 'payloadBytes']) {
                expect(verdict).not.toHaveProperty(key)
            }
        }

        const stateRow = db.prepare(
            'SELECT vacancy_count, shadow_would_wake_count FROM mc_community_steward_wake_state WHERE tenant_id = ?'
        ).get('tenant-alpha');
        expect(stateRow).toBeUndefined();
    });

    test('an inconsistent empty projection leaves vacancy and would-wake observations unknown', () => {
        for (const count of [1, -1, null, '0']) {
            const verdict = evaluateStewardWake({
                attentionCounts: {status: 'empty', count, notAuthority: true},
                db, now: Date.parse('2026-10-26T22:00:00.000Z'), tenantId: 'tenant-empty-invalid'
            });

            expect(verdict).toMatchObject({coverageStatus: 'degraded', shouldWake: false});
            for (const key of ['stewardVacant', 'shadowWouldWake', 'wakePayload', 'payloadBytes']) {
                expect(verdict).not.toHaveProperty(key)
            }
        }
        expect(db.prepare('SELECT COUNT(*) AS count FROM mc_community_steward_wake_state').get().count).toBe(0);
    });

    test('manages lease acquisition, contention, expiry reclaim, release, and stale-holder rejection', async () => {
        const srcAlpha = registerActiveGitHubSource('tenant-alpha', 'org-a', 'repo-a');
        const srcBeta  = registerActiveGitHubSource('tenant-beta', 'org-b', 'repo-b');
        const t0       = Date.parse('2026-10-26T22:00:00.000Z');
        const ttlMs    = TEST_MEASURED_LIVE_LEAVES['communityStewardWake.stewardLeaseTtlMs'];

        expect(() => acquireStewardWakeLease({
            db,
            holderPrincipal  : 'steward:tenant-alpha:seat-1',
            now              : t0,
            sourceInstanceIds: [srcAlpha.sourceInstanceId],
            tenantId         : 'tenant-alpha'
        })).toThrow('COMMUNITY_STEWARD_POLICY_THRESHOLD_UNSET:stewardLeaseTtlMs');

        const restoreLeaseTtl = snapshotAiConfig(memoryCoreConfig, {
            'communityStewardWake.stewardLeaseTtlMs': ttlMs
        });

        try {
            expect(() => acquireStewardWakeLease({
                db,
                holderPrincipal  : 'steward:tenant-alpha:seat-1',
                now              : t0,
                sourceInstanceIds: [srcBeta.sourceInstanceId],
                tenantId         : 'tenant-alpha'
            })).toThrow('COMMUNITY_SOURCE_NOT_OWNED');

            const firstLease = acquireStewardWakeLease({
                db,
                holderPrincipal  : 'steward:tenant-alpha:seat-1',
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
                mode             : 'shadow',
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
        } finally {
            restoreLeaseTtl()
        }
    });

    test('emits count-only bounded wakes when live policy leaves are configured in AiConfig, enforces amplification caps and vacancy cooldown, and preserves Task claim as sole ownership authority', async () => {
        const srcAlpha    = registerActiveGitHubSource('tenant-alpha', 'org-a', 'repo-a');
        const t0          = Date.parse('2026-10-26T22:00:00.000Z');
        const restoreLive = snapshotAiConfig(memoryCoreConfig, TEST_MEASURED_LIVE_LEAVES);

        try {
            admitCompleteBaseline('tenant-alpha', srcAlpha.sourceInstanceId, [
                makeObservation('comment:1001', '2026-10-26T12:01:00.000Z'),
                makeObservation('comment:1002', '2026-10-26T12:02:00.000Z', {
                    occurrenceKind   : 'discussion.comment',
                    sourceAssociation: 'FIRST_TIME_CONTRIBUTOR'
                })
            ]);

            await inTenant('tenant-alpha', async () => {
                const noFallback = await CommunityActivityService.evaluateStewardWake({
                    now: t0
                });
                expect(noFallback).toMatchObject({
                    mode      : 'live',
                    reason    : 'steward-vacant-no-fallback-target',
                    shouldWake: false
                });

                const vacancyWake = await CommunityActivityService.evaluateStewardWake({
                    now                  : t0,
                    vacancyFallbackTarget: {
                        principalId: 'steward:tenant-alpha:oncall-fallback',
                        tenantId   : 'tenant-alpha'
                    }
                });

                expect(vacancyWake.shouldWake).toBe(true);
                expect(vacancyWake.mode).toBe('live');
                expect(vacancyWake.routingMode).toBe('vacancy-fallback');
                expect(vacancyWake.payloadBytes).toBeLessThanOrEqual(
                    TEST_MEASURED_LIVE_LEAVES['communityStewardWake.maxWakePayloadBytes']
                );
                expect(vacancyWake.wakePayload).toMatchObject({
                    coalesceWindowMs : TEST_MEASURED_LIVE_LEAVES['communityStewardWake.wakeCoalesceWindowMs'],
                    count            : 2,
                    coverageStatus   : 'fresh',
                    mode             : 'live',
                    notAuthority     : true,
                    oldestOccurredAt : '2026-10-26T12:01:00.000Z',
                    routingMode      : 'vacancy-fallback',
                    schemaVersion    : COMMUNITY_STEWARD_WAKE_SCHEMA_VERSION,
                    sourceCount      : 1,
                    targetPrincipalId: 'steward:tenant-alpha:oncall-fallback',
                    tenantId         : 'tenant-alpha'
                });

                expect(() => assertCountOnlyWakePayload({
                    ...vacancyWake.wakePayload,
                    title: 'Forbidden prose title'
                }, TEST_MEASURED_LIVE_LEAVES['communityStewardWake.maxWakePayloadBytes']))
                    .toThrow(/COMMUNITY_STEWARD_WAKE_PROSE_OR_AUTHORITY_FORBIDDEN:title/);

                expect(() => assertCountOnlyWakePayload(vacancyWake.wakePayload, 32))
                    .toThrow(/COMMUNITY_STEWARD_WAKE_PAYLOAD_TOO_LARGE/);

                const bindingCountAfterWake = db.prepare('SELECT count(*) AS count FROM mc_community_task_binding').get().count;
                expect(bindingCountAfterWake).toBe(0);

                const duplicateWatermark = await CommunityActivityService.evaluateStewardWake({
                    now                  : t0 + 10_000,
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
                    now            : t0 + 450_000
                });
                expect(lease.acquired).toBe(true);

                const leasedWake = await CommunityActivityService.evaluateStewardWake({
                    holderProof: {
                        fencingEpoch: lease.fencingEpoch,
                        token       : lease.token
                    },
                    now: t0 + 450_000
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
                    now: t0 + 460_000
                });
                expect(staleHolderAttempt).toMatchObject({
                    reason    : 'stale-lease-holder',
                    shouldWake: false
                });

                await CommunityActivityService.claimTask({
                    sourceEventId: sortedItems[1].sourceEventId
                });

                const emptyAfterAllClaimed = await CommunityActivityService.evaluateStewardWake({
                    now: t0 + 900_000
                });
                expect(emptyAfterAllClaimed).toMatchObject({
                    count         : 0,
                    shadowWouldWake: false,
                    shouldWake    : false
                });
            });
        } finally {
            restoreLive()
        }
    });

    test('retains the exact scoped count snapshot consumed by one shadow evaluation', async () => {
        const source = registerActiveGitHubSource('tenant-window', 'org-window', 'repo');
        admitCompleteBaseline('tenant-window', source.sourceInstanceId, [
            makeObservation('comment:window-1', '2026-10-26T12:01:00.000Z')
        ]);

        const originalProjection = CommunityActivityService.projectAttentionCounts;
        let captured, projectionCalls = 0;
        CommunityActivityService.projectAttentionCounts = async function(options) {
            projectionCalls++;
            captured = await originalProjection.call(this, options);
            return captured
        };

        try {
            await inTenant('tenant-window', async () => {
                const policyBefore = JSON.stringify(memoryCoreConfig.communityStewardWake);
                const observed = await CommunityActivityService.observeStewardWake({
                    now: Date.parse('2026-10-26T13:00:00.000Z'),
                    sourceInstanceIds: [source.sourceInstanceId],
                    vacancyFallbackTarget: 'steward:tenant-window:observer'
                });
                expect(projectionCalls).toBe(1);
                expect(observed.attentionCounts).toEqual(captured);
                expect(observed.attentionCounts).toMatchObject({status: 'fresh', count: 1});
                expect(observed.evaluation).toMatchObject({
                    mode: 'shadow', shouldWake: false, shadowWouldWake: true,
                    wakePayload: {count: captured.count, sourceWatermark: captured.sourceWatermark}
                });
                expect(db.prepare('SELECT COUNT(*) AS count FROM mc_community_task_binding').get().count).toBe(0);
                expect(JSON.stringify(memoryCoreConfig.communityStewardWake)).toBe(policyBefore);
            });
        } finally {
            CommunityActivityService.projectAttentionCounts = originalProjection;
        }

        await inTenant('tenant-other-window', async () => {
            const observed = await CommunityActivityService.observeStewardWake();
            expect(observed.attentionCounts).toMatchObject({status: 'missing'});
            expect(observed.evaluation).toMatchObject({reason: 'coverage-missing', shouldWake: false});
            expect(db.prepare('SELECT COUNT(*) AS count FROM mc_community_steward_wake_state WHERE tenant_id = ?')
                .get('tenant-other-window').count).toBe(0);
        });
    });

    test('retains a finite window through the real service and admitted isolated records', async () => {
        const source = registerActiveGitHubSource('tenant-retained-window', 'org-retained-window', 'repo');
        admitCompleteBaseline('tenant-retained-window', source.sourceInstanceId, [
            makeObservation('comment:retained-window-1', '2026-10-26T12:01:00.000Z')
        ]);
        const output = path.join(fs.realpathSync(tmpDir), 'window.json');
        const report = await runOperatorWindow({
            args: {tenantId: 'tenant-retained-window', sourceInstanceIds: [source.sourceInstanceId],
                samples: 2, intervalMs: 0, output,
                vacancyFallbackPrincipal: 'steward:tenant-retained-window:observer'},
            runtimeLoader: async () => ({activity: CommunityActivityService, context: RequestContextService,
                readPolicy: resolveValidatedStewardWakePolicy, testStore: true, unitTestStore: true})
        });
        expect(report.status).toBe('completed');
        expect(report.windowEvidence).toBe('fixture-only');
        expect(report.denominator).toMatchObject({recorded: 2, freshDemand: 2});
        expect(report.observations.every(row => row.attentionCounts.count === 1 &&
            row.evaluation.mode === 'shadow' && row.evaluation.shouldWake === false)).toBe(true);
        expect(report.summary.wouldWake.numerator).toBe(1);
        expect(report.summary.payloadBytes.observedDenominator).toBe(1);
        expect(JSON.parse(fs.readFileSync(output, 'utf8')).observations).toEqual(report.observations);
        expect(db.prepare('SELECT COUNT(*) AS count FROM mc_community_task_binding').get().count).toBe(0);
    });

    test('qualified empty demand observes both absent and held SQLite leases without a wake', async () => {
        const tenantId = 'tenant-qualified-empty',
              source = registerActiveGitHubSource(tenantId, 'org-qualified-empty', 'repo'),
              sourceInstanceIds = [source.sourceInstanceId],
              t0 = Date.parse('2026-10-26T22:00:00.000Z');
        admitCompleteBaseline(tenantId, source.sourceInstanceId, []);

        await inTenant(tenantId, async () => {
            const vacant = await CommunityActivityService.observeStewardWake({now: t0, sourceInstanceIds});

            expect(vacant.attentionCounts).toMatchObject({status: 'empty', count: 0});
            expect(vacant.attentionCounts.sources[0].families.map(family => [family.resourceFamily, family.qualified]))
                .toEqual([['issues', true], ['pulls', true], ['discussions', true]]);
            expect(db.prepare('SELECT COUNT(*) AS count FROM mc_community_steward_lease').get().count).toBe(0);
            expect(vacant.evaluation).toMatchObject({
                count: 0, mode: 'shadow', stewardVacant: true,
                shadowWouldWake: false, shouldWake: false
            });

            const restoreTtl = snapshotAiConfig(memoryCoreConfig, {
                'communityStewardWake.stewardLeaseTtlMs': TEST_MEASURED_LIVE_LEAVES['communityStewardWake.stewardLeaseTtlMs']
            });
            try {
                const lease = await CommunityActivityService.acquireStewardLease({
                    holderPrincipal: `steward:${tenantId}:holder`, now: t0, sourceInstanceIds
                });
                expect(lease.acquired).toBe(true);
                expect(db.prepare('SELECT state FROM mc_community_steward_lease WHERE lease_scope_key = ?')
                    .get(lease.leaseScopeKey).state).toBe('held');

                const held = await CommunityActivityService.observeStewardWake({now: t0 + 1, sourceInstanceIds});
                expect(held.attentionCounts).toMatchObject({status: 'empty', count: 0});
                expect(held.evaluation).toMatchObject({
                    count: 0, mode: 'shadow', stewardVacant: false,
                    shadowWouldWake: false, shouldWake: false
                });
                for (const evaluation of [vacant.evaluation, held.evaluation]) {
                    expect(evaluation).not.toHaveProperty('wakePayload');
                    expect(evaluation).not.toHaveProperty('payloadBytes');
                }
            } finally {
                restoreTtl()
            }
        });
        expect(db.prepare('SELECT COUNT(*) AS count FROM mc_community_task_binding').get().count).toBe(0);
    });

    test('retains qualified empty observations as measured vacancy and zero would-wake demand', async () => {
        const tenantId = 'tenant-empty-window', source = registerActiveGitHubSource(tenantId, 'org-empty-window', 'repo');
        admitCompleteBaseline(tenantId, source.sourceInstanceId, []);
        const output = path.join(fs.realpathSync(tmpDir), 'empty-window.json'),
              report = await runOperatorWindow({
                  args: {tenantId, sourceInstanceIds: [source.sourceInstanceId], samples: 2, intervalMs: 0, output,
                      vacancyFallbackPrincipal: `steward:${tenantId}:observer`},
                  runtimeLoader: async () => ({activity: CommunityActivityService, context: RequestContextService,
                      readPolicy: resolveValidatedStewardWakePolicy, testStore: true, unitTestStore: true})
              });

        expect(report).toMatchObject({status: 'completed', windowEvidence: 'fixture-only'});
        expect(report.denominator).toMatchObject({recorded: 2, freshDemand: 0, empty: 2});
        for (const row of report.observations) {
            expect(row.attentionCounts).toMatchObject({status: 'empty', count: 0});
            expect(row.attentionCounts.sources[0].families).toHaveLength(3);
            expect(row.attentionCounts.sources[0].families.every(family => family.qualified === true)).toBe(true);
            expect(row.sourceGenerationComplete).toBe(true);
            expect(row.evaluation).toMatchObject({
                stewardVacant: true, shadowWouldWake: false, shouldWake: false
            });
        }
        expect(report.summary.vacancy).toEqual({observedDenominator: 2, unknownObservations: 0, numerator: 2, fraction: 1});
        expect(report.summary.wouldWake).toEqual({observedDenominator: 2, unknownObservations: 0, numerator: 0, fraction: 0});
        expect(report.summary.payloadBytes).toMatchObject({observedDenominator: 0, unknownObservations: 2, total: null});
        expect(JSON.parse(fs.readFileSync(output, 'utf8')).observations).toEqual(report.observations);
        expect(db.prepare('SELECT COUNT(*) AS count FROM mc_community_task_binding').get().count).toBe(0);
    });

    test('the observation surface refuses a live policy without recording a wake', async () => {
        const source = registerActiveGitHubSource('tenant-live-window', 'org-live-window', 'repo');
        admitCompleteBaseline('tenant-live-window', source.sourceInstanceId, [
            makeObservation('comment:live-window-1', '2026-10-26T12:01:00.000Z')
        ]);
        const restoreLive = snapshotAiConfig(memoryCoreConfig, TEST_MEASURED_LIVE_LEAVES);
        try {
            await inTenant('tenant-live-window', async () => {
                await expect(CommunityActivityService.observeStewardWake({
                    vacancyFallbackTarget: 'steward:tenant-live-window:observer'
                })).rejects.toThrow('COMMUNITY_STEWARD_SHADOW_OBSERVATION_ONLY');
                expect(db.prepare('SELECT COUNT(*) AS count FROM mc_community_steward_wake_state').get().count).toBe(0);
                expect(db.prepare('SELECT COUNT(*) AS count FROM mc_community_task_binding').get().count).toBe(0);
            });
        } finally {
            restoreLive();
        }
    });

    test('suppresses wake when count coverage is degraded or missing and isolates tenants', async () => {
        const srcIncomplete   = registerActiveGitHubSource('tenant-degraded', 'org-d', 'repo-d');
        const t0              = Date.parse('2026-10-26T22:00:00.000Z');
        const restoreLeaseTtl = snapshotAiConfig(memoryCoreConfig, {
            'communityStewardWake.stewardLeaseTtlMs': TEST_MEASURED_LIVE_LEAVES['communityStewardWake.stewardLeaseTtlMs']
        });

        try {
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
                    now            : t0
                });

                const degradedVerdict = await CommunityActivityService.evaluateStewardWake({
                    now: t0
                });
                expect(degradedVerdict).toMatchObject({
                    coverageStatus: 'degraded',
                    reason        : 'coverage-degraded',
                    shouldWake    : false
                });
                for (const key of ['stewardVacant', 'shadowWouldWake', 'wakePayload', 'payloadBytes']) {
                    expect(degradedVerdict).not.toHaveProperty(key)
                }
            });

            await inTenant('tenant-missing', async () => {
                const missingVerdict = await CommunityActivityService.evaluateStewardWake({
                    now: t0
                });
                expect(missingVerdict).toMatchObject({
                    coverageStatus: 'missing',
                    reason        : 'coverage-missing',
                    shouldWake    : false
                });
                for (const key of ['stewardVacant', 'shadowWouldWake', 'wakePayload', 'payloadBytes']) {
                    expect(missingVerdict).not.toHaveProperty(key)
                }
            });
        } finally {
            restoreLeaseTtl()
        }
    });
});

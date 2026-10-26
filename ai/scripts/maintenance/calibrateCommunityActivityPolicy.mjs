import Neo             from 'neo.mjs/src/Neo.mjs';
import * as core       from 'neo.mjs/src/core/_export.mjs';
import InstanceManager from 'neo.mjs/src/manager/Instance.mjs';

import Database        from 'better-sqlite3';
import fsExtra         from 'fs-extra';
import os              from 'node:os';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';

import CommunityActivityService       from '../../services/memory-core/CommunityActivityService.mjs';
import CommunityBatchAdmissionService from '../../services/memory-core/CommunityBatchAdmissionService.mjs';
import GraphService                   from '../../services/memory-core/GraphService.mjs';
import SourceRegistryService          from '../../services/memory-core/SourceRegistryService.mjs';
import RequestContextService          from '../../mcp/server/shared/services/RequestContextService.mjs';
import {
    formatCalibrationSummary,
    parseArgs,
    runPolicyCalibration
}                                             from './communityActivityPolicyCalibrationCore.mjs';
import {hashEvidence}                         from './communityActivityShadowProbeCore.mjs';

const __filename   = fileURLToPath(import.meta.url);
const __dirname    = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const REPORT_DIR   = path.join(PROJECT_ROOT, '.neo-ai-data', 'community-activity-calibration');

export const DEFAULT_CALIBRATION_FIXTURE = Object.freeze({
    tenantId       : 'tenant-calibration',
    viewerAgentId  : 'AGENT:@fixture-steward-1',
    sessionId      : 'calibration-session',
    attentionPolicy: Object.freeze({
        responseBearingKinds: Object.freeze([
            'issue.opened',
            'issue.comment',
            'pull_request.opened',
            'pull_request.review',
            'pull_request.review_comment',
            'discussion.opened',
            'discussion.comment',
            'discussion.reply'
        ]),
        rosteredActorIds         : Object.freeze(['fixture-maintainer-1']),
        recordedActorDispositions: Object.freeze({})
    }),
    buildFamilyBatches(sourceInstanceId, registrationEpoch) {
        return [
            {
                schemaVersion             : 'community-activity-batch.v1',
                sourceInstanceId,
                resourceFamily            : 'issues',
                adapterSchemaVersion      : 'github-issues.v1',
                providerStateSchemaVersion: 'github-issues-state.v1',
                registrationEpoch,
                baseCheckpointVersion     : 0,
                baseInventoryHash         : null,
                batchId                   : 'cal-issues-b1',
                observations              : [
                    {
                        providerEntityId    : 'I_19129',
                        occurrenceKind      : 'issue.opened',
                        occurrenceCoordinate: 'I_19129:opened:2026-10-26T18:00:00.000Z',
                        occurredAt          : '2026-10-26T18:00:00.000Z',
                        actorId             : 'fixture-maintainer-1',
                        actorKind           : 'user',
                        sourceAssociation   : 'OWNER'
                    },
                    {
                        providerEntityId      : 'IC_6425153408',
                        parentProviderEntityId: 'I_19129',
                        occurrenceKind        : 'issue.comment',
                        occurrenceCoordinate  : 'IC_6425153408:created:2026-10-26T19:18:05.000Z',
                        occurredAt            : '2026-10-26T19:18:05.000Z',
                        actorId               : 'SimonGebru',
                        actorKind             : 'user',
                        sourceAssociation     : 'NONE'
                    }
                ],
                nextProviderState: {family: 'issues', rootCursor: 'cursor-issues-1'},
                nextInventoryHash: 'inv-issues-1',
                coverage         : {fromBasis: 'genesis', toBasis: '2026-10-26T19:20:00.000Z', complete: true, gaps: []}
            },
            {
                schemaVersion             : 'community-activity-batch.v1',
                sourceInstanceId,
                resourceFamily            : 'pulls',
                adapterSchemaVersion      : 'github-pulls.v1',
                providerStateSchemaVersion: 'github-pulls-state.v1',
                registrationEpoch,
                baseCheckpointVersion     : 0,
                baseInventoryHash         : null,
                batchId                   : 'cal-pulls-b1',
                observations              : [
                    {
                        providerEntityId    : 'PR_20119',
                        occurrenceKind      : 'pull_request.opened',
                        occurrenceCoordinate: 'PR_20119:opened:2026-10-26T06:00:05.000Z',
                        occurredAt          : '2026-10-26T06:00:05.000Z',
                        actorId             : 'drakeboley',
                        actorKind           : 'user',
                        sourceAssociation   : 'FIRST_TIME_CONTRIBUTOR'
                    }
                ],
                nextProviderState: {family: 'pulls', rootCursor: 'cursor-pulls-1'},
                nextInventoryHash: 'inv-pulls-1',
                coverage         : {fromBasis: 'genesis', toBasis: '2026-10-26T19:20:00.000Z', complete: true, gaps: []}
            },
            {
                schemaVersion             : 'community-activity-batch.v1',
                sourceInstanceId,
                resourceFamily            : 'discussions',
                adapterSchemaVersion      : 'github-discussion.v1',
                providerStateSchemaVersion: 'github-discussion-state.v1',
                registrationEpoch,
                baseCheckpointVersion     : 0,
                baseInventoryHash         : null,
                batchId                   : 'cal-discussions-b1',
                observations              : [
                    {
                        providerEntityId    : 'D_15139',
                        occurrenceKind      : 'discussion.comment',
                        occurrenceCoordinate: 'DC_1:created:2026-10-26T18:30:00.000Z',
                        occurredAt          : '2026-10-26T18:30:00.000Z',
                        actorId             : 'external-discussant',
                        actorKind           : 'user',
                        sourceAssociation   : 'NONE'
                    }
                ],
                nextProviderState: {family: 'discussions', rootCursor: 'cursor-discussions-1'},
                nextInventoryHash: 'inv-discussions-1',
                coverage         : {fromBasis: 'genesis', toBasis: '2026-10-26T19:20:00.000Z', complete: true, gaps: []}
            }
        ]
    }
});

/**
 * @summary Executes one isolated deterministic fixture pass across registry, admission, Bird View, claim, and count projection.
 * @param {Number} runIndex 1-based run index.
 * @param {Object} [fixture=DEFAULT_CALIBRATION_FIXTURE]
 * @returns {Promise<Object>}
 */
export async function executeLiveCalibrationPass(runIndex, fixture = DEFAULT_CALIBRATION_FIXTURE) {
    const startedMs = Date.now();
    const tempDir   = fsExtra.mkdtempSync(path.join(os.tmpdir(), `neo-community-calibration-${runIndex}-`));
    const dbPath    = path.join(tempDir, 'calibration.sqlite');
    const db        = new Database(dbPath);

    const prevRegistryDb  = SourceRegistryService.db;
    const prevAdmissionDb = CommunityBatchAdmissionService.db;
    const prevActivityDb  = CommunityActivityService.db;
    const prevPolicy      = CommunityBatchAdmissionService.attentionPolicy;
    const prevSubject     = SourceRegistryService.localSubjectId;
    const prevStorageDb   = GraphService.db?.storage?.db || null;

    try {
        SourceRegistryService.set({db, localSubjectId: fixture.tenantId});
        CommunityBatchAdmissionService.set({db, attentionPolicy: fixture.attentionPolicy});
        CommunityActivityService.set({db});
        if (GraphService.db?.storage) {
            GraphService.db.storage.db = db
        } else {
            GraphService.db = {storage: {db}}
        }

        await Promise.all([
            SourceRegistryService.ready(),
            CommunityBatchAdmissionService.ready(),
            CommunityActivityService.ready(),
            GraphService.ready()
        ]);

        SourceRegistryService.ensureSchema();
        CommunityBatchAdmissionService.ensureSchema();
        CommunityActivityService.ensureSchema();

        return await RequestContextService.run({
            userId             : fixture.tenantId,
            agentIdentityNodeId: fixture.viewerAgentId,
            sessionId          : fixture.sessionId
        }, async () => {
            const registered = SourceRegistryService.register({
                provider             : 'github',
                canonicalProviderHost: 'github.com',
                resourceKind         : 'repository',
                providerResourceId   : 'R_calibration_neo',
                displayLocator       : 'neomjs/neo',
                grantRef             : 'github-installation:calibration',
                providerCapabilities : {issues: true, pullRequests: true, discussions: true}
            });
            SourceRegistryService.transitionLifecycle(registered.sourceInstanceId, 'PROVISIONED', {
                expectedState: 'REQUESTED',
                expectedEpoch: 1
            });
            const active = SourceRegistryService.transitionLifecycle(registered.sourceInstanceId, 'ACTIVE', {
                expectedState: 'PROVISIONED',
                expectedEpoch: 2
            });

            const familyBatches = fixture.buildFamilyBatches(active.sourceInstanceId, active.registrationEpoch);

            let admissionAttempts     = 0;
            let casConflicts          = 0;
            let idempotentReceiptHits = 0;

            for (const batch of familyBatches) {
                admissionAttempts++;
                const res = CommunityBatchAdmissionService.admitBatch(batch);
                if (res.status === 'conflict') casConflicts++;
                if (res.status === 'idempotent') idempotentReceiptHits++;
            }

            admissionAttempts++;
            const replayRes = CommunityBatchAdmissionService.admitBatch(familyBatches[0]);
            if (replayRes.status === 'idempotent') idempotentReceiptHits++;

            admissionAttempts++;
            const conflictRes = CommunityBatchAdmissionService.admitBatch({
                ...familyBatches[0],
                batchId          : 'cal-issues-stale',
                nextInventoryHash: 'inv-issues-stale'
            });
            if (conflictRes.status === 'conflict') casConflicts++;

            const birdView = await CommunityActivityService.query({
                windowStart: '2026-10-26T00:00:00.000Z',
                windowEnd  : '2026-10-27T00:00:00.000Z',
                limit      : 25
            });

            const claimTarget = birdView.items[0];
            const seenTarget  = birdView.items[1];
            await CommunityActivityService.claimTask({sourceEventId: claimTarget.sourceEventId});
            await CommunityActivityService.markSeen({sourceEventId: seenTarget.sourceEventId});

            const counts1 = await CommunityActivityService.projectAttentionCounts({
                sourceInstanceIds: [active.sourceInstanceId]
            });

            await CommunityActivityService.markSeen({sourceEventId: birdView.items[2].sourceEventId});
            const counts2 = await CommunityActivityService.projectAttentionCounts({
                sourceInstanceIds: [active.sourceInstanceId]
            });

            const checkpointRows = db.prepare(`
                SELECT resource_family, checkpoint_version, inventory_hash, provider_state, coverage, last_receipt_id
                FROM mc_community_checkpoint
                WHERE tenant_id = ?
                ORDER BY resource_family ASC
            `).all(fixture.tenantId);
            const observationRows = db.prepare(`
                SELECT occurrence_identity, provider_entity_id, occurrence_kind, occurred_at, attention_disposition, occurrence_digest
                FROM mc_community_observation
                WHERE tenant_id = ?
                ORDER BY provider_entity_id ASC
            `).all(fixture.tenantId);

            const checkpointBytesTotal     = Buffer.byteLength(JSON.stringify(checkpointRows), 'utf8');
            const admittedObservationBytes = Buffer.byteLength(JSON.stringify(observationRows), 'utf8');

            const deterministicCheckpoints = checkpointRows.map(({
                resource_family,
                checkpoint_version,
                inventory_hash,
                provider_state,
                coverage
            }) => ({
                resource_family,
                checkpoint_version,
                inventory_hash,
                provider_state,
                coverage
            }));

            const deterministicObservations = observationRows.map(({
                provider_entity_id,
                occurrence_kind,
                occurred_at,
                attention_disposition
            }) => ({
                provider_entity_id,
                occurrence_kind,
                occurred_at,
                attention_disposition
            }));

            return {
                runIndex,
                admittedEvents         : observationRows.length,
                eligibleUnclaimedCount : counts1.count,
                claimedCount           : counts1.measurement.claimedExcludedCount,
                admissionAttempts,
                casConflicts,
                idempotentReceiptHits,
                checkpointBytesTotal,
                partitionCount         : checkpointRows.length,
                admittedObservationBytes,
                hookPayloadBytes       : counts1.measurement.payloadBytes,
                hookSubmissions        : 1,
                replayedHookSubmissions: counts2.sourceWatermark === counts1.sourceWatermark ? 1 : 0,
                hookWatermark          : counts1.sourceWatermark,
                fixtureManifestHash    : hashEvidence(familyBatches.map(b => ({batchId: b.batchId, observations: b.observations}))),
                stateManifestHash      : hashEvidence({
                    checkpoints : deterministicCheckpoints,
                    observations: deterministicObservations,
                    projection  : {
                        status          : counts1.status,
                        count           : counts1.count,
                        oldestOccurredAt: counts1.oldestOccurredAt,
                        coverage        : {
                            basis              : counts1.coverage.basis,
                            snapshot           : counts1.coverage.snapshot,
                            sourceCount        : counts1.coverage.sourceCount,
                            activeSourceCount  : counts1.coverage.activeSourceCount,
                            completeSourceCount: counts1.coverage.completeSourceCount,
                            degraded           : counts1.coverage.degraded,
                            degradedReasons    : counts1.coverage.degradedReasons
                        },
                        measurement: counts1.measurement
                    }
                }),
                cycleDurationMs          : Math.max(1, Date.now() - startedMs)
            }
        })
    } finally {
        SourceRegistryService.set({db: prevRegistryDb, localSubjectId: prevSubject});
        CommunityBatchAdmissionService.set({db: prevAdmissionDb, attentionPolicy: prevPolicy});
        CommunityActivityService.set({db: prevActivityDb});
        if (GraphService.db?.storage) {
            GraphService.db.storage.db = prevStorageDb
        }
        try { db.close() } catch {}
        fsExtra.removeSync(tempDir)
    }
}

function resolveReportPath(requestedPath, completedAt) {
    if (requestedPath) {
        return path.resolve(PROJECT_ROOT, requestedPath)
    }
    const stamp = completedAt.replace(/[:.]/g, '-');
    return path.join(REPORT_DIR, `calibration-${stamp}.json`)
}

/**
 * @summary Runs the community policy calibration CLI and writes the JSON report.
 * @param {String[]} [argv]
 * @returns {Promise<Object>}
 */
export async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.helpText) {
        console.log(args.helpText);
        return {exitCode: 0}
    }

    const result = await runPolicyCalibration(args, {
        runSinglePass: executeLiveCalibrationPass,
        now          : () => new Date().toISOString()
    });

    const reportPath = resolveReportPath(args.output, result.report.generatedAt);
    fsExtra.outputJsonSync(reportPath, result.report, {spaces: 4});

    console.log(formatCalibrationSummary(result.report));
    console.log(`[calibrateCommunityActivityPolicy] report: ${reportPath}`);

    return {...result, reportPath}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main()
        .then(({exitCode = 0}) => {
            process.exitCode = exitCode
        })
        .catch(error => {
            console.error('[calibrateCommunityActivityPolicy] Fatal:', error);
            process.exitCode = 2
        });
}

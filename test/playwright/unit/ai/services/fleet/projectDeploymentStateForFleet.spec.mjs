import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import {
    DEPLOYMENT_STATE_PROJECTION_STATES,
    projectDeploymentMaintenanceForFleet,
    projectDeploymentServiceForFleet,
    projectDeploymentStateForFleet
} from '../../../../../../ai/services/fleet/projectDeploymentStateForFleet.mjs';

/**
 * A snapshot shaped like `DeploymentStateBridgeService#collectSnapshot`, deliberately LEAKING everything a
 * card must not carry. The row's shape is the WRITER's (#323): `status` is the folded string
 * (`foldMemoryPressureIntoStatus`), `classification` carries the class word beside its declared flag, and
 * `diagnosis` is a `container-health-diagnosis-decision` record whose inner `diagnosis` block holds the
 * recovery class and confidence.
 */
const leakingSnapshot = () => ({
    generatedAt: 1700000000000,
    services   : [{
        schemaVersion    : 1,
        recordType       : 'deployment-service-state',
        serviceKey       : 'mc-server',
        targetIdentity   : {kind: 'compose-service', id: 'mc-server'},
        observedAt       : 1700000000000,
        status           : 'degraded',
        memoryPressure   : {disposition: 'at-cap', reason: 'sustained-saturation', receipt: {samples: [1, 2, 3], windowMs: 60000}},
        inspect          : {containerId: 'a1b2c3', image: 'neo-agent-brain:dev', mounts: ['/Users/operator/.neo-ai/data:/app/.neo-ai-data']},
        stats            : {cpuPercent: 400, memoryBytes: 1073741824},
        logs             : {tail: ['[mc] token=sk-live-secret']},
        providerResidency: {model: 'gemma'},
        heapObservation  : {heapUsed: 12345},
        resolvedConfig   : {dataDir: '/Users/operator/.neo-ai/data', env: {NEO_MC_BEARER: 'bearer-secret'}},
        restartChurn     : {baseline: 'available', baselineWrite: 'ok', plannedRestarts: {reason: null, status: 'available'}, detecting: true},
        classification   : {serviceKey: 'mc-server', serviceClass: 'store', serviceClassDeclared: true, appliedMemoryThreshold: 90, requiredWindowMs: 60000, sampleCount: 12, stampCoverage: 1, memoryScope: 'container'},
        diagnosis        : {
            schemaVersion : 1,
            recordType    : 'container-health-diagnosis-decision',
            serviceKey    : 'mc-server',
            targetIdentity: {kind: 'compose-service', id: 'mc-server'},
            observedAt    : 1700000000000,
            status        : 'degraded',
            actionClass   : 'restart',
            diagnosis     : {
                diagnosisId  : 'container-health:mc-server:exhaustion:1700000000000',
                recoveryClass: 'exhaustion',
                confidence   : 0.95,
                evidenceFacts: [{type: 'runtime-read-failed', details: {operation: 'inspect', path: '/var/run/docker.sock'}}],
                source       : 'container-health-diagnostics',
                details      : {classificationReason: 'memory-saturation', sampleWindowMs: 60000}
            },
            facts: [{type: 'memory-saturation', details: {path: '/Users/operator/.neo-ai/data'}}]
        },
        proofs: [{kind: 'exec', command: 'docker inspect'}],
        errors: []
    }],
    bridgeDiagnostics: {socket: '/var/run/docker.sock'},
    recoveryRuns     : [{id: 'run-1'}],
    selfHeal         : {events: []},
    tenantRepoSync   : {repos: [{path: '/Users/operator/repos/private'}]},
    // the writer's maintenance shape (`collectMaintenanceSnapshot`): the retry phase and its success
    // anchor on `retry`, the verdict and reason codes on `health`, the receipt on `lastBackup`
    maintenance      : {
        durability    : {posture: 'off-host-required', targetPath: '/Users/operator/.neo-ai/off-host'},
        stagingResidue: {bytes: 0, root: '/Users/operator/.neo-ai/backups/staging'},
        retry         : {phase: 'healthy', retriesRemaining: 3, windowEndsAtMs: null, streakStartedAtMs: 1699990000000, interruptedAt: null, lastSuccessAt: '2023-11-14T19:26:40.000Z', lastSuccessAgeMs: 10000000, nextAttemptAtMs: 1700003600000},
        health        : {status: 'degraded', observationStatus: 'observed', reasonCodes: ['off-host-durability-unmet'], staleAfterMs: 90000000},
        lastBackup    : {
            schemaVersion    : 1,
            bundleName       : 'backup-2023-11-14T19-24-00.000Z',
            bundleCompletedAt: '2023-11-14T19:26:40.000Z',
            finishedAt       : '2023-11-14T19:26:40.657Z',
            backup           : {status: 'success', durationMs: 149102, error: null},
            offHostSync      : {status: 'disabled', completionScope: 'direct-child', descendants: 'unknown', durationMs: null, exitCode: null, signal: null, stderrTail: 'rsync: /Users/operator/.neo-ai/off-host', terminatedVia: null}
        }
    },
    heavyMaintenanceStarvation: {
        taskName: 'heavy-maintenance-starvation-watchdog',
        posture : 'degraded',
        breaches: [{waiter: 'summary', leaseOwner: 'pid-4242', deferredSince: 1699999000000}, {waiter: 'defrag', leaseOwner: 'pid-4242'}]
    }
});

/**
 * One service row VERBATIM from the live plane (snapshot `generatedAt` 1788568958677, read 2026-09-05T00:42Z),
 * bounded to the fields the projection reads plus the record envelope — the shape the writer actually
 * emits, which the guessed fixture above never was (#323).
 */
const liveChromaRow = () => ({
    schemaVersion : 1,
    recordType    : 'deployment-service-state',
    serviceKey    : 'chroma',
    targetIdentity: {kind: 'compose-service', id: 'chroma'},
    observedAt    : 1788568959783,
    status        : 'available',
    memoryPressure: {disposition: 'below', reason: null, receipt: null},
    restartChurn  : {baseline: 'available', baselineWrite: 'written', plannedRestarts: {reason: null, status: 'available'}, detecting: true},
    classification: {serviceKey: 'chroma', serviceClass: 'store', serviceClassDeclared: true, appliedMemoryThreshold: 80, observedWindowMs: 33695, requiredWindowMs: 30000, sampleCount: 2, stampCoverage: 1, memoryScope: 'container', memoryObservedWindowMs: 33695, memoryStampCoverage: 1},
    diagnosis     : {
        schemaVersion : 1,
        recordType    : 'container-health-diagnosis-decision',
        serviceKey    : 'chroma',
        targetIdentity: {kind: 'compose-service', id: 'chroma'},
        observedAt    : 1788568959783,
        status        : 'healthy',
        actionClass   : null,
        diagnosis     : null,
        facts         : []
    }
});

const LEAK_MARKERS = ['/Users/', '/var/run', 'docker', 'sk-live', 'bearer-secret', 'pid-4242', 'mounts', 'evidenceFacts', 'proofs', 'resolvedConfig', 'inspect', 'logs', 'stats', 'heapObservation', 'receipt', 'facts', 'targetIdentity', 'diagnosisId', '"durability":', 'stagingResidue', 'stderrTail', 'bundleName', 'targetPath'];

test.describe('projectDeploymentStateForFleet — the bounded, redacted wire shape of the deployment snapshot (#314)', () => {
    test('RED-FIRST on the leak: nothing a card must not carry survives projection', () => {
        const serialized = JSON.stringify(projectDeploymentStateForFleet(leakingSnapshot(), {ageMs: 1000, staleAfterMs: 120000}));

        for (const marker of LEAK_MARKERS) {
            expect(serialized, `leaked marker: ${marker}`).not.toContain(marker);
        }
    });

    test('keeps exactly the card fields, under the snapshot\'s own names', () => {
        const projection = projectDeploymentStateForFleet(leakingSnapshot(), {ageMs: 1000, staleAfterMs: 120000});

        expect(projection.state).toBe(DEPLOYMENT_STATE_PROJECTION_STATES.ok);
        expect(projection.reason).toBeNull();
        expect(projection.generatedAt).toBe(1700000000000);
        expect(projection.ageMs).toBe(1000);
        expect(projection.services).toEqual([{
            serviceKey    : 'mc-server',
            observedAt    : 1700000000000,
            status        : 'degraded',
            memoryPressure: {disposition: 'at-cap', reason: 'sustained-saturation'},
            restartChurn  : {baseline: 'available', detecting: true},
            classification: {serviceClass: 'store', serviceClassDeclared: true, appliedMemoryThreshold: 90, sampleCount: 12},
            diagnosis     : {status: 'degraded', actionClass: 'restart', recoveryClass: 'exhaustion', confidence: 0.95}
        }]);
        expect(projection.maintenance).toEqual({
            backup    : {
                phase           : 'healthy',
                lastSuccessAt   : '2023-11-14T19:26:40.000Z',
                lastSuccessAgeMs: 10000000,
                health          : {status: 'degraded', reasonCodes: ['off-host-durability-unmet']},
                lastBackup      : {finishedAt: '2023-11-14T19:26:40.657Z', status: 'success', offHostSync: 'disabled'}
            },
            starvation: {posture: 'degraded', breachCount: 2}
        });
    });

    // #323, the maintenance half: the live plane writes no `retry` block until the lane has task state,
    // the verdict rides `health`, and an unreadable receipt carries its status at the root
    test('a maintenance block without retry state projects a null phase, keeps the health verdict, and reads an unreadable receipt at its root', () => {
        expect(projectDeploymentMaintenanceForFleet({
            maintenance: {
                health    : {status: 'degraded', observationStatus: 'observed', reasonCodes: ['backup-never-succeeded', 'backup-retry-exhausted', 7], staleAfterMs: 90000000},
                lastBackup: {finishedAt: null, kind: 'corrupt', status: 'unreadable'}
            }
        })).toEqual({
            backup    : {
                phase           : null,
                lastSuccessAt   : null,
                lastSuccessAgeMs: null,
                health          : {status: 'degraded', reasonCodes: ['backup-never-succeeded', 'backup-retry-exhausted']},
                lastBackup      : {finishedAt: null, status: 'unreadable', offHostSync: null}
            },
            starvation: null
        });
    });

    // #323 RED-FIRST: the writer folds the status into ONE word and wraps the diagnosis in a decision
    // record; a projection written to a guessed block shape read every live service as unobserved
    test('a VERBATIM live row projects its folded status word, its class word and its healthy decision (#323)', () => {
        expect(projectDeploymentServiceForFleet(liveChromaRow())).toEqual({
            serviceKey    : 'chroma',
            observedAt    : 1788568959783,
            status        : 'available',
            memoryPressure: {disposition: 'below', reason: null},
            restartChurn  : {baseline: 'available', detecting: true},
            classification: {serviceClass: 'store', serviceClassDeclared: true, appliedMemoryThreshold: 80, sampleCount: 2},
            diagnosis     : {status: 'healthy', actionClass: null, recoveryClass: null, confidence: null}
        });
    });

    test('an age beyond the horizon reads STALE and still carries the last known picture', () => {
        const projection = projectDeploymentStateForFleet(leakingSnapshot(), {ageMs: 120001, staleAfterMs: 120000});

        expect(projection.state).toBe(DEPLOYMENT_STATE_PROJECTION_STATES.stale);
        expect(projection.ageMs).toBe(120001);
        expect(projection.services).toHaveLength(1);
    });

    test('no snapshot is UNAVAILABLE with the reader\'s reason, empty services, no maintenance — never a fabricated plane', () => {
        expect(projectDeploymentStateForFleet(null, {reason: 'no-deployment-state-snapshot'})).toEqual({
            state      : DEPLOYMENT_STATE_PROJECTION_STATES.unavailable,
            reason     : 'no-deployment-state-snapshot',
            generatedAt: null,
            ageMs      : null,
            services   : [],
            maintenance: {backup: null, starvation: null}
        });
        expect(projectDeploymentStateForFleet('not-an-object').reason).toBe('snapshot-unreadable');
        expect(projectDeploymentStateForFleet([]).state).toBe(DEPLOYMENT_STATE_PROJECTION_STATES.unavailable);
    });

    test('a record missing a block projects that block as null — a missing field is never invented', () => {
        expect(projectDeploymentServiceForFleet({serviceKey: 'ingress', observedAt: 5})).toEqual({
            serviceKey    : 'ingress',
            observedAt    : 5,
            status        : null,
            memoryPressure: null,
            restartChurn  : null,
            classification: null,
            diagnosis     : null
        });
        // a decision without an inner diagnosis (the healthy arm) keeps its own status and action class
        expect(projectDeploymentServiceForFleet({serviceKey: 'kb-server', diagnosis: {status: 'healthy'}}).diagnosis)
            .toEqual({status: 'healthy', actionClass: null, recoveryClass: null, confidence: null});
        // a status that is not the writer's word — the pre-#323 block shape included — is unknown, never a guess
        expect(projectDeploymentServiceForFleet({serviceKey: 'kb-server', status: {status: 'degraded', disposition: 'at-cap'}}).status).toBeNull();
        expect(projectDeploymentMaintenanceForFleet({maintenance: {}})).toEqual({
            backup    : {phase: null, lastSuccessAt: null, lastSuccessAgeMs: null, health: null, lastBackup: null},
            starvation: null
        });
        expect(projectDeploymentMaintenanceForFleet({})).toEqual({backup: null, starvation: null});
    });

    test('non-record rows are dropped and the projection is a fresh object each call', () => {
        const snapshot = {generatedAt: 1, services: [null, 'x', {serviceKey: 'chroma'}]};
        const a        = projectDeploymentStateForFleet(snapshot, {ageMs: 0, staleAfterMs: 1});
        const b        = projectDeploymentStateForFleet(snapshot, {ageMs: 0, staleAfterMs: 1});

        expect(a.services.map(row => row.serviceKey)).toEqual(['chroma']);
        expect(a).not.toBe(b);
        expect(a.services[0]).not.toBe(b.services[0]);
    });
});

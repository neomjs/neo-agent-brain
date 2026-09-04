import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import {
    DEPLOYMENT_STATE_PROJECTION_STATES,
    projectDeploymentMaintenanceForFleet,
    projectDeploymentServiceForFleet,
    projectDeploymentStateForFleet
} from '../../../../../../ai/services/fleet/projectDeploymentStateForFleet.mjs';

/** A snapshot shaped like `DeploymentStateBridgeService#collectSnapshot`, deliberately LEAKING everything a card must not carry. */
const leakingSnapshot = () => ({
    generatedAt: 1700000000000,
    services   : [{
        schemaVersion    : 1,
        recordType       : 'deployment-service-state',
        serviceKey       : 'mc-server',
        targetIdentity   : {kind: 'compose-service', id: 'mc-server'},
        observedAt       : 1700000000000,
        status           : {status: 'degraded', disposition: 'at-cap'},
        memoryPressure   : {disposition: 'at-cap', reason: 'sustained-saturation', receipt: {samples: [1, 2, 3], windowMs: 60000}},
        inspect          : {containerId: 'a1b2c3', image: 'neo-agent-brain:dev', mounts: ['/Users/operator/.neo-ai/data:/app/.neo-ai-data']},
        stats            : {cpuPercent: 400, memoryBytes: 1073741824},
        logs             : {tail: ['[mc] token=sk-live-secret']},
        providerResidency: {model: 'gemma'},
        heapObservation  : {heapUsed: 12345},
        resolvedConfig   : {dataDir: '/Users/operator/.neo-ai/data', env: {NEO_MC_BEARER: 'bearer-secret'}},
        restartChurn     : {baseline: 'available', baselineWrite: 'ok', plannedRestarts: {reason: null, status: 'available'}, detecting: true},
        classification   : {serviceClassDeclared: 'store', appliedMemoryThreshold: 0.9, requiredWindowMs: 60000, sampleCount: 12, stampCoverage: 1},
        diagnosis        : {
            diagnosisId  : 'diag-1',
            recoveryClass: 'restart-recoverable',
            confidence   : 0.8,
            evidenceFacts: [{type: 'runtime-read-failed', details: {operation: 'inspect', path: '/var/run/docker.sock'}}],
            source       : 'container-health-diagnostics',
            details      : {actionClass: 'observe', classificationReason: 'memory-saturation', sampleWindowMs: 60000}
        },
        proofs: [{kind: 'exec', command: 'docker inspect'}],
        errors: []
    }],
    bridgeDiagnostics: {socket: '/var/run/docker.sock'},
    recoveryRuns     : [{id: 'run-1'}],
    selfHeal         : {events: []},
    tenantRepoSync   : {repos: [{path: '/Users/operator/repos/private'}]},
    maintenance      : {
        stagingResidue: {bytes: 0},
        retry         : {attempts: 1},
        lastBackup    : {finishedAt: 1699990000000, kind: 'full', status: 'ok', archivePath: '/Users/operator/.neo-ai/backups/b.tgz'},
        health        : {phase: 'healthy', lastSuccessAt: 1699990000000, lastSuccessAgeMs: 10000000, nextAttemptAtMs: 1700003600000, retriesRemaining: 3}
    },
    heavyMaintenanceStarvation: {
        taskName: 'heavy-maintenance-starvation-watchdog',
        posture : 'degraded',
        breaches: [{waiter: 'summary', leaseOwner: 'pid-4242', deferredSince: 1699999000000}, {waiter: 'defrag', leaseOwner: 'pid-4242'}]
    }
});

const LEAK_MARKERS = ['/Users/', '/var/run', 'docker', 'sk-live', 'bearer-secret', 'pid-4242', 'archivePath', 'mounts', 'evidenceFacts', 'proofs', 'resolvedConfig', 'inspect', 'logs', 'stats', 'heapObservation', 'receipt'];

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
            status        : {status: 'degraded', disposition: 'at-cap'},
            memoryPressure: {disposition: 'at-cap', reason: 'sustained-saturation'},
            restartChurn  : {baseline: 'available', detecting: true},
            classification: {serviceClassDeclared: 'store', appliedMemoryThreshold: 0.9, sampleCount: 12},
            diagnosis     : {recoveryClass: 'restart-recoverable', confidence: 0.8, actionClass: 'observe', classificationReason: 'memory-saturation'}
        }]);
        expect(projection.maintenance).toEqual({
            backup    : {
                phase           : 'healthy',
                lastSuccessAt   : 1699990000000,
                lastSuccessAgeMs: 10000000,
                lastBackup      : {finishedAt: 1699990000000, kind: 'full', status: 'ok'}
            },
            starvation: {posture: 'degraded', breachCount: 2}
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
        expect(projectDeploymentServiceForFleet({serviceKey: 'kb-server', diagnosis: {recoveryClass: 'none'}}).diagnosis)
            .toEqual({recoveryClass: 'none', confidence: null, actionClass: null, classificationReason: null});
        expect(projectDeploymentMaintenanceForFleet({maintenance: {}})).toEqual({
            backup    : {phase: null, lastSuccessAt: null, lastSuccessAgeMs: null, lastBackup: null},
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

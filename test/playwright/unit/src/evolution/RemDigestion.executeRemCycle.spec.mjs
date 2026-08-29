import {test, expect}                   from '@playwright/test';
import Neo                              from 'neo.mjs/src/Neo.mjs';
import * as core                        from 'neo.mjs/src/core/_export.mjs';
import {createRemDigestion}             from '../../../../../src/evolution/createRemDigestion.mjs';
import EvolutionConfig                  from '../../../../../src/evolution/config.template.mjs';
import {mkdtemp, readdir, readFile, rm} from 'fs/promises';
import os                               from 'os';
import path                             from 'path';

const RemDigestion     = createRemDigestion();
const EXECUTION_POLICY = {
    configuredCadenceMs: 1000,
    overflowThreshold  : 0.8
};

function executeRemCycle(options = {}) {
    return RemDigestion.executeRemCycle({...EXECUTION_POLICY, ...options});
}

/**
 * @summary Focused coverage for the typed-outcome contract of `RemDigestion.executeRemCycle()`.
 *
 * The keystone insight: the periodic dream path used to map every non-throwing return
 * from `processUndigestedSessions()` to `completed`, hiding silent no-ops (zero
 * undigested sessions, concurrent-invocation, provider unreachable). The unified
 * `executeRemCycle()` returns a typed outcome envelope so the no-op + failure paths
 * surface as distinct stage outcomes when consumers map the outcome to their
 * task-state / health-telemetry surfaces.
 *
 * Tests live with the Evolution use case. `RemDigestion` owns the REM pipeline;
 * the Orchestrator delegates and maps the typed outcome.
 *
 * The default composition is one process-scoped instance; tests stub that composition and
 * restore originals in `afterEach` for cross-test isolation.
 */

const ORIGINAL_KEYS = [
    'isProcessing',
    'findUndigestedSessions',
    'processUndigestedSessions',
    'checkProviderReadiness'
];

let originals;
let configOriginals;
let tmpDir;

async function readOnlyRunStateEntry() {
    const files = await readdir(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^rem-.*\.jsonl$/);

    const lines = (await readFile(path.join(tmpDir, files[0]), 'utf8')).trim().split('\n');
    return JSON.parse(lines[0]);
}

test.beforeEach(async () => {
    originals = Object.fromEntries(ORIGINAL_KEYS.map(key => [key, RemDigestion[key]]));
    configOriginals = {
        remRunStateDir      : EvolutionConfig.remRunStateDir,
        remRunRetentionLimit: EvolutionConfig.remRunRetentionLimit
    };
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'neo-dream-cycle-state-'));

    EvolutionConfig.remRunStateDir       = tmpDir;
    EvolutionConfig.remRunRetentionLimit = 3;

    RemDigestion.isProcessing              = false;
    RemDigestion.findUndigestedSessions    = async () => [];
    RemDigestion.processUndigestedSessions = async () => {};
    RemDigestion.checkProviderReadiness    = async () => ({ready: true});
});

test.afterEach(async () => {
    for (const key of ORIGINAL_KEYS) {
        RemDigestion[key] = originals[key];
    }

    EvolutionConfig.remRunStateDir       = configOriginals.remRunStateDir;
    EvolutionConfig.remRunRetentionLimit = configOriginals.remRunRetentionLimit;

    await rm(tmpDir, {recursive: true, force: true});
});

test.describe('RemDigestion.executeRemCycle typed outcome contract', () => {
    test('Sub 9 hypotheses 2, 6, 8: provider readiness failure writes failed providerReady state (#12617)', async () => {
        RemDigestion.checkProviderReadiness = async () => ({
            ready     : false,
            diagnostic: {
                reason       : 'PROVIDER_READINESS_TIMEOUT',
                provider     : 'openAiCompatible',
                graphProvider: 'openAiCompatible',
                host         : 'http://127.0.0.1:13090'
            }
        });

        const outcome = await executeRemCycle({reason: 'unit-test'});

        expect(outcome.status).toBe('failed');
        expect(outcome.diagnostic).toEqual({
            reason       : 'PROVIDER_READINESS_TIMEOUT',
            provider     : 'openAiCompatible',
            graphProvider: 'openAiCompatible',
            host         : 'http://127.0.0.1:13090'
        });
        expect(outcome.error).toBeNull();
        expect(outcome.sessionsProcessed).toBeNull();
        expect(outcome.runId).toMatch(/^rem-/);
        expect(outcome.completedAt).toBeTruthy();
        expect(outcome.durationMs).toBeGreaterThanOrEqual(0);

        const entry = await readOnlyRunStateEntry();
        expect(entry.outcome).toBe('failed');
        expect(entry.reasonCode).toBe('provider-unreachable');
        expect(entry.failurePhase).toBe('providerReady');
        expect(entry.failureReason).toBe('PROVIDER_READINESS_TIMEOUT');
        expect(entry.cycleScopePhases).toEqual(['providerReady']);
        expect(entry.perPhaseStates[0]).toMatchObject({
            phase  : 'providerReady',
            status : 'failed',
            details: {
                diagnostic: {
                    provider     : 'openAiCompatible',
                    graphProvider: 'openAiCompatible'
                }
            }
        });
    });

    test('returns failed status when provider-readiness config validation throws', async () => {
        RemDigestion.checkProviderReadiness = async () => {
            throw new TypeError('AiConfig.orchestrator.providerReadiness is required');
        };

        const outcome = await executeRemCycle({reason: 'missing-config-test'});

        expect(outcome.status).toBe('failed');
        expect(outcome.error?.message).toContain('checkProviderReadiness threw');
        expect(outcome.error?.message).toContain('providerReadiness is required');
        expect(outcome.sessionsProcessed).toBeNull();
        expect(outcome.diagnostic).toBeNull();
    });

    test('returns skipped status when dryRun=true after gate passes', async () => {
        const outcome = await executeRemCycle({reason: 'dry-run-test', dryRun: true});

        expect(outcome.status).toBe('skipped');
        expect(outcome.skipReason).toBe('dry-run requested');
        expect(outcome.diagnostic).toBeNull();
        expect(outcome.error).toBeNull();
    });

    test('returns skipped with concurrent-invocation reason when isProcessing is true', async () => {
        RemDigestion.isProcessing = true;

        const outcome = await executeRemCycle({reason: 'concurrent-test'});

        expect(outcome.status).toBe('skipped');
        expect(outcome.skipReason).toContain('remDigestion.isProcessing already true');
    });

    test('Sub 9 hypotheses 1 and 3: already-processing skip is durable typed cycle state (#12617)', async () => {
        RemDigestion.isProcessing = true;

        const outcome = await executeRemCycle({reason: 'already-processing-state-test'});

        expect(outcome.status).toBe('skipped');
        expect(outcome.skipReason).toContain('already true');

        const entry = await readOnlyRunStateEntry();
        expect(entry.outcome).toBe('skipped');
        expect(entry.reasonCode).toBe('already-processing');
        expect(entry.failurePhase).toBeNull();
        expect(entry.lastSuccessfulPhase).toBe('providerReady');
        expect(entry.cycleScopePhases).toEqual(['providerReady', 'concurrentGuard']);
        expect(entry.perPhaseStates[1]).toMatchObject({
            phase  : 'concurrentGuard',
            status : 'skipped',
            details: {reasonCode: 'already-processing'}
        });
        expect(entry.perSessionStates).toEqual([]);
    });

    test('returns skipped with sessionsProcessed=0 when no undigested sessions exist', async () => {
        RemDigestion.findUndigestedSessions = async () => [];

        let processCalled = false;
        RemDigestion.processUndigestedSessions = async () => {
            processCalled = true;
        };

        const outcome = await executeRemCycle({reason: 'no-sessions-test', includeDecay: false});

        expect(outcome.status).toBe('skipped');
        expect(outcome.sessionsProcessed).toBe(0);
        expect(outcome.skipReason).toBe('no undigested sessions');
        expect(processCalled).toBe(false);
    });

    test('returns completed with sessionsProcessed=N when sessions exist + processing succeeds', async () => {
        RemDigestion.findUndigestedSessions    = async () => [{id: 'session-a'}, {id: 'session-b'}];
        RemDigestion.processUndigestedSessions = async () => {};

        const outcome = await executeRemCycle({reason: 'completed-test', includeDecay: false});

        expect(outcome.status).toBe('completed');
        expect(outcome.sessionsProcessed).toBe(2);
        expect(outcome.remBatchLimit).toBe(EvolutionConfig.remSleepBatchLimit);
        expect(outcome.remBatchSaturated).toBe(false);
        expect(outcome.error).toBeNull();
        expect(outcome.skipReason).toBeNull();
    });

    test('marks REM outcome as saturated when the processed count reaches the batch limit (#13971)', async () => {
        const sessions = Array.from({length: EvolutionConfig.remSleepBatchLimit}, (_, index) => ({id: `session-${index}`}));

        RemDigestion.findUndigestedSessions    = async () => sessions;
        RemDigestion.processUndigestedSessions = async () => {};

        const outcome = await executeRemCycle({reason: 'saturated-test', includeDecay: false});

        expect(outcome.status).toBe('completed');
        expect(outcome.sessionsProcessed).toBe(EvolutionConfig.remSleepBatchLimit);
        expect(outcome.remBatchLimit).toBe(EvolutionConfig.remSleepBatchLimit);
        expect(outcome.remBatchSaturated).toBe(true);
    });

    test('Sub 9 hypotheses 10 and 11: failed phase from processing is persisted into REM run state (#12617)', async () => {
        const failedSessionState = {
            sessionId          : 'session-topology-failure',
            payloadSizeTokens  : 42,
            memorySessionIngest: {status: 'completed', errorReasons: []},
            triVector          : {status: 'completed', attempts: 1},
            topology           : {status: 'failed', conflictCount: 0},
            gapSession         : {status: 'skipped'},
            graphDigestedFlag  : false,
            failureReasons     : ['topology provider failed']
        };
        const error = new Error('topology provider failed');
        error.remState = {
            perPhaseStates: [{
                phase      : 'topology',
                startedAt  : 100,
                completedAt: 150,
                wallClockMs: 50,
                status     : 'failed',
                details    : {
                    sessionId: 'session-topology-failure',
                    error    : 'topology provider failed'
                }
            }],
            perSessionStates: [failedSessionState]
        };

        RemDigestion.findUndigestedSessions = async () => [{id: 'session-a'}];
        RemDigestion.processUndigestedSessions = async () => {
            throw error;
        };

        const outcome = await executeRemCycle({
            reason      : 'topology-failure-state-test',
            includeDecay: false
        });

        expect(outcome.status).toBe('failed');
        expect(outcome.sessionsProcessed).toBe(1);

        const entry = await readOnlyRunStateEntry();
        expect(entry.outcome).toBe('failed');
        expect(entry.reasonCode).toBe('extraction-failed');
        expect(entry.failurePhase).toBe('topology');
        expect(entry.failureReason).toBe('topology provider failed');
        expect(entry.cycleScopePhases).toContain('topology');
        expect(entry.perSessionStates).toEqual([failedSessionState]);
    });

    test('Sub 9 hypotheses 11 and 12: non-throwing per-session failures remain visible without graphDigested (#12617)', async () => {
        const failedSessionState = {
            sessionId          : 'session-null-result',
            payloadSizeTokens  : 100000,
            memorySessionIngest: {status: 'completed', errorReasons: []},
            triVector          : {status: 'failed', attempts: 3, errorKind: 'null-result'},
            topology           : {status: 'completed', conflictCount: 0},
            gapSession         : {status: 'completed'},
            graphDigestedFlag  : false,
            failureReasons     : ['tri-vector extraction returned null']
        };

        RemDigestion.findUndigestedSessions = async () => [{id: 'session-a'}];
        RemDigestion.processUndigestedSessions = async () => ({
            perPhaseStates: [{
                phase      : 'triVector',
                startedAt  : 200,
                completedAt: 275,
                wallClockMs: 75,
                status     : 'failed',
                details    : {sessionId: 'session-null-result'}
            }],
            perSessionStates: [failedSessionState]
        });

        const outcome = await executeRemCycle({
            reason      : 'null-result-session-state-test',
            includeDecay: false
        });

        // Current-dev Phase A boundary: the cycle outcome is still completed, but the
        // per-session state exposes the null-result and prevents graphDigested overclaim.
        expect(outcome.status).toBe('completed');

        const entry = await readOnlyRunStateEntry();
        expect(entry.reasonCode).toBe('ok');
        expect(entry.cycleScopePhases).toContain('triVector');
        expect(entry.perSessionStates).toEqual([failedSessionState]);
        expect(entry.perSessionStates[0].graphDigestedFlag).toBe(false);
        expect(entry.perSessionStates[0].failureReasons).toEqual(['tri-vector extraction returned null']);
    });

    test('returns failed status when processUndigestedSessions throws', async () => {
        RemDigestion.findUndigestedSessions    = async () => [{id: 'session-a'}];
        RemDigestion.processUndigestedSessions = async () => {
            throw new Error('synthetic processing failure');
        };

        const outcome = await executeRemCycle({reason: 'failure-test', includeDecay: false});

        expect(outcome.status).toBe('failed');
        expect(outcome.sessionsProcessed).toBe(1);
        expect(outcome.error?.message).toBe('synthetic processing failure');
        expect(outcome.error?.stack).toBeTruthy();
        expect(outcome.diagnostic).toBeNull();
    });

    test('returns failed status when findUndigestedSessions throws', async () => {
        RemDigestion.findUndigestedSessions = async () => {
            throw new Error('synthetic find failure');
        };

        const outcome = await executeRemCycle({reason: 'find-failure-test'});

        expect(outcome.status).toBe('failed');
        expect(outcome.error?.message).toContain('findUndigestedSessions threw');
        expect(outcome.error?.message).toContain('synthetic find failure');
        expect(outcome.sessionsProcessed).toBeNull();
    });

    test('runId is unique per call', async () => {
        const outcomes = await Promise.all([
            executeRemCycle({reason: 'unique-1', dryRun: true}),
            executeRemCycle({reason: 'unique-2', dryRun: true}),
            executeRemCycle({reason: 'unique-3', dryRun: true})
        ]);

        const runIds = outcomes.map(o => o.runId);
        const unique = new Set(runIds);

        expect(unique.size).toBe(3);
    });

    test('preserves reason + mode in outcome envelope', async () => {
        const outcome = await executeRemCycle({
            reason: 'periodic-dream:3600000',
            mode  : 'periodic',
            dryRun: true
        });

        expect(outcome.reason).toBe('periodic-dream:3600000');
        expect(outcome.mode).toBe('periodic');
    });

    test('writes durable REM run-state JSONL with phase telemetry', async () => {
        const outcome = await executeRemCycle({
            reason: 'state-write-test',
            dryRun: true
        });

        const entry = await readOnlyRunStateEntry();

        expect(outcome.stateWriteError).toBeUndefined();
        expect(entry.runId).toBe(outcome.runId);
        expect(entry.reason).toBe('state-write-test');
        expect(entry.outcome).toBe('skipped');
        expect(entry.reasonCode).toBe('dry-run');
        expect(entry.configuredCadenceMs).toBe(1000);
        expect(entry.cycleOverflowSignal).toBe(false);
        expect(entry.cycleScopePhases).toEqual(['providerReady', 'dryRun']);
        expect(entry.perPhaseStates.map(phase => phase.phase)).toEqual(['providerReady', 'dryRun']);
        expect(entry.perSessionStates).toEqual([]);
    });

    test('surfaces overflow evidence without owning Orchestrator logging', async () => {
        const originalNow = RemDigestion.nowFn;
        const ticks       = [1000, 1000, 1100, 1700, 1800, 2100];
        let   outcome;

        RemDigestion.nowFn = () => ticks.length > 0 ? ticks.shift() : 2100;

        try {
            outcome = await executeRemCycle({
                reason: 'overflow-warning-test',
                dryRun: true
            });
        } finally {
            RemDigestion.nowFn = originalNow;
        }

        expect(outcome.cycleOverflowSignal).toBe(true);
        expect(outcome.configuredCadenceMs).toBe(EXECUTION_POLICY.configuredCadenceMs);
        expect(outcome.overflowThreshold).toBe(EXECUTION_POLICY.overflowThreshold);
        expect(outcome.wallClockMs).toBeGreaterThan(
            EXECUTION_POLICY.configuredCadenceMs * EXECUTION_POLICY.overflowThreshold
        );
    });

    test('surfaces malformed caller policy without hiding the typed outcome', async () => {
        // The Orchestrator owns cadence policy and passes it into the use case. A malformed
        // overflow threshold propagates to `finalize()`, where
        // `createRemRunStateEntry` rejects any non-positive-number threshold; the throw is
        // caught into `stateWriteError` while the typed `skipped` outcome still surfaces.
        const outcome = await executeRemCycle({
            reason           : 'stale-config-test',
            dryRun           : true,
            overflowThreshold: null
        });

        expect(outcome.status).toBe('skipped');
        expect(outcome.stateWriteError).toContain('overflowThreshold must be a positive number');
    });

    test('a budget-clipped cycle maps to completed + saturated with honest counts, so the backlog catch-up re-queues it (#17046)', async () => {
        // The lease belongs to the caller and releases when the task returns; what makes the clip safe
        // is this mapping — proven-remaining work MUST surface as `remBatchSaturated` so the scheduler's
        // existing catch-up cooldown re-queues the deferred sessions instead of losing them until the
        // next periodic interval.
        const originalBatchLimit = EvolutionConfig.remSleepBatchLimit;
        EvolutionConfig.remSleepBatchLimit = 10; // count-saturation cannot fire with 3 sessions — saturation must come from the clip alone

        try {
            RemDigestion.findUndigestedSessions    = async () => [{}, {}, {}];
            RemDigestion.processUndigestedSessions = async options => {
                expect(options.cycleBudgetMs).toBe(250);
                return {
                    perPhaseStates: [{
                        phase  : 'cycleBudget',
                        status : 'completed',
                        details: {reasonCode: 'budget-exhausted', budgetMs: 250, elapsedMs: 260, sessionsDeferred: 2}
                    }],
                    perSessionStates : [],
                    sessionsProcessed: 1,
                    sessionsDeferred : 2
                };
            };

            const outcome = await executeRemCycle({
                reason       : 'unit-test-budget',
                includeDecay : false,
                cycleBudgetMs: 250
            });

            expect(outcome.status).toBe('completed');
            expect(outcome.reasonCode).toBe('budget-clipped');
            expect(outcome.sessionsProcessed).toBe(1);
            expect(outcome.sessionsDeferred).toBe(2);
            expect(outcome.remBatchSaturated).toBe(true);

            const entry = await readOnlyRunStateEntry();
            expect(entry.outcome).toBe('completed');
            expect(entry.reasonCode).toBe('budget-clipped');
            expect(entry.perPhaseStates.map(phase => phase.phase)).toContain('cycleBudget');
        } finally {
            EvolutionConfig.remSleepBatchLimit = originalBatchLimit;
        }
    });

    test('an unclipped completed cycle keeps reasonCode ok and honest actual counts (#17046)', async () => {
        const originalBatchLimit = EvolutionConfig.remSleepBatchLimit;
        EvolutionConfig.remSleepBatchLimit = 10;

        try {
            RemDigestion.findUndigestedSessions    = async () => [{}, {}];
            RemDigestion.processUndigestedSessions = async () => ({
                perPhaseStates   : [],
                perSessionStates : [],
                sessionsProcessed: 2,
                sessionsDeferred : 0
            });

            const outcome = await executeRemCycle({reason: 'unit-test-unclipped', includeDecay: false});

            expect(outcome.status).toBe('completed');
            expect(outcome.reasonCode).toBe('ok');
            expect(outcome.sessionsProcessed).toBe(2);
            expect(outcome.sessionsDeferred).toBe(0);
            expect(outcome.remBatchSaturated).toBe(false);
        } finally {
            EvolutionConfig.remSleepBatchLimit = originalBatchLimit;
        }
    });
});

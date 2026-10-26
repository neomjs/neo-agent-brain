import {setup} from '../../../../setup.mjs';

setup({
    neoConfig: {unitTestMode: true},
    appConfig: {
        name             : 'CommunityPolicyCalibrationTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {expect, test} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import aiConfig       from '../../../../../../ai/config.template.mjs';
import {
    CALIBRATION_REPORT_SCHEMA_VERSION,
    OPTION_REVALIDATION_LEDGER,
    SHADOW_BASELINE_MANIFEST,
    assertCalibrationReport,
    deriveCalibratedPolicy,
    formatCalibrationSummary,
    parseArgs,
    runPolicyCalibration
} from '../../../../../../ai/scripts/maintenance/communityActivityPolicyCalibrationCore.mjs';
import {
    DEFAULT_CALIBRATION_FIXTURE,
    executeLiveCalibrationPass
} from '../../../../../../ai/scripts/maintenance/calibrateCommunityActivityPolicy.mjs';

test.describe('communityActivityPolicyCalibrationCore', () => {
    test('parseArgs enforces repeatable multi-run calibration and supports --help', () => {
        expect(parseArgs(['--help']).helpText).toContain('calibrateCommunityActivityPolicy');
        expect(parseArgs([])).toEqual({runs: 2});
        expect(parseArgs(['--runs', '3', '--output', 'tmp/out.json'])).toEqual({
            output: 'tmp/out.json',
            runs  : 3
        });
        expect(() => parseArgs(['--runs', '1'])).toThrow(/--runs must be an integer >= 2/);
    });

    test('executes two-run deterministic fixture calibration, separates shadow/fixture/unknown evidence classes, and keeps unmeasured thresholds unset', async () => {
        let   tick               = 0;
        const clocks             = ['2026-10-26T22:00:00.000Z', '2026-10-26T22:00:01.000Z'];
        const {exitCode, report} = await runPolicyCalibration({runs: 2}, {
            now           : () => clocks[tick++] || '2026-10-26T22:00:02.000Z',
            runSinglePass : executeLiveCalibrationPass,
            shadowBaseline: SHADOW_BASELINE_MANIFEST
        });

        expect(exitCode).toBe(0);
        expect(report.schemaVersion).toBe(CALIBRATION_REPORT_SCHEMA_VERSION);
        expect(report.repeatability.evidenceStatus).toBe('two-run-fixture-determinism');
        expect(report.repeatability.comparable).toBe(true);
        expect(Object.values(report.repeatability.deterministicVariance).every(delta => delta === 0)).toBe(true);
        expect(report.repeatability.runs[0].stateManifestHash).toBe(report.repeatability.runs[1].stateManifestHash);

        expect(report.metrics.pagesPerEvent).toMatchObject({
            denominator: 11_253,
            numerator  : 1_739,
            status     : 'measured'
        });
        expect(report.metrics.providerAcquisitionLatencyMs).toMatchObject({
            denominator: 1,
            numerator  : 532_899,
            status     : 'measured',
            value      : 532_899
        });
        expect(report.metrics.casConflictRate).toMatchObject({
            denominator: 5,
            numerator  : 1,
            status     : 'fixture',
            value      : 0.2
        });
        expect(report.metrics.duplicateBatchReceiptRate).toMatchObject({
            denominator: 5,
            numerator  : 1,
            status     : 'fixture',
            value      : 0.2
        });
        expect(report.metrics.opaqueCheckpointBytes.status).toBe('fixture');
        expect(report.metrics.opaqueCheckpointBytes.denominator).toBe(3);
        expect(report.metrics.bytesPerAdmittedEvent.status).toBe('fixture');
        expect(report.metrics.bytesPerAdmittedEvent.denominator).toBe(4);
        expect(report.metrics.hookBytesPerEvent.status).toBe('fixture');
        expect(report.metrics.hooksPerAdmittedEvent.status).toBe('fixture');
        expect(report.metrics.liveSubstrateCycleLatencyMs.status).toBe('fixture');
        expect(report.metrics.storageGrowthBytesPerDay).toMatchObject({
            denominator: 30,
            numerator  : 3_809_537,
            status     : 'lower-bound'
        });
        expect(report.metrics.wakesPerAdmittedEvent).toMatchObject({
            denominator: 11_253,
            numerator  : 22,
            status     : 'measured'
        });
        for (const key of ['stewardVacancyRate', 'timeToAcknowledgeMs', 'timeToClaimMs', 'timeToRespondMs']) {
            expect(report.metrics[key]).toMatchObject({
                reasonCode: 'steward_experiment_not_yet_run',
                status    : 'unknown',
                value     : null
            });
        }

        const thresholds = report.policy.thresholds;
        expect(thresholds.reconciliationCadenceMs).toMatchObject({
            aiConfigDefault: null,
            disposition    : 'calibrated',
            value          : 2_131_596
        });
        expect(thresholds.providerRootPageSize).toMatchObject({
            aiConfigDefault: null,
            disposition    : 'calibrated',
            value          : 50
        });
        expect(thresholds.providerChildPageSize).toMatchObject({
            aiConfigDefault: null,
            disposition    : 'calibrated',
            value          : 100
        });
        expect(thresholds.hookProjectionTtlMs).toBeUndefined();

        for (const unsetKey of [
            'maxAdmissionAttempts',
            'paginationCap',
            'retentionMs',
            'archiveThreshold',
            'stewardActivation',
            'stewardLeaseTtlMs',
            'wakeCoalesceWindowMs',
            'vacancyFallbackCooldownMs',
            'minUnclaimedEligibleCount',
            'wakeAmplificationCap',
            'maxWakePayloadBytes'
        ]) {
            expect(thresholds[unsetKey]).toMatchObject({
                disposition: 'unset',
                value      : null
            });
        }

        expect(report.wakeChildDecision).toMatchObject({
            activationAuthorized: false,
            authorized          : true,
            closeNotPlanned     : false,
            disposition         : 'shadow-only steward experiment authorized; activation thresholds unset until its window',
            issueNumber         : 100,
            mode                : 'shadow-only'
        });
        expect(formatCalibrationSummary(report)).toContain('wakeChildMode=shadow-only');
        expect(formatCalibrationSummary(report)).toContain('activationAuthorized=false');
    });

    test('preserves disabled-by-default AiConfig and keeps team roster handles out of product defaults', () => {
        expect(aiConfig.orchestrator.communityReconciliation).toMatchObject({
            enabled             : false,
            maxAdmissionAttempts: null,
            tenantId            : null
        });
        expect(aiConfig.orchestrator.intervals.communityReconciliationMs).toBeNull();
        expect(DEFAULT_CALIBRATION_FIXTURE.attentionPolicy.rosteredActorIds).toEqual(['fixture-maintainer-1']);
        expect(DEFAULT_CALIBRATION_FIXTURE.viewerAgentId).toBe('AGENT:@fixture-steward-1');
    });

    test('revalidates deferred options E, F, K, O, V, X, J and rejects hidden defaults in assertCalibrationReport', () => {
        for (const key of ['E', 'F', 'K', 'O', 'V', 'X']) {
            expect(OPTION_REVALIDATION_LEDGER[key].disposition).toBe('keep-deferred');
            expect(OPTION_REVALIDATION_LEDGER[key].triggerMet).toBe(false);
            expect(OPTION_REVALIDATION_LEDGER[key].revalidationTrigger.length).toBeGreaterThan(10);
        }
        expect(OPTION_REVALIDATION_LEDGER.J.disposition).toBe(
            'shadow-only steward experiment authorized; activation thresholds unset until its window'
        );
        expect(OPTION_REVALIDATION_LEDGER.J.triggerMet).toBe(false);

        const policy = deriveCalibratedPolicy();

        expect(() => assertCalibrationReport({
            optionDispositions: OPTION_REVALIDATION_LEDGER,
            policy            : {
                ...policy,
                thresholds: {
                    ...policy.thresholds,
                    reconciliationCadenceMs: {
                        ...policy.thresholds.reconciliationCadenceMs,
                        aiConfigDefault: 2_131_596
                    }
                }
            },
            repeatability: {
                comparable           : true,
                deterministicVariance: {admittedEvents: 0},
                evidenceStatus       : 'two-run-fixture-determinism'
            },
            schemaVersion: CALIBRATION_REPORT_SCHEMA_VERSION
        })).toThrow(/cannot introduce a hidden active default/);
    });
});

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
import aiConfig       from '../../../../../../ai/config.mjs';
import {
    CALIBRATION_REPORT_SCHEMA_VERSION,
    LIVE_INCIDENT_MANIFEST,
    OPTION_REVALIDATION_LEDGER,
    SHADOW_BASELINE_MANIFEST,
    assertCalibrationReport,
    deriveCalibratedPolicy,
    formatCalibrationSummary,
    parseArgs,
    runPolicyCalibration,
    validateCommunityPolicyThresholds
} from '../../../../../../ai/scripts/maintenance/communityActivityPolicyCalibrationCore.mjs';
import {executeLiveCalibrationPass} from '../../../../../../ai/scripts/maintenance/calibrateCommunityActivityPolicy.mjs';

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

    test('executes two-run live-substrate calibration, populates all shadow+live metrics, and derives explicit formulas', async () => {
        let   tick               = 0;
        const clocks             = ['2026-10-26T22:00:00.000Z', '2026-10-26T22:00:01.000Z'];
        const {exitCode, report} = await runPolicyCalibration({runs: 2}, {
            liveIncident  : LIVE_INCIDENT_MANIFEST,
            now           : () => clocks[tick++] || '2026-10-26T22:00:02.000Z',
            runSinglePass : executeLiveCalibrationPass,
            shadowBaseline: SHADOW_BASELINE_MANIFEST
        });

        expect(exitCode).toBe(0);
        expect(report.schemaVersion).toBe(CALIBRATION_REPORT_SCHEMA_VERSION);
        expect(report.repeatability.evidenceStatus).toBe('two-run');
        expect(report.repeatability.comparable).toBe(true);
        expect(Object.values(report.repeatability.deterministicVariance).every(delta => delta === 0)).toBe(true);
        expect(report.repeatability.runs[0].stateManifestHash).toBe(report.repeatability.runs[1].stateManifestHash);

        expect(report.metrics.pagesPerEvent).toMatchObject({
            denominator: 11_253,
            numerator  : 1_739,
            status     : 'measured'
        });
        expect(report.metrics.casConflictRate).toMatchObject({
            denominator: 5,
            numerator  : 1,
            status     : 'measured',
            value      : 0.2
        });
        expect(report.metrics.duplicateBatchReceiptRate).toMatchObject({
            denominator: 5,
            numerator  : 1,
            status     : 'measured',
            value      : 0.2
        });
        expect(report.metrics.opaqueCheckpointBytes.status).toBe('measured');
        expect(report.metrics.opaqueCheckpointBytes.denominator).toBe(3);
        expect(report.metrics.bytesPerAdmittedEvent.status).toBe('measured');
        expect(report.metrics.bytesPerAdmittedEvent.denominator).toBe(4);
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
        expect(report.metrics.stewardVacancyRate).toMatchObject({
            denominator: 2,
            numerator  : 2,
            status     : 'measured',
            value      : 1
        });
        expect(report.metrics.timeToAcknowledgeMs.value).toBe(214_500);
        expect(report.metrics.timeToClaimMs.value).toBe(312_000);
        expect(report.metrics.timeToRespondMs.value).toBe(397_500);

        const thresholds = report.policy.thresholds;
        expect(thresholds.reconciliationCadenceMs).toMatchObject({
            aiConfigDefault: null,
            bounds         : {max: 86_400_000, min: 1_065_798},
            disposition    : 'calibrated',
            value          : 2_131_596
        });
        expect(thresholds.maxAdmissionAttempts).toMatchObject({
            aiConfigDefault: null,
            bounds         : {max: 5, min: 1},
            disposition    : 'calibrated',
            value          : 2
        });
        expect(thresholds.paginationCap).toMatchObject({
            aiConfigDefault: null,
            bounds         : null,
            disposition    : 'unset',
            value          : null
        });
        expect(thresholds.retentionMs).toMatchObject({
            aiConfigDefault: null,
            bounds         : null,
            disposition    : 'unset',
            value          : null
        });
        expect(thresholds.archiveThreshold).toMatchObject({
            aiConfigDefault: null,
            bounds         : null,
            disposition    : 'unset',
            value          : null
        });
        expect(thresholds.stewardActivation).toMatchObject({
            aiConfigDefault: false,
            disposition    : 'calibrated',
            value          : true
        });
        expect(thresholds.stewardLeaseTtlMs.value).toBe(1_590_000);
        expect(thresholds.wakeCoalesceWindowMs.value).toBe(397_500);
        expect(thresholds.vacancyFallbackCooldownMs.value).toBe(795_000);
        expect(thresholds.minUnclaimedEligibleCount.value).toBe(1);
        expect(thresholds.wakeAmplificationCap.value).toBe(1);
        expect(thresholds.maxWakePayloadBytes.value).toBe(1_024);

        expect(formatCalibrationSummary(report)).toContain('wakeChildAuthorized=true');
    });

    test('validates candidate policy overrides, enforces unset dispositions, and preserves disabled-by-default AiConfig', () => {
        expect(aiConfig.orchestrator.communityReconciliation).toMatchObject({
            enabled             : false,
            maxAdmissionAttempts: null,
            tenantId            : null
        });
        expect(aiConfig.orchestrator.intervals.communityReconciliationMs).toBeNull();

        const policy = deriveCalibratedPolicy({
            hookBytesPerEvent: {numerator: 1_781, value: 445.25},
            timeToRespondMs  : {value: 397_500}
        });

        expect(validateCommunityPolicyThresholds({
            maxAdmissionAttempts     : 2,
            maxWakePayloadBytes      : 1_024,
            minUnclaimedEligibleCount: 1,
            providerChildPageSize    : 100,
            providerRootPageSize     : 50,
            reconciliationCadenceMs  : 2_131_596,
            stewardLeaseTtlMs        : 1_590_000,
            vacancyFallbackCooldownMs: 795_000,
            wakeAmplificationCap     : 1,
            wakeCoalesceWindowMs     : 397_500
        }, policy)).toEqual({errors: [], valid: true});

        const invalidUnset = validateCommunityPolicyThresholds({
            archiveThreshold: 10_000,
            paginationCap   : 500,
            retentionMs     : 86_400_000
        }, policy);
        expect(invalidUnset.valid).toBe(false);
        expect(invalidUnset.errors).toEqual([
            'POLICY_THRESHOLD_MUST_REMAIN_UNSET:paginationCap',
            'POLICY_THRESHOLD_MUST_REMAIN_UNSET:retentionMs',
            'POLICY_THRESHOLD_MUST_REMAIN_UNSET:archiveThreshold'
        ]);

        const outOfBounds = validateCommunityPolicyThresholds({
            maxAdmissionAttempts   : 9,
            maxWakePayloadBytes    : 4_096,
            reconciliationCadenceMs: 30_000,
            stewardLeaseTtlMs      : 400_000,
            wakeAmplificationCap   : 2,
            wakeCoalesceWindowMs   : 500_000
        }, policy);
        expect(outOfBounds.valid).toBe(false);
        expect(outOfBounds.errors).toContain('POLICY_THRESHOLD_OUT_OF_BOUNDS:reconciliationCadenceMs');
        expect(outOfBounds.errors).toContain('POLICY_THRESHOLD_OUT_OF_BOUNDS:maxAdmissionAttempts');
        expect(outOfBounds.errors).toContain('POLICY_THRESHOLD_OUT_OF_BOUNDS:wakeAmplificationCap');
        expect(outOfBounds.errors).toContain('POLICY_THRESHOLD_OUT_OF_BOUNDS:maxWakePayloadBytes');
        expect(outOfBounds.errors).toContain('POLICY_STEWARD_LEASE_SHORTER_THAN_COALESCE_WINDOW');
    });

    test('revalidates deferred options E, F, K, O, V, X, J and rejects hidden defaults in assertCalibrationReport', () => {
        for (const key of ['E', 'F', 'K', 'O', 'V', 'X']) {
            expect(OPTION_REVALIDATION_LEDGER[key].disposition).toBe('keep-deferred');
            expect(OPTION_REVALIDATION_LEDGER[key].triggerMet).toBe(false);
            expect(OPTION_REVALIDATION_LEDGER[key].revalidationTrigger.length).toBeGreaterThan(10);
        }
        expect(OPTION_REVALIDATION_LEDGER.J.disposition).toBe('activate-gated');
        expect(OPTION_REVALIDATION_LEDGER.J.triggerMet).toBe(true);

        const policy = deriveCalibratedPolicy({
            hookBytesPerEvent: {numerator: 1_781, value: 445.25},
            timeToRespondMs  : {value: 397_500}
        });

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
                evidenceStatus       : 'two-run'
            },
            schemaVersion: CALIBRATION_REPORT_SCHEMA_VERSION
        })).toThrow(/cannot introduce a hidden active default/);
    });
});

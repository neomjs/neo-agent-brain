import {test, expect} from '@playwright/test';
import {
    CALIBRATED_COMMUNITY_RECONCILIATION_POLICY,
    getDueTask,
    validateCommunityReconciliationConfig
} from '../../../../../../../ai/daemons/orchestrator/scheduling/communityReconciliation.mjs';

test.describe('community reconciliation trigger (#104)', () => {
    test('is inert for null, invalid, or disabled cadence', () => {
        for (const [intervalMs, enabled] of [[null, true], [0, true], [-1, true], [NaN, true], [100, false]]) {
            expect(getDueTask({state: {}, now: 1000, intervalMs, enabled})).toBeNull();
        }
    });

    test('selects the task only after an explicit positive cadence elapses', () => {
        expect(getDueTask({state: {'community-reconciliation': {lastRunAt: 950}}, now: 1000, intervalMs: 100, enabled: true})).toBeNull();
        expect(getDueTask({state: {}, now: 1000, intervalMs: 100, enabled: true})).toMatchObject({taskName: 'community-reconciliation'});
    });

    test('validates explicit cadence and retry settings against calibrated bounds while keeping null inert', () => {
        expect(CALIBRATED_COMMUNITY_RECONCILIATION_POLICY).toEqual({
            calibratedIntervalMs          : 2_131_596,
            calibratedMaxAdmissionAttempts: 2,
            defaultIntervalMs             : null,
            defaultMaxAdmissionAttempts   : null,
            maxAdmissionAttempts          : 5,
            maxIntervalMs                 : 86_400_000,
            minAdmissionAttempts          : 1,
            minIntervalMs                 : 1_065_798
        });

        expect(validateCommunityReconciliationConfig()).toEqual({
            errors: [],
            inert : true,
            valid : true
        });
        expect(validateCommunityReconciliationConfig({
            intervalMs          : 2_131_596,
            maxAdmissionAttempts: 2
        })).toEqual({
            errors: [],
            inert : false,
            valid : true
        });
        expect(validateCommunityReconciliationConfig({
            intervalMs          : 60_000,
            maxAdmissionAttempts: 10
        })).toEqual({
            errors: [
                'COMMUNITY_RECONCILIATION_CADENCE_OUT_OF_BOUNDS',
                'COMMUNITY_RECONCILIATION_RETRY_OUT_OF_BOUNDS'
            ],
            inert: false,
            valid: false
        });
    });
});

import {test, expect} from '@playwright/test';
import {getDueTask}   from '../../../../../../../ai/daemons/orchestrator/scheduling/communityReconciliation.mjs';

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
});

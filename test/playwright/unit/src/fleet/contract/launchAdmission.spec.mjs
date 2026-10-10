import {test, expect} from '@playwright/test';
import {
    LAUNCH_ADMISSION_CREDENTIALS,
    LAUNCH_ADMISSION_PROOF_REASONS,
    isLaunchAdmissionProofReason
} from '../../../../../../src/fleet/contract/launchAdmission.mjs';

test.describe('the public proof reasons — the contract\'s diagnostic vocabulary (#973)', () => {
    test('the list is frozen, non-empty and admitted wording by wording', () => {
        expect(Object.isFrozen(LAUNCH_ADMISSION_PROOF_REASONS)).toBe(true);
        expect(LAUNCH_ADMISSION_PROOF_REASONS.length).toBeGreaterThan(0);
        expect(LAUNCH_ADMISSION_PROOF_REASONS).toContain('plane endpoint unreachable');
        for (const reason of LAUNCH_ADMISSION_PROOF_REASONS) {
            expect(isLaunchAdmissionProofReason(reason)).toBe(true)
        }
    });

    test('the plane\'s readiness status passes for an HTTP status only', () => {
        expect(isLaunchAdmissionProofReason('plane MCP readiness failed (503)')).toBe(true);
        expect(isLaunchAdmissionProofReason('plane MCP readiness failed (101)')).toBe(true);
        expect(isLaunchAdmissionProofReason('plane MCP readiness failed (999)')).toBe(false);
        expect(isLaunchAdmissionProofReason('plane MCP readiness failed (503) ')).toBe(false)
    });

    test('a credential kind, an arbitrary string and a non-string are not diagnostics', () => {
        for (const kind of Object.values(LAUNCH_ADMISSION_CREDENTIALS)) {
            expect(isLaunchAdmissionProofReason(kind)).toBe(false)
        }
        expect(isLaunchAdmissionProofReason('UNRECOGNIZED_PROBE_SENTINEL')).toBe(false);
        expect(isLaunchAdmissionProofReason('')).toBe(false);
        expect(isLaunchAdmissionProofReason(null)).toBe(false);
        expect(isLaunchAdmissionProofReason(['plane endpoint unreachable'])).toBe(false)
    })
});

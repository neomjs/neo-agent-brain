export const CALIBRATED_COMMUNITY_RECONCILIATION_POLICY = Object.freeze({
    defaultIntervalMs             : null,
    calibratedIntervalMs          : 2_131_596,
    minIntervalMs                 : 1_065_798,
    maxIntervalMs                 : 86_400_000,
    defaultMaxAdmissionAttempts   : null,
    calibratedMaxAdmissionAttempts: 2,
    minAdmissionAttempts          : 1,
    maxAdmissionAttempts          : 5
});

/**
 * @summary Validates explicit community-reconciliation cadence and retry settings against calibrated bounds.
 * @param {Object} [options]
 * @param {Number|null} [options.intervalMs=null]
 * @param {Number|null} [options.maxAdmissionAttempts=null]
 * @returns {{valid: Boolean, inert: Boolean, errors: String[]}}
 */
export function validateCommunityReconciliationConfig({intervalMs = null, maxAdmissionAttempts = null} = {}) {
    const errors = [];

    if (intervalMs !== null && intervalMs !== undefined) {
        if (
            !Number.isInteger(intervalMs) ||
            intervalMs < CALIBRATED_COMMUNITY_RECONCILIATION_POLICY.minIntervalMs ||
            intervalMs > CALIBRATED_COMMUNITY_RECONCILIATION_POLICY.maxIntervalMs
        ) {
            errors.push('COMMUNITY_RECONCILIATION_CADENCE_OUT_OF_BOUNDS')
        }
    }

    if (maxAdmissionAttempts !== null && maxAdmissionAttempts !== undefined) {
        if (
            !Number.isInteger(maxAdmissionAttempts) ||
            maxAdmissionAttempts < CALIBRATED_COMMUNITY_RECONCILIATION_POLICY.minAdmissionAttempts ||
            maxAdmissionAttempts > CALIBRATED_COMMUNITY_RECONCILIATION_POLICY.maxAdmissionAttempts
        ) {
            errors.push('COMMUNITY_RECONCILIATION_RETRY_OUT_OF_BOUNDS')
        }
    }

    return {
        valid: errors.length === 0,
        inert: intervalMs === null || intervalMs === undefined,
        errors
    }
}

/** @summary Pure community-reconciliation cadence trigger; null cadence is intentionally inert. */
export function getDueTask({state = {}, now, intervalMs, enabled} = {}) {
    if (!enabled || !Number.isFinite(intervalMs) || intervalMs <= 0) return null;
    const lastRunAt = state['community-reconciliation']?.lastRunAt ?? 0;
    return now - lastRunAt >= intervalMs ? {
        taskName: 'community-reconciliation', source: 'periodic-community-reconciliation', reason: `periodic-community-reconciliation:${intervalMs}`
    } : null;
}

/** @summary Pure community-reconciliation cadence trigger; null cadence is intentionally inert. */
export function getDueTask({state = {}, now, intervalMs, enabled} = {}) {
    if (!enabled || !Number.isFinite(intervalMs) || intervalMs <= 0) return null;
    const lastRunAt = state['community-reconciliation']?.lastRunAt ?? 0;
    return now - lastRunAt >= intervalMs ? {
        taskName: 'community-reconciliation', source: 'periodic-community-reconciliation', reason: `periodic-community-reconciliation:${intervalMs}`
    } : null;
}

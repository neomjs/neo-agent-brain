/**
 * @module ai/services/fleet/planePrLaneActivityReader
 * @summary The plane-mode PR/lane activity read: `get_pr_lane_activity` through the admitted plane
 * client, answering the slot's own `{capability, counts, events}` snapshot — the plane runs the same
 * `makeReadPrLaneSnapshot` over the corpus the orchestrator materializes, so this adapter hands the
 * answer to the composer untouched. Sibling of `planeDeploymentStateReader`: a fleet process attached
 * to a plane reads the plane's truth, never its own data root, which carries no corpus.
 */

/**
 * @summary Build the plane-mode PR/lane reader for `wireFleetActivityReadSource`'s `readPrLane`.
 * @param {Object} planeClient The admitted plane client (`callTool`).
 * @returns {Function} `async params => snapshot` — the plane's snapshot; throws when the answer is not one,
 *     so the composer degrades this slot alone.
 */
export function createPlanePrLaneActivityReader(planeClient) {
    return async params => {
        // `prEvents: false` travels only when asked: a caller whose PR contributor is the open-work
        // producer wants the plane's bound spent on the other contributors alone
        const payload = await planeClient.callTool('get_pr_lane_activity', params?.prEvents === false
            ? {limit: params.limit, prEvents: false}
            : {limit: params?.limit});

        if (typeof payload?.capability?.state !== 'string' || !Array.isArray(payload?.events)) {
            throw new Error('plane get_pr_lane_activity answer unreadable')
        }

        return payload
    }
}

export default createPlanePrLaneActivityReader;

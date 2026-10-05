/**
 * @module ai/services/fleet/hostWhoIsOnlineReader
 * @summary The host-mode presence reader: the in-process Memory Core's own `who_is_online` projection, composed
 * into the presence adapter's `readPresence` contract, the host twin of `planeWhoIsOnlineReader`.
 *
 * A host Fleet runs Memory Core in its own process, so the projection the plane serves over the wire runs here
 * directly, over the host graph's identity nodes. Its node read answers an empty list when the graph is not
 * open, which would read as a fleet with no identity nodes at all, so this reader refuses first: the adapter
 * turns the refusal into an unanswered read, never into seats without a node.
 */

/**
 * @summary Builds the source-facing presence reader over the in-process Memory Core.
 * @param {Function} loadServices `() => Promise<{wakeSubscriptions: Object, graph: Object}>` resolving the
 *     `WakeSubscriptionService` and `GraphService` singletons
 * @returns {Function} `() => Promise<Object>` matching the adapter's `readPresence` seam.
 */
export function createHostWhoIsOnlineReader(loadServices) {
    return async () => {
        const {wakeSubscriptions, graph} = await loadServices();

        if (!graph?.db?.storage?.db) {
            throw new Error('host graph not open')
        }

        // verbose: the terse report omits the per-agent rows this reader exists to fetch
        const payload = await wakeSubscriptions.whoIsOnline({verbose: true});

        if (!Array.isArray(payload?.agents)) {
            throw new Error('host who_is_online answer unreadable')
        }

        return payload
    }
}

export default createHostWhoIsOnlineReader;

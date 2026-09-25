import FleetControlBridge            from './FleetControlBridge.mjs';
import {createFleetGoldenPathSource} from './fleetGoldenPathSource.mjs';

/**
 * @module ai/services/fleet/wireFleetGoldenPathSource
 * @summary Installs the Golden Path source onto the Fleet control bridge at the authenticated
 * server entry. Both operations are resolved at that use site through the same operation
 * boundary the tasks source rides (the `wireFleetTasksSource` shape): the route and its admission
 * from the Memory Core's `get_computed_route`, the REM state from `get_rem_pipeline_state`. This
 * wiring imports neither MCP tool service nor request context, and a caller that cannot resolve
 * its operations leaves the slot unwired, so the bridge keeps answering its honest `unavailable`
 * default instead of a fabricated route.
 */

/**
 * @summary Wire one process-lifetime Golden Path source.
 * @param {Object} options
 * @param {Function} options.getComputedRoute
 * @param {Function} options.getRemPipelineState
 * @param {Function} [options.now]
 * @param {Object} [options.bridge=FleetControlBridge]
 * @param {Function} [options.createSource=createFleetGoldenPathSource]
 * @returns {Object|null}
 */
export function wireFleetGoldenPathSource({
    getComputedRoute,
    getRemPipelineState,
    now,
    bridge       = FleetControlBridge,
    createSource = createFleetGoldenPathSource
} = {}) {
    if (typeof getComputedRoute !== 'function' || typeof getRemPipelineState !== 'function') {
        return null
    }

    bridge.goldenPathSource = createSource({
        getComputedRoute,
        getRemPipelineState,
        ...(now ? {now} : {})
    });

    return bridge.goldenPathSource
}

export default wireFleetGoldenPathSource;

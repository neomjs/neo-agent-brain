import FleetControlBridge            from './FleetControlBridge.mjs';
import {createFleetGoldenPathSource} from './fleetGoldenPathSource.mjs';

/**
 * @module ai/services/fleet/wireFleetGoldenPathSource
 * @summary Installs the Golden Path source onto the Fleet control bridge at the authenticated
 * server entry. The sidecar path and the REM operation are resolved at that use site (the
 * `wireFleetTasksSource` shape); the source reads its own projection leaves. This wiring imports
 * neither MCP tool service nor request context, and a caller that cannot resolve its inputs
 * leaves the slot unwired, so the bridge keeps answering its honest `unavailable` default
 * instead of a fabricated route.
 */

/**
 * @summary Wire one process-lifetime Golden Path source.
 * @param {Object} options
 * @param {String} options.routePath Absolute path of `computed-route.json`.
 * @param {Function} options.getRemPipelineState
 * @param {Function} [options.now]
 * @param {Object} [options.bridge=FleetControlBridge]
 * @param {Function} [options.createSource=createFleetGoldenPathSource]
 * @returns {Object|null}
 */
export function wireFleetGoldenPathSource({
    routePath,
    getRemPipelineState,
    now,
    bridge       = FleetControlBridge,
    createSource = createFleetGoldenPathSource
} = {}) {
    if (typeof routePath !== 'string' || !routePath || typeof getRemPipelineState !== 'function') {
        return null
    }

    bridge.goldenPathSource = createSource({
        routePath,
        getRemPipelineState,
        ...(now ? {now} : {})
    });

    return bridge.goldenPathSource
}

export default wireFleetGoldenPathSource;

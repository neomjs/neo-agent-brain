import FleetControlBridge             from './FleetControlBridge.mjs';
import {createFleetRecentTurnsSource} from './fleetRecentTurnsSource.mjs';

/**
 * @module ai/services/fleet/wireFleetRecentTurnsSource
 * @summary Installs the viewer-bound recent-turns (thought stream) source onto the Fleet control
 * bridge at the authenticated server entry. The operation function and viewer resolver are
 * injected at that use site; this wiring imports neither MCP tool service nor request context.
 */

/**
 * @summary Wire one process-lifetime recent-turns source.
 * @param {Object} options
 * @param {Function} options.queryRecentTurns
 * @param {Function} options.resolveViewerIdentity
 * @param {Function} [options.now]
 * @param {Object} [options.bridge=FleetControlBridge]
 * @param {Function} [options.createSource=createFleetRecentTurnsSource]
 * @returns {Object|null}
 */
export function wireFleetRecentTurnsSource({
    queryRecentTurns,
    resolveViewerIdentity,
    now,
    bridge       = FleetControlBridge,
    createSource = createFleetRecentTurnsSource
} = {}) {
    if (typeof queryRecentTurns !== 'function' || typeof resolveViewerIdentity !== 'function') {
        return null
    }

    bridge.recentTurnsSource = createSource({
        queryRecentTurns,
        resolveViewerIdentity,
        ...(now ? {now} : {})
    });

    return bridge.recentTurnsSource
}

export default wireFleetRecentTurnsSource;

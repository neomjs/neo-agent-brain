import Base              from 'neo.mjs/src/core/Base.mjs';
import ConnectionService from './ConnectionService.mjs';

/**
 * @summary Manages interaction inspection for the Neural Link MCP Server.
 *
 * This service provides tools for inspecting user interactions, such as Drag & Drop state,
 * focus, and selection.
 *
 * @class Neo.ai.services.neural-link.InteractionService
 * @extends Neo.core.Base
 * @singleton
 */
class InteractionService extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.services.neural-link.InteractionService'
         * @protected
         */
        className: 'Neo.ai.services.neural-link.InteractionService',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * @returns {Promise<void>}
     */
    async initAsync() {
        await super.initAsync();
        await ConnectionService.ready();
    }

    /**
     * Retrieves the state of the DragCoordinator.
     * @param {Object} opts
     * @param {String} [opts.sessionId]
     * @returns {Promise<Object>}
     */
    async getDragState({sessionId}) {
        return await ConnectionService.call(sessionId, 'get_drag_state', {})
    }

    /**
     * @summary Requests one Engine-owned physical drag and preserves its typed receipt.
     *
     * Descriptor validation belongs to the MCP schema; browser geometry, sensor thresholds,
     * event construction, and cleanup remain Engine responsibilities. This service only
     * enforces the one cross-field duration bound that OpenAPI cannot express, forwards the
     * object, and turns an Engine refusal into a machine-readable MCP object error.
     * @param {Object}   opts
     * @param {Object}   opts.destination
     * @param {Number}   [opts.durationMs]
     * @param {String}   [opts.sessionId]
     * @param {Object}   opts.source
     * @param {Number}   opts.steps
     * @param {Object[]} [opts.waypoints]
     * @returns {Promise<Object>}
     */
    async driveDrag({destination, durationMs, sessionId, source, steps, waypoints}) {
        if (durationMs !== undefined && durationMs < steps * 16) {
            throw new Error('durationMs must be at least steps * 16')
        }

        const request = {destination, source, steps};

        if (durationMs !== undefined) request.durationMs = durationMs;
        if (waypoints  !== undefined) request.waypoints  = waypoints;

        const result = await ConnectionService.call(sessionId, 'drive_drag', request);

        if (typeof result?.success !== 'boolean') {
            throw new Error('Engine drive_drag returned no typed outcome')
        }

        if (!result.success) {
            return {
                error  : 'Drag gesture failed',
                message: result.error?.message || 'The Engine rejected the drag gesture.',
                phase  : result.phase,
                receipt: result
            }
        }

        return result
    }

    /**
     * Retrieves the recent drag-lifecycle traces (SortZone ring buffer).
     * @param {Object}  opts
     * @param {Boolean} [opts.clear]
     * @param {String}  [opts.sessionId]
     * @returns {Promise<Object>}
     */
    async getDragTrace({clear, sessionId}) {
        return await ConnectionService.call(sessionId, 'get_drag_trace', {clear})
    }

    /**
     * Samples component and raw DOM-node client rects over a time window (motion trace).
     * @param {Object}         opts
     * @param {String[]}       [opts.componentIds]
     * @param {{rowId:String}} [opts.cellsOf]
     * @param {Number}         [opts.durationMs]
     * @param {Number}         [opts.intervalMs]
     * @param {String[]}       [opts.nodeIds]
     * @param {String}         [opts.sessionId]
     * @param {String}         [opts.windowId]
     * @returns {Promise<Object>}
     */
    async observeMotion({cellsOf, componentIds, durationMs, intervalMs, nodeIds, sessionId, windowId}) {
        return await ConnectionService.call(sessionId, 'observe_motion', {
            cellsOf,
            componentIds,
            durationMs,
            intervalMs,
            nodeIds,
            windowId
        })
    }

    /**
     * Diffs a container's items / vdom / DOM child surfaces (duplication detector).
     * @param {Object} opts
     * @param {String} opts.componentId
     * @param {String} [opts.sessionId]
     * @returns {Promise<Object>}
     */
    async verifyComponentConsistency({componentId, sessionId}) {
        return await ConnectionService.call(sessionId, 'verify_component_consistency', {componentId})
    }

    /**
     * Highlights a component visually for debugging purposes.
     * @param {Object} opts
     * @param {String} opts.sessionId
     * @param {String} opts.componentId
     * @param {Object} [opts.options]
     * @returns {Promise<void>}
     */
    async highlightComponent({sessionId, componentId, options}) {
        return await ConnectionService.call(sessionId, 'highlight_component', {
            componentId,
            options
        })
    }

    /**
     * Simulates a native DOM event sequence.
     * @param {Object} opts
     * @param {Object[]} opts.events
     * @param {String} opts.sessionId
     * @returns {Promise<Boolean>}
     */
    async simulateEvent({events, sessionId}) {
        return await ConnectionService.call(sessionId, 'simulate_event', {
            events
        })
    }
}

export default Neo.setupClass(InteractionService);

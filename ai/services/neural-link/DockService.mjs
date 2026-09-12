import Base              from 'neo.mjs/src/core/Base.mjs';
import ConnectionService from './ConnectionService.mjs';

/**
 * @summary Manages dock-layout inspection and semantic operations for the Neural Link MCP Server.
 *
 * This service provides tools for reading a live dock workspace's serializable layout document
 * (its topology) and for executing dockZone.v1 semantic operations against it. Both calls are
 * thin passthroughs to the App Worker, where the dock document holder applies operations through
 * the landed commit path — policy rejections surface as structured executor errors.
 *
 * @class Neo.ai.services.neural-link.DockService
 * @extends Neo.core.Base
 * @singleton
 */
class DockService extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.services.neural-link.DockService'
         * @protected
         */
        className: 'Neo.ai.services.neural-link.DockService',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * Captures a live workspace as a named saved-layout record and stores it on the holder's
     * perspective surface when present — window scope reads the holder's own document, topology
     * scope reads the holder's ordered multi-window seam.
     * @param {Object} opts
     * @param {String}  opts.componentId       The dock workspace / document-holder component id
     * @param {String}  opts.layoutId          Stable technical id for the record
     * @param {String} [opts.perspectiveName]  Product-facing name
     * @param {String} [opts.title]            Display title
     * @param {String} [opts.captureScope]     'window' (default) | 'topology' — the DockZoneModel.CAPTURE_SCOPES vocabulary
     * @param {Boolean} [opts.replace]         Explicit name-collision decision
     * @param {String} [opts.sessionId]
     * @returns {Promise<Object>}
     */
    async capturePerspective({componentId, layoutId, perspectiveName, title, captureScope, replace, sessionId}) {
        return await ConnectionService.call(sessionId, 'capture_perspective', {
            captureScope,
            componentId,
            layoutId,
            perspectiveName,
            replace,
            title
        })
    }

    /**
     * Computes a semantic diff between a supplied before-document and a live workspace's
     * current layout document.
     * @param {Object} opts
     * @param {String} opts.componentId    The dock workspace / document-holder component id
     * @param {Object} opts.beforeDocument The earlier dockZone.v1 document to compare against
     * @param {Number} [opts.sizeEpsilon]  Optional resize tolerance on split size fractions
     * @param {String} [opts.sessionId]
     * @returns {Promise<Object>}
     */
    async diffDockTopology({componentId, beforeDocument, sizeEpsilon, sessionId}) {
        return await ConnectionService.call(sessionId, 'diff_dock_topology', {
            beforeDocument,
            componentId,
            sizeEpsilon
        })
    }

    /**
     * Lists a live workspace's declared perspectives beside its stored records: `declared` (the
     * names `activePerspective` accepts) with the published `perspective` facts (`active`,
     * `modified`, `pending`), plus the stored summaries and keyed topologies. The key is the
     * discriminator. Fail-closed structured errors only when the holder declares nothing and
     * exposes no perspective or topology store.
     * @param {Object} opts
     * @param {String} opts.componentId The dock workspace / document-holder component id
     * @param {String} [opts.sessionId]
     * @returns {Promise<Object>}
     */
    async listPerspectives({componentId, sessionId}) {
        return await ConnectionService.call(sessionId, 'list_perspectives', {
            componentId
        })
    }

    /**
     * Restores a perspective by name, resolved across the workspace's declared list and its
     * stored layout and topology records (a tie is refused with the sources named). A declared
     * name takes the workspace's accepted `activePerspective` write and reports
     * `source: 'declared'`; stored records ride the holder's switch seam or the topology
     * reconciler. Returns the post-restore document for one-call verification.
     * @param {Object} opts
     * @param {String} opts.componentId The dock workspace / document-holder component id
     * @param {String} opts.name        A declared perspective name, a record's product name or its technical layoutId
     * @param {String} [opts.sessionId]
     * @returns {Promise<Object>}
     */
    async restorePerspective({componentId, name, sessionId}) {
        return await ConnectionService.call(sessionId, 'restore_perspective', {
            componentId,
            name
        })
    }

    /**
     * Applies one semantic dock operation to a live workspace's layout document and returns
     * the post-operation state for immediate verification.
     * @param {Object} opts
     * @param {String} opts.componentId The dock workspace / document-holder component id
     * @param {Object} opts.descriptor  The operation descriptor `{operation, ...}`
     * @param {String} [opts.sessionId]
     * @returns {Promise<Object>}
     */
    async executeDockOperation({componentId, descriptor, sessionId}) {
        return await ConnectionService.call(sessionId, 'execute_dock_operation', {
            componentId,
            descriptor
        })
    }

    /**
     * Reads a live dock workspace's serializable layout document plus the executable
     * operation vocabulary.
     * @param {Object} opts
     * @param {String} opts.componentId The dock workspace / document-holder component id
     * @param {String} [opts.sessionId]
     * @returns {Promise<Object>}
     */
    async getDockTopology({componentId, sessionId}) {
        return await ConnectionService.call(sessionId, 'get_dock_topology', {
            componentId
        })
    }
}

export default Neo.setupClass(DockService);

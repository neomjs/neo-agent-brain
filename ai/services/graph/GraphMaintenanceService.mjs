import Base                                      from 'neo.mjs/src/core/Base.mjs';
import { Memory_StorageRouter as StorageRouter } from '../../services.mjs';
import { Memory_GraphService as GraphService }   from '../../services.mjs';
import logger                                    from '../../mcp/server/memory-core/logger.mjs';

/**
 * @class Neo.ai.daemons.services.GraphMaintenanceService
 * @extends Neo.core.Base
 * @singleton
 */
class GraphMaintenanceService extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.daemons.services.GraphMaintenanceService'
         * @protected
         */
        className: 'Neo.ai.daemons.services.GraphMaintenanceService',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * Executes the global "Fade" algorithm across all Native Graph edges,
     * then executes Vector Apoptosis to clean up resulting orphaned nodes from the hybrid semantic space.
     *
     * An edge is unanchored only when an endpoint is missing from storage. The node cache is lazy and
     * LRU-bounded, so a node absent from it is usually just not loaded, and severing on that absence
     * deletes live rows. The deletion auto-saves, and the orphan pass then removes every node it
     * stranded. Without storage attached, the cache is the whole graph and decides alone.
     *
     * The orphan pass purges a node's vectors only once the node has left storage, because
     * `GraphService#removeNodes` deletes only the nodes the cache holds.
     */
    async runGarbageCollection() {
        logger.info('[GraphMaintenanceService] Initiating Graph Garbage Collection (Apoptosis)...');

        const
            edges      = GraphService.db.edges.items.slice(),
            sqlite     = GraphService.db.storage?.db,
            nodeStmt   = sqlite?.prepare('SELECT 1 FROM Nodes WHERE id = ?'),
            isAnchored = id => !!GraphService.db.nodes.get(id) || !!nodeStmt?.get(id);
        let   cullCount = 0;

        edges.forEach(e => {
            if (e.type === 'SYSTEM_TENET') return; // Protect structural system edges from fading

            if (!isAnchored(e.source) || !isAnchored(e.target)) {
                GraphService.db.removeEdge(e.id);
                cullCount++;
            }
        });

        logger.info(`[GraphMaintenanceService] Garbage Collection complete. Severed ${cullCount} unanchored edges.`);

        // Vector Apoptosis: Identify orphans and purge from Hybrid Store
        logger.info('[GraphMaintenanceService] Initializing Vector Apoptosis (Orphaned Node Cleanup)...');
        const orphaned = GraphService.getOrphanedNodes();

        if (orphaned.length > 0) {
            logger.info(`[GraphMaintenanceService] Apoptosis detected ${orphaned.length} orphaned nodes. Commencing eradication...`);
            GraphService.removeNodes(orphaned);

            const removed = orphaned.filter(id => !nodeStmt?.get(id));

            try {
                // Cross-layer purge from semantic embeddings
                logger.info(`[GraphMaintenanceService] Purging semantic vectors for the ${removed.length} of ${orphaned.length} orphans that left storage.`);

                const graphColl   = await StorageRouter.getGraphCollection();
                const summaryColl = await StorageRouter.getSummaryCollection();

                if (graphColl && removed.length > 0) {
                    await graphColl.delete({ ids: removed });
                }
                if (summaryColl && removed.length > 0) {
                    await summaryColl.delete({ ids: removed });
                }
            } catch (e) {
                logger.warn(`[GraphMaintenanceService] Apoptosis soft-failure on Vector purge: ${e.message}`);
            }
        }
    }
}

export default Neo.setupClass(GraphMaintenanceService);

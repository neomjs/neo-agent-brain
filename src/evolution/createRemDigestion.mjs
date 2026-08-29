import RemDigestion                  from './RemDigestion.mjs';
import StorageRouter                 from '../../ai/services/memory-core/managers/StorageRouter.mjs';
import GraphService                  from '../../ai/services/memory-core/GraphService.mjs';
import LifecycleService              from '../../ai/services/memory-core/lifecycle/SystemLifecycleService.mjs';
import logger                        from '../../ai/mcp/server/memory-core/logger.mjs';
import AdrIngestor                   from '../../ai/services/ingestion/AdrIngestor.mjs';
import ConceptIngestor               from '../../ai/services/ingestion/ConceptIngestor.mjs';
import FileSystemIngestor            from '../../ai/services/memory-core/FileSystemIngestor.mjs';
import GapInferenceEngine            from '../../ai/services/graph/GapInferenceEngine.mjs';
import GraphMaintenanceService       from '../../ai/services/graph/GraphMaintenanceService.mjs';
import MemorySessionIngestor         from '../../ai/services/ingestion/MemorySessionIngestor.mjs';
import SemanticGraphExtractor        from '../../ai/services/graph/SemanticGraphExtractor.mjs';
import TopologyInferenceEngine       from '../../ai/services/graph/TopologyInferenceEngine.mjs';
import * as providerReadiness        from '../../ai/services/graph/providerReadinessHelper.mjs';
import {appendRemRunState}           from '../../ai/services/memory-core/helpers/remRunStateStore.mjs';
import {readCorpusProjectionReceipt} from '../../ai/services/graph/corpusProjectionReceiptStore.mjs';

/**
 * @summary Constructs the Evolution-owned REM-digestion use case from one execution profile.
 *
 * Host and Cloud entrypoints share this source and may replace individual effectful collaborators
 * through `overrides`. The use case itself owns no service locator and does not select a deployment
 * profile; this composition root is the only place that binds the existing Memory Core, graph,
 * provider, projection, clock, and logging implementations. Configuration remains a direct
 * canonical use-site read in the use case rather than a dependency threaded through composition.
 * The executable entrypoint bootstraps global `Neo` before invoking this factory; importing Neo
 * again here would turn a composition helper into a second bootstrap path.
 *
 * @param {Object} [overrides={}] Named collaborator replacements for an execution profile or test.
 * @returns {RemDigestion}
 */
export function createRemDigestion(overrides = {}) {
    return Neo.create(RemDigestion, {
        storageRouter                : StorageRouter,
        lifecycleService             : LifecycleService,
        graphService                 : GraphService,
        logger,
        adrIngestor                  : AdrIngestor,
        conceptIngestor              : ConceptIngestor,
        fileSystemIngestor           : FileSystemIngestor,
        gapInferenceEngine           : GapInferenceEngine,
        graphMaintenanceService      : GraphMaintenanceService,
        memorySessionIngestor        : MemorySessionIngestor,
        semanticGraphExtractor       : SemanticGraphExtractor,
        topologyInferenceEngine      : TopologyInferenceEngine,
        providerReadiness,
        appendRemRunStateFn          : appendRemRunState,
        readCorpusProjectionReceiptFn: readCorpusProjectionReceipt,
        nowFn                        : Date.now,
        ...overrides
    });
}

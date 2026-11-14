import fs        from 'fs';
import path      from 'path';
import * as yaml from 'js-yaml';
import crypto    from 'crypto';
import Base      from 'neo.mjs/src/core/Base.mjs';
import {
    Memory_Config as aiConfig,
    Memory_GraphService as GraphService,
    Memory_StorageRouter as StorageRouter
} from '../../services.mjs';
import logger                    from '../../mcp/server/memory-core/logger.mjs';
import {
    ANCHORED_ISSUE_EDGE_TYPES,
    PROTECTED_EDGE_TYPES,
    isMessageRecordEdge,
    syncCachedEdgeProperties
} from '../memory-core/GraphService.mjs';
import {CORPUS_PROJECTION_OWNER} from '../graph/corpusProjectionContract.mjs';
import {
    getComputedIssueEmphasisMultiplier,
    readInternalAuthorLogins
} from '../graph/computedGoldenPathRouting.mjs';
import {
    normalizeDiscussionRoutingProjection as normalizeSourceDiscussionRoutingProjection
} from '../github-workflow/shared/discussionRoutingDisposition.mjs';

export const LEGACY_ANCHOR_RESET_MARKER_ID = 'issue_ingestor_legacy_anchor_reset_v1';

const PULL_GAP_LABELS              = Object.freeze(['KB_GAP', 'TOOLING_GAP', 'RETROSPECTIVE']);
const ANCHORED_ISSUE_EDGE_TYPE_SET = new Set(ANCHORED_ISSUE_EDGE_TYPES);
const PROTECTED_EDGE_TYPE_SET      = new Set(PROTECTED_EDGE_TYPES);
const normalizedInMemoryStores     = new WeakSet();

/**
 * @summary Resolves the normalized weight for an issue-adjacent edge during the one-shot legacy
 * anchor reset, or `null` when the stored weight already satisfies the scent-decay contract.
 * @param {Object} edge Edge descriptor `{source, target, type, properties}`.
 * @param {Map<String, Object>} issueNodesById Hydrated `ISSUE` node map keyed by graph node id.
 * @param {Set<String>} internalAuthorLogins Plane internal author logins.
 * @returns {Number|null}
 */
function resolveNormalizedLegacyIssueEdgeWeight(edge, issueNodesById, internalAuthorLogins) {
    const {source, target, type, properties} = edge || {};
    const issueEndpoints                     = [source, target].filter(id => typeof id === 'string' && id.startsWith('issue-'));

    if (issueEndpoints.length === 0) return null;

    const rawWeight = Number(properties?.weight);
    if (!Number.isFinite(rawWeight) || rawWeight <= 0) return null;

    if (source === 'frontier' && type === 'GUIDES') return null;

    if (isMessageRecordEdge({source})) {
        return rawWeight !== 1.0 ? 1.0 : null;
    }

    if (ANCHORED_ISSUE_EDGE_TYPE_SET.has(type)) {
        return (rawWeight < 0.1 || rawWeight > 1.0) ? 1.0 : null;
    }

    if (PROTECTED_EDGE_TYPE_SET.has(type)) {
        return (rawWeight < 0.1 || rawWeight > 1.0) ? 1.0 : null;
    }

    if (rawWeight < 0.1) {
        return 1.0;
    }

    if (rawWeight > 1.0) {
        const multiplier = Math.max(
            1.0,
            ...issueEndpoints.map(id => {
                const rawNode = issueNodesById.get(id) || GraphService.db?.nodes?.get?.(id);
                const node    = rawNode?.isRecord
                    ? {id: rawNode.get('id'), type: rawNode.get('label'), properties: rawNode.get('properties')}
                    : rawNode;

                return node ? getComputedIssueEmphasisMultiplier(node, internalAuthorLogins) : 1.0;
            })
        );

        return Math.min(1.0, Number((rawWeight / multiplier).toFixed(6)));
    }

    return null;
}

/**
 * @summary Loads the source revision's exact path→provider-id map for one corpus facet.
 * @param {String} contentRoot Materialized `resources/content` root.
 * @param {String} type Facet name.
 * @returns {Promise<Map<String, *>>}
 */
const loadIndexMap = async (contentRoot, type) => {
    const map       = new Map();
    const typeIndex = path.resolve(contentRoot, `${type}/_index.json`);
    const rootIndex = path.resolve(contentRoot, '_index.json');

    let entries = [];
    if (fs.existsSync(typeIndex)) {
        entries = JSON.parse(await fs.promises.readFile(typeIndex, 'utf-8'));
    } else if (fs.existsSync(rootIndex)) {
        const rootEntries = JSON.parse(await fs.promises.readFile(rootIndex, 'utf-8'));
        entries = rootEntries.filter(e => e.type === type);
    }

    for (const entry of entries) {
        if (entry.path) {
            map.set(path.normalize(entry.path), entry.id);
        }
    }

    return map;
};

/**
 * @summary Reads one field from a plain or Neo-record graph node.
 * @param {Object} node Graph node.
 * @param {String} field Field name.
 * @returns {*}
 */
function readNodeField(node, field) {
    return node?.isRecord ? node.get(field) : node?.[field]
}

/**
 * @summary Validates and normalizes the exact source identity stamped on projection-owned rows.
 * @param {Object|null} value Candidate projection context.
 * @param {Boolean} [required=false] True refuses an absent context.
 * @returns {Object|null}
 */
function normalizeProjectionContext(value, required = false) {
    if (value == null && !required) return null;

    if (!value || value.owner !== CORPUS_PROJECTION_OWNER ||
        typeof value.sourceRepository !== 'string' || !value.sourceRepository.trim() ||
        typeof value.sourceRef !== 'string' || !value.sourceRef.trim() ||
        typeof value.sourceRevision !== 'string' || !/^[0-9a-f]{40}$/i.test(value.sourceRevision)) {
        throw new Error('Projection reconciliation requires an exact source-bound projectionContext')
    }

    return {
        owner           : value.owner,
        sourceRepository: value.sourceRepository.trim(),
        sourceRef       : value.sourceRef.trim(),
        sourceRevision  : value.sourceRevision
    }
}

/**
 * @summary Converts a source-bound projection context into graph/vector metadata fields.
 * @param {Object|null} projectionContext Normalized projection context.
 * @returns {Object}
 */
function getProjectionMetadata(projectionContext) {
    return projectionContext ? {
        corpusProjectionOwner           : projectionContext.owner,
        corpusProjectionSourceRepository: projectionContext.sourceRepository,
        corpusProjectionSourceRef       : projectionContext.sourceRef,
        corpusProjectionSourceRevision  : projectionContext.sourceRevision
    } : {}
}

/**
 * @summary Accepts this writer's rows plus pre-contract shared legacy rows, while excluding any
 * explicitly foreign owner or tenant/user-stamped vector.
 * @param {Object|null} metadata Graph properties or vector metadata.
 * @param {Object} projectionContext Normalized projection context.
 * @returns {Boolean}
 */
function isProjectionOwnedMetadata(metadata, projectionContext) {
    const owner = metadata?.corpusProjectionOwner;

    if (owner != null) return owner === projectionContext.owner;

    return metadata?.userId == null &&
        metadata?.user_id == null &&
        metadata?.tenantId == null &&
        metadata?.tenant == null &&
        metadata?.sourceInstanceId == null &&
        metadata?.sourceAssociation == null
}

/**
 * @summary Reconciles source-removed rows from both structural and semantic graph stores.
 * Every candidate is first enumerated without mutation; a failed vector census therefore cannot
 * delete SQLite alone. If vector deletion fails after structural deletion, the surviving vector is
 * rediscovered on retry and the facet cursor remains held.
 * @param {Object} options
 * @param {Set<String>} options.expectedGraphNodeIds Exact structural ids produced by the materialized facet.
 * @param {Set<String>} [options.expectedVectorIds=options.expectedGraphNodeIds] Exact semantic ids
 * retained by the materialized facet; CLOSED issues deliberately drop out here while their graph row remains.
 * @param {String[]} options.graphLabels Structural labels owned by the facet.
 * @param {Function} options.isOwnedGraphNode Predicate excluding foreign nodes sharing a label.
 * @param {Object|null} [options.nodesCollection=null] Graph-vector collection.
 * @param {String|null} [options.vectorType=null] Vector metadata type owned by the facet.
 * @param {RegExp|null} [options.vectorIdPattern=null] Vector id ownership boundary.
 * @param {Object} options.projectionContext Exact source-bound writer context.
 * @returns {Promise<{removedGraphIds: String[], removedVectorIds: String[]}>}
 */
async function reconcileProjectionFacet({
    expectedGraphNodeIds,
    expectedVectorIds = expectedGraphNodeIds,
    graphLabels,
    isOwnedGraphNode,
    nodesCollection = null,
    vectorType = null,
    vectorIdPattern = null,
    projectionContext
}) {
    const persistedNodes  = GraphService.listSharedNodeRecordsByLabels(graphLabels);
    const removedGraphIds = persistedNodes
        .filter(node =>
            isOwnedGraphNode(node) &&
            isProjectionOwnedMetadata(readNodeField(node, 'properties'), projectionContext)
        )
        .map(node => readNodeField(node, 'id'))
        .filter(id => !expectedGraphNodeIds.has(id));

    let removedVectorIds = [];

    if (nodesCollection && vectorType) {
        const result = await nodesCollection.get({
            where  : {type: vectorType},
            include: ['metadatas']
        });

        const ids       = (result?.ids || []).flat();
        const metadatas = (result?.metadatas || []).flat();

        removedVectorIds = ids.filter((id, index) =>
            typeof id === 'string' &&
            (!vectorIdPattern || vectorIdPattern.test(id)) &&
            isProjectionOwnedMetadata(metadatas[index], projectionContext) &&
            !expectedVectorIds.has(id)
        )
    }

    GraphService.removeNodes(removedGraphIds);

    if (removedVectorIds.length > 0) {
        await nodesCollection.delete({ids: removedVectorIds})
    }

    return {removedGraphIds, removedVectorIds}
}

/**
 * @class Neo.ai.daemons.services.IssueIngestor
 * @extends Neo.core.Base
 * @singleton
 */
class IssueIngestor extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.daemons.services.IssueIngestor'
         * @protected
         */
        className: 'Neo.ai.daemons.services.IssueIngestor',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * @summary Validates the source-owned Discussion routing projection as one atomic tuple. A
     * missing or malformed field degrades the entire tuple together, so graph/vector consumers
     * never observe a v1 schema paired with contradictory legacy reason/evidence fields.
     * @param {Object} meta Parsed synced-Discussion frontmatter.
     * @returns {{schemaVersion: String, disposition: String, reason: String, evidence: String[]}}
     */
    static normalizeDiscussionRoutingProjection(meta = {}) {
        const normalized = normalizeSourceDiscussionRoutingProjection({
            schemaVersion: meta.routingDispositionSchemaVersion,
            disposition  : meta.routingDisposition,
            reasonCode   : meta.routingDispositionReason,
            evidence     : meta.routingDispositionEvidence
        });

        return {
            schemaVersion: normalized.schemaVersion,
            disposition  : normalized.disposition,
            reason       : normalized.reasonCode,
            evidence     : normalized.evidence
        }
    }

    /**
     * @summary Chooses the canonical source when a Discussion exists in both active and archive
     * trees during the sync writer's write-before-unlink crash window. GitHub `updatedAt` is the
     * primary lifecycle clock; the content index and active tree provide deterministic tie-breaks.
     * @param {Object} candidate Candidate parsed from one synced Markdown file.
     * @param {Object|null} incumbent Current winner for the same Discussion id.
     * @returns {Boolean} True when `candidate` must replace `incumbent`.
     */
    static isPreferredDiscussionSource(candidate, incumbent) {
        if (!incumbent) {
            return true;
        }

        if (candidate.updatedAtMs !== incumbent.updatedAtMs) {
            return candidate.updatedAtMs > incumbent.updatedAtMs;
        }

        if (candidate.isIndexedPath !== incumbent.isIndexedPath) {
            return candidate.isIndexedPath;
        }

        if (candidate.isArchived !== incumbent.isArchived) {
            return !candidate.isArchived;
        }

        return candidate.filePath.localeCompare(incumbent.filePath) < 0;
    }

    /**
     * @summary Performs a one-shot normalization of legacy anchor-written issue edge weights, stamped
     * into `SchemaVersion` (`issue_ingestor_legacy_anchor_reset_v1`) so subsequent multi-session
     * `linkNodes` reinforcements above `1.0` are preserved.
     *
     * Strips historical open-issue `bug` / community emphasis multipliers and `0.05` blocker discounts
     * across `OPEN` and `CLOSED` issue edges while preserving unboosted decayed scent weights (`0.1..1.0`),
     * retired-goal `ADVANCED_BY` weights (`0.1`), and `frontier -> GUIDES` synthesis edges.
     *
     * @param {Array<{issueId: String, meta: Object}>} [parsedIssues=[]] Issues parsed during Pass 1.
     * @returns {{skipped: Boolean, repairedCount: Number}}
     */
    normalizeLegacyAnchoredIssueEdgesOnce(parsedIssues = []) {
        if (!GraphService.db) {
            return {skipped: true, repairedCount: 0};
        }

        const sqliteDb = GraphService.db?.storage?.db || null;
        const hasTable = name => Boolean(sqliteDb.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
        ).get(name));

        if (sqliteDb) {
            if (hasTable('SchemaVersion') &&
                sqliteDb.prepare('SELECT 1 FROM SchemaVersion WHERE id = ? LIMIT 1').get(LEGACY_ANCHOR_RESET_MARKER_ID)) {
                return {skipped: true, repairedCount: 0};
            }
        } else if (normalizedInMemoryStores.has(GraphService.db)) {
            return {skipped: true, repairedCount: 0};
        }

        const internalAuthorLogins = readInternalAuthorLogins(
            GraphService,
            error => logger.warn(`[IssueIngestor] AgentIdentity nodes unavailable during legacy anchor weight reset: ${error.message}`)
        );
        const issueNodesById = new Map();

        if (sqliteDb && hasTable('Nodes')) {
            const nodeRows = sqliteDb.prepare("SELECT id, data FROM Nodes WHERE id LIKE 'issue-%'").all();
            for (const row of nodeRows) {
                try {
                    const parsed = JSON.parse(row.data);
                    issueNodesById.set(row.id, {...parsed, id: parsed?.id || row.id});
                } catch {
                    // Ignore malformed node payloads; Pass 1 overlay or default 1.0 multiplier applies.
                }
            }
        }

        for (const item of parsedIssues) {
            if (!item?.issueId || !item?.meta) continue;
            const {issueId, meta} = item;
            issueNodesById.set(issueId, {
                id        : issueId,
                type      : 'ISSUE',
                state     : meta.state,
                properties: {
                    state : meta.state,
                    labels: Array.isArray(meta.labels) ? meta.labels : [],
                    author: meta.author || null
                }
            });
        }

        if (sqliteDb) {
            GraphService.db.storage?.assertTestWriteIsolated?.();

            let repairedCount = 0;

            sqliteDb.transaction(() => {
                if (hasTable('Edges')) {
                    const edgeRows       = sqliteDb.prepare("SELECT id, source, target, type, data FROM Edges WHERE source LIKE 'issue-%' OR target LIKE 'issue-%'").all();
                    const updateEdgeStmt = sqliteDb.prepare('UPDATE Edges SET data = ? WHERE id = ?');

                    for (const row of edgeRows) {
                        let parsed;
                        try {
                            parsed = JSON.parse(row.data);
                        } catch {
                            continue;
                        }

                        const nextWeight = resolveNormalizedLegacyIssueEdgeWeight({
                            source    : row.source,
                            target    : row.target,
                            type      : row.type,
                            properties: parsed?.properties
                        }, issueNodesById, internalAuthorLogins);

                        if (nextWeight === null) continue;

                        parsed.properties = {...(parsed.properties || {}), weight: nextWeight};
                        updateEdgeStmt.run(JSON.stringify(parsed), row.id);
                        repairedCount++;

                        syncCachedEdgeProperties(
                            GraphService.db,
                            {id: row.id, source: row.source, target: row.target},
                            {weight: nextWeight}
                        );
                    }
                }

                sqliteDb.exec(`
                    CREATE TABLE IF NOT EXISTS SchemaVersion (
                        id TEXT PRIMARY KEY,
                        version INTEGER NOT NULL,
                        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                    );
                `);
                sqliteDb.prepare(`
                    INSERT INTO SchemaVersion (id, version, updated_at)
                    VALUES (?, 1, CURRENT_TIMESTAMP)
                    ON CONFLICT(id) DO UPDATE SET
                        version = excluded.version,
                        updated_at = excluded.updated_at
                `).run(LEGACY_ANCHOR_RESET_MARKER_ID);
            })();

            if (repairedCount > 0) {
                GraphService.db.acknowledgeLocalMutations?.();
                logger.info(`[IssueIngestor] Normalized ${repairedCount} legacy anchor-weighted issue edges.`);
            }

            return {skipped: false, repairedCount};
        }

        const edges    = GraphService.db.edges?.items || [];
        const repaired = [];

        for (const edge of edges) {
            const properties = edge?.isRecord ? edge.get('properties') : edge?.properties;
            const nextWeight = resolveNormalizedLegacyIssueEdgeWeight({
                source: edge?.isRecord ? edge.get('source') : edge?.source,
                target: edge?.isRecord ? edge.get('target') : edge?.target,
                type  : edge?.isRecord ? edge.get('type')   : edge?.type,
                properties
            }, issueNodesById, internalAuthorLogins);

            if (nextWeight === null) continue;

            if (edge?.isRecord) {
                edge.set({properties: {...(properties || {}), weight: nextWeight}});
            } else {
                (edge.properties ||= {}).weight = nextWeight;
            }
            repaired.push(edge);
        }

        normalizedInMemoryStores.add(GraphService.db);

        if (repaired.length > 0 && GraphService.db.autoSave && GraphService.db.storage?.addEdges) {
            GraphService.db.storage.addEdges(repaired);
            GraphService.db.acknowledgeLocalMutations?.();
        }

        return {skipped: false, repairedCount: repaired.length};
    }

    /**
     * Resolves the materialized corpus root from an explicit argument or `orchestrator.corpusProjection`,
     * refusing when neither is configured.
     * @param {String} [contentRoot]
     * @param {String} methodName
     * @returns {String}
     * @private
     */
    #resolveContentRoot(contentRoot, methodName) {
        if (typeof contentRoot === 'string' && contentRoot.trim().length > 0) {
            return contentRoot;
        }

        if (aiConfig.orchestrator.corpusProjection.enabled && aiConfig.orchestrator.corpusProjection.materializedRoot) {
            return aiConfig.orchestrator.corpusProjection.materializedRoot;
        }

        throw new Error(
            `IssueIngestor#${methodName}: no contentRoot supplied and orchestrator.corpusProjection.enabled is false ` +
            '(set orchestrator.corpusProjection.enabled / orchestrator.corpusProjection.materializedRoot or pass contentRoot).'
        );
    }

    /**
     * @summary Syncs markdown issue state into the Native Graph and `neo_graph_nodes` vectors, stamping
     * `author` and `assignees` (empty list when unassigned). On `OPEN` issues, re-asserts only
     * `ANCHORED_ISSUE_EDGE_TYPES` (`PARENT_OF` and `BLOCKS`) to `1.0`—matching
     * `GraphService#getInboundStructuralSupport()`—so scent edges (`DISCUSSED_IN`, non-frontier `GUIDES`,
     * `RELATES_TO`, `ADVANCES`) decay via `decayGlobalTopology()`; open blockers gate routing via
     * `hasOpenBlocker` while `bug` and triaged community emphasis apply at Golden Path read time.
     * @param {Object} [options]
     * @param {String} [options.contentRoot] Exact-revision materialized corpus root.
     * @param {Boolean} [options.strict=false] True rejects any otherwise-swallowed facet error so a
     * projection receipt can advance only after error-free completion.
     * @param {Boolean} [options.reconcile=false] True deletes source-absent ISSUE rows/vectors.
     * @param {Object|null} [options.projectionContext=null] Exact source identity stamped on produced rows.
     * @returns {Promise<Object[]>} Returns only the OPEN issues for synthesis.
     */
    async ingestIssueStates({
        contentRoot,
        strict = false,
        reconcile = false,
        projectionContext = null
    } = {}) {
        contentRoot       = this.#resolveContentRoot(contentRoot, 'ingestIssueStates');
        projectionContext = normalizeProjectionContext(projectionContext, reconcile);
        const projectionMetadata = getProjectionMetadata(projectionContext);
        const targetPaths        = [
            path.resolve(contentRoot, 'issues'),
            path.resolve(contentRoot, 'archive/issues')
        ];

        const filesRaw = [];
        for (const targetPath of targetPaths) {
            try {
                if (fs.existsSync(targetPath)) {
                    const files = await fs.promises.readdir(targetPath, { recursive: true });
                    filesRaw.push(...files.filter(f => typeof f === 'string' && f.endsWith('.md')).map(f => path.join(targetPath, f)));
                }
            } catch (e) {
                if (strict) throw e;
                logger.warn(`[IssueIngestor] Error reading issues from ${targetPath}`, e);
            }
        }

        if (filesRaw.length === 0 && !reconcile) {
            return [];
        }

        const files        = filesRaw;
        const openIssues   = [];
        const parsedIssues = [];

        const indexMap = await loadIndexMap(contentRoot, 'issues');

        let nodesCollection = null;
        if (StorageRouter) {
            nodesCollection = await StorageRouter.getGraphCollection();
        }

        // Pass 1: Upsert all nodes
        for (const filePath of files) {
            const content = await fs.promises.readFile(filePath, 'utf8');
            const match   = content.match(/^---\n([\s\S]*?)\n---/);
            if (match) {
                try {
                    const meta = yaml.load(match[1]);
                    if (meta && meta.state) {
                        const relativeToContent = path.relative(contentRoot, filePath);
                        let   id                = indexMap.get(relativeToContent);
                        if (id === undefined) {
                            id = meta.id || path.basename(filePath).replace(/\.md$/, '').replace(/^issue-/, '');
                        }
                        const issueId = 'issue-' + id;

                        GraphService.upsertNode({
                            id        : issueId,
                            type      : 'ISSUE',
                            name      : meta.title || issueId,
                            state     : meta.state,
                            properties: {
                                state    : meta.state,
                                labels   : Array.isArray(meta.labels) ? meta.labels : [],
                                author   : meta.author || null,
                                assignees: Array.isArray(meta.assignees) ? meta.assignees : [],
                                ...projectionMetadata
                            },
                            updatedAt: meta.updatedAt || meta.createdAt
                        });

                        parsedIssues.push({ issueId, meta, content, filePath });
                    }
                } catch (e) {
                    if (strict) throw e;
                    logger.warn(`[IssueIngestor] Failed to parse frontmatter for ${filePath}`, e);
                }
            }
        }

        this.normalizeLegacyAnchoredIssueEdgesOnce(parsedIssues);

        // Pass 2: Link edges and process open issues
        const extractIssueId = (str) => {
            if (!str) return null;
            const m = String(str).match(/(\d+)/);
            return m ? `issue-${m[1]}` : null;
        };

        for (const { issueId, meta, content, filePath } of parsedIssues) {
            try {
                if (meta.parentIssue) {
                    const parentId = extractIssueId(meta.parentIssue);
                    if (parentId && GraphService.db.nodes.get(parentId)) GraphService.linkNodes(parentId, issueId, 'PARENT_OF', 1.0);
                }

                if (Array.isArray(meta.subIssues)) {
                    meta.subIssues.forEach(sub => {
                        const subId = extractIssueId(sub);
                        if (subId && GraphService.db.nodes.get(subId)) GraphService.linkNodes(issueId, subId, 'PARENT_OF', 1.0);
                    });
                }

                if (Array.isArray(meta.blockedBy)) {
                    meta.blockedBy.forEach(blocker => {
                        const blockerId = extractIssueId(blocker);
                        if (blockerId && GraphService.db.nodes.get(blockerId)) GraphService.linkNodes(blockerId, issueId, 'BLOCKS', 1.0);
                    });
                }

                if (Array.isArray(meta.blocking)) {
                    meta.blocking.forEach(blocked => {
                        const blockedId = extractIssueId(blocked);
                        if (blockedId && GraphService.db.nodes.get(blockedId)) GraphService.linkNodes(issueId, blockedId, 'BLOCKS', 1.0);
                    });
                }

                if (meta.state === 'OPEN') {
                    GraphService.db.getAdjacentNodes(issueId, 'both');

                    const anchoredEdges = GraphService.db.edges.items.filter(
                        e => (e.source === issueId || e.target === issueId) && ANCHORED_ISSUE_EDGE_TYPE_SET.has(e.type)
                    );
                    if (anchoredEdges.length > 0) {
                        anchoredEdges.forEach(e => {
                            (e.properties ||= {}).weight = 1.0;
                        });
                        if (GraphService.db.autoSave && GraphService.db.storage) {
                            GraphService.db.storage.addEdges(anchoredEdges);
                            GraphService.db.acknowledgeLocalMutations?.();
                        }
                    }

                    const body         = content.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
                    const titleAndBody = `${meta.title}\n\n${body}`;

                    // Markdown-Aware Vector Chunking using hash bypass
                    if (nodesCollection) {
                        const contentHash    = crypto.createHash('md5').update(titleAndBody).digest('hex');
                        let   needsEmbedding = true;

                        try {
                            const existing = await nodesCollection.get({ ids: [issueId], include: ['metadatas'] });
                            if (existing && existing.ids.length > 0) {
                                const exMeta = existing.metadatas[0] || {};
                                if (exMeta.hash === contentHash) {
                                    needsEmbedding = false;

                                    if (projectionContext && Object.entries(projectionMetadata)
                                        .some(([key, value]) => exMeta[key] !== value)) {
                                        await nodesCollection.update({
                                            ids      : [issueId],
                                            metadatas: [{...exMeta, hash: contentHash, title: meta.title, type: 'ISSUE', ...projectionMetadata}]
                                        })
                                    }
                                }
                            }
                        } catch (e) {
                            if (strict) throw e;
                            console.error("IssueIngestor GET error:", e);
                        }

                        if (needsEmbedding) {
                            logger.debug(`[IssueIngestor] Dynamically embedding OPEN issue: ${issueId}`);
                            await nodesCollection.upsert({
                                ids      : [issueId],
                                documents: [titleAndBody],
                                metadatas: [{hash: contentHash, title: meta.title, type: 'ISSUE', ...projectionMetadata}]
                            });
                        }
                    }

                    openIssues.push({
                        sourceType: 'ISSUE',
                        issueId   : issueId || meta.id || path.basename(filePath).replace(/\.md$/, ''),
                        createdAt : meta.createdAt,
                        title     : meta.title,
                        body
                    });
                }
            } catch (e) {
                if (strict) throw e;
                logger.warn(`[IssueIngestor] Failed to link edges for ${filePath}`, e);
            }
        }

        if (reconcile) {
            await reconcileProjectionFacet({
                expectedGraphNodeIds: new Set(parsedIssues.map(item => item.issueId)),
                expectedVectorIds   : new Set(openIssues.map(item => item.issueId)),
                graphLabels         : ['ISSUE'],
                isOwnedGraphNode(node) {
                    return /^issue-\d+$/.test(readNodeField(node, 'id'))
                },
                nodesCollection,
                vectorType     : 'ISSUE',
                vectorIdPattern: /^issue-\d+$/,
                projectionContext
            })
        }

        return openIssues;
    }

    /**
     * @summary Extracts Ideation Sandbox Discussion content to drive semantic and structural context.
     * Searches both active and archived discussion directories recursively.
     * @param {Object} [options]
     * @param {String} [options.contentRoot] Exact-revision materialized corpus root.
     * @param {Boolean} [options.strict=false] True rejects directory/frontmatter errors for truthful facet completion.
     * @param {Boolean} [options.reconcile=false] True deletes source-absent DISCUSSION rows/vectors.
     * @param {Object|null} [options.projectionContext=null] Exact source identity stamped on produced rows.
     * @returns {Promise<void>}
     */
    async ingestDiscussionStates({
        contentRoot,
        strict = false,
        reconcile = false,
        projectionContext = null
    } = {}) {
        contentRoot       = this.#resolveContentRoot(contentRoot, 'ingestDiscussionStates');
        projectionContext = normalizeProjectionContext(projectionContext, reconcile);
        const projectionMetadata = getProjectionMetadata(projectionContext);
        const targetPaths        = [
            path.resolve(contentRoot, 'discussions'),
            path.resolve(contentRoot, 'archive/discussions')
        ];

        const files = [];
        for (const targetPath of targetPaths) {
            try {
                if (fs.existsSync(targetPath)) {
                    const items = await fs.promises.readdir(targetPath, { recursive: true });
                    files.push(...items.filter(f => typeof f === 'string' && f.endsWith('.md')).map(f => path.join(targetPath, f)));
                }
            } catch (e) {
                if (strict) throw e;
                logger.warn(`[IssueIngestor] Error reading discussions from ${targetPath}`, e);
            }
        }

        const indexMap = await loadIndexMap(contentRoot, 'discussions');

        const nodesCollection = await StorageRouter.getGraphCollection();
        const discussions     = new Map();

        for (const filePath of files) {
            const content = await fs.promises.readFile(filePath, 'utf8');
            const match   = content.match(/^---\n([\s\S]*?)\n---/);
            if (!match) {
                continue;
            }

            let meta;
            try {
                meta = yaml.load(match[1]);
            } catch (e) {
                if (strict) throw e;
                logger.warn(`[IssueIngestor] Failed to parse frontmatter for ${filePath}`, e);
                continue;
            }

            if (!meta) {
                continue;
            }

            const relativeToContent = path.relative(contentRoot, filePath);
            const indexedId         = indexMap.get(relativeToContent);
            const id                = indexedId === undefined
                ? meta.number || path.basename(filePath).replace(/\.md$/, '').replace(/^discussion-/, '')
                : indexedId;
            const discussionId = `discussion-${id}`;
            const updatedAtMs  = Date.parse(meta.updatedAt || meta.createdAt || '') || Number.NEGATIVE_INFINITY;
            const candidate    = {
                content,
                discussionId,
                filePath,
                isArchived   : relativeToContent.startsWith(`archive${path.sep}discussions${path.sep}`),
                isIndexedPath: indexedId !== undefined,
                meta,
                updatedAtMs
            };

            if (this.constructor.isPreferredDiscussionSource(candidate, discussions.get(discussionId))) {
                discussions.set(discussionId, candidate);
            }
        }

        for (const {content, discussionId, meta} of discussions.values()) {
            // DiscussionSyncer emits lifecycle metadata; Golden Path OPEN filtering relies on graph state.
            const
                closed                          = meta.closed === true,
                discussionState                 = closed ? 'CLOSED' : 'OPEN',
                closedAt                        = closed ? (meta.closedAt || null) : null,
                category                        = meta.category || 'Ideas',
                routingProjection               = this.constructor.normalizeDiscussionRoutingProjection(meta),
                routingDispositionSchemaVersion = routingProjection.schemaVersion,
                routingDisposition              = routingProjection.disposition,
                routingDispositionReason        = routingProjection.reason,
                routingDispositionEvidence      = routingProjection.evidence;

            GraphService.upsertNode({
                id        : discussionId,
                type      : 'DISCUSSION',
                name      : meta.title || discussionId,
                state     : discussionState,
                updatedAt : meta.updatedAt || meta.createdAt,
                properties: {
                    state: discussionState,
                    closed,
                    closedAt,
                    category,
                    routingDispositionSchemaVersion,
                    routingDisposition,
                    routingDispositionReason,
                    routingDispositionEvidence,
                    ...projectionMetadata
                }
            });

            const body         = content.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
            const titleAndBody = `[DISCUSSION] ${meta.title}\n\n${body}`;
            const
                lifecycleFingerprint = JSON.stringify({
                    closed,
                    closedAt,
                    discussionState,
                    routingDispositionSchemaVersion,
                    routingDisposition,
                    routingDispositionReason,
                    routingDispositionEvidence
                }),
                contentHash = crypto.createHash('md5')
                    .update(`${titleAndBody}\n${lifecycleFingerprint}`)
                    .digest('hex');
            let needsEmbedding = true;

            const existing = await nodesCollection.get({ ids: [discussionId], include: ['metadatas'] });
            if (existing && existing.ids.length > 0) {
                const exMeta = existing.metadatas[0] || {};
                if (exMeta.hash === contentHash) {
                    needsEmbedding = false;

                    if (projectionContext && Object.entries(projectionMetadata)
                        .some(([key, value]) => exMeta[key] !== value)) {
                        await nodesCollection.update({
                            ids      : [discussionId],
                            metadatas: [{
                                ...exMeta,
                                hash : contentHash,
                                title: meta.title,
                                type : 'DISCUSSION',
                                ...projectionMetadata
                            }]
                        })
                    }
                }
            }

            if (needsEmbedding) {
                logger.debug(`[IssueIngestor] Dynamically embedding DISCUSSION: ${discussionId}`);
                await nodesCollection.upsert({
                    ids      : [discussionId],
                    documents: [titleAndBody],
                    metadatas: [{
                        hash                      : contentHash,
                        title                     : meta.title,
                        type                      : 'DISCUSSION',
                        state                     : discussionState,
                        closed,
                        closedAt,
                        category,
                        routingDispositionSchemaVersion,
                        routingDisposition,
                        routingDispositionReason,
                        routingDispositionEvidence: JSON.stringify(routingDispositionEvidence),
                        ...projectionMetadata
                    }]
                });
            }
        }

        if (reconcile) {
            await reconcileProjectionFacet({
                expectedGraphNodeIds: new Set(discussions.keys()),
                graphLabels         : ['DISCUSSION'],
                isOwnedGraphNode(node) {
                    return /^discussion-\d+$/.test(readNodeField(node, 'id'))
                },
                nodesCollection,
                vectorType     : 'DISCUSSION',
                vectorIdPattern: /^discussion-\d+$/,
                projectionContext
            })
        }
    }

    /**
     * @summary Performs dual-path semantic mining on active and archived PR review documents to extract heuristic tags.
     * Parses `[KB_GAP]`, `[TOOLING_GAP]`, and `[RETROSPECTIVE]` tags. Each PULL_REQUEST node carries its
     * `author` login, and `assignees` only where the synced frontmatter holds that key: an absent key
     * projects nothing rather than an empty list the corpus never asserted.
     * @param {Object} [options]
     * @param {String} [options.contentRoot] Exact-revision materialized corpus root.
     * @param {Boolean} [options.strict=false] True rejects directory/frontmatter errors for truthful facet completion.
     * @param {Boolean} [options.reconcile=false] True deletes source-absent PR and PR-gap graph rows.
     * @param {Object|null} [options.projectionContext=null] Exact source identity stamped on produced rows.
     * @returns {Promise<void>}
     */
    async ingestPullRequestFeedback({
        contentRoot,
        strict = false,
        reconcile = false,
        projectionContext = null
    } = {}) {
        contentRoot       = this.#resolveContentRoot(contentRoot, 'ingestPullRequestFeedback');
        projectionContext = normalizeProjectionContext(projectionContext, reconcile);
        const projectionMetadata = getProjectionMetadata(projectionContext);
        const targetPaths        = [
            path.resolve(contentRoot, 'pulls'),
            path.resolve(contentRoot, 'archive/pulls')
        ];

        const files = [];
        for (const targetPath of targetPaths) {
            try {
                if (fs.existsSync(targetPath)) {
                    const items = fs.readdirSync(targetPath, { recursive: true });
                    files.push(...items.filter(f => typeof f === 'string' && f.endsWith('.md')).map(f => path.join(targetPath, f)));
                }
            } catch (e) {
                if (strict) throw e;
                logger.warn(`[IssueIngestor] Error reading pull requests from ${targetPath}`, e);
            }
        }

        const indexMap        = await loadIndexMap(contentRoot, 'pulls');
        const expectedNodeIds = new Set();

        for (const filePath of files) {
            const content = fs.readFileSync(filePath, 'utf8');
            const match   = content.match(/^---\n([\s\S]*?)\n---/);
            if (match) {
                try {
                    const meta = yaml.load(match[1]);
                    if (meta) {
                        const relativeToContent = path.relative(contentRoot, filePath);
                        let   id                = indexMap.get(relativeToContent);
                        if (id === undefined) {
                            id = meta.number || path.basename(filePath).replace(/\.md$/, '').replace(/^pr-/, '');
                        }
                        const prId = `pr-${id}`;
                        expectedNodeIds.add(prId);

                        // Upsert the PR node structurally
                        GraphService.upsertNode({
                            id        : prId,
                            type      : 'PULL_REQUEST',
                            name      : meta.title || prId,
                            state     : meta.state,
                            updatedAt : meta.updatedAt || meta.createdAt,
                            properties: {
                                author: meta.author || null,
                                ...(Array.isArray(meta.assignees) ? {assignees: meta.assignees} : {}),
                                ...projectionMetadata
                            }
                        });

                        // Lexical scanning for tags
                        const lines = content.split('\n');
                        for (const line of lines) {
                            const gapMatch = line.match(/\[(KB_GAP|TOOLING_GAP|RETROSPECTIVE)\](.*?)$/);
                            if (gapMatch) {
                                const gapType    = gapMatch[1]; // KB_GAP, TOOLING_GAP, RETROSPECTIVE
                                const gapContent = gapMatch[2].replace(/^[\`\*:\s]+/, '').trim();

                                if (!gapContent) continue;

                                // Generate deterministic ID based on PR and Gap Content
                                const gapHash = crypto.createHash('md5').update(`${prId}-${gapType}-${gapContent}`).digest('hex');
                                const gapNodeId = `GAP:${gapType}-${gapHash.substring(0, 8)}`;
                                expectedNodeIds.add(gapNodeId);

                                // Upsert Gap Node
                                GraphService.upsertNode({
                                    id: gapNodeId,
                                    type: gapType,
                                    name: `${gapType} from PR #${id}`,
                                    description: gapContent,
                                    properties: {
                                        sourcePr    : prId,
                                        discoveredAt: meta.updatedAt || meta.createdAt,
                                        ...projectionMetadata
                                    }
                                });

                                // Create Hebbian edges
                                GraphService.linkNodes(gapNodeId, prId, 'DISCOVERED_IN', 1.0, {
                                    justification: `Extracted from PR #${id} feedback.`
                                });
                                GraphService.linkNodes(prId, gapNodeId, 'EVALUATED_BY', 1.0, {
                                    justification: `Gap evaluated during PR #${id} review.`
                                });

                                logger.debug(`[IssueIngestor] Ingested ${gapType} from ${prId}: ${gapNodeId}`);
                            }
                        }

                        // Lexical scanning for Resolves/Closes/Fixes issue linkages
                        const issueMatches = [...content.matchAll(/(?:(?:Resolves|Closes|Fixes)\s+#)(\d+)/gi)];
                        for (const issueMatch of issueMatches) {
                            const issueNumber = issueMatch[1];
                            const issueNodeId = `issue-${issueNumber}`;

                            // Create Hebbian edge for PR resolving Issue
                            GraphService.linkNodes(prId, issueNodeId, 'RESOLVES', 1.0, {
                                justification: `PR #${id} explicitly resolves Issue #${issueNumber}.`
                            });

                            logger.debug(`[IssueIngestor] Linked PR ${prId} as resolving ${issueNodeId}`);
                        }
                    }
                } catch (e) {
                    if (strict) throw e;
                    logger.warn(`[IssueIngestor] Failed to process pull request feedback for ${filePath}`, e);
                }
            }
        }

        if (reconcile) {
            await reconcileProjectionFacet({
                expectedGraphNodeIds: expectedNodeIds,
                graphLabels         : ['PULL_REQUEST', ...PULL_GAP_LABELS],
                isOwnedGraphNode(node) {
                    const
                        id         = readNodeField(node, 'id'),
                        label      = readNodeField(node, 'label'),
                        properties = readNodeField(node, 'properties');

                    return label === 'PULL_REQUEST'
                        ? /^pr-\d+$/.test(id)
                        : PULL_GAP_LABELS.includes(label) && /^pr-\d+$/.test(properties?.sourcePr)
                },
                projectionContext
            })
        }
    }
}

export default Neo.setupClass(IssueIngestor);

import fs              from 'fs';
import path            from 'path';
import {fileURLToPath} from 'url';
import Base            from 'neo.mjs/src/core/Base.mjs';
import crypto          from 'crypto';
import GraphService    from './GraphService.mjs';
import logger          from '../../mcp/server/memory-core/logger.mjs';
import {
    DEFAULT_FILESYSTEM_IGNORE_EXTS,
    DEFAULT_FILESYSTEM_IGNORE_PATTERNS,
    SPLIT_TREE_ROOTS,
    getRepositoryNodeId,
    isIgnoredRepositoryPath,
    resolveRepositoryFileReference,
    resolveSplitTreeFileReference
} from '../shared/conceptEdgeValidation.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const neoRootDir = path.resolve(__dirname, '../../../');

/**
 * @summary Ingests the physical Neo project structure into Native Graph nodes.
 *
 * Scans the filesystem dynamically before REM sleep to guarantee the memory-core
 * never hallucinates against stale Codebase structures. Maps files as 'FILE' nodes
 * and folders as 'DIRECTORY', establishing hierarchical 'CONTAINS' edges natively.
 *
 * @class Neo.ai.services.memory-core.FileSystemIngestor
 * @extends Neo.core.Base
 * @singleton
 */
class FileSystemIngestor extends Base {
    static config = {
        className: 'Neo.ai.services.memory-core.FileSystemIngestor',
        singleton: true,
        /**
         * Standard high-noise directories and files to completely ignore.
         */
        ignorePatterns_: [...DEFAULT_FILESYSTEM_IGNORE_PATTERNS],
        /**
         * Extensions to explicitly ignore (images, fonts, raw binaries)
         */
        ignoreExts_: [...DEFAULT_FILESYSTEM_IGNORE_EXTS]
    }

    /**
     * Returns the canonical Native Edge Graph node ID for a repository-relative path.
     * This is the single identity boundary shared by workspace ingestion and curated
     * Concept Ontology projection; author-facing `file:<path>` references never become
     * a second runtime node family.
     * @param {String} relativePath Repository-relative path using either slash style.
     * @returns {String} Canonical `file-<path>` node ID.
     */
    getRepositoryNodeId(relativePath) {
        return getRepositoryNodeId(relativePath);
    }

    /**
     * Tests whether a repository-relative path is outside the workspace projection.
     * Kept public so other deterministic projectors can reject evidence that the
     * filesystem graph itself would intentionally omit.
     * @param {String} relativePath Normalized repository-relative path.
     * @param {Boolean} [isDirectory=false]
     * @returns {Boolean}
     */
    isIgnoredPath(relativePath, isDirectory=false) {
        return isIgnoredRepositoryPath(relativePath, isDirectory, {
            ignorePatterns: this.ignorePatterns,
            ignoreExts    : this.ignoreExts
        });
    }

    /**
     * @summary Resolves a reference authored against the neo repository as it was before the Brain
     * split, in the `SPLIT_TREE_ROOTS` order.
     *
     * The split moved whole directories, so a path exists in exactly one root. A path two roots hold is
     * reported `AMBIGUOUS_FILE` instead of being resolved by precedence, and a path no root holds keeps
     * the first root's finding. A resolved reference names its root (and the root's version, where one
     * is pinned) as data; its identity stays `file-<relativePath>`.
     * @param {String}   relativePath Repository-relative file path.
     * @param {Object[]} [roots=SPLIT_TREE_ROOTS] `{name, dir, version}` rows, in order; injectable for focused tests.
     * @returns {Object} The {@link #resolveFileReference} shape, plus `root` and `rootVersion` when valid.
     */
    resolveSplitTreeReference(relativePath, roots=SPLIT_TREE_ROOTS) {
        return resolveSplitTreeFileReference(relativePath, roots, {
            ignorePatterns: this.ignorePatterns,
            ignoreExts    : this.ignoreExts
        });
    }

    /**
     * Resolves an author-facing repository file reference into the exact runtime
     * identity owned by this ingestor. Validation fails closed: absolute, escaping,
     * non-canonical, missing, ignored, or non-file targets cannot become graph evidence.
     *
     * `rootDir` is injectable for focused tests; production callers use Neo's root.
     * @param {String} relativePath Repository-relative file path.
     * @param {String} [rootDir=neoRootDir] Repository root.
     * @returns {Object} `{valid, code, reason, absolutePath, nodeId, relativePath}`.
     */
    resolveFileReference(relativePath, rootDir=neoRootDir) {
        return resolveRepositoryFileReference(relativePath, rootDir, {
            ignorePatterns: this.ignorePatterns,
            ignoreExts    : this.ignoreExts
        });
    }

    /**
     * Executes the recursive file system sync into the Native Edge Graph and returns a truthful
     * mutation/verification receipt. `rootDir` is injectable for the real-SQLite unit fixture;
     * production callers retain the no-argument Neo-repository default.
     *
     * @param {Object} [options={}]
     * @param {String} [options.rootDir=neoRootDir] Filesystem root to project.
     * @returns {Promise<{status: String, pathNodesUpserted: Number, edgesCreated: Number, edgesVerified: Number, edgesDrifted: Number, edgesCulled: Number, edgesUnavailable: Number}>}
     */
    async syncWorkspaceToGraph({rootDir = neoRootDir} = {}) {
        logger.info('[FileSystemIngestor] Initiating dynamic filesystem-to-graph sync...');

        const stats = {
            pathNodesUpserted: 0,
            edgesCreated     : 0,
            edgesVerified    : 0,
            edgesDrifted     : 0,
            edgesCulled      : 0,
            edgesUnavailable : 0
        };

        if (!GraphService.db?.nodes || !GraphService.db?.storage?.db) {
            logger.warn('[FileSystemIngestor] GraphService DB not mounted. Aborting sync.');
            return {status: 'unavailable', ...stats}
        }

        // Precache existing mtimeMs dynamically bypassing RAM bloat cleanly natively
        const mtimeMap = new Map();
        const hashMap  = new Map();
        const sqlite   = GraphService.db?.storage?.db;
        if (sqlite) {
            try {
                const stmt = sqlite.prepare("SELECT id, data FROM Nodes WHERE id LIKE 'file-%'");
                const rows = stmt.all();
                for (const row of rows) {
                    const parsedData = JSON.parse(row.data);
                    if (parsedData?.properties?.mtimeMs) {
                        mtimeMap.set(row.id, parsedData.properties.mtimeMs);
                    }
                    if (parsedData?.properties?.hash) {
                        hashMap.set(row.id, parsedData.properties.hash);
                    }
                }
            } catch (e) {
                logger.debug(`[FileSystemIngestor] Caching skipped: ${e.message}`);
            }
        }

        const rootNodeId = 'project-root';
        GraphService.upsertNode({
            id         : rootNodeId,
            type       : 'SYSTEM_ANCHOR',
            name       : 'Neo.mjs Ecosystem Root',
            description: 'The physical root directory of the Neo.mjs project.'
        });

        await this.walkDirectory(rootDir, rootDir, rootNodeId, stats, mtimeMap, hashMap);

        logger.info(
            `[FileSystemIngestor] Workspace Sync Complete. Upserted ${stats.pathNodesUpserted} path nodes; ` +
            `CONTAINS edges created=${stats.edgesCreated}, verified=${stats.edgesVerified}, ` +
            `drifted=${stats.edgesDrifted}, culled=${stats.edgesCulled}, unavailable=${stats.edgesUnavailable}.`
        );

        return {status: 'completed', ...stats}
    }

    /**
     * Recursive folder iteration mapping directly to GraphService endpoints.
     * @param {String} dir Current directory path
     * @param {String} rootDir The base root path determining relative node ids natively
     * @param {String|null} parentId Graph ID of the parent directory Node
     * @param {{pathNodesUpserted: Number, edgesCreated: Number, edgesVerified: Number, edgesDrifted: Number, edgesCulled: Number, edgesUnavailable: Number}} stats Mutation/verification counters.
     * @param {Map} mtimeMap Precaching SQLite map
     * @param {Map} hashMap Precaching SQLite hash map
     */
    async walkDirectory(dir, rootDir, parentId, stats, mtimeMap, hashMap) {
        let files;
        try {
            files = await fs.promises.readdir(dir);
        } catch(e) { return; }

        for (const file of files) {
            const fullPath = path.join(dir, file);
            let   isDir    = false;
            let stat;

            try {
                stat = await fs.promises.lstat(fullPath);

                // Repository symlinks are deliberately outside the filesystem graph:
                // following them can duplicate subtrees or admit targets outside root.
                if (stat.isSymbolicLink()) continue;

                isDir = stat.isDirectory();
            } catch(e) { continue; }

            const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

            // Keep every graph producer on the same projectability boundary.
            if (this.isIgnoredPath(relativePath, isDir)) {
                continue;
            }

            const nodeId  = this.getRepositoryNodeId(relativePath);
            const mtimeMs = stat.mtimeMs;

            const mtimeMatch  = mtimeMap.get(nodeId) === mtimeMs;
            let   fileHash    = null;
            let   isUnchanged = mtimeMatch;

            // Only hash if mtime mismatch on actual files
            if (!mtimeMatch && !isDir) {
                try {
                    const content = await fs.promises.readFile(fullPath);
                    fileHash = crypto.createHash('md5').update(content).digest('hex');
                    if (hashMap.get(nodeId) === fileHash) {
                        isUnchanged = true;
                    }
                } catch(e) {}
            }

            if (!isUnchanged) {
                // Upsert node bypassing textual embeddings (these are purely structural references)
                GraphService.upsertNode({
                    id         : nodeId,
                    type       : isDir ? 'DIRECTORY' : 'FILE',
                    name       : file,
                    description: isDir ? `Directory: ${relativePath}` : `File path: ${relativePath}`,
                    properties : {
                        path             : relativePath,
                        mtimeMs,
                        isConceptEdgeStub: false,
                        ...(fileHash && { hash: fileHash })
                    }
                });
                stats.pathNodesUpserted++;
            }

            // Filesystem hierarchy is an asserted fact, not a learning signal. Verify it on every
            // walk so missing topology self-heals, but never reinforce an unchanged relation.
            if (parentId) {
                const {status} = GraphService.ensureStructuralEdge(parentId, nodeId, 'CONTAINS', 1.0);

                if (status === 'created') {
                    stats.edgesCreated++
                } else if (status === 'verified') {
                    stats.edgesVerified++
                } else if (status === 'drifted') {
                    stats.edgesDrifted++
                } else if (status === 'culled') {
                    stats.edgesCulled++
                } else {
                    stats.edgesUnavailable++
                }
            }

            if (isDir) {
                await this.walkDirectory(fullPath, rootDir, nodeId, stats, mtimeMap, hashMap);
            }
        }
    }
}

export default Neo.setupClass(FileSystemIngestor);

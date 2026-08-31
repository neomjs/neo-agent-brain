import Base         from './Base.mjs';
import SourceParser from '../parser/SourceParser.mjs';
import fs           from 'fs-extra';
import logger       from '../../../mcp/server/knowledge-base/logger.mjs';
import path         from 'path';
import aiConfig     from '../../../mcp/server/knowledge-base/config.mjs';

import {assertCoverageBaseline, loadClassHierarchy} from '../helpers/classHierarchyContract.mjs';

/**
 * @summary Extracts knowledge chunks from Neo.mjs source code.
 *
 * This source provider scans configured Brain roots and installed Engine package roots for `.mjs`
 * files. No repository-root compatibility projection participates.
 * It delegates the parsing logic to `SourceParser`, which decomposes the source code
 * into semantic chunks (Module Context, Class Properties, Config, Methods).
 *
 * This approach ensures the Knowledge Base contains deep implementation details,
 * allowing the AI to understand not just the API contract but also the logic and patterns
 * used within the framework.
 *
 * @class Neo.ai.services.knowledge-base.source.ApiSource
 * @extends Neo.ai.services.knowledge-base.source.Base
 * @singleton
 */
class ApiSource extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.services.knowledge-base.source.ApiSource'
         * @protected
         */
        className: 'Neo.ai.services.knowledge-base.source.ApiSource',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * Extracts knowledge chunks from the source directory.
     * @param {Object}   writeStream  The JSONL write stream.
     * @param {Function} createHashFn Function to create content hash.
     * @returns {Promise<Number>} The number of chunks extracted.
     */
    async extract(writeStream, createHashFn) {
        // Ordered source rows keep dotted package paths as VALUES. Filesystem paths cannot be
        // reactive-namespace object keys: dots are structural separators in the config substrate.
        const sourceEntries = aiConfig.sourcePaths.ApiSource;

        if (!Array.isArray(sourceEntries) || !sourceEntries.every(entry =>
            entry && typeof entry.path === 'string' && entry.path &&
            typeof entry.type === 'string' && entry.type
        )) {
            throw new TypeError('ApiSource requires sourcePaths.ApiSource as ordered {path,type} rows')
        }

        // Fail-closed, because the hierarchy is an IDENTITY input rather than an enrichment:
        // `extends` is hashed into every chunk id, so an absent map re-identifies every class
        // member and marks the existing corpus stale. The contract and the incident that earned
        // it live in the helper's docblock. Refusal happens HERE, before the indexing loop below,
        // so no chunk is written under a degraded identity.
        const hierarchy = await loadClassHierarchy({
            hierarchyPath  : aiConfig.hierarchyPath,
            sourcePathCount: sourceEntries.length
        });

        let count = 0;

        // Per-root coverage, measured rather than inferred from the map being non-empty. Those are
        // different claims: the map is produced for the docs site, and this source indexes roots that
        // producer never covered, so a loaded map can still leave a whole tree with empty `extends`.
        // Reported per root on every ingest so the next regression is loud — see the helper for why
        // this reports instead of refusing.
        const coverage = {};

        for (const {path: sourcePath, type} of sourceEntries) {
            coverage[sourcePath] = {declared: 0, resolved: 0};

            count += await this.indexRawDirectory(
                writeStream,
                createHashFn,
                sourcePath,
                type,
                hierarchy,
                coverage[sourcePath]
            )
        }

        this.assertAndReportCoverage(coverage);

        return count;
    }

    /**
     * @summary Extracts one API territory from an exact repository revision.
     *
     * This is the profile-runner path. Every authority arrives through `context`; unlike the
     * temporary legacy wrapper above it never reads `aiConfig.sourcePaths`,
     * `aiConfig.hierarchyPath`, cwd, or a filesystem root.
     *
     * @param {Object} params
     * @param {Object} params.context Repository-bound invocation context.
     * @param {Object} params.options Route options; requires semantic `type`.
     * @param {Object} params.writeStream JSONL output.
     * @param {Function} params.createHashFn Legacy content hash function.
     * @returns {Promise<{count: Number, yieldedSourcePaths: String[], skippedSourcePaths: Object[], coverage: Object}>}
     */
    async extractFromRepository({context, options = {}, writeStream, createHashFn} = {}) {
        const
            reader       = context?.repositoryReader,
            resolver     = context?.hierarchyResolver,
            semanticType = typeof options.type === 'string' ? options.type.trim() : '';

        if (!reader || typeof reader.readText !== 'function') {
            throw new TypeError('ApiSource repository extraction requires context.repositoryReader')
        }
        if (
            !context?.hierarchy
            && (!resolver || typeof resolver.resolve !== 'function' || !resolver.id || !resolver.version)
        ) {
            throw new TypeError('ApiSource repository extraction requires an identity-bearing hierarchyResolver')
        }
        if (!semanticType) {
            throw new TypeError('ApiSource repository extraction requires route.options.type')
        }

        const
            assignments = [...(context?.territory?.assignments || [])]
                .sort((left, right) => left.entry.sourcePath === right.entry.sourcePath
                    ? 0
                    : left.entry.sourcePath < right.entry.sourcePath ? -1 : 1),
            hierarchy = context.hierarchy || await resolver.resolve({
                tenantId        : context.tenantId,
                repoSlug        : context.repoSlug,
                revision        : context.revision,
                repositoryReader: reader,
                territory       : context.territory
            }),
            coverage = {},
            yieldedSourcePaths = [],
            skippedSourcePaths = [],
            chunksToWrite = [];

        if (!hierarchy || typeof hierarchy !== 'object' || Array.isArray(hierarchy)) {
            throw new TypeError('ApiSource hierarchyResolver.resolve() must return a hierarchy map')
        }

        for (const assignment of assignments) {
            const sourcePath = assignment.entry.sourcePath;

            if (!sourcePath.endsWith('.mjs')) {
                continue
            }

            let content;

            try {
                content = await reader.readText(sourcePath);
            } catch (error) {
                if (error.code === 'KB_REVISION_READER_BINARY_BLOB') {
                    skippedSourcePaths.push({sourcePath, reason: 'binary'});
                    continue
                }
                throw error
            }

            const rootCoverage = coverage[assignment.root] ||= {declared: 0, resolved: 0};
            const chunks       = SourceParser.parse(
                content,
                sourcePath,
                semanticType,
                hierarchy,
                rootCoverage,
                {strict: true}
            );

            if (chunks.length) {
                yieldedSourcePaths.push(sourcePath);
            }

            chunksToWrite.push(...chunks);
        }

        // Resolve and validate every class before the first write. The legacy wrapper writes to a
        // disposable build stream before checking; profile execution may become durable through the
        // tenant lane, so a hierarchy regression cannot leak a partial route.
        this.assertAndReportCoverage(coverage);
        const count = this.writeChunks({
            chunks: chunksToWrite,
            createHashFn,
            writeStream
        });

        return {
            count,
            yieldedSourcePaths: [...new Set(yieldedSourcePaths)].sort(),
            skippedSourcePaths,
            coverage
        };
    }

    /**
     * @summary Applies the interim hierarchy regression floor and reports standing debt.
     *
     * Unknown tenant roots have no floor and remain observable without being refused. Repository
     * hierarchy authority and the eventual baseline retirement stay owned by the injected resolver
     * lane; this preserves the existing guard while that migration lands.
     *
     * @param {Object} coverage Per-root declared/resolved tallies.
     * @returns {void}
     * @protected
     */
    assertAndReportCoverage(coverage) {
        for (const {root, declared, resolved, ratio, floor} of assertCoverageBaseline({coverage})) {
            const percent = (ratio * 100).toFixed(1);

            if (resolved < declared) {
                logger.warn?.(`[ApiSource] Class hierarchy resolves ${resolved}/${declared} (${percent}%) of the classes declaring a superclass under '${root}' — the remainder ingest with an empty 'extends', which is part of their chunk id. Known interim debt at floor ${floor === undefined ? 'unbaselined' : (floor * 100).toFixed(1) + '%'}; the generator's domain does not cover this root.`);
            } else {
                logger.log?.(`[ApiSource] Class hierarchy resolves ${resolved}/${declared} (100%) under '${root}'.`);
            }
        }
    }

    /**
     * @summary Hashes and writes parsed chunks in their parser-provided order.
     * @param {Object} options
     * @returns {Number}
     * @protected
     */
    writeChunks({chunks, createHashFn, writeStream}) {
        let count = 0;

        chunks.forEach(chunk => {
            chunk.hash = createHashFn(chunk);
            writeStream.write(JSON.stringify(chunk) + '\n');
            count++;
        });

        return count;
    }

    /**
     * Recursively scans a directory and indexes .mjs files.
     * @param {Object}   writeStream           The stream to write chunks to.
     * @param {Function} createHashFn          Function to create content hash.
     * @param {String}   relativePath          The relative path from cwd to scan.
     * @param {String}   defaultType           The default type to assign to chunks.
     * @param {Object}   hierarchy             The class hierarchy map.
     * @returns {Promise<Number>} The number of chunks created.
     * @private
     */
    async indexRawDirectory(writeStream, createHashFn, relativePath, defaultType, hierarchy, coverage) {
        let   count    = 0;
        const fullPath = path.resolve(aiConfig.neoRootDir, relativePath);

        if (!await fs.pathExists(fullPath)) return 0;

        const entries = await fs.readdir(fullPath, {withFileTypes: true});
        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
            const entryName         = entry.name;
            const entryPath         = path.join(fullPath, entryName);
            const relativeEntryPath = path.join(relativePath, entryName);

            if (entry.isDirectory()) {
                if (entryName === 'node_modules') continue; // Safety check
                count += await this.indexRawDirectory(writeStream, createHashFn, relativeEntryPath, defaultType, hierarchy, coverage);
            } else if (entry.isFile() && entryName.endsWith('.mjs')) {
                const content = await fs.readFile(entryPath, 'utf-8');

                // Emit the neoRootDir-relative path as chunk metadata.source so the distributed
                // Chroma zip shipped with each neo release stays portable across recipients'
                // filesystems. SearchService resolves against its own neoRootDir at read time.
                // Absolute paths would hard-code the local FS layout into the distributed zip.
                const chunks = SourceParser.parse(content, relativeEntryPath, defaultType, hierarchy, coverage);

                count += this.writeChunks({chunks, createHashFn, writeStream});
            }
        }
        return count;
    }
}

export default Neo.setupClass(ApiSource);

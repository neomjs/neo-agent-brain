import Base     from './Base.mjs';
import fs       from 'fs-extra';
import path     from 'path';
import aiConfig from '../../../mcp/server/knowledge-base/config.mjs';

/**
 * @summary Extracts knowledge chunks from Architecture Decision Records (ADRs).
 *
 * This source provider reads `learn/agentos/decisions/0NNN-*.md`.
 * Each ADR file is treated as a single knowledge chunk.
 *
 * @class Neo.ai.services.knowledge-base.source.AdrSource
 * @extends Neo.ai.services.knowledge-base.source.Base
 * @singleton
 */
class AdrSource extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.services.knowledge-base.source.AdrSource'
         * @protected
         */
        className: 'Neo.ai.services.knowledge-base.source.AdrSource',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * Extracts knowledge chunks from ADR markdown files.
     * @param {Object}   writeStream  The JSONL write stream.
     * @param {Function} createHashFn Function to create content hash.
     * @returns {Promise<Number>} The number of chunks extracted.
     */
    async extract(writeStream, createHashFn) {
        let count = 0;
        // Per-source path from the `sourcePaths` config (SSOT — the leaf in the KB config template
        // defines every Source's default path).
        const adrDir = path.resolve(aiConfig.neoRootDir, aiConfig.sourcePaths.AdrSource);

        if (await fs.pathExists(adrDir)) {
            const files = await fs.readdir(adrDir);
            files.sort();

            for (const file of files) {
                // Match the 0NNN-*.md pattern
                if (!file.match(/^\d{4}-.*\.md$/)) continue;

                const filePath   = path.join(adrDir, file);
                const rawContent = await fs.readFile(filePath, 'utf-8');

                const chunk = {
                    type   : 'adr',
                    kind   : 'adr',
                    name   : path.basename(file, '.md'),
                    content: rawContent.trim(),
                    source : path.relative(aiConfig.neoRootDir, filePath)
                };

                chunk.hash = createHashFn(chunk);
                writeStream.write(JSON.stringify(chunk) + '\n');
                count++;
            }
        }

        return count;
    }

    /**
     * @summary Extracts top-level ADR files from one assigned repository territory.
     * @param {Object} params Repository-bound route invocation.
     * @returns {Promise<{count: Number, yieldedSourcePaths: String[], skippedSourcePaths: Object[]}>}
     */
    async extractFromRepository({context, writeStream, createHashFn} = {}) {
        const reader = context?.repositoryReader;

        if (!reader || typeof reader.readText !== 'function') {
            throw new TypeError('AdrSource repository extraction requires context.repositoryReader')
        }

        const
            assignments = [...(context?.territory?.assignments || [])]
                .sort((left, right) => left.entry.sourcePath === right.entry.sourcePath
                    ? 0
                    : left.entry.sourcePath < right.entry.sourcePath ? -1 : 1),
            yieldedSourcePaths = [],
            skippedSourcePaths = [];

        for (const assignment of assignments) {
            const
                sourcePath = assignment.entry.sourcePath,
                file       = assignment.relativePath;

            if (typeof file !== 'string' || !/^\d{4}-[^/]*\.md$/u.test(file)) {
                skippedSourcePaths.push({sourcePath, reason: 'not-adr'});
                continue
            }

            let rawContent;

            try {
                rawContent = await reader.readText(sourcePath);
            } catch (error) {
                if (error.code === 'KB_REVISION_READER_BINARY_BLOB') {
                    skippedSourcePaths.push({sourcePath, reason: 'binary'});
                    continue
                }
                throw error
            }

            const chunk = {
                type   : 'adr',
                kind   : 'adr',
                name   : path.posix.basename(file, '.md'),
                content: rawContent.trim(),
                source : sourcePath
            };

            chunk.hash = createHashFn(chunk);
            writeStream.write(JSON.stringify(chunk) + '\n');
            yieldedSourcePaths.push(sourcePath);
        }

        return {count: yieldedSourcePaths.length, yieldedSourcePaths, skippedSourcePaths};
    }
}

export default Neo.setupClass(AdrSource);

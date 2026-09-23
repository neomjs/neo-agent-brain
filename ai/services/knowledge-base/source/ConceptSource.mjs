import Base     from './Base.mjs';
import fs       from 'fs-extra';
import path     from 'path';
import matter   from 'gray-matter';
import aiConfig from '../../../mcp/server/knowledge-base/config.mjs';

/**
 * @summary Extracts knowledge chunks from Concept Ontology markdown files.
 *
 * This source provider reads `resources/content/concepts/*.md`.
 * Each concept file is treated as a single knowledge chunk.
 *
 * @class Neo.ai.services.knowledge-base.source.ConceptSource
 * @extends Neo.ai.services.knowledge-base.source.Base
 * @singleton
 */
class ConceptSource extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.services.knowledge-base.source.ConceptSource'
         * @protected
         */
        className: 'Neo.ai.services.knowledge-base.source.ConceptSource',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * Extracts knowledge chunks from concept markdown files.
     * @param {Object}   writeStream  The JSONL write stream.
     * @param {Function} createHashFn Function to create content hash.
     * @returns {Promise<Number>} The number of chunks extracted.
     */
    async extract(writeStream, createHashFn) {
        let count = 0;
        // Per-source path from the `sourcePaths` config (SSOT).
        const conceptsDir = path.resolve(aiConfig.projectRoot, aiConfig.sourcePaths.ConceptSource);

        if (await fs.pathExists(conceptsDir)) {
            const files = await fs.readdir(conceptsDir);
            files.sort();

            for (const file of files) {
                if (!file.endsWith('.md')) continue;

                const filePath   = path.join(conceptsDir, file);
                const rawContent = await fs.readFile(filePath, 'utf-8');
                const parsed     = matter(rawContent);

                const chunk = {
                    type       : 'concept',
                    kind       : 'concept',
                    name       : parsed.data.name || path.basename(file, '.md'),
                    tier       : parsed.data.tier || 0,
                    description: parsed.content.trim(),
                    content    : `${parsed.data.name || path.basename(file, '.md')}: ${parsed.content.trim()}`,
                    source     : path.relative(aiConfig.projectRoot, filePath)
                };

                chunk.hash = createHashFn(chunk);
                writeStream.write(JSON.stringify(chunk) + '\n');
                count++;
            }
        }

        return count;
    }

    /**
     * @summary Extracts top-level concept documents through an exact revision reader.
     * @param {Object} params Repository-bound route invocation.
     * @returns {Promise<{count: Number, yieldedSourcePaths: String[], skippedSourcePaths: Object[]}>}
     */
    async extractFromRepository({context, writeStream, createHashFn} = {}) {
        const reader = context?.repositoryReader;

        if (!reader || typeof reader.readText !== 'function') {
            throw new TypeError('ConceptSource repository extraction requires context.repositoryReader')
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

            if (typeof file !== 'string' || file.includes('/') || !file.endsWith('.md')) {
                skippedSourcePaths.push({sourcePath, reason: 'not-concept'});
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

            const
                parsed = matter(rawContent),
                name   = parsed.data.name || path.posix.basename(file, '.md'),
                chunk  = {
                    type       : 'concept',
                    kind       : 'concept',
                    name,
                    tier       : parsed.data.tier || 0,
                    description: parsed.content.trim(),
                    content    : `${name}: ${parsed.content.trim()}`,
                    source     : sourcePath
                };

            chunk.hash = createHashFn(chunk);
            writeStream.write(JSON.stringify(chunk) + '\n');
            yieldedSourcePaths.push(sourcePath);
        }

        return {count: yieldedSourcePaths.length, yieldedSourcePaths, skippedSourcePaths};
    }
}

export default Neo.setupClass(ConceptSource);

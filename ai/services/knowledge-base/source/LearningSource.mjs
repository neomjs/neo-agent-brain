import Base                from './Base.mjs';
import DocumentationParser from '../parser/DocumentationParser.mjs';
import fs                  from 'fs-extra';
import path                from 'path';
import aiConfig            from '../../../mcp/server/knowledge-base/config.mjs';

/**
 * @summary Extracts knowledge chunks from the 'learn/' directory.
 *
 * The legacy source traverses `learn/tree.json`; repository profiles explicitly select either
 * that tree or assigned Markdown files. Both paths delegate semantic section splitting to
 * `DocumentationParser`.
 *
 * By decoupling the file traversal from the core service, this class simplifies the
 * addition of new documentation structures or file formats in the future.
 *
 * @class Neo.ai.services.knowledge-base.source.LearningSource
 * @extends Neo.ai.services.knowledge-base.source.Base
 * @singleton
 */
class LearningSource extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.services.knowledge-base.source.LearningSource'
         * @protected
         */
        className: 'Neo.ai.services.knowledge-base.source.LearningSource',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * Extracts knowledge chunks from the 'learn/' directory based on tree.json.
     * @param {Object}   writeStream  The JSONL write stream.
     * @param {Function} createHashFn Function to create content hash.
     * @returns {Promise<Number>} The number of chunks extracted.
     */
    async extract(writeStream, createHashFn) {
        let count = 0;
        // Per-source path from the `sourcePaths` config (SSOT). The value points at the tree.json
        // file; the base directory containing the .md files is its containing directory.
        const learnTreeRelative = aiConfig.sourcePaths.LearningSource;
        const learnTreePath     = path.resolve(aiConfig.neoRootDir, learnTreeRelative);
        const learnBaseRelative = path.dirname(learnTreeRelative);

        if (await fs.pathExists(learnTreePath)) {
            const learnTree         = await fs.readJson(learnTreePath);
            const learnBasePath     = path.resolve(aiConfig.neoRootDir, learnBaseRelative);
            const filteredLearnData = learnTree.data.filter(item => item.id !== 'comparisons' && item.parentId !== 'comparisons');

            for (const item of filteredLearnData) {
                if (item.id && item.isLeaf !== false) {
                    const filePath = path.join(learnBasePath, `${item.id}.md`);
                    if (await fs.pathExists(filePath)) {
                        const content = await fs.readFile(filePath, 'utf-8');
                        // Pass the neoRootDir-relative path so stored chunk metadata stays
                        // portable across distributed Chroma zips. fs.readFile above
                        // still uses the absolute path internally.
                        const chunks = DocumentationParser.parse(item, content, path.relative(aiConfig.neoRootDir, filePath));

                        chunks.forEach(chunk => {
                            chunk.hash = createHashFn(chunk);
                            writeStream.write(JSON.stringify(chunk) + '\n');
                            count++;
                        });
                    }
                }
            }
        }

        return count;
    }

    /**
     * @summary Extracts tree-selected guides and blogs from one exact repository revision.
     *
     * The tree is a route option and an assigned blob. It chooses document membership,
     * metadata and order; no process-wide filesystem path can become an implicit input.
     *
     * @param {Object} params Repository-bound route invocation.
     * @param {Object} params.context Repository reader and assigned territory.
     * @param {Object} params.options Canonical route options containing treePath.
     * @returns {Promise<{count: Number, yieldedSourcePaths: String[], skippedSourcePaths: Object[]}>}
     */
    async extractFromRepository({context, options = {}, writeStream, createHashFn} = {}) {
        const
            reader   = context?.repositoryReader,
            treePath = options.treePath;

        if (!reader || typeof reader.readText !== 'function') {
            throw new TypeError('LearningSource repository extraction requires context.repositoryReader')
        }
        if (options.mode === 'files') {
            return await this.extractAssignedFilesFromRepository({context, writeStream, createHashFn})
        }
        if (typeof treePath !== 'string' || !treePath) {
            throw new TypeError('LearningSource repository extraction requires route.options.treePath')
        }

        const assignments = new Map((context?.territory?.assignments || [])
            .map(assignment => [assignment.entry.sourcePath, assignment]));

        if (!assignments.has(treePath)) {
            throw new TypeError(`LearningSource treePath '${treePath}' is outside its assigned territory`)
        }

        const tree = JSON.parse(await reader.readText(treePath));

        if (!Array.isArray(tree?.data)) {
            throw new TypeError(`LearningSource treePath '${treePath}' requires a data array`)
        }

        const
            treeDirectory      = path.posix.dirname(treePath),
            yieldedSourcePaths = new Set(),
            skippedSourcePaths = [{sourcePath: treePath, reason: 'tree-manifest'}];

        let count = 0;

        for (const item of tree.data) {
            if (!item?.id || item.isLeaf === false || item.id === 'comparisons' || item.parentId === 'comparisons') {
                continue
            }
            if (
                typeof item.id !== 'string'
                || item.id.startsWith('/')
                || item.id.includes('\\')
                || item.id.includes('\0')
                || item.id.split('/').some(segment => !segment || segment === '.' || segment === '..')
            ) {
                throw new TypeError(`LearningSource treePath '${treePath}' contains an unsafe document id`)
            }

            const sourcePath = path.posix.join(treeDirectory, `${item.id}.md`);

            if (!assignments.has(sourcePath)) {
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

            for (const chunk of DocumentationParser.parse(item, content, sourcePath)) {
                chunk.hash = createHashFn(chunk);
                writeStream.write(JSON.stringify(chunk) + '\n');
                count++;
                yieldedSourcePaths.add(sourcePath);
            }
        }

        for (const sourcePath of [...assignments.keys()].sort()) {
            if (sourcePath !== treePath && !yieldedSourcePaths.has(sourcePath)
                && !skippedSourcePaths.some(skipped => skipped.sourcePath === sourcePath)) {
                skippedSourcePaths.push({sourcePath, reason: 'not-in-tree'});
            }
        }

        return {
            count,
            yieldedSourcePaths: [...yieldedSourcePaths].sort(),
            skippedSourcePaths
        };
    }

    /**
     * @summary Parses explicitly assigned Markdown without requiring a learning-tree producer.
     * @param {Object} params Repository-bound invocation.
     * @returns {Promise<{count: Number, yieldedSourcePaths: String[], skippedSourcePaths: Object[]}>}
     * @protected
     */
    async extractAssignedFilesFromRepository({context, writeStream, createHashFn}) {
        const
            reader      = context.repositoryReader,
            assignments = [...(context?.territory?.assignments || [])]
                .sort((left, right) => left.entry.sourcePath === right.entry.sourcePath
                    ? 0
                    : left.entry.sourcePath < right.entry.sourcePath ? -1 : 1),
            yieldedSourcePaths = [],
            skippedSourcePaths = [];

        let count = 0;

        for (const assignment of assignments) {
            const
                sourcePath   = assignment.entry.sourcePath,
                relativePath = assignment.relativePath;

            if (typeof relativePath !== 'string' || !relativePath.endsWith('.md')) {
                skippedSourcePaths.push({sourcePath, reason: 'not-markdown'});
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

            const item = {
                id      : relativePath.slice(0, -3),
                name    : path.posix.basename(relativePath, '.md'),
                parentId: sourcePath.split('/').includes('blog') ? 'Blog' : null
            };

            for (const chunk of DocumentationParser.parse(item, content, sourcePath)) {
                chunk.hash = createHashFn(chunk);
                writeStream.write(JSON.stringify(chunk) + '\n');
                count++;
            }

            yieldedSourcePaths.push(sourcePath);
        }

        return {count, yieldedSourcePaths, skippedSourcePaths};
    }
}

export default Neo.setupClass(LearningSource);

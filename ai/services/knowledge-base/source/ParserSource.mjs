import Base from './Base.mjs';

/**
 * @summary Executes one declared server-side parser over an exact repository territory.
 *
 * `ParserSource` is the profile-runner replacement for the legacy raw envelope's `parserId` path.
 * It reads bytes only through the bound revision reader and resolves parser code only through the
 * IngestionService-owned tenant resolver supplied in context. A missing parser remains a coded
 * failure; this route never degrades to raw text.
 *
 * @class Neo.ai.services.knowledge-base.source.ParserSource
 * @extends Neo.ai.services.knowledge-base.source.Base
 * @singleton
 */
class ParserSource extends Base {
    static config = {
        /** @member {String} className='Neo.ai.services.knowledge-base.source.ParserSource' */
        className: 'Neo.ai.services.knowledge-base.source.ParserSource',
        /** @member {Boolean} singleton=true */
        singleton: true
    }

    /**
     * @summary Resolves the declared parser and emits its structured chunks for the assigned files.
     * @param {Object} params
     * @param {Object} params.context Repository-bound context carrying `parserResolver`.
     * @param {{parserId: String, parserVersion: String}} params.options Canonical route options.
     * @param {Object} params.writeStream Route-bound JSONL writer.
     * @returns {Promise<{count: Number, yieldedSourcePaths: String[], skippedSourcePaths: Object[]}>}
     */
    async extractFromRepository({context, options = {}, writeStream} = {}) {
        const
            reader   = context?.repositoryReader,
            resolver = context?.parserResolver;

        if (!reader || typeof reader.readText !== 'function') {
            throw new TypeError('ParserSource repository extraction requires context.repositoryReader')
        }
        if (!resolver || typeof resolver.resolve !== 'function') {
            throw new TypeError('ParserSource repository extraction requires context.parserResolver')
        }

        const parser = await resolver.resolve({
            tenantId: context.tenantId,
            repoSlug: context.repoSlug,
            parserId: options.parserId
        });

        if (!parser) {
            const error = new Error(`Parser '${options.parserId}' is not registered.`);

            error.code = 'KB_PARSER_NOT_REGISTERED';
            throw error
        }

        const
            assignments = [...(context?.territory?.assignments || [])]
                .sort((left, right) => left.entry.sourcePath === right.entry.sourcePath
                    ? 0
                    : left.entry.sourcePath < right.entry.sourcePath ? -1 : 1),
            skippedSourcePaths = [],
            yieldedSourcePaths = [],
            chunksToWrite      = [];

        for (const assignment of assignments) {
            const sourcePath = assignment.entry.sourcePath;
            let content;

            try {
                content = await reader.readText(sourcePath)
            } catch (error) {
                if (error.code === 'KB_REVISION_READER_BINARY_BLOB') {
                    skippedSourcePaths.push({sourcePath, reason: 'binary'});
                    continue
                }

                throw error
            }

            const file = {
                content,
                sourcePath,
                repoSlug     : context.repoSlug,
                rootKind     : 'external-source',
                parserId     : options.parserId,
                parserVersion: options.parserVersion
            };
            const tenantContext = {
                tenantId: context.tenantId,
                repoSlug: context.repoSlug
            };
            let chunks;

            if (typeof parser.parseIngestionFile === 'function') {
                chunks = await parser.parseIngestionFile(file, {tenantContext})
            } else if (typeof parser.parse === 'function') {
                chunks = await parser.parse(content, sourcePath, 'external-source', {})
            } else {
                const error = new Error(`Parser '${options.parserId}' exposes no callable parse method.`);

                error.code = 'KB_TENANT_PARSER_NOT_DISPATCHABLE';
                throw error
            }

            if (!Array.isArray(chunks)) {
                const error = new Error(`Parser '${options.parserId}' must return an array of chunks.`);

                error.code = 'KB_PARSER_RESULT_INVALID';
                throw error
            }

            if (chunks.length) {
                yieldedSourcePaths.push(sourcePath)
            }

            chunksToWrite.push(...chunks)
        }

        chunksToWrite.forEach(chunk => writeStream.write(JSON.stringify(chunk) + '\n'));

        return {
            count: chunksToWrite.length,
            yieldedSourcePaths,
            skippedSourcePaths
        }
    }
}

export default Neo.setupClass(ParserSource);

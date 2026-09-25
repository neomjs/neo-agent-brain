import Base from './Base.mjs';
import path from 'path';

/**
 * @summary Stable refusal codes for the corpus release-notes extractor.
 * @type {Object<String,String>}
 */
export const RELEASE_NOTES_CORPUS_ERROR_CODES = Object.freeze({
    indexInvalid  : 'KB_CORPUS_RELEASE_NOTES_INDEX_INVALID',
    readerRequired: 'KB_CORPUS_READER_REQUIRED'
});

const
    HASH_INPUTS    = Object.freeze(['kind', 'name', 'content', 'sourcePath', 'parserId', 'parserVersion']),
    NOTE_PATH      = /^([^/]+)\/release-notes\/.+\.md$/u,
    PARSER_VERSION = '1.0.0',
    SHARD_INDEX    = /^[^/]+\/release-notes\/_index\.json$/u;

/**
 * @summary Creates a coded extractor refusal.
 * @param {String} message
 * @param {Error} [cause]
 * @returns {Error}
 * @private
 */
function refuse(message, cause) {
    const error = new Error(message, cause ? {cause} : undefined);

    error.code = RELEASE_NOTES_CORPUS_ERROR_CODES.indexInvalid;

    return error
}

/**
 * @summary Extracts GitHub release notes from the org corpus that `github-content-sync` publishes.
 *
 * Each origin with releases carries `<origin>/release-notes/chunk-N/<file>.md`, one note per release, and
 * its own `<origin>/release-notes/_index.json`, whose `items` map each release tag to its note's `path`.
 * The notes stay out of the corpus root index on purpose: its rows are conversations with integer ids.
 *
 * Every identity comes from the origin's index, never from a file name: a note's tag is the key of the
 * item whose `path` names it, so a file the index does not name yields nothing. The origin is the path's
 * first segment and rides `customMeta` and the chunk name, as a conversation's does, while ownership
 * stays the server's stamp for the corpus tenant. Every chunk depends on an index that does not change
 * when a note does, so the built-in descriptor is non-delta-safe.
 *
 * @class Neo.ai.services.knowledge-base.source.ReleaseNotesCorpusSource
 * @extends Neo.ai.services.knowledge-base.source.Base
 * @singleton
 */
class ReleaseNotesCorpusSource extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.services.knowledge-base.source.ReleaseNotesCorpusSource'
         * @protected
         */
        className: 'Neo.ai.services.knowledge-base.source.ReleaseNotesCorpusSource',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * @summary Extracts one `release` chunk per indexed note from one route-scoped corpus revision.
     *
     * @param {Object} params
     * @param {Object} params.context Repository-bound invocation context.
     * @param {Object} [params.options] Canonical route options (`origins` narrows the selection).
     * @param {Object} params.writeStream JSONL output stream.
     * @param {Function} params.createHashFn Legacy content-hash function.
     * @returns {Promise<{count: Number, yieldedSourcePaths: String[], skippedSourcePaths: Object[]}>}
     */
    async extractFromRepository({context, options = {}, writeStream, createHashFn} = {}) {
        const reader = context?.repositoryReader;

        if (!reader || typeof reader.readText !== 'function') {
            const error = new Error('ReleaseNotesCorpusSource repository extraction requires context.repositoryReader');

            error.code = RELEASE_NOTES_CORPUS_ERROR_CODES.readerRequired;
            throw error
        }

        const
            origins     = Array.isArray(options.origins) && options.origins.length ? new Set(options.origins) : null,
            assignments = [...(context?.territory?.assignments || [])]
                .sort((left, right) => left.entry.sourcePath === right.entry.sourcePath
                    ? 0
                    : left.entry.sourcePath < right.entry.sourcePath ? -1 : 1),
            indexes            = new Map(),
            yieldedSourcePaths = [],
            skippedSourcePaths = [];

        let count = 0;

        for (const assignment of assignments) {
            const
                sourcePath = assignment.entry.sourcePath,
                origin     = NOTE_PATH.exec(sourcePath)?.[1];

            if (SHARD_INDEX.test(sourcePath)) {
                skippedSourcePaths.push({sourcePath, reason: 'index'});
                continue
            }

            if (!origin) {
                skippedSourcePaths.push({sourcePath, reason: 'unindexed'});
                continue
            }

            if (origins && !origins.has(origin)) {
                skippedSourcePaths.push({sourcePath, reason: 'origin-not-selected'});
                continue
            }

            if (!indexes.has(origin)) {
                indexes.set(origin, await this.loadIndex(reader, origin))
            }

            const tag = indexes.get(origin).get(sourcePath);

            if (!tag) {
                skippedSourcePaths.push({sourcePath, reason: 'unindexed'});
                continue
            }

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

            const chunk = this.createChunk({content, origin, sourcePath, tag});

            chunk.hash = createHashFn(chunk);
            writeStream.write(JSON.stringify(chunk) + '\n');
            count++;

            yieldedSourcePaths.push(sourcePath)
        }

        return {count, yieldedSourcePaths, skippedSourcePaths}
    }

    /**
     * @summary Reads one origin's release-notes index and keys its tags by note path.
     *
     * An index that does not parse, names no `items`, gives an item no path inside the origin's
     * `release-notes/`, or names one path twice refuses the invocation: it cannot say which note is which.
     *
     * @param {Object} reader Route-scoped repository revision reader.
     * @param {String} origin
     * @returns {Promise<Map<String,String>>} Note path → release tag
     * @protected
     */
    async loadIndex(reader, origin) {
        const indexPath = `${origin}/release-notes/_index.json`;

        let items;

        try {
            items = JSON.parse(await reader.readText(indexPath)).items
        } catch (error) {
            throw refuse(`${indexPath} must be readable JSON`, error)
        }

        if (!items || typeof items !== 'object' || Array.isArray(items)) {
            throw refuse(`${indexPath} must map release tags to items`)
        }

        const byPath = new Map();

        Object.entries(items).forEach(([tag, item]) => {
            const notePath = typeof item?.path === 'string' ? item.path : '';

            if (!notePath.startsWith(`${origin}/release-notes/`) || !notePath.endsWith('.md')) {
                throw refuse(`${indexPath} gives ${tag} no note path inside ${origin}/release-notes/`)
            }

            if (byPath.has(notePath)) {
                throw refuse(`${indexPath} names ${notePath} for both ${byPath.get(notePath)} and ${tag}`)
            }

            byPath.set(notePath, tag)
        });

        return byPath
    }

    /**
     * @summary Creates the chunk for one release note.
     *
     * Ownership (`tenantId`, `repoSlug`) is deliberately absent: the server stamps the tenant's tuple.
     * The origin is display-grade provenance in `customMeta` and part of the name, hence of the hash.
     * The name's last segment is the note's file name from the index (`neo/v13.1.0`), the version as
     * it is written, which the query's exact-version ranking matches.
     *
     * @param {Object} params
     * @param {String} params.content
     * @param {String} params.origin
     * @param {String} params.sourcePath
     * @param {String} params.tag
     * @returns {Object}
     * @protected
     */
    createChunk({content, origin, sourcePath, tag}) {
        return {
            schemaVersion: '1.0.0',
            sourcePath,
            source       : sourcePath,
            content,
            hashInputs   : [...HASH_INPUTS],
            parserId     : 'release-note',
            parserVersion: PARSER_VERSION,
            rootKind     : 'external-source',
            kind         : 'release',
            type         : 'release',
            name         : `${origin}/${path.posix.basename(sourcePath, '.md')}`,
            customMeta   : {
                origin,
                facet: 'release-notes',
                id   : tag
            }
        }
    }
}

export default Neo.setupClass(ReleaseNotesCorpusSource);

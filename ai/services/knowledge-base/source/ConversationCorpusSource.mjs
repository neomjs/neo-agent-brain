import Base                              from './Base.mjs';
import {splitDiscussionArchiveMarkdown}  from './discussionArchiveElementSplitter.mjs';
import {splitPullRequestArchiveMarkdown} from './pullRequestArchiveElementSplitter.mjs';
import {splitTicketArchiveMarkdown}      from './ticketArchiveElementSplitter.mjs';

/**
 * @summary Stable refusal codes for the conversation corpus extractor.
 * @type {Object<String,String>}
 */
export const CONVERSATION_CORPUS_ERROR_CODES = Object.freeze({
    duplicateConversation: 'KB_CORPUS_DUPLICATE_CONVERSATION',
    indexInvalid         : 'KB_CORPUS_INDEX_INVALID',
    indexRowUnqualified  : 'KB_CORPUS_INDEX_ROW_UNQUALIFIED',
    readerRequired       : 'KB_CORPUS_READER_REQUIRED'
});

/**
 * @summary The corpus root index — the only manifest a consumer trusts; index and files are one revision.
 * @type {String}
 */
export const CONVERSATION_CORPUS_INDEX_PATH = '_index.json';

/**
 * Per index `type`: the public chunk type, the legacy name prefix, the parser id and the splitter.
 * The three splitters are the unchanged chunking implementations of the retired per-facet Sources.
 * @type {Object<String,{type: String, prefix: String, parserId: String, split: Function}>}
 */
const FACETS = Object.freeze({
    discussions: Object.freeze({type: 'discussion', prefix: 'discussion', parserId: 'discussion-archive',   split: splitDiscussionArchiveMarkdown}),
    issues     : Object.freeze({type: 'ticket',     prefix: 'issue',      parserId: 'ticket-archive',       split: splitTicketArchiveMarkdown}),
    pulls      : Object.freeze({type: 'pull',       prefix: 'pr',         parserId: 'pull-request-archive', split: splitPullRequestArchiveMarkdown})
});

const
    HASH_INPUTS    = Object.freeze(['kind', 'name', 'content', 'sourcePath', 'parserId', 'parserVersion']),
    PARSER_VERSION = '1.0.0';

/**
 * @summary Creates a coded extractor refusal.
 * @param {String} code
 * @param {String} message
 * @param {Error} [cause]
 * @returns {Error}
 * @private
 */
function refuse(code, message, cause) {
    const error = new Error(message, cause ? {cause} : undefined);

    error.code = code;

    return error
}

/**
 * @summary Extracts GitHub conversations from the org corpus that `github-content-sync` publishes.
 *
 * The corpus is one repository holding every org repository's issues, pull requests and discussions
 * as markdown, one file per conversation, under `<origin>/{issues,pulls,discussions,archive/…}`, with
 * one root `_index.json` whose rows carry `{repoSlug, type, id, version, path}`. The Knowledge Base
 * ingests that repository as its **own** tenant: the ownership tuple `{tenantId, repoSlug}` is the
 * corpus repository's and is stamped by the server, never written here. The row's `repoSlug` is the
 * conversation's **origin** — a separate, display-grade fact that rides `customMeta`
 * and the chunk name, so `neo#86` and `neo-agent-brain#86` are two chunks.
 *
 * Every identity comes from the index. A file the index does not name yields nothing — the retired
 * Sources minted an id from the filename, which is how an unqualified id would re-enter once the
 * index is authoritative. An index row without an origin refuses the whole invocation: a corpus that
 * has lost its origin column cannot be told apart from a single-origin one, and ingesting it would
 * publish every origin's `#86` as one conversation.
 *
 * The extractor reads only through the route-bound revision reader. Because every chunk's identity
 * depends on `_index.json` — a file that does not change when a conversation file does — the built-in
 * descriptor is declared non-delta-safe and every linear advance is a full materialization.
 *
 * @class Neo.ai.services.knowledge-base.source.ConversationCorpusSource
 * @extends Neo.ai.services.knowledge-base.source.Base
 * @singleton
 */
class ConversationCorpusSource extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.services.knowledge-base.source.ConversationCorpusSource'
         * @protected
         */
        className: 'Neo.ai.services.knowledge-base.source.ConversationCorpusSource',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * @summary Extracts per-element conversation chunks from one route-scoped corpus revision.
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
            throw refuse(
                CONVERSATION_CORPUS_ERROR_CODES.readerRequired,
                'ConversationCorpusSource repository extraction requires context.repositoryReader'
            )
        }

        const
            origins     = Array.isArray(options.origins) && options.origins.length ? new Set(options.origins) : null,
            index       = await this.loadIndex(reader),
            assignments = [...(context?.territory?.assignments || [])]
                .sort((left, right) => left.entry.sourcePath === right.entry.sourcePath
                    ? 0
                    : left.entry.sourcePath < right.entry.sourcePath ? -1 : 1),
            seen               = new Map(),
            yieldedSourcePaths = [],
            skippedSourcePaths = [];

        let count = 0;

        for (const assignment of assignments) {
            const sourcePath = assignment.entry.sourcePath;

            if (sourcePath === CONVERSATION_CORPUS_INDEX_PATH) {
                skippedSourcePaths.push({sourcePath, reason: 'index'});
                continue
            }

            const row = index.get(sourcePath);

            if (!row) {
                skippedSourcePaths.push({sourcePath, reason: 'unindexed'});
                continue
            }

            if (origins && !origins.has(row.repoSlug)) {
                skippedSourcePaths.push({sourcePath, reason: 'origin-not-selected'});
                continue
            }

            // Extraction walks files, but a chunk is keyed by conversation identity. Two artifacts for
            // one identity would land as two rows under one logical name, and a retrieval would return
            // one conversation's two renderings as corroborating evidence. Refusing costs a run; the
            // alternatives cost the substrate's trustworthiness.
            const identity = `${row.repoSlug}/${row.type}/${row.id}`;

            if (seen.has(identity)) {
                throw refuse(
                    CONVERSATION_CORPUS_ERROR_CODES.duplicateConversation,
                    `ConversationCorpusSource: ${identity} has more than one artifact ` +
                    `(${seen.get(identity)} and ${sourcePath}) — refusing to embed duplicate evidence ` +
                    'under one logical name. Repair the corpus first.'
                )
            }

            seen.set(identity, sourcePath);

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

            const facet = FACETS[row.type];

            for (const element of facet.split(content)) {
                const chunk = this.createChunk({element, facet, row, sourcePath});

                chunk.hash = createHashFn(chunk);
                writeStream.write(JSON.stringify(chunk) + '\n');
                count++
            }

            yieldedSourcePaths.push(sourcePath)
        }

        return {count, yieldedSourcePaths, skippedSourcePaths}
    }

    /**
     * @summary Reads the root index through the route's reader and keys its rows by corpus path.
     *
     * A reader whose route does not declare `_index.json` refuses the read with
     * `KB_REVISION_READER_PATH_OUTSIDE_SCOPE`; that refusal is the contract, not a defect.
     *
     * @param {Object} reader Route-scoped repository revision reader.
     * @returns {Promise<Map<String,{repoSlug: String, type: String, id: Number, version: String|null}>>}
     * @protected
     */
    async loadIndex(reader) {
        const text = await reader.readText(CONVERSATION_CORPUS_INDEX_PATH);

        let rows;

        try {
            rows = JSON.parse(text)
        } catch (error) {
            throw refuse(CONVERSATION_CORPUS_ERROR_CODES.indexInvalid, 'Corpus root index must contain valid JSON', error)
        }

        if (!Array.isArray(rows)) {
            throw refuse(CONVERSATION_CORPUS_ERROR_CODES.indexInvalid, 'Corpus root index must be an array of rows')
        }

        const byPath = new Map();

        rows.forEach((row, position) => {
            const
                repoSlug = typeof row?.repoSlug === 'string' ? row.repoSlug.trim() : '',
                path     = typeof row?.path === 'string'
                    ? row.path.trim().replace(/\\/gu, '/').replace(/^\.?\//u, '')
                    : '';

            if (!repoSlug) {
                throw refuse(
                    CONVERSATION_CORPUS_ERROR_CODES.indexRowUnqualified,
                    `Corpus index row ${position} (${path || 'no path'}) declares no repository origin`
                )
            }

            if (!FACETS[row.type] || !Number.isSafeInteger(row.id) || row.id < 1 || !path) {
                throw refuse(
                    CONVERSATION_CORPUS_ERROR_CODES.indexInvalid,
                    `Corpus index row ${position} needs a known type, a positive integer id and a path`
                )
            }

            if (byPath.has(path)) {
                throw refuse(
                    CONVERSATION_CORPUS_ERROR_CODES.indexInvalid,
                    `Corpus index declares '${path}' more than once`
                )
            }

            byPath.set(path, Object.freeze({
                repoSlug,
                type   : row.type,
                id     : row.id,
                version: typeof row.version === 'string' && row.version.trim() ? row.version.trim() : null
            }))
        });

        return byPath
    }

    /**
     * @summary Creates one parsed chunk for a conversation element.
     *
     * Ownership (`tenantId`, `repoSlug`) is deliberately absent: the server stamps the tenant's tuple.
     * The origin is display-grade provenance in `customMeta` and part of the name, hence of the hash.
     *
     * @param {Object} params
     * @param {{kind: String, ordinal: Number, content: String}} params.element
     * @param {Object} params.facet
     * @param {{repoSlug: String, type: String, id: Number, version: String|null}} params.row
     * @param {String} params.sourcePath
     * @returns {Object}
     * @protected
     */
    createChunk({element, facet, row, sourcePath}) {
        const suffix = element.kind === 'body' ? 'body' : `${element.kind}-${element.ordinal}`;

        return {
            schemaVersion: '1.0.0',
            sourcePath,
            source       : sourcePath,
            content      : element.content,
            hashInputs   : [...HASH_INPUTS],
            parserId     : facet.parserId,
            parserVersion: PARSER_VERSION,
            rootKind     : 'external-source',
            kind         : facet.type,
            type         : facet.type,
            name         : `${row.repoSlug}/${facet.prefix}-${row.id}#${suffix}`,
            customMeta   : {
                origin : row.repoSlug,
                facet  : row.type,
                id     : row.id,
                version: row.version,
                element: element.kind,
                ordinal: element.ordinal
            }
        }
    }
}

export default Neo.setupClass(ConversationCorpusSource);

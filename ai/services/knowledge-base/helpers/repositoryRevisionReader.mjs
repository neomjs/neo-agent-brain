import {isUtf8}             from 'node:buffer';
import {posix as pathPosix} from 'node:path';

import GitMirror from './gitMirror.mjs';

/**
 * @summary Stable error for the repository-bound extraction reader.
 * @param {String} code
 * @param {String} message
 * @returns {Error}
 */
function createReaderError(code, message) {
    const error = new Error(message);

    error.code = code;

    return error;
}

/**
 * @summary Normalizes a Git tree path to the Knowledge Base path-identity grammar.
 * @param {String} sourcePath
 * @returns {String}
 */
export function normalizeRevisionSourcePath(sourcePath) {
    if (
        typeof sourcePath !== 'string'
        || !sourcePath
        || sourcePath.includes('\0')
        || sourcePath.includes('\\')
        || sourcePath.startsWith('/')
        || /^[a-z]:\//iu.test(sourcePath)
        || sourcePath.split('/').includes('..')
    ) {
        throw createReaderError(
            'KB_REVISION_READER_PATH_INVALID',
            'Repository revision paths must be non-empty, repo-relative POSIX paths without traversal'
        )
    }

    const normalized = pathPosix.normalize(sourcePath.replace(/^(?:\.\/)+/u, ''));

    if (!normalized || normalized === '.' || normalized.endsWith('/')) {
        throw createReaderError(
            'KB_REVISION_READER_PATH_INVALID',
            'Repository revision paths must identify a file entry'
        )
    }

    return normalized;
}

/**
 * @summary True only for ordinary executable/non-executable Git blobs.
 *
 * Object type is deliberately insufficient: a `120000` symlink is also a `blob`.
 * @param {Object} entry
 * @returns {Boolean}
 */
export function isRegularRevisionBlob(entry) {
    return entry?.type === 'blob' && /^(?:100644|100755)$/u.test(entry.mode);
}

/**
 * @summary Classifies bytes before an extractor decodes them as UTF-8.
 * @param {Buffer} value
 * @returns {Boolean}
 */
export function isBinaryRevisionBlob(value) {
    return !Buffer.isBuffer(value) || value.includes(0) || !isUtf8(value);
}

/**
 * @summary Creates one immutable reader bound to a tenant repository and exact revision.
 *
 * The binding is the anti-ambient seam: extractors receive this object and cannot silently switch
 * repositories, revisions, credentials, or filesystem roots. Scopes narrow the readable entry set
 * after route validation, so one extractor cannot reach outside the territory assigned to it.
 *
 * @param {Object} options
 * @param {Object} [options.gitMirror=GitMirror]
 * @param {String} options.mirrorRoot
 * @param {String} options.tenantId
 * @param {String} options.repoSlug
 * @param {String} options.revision
 * @param {String|Object|null} [options.credentialRef]
 * @param {Array<Object>} [options.allowedEntries] Optional already-validated scope.
 * @returns {Object}
 */
export function createRepositoryRevisionReader({
    gitMirror = GitMirror,
    mirrorRoot,
    tenantId,
    repoSlug,
    revision,
    credentialRef,
    allowedEntries
} = {}) {
    if (
        !gitMirror
        || typeof gitMirror.listRevisionEntries !== 'function'
        || typeof gitMirror.readRevisionBlob !== 'function'
    ) {
        throw createReaderError(
            'KB_REVISION_READER_ADAPTER_INVALID',
            'Repository revision reader requires mode-aware list and blob-read GitMirror primitives'
        )
    }

    if (
        typeof tenantId !== 'string' || !tenantId
        || typeof repoSlug !== 'string' || !repoSlug
        || typeof revision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision.trim())
    ) {
        throw createReaderError(
            'KB_REVISION_READER_IDENTITY_INVALID',
            'Repository revision reader requires tenantId, repoSlug, and an exact Git object id'
        )
    }

    let allEntriesPromise;

    /**
     * @summary Validates, freezes, and lexically orders adapter entries.
     * @param {Object[]} entries
     * @returns {Object[]}
     */
    const normalizeEntries = entries => Object.freeze((Array.isArray(entries) ? entries : [])
        .map(entry => {
            const normalized = {
                sourcePath: normalizeRevisionSourcePath(entry?.sourcePath),
                mode      : String(entry?.mode || ''),
                type      : String(entry?.type || ''),
                oid       : String(entry?.oid || '')
            };

            if (
                !/^\d{6}$/u.test(normalized.mode)
                || !/^(?:blob|commit|tree)$/u.test(normalized.type)
                || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(normalized.oid)
            ) {
                throw createReaderError(
                    'KB_REVISION_READER_ENTRY_INVALID',
                    `Repository revision path '${normalized.sourcePath}' has invalid mode/type/object identity`
                )
            }

            return Object.freeze(normalized);
        })
        .sort((left, right) => left.sourcePath === right.sourcePath
            ? 0
            : left.sourcePath < right.sourcePath ? -1 : 1));

    const fixedEntries = allowedEntries ? normalizeEntries(allowedEntries) : null;

    /**
     * @summary Reads the bound entry universe once and memoizes the immutable result.
     * @returns {Promise<Object[]>}
     */
    const listEntries = async () => {
        if (fixedEntries) {
            return fixedEntries
        }

        allEntriesPromise ??= Promise.resolve(gitMirror.listRevisionEntries({
            mirrorRoot,
            tenantId,
            repoSlug,
            revision
        })).then(normalizeEntries);

        return await allEntriesPromise
    };

    /**
     * @summary Resolves one entry inside the reader's fixed scope.
     * @param {String} sourcePath
     * @returns {Promise<Object>}
     */
    const getEntry = async sourcePath => {
        const
            normalized = normalizeRevisionSourcePath(sourcePath),
            entry      = (await listEntries()).find(item => item.sourcePath === normalized);

        if (!entry) {
            throw createReaderError(
                'KB_REVISION_READER_PATH_OUTSIDE_SCOPE',
                `Repository revision path '${normalized}' is absent or outside the assigned territory`
            )
        }

        return entry;
    };

    /**
     * @summary Reads raw bytes only after mode and scope admission.
     * @param {String} sourcePath
     * @returns {Promise<Buffer>}
     */
    const readBlob = async sourcePath => {
        const entry = await getEntry(sourcePath);

        if (!isRegularRevisionBlob(entry)) {
            throw createReaderError(
                'KB_REVISION_READER_ENTRY_UNSUPPORTED',
                `Repository revision path '${entry.sourcePath}' is mode ${entry.mode}/${entry.type}, not a regular blob`
            )
        }

        const value = await gitMirror.readRevisionBlob({
            mirrorRoot,
            tenantId,
            repoSlug,
            revision,
            sourcePath: entry.sourcePath,
            credentialRef
        });

        if (!Buffer.isBuffer(value)) {
            throw createReaderError(
                'KB_REVISION_READER_BLOB_INVALID',
                `Repository revision path '${entry.sourcePath}' did not return raw bytes`
            )
        }

        return value
    };

    const reader = {
        tenantId,
        repoSlug,
        revision: revision.trim(),

        /**
         * @summary Returns the complete mode-bearing entry universe for this reader scope.
         * @returns {Promise<Array<Object>>}
         */
        listEntries,

        /**
         * @summary Returns only ordinary Git blobs, preserving lexical path order.
         * @returns {Promise<Array<Object>>}
         */
        async listRegularEntries() {
            return Object.freeze((await listEntries()).filter(isRegularRevisionBlob))
        },

        /**
         * @summary Reads raw bytes for one regular entry inside this scope.
         * @param {String} sourcePath
         * @returns {Promise<Buffer>}
         */
        readBlob,

        /**
         * @summary Reads one UTF-8 text blob and refuses binary/NUL content before decoding.
         * @param {String} sourcePath
         * @returns {Promise<String>}
         */
        async readText(sourcePath) {
            const value = await readBlob(sourcePath);

            if (isBinaryRevisionBlob(value)) {
                throw createReaderError(
                    'KB_REVISION_READER_BINARY_BLOB',
                    `Repository revision path '${normalizeRevisionSourcePath(sourcePath)}' is not UTF-8 text`
                )
            }

            return value.toString('utf8');
        },

        /**
         * @summary Bulk-prefetches regular blobs inside this scope when the adapter supports it.
         * @param {String[]} sourcePaths
         * @returns {Promise<Object|null>}
         */
        async prefetch(sourcePaths = []) {
            if (typeof gitMirror.prefetchRevisionBlobs !== 'function') {
                return null
            }

            const paths = [];

            for (const sourcePath of [...new Set(sourcePaths)].sort()) {
                const entry = await getEntry(sourcePath);

                if (!isRegularRevisionBlob(entry)) {
                    throw createReaderError(
                        'KB_REVISION_READER_ENTRY_UNSUPPORTED',
                        `Repository revision path '${entry.sourcePath}' is not prefetchable regular content`
                    )
                }

                paths.push(entry.sourcePath)
            }

            return await gitMirror.prefetchRevisionBlobs({
                mirrorRoot,
                tenantId,
                repoSlug,
                revision,
                sourcePaths: paths,
                credentialRef
            })
        },

        /**
         * @summary Returns a reader that can access only the supplied, already-planned entries.
         * @param {Array<Object>} entries
         * @returns {Promise<Object>}
         */
        async scope(entries) {
            const available = new Map((await listEntries())
                .map(entry => [entry.sourcePath, entry]));

            for (const candidate of Array.isArray(entries) ? entries : []) {
                const
                    sourcePath = normalizeRevisionSourcePath(candidate?.sourcePath),
                    entry      = available.get(sourcePath);

                if (
                    !entry
                    || entry.mode !== String(candidate?.mode || '')
                    || entry.type !== String(candidate?.type || '')
                    || entry.oid !== String(candidate?.oid || '')
                ) {
                    throw createReaderError(
                        'KB_REVISION_READER_SCOPE_INVALID',
                        `Repository revision scope cannot admit unbound entry '${sourcePath}'`
                    )
                }
            }

            return createRepositoryRevisionReader({
                gitMirror,
                mirrorRoot,
                tenantId,
                repoSlug,
                revision,
                credentialRef,
                allowedEntries: entries
            })
        }
    };

    return Object.freeze(reader);
}

export default createRepositoryRevisionReader;

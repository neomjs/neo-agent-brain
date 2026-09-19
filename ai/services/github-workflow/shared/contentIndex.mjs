import fs                                                                                                  from 'fs-extra';
import path                                                                                                from 'path';
import {chunkNumberFor, DEFAULT_ITEMS_PER_CHUNK, parseContentPath, pathSegmentOptionsFor, validateSegment} from './contentPath.mjs';

export const CONTENT_INDEX_FILENAME = '_index.json';

/**
 * @summary Resolves the root directory that owns `resources/content/_index.json`.
 *
 * The index is rooted at the shared corpus root. Per-origin directories cannot derive that root: their
 * parent is an origin, not the shared corpus that owns one `_index.json` for every producer.
 *
 * @param {Object} issueSyncConfig GitHub workflow `issueSync` config block
 * @returns {String}
 */
export function contentRootFor(issueSyncConfig = {}) {
    validateSegment(issueSyncConfig.contentRoot, 'issueSyncConfig.contentRoot', {allowPath: true});
    return issueSyncConfig.contentRoot;
}

/**
 * @summary Resolves the absolute `_index.json` path for a GitHub workflow sync config.
 * @param {Object} issueSyncConfig GitHub workflow `issueSync` config block
 * @returns {String}
 */
export function contentIndexPath(issueSyncConfig = {}) {
    return path.join(contentRootFor(issueSyncConfig), CONTENT_INDEX_FILENAME);
}

/**
 * @summary Reads `resources/content/_index.json`.
 *
 * Missing index files are treated as an empty regeneratable cache surface. Malformed files fail
 * loudly so syncers do not silently preserve bad lookup data.
 *
 * @param {Object} issueSyncConfig GitHub workflow `issueSync` config block
 * @returns {Promise<Array<Object>>}
 */
export async function readContentIndex(issueSyncConfig = {}) {
    const indexPath = contentIndexPath(issueSyncConfig);

    if (!await fs.pathExists(indexPath)) {
        return [];
    }

    const entries = await fs.readJson(indexPath);

    if (!Array.isArray(entries)) {
        throw new TypeError(`${CONTENT_INDEX_FILENAME} must contain an array`);
    }

    const {legacyRepoSlug} = issueSyncConfig;

    if (legacyRepoSlug !== undefined && legacyRepoSlug !== null) {
        validateSegment(legacyRepoSlug, 'issueSyncConfig.legacyRepoSlug');
    }

    return entries.map(entry => {
        if (entry.repoSlug !== undefined && entry.repoSlug !== null) {
            return normalizeContentIndexEntry(entry);
        }

        // Legacy ownership is an explicit bootstrap fact. The current producer and the row's path
        // cannot establish it: a shared root can contain a foreign row with either familiar shape.
        return legacyRepoSlug ? normalizeContentIndexEntry({...entry, repoSlug: legacyRepoSlug}) : entry;
    });
}

/**
 * @summary Writes `resources/content/_index.json` with stable ordering.
 * @param {Object} issueSyncConfig GitHub workflow `issueSync` config block
 * @param {Array<Object>} entries Content index entries
 * @returns {Promise<void>}
 */
export async function writeContentIndex(issueSyncConfig = {}, entries = []) {
    const indexPath = contentIndexPath(issueSyncConfig);
    await fs.ensureDir(path.dirname(indexPath));
    await fs.writeJson(indexPath, sortContentIndex(entries), {spaces: 2});
    await fs.appendFile(indexPath, '\n');
}

/**
 * @summary Applies upsert/remove mutations to the content index in one read/write pass.
 *
 * Syncers call this after determining their final target paths. Entries are keyed by `{repoSlug, type, id}`
 * because each GitHub item has exactly one current lookup target — an upsert for an id therefore
 * replaces its predecessor rather than accumulating a second entry.
 *
 * @param {Object} issueSyncConfig GitHub workflow `issueSync` config block
 * @param {Object} mutations
 * @param {Array<Object>} [mutations.upsert]
 * @param {Array<Object>} [mutations.remove]
 * @returns {Promise<Array<Object>>} The written index entries
 */
export async function updateContentIndex(issueSyncConfig = {}, mutations = {}) {
    const {upsert = [], remove = []} = mutations;
    const index = new Map((await readContentIndex(issueSyncConfig)).map(entry => [indexKey(entry), entry]));

    remove.forEach(entry => index.delete(indexKey(entry)));
    upsert.forEach(entry => index.set(indexKey(entry), normalizeContentIndexEntry(entry)));

    const entries = sortContentIndex([...index.values()]);
    await writeContentIndex(issueSyncConfig, entries);
    return entries;
}

/**
 * @summary Finds an index entry by repository origin, type and id.
 * @param {Array<Object>} entries Content index entries
 * @param {Object} query
 * @param {String} query.repoSlug Bare repository provenance
 * @param {String} query.type Content type
 * @param {Number|String} query.id GitHub identifier
 * @returns {Object|null}
 */
export function findContentIndexEntry(entries = [], query = {}) {
    const key = indexKey(query);
    return entries.find(entry => entry.repoSlug !== undefined && entry.repoSlug !== null && indexKey(entry) === key) || null;
}

/**
 * @summary Creates a normalized content index entry for a resolved output path.
 * @param {Object} config
 * @param {Object} config.issueSyncConfig GitHub workflow `issueSync` config block
 * @param {String} config.repoSlug Bare repository provenance
 * @param {'issues'|'pulls'|'discussions'|'release-notes'} config.type Content type
 * @param {Number|String} config.id GitHub ID or semver identifier
 * @param {String} config.filePath Absolute output file path
 * @param {Number} config.itemIndex Zero-based ordinal within the active/archive bucket
 * @param {String|null} [config.version=null] Archive release version, if archived
 * @param {String} [config.bucket] Non-release archive bucket
 * @param {Number} [config.itemsPerChunk=100]
 * @returns {Object}
 */
export function createContentIndexEntry(config = {}) {
    const {
        issueSyncConfig,
        repoSlug,
        type,
        id,
        filePath,
        itemIndex,
        version = null,
        bucket,
        itemsPerChunk = DEFAULT_ITEMS_PER_CHUNK
    } = config;

    const contentRoot  = contentRootFor(issueSyncConfig);
    const relativePath = path.relative(contentRoot, filePath);

    return normalizeContentIndexEntry({
        repoSlug,
        type,
        id,
        version,
        bucket,
        chunkNumber: chunkNumberFor(itemIndex, itemsPerChunk),
        path       : relativePath
    });
}

/**
 * @summary Creates a normalized index entry describing where a file ACTUALLY is.
 *
 * The sibling of {@link createContentIndexEntry}, and the safer of the two. That one takes an
 * `itemIndex` and derives the chunk from it, so the entry records the ordinal a planner *chose*.
 * When a later pass relocates the file, the entry keeps naming the old location and the lookup rots
 * — the mechanism behind thousands of index entries pointing at paths that no longer exist. This one
 * reads the coordinates back out of the written path, so the entry cannot disagree with the
 * filesystem it was derived from.
 *
 * Use this at every site that has already decided the final path — moves especially. Prefer
 * {@link createContentIndexEntry} only where the ordinal is the thing being computed and the write
 * follows from it.
 *
 * Throws on a path that is not chunked content: a caller reaching here has just written or renamed a
 * file, so an unparseable path means the write went somewhere unintended. Returning null would let
 * the move stand with no index entry at all, which is the very drift being repaired.
 *
 * @param {Object} config
 * @param {Object} config.issueSyncConfig GitHub workflow `issueSync` config block
 * @param {String} config.repoSlug Bare repository provenance
 * @param {'issues'|'pulls'|'discussions'|'release-notes'} config.type Content type
 * @param {Number|String} config.id GitHub ID or semver identifier
 * @param {String} config.filePath Absolute path the file now occupies
 * @returns {Object}
 * @throws {TypeError} When `filePath` is not a chunked content path under the content root
 */
export function createContentIndexEntryFromPath(config = {}) {
    const {issueSyncConfig, repoSlug, type, id, filePath} = config,
          contentRoot                           = contentRootFor(issueSyncConfig),
          parsed                                = parseContentPath({contentRoot, repoSlug, filePath, ...pathSegmentOptionsFor(issueSyncConfig)});

    if (!parsed) {
        throw new TypeError(`filePath is not a chunked content path under the content root: ${filePath}`);
    }

    const entry = {
        repoSlug,
        type,
        id,
        version    : parsed.version,
        chunkNumber: parsed.chunkNumber,
        path       : path.relative(path.resolve(contentRoot), path.resolve(contentRoot, filePath))
    };

    if (parsed.bucket) entry.bucket = parsed.bucket;

    return normalizeContentIndexEntry(entry);
}

/**
 * @summary Resolves an indexed path and rejects entries that escape the content root.
 * @param {Object} issueSyncConfig GitHub workflow `issueSync` config block
 * @param {Object} entry Content index entry
 * @returns {String}
 */
export function resolveIndexedPath(issueSyncConfig = {}, entry = {}) {
    normalizeContentIndexEntry(entry);

    const contentRoot  = path.resolve(contentRootFor(issueSyncConfig));
    const absolutePath = path.resolve(contentRoot, entry.path);
    const relative     = path.relative(contentRoot, absolutePath);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new TypeError('indexed path must stay within the content root');
    }

    return absolutePath;
}

function indexKey(entry = {}) {
    validateSegment(entry.repoSlug, 'repoSlug');
    validateSegment(entry.type, 'type');

    if (entry.id === undefined || entry.id === null || `${entry.id}`.length === 0) {
        throw new TypeError('id must be a non-empty value');
    }

    return JSON.stringify([entry.repoSlug, entry.type, String(entry.id)]);
}

function normalizeContentIndexEntry(entry = {}) {
    validateSegment(entry.repoSlug, 'repoSlug');
    validateSegment(entry.type, 'type');
    validateSegment(entry.path, 'path', {allowPath: true});

    if (entry.id === undefined || entry.id === null || `${entry.id}`.length === 0) {
        throw new TypeError('id must be a non-empty value');
    }

    if (!Number.isInteger(entry.chunkNumber) || entry.chunkNumber < 1) {
        throw new TypeError('chunkNumber must be a positive integer');
    }

    const normalized = {
        repoSlug   : entry.repoSlug,
        type       : entry.type,
        id         : entry.id,
        version    : entry.version ?? null,
        chunkNumber: entry.chunkNumber,
        path       : entry.path
    };

    if (entry.bucket !== undefined && entry.bucket !== null) {
        validateSegment(entry.bucket, 'bucket');
        normalized.bucket = entry.bucket;
    }

    return normalized;
}

function sortContentIndex(entries = []) {
    return entries
        .map(entry => normalizeContentIndexEntry(entry))
        .sort((a, b) => {
            const repoCompare = a.repoSlug.localeCompare(b.repoSlug);
            if (repoCompare) return repoCompare;

            const typeCompare = a.type.localeCompare(b.type);
            if (typeCompare) return typeCompare;

            const aId       = Number(a.id);
            const bId       = Number(b.id);
            const idCompare = Number.isFinite(aId) && Number.isFinite(bId)
                ? aId - bId
                : `${a.id}`.localeCompare(`${b.id}`);

            return idCompare || `${a.version || ''}`.localeCompare(`${b.version || ''}`);
        });
}

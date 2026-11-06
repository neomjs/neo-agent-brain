import fs from 'node:fs/promises';
import {
    assertCurrentCoreCorpusRevisions,
    coreCorpusManifestPath,
    readCoreCorpusManifest
} from '../../services/knowledge-base/helpers/coreCorpusProfileRunner.mjs';
import {normalizeRevisionSourcePath}                               from '../../services/knowledge-base/helpers/repositoryRevisionReader.mjs';
import {buildChunkRowMetadata}                                     from '../../services/knowledge-base/helpers/chunkRowMetadata.mjs';
import {coreRowProtectionReason, fingerprint, metadataFingerprint} from './coreRowRetirementPlan.mjs';
import {readCollectionIds, readRetirementRows}                     from './coreRowRetirement.mjs';

/**
 * @module ai/scripts/maintenance/coreRowRetirementInputs
 * @summary Reads selected core-profile inputs and proposes exact-identity correspondences without embedding or deleting.
 * The caller supplies the existing collection and VectorService owner under its maintenance lease.
 * No service singleton, shared configuration or runtime connection is initialized by this module.
 */

const PATH_CONVERSIONS = Object.freeze([
    Object.freeze({fromPrefix: 'node_modules/neo.mjs/', toPrefix: ''}),
    Object.freeze({repoSlug: 'neo-agent-brain', fromPrefix: 'src/ai/', toPrefix: 'ai/'})
]);
const TYPE_CONVERSIONS = Object.freeze([
    Object.freeze({repoSlug: 'neo-agent-brain', pathPrefix: 'src/', from: 'src', to: 'brain-source'}),
    Object.freeze({repoSlug: 'neo-agent-brain', pathPrefix: 'ai/', from: 'src', to: 'ai-infrastructure'})
]);

/** @summary Refuses unreadable or changed observations using a stable maintenance code. */
function requireValue(condition, code) {
    if (!condition) {
        const error = new Error(code);
        error.code = code;
        throw error;
    }
}

/** @summary Freezes only detached input observations; never freezes the injected runtime owner. */
function freeze(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

/**
 * @summary Uses the actual vector owner for expansion and tenant-aware storage IDs, without invoking embedding.
 * @param {Object} vectorService Existing initialized VectorService owner.
 * @returns {Function} Planner-compatible `(chunk, tenantContext) => storedRows` adapter.
 */
export function createCoreRowStoredRowDeriver(vectorService) {
    requireValue(['resolveTenantStamp', 'expandOversizedEmbeddingChunks', 'applyTenantStamp']
        .every(name => typeof vectorService?.[name] === 'function'), 'KB_CORE_RETIRE_VECTOR_OWNER_REQUIRED');
    return (chunk, context) => {
        const stamp = vectorService.resolveTenantStamp(context);
        requireValue(stamp.tenantId === context.tenantId && stamp.repoSlug === context.repoSlug, 'KB_CORE_RETIRE_STAMP_CHANGED');
        return vectorService.expandOversizedEmbeddingChunks([structuredClone(chunk)]).map(child => {
            const stored = vectorService.applyTenantStamp(child, stamp);
            return {id: stored.id, metadata: buildChunkRowMetadata(stored)};
        });
    };
}

/** @summary Normalizes only the bound conversion table, never searches for a moved source file. */
function convertedPath(value, repoSlug, rules) {
    let result = normalizeRevisionSourcePath(value);
    for (const rule of rules) {
        if ((!rule.repoSlug || rule.repoSlug === repoSlug) && result.startsWith(rule.fromPrefix)) {
            result = normalizeRevisionSourcePath(rule.toPrefix + result.slice(rule.fromPrefix.length));
        }
    }
    return result;
}

/** @summary Keys exact source-path/name/kind identity; type admission is checked separately. */
function sourceKey(repoSlug, sourcePath, name, kind) {
    return JSON.stringify([repoSlug, sourcePath, name, kind ?? null]);
}

/** @summary Records only exact reviewed field conversions; semantic equality remains the planner's job. */
function targetFor(artifact, chunk, old) {
    const conversions = [];
    for (const field of ['source', 'sourcePath', 'type']) {
        if ((old[field] ?? null) !== chunk[field]) conversions.push({field, from: old[field] ?? null, to: chunk[field]});
    }
    return {
        repoSlug          : artifact.repoSlug, revision: artifact.revision, artifactSha256: artifact.sha256,
        extractionIdentity: artifact.extractionIdentity, source: chunk.source, sourcePath: chunk.sourcePath,
        type              : chunk.type, name: chunk.name, kind: chunk.kind ?? null, conversions
    };
}

/** @summary Reads the complete old tuple in bounded pages and rejects duplicate or foreign observations. */
async function readLegacyRows(collection, vectorService, scope, pageSize) {
    requireValue(typeof vectorService.buildOwnedScopeFilter === 'function', 'KB_CORE_RETIRE_SCOPE_OWNER_REQUIRED');
    const where = vectorService.buildOwnedScopeFilter(scope), rows = new Map();
    for (let offset = 0;; offset += pageSize) {
        const page = await collection.get({where, include: ['metadatas'], limit: pageSize, offset});
        requireValue(Array.isArray(page.ids) && Array.isArray(page.metadatas) && page.ids.length <= pageSize
            && page.ids.length === page.metadatas.length, 'KB_CORE_RETIRE_LEGACY_PAGE_INVALID');
        page.ids.forEach((id, index) => {
            const metadata = page.metadatas[index];
            requireValue(typeof id === 'string' && id.length > 0 && !rows.has(id) && metadata
                && metadata.tenantId === scope.tenantId && metadata.repoSlug === scope.repoSlug, 'KB_CORE_RETIRE_LEGACY_ROW_INVALID');
            rows.set(id, {id, metadata: structuredClone(metadata)});
        });
        if (page.ids.length < pageSize) return rows;
    }
}

/**
 * @summary Captures exact profile bytes, current storage observations and bound correspondence proposals.
 * @param {Object} options Existing selected owners, exact scope and selected image-carried profile path.
 * @param {Function} [options.readText] Isolated file-reader seam.
 * @param {Function} [options.readManifest] Existing manifest validation owner, or a fixture seam.
 * @param {Function} [options.assertCurrentRevisions] Existing reader-revision gate, or a fixture seam.
 * @returns {Promise<Object>} Frozen planner-compatible inputs; no plan, journal or runtime file is written.
 */
export async function prepareCoreRowRetirementInputs({
    collection, vectorService, scope, dataPath, brainRoot, brainRevision, pageSize = 2000,
    readText = file => fs.readFile(file, 'utf8'), readManifest = readCoreCorpusManifest,
    assertCurrentRevisions = assertCurrentCoreCorpusRevisions,
    pathConversions = PATH_CONVERSIONS, typeConversions = TYPE_CONVERSIONS
}) {
    requireValue(typeof collection?.id === 'string' && collection.id.length > 0 && typeof scope?.tenantId === 'string'
        && scope.tenantId.length > 0 && typeof scope.repoSlug === 'string' && scope.repoSlug.length > 0, 'KB_CORE_RETIRE_INPUT_SCOPE_INVALID');
    requireValue(Number.isSafeInteger(pageSize) && pageSize > 0, 'KB_CORE_RETIRE_PAGE_SIZE_INVALID');
    requireValue(Array.isArray(pathConversions) && pathConversions.every(rule => typeof rule.fromPrefix === 'string'
        && rule.fromPrefix.length > 0 && typeof rule.toPrefix === 'string') && Array.isArray(typeConversions)
        && typeConversions.every(rule => typeof rule.repoSlug === 'string' && typeof rule.pathPrefix === 'string'
            && typeof rule.from === 'string' && typeof rule.to === 'string'), 'KB_CORE_RETIRE_CONVERSIONS_INVALID');
    const manifestPath = coreCorpusManifestPath(dataPath), manifestText = await readText(manifestPath);
    const manifest     = await readManifest(dataPath);
    requireValue(fingerprint(JSON.parse(manifestText)) === fingerprint(manifest), 'KB_CORE_RETIRE_MANIFEST_MOVED');
    await assertCurrentRevisions({manifest, brainRoot, brainRevision});
    const artifacts = [], chunks = [], index = new Map();
    for (const artifact of manifest.artifacts) {
        requireValue(artifact.tenantId === scope.tenantId, 'KB_CORE_RETIRE_PROFILE_SCOPE_CHANGED');
        const text = await readText(artifact.path);
        requireValue(fingerprint(text) === artifact.sha256, 'KB_CORE_RETIRE_ARTIFACT_MOVED');
        const parsed = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
        requireValue(parsed.length === artifact.count, 'KB_CORE_RETIRE_ARTIFACT_COUNT_CHANGED');
        artifacts.push({path: artifact.path, text});
        for (const chunk of parsed) {
            requireValue(chunk.extractionIdentity === artifact.extractionIdentity && typeof chunk.source === 'string'
                && typeof chunk.name === 'string' && typeof chunk.type === 'string', 'KB_CORE_RETIRE_PROFILE_CHUNK_INVALID');
            const sourcePath = normalizeRevisionSourcePath(chunk.sourcePath);
            const item       = {artifact, chunk};
            chunks.push(item);
            if (!coreRowProtectionReason({...scope, type: chunk.type}, scope)) {
                const key = sourceKey(artifact.repoSlug, sourcePath, chunk.name, chunk.kind);
                if (!index.has(key)) index.set(key, []);
                index.get(key).push(item);
            }
        }
    }
    requireValue(await readText(manifestPath) === manifestText, 'KB_CORE_RETIRE_MANIFEST_MOVED');
    const population       = await readCollectionIds(collection, pageSize), populationSet = new Set(population);
    const legacyRows       = await readLegacyRows(collection, vectorService, scope, pageSize);
    const deriveStoredRows = createCoreRowStoredRowDeriver(vectorService), targetIds = new Set();
    for (const {artifact, chunk} of chunks) {
        for (const row of deriveStoredRows(chunk, {tenantId: artifact.tenantId, repoSlug: artifact.repoSlug})) targetIds.add(row.id);
    }
    const targetRows = await readRetirementRows(collection, [...targetIds], pageSize);
    const census     = new Map(legacyRows);
    for (const [id, metadata] of targetRows) {
        requireValue(!census.has(id) || metadataFingerprint(census.get(id).metadata) === metadataFingerprint(metadata), 'KB_CORE_RETIRE_OBSERVED_ROW_MOVED');
        census.set(id, {id, metadata: structuredClone(metadata)});
    }
    requireValue([...census.keys()].every(id => populationSet.has(id)), 'KB_CORE_RETIRE_POPULATION_MOVED');
    const entries = [];
    for (const row of legacyRows.values()) {
        if (coreRowProtectionReason(row.metadata, scope) || typeof row.metadata.source !== 'string' || typeof row.metadata.name !== 'string') continue;
        const targets = [];
        for (const repoSlug of ['neo', 'neo-agent-brain']) {
            let sourcePath;
            try {
                sourcePath = convertedPath(row.metadata.sourcePath ?? row.metadata.source, repoSlug, pathConversions);
                if (convertedPath(row.metadata.source, repoSlug, pathConversions) !== sourcePath) continue;
            } catch {continue;}
            for (const {artifact, chunk} of index.get(sourceKey(repoSlug, sourcePath, row.metadata.name, row.metadata.kind)) || []) {
                const allowed = row.metadata.type === chunk.type || typeConversions.some(rule => rule.repoSlug === repoSlug
                    && sourcePath.startsWith(rule.pathPrefix) && rule.from === row.metadata.type && rule.to === chunk.type);
                if (allowed) targets.push(targetFor(artifact, chunk, row.metadata));
            }
        }
        if (targets.length) entries.push({oldId: row.id, metadataDigest: metadataFingerprint(row.metadata), targets});
    }
    const after = await readCollectionIds(collection, pageSize);
    requireValue(fingerprint(after) === fingerprint(population), 'KB_CORE_RETIRE_POPULATION_MOVED');
    requireValue(await readText(manifestPath) === manifestText, 'KB_CORE_RETIRE_MANIFEST_MOVED');
    const correspondenceText = JSON.stringify({schemaVersion: 'neo.legacy-core-correspondence/v1',
        conversions: {paths: pathConversions, types: typeConversions}, entries: entries.sort((a, b) => a.oldId.localeCompare(b.oldId))});
    return freeze({
        collectionId  : collection.id, scope: structuredClone(scope), manifest: {text: manifestText, sha256: fingerprint(manifestText)}, artifacts,
        census        : [...census.values()].sort((a, b) => a.id.localeCompare(b.id)),
        correspondence: {text: correspondenceText, sha256: fingerprint(correspondenceText)}, deriveStoredRows,
        protectedIds  : population.filter(id => !census.has(id))
    });
}

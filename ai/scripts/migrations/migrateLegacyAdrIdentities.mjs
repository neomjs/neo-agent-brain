import crypto                                                                                                    from 'crypto';
import {execFileSync}                                                                                            from 'node:child_process';
import fs                                                                                                        from 'fs';
import path                                                                                                      from 'path';
import {createRequire}                                                                                           from 'node:module';
import {fileURLToPath}                                                                                           from 'node:url';
import Neo                                                                                                       from 'neo.mjs/src/Neo.mjs';
import * as core                                                                                                 from 'neo.mjs/src/core/_export.mjs';
import {ChromaClient}                                                                                            from 'chromadb';
import kbConfig                                                                                                  from '../../mcp/server/knowledge-base/config.mjs';
import memoryCoreConfig                                                                                          from '../../mcp/server/memory-core/config.mjs';
import AdrSource                                                                                                 from '../../services/knowledge-base/source/AdrSource.mjs';
import TextEmbeddingService                                                                                      from '../../services/memory-core/TextEmbeddingService.mjs';
import {parseAdrRedirect}                                                                                        from '../../services/shared/adrRedirect.mjs';
import {registerNeoChromaEmbeddingFunctions}                                                                     from '../../services/shared/vector/chromaClientPrimitives.mjs';
import {ADR_NUMBER_REGEX, buildCanonicalAdrKey, createCodedError, parseCanonicalAdrKey}                          from '../../services/shared/adrIdentityCodec.mjs';
import {hydrateAdrAdmissionRecords, isAdrReaderAuthorized, registerSharedForgeRepository, resetSharedAdrCatalog} from '../../services/ingestion/adrAdmissionCatalog.mjs';
import {parseAdrFilename}                                                                                        from '../../services/shared/adrDocumentParser.mjs';
import {
    ADR_MIGRATION_RUNBOOK, MIGRATION_CUT_REPOSITORIES, MIGRATION_MANIFEST_VERSION, MOVED_FM_ADR_NUMBERS,
    OBSERVED_11_CENSUS_ANOMALY_NUMBERS, OBSERVED_LIVE_ANOMALY_NUMBERS, REVIEWED_41_ADR_MIGRATION_MANIFEST
} from './adrMigrationManifest.mjs';

/**
 * @module ai/scripts/migrations/migrateLegacyAdrIdentities
 * @summary Restartable cross-store migration and reconciliation tool for legacy four-digit ADR
 * identities across Native Edge Graph SQLite storage, vector projections, and Knowledge Base ADR state.
 * Dry-run by default; requires `--apply` (`apply: true`) to mutate stores.
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §§2.6–2.10
 */

export const MIGRATION_PHASES = Object.freeze([
    'preconditions_verified', 'backup_created', 'graph_sqlite_applied',
    'vector_store_applied', 'kb_projection_applied', 'reader_verified', 'completed'
]);

const LEGACY_ID_REGEX    = /^adr-(\d{4})$/;
const __filename         = fileURLToPath(import.meta.url);
const __dirname          = path.dirname(__filename);
const BRAIN_ROOT_DIR     = path.resolve(__dirname, '../../..');
const WORKSPACE_ROOT_DIR = path.resolve(BRAIN_ROOT_DIR, '..');
const fail               = (code, msg) => { throw createCodedError(code, msg); };

/** @summary Computes the 12-hex-character SHA-256 content hash used by the ADR migration manifest. */
export function computeMigrationContentHash(content) {
    return crypto.createHash('sha256').update(String(content ?? '')).digest('hex').slice(0, 12);
}

function resolveRepositoryWorktreeDir(ns, repoRoots = null) {
    if (repoRoots && typeof repoRoots[ns] === 'string') return repoRoots[ns];
    if (ns === 'neomjs/neo-agent-brain') return BRAIN_ROOT_DIR;
    const shortName = String(ns).split('/')[1];
    return shortName ? path.join(WORKSPACE_ROOT_DIR, shortName) : null;
}

function readLiveWorktreeMarkdown(repoDir, relPath) {
    if (!repoDir || !relPath) return null;
    const absFile = path.join(repoDir, relPath);
    return fs.existsSync(absFile) ? fs.readFileSync(absFile, 'utf8') : null;
}

function readLiveWorktreeContentHash(repoDir, relPath) {
    const raw = readLiveWorktreeMarkdown(repoDir, relPath);
    return raw === null ? null : computeMigrationContentHash(raw);
}

/** @summary Builds the default `sourceProbe` from live repository worktrees and git state without manifest fallbacks. */
export function createDefaultSourceProbe({
    manifest = REVIEWED_41_ADR_MIGRATION_MANIFEST, cutRepositories = MIGRATION_CUT_REPOSITORIES,
    repoRoots = null, requirePrivateStageAccess = true
} = {}) {
    const revisions = {}, contentHashes = {}, redirectContentHashes = {}, probeHashes = {};
    const runGit    = (repoDir, args) => execFileSync('git', args, {cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();

    for (const [ns, repoMeta] of Object.entries(cutRepositories || {})) {
        if (!repoMeta || typeof repoMeta !== 'object') continue;
        const repoDir     = resolveRepositoryWorktreeDir(ns, repoRoots), territoryRoot = repoMeta.territoryRoot || 'learn';
        let   observedRev = null;
        if (repoDir && fs.existsSync(path.join(repoDir, '.git')) && repoMeta.cutRevision) {
            try {
                const resolvedCommit = runGit(repoDir, ['rev-parse', '--verify', `${repoMeta.cutRevision}^{commit}`]);
                if (resolvedCommit.startsWith(repoMeta.cutRevision)) {
                    const diffFromCut    = runGit(repoDir, ['diff', '--name-only', repoMeta.cutRevision, 'HEAD', '--', territoryRoot]);
                    const worktreeStatus = runGit(repoDir, ['status', '--porcelain', '--untracked-files=no', '--', territoryRoot]);
                    observedRev = worktreeStatus ? 'DIRTY_WORKTREE' : diffFromCut ? (runGit(repoDir, ['rev-parse', '--short=9', 'HEAD']) || 'DRIFTED_HEAD') : repoMeta.cutRevision;
                }
            } catch { observedRev = null; }
        }
        if (observedRev) revisions[ns] = observedRev;
        if (repoMeta.probeRecord?.sourcePath) {
            const probeHash = readLiveWorktreeContentHash(repoDir, repoMeta.probeRecord.sourcePath);
            if (probeHash) probeHashes[ns] = probeHash;
        }
    }

    for (const entry of manifest || []) {
        if (!entry?.sourceTuple) continue;
        const actualHash = readLiveWorktreeContentHash(resolveRepositoryWorktreeDir(entry.sourceTuple.namespace, repoRoots), entry.sourcePath);
        if (actualHash) contentHashes[entry.legacyId] = contentHashes[entry.canonicalKey] = actualHash;
        if (entry.custodyTransition?.redirectPath) {
            const actualRedirectHash = readLiveWorktreeContentHash(resolveRepositoryWorktreeDir(entry.custodyTransition.fromNamespace, repoRoots), entry.custodyTransition.redirectPath);
            if (actualRedirectHash) redirectContentHashes[entry.legacyId] = redirectContentHashes[entry.canonicalKey] = actualRedirectHash;
        }
    }
    return {revisions, contentHashes, redirectContentHashes, probeHashes, requirePrivateStageAccess};
}

/** @summary Builds the default `readerContext` from verified repository checkouts and private probe files. */
export function createDefaultReaderContext({
    cutRepositories = MIGRATION_CUT_REPOSITORIES, repoRoots = null,
    agentIdentity = '@neo-migration-verifier', allowPrivate = true
} = {}) {
    const authorizedNamespaces = [], authorizedRepositories = [], publicNamespaces = [], publicRepositories = [];
    for (const [ns, repoMeta] of Object.entries(cutRepositories || {})) {
        if (!repoMeta || typeof repoMeta !== 'object') continue;
        const repoId = repoMeta.repositoryId;
        if (repoMeta.visibility === 'private') {
            if (!allowPrivate) continue;
            const probeHash = readLiveWorktreeContentHash(resolveRepositoryWorktreeDir(ns, repoRoots), repoMeta.probeRecord?.sourcePath);
            if (probeHash && probeHash === repoMeta.probeRecord?.contentHash) {
                authorizedNamespaces.push(ns);
                authorizedRepositories.push(ns, ...(repoId ? [repoId] : []));
            }
        } else {
            publicNamespaces.push(ns);
            publicRepositories.push(ns, ...(repoId ? [repoId] : []));
            authorizedNamespaces.push(ns);
            authorizedRepositories.push(ns, ...(repoId ? [repoId] : []));
        }
    }
    return {
        agentIdentity, allowPrivate, authorizedNamespaces, authorizedRepositories,
        publicReaderContext: {agentIdentity, allowPrivate: false, authorizedNamespaces: publicNamespaces, authorizedRepositories: publicRepositories}
    };
}

function isValidEmbeddingVector(vec) {
    return Array.isArray(vec) && vec.length > 1 && vec.every(v => typeof v === 'number' && Number.isFinite(v));
}

function assertValidUniformEmbeddings(embeddings, ids, storeLabel, expectedDimension = null) {
    let targetDim = Number.isInteger(expectedDimension) && expectedDimension > 1 ? expectedDimension : null;
    for (let i = 0; i < embeddings.length; i++) {
        const vec = embeddings[i], id = ids[i] || `index-${i}`;
        if (!isValidEmbeddingVector(vec)) fail('ADR_MIGRATION_VECTOR_EMBEDDING_REQUIRED', `${storeLabel} requires a non-placeholder numeric embedding vector (length > 1) for '${id}'.`);
        if (targetDim === null) targetDim = vec.length;
        else if (vec.length !== targetDim) fail('ADR_MIGRATION_VECTOR_DIMENSION_MISMATCH', `${storeLabel} embedding dimension mismatch for '${id}': expected ${targetDim}, received ${vec.length}.`);
    }
}

function buildAdrEmbeddingDocumentText(entry, repoRoots = null, fallbackDocument = null) {
    const markdown = readLiveWorktreeMarkdown(resolveRepositoryWorktreeDir(entry?.sourceTuple?.namespace, repoRoots), entry?.sourcePath);
    if (markdown) return `${entry.title}\n\n${markdown}`;
    if (typeof fallbackDocument === 'string' && fallbackDocument.trim().length > 0) return fallbackDocument;
    return `${entry?.title || entry?.canonicalKey} (${entry?.canonicalKey || entry?.legacyId})`;
}

function createDefaultChromaClient(chroma, database, clientFactory = null) {
    registerNeoChromaEmbeddingFunctions({dummyEmbeddingFunction: memoryCoreConfig.dummyEmbeddingFunction});
    const options = {host: chroma.host, port: chroma.port, ssl: false, database};
    return typeof clientFactory === 'function' ? clientFactory(options) : new ChromaClient(options);
}

async function fetchChromaEntriesMap(collection, lookupIds) {
    const res                 = await collection.get({ids: lookupIds, include: ['embeddings', 'documents', 'metadatas']});
    const existingById        = new Map(), ids = res?.ids || [];
    let   collectionDimension = null;
    for (let i = 0; i < ids.length; i++) {
        const vec = res.embeddings?.[i] ?? null;
        if (collectionDimension === null && isValidEmbeddingVector(vec)) collectionDimension = vec.length;
        existingById.set(ids[i], {id: ids[i], embedding: vec, document: res.documents?.[i] ?? null, metadata: res.metadatas?.[i] ? {...res.metadatas[i]} : {}});
    }
    return {existingById, collectionDimension};
}

function createChromaMigrationAdapter(isKb, {client = null, clientFactory = null, collectionName = null, repoRoots = null, embedText = null} = {}) {
    const
        chroma                 = isKb ? kbConfig.engines.chroma : memoryCoreConfig.engines.chroma,
        database               = isKb ? kbConfig.chromaDatabase : (chroma.useTestDatabase ? chroma.databaseTest : chroma.database),
        resolvedClient         = client || createDefaultChromaClient(chroma, database, clientFactory),
        resolvedCollectionName = collectionName || (isKb ? kbConfig.collectionName : memoryCoreConfig.collections.graph),
        storeLabel             = isKb ? 'Knowledge Base vector store' : 'Memory Core vector store',
        missingCode            = isKb ? 'ADR_MIGRATION_KB_COLLECTION_MISSING' : 'ADR_MIGRATION_VECTOR_COLLECTION_MISSING',
        dummyFn                = isKb ? kbConfig.dummyEmbeddingFunction : memoryCoreConfig.dummyEmbeddingFunction,
        resolveEmbedding       = typeof embedText === 'function'
            ? embedText
            : async (text) => TextEmbeddingService.embedText(text, memoryCoreConfig.embeddingProvider, {
                operationLabel: isKb ? 'adr migration kb vector embedding' : 'adr migration graph vector embedding',
                operationStage: 'adr-migration-embedding',
                service       : isKb ? 'knowledge-base' : 'memory-core'
            }),
        getCollection = async () => {
            if (!resolvedClient || typeof resolvedClient.getCollection !== 'function') fail(missingCode, `Chroma client does not support getCollection() for '${resolvedCollectionName}'.`);
            return resolvedClient.getCollection({name: resolvedCollectionName, embeddingFunction: dummyFn});
        };

    return {
        collectionName: resolvedCollectionName,
        async exportSnapshot({manifest = REVIEWED_41_ADR_MIGRATION_MANIFEST} = {}) {
            const targetIds = new Set([...manifest.map(e => e.legacyId), ...manifest.map(e => e.canonicalKey)]);
            if (!isKb) for (const entry of manifest) if (entry.observedState?.observedSemanticVectorId) targetIds.add(entry.observedState.observedSemanticVectorId);
            const {existingById} = await fetchChromaEntriesMap(await getCollection(), Array.from(targetIds));
            return Array.from(existingById.entries());
        },
        async applyAdrMigration({manifest = REVIEWED_41_ADR_MIGRATION_MANIFEST, nonAdrSummaryIds = [], admissionRecords = []} = {}) {
            const
                collection                          = await getCollection(),
                lookupIds                           = Array.from(new Set([...manifest.map(e => e.legacyId), ...manifest.map(e => e.canonicalKey), ...(isKb ? [] : nonAdrSummaryIds)])),
                {existingById, collectionDimension} = await fetchChromaEntriesMap(collection, lookupIds),
                upsertIds                           = [], upsertEmbeddings = [], upsertDocuments = [], upsertMetadatas = [], legacyToDelete = [];

            for (let idx = 0; idx < manifest.length; idx++) {
                const
                    entry             = manifest[idx],
                    existingCanonical = existingById.get(entry.canonicalKey),
                    existingLegacy    = existingById.get(entry.legacyId),
                    existing          = existingLegacy || existingCanonical,
                    isSummaryAnomaly  = String(entry.observedState?.observedSemanticVectorId || '').startsWith('summary_'),
                    docText           = existing?.document || `${entry.title} (${entry.canonicalKey})`,
                    embedding         = isKb
                        ? (isValidEmbeddingVector(existing?.embedding) ? existing.embedding : await resolveEmbedding(buildAdrEmbeddingDocumentText(entry, repoRoots, existing?.document), entry))
                        : (isValidEmbeddingVector(existingCanonical?.embedding)
                            ? existingCanonical.embedding
                            : (!isSummaryAnomaly && isValidEmbeddingVector(existingLegacy?.embedding))
                                ? existingLegacy.embedding
                                : await resolveEmbedding(buildAdrEmbeddingDocumentText(entry, repoRoots, existing?.document), entry));

                upsertIds.push(entry.canonicalKey);
                upsertEmbeddings.push(embedding);
                upsertDocuments.push(docText);
                const admissionRecord = isKb ? (admissionRecords[idx] || buildAdrMigrationRecordFromManifestEntry(entry)) : null;
                upsertMetadatas.push(isKb ? {
                    ...(existing?.metadata || {}), id: entry.canonicalKey, canonicalKey: entry.canonicalKey, legacyId: entry.legacyId,
                    adrNumber   : entry.adrNumber, title: entry.title, currentSlug: entry.currentSlug, sourcePath: entry.sourcePath,
                    repositoryId: entry.sourceTuple.repositoryId, namespace: entry.sourceTuple.namespace, visibility: entry.visibility || 'public',
                    aliases     : JSON.stringify(admissionRecord.aliases || []), historicalAliases: JSON.stringify(admissionRecord.historicalAliases || [])
                } : {
                    ...(existing?.metadata || {}), id: entry.canonicalKey, canonicalKey: entry.canonicalKey, legacyId: entry.legacyId,
                    label    : 'ADR', adrNumber: entry.adrNumber, repositoryId: entry.sourceTuple.repositoryId,
                    namespace: entry.sourceTuple.namespace, contentHash: entry.sourceTuple.contentHash
                });
                if (existingById.has(entry.legacyId)) legacyToDelete.push(entry.legacyId);
            }

            assertValidUniformEmbeddings(upsertEmbeddings, upsertIds, storeLabel, collectionDimension);
            if (upsertIds.length > 0) await collection.upsert({ids: upsertIds, embeddings: upsertEmbeddings, documents: upsertDocuments, metadatas: upsertMetadatas});
            if (legacyToDelete.length > 0) await collection.delete({ids: legacyToDelete});
            return isKb
                ? {migratedKbEntriesCount: upsertIds.length, removedLegacyKbCount: legacyToDelete.length}
                : {upsertedVectorsCount: upsertIds.length, removedLegacyAdrVectorsCount: legacyToDelete.length, preservedSummaryVectorsCount: nonAdrSummaryIds.filter(id => existingById.has(id)).length};
        },
        async restoreSnapshot(entries = [], {canonicalKeys = []} = {}) {
            const collection = await getCollection(), restoreIds = Array.isArray(entries) ? entries.map(([id]) => id) : [], restoreEmbeddings = Array.isArray(entries) ? entries.map(([, v]) => v?.embedding) : [];
            if (restoreIds.length > 0) assertValidUniformEmbeddings(restoreEmbeddings, restoreIds, `${storeLabel} restore`);
            if (Array.isArray(canonicalKeys) && canonicalKeys.length > 0) await collection.delete({ids: canonicalKeys});
            if (restoreIds.length > 0) await collection.upsert({ids: restoreIds, embeddings: restoreEmbeddings, documents: entries.map(([id, v]) => v?.document || String(id)), metadatas: entries.map(([id, v]) => v?.metadata || {id})});
            return {restoredCount: restoreIds.length};
        }
    };
}

/** @summary Creates a production Chroma adapter for the Memory Core native graph vector collection. */
export function createChromaVectorStoreAdapter(options = {}) { return createChromaMigrationAdapter(false, options); }

/** @summary Creates a production Chroma adapter for the Knowledge Base ADR vector collection. */
export function createChromaKbStoreAdapter(options = {}) { return createChromaMigrationAdapter(true, options); }

/** @summary Composes the default migration store adapters (`vectorStore`, `kbStore`), `sourceProbe`, and `readerContext`. */
export function composeDefaultMigrationStores({
    chromaClient = null, vectorChromaClient = null, kbChromaClient = null, clientFactory = null,
    vectorStore = null, kbStore = null, vectorCollectionName = null, kbCollectionName = null,
    embedText = null, manifest = REVIEWED_41_ADR_MIGRATION_MANIFEST, cutRepositories = MIGRATION_CUT_REPOSITORIES,
    repoRoots = null, sourceProbe = undefined, readerContext = undefined
} = {}) {
    return {
        vectorStore  : vectorStore || createChromaVectorStoreAdapter({client: vectorChromaClient || chromaClient, clientFactory, collectionName: vectorCollectionName, repoRoots, embedText}),
        kbStore      : kbStore || createChromaKbStoreAdapter({client: kbChromaClient || chromaClient, clientFactory, collectionName: kbCollectionName, repoRoots, embedText}),
        sourceProbe  : sourceProbe !== undefined ? sourceProbe : createDefaultSourceProbe({manifest, cutRepositories, repoRoots}),
        readerContext: readerContext !== undefined ? readerContext : createDefaultReaderContext({cutRepositories, repoRoots})
    };
}

function isValidMigrationStore(store) {
    return (store instanceof Map) || Boolean(store && typeof store === 'object' && typeof store.applyAdrMigration === 'function' && typeof store.exportSnapshot === 'function' && typeof store.restoreSnapshot === 'function');
}

/** @summary Normalizes an issue, pull-request, or discussion origin reference into its canonical repository-qualified form. */
export function normalizeHistoricalOriginReference(rawRef, defaultRepo = null, declaredReferences = []) {
    if (typeof rawRef !== 'string' || !rawRef.trim()) return '';
    const trimmed = rawRef.trim();
    if (/^(?:ISSUE|PULL_REQUEST|DISCUSSION):[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/i.test(trimmed)) {
        const [prefix, rest] = trimmed.split(':');
        return `${prefix.toUpperCase()}:${rest}`;
    }

    const normalizedDeclared = (Array.isArray(declaredReferences) ? declaredReferences : [])
        .map(ref => typeof ref === 'string' ? ref.trim() : '')
        .filter(ref => /^(?:ISSUE|PULL_REQUEST|DISCUSSION):[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/i.test(ref))
        .map(ref => { const [p, r] = ref.split(':'); return `${p.toUpperCase()}:${r}`; });

    const bareTypedMatch = trimmed.match(/^(ISSUE|PULL_REQUEST|DISCUSSION):#?(\d+)$/i);
    if (bareTypedMatch) {
        const typePrefix = bareTypedMatch[1].toUpperCase(), num = bareTypedMatch[2];
        const proven     = normalizedDeclared.filter(ref => ref.startsWith(`${typePrefix}:`) && ref.endsWith(`#${num}`));
        if (proven.length === 1) return proven[0];
        if (typeof defaultRepo === 'string' && defaultRepo.trim()) return `${typePrefix}:${defaultRepo.trim()}#${num}`;
        return trimmed;
    }

    const untypedMatch = trimmed.match(/^(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)$/);
    if (untypedMatch) {
        const explicitRepo = untypedMatch[1] || null, num = untypedMatch[2];
        const proven       = normalizedDeclared.filter(ref => ref.endsWith(`#${num}`) && (!explicitRepo || ref.split(':')[1].toLowerCase() === `${explicitRepo.toLowerCase()}#${num}`));
        if (proven.length === 1) return proven[0];
    }
    return trimmed;
}

/** @summary Converts a reviewed manifest entry into an `adrAdmissionRecord` payload for SQLite and catalog hydration. */
export function buildAdrMigrationRecordFromManifestEntry(entry) {
    return {
        canonicalKey      : entry.canonicalKey, originCanonicalKey: entry.originCanonicalKey || null,
        adrNumber         : entry.adrNumber, legacyId: entry.legacyId, title: entry.title,
        status            : entry.status || 'Accepted', currentSlug: entry.currentSlug, fileName: entry.fileName, sourcePath: entry.sourcePath,
        assignmentEvidence: {...entry.assignmentEvidence}, sourceTuple: {...entry.sourceTuple},
        documentAvailable : true, kbAvailable: true, stale: false,
        visibility        : entry.visibility || 'public', tenantId: entry.tenantId || null,
        aliases           : [...(entry.aliases || [entry.currentSlug])], historicalAliases: [...(entry.historicalAliases || [entry.legacyId])],
        aliasBindings     : (entry.aliasBindings || []).map(b => ({...b})),
        reservations      : (entry.reservations || []).map(r => ({
            kind  : r.kind || 'legacy-number', value: r.value || r.adrNumber || entry.adrNumber,
            forge : r.forge, repositoryId: r.repositoryId, namespace: r.namespace,
            reason: r.reason || 'assigned-custody', targetKey: entry.canonicalKey
        })),
        historicalReferences: (entry.historicalReferences || []).map(ref => normalizeHistoricalOriginReference(ref, entry.assignmentEvidence?.namespace)),
        semanticDisposition : entry.semanticDisposition || 'retain',
        provenance          : {
            migratedFromLegacyId    : entry.legacyId,
            migrationManifestVersion: MIGRATION_MANIFEST_VERSION,
            custodyTransitions      : entry.custodyTransition ? [{...entry.custodyTransition}] : [],
            repositoryRenames       : [],
            sourceLineage           : [{
                forge: entry.sourceTuple.forge, repositoryId: entry.sourceTuple.repositoryId, namespace: entry.sourceTuple.namespace,
                path : entry.sourceTuple.path, revision: entry.sourceTuple.revision, contentHash: entry.sourceTuple.contentHash
            }]
        }
    };
}

/** @summary Validates the migration manifest, source/data preconditions, shared summary-vector owners, and reader capabilities. */
export function verifyMigrationPreconditions({
    manifest = REVIEWED_41_ADR_MIGRATION_MANIFEST, cutRepositories = MIGRATION_CUT_REPOSITORIES,
    db = null, sourceProbe = undefined, readerContext = undefined, requireCompleteInventory = true
} = {}) {
    const
        effectiveSourceProbe   = sourceProbe === undefined ? createDefaultSourceProbe({manifest, cutRepositories}) : sourceProbe,
        effectiveReaderContext = readerContext === undefined ? createDefaultReaderContext({cutRepositories}) : readerContext;

    if (!Array.isArray(manifest) || manifest.length === 0) fail('ADR_MIGRATION_INCOMPLETE_INVENTORY', 'Migration manifest must be a non-empty array of reviewed ADR inventory records.');
    if (requireCompleteInventory && manifest.length !== 41) fail('ADR_MIGRATION_INCOMPLETE_INVENTORY', `Expected 41 reviewed legacy ADR records (0001..0041), received ${manifest.length}.`);

    const seenLegacyIds = new Set(), seenCanonicalKeys = new Set(), seenRepoAllocations = new Set(), seenNumbers = new Set();
    let   anomalyCount  = 0, sharedVectorRecordCount = 0, custodyMoveCount = 0;

    for (const entry of manifest) {
        if (!entry || typeof entry !== 'object') fail('ADR_MIGRATION_INCOMPLETE_INVENTORY', 'Manifest contains a null or non-object record.');
        if (!ADR_NUMBER_REGEX.test(String(entry.adrNumber || '')) || !LEGACY_ID_REGEX.test(String(entry.legacyId || '')) || entry.legacyId !== `adr-${entry.adrNumber}`) fail('ADR_MIGRATION_INCONSISTENT_IDENTITY_PROOF', `Invalid or mismatched legacyId '${entry.legacyId}' and adrNumber '${entry.adrNumber}'.`);
        let parsedKey;
        try { parsedKey = parseCanonicalAdrKey(entry.canonicalKey); }
        catch (err) { fail('ADR_MIGRATION_INCONSISTENT_IDENTITY_PROOF', `Invalid canonicalKey '${entry.canonicalKey}' for '${entry.legacyId}': ${err.message}`); }

        if (parsedKey.number !== entry.adrNumber) fail('ADR_MIGRATION_INCONSISTENT_IDENTITY_PROOF', `Canonical key '${entry.canonicalKey}' number '${parsedKey.number}' does not match adrNumber '${entry.adrNumber}'.`);
        if (!entry.assignmentEvidence?.verified || !entry.assignmentEvidence?.repositoryId || !entry.assignmentEvidence?.namespace || !entry.sourceTuple?.repositoryId || !entry.sourceTuple?.namespace || !entry.sourceTuple?.path || !entry.sourceTuple?.contentHash) fail('ADR_MIGRATION_LOST_PROVENANCE', `Record '${entry.legacyId}' is missing verified assignmentEvidence or sourceTuple provenance.`);
        if (parsedKey.repositoryId !== entry.sourceTuple.repositoryId || parsedKey.namespace.toLowerCase() !== entry.sourceTuple.namespace.toLowerCase()) fail('ADR_MIGRATION_INCONSISTENT_IDENTITY_PROOF', `Canonical key '${entry.canonicalKey}' repository does not match sourceTuple '${entry.sourceTuple.namespace}'.`);
        if (seenLegacyIds.has(entry.legacyId) || seenCanonicalKeys.has(entry.canonicalKey)) fail('ADR_MIGRATION_DUPLICATE_CANONICAL_CLAIM', `Duplicate legacyId '${entry.legacyId}' or canonicalKey '${entry.canonicalKey}' in migration manifest.`);
        seenLegacyIds.add(entry.legacyId);
        seenCanonicalKeys.add(entry.canonicalKey);

        const repoAllocKey = `${entry.sourceTuple.forge || 'github.com'}:${entry.sourceTuple.repositoryId}:${entry.adrNumber}`;
        if (seenRepoAllocations.has(repoAllocKey)) fail('ADR_MIGRATION_DUPLICATE_CANONICAL_CLAIM', `Duplicate repository number allocation '${repoAllocKey}' in migration manifest.`);
        seenRepoAllocations.add(repoAllocKey);

        if (entry.custodyTransition) {
            custodyMoveCount++;
            const ct = entry.custodyTransition;
            if (!ct.verified || !ct.proof || !ct.fromRepositoryId || !ct.toRepositoryId || !ct.redirectPath) fail('ADR_MIGRATION_LOST_PROVENANCE', `Custody move for '${entry.legacyId}' is missing verified transition proof or redirect metadata.`);
            const originAllocKey = `${ct.fromForge || 'github.com'}:${ct.fromRepositoryId}:${entry.adrNumber}`;
            if (seenRepoAllocations.has(originAllocKey)) fail('ADR_MIGRATION_DUPLICATE_CANONICAL_CLAIM', `Origin reservation '${originAllocKey}' collides with another allocation in migration manifest.`);
            seenRepoAllocations.add(originAllocKey);
        }

        if (!entry.observedState || !Array.isArray(entry.observedState.reusedVectorOwners)) fail('ADR_MIGRATION_INCOMPLETE_INVENTORY', `Record '${entry.legacyId}' is missing observedState or reusedVectorOwners inventory.`);
        if (entry.observedState.nodeLabel !== 'ADR' || String(entry.observedState.observedSemanticVectorId || '').startsWith('summary_')) anomalyCount++;
        if (entry.observedState.anomalyShape === 'SHARED_SUMMARY_VECTOR_WITH_NON_ADR_OWNER' || entry.adrNumber === '0038') {
            if (!entry.observedState.reusedVectorOwners.some(o => o && o.isAdr === false)) fail('ADR_MIGRATION_INCOMPLETE_VECTOR_OWNER_INVENTORY', `Record '${entry.legacyId}' shared summary vector inventory must include its non-ADR owner(s).`);
            sharedVectorRecordCount++;
        }

        for (const ref of entry.historicalReferences || []) {
            const normalized = normalizeHistoricalOriginReference(ref, entry.assignmentEvidence.namespace);
            if (!/^(?:ISSUE|PULL_REQUEST|DISCUSSION):[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/.test(normalized)) fail('ADR_MIGRATION_LOST_PROVENANCE', `Historical reference '${ref}' on '${entry.legacyId}' cannot be normalized to a repository-qualified origin.`);
        }
        seenNumbers.add(entry.adrNumber);
    }

    if (requireCompleteInventory) {
        for (let i = 1; i <= 41; i++) {
            const num = String(i).padStart(4, '0');
            if (!seenNumbers.has(num)) fail('ADR_MIGRATION_INCOMPLETE_INVENTORY', `Reviewed 41-record manifest is missing legacy ADR number '${num}'.`);
        }
    }

    if (!effectiveSourceProbe || typeof effectiveSourceProbe !== 'object' || !effectiveSourceProbe.revisions || typeof effectiveSourceProbe.revisions !== 'object') fail('ADR_MIGRATION_SOURCE_PRECONDITION_CHANGED', 'Migration requires a valid sourceProbe object verifying cut revisions and content hashes.');
    for (const [ns, repoMeta] of Object.entries(cutRepositories || {})) {
        const expectedRev = repoMeta?.cutRevision, actualRev = effectiveSourceProbe.revisions[ns];
        if (!expectedRev || !actualRev || actualRev !== expectedRev) fail('ADR_MIGRATION_SOURCE_PRECONDITION_CHANGED', `Repository '${ns}' revision '${actualRev ?? 'MISSING'}' drifted from manifest cutRevision '${expectedRev ?? 'MISSING'}'.`);
    }
    if (!effectiveSourceProbe.contentHashes || typeof effectiveSourceProbe.contentHashes !== 'object') fail('ADR_MIGRATION_SOURCE_PRECONDITION_CHANGED', 'sourceProbe.contentHashes is missing or invalid.');
    for (const entry of manifest) {
        const actualHash = effectiveSourceProbe.contentHashes[entry.legacyId] ?? effectiveSourceProbe.contentHashes[entry.canonicalKey];
        if (!actualHash || actualHash !== entry.sourceTuple.contentHash) fail('ADR_MIGRATION_SOURCE_PRECONDITION_CHANGED', `Source contentHash for '${entry.legacyId}' changed from '${entry.sourceTuple.contentHash}' to '${actualHash ?? 'MISSING'}'.`);
        if (entry.custodyTransition?.redirectContentHash) {
            const actualRedirectHash = effectiveSourceProbe.redirectContentHashes?.[entry.legacyId] ?? effectiveSourceProbe.redirectContentHashes?.[entry.canonicalKey];
            if (!actualRedirectHash || actualRedirectHash !== entry.custodyTransition.redirectContentHash) fail('ADR_MIGRATION_SOURCE_PRECONDITION_CHANGED', `Redirect stub contentHash for '${entry.legacyId}' changed from '${entry.custodyTransition.redirectContentHash}' to '${actualRedirectHash ?? 'MISSING'}'.`);
        }
    }

    for (const [ns, repoMeta] of Object.entries(cutRepositories || {}).filter(([, m]) => m?.visibility === 'private')) {
        const probeSpec = repoMeta?.probeRecord;
        if (!probeSpec?.canonicalKey || !probeSpec?.sourcePath || !probeSpec?.contentHash || !probeSpec?.authorizedReaderContext || !probeSpec?.unauthorizedReaderContext) fail('ADR_MIGRATION_STAGE_POLICY_MISSING', `Private repository '${ns}' in cutRepositories is missing a complete reader-policy probeRecord.`);
        const actualProbeHash = effectiveSourceProbe.probeHashes?.[ns];
        if (!actualProbeHash || actualProbeHash !== probeSpec.contentHash) fail('ADR_MIGRATION_SOURCE_PRECONDITION_CHANGED', `Private repository '${ns}' probe contentHash '${actualProbeHash ?? 'MISSING'}' drifted from '${probeSpec.contentHash}'.`);
        const stageProbeRecord = {
            canonicalKey      : probeSpec.canonicalKey, visibility: repoMeta.visibility,
            sourceTuple       : {forge: repoMeta.forge, repositoryId: repoMeta.repositoryId, namespace: repoMeta.namespace, path: probeSpec.sourcePath, contentHash: probeSpec.contentHash},
            assignmentEvidence: {forge: repoMeta.forge, repositoryId: repoMeta.repositoryId, namespace: repoMeta.namespace}
        };
        if (isAdrReaderAuthorized(stageProbeRecord, probeSpec.unauthorizedReaderContext) || !isAdrReaderAuthorized(stageProbeRecord, probeSpec.authorizedReaderContext)) fail('ADR_MIGRATION_STAGE_POLICY_MISSING', `Private repository '${ns}' probeRecord failed unauthorized-reader denial or authorized-reader verification.`);
        if (effectiveSourceProbe.requirePrivateStageAccess !== false) {
            const publicContext = effectiveReaderContext?.publicReaderContext || {
                agentIdentity         : effectiveReaderContext?.agentIdentity || '@neo-public-reader',
                allowPrivate          : false,
                authorizedNamespaces  : (effectiveReaderContext?.authorizedNamespaces || []).filter(item => item !== ns),
                authorizedRepositories: (effectiveReaderContext?.authorizedRepositories || []).filter(item => item !== ns && item !== repoMeta.repositoryId)
            };
            if (!isAdrReaderAuthorized(stageProbeRecord, effectiveReaderContext || {}) || isAdrReaderAuthorized(stageProbeRecord, publicContext)) fail('ADR_MIGRATION_READER_PRECONDITION_FAILED', `Reader context is not authorized for private repository '${ns}' required by cut probe.`);
        }
    }

    if (db && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'Nodes'").get()) {
        const manifestByCanonical = new Map(manifest.map(e => [e.canonicalKey, e])), manifestByLegacy = new Map(manifest.map(e => [e.legacyId, e]));
        for (const row of db.prepare("SELECT id, data FROM Nodes WHERE id LIKE 'adr-%' OR id LIKE 'adr:%'").all()) {
            if (row.id.startsWith('adr-') && requireCompleteInventory && !manifestByLegacy.has(row.id)) fail('ADR_MIGRATION_DATA_PRECONDITION_CHANGED', `Uninventoried legacy node '${row.id}' found in SQLite Nodes table.`);
            if (row.id.startsWith('adr:')) {
                const expectedEntry = manifestByCanonical.get(row.id);
                if (expectedEntry) {
                    let parsedData = null;
                    try { parsedData = JSON.parse(row.data); } catch {}
                    const existingLegacyId = parsedData?.properties?.adrAdmissionRecord?.legacyId || parsedData?.properties?.adrAuthority?.migratedFromLegacyId;
                    if (existingLegacyId && existingLegacyId !== expectedEntry.legacyId) fail('ADR_MIGRATION_DATA_PRECONDITION_CHANGED', `Canonical node '${row.id}' in SQLite is already claimed by '${existingLegacyId}' instead of '${expectedEntry.legacyId}'.`);
                }
            }
        }
    }

    return {ok: true, manifestVersion: MIGRATION_MANIFEST_VERSION, recordCount: manifest.length, anomalyCount, sharedVectorRecordCount, custodyMoveCount, verifiedAt: new Date().toISOString()};
}

/** @summary Ensures the SQLite schema (`Nodes`, `Edges`, and `AdrIdentityMigrationJournal`) exists. */
export function ensureMigrationTables(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS Nodes (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS Edges (id TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_edges_source ON Edges(source);
        CREATE INDEX IF NOT EXISTS idx_edges_target ON Edges(target);
        CREATE TABLE IF NOT EXISTS AdrIdentityMigrationJournal (
            migration_id TEXT PRIMARY KEY, manifest_version TEXT NOT NULL, phase TEXT NOT NULL,
            completed_phases TEXT NOT NULL, backup_path TEXT, state_json TEXT NOT NULL, updated_at TEXT NOT NULL
        );
    `);
}

/** @summary Creates a point-in-time backup snapshot of ADR graph nodes, edges, vectors, and KB entries. */
export function createAdrMigrationBackup({db, vectorStore = null, kbStore = null, backupPath = null, manifest = REVIEWED_41_ADR_MIGRATION_MANIFEST} = {}) {
    if (!db) fail('ADR_MIGRATION_DB_REQUIRED', 'createAdrMigrationBackup requires a SQLite db handle.');
    ensureMigrationTables(db);

    const legacyIds = new Set(manifest.map(e => e.legacyId)), canonicalKeys = new Set(manifest.map(e => e.canonicalKey)), ownerNodeIds = new Set();
    for (const entry of manifest) for (const owner of entry.observedState?.reusedVectorOwners || []) if (owner?.nodeId) ownerNodeIds.add(owner.nodeId);

    const
        backedNodes   = db.prepare('SELECT id, data FROM Nodes ORDER BY id ASC').all().filter(r => legacyIds.has(r.id) || canonicalKeys.has(r.id) || ownerNodeIds.has(r.id) || r.id.startsWith('adr-') || r.id.startsWith('adr:')),
        backedEdges   = db.prepare('SELECT id, source, target, type, data FROM Edges ORDER BY id ASC').all().filter(r => legacyIds.has(r.source) || legacyIds.has(r.target) || canonicalKeys.has(r.source) || canonicalKeys.has(r.target)),
        vectorEntries = [], kbEntries = [];

    let vectorExportResult = null, kbExportResult = null;
    if (vectorStore instanceof Map) {
        for (const [k, v] of vectorStore.entries()) if (legacyIds.has(k) || canonicalKeys.has(k) || String(k).startsWith('summary_')) vectorEntries.push([k, structuredClone(v)]);
    } else if (vectorStore && typeof vectorStore.exportSnapshot === 'function') vectorExportResult = vectorStore.exportSnapshot({manifest});

    if (kbStore instanceof Map) {
        for (const [k, v] of kbStore.entries()) if (legacyIds.has(k) || canonicalKeys.has(k)) kbEntries.push([k, structuredClone(v)]);
    } else if (kbStore && typeof kbStore.exportSnapshot === 'function') kbExportResult = kbStore.exportSnapshot({manifest});

    const finalizeSnapshot = (resolvedVecExport, resolvedKbExport) => {
        if (Array.isArray(resolvedVecExport)) vectorEntries.push(...structuredClone(resolvedVecExport));
        if (Array.isArray(resolvedKbExport)) kbEntries.push(...structuredClone(resolvedKbExport));
        const snapshot = {
            version    : MIGRATION_MANIFEST_VERSION, createdAt: new Date().toISOString(),
            manifestIds: manifest.map(e => ({legacyId: e.legacyId, canonicalKey: e.canonicalKey})),
            nodes      : backedNodes, edges: backedEdges, vectorEntries, kbEntries
        };
        if (typeof backupPath === 'string' && backupPath.trim()) {
            fs.mkdirSync(path.dirname(path.resolve(backupPath)), {recursive: true});
            fs.writeFileSync(path.resolve(backupPath), JSON.stringify(snapshot, null, 2), 'utf-8');
        }
        return snapshot;
    };

    if (typeof vectorExportResult?.then === 'function' || typeof kbExportResult?.then === 'function') {
        return Promise.all([vectorExportResult, kbExportResult]).then(([vecArr, kbArr]) => finalizeSnapshot(vecArr, kbArr));
    }
    return finalizeSnapshot(vectorExportResult, kbExportResult);
}

/** @summary Restores ADR graph nodes, edges, vectors, and KB entries from a pre-migration backup snapshot. */
export function restoreAdrMigrationBackup({db, vectorStore = null, kbStore = null, backup = null, backupPath = null} = {}) {
    if (!db) fail('ADR_MIGRATION_DB_REQUIRED', 'restoreAdrMigrationBackup requires a SQLite db handle.');
    const resolvedBackup = backup || (typeof backupPath === 'string' && backupPath.trim() && fs.existsSync(path.resolve(backupPath)) ? JSON.parse(fs.readFileSync(path.resolve(backupPath), 'utf-8')) : null);
    if (!resolvedBackup || !Array.isArray(resolvedBackup.nodes) || !Array.isArray(resolvedBackup.edges)) fail('ADR_MIGRATION_BACKUP_INVALID', 'restoreAdrMigrationBackup requires a valid backup snapshot object or readable backupPath.');

    ensureMigrationTables(db);
    const
        manifestIds   = resolvedBackup.manifestIds || REVIEWED_41_ADR_MIGRATION_MANIFEST.map(e => ({legacyId: e.legacyId, canonicalKey: e.canonicalKey})),
        legacyIds     = new Set(manifestIds.map(e => e.legacyId)),
        canonicalKeys = new Set(manifestIds.map(e => e.canonicalKey));

    db.transaction(() => {
        const deleteEdgeStmt = db.prepare('DELETE FROM Edges WHERE id = ?');
        for (const edge of db.prepare('SELECT id, source, target FROM Edges').all()) {
            if (legacyIds.has(edge.source) || legacyIds.has(edge.target) || canonicalKeys.has(edge.source) || canonicalKeys.has(edge.target)) deleteEdgeStmt.run(edge.id);
        }
        const deleteNodeStmt = db.prepare('DELETE FROM Nodes WHERE id = ?');
        for (const id of [...legacyIds, ...canonicalKeys]) deleteNodeStmt.run(id);
        const upsertNodeStmt = db.prepare('INSERT OR REPLACE INTO Nodes (id, data) VALUES (?, ?)');
        for (const row of resolvedBackup.nodes) upsertNodeStmt.run(row.id, row.data);
        const upsertEdgeStmt = db.prepare('INSERT OR REPLACE INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)');
        for (const edge of resolvedBackup.edges) upsertEdgeStmt.run(edge.id, edge.source, edge.target, edge.type, edge.data);
        db.prepare('DELETE FROM AdrIdentityMigrationJournal').run();
    })();

    let restoredVectorsCount = 0, vectorRestoreResult = null, restoredKbCount = 0, kbRestoreResult = null;
    if (vectorStore instanceof Map) {
        for (const key of canonicalKeys) vectorStore.delete(key);
        for (const [k, v] of resolvedBackup.vectorEntries || []) { vectorStore.set(k, structuredClone(v)); restoredVectorsCount++; }
    } else if (vectorStore && typeof vectorStore.restoreSnapshot === 'function') {
        vectorRestoreResult  = vectorStore.restoreSnapshot(resolvedBackup.vectorEntries || [], {canonicalKeys: Array.from(canonicalKeys)});
        restoredVectorsCount = (resolvedBackup.vectorEntries || []).length;
    }

    if (kbStore instanceof Map) {
        for (const key of canonicalKeys) kbStore.delete(key);
        for (const [k, v] of resolvedBackup.kbEntries || []) { kbStore.set(k, structuredClone(v)); restoredKbCount++; }
    } else if (kbStore && typeof kbStore.restoreSnapshot === 'function') {
        kbRestoreResult = kbStore.restoreSnapshot(resolvedBackup.kbEntries || [], {canonicalKeys: Array.from(canonicalKeys)});
        restoredKbCount = (resolvedBackup.kbEntries || []).length;
    }

    const finalizeRestore = () => {
        resetSharedAdrCatalog();
        return {restored: true, restoredNodesCount: resolvedBackup.nodes.length, restoredEdgesCount: resolvedBackup.edges.length, restoredVectorsCount, restoredKbCount};
    };
    if (typeof vectorRestoreResult?.then === 'function' || typeof kbRestoreResult?.then === 'function') {
        return Promise.all([vectorRestoreResult, kbRestoreResult]).then(finalizeRestore);
    }
    return finalizeRestore();
}

function mergeMigratedEdgeData(existingData, incomingData, targetId, newSource, newTarget) {
    const
        existingProps = existingData?.properties || {},
        incomingProps = incomingData?.properties || {},
        mergedOrigins = Array.from(new Set([
            ...(Array.isArray(existingProps.origins) ? existingProps.origins : []), ...(existingProps.origin ? [existingProps.origin] : []),
            ...(Array.isArray(incomingProps.origins) ? incomingProps.origins : []), ...(incomingProps.origin ? [incomingProps.origin] : [])
        ])),
        mergedProvenance    = [
            ...(Array.isArray(existingProps.provenance) ? existingProps.provenance : existingProps.provenance ? [existingProps.provenance] : []),
            ...(Array.isArray(incomingProps.provenance) ? incomingProps.provenance : incomingProps.provenance ? [incomingProps.provenance] : [])
        ],
        mergedLegacyEdgeIds = Array.from(new Set([
            ...(existingProps.migratedFromEdgeIds || []), ...(existingData?.id ? [existingData.id] : []),
            ...(incomingProps.migratedFromEdgeIds || []), ...(incomingData?.id ? [incomingData.id] : [])
        ]));

    return {
        ...existingData, ...incomingData, id: targetId, source: newSource, target: newTarget,
        weight    : Math.max(Number(existingData?.weight ?? 1), Number(incomingData?.weight ?? 1)),
        properties: {
            ...existingProps, ...incomingProps,
            ...(mergedOrigins.length > 0 ? {origins: mergedOrigins} : {}),
            ...(mergedProvenance.length > 0 ? {provenance: mergedProvenance} : {}),
            migratedFromEdgeIds: mergedLegacyEdgeIds
        }
    };
}

/** @summary Executes or dry-runs the 41-record legacy ADR identity migration with restartable cross-store phase journaling. */
export async function migrateLegacyAdrIdentities({
    db = null, sqlitePath = null, vectorStore = null, kbStore = null,
    manifest = REVIEWED_41_ADR_MIGRATION_MANIFEST, cutRepositories = MIGRATION_CUT_REPOSITORIES,
    apply = false, dryRun = !apply, backupPath = null, migrationId = 'adr-legacy-41-cut-v1',
    failAfterPhase = null, sourceProbe = undefined, readerContext = undefined, requireCompleteInventory = true
} = {}) {
    let ownedDb = null;
    if (!db && typeof sqlitePath === 'string' && sqlitePath.trim()) {
        const Database = createRequire(import.meta.url)('better-sqlite3');
        ownedDb = db = new Database(sqlitePath);
    }

    try {
        const preconditions         = verifyMigrationPreconditions({manifest, cutRepositories, db, sourceProbe, readerContext, requireCompleteInventory});
        const plannedNodeMigrations = manifest.map(entry => {
            const isSummaryVector = String(entry.observedState.observedSemanticVectorId || '').startsWith('summary_');
            const hasNonAdrOwners = entry.observedState.reusedVectorOwners.some(o => o.isAdr === false);
            return {
                adrNumber                  : entry.adrNumber, legacyId: entry.legacyId, canonicalKey: entry.canonicalKey,
                originCanonicalKey         : entry.originCanonicalKey, previousLabel: entry.observedState.nodeLabel, newLabel: 'ADR',
                anomalyShape               : entry.observedState.anomalyShape, observedSemanticVectorId: entry.observedState.observedSemanticVectorId,
                newSemanticVectorId        : entry.canonicalKey,
                vectorAction               : isSummaryVector ? (hasNonAdrOwners ? 'detach-shared-summary-vector-keep-non-adr-owners' : 'detach-summary-vector-reembed-adr') : 'rekey-adr-vector-to-canonical-key',
                sharedVectorPreservedOwners: entry.observedState.reusedVectorOwners.filter(o => o.isAdr === false),
                custodyTransition          : entry.custodyTransition,
                historicalReferences       : entry.historicalReferences.map(ref => normalizeHistoricalOriginReference(ref, entry.assignmentEvidence.namespace, entry.historicalReferences))
            };
        });

        if (dryRun || !apply) {
            const basePlan = {
                applied: false, noOpRerun: false, migrationId, manifestVersion: MIGRATION_MANIFEST_VERSION,
                preconditions, plannedNodeMigrations, plannedCount: plannedNodeMigrations.length,
                custodyMovesCount: plannedNodeMigrations.filter(p => Boolean(p.custodyTransition)).length,
                anomaliesCount   : plannedNodeMigrations.filter(p => p.anomalyShape !== 'NONE').length
            };
            if (typeof backupPath === 'string' && backupPath.trim()) {
                if (!db) fail('ADR_MIGRATION_DB_REQUIRED', 'Creating a migration backup (--backup) requires a SQLite db or sqlitePath.');
                const snap = await createAdrMigrationBackup({db, vectorStore, kbStore, backupPath, manifest});
                return {...basePlan, mode: 'backup', backupPath: path.resolve(backupPath), backupNodeCount: snap.nodes.length, backupEdgeCount: snap.edges.length, backupVectorCount: snap.vectorEntries.length, backupKbCount: snap.kbEntries.length};
            }
            return {...basePlan, mode: 'dry-run'};
        }

        if (!db) fail('ADR_MIGRATION_DB_REQUIRED', 'Applying the migration (--apply) requires a writable SQLite db or sqlitePath.');
        if (!isValidMigrationStore(vectorStore)) fail('ADR_MIGRATION_VECTOR_STORE_REQUIRED', 'Applying the migration (--apply) requires a valid vectorStore.');
        if (!isValidMigrationStore(kbStore)) fail('ADR_MIGRATION_KB_STORE_REQUIRED', 'Applying the migration (--apply) requires a valid kbStore.');

        ensureMigrationTables(db);
        const existingJournal = db.prepare('SELECT * FROM AdrIdentityMigrationJournal WHERE migration_id = ?').get(migrationId);
        const completedPhases = existingJournal ? JSON.parse(existingJournal.completed_phases || '[]') : [];
        const savedState      = existingJournal ? JSON.parse(existingJournal.state_json || '{}') : {};

        if (existingJournal?.phase === 'completed' || completedPhases.includes('completed')) {
            hydrateAdrAdmissionRecords(manifest.map(buildAdrMigrationRecordFromManifestEntry), {replaceExisting: true});
            return {mode: 'apply', applied: false, noOpRerun: true, resumed: false, migrationId, manifestVersion: MIGRATION_MANIFEST_VERSION, phase: 'completed', completedPhases: [...MIGRATION_PHASES], preconditions, ...savedState};
        }

        const resumed            = completedPhases.length > 0;
        const recordJournalPhase = (phase, extraState = {}) => {
            if (!completedPhases.includes(phase)) completedPhases.push(phase);
            Object.assign(savedState, extraState);
            db.prepare('INSERT OR REPLACE INTO AdrIdentityMigrationJournal (migration_id, manifest_version, phase, completed_phases, backup_path, state_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
                migrationId, MIGRATION_MANIFEST_VERSION, phase, JSON.stringify(completedPhases),
                backupPath || existingJournal?.backup_path || null, JSON.stringify(savedState), new Date().toISOString()
            );
            if (failAfterPhase === phase) fail('ADR_MIGRATION_INTERRUPTED_FOR_TEST', `Simulated interruption immediately after phase '${phase}'.`);
        };

        if (!completedPhases.includes('preconditions_verified')) recordJournalPhase('preconditions_verified', {preconditionsVerifiedAt: preconditions.verifiedAt});
        if (!completedPhases.includes('backup_created')) {
            const snap = await createAdrMigrationBackup({db, vectorStore, kbStore, backupPath, manifest});
            recordJournalPhase('backup_created', {backupNodeCount: snap.nodes.length, backupEdgeCount: snap.edges.length});
        }

        const
            admissionRecords     = manifest.map(buildAdrMigrationRecordFromManifestEntry),
            legacyToCanonical    = new Map(manifest.map(e => [e.legacyId, e.canonicalKey])),
            manifestByLegacy     = new Map(manifest.map(e => [e.legacyId, e])),
            manifestByCanonical  = new Map(manifest.map(e => [e.canonicalKey, e])),
            admissionByCanonical = new Map(admissionRecords.map(r => [r.canonicalKey, r]));

        if (!completedPhases.includes('graph_sqlite_applied')) {
            let migratedNodesCount = 0, relabeledNodesCount = 0, rewrittenEdgesCount = 0, mergedEdgesCount = 0;

            db.transaction(() => {
                const
                    getNodeStmt    = db.prepare('SELECT id, data FROM Nodes WHERE id = ?'),
                    upsertNodeStmt = db.prepare('INSERT OR REPLACE INTO Nodes (id, data) VALUES (?, ?)'),
                    deleteNodeStmt = db.prepare('DELETE FROM Nodes WHERE id = ?');

                for (let idx = 0; idx < manifest.length; idx++) {
                    const entry           = manifest[idx], admissionRecord = admissionRecords[idx], legacyRow = getNodeStmt.get(entry.legacyId), canonicalRow = getNodeStmt.get(entry.canonicalKey);
                    let   existingNodeObj = {};
                    try { existingNodeObj = JSON.parse((legacyRow || canonicalRow)?.data || '{}'); } catch {}

                    const
                        existingProps   = existingNodeObj.properties || {},
                        previousLabel   = existingNodeObj.label || entry.observedState.nodeLabel || 'ADR',
                        previousVecId   = existingNodeObj.semanticVectorId || entry.observedState.observedSemanticVectorId || entry.legacyId,
                        isSummaryVec    = String(previousVecId).startsWith('summary_'),
                        nonAdrVecOwners = (entry.observedState.reusedVectorOwners || []).filter(o => o.isAdr === false),
                        declaredRefs    = admissionRecord.historicalReferences || [],
                        normalizedRefs  = Array.from(new Set([
                            ...declaredRefs,
                            ...((existingProps.historicalReferences || []).map(r => normalizeHistoricalOriginReference(r, entry.assignmentEvidence.namespace, declaredRefs)))
                        ])).filter(Boolean);

                    if (previousLabel !== 'ADR') relabeledNodesCount++;

                    const newNodePayload = {
                        ...existingNodeObj, id: entry.canonicalKey, label: 'ADR', type: 'ADR', name: entry.title, semanticVectorId: entry.canonicalKey,
                        properties: {
                            ...existingProps, adrNumber: entry.adrNumber, canonicalKey: entry.canonicalKey,
                            originCanonicalKey  : entry.originCanonicalKey || null, legacyId: entry.legacyId,
                            title               : entry.title, status: entry.status || 'Accepted', currentSlug: entry.currentSlug,
                            filePath            : entry.sourcePath, sourcePath: entry.sourcePath, contentHash: entry.sourceTuple.contentHash,
                            visibility          : entry.visibility || 'public', aliases: admissionRecord.aliases, historicalAliases: admissionRecord.historicalAliases,
                            historicalReferences: normalizedRefs, adrAdmissionRecord: admissionRecord,
                            adrAuthority        : {
                                admitted        : true, writer: 'migrateLegacyAdrIdentities', canonicalKey: entry.canonicalKey,
                                adrNumber       : entry.adrNumber, migratedFromLegacyId: entry.legacyId, previousLabel,
                                anomalyShape    : entry.observedState.anomalyShape, manifestVersion: MIGRATION_MANIFEST_VERSION,
                                vectorProvenance: {previousSemanticVectorId: previousVecId, detachedSummaryVector: isSummaryVec, preservedSharedVectorOwners: nonAdrVecOwners.map(o => o.nodeId)}
                            }
                        }
                    };

                    upsertNodeStmt.run(entry.canonicalKey, JSON.stringify(newNodePayload));
                    if (legacyRow) deleteNodeStmt.run(entry.legacyId);
                    migratedNodesCount++;
                }

                const
                    allEdges       = db.prepare('SELECT id, source, target, type, data FROM Edges ORDER BY id ASC').all(),
                    deleteEdgeStmt = db.prepare('DELETE FROM Edges WHERE id = ?'),
                    upsertEdgeStmt = db.prepare('INSERT OR REPLACE INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)'),
                    edgeByTuple    = new Map();

                for (const row of allEdges) {
                    if (legacyToCanonical.has(row.source) || legacyToCanonical.has(row.target)) continue;
                    let parsed = {};
                    try { parsed = JSON.parse(row.data); } catch {}
                    edgeByTuple.set(`${row.source}|${row.target}|${row.type}`, {id: row.id, source: row.source, target: row.target, type: row.type, data: parsed});
                }

                for (const row of allEdges) {
                    if (!legacyToCanonical.has(row.source) && !legacyToCanonical.has(row.target)) continue;
                    const newSource = legacyToCanonical.get(row.source) || row.source, newTarget = legacyToCanonical.get(row.target) || row.target, tupleKey = `${newSource}|${newTarget}|${row.type}`;
                    let   parsed    = {};
                    try { parsed = JSON.parse(row.data); } catch {}

                    const
                        normalizedProps   = {...(parsed.properties || {})},
                        incidentEntry     = manifestByLegacy.get(row.source) || manifestByLegacy.get(row.target) || manifestByCanonical.get(newSource) || manifestByCanonical.get(newTarget) || null,
                        incidentNamespace = incidentEntry?.assignmentEvidence?.namespace || null,
                        incidentDeclared  = incidentEntry ? (admissionByCanonical.get(incidentEntry.canonicalKey)?.historicalReferences || []) : [];

                    if (typeof normalizedProps.origin === 'string') {
                        if (legacyToCanonical.has(normalizedProps.origin)) normalizedProps.origin = legacyToCanonical.get(normalizedProps.origin);
                        else if (/^(?:ISSUE|PULL_REQUEST|DISCUSSION):/i.test(normalizedProps.origin) || /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+$/.test(normalizedProps.origin)) {
                            normalizedProps.origin = normalizeHistoricalOriginReference(normalizedProps.origin, incidentNamespace, incidentDeclared);
                        }
                    }

                    deleteEdgeStmt.run(row.id);
                    rewrittenEdgesCount++;

                    const existingSurvivor = edgeByTuple.get(tupleKey);
                    if (existingSurvivor) {
                        const mergedData = mergeMigratedEdgeData(existingSurvivor.data, {...parsed, id: row.id, properties: normalizedProps}, existingSurvivor.id, newSource, newTarget);
                        existingSurvivor.data = mergedData;
                        upsertEdgeStmt.run(existingSurvivor.id, newSource, newTarget, row.type, JSON.stringify(mergedData));
                        mergedEdgesCount++;
                    } else {
                        const newEdgeId   = `${newSource}__${row.type}__${newTarget}`;
                        const newEdgeData = {...parsed, id: newEdgeId, source: newSource, target: newTarget, type: row.type, properties: {...normalizedProps, migratedFromEdgeIds: Array.from(new Set([...(normalizedProps.migratedFromEdgeIds || []), row.id]))}};
                        edgeByTuple.set(tupleKey, {id: newEdgeId, source: newSource, target: newTarget, type: row.type, data: newEdgeData});
                        upsertEdgeStmt.run(newEdgeId, newSource, newTarget, row.type, JSON.stringify(newEdgeData));
                    }
                }
            })();

            for (const repo of Object.values(cutRepositories)) registerSharedForgeRepository(repo);
            hydrateAdrAdmissionRecords(admissionRecords, {replaceExisting: true});
            recordJournalPhase('graph_sqlite_applied', {migratedNodesCount, relabeledNodesCount, rewrittenEdgesCount, mergedEdgesCount});
        } else {
            for (const repo of Object.values(cutRepositories)) registerSharedForgeRepository(repo);
            hydrateAdrAdmissionRecords(admissionRecords, {replaceExisting: true});
        }

        if (!completedPhases.includes('vector_store_applied')) {
            let   upsertedVectorsCount = 0, removedLegacyAdrVectorsCount = 0, preservedSummaryVectorsCount = 0;
            const nonAdrSummaryIds     = new Set();
            for (const entry of manifest) {
                const vecId = entry.observedState?.observedSemanticVectorId;
                if (typeof vecId === 'string' && vecId.startsWith('summary_') && (entry.observedState.reusedVectorOwners || []).some(o => o.isAdr === false)) nonAdrSummaryIds.add(vecId);
            }

            if (vectorStore instanceof Map) {
                for (const entry of manifest) {
                    vectorStore.set(entry.canonicalKey, {
                        ...(vectorStore.get(entry.legacyId) || {}), id: entry.canonicalKey, canonicalKey: entry.canonicalKey,
                        legacyId    : entry.legacyId, label: 'ADR', adrNumber: entry.adrNumber,
                        repositoryId: entry.sourceTuple.repositoryId, namespace: entry.sourceTuple.namespace, contentHash: entry.sourceTuple.contentHash
                    });
                    upsertedVectorsCount++;
                    if (vectorStore.has(entry.legacyId)) { vectorStore.delete(entry.legacyId); removedLegacyAdrVectorsCount++; }
                }
                for (const summaryVecId of nonAdrSummaryIds) if (vectorStore.has(summaryVecId)) preservedSummaryVectorsCount++;
            } else if (vectorStore && typeof vectorStore.applyAdrMigration === 'function') {
                const res = await vectorStore.applyAdrMigration({manifest, nonAdrSummaryIds: Array.from(nonAdrSummaryIds)});
                upsertedVectorsCount         = res?.upsertedVectorsCount ?? manifest.length;
                removedLegacyAdrVectorsCount = res?.removedLegacyAdrVectorsCount ?? 0;
                preservedSummaryVectorsCount = res?.preservedSummaryVectorsCount ?? nonAdrSummaryIds.size;
            }
            recordJournalPhase('vector_store_applied', {upsertedVectorsCount, removedLegacyAdrVectorsCount, preservedSummaryVectorsCount});
        }

        if (!completedPhases.includes('kb_projection_applied')) {
            let migratedKbEntriesCount = 0;
            if (kbStore instanceof Map) {
                for (let idx = 0; idx < manifest.length; idx++) {
                    const entry = manifest[idx], admissionRecord = admissionRecords[idx];
                    kbStore.set(entry.canonicalKey, {
                        ...(kbStore.get(entry.legacyId) || {}), id: entry.canonicalKey, canonicalKey: entry.canonicalKey,
                        legacyId  : entry.legacyId, adrNumber: entry.adrNumber, title: entry.title, currentSlug: entry.currentSlug,
                        sourcePath: entry.sourcePath, repositoryId: entry.sourceTuple.repositoryId, namespace: entry.sourceTuple.namespace,
                        visibility: entry.visibility || 'public', aliases: admissionRecord.aliases, historicalAliases: admissionRecord.historicalAliases
                    });
                    if (kbStore.has(entry.legacyId)) kbStore.delete(entry.legacyId);
                    migratedKbEntriesCount++;
                }
            } else if (kbStore && typeof kbStore.applyAdrMigration === 'function') {
                const res = await kbStore.applyAdrMigration({manifest, admissionRecords});
                migratedKbEntriesCount = res?.migratedKbEntriesCount ?? manifest.length;
            }

            AdrSource.hydrateAdmissionEvidence(admissionRecords);
            for (const rec of admissionRecords) {
                AdrSource.kbIndexedDecisions.set(rec.canonicalKey, {
                    id    : rec.canonicalKey, canonicalKey: rec.canonicalKey, adrNumber: rec.adrNumber,
                    source: rec.sourcePath, repositoryId: rec.sourceTuple.repositoryId, namespace: rec.sourceTuple.namespace
                });
            }
            recordJournalPhase('kb_projection_applied', {migratedKbEntriesCount});
        }

        if (!completedPhases.includes('reader_verified')) {
            for (const entry of manifest) {
                const canonicalResolved = AdrSource.resolveAdrReference(entry.canonicalKey, {retainedAdmissionRecords: admissionRecords, authorizedNamespaces: [entry.sourceTuple.namespace]});
                if (!canonicalResolved.resolved || canonicalResolved.canonicalKey !== entry.canonicalKey) fail('ADR_MIGRATION_READER_VERIFICATION_FAILED', `Reader failed to resolve migrated canonicalKey '${entry.canonicalKey}'.`);
                const shortAliasResolved = AdrSource.resolveAdrReference(entry.legacyId, {retainedAdmissionRecords: admissionRecords, namespace: entry.sourceTuple.namespace, repositoryId: entry.sourceTuple.repositoryId, authorizedNamespaces: [entry.sourceTuple.namespace]});
                if (!shortAliasResolved.resolved || shortAliasResolved.canonicalKey !== entry.canonicalKey) fail('ADR_MIGRATION_READER_VERIFICATION_FAILED', `Reader failed to resolve legacy number '${entry.legacyId}' in '${entry.sourceTuple.namespace}'.`);
                if (entry.custodyTransition) {
                    const originAliasResolved = AdrSource.resolveAdrReference(entry.legacyId, {retainedAdmissionRecords: admissionRecords, namespace: entry.custodyTransition.fromNamespace, repositoryId: entry.custodyTransition.fromRepositoryId, authorizedNamespaces: [entry.sourceTuple.namespace, entry.custodyTransition.fromNamespace]});
                    if (!originAliasResolved.resolved || originAliasResolved.canonicalKey !== entry.canonicalKey) fail('ADR_MIGRATION_READER_VERIFICATION_FAILED', `Reader failed to resolve moved FM ADR '${entry.legacyId}' from origin namespace '${entry.custodyTransition.fromNamespace}'.`);
                }
            }
            recordJournalPhase('reader_verified', {readerVerifiedCount: manifest.length});
        }

        recordJournalPhase('completed', {completedAt: new Date().toISOString()});
        return {mode: 'apply', applied: true, noOpRerun: false, resumed, migrationId, manifestVersion: MIGRATION_MANIFEST_VERSION, phase: 'completed', completedPhases: [...completedPhases], preconditions, ...savedState};
    } finally {
        if (ownedDb) { try { ownedDb.close(); } catch {} }
    }
}

/** @summary Reconciles ADR rebuilds after slug rename, custody move, combined move+rename, source loss, and admission-record loss. */
export async function reconcileRebuildAndCustodyControls({retainedAdmissionRecords = [], repositories = [], custodyTransitions = [], sourceLineageEvidence = [], expectedDecisions = []} = {}) {
    const refusedCandidates = [], verifiedRecords = new Map();
    for (const rec of retainedAdmissionRecords || []) {
        const record = rec?.adrAdmissionRecord || rec;
        if (record?.canonicalKey) verifiedRecords.set(record.canonicalKey, structuredClone(record));
    }

    for (const repoSpec of repositories || []) {
        const
            forge        = repoSpec.forge || repoSpec.repository?.forge || 'github.com',
            repositoryId = repoSpec.repositoryId || repoSpec.repository?.repositoryId || null,
            namespace    = repoSpec.namespace || repoSpec.repository?.namespace || null,
            files        = repoSpec.files || {};

        for (const [sourcePath, rawContent] of Object.entries(files)) {
            const parsedName = parseAdrFilename(path.posix.basename(sourcePath));
            if (!parsedName || parseAdrRedirect(rawContent).isRedirect) continue;

            const
                {adrNumber, slug} = parsedName,
                directKey         = repositoryId && namespace ? buildCanonicalAdrKey({forge, repositoryId, namespace, number: adrNumber}) : null,
                directRecord      = directKey ? verifiedRecords.get(directKey) : null,
                matchingByNumber  = Array.from(verifiedRecords.values()).filter(r => r.adrNumber === adrNumber && r.sourceTuple?.repositoryId !== repositoryId && r.assignmentEvidence?.repositoryId !== repositoryId);

            if (!directRecord && matchingByNumber.length > 0) {
                const originRecord = matchingByNumber[0];
                const verifiedMove = (custodyTransitions || []).find(t => (t.canonicalKey === originRecord.canonicalKey || t.adrNumber === adrNumber) && String(t.toRepositoryId) === String(repositoryId) && Boolean(t.proof) && t.verified !== false);
                if (!verifiedMove) refusedCandidates.push({sourcePath, adrNumber, slug, repositoryId, namespace, reasonCode: 'ADR_CUSTODY_TRANSITION_UNVERIFIED'});
                continue;
            }
            if (!directRecord) refusedCandidates.push({sourcePath, adrNumber, slug, repositoryId, namespace, reasonCode: 'ADR_ADMISSION_EVIDENCE_MISSING'});
        }
    }

    const filteredRepositories = (repositories || []).map(repoSpec => {
        const repositoryId = repoSpec.repositoryId || repoSpec.repository?.repositoryId || null, files = {...(repoSpec.files || {})};
        for (const refused of refusedCandidates) if (String(refused.repositoryId) === String(repositoryId) && refused.sourcePath in files) delete files[refused.sourcePath];
        return {...repoSpec, files};
    });

    const updatedRetainedRecords = Array.from(verifiedRecords.values());
    AdrSource.resetCatalog();
    const reconciled = await AdrSource.reconcileDecisionStates({
        repositories            : filteredRepositories, custodyTransitions, sourceLineageEvidence,
        expectedDecisions       : expectedDecisions.length > 0 ? expectedDecisions : updatedRetainedRecords.map(r => r.canonicalKey),
        retainedAdmissionRecords: updatedRetainedRecords
    });

    return {...reconciled, refusedCandidates: [...refusedCandidates, ...(reconciled.refusedSourcePaths || [])], retainedRecords: updatedRetainedRecords};
}

/** @summary Parses CLI arguments for `migrateLegacyAdrIdentities.mjs`. */
export function parseArgs(argv = process.argv.slice(2)) {
    const options = {apply: false, dryRun: true, sqlitePath: null, backupPath: null, restorePath: null, runbook: false, help: false};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--apply') { options.apply = true; options.dryRun = false; }
        else if (arg === '--dry-run') { options.apply = false; options.dryRun = true; }
        else if (arg === '--db' && argv[i + 1]) options.sqlitePath = argv[++i];
        else if (arg === '--backup' && argv[i + 1]) options.backupPath = argv[++i];
        else if (arg === '--restore' && argv[i + 1]) options.restorePath = argv[++i];
        else if (arg === '--runbook') options.runbook = true;
        else if (arg === '--help' || arg === '-h') options.help = true;
    }
    return options;
}

/** @summary Returns human-readable CLI usage instructions. */
export function getUsageText() {
    return [
        'Usage: node ai/scripts/migrations/migrateLegacyAdrIdentities.mjs [options]', '',
        'Options:',
        '  --dry-run              Validate manifest & preconditions and emit reconciliation plan (default)',
        '  --apply                Execute restartable cross-store migration against --db',
        '  --db <sqlite-path>     Path to Memory Core SQLite database',
        '  --backup <file.json>   Write pre-apply backup snapshot to <file.json>',
        '  --restore <file.json>  Restore ADR graph/vector/KB state from <file.json>',
        '  --runbook              Print the operator migration & recovery runbook JSON',
        '  --help, -h             Print this usage guide'
    ].join('\n');
}

/** @summary Executes the CLI workflow with default production store adapters, `sourceProbe`, and `readerContext`. */
export async function runCli(argv = process.argv.slice(2), deps = {}) {
    const opts = parseArgs(argv);
    if (opts.help) { if (!deps.silent) console.log(getUsageText()); return; }
    if (opts.runbook) { if (!deps.silent) console.log(JSON.stringify(ADR_MIGRATION_RUNBOOK, null, 2)); return ADR_MIGRATION_RUNBOOK; }

    const composed = composeDefaultMigrationStores({
        chromaClient        : deps.chromaClient || null, vectorStore: deps.vectorStore || null, kbStore: deps.kbStore || null,
        vectorCollectionName: deps.vectorCollectionName || null, kbCollectionName: deps.kbCollectionName || null,
        manifest            : deps.manifest || REVIEWED_41_ADR_MIGRATION_MANIFEST, cutRepositories: deps.cutRepositories || MIGRATION_CUT_REPOSITORIES,
        repoRoots           : deps.repoRoots || null, sourceProbe: deps.sourceProbe, readerContext: deps.readerContext
    });

    if (opts.restorePath) {
        const Database = createRequire(import.meta.url)('better-sqlite3');
        const db       = deps.db || new Database(opts.sqlitePath);
        try {
            const res = await restoreAdrMigrationBackup({db, vectorStore: composed.vectorStore, kbStore: composed.kbStore, backupPath: opts.restorePath});
            if (!deps.silent) console.log(JSON.stringify(res, null, 2));
            return res;
        } finally { if (!deps.db) db.close(); }
    }

    const result = await migrateLegacyAdrIdentities({
        db         : deps.db || null, sqlitePath: opts.sqlitePath, vectorStore: composed.vectorStore, kbStore: composed.kbStore,
        sourceProbe: composed.sourceProbe, readerContext: composed.readerContext,
        manifest   : deps.manifest || REVIEWED_41_ADR_MIGRATION_MANIFEST, cutRepositories: deps.cutRepositories || MIGRATION_CUT_REPOSITORIES,
        apply      : opts.apply, dryRun: opts.dryRun, backupPath: opts.backupPath
    });
    if (!deps.silent) console.log(JSON.stringify(result, null, 2));
    return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    runCli().catch(err => { console.error(err); process.exitCode = 1; });
}

export {
    ADR_MIGRATION_RUNBOOK, MIGRATION_CUT_REPOSITORIES, MIGRATION_MANIFEST_VERSION, MOVED_FM_ADR_NUMBERS,
    OBSERVED_11_CENSUS_ANOMALY_NUMBERS, OBSERVED_LIVE_ANOMALY_NUMBERS, REVIEWED_41_ADR_MIGRATION_MANIFEST
};

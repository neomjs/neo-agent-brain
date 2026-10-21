import crypto             from 'crypto';
import fs                 from 'fs';
import path               from 'path';
import {createRequire}    from 'node:module';
import {fileURLToPath}    from 'node:url';
import Neo                from 'neo.mjs/src/Neo.mjs';
import * as core          from 'neo.mjs/src/core/_export.mjs';
import InstanceManager    from 'neo.mjs/src/manager/Instance.mjs';
import AdrSource          from '../../services/knowledge-base/source/AdrSource.mjs';
import {qualifyOriginId}  from '../../services/graph/corpusProjectionContract.mjs';
import {parseAdrRedirect} from '../../services/shared/adrRedirect.mjs';
import {
    ADR_NUMBER_REGEX,
    buildCanonicalAdrKey,
    createCodedError,
    parseCanonicalAdrKey,
    validateAdrIdentityFields
} from '../../services/shared/adrIdentityCodec.mjs';
import {
    SHARED_ADR_CATALOG_STATE,
    bindSharedAdrRecordAliases,
    ensureSharedReservationBucket,
    hydrateAdrAdmissionRecords,
    isAdrReaderAuthorized,
    registerSharedForgeRepository,
    rehydrateAdrCatalogFromEvidence,
    resetSharedAdrCatalog,
    resolveSharedAdrReference
} from '../../services/ingestion/adrAdmissionCatalog.mjs';
import {
    computeAdrPayloadHash,
    extractAdrTitleAndStatus,
    parseAdrFilename,
    parseAdrOpeningAliases
} from '../../services/shared/adrDocumentParser.mjs';
import {
    ADR_MIGRATION_RUNBOOK,
    MIGRATION_CUT_REPOSITORIES,
    MIGRATION_MANIFEST_VERSION,
    MOVED_FM_ADR_NUMBERS,
    OBSERVED_11_CENSUS_ANOMALY_NUMBERS,
    OBSERVED_LIVE_ANOMALY_NUMBERS,
    REVIEWED_41_ADR_MIGRATION_MANIFEST
} from './adrMigrationManifest.mjs';

/**
 * @module ai/scripts/migrations/migrateLegacyAdrIdentities
 * @summary Restartable cross-store migration and reconciliation tool for legacy four-digit ADR
 * identities across Native Edge Graph SQLite storage, vector projections, and Knowledge Base ADR state.
 * Dry-run by default; requires `--apply` (`apply: true`) to mutate stores.
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §§2.6–2.10
 */

export const MIGRATION_PHASES = Object.freeze([
    'preconditions_verified',
    'backup_created',
    'graph_sqlite_applied',
    'vector_store_applied',
    'kb_projection_applied',
    'reader_verified',
    'completed'
]);

const LEGACY_ID_REGEX = /^adr-(\d{4})$/;

/**
 * @summary Normalizes an issue or pull-request origin reference into its canonical repository-qualified form.
 * @param {String} rawRef
 * @param {String} [defaultRepo='neomjs/neo']
 * @returns {String}
 */
export function normalizeHistoricalOriginReference(rawRef, defaultRepo = 'neomjs/neo') {
    if (typeof rawRef !== 'string' || !rawRef.trim()) return '';
    const trimmed = rawRef.trim();

    if (/^(?:ISSUE|PULL_REQUEST|DISCUSSION):[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/i.test(trimmed)) {
        const [prefix, rest] = trimmed.split(':');
        return `${prefix.toUpperCase()}:${rest}`;
    }

    const bareTypedMatch = trimmed.match(/^(ISSUE|PULL_REQUEST|DISCUSSION):#?(\d+)$/i);
    if (bareTypedMatch) {
        return `${bareTypedMatch[1].toUpperCase()}:${defaultRepo}#${bareTypedMatch[2]}`;
    }

    const issueMatch = trimmed.match(/^(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)$/);
    if (issueMatch) {
        return `ISSUE:${issueMatch[1] || defaultRepo}#${issueMatch[2]}`;
    }

    return trimmed;
}

/**
 * @summary Converts a reviewed manifest entry into an `adrAdmissionRecord` payload suitable for
 * `Nodes.properties.adrAdmissionRecord` and `hydrateAdrAdmissionRecords`.
 * @param {Object} entry
 * @returns {Object}
 */
export function buildAdrMigrationRecordFromManifestEntry(entry) {
    const
        aliasBindings = (entry.aliasBindings || []).map(b => ({...b})),
        reservations  = (entry.reservations || []).map(r => ({
            kind        : r.kind || 'legacy-number',
            value       : r.value || r.adrNumber || entry.adrNumber,
            forge       : r.forge,
            repositoryId: r.repositoryId,
            namespace   : r.namespace,
            reason      : r.reason || 'assigned-custody',
            targetKey   : entry.canonicalKey
        })),
        historicalReferences = (entry.historicalReferences || []).map(ref =>
            normalizeHistoricalOriginReference(ref, entry.assignmentEvidence?.namespace || 'neomjs/neo')
        );

    return {
        canonicalKey       : entry.canonicalKey,
        originCanonicalKey : entry.originCanonicalKey || null,
        adrNumber          : entry.adrNumber,
        legacyId           : entry.legacyId,
        title              : entry.title,
        status             : entry.status || 'Accepted',
        currentSlug        : entry.currentSlug,
        fileName           : entry.fileName,
        sourcePath         : entry.sourcePath,
        assignmentEvidence : {...entry.assignmentEvidence},
        sourceTuple        : {...entry.sourceTuple},
        documentAvailable  : true,
        kbAvailable        : true,
        stale              : false,
        visibility         : entry.visibility || 'public',
        tenantId           : entry.tenantId || null,
        aliases            : [...(entry.aliases || [entry.currentSlug])],
        historicalAliases  : [...(entry.historicalAliases || [entry.legacyId])],
        aliasBindings,
        reservations,
        historicalReferences,
        semanticDisposition: entry.semanticDisposition || 'retain',
        provenance         : {
            migratedFromLegacyId    : entry.legacyId,
            migrationManifestVersion: MIGRATION_MANIFEST_VERSION,
            custodyTransitions      : entry.custodyTransition ? [{...entry.custodyTransition}] : [],
            repositoryRenames       : [],
            sourceLineage           : [
                {
                    forge       : entry.sourceTuple.forge,
                    repositoryId: entry.sourceTuple.repositoryId,
                    namespace   : entry.sourceTuple.namespace,
                    path        : entry.sourceTuple.path,
                    revision    : entry.sourceTuple.revision,
                    contentHash : entry.sourceTuple.contentHash
                }
            ]
        }
    };
}

/**
 * @summary Validates the migration manifest, source/data preconditions, shared summary-vector owner
 * inventory, and reader capabilities before any migration write is permitted.
 * @param {Object} [options={}]
 * @returns {Object}
 */
export function verifyMigrationPreconditions({
    manifest                 = REVIEWED_41_ADR_MIGRATION_MANIFEST,
    cutRepositories          = MIGRATION_CUT_REPOSITORIES,
    db                       = null,
    sourceProbe              = null,
    readerContext            = null,
    requireCompleteInventory = true
} = {}) {
    if (!Array.isArray(manifest) || manifest.length === 0) {
        throw createCodedError(
            'ADR_MIGRATION_INCOMPLETE_INVENTORY',
            'Migration manifest must be a non-empty array of reviewed ADR inventory records.'
        );
    }

    if (requireCompleteInventory && manifest.length !== 41) {
        throw createCodedError(
            'ADR_MIGRATION_INCOMPLETE_INVENTORY',
            `Expected 41 reviewed legacy ADR records (0001..0041), received ${manifest.length}.`
        );
    }

    const
        seenLegacyIds       = new Set(),
        seenCanonicalKeys   = new Set(),
        seenRepoAllocations = new Set(),
        seenNumbers         = new Set();

    let
        anomalyCount            = 0,
        sharedVectorRecordCount = 0,
        custodyMoveCount        = 0;

    for (const entry of manifest) {
        if (!entry || typeof entry !== 'object') {
            throw createCodedError('ADR_MIGRATION_INCOMPLETE_INVENTORY', 'Manifest contains a null or non-object record.');
        }

        if (!ADR_NUMBER_REGEX.test(String(entry.adrNumber || '')) || !LEGACY_ID_REGEX.test(String(entry.legacyId || ''))) {
            throw createCodedError(
                'ADR_MIGRATION_INCONSISTENT_IDENTITY_PROOF',
                `Invalid legacyId '${entry.legacyId}' or adrNumber '${entry.adrNumber}'.`
            );
        }

        if (entry.legacyId !== `adr-${entry.adrNumber}`) {
            throw createCodedError(
                'ADR_MIGRATION_INCONSISTENT_IDENTITY_PROOF',
                `Mismatched legacyId '${entry.legacyId}' and adrNumber '${entry.adrNumber}'.`
            );
        }

        let parsedKey;
        try {
            parsedKey = parseCanonicalAdrKey(entry.canonicalKey);
        } catch (err) {
            throw createCodedError(
                'ADR_MIGRATION_INCONSISTENT_IDENTITY_PROOF',
                `Invalid canonicalKey '${entry.canonicalKey}' for '${entry.legacyId}': ${err.message}`
            );
        }

        if (parsedKey.number !== entry.adrNumber) {
            throw createCodedError(
                'ADR_MIGRATION_INCONSISTENT_IDENTITY_PROOF',
                `Canonical key '${entry.canonicalKey}' number '${parsedKey.number}' does not match adrNumber '${entry.adrNumber}'.`
            );
        }

        if (!entry.assignmentEvidence?.verified ||
            !entry.assignmentEvidence?.repositoryId ||
            !entry.assignmentEvidence?.namespace ||
            !entry.sourceTuple?.repositoryId ||
            !entry.sourceTuple?.namespace ||
            !entry.sourceTuple?.path ||
            !entry.sourceTuple?.contentHash) {
            throw createCodedError(
                'ADR_MIGRATION_LOST_PROVENANCE',
                `Record '${entry.legacyId}' is missing verified assignmentEvidence or sourceTuple provenance.`
            );
        }

        if (parsedKey.repositoryId !== entry.sourceTuple.repositoryId ||
            parsedKey.namespace.toLowerCase() !== entry.sourceTuple.namespace.toLowerCase()) {
            throw createCodedError(
                'ADR_MIGRATION_INCONSISTENT_IDENTITY_PROOF',
                `Canonical key '${entry.canonicalKey}' repository does not match sourceTuple '${entry.sourceTuple.namespace}' (${entry.sourceTuple.repositoryId}).`
            );
        }

        if (seenLegacyIds.has(entry.legacyId)) {
            throw createCodedError(
                'ADR_MIGRATION_DUPLICATE_CANONICAL_CLAIM',
                `Duplicate legacyId '${entry.legacyId}' in migration manifest.`
            );
        }
        seenLegacyIds.add(entry.legacyId);

        if (seenCanonicalKeys.has(entry.canonicalKey)) {
            throw createCodedError(
                'ADR_MIGRATION_DUPLICATE_CANONICAL_CLAIM',
                `Duplicate canonicalKey '${entry.canonicalKey}' in migration manifest.`
            );
        }
        seenCanonicalKeys.add(entry.canonicalKey);

        const repoAllocKey = `${entry.sourceTuple.forge || 'github.com'}:${entry.sourceTuple.repositoryId}:${entry.adrNumber}`;
        if (seenRepoAllocations.has(repoAllocKey)) {
            throw createCodedError(
                'ADR_MIGRATION_DUPLICATE_CANONICAL_CLAIM',
                `Duplicate repository number allocation '${repoAllocKey}' in migration manifest.`
            );
        }
        seenRepoAllocations.add(repoAllocKey);

        if (entry.custodyTransition) {
            custodyMoveCount++;
            if (!entry.custodyTransition.verified ||
                !entry.custodyTransition.proof ||
                !entry.custodyTransition.fromRepositoryId ||
                !entry.custodyTransition.toRepositoryId ||
                !entry.custodyTransition.redirectPath) {
                throw createCodedError(
                    'ADR_MIGRATION_LOST_PROVENANCE',
                    `Custody move for '${entry.legacyId}' is missing verified transition proof or redirect metadata.`
                );
            }
            const originAllocKey = `${entry.custodyTransition.fromForge || 'github.com'}:${entry.custodyTransition.fromRepositoryId}:${entry.adrNumber}`;
            if (seenRepoAllocations.has(originAllocKey)) {
                throw createCodedError(
                    'ADR_MIGRATION_DUPLICATE_CANONICAL_CLAIM',
                    `Origin reservation '${originAllocKey}' collides with another allocation in migration manifest.`
                );
            }
            seenRepoAllocations.add(originAllocKey);
        }

        if (!entry.observedState || !Array.isArray(entry.observedState.reusedVectorOwners)) {
            throw createCodedError(
                'ADR_MIGRATION_INCOMPLETE_INVENTORY',
                `Record '${entry.legacyId}' is missing observedState or reusedVectorOwners inventory.`
            );
        }

        const isSummaryAnomaly = entry.observedState.nodeLabel !== 'ADR' ||
            String(entry.observedState.observedSemanticVectorId || '').startsWith('summary_');
        if (isSummaryAnomaly) {
            anomalyCount++;
        }

        if (entry.observedState.anomalyShape === 'SHARED_SUMMARY_VECTOR_WITH_NON_ADR_OWNER' || entry.adrNumber === '0038') {
            if (entry.observedState.reusedVectorOwners.length === 0) {
                throw createCodedError(
                    'ADR_MIGRATION_INCOMPLETE_VECTOR_OWNER_INVENTORY',
                    `Record '${entry.legacyId}' carries a shared summary vector but lists zero reusedVectorOwners.`
                );
            }
            const hasNonAdrOwner = entry.observedState.reusedVectorOwners.some(o => o && o.isAdr === false);
            if (!hasNonAdrOwner) {
                throw createCodedError(
                    'ADR_MIGRATION_INCOMPLETE_VECTOR_OWNER_INVENTORY',
                    `Record '${entry.legacyId}' shared summary vector inventory must include its non-ADR owner(s).`
                );
            }
            sharedVectorRecordCount++;
        }

        for (const ref of entry.historicalReferences || []) {
            const normalized = normalizeHistoricalOriginReference(ref, entry.assignmentEvidence.namespace);
            if (!/^(?:ISSUE|PULL_REQUEST|DISCUSSION):[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/.test(normalized)) {
                throw createCodedError(
                    'ADR_MIGRATION_LOST_PROVENANCE',
                    `Historical reference '${ref}' on '${entry.legacyId}' cannot be normalized to a repository-qualified origin.`
                );
            }
        }

        seenNumbers.add(entry.adrNumber);
    }

    if (requireCompleteInventory) {
        for (let i = 1; i <= 41; i++) {
            const num = String(i).padStart(4, '0');
            if (!seenNumbers.has(num)) {
                throw createCodedError(
                    'ADR_MIGRATION_INCOMPLETE_INVENTORY',
                    `Reviewed 41-record manifest is missing legacy ADR number '${num}'.`
                );
            }
        }
    }

    if (sourceProbe && typeof sourceProbe === 'object') {
        if (sourceProbe.revisions && typeof sourceProbe.revisions === 'object') {
            for (const [ns, actualRev] of Object.entries(sourceProbe.revisions)) {
                const expectedRev = cutRepositories?.[ns]?.cutRevision;
                if (expectedRev && actualRev !== expectedRev) {
                    throw createCodedError(
                        'ADR_MIGRATION_SOURCE_PRECONDITION_CHANGED',
                        `Repository '${ns}' revision '${actualRev}' drifted from manifest cutRevision '${expectedRev}'.`
                    );
                }
            }
        }

        if (sourceProbe.contentHashes && typeof sourceProbe.contentHashes === 'object') {
            for (const entry of manifest) {
                const actualHash = sourceProbe.contentHashes[entry.legacyId] ?? sourceProbe.contentHashes[entry.canonicalKey];
                if (actualHash && actualHash !== entry.sourceTuple.contentHash) {
                    throw createCodedError(
                        'ADR_MIGRATION_SOURCE_PRECONDITION_CHANGED',
                        `Source contentHash for '${entry.legacyId}' changed from '${entry.sourceTuple.contentHash}' to '${actualHash}'.`
                    );
                }
            }
        }

        if (sourceProbe.requirePrivateStageAccess === true) {
            const stageRepo   = cutRepositories?.['neomjs/neo-stage'];
            const probeRecord = {
                canonicalKey: 'adr:github.com:1413810081:neomjs%2Fneo-stage:0001',
                visibility  : stageRepo?.visibility || 'private',
                sourceTuple : {
                    forge       : stageRepo?.forge || 'github.com',
                    repositoryId: stageRepo?.repositoryId || '1413810081',
                    namespace   : stageRepo?.namespace || 'neomjs/neo-stage'
                },
                assignmentEvidence: {
                    forge       : stageRepo?.forge || 'github.com',
                    repositoryId: stageRepo?.repositoryId || '1413810081',
                    namespace   : stageRepo?.namespace || 'neomjs/neo-stage'
                }
            };
            if (!isAdrReaderAuthorized(probeRecord, readerContext || {})) {
                throw createCodedError(
                    'ADR_MIGRATION_READER_PRECONDITION_FAILED',
                    'Reader context is not authorized for private repository neomjs/neo-stage required by cut probe.'
                );
            }
        }
    }

    if (db) {
        const hasNodes = db.prepare(`
            SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'Nodes'
        `).get();

        if (hasNodes) {
            const manifestByCanonical = new Map(manifest.map(e => [e.canonicalKey, e]));
            const manifestByLegacy    = new Map(manifest.map(e => [e.legacyId, e]));

            const existingRows = db.prepare(`
                SELECT id, data FROM Nodes WHERE id LIKE 'adr-%' OR id LIKE 'adr:%'
            `).all();

            for (const row of existingRows) {
                if (row.id.startsWith('adr-')) {
                    if (requireCompleteInventory && !manifestByLegacy.has(row.id)) {
                        throw createCodedError(
                            'ADR_MIGRATION_DATA_PRECONDITION_CHANGED',
                            `Uninventoried legacy node '${row.id}' found in SQLite Nodes table.`
                        );
                    }
                } else if (row.id.startsWith('adr:')) {
                    const expectedEntry = manifestByCanonical.get(row.id);
                    if (expectedEntry) {
                        let parsedData = null;
                        try {
                            parsedData = JSON.parse(row.data);
                        } catch {}
                        const existingLegacyId = parsedData?.properties?.adrAdmissionRecord?.legacyId ||
                            parsedData?.properties?.adrAuthority?.migratedFromLegacyId;
                        if (existingLegacyId && existingLegacyId !== expectedEntry.legacyId) {
                            throw createCodedError(
                                'ADR_MIGRATION_DATA_PRECONDITION_CHANGED',
                                `Canonical node '${row.id}' in SQLite is already claimed by '${existingLegacyId}' instead of '${expectedEntry.legacyId}'.`
                            );
                        }
                    }
                }
            }
        }
    }

    return {
        ok             : true,
        manifestVersion: MIGRATION_MANIFEST_VERSION,
        recordCount    : manifest.length,
        anomalyCount,
        sharedVectorRecordCount,
        custodyMoveCount,
        verifiedAt     : new Date().toISOString()
    };
}

/**
 * @summary Ensures the SQLite schema (`Nodes`, `Edges`, and `AdrIdentityMigrationJournal`) exists.
 * @param {Object} db `better-sqlite3` database instance.
 */
export function ensureMigrationTables(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS Nodes (
            id TEXT PRIMARY KEY,
            data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS Edges (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            target TEXT NOT NULL,
            type TEXT NOT NULL,
            data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_edges_source ON Edges(source);
        CREATE INDEX IF NOT EXISTS idx_edges_target ON Edges(target);
        CREATE TABLE IF NOT EXISTS AdrIdentityMigrationJournal (
            migration_id TEXT PRIMARY KEY,
            manifest_version TEXT NOT NULL,
            phase TEXT NOT NULL,
            completed_phases TEXT NOT NULL,
            backup_path TEXT,
            state_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    `);
}

/**
 * @summary Creates a point-in-time backup snapshot of ADR graph nodes, incident edges, shared-vector
 * owner nodes, vector store entries, and KB projection entries prior to applying the migration.
 * @param {Object} [options={}]
 * @returns {Object}
 */
export function createAdrMigrationBackup({
    db,
    vectorStore = null,
    kbStore     = null,
    backupPath  = null,
    manifest    = REVIEWED_41_ADR_MIGRATION_MANIFEST
} = {}) {
    if (!db) {
        throw createCodedError('ADR_MIGRATION_DB_REQUIRED', 'createAdrMigrationBackup requires a SQLite db handle.');
    }
    ensureMigrationTables(db);

    const
        legacyIds     = new Set(manifest.map(e => e.legacyId)),
        canonicalKeys = new Set(manifest.map(e => e.canonicalKey)),
        ownerNodeIds  = new Set();

    for (const entry of manifest) {
        for (const owner of entry.observedState?.reusedVectorOwners || []) {
            if (owner?.nodeId) ownerNodeIds.add(owner.nodeId);
        }
    }

    const
        allNodes    = db.prepare('SELECT id, data FROM Nodes ORDER BY id ASC').all(),
        allEdges    = db.prepare('SELECT id, source, target, type, data FROM Edges ORDER BY id ASC').all(),
        backedNodes = allNodes.filter(row =>
            legacyIds.has(row.id) ||
            canonicalKeys.has(row.id) ||
            ownerNodeIds.has(row.id) ||
            row.id.startsWith('adr-') ||
            row.id.startsWith('adr:')
        ),
        backedEdges  = allEdges.filter(row =>
            legacyIds.has(row.source) ||
            legacyIds.has(row.target) ||
            canonicalKeys.has(row.source) ||
            canonicalKeys.has(row.target)
        );

    const vectorEntries = [];
    if (vectorStore instanceof Map) {
        for (const [k, v] of vectorStore.entries()) {
            if (legacyIds.has(k) || canonicalKeys.has(k) || String(k).startsWith('summary_')) {
                vectorEntries.push([k, structuredClone(v)]);
            }
        }
    } else if (vectorStore && typeof vectorStore.exportSnapshot === 'function') {
        const exported = vectorStore.exportSnapshot();
        if (Array.isArray(exported)) vectorEntries.push(...structuredClone(exported));
    }

    const kbEntries = [];
    if (kbStore instanceof Map) {
        for (const [k, v] of kbStore.entries()) {
            if (legacyIds.has(k) || canonicalKeys.has(k)) {
                kbEntries.push([k, structuredClone(v)]);
            }
        }
    } else if (kbStore && typeof kbStore.exportSnapshot === 'function') {
        const exported = kbStore.exportSnapshot();
        if (Array.isArray(exported)) kbEntries.push(...structuredClone(exported));
    }

    const snapshot = {
        version    : MIGRATION_MANIFEST_VERSION,
        createdAt  : new Date().toISOString(),
        manifestIds: manifest.map(e => ({legacyId: e.legacyId, canonicalKey: e.canonicalKey})),
        nodes      : backedNodes,
        edges      : backedEdges,
        vectorEntries,
        kbEntries
    };

    if (typeof backupPath === 'string' && backupPath.trim()) {
        fs.mkdirSync(path.dirname(path.resolve(backupPath)), {recursive: true});
        fs.writeFileSync(path.resolve(backupPath), JSON.stringify(snapshot, null, 2), 'utf-8');
    }

    return snapshot;
}

/**
 * @summary Restores ADR graph nodes, incident edges, vector store entries, and KB projection entries
 * from a pre-migration backup without harming unrelated graph nodes, shared non-ADR summary vectors,
 * or non-ADR KB consumers.
 * @param {Object} [options={}]
 * @returns {Object}
 */
export function restoreAdrMigrationBackup({
    db,
    vectorStore = null,
    kbStore     = null,
    backup      = null,
    backupPath  = null
} = {}) {
    if (!db) {
        throw createCodedError('ADR_MIGRATION_DB_REQUIRED', 'restoreAdrMigrationBackup requires a SQLite db handle.');
    }

    const resolvedBackup = backup || (
        typeof backupPath === 'string' && backupPath.trim() && fs.existsSync(path.resolve(backupPath))
            ? JSON.parse(fs.readFileSync(path.resolve(backupPath), 'utf-8'))
            : null
    );

    if (!resolvedBackup || !Array.isArray(resolvedBackup.nodes) || !Array.isArray(resolvedBackup.edges)) {
        throw createCodedError(
            'ADR_MIGRATION_BACKUP_INVALID',
            'restoreAdrMigrationBackup requires a valid backup snapshot object or readable backupPath.'
        );
    }

    ensureMigrationTables(db);

    const
        manifestIds   = resolvedBackup.manifestIds || REVIEWED_41_ADR_MIGRATION_MANIFEST.map(e => ({legacyId: e.legacyId, canonicalKey: e.canonicalKey})),
        legacyIds     = new Set(manifestIds.map(e => e.legacyId)),
        canonicalKeys = new Set(manifestIds.map(e => e.canonicalKey));

    const restoreTx = db.transaction(() => {
        const currentEdges   = db.prepare('SELECT id, source, target FROM Edges').all();
        const deleteEdgeStmt = db.prepare('DELETE FROM Edges WHERE id = ?');
        for (const edge of currentEdges) {
            if (legacyIds.has(edge.source) || legacyIds.has(edge.target) ||
                canonicalKeys.has(edge.source) || canonicalKeys.has(edge.target)) {
                deleteEdgeStmt.run(edge.id);
            }
        }

        const deleteNodeStmt = db.prepare('DELETE FROM Nodes WHERE id = ?');
        for (const id of [...legacyIds, ...canonicalKeys]) {
            deleteNodeStmt.run(id);
        }

        const upsertNodeStmt = db.prepare('INSERT OR REPLACE INTO Nodes (id, data) VALUES (?, ?)');
        for (const row of resolvedBackup.nodes) {
            upsertNodeStmt.run(row.id, row.data);
        }

        const upsertEdgeStmt = db.prepare(
            'INSERT OR REPLACE INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)'
        );
        for (const edge of resolvedBackup.edges) {
            upsertEdgeStmt.run(edge.id, edge.source, edge.target, edge.type, edge.data);
        }

        db.prepare('DELETE FROM AdrIdentityMigrationJournal').run();
    });

    restoreTx();

    let restoredVectorsCount = 0;
    if (vectorStore instanceof Map) {
        for (const key of canonicalKeys) {
            vectorStore.delete(key);
        }
        for (const [k, v] of resolvedBackup.vectorEntries || []) {
            vectorStore.set(k, structuredClone(v));
            restoredVectorsCount++;
        }
    } else if (vectorStore && typeof vectorStore.restoreSnapshot === 'function') {
        vectorStore.restoreSnapshot(resolvedBackup.vectorEntries || [], {canonicalKeys: Array.from(canonicalKeys)});
        restoredVectorsCount = (resolvedBackup.vectorEntries || []).length;
    }

    let restoredKbCount = 0;
    if (kbStore instanceof Map) {
        for (const key of canonicalKeys) {
            kbStore.delete(key);
        }
        for (const [k, v] of resolvedBackup.kbEntries || []) {
            kbStore.set(k, structuredClone(v));
            restoredKbCount++;
        }
    } else if (kbStore && typeof kbStore.restoreSnapshot === 'function') {
        kbStore.restoreSnapshot(resolvedBackup.kbEntries || [], {canonicalKeys: Array.from(canonicalKeys)});
        restoredKbCount = (resolvedBackup.kbEntries || []).length;
    }

    resetSharedAdrCatalog();

    return {
        restored          : true,
        restoredNodesCount: resolvedBackup.nodes.length,
        restoredEdgesCount: resolvedBackup.edges.length,
        restoredVectorsCount,
        restoredKbCount
    };
}

/**
 * @summary Merges edge data payloads when two incident edges collapse onto the same `(source, target, type)`
 * tuple during legacy-to-canonical endpoint rewriting, ensuring zero edge metadata or provenance loss.
 * @param {Object} existingData
 * @param {Object} incomingData
 * @param {String} targetId
 * @param {String} newSource
 * @param {String} newTarget
 * @returns {Object}
 * @private
 */
function mergeMigratedEdgeData(existingData, incomingData, targetId, newSource, newTarget) {
    const
        existingProps = existingData?.properties || {},
        incomingProps = incomingData?.properties || {},
        mergedOrigins = Array.from(new Set([
            ...(Array.isArray(existingProps.origins) ? existingProps.origins : []),
            ...(existingProps.origin ? [existingProps.origin] : []),
            ...(Array.isArray(incomingProps.origins) ? incomingProps.origins : []),
            ...(incomingProps.origin ? [incomingProps.origin] : [])
        ])),
        mergedProvenance = [
            ...(Array.isArray(existingProps.provenance) ? existingProps.provenance : []),
            ...(existingProps.provenance && !Array.isArray(existingProps.provenance) ? [existingProps.provenance] : []),
            ...(Array.isArray(incomingProps.provenance) ? incomingProps.provenance : []),
            ...(incomingProps.provenance && !Array.isArray(incomingProps.provenance) ? [incomingProps.provenance] : [])
        ],
        mergedLegacyEdgeIds = Array.from(new Set([
            ...(existingProps.migratedFromEdgeIds || []),
            ...(existingData?.id ? [existingData.id] : []),
            ...(incomingProps.migratedFromEdgeIds || []),
            ...(incomingData?.id ? [incomingData.id] : [])
        ]));

    return {
        ...existingData,
        ...incomingData,
        id        : targetId,
        source    : newSource,
        target    : newTarget,
        weight    : Math.max(Number(existingData?.weight ?? 1), Number(incomingData?.weight ?? 1)),
        properties: {
            ...existingProps,
            ...incomingProps,
            ...(mergedOrigins.length > 0 ? {origins: mergedOrigins} : {}),
            ...(mergedProvenance.length > 0 ? {provenance: mergedProvenance} : {}),
            migratedFromEdgeIds: mergedLegacyEdgeIds
        }
    };
}

/**
 * @summary Executes or dry-runs the 41-record legacy ADR identity migration with restartable
 * cross-store phase journaling across SQLite (`Nodes` / `Edges`), `vectorStore`, and `kbStore`.
 * @param {Object} [options={}]
 * @returns {Promise<Object>}
 */
export async function migrateLegacyAdrIdentities({
    db                = null,
    sqlitePath        = null,
    vectorStore       = null,
    kbStore           = null,
    manifest          = REVIEWED_41_ADR_MIGRATION_MANIFEST,
    cutRepositories   = MIGRATION_CUT_REPOSITORIES,
    apply             = false,
    dryRun            = !apply,
    backupPath        = null,
    migrationId       = 'adr-legacy-41-cut-v1',
    failAfterPhase    = null,
    sourceProbe       = null,
    readerContext     = null,
    requireCompleteInventory = true
} = {}) {
    let ownedDb = null;
    if (!db && typeof sqlitePath === 'string' && sqlitePath.trim()) {
        const Database = createRequire(import.meta.url)('better-sqlite3');
        ownedDb = new Database(sqlitePath);
        db      = ownedDb;
    }

    try {
        const preconditions = verifyMigrationPreconditions({
            manifest,
            cutRepositories,
            db,
            sourceProbe,
            readerContext,
            requireCompleteInventory
        });

        const plannedNodeMigrations = manifest.map(entry => {
            const
                isSummaryVector = String(entry.observedState.observedSemanticVectorId || '').startsWith('summary_'),
                hasNonAdrOwners = entry.observedState.reusedVectorOwners.some(o => o.isAdr === false);

            return {
                adrNumber               : entry.adrNumber,
                legacyId                : entry.legacyId,
                canonicalKey            : entry.canonicalKey,
                originCanonicalKey      : entry.originCanonicalKey,
                previousLabel           : entry.observedState.nodeLabel,
                newLabel                : 'ADR',
                anomalyShape            : entry.observedState.anomalyShape,
                observedSemanticVectorId: entry.observedState.observedSemanticVectorId,
                newSemanticVectorId     : entry.canonicalKey,
                vectorAction            : isSummaryVector
                    ? (hasNonAdrOwners ? 'detach-shared-summary-vector-keep-non-adr-owners' : 'detach-summary-vector-reembed-adr')
                    : 'rekey-adr-vector-to-canonical-key',
                sharedVectorPreservedOwners: entry.observedState.reusedVectorOwners.filter(o => o.isAdr === false),
                custodyTransition          : entry.custodyTransition,
                historicalReferences       : entry.historicalReferences.map(ref =>
                    normalizeHistoricalOriginReference(ref, entry.assignmentEvidence.namespace)
                )
            };
        });

        if (dryRun || !apply) {
            return {
                mode             : 'dry-run',
                applied          : false,
                noOpRerun        : false,
                migrationId,
                manifestVersion  : MIGRATION_MANIFEST_VERSION,
                preconditions,
                plannedNodeMigrations,
                plannedCount     : plannedNodeMigrations.length,
                custodyMovesCount: plannedNodeMigrations.filter(p => Boolean(p.custodyTransition)).length,
                anomaliesCount   : plannedNodeMigrations.filter(p => p.anomalyShape !== 'NONE').length
            };
        }

        if (!db) {
            throw createCodedError(
                'ADR_MIGRATION_DB_REQUIRED',
                'Applying the migration (--apply) requires a writable SQLite db or sqlitePath.'
            );
        }

        ensureMigrationTables(db);

        const existingJournal = db.prepare(
            'SELECT * FROM AdrIdentityMigrationJournal WHERE migration_id = ?'
        ).get(migrationId);

        const completedPhases = existingJournal
            ? JSON.parse(existingJournal.completed_phases || '[]')
            : [];
        const savedState = existingJournal
            ? JSON.parse(existingJournal.state_json || '{}')
            : {};

        if (existingJournal?.phase === 'completed' || completedPhases.includes('completed')) {
            const admissionRecords = manifest.map(buildAdrMigrationRecordFromManifestEntry);
            hydrateAdrAdmissionRecords(admissionRecords, {replaceExisting: true});
            return {
                mode           : 'apply',
                applied        : false,
                noOpRerun      : true,
                resumed        : false,
                migrationId,
                manifestVersion: MIGRATION_MANIFEST_VERSION,
                phase          : 'completed',
                completedPhases: [...MIGRATION_PHASES],
                preconditions,
                ...savedState
            };
        }

        const resumed = completedPhases.length > 0;

        const recordJournalPhase = (phase, extraState = {}) => {
            if (!completedPhases.includes(phase)) {
                completedPhases.push(phase);
            }
            Object.assign(savedState, extraState);
            db.prepare(`
                INSERT OR REPLACE INTO AdrIdentityMigrationJournal (
                    migration_id, manifest_version, phase, completed_phases, backup_path, state_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                migrationId,
                MIGRATION_MANIFEST_VERSION,
                phase,
                JSON.stringify(completedPhases),
                backupPath || existingJournal?.backup_path || null,
                JSON.stringify(savedState),
                new Date().toISOString()
            );

            if (failAfterPhase === phase) {
                throw createCodedError(
                    'ADR_MIGRATION_INTERRUPTED_FOR_TEST',
                    `Simulated interruption immediately after phase '${phase}'.`
                );
            }
        };

        // Phase 1: preconditions_verified
        if (!completedPhases.includes('preconditions_verified')) {
            recordJournalPhase('preconditions_verified', {preconditionsVerifiedAt: preconditions.verifiedAt});
        }

        // Phase 2: backup_created
        if (!completedPhases.includes('backup_created')) {
            const backupSnapshot = createAdrMigrationBackup({
                db,
                vectorStore,
                kbStore,
                backupPath,
                manifest
            });
            recordJournalPhase('backup_created', {
                backupNodeCount: backupSnapshot.nodes.length,
                backupEdgeCount: backupSnapshot.edges.length
            });
        }

        const admissionRecords  = manifest.map(buildAdrMigrationRecordFromManifestEntry);
        const legacyToCanonical = new Map(manifest.map(e => [e.legacyId, e.canonicalKey]));

        // Phase 3: graph_sqlite_applied
        if (!completedPhases.includes('graph_sqlite_applied')) {
            let
                migratedNodesCount  = 0,
                relabeledNodesCount = 0,
                rewrittenEdgesCount = 0,
                mergedEdgesCount    = 0;

            const applySqliteTx = db.transaction(() => {
                const
                    getNodeStmt    = db.prepare('SELECT id, data FROM Nodes WHERE id = ?'),
                    upsertNodeStmt = db.prepare('INSERT OR REPLACE INTO Nodes (id, data) VALUES (?, ?)'),
                    deleteNodeStmt = db.prepare('DELETE FROM Nodes WHERE id = ?');

                for (let idx = 0; idx < manifest.length; idx++) {
                    const
                        entry           = manifest[idx],
                        admissionRecord = admissionRecords[idx],
                        legacyRow       = getNodeStmt.get(entry.legacyId),
                        canonicalRow    = getNodeStmt.get(entry.canonicalKey);

                    let existingNodeObj = {};
                    if (legacyRow) {
                        try { existingNodeObj = JSON.parse(legacyRow.data); } catch {}
                    } else if (canonicalRow) {
                        try { existingNodeObj = JSON.parse(canonicalRow.data); } catch {}
                    }

                    const
                        existingProps   = existingNodeObj.properties || {},
                        previousLabel   = existingNodeObj.label || entry.observedState.nodeLabel || 'ADR',
                        previousVecId   = existingNodeObj.semanticVectorId || entry.observedState.observedSemanticVectorId || entry.legacyId,
                        isSummaryVec    = String(previousVecId).startsWith('summary_'),
                        nonAdrVecOwners = (entry.observedState.reusedVectorOwners || []).filter(o => o.isAdr === false);

                    if (previousLabel !== 'ADR') {
                        relabeledNodesCount++;
                    }

                    const normalizedRefs = Array.from(new Set([
                        ...(admissionRecord.historicalReferences || []),
                        ...((existingProps.historicalReferences || []).map(r =>
                            normalizeHistoricalOriginReference(r, 'neomjs/neo')
                        ))
                    ])).filter(Boolean);

                    const newNodePayload = {
                        ...existingNodeObj,
                        id              : entry.canonicalKey,
                        label           : 'ADR',
                        type            : 'ADR',
                        name            : entry.title,
                        semanticVectorId: entry.canonicalKey,
                        properties      : {
                            ...existingProps,
                            adrNumber           : entry.adrNumber,
                            canonicalKey        : entry.canonicalKey,
                            originCanonicalKey  : entry.originCanonicalKey || null,
                            legacyId            : entry.legacyId,
                            title               : entry.title,
                            status              : entry.status || 'Accepted',
                            currentSlug         : entry.currentSlug,
                            filePath            : entry.sourcePath,
                            sourcePath          : entry.sourcePath,
                            contentHash         : entry.sourceTuple.contentHash,
                            visibility          : entry.visibility || 'public',
                            aliases             : admissionRecord.aliases,
                            historicalAliases   : admissionRecord.historicalAliases,
                            historicalReferences: normalizedRefs,
                            adrAdmissionRecord  : admissionRecord,
                            adrAuthority        : {
                                admitted            : true,
                                writer              : 'migrateLegacyAdrIdentities',
                                canonicalKey        : entry.canonicalKey,
                                adrNumber           : entry.adrNumber,
                                migratedFromLegacyId: entry.legacyId,
                                previousLabel,
                                anomalyShape        : entry.observedState.anomalyShape,
                                manifestVersion     : MIGRATION_MANIFEST_VERSION,
                                vectorProvenance    : {
                                    previousSemanticVectorId   : previousVecId,
                                    detachedSummaryVector      : isSummaryVec,
                                    preservedSharedVectorOwners: nonAdrVecOwners.map(o => o.nodeId)
                                }
                            }
                        }
                    };

                    upsertNodeStmt.run(entry.canonicalKey, JSON.stringify(newNodePayload));
                    if (legacyRow) {
                        deleteNodeStmt.run(entry.legacyId);
                    }
                    migratedNodesCount++;
                }

                // Rewrite all incident edges referencing any legacy ADR ID
                const
                    allEdges       = db.prepare('SELECT id, source, target, type, data FROM Edges ORDER BY id ASC').all(),
                    deleteEdgeStmt = db.prepare('DELETE FROM Edges WHERE id = ?'),
                    upsertEdgeStmt = db.prepare(
                        'INSERT OR REPLACE INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)'
                    ),
                    edgeByTuple    = new Map();

                for (const row of allEdges) {
                    let parsed = {};
                    try { parsed = JSON.parse(row.data); } catch {}
                    const tupleKey = `${row.source}|${row.target}|${row.type}`;
                    if (!legacyToCanonical.has(row.source) && !legacyToCanonical.has(row.target)) {
                        edgeByTuple.set(tupleKey, {id: row.id, source: row.source, target: row.target, type: row.type, data: parsed});
                    }
                }

                for (const row of allEdges) {
                    const
                        hasLegacySource = legacyToCanonical.has(row.source),
                        hasLegacyTarget = legacyToCanonical.has(row.target);

                    if (!hasLegacySource && !hasLegacyTarget) continue;

                    const
                        newSource = legacyToCanonical.get(row.source) || row.source,
                        newTarget = legacyToCanonical.get(row.target) || row.target,
                        tupleKey  = `${newSource}|${newTarget}|${row.type}`;

                    let parsed = {};
                    try { parsed = JSON.parse(row.data); } catch {}

                    const
                        existingProps   = parsed.properties || {},
                        normalizedProps = {...existingProps};

                    if (typeof normalizedProps.origin === 'string') {
                        if (legacyToCanonical.has(normalizedProps.origin)) {
                            normalizedProps.origin = legacyToCanonical.get(normalizedProps.origin);
                        } else if (/^(?:ISSUE|PULL_REQUEST|DISCUSSION):/i.test(normalizedProps.origin) || /^#\d+$/.test(normalizedProps.origin)) {
                            normalizedProps.origin = normalizeHistoricalOriginReference(normalizedProps.origin);
                        }
                    }

                    deleteEdgeStmt.run(row.id);
                    rewrittenEdgesCount++;

                    const existingSurvivor = edgeByTuple.get(tupleKey);
                    if (existingSurvivor) {
                        const mergedData = mergeMigratedEdgeData(
                            existingSurvivor.data,
                            {...parsed, id: row.id, properties: normalizedProps},
                            existingSurvivor.id,
                            newSource,
                            newTarget
                        );
                        existingSurvivor.data = mergedData;
                        upsertEdgeStmt.run(
                            existingSurvivor.id,
                            newSource,
                            newTarget,
                            row.type,
                            JSON.stringify(mergedData)
                        );
                        mergedEdgesCount++;
                    } else {
                        const
                            newEdgeId   = `${newSource}__${row.type}__${newTarget}`,
                            newEdgeData = {
                                ...parsed,
                                id        : newEdgeId,
                                source    : newSource,
                                target    : newTarget,
                                type      : row.type,
                                properties: {
                                    ...normalizedProps,
                                    migratedFromEdgeIds: Array.from(new Set([
                                        ...(normalizedProps.migratedFromEdgeIds || []),
                                        row.id
                                    ]))
                                }
                            };
                        edgeByTuple.set(tupleKey, {
                            id    : newEdgeId,
                            source: newSource,
                            target: newTarget,
                            type  : row.type,
                            data  : newEdgeData
                        });
                        upsertEdgeStmt.run(newEdgeId, newSource, newTarget, row.type, JSON.stringify(newEdgeData));
                    }
                }
            });

            applySqliteTx();

            // Hydrate in-memory catalog state
            for (const repo of Object.values(cutRepositories)) {
                registerSharedForgeRepository(repo);
            }
            hydrateAdrAdmissionRecords(admissionRecords, {replaceExisting: true});

            recordJournalPhase('graph_sqlite_applied', {
                migratedNodesCount,
                relabeledNodesCount,
                rewrittenEdgesCount,
                mergedEdgesCount
            });
        } else {
            for (const repo of Object.values(cutRepositories)) {
                registerSharedForgeRepository(repo);
            }
            hydrateAdrAdmissionRecords(admissionRecords, {replaceExisting: true});
        }

        // Phase 4: vector_store_applied
        if (!completedPhases.includes('vector_store_applied')) {
            let
                upsertedVectorsCount         = 0,
                removedLegacyAdrVectorsCount = 0,
                preservedSummaryVectorsCount = 0;

            const nonAdrSummaryIds = new Set();
            for (const entry of manifest) {
                const vecId = entry.observedState?.observedSemanticVectorId;
                if (typeof vecId === 'string' && vecId.startsWith('summary_')) {
                    const hasNonAdrOwner = (entry.observedState.reusedVectorOwners || []).some(o => o.isAdr === false);
                    if (hasNonAdrOwner) {
                        nonAdrSummaryIds.add(vecId);
                    }
                }
            }

            if (vectorStore instanceof Map) {
                for (const entry of manifest) {
                    const legacyEntry = vectorStore.get(entry.legacyId);
                    vectorStore.set(entry.canonicalKey, {
                        ...(legacyEntry || {}),
                        id          : entry.canonicalKey,
                        canonicalKey: entry.canonicalKey,
                        legacyId    : entry.legacyId,
                        label       : 'ADR',
                        adrNumber   : entry.adrNumber,
                        repositoryId: entry.sourceTuple.repositoryId,
                        namespace   : entry.sourceTuple.namespace,
                        contentHash : entry.sourceTuple.contentHash
                    });
                    upsertedVectorsCount++;

                    if (vectorStore.has(entry.legacyId)) {
                        vectorStore.delete(entry.legacyId);
                        removedLegacyAdrVectorsCount++;
                    }
                }

                for (const summaryVecId of nonAdrSummaryIds) {
                    if (vectorStore.has(summaryVecId)) {
                        preservedSummaryVectorsCount++;
                    }
                }
            } else if (vectorStore && typeof vectorStore.applyAdrMigration === 'function') {
                const res = await vectorStore.applyAdrMigration({manifest, nonAdrSummaryIds: Array.from(nonAdrSummaryIds)});
                upsertedVectorsCount         = res?.upsertedVectorsCount ?? manifest.length;
                removedLegacyAdrVectorsCount = res?.removedLegacyAdrVectorsCount ?? 0;
                preservedSummaryVectorsCount = res?.preservedSummaryVectorsCount ?? nonAdrSummaryIds.size;
            }

            recordJournalPhase('vector_store_applied', {
                upsertedVectorsCount,
                removedLegacyAdrVectorsCount,
                preservedSummaryVectorsCount
            });
        }

        // Phase 5: kb_projection_applied
        if (!completedPhases.includes('kb_projection_applied')) {
            let migratedKbEntriesCount = 0;

            if (kbStore instanceof Map) {
                for (let idx = 0; idx < manifest.length; idx++) {
                    const
                        entry           = manifest[idx],
                        admissionRecord = admissionRecords[idx],
                        existingLegacy  = kbStore.get(entry.legacyId) || {};

                    kbStore.set(entry.canonicalKey, {
                        ...existingLegacy,
                        id               : entry.canonicalKey,
                        canonicalKey     : entry.canonicalKey,
                        legacyId         : entry.legacyId,
                        adrNumber        : entry.adrNumber,
                        title            : entry.title,
                        currentSlug      : entry.currentSlug,
                        sourcePath       : entry.sourcePath,
                        repositoryId     : entry.sourceTuple.repositoryId,
                        namespace        : entry.sourceTuple.namespace,
                        visibility       : entry.visibility || 'public',
                        aliases          : admissionRecord.aliases,
                        historicalAliases: admissionRecord.historicalAliases
                    });
                    if (kbStore.has(entry.legacyId)) {
                        kbStore.delete(entry.legacyId);
                    }
                    migratedKbEntriesCount++;
                }
            } else if (kbStore && typeof kbStore.applyAdrMigration === 'function') {
                const res = await kbStore.applyAdrMigration({manifest, admissionRecords});
                migratedKbEntriesCount = res?.migratedKbEntriesCount ?? manifest.length;
            }

            AdrSource.hydrateAdmissionEvidence(admissionRecords);
            for (const rec of admissionRecords) {
                AdrSource.kbIndexedDecisions.set(rec.canonicalKey, {
                    id          : rec.canonicalKey,
                    canonicalKey: rec.canonicalKey,
                    adrNumber   : rec.adrNumber,
                    source      : rec.sourcePath,
                    repositoryId: rec.sourceTuple.repositoryId,
                    namespace   : rec.sourceTuple.namespace
                });
            }

            recordJournalPhase('kb_projection_applied', {migratedKbEntriesCount});
        }

        // Phase 6: reader_verified
        if (!completedPhases.includes('reader_verified')) {
            for (const entry of manifest) {
                const canonicalResolved = AdrSource.resolveAdrReference(entry.canonicalKey, {
                    retainedAdmissionRecords: admissionRecords,
                    authorizedNamespaces    : [entry.sourceTuple.namespace]
                });
                if (!canonicalResolved.resolved || canonicalResolved.canonicalKey !== entry.canonicalKey) {
                    throw createCodedError(
                        'ADR_MIGRATION_READER_VERIFICATION_FAILED',
                        `Reader failed to resolve migrated canonicalKey '${entry.canonicalKey}'.`
                    );
                }

                const shortAliasResolved = AdrSource.resolveAdrReference(entry.legacyId, {
                    retainedAdmissionRecords: admissionRecords,
                    namespace               : entry.sourceTuple.namespace,
                    repositoryId            : entry.sourceTuple.repositoryId,
                    authorizedNamespaces    : [entry.sourceTuple.namespace]
                });
                if (!shortAliasResolved.resolved || shortAliasResolved.canonicalKey !== entry.canonicalKey) {
                    throw createCodedError(
                        'ADR_MIGRATION_READER_VERIFICATION_FAILED',
                        `Reader failed to resolve legacy number '${entry.legacyId}' in '${entry.sourceTuple.namespace}'.`
                    );
                }

                if (entry.custodyTransition) {
                    const originAliasResolved = AdrSource.resolveAdrReference(entry.legacyId, {
                        retainedAdmissionRecords: admissionRecords,
                        namespace               : entry.custodyTransition.fromNamespace,
                        repositoryId            : entry.custodyTransition.fromRepositoryId,
                        authorizedNamespaces    : [entry.sourceTuple.namespace, entry.custodyTransition.fromNamespace]
                    });
                    if (!originAliasResolved.resolved || originAliasResolved.canonicalKey !== entry.canonicalKey) {
                        throw createCodedError(
                            'ADR_MIGRATION_READER_VERIFICATION_FAILED',
                            `Reader failed to resolve moved FM ADR '${entry.legacyId}' from origin namespace '${entry.custodyTransition.fromNamespace}'.`
                        );
                    }
                }
            }

            recordJournalPhase('reader_verified', {readerVerifiedCount: manifest.length});
        }

        // Phase 7: completed
        recordJournalPhase('completed', {completedAt: new Date().toISOString()});

        return {
            mode           : 'apply',
            applied        : true,
            noOpRerun      : false,
            resumed,
            migrationId,
            manifestVersion: MIGRATION_MANIFEST_VERSION,
            phase          : 'completed',
            completedPhases: [...completedPhases],
            preconditions,
            ...savedState
        };
    } finally {
        if (ownedDb) {
            try { ownedDb.close(); } catch {}
        }
    }
}

/**
 * @summary Reconciles ADR rebuilds after slug rename (`0042-old` -> `0042-new`), custody move (`A` -> `B`),
 * combined custody move + rename (`A-old` -> `B-new`), source loss, and admission-record loss using
 * `AdrSource` and `adrAdmissionCatalog` without ever reconstructing identity from basename or re-scoping
 * custody without verified transition evidence.
 * @param {Object} [options={}]
 * @returns {Promise<Object>}
 */
export async function reconcileRebuildAndCustodyControls({
    retainedAdmissionRecords = [],
    repositories             = [],
    custodyTransitions       = [],
    sourceLineageEvidence    = [],
    expectedDecisions        = []
} = {}) {
    const
        refusedCandidates = [],
        verifiedRecords   = new Map();

    for (const rec of retainedAdmissionRecords || []) {
        const record = rec?.adrAdmissionRecord || rec;
        if (record?.canonicalKey) {
            verifiedRecords.set(record.canonicalKey, structuredClone(record));
        }
    }

    // Inspect candidate files across repositories before delegating to AdrSource.reconcileDecisionStates
    // to enforce explicit refusal codes when admission evidence is missing or custody transition is unverified.
    for (const repoSpec of repositories || []) {
        const
            forge        = repoSpec.forge || repoSpec.repository?.forge || 'github.com',
            repositoryId = repoSpec.repositoryId || repoSpec.repository?.repositoryId || null,
            namespace    = repoSpec.namespace || repoSpec.repository?.namespace || null,
            files        = repoSpec.files || {};

        for (const [sourcePath, rawContent] of Object.entries(files)) {
            const
                fileName     = path.posix.basename(sourcePath),
                parsedName   = parseAdrFilename(fileName),
                redirectInfo = parseAdrRedirect(rawContent);

            if (!parsedName || redirectInfo.isRedirect) continue;

            const
                {adrNumber, slug} = parsedName,
                directKey         = repositoryId && namespace
                    ? buildCanonicalAdrKey({forge, repositoryId, namespace, number: adrNumber})
                    : null,
                directRecord      = directKey ? verifiedRecords.get(directKey) : null;

            // Check if this file represents a custody move from another repository
            const matchingRecordsByNumber = Array.from(verifiedRecords.values()).filter(
                r => r.adrNumber === adrNumber && r.sourceTuple?.repositoryId !== repositoryId && r.assignmentEvidence?.repositoryId !== repositoryId
            );

            if (!directRecord && matchingRecordsByNumber.length > 0) {
                const
                    originRecord = matchingRecordsByNumber[0],
                    verifiedMove = (custodyTransitions || []).find(t =>
                        (t.canonicalKey === originRecord.canonicalKey || t.adrNumber === adrNumber) &&
                        String(t.toRepositoryId) === String(repositoryId) &&
                        Boolean(t.proof) &&
                        t.verified !== false
                    );

                if (!verifiedMove) {
                    refusedCandidates.push({
                        sourcePath,
                        adrNumber,
                        slug,
                        repositoryId,
                        namespace,
                        reasonCode: 'ADR_CUSTODY_TRANSITION_UNVERIFIED'
                    });
                    continue;
                }
                continue;
            }

            if (!directRecord) {
                refusedCandidates.push({
                    sourcePath,
                    adrNumber,
                    slug,
                    repositoryId,
                    namespace,
                    reasonCode: 'ADR_ADMISSION_EVIDENCE_MISSING'
                });
                continue;
            }
        }
    }

    const filteredRepositories = (repositories || []).map(repoSpec => {
        const
            repositoryId = repoSpec.repositoryId || repoSpec.repository?.repositoryId || null,
            files        = {...(repoSpec.files || {})};

        for (const refused of refusedCandidates) {
            if (String(refused.repositoryId) === String(repositoryId) && refused.sourcePath in files) {
                delete files[refused.sourcePath];
            }
        }

        return {
            ...repoSpec,
            files
        };
    });

    const updatedRetainedRecords = Array.from(verifiedRecords.values());
    AdrSource.resetCatalog();

    const reconciled = await AdrSource.reconcileDecisionStates({
        repositories            : filteredRepositories,
        custodyTransitions,
        sourceLineageEvidence,
        expectedDecisions       : expectedDecisions.length > 0 ? expectedDecisions : updatedRetainedRecords.map(r => r.canonicalKey),
        retainedAdmissionRecords: updatedRetainedRecords
    });

    return {
        ...reconciled,
        refusedCandidates: [
            ...refusedCandidates,
            ...(reconciled.refusedSourcePaths || [])
        ],
        retainedRecords: updatedRetainedRecords
    };
}

/**
 * @summary Parses CLI arguments for `migrateLegacyAdrIdentities.mjs`.
 * @param {String[]} [argv=process.argv.slice(2)]
 * @returns {Object}
 */
export function parseArgs(argv = process.argv.slice(2)) {
    const options = {
        apply      : false,
        dryRun     : true,
        sqlitePath : null,
        backupPath : null,
        restorePath: null,
        runbook    : false,
        help       : false
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--apply') {
            options.apply  = true;
            options.dryRun = false;
        } else if (arg === '--dry-run') {
            options.apply  = false;
            options.dryRun = true;
        } else if (arg === '--db' && argv[i + 1]) {
            options.sqlitePath = argv[++i];
        } else if (arg === '--backup' && argv[i + 1]) {
            options.backupPath = argv[++i];
        } else if (arg === '--restore' && argv[i + 1]) {
            options.restorePath = argv[++i];
        } else if (arg === '--runbook') {
            options.runbook = true;
        } else if (arg === '--help' || arg === '-h') {
            options.help = true;
        }
    }

    return options;
}

/**
 * @summary Returns human-readable CLI usage instructions.
 * @returns {String}
 */
export function getUsageText() {
    return [
        'Usage: node ai/scripts/migrations/migrateLegacyAdrIdentities.mjs [options]',
        '',
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

async function runCli() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(getUsageText());
        return;
    }

    if (opts.runbook) {
        console.log(JSON.stringify(ADR_MIGRATION_RUNBOOK, null, 2));
        return;
    }

    if (opts.restorePath) {
        const Database = createRequire(import.meta.url)('better-sqlite3');
        const db       = new Database(opts.sqlitePath);
        try {
            const res = restoreAdrMigrationBackup({db, backupPath: opts.restorePath});
            console.log(JSON.stringify(res, null, 2));
        } finally {
            db.close();
        }
        return;
    }

    const result = await migrateLegacyAdrIdentities({
        sqlitePath: opts.sqlitePath,
        apply     : opts.apply,
        dryRun    : opts.dryRun,
        backupPath: opts.backupPath
    });
    console.log(JSON.stringify(result, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
    runCli().catch(err => {
        console.error(err);
        process.exitCode = 1;
    });
}
export {
    ADR_MIGRATION_RUNBOOK,
    MIGRATION_CUT_REPOSITORIES,
    MIGRATION_MANIFEST_VERSION,
    MOVED_FM_ADR_NUMBERS,
    OBSERVED_11_CENSUS_ANOMALY_NUMBERS,
    OBSERVED_LIVE_ANOMALY_NUMBERS,
    REVIEWED_41_ADR_MIGRATION_MANIFEST
};

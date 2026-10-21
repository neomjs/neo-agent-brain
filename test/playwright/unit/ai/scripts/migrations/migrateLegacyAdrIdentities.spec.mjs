import {setup} from '../../../../setup.mjs';

const appName = 'MigrateLegacyAdrIdentitiesTest';
setup({neoConfig: {unitTestMode: true}, appConfig: {name: appName, isMounted: () => true, vnodeInitialising: false}});

import {test, expect}                                                                   from '@playwright/test';
import {execFileSync}                                                                   from 'node:child_process';
import Database                                                                         from 'better-sqlite3';
import fs                                                                               from 'fs-extra';
import os                                                                               from 'os';
import path                                                                             from 'path';
import {fileURLToPath}                                                                  from 'node:url';
import Neo                                                                              from 'neo.mjs/src/Neo.mjs';
import * as core                                                                        from 'neo.mjs/src/core/_export.mjs';
import {SHARED_ADR_CATALOG_STATE, ensureSharedReservationBucket, resetSharedAdrCatalog} from '../../../../../../ai/services/ingestion/adrAdmissionCatalog.mjs';
import {
    ADR_MIGRATION_RUNBOOK, MIGRATION_CUT_REPOSITORIES, MIGRATION_MANIFEST_VERSION, MOVED_FM_ADR_NUMBERS,
    OBSERVED_11_CENSUS_ANOMALY_NUMBERS, OBSERVED_LIVE_ANOMALY_NUMBERS, REVIEWED_41_ADR_MIGRATION_MANIFEST
} from '../../../../../../ai/scripts/migrations/adrMigrationManifest.mjs';

const BRAIN_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const SHARED_SUMMARY = 'summary_7c49107b-04f0-4e9c-ad86-65513999d61b';

let AdrSource, GRAPH_NODE_WRITER_INVENTORY, MIGRATION_PHASES, composeDefaultMigrationStores, computeMigrationContentHash;
let createAdrMigrationBackup, createChromaKbStoreAdapter, createChromaVectorStoreAdapter, createDefaultReaderContext;
let createDefaultSourceProbe, ensureMigrationTables, getUsageText, migrateLegacyAdrIdentities, normalizeHistoricalOriginReference;
let parseArgs, reconcileRebuildAndCustodyControls, restoreAdrMigrationBackup, runCli, verifyMigrationPreconditions, gitWorktreeCutFixture = null;

/** @summary Builds a self-contained compliant `sourceProbe` object from the manifest and cut repository descriptors. */
function createCompliantSourceProbe(manifest = REVIEWED_41_ADR_MIGRATION_MANIFEST, cutRepositories = MIGRATION_CUT_REPOSITORIES) {
    const revisions = {}, contentHashes = {}, redirectContentHashes = {}, probeHashes = {};
    for (const [ns, repoMeta] of Object.entries(cutRepositories || {})) {
        if (repoMeta?.cutRevision) revisions[ns] = repoMeta.cutRevision;
        if (repoMeta?.probeRecord?.contentHash) probeHashes[ns] = repoMeta.probeRecord.contentHash;
    }
    for (const entry of manifest || []) {
        if (entry?.sourceTuple?.contentHash) contentHashes[entry.legacyId] = contentHashes[entry.canonicalKey] = entry.sourceTuple.contentHash;
        if (entry?.custodyTransition?.redirectContentHash) redirectContentHashes[entry.legacyId] = redirectContentHashes[entry.canonicalKey] = entry.custodyTransition.redirectContentHash;
    }
    return {revisions, contentHashes, redirectContentHashes, probeHashes, requirePrivateStageAccess: true};
}

/** @summary Builds a compliant `readerContext` object (with `publicReaderContext`) for unit tests. */
function createCompliantReaderContext(cutRepositories = MIGRATION_CUT_REPOSITORIES) {
    const authorizedNamespaces = [], authorizedRepositories = [], publicNamespaces = [], publicRepositories = [];
    for (const [ns, repoMeta] of Object.entries(cutRepositories || {})) {
        authorizedNamespaces.push(ns);
        authorizedRepositories.push(ns, ...(repoMeta?.repositoryId ? [repoMeta.repositoryId] : []));
        if (repoMeta?.visibility !== 'private') {
            publicNamespaces.push(ns);
            publicRepositories.push(ns, ...(repoMeta?.repositoryId ? [repoMeta.repositoryId] : []));
        }
    }
    return {
        agentIdentity      : '@neo-migration-verifier', allowPrivate: true, authorizedNamespaces, authorizedRepositories,
        publicReaderContext: {agentIdentity: '@neo-migration-verifier', allowPrivate: false, authorizedNamespaces: publicNamespaces, authorizedRepositories: publicRepositories}
    };
}

/** @summary Materializes 4 disposable git repositories in `os.tmpdir()` so live worktree probes run on single-repo CI runners. */
async function createGitWorktreeCutFixture() {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adr-git-cut-1014-')), repoRoots = {}, manifest = [];
    for (const ns of Object.keys(MIGRATION_CUT_REPOSITORIES)) {
        await fs.ensureDir(repoRoots[ns] = path.join(rootDir, ns.split('/')[1]));
    }
    for (const entry of REVIEWED_41_ADR_MIGRATION_MANIFEST) {
        const absPath = path.join(repoRoots[entry.sourceTuple.namespace], entry.sourcePath);
        const body    = `# Decision ${entry.adrNumber}: ${entry.title}\n\nCanonical: ${entry.canonicalKey}\n`;
        await fs.ensureDir(path.dirname(absPath));
        await fs.writeFile(absPath, body, 'utf8');
        let updatedTransition = entry.custodyTransition ? {...entry.custodyTransition} : null;
        if (updatedTransition?.redirectPath) {
            const stubPath = path.join(repoRoots[updatedTransition.fromNamespace], updatedTransition.redirectPath);
            const stubBody = `---\ntype: redirect\ntarget: ${entry.canonicalKey}\n---\n`;
            await fs.ensureDir(path.dirname(stubPath));
            await fs.writeFile(stubPath, stubBody, 'utf8');
            updatedTransition.redirectContentHash = computeMigrationContentHash(stubBody);
        }
        manifest.push({...entry, sourceTuple: {...entry.sourceTuple, contentHash: computeMigrationContentHash(body)}, custodyTransition: updatedTransition});
    }

    const stageMeta     = MIGRATION_CUT_REPOSITORIES['neomjs/neo-stage'];
    const stageProbeAbs = path.join(repoRoots['neomjs/neo-stage'], stageMeta.probeRecord.sourcePath);
    const stageBody     = '# Decision 0001: The Engine Contract\n\nPrivate stage probe.\n';
    const stageHash     = computeMigrationContentHash(stageBody);
    await fs.ensureDir(path.dirname(stageProbeAbs));
    await fs.writeFile(stageProbeAbs, stageBody, 'utf8');

    const cutRepositories = {};
    for (const [ns, repoMeta] of Object.entries(MIGRATION_CUT_REPOSITORIES)) {
        const repoDir = repoRoots[ns];
        for (const args of [['init'], ['config', 'user.email', 'test@neomjs.com'], ['config', 'user.name', 'Neo Test'], ['add', '.'], ['commit', '-m', 'Initial cut fixture']]) {
            execFileSync('git', args, {cwd: repoDir, stdio: 'ignore'});
        }
        const headRev = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {cwd: repoDir, encoding: 'utf8'}).trim();
        cutRepositories[ns] = {...repoMeta, cutRevision: headRev, ...(repoMeta.probeRecord ? {probeRecord: {...repoMeta.probeRecord, contentHash: stageHash}} : {})};
    }
    for (const entry of manifest) entry.sourceTuple.revision = cutRepositories[entry.sourceTuple.namespace].cutRevision;
    return {rootDir, repoRoots, cutRepositories, manifest};
}

/** @summary Creates an in-memory ChromaClient test double supporting `getCollection`, dimension enforcement, `get`, `upsert`, and `delete`. */
function createMockChromaClient(options = {}) {
    const collections    = new Map();
    const seedCollection = name => {
        if (!collections.has(name)) {
            const store         = new Map();
            let   collectionDim = null;
            collections.set(name, {
                name, store,
                async get({ids = []} = {}) {
                    const outIds = [], outEmbeddings = [], outDocuments = [], outMetadatas = [];
                    for (const id of ids) if (store.has(id)) {
                        const row = store.get(id);
                        outIds.push(id); outEmbeddings.push(row.embedding ?? null); outDocuments.push(row.document ?? id); outMetadatas.push(row.metadata ? {...row.metadata} : {});
                    }
                    return {ids: outIds, embeddings: outEmbeddings, documents: outDocuments, metadatas: outMetadatas};
                },
                async upsert({ids = [], embeddings = [], documents = [], metadatas = []} = {}) {
                    for (let i = 0; i < ids.length; i++) {
                        const vec = embeddings[i];
                        if (!Array.isArray(vec) || vec.length <= 1 || !vec.every(v => typeof v === 'number' && Number.isFinite(v))) throw new Error(`Invalid Chroma vector embedding for '${ids[i]}'`);
                        if (collectionDim === null) for (const ex of store.values()) if (Array.isArray(ex?.embedding) && ex.embedding.length > 1) { collectionDim = ex.embedding.length; break; }
                        if (collectionDim === null) collectionDim = vec.length;
                        else if (vec.length !== collectionDim) throw new Error(`Collection expecting embedding with dimension of ${collectionDim}, got ${vec.length}`);
                        store.set(ids[i], {id: ids[i], embedding: vec, document: documents[i] ?? ids[i], metadata: metadatas[i] ? {...metadatas[i]} : {}});
                    }
                },
                async delete({ids = []} = {}) { for (const id of ids) store.delete(id); }
            });
        }
        return collections.get(name);
    };
    return {
        options, collections, seedCollection,
        async getCollection({name}) {
            if (!collections.has(name)) { const err = new Error(`Collection '${name}' does not exist.`); err.name = 'ChromaNotFoundError'; throw err; }
            return collections.get(name);
        }
    };
}

/** @summary Seeds a disposable SQLite database, vectorStore Map, and kbStore Map with the 41-record pre-migration census state. */
function createSeededDisposableStores() {
    const db = new Database(':memory:'), vectorStore = new Map(), kbStore = new Map();
    ensureMigrationTables(db);
    const insertNode = db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)');
    const insertEdge = db.prepare('INSERT INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)');

    for (const node of [
        {id: 'session:neo_recovery', label: 'SESSION', type: 'SESSION', semanticVectorId: SHARED_SUMMARY, properties: {title: 'Recovery Session'}},
        {id: 'vessel-workspace', label: 'CONCEPT', type: 'CONCEPT', semanticVectorId: SHARED_SUMMARY, properties: {name: 'vessel-workspace'}},
        {id: 'apollonian-gasket-layout', label: 'CONCEPT', type: 'CONCEPT', semanticVectorId: SHARED_SUMMARY, properties: {name: 'apollonian-gasket-layout'}},
        {id: 'offscreen-webgl-eye-world', label: 'CONCEPT', type: 'CONCEPT', semanticVectorId: SHARED_SUMMARY, properties: {name: 'offscreen-webgl-eye-world'}},
        {id: 'ISSUE:neomjs/neo#11377', label: 'ISSUE', type: 'ISSUE', semanticVectorId: 'issue-11377', properties: {number: 11377}}
    ]) insertNode.run(node.id, JSON.stringify(node));

    for (const entry of REVIEWED_41_ADR_MIGRATION_MANIFEST) {
        insertNode.run(entry.legacyId, JSON.stringify({
            id        : entry.legacyId, label: entry.observedState.nodeLabel, type: entry.observedState.nodeLabel,
            name      : entry.title, semanticVectorId: entry.observedState.observedSemanticVectorId,
            properties: {
                adrNumber           : entry.adrNumber, title: entry.title, filePath: `learn/agentos/decisions/${entry.fileName}`,
                historicalReferences: entry.adrNumber === '0011' ? ['#11377', 'PULL_REQUEST:#19722', '#999999'] : [...entry.historicalReferences]
            }
        }));
        vectorStore.set(entry.observedState.observedSemanticVectorId, {id: entry.observedState.observedSemanticVectorId, embedding: [0.1, 0.2, 0.3], ownerId: entry.legacyId});
        kbStore.set(entry.legacyId, {id: entry.legacyId, embedding: [0.1, 0.2, 0.3], type: 'adr', title: entry.title, source: `learn/agentos/decisions/${entry.fileName}`});
    }

    vectorStore.set(SHARED_SUMMARY, {id: SHARED_SUMMARY, embedding: [0.5, 0.6, 0.7], ownerId: 'session:neo_recovery'});
    kbStore.set('guide:unrelated-doc', {id: 'guide:unrelated-doc', embedding: [0.2, 0.3, 0.4], type: 'guide', title: 'Unrelated Guide'});

    const adr0006Canonical = REVIEWED_41_ADR_MIGRATION_MANIFEST.find(e => e.adrNumber === '0006').canonicalKey;
    insertEdge.run('edge-legacy-0006-1', 'adr-0006', 'ISSUE:neomjs/neo#11377', 'GOVERNS', JSON.stringify({id: 'edge-legacy-0006-1', source: 'adr-0006', target: 'ISSUE:neomjs/neo#11377', type: 'GOVERNS', weight: 1, properties: {origin: '#11377', provenance: [{step: 'legacy-ingest-1'}]}}));
    insertEdge.run('edge-existing-canonical-0006', adr0006Canonical, 'ISSUE:neomjs/neo#11377', 'GOVERNS', JSON.stringify({id: 'edge-existing-canonical-0006', source: adr0006Canonical, target: 'ISSUE:neomjs/neo#11377', type: 'GOVERNS', weight: 2, properties: {origin: 'ISSUE:neomjs/neo#11377', provenance: [{step: 'pre-existing-canonical'}]}}));
    insertEdge.run('edge-0018-cites-0006', 'adr-0018', 'adr-0006', 'CITES_AUTHORITY', JSON.stringify({id: 'edge-0018-cites-0006', source: 'adr-0018', target: 'adr-0006', type: 'CITES_AUTHORITY', weight: 1, properties: {origin: 'adr-0018', provenance: [{step: 'citation-extract'}]}}));
    insertEdge.run('edge-unrelated', 'session:neo_recovery', 'vessel-workspace', 'MENTIONS', JSON.stringify({id: 'edge-unrelated', source: 'session:neo_recovery', target: 'vessel-workspace', type: 'MENTIONS', weight: 1, properties: {keep: true}}));

    return {db, vectorStore, kbStore};
}

test.describe('migrateLegacyAdrIdentities (#1014 / #1237)', () => {
    test.beforeAll(async () => {
        AdrSource = (await import('../../../../../../ai/services/knowledge-base/source/AdrSource.mjs')).default;
        ({GRAPH_NODE_WRITER_INVENTORY} = await import('../../../../../../ai/services/memory-core/GraphService.mjs'));
        ({
            MIGRATION_PHASES, composeDefaultMigrationStores, computeMigrationContentHash, createAdrMigrationBackup,
            createChromaKbStoreAdapter, createChromaVectorStoreAdapter, createDefaultReaderContext, createDefaultSourceProbe,
            ensureMigrationTables, getUsageText, migrateLegacyAdrIdentities, normalizeHistoricalOriginReference,
            parseArgs, reconcileRebuildAndCustodyControls, restoreAdrMigrationBackup, runCli, verifyMigrationPreconditions
        } = await import('../../../../../../ai/scripts/migrations/migrateLegacyAdrIdentities.mjs'));
        gitWorktreeCutFixture = await createGitWorktreeCutFixture();
    });

    test.afterAll(async () => { if (gitWorktreeCutFixture?.rootDir) await fs.remove(gitWorktreeCutFixture.rootDir); });
    test.beforeEach(() => { resetSharedAdrCatalog(); AdrSource.resetCatalog(); });

    test('AC1 & #1237 compaction/cut-stamp: reviewed 41-record manifest, neo-stage cut stamp, LOC bounds, and writer seam registration', () => {
        expect(REVIEWED_41_ADR_MIGRATION_MANIFEST).toHaveLength(41);
        expect(OBSERVED_11_CENSUS_ANOMALY_NUMBERS).toHaveLength(11);
        expect(OBSERVED_LIVE_ANOMALY_NUMBERS).toHaveLength(12);
        expect(MOVED_FM_ADR_NUMBERS).toEqual(['0020', '0032', '0034', '0037', '0038']);
        expect(Object.keys(MIGRATION_CUT_REPOSITORIES)).toHaveLength(4);
        for (const repo of Object.values(MIGRATION_CUT_REPOSITORIES)) expect(repo.cutRevision).toMatch(/^[0-9a-f]{7,40}$/);

        const stageCut = MIGRATION_CUT_REPOSITORIES['neomjs/neo-stage'];
        expect(stageCut).toMatchObject({
            cutRevision  : 'ca26ffd9',
            territoryRoot: 'learn/agentos/decisions',
            probeRecord  : {sourcePath: 'learn/agentos/decisions/0001-the-engine-contract.md', contentHash: '4a580037288a'}
        });

        const countLines  = relPath => fs.readFileSync(path.join(BRAIN_ROOT_DIR, relPath), 'utf8').split('\n').length - 1;
        const manifestLoc = countLines('ai/scripts/migrations/adrMigrationManifest.mjs');
        const scriptLoc   = countLines('ai/scripts/migrations/migrateLegacyAdrIdentities.mjs');
        const specLoc     = countLines('test/playwright/unit/ai/scripts/migrations/migrateLegacyAdrIdentities.spec.mjs');
        expect(manifestLoc).toBeLessThanOrEqual(220);
        expect(scriptLoc).toBeLessThanOrEqual(1100);
        expect(specLoc).toBeLessThanOrEqual(650);
        expect(5054 - (manifestLoc + scriptLoc + specLoc)).toBeGreaterThanOrEqual(3200);

        const byNamespace      = {'neomjs/neo-agent-brain': 0, 'neomjs/neo': 0, 'neomjs/neo-agent-institution': 0};
        let   conceptAnomalies = 0, classAnomalies = 0;

        for (const entry of REVIEWED_41_ADR_MIGRATION_MANIFEST) {
            byNamespace[entry.sourceTuple.namespace]++;
            expect(entry.legacyId).toBe(`adr-${entry.adrNumber}`);
            expect(entry.canonicalKey).toMatch(/^adr:github\.com:\d+:neomjs%2F[a-z-]+:\d{4}$/);
            expect(entry.assignmentEvidence.verified).toBe(true);
            expect(entry.sourceTuple.contentHash).toMatch(/^[0-9a-f]{12}$/);
            expect(entry.sourceTuple.revision).toMatch(/^[0-9a-f]{7,40}$/);
            expect(Array.isArray(entry.aliases)).toBe(true);
            expect(Array.isArray(entry.historicalAliases)).toBe(true);
            expect(Array.isArray(entry.observedState.reusedVectorOwners)).toBe(true);
            expect(['retain', 'retain-landed-amendment', 'pending']).toContain(entry.semanticDisposition);
            if (OBSERVED_11_CENSUS_ANOMALY_NUMBERS.includes(entry.adrNumber)) {
                if (entry.observedState.nodeLabel === 'CONCEPT') conceptAnomalies++;
                if (entry.observedState.nodeLabel === 'CLASS') classAnomalies++;
                expect(entry.observedState.observedSemanticVectorId).toMatch(/^summary_/);
            }
        }

        expect(byNamespace).toEqual({'neomjs/neo-agent-brain': 29, 'neomjs/neo': 7, 'neomjs/neo-agent-institution': 5});
        expect(conceptAnomalies).toBe(9);
        expect(classAnomalies).toBe(2);

        const adr0038 = REVIEWED_41_ADR_MIGRATION_MANIFEST.find(e => e.adrNumber === '0038');
        expect(adr0038.observedState.anomalyShape).toBe('SHARED_SUMMARY_VECTOR_WITH_NON_ADR_OWNER');
        expect(adr0038.observedState.reusedVectorOwners.map(o => o.nodeId)).toEqual(
            expect.arrayContaining(['session:neo_recovery', 'vessel-workspace', SHARED_SUMMARY, 'workstation-reclaim-embodiment', 'TASK:PR_19722'])
        );

        const adr0041 = REVIEWED_41_ADR_MIGRATION_MANIFEST.find(e => e.adrNumber === '0041');
        expect(adr0041.historicalReferences).toEqual([
            'PULL_REQUEST:neomjs/neo-agent-brain#680', 'ISSUE:neomjs/neo-agent-brain#678',
            'DISCUSSION:neomjs/neo#18965', 'ISSUE:neomjs/neo-agent-institution#351'
        ]);

        const liveProbe         = createDefaultSourceProbe({manifest: gitWorktreeCutFixture.manifest, cutRepositories: gitWorktreeCutFixture.cutRepositories, repoRoots: gitWorktreeCutFixture.repoRoots});
        const liveReaderContext = createDefaultReaderContext({cutRepositories: gitWorktreeCutFixture.cutRepositories, repoRoots: gitWorktreeCutFixture.repoRoots});
        expect(Object.keys(liveProbe.revisions)).toEqual(expect.arrayContaining(['neomjs/neo', 'neomjs/neo-agent-brain', 'neomjs/neo-agent-institution', 'neomjs/neo-stage']));
        expect(Object.keys(liveProbe.contentHashes)).toHaveLength(82);
        expect(verifyMigrationPreconditions({manifest: gitWorktreeCutFixture.manifest, cutRepositories: gitWorktreeCutFixture.cutRepositories, sourceProbe: liveProbe, readerContext: liveReaderContext}).ok).toBe(true);
        expect(GRAPH_NODE_WRITER_INVENTORY.find(w => w.id === 'migrateLegacyAdrIdentities')).toEqual(
            expect.objectContaining({id: 'migrateLegacyAdrIdentities', path: 'ai/scripts/migrations/migrateLegacyAdrIdentities.mjs', canMutateAdrAuthority: true})
        );
    });

    test('AC2: defaults to dry-run and refuses inconsistent proof, duplicate claims, lost provenance, missing stores, or changed preconditions before any write', async () => {
        const {db, vectorStore, kbStore} = createSeededDisposableStores(), sourceProbe = createCompliantSourceProbe(), readerContext = createCompliantReaderContext();
        try {
            expect(parseArgs([])).toMatchObject({dryRun: true, apply: false});
            const dryRunRes = await migrateLegacyAdrIdentities({db, vectorStore, kbStore, sourceProbe, readerContext});
            expect(dryRunRes).toMatchObject({mode: 'dry-run', applied: false, plannedCount: 41});
            expect(db.prepare('SELECT id FROM Nodes WHERE id = ?').get('adr-0001')).toBeTruthy();
            expect(db.prepare('SELECT id FROM Nodes WHERE id = ?').get(REVIEWED_41_ADR_MIGRATION_MANIFEST[0].canonicalKey)).toBeUndefined();
            expect(vectorStore.has('adr-0001')).toBe(true);
            expect(kbStore.has('adr-0001')).toBe(true);

            await expect(migrateLegacyAdrIdentities({db, kbStore, apply: true, sourceProbe, readerContext})).rejects.toMatchObject({code: 'ADR_MIGRATION_VECTOR_STORE_REQUIRED'});
            await expect(migrateLegacyAdrIdentities({db, vectorStore, apply: true, sourceProbe, readerContext})).rejects.toMatchObject({code: 'ADR_MIGRATION_KB_STORE_REQUIRED'});
            await expect(migrateLegacyAdrIdentities({db, vectorStore, kbStore, apply: true, manifest: REVIEWED_41_ADR_MIGRATION_MANIFEST.slice(0, 40), sourceProbe, readerContext})).rejects.toMatchObject({code: 'ADR_MIGRATION_INCOMPLETE_INVENTORY'});

            const badIdentityManifest = REVIEWED_41_ADR_MIGRATION_MANIFEST.map((e, i) => i === 0 ? {...e, canonicalKey: 'adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0099'} : e);
            await expect(migrateLegacyAdrIdentities({db, vectorStore, kbStore, apply: true, manifest: badIdentityManifest, sourceProbe, readerContext})).rejects.toMatchObject({code: 'ADR_MIGRATION_INCONSISTENT_IDENTITY_PROOF'});

            const duplicateClaimManifest = REVIEWED_41_ADR_MIGRATION_MANIFEST.map((e, i) => i === 1 ? {...e, adrNumber: '0001', legacyId: 'adr-0001', canonicalKey: REVIEWED_41_ADR_MIGRATION_MANIFEST[0].canonicalKey} : e);
            await expect(migrateLegacyAdrIdentities({db, vectorStore, kbStore, apply: true, manifest: duplicateClaimManifest, sourceProbe, readerContext})).rejects.toMatchObject({code: 'ADR_MIGRATION_DUPLICATE_CANONICAL_CLAIM'});

            const lostProvenanceManifest = REVIEWED_41_ADR_MIGRATION_MANIFEST.map((e, i) => i === 0 ? {...e, sourceTuple: {...e.sourceTuple, contentHash: ''}} : e);
            await expect(migrateLegacyAdrIdentities({db, vectorStore, kbStore, apply: true, manifest: lostProvenanceManifest, sourceProbe, readerContext})).rejects.toMatchObject({code: 'ADR_MIGRATION_LOST_PROVENANCE'});

            const missingOwnersManifest = REVIEWED_41_ADR_MIGRATION_MANIFEST.map(e => e.adrNumber === '0038' ? {...e, observedState: {...e.observedState, reusedVectorOwners: []}} : e);
            await expect(migrateLegacyAdrIdentities({db, vectorStore, kbStore, apply: true, manifest: missingOwnersManifest, sourceProbe, readerContext})).rejects.toMatchObject({code: 'ADR_MIGRATION_INCOMPLETE_VECTOR_OWNER_INVENTORY'});

            await expect(migrateLegacyAdrIdentities({
                db, vectorStore, kbStore, apply: true,
                sourceProbe: {...sourceProbe, revisions: {...sourceProbe.revisions, 'neomjs/neo': 'deadbeef'}}, readerContext
            })).rejects.toMatchObject({code: 'ADR_MIGRATION_SOURCE_PRECONDITION_CHANGED'});

            const probeMissingOneHash = {...sourceProbe, contentHashes: {...sourceProbe.contentHashes}};
            delete probeMissingOneHash.contentHashes[REVIEWED_41_ADR_MIGRATION_MANIFEST[0].legacyId];
            delete probeMissingOneHash.contentHashes[REVIEWED_41_ADR_MIGRATION_MANIFEST[0].canonicalKey];
            await expect(migrateLegacyAdrIdentities({db, vectorStore, kbStore, apply: true, sourceProbe: probeMissingOneHash, readerContext})).rejects.toMatchObject({code: 'ADR_MIGRATION_SOURCE_PRECONDITION_CHANGED'});

            db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run('adr-0099', JSON.stringify({id: 'adr-0099', label: 'ADR'}));
            await expect(migrateLegacyAdrIdentities({db, vectorStore, kbStore, apply: true, sourceProbe, readerContext})).rejects.toMatchObject({code: 'ADR_MIGRATION_DATA_PRECONDITION_CHANGED'});
        } finally { db.close(); }
    });

    test('AC3: disposable-state migration relabels 11 anomaly nodes, detaches shared summary vector without harming non-ADR owners, preserves edge provenance, and normalizes origins', async () => {
        const {db, vectorStore, kbStore} = createSeededDisposableStores(), sourceProbe = createCompliantSourceProbe(), readerContext = createCompliantReaderContext();
        try {
            const result = await migrateLegacyAdrIdentities({db, vectorStore, kbStore, apply: true, sourceProbe, readerContext});
            expect(result).toMatchObject({applied: true, phase: 'completed', migratedNodesCount: 41, relabeledNodesCount: 12});
            expect(db.prepare("SELECT id FROM Nodes WHERE id LIKE 'adr-%'").all()).toHaveLength(0);
            const canonicalNodes = db.prepare("SELECT id, data FROM Nodes WHERE id LIKE 'adr:%'").all();
            expect(canonicalNodes).toHaveLength(41);

            for (const row of canonicalNodes) {
                const parsed = JSON.parse(row.data);
                expect(parsed).toMatchObject({label: 'ADR', type: 'ADR', semanticVectorId: row.id});
                expect(parsed.properties.adrAuthority).toMatchObject({admitted: true, writer: 'migrateLegacyAdrIdentities'});
            }

            const adr0038Entry = REVIEWED_41_ADR_MIGRATION_MANIFEST.find(e => e.adrNumber === '0038');
            const adr0038Node  = JSON.parse(db.prepare('SELECT data FROM Nodes WHERE id = ?').get(adr0038Entry.canonicalKey).data);
            expect(adr0038Node.semanticVectorId).toBe(adr0038Entry.canonicalKey);
            expect(adr0038Node.properties.adrAuthority.vectorProvenance).toEqual({
                previousSemanticVectorId   : SHARED_SUMMARY,
                detachedSummaryVector      : true,
                preservedSharedVectorOwners: ['session:neo_recovery', 'vessel-workspace', SHARED_SUMMARY, 'workstation-reclaim-embodiment', 'TASK:PR_19722']
            });

            expect(JSON.parse(db.prepare('SELECT data FROM Nodes WHERE id = ?').get('session:neo_recovery').data).semanticVectorId).toBe(SHARED_SUMMARY);
            expect(vectorStore.has(SHARED_SUMMARY)).toBe(true);

            const adr0011Entry = REVIEWED_41_ADR_MIGRATION_MANIFEST.find(e => e.adrNumber === '0011');
            expect(JSON.parse(db.prepare('SELECT data FROM Nodes WHERE id = ?').get(adr0011Entry.canonicalKey).data).properties.historicalReferences)
                .toEqual(['#11377', 'PULL_REQUEST:neomjs/neo-agent-brain#19722', '#999999']);

            const adr0041Entry = REVIEWED_41_ADR_MIGRATION_MANIFEST.find(e => e.adrNumber === '0041');
            expect(JSON.parse(db.prepare('SELECT data FROM Nodes WHERE id = ?').get(adr0041Entry.canonicalKey).data).properties.historicalReferences)
                .toEqual(['PULL_REQUEST:neomjs/neo-agent-brain#680', 'ISSUE:neomjs/neo-agent-brain#678', 'DISCUSSION:neomjs/neo#18965', 'ISSUE:neomjs/neo-agent-institution#351']);

            expect(normalizeHistoricalOriginReference('#680', 'neomjs/neo', adr0041Entry.historicalReferences)).toBe('PULL_REQUEST:neomjs/neo-agent-brain#680');
            expect(normalizeHistoricalOriginReference('#18965', 'neomjs/neo-agent-brain', adr0041Entry.historicalReferences)).toBe('DISCUSSION:neomjs/neo#18965');
            expect(normalizeHistoricalOriginReference('#424242', 'neomjs/neo-agent-brain', adr0041Entry.historicalReferences)).toBe('#424242');

            const adr0006Entry = REVIEWED_41_ADR_MIGRATION_MANIFEST.find(e => e.adrNumber === '0006');
            const adr0018Entry = REVIEWED_41_ADR_MIGRATION_MANIFEST.find(e => e.adrNumber === '0018');
            const governsEdge  = db.prepare('SELECT * FROM Edges WHERE source = ? AND target = ? AND type = ?').get(adr0006Entry.canonicalKey, 'ISSUE:neomjs/neo#11377', 'GOVERNS');
            expect(governsEdge).toBeTruthy();

            const governsData = JSON.parse(governsEdge.data);
            expect(governsData.weight).toBe(2);
            expect(governsData.properties.provenance).toEqual([{step: 'pre-existing-canonical'}, {step: 'legacy-ingest-1'}]);
            expect(governsData.properties.migratedFromEdgeIds).toEqual(expect.arrayContaining(['edge-existing-canonical-0006', 'edge-legacy-0006-1']));

            const citesEdge = db.prepare('SELECT * FROM Edges WHERE source = ? AND target = ? AND type = ?').get(adr0018Entry.canonicalKey, adr0006Entry.canonicalKey, 'CITES_AUTHORITY');
            expect(citesEdge).toBeTruthy();
            expect(JSON.parse(citesEdge.data).properties.origin).toBe(adr0018Entry.canonicalKey);
        } finally { db.close(); }
    });

    test('AC4: interrupted cross-store phases resume deterministically, completed reruns no-op, and backup/restore preserves unrelated consumers', async () => {
        const {db, vectorStore, kbStore} = createSeededDisposableStores();
        const tmpDir                     = await fs.mkdtemp(path.join(os.tmpdir(), 'adr-migration-1014-')), backupPath = path.join(tmpDir, 'pre-migration-backup.json');
        const sourceProbe                = createCompliantSourceProbe(), readerContext = createCompliantReaderContext();
        try {
            for (const phaseToInterrupt of ['preconditions_verified', 'backup_created', 'graph_sqlite_applied', 'vector_store_applied', 'kb_projection_applied', 'reader_verified']) {
                await expect(migrateLegacyAdrIdentities({db, vectorStore, kbStore, apply: true, backupPath, sourceProbe, readerContext, failAfterPhase: phaseToInterrupt}))
                    .rejects.toMatchObject({code: 'ADR_MIGRATION_INTERRUPTED_FOR_TEST'});
                const journalRow = db.prepare('SELECT phase, completed_phases FROM AdrIdentityMigrationJournal WHERE migration_id = ?').get('adr-legacy-41-cut-v1');
                expect(journalRow.phase).toBe(phaseToInterrupt);
                expect(JSON.parse(journalRow.completed_phases)).toContain(phaseToInterrupt);
            }

            const completedRes = await migrateLegacyAdrIdentities({db, vectorStore, kbStore, apply: true, backupPath, sourceProbe, readerContext});
            expect(completedRes).toMatchObject({applied: true, resumed: true, phase: 'completed', completedPhases: [...MIGRATION_PHASES]});

            const rerunRes = await migrateLegacyAdrIdentities({db, vectorStore, kbStore, apply: true, backupPath, sourceProbe, readerContext});
            expect(rerunRes).toMatchObject({noOpRerun: true, applied: false, phase: 'completed'});

            expect(restoreAdrMigrationBackup({db, vectorStore, kbStore, backupPath}).restored).toBe(true);
            expect(db.prepare("SELECT id FROM Nodes WHERE id LIKE 'adr-%'").all()).toHaveLength(41);
            expect(db.prepare("SELECT id FROM Nodes WHERE id LIKE 'adr:%'").all()).toHaveLength(0);
            expect(db.prepare('SELECT id FROM Nodes WHERE id = ?').get('session:neo_recovery')).toBeTruthy();
            expect(db.prepare('SELECT id FROM Edges WHERE id = ?').get('edge-unrelated')).toBeTruthy();
            expect(vectorStore.has(SHARED_SUMMARY)).toBe(true);
            expect(kbStore.has('guide:unrelated-doc')).toBe(true);
        } finally { db.close(); await fs.remove(tmpDir); }
    });

    test('AC5 & AC6: runbook binds manifest/reader versions, CLI Chroma adapters support standalone backup/apply/restore, and migrated records use shared admission catalog with historical 0001..0041 alias scope and FM reservations', async () => {
        expect(ADR_MIGRATION_RUNBOOK).toMatchObject({
            manifestVersion           : MIGRATION_MANIFEST_VERSION, manifestRecordCount: 41,
            requiredReaderCapabilities: {adrSource: 'ai/services/knowledge-base/source/AdrSource.mjs'}
        });
        expect(ADR_MIGRATION_RUNBOOK.postMergeLiveApplyBoundary).toContain('post-merge acceptance');
        expect(getUsageText()).toContain('--runbook');

        const
            {db, vectorStore, kbStore} = createSeededDisposableStores(),
            tmpDir                     = await fs.mkdtemp(path.join(os.tmpdir(), 'adr-cli-chroma-1014-')),
            dbPath                     = path.join(tmpDir, 'disposable-graph.sqlite'),
            standaloneBackupPath       = path.join(tmpDir, 'standalone-backup.json'),
            applyBackupPath            = path.join(tmpDir, 'apply-backup.json'),
            createdClientOptions       = [],
            mockChromaClient           = createMockChromaClient(),
            embeddedAnomalyRecords     = [],
            mockEmbedText              = async (text, entry) => { embeddedAnomalyRecords.push({adrNumber: entry?.adrNumber, length: text.length}); return [0.4, 0.5, 0.6]; },
            chromaVectorStore          = createChromaVectorStoreAdapter({client: mockChromaClient, collectionName: 'neo-native-graph', embedText: mockEmbedText}),
            chromaKbStore              = createChromaKbStoreAdapter({client: mockChromaClient, collectionName: 'neo-knowledge-base', embedText: mockEmbedText});

        composeDefaultMigrationStores({clientFactory: options => { createdClientOptions.push(options); return createMockChromaClient(options); }});
        expect(createdClientOptions).toHaveLength(2);
        expect(createdClientOptions[0].database).toBeTruthy();
        expect(createdClientOptions[1].database).toBeTruthy();

        await expect(chromaVectorStore.exportSnapshot()).rejects.toThrow(/does not exist/);
        await expect(chromaKbStore.exportSnapshot()).rejects.toThrow(/does not exist/);
        expect(mockChromaClient.collections.size).toBe(0);

        try {
            const fileDb = new Database(dbPath);
            fileDb.exec('CREATE TABLE Nodes (id TEXT PRIMARY KEY, data TEXT); CREATE TABLE Edges (id TEXT PRIMARY KEY, source TEXT, target TEXT, type TEXT, data TEXT);');
            const insertFileNode = fileDb.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)');
            for (const row of db.prepare('SELECT id, data FROM Nodes').all()) insertFileNode.run(row.id, row.data);
            const insertFileEdge = fileDb.prepare('INSERT INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)');
            for (const row of db.prepare('SELECT id, source, target, type, data FROM Edges').all()) insertFileEdge.run(row.id, row.source, row.target, row.type, row.data);
            fileDb.close();

            const graphCollection = mockChromaClient.seedCollection('neo-native-graph'), kbCollection = mockChromaClient.seedCollection('neo-knowledge-base');
            for (const [k, v] of vectorStore.entries()) graphCollection.store.set(k, v);
            for (const [k, v] of kbStore.entries()) kbCollection.store.set(k, v);

            const badVectorAdapter = createChromaVectorStoreAdapter({client: mockChromaClient, collectionName: 'neo-native-graph', embedText: async () => [0]});
            await expect(badVectorAdapter.applyAdrMigration()).rejects.toMatchObject({code: 'ADR_MIGRATION_VECTOR_EMBEDDING_REQUIRED'});
            await expect(chromaVectorStore.restoreSnapshot([['adr-0001', {id: 'adr-0001', embedding: [0]}]])).rejects.toMatchObject({code: 'ADR_MIGRATION_VECTOR_EMBEDDING_REQUIRED'});
            const wrongDimAdapter = createChromaVectorStoreAdapter({client: mockChromaClient, collectionName: 'neo-native-graph', embedText: async () => [0.1, 0.2, 0.3, 0.4, 0.5]});
            await expect(wrongDimAdapter.applyAdrMigration()).rejects.toMatchObject({code: 'ADR_MIGRATION_VECTOR_DIMENSION_MISMATCH'});

            const standaloneBackupRes = await runCli(['--db', dbPath, '--backup', standaloneBackupPath], {
                vectorStore: chromaVectorStore, kbStore: chromaKbStore, sourceProbe: createCompliantSourceProbe(), readerContext: createCompliantReaderContext(), silent: true
            });
            expect(standaloneBackupRes).toMatchObject({mode: 'backup', applied: false});
            expect(await fs.pathExists(standaloneBackupPath)).toBe(true);
            expect(graphCollection.store.has('adr-0001')).toBe(true);
            expect(kbCollection.store.has('adr-0001')).toBe(true);

            const cliApplyRes = await runCli(['--db', dbPath, '--apply', '--backup', applyBackupPath], {
                vectorStore: chromaVectorStore, kbStore: chromaKbStore, sourceProbe: createCompliantSourceProbe(), readerContext: createCompliantReaderContext(), silent: true
            });
            expect(cliApplyRes).toMatchObject({applied: true, phase: 'completed', upsertedVectorsCount: 41, migratedKbEntriesCount: 41});
            expect(embeddedAnomalyRecords).toHaveLength(12);

            const adr0001Key = REVIEWED_41_ADR_MIGRATION_MANIFEST[0].canonicalKey;
            const adr0004Key = REVIEWED_41_ADR_MIGRATION_MANIFEST.find(e => e.adrNumber === '0004').canonicalKey;
            expect(graphCollection.store.has('adr-0001')).toBe(false);
            expect(graphCollection.store.has(adr0001Key)).toBe(true);
            expect(graphCollection.store.get(adr0004Key).embedding).toEqual([0.4, 0.5, 0.6]);
            expect(kbCollection.store.has('adr-0001')).toBe(false);
            expect(kbCollection.store.has(adr0001Key)).toBe(true);
            expect(graphCollection.store.has(SHARED_SUMMARY)).toBe(true);
            expect(kbCollection.store.has('guide:unrelated-doc')).toBe(true);

            const reloadedVectorStore = createChromaVectorStoreAdapter({client: mockChromaClient, collectionName: 'neo-native-graph', embedText: mockEmbedText});
            const reloadedKbStore     = createChromaKbStoreAdapter({client: mockChromaClient, collectionName: 'neo-knowledge-base', embedText: mockEmbedText});
            const exportedAfterApply  = await reloadedVectorStore.exportSnapshot();
            expect(exportedAfterApply.some(([id]) => id === adr0001Key)).toBe(true);
            expect(exportedAfterApply.some(([id]) => id === 'adr-0001')).toBe(false);
            expect(SHARED_ADR_CATALOG_STATE.admissionCatalog.size).toBe(41);

            const fm0020 = REVIEWED_41_ADR_MIGRATION_MANIFEST.find(e => e.adrNumber === '0020');
            expect(AdrSource.resolveAdrReference('adr-0020', {namespace: 'neomjs/neo-agent-institution'})).toMatchObject({resolved: true, canonicalKey: fm0020.canonicalKey});
            expect(AdrSource.resolveAdrReference('adr-0020', {namespace: 'neomjs/neo'})).toMatchObject({resolved: true, canonicalKey: fm0020.canonicalKey});

            const neoBucket = ensureSharedReservationBucket('github.com', '220867748');
            for (const movedNum of MOVED_FM_ADR_NUMBERS) expect(neoBucket.numbers.has(movedNum)).toBe(true);
            expect(AdrSource.resolveAdrReference('adr-0042', {namespace: 'neomjs/neo-agent-brain'}).resolved).toBe(false);

            const cliRestoreRes = await runCli(['--db', dbPath, '--restore', applyBackupPath], {vectorStore: reloadedVectorStore, kbStore: reloadedKbStore, silent: true});
            expect(cliRestoreRes.restored).toBe(true);
            expect(graphCollection.store.has('adr-0001')).toBe(true);
            expect(graphCollection.store.has(adr0001Key)).toBe(false);
            expect(kbCollection.store.has('adr-0001')).toBe(true);
            expect(kbCollection.store.has(adr0001Key)).toBe(false);
        } finally { db.close(); await fs.remove(tmpDir); }
    });

    test('AC7: rebuild and custody-move failure controls handle rename, custody move, combined move+rename, source loss, and admission-record loss', async () => {
        const baseRecord0042 = {
            canonicalKey      : 'adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0042', adrNumber: '0042', title: 'Decision Forty-Two',
            status            : 'Accepted', currentSlug: 'old-slug', fileName: '0042-old-slug.md', sourcePath: 'learn/agentos/decisions/0042-old-slug.md',
            assignmentEvidence: {forge: 'github.com', repositoryId: '1344062228', namespace: 'neomjs/neo-agent-brain', verified: true},
            sourceTuple       : {forge: 'github.com', repositoryId: '1344062228', namespace: 'neomjs/neo-agent-brain', revision: 'HEAD', path: 'learn/agentos/decisions/0042-old-slug.md', contentHash: '111122223333'},
            documentAvailable : true, kbAvailable: true, stale: false, historicalAliases: ['old-slug'],
            aliasBindings     : [
                {kind: 'slug', value: 'old-slug', forge: 'github.com', repositoryId: '1344062228', namespace: 'neomjs/neo-agent-brain', targetKey: 'adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0042', current: true},
                {kind: 'legacy-number', value: '0042', forge: 'github.com', repositoryId: '1344062228', namespace: 'neomjs/neo-agent-brain', targetKey: 'adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0042', current: true}
            ],
            reservations: [], provenance: {custodyTransitions: [], repositoryRenames: [], sourceLineage: []}
        };

        const renameRebuild = await reconcileRebuildAndCustodyControls({
            retainedAdmissionRecords: [baseRecord0042],
            repositories            : [{forge: 'github.com', repositoryId: '1344062228', namespace: 'neomjs/neo-agent-brain', files: {'learn/agentos/decisions/0042-new-slug.md': '# ADR 0042: Decision Forty-Two\n\n| Attribute | Value |\n| :--- | :--- |\n| **Status** | Accepted |\n| **Aliases** | `old-slug` |\n\n## Context\nRenamed slug within same repository.'}}]
        });
        expect(renameRebuild.reconciliation[baseRecord0042.canonicalKey].documentAvailable).toBe(true);
        expect(AdrSource.resolveAdrReference('adr:new-slug', {namespace: 'neomjs/neo-agent-brain'}).canonicalKey).toBe(baseRecord0042.canonicalKey);
        expect(AdrSource.resolveAdrReference('adr:old-slug', {namespace: 'neomjs/neo-agent-brain'}).canonicalKey).toBe(baseRecord0042.canonicalKey);

        const combinedMoveRebuild = await reconcileRebuildAndCustodyControls({
            retainedAdmissionRecords: [baseRecord0042],
            custodyTransitions      : [{adrNumber: '0042', canonicalKey: baseRecord0042.canonicalKey, fromForge: 'github.com', fromRepositoryId: '1344062228', fromNamespace: 'neomjs/neo-agent-brain', toForge: 'github.com', toRepositoryId: '1347756127', toNamespace: 'neomjs/neo-agent-institution', proof: 'verified-move-0042', verified: true}],
            repositories            : [
                {forge: 'github.com', repositoryId: '1344062228', namespace: 'neomjs/neo-agent-brain', files: {'learn/agentos/decisions/0042-old-slug.md': `---\ntype: redirect\ntarget: ${baseRecord0042.canonicalKey}\n---\n# Moved`}},
                {forge: 'github.com', repositoryId: '1347756127', namespace: 'neomjs/neo-agent-institution', files: {'learn/agentos/decisions/0042-moved-new-slug.md': '# ADR 0042: Decision Forty-Two\n\n| Attribute | Value |\n| :--- | :--- |\n| **Status** | Accepted |\n| **Aliases** | `old-slug` |\n\n## Context\nMoved custody and renamed slug.'}}
            ]
        });
        expect(combinedMoveRebuild.refusedCandidates).toHaveLength(0);
        expect(AdrSource.resolveAdrReference('adr:moved-new-slug', {namespace: 'neomjs/neo-agent-institution'}).canonicalKey).toBe(baseRecord0042.canonicalKey);
        expect(AdrSource.resolveAdrReference('adr:old-slug', {namespace: 'neomjs/neo-agent-brain'}).canonicalKey).toBe(baseRecord0042.canonicalKey);

        const sourceLossRebuild = await reconcileRebuildAndCustodyControls({
            retainedAdmissionRecords: [baseRecord0042],
            repositories            : [{forge: 'github.com', repositoryId: '1344062228', namespace: 'neomjs/neo-agent-brain', files: {}}]
        });
        expect(sourceLossRebuild.reconciliation[baseRecord0042.canonicalKey]).toMatchObject({identityResolved: true, documentAvailable: false, kbAvailable: false, stale: true});

        const refusalRebuild = await reconcileRebuildAndCustodyControls({
            retainedAdmissionRecords: [baseRecord0042], custodyTransitions: [],
            repositories            : [{forge: 'github.com', repositoryId: '1347756127', namespace: 'neomjs/neo-agent-institution', files: {'learn/agentos/decisions/0042-unverified-move.md': '# ADR 0042: Unverified Move\n\nBody', 'learn/agentos/decisions/0099-no-admission-record.md': '# ADR 0099: Unadmitted\n\nBody'}}]
        });
        expect(refusalRebuild.refusedCandidates).toEqual(expect.arrayContaining([
            expect.objectContaining({adrNumber: '0042', reasonCode: 'ADR_CUSTODY_TRANSITION_UNVERIFIED'}),
            expect.objectContaining({adrNumber: '0099', reasonCode: 'ADR_ADMISSION_EVIDENCE_MISSING'})
        ]));
    });

    test('AC8: revalidates reader authorization for private neomjs/neo-stage from manifest-derived probeRecord before cut', () => {
        const
            liveProbe  = createDefaultSourceProbe({manifest: gitWorktreeCutFixture.manifest, cutRepositories: gitWorktreeCutFixture.cutRepositories, repoRoots: gitWorktreeCutFixture.repoRoots}),
            liveReader = createDefaultReaderContext({cutRepositories: gitWorktreeCutFixture.cutRepositories, repoRoots: gitWorktreeCutFixture.repoRoots});

        expect(() => verifyMigrationPreconditions({
            manifest   : gitWorktreeCutFixture.manifest, cutRepositories: gitWorktreeCutFixture.cutRepositories,
            sourceProbe: liveProbe, readerContext: {authorizedNamespaces: ['neomjs/neo', 'neomjs/neo-agent-brain']}
        })).toThrow(expect.objectContaining({code: 'ADR_MIGRATION_READER_PRECONDITION_FAILED'}));

        const cutReposWithoutStageProbe = {...gitWorktreeCutFixture.cutRepositories, 'neomjs/neo-stage': {...gitWorktreeCutFixture.cutRepositories['neomjs/neo-stage'], probeRecord: null}};
        expect(() => verifyMigrationPreconditions({manifest: gitWorktreeCutFixture.manifest, cutRepositories: cutReposWithoutStageProbe, sourceProbe: liveProbe, readerContext: liveReader}))
            .toThrow(expect.objectContaining({code: 'ADR_MIGRATION_STAGE_POLICY_MISSING'}));

        expect(verifyMigrationPreconditions({manifest: gitWorktreeCutFixture.manifest, cutRepositories: gitWorktreeCutFixture.cutRepositories, sourceProbe: liveProbe, readerContext: liveReader}).ok).toBe(true);

        const missingRepoProbe = createDefaultSourceProbe({
            manifest : gitWorktreeCutFixture.manifest, cutRepositories: gitWorktreeCutFixture.cutRepositories,
            repoRoots: {...gitWorktreeCutFixture.repoRoots, 'neomjs/neo': path.join(os.tmpdir(), 'nonexistent-neo-checkout-1014')}
        });
        expect(missingRepoProbe.revisions['neomjs/neo']).toBeUndefined();
        expect(missingRepoProbe.contentHashes['adr-0004']).toBeUndefined();
        expect(() => verifyMigrationPreconditions({manifest: gitWorktreeCutFixture.manifest, cutRepositories: gitWorktreeCutFixture.cutRepositories, sourceProbe: missingRepoProbe, readerContext: liveReader}))
            .toThrow(expect.objectContaining({code: 'ADR_MIGRATION_SOURCE_PRECONDITION_CHANGED'}));

        const missingStageReaderContext = createDefaultReaderContext({
            cutRepositories: gitWorktreeCutFixture.cutRepositories,
            repoRoots      : {...gitWorktreeCutFixture.repoRoots, 'neomjs/neo-stage': path.join(os.tmpdir(), 'nonexistent-stage-checkout-1014')}
        });
        expect(missingStageReaderContext.authorizedNamespaces).not.toContain('neomjs/neo-stage');
        expect(() => verifyMigrationPreconditions({manifest: gitWorktreeCutFixture.manifest, cutRepositories: gitWorktreeCutFixture.cutRepositories, sourceProbe: liveProbe, readerContext: missingStageReaderContext}))
            .toThrow(expect.objectContaining({code: 'ADR_MIGRATION_READER_PRECONDITION_FAILED'}));
    });
});

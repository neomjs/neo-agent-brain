import {setup} from '../../../../setup.mjs';

const appName = 'MigrateLegacyAdrIdentitiesTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect} from '@playwright/test';
import Database       from 'better-sqlite3';
import fs             from 'fs-extra';
import os             from 'os';
import path           from 'path';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import {
    SHARED_ADR_CATALOG_STATE,
    ensureSharedReservationBucket,
    resetSharedAdrCatalog
} from '../../../../../../ai/services/ingestion/adrAdmissionCatalog.mjs';
import {
    ADR_MIGRATION_RUNBOOK,
    MIGRATION_CUT_REPOSITORIES,
    MIGRATION_MANIFEST_VERSION,
    MOVED_FM_ADR_NUMBERS,
    OBSERVED_11_CENSUS_ANOMALY_NUMBERS,
    OBSERVED_LIVE_ANOMALY_NUMBERS,
    REVIEWED_41_ADR_MIGRATION_MANIFEST
} from '../../../../../../ai/scripts/migrations/adrMigrationManifest.mjs';

let AdrSource;
let GRAPH_NODE_WRITER_INVENTORY;
let MIGRATION_PHASES;
let createAdrMigrationBackup;
let ensureMigrationTables;
let getUsageText;
let migrateLegacyAdrIdentities;
let parseArgs;
let reconcileRebuildAndCustodyControls;
let restoreAdrMigrationBackup;
let verifyMigrationPreconditions;

/**
 * @summary Seeds a disposable SQLite database, vectorStore Map, and kbStore Map with the
 * 41-record pre-migration census state (including the 11 anomaly shapes, shared summary vector
 * `summary_7c49107b-04f0-4e9c-ad86-65513999d61b` with non-ADR owners, and incident edges).
 * @returns {{db: Object, vectorStore: Map, kbStore: Map}}
 */
function createSeededDisposableStores() {
    const
        db          = new Database(':memory:'),
        vectorStore = new Map(),
        kbStore     = new Map();

    ensureMigrationTables(db);

    const
        insertNode = db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)'),
        insertEdge = db.prepare('INSERT INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)');

    // Seed unrelated graph nodes and non-ADR owners of the shared summary vector
    const nonAdrNodes = [
        {
            id              : 'session:neo_recovery',
            label           : 'SESSION',
            type            : 'SESSION',
            semanticVectorId: 'summary_7c49107b-04f0-4e9c-ad86-65513999d61b',
            properties      : {title: 'Recovery Session'}
        },
        {
            id              : 'vessel-workspace',
            label           : 'CONCEPT',
            type            : 'CONCEPT',
            semanticVectorId: 'summary_7c49107b-04f0-4e9c-ad86-65513999d61b',
            properties      : {name: 'vessel-workspace'}
        },
        {
            id              : 'apollonian-gasket-layout',
            label           : 'CONCEPT',
            type            : 'CONCEPT',
            semanticVectorId: 'summary_7c49107b-04f0-4e9c-ad86-65513999d61b',
            properties      : {name: 'apollonian-gasket-layout'}
        },
        {
            id              : 'offscreen-webgl-eye-world',
            label           : 'CONCEPT',
            type            : 'CONCEPT',
            semanticVectorId: 'summary_7c49107b-04f0-4e9c-ad86-65513999d61b',
            properties      : {name: 'offscreen-webgl-eye-world'}
        },
        {
            id              : 'ISSUE:neomjs/neo#11377',
            label           : 'ISSUE',
            type            : 'ISSUE',
            semanticVectorId: 'issue-11377',
            properties      : {number: 11377}
        }
    ];

    for (const node of nonAdrNodes) {
        insertNode.run(node.id, JSON.stringify(node));
    }

    // Seed all 41 legacy ADR nodes and their observed vector/KB/edge states
    for (const entry of REVIEWED_41_ADR_MIGRATION_MANIFEST) {
        const legacyNode = {
            id              : entry.legacyId,
            label           : entry.observedState.nodeLabel,
            type            : entry.observedState.nodeLabel,
            name            : entry.title,
            semanticVectorId: entry.observedState.observedSemanticVectorId,
            properties      : {
                adrNumber           : entry.adrNumber,
                title               : entry.title,
                filePath            : `learn/agentos/decisions/${entry.fileName}`,
                historicalReferences: entry.adrNumber === '0011'
                    ? ['#11377', 'PULL_REQUEST:#19722']
                    : [...entry.historicalReferences]
            }
        };
        insertNode.run(entry.legacyId, JSON.stringify(legacyNode));

        vectorStore.set(entry.observedState.observedSemanticVectorId, {
            id       : entry.observedState.observedSemanticVectorId,
            embedding: [0.1, 0.2, 0.3],
            ownerId  : entry.legacyId
        });

        kbStore.set(entry.legacyId, {
            id    : entry.legacyId,
            type  : 'adr',
            title : entry.title,
            source: `learn/agentos/decisions/${entry.fileName}`
        });
    }

    // Also seed an unrelated KB document
    kbStore.set('guide:unrelated-doc', {
        id   : 'guide:unrelated-doc',
        type : 'guide',
        title: 'Unrelated Guide'
    });

    // Seed incident edges including a duplicate-collapse pair onto an issue target
    const adr0006Canonical = REVIEWED_41_ADR_MIGRATION_MANIFEST.find(e => e.adrNumber === '0006').canonicalKey;
    insertEdge.run(
        'edge-legacy-0006-1',
        'adr-0006',
        'ISSUE:neomjs/neo#11377',
        'GOVERNS',
        JSON.stringify({
            id        : 'edge-legacy-0006-1',
            source    : 'adr-0006',
            target    : 'ISSUE:neomjs/neo#11377',
            type      : 'GOVERNS',
            weight    : 1,
            properties: {
                origin    : '#11377',
                provenance: [{step: 'legacy-ingest-1'}]
            }
        })
    );
    insertEdge.run(
        'edge-existing-canonical-0006',
        adr0006Canonical,
        'ISSUE:neomjs/neo#11377',
        'GOVERNS',
        JSON.stringify({
            id        : 'edge-existing-canonical-0006',
            source    : adr0006Canonical,
            target    : 'ISSUE:neomjs/neo#11377',
            type      : 'GOVERNS',
            weight    : 2,
            properties: {
                origin    : 'ISSUE:neomjs/neo#11377',
                provenance: [{step: 'pre-existing-canonical'}]
            }
        })
    );

    // Seed cross-ADR edge between two legacy ADR nodes
    insertEdge.run(
        'edge-0018-cites-0006',
        'adr-0018',
        'adr-0006',
        'CITES_AUTHORITY',
        JSON.stringify({
            id        : 'edge-0018-cites-0006',
            source    : 'adr-0018',
            target    : 'adr-0006',
            type      : 'CITES_AUTHORITY',
            weight    : 1,
            properties: {
                origin    : 'adr-0018',
                provenance: [{step: 'citation-extract'}]
            }
        })
    );

    // Seed an unrelated edge between non-ADR nodes
    insertEdge.run(
        'edge-unrelated',
        'session:neo_recovery',
        'vessel-workspace',
        'MENTIONS',
        JSON.stringify({
            id        : 'edge-unrelated',
            source    : 'session:neo_recovery',
            target    : 'vessel-workspace',
            type      : 'MENTIONS',
            weight    : 1,
            properties: {keep: true}
        })
    );

    return {db, vectorStore, kbStore};
}

test.describe('migrateLegacyAdrIdentities (#1014)', () => {
    test.beforeAll(async () => {
        AdrSource = (await import('../../../../../../ai/services/knowledge-base/source/AdrSource.mjs')).default;
        ({GRAPH_NODE_WRITER_INVENTORY} = await import('../../../../../../ai/services/memory-core/GraphService.mjs'));
        ({
            MIGRATION_PHASES,
            createAdrMigrationBackup,
            ensureMigrationTables,
            getUsageText,
            migrateLegacyAdrIdentities,
            parseArgs,
            reconcileRebuildAndCustodyControls,
            restoreAdrMigrationBackup,
            verifyMigrationPreconditions
        } = await import('../../../../../../ai/scripts/migrations/migrateLegacyAdrIdentities.mjs'));
    });

    test.beforeEach(() => {
        resetSharedAdrCatalog();
        AdrSource.resetCatalog();
    });

    test('AC1: reviewed 41-record manifest, shared vector owner inventory, and writer seam registration', () => {
        expect(REVIEWED_41_ADR_MIGRATION_MANIFEST).toHaveLength(41);
        expect(OBSERVED_11_CENSUS_ANOMALY_NUMBERS).toHaveLength(11);
        expect(OBSERVED_LIVE_ANOMALY_NUMBERS).toHaveLength(12);
        expect(MOVED_FM_ADR_NUMBERS).toEqual(['0020', '0032', '0034', '0037', '0038']);

        const byNamespace = {
            'neomjs/neo-agent-brain'      : 0,
            'neomjs/neo'                  : 0,
            'neomjs/neo-agent-institution': 0
        };

        let conceptAnomalies = 0;
        let classAnomalies   = 0;

        for (const entry of REVIEWED_41_ADR_MIGRATION_MANIFEST) {
            byNamespace[entry.sourceTuple.namespace]++;
            expect(entry.legacyId).toBe(`adr-${entry.adrNumber}`);
            expect(entry.canonicalKey).toMatch(/^adr:github\.com:\d+:neomjs%2F[a-z-]+:\d{4}$/);
            expect(entry.assignmentEvidence.verified).toBe(true);
            expect(entry.sourceTuple.contentHash).toMatch(/^[0-9a-f]{12}$/);
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

        expect(byNamespace['neomjs/neo-agent-brain']).toBe(29);
        expect(byNamespace['neomjs/neo']).toBe(7);
        expect(byNamespace['neomjs/neo-agent-institution']).toBe(5);
        expect(conceptAnomalies).toBe(9);
        expect(classAnomalies).toBe(2);

        const adr0038 = REVIEWED_41_ADR_MIGRATION_MANIFEST.find(e => e.adrNumber === '0038');
        expect(adr0038.observedState.anomalyShape).toBe('SHARED_SUMMARY_VECTOR_WITH_NON_ADR_OWNER');
        expect(adr0038.observedState.reusedVectorOwners.map(o => o.nodeId)).toEqual(
            expect.arrayContaining([
                'session:neo_recovery',
                'vessel-workspace',
                'summary_7c49107b-04f0-4e9c-ad86-65513999d61b',
                'workstation-reclaim-embodiment',
                'TASK:PR_19722'
            ])
        );

        expect(GRAPH_NODE_WRITER_INVENTORY.find(w => w.id === 'migrateLegacyAdrIdentities')).toEqual(
            expect.objectContaining({
                id                   : 'migrateLegacyAdrIdentities',
                path                 : 'ai/scripts/migrations/migrateLegacyAdrIdentities.mjs',
                canMutateAdrAuthority: true
            })
        );
    });

    test('AC2: defaults to dry-run and refuses inconsistent proof, duplicate claims, lost provenance, or changed preconditions before any write', async () => {
        const {db, vectorStore, kbStore} = createSeededDisposableStores();

        try {
            const parsedDefault = parseArgs([]);
            expect(parsedDefault.dryRun).toBe(true);
            expect(parsedDefault.apply).toBe(false);

            const dryRunRes = await migrateLegacyAdrIdentities({db, vectorStore, kbStore});
            expect(dryRunRes.mode).toBe('dry-run');
            expect(dryRunRes.applied).toBe(false);
            expect(dryRunRes.plannedCount).toBe(41);

            // Verify zero SQLite/vector/KB mutations occurred during dry-run
            const legacy0001    = db.prepare('SELECT id FROM Nodes WHERE id = ?').get('adr-0001');
            const canonical0001 = db.prepare('SELECT id FROM Nodes WHERE id = ?').get(
                REVIEWED_41_ADR_MIGRATION_MANIFEST[0].canonicalKey
            );
            expect(legacy0001).toBeTruthy();
            expect(canonical0001).toBeUndefined();
            expect(vectorStore.has('adr-0001')).toBe(true);
            expect(kbStore.has('adr-0001')).toBe(true);

            // 1. Incomplete inventory refusal
            await expect(
                migrateLegacyAdrIdentities({
                    db,
                    apply   : true,
                    manifest: REVIEWED_41_ADR_MIGRATION_MANIFEST.slice(0, 40)
                })
            ).rejects.toMatchObject({code: 'ADR_MIGRATION_INCOMPLETE_INVENTORY'});

            // 2. Inconsistent identity proof refusal
            const badIdentityManifest = REVIEWED_41_ADR_MIGRATION_MANIFEST.map((entry, idx) =>
                idx === 0
                    ? {...entry, canonicalKey: 'adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0099'}
                    : entry
            );
            await expect(
                migrateLegacyAdrIdentities({db, apply: true, manifest: badIdentityManifest})
            ).rejects.toMatchObject({code: 'ADR_MIGRATION_INCONSISTENT_IDENTITY_PROOF'});

            // 3. Duplicate canonical claim refusal
            const duplicateClaimManifest = REVIEWED_41_ADR_MIGRATION_MANIFEST.map((entry, idx) =>
                idx === 1
                    ? {
                        ...entry,
                        adrNumber   : '0001',
                        legacyId    : 'adr-0001',
                        canonicalKey: REVIEWED_41_ADR_MIGRATION_MANIFEST[0].canonicalKey
                    }
                    : entry
            );
            await expect(
                migrateLegacyAdrIdentities({db, apply: true, manifest: duplicateClaimManifest})
            ).rejects.toMatchObject({code: 'ADR_MIGRATION_DUPLICATE_CANONICAL_CLAIM'});

            // 4. Lost provenance refusal
            const lostProvenanceManifest = REVIEWED_41_ADR_MIGRATION_MANIFEST.map((entry, idx) =>
                idx === 0
                    ? {...entry, sourceTuple: {...entry.sourceTuple, contentHash: ''}}
                    : entry
            );
            await expect(
                migrateLegacyAdrIdentities({db, apply: true, manifest: lostProvenanceManifest})
            ).rejects.toMatchObject({code: 'ADR_MIGRATION_LOST_PROVENANCE'});

            // 5. Incomplete shared vector owner inventory refusal
            const missingOwnersManifest = REVIEWED_41_ADR_MIGRATION_MANIFEST.map(entry =>
                entry.adrNumber === '0038'
                    ? {...entry, observedState: {...entry.observedState, reusedVectorOwners: []}}
                    : entry
            );
            await expect(
                migrateLegacyAdrIdentities({db, apply: true, manifest: missingOwnersManifest})
            ).rejects.toMatchObject({code: 'ADR_MIGRATION_INCOMPLETE_VECTOR_OWNER_INVENTORY'});

            // 6. Changed source precondition refusal
            await expect(
                migrateLegacyAdrIdentities({
                    db,
                    apply      : true,
                    sourceProbe: {revisions: {'neomjs/neo': 'deadbeef'}}
                })
            ).rejects.toMatchObject({code: 'ADR_MIGRATION_SOURCE_PRECONDITION_CHANGED'});

            // 7. Changed SQLite data precondition refusal (uninventoried legacy ADR row in DB)
            db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run(
                'adr-0099',
                JSON.stringify({id: 'adr-0099', label: 'ADR'})
            );
            await expect(
                migrateLegacyAdrIdentities({db, apply: true})
            ).rejects.toMatchObject({code: 'ADR_MIGRATION_DATA_PRECONDITION_CHANGED'});
        } finally {
            db.close();
        }
    });

    test('AC3: disposable-state migration relabels 11 anomaly nodes, detaches shared summary vector without harming non-ADR owners, preserves edge provenance, and normalizes origins', async () => {
        const {db, vectorStore, kbStore} = createSeededDisposableStores();

        try {
            const result = await migrateLegacyAdrIdentities({
                db,
                vectorStore,
                kbStore,
                apply: true
            });

            expect(result.applied).toBe(true);
            expect(result.phase).toBe('completed');
            expect(result.migratedNodesCount).toBe(41);
            expect(result.relabeledNodesCount).toBe(12); // 11 initial census anomalies + 0019

            // Zero legacy adr-NNNN nodes remain
            const remainingLegacy = db.prepare("SELECT id FROM Nodes WHERE id LIKE 'adr-%'").all();
            expect(remainingLegacy).toHaveLength(0);

            // All 41 canonical ADR nodes exist with label='ADR' and semanticVectorId=canonicalKey
            const canonicalNodes = db.prepare("SELECT id, data FROM Nodes WHERE id LIKE 'adr:%'").all();
            expect(canonicalNodes).toHaveLength(41);

            for (const row of canonicalNodes) {
                const parsed = JSON.parse(row.data);
                expect(parsed.label).toBe('ADR');
                expect(parsed.type).toBe('ADR');
                expect(parsed.semanticVectorId).toBe(row.id);
                expect(parsed.properties.adrAuthority.admitted).toBe(true);
                expect(parsed.properties.adrAuthority.writer).toBe('migrateLegacyAdrIdentities');
            }

            // Shared summary vector is detached from the ADR node but preserved for session:neo_recovery and concepts
            const adr0038Entry = REVIEWED_41_ADR_MIGRATION_MANIFEST.find(e => e.adrNumber === '0038');
            const adr0038Node  = JSON.parse(
                db.prepare('SELECT data FROM Nodes WHERE id = ?').get(adr0038Entry.canonicalKey).data
            );
            expect(adr0038Node.semanticVectorId).toBe(adr0038Entry.canonicalKey);
            expect(adr0038Node.properties.adrAuthority.vectorProvenance).toEqual({
                previousSemanticVectorId   : 'summary_7c49107b-04f0-4e9c-ad86-65513999d61b',
                detachedSummaryVector      : true,
                preservedSharedVectorOwners: [
                    'session:neo_recovery',
                    'vessel-workspace',
                    'summary_7c49107b-04f0-4e9c-ad86-65513999d61b',
                    'workstation-reclaim-embodiment',
                    'TASK:PR_19722'
                ]
            });

            const sessionRecoveryNode = JSON.parse(
                db.prepare('SELECT data FROM Nodes WHERE id = ?').get('session:neo_recovery').data
            );
            expect(sessionRecoveryNode.semanticVectorId).toBe('summary_7c49107b-04f0-4e9c-ad86-65513999d61b');
            expect(vectorStore.has('summary_7c49107b-04f0-4e9c-ad86-65513999d61b')).toBe(true);

            // Historical references on 0011 are normalized to canonical repository-qualified IDs
            const adr0011Entry = REVIEWED_41_ADR_MIGRATION_MANIFEST.find(e => e.adrNumber === '0011');
            const adr0011Node  = JSON.parse(
                db.prepare('SELECT data FROM Nodes WHERE id = ?').get(adr0011Entry.canonicalKey).data
            );
            expect(adr0011Node.properties.historicalReferences).toEqual([
                'ISSUE:neomjs/neo#11377',
                'PULL_REQUEST:neomjs/neo#19722'
            ]);

            // Incident edges are rewritten to canonical keys and duplicate edges merge provenance without loss
            const adr0006Entry = REVIEWED_41_ADR_MIGRATION_MANIFEST.find(e => e.adrNumber === '0006');
            const adr0018Entry = REVIEWED_41_ADR_MIGRATION_MANIFEST.find(e => e.adrNumber === '0018');

            const governsEdge = db.prepare(
                'SELECT * FROM Edges WHERE source = ? AND target = ? AND type = ?'
            ).get(adr0006Entry.canonicalKey, 'ISSUE:neomjs/neo#11377', 'GOVERNS');
            expect(governsEdge).toBeTruthy();

            const governsData = JSON.parse(governsEdge.data);
            expect(governsData.weight).toBe(2);
            expect(governsData.properties.provenance).toEqual([
                {step: 'pre-existing-canonical'},
                {step: 'legacy-ingest-1'}
            ]);
            expect(governsData.properties.migratedFromEdgeIds).toEqual(
                expect.arrayContaining(['edge-existing-canonical-0006', 'edge-legacy-0006-1'])
            );

            const citesEdge = db.prepare(
                'SELECT * FROM Edges WHERE source = ? AND target = ? AND type = ?'
            ).get(adr0018Entry.canonicalKey, adr0006Entry.canonicalKey, 'CITES_AUTHORITY');
            expect(citesEdge).toBeTruthy();
            expect(JSON.parse(citesEdge.data).properties.origin).toBe(adr0018Entry.canonicalKey);
        } finally {
            db.close();
        }
    });

    test('AC4: interrupted cross-store phases resume deterministically, completed reruns no-op, and backup/restore preserves unrelated consumers', async () => {
        const
            {db, vectorStore, kbStore} = createSeededDisposableStores(),
            tmpDir                     = await fs.mkdtemp(path.join(os.tmpdir(), 'adr-migration-1014-')),
            backupPath                 = path.join(tmpDir, 'pre-migration-backup.json');

        try {
            // Interrupt after each store boundary and verify deterministic resumption
            for (const phaseToInterrupt of [
                'preconditions_verified',
                'backup_created',
                'graph_sqlite_applied',
                'vector_store_applied',
                'kb_projection_applied',
                'reader_verified'
            ]) {
                await expect(
                    migrateLegacyAdrIdentities({
                        db,
                        vectorStore,
                        kbStore,
                        apply         : true,
                        backupPath,
                        failAfterPhase: phaseToInterrupt
                    })
                ).rejects.toMatchObject({code: 'ADR_MIGRATION_INTERRUPTED_FOR_TEST'});

                const journalRow = db.prepare(
                    'SELECT phase, completed_phases FROM AdrIdentityMigrationJournal WHERE migration_id = ?'
                ).get('adr-legacy-41-cut-v1');
                expect(journalRow.phase).toBe(phaseToInterrupt);
                expect(JSON.parse(journalRow.completed_phases)).toContain(phaseToInterrupt);
            }

            // Final resume completes cleanly
            const completedRes = await migrateLegacyAdrIdentities({
                db,
                vectorStore,
                kbStore,
                apply: true,
                backupPath
            });
            expect(completedRes.applied).toBe(true);
            expect(completedRes.resumed).toBe(true);
            expect(completedRes.phase).toBe('completed');
            expect(completedRes.completedPhases).toEqual([...MIGRATION_PHASES]);

            // Rerunning after completion is a strict no-op
            const rerunRes = await migrateLegacyAdrIdentities({
                db,
                vectorStore,
                kbStore,
                apply: true,
                backupPath
            });
            expect(rerunRes.noOpRerun).toBe(true);
            expect(rerunRes.applied).toBe(false);
            expect(rerunRes.phase).toBe('completed');

            // Restore from backup and verify pre-migration ADR state + unrelated consumers are intact
            const restoreRes = restoreAdrMigrationBackup({
                db,
                vectorStore,
                kbStore,
                backupPath
            });
            expect(restoreRes.restored).toBe(true);

            const restoredLegacyNodes    = db.prepare("SELECT id FROM Nodes WHERE id LIKE 'adr-%'").all();
            const restoredCanonicalNodes = db.prepare("SELECT id FROM Nodes WHERE id LIKE 'adr:%'").all();
            expect(restoredLegacyNodes).toHaveLength(41);
            expect(restoredCanonicalNodes).toHaveLength(0);

            // Unrelated node, edge, shared summary vector, and unrelated KB doc are untouched
            expect(db.prepare('SELECT id FROM Nodes WHERE id = ?').get('session:neo_recovery')).toBeTruthy();
            expect(db.prepare('SELECT id FROM Edges WHERE id = ?').get('edge-unrelated')).toBeTruthy();
            expect(vectorStore.has('summary_7c49107b-04f0-4e9c-ad86-65513999d61b')).toBe(true);
            expect(kbStore.has('guide:unrelated-doc')).toBe(true);
        } finally {
            db.close();
            await fs.remove(tmpDir);
        }
    });

    test('AC5 & AC6: runbook binds manifest/reader versions, and migrated records use shared admission catalog with historical 0001..0041 alias scope and FM reservations', async () => {
        expect(ADR_MIGRATION_RUNBOOK.manifestVersion).toBe(MIGRATION_MANIFEST_VERSION);
        expect(ADR_MIGRATION_RUNBOOK.manifestRecordCount).toBe(41);
        expect(ADR_MIGRATION_RUNBOOK.requiredReaderCapabilities.adrSource).toBe(
            'ai/services/knowledge-base/source/AdrSource.mjs'
        );
        expect(ADR_MIGRATION_RUNBOOK.postMergeLiveApplyBoundary).toContain('post-merge acceptance');
        expect(getUsageText()).toContain('--runbook');

        const {db, vectorStore, kbStore} = createSeededDisposableStores();
        try {
            await migrateLegacyAdrIdentities({db, vectorStore, kbStore, apply: true});

            // All 41 records are hydrated into SHARED_ADR_CATALOG_STATE
            expect(SHARED_ADR_CATALOG_STATE.admissionCatalog.size).toBe(41);

            // Moved FM ADR resolves in both neomjs/neo-agent-institution and historical neomjs/neo
            const fm0020       = REVIEWED_41_ADR_MIGRATION_MANIFEST.find(e => e.adrNumber === '0020');
            const resolvedInFm = AdrSource.resolveAdrReference('adr-0020', {
                namespace: 'neomjs/neo-agent-institution'
            });
            expect(resolvedInFm.resolved).toBe(true);
            expect(resolvedInFm.canonicalKey).toBe(fm0020.canonicalKey);

            const resolvedInOriginNeo = AdrSource.resolveAdrReference('adr-0020', {
                namespace: 'neomjs/neo'
            });
            expect(resolvedInOriginNeo.resolved).toBe(true);
            expect(resolvedInOriginNeo.canonicalKey).toBe(fm0020.canonicalKey);

            // Number 0020 is reserved in neomjs/neo (220867748) so it cannot be reused there
            const neoBucket = ensureSharedReservationBucket('github.com', '220867748');
            for (const movedNum of MOVED_FM_ADR_NUMBERS) {
                expect(neoBucket.numbers.has(movedNum)).toBe(true);
            }

            // 0042+ is not in the legacy manifest and does not resolve without normal admission
            const unresolved0042 = AdrSource.resolveAdrReference('adr-0042', {
                namespace: 'neomjs/neo-agent-brain'
            });
            expect(unresolved0042.resolved).toBe(false);
        } finally {
            db.close();
        }
    });

    test('AC7: rebuild and custody-move failure controls handle rename, custody move, combined move+rename, source loss, and admission-record loss', async () => {
        const baseRecord0042 = {
            canonicalKey      : 'adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0042',
            adrNumber         : '0042',
            title             : 'Decision Forty-Two',
            status            : 'Accepted',
            currentSlug       : 'old-slug',
            fileName          : '0042-old-slug.md',
            sourcePath        : 'learn/agentos/decisions/0042-old-slug.md',
            assignmentEvidence: {
                forge       : 'github.com',
                repositoryId: '1344062228',
                namespace   : 'neomjs/neo-agent-brain',
                verified    : true
            },
            sourceTuple       : {
                forge       : 'github.com',
                repositoryId: '1344062228',
                namespace   : 'neomjs/neo-agent-brain',
                revision    : 'HEAD',
                path        : 'learn/agentos/decisions/0042-old-slug.md',
                contentHash : '111122223333'
            },
            documentAvailable: true,
            kbAvailable      : true,
            stale            : false,
            historicalAliases: ['old-slug'],
            aliasBindings    : [
                {
                    kind        : 'slug',
                    value       : 'old-slug',
                    forge       : 'github.com',
                    repositoryId: '1344062228',
                    namespace   : 'neomjs/neo-agent-brain',
                    targetKey   : 'adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0042',
                    current     : true
                },
                {
                    kind        : 'legacy-number',
                    value       : '0042',
                    forge       : 'github.com',
                    repositoryId: '1344062228',
                    namespace   : 'neomjs/neo-agent-brain',
                    targetKey   : 'adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0042',
                    current     : true
                }
            ],
            reservations: [],
            provenance  : {custodyTransitions: [], repositoryRenames: [], sourceLineage: []}
        };

        // 1. Rebuild after slug rename (0042-old-slug -> 0042-new-slug) in the same repository
        const renameRebuild = await reconcileRebuildAndCustodyControls({
            retainedAdmissionRecords: [baseRecord0042],
            repositories            : [
                {
                    forge       : 'github.com',
                    repositoryId: '1344062228',
                    namespace   : 'neomjs/neo-agent-brain',
                    files       : {
                        'learn/agentos/decisions/0042-new-slug.md': [
                            '# ADR 0042: Decision Forty-Two',
                            '',
                            '| Attribute | Value |',
                            '| :--- | :--- |',
                            '| **Status** | Accepted |',
                            '| **Aliases** | `old-slug` |',
                            '',
                            '## Context',
                            'Renamed slug within same repository.'
                        ].join('\n')
                    }
                }
            ]
        });
        expect(renameRebuild.reconciliation[baseRecord0042.canonicalKey].documentAvailable).toBe(true);
        expect(AdrSource.resolveAdrReference('adr:new-slug', {namespace: 'neomjs/neo-agent-brain'}).canonicalKey).toBe(
            baseRecord0042.canonicalKey
        );
        expect(AdrSource.resolveAdrReference('adr:old-slug', {namespace: 'neomjs/neo-agent-brain'}).canonicalKey).toBe(
            baseRecord0042.canonicalKey
        );

        // 2 & 3. Combined custody move + rename (A-old -> B-new) with verified transition proof
        const combinedMoveRebuild = await reconcileRebuildAndCustodyControls({
            retainedAdmissionRecords: [baseRecord0042],
            custodyTransitions      : [
                {
                    adrNumber       : '0042',
                    canonicalKey    : baseRecord0042.canonicalKey,
                    fromForge       : 'github.com',
                    fromRepositoryId: '1344062228',
                    fromNamespace   : 'neomjs/neo-agent-brain',
                    toForge         : 'github.com',
                    toRepositoryId  : '1347756127',
                    toNamespace     : 'neomjs/neo-agent-institution',
                    proof           : 'verified-move-0042',
                    verified        : true
                }
            ],
            repositories            : [
                {
                    forge       : 'github.com',
                    repositoryId: '1344062228',
                    namespace   : 'neomjs/neo-agent-brain',
                    files       : {
                        'learn/agentos/decisions/0042-old-slug.md': [
                            '---',
                            'type: redirect',
                            `target: ${baseRecord0042.canonicalKey}`,
                            '---',
                            '# Moved'
                        ].join('\n')
                    }
                },
                {
                    forge       : 'github.com',
                    repositoryId: '1347756127',
                    namespace   : 'neomjs/neo-agent-institution',
                    files       : {
                        'learn/agentos/decisions/0042-moved-new-slug.md': [
                            '# ADR 0042: Decision Forty-Two',
                            '',
                            '| Attribute | Value |',
                            '| :--- | :--- |',
                            '| **Status** | Accepted |',
                            '| **Aliases** | `old-slug` |',
                            '',
                            '## Context',
                            'Moved custody and renamed slug.'
                        ].join('\n')
                    }
                }
            ]
        });
        expect(combinedMoveRebuild.refusedCandidates).toHaveLength(0);
        expect(AdrSource.resolveAdrReference('adr:moved-new-slug', {namespace: 'neomjs/neo-agent-institution'}).canonicalKey).toBe(
            baseRecord0042.canonicalKey
        );
        expect(AdrSource.resolveAdrReference('adr:old-slug', {namespace: 'neomjs/neo-agent-brain'}).canonicalKey).toBe(
            baseRecord0042.canonicalKey
        );

        // 4. Source loss retains canonical identity while marking documentAvailable=false and stale=true
        const sourceLossRebuild = await reconcileRebuildAndCustodyControls({
            retainedAdmissionRecords: [baseRecord0042],
            repositories            : [
                {
                    forge       : 'github.com',
                    repositoryId: '1344062228',
                    namespace   : 'neomjs/neo-agent-brain',
                    files       : {}
                }
            ]
        });
        const lostState = sourceLossRebuild.reconciliation[baseRecord0042.canonicalKey];
        expect(lostState.identityResolved).toBe(true);
        expect(lostState.documentAvailable).toBe(false);
        expect(lostState.kbAvailable).toBe(false);
        expect(lostState.stale).toBe(true);

        // 5. Admission-record loss & unverified custody move refuse basename reconstruction and unverified re-scoping
        const refusalRebuild = await reconcileRebuildAndCustodyControls({
            retainedAdmissionRecords: [baseRecord0042],
            custodyTransitions      : [], // Missing transition proof for custody move of 0042!
            repositories            : [
                {
                    forge       : 'github.com',
                    repositoryId: '1347756127',
                    namespace   : 'neomjs/neo-agent-institution',
                    files       : {
                        'learn/agentos/decisions/0042-unverified-move.md'    : '# ADR 0042: Unverified Move\n\nBody',
                        'learn/agentos/decisions/0099-no-admission-record.md': '# ADR 0099: Unadmitted\n\nBody'
                    }
                }
            ]
        });

        expect(refusalRebuild.refusedCandidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    adrNumber : '0042',
                    reasonCode: 'ADR_CUSTODY_TRANSITION_UNVERIFIED'
                }),
                expect.objectContaining({
                    adrNumber : '0099',
                    reasonCode: 'ADR_ADMISSION_EVIDENCE_MISSING'
                })
            ])
        );
    });

    test('AC8: revalidates reader authorization for private neomjs/neo-stage before cut', () => {
        expect(() =>
            verifyMigrationPreconditions({
                sourceProbe  : {requirePrivateStageAccess: true},
                readerContext: {authorizedNamespaces: ['neomjs/neo', 'neomjs/neo-agent-brain']}
            })
        ).toThrow(expect.objectContaining({code: 'ADR_MIGRATION_READER_PRECONDITION_FAILED'}));

        const authorizedPrecheck = verifyMigrationPreconditions({
            sourceProbe  : {requirePrivateStageAccess: true},
            readerContext: {authorizedNamespaces: ['neomjs/neo-stage']}
        });
        expect(authorizedPrecheck.ok).toBe(true);
    });
});

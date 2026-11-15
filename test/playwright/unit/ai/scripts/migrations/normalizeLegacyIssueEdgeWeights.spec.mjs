import {setup} from '../../../../setup.mjs';

const appName = 'NormalizeLegacyIssueEdgeWeightsSpec';

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
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import CoreDatabase   from '../../../../../../ai/graph/Database.mjs';
import SQLite         from '../../../../../../ai/graph/storage/SQLite.mjs';
import {
    LEGACY_ANCHOR_RESET_MARKER_ID,
    createProgram,
    normalizeLegacyIssueEdgeWeights,
    parseArgs
} from '../../../../../../ai/scripts/migrations/normalizeLegacyIssueEdgeWeights.mjs';

/**
 * @summary Creates the minimal Memory Core SQLite `Nodes` and `Edges` schema in a disposable file.
 * @param {String} dbPath Target SQLite database file path.
 * @returns {Database.Database}
 */
function createSeededGraphDatabase(dbPath) {
    const db = new Database(dbPath);

    db.exec(`
        CREATE TABLE Nodes (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            data TEXT NOT NULL
        );

        CREATE TABLE Edges (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            source TEXT NOT NULL,
            target TEXT NOT NULL,
            type TEXT NOT NULL,
            data TEXT NOT NULL
        );
    `);

    return db;
}

/**
 * @summary Inserts one serialized graph node into `Nodes`.
 * @param {Database.Database} db Open SQLite handle.
 * @param {Object} node `{id, label, properties}`.
 */
function insertNode(db, {id, label, properties = {}}) {
    db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, ?, ?)').run(
        id,
        null,
        JSON.stringify({id, label, properties})
    );
}

/**
 * @summary Inserts one serialized graph edge into `Edges`.
 * @param {Database.Database} db Open SQLite handle.
 * @param {Object} edge `{id, source, target, type, properties}`.
 */
function insertEdge(db, {id, source, target, type, properties = {}}) {
    db.prepare('INSERT INTO Edges (id, user_id, source, target, type, data) VALUES (?, ?, ?, ?, ?, ?)').run(
        id,
        null,
        source,
        target,
        type,
        JSON.stringify({id, source, target, type, properties})
    );
}

/**
 * @summary Reads the persisted `properties` payload for an edge row by id.
 * @param {Database.Database} db Open SQLite handle.
 * @param {String} edgeId Edge primary key.
 * @returns {Object}
 */
function readEdgeProperties(db, edgeId) {
    const row = db.prepare('SELECT data FROM Edges WHERE id = ?').get(edgeId);
    return JSON.parse(row.data).properties;
}

test.describe('ai/scripts/migrations/normalizeLegacyIssueEdgeWeights', () => {
    let tmpDir;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-legacy-issue-edge-weights-'));
    });

    test.afterEach(() => {
        if (tmpDir && fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, {recursive: true, force: true});
        }
    });

    test('parseArgs enforces Commander CLI contract for defaults, flags, help, and invalid inputs', () => {
        expect(LEGACY_ANCHOR_RESET_MARKER_ID).toBe('issue_ingestor_legacy_anchor_reset_v1');
        expect(createProgram().name()).toBe('normalizeLegacyIssueEdgeWeights');

        expect(parseArgs([])).toEqual({
            apply: false,
            db   : null,
            force: false,
            json : false
        });

        expect(parseArgs(['--dry-run'])).toEqual({
            apply: false,
            db   : null,
            force: false,
            json : false
        });

        expect(parseArgs(['--apply', '--db', '/tmp/custom-graph.sqlite', '--force', '--json'])).toEqual({
            apply: true,
            db   : '/tmp/custom-graph.sqlite',
            force: true,
            json : true
        });

        expect(() => parseArgs(['--apply', '--dry-run'])).toThrow(/Cannot combine --apply and --dry-run/);
        expect(() => parseArgs(['--aply'])).toThrow(/unknown option/i);
        expect(() => parseArgs(['--db'])).toThrow(/argument missing/i);
        expect(() => parseArgs(['/tmp/positional.sqlite'])).toThrow(/too many arguments/i);

        let helpError = null;
        try {
            parseArgs(['--help']);
        } catch (error) {
            helpError = error;
        }

        expect(helpError?.code).toBe('commander.helpDisplayed');
    });

    test('dry-run reports exact candidate updates with zero writes and --apply normalizes atomically with SchemaVersion marker', () => {
        const dbPath = path.join(tmpDir, 'memory-core-graph.sqlite'),
              seedDb = createSeededGraphDatabase(dbPath);

        try {
            insertNode(seedDb, {
                id        : '@neo-internal',
                label     : 'AgentIdentity',
                properties: {
                    accountType : 'agent',
                    githubLogin : 'internal-maintainer',
                    formerLogins: ['legacy-maintainer-handle']
                }
            });

            insertNode(seedDb, {
                id        : 'issue-101',
                label     : 'ISSUE',
                properties: {state: 'OPEN', author: 'internal-maintainer', labels: ['ai']}
            });
            insertNode(seedDb, {
                id        : 'issue-201',
                label     : 'ISSUE',
                properties: {state: 'OPEN', author: 'internal-maintainer', labels: ['bug', 'ai']}
            });
            insertNode(seedDb, {
                id        : 'issue-202',
                label     : 'ISSUE',
                properties: {state: 'OPEN', author: 'external-contributor', labels: ['bug', 'ai']}
            });
            insertNode(seedDb, {
                id        : 'issue-203',
                label     : 'ISSUE',
                properties: {state: 'OPEN', author: 'internal-maintainer', labels: ['bug', 'ai']}
            });
            insertNode(seedDb, {
                id        : 'issue-204',
                label     : 'ISSUE',
                properties: {state: 'CLOSED', author: 'legacy-maintainer-handle', labels: ['bug', 'ai']}
            });

            // 9 candidate issue edges requiring normalization:
            insertEdge(seedDb, {id: 'e-msg-discount',     source: 'MESSAGE:m-1',         target: 'issue-203', type: 'REFERENCES_TICKET', properties: {weight: 0.05}});
            insertEdge(seedDb, {id: 'e-msg-boost',        source: 'MESSAGE:m-2',         target: 'issue-201', type: 'REFERENCES_TICKET', properties: {weight: 2.0}});
            insertEdge(seedDb, {id: 'e-internal-bug',     source: 'SESSION_SUMMARY:s-1', target: 'issue-201', type: 'DISCUSSED_IN',      properties: {weight: 1.96, provenance: 'rem'}});
            insertEdge(seedDb, {id: 'e-former-login-bug', source: 'SESSION_SUMMARY:s-2', target: 'issue-204', type: 'DISCUSSED_IN',      properties: {weight: 1.96}});
            insertEdge(seedDb, {id: 'e-community-bug',    source: 'SESSION_SUMMARY:s-3', target: 'issue-202', type: 'DISCUSSED_IN',      properties: {weight: 2.45}});
            insertEdge(seedDb, {id: 'e-blocker-discount', source: 'SESSION_SUMMARY:s-4', target: 'issue-203', type: 'DISCUSSED_IN',      properties: {weight: 0.05}});
            insertEdge(seedDb, {id: 'e-parent-boost',     source: 'issue-101',           target: 'issue-201', type: 'PARENT_OF',         properties: {weight: 2.0}});
            insertEdge(seedDb, {id: 'e-blocks-discount',  source: 'issue-101',           target: 'issue-203', type: 'BLOCKS',            properties: {weight: 0.05}});
            insertEdge(seedDb, {id: 'e-resolves-boost',   source: 'pr-900',              target: 'issue-204', type: 'RESOLVES',          properties: {weight: 2.0}});

            // 4 compliant issue edges + 1 non-issue edge that must remain untouched:
            insertEdge(seedDb, {id: 'e-decayed-scent',    source: 'SESSION_SUMMARY:s-5', target: 'issue-201', type: 'DISCUSSED_IN',      properties: {weight: 0.8}});
            insertEdge(seedDb, {id: 'e-retired-goal',     source: 'goal-1',              target: 'issue-201', type: 'ADVANCED_BY',       properties: {weight: 0.1}});
            insertEdge(seedDb, {id: 'e-frontier-guides',  source: 'frontier',            target: 'issue-201', type: 'GUIDES',            properties: {weight: 2.0}});
            insertEdge(seedDb, {id: 'e-msg-already-one',  source: 'MESSAGE:m-3',         target: 'issue-201', type: 'REFERENCES_TICKET', properties: {weight: 1.0}});
            insertEdge(seedDb, {id: 'e-non-issue',        source: 'SESSION_SUMMARY:s-1', target: 'concept-1', type: 'RELATES_TO',        properties: {weight: 1.75}});
        } finally {
            seedDb.close();
        }

        const dryRunResult = normalizeLegacyIssueEdgeWeights({dbPath, apply: false});

        expect(dryRunResult).toMatchObject({
            status           : 'dry-run',
            markerId         : LEGACY_ANCHOR_RESET_MARKER_ID,
            markerPresent    : false,
            scannedIssueEdges: 13,
            candidateUpdates : 9,
            updatedEdges     : 0,
            byEdgeType       : {
                BLOCKS           : 1,
                DISCUSSED_IN     : 4,
                PARENT_OF        : 1,
                REFERENCES_TICKET: 2,
                RESOLVES         : 1
            }
        });

        const checkAfterDryRun = new Database(dbPath, {readonly: true});
        try {
            expect(readEdgeProperties(checkAfterDryRun, 'e-msg-discount').weight).toBe(0.05);
            expect(readEdgeProperties(checkAfterDryRun, 'e-internal-bug').weight).toBe(1.96);
            expect(
                checkAfterDryRun
                    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'SchemaVersion'")
                    .get()
            ).toBeUndefined();
        } finally {
            checkAfterDryRun.close();
        }

        const applyResult = normalizeLegacyIssueEdgeWeights({dbPath, apply: true});

        expect(applyResult).toMatchObject({
            status           : 'applied',
            markerId         : LEGACY_ANCHOR_RESET_MARKER_ID,
            markerPresent    : true,
            scannedIssueEdges: 13,
            candidateUpdates : 9,
            updatedEdges     : 9
        });
        expect(typeof applyResult.markerUpdatedAt).toBe('string');

        const verifyDb = new Database(dbPath);
        try {
            expect(readEdgeProperties(verifyDb, 'e-msg-discount').weight).toBe(1.0);
            expect(readEdgeProperties(verifyDb, 'e-msg-boost').weight).toBe(1.0);
            expect(readEdgeProperties(verifyDb, 'e-internal-bug')).toEqual({weight: 0.98, provenance: 'rem'});
            expect(readEdgeProperties(verifyDb, 'e-former-login-bug').weight).toBe(0.98);
            expect(readEdgeProperties(verifyDb, 'e-community-bug').weight).toBe(0.98);
            expect(readEdgeProperties(verifyDb, 'e-blocker-discount').weight).toBe(1.0);
            expect(readEdgeProperties(verifyDb, 'e-parent-boost').weight).toBe(1.0);
            expect(readEdgeProperties(verifyDb, 'e-blocks-discount').weight).toBe(1.0);
            expect(readEdgeProperties(verifyDb, 'e-resolves-boost').weight).toBe(1.0);

            expect(readEdgeProperties(verifyDb, 'e-decayed-scent').weight).toBe(0.8);
            expect(readEdgeProperties(verifyDb, 'e-retired-goal').weight).toBe(0.1);
            expect(readEdgeProperties(verifyDb, 'e-frontier-guides').weight).toBe(2.0);
            expect(readEdgeProperties(verifyDb, 'e-msg-already-one').weight).toBe(1.0);
            expect(readEdgeProperties(verifyDb, 'e-non-issue').weight).toBe(1.75);

            const markerRow = verifyDb
                .prepare('SELECT id, version FROM SchemaVersion WHERE id = ?')
                .get(LEGACY_ANCHOR_RESET_MARKER_ID);
            expect(markerRow).toEqual({id: LEGACY_ANCHOR_RESET_MARKER_ID, version: 1});

            // Re-evaluating a cleanly migrated store with --force finds zero further updates.
            const forcedCleanCheck = normalizeLegacyIssueEdgeWeights({db: verifyDb, apply: false, force: true});
            expect(forcedCleanCheck).toMatchObject({
                status           : 'dry-run',
                markerPresent    : true,
                scannedIssueEdges: 13,
                candidateUpdates : 0,
                updatedEdges     : 0
            });

            // Simulate a post-cutover multi-session linkNodes reinforcement above 1.0 (0.98 + 0.1 = 1.08).
            verifyDb.prepare('UPDATE Edges SET data = ? WHERE id = ?').run(
                JSON.stringify({
                    id        : 'e-internal-bug',
                    source    : 'SESSION_SUMMARY:s-1',
                    target    : 'issue-201',
                    type      : 'DISCUSSED_IN',
                    properties: {weight: 1.08, provenance: 'rem'}
                }),
                'e-internal-bug'
            );
        } finally {
            verifyDb.close();
        }

        // Subsequent runs without --force short-circuit on SchemaVersion and preserve the 1.08 reinforcement.
        const secondApply = normalizeLegacyIssueEdgeWeights({dbPath, apply: true});
        expect(secondApply).toEqual({
            status           : 'already-normalized',
            markerId         : LEGACY_ANCHOR_RESET_MARKER_ID,
            markerPresent    : true,
            markerUpdatedAt  : applyResult.markerUpdatedAt,
            scannedIssueEdges: 0,
            candidateUpdates : 0,
            updatedEdges     : 0,
            byEdgeType       : {},
            sample           : []
        });

        const afterSecondApplyDb = new Database(dbPath, {readonly: true});
        try {
            expect(readEdgeProperties(afterSecondApplyDb, 'e-internal-bug').weight).toBe(1.08);
        } finally {
            afterSecondApplyDb.close();
        }
    });

    test('fails closed on missing --db files and blocks test-runner writes to production-shaped paths', () => {
        const missingPath = path.join(tmpDir, 'does-not-exist.sqlite');

        expect(() => normalizeLegacyIssueEdgeWeights({dbPath: missingPath, apply: false})).toThrow();
        expect(fs.existsSync(missingPath)).toBe(false);

        expect(() => normalizeLegacyIssueEdgeWeights({
            dbPath: '/Users/operator/.neo-ai-data/sqlite/memory-core-graph.sqlite',
            apply : true
        })).toThrow(/STORE_WRITE_GUARD/);
    });

    test('migrated SQLite store preserves normalized weights and post-migration linkNodes reinforcements across IssueIngestor.ingestIssueStates()', async () => {
        const {
            Memory_GraphService : GraphService,
            Memory_StorageRouter: StorageRouter
        }                                = await import('../../../../../../ai/services.mjs'),
        IssueIngestor                    = (await import('../../../../../../ai/services/ingestion/IssueIngestor.mjs')).default,
        dbPath                           = path.join(tmpDir, 'ingestor-continuity.sqlite'),
        corpusRoot                       = path.join(tmpDir, 'corpus'),
        previousGraphDb                  = GraphService.db,
        previousGetGraphCollection       = StorageRouter.getGraphCollection;

        await GraphService.ready();

        fs.mkdirSync(path.join(corpusRoot, 'issues'), {recursive: true});
        fs.writeFileSync(
            path.join(corpusRoot, 'issues/issue-201.md'),
            [
                '---',
                'id: 201',
                'title: Migrated Bug Ticket',
                'state: OPEN',
                'author: internal-maintainer',
                'labels:',
                '  - bug',
                '  - ai',
                'blockedBy:',
                "  - '#101'",
                '---',
                '# Migrated Bug Ticket'
            ].join('\n')
        );
        fs.writeFileSync(
            path.join(corpusRoot, 'issues/issue-101.md'),
            [
                '---',
                'id: 101',
                'title: Open Blocker',
                'state: OPEN',
                'author: internal-maintainer',
                'labels:',
                '  - ai',
                '---',
                '# Open Blocker'
            ].join('\n')
        );

        let storage = Neo.create(SQLite, {dbPath});
        await storage.ready();
        let graphDb = Neo.create(CoreDatabase, {storage});
        await graphDb.ready();

        try {
            GraphService.db = graphDb;

            GraphService.upsertGlobalNode({
                id        : '@neo-internal',
                type      : 'AgentIdentity',
                properties: {accountType: 'agent', githubLogin: 'internal-maintainer'}
            });
            GraphService.upsertNode({id: 'issue-101', type: 'ISSUE', properties: {state: 'OPEN', author: 'internal-maintainer', labels: ['ai']}});
            GraphService.upsertNode({id: 'issue-201', type: 'ISSUE', properties: {state: 'OPEN', author: 'internal-maintainer', labels: ['bug', 'ai']}});
            GraphService.upsertNode({id: 'MESSAGE:m-201', type: 'MESSAGE'});
            GraphService.upsertNode({id: 'SESSION_SUMMARY:s-201', type: 'SESSION_SUMMARY'});

            GraphService.linkNodes('MESSAGE:m-201',         'issue-201', 'REFERENCES_TICKET', 0.05);
            GraphService.linkNodes('SESSION_SUMMARY:s-201', 'issue-201', 'DISCUSSED_IN',      1.96);
            GraphService.linkNodes('issue-101',             'issue-201', 'BLOCKS',            0.35);

            storage.db.close();
            storage = null;
            graphDb = null;

            const migrationResult = normalizeLegacyIssueEdgeWeights({dbPath, apply: true});
            expect(migrationResult).toMatchObject({
                status          : 'applied',
                candidateUpdates: 2,
                updatedEdges    : 2
            });

            storage = Neo.create(SQLite, {dbPath});
            await storage.ready();
            graphDb = Neo.create(CoreDatabase, {storage});
            await graphDb.ready();
            GraphService.db = graphDb;

            StorageRouter.getGraphCollection = async () => ({
                upsert: async () => {},
                get   : async () => ({ids: [], metadatas: [], documents: []}),
                add   : async () => {}
            });

            // Reinforce DISCUSSED_IN post-migration (0.98 + 0.1 * 1.0 = 1.08), then run IssueIngestor.
            GraphService.linkNodes('SESSION_SUMMARY:s-201', 'issue-201', 'DISCUSSED_IN', 1.0);

            await IssueIngestor.ingestIssueStates({contentRoot: corpusRoot, strict: true});

            const readPersistedWeight = (source, target, type) => {
                const row = storage.db
                    .prepare('SELECT data FROM Edges WHERE source = ? AND target = ? AND type = ?')
                    .get(source, target, type);
                return JSON.parse(row.data).properties.weight;
            };

            expect(readPersistedWeight('MESSAGE:m-201',         'issue-201', 'REFERENCES_TICKET')).toBe(1.0);
            expect(readPersistedWeight('SESSION_SUMMARY:s-201', 'issue-201', 'DISCUSSED_IN')).toBeCloseTo(1.08, 6);
            expect(readPersistedWeight('issue-101',             'issue-201', 'BLOCKS')).toBe(1.0);
        } finally {
            GraphService.db                  = previousGraphDb;
            StorageRouter.getGraphCollection = previousGetGraphCollection;
            storage?.db?.close?.();
        }
    });
});

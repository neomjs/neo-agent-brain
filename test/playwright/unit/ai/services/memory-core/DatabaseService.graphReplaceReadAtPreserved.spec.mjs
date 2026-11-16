import {setup} from '../../../../setup.mjs';

const appName = 'MCGraphReplaceReadAtTest';

setup({
    neoConfig: {
        allowVdomUpdatesInTests: false,
        unitTestMode           : true,
        useDomApiRenderer      : false
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}  from '@playwright/test';
import {spawnSync}     from 'node:child_process';
import fs              from 'node:fs';
import os              from 'node:os';
import path            from 'node:path';
import Neo             from 'neo.mjs/src/Neo.mjs';
import * as core       from 'neo.mjs/src/core/_export.mjs';
import InstanceManager from 'neo.mjs/src/manager/Instance.mjs';

// `markRead` writes `readAt` to graph storage (the WAL carries send-time null by design). A destructive
// `graph.import.replace` from a LAGGED snapshot restores that null and silently reverts committed read receipts.
// This proves the fix in `DatabaseService.importDatabase`: committed graph-owned `DELIVERED_TO` state is captured
// before the replace-mode truncate and re-applied after the restore, so a lagged snapshot cannot clobber an acked `mark_read`.
test.describe('Memory_DatabaseService — graph.import.replace preserves committed DELIVERED_TO readAt (#15448)', () => {
    test('a committed readAt survives a replace-import from a snapshot captured before the mark', async () => {
        const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-readat-reseed-'));
        const graphPath = path.join(tmpDir, 'memory-core-graph.sqlite');
        const script    = String.raw`
            await import('neo.mjs/src/Neo.mjs');
            await import('neo.mjs/src/core/_export.mjs');
            await import('neo.mjs/src/manager/Instance.mjs');
            await import('./ai/mcp/server/memory-core/config.template.mjs');

            const GraphService          = (await import('./ai/services/memory-core/GraphService.mjs')).default;
            const MemoryDatabaseService = (await import('./ai/services/memory-core/DatabaseService.mjs')).default;

            await GraphService.ready();
            await MemoryDatabaseService.ready();

            await GraphService.db.storage.clear();
            GraphService.db.storage.db.exec('DELETE FROM GraphLog');
            GraphService.db.nodes.clear();
            GraphService.db.edges.clear();
            GraphService.db.vicinityLoadedNodes.clear();

            const messageId   = 'MESSAGE:readat-reseed-proof';
            const recipientId = '@readat-proof-recipient';

            // Seed a delivery whose read receipt has NOT yet been written — this is the state the lagged snapshot captures.
            GraphService.upsertNode({id: messageId,   type: 'MESSAGE'});
            GraphService.upsertNode({id: recipientId, type: 'AgentIdentity'});
            GraphService.linkNodes(messageId, recipientId, 'DELIVERED_TO', 1, {});

            const db          = GraphService.db.storage.db;
            const selectEdge  = () => db.prepare("SELECT id, data FROM Edges WHERE type='DELIVERED_TO' AND source=?").get(messageId);
            const readAtOf    = row => row && (JSON.parse(row.data).properties || {}).readAt;

            // Export NOW: the snapshot carries the DELIVERED_TO edge with readAt null (send-time truth, pre-mark).
            await MemoryDatabaseService.manageDatabaseBackup({action: 'export', include: ['graph'], backupPath: ${JSON.stringify(tmpDir)}});
            const graphBackupFile = (await import('node:fs')).readdirSync(${JSON.stringify(tmpDir)}).find(file => file.startsWith('graph-backup-'));
            const graphBackupPath = (await import('node:path')).join(${JSON.stringify(tmpDir)}, graphBackupFile);

            // Simulate markRead committing a read AFTER the snapshot was captured (storage write; the WAL stays null).
            const committedReadAt = '2026-07-18T17:00:00.000Z';
            const edgeBefore      = selectEdge();
            db.prepare("UPDATE Edges SET data = json_set(data, '$.properties.readAt', ?) WHERE id = ?").run(committedReadAt, edgeBefore.id);
            const beforeReadAt = readAtOf(selectEdge());

            // OPERATIONAL re-seed: the caller opts in, so the lagged snapshot's null must not revert the mark.
            const importResult = await MemoryDatabaseService.manageDatabaseBackup({action: 'import', file: graphBackupPath, mode: 'replace', preserveDeliveryReadState: true, confirmation: {sqlitePath: graphPathToken}});
            const edgeAfter = selectEdge();

            // DISASTER-RECOVERY restore: same snapshot, no opt-in. "The backup IS the new state" must hold —
            // preservation is a caller's operational choice, never an implicit rewrite of restore semantics.
            const reMarkEdge = selectEdge();
            db.prepare("UPDATE Edges SET data = json_set(data, '$.properties.readAt', ?) WHERE id = ?").run(committedReadAt, reMarkEdge.id);
            const beforeExactRestore = readAtOf(selectEdge());
            await MemoryDatabaseService.manageDatabaseBackup({action: 'import', file: graphBackupPath, mode: 'replace', confirmation: {sqlitePath: graphPathToken}});
            const exactRestoreReadAt = readAtOf(selectEdge());

            console.log('READAT_RESEED_RESULT:' + JSON.stringify({
                beforeReadAt,
                committedReadAt,
                afterReadAt        : readAtOf(edgeAfter),
                edgePresent        : !!edgeAfter,
                beforeExactRestore,
                exactRestoreReadAt : exactRestoreReadAt ?? null,
                imported           : importResult.imported
            }));
        `.replace(/graphPathToken/g, JSON.stringify(graphPath));

        try {
            const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
                cwd     : process.cwd(),
                encoding: 'utf8',
                env     : {
                    ...process.env,
                    NEO_MEMORY_DB_PATH_TEST: graphPath,
                    UNIT_TEST_MODE         : 'true'
                },
                timeout: 30_000
            });

            expect(result.error, `${result.stderr}\n${result.stdout}`).toBeUndefined();
            expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);

            const output = result.stdout.match(/^READAT_RESEED_RESULT:(.+)$/m);

            expect(output, result.stdout).toBeTruthy();

            const proof = JSON.parse(output[1]);

            // Preconditions: the mark committed, and the edge survived the re-seed (it exists in the snapshot).
            expect(proof.beforeReadAt).toBe(proof.committedReadAt);
            expect(proof.edgePresent).toBe(true);

            // The discriminating assertion — RED without the fix (readAt reverts to the snapshot's null),
            // GREEN with it (the committed receipt is re-applied across the truncate).
            expect(proof.afterReadAt).toBe(proof.committedReadAt);

            // The other half of the contract: WITHOUT the opt-in, `replace` still means "the backup IS the
            // new state". Preservation is an operational-re-seed choice the caller makes, never an implicit
            // rewrite of disaster-recovery semantics — a restore that silently kept live state would be a
            // worse defect than the revert this fix exists to prevent.
            expect(proof.beforeExactRestore).toBe(proof.committedReadAt);
            expect(proof.exactRestoreReadAt).toBeNull();
        } finally {
            fs.rmSync(tmpDir, {recursive: true, force: true});
        }
    });
});

test('disposable owner: actual import and truncate methods fence with isolated service dependencies', () => {
    const tmpDir       = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-restore-owner-fence-'));
    const ownerUrl     = new URL('../../../../../../ai/services/memory-core/DatabaseService.mjs', import.meta.url).href;
    const fenceUrl     = new URL('../../../../../../ai/services/memory-core/helpers/identityPublicationFence.mjs', import.meta.url).href;
    const canonicalUrl = new URL('../../../../../../ai/services/shared/canonicalJson.mjs', import.meta.url).href;
    const script       = `
        import assert from 'node:assert/strict';
        import {registerHooks} from 'node:module';
        import Database from 'better-sqlite3';
        import fs from 'node:fs';
        import path from 'node:path';
        import {fenceIdentityPublication, readIdentityPublicationFence} from ${JSON.stringify(fenceUrl)};
        import {stringifyCanonicalJson} from ${JSON.stringify(canonicalUrl)};
        await import('neo.mjs/src/Neo.mjs');
        await import('neo.mjs/src/core/_export.mjs');
        const root = ${JSON.stringify(tmpDir)}, ownerUrl = ${JSON.stringify(ownerUrl)};
        const target = {planeId: 'owner-fixture', dataRoot: root};
        const db = new Database(path.join(root, 'graph.sqlite'));
        db.exec('CREATE TABLE Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL); CREATE TABLE Edges (id TEXT PRIMARY KEY, user_id TEXT, source TEXT, target TEXT, type TEXT, data TEXT NOT NULL);');
        const records = [
            {type: 'node', data: {id: 'message', label: 'MESSAGE', properties: {}}},
            {type: 'node', data: {id: 'recipient', label: 'AgentIdentity', properties: {}}},
            {type: 'edge', data: {id: 'delivery', source: 'message', target: 'recipient', type: 'DELIVERED_TO', properties: {readAt: null}}}
        ];
        for (const {type, data} of records) {
            if (type === 'node') db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run(data.id, JSON.stringify(data));
            else db.prepare('INSERT INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)').run(data.id, data.source, data.target, data.type, JSON.stringify(data));
        }
        const clear = () => db.prepare('UPDATE IdentityPublicationFence SET data = ?').run(stringifyCanonicalJson({version: 1, ...target, state: 'clear', cause: null}));
        db.transaction(() => fenceIdentityPublication(db, {...target, operation: 'fixture', source: 'fixture'})).immediate();
        clear();
        const calls = [];
        globalThis.fixtureGraphOwner = {
            db: {storage: {db}}, refuse: false,
            fenceIdentityPublication(info) {
                assert.equal(info.db, db);
                assert.equal(db.inTransaction, true);
                calls.push(info.operation);
                const fenced = fenceIdentityPublication(db, {...target, operation: info.operation, source: info.source});
                if (this.refuse) throw new Error('fixture owner refusal');
                return fenced;
            }
        };
        const modules = new Map([
            ['../../mcp/server/memory-core/config.mjs', 'export default ' + JSON.stringify({storagePaths: {graph: db.name}, vectorDimension: 3})],
            ['../../mcp/server/memory-core/logger.mjs', 'export default {log() {}, warn() {}, error() {}}'],
            ['./managers/StorageRouter.mjs', 'export default {async ready() {}}'],
            ['../../mcp/server/shared/services/DestructiveOperationGuard.mjs', 'export default {async assertDestructiveTargetAllowed() {if (globalThis.fixtureTargetRefuse) throw new Error("fixture target refusal");}}'],
            ['./GraphService.mjs', 'export default globalThis.fixtureGraphOwner']
        ]);
        const seen = new Set();
        const hooks = registerHooks({resolve(specifier, context, nextResolve) {
            if (context.parentURL === ownerUrl && modules.has(specifier)) {
                seen.add(specifier);
                return {url: 'data:text/javascript,' + encodeURIComponent(modules.get(specifier)), shortCircuit: true};
            }
            return nextResolve(specifier, context);
        }});
        try {
            const owner = (await import(ownerUrl)).default;
            await owner.ready();
            const file = path.join(root, 'graph-backup-fixture.jsonl');
            fs.writeFileSync(file, records.map(row => JSON.stringify(row)).join('\\n') + '\\n');
            db.prepare("UPDATE Edges SET data = json_set(data, '$.properties.readAt', 'committed')").run();
            await owner.importDatabase({file, mode: 'replace', preserveDeliveryReadState: true});
            assert.equal(db.prepare("SELECT json_extract(data, '$.properties.readAt') AS value FROM Edges").get().value, 'committed');
            // The truncation's rolled-back admission probe, its real fence, then the import's.
            assert.deepEqual(calls, ['graph-truncate', 'graph-truncate', 'graph-import-replace']);
            assert.equal(readIdentityPublicationFence(db, target).state, 'fenced');
            clear();
            await owner.importDatabase({file, mode: 'merge'});
            assert.equal(readIdentityPublicationFence(db, target).cause.operation, 'graph-import-merge');
            clear();
            const before = db.prepare('SELECT * FROM Nodes ORDER BY id').all();
            globalThis.fixtureGraphOwner.refuse = true;
            await assert.rejects(owner.truncateDatabase({include: ['graph']}), /fixture owner refusal/);
            assert.deepEqual(db.prepare('SELECT * FROM Nodes ORDER BY id').all(), before);
            assert.equal(readIdentityPublicationFence(db, target).state, 'clear');

            // Every graph refusal is decided before a vector collection drops.
            const drops = [];
            class RecordingCollectionProxy extends Neo.core.Base {
                static config = {className: 'Neo.ai.services.memory-core.managers.CollectionProxy', collectionType: null};
                async drop() {drops.push(this.collectionType);}
            }
            Neo.setupClass(RecordingCollectionProxy);
            const truncateWithVectors = () => owner.truncateDatabase({include: ['memories', 'graph']});
            globalThis.fixtureTargetRefuse = true;
            await assert.rejects(truncateWithVectors(), /fixture target refusal/);
            globalThis.fixtureTargetRefuse = false;
            await assert.rejects(truncateWithVectors(), /fixture owner refusal/);
            globalThis.fixtureGraphOwner.refuse = false;
            db.prepare('UPDATE IdentityPublicationFence SET data = ?').run('{"version":1}');
            await assert.rejects(truncateWithVectors(), /malformed or wrong-target state/);
            assert.deepEqual(drops, []);
            assert.deepEqual(db.prepare('SELECT * FROM Nodes ORDER BY id').all(), before);

            // An accepted truncation behaves as before: the vectors drop, then the fenced graph empties.
            clear();
            await truncateWithVectors();
            assert.deepEqual(drops, ['memory']);
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Nodes').get().n, 0);
            assert.equal(readIdentityPublicationFence(db, target).cause.operation, 'graph-truncate');
            assert.deepEqual(seen, new Set(modules.keys()));
        } finally {hooks.deregister(); db.close();}
    `;
    try {
        const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {encoding: 'utf8', timeout: 15000});
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr + result.stdout).toBe(0);
    } finally {fs.rmSync(tmpDir, {recursive: true, force: true});}
});

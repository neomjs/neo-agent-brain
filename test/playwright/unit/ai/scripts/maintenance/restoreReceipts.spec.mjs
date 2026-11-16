import {setup} from '../../../../setup.mjs';

setup({
    appConfig: {
        name: 'AiRestoreReceiptsTest'
    }
});

import {test, expect}                                           from '@playwright/test';
import Neo                                                      from 'neo.mjs/src/Neo.mjs';
import * as core                                                from 'neo.mjs/src/core/_export.mjs';
import Database                                                 from 'better-sqlite3';
import fs                                                       from 'fs-extra';
import path                                                     from 'path';
import os                                                       from 'node:os';
import {fenceIdentityPublication, readIdentityPublicationFence} from '../../../../../../ai/services/memory-core/helpers/identityPublicationFence.mjs';
import {stringifyCanonicalJson}                                 from '../../../../../../ai/services/shared/canonicalJson.mjs';
import {
    MAILBOX_EDGE_TYPES,
    assertRestoreReceiptsTarget,
    resolveGraphJsonl,
    restoreReceipts,
    runRestoreReceipts as runRestoreReceiptsOwner,
    validateGraphJsonl
} from '../../../../../../ai/scripts/maintenance/restoreReceipts.mjs';

/**
 * @summary The receipts restore fills only what the live graph lacks: a null receipt takes the bundle's
 * value, a committed one is never regressed, a mailbox edge is never inserted, a named type is inserted
 * once where both endpoints exist, and a dry run writes nothing.
 */
test.describe('restoreReceipts maintenance script', () => {
    let tmpRoot, dbPath, jsonlPath;
    const quiet          = {log() {}, error() {}};
    const fenceTarget    = () => ({planeId: 'receipt-fixture', dataRoot: tmpRoot});
    const beforeMutation = info => fenceIdentityPublication(info.db, {
        ...fenceTarget(), operation: info.operation, source: info.source
    });
    const runRestoreReceipts = options => runRestoreReceiptsOwner({beforeMutation, ...options});

    const node = (id, label, properties = {}) => ({type: 'node', data: {id, label, properties}});
    const edge = (id, source, target, type, properties = {}) => ({type: 'edge', data: {id, source, target, type, properties: {weight: 1, ...properties}}});

    const openDb = () => new Database(dbPath);

    const seedLive = records => {
        const db = openDb();
        db.exec(`
            CREATE TABLE IF NOT EXISTS Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS Edges (
                id TEXT PRIMARY KEY, user_id TEXT, source TEXT NOT NULL, target TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL,
                FOREIGN KEY (source) REFERENCES Nodes(id) ON DELETE CASCADE,
                FOREIGN KEY (target) REFERENCES Nodes(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_edges_source ON Edges(source);
            CREATE INDEX IF NOT EXISTS idx_edges_target ON Edges(target);
        `);
        const insertNode = db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, NULL, ?)'),
              insertEdge = db.prepare('INSERT INTO Edges (id, user_id, source, target, type, data) VALUES (?, NULL, ?, ?, ?, ?)');
        records.forEach(({type, data}) => type === 'node'
            ? insertNode.run(data.id, JSON.stringify(data))
            : insertEdge.run(data.id, data.source, data.target, data.type, JSON.stringify(data)));
        db.transaction(() => beforeMutation({db, operation: 'fixture', source: 'fixture'})).immediate();
        db.prepare('UPDATE IdentityPublicationFence SET data = ?').run(stringifyCanonicalJson({
            version: 1, ...fenceTarget(), state: 'clear', cause: null
        }));
        db.close();
    };

    const writeBundle = records => fs.writeFileSync(jsonlPath, records.map(record => JSON.stringify(record)).join('\n') + '\n');

    const liveEdges = () => {
        const db   = openDb();
        const rows = db.prepare("SELECT id, source, target, type, json_extract(data, '$.properties.readAt') AS readAt, json_extract(data, '$.properties.archivedAt') AS archivedAt FROM Edges ORDER BY type, source, target").all();
        db.close();
        return rows;
    };

    const liveNode = id => {
        const db  = openDb();
        const row = db.prepare("SELECT json_extract(data, '$.properties.readAt') AS readAt FROM Nodes WHERE id = ?").get(id);
        db.close();
        return row;
    };

    const liveFence = () => {
        const db = openDb();
        try { return readIdentityPublicationFence(db, fenceTarget()); }
        finally { db.close(); }
    };

    test.beforeEach(async () => {
        tmpRoot   = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-receipts-'));
        dbPath    = path.join(tmpRoot, 'memory-core-graph.sqlite');
        jsonlPath = path.join(tmpRoot, 'bundle', 'graph', 'graph-backup.jsonl');
        await fs.ensureDir(path.dirname(jsonlPath));
    });

    test.afterEach(async () => {
        await fs.remove(tmpRoot);
    });

    test('a null live receipt takes the bundle value; a committed one is never regressed', async () => {
        seedLive([
            node('MESSAGE:m1', 'MESSAGE', {readAt: null}), node('MESSAGE:m2', 'MESSAGE', {readAt: '2026-09-25T20:00:00.000Z'}), node('@a', 'AgentIdentity'), node('@b', 'AgentIdentity'),
            edge('re-derived-id', 'MESSAGE:m1', '@a', 'DELIVERED_TO', {readAt: null, archivedAt: null}),
            edge('fresh-mark',    'MESSAGE:m1', '@b', 'DELIVERED_TO', {readAt: '2026-09-25T22:00:00.000Z', archivedAt: null})
        ]);
        writeBundle([
            node('MESSAGE:m1', 'MESSAGE', {readAt: '2026-09-25T10:00:00.000Z'}),
            node('MESSAGE:m2', 'MESSAGE', {readAt: '2026-09-25T09:00:00.000Z'}),
            edge('original-id', 'MESSAGE:m1', '@a', 'DELIVERED_TO', {readAt: '2026-09-25T11:00:00.000Z', archivedAt: '2026-09-25T12:00:00.000Z'}),
            edge('older-mark',  'MESSAGE:m1', '@b', 'DELIVERED_TO', {readAt: '2026-09-25T11:30:00.000Z'})
        ]);

        const result = await runRestoreReceipts({dbPath, source: jsonlPath, apply: true, logger: quiet});

        expect(result.receipts.edges).toEqual({matched: 2, filled: 2, alreadySet: 1, missingLive: 0, duplicateInBundle: 0});
        expect(result.receipts.nodes).toEqual({matched: 2, filled: 1, alreadySet: 1, missingLive: 0, duplicateInBundle: 0});
        expect(liveEdges()).toEqual([
            {id: 're-derived-id', source: 'MESSAGE:m1', target: '@a', type: 'DELIVERED_TO', readAt: '2026-09-25T11:00:00.000Z', archivedAt: '2026-09-25T12:00:00.000Z'},
            {id: 'fresh-mark',    source: 'MESSAGE:m1', target: '@b', type: 'DELIVERED_TO', readAt: '2026-09-25T22:00:00.000Z', archivedAt: null}
        ]);
        expect(liveNode('MESSAGE:m1').readAt).toBe('2026-09-25T10:00:00.000Z');
        expect(liveNode('MESSAGE:m2').readAt).toBe('2026-09-25T20:00:00.000Z');
        expect(liveFence().state).toBe('fenced');
    });

    test('missing or declared async callbacks refuse apply before touching receipts', async () => {
        seedLive([node('MESSAGE:m1', 'MESSAGE', {readAt: null})]);
        writeBundle([node('MESSAGE:m1', 'MESSAGE', {readAt: 'restored'})]);
        for (const callback of [undefined, async () => {}]) {
            await expect(runRestoreReceipts({dbPath, source: jsonlPath, apply: true,
                beforeMutation: callback, logger: quiet})).rejects.toThrow(/synchronous.*fence/);
            expect(liveNode('MESSAGE:m1').readAt).toBeNull();
            expect(liveFence().state).toBe('clear');
        }
    });

    test('receipt writes and their fence commit atomically on the physical handle', async () => {
        seedLive([node('MESSAGE:m1', 'MESSAGE', {readAt: null})]);
        writeBundle([node('MESSAGE:m1', 'MESSAGE', {readAt: 'restored'}),
            node('clear-spoof', 'IdentityPublicationFence', {state: 'clear'})]);
        let called = 0;
        await runRestoreReceipts({dbPath, source: jsonlPath, apply: true, logger: quiet,
            beforeMutation: info => {
                called++;
                expect(info.db.inTransaction).toBe(true);
                expect(info.operation).toBe('restore-receipts');
                beforeMutation(info);
                expect(liveFence().state).toBe('clear');
                expect(liveNode('MESSAGE:m1').readAt).toBeNull();
            }});
        expect(called).toBe(1);
        expect(liveNode('MESSAGE:m1').readAt).toBe('restored');
        expect(liveFence().state).toBe('fenced');
    });

    test('a receipt fence refusal rolls back eligibility and reports no committed writes', async () => {
        seedLive([node('MESSAGE:m1', 'MESSAGE', {readAt: null})]);
        writeBundle([node('MESSAGE:m1', 'MESSAGE', {readAt: 'restored'})]);
        const error = await runRestoreReceipts({dbPath, source: jsonlPath, apply: true, logger: quiet,
            beforeMutation: info => {
                beforeMutation(info);
                throw new Error('fixture receipt refusal');
            }}).then(() => null, error => error);
        expect(error?.message).toBe('fixture receipt refusal');
        expect(error.committed).toBeNull();
        expect(liveNode('MESSAGE:m1').readAt).toBeNull();
        expect(liveFence().state).toBe('clear');
    });

    test('receipt restoration refuses protected relations and cold protected endpoints', async () => {
        seedLive([node('@a', 'AgentIdentity'), node('ordinary-id', 'IDENTITY_FAMILY_CURRENT')]);
        for (const type of ['IDENTITY_FAMILY_LINK', 'RELATES_TO']) {
            writeBundle([edge('ordinary-edge', '@a', 'ordinary-id', type)]);
            await expect(runRestoreReceipts({dbPath, source: jsonlPath, apply: true,
                edgeTypes: [type], logger: quiet})).rejects.toThrow(/Protected identity-publication/);
            expect(liveEdges()).toEqual([]);
            expect(liveFence().state).toBe('clear');
        }
    });

    test('apply target qualification accepts the configured file and refuses a different existing database', () => {
        seedLive([]);
        const alias = path.join(tmpRoot, 'alias.sqlite'), other = path.join(tmpRoot, 'other.sqlite');
        fs.symlinkSync(dbPath, alias);
        fs.writeFileSync(other, '');
        expect(() => assertRestoreReceiptsTarget(alias, dbPath)).not.toThrow();
        expect(() => assertRestoreReceiptsTarget(other, dbPath)).toThrow('configured live graph path');
        expect(() => assertRestoreReceiptsTarget(dbPath, undefined)).toThrow('configured live graph path');
    });

    test('a colliding protected bundle id cannot become an ordinary edge through id replacement', async () => {
        seedLive([node('@a', 'AgentIdentity'), node('@b', 'AgentIdentity'),
            edge('identity-family-collision', '@a', '@b', 'RELATES_TO')]);
        writeBundle([edge('identity-family-collision', '@b', '@a', 'RELATES_TO')]);
        await expect(runRestoreReceipts({dbPath, source: jsonlPath, apply: true,
            edgeTypes: ['RELATES_TO'], logger: quiet})).rejects.toThrow(/Protected identity-publication/);
        expect(liveEdges()).toHaveLength(1);
        expect(liveFence().state).toBe('clear');
    });

    test('nested receipt restore and thenable fences refuse without committing graph changes', async () => {
        seedLive([node('MESSAGE:m1', 'MESSAGE', {readAt: null})]);
        writeBundle([node('MESSAGE:m1', 'MESSAGE', {readAt: 'restored'})]);
        const db = openDb();
        db.exec('BEGIN IMMEDIATE');
        try {
            await expect(restoreReceipts({db, jsonl: jsonlPath, apply: true, beforeMutation}))
                .rejects.toThrow('existing transaction');
        } finally { db.exec('ROLLBACK'); db.close(); }
        await expect(runRestoreReceipts({dbPath, source: jsonlPath, apply: true, logger: quiet,
            beforeMutation: info => {
                beforeMutation(info);
                return Promise.reject(new Error('fixture async refusal'));
            }})).rejects.toThrow('synchronous');
        expect(liveNode('MESSAGE:m1').readAt).toBeNull();
        expect(liveFence().state).toBe('clear');
    });

    test('a later batch refusal reports only earlier committed receipt counts', async () => {
        const rows = Array.from({length: 1001}, (_, index) => node(`MESSAGE:${index}`, 'MESSAGE', {readAt: null}));
        seedLive(rows);
        writeBundle(rows.map(row => node(row.data.id, 'MESSAGE', {readAt: 'restored'})));
        let   batches = 0;
        const error   = await runRestoreReceipts({dbPath, source: jsonlPath, apply: true, logger: quiet,
            beforeMutation: info => {
                if (++batches === 2) throw new Error('second batch refused');
                return beforeMutation(info);
            }}).then(() => null, error => error);
        expect(error.message).toBe('second batch refused');
        expect(error.committed.receipts.nodes.filled).toBe(1000);
        expect(liveNode('MESSAGE:999').readAt).toBe('restored');
        expect(liveNode('MESSAGE:1000').readAt).toBeNull();
        expect(liveFence().state).toBe('fenced');
    });

    test('a bundle written at the head holds graph/*.jsonl.br — the receipts come from the compressed payload (#974)', async () => {
        const zlib       = (await import('zlib')).default;
        const bundleRoot = path.dirname(path.dirname(jsonlPath));

        seedLive([
            node('MESSAGE:m1', 'MESSAGE', {readAt: null}), node('@a', 'AgentIdentity'),
            edge('re-derived-id', 'MESSAGE:m1', '@a', 'DELIVERED_TO', {readAt: null, archivedAt: null})
        ]);

        const records = [
            node('MESSAGE:m1', 'MESSAGE', {readAt: '2026-09-25T10:00:00.000Z'}),
            edge('original-id', 'MESSAGE:m1', '@a', 'DELIVERED_TO', {readAt: '2026-09-25T11:00:00.000Z', archivedAt: null})
        ];
        fs.writeFileSync(`${jsonlPath}.br`, zlib.brotliCompressSync(Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n')));

        const result = await runRestoreReceipts({dbPath, source: bundleRoot, apply: true, logger: quiet});

        expect(result.receipts.edges).toMatchObject({matched: 1, filled: 1});
        expect(liveNode('MESSAGE:m1').readAt).toBe('2026-09-25T10:00:00.000Z');
    });

    test('a mailbox edge with no live counterpart is reported, never inserted', async () => {
        seedLive([node('MESSAGE:m1', 'MESSAGE'), node('@a', 'AgentIdentity')]);
        writeBundle([
            edge('gone', 'MESSAGE:m1', '@a', 'DELIVERED_TO', {readAt: '2026-09-25T11:00:00.000Z'}),
            edge('gone-sent', 'MESSAGE:m1', '@a', 'SENT_TO')
        ]);

        const result = await runRestoreReceipts({dbPath, source: jsonlPath, apply: true, edgeTypes: [...MAILBOX_EDGE_TYPES], logger: quiet});

        expect(result.receipts.edges).toEqual({matched: 0, filled: 0, alreadySet: 0, missingLive: 1, duplicateInBundle: 0});
        expect(result.edges.requested).toEqual([]);
        expect(liveEdges()).toEqual([]);
    });

    test('an absent edge of a named type is inserted once where both endpoints exist; a rerun inserts nothing', async () => {
        seedLive([
            node('@a', 'AgentIdentity'), node('@b', 'AgentIdentity'), node('turn-1', 'AGENT_TURN_PRESENCE'),
            edge('taken-id', '@a', '@b', 'RELATES_TO')
        ]);
        writeBundle([
            edge('presence-1', '@a', 'turn-1', 'AGENT_TURN_PRESENCE', {weight: 0.7}),
            edge('taken-id',   '@b', 'turn-1', 'AGENT_TURN_PRESENCE'),
            edge('dangling',   '@a', 'turn-gone', 'AGENT_TURN_PRESENCE'),
            edge('not-named',  '@a', '@b', 'TAGGED_CONCEPT')
        ]);

        const first = await runRestoreReceipts({dbPath, source: jsonlPath, apply: true, edgeTypes: ['AGENT_TURN_PRESENCE'], logger: quiet});

        expect(first.edges.types.AGENT_TURN_PRESENCE).toEqual({bundle: 3, live: 0, absentLive: 3, restorable: 2, missingEndpoint: 1, duplicateInBundle: 0, inserted: 2});
        expect(first.edges.types.TAGGED_CONCEPT).toEqual({bundle: 1, live: 0, absentLive: 1, restorable: 1, missingEndpoint: 0, duplicateInBundle: 0, inserted: 0});

        const inserted = liveEdges().filter(row => row.type === 'AGENT_TURN_PRESENCE');
        expect(inserted.map(row => [row.source, row.target])).toEqual([['@a', 'turn-1'], ['@b', 'turn-1']]);
        expect(inserted[0].id).toBe('presence-1');
        expect(inserted[1].id).not.toBe('taken-id');

        const second = await runRestoreReceipts({dbPath, source: jsonlPath, apply: true, edgeTypes: ['AGENT_TURN_PRESENCE'], logger: quiet});

        expect(second.edges.types.AGENT_TURN_PRESENCE).toEqual({bundle: 3, live: 2, absentLive: 1, restorable: 0, missingEndpoint: 1, duplicateInBundle: 0, inserted: 0});
        expect(liveEdges().filter(row => row.type === 'AGENT_TURN_PRESENCE')).toHaveLength(2);
    });

    test('a dry run counts the same work and writes nothing', async () => {
        seedLive([
            node('MESSAGE:m1', 'MESSAGE', {readAt: null}), node('@a', 'AgentIdentity'), node('turn-1', 'AGENT_TURN_PRESENCE'),
            edge('re-derived-id', 'MESSAGE:m1', '@a', 'DELIVERED_TO', {readAt: null})
        ]);
        writeBundle([
            node('MESSAGE:m1', 'MESSAGE', {readAt: '2026-09-25T10:00:00.000Z'}),
            edge('original-id', 'MESSAGE:m1', '@a', 'DELIVERED_TO', {readAt: '2026-09-25T11:00:00.000Z'}),
            edge('presence-1', '@a', 'turn-1', 'AGENT_TURN_PRESENCE')
        ]);
        const before = {edges: liveEdges(), node: liveNode('MESSAGE:m1')};

        const result = await runRestoreReceipts({dbPath, source: path.dirname(path.dirname(jsonlPath)), edgeTypes: ['AGENT_TURN_PRESENCE'], logger: quiet});

        expect(result.receipts.edges).toEqual({matched: 1, filled: 1, alreadySet: 0, missingLive: 0, duplicateInBundle: 0});
        expect(result.receipts.nodes).toEqual({matched: 1, filled: 1, alreadySet: 0, missingLive: 0, duplicateInBundle: 0});
        expect(result.edges.types.AGENT_TURN_PRESENCE).toEqual({bundle: 1, live: 0, absentLive: 1, restorable: 1, missingEndpoint: 0, duplicateInBundle: 0, inserted: 0});
        expect({edges: liveEdges(), node: liveNode('MESSAGE:m1')}).toEqual(before);
    });

    test('two bundle rows for one identity in one batch insert one edge; the first bundle row wins', async () => {
        seedLive([node('@a', 'AgentIdentity'), node('@b', 'AgentIdentity')]);
        writeBundle([
            edge('first-id',  '@a', '@b', 'RELATES_TO', {weight: 0.9}),
            edge('second-id', '@a', '@b', 'RELATES_TO', {weight: 0.1})
        ]);

        const result = await runRestoreReceipts({dbPath, source: jsonlPath, apply: true, edgeTypes: ['RELATES_TO'], logger: quiet});

        expect(result.edges.types.RELATES_TO).toEqual({bundle: 2, live: 0, absentLive: 1, restorable: 1, missingEndpoint: 0, duplicateInBundle: 1, inserted: 1});
        const rows = liveEdges();
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe('first-id');
    });

    test('two bundle receipts for one live field fill it once with the first value', async () => {
        seedLive([
            node('MESSAGE:m1', 'MESSAGE', {readAt: null}), node('@a', 'AgentIdentity'),
            edge('live-id', 'MESSAGE:m1', '@a', 'DELIVERED_TO', {readAt: null})
        ]);
        writeBundle([
            node('MESSAGE:m1', 'MESSAGE', {readAt: '2026-09-25T10:00:00.000Z'}),
            node('MESSAGE:m1', 'MESSAGE', {readAt: '2026-09-25T09:00:00.000Z'}),
            edge('bundle-a', 'MESSAGE:m1', '@a', 'DELIVERED_TO', {readAt: '2026-09-25T11:00:00.000Z'}),
            edge('bundle-b', 'MESSAGE:m1', '@a', 'DELIVERED_TO', {readAt: '2026-09-25T12:00:00.000Z'})
        ]);

        const result = await runRestoreReceipts({dbPath, source: jsonlPath, apply: true, logger: quiet});

        expect(result.receipts.edges).toEqual({matched: 2, filled: 1, alreadySet: 0, missingLive: 0, duplicateInBundle: 1});
        expect(result.receipts.nodes).toEqual({matched: 2, filled: 1, alreadySet: 0, missingLive: 0, duplicateInBundle: 1});
        expect(liveEdges()[0].readAt).toBe('2026-09-25T11:00:00.000Z');
        expect(liveNode('MESSAGE:m1').readAt).toBe('2026-09-25T10:00:00.000Z');
    });

    test('a malformed record after more than one batch of fills refuses the run before any write', async () => {
        const count = 1001;
        seedLive(Array.from({length: count}, (_, i) => node(`MESSAGE:m${i}`, 'MESSAGE', {readAt: null})));
        writeBundle(Array.from({length: count}, (_, i) => node(`MESSAGE:m${i}`, 'MESSAGE', {readAt: '2026-09-25T10:00:00.000Z'})));
        fs.appendFileSync(jsonlPath, '{"type":"node","data":{"id":"MESSAGE:broken"\n');

        await expect(runRestoreReceipts({dbPath, source: jsonlPath, apply: true, logger: quiet})).rejects.toThrow(`:${count + 1} does not parse`);
        await expect(validateGraphJsonl(jsonlPath)).rejects.toThrow('nothing was written');

        const db = openDb();
        expect(db.prepare("SELECT COUNT(*) AS n FROM Nodes WHERE json_extract(data, '$.properties.readAt') IS NOT NULL").get().n).toBe(0);
        db.close();
    });

    test('a bundle directory resolves to its one graph JSONL; none or two refuse', async () => {
        const bundleRoot = path.dirname(path.dirname(jsonlPath));

        expect(() => resolveGraphJsonl(bundleRoot)).toThrow(/exactly one graph/);

        writeBundle([]);
        expect(resolveGraphJsonl(bundleRoot)).toBe(jsonlPath);

        fs.writeFileSync(path.join(path.dirname(jsonlPath), 'second.jsonl'), '');
        expect(() => resolveGraphJsonl(bundleRoot)).toThrow(/found 2/);
        expect(() => resolveGraphJsonl(path.join(tmpRoot, 'missing'))).toThrow(/does not exist/);
    });
});

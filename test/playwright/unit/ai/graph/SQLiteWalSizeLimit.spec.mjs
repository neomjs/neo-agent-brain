import {setup} from '../../../setup.mjs';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : 'AiSQLiteWalSizeLimitTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}                             from '@playwright/test';
import Neo                                        from 'neo.mjs/src/Neo.mjs';
import * as core                                  from 'neo.mjs/src/core/_export.mjs';
import SQLite, {isCompositeMessageSentAtIndexSql} from '../../../../../ai/graph/storage/SQLite.mjs';
import BetterSqlite                               from 'better-sqlite3';
import fs                                         from 'fs-extra';
import path                                       from 'path';

const WAL_LIMIT = 64 * 1024 * 1024;

/**
 * SQLite reuses a WAL file after a checkpoint instead of shrinking it, so without `journal_size_limit`
 * one burst leaves the file at its high-water size for good. The plane's graph WAL stood at 9.7 GB
 * around 3.3 MB of live frames.
 */
test.describe('Neo.ai.graph.storage.SQLite — WAL size limit', () => {
    const tmpDir = path.resolve(process.cwd(), 'tmp'),
          dbPath = path.join(tmpDir, `graph-wal-limit-test-${process.pid}.sqlite`),
          remove = () => ['', '-wal', '-shm'].forEach(suffix => fs.rmSync(dbPath + suffix, {force: true}));

    let storage;

    test.beforeEach(async () => {
        await fs.ensureDir(tmpDir);
        remove();
        storage = Neo.create(SQLite, {dbPath});
        await storage.initAsync();
    });

    test.afterEach(() => {
        storage?.db?.close();
        storage?.destroy?.();
        storage = null;
        remove();
    });

    test('every graph connection limits the WAL to 64 MiB', () => {
        expect(storage.db.pragma('journal_size_limit', {simple: true})).toBe(WAL_LIMIT);
    });

    test('a checkpoint that resets the WAL truncates the file to the limit', () => {
        // A second connection holds a read snapshot, so the writes below grow the WAL past the limit
        // instead of letting the automatic checkpoint recycle it.
        const reader = new BetterSqlite(dbPath);

        reader.exec('BEGIN');
        reader.prepare('SELECT count(*) FROM Nodes').get();

        storage.db.exec('CREATE TABLE WalProbe (v BLOB)');

        const insert = storage.db.prepare('INSERT INTO WalProbe (v) VALUES (?)'),
              blob   = Buffer.alloc(64 * 1024),
              write  = storage.db.transaction(count => {for (let i = 0; i < count; i++) insert.run(blob)});

        for (let batch = 0; batch < 30; batch++) write(40);

        expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(WAL_LIMIT);

        reader.exec('COMMIT');
        reader.close();
        storage.db.pragma('wal_checkpoint(PASSIVE)');
        insert.run(Buffer.alloc(16)); // the first write after a complete checkpoint resets the log

        expect(fs.statSync(`${dbPath}-wal`).size).toBeLessThanOrEqual(WAL_LIMIT);
    });
});

test.describe('Neo.ai.graph.storage.SQLite — expression indexes and schema migration', () => {
    const tmpDir = path.resolve(process.cwd(), 'tmp'),
          dbPath = path.join(tmpDir, `graph-index-migration-test-${process.pid}.sqlite`),
          remove = () => ['', '-wal', '-shm'].forEach(suffix => fs.rmSync(dbPath + suffix, {force: true}));

    let storage;

    test.beforeEach(async () => {
        await fs.ensureDir(tmpDir);
        remove();
    });

    test.afterEach(() => {
        storage?.db?.close();
        storage?.destroy?.();
        storage = null;
        remove();
    });

    test('migrates legacy single-column idx_nodes_message_sent_at and creates idx_nodes_session_user_id idempotently', async () => {
        const seedDb = new BetterSqlite(dbPath);

        seedDb.exec(`
            CREATE TABLE Nodes (
                id TEXT PRIMARY KEY,
                user_id TEXT DEFAULT NULL,
                data TEXT NOT NULL
            );
            CREATE INDEX idx_nodes_message_sent_at
                ON Nodes(json_extract(data, '$.properties.sentAt')) WHERE id LIKE 'MESSAGE:%';
        `);
        seedDb.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run(
            'MESSAGE:legacy',
            JSON.stringify({id: 'MESSAGE:legacy', label: 'MESSAGE', properties: {sentAt: '2026-11-11T00:00:00.000Z'}})
        );
        seedDb.close();

        storage = Neo.create(SQLite, {dbPath});
        await storage.initAsync();

        const readIndexEntry = name => storage.db.prepare(`
            SELECT sql, rootpage FROM sqlite_master
            WHERE type = 'index' AND name = ?
        `).get(name);

        const migratedMessageIndex = readIndexEntry('idx_nodes_message_sent_at'),
              sessionUserIndex     = readIndexEntry('idx_nodes_session_user_id');

        expect(isCompositeMessageSentAtIndexSql(migratedMessageIndex?.sql)).toBe(true);
        expect(isCompositeMessageSentAtIndexSql("CREATE INDEX idx_nodes_message_sent_at ON Nodes(json_extract(data, '$.properties.sentAt')) WHERE id LIKE 'MESSAGE:%'")).toBe(false);
        expect(migratedMessageIndex.sql).toContain("json_extract(data, '$.properties.sentAt') DESC, id DESC");
        expect(migratedMessageIndex.sql).toContain("WHERE id LIKE 'MESSAGE:%'");
        expect(sessionUserIndex.sql).toContain("COALESCE(json_extract(data, '$.properties.userId'), '')");
        expect(sessionUserIndex.sql).toContain("WHERE json_extract(data, '$.label') = 'SESSION'");

        storage.initSchema();
        expect(readIndexEntry('idx_nodes_message_sent_at')).toEqual(migratedMessageIndex);
        expect(readIndexEntry('idx_nodes_session_user_id')).toEqual(sessionUserIndex);
    });

    test('tolerates concurrent two-opener migration and missing-index drop races without throwing', async () => {
        const seedDb = new BetterSqlite(dbPath);

        seedDb.exec(`
            CREATE TABLE Nodes (
                id TEXT PRIMARY KEY,
                user_id TEXT DEFAULT NULL,
                data TEXT NOT NULL
            );
            CREATE INDEX idx_nodes_message_sent_at
                ON Nodes(json_extract(data, '$.properties.sentAt')) WHERE id LIKE 'MESSAGE:%';
        `);
        seedDb.close();

        const openerB = Neo.create(SQLite, {dbPath});

        try {
            storage = Neo.create(SQLite, {dbPath});
            await Promise.all([storage.initAsync(), openerB.initAsync()]);

            const entryA = storage.db.prepare("SELECT sql, rootpage FROM sqlite_master WHERE type = 'index' AND name = 'idx_nodes_message_sent_at'").get(),
                  entryB = openerB.db.prepare("SELECT sql, rootpage FROM sqlite_master WHERE type = 'index' AND name = 'idx_nodes_message_sent_at'").get();

            expect(isCompositeMessageSentAtIndexSql(entryA?.sql)).toBe(true);
            expect(entryB).toEqual(entryA);

            // Simulate a stale sqlite_master observation where another opener dropped the legacy index right before DROP runs.
            storage.db.exec('DROP INDEX idx_nodes_message_sent_at');
            const realPrepare          = openerB.db.prepare.bind(openerB.db);
            let   simulatedStaleLookup = false;

            openerB.db.prepare = sql => {
                if (!simulatedStaleLookup && sql.includes('FROM sqlite_master') && sql.includes('type = \'index\'')) {
                    simulatedStaleLookup = true;
                    return {
                        get: () => ({
                            sql: "CREATE INDEX idx_nodes_message_sent_at ON Nodes(json_extract(data, '$.properties.sentAt')) WHERE id LIKE 'MESSAGE:%'"
                        })
                    }
                }

                return realPrepare(sql)
            };

            try {
                expect(() => openerB.initSchema()).not.toThrow();
            } finally {
                openerB.db.prepare = realPrepare
            }

            expect(simulatedStaleLookup).toBe(true);
            const rebuilt = openerB.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_nodes_message_sent_at'").get();
            expect(isCompositeMessageSentAtIndexSql(rebuilt?.sql)).toBe(true);
        } finally {
            openerB.db?.close();
            openerB.destroy?.()
        }
    });
});

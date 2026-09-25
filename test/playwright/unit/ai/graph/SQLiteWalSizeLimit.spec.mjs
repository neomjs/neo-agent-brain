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

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import SQLite         from '../../../../../ai/graph/storage/SQLite.mjs';
import BetterSqlite   from 'better-sqlite3';
import fs             from 'fs-extra';
import path           from 'path';

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

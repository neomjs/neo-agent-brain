import {test, expect}                    from '@playwright/test';
import Database                          from 'better-sqlite3';
import {spawnSync}                       from 'node:child_process';
import {mkdtempSync, rmSync, existsSync} from 'node:fs';
import {tmpdir}                          from 'node:os';
import {join}                            from 'node:path';
import {fileURLToPath}                   from 'node:url';
import {runMigration}                    from '../../../../../../ai/scripts/migrations/normalizeGraphIdentities.mjs';

let db;
const script = fileURLToPath(new URL('../../../../../../ai/scripts/migrations/normalizeGraphIdentities.mjs', import.meta.url));

/** @summary Supplies production-shaped cascading relations and observable write effects in an isolated DB. */
function createSchema() {
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL);
        CREATE TABLE Edges (id TEXT PRIMARY KEY, user_id TEXT,
            source TEXT NOT NULL REFERENCES Nodes(id) ON DELETE CASCADE,
            target TEXT NOT NULL REFERENCES Nodes(id) ON DELETE CASCADE, type TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE GraphLog (id INTEGER PRIMARY KEY, entity_id TEXT);`);
    for (const table of ['Nodes', 'Edges']) {
        for (const action of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER trace_${table}_${action}
            AFTER ${action} ON ${table} BEGIN INSERT INTO GraphLog(entity_id) VALUES (${action === 'DELETE' ? 'OLD' : 'NEW'}.id); END;`);
    }
}

/** @summary Seeds raw historical owner facts rather than using the migration under test. */
function node(id, label = 'AgentIdentity') {
    db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run(id, JSON.stringify({id, label, properties: {}}));
}

/** @summary Captures physical rows and transaction-trigger effects. */
const snapshot = () => Object.fromEntries(['Nodes', 'Edges', 'GraphLog'].map(table =>
    [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));

test.beforeEach(() => { db = new Database(':memory:'); createSchema(); });
test.afterEach(() => db.close());

test('ordinary alias convergence retains preview behavior and is idempotent', () => {
    node('@opus'); node('@neo-opus-ada'); node('other'); node('AGENT:bob');
    const record = {id: 'ordinary', source: '@opus', target: 'other', type: 'RELATED_TO', properties: {}};
    db.prepare('INSERT INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)')
        .run(record.id, record.source, record.target, record.type, JSON.stringify(record));
    const before = snapshot();
    expect(runMigration(db, false).nodesDeleted).toBe(2);
    expect(snapshot()).toEqual(before);
    expect(runMigration(db, true).nodesDeleted).toBe(2);
    expect(db.prepare('SELECT source FROM Edges').get().source).toBe('@neo-opus-ada');
    expect(runMigration(db, true).nodesDeleted).toBe(0);
});

test('a protected incident edge arriving after preview refuses the whole alias apply', () => {
    node('@opus'); node('@neo-opus-ada'); node('other'); node('AGENT:bob');
    runMigration(db, false);
    const record = {id: 'late', source: '@opus', target: 'other', type: 'IDENTITY_FAMILY_DECLARES', properties: {}};
    db.prepare('INSERT INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)')
        .run(record.id, record.source, record.target, record.type, JSON.stringify(record));
    const before = snapshot();
    expect(() => runMigration(db, true)).toThrow(/protected identity-publication/i);
    expect(snapshot()).toEqual(before);
    expect(db.pragma('foreign_key_check')).toEqual([]);
});

test('fixture-name purge cannot delete a protected record', () => {
    node('AGENT:alice', 'IDENTITY_FAMILY_FOUNDING'); node('AGENT:bob');
    const before = snapshot();
    expect(() => runMigration(db, true)).toThrow(/protected identity-publication/i);
    expect(snapshot()).toEqual(before);
});

test('help and read-only preview do not create missing graph files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'normalize-identity-test-'));
    try {
        const help = spawnSync(process.execPath, [script, '--help'], {cwd: root, encoding: 'utf8'});
        expect(help.status, help.stderr).toBe(0);
        expect(help.stdout).toContain('Dry-run mode');
        const file = join(root, 'graph.sqlite');
        await db.backup(file);
        const preview = spawnSync(process.execPath, [script, '--db', file], {cwd: root, encoding: 'utf8'});
        expect(preview.status, preview.stderr).toBe(0);
        const missing = join(root, 'absent.sqlite');
        const result  = spawnSync(process.execPath, [script, '--db', missing], {cwd: root, encoding: 'utf8'});
        expect(result.status).toBe(1);
        expect(existsSync(missing)).toBe(false);
    } finally { rmSync(root, {recursive: true, force: true}); }
});

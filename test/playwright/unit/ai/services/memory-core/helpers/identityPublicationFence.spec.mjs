import {test, expect} from '@playwright/test';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fenceIdentityPublication, readIdentityPublicationFence} from '../../../../../../../ai/services/memory-core/helpers/identityPublicationFence.mjs';
import {importGraphJsonl} from '../../../../../../../ai/services/memory-core/helpers/graphJsonlImport.mjs';
import {stringifyCanonicalJson} from '../../../../../../../ai/services/shared/canonicalJson.mjs';

const target = {planeId: 'fixture-plane', dataRoot: '/fixture/plane'};
let root, db, dbPath;

test.beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-fence-'));
    dbPath = path.join(root, 'graph.sqlite');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL);
        CREATE TABLE Edges (id TEXT PRIMARY KEY, user_id TEXT, source TEXT, target TEXT, type TEXT, data TEXT NOT NULL);`);
    db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run('old', '{"id":"old"}');
});
test.afterEach(() => {
    if (db.open) db.close();
    fs.rmSync(root, {recursive: true, force: true});
});

/** @summary Supplies a source-owned live fence callback for the exact fixture connection. */
function beforeMutation(info) {
    expect(info.db).toBe(db);
    return fenceIdentityPublication(db, {...target, operation: info.operation, source: info.source, at: 1000});
}

/** @summary Writes only disposable import fixture bytes. */
function bundle(lines) {
    const filePath = path.join(root, 'graph.jsonl');
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
    return filePath;
}

/** @summary Seeds clear state as a test precondition, not a production admission API. */
function clearFixture() {
    db.transaction(() => beforeMutation({db, operation: 'fixture', source: 'fixture'})).immediate();
    db.prepare('UPDATE IdentityPublicationFence SET data = ?').run(stringifyCanonicalJson({
        version: 1, ...target, state: 'clear', cause: null
    }));
}

test('missing table/row and malformed or wrong-target state are unavailable, never clear', () => {
    expect(() => readIdentityPublicationFence(db, target)).toThrow('cannot be read');
    clearFixture();
    expect(() => readIdentityPublicationFence(db, {...target, dataRoot: '/other'})).toThrow('wrong-target');
    db.prepare('UPDATE IdentityPublicationFence SET data = ?').run('{"state":"clear"}');
    expect(() => readIdentityPublicationFence(db, target)).toThrow();
    db.exec('DELETE FROM IdentityPublicationFence');
    expect(() => readIdentityPublicationFence(db, target)).toThrow('missing');
});

test('fence requires the physical transaction and preserves wrong-target evidence', () => {
    expect(() => beforeMutation({db, operation: 'replace', source: 'fixture'})).toThrow('transaction');
    clearFixture();
    expect(() => db.transaction(() => fenceIdentityPublication(db, {
        ...target, planeId: 'other', operation: 'replace', source: 'fixture'
    })).immediate()).toThrow('wrong-target');
    expect(readIdentityPublicationFence(db, target).state).toBe('clear');
});

test('fence and delete roll back together if the live transaction fails', () => {
    clearFixture();
    expect(() => db.transaction(() => {
        beforeMutation({db, operation: 'truncate', source: 'fixture'});
        db.exec('DELETE FROM Nodes');
        throw new Error('interrupted before commit');
    }).immediate()).toThrow('interrupted');
    expect(db.prepare('SELECT count(*) AS n FROM Nodes').get().n).toBe(1);
    expect(readIdentityPublicationFence(db, target).state).toBe('clear');
});

test('another SQLite connection sees fence and graph deletion atomically', () => {
    clearFixture();
    const observer = new Database(dbPath);
    try {
        db.transaction(() => {
            beforeMutation({db, operation: 'truncate', source: 'fixture'});
            db.exec('DELETE FROM Nodes');
            expect(readIdentityPublicationFence(observer, target).state).toBe('clear');
            expect(observer.prepare('SELECT count(*) AS n FROM Nodes').get().n).toBe(1);
        }).immediate();
        expect(readIdentityPublicationFence(observer, target).state).toBe('fenced');
        expect(observer.prepare('SELECT count(*) AS n FROM Nodes').get().n).toBe(0);
    } finally {observer.close();}
});

test('lost acknowledgement stays fenced after reopen and repeated mutation', () => {
    db.transaction(() => {
        beforeMutation({db, operation: 'promotion', source: 'first-attempt'});
        db.exec('DELETE FROM Nodes; DELETE FROM Edges;');
    }).immediate();
    db.close();
    db = new Database(dbPath);
    const first = readIdentityPublicationFence(db, target);
    db.transaction(() => beforeMutation({db, operation: 'replace', source: 'second-attempt'})).immediate();
    expect(readIdentityPublicationFence(db, target)).toEqual(first);
    expect(first.cause.source).toBe('first-attempt');
    expect(Object.isFrozen(first.cause)).toBe(true);
});

test('replace import cannot use graph rows to clear the operational fence', async () => {
    clearFixture();
    const filePath = bundle([JSON.stringify({type: 'node', data: {id: 'spoof', label: 'IdentityPublicationFence',
        properties: {state: 'clear', admitted: true}}})]);
    await importGraphJsonl({db, filePath, mode: 'replace', beforeMutation});
    expect(db.prepare('SELECT id FROM Nodes').get().id).toBe('spoof');
    expect(readIdentityPublicationFence(db, target).state).toBe('fenced');
});

test('merge commits the fence before rows and retains it after partial parse failure', async () => {
    clearFixture();
    const filePath = bundle([JSON.stringify({type: 'node', data: {id: 'imported'}}), 'invalid-json']);
    await expect(importGraphJsonl({db, filePath, mode: 'merge', beforeMutation, batchSize: 1})).rejects.toThrow();
    expect(readIdentityPublicationFence(db, target).state).toBe('fenced');
    expect(db.prepare('SELECT id FROM Nodes WHERE id = ?').get('imported')).toBeTruthy();
});

test('missing, rejecting and async fence callbacks prevent the first live delete', async () => {
    const filePath = bundle([]);
    for (const callback of [undefined, () => {throw new Error('fence refusal');}, () => Promise.resolve()]) {
        await expect(importGraphJsonl({db, filePath, mode: 'replace', beforeMutation: callback})).rejects.toThrow();
        expect(db.prepare('SELECT count(*) AS n FROM Nodes').get().n).toBe(1);
    }
});

test('source-owned disposable staging does not mutate live eligibility', async () => {
    clearFixture();
    const staging = new Database(':memory:');
    staging.exec(`CREATE TABLE Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL);
        CREATE TABLE Edges (id TEXT PRIMARY KEY, user_id TEXT, source TEXT, target TEXT, type TEXT, data TEXT NOT NULL);`);
    try {
        await importGraphJsonl({db: staging, filePath: bundle([JSON.stringify({type: 'node', data: {id: 'staged'}})]),
            mode: 'replace', beforeMutation: () => {}});
        expect(staging.prepare('SELECT count(*) AS n FROM Nodes').get().n).toBe(1);
        expect(readIdentityPublicationFence(db, target).state).toBe('clear');
    } finally {staging.close();}
});

test('retired raw-SQL example refuses before opening its hardcoded graph path', () => {
    const script = fileURLToPath(new URL('../../../../../../../ai/examples/db-restore-graph.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, 'nonexistent-bundle'], {cwd: root, encoding: 'utf8'});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('retired');
    expect(fs.readdirSync(root).some(name => name === '.neo-ai-data')).toBe(false);
});

import {setup}                    from '../../../setup.mjs';
import Neo                        from 'neo.mjs/src/Neo.mjs';
import * as core                  from 'neo.mjs/src/core/_export.mjs';
import {test, expect}             from '@playwright/test';
import {mkdtempSync, rmSync}      from 'node:fs';
import {tmpdir}                   from 'node:os';
import {join}                     from 'node:path';
import SQLite                     from '../../../../../ai/graph/storage/SQLite.mjs';
import {fenceIdentityPublication} from '../../../../../ai/services/memory-core/helpers/identityPublicationFence.mjs';

setup({appConfig: {name: 'SQLiteIdentityPublicationTest'}});

let storage;
const refusal = /typed admission owner/;

/** @summary Seeds physical owner state without using the ordinary writer under test. */
function node(id, label = 'ORDINARY', properties = {}) {
    const value = {id, label, properties};
    storage.db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run(id, JSON.stringify(value));
    return value;
}

/** @summary Seeds an incident relation in the actual cascading foreign-key schema. */
function edge(id, source, target, type = 'ORDINARY') {
    const value = {id, source, target, type, properties: {marker: 'original'}};
    storage.db.prepare('INSERT INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)')
        .run(id, source, target, type, JSON.stringify(value));
    return value;
}

/** @summary Captures authoritative records and trigger effects independently of the write results. */
function physical() {
    return Object.fromEntries(['Nodes', 'Edges', 'GraphLog'].map(table =>
        [table, storage.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
}

/** @summary Restores the process-only schema maintenance gate after a disposable fixture action. */
function withSchemaWipe(action) {
    const previous = process.env.NEO_ALLOW_SCHEMA_WIPE;
    process.env.NEO_ALLOW_SCHEMA_WIPE = 'true';
    try { return action(); }
    finally {
        if (previous === undefined) delete process.env.NEO_ALLOW_SCHEMA_WIPE;
        else process.env.NEO_ALLOW_SCHEMA_WIPE = previous;
    }
}

test.beforeEach(async () => {
    storage = Neo.create(SQLite, {dbPath: ':memory:'});
    await storage.ready();
    expect(storage.db.open).toBe(true);
    expect(storage.db.pragma('foreign_keys', {simple: true})).toBe(1);
});
test.afterEach(() => storage.destroy());

test('ordinary node inserts refuse reserved IDs and labels without retaining earlier writes or GraphLog', () => {
    for (const value of [
        {id: 'identity-family-founding-fixture', label: 'ORDINARY'},
        {id: 'unprefixed-founder', label: 'IDENTITY_FAMILY_FOUNDING'}
    ]) {
        const before = physical();
        expect(() => storage.addNodes([{id: 'earlier', label: 'ORDINARY'}, value])).toThrow(refusal);
        expect(physical()).toEqual(before);
    }
    storage.addNodes([{id: 'ordinary', label: 'ORDINARY', properties: {admitted: true}}]);
    expect(storage.db.prepare('SELECT id FROM Nodes').get().id).toBe('ordinary');
});

test('a persisted protected row cannot be relabeled or rewritten through an ordinary node upsert', () => {
    const original = node('unprefixed-founder', 'IDENTITY_FAMILY_FOUNDING', {family: 'gpt'});
    const before   = physical();
    expect(() => storage.addNodes([{...original, label: 'ORDINARY', properties: {family: 'claude'}}])).toThrow(refusal);
    expect(physical()).toEqual(before);
});

test('edge inserts and rewrites refuse reserved identity, typed relations and protected endpoints', () => {
    node('a'); node('b'); node('founder', 'IDENTITY_FAMILY_FOUNDING');
    const ordinary      = edge('ordinary', 'a', 'b');
    const protectedEdge = edge('existing', 'a', 'b', 'IDENTITY_FAMILY_DECLARES');
    for (const value of [
        {...ordinary, id: 'identity-family-edge'},
        {...ordinary, id: 'new-typed', type: 'IDENTITY_FAMILY_DECLARES'},
        {...ordinary, id: 'new-endpoint', target: 'founder'},
        {...protectedEdge, type: 'ORDINARY'}
    ]) {
        const before = physical();
        expect(() => storage.addEdges([{...ordinary, id: 'earlier-edge'}, value])).toThrow(refusal);
        expect(physical()).toEqual(before);
    }
    storage.addEdges([{...ordinary, properties: {marker: 'changed'}}]);
    expect(JSON.parse(storage.db.prepare('SELECT data FROM Edges WHERE id = ?').get('ordinary').data).properties.marker)
        .toBe('changed');
});

test('bulk node deletion preserves protected records and ordinary endpoints with protected cascading edges', () => {
    node('free'); node('endpoint'); node('other'); node('founder', 'IDENTITY_FAMILY_FOUNDING');
    edge('protected-relation', 'endpoint', 'other', 'IDENTITY_FAMILY_DECLARES');
    for (const id of ['founder', 'endpoint']) {
        const before = physical();
        expect(() => storage.removeNodes(['free', id])).toThrow(refusal);
        expect(physical()).toEqual(before);
    }
    storage.removeNodes(['free']);
    expect(storage.db.prepare('SELECT id FROM Nodes WHERE id = ?').get('free')).toBeUndefined();
    expect(storage.db.pragma('foreign_key_check')).toEqual([]);
});

test('ordinary edge deletion refuses protected rows and rolls back preceding deletions', () => {
    node('a'); node('b');
    edge('ordinary', 'a', 'b');
    edge('protected', 'a', 'b', 'IDENTITY_FAMILY_DECLARES');
    const before = physical();
    expect(() => storage.removeEdges(['ordinary', 'protected'])).toThrow(refusal);
    expect(physical()).toEqual(before);
    storage.removeEdges(['ordinary']);
    expect(storage.db.prepare('SELECT id FROM Edges').all()).toEqual([{id: 'protected'}]);
});

test('unreferenced cleanup cannot delete a protected node or bypass its protected incident relation', () => {
    node('founder', 'IDENTITY_FAMILY_FOUNDING');
    node('endpoint'); node('other'); node('orphan', 'ORDINARY', {marker: true});
    edge('protected', 'endpoint', 'other', 'IDENTITY_FAMILY_DECLARES');
    for (const id of ['founder', 'endpoint']) {
        const before = physical();
        expect(() => storage.removeNodeIfUnreferenced(id)).toThrow(refusal);
        expect(physical()).toEqual(before);
    }
    expect(storage.removeNodeIfUnreferenced('orphan', {
        requiredPropertyPath: '$.properties.marker', requiredPropertyValue: false
    })).toBe(false);
    expect(storage.removeNodeIfUnreferenced('orphan', {
        requiredPropertyPath: '$.properties.marker', requiredPropertyValue: true
    })).toBe(true);
});

test('both narrow writers protect nodes and relations while preserving ordinary write-once semantics', () => {
    node('founder', 'IDENTITY_FAMILY_FOUNDING'); node('a'); node('b');
    edge('protected', 'a', 'b', 'IDENTITY_FAMILY_DECLARES');
    for (const method of ['setRecordProperty', 'setRecordPropertyIfAbsent']) {
        for (const [table, id] of [['Nodes', 'founder'], ['Edges', 'protected']]) {
            const before = physical();
            expect(() => storage[method](table, id, 'newMarker', 'forged')).toThrow(refusal);
            expect(physical()).toEqual(before);
        }
    }
    expect(storage.setRecordPropertyIfAbsent('Nodes', 'a', 'marker', 'first')).toBe(true);
    expect(storage.setRecordPropertyIfAbsent('Nodes', 'a', 'marker', 'second')).toBe(false);
    expect(storage.setRecordProperty('Nodes', 'a', 'marker', null)).toBe(true);
    expect(storage.setRecordProperty('Nodes', 'missing', 'marker', 'value')).toBe(false);
});

test('mixed transactions refuse every protected arm with records and GraphLog unchanged', () => {
    node('a'); node('b'); node('founder', 'IDENTITY_FAMILY_FOUNDING');
    edge('protected-edge', 'a', 'b', 'IDENTITY_FAMILY_DECLARES');
    const first = {type: 'nodes', mutation: {addedItems: [{id: 'earlier', label: 'ORDINARY'}]}};
    for (const trace of [
        {type: 'nodes', mutation: {addedItems: [{id: 'founder', label: 'ORDINARY'}]}},
        {type: 'nodes', mutation: {removedItems: [{id: 'a'}]}},
        {type: 'edges', mutation: {addedItems: [{id: 'new-edge', source: 'a', target: 'b', type: 'IDENTITY_FAMILY_DECLARES'}]}},
        {type: 'edges', mutation: {removedItems: [{id: 'protected-edge'}]}}
    ]) {
        const before = physical();
        expect(() => storage.executeTransaction([first, trace])).toThrow(refusal);
        expect(physical()).toEqual(before);
    }
    storage.executeTransaction([first, {type: 'edges', mutation: {
        addedItems: [{id: 'ordinary-edge', source: 'earlier', target: 'b', type: 'ORDINARY'}]
    }}]);
    expect(storage.db.prepare('SELECT id FROM Edges WHERE id = ?').get('ordinary-edge')).toBeTruthy();
});

test('durable publication fence prevents schema reset even with the maintenance gate enabled', () => {
    node('ordinary');
    storage.db.transaction(() => fenceIdentityPublication(storage.db, {
        planeId: 'fixture-plane', dataRoot: '/fixture/plane', operation: 'replace', source: 'fixture', at: 100
    })).immediate();
    const before = physical();
    const schema = storage.db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all();
    withSchemaWipe(() => expect(() => storage.resetGraphSchemaOrThrow('fixture')).toThrow('separately admitted recovery'));
    expect(physical()).toEqual(before);
    expect(storage.db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
});


for (const kind of ['lowercase-fence', 'unfenced-protected-history']) {
    test('schema reset refuses ' + kind + ' with the maintenance gate enabled', () => {
        node('ordinary');
        if (kind === 'lowercase-fence') storage.db.exec('CREATE TABLE identitypublicationfence (data TEXT)');
        else node('identity-family-retained', 'ORDINARY');
        const before = physical(), schema = storage.db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all();
        withSchemaWipe(() => expect(() => storage.resetGraphSchemaOrThrow('fixture'))
            .toThrow(expect.objectContaining({code: 'IDENTITY_PUBLICATION_RECOVERY_REQUIRED'})));
        expect(physical()).toEqual(before);
        expect(storage.db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
    });
}

test('clear refuses protected history and its durable fence even on a disposable path', () => {
    node('ordinary'); node('founder', 'IDENTITY_FAMILY_FOUNDING');
    edge('history', 'founder', 'ordinary');
    storage.db.transaction(() => fenceIdentityPublication(storage.db, {
        planeId: 'fixture-plane', dataRoot: '/fixture/plane', operation: 'replace', source: 'fixture', at: 100
    })).immediate();
    const before = physical(), fence = storage.db.prepare('SELECT * FROM IdentityPublicationFence').all();
    expect(storage.isDisposableDbPath()).toBe(true);
    expect(() => storage.clear()).toThrow(expect.objectContaining({code: 'IDENTITY_PUBLICATION_RECOVERY_REQUIRED'}));
    expect(physical()).toEqual(before);
    expect(storage.db.prepare('SELECT * FROM IdentityPublicationFence').all()).toEqual(fence);
});

for (const kind of ['node', 'edge', 'empty-fence-table']) {
    test(`clear refuses ${kind} publication state independently of the other forms`, () => {
        node('a'); node('b');
        if (kind === 'node') node('identity-family-unadmitted', 'ORDINARY');
        if (kind === 'edge') edge('history', 'a', 'b', 'IDENTITY_FAMILY_DECLARES');
        if (kind === 'empty-fence-table') storage.db.exec('CREATE TABLE IdentityPublicationFence (unreadable TEXT)');
        const before = physical(), schema = storage.db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all();
        expect(() => storage.clear()).toThrow(expect.objectContaining({code: 'IDENTITY_PUBLICATION_RECOVERY_REQUIRED'}));
        expect(physical()).toEqual(before);
        expect(storage.db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
    });
}

test('clear refuses an unreadable protection census without deleting ordinary records', () => {
    node('a'); node('b'); edge('ordinary', 'a', 'b');
    for (const data of ['{invalid', 'null', '[]']) {
        storage.db.prepare('UPDATE Edges SET data = ? WHERE id = ?').run(data, 'ordinary');
        const before = physical();
        expect(() => storage.clear()).toThrow(expect.objectContaining({code: 'IDENTITY_PUBLICATION_STATE_UNAVAILABLE'}));
        expect(physical()).toEqual(before);
    }
});

test('clear refuses a missing census table before deleting remaining edges or GraphLog', () => {
    node('a'); node('b'); edge('ordinary', 'a', 'b');
    storage.db.exec('ALTER TABLE Nodes RENAME TO MissingNodes');
    const snapshot = () => Object.fromEntries(['MissingNodes', 'Edges', 'GraphLog'].map(table =>
        [table, storage.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
    const before = snapshot();
    expect(() => storage.clear()).toThrow(expect.objectContaining({code: 'IDENTITY_PUBLICATION_STATE_UNAVAILABLE'}));
    expect(snapshot()).toEqual(before);
});

test('clear still requires actual graph tables when publication absence permits a fresh target', () => {
    storage.db.exec('DROP TABLE Edges; DROP TABLE Nodes;');
    const before = storage.db.prepare('SELECT * FROM GraphLog').all();
    expect(() => storage.clear()).toThrow('no such table: Edges');
    expect(storage.db.prepare('SELECT * FROM GraphLog').all()).toEqual(before);
});

test('clear owns its transaction and rolls back earlier deletes and GraphLog on failure', () => {
    node('a'); node('b'); edge('ordinary', 'a', 'b');
    const before = physical();
    storage.db.exec('BEGIN IMMEDIATE');
    try {
        expect(() => storage.clear()).toThrow(/own.*transaction/);
        expect(physical()).toEqual(before);
    } finally {storage.db.exec('ROLLBACK');}
    storage.db.exec("CREATE TRIGGER refuse_clear BEFORE DELETE ON Nodes BEGIN SELECT RAISE(ABORT, 'fixture clear refusal'); END;");
    expect(() => storage.clear()).toThrow('fixture clear refusal');
    expect(physical()).toEqual(before);
});

test('clear preserves the non-temporary path refusal and clears an ordinary disposable graph', () => {
    node('a'); node('b'); edge('ordinary', 'a', 'b');
    const before = physical(), dbPath = storage.dbPath;
    storage.dbPath = '/production/graph.sqlite';
    try {
        expect(() => storage.clear()).toThrow('non-temporary SQLite database');
        expect(physical()).toEqual(before);
    } finally {storage.dbPath = dbPath;}
    storage.clear();
    expect(storage.db.prepare('SELECT count(*) AS count FROM Nodes').get().count).toBe(0);
    expect(storage.db.prepare('SELECT count(*) AS count FROM Edges').get().count).toBe(0);
    expect(storage.hasTable('IdentityPublicationFence')).toBe(false);
});

test('ordinary writers and schema reset serialize before inspecting persisted protection', async () => {
    const directory   = mkdtempSync(join(tmpdir(), 'neo-graph-test-publication-serialization-'));
    const fileStorage = Neo.create(SQLite, {dbPath: join(directory, 'graph.sqlite')});
    let peer;
    try {
        await fileStorage.ready();
        peer = new fileStorage.db.constructor(fileStorage.dbPath, {timeout: 1});
        const originalPrepare = fileStorage.db.prepare.bind(fileStorage.db);
        const actions         = [
            () => fileStorage.addNodes([{id: 'a', label: 'ORDINARY'}]),
            () => fileStorage.addEdges([{id: 'edge', source: 'a', target: 'b', type: 'ORDINARY'}]),
            () => fileStorage.removeNodes(['orphan']),
            () => fileStorage.removeEdges(['edge']),
            () => fileStorage.removeNodeIfUnreferenced('orphan'),
            () => fileStorage.setRecordProperty('Nodes', 'a', 'marker', 'changed'),
            () => fileStorage.setRecordPropertyIfAbsent('Nodes', 'a', 'newMarker', 'changed'),
            () => fileStorage.executeTransaction([{type: 'nodes', mutation: {addedItems: [{id: 'a', label: 'ORDINARY'}]}}]),
            () => fileStorage.clear()
        ];
        for (const action of actions) {
            fileStorage.addNodes([{id: 'a', label: 'ORDINARY'}, {id: 'b', label: 'ORDINARY'}, {id: 'orphan', label: 'ORDINARY'}]);
            fileStorage.addEdges([{id: 'edge', source: 'a', target: 'b', type: 'ORDINARY'}]);
            let inspected = false;
            fileStorage.db.prepare = sql => {
                if (!inspected && /^SELECT (?:\*|id(?:, data)?|1) FROM (?:Nodes|Edges)/.test(sql)) {
                    inspected = true;
                    expect(() => peer.prepare("UPDATE Nodes SET data = json_set(data, '$.label', 'IDENTITY_FAMILY_FOUNDING') WHERE id = 'a'").run())
                        .toThrow('database is locked');
                }
                return originalPrepare(sql);
            };
            try {
                action();
                expect(inspected).toBe(true);
            } finally { fileStorage.db.prepare = originalPrepare; }
        }

        fileStorage.db.transaction(() => fenceIdentityPublication(fileStorage.db, {
            planeId: 'fixture-plane', dataRoot: '/fixture/plane', operation: 'replace', source: 'fixture', at: 100
        })).immediate();
        let inspectedFence = false;
        fileStorage.db.prepare = sql => {
            if (/SELECT name(?:, type)? FROM sqlite_master/.test(sql)) {
                inspectedFence = true;
                expect(() => peer.prepare("UPDATE Nodes SET data = json_set(data, '$.properties.peer', 1) WHERE id = 'a'").run())
                    .toThrow('database is locked');
            }
            return originalPrepare(sql);
        };
        try {
            withSchemaWipe(() => expect(() => fileStorage.resetGraphSchemaOrThrow('fixture')).toThrow('separately admitted recovery'));
            expect(inspectedFence).toBe(true);
        } finally { fileStorage.db.prepare = originalPrepare; }
    } finally {
        peer?.close();
        fileStorage.destroy();
        rmSync(directory, {recursive: true, force: true});
    }
});

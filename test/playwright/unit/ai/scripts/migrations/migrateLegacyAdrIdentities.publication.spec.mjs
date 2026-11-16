import {setup}                 from '../../../../setup.mjs';
import Neo                     from 'neo.mjs/src/Neo.mjs';
import * as core               from 'neo.mjs/src/core/_export.mjs';
import {test, expect}          from '@playwright/test';
import Database                from 'better-sqlite3';
import {resetSharedAdrCatalog} from '../../../../../../ai/services/ingestion/adrAdmissionCatalog.mjs';
import {MIGRATION_CUT_REPOSITORIES, REVIEWED_41_ADR_MIGRATION_MANIFEST}
    from '../../../../../../ai/scripts/migrations/adrMigrationManifest.mjs';

setup({appConfig: {name: 'LegacyAdrPublicationProtectionTest'}});

let db, migrateLegacyAdrIdentities, restoreAdrMigrationBackup, createAdrMigrationBackup;
const entry = REVIEWED_41_ADR_MIGRATION_MANIFEST.find(value =>
    value.sourceTuple.namespace === 'neomjs/neo-agent-brain' && !value.custodyTransition && value.observedState.nodeLabel === 'ADR');
const namespace       = entry.sourceTuple.namespace;
const cutRepositories = {[namespace]: MIGRATION_CUT_REPOSITORIES[namespace]};

/** @summary Uses a production-shaped cascading graph with visible trigger effects, never a running store. */
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

/** @summary Seeds independently owned graph facts without invoking the migration. */
function node(id, label = 'ORDINARY') {
    db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run(id, JSON.stringify({id, label, properties: {marker: 'retained'}}));
}

/** @summary Captures the graph and GraphLog independently of migration journal phase updates. */
const graphRows = () => ['Nodes', 'Edges', 'GraphLog'].map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());

/** @summary A refusal must also avoid schema creation or journal mutation. */
function completeState() {
    const schema = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    return {schema, rows: schema.map(row => [row.name, db.prepare('SELECT * FROM "' + row.name + '" ORDER BY rowid').all()])};
}

/** @summary Supplies literal already-reviewed cut facts so the fixture performs no worktree or network census. */
function migrationOptions() {
    return {db, manifest: [entry], cutRepositories, requireCompleteInventory: false,
        sourceProbe: {revisions: {[namespace]: cutRepositories[namespace].cutRevision},
            contentHashes: {[entry.legacyId]: entry.sourceTuple.contentHash}, requirePrivateStageAccess: false},
        readerContext: {agentIdentity: '@fixture', allowPrivate: false,
            authorizedNamespaces: [namespace], authorizedRepositories: [namespace, entry.sourceTuple.repositoryId]},
        vectorStore: new Map(), kbStore: new Map(), failAfterPhase: 'graph_sqlite_applied'};
}

/** @summary Supplies an ordinary historical restore payload without granting publication recovery. */
function ordinaryBackup() {
    return {manifestIds: [{legacyId: entry.legacyId, canonicalKey: entry.canonicalKey}],
        nodes: [{id: entry.legacyId, data: JSON.stringify({id: entry.legacyId, label: 'ADR', properties: {}})}],
        edges: [], vectorEntries: [[entry.legacyId, {marker: 'backup'}]], kbEntries: []};
}

/** @summary Proves denial precedes graph, schema, vector and KB mutations. */
function expectRestoreRefusal(code, backup = ordinaryBackup()) {
    const before  = completeState();
    let   calls   = 0, error;
    const adapter = {restoreSnapshot() {calls++; return {};}};
    try {restoreAdrMigrationBackup({db, backup, vectorStore: adapter, kbStore: adapter});}
    catch (caught) {error = caught;}
    expect(error).toMatchObject({code});
    expect(calls).toBe(0);
    expect(completeState()).toEqual(before);
}

test.beforeAll(async () => {
    ({migrateLegacyAdrIdentities, restoreAdrMigrationBackup, createAdrMigrationBackup} =
        await import('../../../../../../ai/scripts/migrations/migrateLegacyAdrIdentities.mjs'));
});
test.beforeEach(() => {
    resetSharedAdrCatalog();
    db = new Database(':memory:');
    createSchema();
});
test.afterEach(() => { db.close(); resetSharedAdrCatalog(); });

test('a late protected incident edge rolls the ADR graph phase back before vector mutation', async () => {
    node(entry.legacyId, 'ADR'); node('other');
    const options = migrationOptions();
    expect((await migrateLegacyAdrIdentities({...options, apply: false})).mode).toBe('dry-run');
    const edge = {id: 'late', source: entry.legacyId, target: 'other', type: 'IDENTITY_FAMILY_DECLARES', properties: {}};
    db.prepare('INSERT INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)')
        .run(edge.id, edge.source, edge.target, edge.type, JSON.stringify(edge));
    const before = graphRows();
    await expect(migrateLegacyAdrIdentities({...options, apply: true})).rejects.toMatchObject({
        code: 'IDENTITY_PUBLICATION_WRITE_PROTECTED'
    });
    expect(graphRows()).toEqual(before);
    expect(options.vectorStore.size).toBe(0);
    expect(options.kbStore.size).toBe(0);
});

test('ordinary ADR graph migration preserves unrelated protected history', async () => {
    node(entry.legacyId, 'ADR'); node('identity-family-unrelated', 'IDENTITY_FAMILY_FOUNDING');
    const before = db.prepare('SELECT * FROM Nodes WHERE id = ?').get('identity-family-unrelated');
    await expect(migrateLegacyAdrIdentities({...migrationOptions(), apply: true})).rejects.toMatchObject({
        code: 'ADR_MIGRATION_INTERRUPTED_FOR_TEST'
    });
    expect(db.prepare('SELECT id FROM Nodes WHERE id = ?').get(entry.canonicalKey)).toBeTruthy();
    expect(db.prepare('SELECT id FROM Nodes WHERE id = ?').get(entry.legacyId)).toBeUndefined();
    expect(db.prepare('SELECT * FROM Nodes WHERE id = ?').get('identity-family-unrelated')).toEqual(before);
});

test('protected history created after an ADR backup refuses restore before any mutation', () => {
    node(entry.legacyId, 'ADR');
    const backup = createAdrMigrationBackup({db, manifest: [entry], vectorStore: new Map(), kbStore: new Map()});
    node('identity-family-later', 'IDENTITY_FAMILY_FOUNDING');
    expectRestoreRefusal('IDENTITY_PUBLICATION_RECOVERY_REQUIRED', backup);
});

test('an operational fence table alone refuses ADR restore before schema or vector mutation', () => {
    db.exec('CREATE TABLE IdentityPublicationFence (data TEXT)');
    expectRestoreRefusal('IDENTITY_PUBLICATION_RECOVERY_REQUIRED');
});

test('a protected relation also refuses ADR restore before any mutation', () => {
    node('a'); node('b');
    const edge = {id: 'protected', source: 'a', target: 'b', type: 'IDENTITY_FAMILY_DECLARES', properties: {}};
    db.prepare('INSERT INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)')
        .run(edge.id, edge.source, edge.target, edge.type, JSON.stringify(edge));
    expectRestoreRefusal('IDENTITY_PUBLICATION_RECOVERY_REQUIRED');
});

test('partial and malformed current graph populations are unknown rather than empty', () => {
    db.exec('DROP TABLE Edges');
    expectRestoreRefusal('IDENTITY_PUBLICATION_STATE_UNAVAILABLE');
    db.close();
    db = new Database(':memory:');
    createSchema();
    db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run('ordinary', 'malformed');
    expectRestoreRefusal('IDENTITY_PUBLICATION_STATE_UNAVAILABLE');
});

test('non-object ordinary payloads cannot establish publication absence for ADR restore', () => {
    node('ordinary');
    for (const data of ['null', '[]', '"opaque"', '0']) {
        db.prepare('UPDATE Nodes SET data = ? WHERE id = ?').run(data, 'ordinary');
        expectRestoreRefusal('IDENTITY_PUBLICATION_STATE_UNAVAILABLE');
    }
});

test('a backup cannot introduce a new protected population and reach vector restore', () => {
    const backup = ordinaryBackup();
    backup.nodes.push({id: 'identity-family-new', data: JSON.stringify({
        id: 'identity-family-new', label: 'IDENTITY_FAMILY_FOUNDING', properties: {}
    })});
    expectRestoreRefusal('IDENTITY_PUBLICATION_RECOVERY_REQUIRED', backup);
});

test('ordinary restoration into an empty database commits before vector and KB calls', () => {
    db.close();
    db = new Database(':memory:');
    let   calls   = 0;
    const adapter = {restoreSnapshot() {
        expect(db.inTransaction).toBe(false);
        expect(db.prepare('SELECT id FROM Nodes').get().id).toBe(entry.legacyId);
        calls++;
        return {};
    }};
    const result = restoreAdrMigrationBackup({db, backup: ordinaryBackup(), vectorStore: adapter, kbStore: adapter});
    expect(result.restored).toBe(true);
    expect(calls).toBe(2);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'IdentityPublicationFence'").get()).toBeUndefined();
});

test('an outer transaction cannot receive a successful restore before its own commit', () => {
    const before = completeState();
    let   calls  = 0;
    expect(() => db.transaction(() => restoreAdrMigrationBackup({db, backup: ordinaryBackup(),
        vectorStore: {restoreSnapshot() {calls++;}}})).immediate()).toThrow(/own physical transaction/);
    expect(calls).toBe(0);
    expect(completeState()).toEqual(before);
});

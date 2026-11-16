import {setup}               from '../../../setup.mjs';
import Neo                   from 'neo.mjs/src/Neo.mjs';
import * as core             from 'neo.mjs/src/core/_export.mjs';
import {test, expect}        from '@playwright/test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir}              from 'node:os';
import {join}                from 'node:path';
import Database              from '../../../../../ai/graph/Database.mjs';
import SQLite                from '../../../../../ai/graph/storage/SQLite.mjs';

setup({appConfig: {name: 'IdentityPublicationCacheTest'}});

let graph, storage;
const protectedId = 'identity-family-cache-fixture';
const refusal     = /typed admission owner/;

/** @summary Supplies admitted fixture bytes directly to the isolated physical owner. */
function node(id, label = 'ORDINARY') {
    const value = {id, label, properties: {marker: 'original'}};
    storage.db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run(id, JSON.stringify(value));
    return value;
}

/** @summary Supplies a physical edge independently of the ordinary cache writer under test. */
function edge(id, source = 'a', target = 'b') {
    const value = {id, source, target, type: 'RELATED_TO', properties: {marker: 'original'}};
    storage.db.prepare('INSERT INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)')
        .run(id, source, target, value.type, JSON.stringify(value));
    return value;
}

/** @summary Reads records and committed trigger effects without consulting the cache. */
function physical() {
    return Object.fromEntries(['Nodes', 'Edges', 'GraphLog'].map(table =>
        [table, storage.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
}

test.beforeEach(async () => {
    storage = Neo.create(SQLite, {dbPath: ':memory:'});
    await storage.ready();
    graph = Neo.create(Database, {storage});
    await graph.ready();
});
test.afterEach(() => {
    graph.destroy();
    if (!storage.isDestroyed) storage.destroy();
});

test('a cold rejected insertion leaves no forged cache entry or physical row', () => {
    const before = physical();
    expect(() => graph.nodes.add({id: protectedId, label: 'ORDINARY'})).toThrow(refusal);
    expect(graph.nodes.has(protectedId)).toBe(false);
    expect(physical()).toEqual(before);
    expect(graph.autoSave).toBe(true);
    expect(graph.isExecutingTransaction).toBe(false);
});

test('a warm protected replacement reloads original facts after refusal', () => {
    node('founder', 'IDENTITY_FAMILY_FOUNDING');
    graph.getAdjacentNodes('founder', 'both');
    const before = physical();
    expect(() => graph.nodes.splice(0, ['founder'], [
        {id: 'founder', label: 'ORDINARY', properties: {marker: 'forged'}}
    ])).toThrow(refusal);
    expect(physical()).toEqual(before);
    graph.getAdjacentNodes('founder', 'both');
    expect(graph.nodes.get('founder').label).toBe('IDENTITY_FAMILY_FOUNDING');
    expect(graph.nodes.get('founder').properties.marker).toBe('original');
});

for (const table of ['Nodes', 'Edges']) {
    for (const transactional of [false, true]) {
        test('a duplicate ' + table + ' batch recovers its ordinary member (transaction=' + transactional + ')', () => {
            node('a'); node('b');
            const original = table === 'Nodes' ? node('ordinary-existing') : edge('ordinary-existing');
            const anchor   = table === 'Nodes' ? original.id : 'a';
            graph.getAdjacentNodes(anchor, 'both');
            const store    = table === 'Nodes' ? graph.nodes : graph.edges;
            const existing = store.get(original.id);
            const before   = physical(), cursor = graph.lastSyncId;
            const write    = () => store.add([existing, {...original, id: protectedId}]);
            expect(() => transactional ? graph.transaction(write) : write()).toThrow(refusal);
            expect(physical()).toEqual(before);
            expect(graph.lastSyncId).toBe(cursor);
            expect(store.has(protectedId)).toBe(false);
            graph.getAdjacentNodes(anchor, 'both');
            expect(store.get(original.id).properties.marker).toBe('original');
            if (table === 'Edges') expect(store.getByIndex('source', 'a').map(row => row.id)).toEqual([original.id]);
        });
    }
}

for (const table of ['Nodes', 'Edges']) {
    test('a mixed direct ' + table + ' splice cannot commit its ordinary addition before protected refusal', () => {
        node('a'); node('b');
        if (table === 'Nodes') node(protectedId);
        else edge(protectedId);
        const anchor = table === 'Nodes' ? protectedId : 'a';
        graph.getAdjacentNodes(anchor, 'both');
        const store    = table === 'Nodes' ? graph.nodes : graph.edges;
        const addition = table === 'Nodes'
            ? {id: 'ordinary-added', label: 'ORDINARY'}
            : {id: 'ordinary-added', source: 'a', target: 'b', type: 'RELATED_TO'};
        const before = physical(), cursor = graph.lastSyncId;
        expect(() => store.splice(0, [protectedId], [addition])).toThrow(refusal);
        expect(physical()).toEqual(before);
        expect(graph.lastSyncId).toBe(cursor);
        expect(store.has('ordinary-added')).toBe(false);
        graph.getAdjacentNodes(anchor, 'both');
        expect(store.has(protectedId)).toBe(true);
        if (table === 'Edges') expect(store.getByIndex('source', 'a').map(row => row.id)).toEqual([protectedId]);
    });
}

test('rejected endpoint deletion evicts every indexed edge copy and every requester vicinity', () => {
    node('a'); node('b'); node('unrelated');
    edge(protectedId);
    graph.getAdjacentNodes('a', 'both');
    graph.getAdjacentNodes('b', 'both');
    graph.getAdjacentNodes('unrelated', 'both');
    const indexed  = graph.edges.getByIndex('source', 'a')[0];
    const hydrated = graph.edges.get(protectedId);
    expect(hydrated).not.toBe(indexed);
    graph.vicinityLoadedNodes.scopesByNode.get('a').add('another-requester');
    const before = physical();
    expect(() => graph.nodes.remove('a')).toThrow(refusal);
    expect(physical()).toEqual(before);
    expect(graph.edges.getByIndex('source', 'a')).toEqual([]);
    expect(graph.edges.getByIndex('target', 'b')).toEqual([]);
    expect(graph.vicinityLoadedNodes.scopesByNode.has('a')).toBe(false);
    expect(graph.vicinityLoadedNodes.scopesByNode.has('b')).toBe(false);
    expect(graph.lastAccessMap.has('a')).toBe(false);
    expect(graph.lastAccessMap.has('b')).toBe(false);
    expect(graph.vicinityLoadedNodes.has('unrelated')).toBe(true);
    graph.getAdjacentNodes('a', 'both');
    expect(graph.nodes.has('a')).toBe(true);
    expect(graph.edges.getByIndex('source', 'a').map(row => row.id)).toEqual([protectedId]);
    expect(graph.edges.getByIndex('target', 'b').map(row => row.id)).toEqual([protectedId]);
});

test('rejected direct edge insertion and deletion reload without forged or duplicate index entries', () => {
    node('a'); node('b');
    graph.getAdjacentNodes('a', 'both');
    expect(() => graph.edges.add({id: protectedId, source: 'a', target: 'b', type: 'RELATED_TO'})).toThrow(refusal);
    expect(graph.edges.has(protectedId)).toBe(false);
    expect(graph.edges.getByIndex('source', 'a')).toEqual([]);
    edge(protectedId);
    graph.getAdjacentNodes('a', 'both');
    expect(() => graph.edges.remove(protectedId)).toThrow(refusal);
    expect(graph.edges.getByIndex('source', 'a')).toEqual([]);
    graph.getAdjacentNodes('a', 'both');
    expect(graph.edges.getByIndex('source', 'a').map(row => row.id)).toEqual([protectedId]);
});

test('a late protected write in a logical transaction leaves no earlier cache or graph changes', () => {
    const before = physical(), cursor = graph.lastSyncId;
    expect(() => graph.transaction(() => {
        graph.addNode({id: 'earlier', label: 'ORDINARY'});
        graph.addNode({id: protectedId, label: 'ORDINARY'});
    })).toThrow(refusal);
    expect(graph.nodes.has('earlier')).toBe(false);
    expect(graph.nodes.has(protectedId)).toBe(false);
    expect(physical()).toEqual(before);
    expect(graph.lastSyncId).toBe(cursor);
});

test('ordinary writes and rollback preserve physical records and cache membership', () => {
    graph.transaction(() => {
        graph.addNode({id: 'a', label: 'ORDINARY'});
        graph.addNode({id: 'b', label: 'ORDINARY'});
        graph.addEdge({id: 'ordinary', source: 'a', target: 'b', type: 'RELATED_TO'});
    });
    const before = physical();
    expect(storage.db.prepare('SELECT target FROM Edges WHERE id = ?').get('ordinary').target).toBe('b');
    expect(() => graph.transaction(() => {
        graph.removeEdge('ordinary');
        graph.removeNode('b');
        throw new Error('ordinary failure');
    })).toThrow('ordinary failure');
    expect(physical()).toEqual(before);
    expect(graph.nodes.has('b')).toBe(true);
    expect(graph.edges.has('ordinary')).toBe(true);
    graph.edges.splice(0, ['ordinary'], [{id: 'replacement', source: 'a', target: 'b', type: 'RELATED_TO'}]);
    expect(storage.db.prepare('SELECT id FROM Edges').all()).toEqual([{id: 'replacement'}]);
});

test('a non-protection SQLite failure keeps ordinary inverse rollback and committed rows intact', () => {
    graph.addNode({id: 'existing', label: 'ORDINARY'});
    const before = physical(), cursor = graph.lastSyncId;
    expect(() => graph.transaction(() => {
        graph.addNode({id: 'new-node', label: 'ORDINARY'});
        graph.addEdge({id: 'broken-edge', source: 'existing', target: 'missing', type: 'RELATED_TO'});
    })).toThrow('FOREIGN KEY constraint failed');
    expect(physical()).toEqual(before);
    expect(graph.lastSyncId).toBe(cursor);
    expect(graph.nodes.has('existing')).toBe(true);
    expect(graph.nodes.has('new-node')).toBe(false);
    expect(graph.edges.has('broken-edge')).toBe(false);
    expect(graph.isExecutingTransaction).toBe(false);
});

test('protected refusal does not acknowledge an unread foreign GraphLog change', async () => {
    const directory   = mkdtempSync(join(tmpdir(), 'neo-graph-test-publication-cache-'));
    const fileStorage = Neo.create(SQLite, {dbPath: join(directory, 'graph.sqlite')});
    let fileGraph, peer;
    try {
        await fileStorage.ready();
        fileGraph = Neo.create(Database, {storage: fileStorage});
        await fileGraph.ready();
        fileGraph.addNode({id: 'foreign', label: 'ORDINARY', properties: {marker: 'before'}});
        fileGraph.getAdjacentNodes('foreign', 'both');
        const cursor = fileGraph.lastSyncId;
        peer = new fileStorage.db.constructor(fileStorage.dbPath);
        peer.prepare("UPDATE Nodes SET data = json_set(data, '$.properties.marker', 'after') WHERE id = 'foreign'").run();
        expect(fileStorage.getLatestLogId()).toBeGreaterThan(cursor);
        expect(() => fileGraph.nodes.add({id: protectedId, label: 'ORDINARY'})).toThrow(refusal);
        expect(fileGraph.lastSyncId).toBe(cursor);
        fileGraph.getAdjacentNodes('foreign', 'both');
        expect(fileGraph.nodes.get('foreign').properties.marker).toBe('after');
        expect(fileGraph.lastSyncId).toBeGreaterThan(cursor);
    } finally {
        peer?.close();
        fileGraph?.destroy();
        if (!fileStorage.isDestroyed) fileStorage.destroy();
        rmSync(directory, {recursive: true, force: true});
    }
});

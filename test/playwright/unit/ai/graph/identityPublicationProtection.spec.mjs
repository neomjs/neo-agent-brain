import {setup}                                                     from '../../../setup.mjs';
import Neo                                                         from 'neo.mjs/src/Neo.mjs';
import * as core                                                   from 'neo.mjs/src/core/_export.mjs';
import InstanceManager                                             from 'neo.mjs/src/manager/Instance.mjs';
import {test, expect}                                              from '@playwright/test';
import {mkdtempSync, rmSync}                                       from 'node:fs';
import {tmpdir}                                                    from 'node:os';
import {join}                                                      from 'node:path';
import {generateKeyPairSync, sign}                                 from 'node:crypto';
import Database                                                    from '../../../../../ai/graph/Database.mjs';
import SQLite                                                      from '../../../../../ai/graph/storage/SQLite.mjs';
import {fenceIdentityPublication}                                  from '../../../../../ai/services/memory-core/helpers/identityPublicationFence.mjs';
import {consumeIdentityPublicationBoot}                            from '../../../../../ai/services/memory-core/helpers/identityPublicationLineage.mjs';
import {admitIdentityPublication, readIdentityPublicationSnapshot} from '../../../../../ai/services/memory-core/helpers/identityPublicationAdmission.mjs';
import {stringifyCanonicalJson}                                    from '../../../../../ai/services/shared/canonicalJson.mjs';
import {buildFamilyProjection, familyAt}                           from '../../../../../ai/graph/identityFamilyProjection.mjs';

setup({appConfig: {name: 'IdentityPublicationProtectionTest'}});

let GraphService, previousDb, graph, storage;
const protectedId = 'identity-family-receipt-fixture';

test.beforeAll(async () => {
    GraphService = (await import('../../../../../ai/services/memory-core/GraphService.mjs')).default;
    await GraphService.ready();
});
test.beforeEach(async () => {
    storage = Neo.create(SQLite, {dbPath: ':memory:'});
    await storage.ready();
    graph = Neo.create(Database, {storage});
    await graph.ready();
    previousDb = GraphService.db;
    GraphService.db = graph;
});
test.afterEach(() => {
    GraphService.db = previousDb;
    graph.destroy();
    if (!storage.isDestroyed) storage.destroy();
});

/** @summary Seeds persisted state directly as a fixture for the ordinary-write refusal boundary. */
function node(id, label = 'NODE') {
    const record = {id, label, properties: {marker: 'original'}};
    storage.db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, NULL, ?)').run(id, JSON.stringify(record));
    return record;
}
/** @summary Seeds an edge that ordinary graph writers must preserve. */
function edge(id, source, target, type = 'MUTABLE_RELATION') {
    const record = {id, source, target, type, properties: {weight: 0.5, marker: 'original'}};
    storage.db.prepare('INSERT INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)')
        .run(id, source, target, type, JSON.stringify(record));
    return record;
}
/** @summary Reads authoritative fixture bytes independently of the graph cache. */
function stored(table, id) {
    return storage.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id)?.data;
}

test('public upsert refuses reserved IDs and labels before warming or mutating cached state', () => {
    for (const [id, label] of [[protectedId, 'NODE'], ['cold-label', 'IDENTITY_FAMILY_LINEAGE']]) {
        const original = node(id, label);
        if (id === protectedId) graph.getAdjacentNodes(id, 'both');
        expect(() => GraphService.upsertNode({id, type: 'NODE', properties: {marker: 'forged', admitted: true}})).toThrow('typed admission owner');
        expect(JSON.parse(stored('Nodes', id))).toEqual(original);
        if (id === protectedId) expect(graph.nodes.get(id).properties.marker).toBe('original');
        else expect(graph.nodes.has(id)).toBe(false);
    }
});

test('new ordinary upserts cannot manufacture protected records through JSON permission flags', () => {
    for (const spec of [{id: protectedId, type: 'NODE'}, {id: 'ordinary-id', type: 'IDENTITY_FAMILY_DECLARATION'}]) {
        expect(() => GraphService.upsertNode({...spec, properties: {admitted: true, authority: 'system'}})).toThrow('typed admission owner');
        expect(stored('Nodes', spec.id)).toBeUndefined();
        expect(graph.nodes.has(spec.id)).toBe(false);
    }
});

test('ordinary writable EmbodiedEpisode rows cannot impersonate admitted binding history', () => {
    const target  = {planeId: 'ordinary-episode-fixture', dataRoot: '/fixture/ordinary-episode'};
    const key     = generateKeyPairSync('ed25519');
    const reserve = {version: 1, target, issuer: 'fixture-fleet', trust: null,
        reservation: {attemptId: 'fixture-attempt', kid: 'key-a', originRunId: '123e4567-e89b-42d3-a456-426614174000'}};
    const bootText = stringifyCanonicalJson({...reserve, trust: [{kid: 'key-a',
        publicKey: key.publicKey.export({type: 'spki', format: 'der'}).toString('base64url')}]});
    expect(consumeIdentityPublicationBoot(storage.db, stringifyCanonicalJson(reserve), target).state).toBe('reserved');
    expect(consumeIdentityPublicationBoot(storage.db, bootText, target).state).toBe('bound');
    const binding = {seatId: 'seat', incarnation: 'incarnation', subject: {authProvider: 'github',
        providerBaseUrl: 'https://api.github.com', providerUserId: '123', providerUsername: 'fixture'}};
    const publish = (operation, now) => {
        const payload = Buffer.from(stringifyCanonicalJson({version: 1, purpose: 'identity-family-publication',
            audience: target.planeId, issuer: reserve.issuer, kid: 'key-a', issuedAt: now, expiresAt: now + 300000, operation}));
        const signature = sign(null, Buffer.concat([Buffer.from('neo.identity-family-publication.v1\0'), payload]), key.privateKey);
        return admitIdentityPublication(storage.db, payload.toString('base64url') + '.' + signature.toString('base64url'),
            {bootText, target, rosterFamilies: ['gpt', 'claude'], clock: () => now});
    };
    expect(publish({kind: 'baseline', operationId: 'baseline', effectiveAt: 100,
        expectedPlaneRevision: 0, bindings: [binding]}, 100).state).toBe('accepted');
    const admitted = publish({kind: 'confirm', operationId: 'confirm', effectiveAt: 110, binding,
        expectedMembershipRevision: 1, expectedAdmissionRevision: 0, operatorPrincipal: 'operator',
        family                    : 'gpt', model: null, newFamily: false, unattestedReason: 'No model attested'}, 110);
    expect(admitted.state).toBe('accepted');
    graph.syncCache();
    const before   = readIdentityPublicationSnapshot(storage.db, {bootText, target});
    const original = JSON.parse(stored('Nodes', admitted.receipt.admissionId));
    const id       = 'embodied-episode-ordinary-fixture';
    const forged   = {...original.properties, family: 'claude', admitted: true};
    expect(forged.identityKey).toBe(before.snapshot.subjects[0].source.memberships[0].bindingId);
    GraphService.upsertNode({id, type: 'EmbodiedEpisode', properties: forged});
    expect(JSON.parse(stored('Nodes', id)).properties.family).toBe('claude');
    expect(graph.nodes.has(id)).toBe(true);
    const after = readIdentityPublicationSnapshot(storage.db, {bootText, target});
    expect(after).toEqual(before);
    expect(familyAt(buildFamilyProjection(after.snapshot.subjects[0].source), 120))
        .toEqual({state: 'classified', family: 'gpt'});
    GraphService.removeNodes([id]);
    expect(readIdentityPublicationSnapshot(storage.db, {bootText, target})).toEqual(before);
});

test('bulk public deletion cannot cascade a cold protected relation or partially remove an earlier node', () => {
    node('free'); node('endpoint'); node('other');
    edge(protectedId, 'endpoint', 'other');
    graph.getAdjacentNodes('free', 'both');
    expect(() => GraphService.removeNodes(['free', 'endpoint'])).toThrow('typed admission owner');
    expect(stored('Nodes', 'free')).toBeTruthy();
    expect(graph.nodes.has('free')).toBe(true);
    expect(stored('Edges', protectedId)).toBeTruthy();
});

test('raw SQL link/reconciliation paths cannot reweight a protected edge or attach to a cold protected node', () => {
    node('a'); node('b'); node('cold', 'IDENTITY_FAMILY_MEMBERSHIP');
    const original = edge(protectedId, 'a', 'b');
    expect(() => GraphService.linkNodes('a', 'b', 'MUTABLE_RELATION')).toThrow('typed admission owner');
    expect(() => GraphService.ensureStructuralEdge('a', 'b', 'MUTABLE_RELATION')).toThrow('typed admission owner');
    expect(() => GraphService.linkNodes('a', 'cold', 'RELATED_TO')).toThrow('typed admission owner');
    expect(JSON.parse(stored('Edges', protectedId))).toEqual(original);
});

test('raw link reweighting prevents a second connection changing protection between check and write', async () => {
    const directory   = mkdtempSync(join(tmpdir(), 'neo-graph-test-publication-lock-'));
    const dbPath      = join(directory, 'graph.sqlite');
    const fileStorage = Neo.create(SQLite, {dbPath});
    let fileGraph, peer;
    try {
        await fileStorage.ready();
        fileGraph = Neo.create(Database, {storage: fileStorage});
        await fileGraph.ready();
        GraphService.db = fileGraph;
        fileStorage.addNodes([{id: 'a', label: 'NODE'}, {id: 'b', label: 'NODE'}]);
        fileStorage.addEdges([{id: 'ordinary-edge', source: 'a', target: 'b', type: 'MUTABLE_RELATION', properties: {weight: 0.5}}]);
        peer = new fileStorage.db.constructor(dbPath, {timeout: 1});
        const prepare  = fileStorage.db.prepare;
        let   observed = false;
        fileStorage.db.prepare = function(sql) {
            if (sql.includes('SELECT id, json_extract')) {
                observed = true;
                expect(() => peer.prepare("UPDATE Nodes SET data = json_set(data, '$.label', 'IDENTITY_FAMILY_MEMBERSHIP') WHERE id = 'a'").run())
                    .toThrow('database is locked');
            }
            return prepare.call(this, sql);
        };
        GraphService.linkNodes('a', 'b', 'MUTABLE_RELATION');
        expect(observed).toBe(true);
        expect(JSON.parse(peer.prepare("SELECT data FROM Nodes WHERE id = 'a'").get().data).label).toBe('NODE');
        expect(JSON.parse(peer.prepare("SELECT data FROM Edges WHERE id = 'ordinary-edge'").get().data).properties.weight).toBe(0.6);
    } finally {
        GraphService.db = graph;
        peer?.close();
        fileGraph?.destroy();
        if (!fileStorage.isDestroyed) fileStorage.destroy();
        rmSync(directory, {recursive: true, force: true});
    }
});

test('ambient decay preserves protected edge IDs, types and cold endpoints while ordinary edges still decay', () => {
    node('a'); node('b'); node('cold', 'IDENTITY_FAMILY_MEMBERSHIP');
    const records = [edge(protectedId, 'a', 'b'), edge('protected-type', 'a', 'b', 'IDENTITY_FAMILY_DECLARES'),
        edge('cold-endpoint', 'a', 'cold')];
    edge('ordinary-edge', 'a', 'b');
    GraphService.decayGlobalTopology(0.1, 0.2, true);
    for (const record of records) expect(JSON.parse(stored('Edges', record.id))).toEqual(record);
    expect(stored('Edges', 'ordinary-edge')).toBeUndefined();
});

test('frontier mutation refuses before changing other cached weights or creating placeholders', () => {
    node('frontier'); node('ordinary'); node('cold', 'IDENTITY_FAMILY_DECLARATION');
    const original = edge('old-frontier-edge', 'frontier', 'ordinary');
    graph.getAdjacentNodes('frontier', 'both');
    expect(() => GraphService.mutateFrontier({targetNodeId: 'cold'})).toThrow('typed admission owner');
    expect(JSON.parse(stored('Edges', original.id))).toEqual(original);
    expect(graph.edges.get(original.id).properties.weight).toBe(0.5);
});

test('direct storage batches and narrow properties cannot overwrite cold protected state', () => {
    node('a'); node('b');
    node('cold', 'IDENTITY_FAMILY_LINEAGE');
    edge(protectedId, 'a', 'b');
    expect(() => storage.addNodes([{id: 'fresh', label: 'NODE'}, {id: 'cold', label: 'NODE'}])).toThrow('typed admission owner');
    expect(stored('Nodes', 'fresh')).toBeUndefined();
    expect(() => storage.setRecordProperty('Nodes', 'cold', 'marker', 'changed')).toThrow('typed admission owner');
    expect(() => storage.setRecordPropertyIfAbsent('Edges', protectedId, 'newField', 'changed')).toThrow('typed admission owner');
    expect(() => storage.removeNodes(['a'])).toThrow('typed admission owner');
    expect(() => storage.removeEdges([protectedId])).toThrow('typed admission owner');
    expect(() => storage.removeNodeIfUnreferenced('cold')).toThrow('typed admission owner');
});

test('a direct Store add refused by storage leaves no protected cache entry', () => {
    expect(() => graph.nodes.add({id: protectedId, label: 'NODE', properties: {admitted: true}})).toThrow('typed admission owner');
    expect(stored('Nodes', protectedId)).toBeUndefined();
    expect(graph.nodes.has(protectedId)).toBe(false);
});

for (const table of ['Nodes', 'Edges']) {
    for (const transactional of [false, true]) {
        test('refusing a ' + table + ' duplicate batch preserves scoped recovery (transaction=' + transactional + ')', () => {
            node('a'); node('b');
            const original = table === 'Nodes' ? node('ordinary-existing') : edge('ordinary-existing', 'a', 'b');
            graph.getAdjacentNodes(table === 'Nodes' ? original.id : 'a', 'both');
            const store     = table === 'Nodes' ? graph.nodes : graph.edges;
            const existing  = store.get(original.id);
            const forbidden = {...original, id: protectedId};
            const cursor    = graph.lastSyncId;
            const write     = () => store.add([existing, forbidden]);
            expect(() => transactional ? graph.transaction(write) : write()).toThrow('typed admission owner');
            expect(stored(table, original.id)).toBe(JSON.stringify(original));
            expect(graph.lastSyncId).toBe(cursor);
            expect(store.has(original.id)).toBe(false);
            graph.getAdjacentNodes(table === 'Nodes' ? original.id : 'a', 'both');
            expect(store.has(original.id)).toBe(true);
            expect(store.get(original.id).properties.marker).toBe('original');
            expect(store.has(protectedId)).toBe(false);
            if (table === 'Edges') expect(store.getByIndex('source', 'a').map(row => row.id)).toEqual([original.id]);
        });
    }
}

test('refused direct edge insertion and cached deletion recover without duplicate indexes', () => {
    node('a'); node('b'); node('free');
    graph.getAdjacentNodes('a', 'both');
    expect(() => graph.edges.add({id: protectedId, source: 'a', target: 'b', type: 'RELATED_TO', properties: {}})).toThrow('typed admission owner');
    expect(graph.edges.has(protectedId)).toBe(false);
    expect(graph.edges.getByIndex('source', 'a')).toEqual([]);
    const original = edge(protectedId, 'a', 'b');
    graph.getAdjacentNodes('a', 'both');
    expect(graph.edges.getByIndex('source', 'a').map(row => row.id), 'after authoritative hydration').toEqual([protectedId]);
    graph.getAdjacentNodes('free', 'both');
    expect(graph.edges.getByIndex('source', 'a').map(row => row.id), 'after unrelated hydration').toEqual([protectedId]);
    expect(() => graph.nodes.remove(['free', 'a'])).toThrow('typed admission owner');
    expect(graph.nodes.has('free')).toBe(false);
    expect(graph.edges.getByIndex('source', 'a')).toEqual([]);
    graph.getAdjacentNodes('free', 'both');
    graph.getAdjacentNodes('a', 'both');
    expect(graph.nodes.has('free')).toBe(true);
    expect(graph.nodes.has('a')).toBe(true);
    expect(graph.edges.getByIndex('source', 'a').map(row => row.id), 'after node rollback').toEqual([protectedId]);
    expect(() => graph.edges.remove(protectedId)).toThrow('typed admission owner');
    expect(graph.edges.has(protectedId)).toBe(false);
    graph.getAdjacentNodes('a', 'both');
    expect(graph.edges.has(protectedId)).toBe(true);
    expect(graph.edges.getByIndex('source', 'a').map(row => row.id)).toEqual([protectedId]);
    expect(JSON.parse(stored('Edges', protectedId))).toEqual(original);
});

test('a logical transaction with a late protected addition restores earlier cache and physical changes', () => {
    expect(() => graph.transaction(() => {
        graph.addNode({id: 'ordinary-batch-node', label: 'NODE'});
        graph.addNode({id: protectedId, label: 'NODE'});
    })).toThrow('typed admission owner');
    expect(stored('Nodes', 'ordinary-batch-node')).toBeUndefined();
    expect(graph.nodes.has('ordinary-batch-node')).toBe(false);
    expect(graph.nodes.has(protectedId)).toBe(false);
});

for (const table of ['Nodes', 'Edges']) {
    test('a mixed direct ' + table + ' splice refuses as one physical operation', () => {
        node('a'); node('b');
        if (table === 'Nodes') node(protectedId);
        else edge(protectedId, 'a', 'b');
        graph.getAdjacentNodes(table === 'Nodes' ? protectedId : 'a', 'both');
        const store    = table === 'Nodes' ? graph.nodes : graph.edges;
        const addition = table === 'Nodes'
            ? {id: 'ordinary-added', label: 'NODE', properties: {}}
            : {id: 'ordinary-added', source: 'a', target: 'b', type: 'RELATED_TO', properties: {}};
        expect(() => store.splice(0, [protectedId], [addition])).toThrow('typed admission owner');
        expect(stored(table, 'ordinary-added')).toBeUndefined();
        expect(store.has('ordinary-added')).toBe(false);
        expect(stored(table, protectedId)).toBeTruthy();
        graph.getAdjacentNodes(table === 'Nodes' ? protectedId : 'a', 'both');
        expect(store.has(protectedId)).toBe(true);
    });
}

test('bulk protection honors legacy type DTOs at persisted edge endpoints', () => {
    node('a');
    storage.db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run('legacy', JSON.stringify({
        id: 'legacy', type: 'IDENTITY_FAMILY_MEMBERSHIP', properties: {}
    }));
    const original = edge('legacy-reference', 'a', 'legacy');
    GraphService.decayGlobalTopology(0.1, 0.2, true);
    expect(stored('Edges', original.id)).toBe(JSON.stringify(original));
});

test('ordinary records remain writable through GraphService, Stores and narrow storage updates', () => {
    GraphService.upsertNode({id: 'ordinary', type: 'NODE', properties: {marker: 'first'}});
    GraphService.upsertNode({id: 'ordinary', type: 'NODE', properties: {marker: 'next'}});
    graph.nodes.add({id: 'second', label: 'NODE', properties: {}});
    GraphService.linkNodes('ordinary', 'second', 'RELATED_TO');
    expect(storage.setRecordProperty('Nodes', 'ordinary', 'marker', 'last')).toBe(true);
    expect(JSON.parse(stored('Nodes', 'ordinary')).properties.marker).toBe('last');
});

test('the administrative schema-wipe flag cannot erase a graph with class-9 fence state', () => {
    const previous = process.env.NEO_ALLOW_SCHEMA_WIPE;
    node('retained');
    storage.db.transaction(() => fenceIdentityPublication(storage.db, {
        planeId: 'fixture', dataRoot: '/fixture', operation: 'fixture', source: 'fixture'
    })).immediate();
    try {
        process.env.NEO_ALLOW_SCHEMA_WIPE = 'true';
        expect(() => storage.resetGraphSchemaOrThrow('fixture reset')).toThrow('admitted recovery');
        expect(stored('Nodes', 'retained')).toBeTruthy();
    } finally {
        if (previous === undefined) delete process.env.NEO_ALLOW_SCHEMA_WIPE;
        else process.env.NEO_ALLOW_SCHEMA_WIPE = previous;
    }
});

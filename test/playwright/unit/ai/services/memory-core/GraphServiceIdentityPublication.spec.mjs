import {setup}                                                    from '../../../../setup.mjs';
import {test, expect}                                             from '@playwright/test';
import Neo                                                        from 'neo.mjs/src/Neo.mjs';
import * as core                                                  from 'neo.mjs/src/core/_export.mjs';
import SQLite                                                     from '../../../../../../ai/graph/storage/SQLite.mjs';
import GraphDatabase                                              from '../../../../../../ai/graph/Database.mjs';
import {generateKeyPairSync, sign}                                from 'node:crypto';
import {stringifyCanonicalJson}                                   from '../../../../../../ai/services/shared/canonicalJson.mjs';
import {compileFoundingFamilySeed}                                from '../../../../../../ai/graph/identityFoundingSeed.mjs';
import {familyFoundingKey, familyLineageKey, familyPlaneStateKey} from '../../../../../../ai/services/shared/identityPublicationKeys.mjs';
import {readIdentityPublicationFence}                             from '../../../../../../ai/services/memory-core/helpers/identityPublicationFence.mjs';

setup({appConfig: {name: 'GraphServiceIdentityPublicationTest'}});

let service, originalDb, graph, storage;
const target    = {planeId: 'graph-owner-fixture', dataRoot: '/fixture/graph-owner'},
    key         = generateKeyPairSync('ed25519'),
    reservation = {version: 1, target, issuer: 'fixture-fleet',
        reservation: {attemptId: 'fixture-attempt', kid: 'key-a', originRunId: '123e4567-e89b-42d3-a456-426614174000'}, trust: null},
    boot = stringifyCanonicalJson({...reservation, trust: [{kid: 'key-a',
        publicKey: key.publicKey.export({type: 'spki', format: 'der'}).toString('base64url')}]}),
    seed = compileFoundingFamilySeed({identities: [{id: '@founder', type: 'AgentIdentity',
        properties: {accountType: 'agent', modelFamily: 'gpt'}}], subjects: [{identityKey: '@founder',
        subject   : {authProvider: 'github', providerBaseUrl: 'https://api.github.com', providerUserId: 'founder'}}]}),
    baseline = {kind: 'baseline', operationId: 'baseline', effectiveAt: 90, expectedPlaneRevision: 0, bindings: []};

/** @summary Signs only literal fixture operations with an ephemeral in-memory key. */
function token(operation) {
    const bytes = Buffer.from(stringifyCanonicalJson({version: 1, purpose: 'identity-family-publication',
        audience: target.planeId, issuer: 'fixture-fleet', kid: 'key-a', issuedAt: 100, expiresAt: 300100, operation}));
    return bytes.toString('base64url') + '.' + sign(null,
        Buffer.concat([Buffer.from('neo.identity-family-publication.v1\0'), bytes]), key.privateKey).toString('base64url');
}

/** @summary Captures the physical fixture and cache cursor without hydrating any records. */
function physical() {
    return {nodes: storage.db.prepare('SELECT * FROM Nodes ORDER BY id').all(),
        edges: storage.db.prepare('SELECT * FROM Edges ORDER BY id').all(),
        log  : storage.db.prepare('SELECT * FROM GraphLog ORDER BY log_id').all(), cursor: graph.lastSyncId};
}

test.beforeAll(async () => {
    service = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
    await service.ready();
    originalDb = service.db;
    expect(originalDb.storage.dbPath).toBe(':memory:');
});

test.beforeEach(async () => {
    storage = Neo.create(SQLite, {dbPath: ':memory:'});
    await storage.ready();
    graph = Neo.create(GraphDatabase, {storage});
    await graph.ready();
    service.db = graph;
});

test.afterEach(() => {
    service.db = originalDb;
    graph.autoSave = false;
    graph.destroy();
    storage.destroy();
});

test('raw edge reinforcement refuses protected history before changing physical or cached properties', () => {
    storage.addNodes([{id: 'source', label: 'TEST', properties: {}}, {id: 'target', label: 'TEST', properties: {}}]);
    const edge = {id: 'identity-family-test-edge', source: 'source', target: 'target',
        type: 'IDENTITY_FAMILY_RELATION', properties: {weight: 0.5, retained: true}};
    storage.db.prepare('INSERT INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)')
        .run(edge.id, edge.source, edge.target, edge.type, JSON.stringify(edge));
    graph.getAdjacentNodes('source', 'both');
    const before = physical();
    expect(() => service.linkNodes('source', 'target', edge.type, 2, {retained: false}))
        .toThrow(/protected/i);
    expect(physical()).toEqual(before);
    expect(graph.edges.get(edge.id).get('properties')).toMatchObject({weight: 0.5, retained: true});
});

test('frontier mutation refuses before touching a protected cached edge', () => {
    storage.addNodes(['frontier', 'history', 'next'].map(id => ({id, label: 'TEST', properties: {}})));
    const edge = {id: 'identity-family-frontier-edge', source: 'frontier', target: 'history',
        type: 'RELATED_TO', properties: {weight: 0.5}};
    storage.db.prepare('INSERT INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)')
        .run(edge.id, edge.source, edge.target, edge.type, JSON.stringify(edge));
    graph.getAdjacentNodes('frontier', 'both');
    const before = physical();
    expect(() => service.mutateFrontier({targetNodeId: 'next'})).toThrow(/protected/i);
    expect(physical()).toEqual(before);
    expect(graph.edges.getByIndex('source', 'frontier').map(value => value.properties.weight)).toEqual([0.5]);
});

test('a late physical frontier refusal evicts speculative weights and leaves the foreign log unread', () => {
    storage.addNodes(['frontier', 'history', 'next'].map(id => ({id, label: 'TEST', properties: {}})));
    storage.addEdges([{id: 'frontier-edge', source: 'frontier', target: 'history', type: 'RELATED_TO', properties: {weight: 0.5}}]);
    graph.getAdjacentNodes('frontier', 'both');
    const originalAdd = storage.addEdges, cursor = graph.lastSyncId;
    storage.addEdges = edges => {
        storage.db.prepare("UPDATE Edges SET type = 'IDENTITY_FAMILY_RELATION', data = json_set(data, '$.type', 'IDENTITY_FAMILY_RELATION') WHERE id = 'frontier-edge'").run();
        return originalAdd.call(storage, edges);
    };
    try {
        expect(() => service.mutateFrontier({targetNodeId: 'next'})).toThrow(/protected/i);
    } finally { storage.addEdges = originalAdd; }
    expect(graph.lastSyncId).toBe(cursor);
    expect(graph.edges.getByIndex('source', 'frontier')).toEqual([]);
    graph.getAdjacentNodes('frontier', 'both');
    expect(graph.edges.get('frontier-edge').get('properties').weight).toBe(0.5);
});

test('ambient decay preserves protected bytes while ordinary edges still decay and prune', () => {
    storage.addNodes(['a', 'b'].map(id => ({id, label: 'TEST', properties: {}})));
    const protectedEdge = {id: 'identity-family-decay', source: 'a', target: 'b', type: 'RELATED_TO', properties: {weight: 0.1}};
    storage.db.prepare('INSERT INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)')
        .run(protectedEdge.id, 'a', 'b', protectedEdge.type, JSON.stringify(protectedEdge));
    storage.addEdges([{id: 'ordinary-decay', source: 'a', target: 'b', type: 'RELATED_TO', properties: {weight: 0.1}}]);
    const before = storage.db.prepare('SELECT * FROM Edges WHERE id = ?').get(protectedEdge.id);
    service.decayGlobalTopology(0.5, 0.2, true);
    expect(storage.db.prepare('SELECT * FROM Edges WHERE id = ?').get(protectedEdge.id)).toEqual(before);
    expect(storage.db.prepare('SELECT * FROM Edges WHERE id = ?').get('ordinary-decay')).toBeUndefined();
});

test('the GraphService owner commits lineage, founding and admission before invalidating its cache', () => {
    expect(service.consumeIdentityPublicationBoot(stringifyCanonicalJson(reservation), target).state).toBe('reserved');
    expect(service.consumeIdentityPublicationBoot(boot, target).state).toBe('bound');
    expect(service.installIdentityFoundingSource({bootText: boot, target, seed,
        sourceRevision: 'fixture-review', clock: () => 95}).state).toBe('installed');
    expect(service.admitIdentityPublication(token(baseline), {bootText: boot, target, clock: () => 100}).state).toBe('accepted');
    expect(graph.lastSyncId).toBe(storage.getLatestLogId());
    const read = service.readIdentityPublicationSnapshot({bootText: boot, target});
    expect(read).toMatchObject({state: 'available', snapshot: {revision: 1, foundingRevision: 1, founding: seed}});
    expect(read.snapshot.subjects[0].subject.providerUserId).toBe('founder');
    expect(storage.db.prepare('SELECT count(*) AS n FROM Nodes WHERE id IN (?, ?)')
        .get(familyFoundingKey(target), familyPlaneStateKey(target)).n).toBe(2);
});

test('receipt failure leaves the owner cache and physical history unchanged', () => {
    service.consumeIdentityPublicationBoot(stringifyCanonicalJson(reservation), target);
    service.consumeIdentityPublicationBoot(boot, target);
    service.installIdentityFoundingSource({bootText: boot, target, seed, sourceRevision: 'fixture', clock: () => 95});
    graph.getAdjacentNodes(familyFoundingKey(target), 'both');
    const cached = graph.nodes.get(familyFoundingKey(target)), before = physical();
    storage.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON Nodes WHEN json_extract(NEW.data, '$.label') = 'IDENTITY_FAMILY_RECEIPT' BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    expect(service.admitIdentityPublication(token(baseline), {bootText: boot, target, clock: () => 100}).state).toBe('unavailable');
    expect(physical()).toEqual(before);
    expect(graph.nodes.get(familyFoundingKey(target))).toBe(cached);
});

test('missing storage and outer transactions cannot produce positive owner observations', () => {
    expect(storage.db.transaction(() => service.consumeIdentityPublicationBoot(stringifyCanonicalJson(reservation), target))()
        .state).toBe('unadmitted');
    service.db = null;
    expect(service.readIdentityPublicationSnapshot({bootText: boot, target}).state).toBe('unavailable');
    expect(service.admitIdentityPublication(token(baseline), {bootText: boot, target, clock: () => 100}).state).toBe('unavailable');
});

test('a logical Store transaction cannot obtain a publication receipt or read witness', () => {
    const before = physical();
    graph.transaction(() => {
        expect(service.consumeIdentityPublicationBoot(stringifyCanonicalJson(reservation), target))
            .toMatchObject({state: 'unavailable', code: 'publication-transaction-in-progress'});
        expect(service.readIdentityPublicationLineage(boot, target).state).toBe('unavailable');
        expect(service.readIdentityPublicationSnapshot({bootText: boot, target}).state).toBe('unavailable');
    });
    expect(physical()).toEqual(before);
});

test('a cache-sync failure after commit reconciles the same receipt without a duplicate admission', () => {
    service.consumeIdentityPublicationBoot(stringifyCanonicalJson(reservation), target);
    service.consumeIdentityPublicationBoot(boot, target);
    service.installIdentityFoundingSource({bootText: boot, target, seed, sourceRevision: 'fixture', clock: () => 95});
    const originalSync = graph.syncCache;
    graph.syncCache = () => { throw new Error('fixture cache failure'); };
    try {
        expect(() => service.admitIdentityPublication(token(baseline), {bootText: boot, target, clock: () => 100}))
            .toThrow('fixture cache failure');
    } finally { graph.syncCache = originalSync; }
    expect(service.admitIdentityPublication(token(baseline), {bootText: boot, target, clock: () => 100}).state).toBe('idempotent');
    expect(storage.db.prepare("SELECT count(*) AS n FROM Nodes WHERE json_extract(data, '$.label') = 'IDENTITY_FAMILY_RECEIPT'").get().n).toBe(1);
    expect(graph.lastSyncId).toBe(storage.getLatestLogId());
});

test('a partial cache invalidation failure preserves flags and cursor so the same boot retry reloads bound lineage', () => {
    expect(service.consumeIdentityPublicationBoot(stringifyCanonicalJson(reservation), target).state).toBe('reserved');
    const id = familyLineageKey(target);
    graph.getAdjacentNodes(id, 'both');
    expect(graph.nodes.get(id).get('properties').publicKey).toBeNull();
    const before = {cursor: graph.lastSyncId, autoSave: graph.autoSave, isExecutingTransaction: graph.isExecutingTransaction};
    const remove = graph.nodes.remove;
    graph.nodes.remove = () => {throw new Error('fixture partial invalidation failure');};
    try {
        expect(() => service.consumeIdentityPublicationBoot(boot, target)).toThrow('fixture partial invalidation failure');
    } finally {graph.nodes.remove = remove;}
    expect(JSON.parse(storage.db.prepare('SELECT data FROM Nodes WHERE id = ?').get(id).data).properties.publicKey)
        .toBe(JSON.parse(boot).trust[0].publicKey);
    expect({cursor: graph.lastSyncId, autoSave: graph.autoSave, isExecutingTransaction: graph.isExecutingTransaction})
        .toEqual(before);
    expect(graph.nodes.get(id).get('properties').publicKey).toBeNull();
    expect(service.consumeIdentityPublicationBoot(boot, target).state).toBe('bound');
    expect(graph.lastSyncId).toBe(storage.getLatestLogId());
    graph.getAdjacentNodes(id, 'both');
    expect(graph.nodes.get(id).get('properties').publicKey).toBe(JSON.parse(boot).trust[0].publicKey);
});

test('the live fence callback binds its exact connection and commits only with its physical mutation', async () => {
    const info = {db: storage.db, operation: 'fixture-replace', source: 'fixture'}, before = physical();
    expect(() => service.fenceIdentityPublication({...info, db: {}})).toThrow('live GraphService connection');
    expect(() => service.fenceIdentityPublication(info)).toThrow(/transaction/);
    expect(physical()).toEqual(before);
    expect(() => storage.db.transaction(() => {
        service.fenceIdentityPublication(info);
        throw new Error('fixture abort');
    }).immediate()).toThrow('fixture abort');
    expect(storage.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'IdentityPublicationFence'").get()).toBeUndefined();
    const result = storage.db.transaction(() => service.fenceIdentityPublication(info)).immediate(),
        config   = (await import('../../../../../../ai/mcp/server/memory-core/config.template.mjs')).default;
    expect(result.state).toBe('fenced');
    expect(readIdentityPublicationFence(storage.db, {planeId: config.plane.id, dataRoot: config.plane.dataRoot}))
        .toMatchObject({state: 'fenced', cause: {operation: info.operation, source: info.source}});
});

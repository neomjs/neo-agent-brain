import {test, expect}                                    from '@playwright/test';
import Database                                          from 'better-sqlite3';
import {participationByIdentity, readAgentIdentityNodes} from '../../../../../ai/graph/agentIdentityParticipation.mjs';

/**
 * @summary The one participation read every plane-side reader shares: the AgentIdentity node rows `who_is_online`
 * reads, and the status each records.
 */
test.describe('ai/graph/agentIdentityParticipation', () => {
    let db;

    test.beforeEach(() => {
        db = new Database(':memory:');
        db.exec('CREATE TABLE Nodes (id TEXT PRIMARY KEY, data TEXT)')
    });

    test.afterEach(() => {
        try { db.close() } catch {}
    });

    test('readAgentIdentityNodes answers the AgentIdentity rows only, through the graph store\'s label index', () => {
        // the graph store's own index (ai/graph/storage/SQLite.mjs)
        db.exec(`CREATE INDEX idx_nodes_label ON Nodes(json_extract(data, '$.label'))`);

        const insert = db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)');

        insert.run('@neo-gpt', JSON.stringify({id: '@neo-gpt', label: 'AgentIdentity', properties: {participationStatus: 'operator_benched'}}));
        insert.run('@neo-kimi-iris', JSON.stringify({id: '@neo-kimi-iris', label: 'AgentIdentity', properties: {}}));
        insert.run('msg_1', JSON.stringify({id: 'msg_1', label: 'MESSAGE', properties: {}}));

        const prepared = [],
              spy      = {prepare: sql => { prepared.push(sql); return db.prepare(sql) }};

        expect(readAgentIdentityNodes(spy).map(node => [node.id, node.properties.participationStatus ?? null])).toEqual([
            ['@neo-gpt', 'operator_benched'],
            ['@neo-kimi-iris', null]
        ]);

        // the readers ask this every poll: the exact SQL must search the index, never scan Nodes
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${prepared[0]}`).all().map(row => row.detail).join(' | ');

        expect(plan).toContain('USING INDEX idx_nodes_label');
        // and the same index rejects a row whose data does not parse, so the read never meets one
        expect(() => insert.run('@broken', '{"label": "AgentIdentity", ')).toThrow(/malformed JSON/)
    });

    test('a store that cannot answer, or no store at all, throws: a reader names it and never falls back to the roots', () => {
        expect(() => readAgentIdentityNodes(null)).toThrow('no graph store to read the identity nodes from');

        db.close();
        expect(() => readAgentIdentityNodes(db)).toThrow()
    });

    test('participationByIdentity keys the canonical identity, and a node that records no status is active', () => {
        expect([...participationByIdentity([
            {id: 'neo-gpt', properties: {participationStatus: 'operator_benched'}},
            {id: '@neo-kimi-iris', properties: {}}
        ])]).toEqual([['@neo-gpt', 'operator_benched'], ['@neo-kimi-iris', 'active']])
    })
});

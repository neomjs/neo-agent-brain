import {test, expect} from '@playwright/test';
import Database       from 'better-sqlite3';
import {
    backfillMessageEmbeddings,
    toGraphMessageEmbedRecord
} from '../../../../../../ai/scripts/maintenance/backfillMessageEmbeddings.mjs';
import {toMessageEmbedRecord} from '../../../../../../ai/services/memory-core/helpers/messageWalStore.mjs';

const SENT_AT = '2026-10-01T12:00:00.000Z';

/**
 * @summary One message as both of its sources: the WAL record the drain maps and the graph node with
 * the routing edges the backfill reads. The graph spells identities the legacy ways.
 * @param {String} id
 * @param {Object} wal   WAL routing.
 * @param {Array[]} edges `[type, target, properties]` triples.
 * @param {Object} [properties]
 * @returns {{record: Object, node: Object, edges: Object[]}}
 */
function message(id, wal, edges, properties = {}) {
    const props = {subject: `${id} subject`, bodyText: `${id} body`, sentAt: SENT_AT, ...properties};

    return {
        record: {id, timestamp: Date.parse(SENT_AT), message: {id, type: 'MESSAGE', name: id, properties: props}, routing: {sentBy: '@alice', ...wal}},
        node  : {id, properties: props},
        edges : edges.map(([type, target, properties = {}]) => ({type, target, properties}))
    }
}

const corpus = [
    message('MESSAGE:direct', {to: '@bob', broadcastRecipients: []}, [['SENT_BY', 'AGENT:@alice'], ['SENT_TO', 'bob']], {partOfThread: 'THREAD:1'}),
    message('MESSAGE:known', {to: 'AGENT:*', broadcastRecipients: ['@bob', '@carol']}, [
        ['SENT_BY', '@alice'], ['SENT_TO', 'AGENT:*', {broadcastCohort: 'known', intendedRecipientCount: 2}],
        ['DELIVERED_TO', '@bob'], ['DELIVERED_TO', 'AGENT:carol']
    ]),
    message('MESSAGE:known-zero', {to: 'AGENT:*', broadcastRecipients: []}, [['SENT_BY', '@alice'], ['SENT_TO', 'AGENT:*', {broadcastCohort: 'known', intendedRecipientCount: 0}]]),
    message('MESSAGE:legacy', {to: 'AGENT:*'}, [['SENT_BY', '@alice'], ['SENT_TO', 'AGENT:*', {broadcastCohort: 'legacy-unknown'}]]),
    message('MESSAGE:unstamped', {to: 'AGENT:*'}, [['SENT_BY', '@alice'], ['SENT_TO', 'AGENT:*']])
];

/**
 * @summary An in-memory graph holding the given messages.
 * @param {Object[]} messages `{node, edges}` pairs.
 * @returns {Object} better-sqlite3 handle.
 */
function seedGraph(messages) {
    const db = new Database(':memory:');

    db.exec(`CREATE TABLE Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL);
             CREATE TABLE Edges (id TEXT PRIMARY KEY, user_id TEXT, source TEXT NOT NULL, target TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);`);

    const insertNode = db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, NULL, ?)'),
          insertEdge = db.prepare('INSERT INTO Edges (id, user_id, source, target, type, data) VALUES (?, NULL, ?, ?, ?, ?)');

    messages.forEach(({node, edges}, n) => {
        insertNode.run(node.id, JSON.stringify({id: node.id, label: 'MESSAGE', properties: node.properties}));
        edges.forEach((edge, e) => insertEdge.run(`E${n}-${e}`, node.id, edge.target, edge.type, JSON.stringify({properties: edge.properties})))
    });

    return db
}

/**
 * @summary Marks a message's graph node retracted, as `MailboxService` does.
 * @param {Object} db
 * @param {String} id
 */
function retract(db, id) {
    db.prepare(`UPDATE Nodes SET data = json_set(data, '$.properties.retracted', json('true')) WHERE id = ?`).run(id)
}

/**
 * @summary A message collection double: holds rows by id and records its writes.
 * @param {Object}   [options]
 * @param {String[]} [options.held=[]]      Ids it already holds.
 * @param {Function} [options.onUpsert]     Called with each upsert's arguments before it writes; may throw.
 * @param {Function} [options.afterUpsert]  Called after an upsert wrote its rows; a throw is a lost answer.
 * @param {Function} [options.onDelete]     Called with each delete's arguments before it deletes; may throw.
 * @returns {Object}
 */
function fakeCollection({held = [], onUpsert = () => {}, afterUpsert = () => {}, onDelete = () => {}} = {}) {
    const rows = new Map(held.map(id => [id, {}]));

    return {
        rows,
        upserts: [],
        deletes: [],
        async get({ids, limit}) {
            return ids
                ? {ids: ids.filter(id => rows.has(id))}
                : {ids: [...rows.keys()].slice(0, limit), embeddings: rows.size > 0 ? [new Array(8).fill(0)] : []}
        },
        async upsert(args) {
            this.upserts.push(args);
            onUpsert(args);
            args.ids.forEach((id, i) => rows.set(id, {metadata: args.metadatas[i], document: args.documents[i]}));
            afterUpsert(args)
        },
        async delete({ids}) {
            this.deletes.push(ids);
            onDelete({ids});
            ids.forEach(id => rows.delete(id))
        }
    }
}

test.describe('backfillMessageEmbeddings maintenance script', () => {
    test('the graph mapper writes exactly what the WAL mapper writes for the same message', () => {
        for (const {record, node, edges} of corpus) {
            const fromWal   = toMessageEmbedRecord(record, '2026-10-01'),
                  fromGraph = toGraphMessageEmbedRecord(node, edges);

            expect(fromGraph, node.id).toEqual({id: fromWal.id, document: fromWal.document, metadata: fromWal.metadata})
        }
    });

    test('a message missing a route edge or its send time maps to nothing', () => {
        const {node, edges} = corpus[0];

        expect(toGraphMessageEmbedRecord(node, edges.filter(edge => edge.type !== 'SENT_TO'))).toBeNull();
        expect(toGraphMessageEmbedRecord({...node, properties: {...node.properties, sentAt: undefined}}, edges)).toBeNull();
    });

    test('a dry run counts and projects without writing; apply embeds the rest; a re-run embeds nothing', async () => {
        const retracted  = message('MESSAGE:retracted', {to: '@bob'}, [['SENT_BY', '@alice'], ['SENT_TO', '@bob']], {retracted: true}),
              incomplete = message('MESSAGE:incomplete', {to: '@bob'}, [['SENT_TO', '@bob']]),
              db         = seedGraph([...corpus, retracted, incomplete]),
              collection = fakeCollection({held: ['MESSAGE:direct']});

        const dryRun = await backfillMessageEmbeddings({db, collection});

        expect(dryRun).toEqual({
            mode          : 'dry-run', messages: 7, embedded: 0, pending: 4, compensated: 0, failed: 0,
            skipped       : {present: 1, retracted: 1, incomplete: 1},
            projectedBytes: 4 * 8 * 4
        });
        expect(collection.upserts).toHaveLength(0);

        const applied = await backfillMessageEmbeddings({db, collection, apply: true, embedBatchSize: 3});

        expect(applied).toMatchObject({mode: 'apply', embedded: 4, pending: 4, failed: 0});
        expect(collection.upserts.map(call => call.ids.length)).toEqual([3, 1]);
        expect(collection.rows.get('MESSAGE:known').metadata).toEqual(toMessageEmbedRecord(corpus[1].record, 'x').metadata);

        // The collection is the cursor: everything it now holds is skipped.
        expect(await backfillMessageEmbeddings({db, collection, apply: true})).toMatchObject({embedded: 0, pending: 0, skipped: {present: 5}});
    });

    test('a failed batch is counted and the run moves on; the next run retries it', async () => {
        let   calls = 0;
        const db    = seedGraph(corpus),
              collection = fakeCollection({onUpsert: () => {
                  if (calls++ === 0) throw new Error('embedder unavailable')
              }});

        expect(await backfillMessageEmbeddings({db, collection, apply: true, embedBatchSize: 2})).toMatchObject({embedded: 3, failed: 2});
        expect(await backfillMessageEmbeddings({db, collection, apply: true, embedBatchSize: 2})).toMatchObject({embedded: 2, failed: 0, skipped: {present: 3}});
    });

    test('a message retracted while its batch is written is deleted again', async () => {
        const db         = seedGraph(corpus),
              collection = fakeCollection({onUpsert: ({ids}) => {
                  if (ids.includes('MESSAGE:known')) retract(db, 'MESSAGE:known')
              }});

        const receipt = await backfillMessageEmbeddings({db, collection, apply: true});

        expect(collection.deletes).toEqual([['MESSAGE:known']]);
        expect(collection.rows.has('MESSAGE:known')).toBe(false);
        expect(receipt).toMatchObject({embedded: 4, skipped: {retracted: 1}});
    });

    test('a write that lands after its answer is lost, for a message retracted meanwhile, is deleted by the next run', async () => {
        let   lost = false;
        const db   = seedGraph(corpus),
              collection = fakeCollection({afterUpsert: ({ids}) => {
                  if (!lost && ids.includes('MESSAGE:known')) {
                      lost = true;
                      retract(db, 'MESSAGE:known');
                      throw new Error('socket hang up')
                  }
              }});

        expect(await backfillMessageEmbeddings({db, collection, apply: true})).toMatchObject({embedded: 0, failed: 5, compensated: 0});
        expect(collection.rows.has('MESSAGE:known')).toBe(true);

        expect(await backfillMessageEmbeddings({db, collection, apply: true}))
            .toMatchObject({embedded: 0, pending: 0, compensated: 1, failed: 0, skipped: {present: 4, retracted: 0}});
        expect(collection.deletes).toEqual([['MESSAGE:known']]);
        expect(collection.rows.has('MESSAGE:known')).toBe(false);
    });

    test('a dry run counts a retracted message the collection holds and deletes nothing', async () => {
        const retracted  = message('MESSAGE:retracted', {to: '@bob'}, [['SENT_BY', '@alice'], ['SENT_TO', '@bob']], {retracted: true}),
              db         = seedGraph([...corpus, retracted]),
              collection = fakeCollection({held: ['MESSAGE:direct', 'MESSAGE:retracted']});

        expect(await backfillMessageEmbeddings({db, collection}))
            .toMatchObject({mode: 'dry-run', pending: 4, compensated: 1, skipped: {present: 1, retracted: 0}});
        expect(collection.deletes).toEqual([]);
        expect(collection.rows.has('MESSAGE:retracted')).toBe(true);
    });

    test('a failed delete is counted, the run finishes, and the next run deletes the message', async () => {
        let   refuse = true;
        const db     = seedGraph(corpus),
              collection = fakeCollection({
                  onUpsert: ({ids}) => {
                      if (ids.includes('MESSAGE:known')) retract(db, 'MESSAGE:known')
                  },
                  onDelete: () => {
                      if (refuse) {
                          refuse = false;
                          throw new Error('collection unavailable')
                      }
                  }
              });

        expect(await backfillMessageEmbeddings({db, collection, apply: true}))
            .toMatchObject({embedded: 4, failed: 1, compensated: 0, skipped: {retracted: 0}});
        expect(collection.rows.has('MESSAGE:known')).toBe(true);

        expect(await backfillMessageEmbeddings({db, collection, apply: true})).toMatchObject({compensated: 1, failed: 0});
        expect(collection.rows.has('MESSAGE:known')).toBe(false);
    });
});

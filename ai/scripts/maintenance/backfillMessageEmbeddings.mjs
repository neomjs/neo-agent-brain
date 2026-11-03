import {Command}                     from 'commander';
import Database                      from 'better-sqlite3';
import path                          from 'node:path';
import {SQLITE_IN_CLAUSE_BATCH_SIZE} from '../../graph/storage/constants.mjs';
import {isEntryModule}               from '../../services/shared/isEntryModule.mjs';
import {
    toMessageEmbedDocument,
    toMessageEmbedMetadata
} from '../../services/memory-core/helpers/messageWalStore.mjs';

/**
 * @module ai/scripts/maintenance/backfillMessageEmbeddings
 * @summary Embeds the graph's `MESSAGE` nodes that the A2A message index does not hold.
 *
 * The embed drain indexes messages from the message WAL, which keeps only its retention window; the
 * graph keeps every message. This walks the graph's `MESSAGE` nodes in send order and embeds each
 * one the collection lacks, with the metadata the drain writes (`toMessageEmbedMetadata`), so
 * admission reads one shape whichever source wrote a row.
 *
 * The collection is the cursor: an id it already holds is skipped, so an interrupted run resumes
 * where it stopped, and a graph restore is followed by a re-run. Retracted and incompletely routed
 * messages are skipped and counted. A message retracted while its batch was being written is
 * deleted again afterwards, as the drain compensates a mid-embed retraction.
 *
 * Run it inside the Memory Core container against the serving graph, which it opens read-only.
 * Dry-run by default: the receipt then counts what `--apply` would embed and projects its vector
 * bytes, the number the plane's Chroma sizing reads before a write.
 */

const BROADCAST_EDGE_TYPES = "'SENT_BY', 'SENT_TO', 'DELIVERED_TO'";

/**
 * @summary Maps one graph `MESSAGE` node and its routing edges to the embed record the drain writes.
 *
 * The audience is the `DELIVERED_TO` set, the edges `getMessage` admits by. A broadcast without
 * delivery edges is known-zero when its `SENT_TO` stamp says `known`, and legacy otherwise; both
 * are open to everyone.
 *
 * @param {Object}   node  `{id, properties}` of one `MESSAGE` node.
 * @param {Object[]} edges Its outgoing `SENT_BY` / `SENT_TO` / `DELIVERED_TO` edges, `{type, target, properties}`.
 * @returns {{id: String, document: String, metadata: Object}|null} `null` when a route edge or the send time is missing.
 */
export function toGraphMessageEmbedRecord(node, edges) {
    const deliveries = [];
    let   sentBy     = null,
          sentTo     = null;

    for (const edge of edges) {
        if (edge.type === 'SENT_BY')      sentBy = edge.target;
        if (edge.type === 'SENT_TO')      sentTo = edge;
        if (edge.type === 'DELIVERED_TO') deliveries.push(edge.target);
    }

    const sentAt = Date.parse(node.properties.sentAt);

    if (!sentBy || !sentTo || Number.isNaN(sentAt)) return null;

    const known = deliveries.length > 0 || sentTo.properties?.broadcastCohort === 'known';

    return {
        id      : node.id,
        document: toMessageEmbedDocument(node.properties),
        metadata: toMessageEmbedMetadata({
            sentBy,
            to      : sentTo.target,
            audience: known ? deliveries : undefined,
            threadId: node.properties.partOfThread,
            sentAt
        })
    }
}

/**
 * @summary Reads one page of `MESSAGE` nodes with their routing edges.
 * @param {Object}   db  Open better-sqlite3 handle.
 * @param {String[]} ids Message ids, at most `SQLITE_IN_CLAUSE_BATCH_SIZE`.
 * @returns {Array<{node: Object, edges: Object[]}>} In `ids` order; an id without a node is absent.
 */
export function readMessagePage(db, ids) {
    const list  = ids.map(() => '?').join(', '),
          nodes = new Map(db.prepare(`SELECT id, data FROM Nodes WHERE id IN (${list})`).all(...ids)
              .map(row => [row.id, {id: row.id, properties: JSON.parse(row.data).properties ?? {}}])),
          edges = new Map(ids.map(id => [id, []]));

    db.prepare(`SELECT source, target, type, data FROM Edges WHERE source IN (${list}) AND type IN (${BROADCAST_EDGE_TYPES})`)
        .all(...ids)
        .forEach(row => edges.get(row.source).push({type: row.type, target: row.target, properties: JSON.parse(row.data ?? '{}').properties ?? {}}));

    return ids.filter(id => nodes.has(id)).map(id => ({node: nodes.get(id), edges: edges.get(id)}))
}

/**
 * @summary Ids of the given messages whose node is now retracted.
 * @param {Object}   db
 * @param {String[]} ids
 * @returns {String[]}
 */
function readRetracted(db, ids) {
    return db.prepare(`SELECT id FROM Nodes WHERE id IN (${ids.map(() => '?').join(', ')})
        AND json_extract(data, '$.properties.retracted') = 1`).all(...ids).map(row => row.id)
}

/**
 * @summary Embeds the `MESSAGE` nodes the collection lacks, in send order.
 * @param {Object}   options
 * @param {Object}   options.db                 Open better-sqlite3 handle (read-only is enough).
 * @param {Object}   options.collection         The message collection: `get`, `upsert`, `delete`.
 * @param {Boolean}  [options.apply=false]      Write; otherwise count and project only.
 * @param {Number}   [options.embedBatchSize=32] Messages per embedding request.
 * @param {Function} [options.log]              `(level, message)` sink.
 * @returns {Promise<Object>} The receipt.
 */
export async function backfillMessageEmbeddings({db, collection, apply = false, embedBatchSize = 32, log = () => {}}) {
    const ids     = db.prepare(`SELECT id FROM Nodes WHERE id LIKE 'MESSAGE:%'
                        ORDER BY json_extract(data, '$.properties.sentAt'), id`).all().map(row => row.id),
          receipt = {mode: apply ? 'apply' : 'dry-run', messages: ids.length, embedded: 0, pending: 0,
                     skipped: {present: 0, retracted: 0, incomplete: 0}, failed: 0};

    for (let start = 0; start < ids.length; start += SQLITE_IN_CLAUSE_BATCH_SIZE) {
        const page    = readMessagePage(db, ids.slice(start, start + SQLITE_IN_CLAUSE_BATCH_SIZE)),
              live    = page.filter(({node}) => !node.properties.retracted),
              present = new Set(live.length > 0 ? (await collection.get({ids: live.map(({node}) => node.id), include: []})).ids : []),
              records = [];

        receipt.skipped.retracted += page.length - live.length;
        receipt.skipped.present   += present.size;

        for (const {node, edges} of live) {
            if (present.has(node.id)) continue;

            const record = toGraphMessageEmbedRecord(node, edges);

            if (record) records.push(record);
            else receipt.skipped.incomplete++
        }

        receipt.pending += records.length;

        for (let i = 0; apply && i < records.length; i += embedBatchSize) {
            const batch    = records.slice(i, i + embedBatchSize),
                  batchIds = batch.map(record => record.id);

            try {
                await collection.upsert({ids: batchIds, documents: batch.map(record => record.document), metadatas: batch.map(record => record.metadata)});
                receipt.embedded += batch.length;
            } catch (error) {
                receipt.failed += batch.length;
                log('ERROR', `embedding ${batch.length} messages failed: ${error.message || error}`);
                continue
            }

            const retracted = readRetracted(db, batchIds);

            if (retracted.length > 0) {
                await collection.delete({ids: retracted});
                receipt.embedded         -= retracted.length;
                receipt.skipped.retracted += retracted.length;
            }
        }
    }

    if (!apply) {
        const [vector] = (await collection.get({limit: 1, include: ['embeddings']})).embeddings ?? [];

        receipt.projectedBytes = vector ? receipt.pending * vector.length * 4 : null;
    }

    return receipt
}

/**
 * @summary Resolves the plane's message collection with the embedder the drain uses.
 * @returns {Promise<Object>}
 */
async function openMessageCollection() {
    // The Neo namespace must exist before a service class loads; the drain host bootstraps the same way.
    await import('neo.mjs/src/Neo.mjs');
    await import('neo.mjs/src/core/_export.mjs');
    await import('neo.mjs/src/manager/Instance.mjs');

    const {default: StorageRouter} = await import('../../services/memory-core/managers/StorageRouter.mjs');

    await StorageRouter.ready();

    return StorageRouter.getMessageCollection()
}

/**
 * @summary Builds the CLI: `--db-path` is mandatory, `--apply` writes.
 * @returns {Command}
 */
export function createCommand() {
    return new Command('backfillMessageEmbeddings')
        .description('Embed the graph\'s MESSAGE nodes the A2A message index lacks. Dry-run unless --apply.')
        .requiredOption('--db-path <path>', 'serving graph SQLite file (explicit, must exist; opened read-only)')
        .option('--apply', 'embed instead of counting', false)
        .option('--embed-batch-size <n>', 'messages per embedding request', value => Number.parseInt(value, 10), 32);
}

/**
 * @summary Parses `argv`, runs the backfill and prints the receipt.
 * @param {String[]} [argv=process.argv]
 * @returns {Promise<Object>}
 */
export async function runCli(argv = process.argv) {
    const options = createCommand().parse(argv).opts(),
          db      = new Database(path.resolve(options.dbPath), {fileMustExist: true, readonly: true, timeout: 10000});

    try {
        const receipt = await backfillMessageEmbeddings({
            db,
            collection    : await openMessageCollection(),
            apply         : options.apply,
            embedBatchSize: options.embedBatchSize,
            log           : (level, message) => console.error(`[backfillMessageEmbeddings] ${level} ${message}`)
        });

        console.log(JSON.stringify(receipt, null, 2));

        return receipt
    } finally {
        db.close()
    }
}

if (isEntryModule(import.meta.url)) {
    runCli().then(
        receipt => process.exit(receipt.failed > 0 ? 1 : 0),
        error   => {
            console.error(`[backfillMessageEmbeddings] ${error.message}`);
            process.exit(2)
        }
    );
}

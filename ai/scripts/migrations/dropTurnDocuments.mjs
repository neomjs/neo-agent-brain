#!/usr/bin/env node
/**
 * @summary Drops the stored document from existing turn rows in Memory Core's memory collection and keeps each
 * row's vector. Turns written before turns stopped storing a document hold their text twice: as the split metadata
 * fields, and as the Chroma document that also feeds Chroma's full-text index. A row qualifies only where
 * `composeTurnDocumentText` reproduces its stored document byte for byte. Every other row stays as it is, and
 * `resolveTurnDocumentForRead` rebuilds a cleared turn on read.
 *
 * The mechanism, measured against delete + add on a scratch store: `update` with an empty document and the row's
 * own vector. An `update` without embeddings re-embeds every row, and delete + add loses the batch when a crash
 * falls between the two. A request killed after it commits still fails on the client, so a failed batch is read
 * back before the run decides anything.
 *
 * Dry-run by default. `--apply` appends each batch's prior documents to the snapshot file and flushes it to disk
 * before the update, so every mutation has its undo on disk first; `--restore` writes a snapshot back. Rows already
 * empty are skipped, so a rerun resumes where a stopped run ended. The bytes return only with a VACUUM, which is the
 * operator's separate step.
 *
 * Module scope stays free of Neo: `main()` boots it and imports `ChromaManager`, which connects on init, so a
 * spec imports the functions below without reaching a live store.
 *
 * Usage:
 *   node ai/scripts/migrations/dropTurnDocuments.mjs                            # dry-run: counts, writes nothing
 *   node ai/scripts/migrations/dropTurnDocuments.mjs --apply --snapshot <file>  # snapshot each batch, then clear it
 *   node ai/scripts/migrations/dropTurnDocuments.mjs --restore <file>           # write a snapshot's documents back
 *   [--batch <n>]                                                               # rows per request, default 250
 */
import fs                                               from 'node:fs';
import readline                                         from 'node:readline';
import {composeTurnDocumentText, isReconstructableTurn} from '../../services/memory-core/helpers/turnDocumentText.mjs';
import {isEntryModule}                                  from '../../services/shared/isEntryModule.mjs';

const
    BATCH_SIZE = 250,
    USAGE      = 'node ai/scripts/migrations/dropTurnDocuments.mjs [--apply --snapshot <file> | --restore <file>] [--batch <n>]';

/**
 * @summary Parses the command line.
 * @param {String[]} argv The arguments after the script path.
 * @returns {{apply: Boolean, snapshot: String|null, restore: String|null, batch: Number, help: Boolean}}
 * @throws {Error} On an unknown argument, a flag missing its value, `--apply` without `--snapshot`, or
 *     `--apply` together with `--restore`.
 */
export function parseArgs(argv) {
    const
        options = {apply: false, snapshot: null, restore: null, batch: BATCH_SIZE, help: false},
        value   = i => {
            if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} needs a value; usage: ${USAGE}`);
            return argv[i + 1]
        };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === '--apply') options.apply = true;
        else if (arg === '--snapshot') options.snapshot = value(i++);
        else if (arg === '--restore') options.restore = value(i++);
        else if (arg === '--batch') options.batch = Number(value(i++));
        else if (arg === '--help' || arg === '-h') options.help = true;
        else throw new Error(`unknown argument ${arg}; usage: ${USAGE}`)
    }

    if (options.apply && options.restore) throw new Error('--apply and --restore exclude each other');
    if (options.apply && !options.snapshot) throw new Error('--apply needs --snapshot <file>: each batch\'s prior documents are written there first');
    if (!Number.isInteger(options.batch) || options.batch < 1) throw new Error('--batch needs a positive integer');

    return options
}

/**
 * @summary Classifies one memory row for the drop.
 * @param {Object} row
 * @param {String|null} row.document The stored document.
 * @param {Object|null} row.metadata
 * @returns {'drop'|'mismatch'|'empty'|'other'} `drop` when the turn's split fields rebuild its stored document
 *     byte for byte; `mismatch` for a turn whose stored document differs from that, which stays as it is; `empty`
 *     for a turn already stored without a document; `other` for every row that is not a turn.
 */
export function classifyTurnRow({document, metadata}) {
    if (metadata?.type !== 'agent-interaction') return 'other';
    if (!document) return 'empty';

    return isReconstructableTurn(metadata) &&
        document === composeTurnDocumentText({prompt: metadata.prompt, thought: metadata.thought, response: metadata.response}) ?
        'drop' : 'mismatch'
}

/**
 * @summary Every id in the collection, read page by page without documents, metadata or vectors.
 * @param {Object} collection
 * @param {Number} pageSize
 * @returns {Promise<String[]>}
 */
async function listIds(collection, pageSize) {
    const ids = [];

    for (let offset = 0; ; offset += pageSize) {
        const page = await collection.get({include: [], limit: pageSize, offset});

        ids.push(...page.ids);
        if (page.ids.length < pageSize) return ids
    }
}

/**
 * @summary Snapshots one batch's documents, then clears them with each row's own vector.
 * @param {Object} options
 * @param {Object} options.collection
 * @param {Object[]} options.rows `{id, document}` of the qualifying rows.
 * @param {String} options.snapshotPath
 * @returns {Promise<Number>} How many rows were cleared.
 * @throws {Error} When the update failed and a row still holds its document.
 */
async function clearBatch({collection, rows, snapshotPath}) {
    const
        stored   = await collection.get({ids: rows.map(row => row.id), include: ['embeddings']}),
        vectorOf = new Map(stored.ids.map((id, i) => [id, stored.embeddings[i]])),
        present  = rows.filter(row => vectorOf.has(row.id)),
        ids      = present.map(row => row.id),
        fd       = fs.openSync(snapshotPath, 'a');

    try {
        fs.writeSync(fd, present.map(row => JSON.stringify(row)).join('\n') + '\n');
        fs.fsyncSync(fd)
    } finally {
        fs.closeSync(fd)
    }

    try {
        await collection.update({ids, documents: ids.map(() => ''), embeddings: ids.map(id => vectorOf.get(id))})
    } catch (error) {
        const after = await collection.get({ids, include: ['documents']}),
              left  = after.documents.filter(Boolean).length;

        if (left) throw new Error(`the update failed and ${left} of ${ids.length} rows still hold their document; rerun to resume (${error.message})`)
    }

    return ids.length
}

/**
 * @summary Clears the stored document of every qualifying turn row, snapshotting each batch first.
 * @param {Object} options
 * @param {Object} options.collection A chromadb collection.
 * @param {Boolean} [options.apply=false] Without it, the run only counts.
 * @param {String} [options.snapshotPath] Required with `apply`: the JSONL file each batch's `{id, document}` rows are
 *     appended to before that batch is cleared.
 * @param {Number} [options.batchSize=250]
 * @param {Function} [options.log] Called with a progress line after each cleared batch.
 * @returns {Promise<{rows: Number, drop: Number, mismatch: Number, empty: Number, other: Number, cleared: Number,
 *     documentBytes: Number}>} `drop` counts the qualifying rows found, `cleared` those this run emptied, and
 *     `documentBytes` the UTF-8 bytes of the qualifying documents.
 */
export async function dropTurnDocuments({collection, apply = false, snapshotPath, batchSize = BATCH_SIZE, log = () => {}}) {
    if (apply && !snapshotPath) throw new Error('apply needs a snapshotPath: each batch\'s prior documents are written there first');

    const
        ids   = await listIds(collection, batchSize * 4),
        stats = {rows: ids.length, drop: 0, mismatch: 0, empty: 0, other: 0, cleared: 0, documentBytes: 0};

    for (let i = 0; i < ids.length; i += batchSize) {
        const
            batch = await collection.get({ids: ids.slice(i, i + batchSize), include: ['documents', 'metadatas']}),
            drop  = [];

        batch.ids.forEach((id, k) => {
            const kind = classifyTurnRow({document: batch.documents[k], metadata: batch.metadatas[k]});

            stats[kind]++;

            if (kind === 'drop') {
                drop.push({id, document: batch.documents[k]});
                stats.documentBytes += Buffer.byteLength(batch.documents[k])
            }
        });

        if (apply && drop.length) {
            stats.cleared += await clearBatch({collection, rows: drop, snapshotPath});
            log(`cleared ${stats.cleared} rows (${i + batch.ids.length} of ${ids.length} scanned)`)
        }
    }

    return stats
}

/**
 * @summary Writes a snapshot's documents back onto their rows, with each row's current vector.
 * @param {Object} options
 * @param {Object} options.collection
 * @param {String} options.snapshotPath A file `dropTurnDocuments` appended to. A rerun after a failed batch may have
 *     appended a row twice, with the same document both times.
 * @param {Number} [options.batchSize=250]
 * @returns {Promise<{snapshotted: Number, restored: Number, missing: Number}>} `missing` counts snapshot lines whose
 *     row no longer exists.
 */
export async function restoreTurnDocuments({collection, snapshotPath, batchSize = BATCH_SIZE}) {
    const
        stats = {snapshotted: 0, restored: 0, missing: 0},
        lines = readline.createInterface({input: fs.createReadStream(snapshotPath), crlfDelay: Infinity});

    let batch = [];

    const flush = async () => {
        const
            stored     = await collection.get({ids: batch.map(row => row.id), include: ['embeddings']}),
            documentOf = new Map(batch.map(row => [row.id, row.document]));

        stats.missing += documentOf.size - stored.ids.length;

        if (stored.ids.length) {
            await collection.update({ids: stored.ids, documents: stored.ids.map(id => documentOf.get(id)), embeddings: stored.embeddings});
            stats.restored += stored.ids.length
        }

        batch = []
    };

    for await (const line of lines) {
        if (!line) continue;

        batch.push(JSON.parse(line));
        stats.snapshotted++;

        if (batch.length === batchSize) await flush()
    }

    if (batch.length) await flush();

    return stats
}

/**
 * @summary Boots Neo, opens Memory Core's memory collection through `ChromaManager`, and runs the requested mode.
 * @returns {Promise<void>}
 */
async function main() {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
        console.log(USAGE);
        return
    }

    await import('neo.mjs/src/Neo.mjs');
    await import('neo.mjs/src/core/_export.mjs');

    const
        {default: ChromaManager} = await import('../../services/memory-core/managers/ChromaManager.mjs'),
        collection               = await ChromaManager.ready().then(() => ChromaManager.getMemoryCollection()),
        result                   = options.restore ?
            await restoreTurnDocuments({collection, snapshotPath: options.restore, batchSize: options.batch}) :
            await dropTurnDocuments({collection, apply: options.apply, snapshotPath: options.snapshot, batchSize: options.batch, log: console.log});

    console.log(JSON.stringify({collection: collection.name, mode: options.restore ? 'restore' : options.apply ? 'apply' : 'dry-run', ...result}, null, 2));

    if (!options.restore && !options.apply) console.log('\nDRY-RUN: nothing was written. --apply --snapshot <file> clears the rows counted as drop.')
}

if (isEntryModule(import.meta.url)) {
    main().then(() => process.exit(0), error => {
        console.error(error.message);
        process.exit(1)
    })
}

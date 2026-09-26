import {Command}       from 'commander';
import Database        from 'better-sqlite3';
import fs              from 'node:fs';
import path            from 'node:path';
import readline        from 'node:readline';
import {pathToFileURL} from 'node:url';

/**
 * @module ai/scripts/maintenance/restoreReceipts
 * @summary Returns mailbox read receipts, and edges of named types, from a backup bundle's graph
 * JSONL to a live graph, filling only what the live graph lacks.
 *
 * `restore.mjs --mode merge` inserts rows by id and refuses logical duplicates, and a re-derived
 * delivery edge carries a new id for the same `(source, target, type)`, so a merge cannot return a
 * receipt to it; `--mode replace` rebuilds the graph from the bundle and discards everything written
 * since. This is the narrow third shape. For every `DELIVERED_TO` edge and `MESSAGE` node in the bundle
 * that carries `readAt` or `archivedAt`, the live row with the same identity receives the field where
 * it is null; a non-null live value is never touched. Edges of the types named on the command line are
 * inserted where no live row shares their `(source, target, type)` and both endpoints exist. The three
 * mailbox carriers are never inserted: the projection owns them.
 *
 * Dry-run by default: the database is opened read-only, so nothing can be written without `--apply`.
 * The database path is explicit and mandatory; nothing is inferred from the checkout or the cwd.
 */

export const MAILBOX_EDGE_TYPES = Object.freeze(['DELIVERED_TO', 'SENT_TO', 'SENT_BY']);
export const RECEIPT_FIELDS     = Object.freeze(['readAt', 'archivedAt']);

const WRITE_BATCH_SIZE = 1000;

/**
 * @summary Resolves the graph JSONL of a bundle directory, or accepts the file itself.
 * @param {String} source A bundle root holding `graph/<one>.jsonl`, or a `.jsonl` path.
 * @returns {String} Absolute JSONL path.
 * @throws {Error} When the path is absent, or the bundle holds not exactly one graph JSONL.
 */
export function resolveGraphJsonl(source) {
    if (typeof source !== 'string' || !source.trim()) {
        throw new Error('source must be an explicit bundle directory or graph JSONL path.');
    }

    const resolved = path.resolve(source);

    if (!fs.existsSync(resolved)) {
        throw new Error(`source does not exist: ${resolved}`);
    }

    if (fs.statSync(resolved).isFile()) {
        return resolved;
    }

    const graphDir = path.join(resolved, 'graph'),
          files    = fs.existsSync(graphDir) ? fs.readdirSync(graphDir).filter(name => name.endsWith('.jsonl')) : [];

    if (files.length !== 1) {
        throw new Error(`bundle must hold exactly one graph/*.jsonl, found ${files.length}: ${graphDir}`);
    }

    return path.join(graphDir, files[0]);
}

/**
 * @summary Streams the bundle's graph records, one parsed JSON object per non-empty line.
 * @param {String} file Graph JSONL path.
 * @yields {{type: String, data: Object}}
 */
export async function* readGraphRecords(file) {
    const lines = readline.createInterface({input: fs.createReadStream(file, {encoding: 'utf8'}), crlfDelay: Infinity});

    for await (const line of lines) {
        if (line.trim()) {
            yield JSON.parse(line);
        }
    }
}

/**
 * @summary Fills null receipt fields and inserts absent edges from the bundle into an open live graph.
 *
 * Receipts are matched by identity, never by row id: a delivery edge by `(source, target, 'DELIVERED_TO')`,
 * a direct-message receipt by the `MESSAGE` node id. Every non-mailbox edge type is counted against the
 * live graph so the dry run reports which types the graph lost; only the `edgeTypes` named are inserted.
 * @param {Object}   options
 * @param {Object}   options.db                Open better-sqlite3 handle; read-only unless `apply`.
 * @param {String}   options.jsonl             Graph JSONL path.
 * @param {Boolean}  [options.apply=false]     Write; otherwise count only.
 * @param {String[]} [options.edgeTypes=[]]    Non-mailbox edge types to insert where absent.
 * @returns {Promise<Object>} `{receipts: {edges, nodes}, edges: {requested, types}}` with per-ledger counts.
 */
export async function restoreReceipts({db, jsonl, apply = false, edgeTypes = []}) {
    const requested = edgeTypes.filter(type => !MAILBOX_EDGE_TYPES.includes(type));

    const
        findDeliveries = db.prepare(`
            SELECT id,
                   json_extract(data, '$.properties.readAt')     AS readAt,
                   json_extract(data, '$.properties.archivedAt') AS archivedAt
            FROM Edges
            WHERE source = ? AND target = ? AND type = 'DELIVERED_TO'`),
        findMessage    = db.prepare(`
            SELECT json_extract(data, '$.properties.readAt')     AS readAt,
                   json_extract(data, '$.properties.archivedAt') AS archivedAt
            FROM Nodes
            WHERE id = ? AND json_extract(data, '$.label') = 'MESSAGE'`),
        nodeExists     = db.prepare('SELECT 1 FROM Nodes WHERE id = ?').pluck(),
        edgeExists     = db.prepare('SELECT 1 FROM Edges WHERE source = ? AND target = ? AND type = ? LIMIT 1').pluck(),
        edgeIdTaken    = db.prepare('SELECT 1 FROM Edges WHERE id = ?').pluck(),
        liveTypeCounts = new Map(db.prepare('SELECT type, COUNT(*) AS n FROM Edges GROUP BY type').all().map(row => [row.type, row.n])),
        setEdgeField   = Object.fromEntries(RECEIPT_FIELDS.map(field => [field, apply && db.prepare(
            `UPDATE Edges SET data = json_set(data, '$.properties.${field}', ?) WHERE id = ? AND json_extract(data, '$.properties.${field}') IS NULL`)])),
        setNodeField   = Object.fromEntries(RECEIPT_FIELDS.map(field => [field, apply && db.prepare(
            `UPDATE Nodes SET data = json_set(data, '$.properties.${field}', ?) WHERE id = ? AND json_extract(data, '$.properties.${field}') IS NULL`)])),
        insertEdge     = apply && db.prepare('INSERT INTO Edges (id, user_id, source, target, type, data) VALUES (?, ?, ?, ?, ?, ?)');

    const
        ledger  = () => ({matched: 0, filled: 0, alreadySet: 0, missingLive: 0}),
        result  = {receipts: {edges: ledger(), nodes: ledger()}, edges: {requested, types: {}}},
        typeRow = type => result.edges.types[type] ??= {bundle: 0, live: liveTypeCounts.get(type) || 0, absentLive: 0, restorable: 0, missingEndpoint: 0, inserted: 0};

    let pending = [];

    const flush = db.transaction(ops => { ops.forEach(op => op()); });
    const queue = op => {
        pending.push(op);
        if (pending.length >= WRITE_BATCH_SIZE) {
            flush(pending);
            pending = [];
        }
    };

    const fillFields = (book, liveRow, bundleProps, write) => {
        RECEIPT_FIELDS.forEach(field => {
            const value = bundleProps[field];
            if (value == null) return;
            if (liveRow[field] != null) {
                book.alreadySet++;
            } else {
                book.filled++;
                apply && queue(() => write(field, value));
            }
        });
    };

    for await (const record of readGraphRecords(jsonl)) {
        const {type: kind, data} = record;

        if (kind === 'node') {
            const props = data?.properties || {};
            if (data?.label !== 'MESSAGE' || RECEIPT_FIELDS.every(field => props[field] == null)) continue;

            const live = findMessage.get(data.id);
            if (!live) { result.receipts.nodes.missingLive++; continue; }

            result.receipts.nodes.matched++;
            fillFields(result.receipts.nodes, live, props, (field, value) => setNodeField[field].run(value, data.id));
            continue;
        }

        if (kind !== 'edge' || !data?.type) continue;

        const {id, source, target, type, properties = {}} = data;

        if (type === 'DELIVERED_TO') {
            if (RECEIPT_FIELDS.every(field => properties[field] == null)) continue;

            const rows = findDeliveries.all(source, target);
            if (rows.length === 0) { result.receipts.edges.missingLive++; continue; }

            result.receipts.edges.matched++;
            rows.forEach(row => fillFields(result.receipts.edges, row, properties, (field, value) => setEdgeField[field].run(value, row.id)));
            continue;
        }

        if (MAILBOX_EDGE_TYPES.includes(type)) continue;

        const row = typeRow(type);
        row.bundle++;

        if (edgeExists.get(source, target, type)) continue;

        row.absentLive++;

        if (!nodeExists.get(source) || !nodeExists.get(target)) { row.missingEndpoint++; continue; }

        row.restorable++;

        if (apply && requested.includes(type)) {
            row.inserted++;
            queue(() => {
                const edgeId = edgeIdTaken.get(id) ? globalThis.crypto.randomUUID() : id;
                insertEdge.run(edgeId, properties.userId ?? null, source, target, type, JSON.stringify({id: edgeId, source, target, type, properties}));
            });
        }
    }

    if (pending.length > 0) {
        flush(pending);
    }

    return result;
}

/**
 * @summary Opens the named graph (read-only unless `apply`), restores from the bundle, and logs the counts.
 * @param {Object}   options
 * @param {String}   options.dbPath         Explicit live graph SQLite path; must exist.
 * @param {String}   options.source         Bundle root or graph JSONL path.
 * @param {Boolean}  [options.apply=false]
 * @param {String[]} [options.edgeTypes=[]]
 * @param {Object}   [options.logger=console]
 * @returns {Promise<Object>} The `restoreReceipts` result.
 */
export async function runRestoreReceipts({dbPath, source, apply = false, edgeTypes = [], logger = console}) {
    if (typeof dbPath !== 'string' || !dbPath.trim()) {
        throw new Error('dbPath must be an explicit non-empty path.');
    }

    const jsonl = resolveGraphJsonl(source),
          db    = new Database(path.resolve(dbPath), {fileMustExist: true, readonly: !apply, timeout: 10000});

    try {
        const result = await restoreReceipts({db, jsonl, apply, edgeTypes});

        logResult(result, {apply, logger});
        return result;
    } finally {
        db.close();
    }
}

/**
 * @summary Prints the receipt ledgers and the per-type edge table, largest live gap first.
 * @param {Object} result
 * @param {Object} options
 * @param {Boolean} [options.apply=false]
 * @param {Object}  [options.logger=console]
 */
export function logResult(result, {apply = false, logger = console} = {}) {
    const mode = apply ? 'APPLIED' : 'DRY RUN';

    logger.log(`[restoreReceipts] ${mode} — delivery receipts: ${JSON.stringify(result.receipts.edges)}; message receipts: ${JSON.stringify(result.receipts.nodes)}`);
    logger.log(`[restoreReceipts] edge types requested for insert: ${result.edges.requested.length ? result.edges.requested.join(', ') : 'none'}`);

    Object.entries(result.edges.types)
        .sort(([, a], [, b]) => b.absentLive - a.absentLive)
        .forEach(([type, row]) => logger.log(`[restoreReceipts]   ${type}: ${JSON.stringify(row)}`));
}

/**
 * @summary Builds the CLI: `--db-path` and `--source` are mandatory, `--apply` writes, `--edge-types` names inserts.
 * @returns {Command}
 */
export function createCommand() {
    return new Command('restoreReceipts')
        .description('Fill mailbox read receipts, and insert edges of named types, from a backup bundle into a live graph. Dry-run unless --apply.')
        .requiredOption('--db-path <path>', 'live graph SQLite file (explicit, must exist)')
        .requiredOption('--source <path>', 'backup bundle root or its graph JSONL')
        .option('--apply', 'write instead of counting', false)
        .option('--edge-types <types>', 'comma-separated non-mailbox edge types to insert where absent', value => value.split(',').map(s => s.trim()).filter(Boolean), []);
}

/**
 * @summary Parses `argv` and runs the restore.
 * @param {String[]} [argv=process.argv]
 * @returns {Promise<Object>}
 */
export async function runCli(argv = process.argv) {
    const options = createCommand().parse(argv).opts();

    return runRestoreReceipts({dbPath: options.dbPath, source: options.source, apply: options.apply, edgeTypes: options.edgeTypes});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch(error => {
        console.error(`[restoreReceipts] ${error.message}`);
        process.exit(1);
    });
}

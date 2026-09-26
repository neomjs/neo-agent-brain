import {Command}       from 'commander';
import Database        from 'better-sqlite3';
import path            from 'node:path';
import {pathToFileURL} from 'node:url';

/**
 * @module ai/scripts/maintenance/rebuildMessageEdges
 * @summary Rebuilds the reply, thread, ticket and tag edges of every `MESSAGE` node from the node's
 * own fields, where the live graph lacks them.
 *
 * `MailboxService` writes these edges once, at projection, from the same fields the node keeps
 * (`inReplyTo`, `partOfThread`, `relatedTickets`, `taggedConcepts`); `repairMessageGraphIntegrity`
 * repairs the three carriers only, so an edge a collector severed or a decay pruned never comes back
 * on its own. This walks the nodes and links what is missing, the way the projection does: a tag's
 * concept node is created when absent, any other target must exist, the edge carries weight 1, the
 * message's `sentAt` as `timestamp`, its `userId` and `sharedEntity`. A present edge is left alone,
 * weight included. The session edges (`ORIGINATES_IN`, `RELATED_SESSION`) live on the WAL record,
 * not the node, and are not rebuilt here.
 *
 * Identity is decided inside the insert (`INSERT … WHERE NOT EXISTS`), and the counts are the rows it
 * changed. `--types` names the edge types to link (all four by default): the tag edges are tens of
 * thousands and feed concept scoring, so they can be applied on their own decision. Dry-run by default
 * with the database opened read-only; `--db-path` is explicit and mandatory.
 */

/**
 * The node fields and the edge type each one becomes. A string field links one target, an array
 * field links each entry.
 * @type {Object[]}
 */
export const MESSAGE_EDGE_FIELDS = Object.freeze([
    Object.freeze({field: 'inReplyTo',      type: 'IN_REPLY_TO'}),
    Object.freeze({field: 'partOfThread',   type: 'PART_OF_THREAD'}),
    Object.freeze({field: 'relatedTickets', type: 'REFERENCES_TICKET'}),
    Object.freeze({field: 'taggedConcepts', type: 'TAGGED_CONCEPT'})
]);

const WRITE_BATCH_SIZE = 1000;

/**
 * @summary The targets one node field names: a string is one target, an array its string entries.
 * @param {*} value The field's value.
 * @returns {String[]}
 */
export function targetsOf(value) {
    const values = Array.isArray(value) ? value : [value];

    return values.filter(entry => typeof entry === 'string' && entry.length > 0);
}

/**
 * @summary Links the missing message edges in an open live graph.
 * @param {Object}   options
 * @param {Object}   options.db            Open better-sqlite3 handle; read-only unless `apply`.
 * @param {Boolean}  [options.apply=false] Write; otherwise count only.
 * @param {String[]} [options.types]       Edge types to link; every other field is skipped. Default: all four.
 * @returns {{messages: Number, types: Object}} Per type: `{fields, linked, present, missingTarget, conceptsCreated}`.
 */
export function rebuildMessageEdges({db, apply = false, types = MESSAGE_EDGE_FIELDS.map(entry => entry.type)}) {
    const
        fields     = MESSAGE_EDGE_FIELDS.filter(entry => types.includes(entry.type)),
        messages   = db.prepare("SELECT id, data FROM Nodes WHERE id LIKE 'MESSAGE:%'").iterate(),
        nodeExists = db.prepare('SELECT 1 FROM Nodes WHERE id = ?').pluck(),
        edgeExists = db.prepare('SELECT 1 FROM Edges WHERE source = ? AND target = ? AND type = ? LIMIT 1').pluck(),
        insertEdge = apply && db.prepare(`
            INSERT INTO Edges (id, user_id, source, target, type, data)
            SELECT ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM Edges WHERE source = ? AND target = ? AND type = ?)`),
        insertNode = apply && db.prepare('INSERT OR IGNORE INTO Nodes (id, user_id, data) VALUES (?, NULL, ?)'),
        result     = {messages: 0, types: {}},
        row        = type => result.types[type] ??= {fields: 0, linked: 0, present: 0, missingTarget: 0, conceptsCreated: 0},
        seenConcepts = new Set();

    let pending = [];

    const flush = db.transaction(ops => { ops.forEach(op => op()); });
    const queue = op => {
        pending.push(op);
        if (pending.length >= WRITE_BATCH_SIZE) {
            flush(pending);
            pending = [];
        }
    };

    for (const {id: messageId, data} of messages) {
        const props = JSON.parse(data)?.properties || {};

        result.messages++;

        for (const {field, type} of fields) {
            const targets = targetsOf(props[field]);

            if (targets.length === 0) continue;

            const counts = row(type);

            counts.fields++;

            for (const target of targets) {
                if (edgeExists.get(messageId, target, type)) { counts.present++; continue; }

                if (!nodeExists.get(target) && !seenConcepts.has(target)) {
                    if (type !== 'TAGGED_CONCEPT') { counts.missingTarget++; continue; }

                    // the projection creates a tag's concept node before linking it (MailboxService.ensureTaggedConceptNode)
                    seenConcepts.add(target);
                    counts.conceptsCreated++;
                    apply && queue(() => insertNode.run(target, JSON.stringify({id: target, label: 'CONCEPT', properties: {name: target, description: '', canonicalConceptId: target, userId: null}})));
                }

                counts.linked++;

                if (apply) {
                    const
                        edgeId     = globalThis.crypto.randomUUID(),
                        properties = {weight: 1, timestamp: props.sentAt ?? null, userId: props.userId ?? null, sharedEntity: true};

                    queue(() => {
                        const changes = insertEdge.run(edgeId, properties.userId, messageId, target, type, JSON.stringify({id: edgeId, source: messageId, target, type, properties}), messageId, target, type).changes;

                        if (changes === 0) counts.linked--;
                    });
                }
            }
        }
    }

    if (pending.length > 0) {
        flush(pending);
    }

    return result;
}

/**
 * @summary Opens the named graph (read-only unless `apply`), rebuilds, and logs the counts per type.
 * @param {Object}  options
 * @param {String}  options.dbPath Explicit live graph SQLite path; must exist.
 * @param {Boolean} [options.apply=false]
 * @param {String[]} [options.types] Forwarded to {@link rebuildMessageEdges}.
 * @param {Object}  [options.logger=console]
 * @returns {Object} The `rebuildMessageEdges` result.
 */
export function runRebuildMessageEdges({dbPath, apply = false, types, logger = console}) {
    if (typeof dbPath !== 'string' || !dbPath.trim()) {
        throw new Error('dbPath must be an explicit non-empty path.');
    }

    const db = new Database(path.resolve(dbPath), {fileMustExist: true, readonly: !apply, timeout: 10000});

    try {
        const result = rebuildMessageEdges({db, apply, ...(types ? {types} : {})});

        logger.log(`[rebuildMessageEdges] ${apply ? 'APPLIED' : 'DRY RUN'} — ${result.messages} messages`);
        Object.entries(result.types).forEach(([type, counts]) => logger.log(`[rebuildMessageEdges]   ${type}: ${JSON.stringify(counts)}`));

        return result;
    } finally {
        db.close();
    }
}

/**
 * @summary Builds the CLI: `--db-path` is mandatory, `--apply` writes.
 * @returns {Command}
 */
export function createCommand() {
    return new Command('rebuildMessageEdges')
        .description("Link the reply, thread, ticket and tag edges a MESSAGE node's fields name where the live graph lacks them. Dry-run unless --apply.")
        .requiredOption('--db-path <path>', 'live graph SQLite file (explicit, must exist)')
        .option('--apply', 'write instead of counting', false)
        .option('--types <types>', 'comma-separated edge types to link (default: all four)', value => value.split(',').map(s => s.trim()).filter(Boolean));
}

/**
 * @summary Parses `argv` and runs the rebuild.
 * @param {String[]} [argv=process.argv]
 * @returns {Object}
 */
export function runCli(argv = process.argv) {
    const options = createCommand().parse(argv).opts();

    return runRebuildMessageEdges({dbPath: options.dbPath, apply: options.apply, types: options.types});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        runCli();
    } catch (error) {
        console.error(`[rebuildMessageEdges] ${error.message}`);
        process.exit(1);
    }
}

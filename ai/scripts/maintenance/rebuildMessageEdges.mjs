import {resolveTicketReference}                 from '../../services/graph/ticketReferences.mjs';
import {Command}                                from 'commander';
import Database                                 from 'better-sqlite3';
import path                                     from 'node:path';
import {isEntryModule}                          from '../../services/shared/isEntryModule.mjs';
import {normalizeMailboxIdentityForComparison} from '../../services/memory-core/helpers/mailboxReadStateClassifier.mjs';

/**
 * @module ai/scripts/maintenance/rebuildMessageEdges
 * @summary Rebuilds the routing, reply, thread, ticket and tag edges of every `MESSAGE` node from the
 * node's own fields, where the live graph lacks them.
 *
 * `MailboxService` writes these edges once, at projection, from the same fields the node keeps
 * (`from`, `to`, `inReplyTo`, `partOfThread`, `relatedTickets`, `taggedConcepts`), so an edge a
 * collector severed or a decay pruned never comes back on its own. This walks the nodes and links what
 * is missing, the way the projection does: a tag's concept node is created when absent, any other
 * target must exist, the edge carries weight 1, the message's `sentAt` as `timestamp`, its `userId` and
 * `sharedEntity`. A present edge is left alone, weight included. The session edges (`ORIGINATES_IN`,
 * `RELATED_SESSION`) live on the WAL record, not the node, and are not rebuilt here.
 *
 * The routing carriers are `repairMessageGraphIntegrity`'s, but it rebuilds them from the message WAL,
 * which keeps only its retention window: a message older than the WAL has no route, and `getMessage`
 * refuses even its sender. So `from` and `to` link `SENT_BY` and `SENT_TO` here, normalized as the
 * projection normalizes them. A route decides who may read the message, so it is linked only from a
 * node labelled `MESSAGE`, from a single string, to a node of the kind the projection routes to, and
 * only while the message holds no route of that type, which the insert itself checks, so a route
 * another writer adds meanwhile stays the only one. Anything else counts as `invalid`. A broadcast
 * route carries `broadcastCohort: 'legacy-unknown'`, the projection's stamp for a broadcast without a
 * recipient snapshot. That snapshot is not on the node, so `DELIVERED_TO` is not rebuilt.
 *
 * Identity is decided inside the insert (`INSERT … WHERE NOT EXISTS`), and the counts are the rows it
 * changed. `--types` names the edge types to link (all six by default): the tag edges are tens of
 * thousands and feed concept scoring, so they can be applied on their own decision. The message ids
 * are read up front and each node fetched by id, so no cursor is open on the connection when a batch
 * flushes (better-sqlite3 refuses a write while a statement iterates). Dry-run by default with the
 * database opened read-only; `--db-path` is explicit and mandatory.
 */

/**
 * The node fields and the edge type each one becomes. A string field links one target, an array
 * field links each entry. A `carrier` lists the target labels its route may name, the ones the
 * projection writes: senders are identities or the system, destinations identities or the broadcast.
 * @type {Object[]}
 */
export const MESSAGE_EDGE_FIELDS = Object.freeze([
    Object.freeze({field: 'inReplyTo',      type: 'IN_REPLY_TO'}),
    Object.freeze({field: 'partOfThread',   type: 'PART_OF_THREAD'}),
    Object.freeze({field: 'relatedTickets', type: 'REFERENCES_TICKET'}),
    Object.freeze({field: 'taggedConcepts', type: 'TAGGED_CONCEPT'}),
    Object.freeze({field: 'from',           type: 'SENT_BY', carrier: Object.freeze(['AgentIdentity', 'System'])}),
    Object.freeze({field: 'to',             type: 'SENT_TO', carrier: Object.freeze(['AgentIdentity', 'BroadcastSentinel'])})
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
 * @param {String[]} [options.types]       Edge types to link; every other field is skipped. Default: all six.
 * @param {Number}   [options.batchSize=1000] Writes per transaction.
 * @returns {{messages: Number, types: Object}} Per type: `{fields, linked, present, missingTarget, conceptsCreated}`;
 * ticket references also report `unresolved` counts by refusal class, and carriers `invalid`.
 */
export function rebuildMessageEdges({db, apply = false, types = MESSAGE_EDGE_FIELDS.map(entry => entry.type), batchSize = WRITE_BATCH_SIZE}) {
    const
        fields     = MESSAGE_EDGE_FIELDS.filter(entry => types.includes(entry.type)),
        messageIds = db.prepare("SELECT id FROM Nodes WHERE id LIKE 'MESSAGE:%'").pluck().all(),
        readNode   = db.prepare('SELECT data FROM Nodes WHERE id = ?').pluck(),
        nodeExists = db.prepare('SELECT 1 FROM Nodes WHERE id = ?').pluck(),
        edgeExists = db.prepare('SELECT 1 FROM Edges WHERE source = ? AND target = ? AND type = ? LIMIT 1').pluck(),
        typeHeld   = db.prepare('SELECT 1 FROM Edges WHERE source = ? AND type = ? LIMIT 1').pluck(),
        labelOf    = db.prepare("SELECT json_extract(data, '$.label') FROM Nodes WHERE id = ?").pluck(),
        insertEdge = apply && db.prepare(`
            INSERT INTO Edges (id, user_id, source, target, type, data)
            SELECT ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM Edges WHERE source = ? AND target = ? AND type = ?)`),
        insertRoute = apply && db.prepare(`
            INSERT INTO Edges (id, user_id, source, target, type, data)
            SELECT ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM Edges WHERE source = ? AND type = ?)`),
        insertNode = apply && db.prepare('INSERT OR IGNORE INTO Nodes (id, user_id, data) VALUES (?, NULL, ?)'),
        result     = {messages: 0, types: {}},
        row        = (type, carrier) => result.types[type] ??= {fields: 0, linked: 0, present: 0, missingTarget: 0, conceptsCreated: 0, ...(carrier ? {invalid: 0} : {})},
        edgeData   = (id, source, target, type, props, extra) => ({id, source, target, type, properties: {weight: 1, timestamp: props.sentAt ?? null, userId: props.userId ?? null, sharedEntity: true, ...extra}}),
        seenConcepts = new Set();

    let pending = [];

    const flush = db.transaction(ops => { ops.forEach(op => op()); });
    const queue = op => {
        pending.push(op);
        if (pending.length >= batchSize) {
            flush(pending);
            pending = [];
        }
    };

    for (const messageId of messageIds) {
        const data = readNode.get(messageId);

        if (data === undefined) continue;

        const node  = JSON.parse(data) || {},
              props = node.properties || {};

        result.messages++;

        for (const {field, type, carrier} of fields) {
            if (carrier) {
                if (props[field] === undefined || props[field] === null) continue;

                const counts = row(type, true),
                      target = typeof props[field] === 'string' ? normalizeMailboxIdentityForComparison(props[field]) : null;

                counts.fields++;

                if (node.label !== 'MESSAGE' || !target || target === '@me' || target === '@') { counts.invalid++; continue; }
                if (typeHeld.get(messageId, type)) { counts.present++; continue; }

                const label = labelOf.get(target);

                if (label === undefined) { counts.missingTarget++; continue; }
                if (!carrier.includes(label)) { counts.invalid++; continue; }

                counts.linked++;

                if (apply) {
                    const edge = edgeData(globalThis.crypto.randomUUID(), messageId, target, type, props, target === 'AGENT:*' ? {broadcastCohort: 'legacy-unknown'} : {});

                    queue(() => {
                        if (insertRoute.run(edge.id, edge.properties.userId, messageId, target, type, JSON.stringify(edge), messageId, type).changes === 0) {
                            counts.linked--;
                            counts.present++;
                        }
                    });
                }
                continue;
            }

            const targets = targetsOf(props[field]);

            if (targets.length === 0) continue;

            const counts = row(type);

            counts.fields++;

            for (const authoredTarget of targets) {
                let target = authoredTarget, externalRef;

                if (type === 'REFERENCES_TICKET') {
                    counts.unresolved ||= {};
                    const resolved = resolveTicketReference(authoredTarget, id => {
                        const data = readNode.get(id);
                        return data === undefined ? null : JSON.parse(data)
                    }, {onUnresolved: reason => counts.unresolved[reason] = (counts.unresolved[reason] || 0) + 1});
                    if (!resolved) { counts.missingTarget++; continue; }
                    ({targetId: target, externalRef} = resolved);
                }
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
                    const edge = edgeData(globalThis.crypto.randomUUID(), messageId, target, type, props, externalRef ? {externalRef} : {});

                    queue(() => {
                        if (insertEdge.run(edge.id, edge.properties.userId, messageId, target, type, JSON.stringify(edge), messageId, target, type).changes === 0) counts.linked--;
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
        .description("Link the routing, reply, thread, ticket and tag edges a MESSAGE node's fields name where the live graph lacks them. Dry-run unless --apply.")
        .requiredOption('--db-path <path>', 'live graph SQLite file (explicit, must exist)')
        .option('--apply', 'write instead of counting', false)
        .option('--types <types>', 'comma-separated edge types to link (default: all six)', value => value.split(',').map(s => s.trim()).filter(Boolean));
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

if (isEntryModule(import.meta.url)) {
    try {
        runCli();
    } catch (error) {
        console.error(`[rebuildMessageEdges] ${error.message}`);
        process.exit(1);
    }
}

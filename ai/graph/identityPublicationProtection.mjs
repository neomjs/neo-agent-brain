import {isDeepStrictEqual}                              from 'node:util';
import {FAMILY_GRAPH_TYPE_PREFIX, FAMILY_RECORD_PREFIX} from '../services/shared/identityPublicationKeys.mjs';

/** @type {String} Durable publication fence storage, outside the graph record populations. */
export const IDENTITY_PUBLICATION_FENCE_TABLE = 'IdentityPublicationFence';

/** @summary Tests reserved identity-publication record IDs without coercing caller data. */
const reservedId = value => typeof value === 'string' && value.startsWith(FAMILY_RECORD_PREFIX);
/** @summary Tests the typed admission owner's graph vocabulary. */
const reservedType = value => typeof value === 'string' && value.startsWith(FAMILY_GRAPH_TYPE_PREFIX);
/** @summary Reads a graph DTO or the corresponding Neo record field. */
const field = (record, key) => record?.isRecord ? record.get(key) : record?.[key];

/**
 * @summary Identifies a protected node by either namespace or label; JSON permission flags are irrelevant.
 * @param {Object} record Proposed or persisted graph node.
 * @returns {Boolean}
 */
export function isIdentityPublicationNode(record) {
    return reservedId(field(record, 'id')) || reservedType(field(record, 'label')) || reservedType(field(record, 'type'));
}

/**
 * @summary Identifies protected edge vocabulary or references, including a cold endpoint's node label.
 * @param {Object} record Proposed or persisted edge.
 * @param {Function} [readNode=()=>null] Unscoped persisted endpoint reader.
 * @returns {Boolean}
 */
export function isIdentityPublicationEdge(record, readNode = () => null) {
    const source = field(record, 'source'), target = field(record, 'target');
    return reservedId(field(record, 'id')) || reservedType(field(record, 'type')) ||
        reservedId(source) || reservedId(target) ||
        isIdentityPublicationNode(readNode(source)) || isIdentityPublicationNode(readNode(target));
}

/** @summary Creates a stable refusal without echoing protected provenance. */
function refuse(message = 'Protected identity-publication records require the typed admission owner.', code = 'IDENTITY_PUBLICATION_WRITE_PROTECTED') {
    const error = new Error(message);
    error.code = code;
    throw error;
}

/** @summary Builds a null-safe prefix test over a fixed internal SQL expression and namespace. */
const prefixSql = (expression, prefix) => `COALESCE(substr(${expression}, 1, ${prefix.length}) = '${prefix}', 0)`;

/** @summary Fixed persisted-node predicate shared by the raw migration census. */
export const IDENTITY_PUBLICATION_NODE_SQL = `(
    ${prefixSql('Nodes.id', FAMILY_RECORD_PREFIX)} OR
    ${prefixSql("json_extract(Nodes.data, '$.id')", FAMILY_RECORD_PREFIX)} OR
    ${prefixSql("json_extract(Nodes.data, '$.label')", FAMILY_GRAPH_TYPE_PREFIX)} OR
    ${prefixSql("json_extract(Nodes.data, '$.type')", FAMILY_GRAPH_TYPE_PREFIX)}
)`;

/**
 * Persisted edge predicate for bulk decay and cascading deletion. Only fixed source expressions
 * and namespace constants enter this SQL; it is not a caller-supplied query builder.
 * @type {String}
 */
export const IDENTITY_PUBLICATION_EDGE_SQL = `(
    ${prefixSql('Edges.id', FAMILY_RECORD_PREFIX)} OR
    ${prefixSql('Edges.type', FAMILY_GRAPH_TYPE_PREFIX)} OR
    ${prefixSql('Edges.source', FAMILY_RECORD_PREFIX)} OR
    ${prefixSql('Edges.target', FAMILY_RECORD_PREFIX)} OR
    ${prefixSql("json_extract(Edges.data, '$.id')", FAMILY_RECORD_PREFIX)} OR
    ${prefixSql("json_extract(Edges.data, '$.type')", FAMILY_GRAPH_TYPE_PREFIX)} OR
    ${prefixSql("json_extract(Edges.data, '$.source')", FAMILY_RECORD_PREFIX)} OR
    ${prefixSql("json_extract(Edges.data, '$.target')", FAMILY_RECORD_PREFIX)} OR
    EXISTS (SELECT 1 FROM Nodes AS familyEndpoint
        WHERE familyEndpoint.id IN (Edges.source, Edges.target,
            json_extract(Edges.data, '$.source'), json_extract(Edges.data, '$.target'))
          AND (${prefixSql('familyEndpoint.id', FAMILY_RECORD_PREFIX)} OR
               ${prefixSql("json_extract(familyEndpoint.data, '$.id')", FAMILY_RECORD_PREFIX)} OR
               ${prefixSql("json_extract(familyEndpoint.data, '$.label')", FAMILY_GRAPH_TYPE_PREFIX)} OR
               ${prefixSql("json_extract(familyEndpoint.data, '$.type')", FAMILY_GRAPH_TYPE_PREFIX)}))
)`;

/**
 * @summary Identifies existing admitted history and the endpoints raw migrations must retain.
 * Apply owners take this unscoped census under their physical write transaction and still guard
 * proposed mutations. A caller-held census does not authorize a later write or provision history.
 * @param {Object} sqlite Physical graph connection.
 * @returns {{nodes: Set<String>, edges: Set<String>, endpoints: Set<String>}}
 */
export function readIdentityPublicationPreservation(sqlite) {
    const nodes = new Set(sqlite.prepare(`SELECT id FROM Nodes WHERE ${IDENTITY_PUBLICATION_NODE_SQL}`).all().map(row => row.id));
    const edges = new Set(), endpoints = new Set();
    for (const row of sqlite.prepare(`SELECT id, source, target, data FROM Edges WHERE ${IDENTITY_PUBLICATION_EDGE_SQL}`).all()) {
        edges.add(row.id);
        const data = JSON.parse(row.data);
        for (const id of [row.source, row.target, data.source, data.target]) {
            if (typeof id === 'string') endpoints.add(id);
        }
    }
    return {nodes, edges, endpoints};
}

/**
 * @summary Proves publication absence before an unqualified graph clear or restore.
 * The caller owns serialization and subsequent writes. Both graph tables absent is a fresh target;
 * a fence, protected population, partial schema or unreadable/non-object record never grants recovery.
 * This check reads only and accepts no bypass option or caller-selected publication identity.
 * @param {Object} sqlite Open physical connection with an active transaction.
 * @returns {void}
 * @throws {Error} Typed transaction, recovery-required or unavailable-state refusal.
 */
export function assertIdentityPublicationAbsent(sqlite) {
    if (!sqlite?.open || !sqlite.inTransaction) {
        refuse('Publication absence requires an open physical transaction.', 'IDENTITY_PUBLICATION_TRANSACTION_REQUIRED');
    }
    try {
        const objects = sqlite.prepare('SELECT name, type FROM sqlite_master WHERE name COLLATE NOCASE IN (?, ?, ?)')
            .all('Nodes', 'Edges', IDENTITY_PUBLICATION_FENCE_TABLE);
        if (objects.some(object => object.type !== 'table')) {
            refuse('Publication graph names do not identify tables.', 'IDENTITY_PUBLICATION_STATE_UNAVAILABLE');
        }
        const tables = new Set(objects.map(object => object.name.toLowerCase()));
        if (tables.has(IDENTITY_PUBLICATION_FENCE_TABLE.toLowerCase())) {
            refuse('A durable publication fence requires separately admitted recovery.', 'IDENTITY_PUBLICATION_RECOVERY_REQUIRED');
        }
        if (!tables.has('nodes') && !tables.has('edges')) return;
        if (!tables.has('nodes') || !tables.has('edges')) {
            refuse('Publication graph population is incomplete.', 'IDENTITY_PUBLICATION_STATE_UNAVAILABLE');
        }
        for (const table of ['Nodes', 'Edges']) {
            if (sqlite.prepare(`SELECT 1 FROM ${table}
                WHERE CASE WHEN json_valid(data) THEN json_type(data) <> 'object' ELSE 1 END LIMIT 1`).get()) {
                refuse('Publication state cannot classify malformed graph records.', 'IDENTITY_PUBLICATION_STATE_UNAVAILABLE');
            }
        }
        const publication = readIdentityPublicationPreservation(sqlite);
        if (publication.nodes.size || publication.edges.size) {
            refuse('Protected publication history requires separately admitted recovery.', 'IDENTITY_PUBLICATION_RECOVERY_REQUIRED');
        }
    } catch (error) {
        if (['IDENTITY_PUBLICATION_RECOVERY_REQUIRED', 'IDENTITY_PUBLICATION_STATE_UNAVAILABLE'].includes(error.code)) throw error;
        refuse('Publication state cannot be completely read.', 'IDENTITY_PUBLICATION_STATE_UNAVAILABLE');
    }
}

/** @summary Captures every protected physical column and necessary endpoint without normalizing JSON bytes. */
function preservationSnapshot(sqlite) {
    try {
        const census = readIdentityPublicationPreservation(sqlite);
        const rows   = (table, ids) => {
            const read    = sqlite.prepare('SELECT * FROM ' + table + ' WHERE id = ?');
            const columns = read.columns().map(column => column.name);
            const values  = columns.flatMap(column => {
                const quoted = '"' + column.replaceAll('"', '""') + '"';
                return ['typeof(' + quoted + ')', 'CAST(' + quoted + ' AS BLOB)'];
            });
            const raw = sqlite.prepare('SELECT ' + values.join(', ') + ' FROM ' + table + ' WHERE id = ?').raw();
            return new Map([...ids].sort().map(id => {
                const row = read.get(id);
                if (!row) refuse('Protected identity-publication history has a missing record or endpoint.');
                const data = typeof row.data === 'string' ? JSON.parse(row.data) : null;
                if (!data || typeof data !== 'object' || Array.isArray(data)) {
                    refuse('Protected identity-publication history has an invalid record payload.');
                }
                // Raw TEXT/integer bytes avoid lossy JS decoding; decoded REAL values retain full precision.
                return [id, {columns, row, raw: raw.get(id)}];
            }));
        };
        return {nodes: rows('Nodes', census.nodes), edges: rows('Edges', census.edges),
            endpoints: rows('Nodes', census.endpoints)};
    } catch (error) {
        if (error.code === 'IDENTITY_PUBLICATION_WRITE_PROTECTED') throw error;
        refuse('Protected identity-publication history cannot be completely read.');
    }
}

/**
 * @summary Commits a synchronous raw migration only when protected history and its endpoints retain every byte.
 * The immediate transaction owns both censuses; a late mismatch rolls back ordinary writes and GraphLog too.
 * The callback receives only captured classification closures, never mutable Sets or a permission flag.
 * It is trusted source code: it must not control transactions or schedule writes after returning.
 * Known async callbacks refuse before invocation; a thenable result refuses before commit.
 * @param {Object} sqlite Open physical SQLite connection with no active transaction.
 * @param {Function} mutation Synchronous callback receiving frozen row-ID predicates.
 * @returns {*} The callback's result, returned only after commit.
 * @throws {Error} Typed protection refusal for unsafe changes, incomplete history or invalid callback boundaries.
 */
export function runWithIdentityPublicationPreserved(sqlite, mutation) {
    if (!sqlite?.open || sqlite.inTransaction) {
        refuse('Identity-publication preservation requires its own open physical transaction.');
    }
    if (typeof mutation !== 'function' || /\[object Async(?:Generator)?Function\]/.test(Object.prototype.toString.call(mutation))) {
        refuse('Identity-publication preservation requires a synchronous callback.');
    }
    return sqlite.transaction(() => {
        const before = preservationSnapshot(sqlite);
        const result = mutation(Object.freeze({
            isProtectedNode     : id => before.nodes.has(id),
            isProtectedEdge     : id => before.edges.has(id),
            isHistoricalEndpoint: id => before.endpoints.has(id)
        }));
        if (result && typeof result.then === 'function') {
            refuse('Identity-publication preservation refuses a thenable callback result.');
        }
        if (!sqlite.inTransaction) refuse('Identity-publication preservation lost its owned transaction.');
        if (!isDeepStrictEqual(before, preservationSnapshot(sqlite))) {
            refuse('Raw migration changed protected identity-publication history or its endpoints.');
        }
        return result;
    }).immediate();
}

/**
 * @summary Refuses ordinary graph mutation of either proposed or persisted protected state.
 *
 * Storage writers call this inside their physical transaction; cache owners call it before any
 * RAM mutation too. Deleting an ordinary endpoint must not cascade a protected relation away.
 * The typed admission owner uses its separately scoped physical transaction, never a JSON bypass.
 * @param {Object|null} sqlite Physical connection, or null for an in-memory-only graph.
 * @param {Object} options
 * @param {'Nodes'|'Edges'} options.table Graph population.
 * @param {String} options.id Target record id.
 * @param {Object|null} [options.record=null] Proposed write.
 * @param {Object|null} [options.current=null] Current cached record for memory-only/early guards.
 * @param {Boolean} [options.remove=false] Whether deletion can cascade incident edges.
 * @param {Function} [options.readCachedNode=()=>null] Endpoint lookup for memory-only graphs.
 */
export function assertOrdinaryGraphMutation(sqlite, {table, id, record = null, current = null, remove = false, readCachedNode = () => null}) {
    if (!['Nodes', 'Edges'].includes(table)) throw new TypeError('Ordinary graph mutation requires Nodes or Edges.');

    const readNode = nodeId => {
        if (typeof nodeId !== 'string') return null;
        const row = sqlite?.prepare('SELECT id, data FROM Nodes WHERE id = ?').get(nodeId);
        if (!row) return readCachedNode(nodeId);
        const data = JSON.parse(row.data);
        return isIdentityPublicationNode(data) ? data : {...data, id: row.id};
    };
    const protectedRecord = value => table === 'Nodes'
        ? isIdentityPublicationNode(value)
        : isIdentityPublicationEdge(value, readNode);

    if (reservedId(id) || protectedRecord(record) || protectedRecord(current)) refuse();

    if (sqlite) {
        const stored = sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
        if (stored) {
            const data = JSON.parse(stored.data);
            if (protectedRecord(data) || protectedRecord({...data, ...stored})) refuse();
        }
        if (table === 'Nodes' && remove && sqlite.prepare(`
            SELECT 1 FROM Edges WHERE (source = ? OR target = ?) AND ${IDENTITY_PUBLICATION_EDGE_SQL} LIMIT 1
        `).get(id, id)) refuse();
    }
}

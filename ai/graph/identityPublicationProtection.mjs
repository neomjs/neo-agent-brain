import {FAMILY_GRAPH_TYPE_PREFIX, FAMILY_RECORD_PREFIX} from '../services/shared/identityPublicationKeys.mjs';

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
function refuse() {
    const error = new Error('Protected identity-publication records require the typed admission owner.');
    error.code = 'IDENTITY_PUBLICATION_WRITE_PROTECTED';
    throw error;
}

/** @summary Builds a null-safe prefix test over a fixed internal SQL expression and namespace. */
const prefixSql = (expression, prefix) => `COALESCE(substr(${expression}, 1, ${prefix.length}) = '${prefix}', 0)`;

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

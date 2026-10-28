import {stringifyCanonicalJson} from '../../shared/canonicalJson.mjs';

/**
 * @module ai/services/memory-core/helpers/identityPublicationFence
 * @summary Sticky class-9 restore eligibility on the owner's physical SQLite connection.
 *
 * This operational table is outside Nodes/Edges and carries no family history or keys. The
 * write seam only fences; it cannot clear, recover, or authorize enrollment. Missing state is
 * unavailable to readers. An admitted initial reservation must establish its own clear state.
 */

export const IDENTITY_PUBLICATION_FENCE_TABLE = 'IdentityPublicationFence';
const CAPABILITY = 'identity-family-publication';

/** @summary Returns a value-free, named refusal for unavailable or inconsistent fence state. */
function unavailable(reason) {
    const error = new Error(`Identity publication fence unavailable: ${reason}`);
    error.code = 'IDENTITY_PUBLICATION_FENCE_UNAVAILABLE';
    return error;
}

/** @summary Checks a caller-owned identifier without normalization. */
function text(value) {
    return typeof value === 'string' && value.length > 0 && value.trim() === value &&
        !/[\u0000-\u001f\u007f]/u.test(value);
}

/** @summary Checks the independent served target required for every fence access. */
function checkTarget(target) {
    if (!target || !text(target.planeId) || !text(target.dataRoot)) throw unavailable('served target is required.');
}

/** @summary Checks an exact stored record shape before interpreting eligibility. */
function exact(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** @summary Reads and validates an existing operational row; absence is returned only to the fencing writer. */
function readRow(db, target) {
    const row = db.prepare(`SELECT data FROM ${IDENTITY_PUBLICATION_FENCE_TABLE} WHERE capability = ?`).get(CAPABILITY);
    if (!row) return null;
    const value = JSON.parse(row.data);

    if (stringifyCanonicalJson(value) !== row.data || !exact(value, ['version', 'planeId', 'dataRoot', 'state', 'cause']) ||
        value.version !== 1 || value.planeId !== target.planeId || value.dataRoot !== target.dataRoot ||
        !['clear', 'fenced'].includes(value.state)) throw unavailable('malformed or wrong-target state.');

    if (value.state === 'clear') {
        if (value.cause !== null) throw unavailable('malformed clear state.');
    } else {
        if (!exact(value.cause, ['operation', 'source', 'at']) || !text(value.cause.operation) ||
            !text(value.cause.source) || !Number.isSafeInteger(value.cause.at) || value.cause.at < 0) {
            throw unavailable('malformed fence provenance.');
        }
        Object.freeze(value.cause);
    }

    return Object.freeze(value);
}

/**
 * @summary Reads durable eligibility directly; missing/unreadable state never means clear.
 * @param {Object} db Owner's physical SQLite connection.
 * @param {Object} target Independently resolved {planeId, dataRoot}.
 * @returns {Object} Detached frozen clear/fenced record.
 */
export function readIdentityPublicationFence(db, target) {
    checkTarget(target);
    try {
        const row = readRow(db, target);
        if (!row) throw unavailable('required state is missing.');
        return row;
    } catch (error) {
        if (error.code === 'IDENTITY_PUBLICATION_FENCE_UNAVAILABLE') throw error;
        throw unavailable('operational storage cannot be read.');
    }
}

/**
 * @summary Admits or preserves a sticky fence inside the caller's live mutation transaction.
 *
 * The first cause remains evidence across retries. Schema creation and the fence participate in
 * the same transaction as a live delete/promotion, or a separate committed pre-merge transaction.
 * No request-provided flag selects disposable storage; source composition owns this call.
 * @param {Object} db Owner's physical SQLite connection, already in a synchronous transaction.
 * @param {Object} options
 * @param {String} options.planeId Served plane identity.
 * @param {String} options.dataRoot Served root corroborating that identity.
 * @param {String} options.operation Trusted mutation owner's operation name.
 * @param {String} options.source Mutation provenance, never authority from imported rows.
 * @param {Number} [options.at=Date.now()] Observation timestamp.
 * @returns {Object} Detached frozen fenced record.
 */
export function fenceIdentityPublication(db, {planeId, dataRoot, operation, source, at = Date.now()}) {
    const target = {planeId, dataRoot};
    checkTarget(target);
    if (!db?.inTransaction) throw unavailable('a physical mutation transaction is required.');
    if (!text(operation) || !text(source) || !Number.isSafeInteger(at) || at < 0) {
        throw unavailable('mutation provenance is required.');
    }

    try {
        db.exec(`CREATE TABLE IF NOT EXISTS ${IDENTITY_PUBLICATION_FENCE_TABLE} (
            capability TEXT PRIMARY KEY CHECK (capability = 'identity-family-publication'),
            data TEXT NOT NULL
        )`);
        const current = readRow(db, target);
        if (current?.state === 'fenced') return current;

        const value = {version: 1, planeId, dataRoot, state: 'fenced', cause: {operation, source, at}};
        db.prepare(`INSERT INTO ${IDENTITY_PUBLICATION_FENCE_TABLE} (capability, data) VALUES (?, ?)
            ON CONFLICT(capability) DO UPDATE SET data = excluded.data`).run(CAPABILITY, stringifyCanonicalJson(value));
        return readRow(db, target);
    } catch (error) {
        if (error.code === 'IDENTITY_PUBLICATION_FENCE_UNAVAILABLE') throw error;
        throw unavailable('operational storage cannot be fenced.');
    }
}

/**
 * @module ai/services/memory-core/helpers/subjectBinding
 * @summary The protected relation from a provider subject to the one `AgentIdentity` a request acts as,
 * and the activation record that turns selection by subject on.
 *
 * A login is display data: a forge releases a renamed login for anyone to register, so the identity a
 * request acts as follows the verified subject `{authProvider, providerBaseUrl, providerUserId}`, compared
 * exactly and never normalized here.
 *
 * The relation lives in its own table on the graph's physical connection, outside Nodes/Edges, so no
 * graph write, edge cascade, decay or cold-storage pass reaches it. Exactly two writers exist:
 * - {@link bindAtFirstAdmission}, Memory Core's request boundary, inside the transaction that creates
 *   the identity. It binds only an identity that transaction created.
 * - {@link bindAdministratively}, the plane-local administrative path, whose authority is host access to
 *   the data root. It records the retained founding source revision and is the only route that binds an
 *   existing identity or moves a binding to a new endpoint.
 *
 * A subject binds one identity and an identity one subject. A conflicting claim refuses by name and
 * writes nothing; re-presenting a matching binding returns it without a write.
 *
 * Selection is dormant until the epic's cutover commits its activation record through
 * {@link activateSubjectBinding}, so the leaves activate together. Until then readers keep the login
 * selection, and only identities created at first admission gain a binding.
 */

/** @type {String} The relation's table, outside the graph record populations. */
export const SUBJECT_BINDING_TABLE = 'SubjectBinding';

/** @type {String} The one-row activation record the cutover writes. */
export const SUBJECT_BINDING_ACTIVATION_TABLE = 'SubjectBindingActivation';

/** @type {ReadonlyArray<String>} The subject key, in key order. */
export const SUBJECT_KEY = Object.freeze(['authProvider', 'providerBaseUrl', 'providerUserId']);

const
    ROW_KEYS   = [...SUBJECT_KEY, 'identityId', 'writer', 'foundingRevision', 'boundAt'],
    WRITERS    = ['first-admission', 'administrative'],
    ACTIVATION = 'acting-identity',
    SCHEMA     = `CREATE TABLE IF NOT EXISTS ${SUBJECT_BINDING_TABLE} (
        authProvider     TEXT    NOT NULL,
        providerBaseUrl  TEXT    NOT NULL,
        providerUserId   TEXT    NOT NULL,
        identityId       TEXT    NOT NULL UNIQUE,
        writer           TEXT    NOT NULL CHECK (writer IN ('first-admission', 'administrative')),
        foundingRevision TEXT,
        boundAt          INTEGER NOT NULL,
        PRIMARY KEY (authProvider, providerBaseUrl, providerUserId)
    )`,
    ACTIVATION_SCHEMA = `CREATE TABLE IF NOT EXISTS ${SUBJECT_BINDING_ACTIVATION_TABLE} (
        gate            TEXT    PRIMARY KEY CHECK (gate = '${ACTIVATION}'),
        cutoverRevision TEXT    NOT NULL,
        activatedAt     INTEGER NOT NULL
    )`;

/**
 * @summary Builds a named refusal; `details` carries the conflicting identity so a caller can name it.
 * @param {String} code
 * @param {String} message
 * @param {Object} [details={}]
 * @returns {Error}
 */
function refusal(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
}

/** @summary Checks a caller-owned identifier without normalization. */
function text(value) {
    return typeof value === 'string' && value.length > 0 && value.trim() === value &&
        !/[\u0000-\u001f\u007f]/u.test(value);
}

/** @summary Validates the exact subject tuple; anything short of all three fields is nonqualifying. */
function checkSubject(subject) {
    if (!subject || typeof subject !== 'object' || !SUBJECT_KEY.every(key => text(subject[key]))) {
        throw refusal('SUBJECT_BINDING_INVALID', 'A binding needs the complete subject: authProvider, providerBaseUrl and providerUserId.');
    }
}

/** @summary Validates the remaining write inputs. */
function checkWrite({identityId, at}) {
    if (!text(identityId)) throw refusal('SUBJECT_BINDING_INVALID', 'A binding needs the identity it binds.');
    if (!Number.isSafeInteger(at) || at < 0) throw refusal('SUBJECT_BINDING_INVALID', 'A binding needs its time.');
}

/** @summary Requires the caller's physical transaction, so a refusal writes nothing. */
function checkTransaction(db) {
    if (!db?.open || !db.inTransaction) {
        throw refusal('SUBJECT_BINDING_TRANSACTION_REQUIRED', 'A subject binding is written only inside a physical transaction.');
    }
}

/** @summary Tests whether a table exists; absence is a valid, unbound state. */
function hasTable(db, name) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/** @summary Freezes one row after checking its exact shape; a malformed row never reads as a binding. */
function freezeRow(row) {
    if (!row) return null;
    if (Object.keys(row).length !== ROW_KEYS.length || !ROW_KEYS.every(key => Object.hasOwn(row, key)) ||
        ![...SUBJECT_KEY, 'identityId'].every(key => text(row[key])) || !WRITERS.includes(row.writer) ||
        (row.writer === 'administrative' ? !text(row.foundingRevision) : row.foundingRevision !== null) ||
        !Number.isSafeInteger(row.boundAt)) {
        throw refusal('SUBJECT_BINDING_UNAVAILABLE', 'A stored subject binding is malformed.');
    }
    return Object.freeze({...row});
}

/** @summary Runs a read, mapping storage failures to one named unavailable state. */
function read(fn) {
    try {
        return fn();
    } catch (error) {
        if (error.code?.startsWith?.('SUBJECT_BINDING_')) throw error;
        throw refusal('SUBJECT_BINDING_UNAVAILABLE', 'Subject bindings cannot be read.');
    }
}

/** @summary Reads the row bound to one exact subject. */
function rowBySubject(db, subject) {
    return freezeRow(db.prepare(`SELECT ${ROW_KEYS.join(', ')} FROM ${SUBJECT_BINDING_TABLE}
        WHERE authProvider = ? AND providerBaseUrl = ? AND providerUserId = ?`)
        .get(subject.authProvider, subject.providerBaseUrl, subject.providerUserId));
}

/** @summary Reads the row bound to one identity. */
function rowByIdentity(db, identityId) {
    return freezeRow(db.prepare(`SELECT ${ROW_KEYS.join(', ')} FROM ${SUBJECT_BINDING_TABLE} WHERE identityId = ?`)
        .get(identityId));
}

/** @summary Renders a subject for a refusal message without echoing anything beyond its key. */
function describe(subject) {
    return `${subject.authProvider} user ${subject.providerUserId} at ${subject.providerBaseUrl}`;
}

/**
 * @summary Reads the identity a subject is bound to.
 * @param {Object} db The graph's physical SQLite connection.
 * @param {Object} subject `{authProvider, providerBaseUrl, providerUserId}`.
 * @returns {Object|null} The frozen binding, or `null` when the subject is unbound.
 */
export function readSubjectBinding(db, subject) {
    checkSubject(subject);
    return read(() => hasTable(db, SUBJECT_BINDING_TABLE) ? rowBySubject(db, subject) : null);
}

/**
 * @summary Reads the subject an identity is bound to.
 * @param {Object} db The graph's physical SQLite connection.
 * @param {String} identityId An `AgentIdentity` id.
 * @returns {Object|null} The frozen binding, or `null` when the identity is unbound.
 */
export function readIdentityBinding(db, identityId) {
    if (!text(identityId)) throw refusal('SUBJECT_BINDING_INVALID', 'A binding read needs the identity.');
    return read(() => hasTable(db, SUBJECT_BINDING_TABLE) ? rowByIdentity(db, identityId) : null);
}

/**
 * @summary Reads the activation record; `null` keeps selection by subject dormant.
 * @param {Object} db The graph's physical SQLite connection.
 * @returns {Object|null} Frozen `{cutoverRevision, activatedAt}`, or `null` before the cutover.
 */
export function readSubjectBindingActivation(db) {
    return read(() => {
        if (!hasTable(db, SUBJECT_BINDING_ACTIVATION_TABLE)) return null;
        const row = db.prepare(`SELECT cutoverRevision, activatedAt FROM ${SUBJECT_BINDING_ACTIVATION_TABLE} WHERE gate = ?`)
            .get(ACTIVATION);
        if (!row) return null;
        if (!text(row.cutoverRevision) || !Number.isSafeInteger(row.activatedAt)) {
            throw refusal('SUBJECT_BINDING_UNAVAILABLE', 'The activation record is malformed.');
        }
        return Object.freeze({...row});
    });
}

/**
 * @summary Checks one claim against the stored relation and returns the matching binding, if any.
 * A subject bound elsewhere and an identity bound to another subject both refuse by name.
 * @param {Object} db
 * @param {Object} subject
 * @param {String} identityId
 * @returns {Object|null}
 */
function existingClaim(db, subject, identityId) {
    const bySubject = rowBySubject(db, subject);

    if (bySubject) {
        if (bySubject.identityId === identityId) return bySubject;
        throw refusal('SUBJECT_BINDING_SUBJECT_CLAIMED',
            `${describe(subject)} already acts as ${bySubject.identityId}; it cannot also act as ${identityId}.`,
            {identityId: bySubject.identityId});
    }

    const byIdentity = rowByIdentity(db, identityId);

    if (byIdentity) {
        throw refusal('SUBJECT_BINDING_IDENTITY_CLAIMED',
            `${identityId} is bound to another subject; ${describe(subject)} cannot act as it.`,
            {identityId});
    }

    return null;
}

/** @summary Inserts one row and returns it frozen. */
function insert(db, row) {
    db.prepare(`INSERT INTO ${SUBJECT_BINDING_TABLE} (${ROW_KEYS.join(', ')}) VALUES (${ROW_KEYS.map(() => '?').join(', ')})`)
        .run(...ROW_KEYS.map(key => row[key]));
    return rowBySubject(db, row);
}

/**
 * @summary Binds a subject to the identity its first admission just created.
 * Call it inside the transaction that wrote the identity; it binds nothing else.
 * @param {Object} db The graph's physical SQLite connection, already in a transaction.
 * @param {Object} options
 * @param {Object} options.subject `{authProvider, providerBaseUrl, providerUserId}`.
 * @param {String} options.identityId The identity the same transaction created.
 * @param {Number} [options.at=Date.now()]
 * @returns {{state: 'bound'|'matching', binding: Object}}
 * @throws {Error} A named refusal; nothing is written.
 */
export function bindAtFirstAdmission(db, {subject, identityId, at = Date.now()} = {}) {
    checkSubject(subject);
    checkWrite({identityId, at});
    checkTransaction(db);
    db.exec(SCHEMA);

    const matching = existingClaim(db, subject, identityId);
    if (matching) return Object.freeze({state: 'matching', binding: matching});

    return Object.freeze({state: 'bound', binding: insert(db, {...subject, identityId, writer: 'first-admission', foundingRevision: null, boundAt: at})});
}

/**
 * @summary Binds a subject to an existing identity, or moves an identity to its subject's new endpoint.
 * Only the plane-local administrative path calls this. An endpoint move keeps the identity, so its
 * history stays reachable; any other conflict refuses by name.
 * @param {Object} db The graph's physical SQLite connection, already in a transaction.
 * @param {Object} options
 * @param {Object} options.subject `{authProvider, providerBaseUrl, providerUserId}`.
 * @param {String} options.identityId The identity to bind.
 * @param {String} options.foundingRevision The retained founding source revision this bind rests on.
 * @param {Number} [options.at=Date.now()]
 * @returns {{state: 'bound'|'matching'|'moved', binding: Object, previous?: Object}}
 * @throws {Error} A named refusal; nothing is written.
 */
export function bindAdministratively(db, {subject, identityId, foundingRevision, at = Date.now()} = {}) {
    checkSubject(subject);
    checkWrite({identityId, at});
    if (!text(foundingRevision)) throw refusal('SUBJECT_BINDING_INVALID', 'An administrative bind names its founding source revision.');
    checkTransaction(db);
    db.exec(SCHEMA);

    const
        row      = {...subject, identityId, writer: 'administrative', foundingRevision, boundAt: at},
        previous = rowBySubject(db, subject) ? null : rowByIdentity(db, identityId);

    // Same forge account at a new API endpoint: the one conflict an administrative bind resolves.
    if (previous && previous.authProvider === subject.authProvider && previous.providerUserId === subject.providerUserId) {
        db.prepare(`DELETE FROM ${SUBJECT_BINDING_TABLE} WHERE identityId = ?`).run(identityId);
        return Object.freeze({state: 'moved', binding: insert(db, row), previous});
    }

    const matching = existingClaim(db, subject, identityId);
    if (matching) return Object.freeze({state: 'matching', binding: matching});

    return Object.freeze({state: 'bound', binding: insert(db, row)});
}

/**
 * @summary Carries every binding across a migration that renames identity ids: each binding follows its
 * identity to the id the migration gives it. A rename that would leave two subjects on one identity
 * refuses, so the caller's transaction rolls the whole migration back.
 * @param {Object} db The graph's physical SQLite connection, already in the migration's transaction.
 * @param {Function} rename Maps an identity id to its id after the migration; unchanged ids map to themselves.
 * @returns {Number} The number of bindings that moved.
 * @throws {Error} `SUBJECT_BINDING_IDENTITY_CLAIMED` for a merge of two bound identities.
 */
export function renameBoundIdentities(db, rename) {
    checkTransaction(db);
    if (!hasTable(db, SUBJECT_BINDING_TABLE)) return 0;

    const
        rows     = db.prepare(`SELECT ${ROW_KEYS.join(', ')} FROM ${SUBJECT_BINDING_TABLE}`).all().map(freezeRow),
        targetOf = new Map(rows.map(row => [row.identityId, rename(row.identityId)])),
        moves    = [...targetOf].filter(([from, to]) => from !== to),
        claimed  = new Set();

    for (const [, to] of targetOf) {
        if (!text(to)) throw refusal('SUBJECT_BINDING_INVALID', 'A renamed identity needs a valid id.');
        if (claimed.has(to)) {
            throw refusal('SUBJECT_BINDING_IDENTITY_CLAIMED',
                `${to} would bind two subjects after this rename; the migration stops and nothing changes.`, {identityId: to});
        }
        claimed.add(to);
    }

    // Two passes, so a swap or a chain never meets the uniqueness constraint halfway.
    const update = db.prepare(`UPDATE ${SUBJECT_BINDING_TABLE} SET identityId = ? WHERE identityId = ?`);
    moves.forEach(([from], index) => update.run(`renaming:${index}`, from));
    moves.forEach(([, to], index) => update.run(to, `renaming:${index}`));

    return moves.length;
}

/**
 * @summary Records the cutover's activation, which turns selection by subject on for every leaf.
 * The cutover calls this after it has bound the legacy identities; re-recording keeps the first record.
 * @param {Object} db The graph's physical SQLite connection, already in a transaction.
 * @param {Object} options
 * @param {String} options.cutoverRevision The cutover inventory revision the activation rests on.
 * @param {Number} [options.at=Date.now()]
 * @returns {Object} The frozen activation record.
 */
export function activateSubjectBinding(db, {cutoverRevision, at = Date.now()} = {}) {
    if (!text(cutoverRevision)) throw refusal('SUBJECT_BINDING_INVALID', 'Activation names its cutover revision.');
    if (!Number.isSafeInteger(at) || at < 0) throw refusal('SUBJECT_BINDING_INVALID', 'Activation needs its time.');
    checkTransaction(db);
    db.exec(SCHEMA);
    db.exec(ACTIVATION_SCHEMA);
    db.prepare(`INSERT INTO ${SUBJECT_BINDING_ACTIVATION_TABLE} (gate, cutoverRevision, activatedAt) VALUES (?, ?, ?)
        ON CONFLICT(gate) DO NOTHING`).run(ACTIVATION, cutoverRevision, at);
    return readSubjectBindingActivation(db);
}

import {validateFoundingFamilySeed}                                from '../../../graph/identityFoundingSeed.mjs';
import {readIdentityPublicationPreservation}                       from '../../../graph/identityPublicationProtection.mjs';
import {stringifyCanonicalJson}                                    from '../../shared/canonicalJson.mjs';
import {FAMILY_RECORD_PREFIX, familyFoundingKey, familyLineageKey} from '../../shared/identityPublicationKeys.mjs';
import {isIdentityPublicationIdentifier}                           from '../../shared/identityPublicationOperation.mjs';
import {readIdentityPublicationAuthorityInTransaction}             from './identityPublicationLineage.mjs';
import {readIdentityPublicationFence}                              from './identityPublicationFence.mjs';

/**
 * @module ai/services/memory-core/helpers/identityFoundingStorage
 * @summary Owns immutable founding-source storage on an explicit SQLite connection.
 * Installation requires bound trusted lineage; this owner never reserves lineage or publishes C7 acts.
 * A seed's complete content is its installation identity. A retry's source reference cannot replace
 * the original provenance. Physical snapshot callers separately qualify current lineage and trust.
 * First installation follows bound lineage and precedes admitted history; missing source amid
 * protected history requires reconciliation rather than silently re-establishing founding authority.
 */

const LABEL         = 'IDENTITY_FAMILY_FOUNDING';
const PREFIX        = FAMILY_RECORD_PREFIX + 'founding-';
const FOUNDING_ROWS = 'SELECT id, user_id, data FROM Nodes WHERE substr(id, 1, ?) = ? OR ' +
    'CASE WHEN json_valid(data) THEN (substr(json_extract(data, \'$.id\'), 1, ?) = ? OR ' +
    'json_extract(data, \'$.label\') = ? OR json_extract(data, \'$.type\') = ?) ELSE 0 END';

/** @summary Refuses source gaps without echoing retained provenance or caller input. */
function unavailable(reason) {
    const error = new Error('Founding source unavailable: ' + reason);
    error.code = 'IDENTITY_FOUNDING_SOURCE_UNAVAILABLE';
    return error;
}
/** @summary Checks closed JSON shapes after canonical validation has excluded accessors. */
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
/** @summary Requires an explicit source reference without imposing a forge-specific format. */
const reference = value => typeof value === 'string' && value.trim().length > 0;
/** @summary Requires an exactly representable nonnegative timestamp inside the protocol's Date range. */
const time = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0) &&
    Number.isFinite(new Date(value).getTime());
/** @summary Freezes detached JSON results, never the caller's source input. */
function freeze(value) {
    if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);}
    return value;
}
/** @summary Requires a complete independently resolved target rather than a path-derived identity. */
function validateTarget(target) {
    stringifyCanonicalJson(target);
    if (!exact(target, ['planeId', 'dataRoot']) || !isIdentityPublicationIdentifier(target.planeId) ||
        !reference(target.dataRoot) || target.dataRoot.trim() !== target.dataRoot || /[\u0000-\u001f\u007f]/u.test(target.dataRoot)) {
        throw unavailable('invalid target.');
    }
}

/** @summary Reads all founding candidates, so a foreign or malformed row cannot hide behind a point lookup. */
function readSource(db, target, allowMissing = false) {
    if (!db?.open || !db.inTransaction) throw unavailable('a physical transaction is required.');
    validateTarget(target);
    if (readIdentityPublicationFence(db, target).state !== 'clear') throw unavailable('publication is fenced.');
    const rows = db.prepare(FOUNDING_ROWS).all(PREFIX.length, PREFIX, PREFIX.length, PREFIX, LABEL, LABEL);
    if (rows.length === 0 && allowMissing) return null;
    if (rows.length !== 1) throw unavailable('missing or conflicting founding population.');
    const row = rows[0], node = JSON.parse(row.data), source = node?.properties, provenance = source?.provenance;
    if (row.user_id !== null || row.id !== familyFoundingKey(target) || stringifyCanonicalJson(node) !== row.data ||
        !exact(node, ['id', 'label', 'properties']) || node.id !== row.id || node.label !== LABEL ||
        !exact(source, ['version', 'target', 'revision', 'seed', 'provenance']) || source.version !== 1 || source.revision !== 1 ||
        stringifyCanonicalJson(source.target) !== stringifyCanonicalJson(target) || !validateFoundingFamilySeed(source.seed) ||
        !exact(provenance, ['sourceRevision', 'installedAt', 'issuer', 'lineageHead']) ||
        !reference(provenance.sourceRevision) || !time(provenance.installedAt) ||
        !isIdentityPublicationIdentifier(provenance.issuer) ||
        typeof provenance.lineageHead !== 'string' || !/^identity-family-lineage-head-[a-f0-9]{64}$/.test(provenance.lineageHead)) {
        throw unavailable('malformed or wrong-target founding record.');
    }
    return freeze(source);
}

/**
 * @summary Installs a complete seed once under current bound trust, without changing C7 counters.
 * Exact content retries retain original provenance even when the caller supplies a newer reference.
 * The owner commits before returning and refuses an outer transaction; it provisions no authority.
 * @param {Object} db Explicit physical SQLite connection.
 * @param {Object} options Trusted source composition, never request-selected writer privilege.
 * @param {String|null} options.bootText Resolved public boot trust.
 * @param {Object} options.target Independently resolved planeId and dataRoot.
 * @param {Object} options.seed Complete validated founding compiler payload.
 * @param {String} options.sourceRevision Explicit reviewed-source reference, retained on first install.
 * @param {Function} [options.clock=Date.now] Installation clock sampled after acquiring serialization.
 * @returns {Object} Detached installed/idempotent source, conflict or unavailable result.
 */
export function installIdentityFoundingSource(db, {bootText, target, seed, sourceRevision, clock = Date.now} = {}) {
    const refuse = code => freeze({state: 'unavailable', code});
    if (!db?.open) return refuse('founding-graph-unavailable');
    if (db.inTransaction) return refuse('founding-transaction-in-progress');
    try {
        validateTarget(target);
        if (!validateFoundingFamilySeed(seed) || !reference(sourceRevision) || typeof clock !== 'function') {
            return refuse('founding-input-invalid');
        }
        const seedBytes = stringifyCanonicalJson(seed);
        return db.transaction(() => {
            const authority = readIdentityPublicationAuthorityInTransaction(db, bootText, target);
            if (authority.state !== 'bound') return refuse(authority.code ?? 'founding-lineage-unbound');
            const prior = readSource(db, target, true);
            if (prior) {
                if (prior.provenance.issuer !== authority.issuer || prior.provenance.lineageHead !== authority.head) {
                    return refuse('founding-lineage-mismatch');
                }
                if (stringifyCanonicalJson(prior.seed) !== seedBytes) {
                    return freeze({state: 'conflict', code: 'founding-source-conflict', remedy: 'reviewed-reconciliation'});
                }
                return freeze({state: 'idempotent', source: prior});
            }
            const history = readIdentityPublicationPreservation(db);
            if (history.nodes.size !== 1 || !history.nodes.has(familyLineageKey(target)) || history.edges.size !== 0) {
                return refuse('founding-history-unreconciled');
            }
            const installedAt = clock();
            if (!time(installedAt)) return refuse('founding-clock-unavailable');
            const source = {version: 1, target: {...target}, revision: 1, seed: JSON.parse(seedBytes),
                provenance: {sourceRevision, installedAt, issuer: authority.issuer, lineageHead: authority.head}};
            const id = familyFoundingKey(target);
            db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, NULL, ?)')
                .run(id, stringifyCanonicalJson({id, label: LABEL, properties: source}));
            return freeze({state: 'installed', source: readSource(db, target)});
        }).immediate();
    } catch {
        return refuse('founding-source-unavailable');
    }
}

/**
 * @summary Reads the complete immutable source under the caller's physical snapshot and durable fence.
 * The caller must qualify current bound trust and compare source provenance with that same authority.
 * This read never installs, reserves, clears a fence or converts missing source into an empty seed.
 * @param {Object} db Owner's physical SQLite connection with an active transaction.
 * @param {Object} options
 * @param {Object} options.target Independently resolved planeId and dataRoot.
 * @returns {Object} Detached frozen source including seed, revision and installation provenance.
 * @throws {Error} On a missing transaction, missing/fenced source or any malformed founding candidate.
 */
export function readIdentityFoundingSourceInTransaction(db, {target} = {}) {
    try {
        return readSource(db, target);
    } catch (error) {
        if (error.code === 'IDENTITY_FOUNDING_SOURCE_UNAVAILABLE') throw error;
        throw unavailable('retained source cannot be read.');
    }
}

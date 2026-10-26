import {compileIdentityPublicationBoot}                                   from './identityPublicationBoot.mjs';
import {IDENTITY_PUBLICATION_FENCE_TABLE, readIdentityPublicationFence}   from './identityPublicationFence.mjs';
import {readIdentityPublicationPreservation}                              from '../../../graph/identityPublicationProtection.mjs';
import {familyLineageHead, familyLineageKey}                              from '../../shared/identityPublicationKeys.mjs';
import {IDENTITY_PUBLICATION_PURPOSE, verifyIdentityPublicationSignature} from '../../shared/identityPublicationSignature.mjs';
import {stringifyCanonicalJson}                                           from '../../shared/canonicalJson.mjs';

/**
 * @module ai/services/memory-core/helpers/identityPublicationLineage
 * @summary MC-owned first-generation reservation and bind-once consumption, never a request mutation API.
 * The trusted boot caller supplies independently resolved target evidence. Ordinary reads cannot
 * initialize a fence or reserve history. Explicit rotation/recovery has no implicit fallback here.
 */

const LABEL = 'IDENTITY_FAMILY_LINEAGE';

/** @summary Checks the complete persisted shape before interpreting protected authority. */
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** @summary Builds a detached, secret-free observation; unadmitted never means an empty lineage. */
function witness(state, target, code, lineage) {
    return Object.freeze({state, target: Object.freeze({...target}), ...(code ? {code} : {}),
        ...(lineage ? {issuer: lineage.issuer, reservation: Object.freeze({...lineage.reservation}),
            head: lineage.head, fingerprint: lineage.fingerprint} : {})});
}

/** @summary Reads canonical protected bytes and revalidates public-key evidence without cache hydration. */
function readLineage(db, target) {
    const id  = familyLineageKey(target);
    const row = db.prepare('SELECT id, user_id, data FROM Nodes WHERE id = ?').get(id);
    if (!row) return null;
    const node = JSON.parse(row.data), value = node.properties;
    if (row.user_id !== null || stringifyCanonicalJson(node) !== row.data ||
        !exact(node, ['id', 'label', 'properties']) || node.id !== id || node.label !== LABEL ||
        !exact(value, ['version', 'target', 'issuer', 'reservation', 'publicKey', 'fingerprint', 'head'])) {
        throw new Error('Malformed lineage.');
    }
    const compiled = compileIdentityPublicationBoot(stringifyCanonicalJson({version: value.version,
        target: value.target, issuer: value.issuer, reservation: value.reservation,
        trust : value.publicKey === null ? null : [{kid: value.reservation.kid, publicKey: value.publicKey}]}), target);
    const fingerprint = compiled.descriptor.trust?.[0].fingerprint ?? null;
    if (value.fingerprint !== fingerprint || value.head !== familyLineageHead({...value, planeId: target.planeId})) {
        throw new Error('Malformed lineage binding.');
    }
    return value;
}

/** @summary Compares boot intent with the immutable attempt and any already-bound public bytes. */
function disagreement(value, descriptor) {
    if (value.issuer !== descriptor.issuer ||
        stringifyCanonicalJson(value.reservation) !== stringifyCanonicalJson(descriptor.reservation)) {
        return 'lineage-reservation-conflict';
    }
    if (descriptor.trust?.some(entry => entry.kid !== value.reservation.kid)) return 'lineage-rotation-required';
    const proposed = descriptor.trust?.[0];
    if (value.publicKey !== null && proposed && value.publicKey !== proposed.publicKey) {
        return 'lineage-key-conflict';
    }
    return null;
}

/** @summary Produces a reserved/bound observation only after fence and descriptor agreement. */
function observe(db, descriptor, target) {
    const fence = readIdentityPublicationFence(db, target);
    if (fence.state === 'fenced') return witness('fenced', target, 'publication-restore-fenced');
    const value = readLineage(db, target);
    if (!value) return witness('unadmitted', target, 'lineage-missing');
    const conflict = disagreement(value, descriptor);
    if (conflict) return witness('conflict', target, conflict, value);
    return witness(value.publicKey === null ? 'reserved' : 'bound', target, null, value);
}

/**
 * @summary Resolves consumed authority inside the physical owner's transaction.
 * A prior read witness is insufficient: current configuration must supply public trust, physical
 * lineage must agree with it, and the restore fence must still be clear.
 * This reads only; it never reserves or clears state.
 * The public witness API keeps its separate refusal of uncommitted transactions.
 * @param {Object} db Owner's physical SQLite connection, already in its admission transaction.
 * @param {String|null} bootText Trusted resolved boot descriptor, never request-provided configuration.
 * @param {Object} target Independently resolved served plane/root.
 * @returns {Object} Compiled public trust and physical witness, or an explicit refusal.
 */
function transactionAuthority(db, bootText, target) {
    const refuse = code => ({authenticated: false, code});
    if (!db?.open) return refuse('publication-graph-unavailable');
    if (!db.inTransaction) return refuse('publication-transaction-required');
    try {
        const compiled = compileIdentityPublicationBoot(bootText, target);
        if (!compiled) return refuse('publication-not-provisioned');
        if (compiled.descriptor.trust === null) return refuse('publication-trust-unavailable');
        const current = observe(db, compiled.descriptor, target);
        if (current.state !== 'bound') return refuse(current.code ?? 'publication-lineage-unbound');
        return {compiled, current};
    } catch {
        return refuse('publication-history-unavailable');
    }
}

/**
 * @summary Verifies original signed bytes against authority observed inside the owner's transaction.
 * The owner samples now after acquiring serialization; a caller's authenticated flag is never input.
 */
export function verifyIdentityPublicationInTransaction(db, bootText, target, token, now) {
    const authority = transactionAuthority(db, bootText, target);
    if (!authority.compiled) return authority;
    return verifyIdentityPublicationSignature(token, {audience: target.planeId,
        issuer: authority.compiled.descriptor.issuer, publicKeys: authority.compiled.publicKeys, now});
}

/**
 * @summary Observes current consumed trust and fence inside one physical snapshot transaction.
 * No signed operation is required for a read; the service still owns caller authorization.
 * This grants neither publication nor provisioning authority and refuses an absent outer transaction.
 */
export function readIdentityPublicationAuthorityInTransaction(db, bootText, target) {
    const authority = transactionAuthority(db, bootText, target);
    return authority.current ?? {state: 'unavailable', code: authority.code};
}

/**
 * @summary Reads a committed target-bound witness without writing or repairing missing storage.
 * Nested transactions are refused: a savepoint could otherwise expose authority before outer commit.
 * @param {Object|null} db Owner's physical SQLite connection; null means graph unavailable.
 * @param {String|null} bootText Trusted resolved boot descriptor, never a request argument.
 * @param {Object} target Independently resolved served planeId/dataRoot.
 * @returns {Object} Detached reserved/bound/fenced/conflict/unadmitted witness.
 */
export function readIdentityPublicationLineage(db, bootText, target) {
    const compiled = compileIdentityPublicationBoot(bootText, target);
    if (!compiled) return witness('unadmitted', target, 'publication-not-provisioned');
    try {
        if (!db?.open) return witness('unadmitted', target, 'publication-graph-unavailable');
        if (db.inTransaction) return witness('unadmitted', target, 'publication-transaction-in-progress');
        return db.transaction(() => observe(db, compiled.descriptor, target)).deferred();
    } catch {
        return witness('unadmitted', target, 'publication-history-unavailable');
    }
}

/**
 * @summary Reserves absent history or binds its first public key once, solely from trusted MC boot.
 *
 * Initial reservation and clear-fence creation commit together. Existing missing/malformed fence
 * state is never healed. A reserve-only retry preserves bound history and cannot re-authorize minting.
 * This entrypoint owns the physical commit and refuses an outer transaction.
 * The host still must prove its original generation effect was never dispatched before minting.
 * @param {Object|null} db Owner's physical SQLite connection; no connection is opened here.
 * @param {String|null} bootText Trusted resolved MC configuration, not client-provided JSON.
 * @param {Object} target Independently resolved served planeId/dataRoot.
 * @returns {Object} Current detached witness; conflict/unavailability performs no repair.
 */
export function consumeIdentityPublicationBoot(db, bootText, target) {
    const compiled = compileIdentityPublicationBoot(bootText, target);
    if (!compiled) return witness('unadmitted', target, 'publication-not-provisioned');
    try {
        if (!db?.open) return witness('unadmitted', target, 'publication-graph-unavailable');
        if (db.inTransaction) return witness('unadmitted', target, 'publication-transaction-in-progress');
        return db.transaction(() => {
            const {descriptor} = compiled;
            let   value        = readLineage(db, target);
            const hasFence     = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(IDENTITY_PUBLICATION_FENCE_TABLE));
            if (hasFence) {
                const fence = readIdentityPublicationFence(db, target);
                if (fence.state === 'fenced') return witness('fenced', target, 'publication-restore-fenced');
                if (!value) return witness('unadmitted', target, 'lineage-missing');
            } else if (value) {
                return witness('unadmitted', target, 'publication-fence-missing');
            }

            if (!value) {
                const history = readIdentityPublicationPreservation(db);
                if (history.nodes.size || history.edges.size) return witness('unadmitted', target, 'publication-history-unreconciled');
                if (descriptor.trust !== null) return witness('conflict', target, 'lineage-reservation-required');
                value = {version: 1, target: {...target}, issuer: descriptor.issuer,
                    reservation: {...descriptor.reservation}, publicKey: null, fingerprint: null,
                    head       : familyLineageHead({planeId: target.planeId, issuer: descriptor.issuer,
                        reservation: descriptor.reservation, fingerprint: null})};
                db.exec(`CREATE TABLE ${IDENTITY_PUBLICATION_FENCE_TABLE} (
                    capability TEXT PRIMARY KEY CHECK (capability = '${IDENTITY_PUBLICATION_PURPOSE}'), data TEXT NOT NULL)`);
                db.prepare(`INSERT INTO ${IDENTITY_PUBLICATION_FENCE_TABLE} (capability, data) VALUES (?, ?)`)
                    .run(IDENTITY_PUBLICATION_PURPOSE, stringifyCanonicalJson({version: 1, ...target, state: 'clear', cause: null}));
            } else {
                const conflict = disagreement(value, descriptor);
                if (conflict) return witness('conflict', target, conflict, value);
            }

            const key = descriptor.trust?.[0];
            if (key && value.publicKey === null) {
                value = {...value, publicKey: key.publicKey, fingerprint: key.fingerprint,
                    head: familyLineageHead({planeId: target.planeId, issuer: value.issuer,
                        reservation: value.reservation, fingerprint: key.fingerprint})};
            }
            const id = familyLineageKey(target), data = stringifyCanonicalJson({id, label: LABEL, properties: value});
            db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, NULL, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data WHERE data != excluded.data')
                .run(id, data);
            return observe(db, descriptor, target);
        }).immediate();
    } catch {
        return witness('unadmitted', target, 'publication-history-unavailable');
    }
}

import {stringifyCanonicalJson} from '../../shared/canonicalJson.mjs';
import {familyLineageKey, familyMembershipKey, familyPlaneStateKey,
    familyReceiptKey, familySubjectStateKey} from '../../shared/identityPublicationKeys.mjs';
import {IDENTITY_PUBLICATION_NODE_SQL} from '../../../graph/identityPublicationProtection.mjs';
import {IDENTITY_PUBLICATION_LIMITS, isIdentityPublicationBinding, isIdentityPublicationIdentifier,
    validateIdentityPublicationOperation} from '../../shared/identityPublicationOperation.mjs';
import {IDENTITY_PUBLICATION_VALIDITY_MS}       from '../../shared/identityPublicationSignature.mjs';
import {verifyIdentityPublicationInTransaction} from './identityPublicationLineage.mjs';
import {resolveForwardFamilyBoundary}           from './identityPublicationTiming.mjs';

/**
 * @module ai/services/memory-core/helpers/identityPublicationMembership
 * @summary Atomic admitted membership on an explicitly borrowed physical graph connection.
 * This unwired owner opens no database, reads no config and provisions no lineage or fence.
 * Membership history is canonical; revision nodes order it and receipts only evidence operations.
 * Declaration/correction admission remains a separate unfinished part of the same source boundary.
 */

const LABELS = Object.freeze({plane: 'IDENTITY_FAMILY_STATE', subject: 'IDENTITY_FAMILY_SUBJECT',
    member: 'IDENTITY_FAMILY_MEMBERSHIP', receipt: 'IDENTITY_FAMILY_RECEIPT'});
const MEMBERSHIP_KINDS = ['baseline', 'bind', 'retire', 'rekey'];

/** @summary Refuses malformed stored data without exposing its contents. */
function requireState(condition) {
    if (!condition) throw new Error('Invalid admitted membership history.');
}
/** @summary Checks closed stored JSON records after canonical decoding. */
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
/** @summary Checks counters and canonical millisecond values without coercion. */
const integer = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
/** @summary Copies provider-stable identity; display names never select records. */
const stableSubject = subject => Object.fromEntries(['authProvider', 'providerBaseUrl', 'providerUserId'].map(key => [key, subject[key]]));
/** @summary Freezes a detached response, not physical state or a Store. */
function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}
/** @summary Produces a value-free source refusal; only named counters/limits are added by callers. */
const refusal = (state, code, details = {}) => freeze({state, code, ...details});

/** @summary Reads canonical global graph bytes, rejecting a label/physical-id or scope mismatch. */
function decode(row, label) {
    const node = JSON.parse(row.data);
    requireState(row.user_id === null && stringifyCanonicalJson(node) === row.data &&
        exact(node, ['id', 'label', 'properties']) && node.id === row.id && node.label === label);
    return node.properties;
}
/** @summary Writes only source-selected protected graph records inside the caller's transaction. */
function put(db, id, label, properties) {
    db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, NULL, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data WHERE data != excluded.data')
        .run(id, stringifyCanonicalJson({id, label, properties}));
}
/** @summary Captures the first admitted delivery while retaining the original logical act time. */
function provenance(envelope, digest, admittedAt, revision) {
    return {kind: envelope.operation.kind, operationId: envelope.operation.operationId,
        issuer     : envelope.issuer, kid: envelope.kid, issuedAt: envelope.issuedAt, expiresAt: envelope.expiresAt,
        effectiveAt: envelope.operation.effectiveAt, admittedAt, revision, digest};
}
/** @summary Validates immutable operation provenance before interpreting a stored transition. */
function checkProvenance(value, state, issuer, kinds) {
    requireState(exact(value, ['kind', 'operationId', 'issuer', 'kid', 'issuedAt', 'expiresAt', 'effectiveAt',
        'admittedAt', 'revision', 'digest']) && kinds.includes(value.kind) && value.issuer === issuer &&
        ['operationId', 'issuer', 'kid'].every(key => isIdentityPublicationIdentifier(value[key])) &&
        ['issuedAt', 'expiresAt', 'effectiveAt', 'admittedAt', 'revision'].every(key => integer(value[key])) &&
        value.expiresAt - value.issuedAt === IDENTITY_PUBLICATION_VALIDITY_MS && value.revision > 0 && value.revision <= state.revision &&
        value.issuedAt <= value.admittedAt && value.admittedAt < value.expiresAt &&
        /^[a-f0-9]{64}$/.test(value.digest));
    requireState(value.kind === 'baseline' ? value.revision === 1 &&
        stringifyCanonicalJson(value) === stringifyCanonicalJson(state.baseline) : value.revision > 1);
}
/** @summary Reads an operation receipt without using it as current membership authority. */
function readReceipt(db, target, issuer, operationId) {
    const id  = familyReceiptKey({planeId: target.planeId, issuer, operationId});
    const row = db.prepare('SELECT id, user_id, data FROM Nodes WHERE id = ?').get(id);
    if (!row) return null;
    const value = decode(row, LABELS.receipt), result = value.result;
    requireState(exact(value, ['version', 'planeId', 'issuer', 'operationId', 'digest', 'result']) && value.version === 1 &&
        value.planeId === target.planeId && value.issuer === issuer && value.operationId === operationId &&
        /^[a-f0-9]{64}$/.test(value.digest) && exact(result, ['operationId', 'kind', 'revision', 'admittedAt',
            'membershipRevision', 'admissionRevision', 'bindingIds']) && result.operationId === operationId &&
        MEMBERSHIP_KINDS.includes(result.kind) && integer(result.revision) && result.revision > 0 &&
        integer(result.admittedAt) && [result.membershipRevision, result.admissionRevision].every(v => v === null || integer(v)) &&
        Array.isArray(result.bindingIds) && result.bindingIds.length <= IDENTITY_PUBLICATION_LIMITS.baselineBindings &&
        result.bindingIds.every(isIdentityPublicationIdentifier) && new Set(result.bindingIds).size === result.bindingIds.length);
    requireState(result.kind === 'baseline' ? result.revision === 1 && result.membershipRevision === null &&
        result.admissionRevision === null : result.bindingIds.length === 1 && integer(result.membershipRevision) &&
        result.membershipRevision > 0 && integer(result.admissionRevision));
    return value;
}
/** @summary Derives the current seat key from admitted rename history; original provenance stays immutable. */
const currentSeat = member => member.rekeys.at(-1)?.seatId ?? member.binding.seatId;

/**
 * @summary Loads complete membership and revision populations under the same physical transaction.
 * Counts and receipt references detect missing history; no malformed row is dropped into an empty set.
 * @param {Object} db Physical connection.
 * @param {Object} target Served target.
 * @param {String} issuer Consumed stable issuer.
 * @returns {Object} Detached maps for the transaction owner, never a public/cache authority object.
 */
function load(db, target, issuer) {
    const rows     = db.prepare(`SELECT id, user_id, data FROM Nodes WHERE ${IDENTITY_PUBLICATION_NODE_SQL}`).all();
    const planeId  = familyPlaneStateKey(target), lineageId = familyLineageKey(target);
    const planeRow = rows.find(row => row.id === planeId);
    if (!planeRow) {
        requireState(rows.every(row => row.id === lineageId));
        return {state: null, subjects: new Map(), members: new Map()};
    }
    const state = decode(planeRow, LABELS.plane);
    requireState(exact(state, ['version', 'planeId', 'revision', 'baseline', 'memberCount', 'subjectCount']) &&
        state.version === 1 && state.planeId === target.planeId && integer(state.revision) && state.revision > 0 &&
        integer(state.memberCount) && integer(state.subjectCount));
    checkProvenance(state.baseline, state, issuer, ['baseline']);
    requireState(state.baseline.revision === 1);
    const subjects = new Map(), members = new Map(), receipts = new Map();
    for (const row of rows) {
        if (row.id === lineageId || row.id === planeId) continue;
        const label = JSON.parse(row.data).label;
        if (label === LABELS.receipt) {
            const raw     = decode(row, label);
            const receipt = readReceipt(db, target, issuer, raw.operationId);
            requireState(receipt && !receipts.has(receipt.result.revision) &&
                row.id === familyReceiptKey({planeId: target.planeId, issuer, operationId: raw.operationId}));
            receipts.set(receipt.result.revision, receipt);
        } else if (label === LABELS.subject) {
            const value = decode(row, label);
            requireState(exact(value, ['version', 'planeId', 'subject', 'membershipRevision', 'admissionRevision', 'lastBoundary']) &&
                value.version === 1 && value.planeId === target.planeId &&
                exact(value.subject, ['authProvider', 'providerBaseUrl', 'providerUserId']) &&
                row.id === familySubjectStateKey({planeId: target.planeId, subject: value.subject}) &&
                integer(value.membershipRevision) && value.membershipRevision > 0 && value.admissionRevision === 0 &&
                integer(value.lastBoundary) && value.lastBoundary >= state.baseline.admittedAt);
            subjects.set(row.id, value);
        } else if (label === LABELS.member) {
            const value = decode(row, label);
            requireState(exact(value, ['version', 'planeId', 'binding', 'bound', 'rekeys', 'retired']) && value.version === 1 &&
                value.planeId === target.planeId && isIdentityPublicationBinding(value.binding) &&
                row.id === familyMembershipKey({planeId: target.planeId, ...value.binding}) && Array.isArray(value.rekeys));
            checkProvenance(value.bound, state, issuer, ['baseline', 'bind']);
            requireState(value.bound.kind === 'baseline' ? value.bound.admittedAt === state.baseline.admittedAt :
                value.bound.admittedAt > state.baseline.admittedAt);
            let revision = value.bound.revision, seat = value.binding.seatId;
            for (const rekey of value.rekeys) {
                requireState(exact(rekey, ['seatId', 'admission']) && isIdentityPublicationIdentifier(rekey.seatId) && rekey.seatId !== seat);
                checkProvenance(rekey.admission, state, issuer, ['rekey']);
                requireState(rekey.admission.revision > revision);
                revision = rekey.admission.revision; seat = rekey.seatId;
            }
            if (value.retired !== null) {
                requireState(exact(value.retired, ['removal', 'admission']));
                checkProvenance(value.retired.admission, state, issuer, ['retire']);
                const operation = {kind: 'retire', operationId: value.retired.admission.operationId,
                    effectiveAt               : value.retired.admission.effectiveAt, binding: {...value.binding, seatId: seat},
                    expectedMembershipRevision: 0, expectedAdmissionRevision: 0, removal: value.retired.removal};
                requireState(validateIdentityPublicationOperation(operation).valid &&
                    value.retired.admission.revision > revision && value.retired.admission.admittedAt > value.bound.admittedAt);
            }
            members.set(row.id, value);
        } else {
            throw new Error('Unsupported admitted history.');
        }
    }
    requireState(members.size === state.memberCount && subjects.size === state.subjectCount && receipts.size === state.revision);
    const usedRevisions = new Set(), affectedBindings = new Map();
    const checkReceipt  = (admission, bindingId = null) => {
        const receipt = receipts.get(admission.revision);
        requireState(receipt && receipt.digest === admission.digest && receipt.operationId === admission.operationId &&
            receipt.result.kind === admission.kind && receipt.result.admittedAt === admission.admittedAt);
        usedRevisions.add(admission.revision);
        const ids = affectedBindings.get(admission.revision) ?? new Set();
        if (bindingId !== null) ids.add(bindingId);
        affectedBindings.set(admission.revision, ids);
    };
    checkReceipt(state.baseline);
    const subjectRevisions = new Map(), subjectBoundaries = new Map(), activeSeats = new Set();
    for (const [bindingId, member] of members) {
        const subjectId = familySubjectStateKey({planeId: target.planeId, subject: member.binding.subject});
        requireState(subjects.has(subjectId));
        const admissions = [member.bound, ...member.rekeys.map(value => value.admission),
            ...(member.retired ? [member.retired.admission] : [])];
        const revisions = subjectRevisions.get(subjectId) ?? new Set();
        admissions.forEach(admission => { checkReceipt(admission, bindingId); revisions.add(admission.revision); });
        subjectRevisions.set(subjectId, revisions);
        const boundaries = subjectBoundaries.get(subjectId) ?? new Map();
        for (const admission of admissions.filter(value => value.kind !== 'rekey')) {
            requireState(!boundaries.has(admission.revision) || boundaries.get(admission.revision) === admission.admittedAt);
            boundaries.set(admission.revision, admission.admittedAt);
        }
        subjectBoundaries.set(subjectId, boundaries);
        if (!member.retired) { requireState(!activeSeats.has(currentSeat(member))); activeSeats.add(currentSeat(member)); }
    }
    for (const [id, subject] of subjects) {
        const revisions  = [...(subjectRevisions.get(id) ?? [])].sort((a, b) => a - b);
        const boundaries = [...(subjectBoundaries.get(id) ?? [])].sort(([a], [b]) => a - b);
        requireState(revisions.length === subject.membershipRevision && boundaries.at(-1)?.[1] === subject.lastBoundary &&
            boundaries.every((value, index) => index === 0 || value[1] > boundaries[index - 1][1]));
        for (const [index, revision] of revisions.entries()) {
            const receipt = receipts.get(revision).result;
            requireState(receipt.kind === 'baseline' || receipt.membershipRevision === index + 1 && receipt.admissionRevision === 0);
        }
    }
    for (const [revision, ids] of affectedBindings) requireState(stringifyCanonicalJson([...ids].sort()) ===
        stringifyCanonicalJson([...receipts.get(revision).result.bindingIds].sort()));
    requireState(usedRevisions.size === state.revision && activeSeats.size <= IDENTITY_PUBLICATION_LIMITS.baselineBindings);
    return {state, subjects, members};
}

/** @summary Constructs one new stable-subject counter record, independent of login and seat-key changes. */
const newSubject = (planeId, subject) => ({version: 1, planeId, subject: stableSubject(subject),
    membershipRevision: 0, admissionRevision: 0, lastBoundary: null});
/** @summary Constructs the immutable original binding plus initially empty lifecycle history. */
const newMember = (planeId, binding, admission) => ({version: 1, planeId, binding, bound: admission, rekeys: [], retired: null});

/**
 * @summary Admits one signed membership operation with history, counters and receipt in one commit.
 * The source owner supplies boot/target/clock, never a request flag. Current physical trust/expiry
 * checks precede receipt lookup, which precedes all state-dependent and exact-revision checks.
 * No Store is touched; the eventual GraphService caller must sync committed cache invalidations.
 * This source helper is not wired to AuthService, startup, a tool or any live graph.
 * @param {Object} db Explicit physical connection; an outer transaction refuses.
 * @param {String} token Original signed compact carrier.
 * @param {Object} options Trusted composition, including bootText and independently resolved target.
 * @param {Function} [options.clock=Date.now] Clock sampled after physical transaction acquisition.
 * @returns {Object} Accepted/idempotent receipt, conflict, refusal or unavailable state.
 */
export function admitIdentityMembership(db, token, {bootText, target, clock = Date.now} = {}) {
    if (!db?.open) return refusal('unavailable', 'publication-graph-unavailable');
    if (db.inTransaction) return refusal('unavailable', 'publication-transaction-in-progress');
    try {
        return db.transaction(() => {
            const now = clock();
            if (!integer(now)) return refusal('unavailable', 'publication-clock-unavailable');
            const verified = verifyIdentityPublicationInTransaction(db, bootText, target, token, now);
            if (!verified.authenticated) return refusal('refused', verified.code);
            const checked = validateIdentityPublicationOperation(verified.envelope.operation);
            if (!checked.valid) return refusal('refused', checked.code, {field: checked.field});
            const {operation, digest} = checked, {issuer} = verified.envelope;
            const prior               = readReceipt(db, target, issuer, operation.operationId);
            if (prior) {
                if (prior.digest !== digest) return refusal('conflict', 'logical-operation-conflict');
                const bindings = operation.kind === 'baseline' ? operation.bindings : [operation.binding];
                requireState(prior.result.kind === operation.kind && stringifyCanonicalJson(prior.result.bindingIds) ===
                    stringifyCanonicalJson(bindings.map(binding => familyMembershipKey({planeId: target.planeId, ...binding}))));
                requireState(operation.kind === 'baseline' ? prior.result.revision === 1 &&
                    prior.result.membershipRevision === null && prior.result.admissionRevision === null :
                    prior.result.membershipRevision === operation.expectedMembershipRevision + 1 &&
                    prior.result.admissionRevision === operation.expectedAdmissionRevision);
                return freeze({state: 'idempotent', receipt: prior.result});
            }
            if (!MEMBERSHIP_KINDS.includes(operation.kind)) return refusal('unavailable', 'declaration-admission-unavailable');
            const data  = load(db, target, issuer), {members, subjects} = data;
            let   state = data.state, subjectId = null, subject = null, bindingIds;
            if (operation.kind === 'baseline') {
                if (state) return refusal('conflict', 'baseline-already-admitted');
                const admission = provenance(verified.envelope, digest, now, 1);
                state = {version: 1, planeId: target.planeId, revision: 1, baseline: admission,
                    memberCount: operation.bindings.length, subjectCount: 0};
                bindingIds = operation.bindings.map(binding => {
                    const id        = familyMembershipKey({planeId: target.planeId, ...binding});
                    const subjectId = familySubjectStateKey({planeId: target.planeId, subject: binding.subject});
                    const subject   = newSubject(target.planeId, binding.subject);
                    subject.membershipRevision = 1; subject.lastBoundary = now;
                    subjects.set(subjectId, subject);
                    members.set(id, newMember(target.planeId, binding, admission));
                    return id;
                });
                state.subjectCount = subjects.size;
            } else {
                if (!state) return refusal('unavailable', 'membership-unknown');
                subjectId = familySubjectStateKey({planeId: target.planeId, subject: operation.binding.subject});
                subject = subjects.get(subjectId) ?? newSubject(target.planeId, operation.binding.subject);
                if (operation.expectedMembershipRevision !== subject.membershipRevision) return refusal('conflict',
                    'membership-revision-conflict', {actualRevision: subject.membershipRevision});
                if (operation.expectedAdmissionRevision !== subject.admissionRevision) return refusal('conflict',
                    'admission-revision-conflict', {actualRevision: subject.admissionRevision});
                if (state.revision === Number.MAX_SAFE_INTEGER || subject.membershipRevision === Number.MAX_SAFE_INTEGER) {
                    return refusal('unavailable', 'publication-revision-exhausted');
                }
                const id     = familyMembershipKey({planeId: target.planeId, ...operation.binding});
                const member = members.get(id), active = [...members.values()].filter(value => !value.retired);
                if (operation.kind === 'bind') {
                    if (member) return refusal('conflict', 'incarnation-already-admitted');
                    if (active.length >= IDENTITY_PUBLICATION_LIMITS.baselineBindings) return refusal('conflict',
                        'binding-capacity-exceeded', {seatCount: active.length, limit: IDENTITY_PUBLICATION_LIMITS.baselineBindings,
                            seatId: operation.binding.seatId, remedy: 'correct-or-retire'});
                } else if (!member || member.retired || currentSeat(member) !== operation.binding.seatId) {
                    return refusal('conflict', 'binding-incarnation-mismatch');
                }
                const proposedSeat = operation.kind === 'rekey' ? operation.newSeatId : operation.binding.seatId;
                if (operation.kind !== 'retire' && active.some(value => value !== member && currentSeat(value) === proposedSeat)) {
                    return refusal('conflict', 'seat-key-already-bound');
                }
                if (operation.kind !== 'rekey') {
                    const timing = resolveForwardFamilyBoundary({admittedAt: now,
                        previousBoundary: subject.lastBoundary ?? state.baseline.admittedAt});
                    if (!timing.allowed) return refusal('conflict', timing.code, timing);
                    subject.lastBoundary = timing.since;
                }
                const admission = provenance(verified.envelope, digest, now, state.revision + 1);
                if (operation.kind === 'bind') {
                    members.set(id, newMember(target.planeId, operation.binding, admission));
                    state.memberCount++;
                } else if (operation.kind === 'rekey') member.rekeys.push({seatId: operation.newSeatId, admission});
                else member.retired = {removal: operation.removal, admission};
                if (!subjects.has(subjectId)) state.subjectCount++;
                subject.membershipRevision++; subjects.set(subjectId, subject);
                state.revision++; bindingIds = [id];
            }
            const receipt = {operationId: operation.operationId, kind: operation.kind, revision: state.revision,
                admittedAt       : now, membershipRevision: subject?.membershipRevision ?? null,
                admissionRevision: subject?.admissionRevision ?? null, bindingIds};
            for (const [id, value] of subjects) put(db, id, LABELS.subject, value);
            for (const [id, value] of members) put(db, id, LABELS.member, value);
            put(db, familyPlaneStateKey(target), LABELS.plane, state);
            put(db, familyReceiptKey({planeId: target.planeId, issuer, operationId: operation.operationId}), LABELS.receipt,
                {version: 1, planeId: target.planeId, issuer, operationId: operation.operationId, digest, result: receipt});
            return freeze({state: 'accepted', receipt});
        }).immediate();
    } catch {
        return refusal('unavailable', 'publication-history-unavailable');
    }
}

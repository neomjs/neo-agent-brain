import {stringifyCanonicalJson} from '../../shared/canonicalJson.mjs';
import {familyAdmissionKey, familyLineageKey, familyMembershipKey, familyPlaneStateKey,
    familyReceiptKey, familySubjectStateKey} from '../../shared/identityPublicationKeys.mjs';
import {IDENTITY_PUBLICATION_NODE_SQL} from '../../../graph/identityPublicationProtection.mjs';
import {IDENTITY_PUBLICATION_LIMITS, isIdentityPublicationBinding, isIdentityPublicationIdentifier,
    validateIdentityPublicationOperation} from '../../shared/identityPublicationOperation.mjs';
import {IDENTITY_PUBLICATION_VALIDITY_MS}                                                      from '../../shared/identityPublicationSignature.mjs';
import {readIdentityPublicationAuthorityInTransaction, verifyIdentityPublicationInTransaction} from './identityPublicationLineage.mjs';
import {resolveForwardFamilyBoundary}                                                          from './identityPublicationTiming.mjs';
import {validateIdentityFamilyIntroduction}                                                    from './identityPublicationVocabulary.mjs';
import {createEmbodiedEpisodeNode, IDENTITY_NODE_TYPES}                                        from '../../../graph/identitySchema.mjs';

/**
 * @module ai/services/memory-core/helpers/identityPublicationAdmission
 * @summary Atomic membership, family declarations and complete snapshots on a borrowed graph connection.
 * This unwired owner opens no database, reads no config and provisions no lineage or fence.
 * Membership history is canonical; revision nodes order it and receipts only evidence operations.
 * Episodes and targeted corrections own family facts; aggregate eras are derived by the reader.
 */

const LABELS = Object.freeze({plane: 'IDENTITY_FAMILY_STATE', subject: 'IDENTITY_FAMILY_SUBJECT',
    member : 'IDENTITY_FAMILY_MEMBERSHIP', receipt: 'IDENTITY_FAMILY_RECEIPT',
    episode: IDENTITY_NODE_TYPES.EMBODIED_EPISODE, correction: 'IDENTITY_FAMILY_CORRECTION'});
const MEMBERSHIP_KINDS  = ['baseline', 'bind', 'retire', 'rekey'];
const DECLARATION_KINDS = ['confirm', 'correct'];
const ALL_KINDS         = [...MEMBERSHIP_KINDS, ...DECLARATION_KINDS];

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
            'membershipRevision', 'admissionRevision', 'bindingIds', 'admissionId']) && result.operationId === operationId &&
        ALL_KINDS.includes(result.kind) && integer(result.revision) && result.revision > 0 &&
        integer(result.admittedAt) && [result.membershipRevision, result.admissionRevision].every(v => v === null || integer(v)) &&
        Array.isArray(result.bindingIds) && result.bindingIds.length <= IDENTITY_PUBLICATION_LIMITS.baselineBindings &&
        result.bindingIds.every(isIdentityPublicationIdentifier) && new Set(result.bindingIds).size === result.bindingIds.length);
    requireState(result.kind === 'baseline' ? result.revision === 1 && result.membershipRevision === null &&
        result.admissionRevision === null : result.bindingIds.length === 1 && integer(result.membershipRevision) &&
        result.membershipRevision > 0 && integer(result.admissionRevision));
    requireState(DECLARATION_KINDS.includes(result.kind) ? result.admissionRevision > 0 &&
        result.admissionId === familyAdmissionKey({planeId: target.planeId, issuer, operationId, kind: result.kind}) :
        result.admissionId === null);
    return value;
}
/** @summary Derives the current seat key from admitted rename history; original provenance stays immutable. */
const currentSeat = member => member.rekeys.at(-1)?.seatId ?? member.binding.seatId;

/** @summary Uses the established episode facts while replacing its handle/time id with an admitted id. */
function episodeFacts(bindingId, family, model, since, until = null) {
    const built = createEmbodiedEpisodeNode({identityKey: bindingId, family, model,
        since: new Date(since).toISOString(), until: until === null ? null : new Date(until).toISOString()});
    requireState(built.valid && Date.parse(built.node.since) === since &&
        (until === null || Date.parse(built.node.until) === until));
    const {id, type, ...facts} = built.node;
    return facts;
}

/** @summary Validates retained explicit family facts with the same closed wire grammar as admission. */
function checkDeclaration(value, member, state, issuer, kind) {
    requireState(member && value.bindingId === familyMembershipKey({planeId: value.planeId, ...member.binding}));
    checkProvenance(value.admission, state, issuer, [kind]);
    requireState(value.admission.revision > member.bound.revision &&
        (!member.retired || value.admission.revision < member.retired.admission.revision));
    const operation = {kind, operationId: value.admission.operationId, effectiveAt: value.admission.effectiveAt,
        binding          : member.binding, expectedMembershipRevision: 0, expectedAdmissionRevision: 0,
        operatorPrincipal: value.operatorPrincipal, family: value.family, model: value.model,
        newFamily        : value.newFamily, unattestedReason: value.unattestedReason,
        ...(kind === 'correct' ? {targetAdmissionId: value.targetAdmissionId, reason: value.reason} : {})};
    requireState(validateIdentityPublicationOperation(operation).valid);
}

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
        return {state: null, subjects: new Map(), members: new Map(), declarations: new Map(), corrections: new Map()};
    }
    const state = decode(planeRow, LABELS.plane);
    requireState(exact(state, ['version', 'planeId', 'revision', 'baseline', 'memberCount', 'subjectCount', 'declarationCount', 'correctionCount']) &&
        state.version === 1 && state.planeId === target.planeId && integer(state.revision) && state.revision > 0 &&
        [state.memberCount, state.subjectCount, state.declarationCount, state.correctionCount].every(integer));
    checkProvenance(state.baseline, state, issuer, ['baseline']);
    requireState(state.baseline.revision === 1);
    const subjects = new Map(), members = new Map(), receipts = new Map(), declarations = new Map(), corrections = new Map();
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
                integer(value.membershipRevision) && value.membershipRevision > 0 && integer(value.admissionRevision) &&
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
        } else if (label === LABELS.episode || label === LABELS.correction) {
            const value  = decode(row, label), kind = label === LABELS.episode ? 'confirm' : 'correct';
            const common = ['version', 'planeId', 'bindingId', 'operatorPrincipal', 'family', 'model',
                'newFamily', 'unattestedReason', 'admission'];
            requireState(exact(value, [...common, ...(kind === 'confirm' ?
                ['identityKey', 'since', 'until', 'capabilities'] : ['targetAdmissionId', 'reason'])]) &&
                value.version === 1 && value.planeId === target.planeId &&
                row.id === familyAdmissionKey({planeId: target.planeId, issuer,
                    operationId: value.admission?.operationId, kind}));
            (kind === 'confirm' ? declarations : corrections).set(row.id, value);
        } else {
            throw new Error('Unsupported admitted history.');
        }
    }
    requireState(members.size === state.memberCount && subjects.size === state.subjectCount && receipts.size === state.revision &&
        declarations.size === state.declarationCount && corrections.size === state.correctionCount);
    const events   = new Map();
    const addEvent = (admission, bindingId = null, admissionId = null) => {
        const receipt = receipts.get(admission.revision);
        requireState(receipt && receipt.digest === admission.digest && receipt.operationId === admission.operationId &&
            receipt.result.kind === admission.kind && receipt.result.admittedAt === admission.admittedAt &&
            receipt.result.admissionId === admissionId);
        const event = events.get(admission.revision) ?? {admission, bindings: new Set()};
        requireState(stringifyCanonicalJson(event.admission) === stringifyCanonicalJson(admission));
        if (bindingId !== null) event.bindings.add(bindingId);
        events.set(admission.revision, event);
    };
    addEvent(state.baseline);
    const activeSeats = new Set();
    for (const [bindingId, member] of members) {
        const subjectId = familySubjectStateKey({planeId: target.planeId, subject: member.binding.subject});
        requireState(subjects.has(subjectId));
        [member.bound, ...member.rekeys.map(value => value.admission),
            ...(member.retired ? [member.retired.admission] : [])].forEach(value => addEvent(value, bindingId));
        if (!member.retired) { requireState(!activeSeats.has(currentSeat(member))); activeSeats.add(currentSeat(member)); }
        const episodes = [...declarations].filter(([, value]) => value.bindingId === bindingId)
            .sort(([, a], [, b]) => a.admission.revision - b.admission.revision);
        for (const [index, [id, value]] of episodes.entries()) {
            checkDeclaration(value, member, state, issuer, 'confirm');
            const until = episodes[index + 1]?.[1].admission.admittedAt ?? member.retired?.admission.admittedAt ?? null;
            const facts = episodeFacts(bindingId, value.family, value.model, value.admission.admittedAt, until);
            requireState(Object.entries(facts).every(([key, expected]) =>
                stringifyCanonicalJson(value[key]) === stringifyCanonicalJson(expected)));
            addEvent(value.admission, bindingId, id);
        }
    }
    for (const [id, value] of declarations) requireState(members.has(value.bindingId) &&
        id === familyAdmissionKey({planeId: target.planeId, issuer, operationId: value.admission.operationId, kind: 'confirm'}));
    for (const [id, value] of corrections) {
        const member = members.get(value.bindingId), original = declarations.get(value.targetAdmissionId);
        checkDeclaration(value, member, state, issuer, 'correct');
        requireState(original && original.bindingId === value.bindingId &&
            original.operatorPrincipal === value.operatorPrincipal && original.admission.revision < value.admission.revision);
        addEvent(value.admission, value.bindingId, id);
    }
    requireState(events.size === state.revision && activeSeats.size <= IDENTITY_PUBLICATION_LIMITS.baselineBindings);
    const counters = new Map();
    for (const [revision, event] of [...events].sort(([a], [b]) => a - b)) {
        const result = receipts.get(revision).result, admission = event.admission;
        requireState(stringifyCanonicalJson([...event.bindings].sort()) ===
            stringifyCanonicalJson([...result.bindingIds].sort()));
        const affectedSubjects = new Set([...event.bindings].map(id =>
            familySubjectStateKey({planeId: target.planeId, subject: members.get(id).binding.subject})));
        for (const id of affectedSubjects) {
            const counter = counters.get(id) ?? {membershipRevision: 0, admissionRevision: 0,
                lastBoundary: state.baseline.admittedAt};
            if (admission.kind === 'baseline') {
                requireState(counter.membershipRevision === 0 && counter.admissionRevision === 0);
                counter.membershipRevision = 1;
            } else {
                if (['bind', 'retire', 'confirm'].includes(admission.kind)) {
                    requireState(admission.admittedAt > counter.lastBoundary);
                    counter.lastBoundary = admission.admittedAt;
                }
                counter[MEMBERSHIP_KINDS.includes(admission.kind) ? 'membershipRevision' : 'admissionRevision']++;
                requireState(result.membershipRevision === counter.membershipRevision &&
                    result.admissionRevision === counter.admissionRevision);
            }
            counters.set(id, counter);
        }
    }
    for (const [id, subject] of subjects) {
        const counter = counters.get(id);
        requireState(counter && ['membershipRevision', 'admissionRevision', 'lastBoundary']
            .every(key => subject[key] === counter[key]));
    }
    return {state, subjects, members, declarations, corrections};
}

/** @summary Constructs one new stable-subject counter record, independent of login and seat-key changes. */
const newSubject = (planeId, subject) => ({version: 1, planeId, subject: stableSubject(subject),
    membershipRevision: 0, admissionRevision: 0, lastBoundary: null});
/** @summary Constructs the immutable original binding plus initially empty lifecycle history. */
const newMember = (planeId, binding, admission) => ({version: 1, planeId, binding, bound: admission, rekeys: [], retired: null});

/**
 * @summary Admits one signed membership or explicit family act with counters and receipt in one commit.
 * The source owner supplies boot/target/clock, never a request flag. Current physical trust/expiry
 * checks precede receipt lookup, which precedes all state-dependent and exact-revision checks.
 * No Store is touched; the eventual GraphService caller must sync committed cache invalidations.
 * This source helper is not wired to AuthService, startup, a tool or any live graph.
 * @param {Object} db Explicit physical connection; an outer transaction refuses.
 * @param {String} token Original signed compact carrier.
 * @param {Object} options Trusted composition, including bootText, independently resolved target and rosterFamilies.
 * @param {Function} [options.clock=Date.now] Clock sampled after physical transaction acquisition.
 * @returns {Object} Accepted/idempotent receipt, conflict, refusal or unavailable state.
 */
export function admitIdentityPublication(db, token, {bootText, target, rosterFamilies, clock = Date.now} = {}) {
    if (!db?.open) return refusal('unavailable', 'publication-graph-unavailable');
    if (db.inTransaction) return refusal('unavailable', 'publication-transaction-in-progress');
    try {
        return db.transaction(() => {
            const now = clock();
            if (!integer(now) || !Number.isFinite(new Date(now).getTime())) return refusal('unavailable', 'publication-clock-unavailable');
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
                    prior.result.membershipRevision === operation.expectedMembershipRevision + (MEMBERSHIP_KINDS.includes(operation.kind) ? 1 : 0) &&
                    prior.result.admissionRevision === operation.expectedAdmissionRevision + (DECLARATION_KINDS.includes(operation.kind) ? 1 : 0));
                return freeze({state: 'idempotent', receipt: prior.result});
            }
            const data  = load(db, target, issuer), {members, subjects, declarations, corrections} = data;
            let   state = data.state, subjectId = null, subject = null, bindingIds, admissionId = null;
            if (operation.kind === 'baseline') {
                if (state) return refusal('conflict', 'baseline-already-admitted');
                const admission = provenance(verified.envelope, digest, now, 1);
                state = {version: 1, planeId: target.planeId, revision: 1, baseline: admission,
                    memberCount: operation.bindings.length, subjectCount: 0, declarationCount: 0, correctionCount: 0};
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
                if ([state.revision, subject.membershipRevision, subject.admissionRevision].includes(Number.MAX_SAFE_INTEGER)) {
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
                if (DECLARATION_KINDS.includes(operation.kind)) {
                    if (operation.kind === 'correct') {
                        const original = declarations.get(operation.targetAdmissionId);
                        if (!original || original.bindingId !== id) return refusal('conflict', 'correction-target-mismatch');
                        if (original.operatorPrincipal !== operation.operatorPrincipal) return refusal('refused', 'correction-principal-mismatch');
                    }
                    // The source owner supplies the roster; request fields never establish catalog completeness.
                    const roster = validateIdentityFamilyIntroduction({family: operation.family,
                        newFamily: operation.newFamily, knownFamilies: rosterFamilies});
                    if (roster.code === 'family-catalog-unavailable') return refusal('unavailable', roster.code);
                    const vocabulary = validateIdentityFamilyIntroduction({family: operation.family, newFamily: operation.newFamily,
                        knownFamilies: [...rosterFamilies, ...[...declarations.values(), ...corrections.values()].map(value => value.family)]});
                    if (!vocabulary.valid) return refusal('refused', vocabulary.code, {
                        ...(vocabulary.conflictingLabels ? {conflictingLabels: vocabulary.conflictingLabels} : {}),
                        ...(vocabulary.remedy ? {remedy: vocabulary.remedy} : {})});
                }
                if (!['rekey', 'correct'].includes(operation.kind)) {
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
                else if (operation.kind === 'retire') member.retired = {removal: operation.removal, admission};
                else {
                    admissionId = familyAdmissionKey({planeId: target.planeId, issuer,
                        operationId: operation.operationId, kind: operation.kind});
                    const value = {version: 1, planeId: target.planeId, bindingId: id,
                        operatorPrincipal: operation.operatorPrincipal, family: operation.family, model: operation.model,
                        newFamily        : operation.newFamily, unattestedReason: operation.unattestedReason, admission};
                    if (operation.kind === 'confirm') {
                        declarations.set(admissionId, {...value, ...episodeFacts(id, operation.family, operation.model, now)});
                        state.declarationCount++;
                    } else {
                        corrections.set(admissionId, {...value, targetAdmissionId: operation.targetAdmissionId, reason: operation.reason});
                        state.correctionCount++;
                    }
                }
                if (['confirm', 'retire'].includes(operation.kind)) {
                    const previous = [...declarations].filter(([key, value]) => key !== admissionId && value.bindingId === id && value.until === null);
                    requireState(previous.length <= 1);
                    if (previous.length) previous[0][1].until = new Date(now).toISOString();
                }
                if (!subjects.has(subjectId)) state.subjectCount++;
                subject[MEMBERSHIP_KINDS.includes(operation.kind) ? 'membershipRevision' : 'admissionRevision']++;
                subjects.set(subjectId, subject);
                state.revision++; bindingIds = [id];
            }
            const receipt = {operationId: operation.operationId, kind: operation.kind, revision: state.revision,
                admittedAt       : now, membershipRevision: subject?.membershipRevision ?? null,
                admissionRevision: subject?.admissionRevision ?? null, bindingIds, admissionId};
            for (const [id, value] of subjects) put(db, id, LABELS.subject, value);
            for (const [id, value] of members) put(db, id, LABELS.member, value);
            for (const [id, value] of declarations) put(db, id, LABELS.episode, value);
            for (const [id, value] of corrections) put(db, id, LABELS.correction, value);
            put(db, familyPlaneStateKey(target), LABELS.plane, state);
            put(db, familyReceiptKey({planeId: target.planeId, issuer, operationId: operation.operationId}), LABELS.receipt,
                {version: 1, planeId: target.planeId, issuer, operationId: operation.operationId, digest, result: receipt});
            return freeze({state: 'accepted', receipt});
        }).immediate();
    } catch {
        return refusal('unavailable', 'publication-history-unavailable');
    }
}

/**
 * @summary Reads every admitted binding, declaration and correction at one physical owner revision.
 * Returned per-subject source objects feed identityFamilyProjection; legacy single-head hydration
 * cannot represent simultaneous seats or fully retired incarnations. Service composition still owns
 * caller authentication and roster precedence. No read repairs, reserves or clears source history.
 * @param {Object} db Explicit physical connection, with no active caller transaction.
 * @param {Object} options Trusted bootText and independently resolved plane/root target.
 * @returns {Object} Detached frozen complete snapshot or an explicit unavailable result.
 */
export function readIdentityPublicationSnapshot(db, {bootText, target} = {}) {
    if (!db?.open) return refusal('unavailable', 'publication-graph-unavailable');
    if (db.inTransaction) return refusal('unavailable', 'publication-transaction-in-progress');
    try {
        return db.transaction(() => {
            const authority = readIdentityPublicationAuthorityInTransaction(db, bootText, target);
            if (authority.state !== 'bound') return refusal('unavailable', authority.code ?? 'publication-lineage-unbound');
            const {state, subjects, members, declarations, corrections} = load(db, target, authority.issuer);
            if (!state) return refusal('unavailable', 'membership-unknown');
            const values = [...subjects.values()].map(subject => {
                const key      = familySubjectStateKey({planeId: target.planeId, subject: subject.subject});
                const bindings = [...members].filter(([, member]) =>
                    familySubjectStateKey({planeId: target.planeId, subject: member.binding.subject}) === key);
                const ids = new Set(bindings.map(([id]) => id));
                return {subject: subject.subject, membershipRevision: subject.membershipRevision,
                    admissionRevision: subject.admissionRevision,
                    bindings         : bindings.map(([bindingId, member]) => ({bindingId, binding: member.binding, currentSeatId: currentSeat(member)})),
                    source           : {baselineSince: state.baseline.admittedAt, revision: state.revision,
                        memberships: bindings.map(([bindingId, member]) => ({bindingId,
                            since: member.bound.admittedAt, until: member.retired?.admission.admittedAt ?? null})),
                        declarations: [...declarations].filter(([, value]) => ids.has(value.bindingId)).map(([admissionId, value]) => ({
                            admissionId, bindingId: value.bindingId, operatorPrincipal: value.operatorPrincipal,
                            since: value.admission.admittedAt, revision: value.admission.revision, family: value.family, model: value.model})),
                        corrections: [...corrections].filter(([, value]) => ids.has(value.bindingId)).map(([admissionId, value]) => ({
                            admissionId, targetAdmissionId: value.targetAdmissionId, operatorPrincipal: value.operatorPrincipal,
                            revision: value.admission.revision, family: value.family, model: value.model}))}};
            });
            return freeze({state: 'available', snapshot: {version: 1, target: {...target}, revision: state.revision,
                baselineSince: state.baseline.admittedAt, counts: {subjects: state.subjectCount, memberships: state.memberCount,
                    declarations: state.declarationCount, corrections: state.correctionCount}, subjects: values}});
        }).deferred();
    } catch {
        return refusal('unavailable', 'publication-history-unavailable');
    }
}

import {stringifyCanonicalJson} from '../services/shared/canonicalJson.mjs';
import {isIdentityPublicationFamily, isIdentityPublicationIdentifier, isIdentityPublicationModel}
    from '../services/shared/identityPublicationOperation.mjs';

/**
 * @module ai/graph/identityFamilyProjection
 * @summary Regenerates temporal account-family intervals from admitted membership and declarations.
 * The caller supplies one complete owner-revision snapshot for one stable subject. This pure view
 * neither admits facts nor proves snapshot completeness, operator custody, plane identity or trust.
 * Canonical interval boundaries come from admission; signed act times and receipts are not inputs.
 * @see ../../learn/agentos/IdentitySchema.md
 */

/** @summary Rejects malformed retained facts instead of omitting them from a positive projection. */
function requireFact(condition, reason) {
    if (!condition) throw new TypeError(reason);
}

/** @summary Requires a closed normalized row after the plain-JSON boundary has been checked. */
function row(value, keys) {
    requireFact(value !== null && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)),
    'Missing or unexpected history field.');
}

/** @summary Checks canonical millisecond times and revision counters without coercion. */
function integer(value) {
    return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

/** @summary Freezes only the detached derived view, never the caller's snapshot. */
function freeze(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

/**
 * @summary Validates normalized retained history and indexes declarations by immutable incarnation.
 * Physical admission must separately prove that a correcting principal still operated the binding
 * at admission. Here a correction must name its original declaration and its original principal.
 * @param {Object} source Plain snapshot; all arrays are required, including empty correction history.
 * @returns {Map} Binding histories with corrected declarations in canonical temporal order.
 */
function histories(source) {
    row(source, ['baselineSince', 'revision', 'memberships', 'declarations', 'corrections']);
    requireFact(integer(source.revision) && (source.baselineSince === null || source.revision > 0) &&
        (source.baselineSince === null || integer(source.baselineSince)), 'Invalid snapshot boundary or revision.');
    requireFact(['memberships', 'declarations', 'corrections'].every(key => Array.isArray(source[key])),
        'Complete history arrays are required.');
    requireFact(source.baselineSince !== null ||
        [source.memberships, source.declarations, source.corrections].every(values => values.length === 0),
    'History cannot precede a complete baseline.');

    const bindings = new Map(), declarations = new Map(), admissionIds = new Set(), revisions = new Set();
    for (const membership of source.memberships) {
        row(membership, ['bindingId', 'since', 'until']);
        requireFact(isIdentityPublicationIdentifier(membership.bindingId) && !bindings.has(membership.bindingId) &&
            integer(membership.since) && membership.since >= source.baselineSince &&
            (membership.until === null || integer(membership.until) && membership.until > membership.since),
        'Invalid or duplicate binding lifetime.');
        bindings.set(membership.bindingId, {...membership, declarations: []});
    }

    const validateAdmission = value => {
        requireFact(isIdentityPublicationIdentifier(value.admissionId) && !admissionIds.has(value.admissionId) &&
            integer(value.revision) && value.revision > 0 && value.revision <= source.revision &&
            !revisions.has(value.revision) && isIdentityPublicationIdentifier(value.operatorPrincipal) &&
            isIdentityPublicationFamily(value.family) && isIdentityPublicationModel(value.model),
        'Invalid or duplicate family admission.');
        admissionIds.add(value.admissionId);
        revisions.add(value.revision);
    };
    for (const declaration of source.declarations) {
        row(declaration, ['admissionId', 'bindingId', 'operatorPrincipal', 'since', 'revision', 'family', 'model']);
        validateAdmission(declaration);
        const binding = bindings.get(declaration.bindingId);
        requireFact(binding && integer(declaration.since) && declaration.since >= binding.since &&
            (binding.until === null || declaration.since < binding.until), 'Declaration is outside its binding lifetime.');
        declarations.set(declaration.admissionId, declaration);
        binding.declarations.push({...declaration});
    }
    for (const binding of bindings.values()) {
        binding.declarations.sort((a, b) => a.since - b.since);
        requireFact(binding.declarations.every((value, index, values) => index === 0 ||
            value.since > values[index - 1].since && value.revision > values[index - 1].revision),
        'Forward declarations must advance time and revision.');
    }

    const corrected = new Map();
    for (const correction of source.corrections) {
        row(correction, ['admissionId', 'targetAdmissionId', 'operatorPrincipal', 'revision', 'family', 'model']);
        validateAdmission(correction);
        const target = declarations.get(correction.targetAdmissionId);
        requireFact(target && target.operatorPrincipal === correction.operatorPrincipal &&
            correction.revision > target.revision, 'Correction must follow its original principal and declaration.');
        const previous = corrected.get(target.admissionId);
        if (!previous || previous.revision < correction.revision) corrected.set(target.admissionId, correction);
    }
    for (const binding of bindings.values()) {
        for (const declaration of binding.declarations) {
            const correction = corrected.get(declaration.admissionId);
            if (correction) {
                declaration.family = correction.family;
                declaration.model  = correction.model;
            }
        }
    }
    return bindings;
}

/**
 * @summary Derives one interval from every member active at its start, including undeclared members.
 * @param {Map} bindings Validated binding histories.
 * @param {Number} since Inclusive canonical boundary.
 * @param {Number|null} until Exclusive next boundary, or null for the open head.
 * @returns {Object} Classification with per-binding evidence; no aggregate model is invented.
 */
function interval(bindings, since, until) {
    const members = [];
    for (const binding of bindings.values()) {
        if (binding.since > since || binding.until !== null && binding.until <= since) continue;
        const declaration = binding.declarations.findLast(value => value.since <= since);
        members.push({bindingId: binding.bindingId, admissionId: declaration?.admissionId ?? null,
            family: declaration?.family ?? null, model: declaration?.model ?? null});
    }
    members.sort((a, b) => a.bindingId < b.bindingId ? -1 : a.bindingId > b.bindingId ? 1 : 0);
    const families = new Set(members.map(member => member.family));
    const state    = members.length === 0 ? 'empty-membership' : families.has(null) ? 'unconfirmed-seat' :
        families.size > 1 ? 'ambiguous-seats' : 'classified';
    return {since, until, state, family: state === 'classified' ? members[0].family : null, members};
}

/**
 * @summary Rebuilds a detached immutable view of all account-family intervals at one owner revision.
 * Membership rows are {bindingId,since,until}; until means admitted completed retirement, never a
 * pending stop. Declarations carry {admissionId,bindingId,operatorPrincipal,since,revision,family,model}.
 * Corrections carry {admissionId,targetAdmissionId,operatorPrincipal,revision,family,model}; their
 * highest revision replaces only the target declaration's facts, preserving its original boundaries.
 * A re-key keeps bindingId; remove/recreate needs another bindingId and inherits no declaration.
 * @param {Object} source Complete normalized history for one stable subject; baselineSince may be null.
 * @returns {Object} Valid projection or an explicit unavailable result, never an empty success on error.
 */
export function buildFamilyProjection(source) {
    try {
        // Validate before copying: JSON conversion must not invoke getters or erase sparse entries.
        stringifyCanonicalJson(source);
        const bindings = histories(source);
        const times    = new Set(source.baselineSince === null ? [] : [source.baselineSince]);
        for (const binding of bindings.values()) {
            times.add(binding.since);
            if (binding.until !== null) times.add(binding.until);
            binding.declarations.forEach(value => times.add(value.since));
        }
        const ordered = [...times].sort((a, b) => a - b);
        return freeze({valid: true, revision: source.revision, baselineSince: source.baselineSince,
            intervals: ordered.map((since, index) => interval(bindings, since, ordered[index + 1] ?? null))});
    } catch (error) {
        return freeze({valid: false, state: 'unavailable', reason: error.message});
    }
}

/**
 * @summary Resolves a submission or routing instant in the same projection, with half-open era bounds.
 * @param {Object} projection A result of buildFamilyProjection, not an authority or remote identity proof.
 * @param {Number} at Canonical timestamp to classify.
 * @returns {Object} Exact family or an explicit unclassified state; literal "unknown" is a family.
 */
export function familyAt(projection, at) {
    if (!projection?.valid || !integer(at)) return {state: 'unavailable', family: null};
    const found = projection.intervals.find(value => value.since <= at && (value.until === null || at < value.until));
    return found ? {state: found.state, family: found.family} : {state: 'membership-unknown', family: null};
}

/**
 * @summary Unions every corrected family overlapping a PR's creation-through-evaluation window.
 * Both query endpoints are included; era ends remain exclusive. Any unclassified span refuses the
 * whole certificate. In particular equal endpoint families cannot hide an intermediate family swap.
 * @param {Object} projection A result of buildFamilyProjection from the decision's one snapshot.
 * @param {Number} since Inclusive PR creation timestamp.
 * @param {Number} until Inclusive evaluation timestamp.
 * @returns {Object} Complete family union or explicit refusal with no partial positive family set.
 */
export function familiesDuring(projection, since, until) {
    if (!projection?.valid || !integer(since) || !integer(until) || since > until) {
        return {state: 'unavailable', families: []};
    }
    const initial = familyAt(projection, since);
    if (initial.state !== 'classified') return {state: initial.state, families: []};
    const overlapping = projection.intervals.filter(value => value.since <= until &&
        (value.until === null || value.until > since));
    const unknown = overlapping.find(value => value.state !== 'classified');
    return unknown ? {state: unknown.state, families: []} :
        {state: 'classified', families: [...new Set(overlapping.map(value => value.family))].sort()};
}

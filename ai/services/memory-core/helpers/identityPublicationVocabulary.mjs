import {identityFamilyComparisonKey} from '../../shared/identityPublicationOperation.mjs';

/**
 * @module ai/services/memory-core/helpers/identityPublicationVocabulary
 * @summary Checks exact-label introduction intent against a complete admitted family catalog.
 * The physical owner supplies the authoritative catalog under serialization, after current
 * trust/expiry checks and accepted-receipt lookup. This pure check proves neither completeness
 * nor authority, and never admits, normalizes or persists a family value.
 */

/** @summary Refuses unavailable catalogs, including sparse, decorated or accessor-bearing arrays. */
function readCatalog(values) {
    if (!Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(values);
    if (Reflect.ownKeys(descriptors).length !== values.length + 1) return null;
    const catalog = new Map();
    for (let index = 0; index < values.length; index++) {
        const entry = descriptors[index];
        if (!entry || !entry.enumerable || !Object.hasOwn(entry, 'value')) return null;
        const key = identityFamilyComparisonKey(entry.value);
        if (key === null) return null;
        catalog.set(entry.value, key);
    }
    return catalog;
}

/**
 * @summary Requires explicit intent for a novel label and refuses conservative-key collisions.
 * Existing exact labels require newFamily:false. An already-colliding key refuses new admissions
 * into that key; unrelated labels remain usable and no historical label is merged or rewritten.
 * Comparison keys are derived only; successful results retain the caller's exact label.
 * @param {Object} options
 * @param {String} options.family Exact proposed family label.
 * @param {Boolean} options.newFamily Explicit introduction intent.
 * @param {String[]} options.knownFamilies Complete owner-supplied catalog, including an explicit empty set.
 * @returns {Object} Frozen valid/family/comparisonKey/novel result or a field-specific refusal code.
 */
export function validateIdentityFamilyIntroduction(options = {}) {
    const refuse = (code, details = {}) => Object.freeze({valid: false, code, ...details});
    try {
        if (!options || typeof options !== 'object' || Array.isArray(options) ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(options))) return refuse('invalid-family-introduction');
        const fields = Object.getOwnPropertyDescriptors(options), keys = ['family', 'newFamily', 'knownFamilies'];
        if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key =>
            !Object.hasOwn(fields, key) || !fields[key].enumerable || !Object.hasOwn(fields[key], 'value'))) {
            return refuse('invalid-family-introduction');
        }
        const family        = fields.family.value, newFamily = fields.newFamily.value;
        const comparisonKey = identityFamilyComparisonKey(family);
        if (comparisonKey === null) return refuse('invalid-family');
        if (typeof newFamily !== 'boolean') return refuse('invalid-family-intent');
        const catalog = readCatalog(fields.knownFamilies.value);
        if (catalog === null) return refuse('family-catalog-unavailable');
        const colliding = [...catalog].filter(([, key]) => key === comparisonKey).map(([label]) => label).sort();
        if (colliding.length > 1) return refuse('known-family-comparison-collision', {
            conflictingLabels: Object.freeze(colliding), remedy: 'authorized-catalog-reconciliation'
        });
        const novel = !catalog.has(family);
        if (!novel && newFamily) return refuse('known-family-introduction');
        if (novel && !newFamily) return refuse('new-family-intent-required');
        if (novel && colliding.length) return refuse('family-comparison-collision', {
            conflictingLabels: Object.freeze(colliding), remedy: 'use-existing-exact-label'
        });
        return Object.freeze({valid: true, family, comparisonKey, novel});
    } catch {
        return refuse('family-catalog-unavailable');
    }
}

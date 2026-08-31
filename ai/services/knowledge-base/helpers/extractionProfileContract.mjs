import {createHash} from 'node:crypto';

import ExtractorCatalogue from '../source/ExtractorCatalogue.mjs';

export const EXTRACTION_PROFILE_SCHEMA_VERSION        = 1;
export const EXTRACTION_NORMALIZATION_CONTRACT_VERSION = 1;

/**
 * Exact matcher semantics are materialization input. A dependency or option change without a
 * normalization-version bump would let the same receipt name a different selected file set.
 */
export const EXTRACTION_MATCHER_CONTRACT = Object.freeze({
    id     : 'micromatch',
    version: '4.0.8',
    options: Object.freeze({
        basename  : false,
        dot       : true,
        nobrace   : false,
        nocase    : false,
        noext     : false,
        noglobstar: false,
        nonegate  : true
    })
});

/**
 * @summary Creates a stable extraction-profile contract error.
 * @param {String} code
 * @param {String} message
 * @returns {Error}
 */
function createProfileError(code, message) {
    const error = new Error(message);

    error.code = code;

    return error;
}

/**
 * @summary Returns true only for JSON-record-shaped objects.
 * @param {*} value
 * @returns {Boolean}
 * @private
 */
function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false
    }

    const prototype = Object.getPrototypeOf(value);

    return prototype === Object.prototype || prototype === null;
}

/**
 * @summary Refuses undeclared schema fields at each profile layer.
 * @param {Object} value
 * @param {String[]} allowed
 * @param {String} label
 * @private
 */
function assertOnlyKeys(value, allowed, label) {
    const extras = Object.keys(value).filter(key => !allowed.includes(key));

    if (extras.length) {
        throw createProfileError(
            'KB_EXTRACTION_PROFILE_UNKNOWN_FIELD',
            `${label} contains unsupported field(s): ${extras.sort().join(', ')}`
        )
    }
}

/**
 * @summary Produces JSON-safe data with recursively sorted object keys.
 * @param {*} value
 * @param {String} label
 * @returns {*}
 */
function canonicalizeData(value, label = 'value') {
    if (
        value === null
        || typeof value === 'string'
        || typeof value === 'boolean'
        || (typeof value === 'number' && Number.isFinite(value))
    ) {
        return value
    }

    if (Array.isArray(value)) {
        return value.map((item, index) => canonicalizeData(item, `${label}[${index}]`))
    }

    if (!isPlainObject(value)) {
        throw createProfileError(
            'KB_EXTRACTION_PROFILE_VALUE_INVALID',
            `${label} must contain only JSON-compatible plain data`
        )
    }

    const forbiddenKey = Object.keys(value)
        .find(key => ['__proto__', 'constructor', 'prototype'].includes(key));

    if (forbiddenKey) {
        throw createProfileError(
            'KB_EXTRACTION_PROFILE_VALUE_INVALID',
            `${label} contains forbidden prototype-chain key '${forbiddenKey}'`
        )
    }

    return Object.fromEntries(Object.keys(value)
        .sort()
        .map(key => [key, canonicalizeData(value[key], `${label}.${key}`)]));
}

/**
 * @summary Recursively freezes canonical profile data before it crosses consumers.
 * @param {*} value
 * @returns {*}
 * @private
 */
function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }

    return value;
}

/**
 * @summary Normalizes one repository-relative territory root.
 * @param {String} value
 * @returns {String}
 */
export function normalizeTerritoryRoot(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw createProfileError(
            'KB_EXTRACTION_PROFILE_ROOT_INVALID',
            'Extraction territory roots must be strings or {path, optional} records'
        )
    }

    const normalized = value.trim()
        .replace(/\\/gu, '/')
        .replace(/^\.\//u, '')
        .replace(/\/{2,}/gu, '/')
        .replace(/\/$/u, '') || '.';

    if (
        normalized.startsWith('/')
        || /^[a-z]:\//iu.test(normalized)
        || normalized.split('/').includes('..')
        || normalized.includes('\0')
    ) {
        throw createProfileError(
            'KB_EXTRACTION_PROFILE_ROOT_INVALID',
            `Extraction territory root '${value}' is not a safe repo-relative path`
        )
    }

    return normalized;
}

/**
 * @summary Normalizes one root-relative micromatch pattern.
 * @param {String} value
 * @returns {String}
 */
export function normalizeTerritoryPattern(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw createProfileError(
            'KB_EXTRACTION_PROFILE_PATTERN_INVALID',
            'Extraction territory patterns must be non-empty strings'
        )
    }

    const normalized = value.trim()
        .replace(/\\/gu, '/')
        .replace(/^\.\//u, '')
        .replace(/\/{2,}/gu, '/');

    if (
        normalized.startsWith('/')
        || /^[a-z]:\//iu.test(normalized)
        || normalized.startsWith('!')
        || normalized.split('/').includes('..')
        || normalized.includes('\0')
    ) {
        throw createProfileError(
            'KB_EXTRACTION_PROFILE_PATTERN_INVALID',
            `Extraction territory pattern '${value}' violates the root-relative matcher grammar`
        )
    }

    return normalized;
}

/**
 * @summary Canonicalizes one include/exclude pattern list.
 * @param {*} value
 * @param {Object} options
 * @returns {String[]}
 * @private
 */
function normalizePatternList(value, {defaultAll = false, label} = {}) {
    if (value === undefined) {
        return defaultAll ? ['**/*'] : []
    }

    if (!Array.isArray(value) || (defaultAll && value.length === 0)) {
        throw createProfileError(
            'KB_EXTRACTION_PROFILE_PATTERN_INVALID',
            `${label} must be a non-empty array when declared`
        )
    }

    return [...new Set(value.map(normalizeTerritoryPattern))].sort();
}

/**
 * @summary Canonicalizes non-overlapping required/optional territory roots.
 * @param {*} value
 * @returns {Object[]}
 * @private
 */
function normalizeRoots(value) {
    if (!Array.isArray(value) || value.length === 0) {
        throw createProfileError(
            'KB_EXTRACTION_PROFILE_ROOT_INVALID',
            'Extraction territory requires at least one root'
        )
    }

    const roots = value.map(candidate => {
        if (typeof candidate === 'string') {
            return {path: normalizeTerritoryRoot(candidate), optional: false}
        }

        if (!isPlainObject(candidate)) {
            throw createProfileError(
                'KB_EXTRACTION_PROFILE_ROOT_INVALID',
                'Extraction territory roots must be strings or {path, optional} records'
            )
        }

        assertOnlyKeys(candidate, ['path', 'optional'], 'territory root');

        if (Object.hasOwn(candidate, 'optional') && typeof candidate.optional !== 'boolean') {
            throw createProfileError(
                'KB_EXTRACTION_PROFILE_ROOT_INVALID',
                'Extraction territory root optional must be boolean'
            )
        }

        return {
            path    : normalizeTerritoryRoot(candidate.path),
            optional: candidate.optional === true
        }
    });

    const seen = new Set();

    for (const root of roots) {
        if (seen.has(root.path)) {
            throw createProfileError(
                'KB_EXTRACTION_PROFILE_ROOT_DUPLICATE',
                `Extraction territory root '${root.path}' is declared more than once`
            )
        }
        seen.add(root.path);
    }

    const ordered = roots.sort((left, right) => left.path === right.path
        ? 0
        : left.path < right.path ? -1 : 1);

    for (let leftIndex = 0; leftIndex < ordered.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex++) {
            const
                left  = ordered[leftIndex].path,
                right = ordered[rightIndex].path;

            if (left === '.' || right.startsWith(`${left}/`)) {
                throw createProfileError(
                    'KB_EXTRACTION_PROFILE_ROOT_OVERLAP',
                    `Extraction territory roots '${left}' and '${right}' overlap`
                )
            }
        }
    }

    return ordered;
}

/**
 * @summary Resolves one extractor id and delegates canonical option validation to its descriptor.
 * @param {Object} value
 * @param {Object} catalogue
 * @param {String} label
 * @returns {Object}
 * @private
 */
function normalizeExtractorReference(value, catalogue, label) {
    const extractorId = typeof value?.extractorId === 'string'
        ? value.extractorId.trim()
        : '';

    if (!extractorId) {
        throw createProfileError(
            'KB_EXTRACTION_PROFILE_EXTRACTOR_REQUIRED',
            `${label} requires extractorId`
        )
    }

    if (value.options !== undefined && !isPlainObject(value.options)) {
        throw createProfileError(
            'KB_EXTRACTION_PROFILE_OPTIONS_INVALID',
            `${label}.options must be a plain object when declared`
        )
    }

    const descriptor = catalogue.get(extractorId);
    const options    = canonicalizeData(value.options ?? {}, `${label}.options`);

    return {
        extractorId,
        options: canonicalizeData(
            descriptor.normalizeOptions(deepFreeze(options)),
            `${label}.normalizedOptions`
        )
    };
}

/**
 * @summary Validates and canonicalizes one primary extraction route.
 * @param {Object} value
 * @param {Object} catalogue
 * @returns {Object}
 * @private
 */
function normalizeRoute(value, catalogue) {
    if (!isPlainObject(value) || !isPlainObject(value.territory)) {
        throw createProfileError(
            'KB_EXTRACTION_PROFILE_ROUTE_INVALID',
            'Extraction routes require territory and extractorId'
        )
    }

    assertOnlyKeys(value, ['territory', 'extractorId', 'options'], 'route');
    assertOnlyKeys(value.territory, ['roots', 'include', 'exclude'], 'route territory');

    return {
        territory: {
            roots  : normalizeRoots(value.territory.roots),
            include: normalizePatternList(value.territory.include, {
                defaultAll: true,
                label     : 'territory.include'
            }),
            exclude: normalizePatternList(value.territory.exclude, {
                label: 'territory.exclude'
            })
        },
        ...normalizeExtractorReference(value, catalogue, 'route')
    };
}

/**
 * @summary Canonicalizes the explicit unmatched-file disposition.
 * @param {*} value
 * @param {Object} catalogue
 * @returns {Object|null}
 * @private
 */
function normalizeFallback(value, catalogue) {
    if (value === undefined || value === null) {
        return null
    }

    if (!isPlainObject(value)) {
        throw createProfileError(
            'KB_EXTRACTION_PROFILE_FALLBACK_INVALID',
            'Extraction fallback must be an action record'
        )
    }

    if (value.action === 'exclude') {
        assertOnlyKeys(value, ['action'], 'fallback');
        return {action: 'exclude'}
    }

    if (value.action === 'extract') {
        assertOnlyKeys(value, ['action', 'extractorId', 'options'], 'fallback');
        return {
            action: 'extract',
            ...normalizeExtractorReference(value, catalogue, 'fallback')
        }
    }

    throw createProfileError(
        'KB_EXTRACTION_PROFILE_FALLBACK_INVALID',
        "Extraction fallback action must be 'exclude' or 'extract'"
    )
}

/**
 * @summary Validates and canonicalizes one per-repository extraction profile.
 * @param {Object} profile
 * @param {Object} [options]
 * @param {Object} [options.catalogue=ExtractorCatalogue]
 * @returns {Object}
 */
export function normalizeExtractionProfile(profile, {catalogue = ExtractorCatalogue} = {}) {
    if (!isPlainObject(profile)) {
        throw createProfileError(
            'KB_EXTRACTION_PROFILE_INVALID',
            'Extraction profile must be a plain object'
        )
    }

    assertOnlyKeys(profile, ['profileSchemaVersion', 'routes', 'fallback'], 'profile');

    if (profile.profileSchemaVersion !== EXTRACTION_PROFILE_SCHEMA_VERSION) {
        throw createProfileError(
            'KB_EXTRACTION_PROFILE_SCHEMA_UNSUPPORTED',
            `Extraction profileSchemaVersion must be ${EXTRACTION_PROFILE_SCHEMA_VERSION}`
        )
    }

    if (!Array.isArray(profile.routes) || profile.routes.length === 0) {
        throw createProfileError(
            'KB_EXTRACTION_PROFILE_ROUTE_INVALID',
            'Extraction profile requires at least one route'
        )
    }

    const routes = profile.routes.map(route => normalizeRoute(route, catalogue))
        .sort((left, right) => {
            const
                leftKey  = JSON.stringify(left),
                rightKey = JSON.stringify(right);

            return leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1;
        });

    return deepFreeze({
        profileSchemaVersion: EXTRACTION_PROFILE_SCHEMA_VERSION,
        routes,
        fallback            : normalizeFallback(profile.fallback, catalogue)
    });
}

/**
 * @summary Canonicalizes the repository hierarchy resolver identity.
 * @param {*} value
 * @returns {{id: String, version: String}|null}
 * @private
 */
function normalizeHierarchyIdentity(value) {
    if (value === undefined || value === null) {
        return null
    }

    if (!isPlainObject(value)) {
        throw createProfileError(
            'KB_EXTRACTION_HIERARCHY_IDENTITY_INVALID',
            'Hierarchy identity must be an {id, version} record'
        )
    }

    assertOnlyKeys(value, ['id', 'version'], 'hierarchy identity');

    const
        id      = typeof value.id === 'string' ? value.id.trim() : '',
        version = typeof value.version === 'string' ? value.version.trim() : '';

    if (!id || !version) {
        throw createProfileError(
            'KB_EXTRACTION_HIERARCHY_IDENTITY_INVALID',
            'Hierarchy identity requires non-empty id and version'
        )
    }

    return {id, version};
}

/**
 * @summary Creates the canonical extraction input consumed by the existing materialization digest.
 *
 * This function deliberately does not hash. #262 extends
 * `createTenantRepoMaterializationDigest()`; minting a second digest here would recreate the
 * parallel-authority defect that the epic rejected.
 *
 * @param {Object} options
 * @param {Object} options.profile
 * @param {Object} [options.catalogue=ExtractorCatalogue]
 * @param {Object|null} [options.hierarchyIdentity]
 * @returns {Object}
 */
export function createExtractionProfileMaterializationInput({
    profile,
    catalogue = ExtractorCatalogue,
    hierarchyIdentity = null
} = {}) {
    const normalizedProfile = normalizeExtractionProfile(profile, {catalogue});
    const extractorIds      = new Set(normalizedProfile.routes.map(route => route.extractorId));

    if (normalizedProfile.fallback?.action === 'extract') {
        extractorIds.add(normalizedProfile.fallback.extractorId);
    }

    const descriptors = [...extractorIds]
        .sort()
        .map(extractorId => {
            const descriptor = catalogue.get(extractorId);

            return {
                extractorId      : descriptor.extractorId,
                version          : descriptor.version,
                deltaSafe        : descriptor.deltaSafe,
                requiresHierarchy: descriptor.requiresHierarchy
            }
        });

    return deepFreeze(canonicalizeData({
        formatVersion               : 1,
        normalizationContractVersion: EXTRACTION_NORMALIZATION_CONTRACT_VERSION,
        matcher                     : EXTRACTION_MATCHER_CONTRACT,
        hierarchyIdentity           : normalizeHierarchyIdentity(hierarchyIdentity),
        descriptors,
        profile                     : normalizedProfile
    }, 'extraction materialization input'));
}

/**
 * @summary Serializes canonical extraction input byte-for-byte for receipt composition.
 * @param {Object} options
 * @returns {String}
 */
export function serializeExtractionProfileMaterializationInput(options = {}) {
    return JSON.stringify(createExtractionProfileMaterializationInput(options));
}

/**
 * @summary Derives the bounded extraction component identity from canonical materialization input.
 *
 * This is not a second materialization digest: it identifies only the extraction component and is
 * consumed by the existing tenant-repo materialization digest, checkpoint, chunk hash, and
 * reconciliation currency. Those surfaces never mint competing answers from the raw profile.
 *
 * @param {Object} options See {@link createExtractionProfileMaterializationInput}.
 * @returns {String} Lowercase SHA-256 identity.
 */
export function createExtractionProfileIdentity(options = {}) {
    return createHash('sha256')
        .update(serializeExtractionProfileMaterializationInput(options))
        .digest('hex')
}

export default {
    createExtractionProfileIdentity,
    createExtractionProfileMaterializationInput,
    normalizeExtractionProfile,
    serializeExtractionProfileMaterializationInput
};

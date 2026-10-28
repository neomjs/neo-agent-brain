/** @summary Stable outer batch version; coverage generations do not change legacy retry digests. */
export const BATCH_SCHEMA_VERSION = 'community-activity-batch.v1';

/** @summary First explicit acquisition/declaration contract; unbound legacy coverage is not this generation. */
export const COVERAGE_SCHEMA_VERSION = 'community-coverage.v1';

const definitions = {
    issues: {
        adapterSchemaVersion: 'github-issue.v1', providerStateSchemaVersion: 'github-issue-state.v1',
        limitations: [
            {axis: 'comment-deletion-correlation', reason: 'github-comment-deleted-event-omits-deleted-comment-id'},
            {axis: 'issue-edit-attribution', reason: 'editor-unattributed'},
            {axis: 'issue-snapshot-history', reason: 'snapshot-without-granular-event'}
        ]
    },
    pulls: {
        adapterSchemaVersion: 'github-pull-request.v1', providerStateSchemaVersion: 'github-pull-request-state.v1',
        limitations: [
            {axis: 'comment-deletion-correlation', reason: 'github-comment-deleted-event-omits-deleted-comment-id'},
            {axis: 'review-deletions', reason: 'github-does-not-expose-exhaustive-review-deletion-tombstones'},
            {axis: 'inline-review-comment-deletions', reason: 'github-does-not-expose-exhaustive-inline-review-comment-deletion-tombstones'}
        ]
    },
    discussions: {
        adapterSchemaVersion: 'github-discussion.v1', providerStateSchemaVersion: 'github-discussion-state.v1',
        limitations: [
            {axis: 'discussion-state-history', reason: 'github-has-no-discussion-lifecycle-connection'},
            {axis: 'discussion-deletions', reason: 'github-has-no-exhaustive-discussion-deletion-tombstones'},
            {axis: 'discussion-child-deletions', reason: 'only-visible-deletedAt-or-explicit-provider-evidence'}
        ]
    }
};

/**
 * @summary Recognized immutable adapter contracts, not caller-selectable policy or acquisition evidence.
 * Each declaration set has one lexical axis order. Provider adapters emit these fixed limitations;
 * the neutral admission/read path checks the same contract without importing provider services.
 * @member {Object}
 */
export const COMMUNITY_COVERAGE_CONTRACTS = Object.freeze(Object.fromEntries(
    Object.entries(definitions).map(([resourceFamily, definition]) => [resourceFamily, Object.freeze({
        contract: Object.freeze({
            schemaVersion: COVERAGE_SCHEMA_VERSION, batchSchemaVersion: BATCH_SCHEMA_VERSION, resourceFamily,
            adapterSchemaVersion: definition.adapterSchemaVersion,
            providerStateSchemaVersion: definition.providerStateSchemaVersion
        }),
        providerLimitations: Object.freeze(definition.limitations
            .sort((a, b) => a.axis < b.axis ? -1 : a.axis > b.axis ? 1 : 0).map(value => Object.freeze(value)))
    })])
));

/** @summary The required initial source-family bundle; a caller cannot select a completeness subset. */
export const COMMUNITY_RESOURCE_FAMILIES = Object.freeze(Object.keys(COMMUNITY_COVERAGE_CONTRACTS));

/** @summary The binding's transport schema is derived from the recognized contract catalogue. */
export const COMMUNITY_COVERAGE_BINDING_SCHEMA = Object.freeze({
    type: 'object', additionalProperties: false,
    required: Object.freeze(Object.keys(COMMUNITY_COVERAGE_CONTRACTS.issues.contract)),
    properties: Object.freeze(Object.fromEntries(
        Object.keys(COMMUNITY_COVERAGE_CONTRACTS.issues.contract).map(key => [key, Object.freeze({
            type: 'string', enum: Object.freeze([...new Set(Object.values(COMMUNITY_COVERAGE_CONTRACTS)
                .map(value => value.contract[key]))].sort())
        })])
    ))
});

/**
 * @summary One neutral definition of acquisition-gap metadata shared by local and hosted coverage.
 *
 * Fields are optional to retain the original range-gap wire contract. Actual adapters supply an
 * axis and any evidence specific to that failure. A gap always degrades acquisition; this shape
 * never makes a declaration, a complete window, or a qualified source. The OpenAPI component is
 * checked against this definition so provider-created evidence cannot disappear at the transport.
 * No schema file, provider, configuration or mutable service is read while validating an item.
 * @member {Object}
 */
export const COMMUNITY_GAP_ITEM_SCHEMA = Object.freeze({
    type                : 'object',
    additionalProperties: false,
    properties          : Object.freeze(Object.fromEntries(Object.entries({
        axis            : {type: 'string'},
        reason          : {type: 'string'},
        afterCursor     : {type: 'string', nullable: true},
        issueId         : {type: 'string'},
        pullRequestId   : {type: 'string'},
        providerEntityId: {type: 'string'},
        discussionId    : {type: 'string'},
        expected        : {type: 'number'},
        fetched         : {type: 'integer', minimum: 0},
        fromBasis       : {type: 'string'},
        toBasis         : {type: 'string'}
    }).map(([key, value]) => [key, Object.freeze(value)])))
});

/**
 * @summary Validates one JSON acquisition-gap item against the shared closed metadata definition.
 *
 * This is intentionally limited to the fields above, not a general schema engine. Legacy range
 * keys remain optional; nullable cursors and finite numeric census evidence retain the actual
 * producer types. Unknown keys and wrong types are refused rather than stripped.
 * @param {*} item
 * @returns {{valid: Boolean, errors: String[]}} Errors name keys, never their submitted values.
 */
export function validateCommunityGap(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return {valid: false, errors: ['COVERAGE_GAP_NOT_AN_OBJECT']}
    }

    const errors = [], properties = COMMUNITY_GAP_ITEM_SCHEMA.properties;

    for (const [key, value] of Object.entries(item)) {
        if (!Object.hasOwn(properties, key)) {
            errors.push(`COVERAGE_GAP_KEY_UNSUPPORTED_${key}`);
            continue
        }

        const field = properties[key];

        if (value === undefined || value === null && field.nullable === true) continue;

        const valid = field.type === 'string'
            ? typeof value === 'string'
            : field.type === 'number'
                ? typeof value === 'number' && Number.isFinite(value)
                : Number.isInteger(value) && value >= field.minimum;

        if (!valid) errors.push(`COVERAGE_GAP_VALUE_INVALID_${key}`)
    }

    return {valid: errors.length === 0, errors}
}

/**
 * @summary Adds the recognized persisted declaration binding to one actual provider acquisition result.
 * A suffix traversal is retained as a gap, never promoted by reaching its end. This function cannot
 * remove acquisition gaps or caller-supplied evidence; only the adapter decides what it observed.
 * @param {String} resourceFamily
 * @param {Object} coverage Actual runner bases, completeness and acquisition gaps.
 * @returns {Object} Fresh coverage evidence; the input and contract catalogue stay immutable.
 */
export function bindCommunityCoverage(resourceFamily, coverage) {
    const recognized = Object.hasOwn(COMMUNITY_COVERAGE_CONTRACTS, resourceFamily)
        ? COMMUNITY_COVERAGE_CONTRACTS[resourceFamily] : null;
    if (!recognized) throw new Error('COMMUNITY_COVERAGE_FAMILY_UNSUPPORTED');

    const gaps = [...(coverage.gaps ?? [])];
    if (coverage.fromBasis !== 'genesis' && !gaps.some(gap => gap.axis === 'root-traversal' && gap.reason === 'not-from-beginning')) {
        gaps.push({axis: 'root-traversal', reason: 'not-from-beginning'})
    }

    return {
        ...coverage, complete: coverage.complete === true && gaps.length === 0,
        ...(gaps.length ? {gaps} : {}),
        contract: {...recognized.contract},
        providerLimitations: recognized.providerLimitations.map(value => ({...value}))
    }
}

/**
 * @summary Interprets explicit coverage without upgrading legacy evidence or fetching a provider.
 * A valid declaration can accompany incomplete acquisition. Qualification additionally requires
 * an exhausted beginning-to-end traversal and zero real gaps. Context fields, when supplied by
 * admission or a receipt reader, must agree with the persisted binding rather than replacing it.
 * @param {*} coverage
 * @param {Object} [context] Server/outer-batch family and version attestations.
 * @returns {{valid: Boolean, qualified: Boolean, errors: String[], reason: String|null}}
 */
export function validateCommunityCoverage(coverage, context = {}) {
    const errors = [], contract = coverage?.contract;
    if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
        return {valid: false, qualified: false, errors: ['COVERAGE_CONTRACT_REQUIRED'], reason: 'legacy-coverage-unqualified'}
    }

    const recognized = Object.hasOwn(COMMUNITY_COVERAGE_CONTRACTS, contract.resourceFamily)
        ? COMMUNITY_COVERAGE_CONTRACTS[contract.resourceFamily] : null;
    if (!recognized) {
        return {valid: false, qualified: false, errors: ['COVERAGE_CONTRACT_UNRECOGNIZED'], reason: 'coverage-contract-unrecognized'}
    }

    const expected = recognized.contract;
    if (Object.keys(contract).length !== Object.keys(expected).length ||
        Object.entries(expected).some(([key, value]) => !Object.hasOwn(contract, key) || contract[key] !== value) ||
        Object.entries(context).some(([key, value]) => Object.hasOwn(expected, key) && expected[key] !== value)) {
        errors.push('COVERAGE_CONTRACT_MISMATCH')
    }

    const allowed = new Set(['fromBasis', 'toBasis', 'complete', 'gaps', 'contract', 'providerLimitations']);
    if (Object.keys(coverage).some(key => !allowed.has(key)) ||
        typeof coverage.fromBasis !== 'string' || typeof coverage.toBasis !== 'string' ||
        typeof coverage.complete !== 'boolean') errors.push('COVERAGE_SHAPE_INVALID');

    const declarations = coverage.providerLimitations;
    if (!Array.isArray(declarations) || declarations.length !== recognized.providerLimitations.length ||
        declarations.some((value, index) => !value || Object.keys(value).length !== 2 ||
            value.axis !== recognized.providerLimitations[index].axis ||
            value.reason !== recognized.providerLimitations[index].reason)) {
        errors.push('COVERAGE_LIMITATIONS_MISMATCH')
    }

    const gaps = coverage.gaps === undefined ? [] : coverage.gaps;
    if (!Array.isArray(gaps)) errors.push('COVERAGE_GAPS_NOT_AN_ARRAY');
    else {
        gaps.forEach(gap => errors.push(...validateCommunityGap(gap).errors));
        if (coverage.complete === true && gaps.length > 0 || coverage.complete === false && gaps.length === 0) {
            errors.push('COVERAGE_ACQUISITION_CONTRADICTION')
        }
    }
    if (coverage.complete === true && coverage.fromBasis !== 'genesis') errors.push('COVERAGE_WINDOW_NOT_EXHAUSTIVE');

    const valid = errors.length === 0,
          qualified = valid && coverage.complete === true && coverage.fromBasis === 'genesis' && gaps.length === 0;
    return {valid, qualified, errors,
        reason: !valid ? 'coverage-contract-invalid' : qualified ? null : 'source-coverage-incomplete'}
}

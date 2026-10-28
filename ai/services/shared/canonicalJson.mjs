/**
 * @module ai/services/shared/canonicalJson
 * @summary Shared deterministic JSON encoding for publication digests and signed service messages.
 * This is the repository's JSON encoding convention, not a general RFC 8785 implementation.
 */

/**
 * @summary Detaches JSON-ready values and sorts object keys without treating prototype names as setters.
 * Retains the existing publication helper's omission of undefined object values. New signed-message
 * producers use stringifyCanonicalJson to reject values which JSON would discard or coerce.
 * @param {*} value JSON-ready value.
 * @returns {*} Detached, deterministically ordered value.
 */
export function canonicalizeDeterministicJsonValue(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalizeDeterministicJsonValue);
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort()
            .filter(key => value[key] !== undefined)
            .map(key => [key, canonicalizeDeterministicJsonValue(value[key])]));
    }

    return value;
}

/**
 * @summary Refuses non-JSON values before canonicalization can erase their meaning.
 * Only plain data records, dense arrays, finite numbers, strings, booleans and null are accepted.
 * Schema-specific required fields and types remain the consumer's responsibility.
 * @param {*} value Candidate data.
 * @param {Set<Object>} ancestors Active traversal path; repeated non-cyclic values are allowed.
 * @throws {TypeError} When the value has no lossless plain-JSON representation.
 */
function assertJsonValue(value, ancestors) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;

    if (typeof value !== 'object') {
        throw new TypeError('Canonical JSON requires finite, plain JSON data.');
    }

    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);

    if ((array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) || ancestors.has(value)) {
        throw new TypeError('Canonical JSON requires acyclic plain records and arrays.');
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors).filter(key => !array || key !== 'length');

    if (keys.some(key => typeof key !== 'string') ||
        (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index))))) {
        throw new TypeError('Canonical JSON refuses symbol keys, sparse arrays and array properties.');
    }

    ancestors.add(value);

    for (const key of keys) {
        const descriptor = descriptors[key];

        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError('Canonical JSON requires enumerable data properties.');
        }

        assertJsonValue(descriptor.value, ancestors);
    }

    ancestors.delete(value);
}

/**
 * @summary Serializes validated plain JSON with the shared deterministic object ordering.
 * Does not normalize strings, infer missing fields or invoke custom toJSON methods.
 * @param {*} value Plain JSON data, with consumer-specific schema validation performed by its owner.
 * @returns {String} Canonical JSON text, ready for UTF-8 encoding.
 * @throws {TypeError} When JSON serialization would omit or coerce an unsupported value.
 */
export function stringifyCanonicalJson(value) {
    assertJsonValue(value, new Set());

    return JSON.stringify(canonicalizeDeterministicJsonValue(value));
}

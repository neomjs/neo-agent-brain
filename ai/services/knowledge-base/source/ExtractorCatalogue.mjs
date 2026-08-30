/**
 * @summary Creates one immutable extractor descriptor.
 * @param {Object} descriptor
 * @returns {Object}
 */
function normalizeDescriptor(descriptor = {}) {
    const
        extractorId = typeof descriptor.extractorId === 'string' ? descriptor.extractorId.trim() : '',
        version     = typeof descriptor.version === 'string' ? descriptor.version.trim() : '';

    if (!extractorId || !version || typeof descriptor.extract !== 'function') {
        throw new TypeError(
            'Extractor descriptors require non-empty extractorId/version strings and an extract function'
        )
    }

    return Object.freeze({
        extractorId,
        version,
        deltaSafe        : descriptor.deltaSafe === true,
        requiresHierarchy: descriptor.requiresHierarchy === true,
        normalizeOptions : typeof descriptor.normalizeOptions === 'function'
            ? descriptor.normalizeOptions
            : options => options,
        extract         : descriptor.extract
    });
}

/**
 * @summary Closes ApiSource route options to one required semantic type.
 * @param {Object} options
 * @returns {{type: String}}
 * @private
 */
function normalizeApiSourceOptions(options = {}) {
    const keys = Object.keys(options);

    if (keys.some(key => key !== 'type')) {
        throw new TypeError('ApiSource route options support only type')
    }

    const type = typeof options.type === 'string' ? options.type.trim() : '';

    if (!type) {
        throw new TypeError('ApiSource route options require a non-empty type')
    }

    return {type};
}

/**
 * @summary Refuses SkillSource options until that extractor owns a declared option surface.
 * @param {Object} options
 * @returns {Object}
 * @private
 */
function normalizeSkillSourceOptions(options = {}) {
    if (Object.keys(options).length) {
        throw new TypeError('SkillSource route options must be empty')
    }

    return {};
}

/**
 * @summary Builds a read-only descriptor catalogue with no mutation surface.
 *
 * This is intentionally not a frozen `Map`: `Object.freeze(new Map())` still permits
 * `.set()`. The private map remains closure-owned and callers receive only frozen descriptor
 * values through `get()` / `list()`. Tenant-declared extractors build an invocation-local
 * catalogue through the same constructor; they are never registered in the legacy singleton.
 *
 * @param {Object[]} descriptors
 * @returns {{get: Function, has: Function, list: Function}}
 */
export function createExtractorCatalogue(descriptors = []) {
    const byId = new Map();

    for (const candidate of descriptors) {
        const descriptor = normalizeDescriptor(candidate);

        if (byId.has(descriptor.extractorId)) {
            throw new TypeError(
                `Duplicate extractor descriptor '${descriptor.extractorId}'`
            )
        }

        byId.set(descriptor.extractorId, descriptor);
    }

    const catalogue = {
        /**
         * @summary Resolves one descriptor or fails closed.
         * @param {String} extractorId
         * @returns {Object}
         */
        get(extractorId) {
            const descriptor = byId.get(extractorId);

            if (!descriptor) {
                const error = new Error(`Unknown extractor descriptor '${extractorId}'`);

                error.code = 'KB_EXTRACTION_DESCRIPTOR_UNKNOWN';
                throw error
            }

            return descriptor;
        },

        /**
         * @summary Reports whether a descriptor exists without exposing its backing store.
         * @param {String} extractorId
         * @returns {Boolean}
         */
        has(extractorId) {
            return byId.has(extractorId);
        },

        /**
         * @summary Returns descriptors in stable extractor-id order.
         * @returns {Object[]}
         */
        list() {
            return Object.freeze([...byId.values()]
                .sort((left, right) => left.extractorId === right.extractorId
                    ? 0
                    : left.extractorId < right.extractorId ? -1 : 1))
        }
    };

    return Object.freeze(catalogue);
}

/**
 * @summary Built-in extraction definitions available to repository profiles.
 *
 * Both initial ports are intentionally non-delta-safe. Skill metadata can depend on another file's
 * trigger pointer; API chunk identity depends on the repository-wide hierarchy input. A changed
 * path therefore replays the whole selected territory until a narrower capability is proved.
 */
export const ExtractorCatalogue = createExtractorCatalogue([{
    extractorId      : 'ApiSource',
    version          : '1.0.0',
    deltaSafe        : false,
    requiresHierarchy: true,
    normalizeOptions : normalizeApiSourceOptions,
    extract          : async options => {
        const {default: ApiSource} = await import('./ApiSource.mjs');

        return await ApiSource.extractFromRepository(options)
    }
}, {
    extractorId      : 'SkillSource',
    version          : '1.0.0',
    deltaSafe        : false,
    requiresHierarchy: false,
    normalizeOptions : normalizeSkillSourceOptions,
    extract          : async options => {
        const {default: SkillSource} = await import('./SkillSource.mjs');

        return await SkillSource.extractFromRepository(options)
    }
}]);

export default ExtractorCatalogue;

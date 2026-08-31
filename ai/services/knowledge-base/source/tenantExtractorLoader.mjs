import {
    resolveTenantModulePath
} from './tenantParserLoader.mjs';

/**
 * @summary Stable refusal codes for tenant-declared extractor modules.
 * @type {Object<String,String>}
 */
export const TENANT_EXTRACTOR_ERROR_CODES = Object.freeze({
    deltaSafeUnproven: 'KB_TENANT_EXTRACTOR_DELTA_SAFE_UNPROVEN',
    escapesRoot      : 'KB_TENANT_EXTRACTOR_SPECIFIER_ESCAPES_ROOT',
    loadFailed       : 'KB_TENANT_EXTRACTOR_LOAD_FAILED',
    noExport         : 'KB_TENANT_EXTRACTOR_NO_DESCRIPTOR_EXPORT',
    notDispatchable  : 'KB_TENANT_EXTRACTOR_NOT_DISPATCHABLE',
    notFound         : 'KB_TENANT_EXTRACTOR_NOT_FOUND',
    rootNotSet       : 'KB_TENANT_EXTRACTOR_ROOT_NOT_SET',
    unsafeShape      : 'KB_TENANT_EXTRACTOR_SPECIFIER_UNSAFE'
});

/**
 * @summary Creates a coded tenant-extractor refusal.
 * @param {String} code
 * @param {String} message
 * @returns {Error}
 * @private
 */
function refuse(code, message) {
    const error = new Error(message);

    error.code = code;

    return error
}

/**
 * @summary Resolves one extractor module below the deployment-pinned extractor root.
 * @param {Object} options
 * @returns {String}
 */
export function resolveTenantExtractorPath(options = {}) {
    return resolveTenantModulePath({
        ...options,
        kind       : 'extractor',
        errorCodes : TENANT_EXTRACTOR_ERROR_CODES,
        rootEnv    : 'NEO_KB_TENANT_EXTRACTOR_ROOT',
        rootExample: '/app/kb-extractors'
    })
}

/**
 * @summary Refuses a loaded value that cannot be an immutable extractor descriptor.
 *
 * The module export owns `extractorId` and `version`; config owns only the module/export address.
 * Custom `deltaSafe:true` is refused because a generic loader cannot prove the absence of hidden
 * cross-file dependencies. The false capability claim is therefore unrepresentable in this lane.
 *
 * @param {*} descriptor Loaded module export.
 * @param {String} subject Bounded declaration label.
 * @returns {Object} Validated descriptor.
 */
export function assertDispatchableExtractor(descriptor, subject) {
    const
        extractorId = typeof descriptor?.extractorId === 'string' ? descriptor.extractorId.trim() : '',
        version     = typeof descriptor?.version === 'string' ? descriptor.version.trim() : '';

    if (!extractorId || !version || typeof descriptor?.extract !== 'function') {
        throw refuse(
            TENANT_EXTRACTOR_ERROR_CODES.notDispatchable,
            `${subject} but does not export a descriptor with non-empty extractorId/version and extract().`
        )
    }

    if (descriptor.deltaSafe === true) {
        throw refuse(
            TENANT_EXTRACTOR_ERROR_CODES.deltaSafeUnproven,
            `${subject} declares deltaSafe:true, but custom delta safety requires a separate capability proof.`
        )
    }

    return descriptor
}

/**
 * @summary Loads the descriptor a tenant declared without registering it globally.
 * @param {Object} options
 * @param {String} options.specifier
 * @param {String} options.root
 * @param {String} [options.exportName]
 * @param {Function} [options.importModule]
 * @param {Function} [options.resolvePath]
 * @returns {Promise<Object>}
 */
export async function loadTenantExtractor({
    specifier,
    root,
    exportName,
    importModule = target => import(target),
    resolvePath  = resolveTenantExtractorPath
} = {}) {
    const absolutePath = resolvePath({specifier, root});

    let module;

    try {
        module = await importModule(absolutePath)
    } catch (error) {
        throw refuse(
            TENANT_EXTRACTOR_ERROR_CODES.loadFailed,
            `tenant extractor '${specifier}' failed to load from '${absolutePath}': ${error.message}`
        )
    }

    const descriptor = exportName ? module?.[exportName] : (module?.default ?? module?.Extractor);

    if (!descriptor) {
        throw refuse(
            TENANT_EXTRACTOR_ERROR_CODES.noExport,
            `tenant extractor '${specifier}' loaded from '${absolutePath}' but exposes no ` +
            `${exportName ? `\`${exportName}\` export` : 'default export'}.`
        )
    }

    return assertDispatchableExtractor(
        descriptor,
        `tenant extractor '${specifier}' loaded from '${absolutePath}'`
    )
}

export default {
    assertDispatchableExtractor,
    loadTenantExtractor,
    resolveTenantExtractorPath
};

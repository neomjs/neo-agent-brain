import {posix as pathPosix} from 'node:path';

/**
 * Neo-free class and import-bound superclass resolution shared by repository hierarchy
 * materialization and standalone source-tree indexing.
 *
 * Resolver-owned identity: `{id, version}` in `REPOSITORY_CLASS_HIERARCHY_RESOLVER_VERSION` and
 * `REPOSITORY_SOURCE_PATH_CLASS_HIERARCHY_RESOLVER_VERSION` certifies `inferClassNameFromPath`,
 * `resolveRelativeModule`, and `resolveSuperClass` as chunk-materialization input. Any semantic
 * change to class/import resolution here MUST bump those versions so prior proof cannot name a
 * different hierarchy.
 */
export const REPOSITORY_CLASS_HIERARCHY_RESOLVER_ID                  = 'repository-class-hierarchy';
export const REPOSITORY_CLASS_HIERARCHY_RESOLVER_VERSION             = '1.0.0';
export const REPOSITORY_SOURCE_PATH_CLASS_HIERARCHY_RESOLVER_ID      = 'repository-source-path-class-hierarchy';
export const REPOSITORY_SOURCE_PATH_CLASS_HIERARCHY_RESOLVER_VERSION = '1.0.0';

/**
 * @summary Infers Neo's conventional class identity from a repository/package module path.
 * Certified by `REPOSITORY_CLASS_HIERARCHY_RESOLVER_VERSION` and
 * `REPOSITORY_SOURCE_PATH_CLASS_HIERARCHY_RESOLVER_VERSION`.
 * @param {String} modulePath
 * @returns {String|null}
 */
export function inferClassNameFromPath(modulePath) {
    const normalized = modulePath
        .replace(/^neo\.mjs\//u, '')
        .replace(/\.mjs$/u, '');

    if (normalized === 'src/Neo') {
        return 'Neo'
    }
    if (normalized.startsWith('src/')) {
        return `Neo.${normalized.slice(4).replaceAll('/', '.')}`
    }
    if (normalized.startsWith('ai/')) {
        return `Neo.ai.${normalized.slice(3).replaceAll('/', '.')}`
    }
    if (normalized.startsWith('apps/')) {
        return normalized.slice(5).replaceAll('/', '.')
    }

    return null
}

/**
 * @summary Resolves one relative module specifier against the already-scoped descriptor universe.
 * Certified by `REPOSITORY_CLASS_HIERARCHY_RESOLVER_VERSION` and
 * `REPOSITORY_SOURCE_PATH_CLASS_HIERARCHY_RESOLVER_VERSION`.
 * @param {Object} options
 * @param {String} options.sourcePath
 * @param {String} options.specifier
 * @param {Map<String, Object>} options.descriptorsByPath
 * @returns {{sourcePath: String, descriptor: Object}|null}
 */
export function resolveRelativeModule({sourcePath, specifier, descriptorsByPath}) {
    if (!specifier.startsWith('.')) {
        return null
    }

    const resolved   = pathPosix.normalize(pathPosix.join(pathPosix.dirname(sourcePath), specifier));
    const candidates = [
        resolved,
        resolved.endsWith('.mjs') ? null : `${resolved}.mjs`,
        `${resolved}/index.mjs`
    ].filter(Boolean);

    for (const candidate of candidates) {
        const descriptor = descriptorsByPath.get(candidate);

        if (descriptor) {
            return {sourcePath: candidate, descriptor}
        }
    }

    return null
}

/**
 * @summary Resolves one canonical descriptor's superclass identity without reading outside the
 * scoped repository capability.
 * Certified by `REPOSITORY_CLASS_HIERARCHY_RESOLVER_VERSION` and
 * `REPOSITORY_SOURCE_PATH_CLASS_HIERARCHY_RESOLVER_VERSION`.
 * @param {Object} options
 * @param {String} options.sourcePath
 * @param {Object} options.descriptor
 * @param {Map<String, Object>} options.descriptorsByPath
 * @returns {String|null}
 */
export function resolveSuperClass({sourcePath, descriptor, descriptorsByPath}) {
    const reference = descriptor.superClassReference;

    if (!descriptor.declaresSuper || !reference) {
        return null
    }

    if (reference.kind !== 'identifier') {
        return reference.value || null
    }

    const binding = descriptor.imports.find(item => item.localName === reference.name);

    if (!binding) {
        return reference.name
    }

    const relative = resolveRelativeModule({
        sourcePath,
        specifier: binding.source,
        descriptorsByPath
    });

    if (binding.kind === 'default' && relative?.descriptor.className) {
        return relative.descriptor.className
    }

    if (binding.kind === 'named' && binding.importedName) {
        return binding.importedName
    }

    // A route's reader excludes sibling territories by construction. The imported module may
    // still be a known Neo path (e.g. examples/... → src/container/Viewport.mjs), so infer from
    // its normalized repository path rather than the unresolved relative specifier.
    const importPath = binding.source.startsWith('.')
        ? pathPosix.normalize(pathPosix.join(pathPosix.dirname(sourcePath), binding.source))
        : binding.source;

    return inferClassNameFromPath(relative?.sourcePath || importPath) || reference.name
}

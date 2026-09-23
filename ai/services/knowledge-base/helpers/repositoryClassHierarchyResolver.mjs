import {posix as pathPosix} from 'node:path';

import SourceParser from '../parser/SourceParser.mjs';

/**
 * Resolver-owned identity. Any semantic change to class/import resolution MUST bump the version:
 * `{id, version}` is materialization input, so keeping the version while changing the algorithm
 * would let prior proof name a different hierarchy.
 */
export const REPOSITORY_CLASS_HIERARCHY_RESOLVER_ID      = 'repository-class-hierarchy';
export const REPOSITORY_CLASS_HIERARCHY_RESOLVER_VERSION = '1.0.0';
export const REPOSITORY_SOURCE_PATH_CLASS_HIERARCHY_RESOLVER_ID = 'repository-source-path-class-hierarchy';
export const REPOSITORY_SOURCE_PATH_CLASS_HIERARCHY_RESOLVER_VERSION = '1.0.0';

/**
 * @summary Creates a stable repository-hierarchy failure.
 * @param {String} code
 * @param {String} message
 * @returns {Error}
 */
function createResolverError(code, message) {
    const error = new Error(message);

    error.code = code;

    return error
}

/**
 * @summary Infers Neo's conventional class identity from a repository/package module path.
 * @param {String} modulePath
 * @returns {String|null}
 */
function inferClassNameFromPath(modulePath) {
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
 * @param {Object} options
 * @returns {{sourcePath: String, descriptor: Object}|null}
 */
function resolveRelativeModule({sourcePath, specifier, descriptorsByPath}) {
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
 * @param {Object} options
 * @returns {String|null}
 */
function resolveSuperClass({sourcePath, descriptor, descriptorsByPath}) {
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

/**
 * @summary Reads class descriptors from one exact, scoped repository revision.
 *
 * This capability is pure over `repositoryReader`: it reads no configuration, process filesystem,
 * cwd, generated artifact, or mutable registry. The profile runner supplies the already-admitted
 * territory, and `SourceParser.describeClass()` supplies the SAME class universe used to produce
 * chunks.
 *
 * @param {Object} options
 * @param {String} [options.tenantId]
 * @param {String} [options.repoSlug]
 * @param {String} [options.revision]
 * @param {Object} options.repositoryReader Exact scoped revision reader.
 * @param {Boolean} [options.rejectDuplicateClassNames=false] Preserve the flat resolver's uniqueness contract.
 * @returns {Promise<Map>} Source-path keyed descriptors.
 */
async function describeRepositoryClasses({
    tenantId,
    repoSlug,
    revision,
    repositoryReader,
    rejectDuplicateClassNames = false
} = {}) {
    if (
        !repositoryReader
        || typeof repositoryReader.listRegularEntries !== 'function'
        || typeof repositoryReader.prefetch !== 'function'
        || typeof repositoryReader.readText !== 'function'
    ) {
        throw createResolverError(
            'KB_REPOSITORY_HIERARCHY_READER_INVALID',
            'Repository hierarchy resolution requires one bound revision reader'
        )
    }

    for (const [name, supplied] of Object.entries({tenantId, repoSlug, revision})) {
        if (supplied != null && supplied !== repositoryReader[name]) {
            throw createResolverError(
                'KB_REPOSITORY_HIERARCHY_IDENTITY_MISMATCH',
                `Repository hierarchy ${name} does not match the bound reader`
            )
        }
    }

    const entries = (await repositoryReader.listRegularEntries())
        .filter(entry => entry.sourcePath.endsWith('.mjs'))
        .sort((left, right) => left.sourcePath === right.sourcePath
            ? 0
            : left.sourcePath < right.sourcePath ? -1 : 1);

    await repositoryReader.prefetch(entries.map(entry => entry.sourcePath));

    const descriptorsByPath = new Map();
    const classOwners       = new Map();

    for (const entry of entries) {
        let content;

        try {
            content = await repositoryReader.readText(entry.sourcePath);
        } catch (error) {
            if (error.code === 'KB_REVISION_READER_BINARY_BLOB') {
                continue
            }
            throw error
        }

        const descriptor = SourceParser.describeClass(content, entry.sourcePath, {strict: true});

        if (!descriptor?.className) {
            continue
        }

        const existingOwner = rejectDuplicateClassNames && classOwners.get(descriptor.className);

        if (existingOwner) {
            throw createResolverError(
                'KB_REPOSITORY_HIERARCHY_DUPLICATE_CLASS',
                `Repository class '${descriptor.className}' is declared by both '${existingOwner}' and '${entry.sourcePath}'`
            )
        }

        descriptorsByPath.set(entry.sourcePath, descriptor);
        if (rejectDuplicateClassNames) {
            classOwners.set(descriptor.className, entry.sourcePath);
        }
    }

    return descriptorsByPath
}

/**
 * @summary Derives the original flat class hierarchy from one exact, scoped repository revision.
 * Duplicate class names remain a refusal for this resolver's existing consumers and identity.
 * @param {Object} options Bound revision reader and optional identity assertions.
 * @returns {Promise<Object>} Frozen `className -> superClassName|null` map.
 */
async function resolve(options = {}) {
    const descriptorsByPath = await describeRepositoryClasses({
        ...options,
        rejectDuplicateClassNames: true
    });

    return Object.freeze(Object.fromEntries([...descriptorsByPath.entries()]
        .map(([sourcePath, descriptor]) => [
            descriptor.className,
            resolveSuperClass({sourcePath, descriptor, descriptorsByPath})
        ])
        .sort(([left], [right]) => left === right ? 0 : left < right ? -1 : 1)))
}

/**
 * @summary Resolves each class in its source file's own namespace, so separate application trees
 * may declare the same className with different superclasses without borrowing each other's parent.
 * The result has a separate identity from the original flat resolver because hierarchy values
 * participate in chunk materialization.
 * @param {Object} options Bound revision reader and optional identity assertions.
 * @returns {Promise<Object>} Frozen `sourcePath -> {className: superClassName|null}` map.
 */
async function resolveBySourcePath(options = {}) {
    const descriptorsByPath = await describeRepositoryClasses(options);

    return Object.freeze(Object.fromEntries([...descriptorsByPath.entries()]
        .map(([sourcePath, descriptor]) => [
            sourcePath,
            Object.freeze({
                [descriptor.className]: resolveSuperClass({sourcePath, descriptor, descriptorsByPath})
            })
        ])));
}

const RepositoryClassHierarchyResolver = Object.freeze({
    id     : REPOSITORY_CLASS_HIERARCHY_RESOLVER_ID,
    version: REPOSITORY_CLASS_HIERARCHY_RESOLVER_VERSION,
    resolve
});

export const RepositorySourcePathClassHierarchyResolver = Object.freeze({
    id     : REPOSITORY_SOURCE_PATH_CLASS_HIERARCHY_RESOLVER_ID,
    version: REPOSITORY_SOURCE_PATH_CLASS_HIERARCHY_RESOLVER_VERSION,
    resolve: resolveBySourcePath
});

export default RepositoryClassHierarchyResolver;

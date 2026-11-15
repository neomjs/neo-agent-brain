import SourceParser from '../parser/SourceParser.mjs';
import {
    REPOSITORY_CLASS_HIERARCHY_RESOLVER_ID,
    REPOSITORY_CLASS_HIERARCHY_RESOLVER_VERSION,
    REPOSITORY_SOURCE_PATH_CLASS_HIERARCHY_RESOLVER_ID,
    REPOSITORY_SOURCE_PATH_CLASS_HIERARCHY_RESOLVER_VERSION,
    resolveSuperClass
}                   from './classHierarchyResolution.mjs';

export {
    REPOSITORY_CLASS_HIERARCHY_RESOLVER_ID,
    REPOSITORY_CLASS_HIERARCHY_RESOLVER_VERSION,
    REPOSITORY_SOURCE_PATH_CLASS_HIERARCHY_RESOLVER_ID,
    REPOSITORY_SOURCE_PATH_CLASS_HIERARCHY_RESOLVER_VERSION
};

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

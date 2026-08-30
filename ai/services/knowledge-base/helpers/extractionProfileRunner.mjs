import micromatch from 'micromatch';

import ExtractorCatalogue from '../source/ExtractorCatalogue.mjs';
import {
    createExtractionProfileMaterializationInput,
    EXTRACTION_MATCHER_CONTRACT,
    normalizeExtractionProfile
} from './extractionProfileContract.mjs';
import {
    isRegularRevisionBlob,
    normalizeRevisionSourcePath
} from './repositoryRevisionReader.mjs';

/**
 * @summary Creates a stable runner error with bounded structured details.
 * @private
 */
function createRunnerError(code, message, details = {}) {
    const error = new Error(message);

    error.code = code;
    error.details = details;

    return error;
}

/**
 * @summary Returns a root-relative file path, or null when the file is outside the root.
 * @private
 */
function pathWithinRoot(sourcePath, rootPath) {
    if (rootPath === '.') {
        return sourcePath
    }

    if (sourcePath === rootPath) {
        return ''
    }

    return sourcePath.startsWith(`${rootPath}/`)
        ? sourcePath.slice(rootPath.length + 1)
        : null;
}

/**
 * @summary Observes whether a required root exists in the Git revision universe.
 * @private
 */
function rootExists(rootPath, entries) {
    return rootPath === '.' || entries.some(entry =>
        entry.sourcePath.startsWith(`${rootPath}/`)
        || (
            entry.sourcePath === rootPath
            && (entry.mode === '120000' || entry.mode === '160000')
        )
    );
}

/**
 * @summary Evaluates the pinned matcher contract against one root-relative path.
 * @private
 */
function matchesAny(sourcePath, patterns) {
    return patterns.some(pattern => micromatch.isMatch(
        sourcePath,
        pattern,
        EXTRACTION_MATCHER_CONTRACT.options
    ));
}

/**
 * @summary Deduplicates and orders the complete mode-bearing revision universe.
 * @private
 */
function normalizeEntries(entries) {
    const byPath = new Map();

    for (const candidate of Array.isArray(entries) ? entries : []) {
        const entry = Object.freeze({
            sourcePath: normalizeRevisionSourcePath(candidate?.sourcePath),
            mode      : String(candidate?.mode || ''),
            type      : String(candidate?.type || ''),
            oid       : String(candidate?.oid || '')
        });
        const prior = byPath.get(entry.sourcePath);

        if (prior && (
            prior.mode !== entry.mode
            || prior.type !== entry.type
            || prior.oid !== entry.oid
        )) {
            throw createRunnerError(
                'KB_EXTRACTION_REVISION_ENTRY_CONFLICT',
                `Revision path '${entry.sourcePath}' has conflicting entry identities`
            )
        }

        byPath.set(entry.sourcePath, entry);
    }

    return Object.freeze([...byPath.values()]
        .sort((left, right) => left.sourcePath === right.sourcePath
            ? 0
            : left.sourcePath < right.sourcePath ? -1 : 1));
}

/**
 * @summary Resolves all primary route candidates for one regular blob.
 * @private
 */
function resolveRouteCandidates(entry, routes) {
    const candidates         = [];
    let   explicitlyExcluded = false;

    routes.forEach((route, routeIndex) => {
        const matches = [];

        for (const root of route.territory.roots) {
            const relativePath = pathWithinRoot(entry.sourcePath, root.path);

            if (relativePath === null || relativePath === '') {
                continue;
            }

            const included = matchesAny(relativePath, route.territory.include);

            if (!included) {
                continue;
            }

            if (matchesAny(relativePath, route.territory.exclude)) {
                explicitlyExcluded = true;
                continue;
            }

            matches.push({root: root.path, relativePath});
        }

        if (matches.length > 1) {
            throw createRunnerError(
                'KB_EXTRACTION_ROUTE_ROOT_OVERLAP',
                `Revision path '${entry.sourcePath}' matches multiple roots inside one route`,
                {entry: entry.sourcePath, routeIndex, roots: matches.map(match => match.root)}
            )
        }

        if (matches.length === 1) {
            candidates.push({
                routeIndex,
                route,
                root        : matches[0].root,
                relativePath: matches[0].relativePath
            });
        }
    });

    return {candidates, explicitlyExcluded};
}

/**
 * @summary Compiles a profile against the complete mode-bearing revision universe.
 *
 * Compilation performs every root, overlap, gap, fallback, and entry-mode decision before the
 * first extractor is invoked. A late bad path can therefore never leave a partial JSONL corpus.
 *
 * @param {Object} options
 * @returns {Promise<Object>}
 */
export async function compileExtractionProfile({
    profile,
    catalogue = ExtractorCatalogue,
    repositoryReader,
    hierarchyResolver = null
} = {}) {
    if (
        !repositoryReader
        || typeof repositoryReader.listEntries !== 'function'
        || typeof repositoryReader.scope !== 'function'
    ) {
        throw createRunnerError(
            'KB_EXTRACTION_READER_REQUIRED',
            'Extraction profile compilation requires a repository-bound reader with listEntries and scope'
        )
    }

    const
        normalizedProfile = normalizeExtractionProfile(profile, {catalogue}),
        entries           = normalizeEntries(await repositoryReader.listEntries());

    const rootObservations = [];

    for (const [routeIndex, route] of normalizedProfile.routes.entries()) {
        for (const root of route.territory.roots) {
            const present = rootExists(root.path, entries);

            rootObservations.push(Object.freeze({
                routeIndex,
                path    : root.path,
                optional: root.optional,
                present
            }));

            if (!root.optional && !present) {
                throw createRunnerError(
                    'KB_EXTRACTION_REQUIRED_ROOT_MISSING',
                    `Required extraction root '${root.path}' is absent at revision ${repositoryReader.revision}`,
                    {root: root.path}
                )
            }
        }
    }

    const
        assignments   = [],
        skippedByType = [],
        skippedPaths  = [];

    for (const entry of entries) {
        if (!isRegularRevisionBlob(entry)) {
            skippedByType.push(Object.freeze({
                sourcePath: entry.sourcePath,
                mode      : entry.mode,
                type      : entry.type,
                reason    : entry.mode === '120000'
                    ? 'symlink'
                    : entry.mode === '160000'
                        ? 'gitlink'
                        : 'unsupported-entry'
            }));
            continue;
        }

        const {candidates, explicitlyExcluded} = resolveRouteCandidates(
            entry,
            normalizedProfile.routes
        );

        if (candidates.length > 1) {
            throw createRunnerError(
                'KB_EXTRACTION_ROUTE_OVERLAP',
                `Revision path '${entry.sourcePath}' matches more than one extraction route`,
                {
                    entry       : entry.sourcePath,
                    extractorIds: candidates.map(candidate => candidate.route.extractorId)
                }
            )
        }

        if (candidates.length === 1) {
            assignments.push(Object.freeze({...candidates[0], entry}));
            continue;
        }

        if (explicitlyExcluded || normalizedProfile.fallback?.action === 'exclude') {
            skippedPaths.push(Object.freeze({
                sourcePath: entry.sourcePath,
                reason    : explicitlyExcluded ? 'route-exclude' : 'fallback-exclude'
            }));
            continue;
        }

        if (normalizedProfile.fallback?.action === 'extract') {
            assignments.push(Object.freeze({
                routeIndex  : -1,
                route       : normalizedProfile.fallback,
                root        : '.',
                relativePath: entry.sourcePath,
                entry
            }));
            continue;
        }

        throw createRunnerError(
            'KB_EXTRACTION_ROUTE_GAP',
            `Revision path '${entry.sourcePath}' has no extraction route, exclusion, or fallback`,
            {entry: entry.sourcePath}
        )
    }

    const hierarchyIdentity = hierarchyResolver
        ? {id: hierarchyResolver.id, version: hierarchyResolver.version}
        : null;
    const materializationInput = createExtractionProfileMaterializationInput({
        profile: normalizedProfile,
        catalogue,
        hierarchyIdentity
    });
    const preparedHierarchies = {};

    for (const group of groupAssignments({assignments})) {
        const descriptor = catalogue.get(group.route.extractorId);

        if (!descriptor.requiresHierarchy) {
            continue
        }

        if (
            !hierarchyResolver
            || typeof hierarchyResolver.resolve !== 'function'
            || !hierarchyResolver.id
            || !hierarchyResolver.version
        ) {
            throw createRunnerError(
                'KB_EXTRACTION_HIERARCHY_RESOLVER_REQUIRED',
                `Extractor '${descriptor.extractorId}' requires an identity-bearing hierarchy resolver`
            )
        }

        const
            scopedReader = await repositoryReader.scope(
                group.assignments.map(assignment => assignment.entry)
            ),
            territory = createInvocationTerritory(group, group.assignments),
            hierarchy = await hierarchyResolver.resolve({
                tenantId        : scopedReader.tenantId,
                repoSlug        : scopedReader.repoSlug,
                revision        : scopedReader.revision,
                repositoryReader: scopedReader,
                territory,
                options         : group.route.options || {}
            });

        if (!hierarchy || typeof hierarchy !== 'object' || Array.isArray(hierarchy)) {
            throw createRunnerError(
                'KB_EXTRACTION_HIERARCHY_INVALID',
                `Hierarchy resolver returned an invalid map for '${descriptor.extractorId}'`
            )
        }

        preparedHierarchies[group.routeIndex] = Object.freeze({...hierarchy});
    }

    return Object.freeze({
        catalogue,
        profile    : normalizedProfile,
        materializationInput,
        assignments: Object.freeze(assignments.sort((left, right) => {
            const routeOrder = left.routeIndex - right.routeIndex;

            return routeOrder || (
                left.entry.sourcePath === right.entry.sourcePath
                    ? 0
                    : left.entry.sourcePath < right.entry.sourcePath ? -1 : 1
            );
        })),
        entries,
        repositoryReader,
        rootObservations   : Object.freeze(rootObservations),
        skippedByType      : Object.freeze(skippedByType),
        skippedPaths       : Object.freeze(skippedPaths),
        hierarchyResolver,
        preparedHierarchies: Object.freeze(preparedHierarchies)
    });
}

/**
 * @summary Groups canonical assignments by route without reordering paths.
 * @private
 */
function groupAssignments(compiledProfile) {
    const groups = [];

    for (const assignment of compiledProfile.assignments) {
        const key   = assignment.routeIndex;
        let   group = groups.find(item => item.routeIndex === key);

        if (!group) {
            group = {
                routeIndex : key,
                route      : assignment.route,
                assignments: []
            };
            groups.push(group);
        }

        group.assignments.push(assignment);
    }

    return groups.sort((left, right) => left.routeIndex - right.routeIndex);
}

/**
 * @summary Binds planned assignments to the canonical route territory.
 * @private
 */
function createInvocationTerritory(group, assignments) {
    return Object.freeze({
        ...(group.route.territory || {
            roots  : Object.freeze([{path: '.', optional: false}]),
            include: Object.freeze(['**/*']),
            exclude: Object.freeze([])
        }),
        assignments: Object.freeze(assignments)
    });
}

/**
 * @summary Applies the descriptor's delta-safety capability to one route replay.
 * @private
 */
function selectAssignments({assignments, descriptor, changedPaths}) {
    if (!changedPaths) {
        return assignments
    }

    if (!descriptor.deltaSafe) {
        return changedPaths.size ? assignments : []
    }

    return assignments.filter(assignment => changedPaths.has(assignment.entry.sourcePath));
}

/**
 * @summary Executes one already-validatable repository profile in canonical route/path order.
 *
 * Legacy `SourceRegistry` is intentionally absent from this dependency graph. Descriptors are
 * invocation values from the immutable catalogue, and each receives a reader scoped to the paths
 * the complete preflight assigned.
 *
 * @param {Object} options
 * @returns {Promise<Object>}
 */
export async function runExtractionProfile({
    profile,
    compiledProfile,
    catalogue = ExtractorCatalogue,
    repositoryReader,
    hierarchyResolver = null,
    changedPaths,
    writeStream,
    createHashFn
} = {}) {
    if (!writeStream || typeof writeStream.write !== 'function' || typeof createHashFn !== 'function') {
        throw createRunnerError(
            'KB_EXTRACTION_OUTPUT_INVALID',
            'Extraction profile execution requires writeStream.write and createHashFn'
        )
    }

    const compiled = compiledProfile || await compileExtractionProfile({
        profile,
        catalogue,
        repositoryReader,
        hierarchyResolver
    });

    if (
        compiledProfile
        && repositoryReader
        && repositoryReader !== compiled.repositoryReader
    ) {
        throw createRunnerError(
            'KB_EXTRACTION_COMPILED_READER_MISMATCH',
            'A compiled extraction profile cannot execute against a different repository reader'
        )
    }
    if (
        compiledProfile
        && hierarchyResolver
        && hierarchyResolver !== compiled.hierarchyResolver
    ) {
        throw createRunnerError(
            'KB_EXTRACTION_COMPILED_HIERARCHY_MISMATCH',
            'A compiled extraction profile cannot execute against a different hierarchy resolver'
        )
    }

    const activeCatalogue = compiled.catalogue || catalogue;
    const activeReader    = repositoryReader || compiled.repositoryReader;

    if (!activeReader || typeof activeReader.scope !== 'function') {
        throw createRunnerError(
            'KB_EXTRACTION_READER_REQUIRED',
            'Extraction profile execution requires the reader used during compilation'
        )
    }
    const changed = Array.isArray(changedPaths)
        ? new Set(changedPaths.map(normalizeRevisionSourcePath))
        : null;
    const
        routeResults          = [],
        yieldedSourcePaths    = new Set(),
        extractorSkippedPaths = [];

    for (const group of groupAssignments(compiled)) {
        const
            descriptor = activeCatalogue.get(group.route.extractorId),
            selected   = selectAssignments({
                assignments : group.assignments,
                descriptor,
                changedPaths: changed
            });

        if (!selected.length) {
            continue;
        }

        const entries      = selected.map(assignment => assignment.entry);
        const scopedReader = await activeReader.scope(entries);

        await scopedReader.prefetch(entries.map(entry => entry.sourcePath));

        const result = await descriptor.extract({
            context: Object.freeze({
                tenantId         : scopedReader.tenantId,
                repoSlug         : scopedReader.repoSlug,
                revision         : scopedReader.revision,
                repositoryReader : scopedReader,
                territory        : createInvocationTerritory(group, selected),
                hierarchyResolver: compiled.hierarchyResolver || hierarchyResolver,
                hierarchy        : compiled.preparedHierarchies?.[group.routeIndex]
            }),
            options     : group.route.options || {},
            writeStream,
            createHashFn
        });

        const
            count = Number.isSafeInteger(result?.count) && result.count >= 0
                ? result.count
                : Number.isSafeInteger(result) && result >= 0
                    ? result
                    : null,
            yielded = Array.isArray(result?.yieldedSourcePaths)
                ? result.yieldedSourcePaths
                : [],
            selectedPaths = new Set(entries.map(entry => entry.sourcePath));

        if (count === null) {
            throw createRunnerError(
                'KB_EXTRACTION_RESULT_INVALID',
                `Extractor '${descriptor.extractorId}' returned an invalid count`
            )
        }

        yielded.forEach(sourcePath => {
            const normalized = normalizeRevisionSourcePath(sourcePath);

            if (!selectedPaths.has(normalized)) {
                throw createRunnerError(
                    'KB_EXTRACTION_RESULT_OUTSIDE_SCOPE',
                    `Extractor '${descriptor.extractorId}' yielded path '${normalized}' outside its territory`
                )
            }

            yieldedSourcePaths.add(normalized);
        });
        for (const skipped of Array.isArray(result?.skippedSourcePaths) ? result.skippedSourcePaths : []) {
            const sourcePath = normalizeRevisionSourcePath(skipped?.sourcePath);

            if (!selectedPaths.has(sourcePath)) {
                throw createRunnerError(
                    'KB_EXTRACTION_RESULT_OUTSIDE_SCOPE',
                    `Extractor '${descriptor.extractorId}' skipped path '${sourcePath}' outside its territory`
                )
            }

            extractorSkippedPaths.push(Object.freeze({
                sourcePath,
                reason    : String(skipped?.reason || 'extractor-skip')
            }));
        }
        routeResults.push(Object.freeze({
            extractorId    : descriptor.extractorId,
            count,
            sourcePathCount: selected.length
        }));
    }

    return Object.freeze({
        count                : routeResults.reduce((sum, result) => sum + result.count, 0),
        materializationInput : compiled.materializationInput,
        rootObservations     : compiled.rootObservations,
        routeResults         : Object.freeze(routeResults),
        skippedByType        : compiled.skippedByType,
        skippedPaths         : compiled.skippedPaths,
        extractorSkippedPaths: Object.freeze(extractorSkippedPaths
            .sort((left, right) => left.sourcePath === right.sourcePath
                ? 0
                : left.sourcePath < right.sourcePath ? -1 : 1)),
        yieldedSourcePaths: Object.freeze([...yieldedSourcePaths].sort())
    });
}

export default {
    compileExtractionProfile,
    runExtractionProfile
};

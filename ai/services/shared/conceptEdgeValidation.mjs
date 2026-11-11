import fs              from 'fs';
import path            from 'path';
import {createRequire} from 'module';
import {fileURLToPath} from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const neoRootDir = path.resolve(__dirname, '../../../');
const require    = createRequire(import.meta.url);

export const DEFAULT_FILESYSTEM_IGNORE_PATTERNS = Object.freeze([
    'node_modules', 'dist', '.git', '.DS_Store', 'build', '.env', '.neo-ai-data',
    'docs/output', 'tmp', '.idea', '.gemini', '.codex', '.claude', '.agents',
    'resources/images', 'resources/fonts'
]);

export const DEFAULT_FILESYSTEM_IGNORE_EXTS = Object.freeze([
    '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico',
    '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.avi',
    '.map', '.pdf', '.zip', '.tar', '.gz'
]);

export const SPLIT_TREE_ROOTS = Object.freeze([
    Object.freeze({name: 'neo-agent-brain', dir: neoRootDir}),
    Object.freeze({
        name   : 'neo.mjs',
        dir    : path.dirname(require.resolve('neo.mjs/package.json')),
        version: require('neo.mjs/package.json').version
    })
]);

export const CONCEPT_EDGE_TYPES = Object.freeze({
    ANALOGOUS_TO  : 'ANALOGOUS_TO',
    EXEMPLIFIED_BY: 'EXEMPLIFIED_BY',
    EXPLAINED_BY  : 'EXPLAINED_BY',
    IMPLEMENTED_BY: 'IMPLEMENTED_BY',
    PARENT_CONCEPT: 'PARENT_CONCEPT',
    REQUIRES      : 'REQUIRES'
});

export const CONCEPT_EDGE_TYPE_SET = new Set(Object.values(CONCEPT_EDGE_TYPES));

const DECISION_REFERENCE_PATTERNS = Object.freeze([
    /(?:^|[\s(])(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+\b/,
    /\bGH-\d+\b/i,
    /https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull|discussions)\/\d+\b/i,
    /(?:^|[\s(#])adr:[A-Za-z0-9][A-Za-z0-9_.-]*\b/i,
    /\bADR[-\s]?\d{1,4}\b/i,
    /(?:^|[\s/(])\d{4}-[a-z0-9][a-z0-9-]*(?:\.md)?\b/i
]);

/**
 * @summary Builds the canonical Native Edge Graph `file-<path>` node ID for a repository-relative path.
 * @param {String} relativePath
 * @returns {String}
 */
export function getRepositoryNodeId(relativePath) {
    return `file-${String(relativePath).replace(/\\/g, '/')}`;
}

/**
 * @summary Checks whether a normalized repository-relative path is excluded from filesystem projection.
 * @param {String} relativePath
 * @param {Boolean} [isDirectory=false]
 * @param {Object} [options={}]
 * @returns {Boolean}
 */
export function isIgnoredRepositoryPath(
    relativePath,
    isDirectory = false,
    {
        ignorePatterns = DEFAULT_FILESYSTEM_IGNORE_PATTERNS,
        ignoreExts     = DEFAULT_FILESYSTEM_IGNORE_EXTS
    } = {}
) {
    if (ignorePatterns.some(pattern => relativePath === pattern || relativePath.startsWith(pattern + '/'))) {
        return true;
    }

    return !isDirectory && ignoreExts.includes(path.extname(relativePath).toLowerCase());
}

/**
 * @summary Resolves an author-facing repository file reference within a single root directory.
 * @param {String} relativePath
 * @param {String} [rootDir=neoRootDir]
 * @param {Object} [options={}]
 * @returns {Object}
 */
export function resolveRepositoryFileReference(relativePath, rootDir = neoRootDir, options = {}) {
    const rawPath = typeof relativePath === 'string' ? relativePath.trim().replace(/\\/g, '/') : '';

    if (!rawPath || path.isAbsolute(rawPath) || /^[A-Za-z]:\//.test(rawPath)) {
        return {
            valid : false,
            code  : 'INVALID_FILE_REFERENCE',
            reason: 'File references must be non-empty repository-relative paths.'
        };
    }

    const
        normalizedPath = path.posix.normalize(rawPath),
        resolvedRoot   = path.resolve(rootDir),
        absolutePath   = path.resolve(resolvedRoot, normalizedPath),
        containment    = path.relative(resolvedRoot, absolutePath);

    if (
        normalizedPath === '.'
        || normalizedPath === '..'
        || normalizedPath.startsWith('../')
        || containment === '..'
        || containment.startsWith(`..${path.sep}`)
        || path.isAbsolute(containment)
    ) {
        return {
            valid       : false,
            code        : 'OUTSIDE_REPOSITORY',
            reason      : `File reference escapes the repository root: ${rawPath}`,
            relativePath: normalizedPath
        };
    }

    if (isIgnoredRepositoryPath(normalizedPath, false, options)) {
        return {
            valid       : false,
            code        : 'IGNORED_FILE',
            reason      : `File reference is excluded from filesystem projection: ${normalizedPath}`,
            relativePath: normalizedPath
        };
    }

    let stat;

    try {
        stat = fs.lstatSync(absolutePath);
    } catch {
        return {
            valid       : false,
            code        : 'MISSING_FILE',
            reason      : `Repository file does not exist: ${normalizedPath}`,
            absolutePath,
            relativePath: normalizedPath
        };
    }

    if (!stat.isFile()) {
        return {
            valid       : false,
            code        : 'NOT_A_FILE',
            reason      : `Repository reference is not a regular file: ${normalizedPath}`,
            absolutePath,
            relativePath: normalizedPath
        };
    }

    const
        authoredSegments  = normalizedPath.split('/'),
        canonicalSegments = [];

    let currentDirectory = resolvedRoot;

    try {
        for (let index = 0; index < authoredSegments.length; index++) {
            const
                segment      = authoredSegments[index],
                entries      = fs.readdirSync(currentDirectory),
                exactEntry   = entries.find(entry => entry === segment),
                matchingCase = exactEntry || entries.find(entry => entry.toLowerCase() === segment.toLowerCase());

            if (!exactEntry) {
                const canonicalPath = [
                    ...canonicalSegments,
                    matchingCase || segment,
                    ...authoredSegments.slice(index + 1)
                ].join('/');

                return {
                    valid       : false,
                    code        : 'NON_CANONICAL_FILE_REFERENCE',
                    reason      : `File reference must use the repository's exact path casing: ${canonicalPath}`,
                    absolutePath,
                    relativePath: normalizedPath
                };
            }

            canonicalSegments.push(exactEntry);
            currentDirectory = path.join(currentDirectory, exactEntry);
        }
    } catch (error) {
        return {
            valid       : false,
            code        : 'CANONICAL_PATH_UNVERIFIED',
            reason      : `Could not verify repository path casing for ${normalizedPath}: ${error.message}`,
            absolutePath,
            relativePath: normalizedPath
        };
    }

    const
        realRoot              = fs.realpathSync(resolvedRoot),
        realPath              = fs.realpathSync(absolutePath),
        realContainment       = path.relative(realRoot, realPath),
        canonicalRelativePath = realContainment.replace(/\\/g, '/');

    if (realContainment === '..' || realContainment.startsWith(`..${path.sep}`) || path.isAbsolute(realContainment)) {
        return {
            valid       : false,
            code        : 'OUTSIDE_REPOSITORY',
            reason      : `File reference resolves outside the repository root: ${normalizedPath}`,
            absolutePath,
            relativePath: normalizedPath
        };
    }

    if (canonicalRelativePath !== normalizedPath) {
        return {
            valid       : false,
            code        : 'NON_CANONICAL_FILE_REFERENCE',
            reason      : `File reference must use the repository's canonical path: ${canonicalRelativePath}`,
            absolutePath,
            relativePath: normalizedPath
        };
    }

    return {
        valid       : true,
        code        : null,
        reason      : null,
        absolutePath,
        nodeId      : getRepositoryNodeId(normalizedPath),
        relativePath: normalizedPath
    };
}

/**
 * @summary Resolves a repository file reference across the ordered split-tree roots.
 * @param {String} relativePath
 * @param {Object[]} [roots=SPLIT_TREE_ROOTS]
 * @param {Object} [options={}]
 * @returns {Object}
 */
export function resolveSplitTreeFileReference(relativePath, roots = SPLIT_TREE_ROOTS, options = {}) {
    const
        resolutions = roots.map(root => ({
            root,
            resolution: resolveRepositoryFileReference(relativePath, root.dir, options)
        })),
        resolved    = resolutions.filter(({resolution}) => resolution.valid);

    if (resolved.length > 1) {
        return {
            valid       : false,
            code        : 'AMBIGUOUS_FILE',
            reason      : `File reference exists in more than one repository root (${resolved.map(({root}) => root.name).join(', ')}): ${resolved[0].resolution.relativePath}`,
            relativePath: resolved[0].resolution.relativePath
        };
    }

    if (resolved.length === 0) {
        return resolutions[0].resolution;
    }

    const {root, resolution} = resolved[0];

    return {
        ...resolution,
        root: root.name,
        ...(root.version ? {rootVersion: root.version} : {})
    };
}

/**
 * @summary Validates a concept edge's `(type, target)` pair for both store import and graph projection.
 * @param {Object} edge
 * @param {Object} [options={}]
 * @param {Function} [options.resolveSplitTree=resolveSplitTreeFileReference]
 * @returns {Object}
 */
export function validateConceptEdgeTarget(edge, {resolveSplitTree = resolveSplitTreeFileReference} = {}) {
    if (!CONCEPT_EDGE_TYPE_SET.has(edge?.type)) {
        return {
            valid : false,
            code  : 'UNSUPPORTED_EDGE_TYPE',
            type  : edge?.type ?? null,
            target: edge?.target ?? null,
            reason: `Unsupported concept edge type: ${String(edge?.type)}`
        };
    }

    if (typeof edge?.target !== 'string' || edge.target.trim().length === 0) {
        return {
            valid : false,
            code  : 'INVALID_EDGE_TARGET',
            type  : edge.type,
            target: edge?.target ?? null,
            reason: 'Concept edge target must be a non-empty string.'
        };
    }

    const trimmedTarget = edge.target.trim();

    if (trimmedTarget.startsWith('file:')) {
        const resolution = resolveSplitTree(trimmedTarget.slice('file:'.length));

        if (!resolution?.valid) {
            return {
                valid : false,
                code  : resolution?.code || 'INVALID_FILE_REFERENCE',
                type  : edge.type,
                target: edge.target,
                reason: resolution?.reason || 'Invalid file reference.'
            };
        }

        return {
            valid        : true,
            kind         : 'file',
            type         : edge.type,
            storedTarget : `file:${resolution.relativePath}`,
            runtimeTarget: resolution.nodeId,
            root         : resolution.root,
            rootVersion  : resolution.rootVersion ?? null,
            resolution
        };
    }

    if (trimmedTarget.startsWith('ext:')) {
        const externalSlug = trimmedTarget.slice('ext:'.length).trim();

        if (externalSlug.length === 0) {
            return {
                valid : false,
                code  : 'INVALID_EDGE_TARGET',
                type  : edge.type,
                target: edge.target,
                reason: 'External concept edge target must include an identifier after ext:.'
            };
        }

        const normalizedTarget = `ext:${externalSlug}`;

        return {
            valid        : true,
            kind         : 'ext',
            type         : edge.type,
            storedTarget : normalizedTarget,
            runtimeTarget: normalizedTarget,
            root         : null,
            rootVersion  : null
        };
    }

    return {
        valid        : true,
        kind         : 'concept',
        type         : edge.type,
        storedTarget : trimmedTarget,
        runtimeTarget: trimmedTarget,
        root         : null,
        rootVersion  : null
    };
}

/**
 * @summary Verifies that a removal decision string names an issue, pull request, or ADR.
 * @param {*} decision
 * @returns {Boolean}
 */
export function isValidDecisionReference(decision) {
    if (typeof decision !== 'string') {
        return false;
    }

    const trimmed = decision.trim();

    if (trimmed.length === 0) {
        return false;
    }

    return DECISION_REFERENCE_PATTERNS.some(pattern => pattern.test(trimmed));
}

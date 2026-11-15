import fs                   from 'node:fs';
import path, {posix as pathPosix} from 'node:path';
import {inspectSourceModule} from './inspectSourceModule.mjs';

export const CODE_INDEX_EXTRACTOR_VERSION = '1.0.0';

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules']);

/**
 * @summary Converts platform path separators to POSIX forward slashes.
 * @param {String} value
 * @returns {String}
 */
function toPosixPath(value) {
    return value.split(path.sep).join('/')
}

/**
 * @summary Creates a coded error for source-tree index failures.
 * @param {String} code
 * @param {String} message
 * @param {Object} [details]
 * @returns {Error}
 */
function createIndexError(code, message, details = undefined) {
    const error = new Error(message);

    error.code = code;
    if (details !== undefined) {
        error.details = details;
    }

    return error
}

/**
 * @summary Infers Neo's conventional class identity from a repository/package module path.
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
 * @param {Object} options
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
 * @param {Object} options
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

    const importPath = binding.source.startsWith('.')
        ? pathPosix.normalize(pathPosix.join(pathPosix.dirname(sourcePath), binding.source))
        : binding.source;

    return inferClassNameFromPath(relative?.sourcePath || importPath) || reference.name
}

/**
 * @summary Resolves a git checkout's commit SHA and origin URL purely via filesystem reads.
 * @param {String} startDir Absolute directory inside or equal to a checkout.
 * @returns {{repoRoot: String|null, commit: String|null, origin: String|null}}
 */
function readGitProvenance(startDir) {
    let current = startDir;

    while (true) {
        if (path.basename(current) === 'node_modules') {
            return {repoRoot: null, commit: null, origin: null}
        }

        const dotGitPath = path.join(current, '.git');

        if (fs.existsSync(dotGitPath)) {
            try {
                const stat = fs.statSync(dotGitPath);
                let gitDir = dotGitPath;

                if (stat.isFile()) {
                    const pointer = fs.readFileSync(dotGitPath, 'utf8').trim();
                    const match   = /^gitdir:\s*(.+)$/u.exec(pointer);
                    if (match) {
                        gitDir = path.resolve(current, match[1].trim());
                    }
                }

                const commonDirFile = path.join(gitDir, 'commondir');
                const commonDir     = fs.existsSync(commonDirFile)
                    ? path.resolve(gitDir, fs.readFileSync(commonDirFile, 'utf8').trim())
                    : gitDir;

                let commit = null;
                const headPath = path.join(gitDir, 'HEAD');

                if (fs.existsSync(headPath)) {
                    const headText = fs.readFileSync(headPath, 'utf8').trim();
                    const refMatch = /^ref:\s*(.+)$/u.exec(headText);

                    if (refMatch) {
                        const refName       = refMatch[1].trim();
                        const localRefPath  = path.join(gitDir, refName);
                        const commonRefPath = path.join(commonDir, refName);

                        if (fs.existsSync(localRefPath)) {
                            commit = fs.readFileSync(localRefPath, 'utf8').trim() || null;
                        } else if (fs.existsSync(commonRefPath)) {
                            commit = fs.readFileSync(commonRefPath, 'utf8').trim() || null;
                        } else {
                            const packedPath = path.join(commonDir, 'packed-refs');
                            if (fs.existsSync(packedPath)) {
                                const packedLines = fs.readFileSync(packedPath, 'utf8').split(/\r?\n/u);
                                for (const line of packedLines) {
                                    if (!line || line.startsWith('#') || line.startsWith('^')) {
                                        continue
                                    }
                                    const [sha, packedRef] = line.trim().split(/\s+/u);
                                    if (packedRef === refName && sha) {
                                        commit = sha;
                                        break;
                                    }
                                }
                            }
                        }
                    } else if (/^[0-9a-f]{40}$/iu.test(headText)) {
                        commit = headText;
                    }
                }

                let origin = null;
                const configPath = path.join(commonDir, 'config');

                if (fs.existsSync(configPath)) {
                    const lines = fs.readFileSync(configPath, 'utf8').split(/\r?\n/u);
                    let inOrigin = false;

                    for (const rawLine of lines) {
                        const line = rawLine.trim();
                        if (line.startsWith('[') && line.endsWith(']')) {
                            inOrigin = /^\[remote\s+"origin"\]$/iu.test(line);
                            continue
                        }
                        if (inOrigin) {
                            const urlMatch = /^url\s*=\s*(.+)$/u.exec(line);
                            if (urlMatch) {
                                origin = urlMatch[1].trim();
                                break;
                            }
                        }
                    }
                }

                return {repoRoot: current, commit, origin}
            } catch {
                return {repoRoot: current, commit: null, origin: null}
            }
        }

        const parent = path.dirname(current);
        if (parent === current) {
            return {repoRoot: null, commit: null, origin: null}
        }
        current = parent;
    }
}

/**
 * @summary Collects `.mjs` files recursively under `absRoot` in deterministic path order.
 * @param {String} absRoot
 * @param {String} baseDir
 * @returns {Array<{absPath: String, sourcePath: String}>}
 */
function collectMjsFiles(absRoot, baseDir) {
    const collected = [];

    function visit(dirPath) {
        const entries = fs.readdirSync(dirPath, {withFileTypes: true});

        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!IGNORED_DIRECTORIES.has(entry.name)) {
                    visit(path.join(dirPath, entry.name));
                }
            } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
                const absPath    = path.join(dirPath, entry.name);
                const sourcePath = toPosixPath(path.relative(baseDir, absPath));
                collected.push({absPath, sourcePath});
            }
        }
    }

    visit(absRoot);
    collected.sort((left, right) => left.sourcePath < right.sourcePath ? -1 : left.sourcePath > right.sourcePath ? 1 : 0);

    return collected
}

/**
 * @summary Resolves one mixin reference using the shared import/path resolver.
 * @param {Object} options
 * @returns {String|null}
 */
function resolveMixinReference({sourcePath, mixinRef, imports, descriptorsByPath}) {
    if (!mixinRef) {
        return null
    }

    if (mixinRef.kind === 'literal') {
        return mixinRef.value || null
    }

    return resolveSuperClass({
        sourcePath,
        descriptor: {
            declaresSuper      : true,
            superClassReference: mixinRef,
            imports
        },
        descriptorsByPath
    })
}

/**
 * @summary Walks a local directory of `.mjs` modules and builds a resolved Neo-aware code index.
 * @param {Object} options
 * @param {String} options.rootDir Directory to index.
 * @returns {Object} Plain resolved index structure.
 */
export function indexSourceTree({rootDir} = {}) {
    if (!rootDir || typeof rootDir !== 'string') {
        throw createIndexError('CODE_INDEX_ROOT_NOT_FOUND', 'Code index requires a non-empty rootDir path.')
    }

    const absRoot = path.resolve(rootDir);
    let stat;

    try {
        stat = fs.statSync(absRoot);
    } catch {
        throw createIndexError('CODE_INDEX_ROOT_NOT_FOUND', `Code index root directory not found: ${rootDir}`, {
            rootDir: absRoot
        })
    }

    if (!stat.isDirectory()) {
        throw createIndexError('CODE_INDEX_ROOT_NOT_FOUND', `Code index root is not a directory: ${rootDir}`, {
            rootDir: absRoot
        })
    }

    const startedAt = performance.now();
    const gitMeta   = readGitProvenance(absRoot);
    const baseDir   = (gitMeta.repoRoot && (absRoot === gitMeta.repoRoot || absRoot.startsWith(`${gitMeta.repoRoot}${path.sep}`)))
        ? gitMeta.repoRoot
        : path.basename(absRoot) === 'src'
            ? path.dirname(absRoot)
            : absRoot;
    const rootPrefix = toPosixPath(path.relative(baseDir, absRoot));
    const files      = collectMjsFiles(absRoot, baseDir);

    const descriptorsByPath = new Map();
    const rawClassesByName  = new Map();
    const unresolved        = [];

    for (const file of files) {
        const content   = fs.readFileSync(file.absPath, 'utf8');
        const inspected = inspectSourceModule(content, file.sourcePath, {
            strict      : false,
            extractCalls: true
        });

        if (inspected.parseFailed) {
            unresolved.push(Object.freeze({
                kind      : 'parse',
                sourcePath: file.sourcePath,
                line      : 1,
                className : null,
                methodName: null,
                receiver  : null,
                callee    : null,
                target    : file.sourcePath,
                reason    : 'parse-failed',
                message   : inspected.message
            }));
            continue
        }

        if (!inspected.className) {
            continue
        }

        descriptorsByPath.set(file.sourcePath, inspected);

        if (rawClassesByName.has(inspected.className)) {
            unresolved.push(Object.freeze({
                kind      : 'class',
                sourcePath: file.sourcePath,
                line      : 1,
                className : inspected.className,
                methodName: null,
                receiver  : null,
                callee    : null,
                target    : inspected.className,
                reason    : 'duplicate-class-name'
            }));
            continue
        }

        rawClassesByName.set(inspected.className, {
            sourcePath: file.sourcePath,
            inspected
        });
    }

    const classEntries = new Map();
    let declaredSuperCount = 0;
    let resolvedSuperCount = 0;

    for (const [className, {sourcePath, inspected}] of rawClassesByName.entries()) {
        const superClass         = resolveSuperClass({sourcePath, descriptor: inspected, descriptorsByPath});
        const superClassResolved = Boolean(superClass && rawClassesByName.has(superClass));

        if (inspected.declaresSuper) {
            declaredSuperCount++;
            if (superClassResolved) {
                resolvedSuperCount++;
            } else {
                unresolved.push(Object.freeze({
                    kind      : 'extends',
                    sourcePath,
                    line      : 1,
                    className,
                    methodName: null,
                    receiver  : null,
                    callee    : null,
                    target    : superClass || '(anonymous)',
                    reason    : superClass ? 'superclass-not-in-tree' : 'superclass-unresolved'
                }));
            }
        }

        const resolvedMixins = [];
        const seenMixins     = new Set();

        for (const mixinRef of inspected.mixins) {
            const mixinName = resolveMixinReference({
                sourcePath,
                mixinRef,
                imports: inspected.imports,
                descriptorsByPath
            });

            if (mixinName && rawClassesByName.has(mixinName)) {
                if (!seenMixins.has(mixinName)) {
                    seenMixins.add(mixinName);
                    resolvedMixins.push(mixinName);
                }
            } else {
                unresolved.push(Object.freeze({
                    kind      : 'mixin',
                    sourcePath,
                    line      : mixinRef.line || 1,
                    className,
                    methodName: null,
                    receiver  : null,
                    callee    : null,
                    target    : mixinName || mixinRef.value || mixinRef.name || '(unknown)',
                    reason    : 'mixin-not-in-tree'
                }));
            }
        }

        classEntries.set(className, {
            className,
            ntype             : inspected.ntype,
            sourcePath,
            declaresSuper     : inspected.declaresSuper,
            superClass,
            superClassResolved,
            mixins            : resolvedMixins,
            ownConfigs        : inspected.configs,
            rawMethods        : inspected.methods
        });
    }

    const extendsSpineCache = new Map();

    function getExtendsSpine(className) {
        if (extendsSpineCache.has(className)) {
            return extendsSpineCache.get(className)
        }

        const spine = [];
        const seen  = new Set();
        let current = className;

        while (current && classEntries.has(current) && !seen.has(current)) {
            seen.add(current);
            const entry = classEntries.get(current);
            spine.push(entry);
            current = entry.superClassResolved ? entry.superClass : null;
        }

        extendsSpineCache.set(className, spine);
        return spine
    }

    const fullLookupCache = new Map();

    function getLookupChain(className) {
        if (fullLookupCache.has(className)) {
            return fullLookupCache.get(className)
        }

        const spine    = getExtendsSpine(className);
        const spineSet = new Set(spine.map(item => item.className));
        const ordered  = [];
        const emitted  = new Set();

        function appendMixinBranch(mixinName) {
            if (!mixinName || emitted.has(mixinName) || spineSet.has(mixinName)) {
                return
            }

            const mixinEntry = classEntries.get(mixinName);
            if (!mixinEntry) {
                return
            }

            emitted.add(mixinName);
            ordered.push(mixinEntry);

            for (const nestedMixin of mixinEntry.mixins) {
                appendMixinBranch(nestedMixin);
            }

            if (mixinEntry.superClassResolved) {
                appendMixinBranch(mixinEntry.superClass);
            }
        }

        for (const spineEntry of spine) {
            if (!emitted.has(spineEntry.className)) {
                emitted.add(spineEntry.className);
                ordered.push(spineEntry);
            }

            for (const mixinName of spineEntry.mixins) {
                appendMixinBranch(mixinName);
            }
        }

        fullLookupCache.set(className, ordered);
        return ordered
    }

    function getSuperLookupChain(entry) {
        if (!entry.superClassResolved || !entry.superClass) {
            return []
        }

        return getLookupChain(entry.superClass)
    }

    function getOverrideCandidatesChain(entry) {
        const superChain = getSuperLookupChain(entry);
        const seen       = new Set(superChain.map(item => item.className));
        const ownMixins  = [];

        for (const mixinName of entry.mixins) {
            for (const item of getLookupChain(mixinName)) {
                if (!seen.has(item.className)) {
                    seen.add(item.className);
                    ownMixins.push(item);
                }
            }
        }

        return [...ownMixins, ...superChain]
    }

    const effectiveConfigsByClass = new Map();
    const chainSetByClass         = new Map();

    for (const className of classEntries.keys()) {
        const lookupChain = getLookupChain(className);
        chainSetByClass.set(className, new Set(lookupChain.map(item => item.className)));

        const configMap = new Map();

        for (let idx = lookupChain.length - 1; idx >= 0; idx--) {
            const owner = lookupChain[idx];

            for (const cfg of owner.ownConfigs) {
                const prev = configMap.get(cfg.name);

                configMap.set(cfg.name, {
                    name         : cfg.name,
                    reactive     : Boolean(prev?.reactive || cfg.reactive),
                    reactiveOwner: prev?.reactiveOwner ?? (cfg.reactive ? owner.className : null),
                    reactiveLine : prev?.reactiveLine ?? (cfg.reactive ? cfg.line : null),
                    declaredOn   : owner.className,
                    declaredKey  : cfg.declaredKey,
                    line         : cfg.line
                });
            }
        }

        effectiveConfigsByClass.set(className, configMap);
    }

    const hooks            = [];
    const hooksByMethodKey = new Map();
    const calls            = [];
    const callsByTarget    = new Map();
    const overridesByBase  = new Map();
    const allConfigWrites  = [];
    const classes          = {};

    const callPairs = {
        this : {total: 0, bound: 0},
        me   : {total: 0, bound: 0},
        super: {total: 0, bound: 0}
    };
    let totalHookMethods = 0;
    let boundHookMethods = 0;

    for (const entry of classEntries.values()) {
        const lookupChain       = getLookupChain(entry.className);
        const superChain        = getSuperLookupChain(entry);
        const overrideChain     = getOverrideCandidatesChain(entry);
        const effectiveConfigs  = effectiveConfigsByClass.get(entry.className);
        const hooksByConfigName = new Map();
        const finalizedMethods  = [];

        for (const rawMethod of entry.rawMethods) {
            const methodKey = `${entry.className}#${rawMethod.name}`;
            const ancestorOwner = overrideChain.find(candidate => candidate.rawMethods.some(
                candidateMethod => candidateMethod.name === rawMethod.name
                    && candidateMethod.static === rawMethod.static
                    && candidateMethod.kind === rawMethod.kind
            ));
            const overrides     = Boolean(ancestorOwner);
            const overridesFrom = ancestorOwner ? `${ancestorOwner.className}#${rawMethod.name}` : null;
            const callsSuper    = rawMethod.calls.some(
                call => !call.computed
                    && call.receiver === 'super'
                    && (call.callee === rawMethod.name || (rawMethod.kind === 'constructor' && call.callee === 'constructor'))
            );

            if (overridesFrom) {
                let bucket = overridesByBase.get(overridesFrom);
                if (!bucket) {
                    bucket = [];
                    overridesByBase.set(overridesFrom, bucket);
                }
                bucket.push(Object.freeze({
                    className : entry.className,
                    methodName: rawMethod.name,
                    sourcePath: entry.sourcePath,
                    line      : rawMethod.line,
                    callsSuper
                }));
            }

            let finalizedHook = null;

            if (rawMethod.hook) {
                totalHookMethods++;
                const cfgInfo = effectiveConfigs.get(rawMethod.hook.configName);

                if (cfgInfo?.reactive) {
                    boundHookMethods++;
                    finalizedHook = Object.freeze({
                        kind       : rawMethod.hook.kind,
                        configName : rawMethod.hook.configName,
                        configOwner: cfgInfo.reactiveOwner,
                        configLine : cfgInfo.reactiveLine,
                        bound      : true
                    });

                    const hookRow = Object.freeze({
                        className  : entry.className,
                        sourcePath : entry.sourcePath,
                        methodName : rawMethod.name,
                        line       : rawMethod.line,
                        hookKind   : rawMethod.hook.kind,
                        configName : rawMethod.hook.configName,
                        configOwner: cfgInfo.reactiveOwner,
                        configLine : cfgInfo.reactiveLine,
                        bound      : true
                    });

                    hooks.push(hookRow);
                    hooksByMethodKey.set(methodKey, hookRow);

                    let cfgHooks = hooksByConfigName.get(rawMethod.hook.configName);
                    if (!cfgHooks) {
                        cfgHooks = [];
                        hooksByConfigName.set(rawMethod.hook.configName, cfgHooks);
                    }
                    cfgHooks.push(Object.freeze({
                        hookKind  : rawMethod.hook.kind,
                        methodName: rawMethod.name,
                        line      : rawMethod.line
                    }));
                } else {
                    const reason = cfgInfo ? 'config-not-reactive' : 'no-matching-config';

                    finalizedHook = Object.freeze({
                        kind      : rawMethod.hook.kind,
                        configName: rawMethod.hook.configName,
                        bound     : false,
                        reason
                    });

                    unresolved.push(Object.freeze({
                        kind      : 'hook',
                        sourcePath: entry.sourcePath,
                        line      : rawMethod.line,
                        className : entry.className,
                        methodName: rawMethod.name,
                        receiver  : null,
                        callee    : null,
                        target    : rawMethod.hook.configName,
                        reason
                    }));
                }
            }

            const seenPairs = new Set();

            for (const call of rawMethod.calls) {
                if (call.computed) {
                    unresolved.push(Object.freeze({
                        kind      : 'call',
                        sourcePath: entry.sourcePath,
                        line      : call.line,
                        className : entry.className,
                        methodName: rawMethod.name,
                        receiver  : call.receiver,
                        callee    : call.callee,
                        target    : call.expression,
                        reason    : 'computed-member'
                    }));
                    continue
                }

                const searchChain = call.receiver === 'super' ? superChain : lookupChain;
                const targetOwner = searchChain.find(candidate => candidate.rawMethods.some(
                    candidateMethod => !candidateMethod.computed
                        && candidateMethod.name === call.callee
                        && candidateMethod.static === rawMethod.static
                        && (candidateMethod.kind === 'method' || candidateMethod.kind === 'constructor')
                ));

                const pairKey = `${call.receiver}:${call.callee}`;
                if (!seenPairs.has(pairKey)) {
                    seenPairs.add(pairKey);
                    callPairs[call.receiver].total++;
                    if (targetOwner) {
                        callPairs[call.receiver].bound++;
                    }
                }

                if (targetOwner) {
                    const targetKey = `${targetOwner.className}#${call.callee}`;
                    const callRow   = Object.freeze({
                        kind        : 'call',
                        sourcePath  : entry.sourcePath,
                        line        : call.line,
                        column      : call.column,
                        callerClass : entry.className,
                        callerMethod: rawMethod.name,
                        isStatic    : rawMethod.static,
                        receiver    : call.receiver,
                        targetClass : targetOwner.className,
                        targetMethod: call.callee,
                        targetKey,
                        expression  : call.expression
                    });

                    calls.push(callRow);

                    let targetBucket = callsByTarget.get(targetKey);
                    if (!targetBucket) {
                        targetBucket = [];
                        callsByTarget.set(targetKey, targetBucket);
                    }
                    targetBucket.push(callRow);
                } else {
                    const reason = (call.receiver === 'super' && entry.declaresSuper && !entry.superClassResolved)
                        ? 'superclass-not-in-tree'
                        : (!rawMethod.static && effectiveConfigs.has(call.callee))
                            ? 'config-callback'
                            : 'method-not-on-chain';

                    unresolved.push(Object.freeze({
                        kind      : 'call',
                        sourcePath: entry.sourcePath,
                        line      : call.line,
                        className : entry.className,
                        methodName: rawMethod.name,
                        receiver  : call.receiver,
                        callee    : call.callee,
                        target    : `${call.receiver}.${call.callee}`,
                        reason
                    }));
                }
            }

            for (const write of rawMethod.configWrites) {
                if (write.isStatic && write.receiver !== 'external') {
                    continue
                }

                allConfigWrites.push(Object.freeze({
                    sourcePath  : entry.sourcePath,
                    line        : write.line,
                    column      : write.column,
                    writerClass : entry.className,
                    writerMethod: rawMethod.name,
                    receiver    : write.receiver,
                    configName  : write.name,
                    writeKind   : write.writeKind,
                    operator    : write.operator,
                    expression  : write.expression
                }));
            }

            finalizedMethods.push(Object.freeze({
                name     : rawMethod.name,
                kind     : rawMethod.kind,
                static   : rawMethod.static,
                computed : rawMethod.computed,
                line     : rawMethod.line,
                endLine  : rawMethod.endLine,
                overrides,
                overridesFrom,
                callsSuper,
                hook     : finalizedHook
            }));
        }

        const ownConfigNames  = new Set(entry.ownConfigs.map(cfg => cfg.name));
        const finalizedConfigs = entry.ownConfigs.map(cfg => {
            const effective = effectiveConfigs.get(cfg.name);
            return Object.freeze({
                name       : cfg.name,
                declaredKey: cfg.declaredKey,
                reactive   : Boolean(effective?.reactive),
                inherited  : false,
                definedOn  : effective?.reactiveOwner || entry.className,
                line       : cfg.line,
                hooks      : Object.freeze(hooksByConfigName.get(cfg.name) || [])
            });
        });

        for (const [cfgName, cfgHooks] of hooksByConfigName.entries()) {
            if (ownConfigNames.has(cfgName)) {
                continue
            }

            const effective = effectiveConfigs.get(cfgName);
            finalizedConfigs.push(Object.freeze({
                name       : cfgName,
                declaredKey: `${cfgName}_`,
                reactive   : true,
                inherited  : true,
                definedOn  : effective.reactiveOwner,
                line       : effective.reactiveLine,
                hooks      : Object.freeze(cfgHooks)
            }));
        }

        const spineNames = getExtendsSpine(entry.className).map(item => item.className);
        const tailEntry  = getExtendsSpine(entry.className).at(-1);
        if (tailEntry?.declaresSuper && !tailEntry.superClassResolved && tailEntry.superClass) {
            spineNames.push(tailEntry.superClass);
        }

        classes[entry.className] = Object.freeze({
            className         : entry.className,
            ntype             : entry.ntype,
            sourcePath        : entry.sourcePath,
            declaresSuper     : entry.declaresSuper,
            superClass        : entry.superClass,
            superClassResolved: entry.superClassResolved,
            chain             : Object.freeze(spineNames),
            mixins            : Object.freeze([...entry.mixins]),
            configs           : Object.freeze(finalizedConfigs),
            methods           : Object.freeze(finalizedMethods)
        });
    }

    const indexDurationMs = Number((performance.now() - startedAt).toFixed(2));
    const stats = Object.freeze({
        fileCount   : files.length,
        classCount  : classEntries.size,
        superclasses: Object.freeze({
            declared: declaredSuperCount,
            resolved: resolvedSuperCount
        }),
        callPairs: Object.freeze({
            this : Object.freeze({...callPairs.this}),
            me   : Object.freeze({...callPairs.me}),
            super: Object.freeze({...callPairs.super}),
            all  : Object.freeze({
                total: callPairs.this.total + callPairs.me.total + callPairs.super.total,
                bound: callPairs.this.bound + callPairs.me.bound + callPairs.super.bound
            })
        }),
        hooks: Object.freeze({
            total: totalHookMethods,
            bound: boundHookMethods
        }),
        unresolvedCount: unresolved.length
    });

    return {
        extractorVersion: CODE_INDEX_EXTRACTOR_VERSION,
        rootDir         : absRoot,
        baseDir,
        rootPrefix,
        origin          : gitMeta.origin,
        commit          : gitMeta.commit,
        indexDurationMs,
        stats,
        classes         : Object.freeze(classes),
        calls           : Object.freeze(calls),
        hooks           : Object.freeze(hooks),
        configWrites    : Object.freeze(allConfigWrites),
        unresolved      : Object.freeze(unresolved),
        _internal       : {
            callsByTarget,
            hooksByMethodKey,
            overridesByBase,
            chainSetByClass,
            effectiveConfigsByClass
        }
    }
}

/**
 * @summary Ranks candidate symbol or folder names matching a failed lookup query.
 * @param {String} query
 * @param {String[]} universe
 * @param {Number} [maxCandidates=20]
 * @returns {String[]}
 */
function findCandidates(query, universe, maxCandidates = 20) {
    const needle = String(query || '').toLowerCase();
    const tail   = needle.split(/[.#/]/u).filter(Boolean).at(-1) || needle;

    const directMatches = universe.filter(item => item.toLowerCase().includes(needle));
    if (directMatches.length > 0) {
        return directMatches.slice(0, maxCandidates)
    }

    const tailMatches = universe.filter(item => item.toLowerCase().includes(tail));
    if (tailMatches.length > 0) {
        return tailMatches.slice(0, maxCandidates)
    }

    return universe.slice(0, maxCandidates)
}

/**
 * @summary Reads one class card (`file`, `chain`, `mixins`, `configs` with hooks, `methods`, and unresolved rows).
 * @param {Object} index Output of `indexSourceTree`.
 * @param {String} className Exact class name.
 * @returns {Object}
 */
export function readClassCard(index, className) {
    const allNames = Object.keys(index.classes).sort();
    const card     = index.classes[className];

    if (!card) {
        return Object.freeze({
            found     : false,
            query     : className,
            candidates: Object.freeze(findCandidates(className, allNames))
        })
    }

    const classUnresolved = index.unresolved.filter(row => row.className === className);

    return Object.freeze({
        found     : true,
        className : card.className,
        ntype     : card.ntype,
        sourcePath: card.sourcePath,
        chain     : card.chain,
        mixins    : card.mixins,
        configs   : card.configs,
        methods   : card.methods,
        unresolved: Object.freeze(classUnresolved)
    })
}

/**
 * @summary Reads direct call sites of `<ClassName>#<method>` and, for bound hooks, config writes labelled as `possible dispatch`.
 * @param {Object} index Output of `indexSourceTree`.
 * @param {String} methodTarget `<ClassName>#<methodName>`
 * @returns {Object}
 */
export function readMethodCallers(index, methodTarget) {
    const hashIndex = String(methodTarget || '').indexOf('#');
    const allMethodTargets = [];

    for (const cls of Object.values(index.classes)) {
        for (const method of cls.methods) {
            if (!method.computed) {
                allMethodTargets.push(`${cls.className}#${method.name}`);
            }
        }
    }
    allMethodTargets.sort();

    if (hashIndex <= 0 || hashIndex === methodTarget.length - 1) {
        return Object.freeze({
            found     : false,
            query     : methodTarget,
            candidates: Object.freeze(findCandidates(methodTarget, allMethodTargets))
        })
    }

    const className  = methodTarget.slice(0, hashIndex);
    const methodName = methodTarget.slice(hashIndex + 1);
    const cls        = index.classes[className];

    if (!cls) {
        return Object.freeze({
            found     : false,
            query     : methodTarget,
            candidates: Object.freeze(findCandidates(methodTarget, allMethodTargets))
        })
    }

    const method = cls.methods.find(item => !item.computed && item.name === methodName);

    if (!method) {
        const sameClassSymbols = cls.methods
            .filter(item => !item.computed)
            .map(item => `${cls.className}#${item.name}`)
            .sort();

        return Object.freeze({
            found     : false,
            query     : methodTarget,
            candidates: Object.freeze(findCandidates(methodName, sameClassSymbols))
        })
    }

    const targetKey = `${className}#${methodName}`;
    const directCalls = [...(index._internal.callsByTarget.get(targetKey) || [])]
        .sort((a, b) => a.sourcePath === b.sourcePath ? a.line - b.line : a.sourcePath < b.sourcePath ? -1 : 1);
    const overrides = [...(index._internal.overridesByBase.get(targetKey) || [])]
        .sort((a, b) => a.sourcePath === b.sourcePath ? a.line - b.line : a.sourcePath < b.sourcePath ? -1 : 1);

    const boundHook          = index._internal.hooksByMethodKey.get(targetKey) || null;
    const possibleDispatches = [];

    if (boundHook) {
        const hookChainSet = index._internal.chainSetByClass.get(className);

        for (const write of index.configWrites) {
            if (write.configName !== boundHook.configName) {
                continue
            }

            if (write.receiver !== 'external') {
                const writerConfigs = index._internal.effectiveConfigsByClass.get(write.writerClass);
                if (!writerConfigs?.get(boundHook.configName)?.reactive) {
                    continue
                }

                const writerChainSet = index._internal.chainSetByClass.get(write.writerClass);
                if (!writerChainSet?.has(className) && !hookChainSet?.has(write.writerClass)) {
                    continue
                }
            }

            possibleDispatches.push(Object.freeze({
                kind        : 'possible dispatch',
                label       : 'possible dispatch',
                sourcePath  : write.sourcePath,
                line        : write.line,
                column      : write.column,
                writerClass : write.writerClass,
                writerMethod: write.writerMethod,
                receiver    : write.receiver,
                configName  : write.configName,
                writeKind   : write.writeKind,
                expression  : write.expression
            }));
        }

        possibleDispatches.sort(
            (a, b) => a.sourcePath === b.sourcePath ? a.line - b.line : a.sourcePath < b.sourcePath ? -1 : 1
        );
    }

    const methodUnresolved = index.unresolved.filter(
        row => row.kind === 'hook' && row.className === className && row.methodName === methodName
    );

    return Object.freeze({
        found             : true,
        target            : targetKey,
        className,
        methodName,
        sourcePath        : cls.sourcePath,
        line              : method.line,
        hook              : method.hook,
        calls             : Object.freeze(directCalls),
        possibleDispatches: Object.freeze(possibleDispatches),
        overrides         : Object.freeze(overrides),
        unresolved        : Object.freeze(methodUnresolved)
    })
}

/**
 * @summary Reads one subsystem folder's classes, internal/border inheritance & mixin edges, and inbound external calls.
 * @param {Object} index Output of `indexSourceTree`.
 * @param {String} folderQuery Folder path relative to repo root or indexed root.
 * @returns {Object}
 */
export function readFolderScene(index, folderQuery) {
    const cleaned = toPosixPath(String(folderQuery || '').trim())
        .replace(/^\.\//u, '')
        .replace(/\/+$/u, '');

    const allClasses = Object.values(index.classes);
    const folderSet  = new Set();

    for (const cls of allClasses) {
        let dir = pathPosix.dirname(cls.sourcePath);
        while (dir && dir !== '.') {
            folderSet.add(dir);
            if (index.rootPrefix && dir.startsWith(`${index.rootPrefix}/`)) {
                folderSet.add(dir.slice(index.rootPrefix.length + 1));
            }
            dir = pathPosix.dirname(dir);
        }
    }

    const candidatePrefixes = [];
    if (!cleaned || cleaned === '.') {
        candidatePrefixes.push(index.rootPrefix || '');
    } else {
        candidatePrefixes.push(cleaned);
        if (index.rootPrefix && !cleaned.startsWith(`${index.rootPrefix}/`) && cleaned !== index.rootPrefix) {
            candidatePrefixes.push(`${index.rootPrefix}/${cleaned}`);
        }
    }

    let matchedFolder  = null;
    let scopedClasses  = [];

    for (const prefix of candidatePrefixes) {
        const matches = prefix === ''
            ? allClasses
            : allClasses.filter(cls => cls.sourcePath.startsWith(`${prefix}/`));

        if (matches.length > 0) {
            matchedFolder = prefix || '.';
            scopedClasses = matches;
            break;
        }
    }

    if (!matchedFolder) {
        return Object.freeze({
            found     : false,
            query     : folderQuery,
            candidates: Object.freeze(findCandidates(cleaned, [...folderSet].sort()))
        })
    }

    scopedClasses.sort((a, b) => a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0);
    const inScopeNames = new Set(scopedClasses.map(cls => cls.className));

    const inheritanceInternal = [];
    const inheritanceOutbound = [];
    const inheritanceInbound  = [];
    const mixinInternal       = [];
    const mixinOutbound       = [];
    const mixinInbound        = [];

    for (const cls of scopedClasses) {
        if (cls.declaresSuper && cls.superClass) {
            if (inScopeNames.has(cls.superClass)) {
                inheritanceInternal.push(Object.freeze({
                    from: cls.className,
                    to  : cls.superClass
                }));
            } else {
                inheritanceOutbound.push(Object.freeze({
                    from      : cls.className,
                    to        : cls.superClass,
                    resolved  : cls.superClassResolved,
                    targetPath: index.classes[cls.superClass]?.sourcePath || null
                }));
            }
        }

        for (const mixinName of cls.mixins) {
            if (inScopeNames.has(mixinName)) {
                mixinInternal.push(Object.freeze({
                    from : cls.className,
                    mixin: mixinName
                }));
            } else {
                mixinOutbound.push(Object.freeze({
                    from      : cls.className,
                    mixin     : mixinName,
                    targetPath: index.classes[mixinName]?.sourcePath || null
                }));
            }
        }
    }

    for (const cls of allClasses) {
        if (inScopeNames.has(cls.className)) {
            continue
        }

        if (cls.superClass && inScopeNames.has(cls.superClass)) {
            inheritanceInbound.push(Object.freeze({
                from      : cls.className,
                sourcePath: cls.sourcePath,
                to        : cls.superClass
            }));
        }

        for (const mixinName of cls.mixins) {
            if (inScopeNames.has(mixinName)) {
                mixinInbound.push(Object.freeze({
                    from      : cls.className,
                    sourcePath: cls.sourcePath,
                    mixin     : mixinName
                }));
            }
        }
    }

    const externalCallsMap = new Map();

    for (const call of index.calls) {
        if (!inScopeNames.has(call.targetClass) || inScopeNames.has(call.callerClass)) {
            continue
        }

        let group = externalCallsMap.get(call.targetKey);
        if (!group) {
            group = {
                target      : call.targetKey,
                targetClass : call.targetClass,
                targetMethod: call.targetMethod,
                callers     : []
            };
            externalCallsMap.set(call.targetKey, group);
        }
        group.callers.push(Object.freeze({
            sourcePath  : call.sourcePath,
            line        : call.line,
            callerClass : call.callerClass,
            callerMethod: call.callerMethod,
            receiver    : call.receiver
        }));
    }

    const externalCalls = [...externalCallsMap.values()]
        .sort((a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : 0)
        .map(group => Object.freeze({
            target      : group.target,
            targetClass : group.targetClass,
            targetMethod: group.targetMethod,
            callCount   : group.callers.length,
            callers     : Object.freeze(group.callers)
        }));

    const sceneUnresolved = index.unresolved.filter(
        row => (row.className && inScopeNames.has(row.className))
            || (matchedFolder !== '.' && row.sourcePath.startsWith(`${matchedFolder}/`))
    );

    return Object.freeze({
        found      : true,
        folder     : matchedFolder,
        classes    : Object.freeze(scopedClasses.map(cls => Object.freeze({
            className  : cls.className,
            ntype      : cls.ntype,
            sourcePath : cls.sourcePath,
            superClass : cls.superClass,
            mixins     : cls.mixins,
            configCount: cls.configs.length,
            methodCount: cls.methods.length
        }))),
        inheritance: Object.freeze({
            internal: Object.freeze(inheritanceInternal),
            outbound: Object.freeze(inheritanceOutbound),
            inbound : Object.freeze(inheritanceInbound)
        }),
        mixins: Object.freeze({
            internal: Object.freeze(mixinInternal),
            outbound: Object.freeze(mixinOutbound),
            inbound : Object.freeze(mixinInbound)
        }),
        externalCalls: Object.freeze(externalCalls),
        unresolved   : Object.freeze(sceneUnresolved)
    })
}

/**
 * @summary Returns revision-bound tree coverage totals for index diagnostics.
 * @param {Object} index Output of `indexSourceTree`.
 * @returns {Object}
 */
export function summarizeSourceTreeIndex(index) {
    return Object.freeze({
        origin          : index.origin,
        commit          : index.commit,
        extractorVersion: index.extractorVersion,
        rootDir         : index.rootDir,
        indexDurationMs : index.indexDurationMs,
        stats           : index.stats,
        unresolved      : index.unresolved
    })
}

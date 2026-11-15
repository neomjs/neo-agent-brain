import {execFileSync}             from 'node:child_process';
import fs                         from 'node:fs';
import path, {posix as pathPosix} from 'node:path';
import {resolveSuperClass}        from './classHierarchyResolution.mjs';
import {inspectSourceModule}      from './inspectSourceModule.mjs';

export const CODE_INDEX_EXTRACTOR_VERSION = '1.0.0';

const GIT_SHA_PATTERN     = /^[0-9a-f]{40}$/iu;
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules']);
const INDEX_INTERNALS     = new WeakMap();

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
 * @summary Retrieves private lookup tables bound to an `indexSourceTree()` handle.
 * @param {Object} index
 * @returns {Object}
 */
function getIndexInternals(index) {
    const internals = index && typeof index === 'object' ? INDEX_INTERNALS.get(index) : null;

    if (!internals) {
        throw createIndexError(
            'CODE_INDEX_INVALID_HANDLE',
            'Expected an index object returned by indexSourceTree().'
        )
    }

    return internals
}

/**
 * @summary Runs one `git -C <startDir>` read query and returns trimmed stdout or `null` on failure.
 * @param {String} startDir
 * @param {String[]} args
 * @param {Function} [runGit=execFileSync]
 * @returns {String|null}
 */
function runGitQuery(startDir, args, runGit = execFileSync) {
    try {
        const output = String(runGit('git', ['-C', startDir, ...args], {
            encoding: 'utf8',
            stdio   : ['ignore', 'pipe', 'pipe']
        })).trim();

        return output || null
    } catch {
        return null
    }
}

/**
 * @summary Resolves a git checkout's top-level root, HEAD SHA, and `origin` URL via `git`,
 * returning nulls outside a checkout or across a `node_modules` boundary.
 * @param {String} startDir Absolute directory inside or equal to a checkout.
 * @param {Object} [options]
 * @param {Function} [options.runGit=execFileSync]
 * @returns {{repoRoot: String|null, commit: String|null, origin: String|null}}
 */
function readGitProvenance(startDir, {runGit = execFileSync} = {}) {
    const topLevel = runGitQuery(startDir, ['rev-parse', '--show-toplevel'], runGit);

    if (!topLevel) {
        return {repoRoot: null, commit: null, origin: null}
    }

    let physicalTop;
    let physicalStart;

    try {
        physicalTop   = fs.realpathSync(topLevel);
        physicalStart = fs.realpathSync(startDir);
    } catch {
        return {repoRoot: null, commit: null, origin: null}
    }

    const relative = path.relative(physicalTop, physicalStart);

    if (
        relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
        || relative.split(path.sep).includes('node_modules')
    ) {
        return {repoRoot: null, commit: null, origin: null}
    }

    const repoRoot = relative === ''
        ? startDir
        : startDir.endsWith(`${path.sep}${relative}`)
            ? startDir.slice(0, startDir.length - relative.length - 1)
            : physicalTop;
    const rawHead = runGitQuery(startDir, ['rev-parse', 'HEAD'], runGit);
    const commit  = rawHead && GIT_SHA_PATTERN.test(rawHead) ? rawHead : null;
    const origin  = runGitQuery(startDir, ['config', '--get', 'remote.origin.url'], runGit);

    return {repoRoot, commit, origin}
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

        for (const item of inspected.unindexedClasses || []) {
            unresolved.push(Object.freeze({
                kind         : 'class',
                sourcePath   : file.sourcePath,
                line         : item.line,
                className    : item.name,
                methodName   : null,
                receiver     : null,
                callee       : null,
                declaresSuper: item.declaresSuper,
                target       : item.name || '<anonymous class>',
                expression   : item.expression,
                reason       : item.reason
            }));
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

    const classEntries       = new Map();
    let   declaredSuperCount = 0;
    let   resolvedSuperCount = 0;

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
            ntype        : inspected.ntype,
            sourcePath,
            declaresSuper: inspected.declaresSuper,
            superClass,
            superClassResolved,
            mixins       : resolvedMixins,
            ownConfigs   : inspected.configs,
            rawMethods   : inspected.methods
        });
    }

    const extendsSpineCache = new Map();

    function getExtendsSpine(className) {
        if (extendsSpineCache.has(className)) {
            return extendsSpineCache.get(className)
        }

        const spine   = [];
        const seen    = new Set();
        let   current = className;

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
    const lookupChainByClass      = new Map();
    const superChainByClass       = new Map();

    for (const [className, entry] of classEntries.entries()) {
        const lookupChain = getLookupChain(className);
        const superChain  = getSuperLookupChain(entry);

        lookupChainByClass.set(className, Object.freeze(lookupChain.map(item => item.className)));
        superChainByClass.set(className, Object.freeze(superChain.map(item => item.className)));

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
    const allMethods       = [];
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
            const methodKey     = `${entry.className}#${rawMethod.name}`;
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
                if (write.receiver === 'external') {
                    unresolved.push(Object.freeze({
                        kind      : 'write',
                        sourcePath: entry.sourcePath,
                        line      : write.line,
                        className : entry.className,
                        methodName: rawMethod.name,
                        receiver  : 'external',
                        callee    : null,
                        configName: write.name,
                        target    : write.name,
                        expression: write.expression,
                        reason    : 'receiver-class-unresolved'
                    }));
                    continue
                }

                if (write.isStatic) {
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
                name    : rawMethod.name,
                kind    : rawMethod.kind,
                static  : rawMethod.static,
                computed: rawMethod.computed,
                line    : rawMethod.line,
                endLine : rawMethod.endLine,
                overrides,
                overridesFrom,
                callsSuper,
                hook    : finalizedHook
            }));

            allMethods.push(Object.freeze({
                className : entry.className,
                sourcePath: entry.sourcePath,
                name      : rawMethod.name,
                kind      : rawMethod.kind,
                static    : rawMethod.static,
                computed  : rawMethod.computed,
                line      : rawMethod.line,
                endLine   : rawMethod.endLine,
                overrides,
                overridesFrom,
                callsSuper,
                hook      : finalizedHook
            }));
        }

        const ownConfigNames   = new Set(entry.ownConfigs.map(cfg => cfg.name));
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
    const stats           = Object.freeze({
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

    const index = Object.freeze({
        extractorVersion: CODE_INDEX_EXTRACTOR_VERSION,
        rootDir         : absRoot,
        baseDir,
        rootPrefix,
        origin          : gitMeta.origin,
        commit          : gitMeta.commit,
        indexDurationMs,
        stats,
        classes         : Object.freeze(classes),
        methods         : Object.freeze(allMethods),
        calls           : Object.freeze(calls),
        hooks           : Object.freeze(hooks),
        configWrites    : Object.freeze(allConfigWrites),
        unresolved      : Object.freeze(unresolved)
    });

    INDEX_INTERNALS.set(index, {
        callsByTarget,
        hooksByMethodKey,
        overridesByBase,
        lookupChainByClass,
        superChainByClass,
        effectiveConfigsByClass
    });

    return index
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
 * @summary Finds the nearest non-static, non-computed instance method on a lookup chain.
 * @param {ReadonlyArray<String>} chainNames
 * @param {String} methodName
 * @param {Object} classes
 * @returns {{className: String, method: Object}|null}
 */
function findNearestChainMethod(chainNames, methodName, classes) {
    for (const ownerName of chainNames) {
        const ownerClass = classes[ownerName];
        const method     = ownerClass?.methods.find(
            item => !item.computed && !item.static && item.kind === 'method' && item.name === methodName
        );

        if (method) {
            return {className: ownerName, method}
        }
    }

    return null
}

/**
 * @summary Checks whether a bound-receiver config write on `writerClass` reaches `targetClass#methodName`
 * directly or through `super` forwarding along intermediate hook overrides.
 * @param {String} writerClass
 * @param {String} targetClass
 * @param {String} methodName
 * @param {Object} internals
 * @param {Object} classes
 * @returns {Boolean}
 */
function canChainWriteReachHook(writerClass, targetClass, methodName, internals, classes) {
    const writerLookup = internals.lookupChainByClass.get(writerClass);

    if (!writerLookup) {
        return false
    }

    let   current = findNearestChainMethod(writerLookup, methodName, classes);
    const visited = new Set();

    while (current) {
        const visitKey = `${current.className}#${methodName}`;

        if (visited.has(visitKey)) {
            return false
        }
        visited.add(visitKey);

        if (current.className === targetClass) {
            return true
        }

        if (!current.method.callsSuper) {
            return false
        }

        const superLookup = internals.superChainByClass.get(current.className);
        current = superLookup ? findNearestChainMethod(superLookup, methodName, classes) : null;
    }

    return false
}

/**
 * @summary Reads one class card (`file`, `chain`, `mixins`, `configs` with hooks, `methods`, and unresolved rows).
 * @param {Object} index Output of `indexSourceTree`.
 * @param {String} className Exact class name.
 * @returns {Object}
 */
export function readClassCard(index, className) {
    getIndexInternals(index);

    const allNames = Object.keys(index.classes).sort();
    const card     = index.classes[className];

    if (!card) {
        const unindexed = index.unresolved.filter(
            row => row.kind === 'class' && row.className === className
        );

        return Object.freeze({
            found     : false,
            query     : className,
            unindexed : Object.freeze(unindexed),
            candidates: Object.freeze(findCandidates(className, allNames))
        })
    }

    const classUnresolved = index.unresolved.filter(
        row => row.className === className || (row.kind === 'class' && row.sourcePath === card.sourcePath)
    );

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
 * @summary Reads direct call sites of `<ClassName>#<method>` and, for bound hooks, reachable config writes
 * labelled strictly as `possible dispatch` while surfacing unresolved writes separately.
 * @param {Object} index Output of `indexSourceTree`.
 * @param {String} methodTarget `<ClassName>#<methodName>`
 * @returns {Object}
 */
export function readMethodCallers(index, methodTarget) {
    const internals        = getIndexInternals(index);
    const hashIndex        = String(methodTarget || '').indexOf('#');
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

    const targetKey   = `${className}#${methodName}`;
    const directCalls = [...(internals.callsByTarget.get(targetKey) || [])]
        .sort((a, b) => a.sourcePath === b.sourcePath ? a.line - b.line : a.sourcePath < b.sourcePath ? -1 : 1);
    const overrides = [...(internals.overridesByBase.get(targetKey) || [])]
        .sort((a, b) => a.sourcePath === b.sourcePath ? a.line - b.line : a.sourcePath < b.sourcePath ? -1 : 1);

    const boundHook          = internals.hooksByMethodKey.get(targetKey) || null;
    const possibleDispatches = [];

    if (boundHook) {
        for (const write of index.configWrites) {
            if (write.receiver === 'external' || write.configName !== boundHook.configName) {
                continue
            }

            const writerConfigs = internals.effectiveConfigsByClass.get(write.writerClass);
            if (!writerConfigs?.get(boundHook.configName)?.reactive) {
                continue
            }

            if (!canChainWriteReachHook(write.writerClass, className, methodName, internals, index.classes)) {
                continue
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

    const hookConfigName   = method.hook?.configName || null;
    const methodUnresolved = index.unresolved
        .filter(row => (row.kind === 'hook' && row.className === className && row.methodName === methodName)
            || (hookConfigName !== null && row.kind === 'write' && row.configName === hookConfigName))
        .sort((a, b) => a.sourcePath === b.sourcePath ? a.line - b.line : a.sourcePath < b.sourcePath ? -1 : 1);

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
    getIndexInternals(index);

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

    let matchedFolder = null;
    let scopedClasses = [];

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
            || (matchedFolder === '.' ? Boolean(row.sourcePath) : row.sourcePath.startsWith(`${matchedFolder}/`))
    );

    return Object.freeze({
        found  : true,
        folder : matchedFolder,
        classes: Object.freeze(scopedClasses.map(cls => Object.freeze({
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
    getIndexInternals(index);

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

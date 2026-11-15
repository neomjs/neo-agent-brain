import * as acorn from 'acorn';

const HOOK_METHOD_PATTERN = /^(afterSet|beforeSet|beforeGet)([A-Z][\w$]*)$/u;
const CONFIG_META_KEYS    = new Set(['className', 'ntype', 'mixins']);

/**
 * @summary Collects identifier names bound by a destructuring or parameter pattern.
 * @param {Object|null} pattern ESTree pattern node.
 * @param {Set<String>} [names]
 * @returns {Set<String>}
 */
function collectBoundNames(pattern, names = new Set()) {
    if (!pattern) {
        return names
    }

    switch (pattern.type) {
        case 'Identifier':
            names.add(pattern.name);
            break;
        case 'AssignmentPattern':
            collectBoundNames(pattern.left, names);
            break;
        case 'RestElement':
            collectBoundNames(pattern.argument, names);
            break;
        case 'ArrayPattern':
            pattern.elements.forEach(element => collectBoundNames(element, names));
            break;
        case 'ObjectPattern':
            pattern.properties.forEach(prop => collectBoundNames(prop.value || prop.argument, names));
            break;
    }

    return names
}

/**
 * @summary Checks whether a function body hoists a `var me` declaration in its own function scope.
 * @param {Object|null} node ESTree node.
 * @returns {Boolean}
 */
function hasHoistedVarMe(node) {
    if (!node || typeof node.type !== 'string') {
        return false
    }

    if (
        node.type === 'FunctionDeclaration'
        || node.type === 'FunctionExpression'
        || node.type === 'ArrowFunctionExpression'
    ) {
        return false
    }

    if (node.type === 'VariableDeclaration' && node.kind === 'var') {
        for (const declarator of node.declarations) {
            if (collectBoundNames(declarator.id).has('me')) {
                return true
            }
        }
    }

    for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') {
            continue
        }

        const value = node[key];

        if (Array.isArray(value)) {
            if (value.some(child => hasHoistedVarMe(child))) {
                return true
            }
        } else if (value && typeof value.type === 'string' && hasHoistedVarMe(value)) {
            return true
        }
    }

    return false
}

/**
 * @summary Reads a static property name from an ESTree key or member property node.
 * @param {Object|null} keyNode
 * @param {Boolean} computed
 * @returns {String|null}
 */
function readStaticKey(keyNode, computed) {
    if (!keyNode) {
        return null
    }

    if (!computed && keyNode.type === 'Identifier') {
        return keyNode.name
    }

    if (keyNode.type === 'Literal' && typeof keyNode.value === 'string') {
        return keyNode.value
    }

    return null
}

/**
 * @summary Classifies a receiver AST node against the active lexical `this` / `me` / `super` bindings.
 * @param {Object|null} objectNode
 * @param {{thisBound: Boolean, meBound: Boolean}} scope
 * @returns {'this'|'me'|'super'|null}
 */
function resolveReceiver(objectNode, scope) {
    if (!objectNode) {
        return null
    }

    if (objectNode.type === 'ThisExpression' && scope.thisBound) {
        return 'this'
    }

    if (objectNode.type === 'Identifier' && objectNode.name === 'me' && scope.meBound) {
        return 'me'
    }

    if (objectNode.type === 'Super') {
        return 'super'
    }

    return null
}

/**
 * @summary Converts one mixin AST element into a normalized reference descriptor.
 * @param {Object|null} element
 * @param {String} content
 * @returns {Object|null}
 */
function describeMixinElement(element, content) {
    if (!element) {
        return null
    }

    if (element.type === 'Literal') {
        return typeof element.value === 'string'
            ? Object.freeze({kind: 'literal', value: element.value, line: element.loc.start.line})
            : null
    }

    if (element.type === 'Identifier') {
        return Object.freeze({kind: 'identifier', name: element.name, line: element.loc.start.line})
    }

    return Object.freeze({
        kind : 'expression',
        value: content.slice(element.start, element.end).trim(),
        line : element.loc.start.line
    })
}

/**
 * @summary Extracts `ntype`, `mixins`, and config key descriptors from a class `static config` block.
 * @param {Object|null} configNode
 * @param {Array<Object>} staticMixins
 * @param {String} content
 * @returns {{ntype: String|null, mixins: ReadonlyArray<Object>, configs: ReadonlyArray<Object>}}
 */
function extractConfigBlock(configNode, staticMixins, content) {
    const mixins  = [...staticMixins];
    const configs = [];
    let   ntype   = null;

    if (configNode?.value?.type === 'ObjectExpression') {
        for (const prop of configNode.value.properties) {
            if (prop.type !== 'Property') {
                continue
            }

            const key = readStaticKey(prop.key, prop.computed);

            if (!key) {
                continue
            }

            if (key === 'ntype') {
                if (prop.value?.type === 'Literal' && typeof prop.value.value === 'string') {
                    ntype = prop.value.value;
                }
                continue
            }

            if (key === 'mixins') {
                if (prop.value?.type === 'ArrayExpression') {
                    for (const element of prop.value.elements) {
                        const described = describeMixinElement(element, content);
                        described && mixins.push(described);
                    }
                } else {
                    const described = describeMixinElement(prop.value, content);
                    described && mixins.push(described);
                }
                continue
            }

            if (CONFIG_META_KEYS.has(key)) {
                continue
            }

            const reactive = key.endsWith('_') && key.length > 1;

            configs.push(Object.freeze({
                name       : reactive ? key.slice(0, -1) : key,
                declaredKey: key,
                reactive,
                line       : prop.loc.start.line
            }));
        }
    }

    return {
        ntype,
        mixins : Object.freeze(mixins),
        configs: Object.freeze(configs)
    }
}

/**
 * @summary Extracts calls and config writes from one class `MethodDefinition` body.
 * @param {Object} member ESTree MethodDefinition node.
 * @param {String} content Raw module text.
 * @returns {Object}
 */
function extractMethodDetails(member, content) {
    const staticKey = readStaticKey(member.key, member.computed);
    const name      = staticKey
        ?? (member.key?.type === 'PrivateIdentifier' ? `#${member.key.name}` : '[computed]');
    const hookMatch = (!member.static && member.kind === 'method' && !member.computed && staticKey)
        ? HOOK_METHOD_PATTERN.exec(staticKey)
        : null;
    const hook = hookMatch
        ? Object.freeze({
            kind      : hookMatch[1],
            configName: hookMatch[2][0].toLowerCase() + hookMatch[2].slice(1)
        })
        : null;

    const calls        = [];
    const configWrites = [];
    const fn           = member.value;

    function walk(node, scope, fnScope) {
        if (!node || typeof node.type !== 'string') {
            return
        }

        if (
            node !== fn
            && (
                node.type === 'FunctionDeclaration'
                || node.type === 'FunctionExpression'
                || node.type === 'ArrowFunctionExpression'
            )
        ) {
            const paramNames = new Set();
            (node.params || []).forEach(param => collectBoundNames(param, paramNames));

            const isArrow      = node.type === 'ArrowFunctionExpression';
            const hoistedVarMe = !isArrow && hasHoistedVarMe(node.body);
            const childFnScope = {
                thisBound: isArrow ? scope.thisBound : false,
                meBound  : (paramNames.has('me') || hoistedVarMe) ? false : scope.meBound
            };

            (node.params || []).forEach(param => walk(param, childFnScope, childFnScope));
            walk(node.body, {...childFnScope}, childFnScope);
            return
        }

        if (node.type === 'BlockStatement' && node !== fn?.body) {
            const blockScope = {...scope};

            for (const statement of node.body) {
                walk(statement, blockScope, fnScope);
            }
            return
        }

        if (node.type === 'VariableDeclaration') {
            for (const declarator of node.declarations) {
                if (declarator.init) {
                    walk(declarator.init, scope, fnScope);
                }

                const boundNames = collectBoundNames(declarator.id);

                if (boundNames.has('me')) {
                    const bindsThis = declarator.id?.type === 'Identifier'
                        && declarator.init?.type === 'ThisExpression'
                        && scope.thisBound;

                    scope.meBound = bindsThis;

                    if (node.kind === 'var') {
                        fnScope.meBound = bindsThis;
                    }
                }
            }
            return
        }

        if (node.type === 'AssignmentExpression') {
            walk(node.right, scope, fnScope);

            if (node.left?.type === 'Identifier' && node.left.name === 'me') {
                const bindsThis = node.right?.type === 'ThisExpression' && scope.thisBound;
                scope.meBound   = bindsThis;
                fnScope.meBound = bindsThis;
                return
            }

            if (node.left?.type === 'MemberExpression') {
                const receiver = resolveReceiver(node.left.object, scope);
                const propName = receiver ? readStaticKey(node.left.property, node.left.computed) : null;

                if (receiver && receiver !== 'super' && propName) {
                    configWrites.push(Object.freeze({
                        methodName: name,
                        isStatic  : Boolean(member.static),
                        receiver,
                        name      : propName,
                        writeKind : 'assignment',
                        operator  : node.operator,
                        line      : node.loc.start.line,
                        column    : node.loc.start.column,
                        expression: `${receiver}.${propName} ${node.operator} ...`
                    }));
                }
            }

            walk(node.left, scope, fnScope);
            return
        }

        if (node.type === 'UpdateExpression' && node.argument?.type === 'MemberExpression') {
            const receiver = resolveReceiver(node.argument.object, scope);
            const propName = receiver ? readStaticKey(node.argument.property, node.argument.computed) : null;

            if (receiver && receiver !== 'super' && propName) {
                configWrites.push(Object.freeze({
                    methodName: name,
                    isStatic  : Boolean(member.static),
                    receiver,
                    name      : propName,
                    writeKind : 'update',
                    operator  : node.operator,
                    line      : node.loc.start.line,
                    column    : node.loc.start.column,
                    expression: `${receiver}.${propName}${node.operator}`
                }));
            }
        }

        if (node.type === 'CallExpression') {
            const {callee} = node;

            if (callee?.type === 'Super') {
                calls.push(Object.freeze({
                    methodName: name,
                    isStatic  : Boolean(member.static),
                    receiver  : 'super',
                    callee    : 'constructor',
                    computed  : false,
                    line      : node.loc.start.line,
                    column    : node.loc.start.column,
                    expression: 'super()'
                }));
            } else if (callee?.type === 'MemberExpression') {
                const receiver = resolveReceiver(callee.object, scope);

                if (receiver) {
                    const calleeName = readStaticKey(callee.property, callee.computed);

                    if (calleeName) {
                        calls.push(Object.freeze({
                            methodName: name,
                            isStatic  : Boolean(member.static),
                            receiver,
                            callee    : calleeName,
                            computed  : false,
                            line      : node.loc.start.line,
                            column    : node.loc.start.column,
                            expression: `${receiver}.${calleeName}()`
                        }));

                        if (calleeName === 'set' && node.arguments[0]?.type === 'ObjectExpression') {
                            for (const prop of node.arguments[0].properties) {
                                if (prop.type !== 'Property') {
                                    continue
                                }

                                const writtenKey = readStaticKey(prop.key, prop.computed);

                                if (writtenKey) {
                                    configWrites.push(Object.freeze({
                                        methodName: name,
                                        isStatic  : Boolean(member.static),
                                        receiver,
                                        name      : writtenKey,
                                        writeKind : 'set',
                                        operator  : 'set',
                                        line      : prop.loc.start.line,
                                        column    : prop.loc.start.column,
                                        expression: `${receiver}.set({${writtenKey}: ...})`
                                    }));
                                }
                            }
                        }
                    } else if (callee.computed && callee.property) {
                        const propText = content.slice(callee.property.start, callee.property.end).trim();

                        calls.push(Object.freeze({
                            methodName: name,
                            isStatic  : Boolean(member.static),
                            receiver,
                            callee    : `[${propText}]`,
                            computed  : true,
                            line      : node.loc.start.line,
                            column    : node.loc.start.column,
                            expression: `${receiver}[${propText}]()`
                        }));
                    }
                } else if (
                    readStaticKey(callee.property, callee.computed) === 'set'
                    && node.arguments.length === 1
                    && node.arguments[0]?.type === 'ObjectExpression'
                ) {
                    const receiverText = content
                        .slice(callee.object.start, callee.object.end)
                        .replace(/\s+/gu, ' ')
                        .trim();

                    for (const prop of node.arguments[0].properties) {
                        if (prop.type !== 'Property') {
                            continue
                        }

                        const writtenKey = readStaticKey(prop.key, prop.computed);

                        if (writtenKey) {
                            configWrites.push(Object.freeze({
                                methodName: name,
                                isStatic  : Boolean(member.static),
                                receiver  : 'external',
                                name      : writtenKey,
                                writeKind : 'set',
                                operator  : 'set',
                                line      : prop.loc.start.line,
                                column    : prop.loc.start.column,
                                expression: `${receiverText}.set({${writtenKey}: ...})`
                            }));
                        }
                    }
                }
            }
        }

        for (const key of Object.keys(node)) {
            if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') {
                continue
            }

            const value = node[key];

            if (Array.isArray(value)) {
                value.forEach(child => walk(child, scope, fnScope));
            } else if (value && typeof value.type === 'string') {
                walk(value, scope, fnScope);
            }
        }
    }

    if (fn) {
        const rootScope = {thisBound: true, meBound: false};
        (fn.params || []).forEach(param => walk(param, rootScope, rootScope));

        const bodyScope = {thisBound: true, meBound: false};
        walk(fn.body, bodyScope, bodyScope);
    }

    return Object.freeze({
        name,
        kind        : member.kind,
        static      : Boolean(member.static),
        computed    : Boolean(member.computed),
        line        : member.loc.start.line,
        endLine     : member.loc.end.line,
        hook,
        calls       : Object.freeze(calls),
        configWrites: Object.freeze(configWrites)
    })
}

/**
 * @summary Collects any `ClassDeclaration` or `ClassExpression` in `rootAst` that was not chosen as
 * the module's single primary indexed class.
 * @param {Object} rootAst
 * @param {Object|null} indexedClassNode
 * @param {Set<Object>} topLevelClassNodes
 * @param {String} content
 * @returns {ReadonlyArray<Object>}
 */
function collectUnindexedClasses(rootAst, indexedClassNode, topLevelClassNodes, content) {
    const unindexed = [];

    function visit(node) {
        if (!node || typeof node.type !== 'string') {
            return
        }

        if (
            (node.type === 'ClassDeclaration' || node.type === 'ClassExpression')
            && node !== indexedClassNode
        ) {
            const name          = node.id?.name || null;
            const declaresSuper = Boolean(node.superClass);
            const superName     = node.superClass
                ? content.slice(node.superClass.start, node.superClass.end).replace(/\s+/gu, ' ').trim()
                : null;
            const headerPrefix = name ? `class ${name}` : 'class <anonymous>';
            const expression   = superName ? `${headerPrefix} extends ${superName}` : headerPrefix;
            const reason       = node.type === 'ClassExpression'
                ? 'class-expression'
                : topLevelClassNodes.has(node)
                    ? 'secondary-class-in-module'
                    : 'nested-class-declaration';

            unindexed.push(Object.freeze({
                name,
                line: node.loc.start.line,
                declaresSuper,
                superName,
                expression,
                reason
            }));
        }

        for (const key of Object.keys(node)) {
            if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') {
                continue
            }

            const value = node[key];

            if (Array.isArray(value)) {
                value.forEach(visit);
            } else if (value && typeof value.type === 'string') {
                visit(value);
            }
        }
    }

    visit(rootAst);
    return Object.freeze(unindexed)
}

/**
 * @summary Parses one source module into the single class-description universe shared by chunking,
 * repository hierarchy derivation, and source-tree indexing.
 *
 * A separate hierarchy scan already produced different class totals from the chunks whose ids it
 * was meant to protect. Keeping the AST walk here makes `className`, superclass declaration, and
 * import bindings one producer contract rather than two implementations that merely look similar.
 *
 * @param {String} content Raw module source.
 * @param {String} filePath Repository-relative source path.
 * @param {Object} [options]
 * @param {Boolean} [options.strict=false] Throw a coded error on parse failure instead of returning a coded result.
 * @param {Boolean} [options.extractCalls=false] Extract configs, mixins, ntype, method calls, config writes, and unindexed classes.
 * @returns {Object}
 */
export function inspectSourceModule(content, filePath, {strict = false, extractCalls = false} = {}) {
    if (content.startsWith('#!')) {
        content = content.replace(/^#!.*\n/u, '');
    }

    let ast;

    try {
        ast = acorn.parse(content, {sourceType: 'module', locations: true, ecmaVersion: 'latest'});
    } catch (cause) {
        if (strict) {
            const error = new Error(`Repository source '${filePath}' could not be parsed.`);

            error.code    = 'KB_SOURCE_PARSE_FAILED';
            error.details = {sourcePath: filePath, causeMessage: cause.message};

            throw error
        }

        return Object.freeze({
            parseFailed: true,
            code       : 'KB_SOURCE_PARSE_FAILED',
            message    : cause.message,
            sourcePath : filePath
        })
    }

    const
        contextNodes       = [],
        propertyNodes      = [],
        methodNodes        = [],
        imports            = [],
        topLevelClassNodes = new Set();
    let
        activeClassNode     = null,
        activeConfigNode    = null,
        activeMethodNodes   = [],
        activeStaticMixins  = [],
        classStart          = 0,
        classDefinition     = '',
        className           = '',
        configNode          = null,
        declaresSuper       = false,
        superClassReference = null;

    ast.body.forEach(node => {
        if (node.type === 'ImportDeclaration' || node.type === 'VariableDeclaration') {
            contextNodes.push(node);

            if (node.type === 'ImportDeclaration' && typeof node.source?.value === 'string') {
                node.specifiers.forEach(specifier => {
                    const localName = specifier.local?.name;

                    if (!localName) {
                        return
                    }

                    imports.push(Object.freeze({
                        kind: specifier.type === 'ImportDefaultSpecifier'
                            ? 'default'
                            : specifier.type === 'ImportNamespaceSpecifier'
                                ? 'namespace'
                                : 'named',
                        localName,
                        importedName: specifier.type === 'ImportSpecifier'
                            ? (specifier.imported?.name || specifier.imported?.value || '')
                            : specifier.type === 'ImportDefaultSpecifier' ? 'default' : '*',
                        source: node.source.value
                    }))
                })
            }
        } else if (node.type === 'ClassDeclaration' || node.type === 'ExportDefaultDeclaration') {
            const classDecl = node.type === 'ExportDefaultDeclaration' ? node.declaration : node;

            if (classDecl.type !== 'ClassDeclaration') {
                return
            }

            topLevelClassNodes.add(classDecl);
            activeClassNode     = classDecl;
            classStart          = classDecl.start;
            classDefinition     = content.substring(classDecl.start, classDecl.body.start + 1);
            className           = classDecl.id?.name || '';
            declaresSuper       = Boolean(classDecl.superClass);
            superClassReference = null;
            activeConfigNode    = null;
            activeMethodNodes   = [];
            activeStaticMixins  = [];

            if (classDecl.superClass?.type === 'Identifier') {
                superClassReference = Object.freeze({
                    kind: 'identifier',
                    name: classDecl.superClass.name
                });
            } else if (classDecl.superClass) {
                superClassReference = Object.freeze({
                    kind : 'expression',
                    value: content.substring(classDecl.superClass.start, classDecl.superClass.end).trim()
                });
            }

            classDecl.body.body.forEach(member => {
                if (member.type === 'MethodDefinition') {
                    methodNodes.push(member);
                    activeMethodNodes.push(member);
                } else if (member.type === 'PropertyDefinition') {
                    const memberKey = readStaticKey(member.key, member.computed);

                    if (memberKey === 'config' && member.static) {
                        configNode       = member;
                        activeConfigNode = member;

                        if (member.value?.type === 'ObjectExpression') {
                            const classNameProp = member.value.properties
                                .find(property => readStaticKey(property.key, property.computed) === 'className');

                            if (classNameProp?.value?.type === 'Literal') {
                                className = classNameProp.value.value;
                            }
                        }
                    } else {
                        propertyNodes.push(member);

                        if (
                            member.static
                            && memberKey === 'observable'
                            && member.value?.type === 'Literal'
                            && member.value.value === true
                        ) {
                            activeStaticMixins.push(Object.freeze({
                                kind : 'literal',
                                value: 'Neo.core.Observable',
                                via  : 'static-observable',
                                line : member.loc.start.line
                            }));
                        }
                    }
                }
            })
        }
    });

    const baseResult = {
        ast,
        content,
        contextNodes,
        propertyNodes,
        configNode,
        methodNodes,
        classStart,
        classDefinition,
        className,
        declaresSuper,
        superClassReference,
        imports: Object.freeze(imports)
    };

    if (!extractCalls) {
        return baseResult
    }

    const {ntype, mixins, configs} = extractConfigBlock(activeConfigNode, activeStaticMixins, content);
    const methods                  = Object.freeze(
        activeMethodNodes.map(member => extractMethodDetails(member, content))
    );
    const calls            = Object.freeze(methods.flatMap(method => method.calls));
    const configWrites     = Object.freeze(methods.flatMap(method => method.configWrites));
    const unindexedClasses = collectUnindexedClasses(ast, activeClassNode, topLevelClassNodes, content);

    return {
        ...baseResult,
        ntype,
        mixins,
        configs,
        methods,
        calls,
        configWrites,
        unindexedClasses
    }
}

export default inspectSourceModule;

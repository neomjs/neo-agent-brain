import * as acorn from 'acorn';
import Base       from 'neo.mjs/src/core/Base.mjs';
import logger     from '../../../mcp/server/knowledge-base/logger.mjs';

/**
 * @summary Parses one source module into the single class-description universe shared by chunking
 * and repository hierarchy derivation.
 *
 * A separate hierarchy scan already produced different class totals from the chunks whose ids it
 * was meant to protect. Keeping the AST walk here makes `className`, superclass declaration, and
 * import bindings one producer contract rather than two implementations that merely look similar.
 *
 * @param {String} content Raw module source.
 * @param {String} filePath Repository-relative source path.
 * @param {Object} [options]
 * @param {Boolean} [options.strict=false]
 * @returns {Object|null}
 * @private
 */
function inspectSourceModule(content, filePath, {strict = false} = {}) {
    if (content.startsWith('#!')) {
        content = content.replace(/^#!.*\n/u, '');
    }

    let ast;

    try {
        ast = acorn.parse(content, {sourceType: 'module', locations: true, ecmaVersion: 'latest'});
    } catch (cause) {
        logger.warn(`Failed to parse source file ${filePath}: ${cause.message}`);

        if (strict) {
            const error = new Error(`Repository source '${filePath}' could not be parsed.`);

            error.code    = 'KB_SOURCE_PARSE_FAILED';
            error.details = {sourcePath: filePath};

            throw error
        }

        return null
    }

    const
        contextNodes  = [],
        propertyNodes = [],
        methodNodes   = [],
        imports       = [];
    let
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

            classStart      = classDecl.start;
            classDefinition = content.substring(classDecl.start, classDecl.body.start + 1);
            className       = classDecl.id?.name || '';
            declaresSuper   = Boolean(classDecl.superClass);

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
                } else if (member.type === 'PropertyDefinition') {
                    if (member.key.name === 'config' && member.static) {
                        configNode = member;

                        if (member.value?.type === 'ObjectExpression') {
                            const classNameProp = member.value.properties
                                .find(property => property.key?.name === 'className');

                            if (classNameProp?.value?.type === 'Literal') {
                                className = classNameProp.value.value;
                            }
                        }
                    } else {
                        propertyNodes.push(member);
                    }
                }
            })
        }
    });

    return {
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
    }
}

/**
 * @summary Parses Neo.mjs source files into granular knowledge chunks.
 *
 * This parser decomposes ES modules (source code) into semantically meaningful chunks,
 * providing the Knowledge Base with deep insight into implementation details, not just
 * API signatures.
 *
 * It identifies and extracts:
 * 1.  **Module Context:** Imports, top-level variables, and the class definition header.
 * 2.  **Class Properties:** Static and instance fields (excluding `config`).
 * 3.  **Config Block:** The entire `static config` object as a single, cohesive unit.
 * 4.  **Methods:** Individual class methods including their bodies and JSDoc.
 *
 * It uses AST parsing (via `acorn`) to robustly handle the code structure.
 *
 * @class Neo.ai.services.knowledge-base.parser.SourceParser
 * @extends Neo.core.Base
 * @singleton
 */
class SourceParser extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.services.knowledge-base.parser.SourceParser'
         * @protected
         */
        className: 'Neo.ai.services.knowledge-base.parser.SourceParser',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * @summary Describes one module's class and import-bound superclass using the same AST walk as
     * chunk generation.
     * @param {String} content Raw file content.
     * @param {String} filePath Repository-relative file path.
     * @param {Object} [options]
     * @param {Boolean} [options.strict=false]
     * @returns {{className: String, declaresSuper: Boolean, superClassReference: Object|null, imports: Object[]}|null}
     */
    describeClass(content, filePath, {strict = false} = {}) {
        const inspected = inspectSourceModule(content, filePath, {strict});

        if (!inspected) {
            return null
        }

        return Object.freeze({
            className          : inspected.className,
            declaresSuper      : inspected.declaresSuper,
            superClassReference: inspected.superClassReference,
            imports            : inspected.imports
        })
    }

    /**
     * Parses a Neo.mjs source file into granular chunks.
     * @param {String} content The raw file content.
     * @param {String} filePath The relative file path.
     * @param {String} [defaultType='src'] The type to assign to chunks (e.g., 'src', 'app', 'example').
     * @param {Object} [hierarchy={}] The authoritative class hierarchy map.
     * @param {Object} [coverage=null] Optional `{declared, resolved}` accumulator, incremented in
     *     place when this module declares a superclass. Passed in rather than returned so callers
     *     measure the SAME universe the chunks come from — a reimplemented scan measures its own,
     *     which is the producer/consumer mismatch this area exists to fix.
     * @param {Object} [options]
     * @param {Boolean} [options.strict=false] Refuse malformed input with a coded error instead of
     *     publishing the legacy empty-array result. Repository materialization enables this because
     *     an empty yield can become deletion authority; the legacy corpus path deliberately does not.
     * @returns {Array<Object>} An array of chunks.
     */
    parse(content, filePath, defaultType='src', hierarchy={}, coverage=null, {strict = false} = {}) {
        const inspected = inspectSourceModule(content, filePath, {strict});

        if (!inspected) {
            return []
        }

        ({content} = inspected);

        const {
            ast,
            contextNodes,
            propertyNodes,
            configNode,
            methodNodes,
            classStart,
            classDefinition,
            className,
            declaresSuper
        } = inspected;
        const chunks     = [];
        let   superClass = '';

        // Resolve superclass using the authoritative hierarchy map
        if (className && hierarchy[className]) {
            superClass = hierarchy[className];
        }

        // Hierarchy-coverage tally, recorded at the exact point resolution succeeds or fails so the
        // measured universe IS the ingested one. A module only counts when the AST saw an `extends`
        // clause and a `className` was resolved: a class with no superclass is legitimately
        // unresolved rather than a gap, and a file acorn could not parse contributes no chunks and
        // so puts no ids at risk.
        if (coverage && className && declaresSuper) {
            coverage.declared++;
            superClass && coverage.resolved++;
        }

        const commonMetadata = {
            className,
            extends: superClass
        };

        // 2. Extract Module Context Chunk
        // Captures everything from the start of the file up to the opening brace of the class body.
        // This includes:
        // - Imports
        // - Top-level variables
        // - Class JSDoc
        // - Class Declaration line (e.g. "class MyComponent extends Base {")
        let contextContent = '';

        if (classStart > 0) {
             const preClassContent = content.substring(0, classStart).trim();
             contextContent = (preClassContent ? preClassContent + '\n\n' : '') + classDefinition;
        } else if (contextNodes.length > 0) {
            // Fallback for files without a class (e.g. utility modules)
            const lastNode = contextNodes[contextNodes.length - 1];
            contextContent = content.substring(0, lastNode.end);
        }

        if (contextContent.trim()) {
            chunks.push({
                type      : defaultType,
                kind      : 'module-context',
                name      : `${filePath} - [Module Context]`,
                content   : contextContent.trim(),
                source    : filePath,
                line_start: 1,
                line_end  : ast.loc.end.line, // Approximation
                ...commonMetadata
            });
        }

        // 3. Extract Class Properties Chunk
        if (propertyNodes.length > 0) {
            // We join the raw source of all property nodes
            const propsContent = propertyNodes.map(node => content.substring(node.start, node.end)).join('\n\n');
            chunks.push({
                type      : defaultType,
                kind      : 'class-properties',
                name      : `${filePath} - [Class Properties]`,
                content   : propsContent,
                source    : filePath,
                line_start: propertyNodes[0].loc.start.line,
                line_end  : propertyNodes[propertyNodes.length - 1].loc.end.line,
                ...commonMetadata
            });
        }

        // 4. Extract Config Chunk
        if (configNode) {
            chunks.push({
                type      : defaultType,
                kind      : 'class-config',
                name      : `${filePath} - [Config]`,
                content   : content.substring(configNode.start, configNode.end),
                source    : filePath,
                line_start: configNode.loc.start.line,
                line_end  : configNode.loc.end.line,
                ...commonMetadata
            });
        }

        // 5. Extract Method Chunks
        methodNodes.forEach(node => {
            const methodName = node.key.name || '[computed]';
            chunks.push({
                type      : defaultType,
                kind      : 'method',
                name      : `${filePath} - ${methodName}()`,
                content   : content.substring(node.start, node.end),
                source    : filePath,
                line_start: node.loc.start.line,
                line_end  : node.loc.end.line,
                ...commonMetadata
            });
        });

        return chunks;
    }
}

export default Neo.setupClass(SourceParser);

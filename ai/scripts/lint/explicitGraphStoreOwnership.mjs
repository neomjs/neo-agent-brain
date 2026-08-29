import fs                               from 'node:fs';
import path                             from 'node:path';
import {fileURLToPath}                  from 'node:url';
import {parseModule, walkWithAncestors} from './scriptPlaneClosure.mjs';

const
    __dirname = path.dirname(fileURLToPath(import.meta.url)),
    AI_ROOT   = path.resolve(__dirname, '../..');

/**
 * @summary Returns the binding name from a parameter assignment target when one is explicit.
 * @param {Object} node ESTree assignment target.
 * @returns {String}
 */
function assignmentName(node) {
    return node?.type === 'Identifier' ? node.name : '<destructured>'
}

/**
 * @summary Classifies whether a default expression silently derives a store coordinate locally.
 *
 * The two forbidden sources are the mechanical discriminator established by the storage-ownership
 * contract: module location (`import.meta.url`) and invocation location (`process.cwd()`). A caller
 * that omits such a parameter receives a nearby checkout store instead of proving which deployment
 * store it intended.
 *
 * @param {Object} expression ESTree expression.
 * @returns {'import-meta-url'|'process-cwd'|null}
 */
function implicitCoordinateSource(expression) {
    let source = null;

    walkWithAncestors(expression, node => {
        if (source) return;

        if (node.type === 'MemberExpression' && !node.computed &&
            node.object?.type === 'MetaProperty' &&
            node.object.meta?.name === 'import' && node.object.property?.name === 'meta' &&
            node.property?.name === 'url') {
            source = 'import-meta-url';
            return
        }

        if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' &&
            !node.callee.computed && node.callee.object?.name === 'process' &&
            node.callee.property?.name === 'cwd') {
            source = 'process-cwd'
        }
    });

    return source
}

/**
 * @summary Finds direct SQLite modules whose function defaults silently select a local store.
 *
 * A module is in scope only when it imports `better-sqlite3` and constructs that imported binding.
 * Explicit `dbPath` parameters remain legal regardless of how callers obtain them; this rule targets
 * the dangerous fallback itself, not direct handles as a category.
 *
 * @param {String} source Module source.
 * @returns {Array<{code:String,line:Number|null,parameter:String,source:String}>}
 */
export function findImplicitGraphStoreDefaults(source) {
    const ast = parseModule(source);

    if (!ast) {
        return [{code: 'unparseable', line: null, parameter: '<unknown>', source: 'unparseable'}]
    }

    const sqliteBindings = new Set();

    walkWithAncestors(ast, node => {
        if (node.type === 'ImportDeclaration' && node.source?.value === 'better-sqlite3') {
            node.specifiers.forEach(specifier => sqliteBindings.add(specifier.local.name))
        }
    });

    if (sqliteBindings.size === 0) return [];

    let opensDirectHandle = false;

    walkWithAncestors(ast, node => {
        if (node.type === 'NewExpression' && node.callee?.type === 'Identifier' &&
            sqliteBindings.has(node.callee.name)) {
            opensDirectHandle = true
        }
    });

    if (!opensDirectHandle) return [];

    const findings = [];

    walkWithAncestors(ast, node => {
        if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
            return
        }

        node.params.forEach(parameter => {
            walkWithAncestors(parameter, candidate => {
                if (candidate.type !== 'AssignmentPattern') return;

                const sourceKind = implicitCoordinateSource(candidate.right);

                if (sourceKind) {
                    findings.push({
                        code     : 'implicit-graph-store-default',
                        line     : candidate.loc?.start?.line ?? null,
                        parameter: assignmentName(candidate.left),
                        source   : sourceKind
                    })
                }
            })
        })
    });

    return findings
}

/**
 * @summary Lists JavaScript modules beneath one root without following symlinks.
 * @param {String} root Absolute directory.
 * @returns {String[]}
 */
function listModules(root) {
    const files = [];

    const walk = directory => {
        fs.readdirSync(directory, {withFileTypes: true}).forEach(entry => {
            const target = path.join(directory, entry.name);

            if (entry.isDirectory()) walk(target);
            else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(target)
        })
    };

    walk(root);
    return files.sort()
}

/**
 * @summary Enforces explicit graph-store selection across Brain production modules.
 * @param {Object} [options]
 * @param {String[]} [options.files=listModules(AI_ROOT)] Absolute modules to inspect.
 * @param {Object} [options.logger=console] Output sink.
 * @returns {{exitCode:Number,findings:Array<Object>,filesRead:Number}}
 */
export function runExplicitGraphStoreOwnershipLint({files = listModules(AI_ROOT), logger = console} = {}) {
    const findings = [];

    files.forEach(file => {
        let source;

        try {
            source = fs.readFileSync(file, 'utf8')
        } catch (error) {
            findings.push({file, code: 'unreadable', line: null, parameter: '<unknown>', source: error.message});
            return
        }

        findImplicitGraphStoreDefaults(source).forEach(finding => findings.push({file, ...finding}))
    });

    if (findings.length === 0) {
        logger.log(`[explicit-graph-store] OK — ${files.length} production module(s), no implicit store defaults.`);
        return {exitCode: 0, findings, filesRead: files.length}
    }

    logger.error(`[explicit-graph-store] FAILED — ${findings.length} implicit or unreadable store owner(s):`);
    findings.forEach(finding => logger.error(
        `  ${path.relative(AI_ROOT, finding.file)}:${finding.line ?? '?'} ` +
        `${finding.parameter} (${finding.source})`
    ));
    logger.error('Require an explicit path and fail closed when it is absent; never infer a graph store from checkout or cwd.');

    return {exitCode: 1, findings, filesRead: files.length}
}

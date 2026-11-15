#!/usr/bin/env node
/**
 * @summary Standalone Neo-aware source-tree code index CLI (`card`, `callers`, `scene`, `stats`).
 *
 * Usage:
 *   npm run ai:code-index -- --root <dir> <card|callers|scene|stats> [target] [--json] [--log <file>] [--limit <n>]
 */
import {Command}       from 'commander';
import fs              from 'node:fs';
import path            from 'node:path';
import process         from 'node:process';
import {isEntryModule} from '../../services/shared/isEntryModule.mjs';
import {
    indexSourceTree,
    readClassCard,
    readFolderScene,
    readMethodCallers,
    summarizeSourceTreeIndex
}                      from '../../services/knowledge-base/helpers/sourceTreeIndex.mjs';

const DEFAULT_ROOT       = 'src';
const DEFAULT_TEXT_LIMIT = 100;
const VALID_READ_MODES   = new Set(['card', 'callers', 'scene', 'stats']);

/**
 * @summary Creates the Commander CLI definition for `ai:code-index`.
 * @returns {Command}
 */
export function createProgram() {
    return new Command()
        .name('ai-code-index')
        .description('Inspect one Neo source tree for class cards, method callers, hook dispatches, and folder scenes.')
        .argument('[read]', 'Read mode: card, callers, scene, or stats.', 'stats')
        .argument('[target]', 'ClassName, ClassName#method, or folder path.')
        .option('-r, --root <dir>', 'Root directory to index.', DEFAULT_ROOT)
        .option('--json', 'Emit JSON instead of human-readable text.')
        .option('--log <file>', 'Append one JSONL telemetry line per read.')
        .option('--limit <n>', 'Maximum rows per list section (0 for unlimited).');
}

/**
 * @summary Parses CLI arguments into normalized command options.
 * @param {String[]} [argv]
 * @returns {{read: String, target: String|null, root: String, json: Boolean, log: String|null, limit: Number|undefined}}
 */
export function parseArgs(argv = process.argv.slice(2)) {
    const program = createProgram();

    program.exitOverride();
    program.configureOutput({writeOut: () => {}, writeErr: () => {}});
    program.parse(argv, {from: 'user'});

    const opts           = program.opts();
    const [read, target] = program.args;
    const rawLimit       = opts.limit !== undefined ? Number(opts.limit) : undefined;

    if (rawLimit !== undefined && (!Number.isInteger(rawLimit) || rawLimit < 0)) {
        const error = new Error(`Invalid --limit value '${opts.limit}': expected a non-negative integer.`);
        error.code  = 'CODE_INDEX_INVALID_LIMIT';
        throw error
    }

    return {
        read  : read || 'stats',
        target: target ?? null,
        root  : opts.root,
        json  : Boolean(opts.json),
        log   : opts.log ?? null,
        limit : rawLimit
    }
}

/**
 * @summary Slices an array according to `limit` and tracks omitted row counts.
 * @param {Array} items
 * @param {Number} limit
 * @param {{cut: Boolean, omittedRows: Number}} tracker
 * @returns {{rows: Array, omitted: Number, total: Number}}
 */
function capRows(items, limit, tracker) {
    if (limit > 0 && items.length > limit) {
        const omitted       = items.length - limit;
        tracker.cut         = true;
        tracker.omittedRows += omitted;

        return {
            rows : items.slice(0, limit),
            omitted,
            total: items.length
        }
    }

    return {
        rows   : items,
        omitted: 0,
        total  : items.length
    }
}

/**
 * @summary Formats an unknown-symbol candidate list in plain text.
 * @param {String} label
 * @param {Object} result
 * @param {Number} limit
 * @param {{cut: Boolean, omittedRows: Number}} tracker
 * @returns {String}
 */
function formatNotFound(label, result, limit, tracker) {
    const lines  = [`Unknown ${label}: ${result.query}`];
    const capped = capRows(result.candidates || [], limit, tracker);

    if (capped.total === 0) {
        lines.push('Candidates: (none)');
    } else {
        lines.push(`Candidates (${capped.total}):`);
        capped.rows.forEach(item => lines.push(`  ${item}`));
        if (capped.omitted > 0) {
            lines.push(`  ... (${capped.omitted} rows omitted; ${capped.total} total)`);
        }
    }

    return `${lines.join('\n')}\n`
}

/**
 * @summary Formats a `card` read in plain text.
 * @param {Object} result
 * @param {Object} index
 * @param {Number} limit
 * @param {{cut: Boolean, omittedRows: Number}} tracker
 * @returns {String}
 */
function formatCardText(result, index, limit, tracker) {
    if (!result.found) {
        return formatNotFound('class', result, limit, tracker)
    }

    const lines = [
        `Class: ${result.className}${result.ntype ? ` (ntype: ${result.ntype})` : ''}`,
        `File: ${result.sourcePath}`,
        `Revision: ${index.commit || 'untracked'}${index.origin ? ` (${index.origin})` : ''}`,
        `Chain: ${result.chain.join(' -> ')}`,
        `Mixins: ${result.mixins.length > 0 ? result.mixins.join(', ') : '(none)'}`
    ];

    const configsCap = capRows(result.configs, limit, tracker);
    lines.push(`Configs (${configsCap.total}):`);
    if (configsCap.total === 0) {
        lines.push('  (none)');
    } else {
        for (const cfg of configsCap.rows) {
            const reactivity = cfg.reactive ? 'reactive' : 'static';
            const originTag  = cfg.inherited ? `, inherited from ${cfg.definedOn}:${cfg.line}` : `, line ${cfg.line}`;
            const hookTag    = cfg.hooks.length > 0
                ? ` hooks: ${cfg.hooks.map(h => `${h.methodName} (L${h.line})`).join(', ')}`
                : '';
            lines.push(`  ${cfg.declaredKey} [${reactivity}${originTag}]${hookTag}`);
        }
        if (configsCap.omitted > 0) {
            lines.push(`  ... (${configsCap.omitted} rows omitted; ${configsCap.total} total)`);
        }
    }

    const methodsCap = capRows(result.methods, limit, tracker);
    lines.push(`Methods (${methodsCap.total}):`);
    if (methodsCap.total === 0) {
        lines.push('  (none)');
    } else {
        for (const method of methodsCap.rows) {
            const staticPrefix = method.static ? 'static ' : '';
            const overrideDesc = method.overrides ? `true (${method.overridesFrom})` : 'false';
            const hookDesc     = method.hook
                ? method.hook.bound
                    ? ` hook(${method.hook.kind}:${method.hook.configName})`
                    : ` hook(${method.hook.kind}:${method.hook.configName}, unbound:${method.hook.reason})`
                : '';
            lines.push(
                `  ${staticPrefix}${method.name} [L${method.line}-${method.endLine}]${hookDesc} ` +
                `overrides=${overrideDesc} callsSuper=${method.callsSuper}`
            );
        }
        if (methodsCap.omitted > 0) {
            lines.push(`  ... (${methodsCap.omitted} rows omitted; ${methodsCap.total} total)`);
        }
    }

    const unresolvedCap = capRows(result.unresolved, limit, tracker);
    if (unresolvedCap.total > 0) {
        lines.push(`Unresolved (${unresolvedCap.total}):`);
        for (const row of unresolvedCap.rows) {
            const owner = row.methodName ? `${row.className}#${row.methodName}` : row.className || row.sourcePath;
            lines.push(`  ${row.sourcePath}:${row.line} ${owner} -> ${row.target} (${row.reason})`);
        }
        if (unresolvedCap.omitted > 0) {
            lines.push(`  ... (${unresolvedCap.omitted} rows omitted; ${unresolvedCap.total} total)`);
        }
    }

    if (tracker.cut) {
        lines.push(`Result cut: ${tracker.omittedRows} rows omitted (pass --limit 0 for all rows).`);
    }

    return `${lines.join('\n')}\n`
}

/**
 * @summary Formats a `callers` read in plain text, labelling hook config writes strictly as `possible dispatch`.
 * @param {Object} result
 * @param {Object} index
 * @param {Number} limit
 * @param {{cut: Boolean, omittedRows: Number}} tracker
 * @returns {String}
 */
function formatCallersText(result, index, limit, tracker) {
    if (!result.found) {
        return formatNotFound('method', result, limit, tracker)
    }

    const lines = [
        `Target: ${result.target} (${result.sourcePath}:${result.line})`,
        `Revision: ${index.commit || 'untracked'}${index.origin ? ` (${index.origin})` : ''}`
    ];

    if (result.hook) {
        if (result.hook.bound) {
            lines.push(
                `Hook: ${result.hook.kind} bound to reactive config '${result.hook.configName}' ` +
                `(${result.hook.configOwner}:${result.hook.configLine})`
            );
        } else {
            lines.push(`Hook: ${result.hook.kind} for '${result.hook.configName}' (unbound: ${result.hook.reason})`);
        }
    }

    const callsCap = capRows(result.calls, limit, tracker);
    lines.push(`Direct call sites (${callsCap.total}):`);
    if (callsCap.total === 0) {
        lines.push('  (none)');
    } else {
        for (const row of callsCap.rows) {
            lines.push(
                `  [call] ${row.sourcePath}:${row.line} ${row.callerClass}#${row.callerMethod} (${row.expression})`
            );
        }
        if (callsCap.omitted > 0) {
            lines.push(`  ... (${callsCap.omitted} rows omitted; ${callsCap.total} total)`);
        }
    }

    if (result.hook) {
        const dispatchCap = capRows(result.possibleDispatches, limit, tracker);
        lines.push(`Config writes for '${result.hook.configName}' (${dispatchCap.total}):`);
        if (dispatchCap.total === 0) {
            lines.push('  (none)');
        } else {
            for (const row of dispatchCap.rows) {
                lines.push(
                    `  [possible dispatch] ${row.sourcePath}:${row.line} ` +
                    `${row.writerClass}#${row.writerMethod} (${row.expression})`
                );
            }
            if (dispatchCap.omitted > 0) {
                lines.push(`  ... (${dispatchCap.omitted} rows omitted; ${dispatchCap.total} total)`);
            }
        }
    }

    const overridesCap = capRows(result.overrides, limit, tracker);
    if (overridesCap.total > 0) {
        lines.push(`Subclass overrides (${overridesCap.total}):`);
        for (const row of overridesCap.rows) {
            lines.push(
                `  ${row.sourcePath}:${row.line} ${row.className}#${row.methodName} (callsSuper=${row.callsSuper})`
            );
        }
        if (overridesCap.omitted > 0) {
            lines.push(`  ... (${overridesCap.omitted} rows omitted; ${overridesCap.total} total)`);
        }
    }

    if (tracker.cut) {
        lines.push(`Result cut: ${tracker.omittedRows} rows omitted (pass --limit 0 for all rows).`);
    }

    return `${lines.join('\n')}\n`
}

/**
 * @summary Formats a `scene` read in plain text.
 * @param {Object} result
 * @param {Object} index
 * @param {Number} limit
 * @param {{cut: Boolean, omittedRows: Number}} tracker
 * @returns {String}
 */
function formatSceneText(result, index, limit, tracker) {
    if (!result.found) {
        return formatNotFound('folder', result, limit, tracker)
    }

    const lines = [
        `Scene: ${result.folder}`,
        `Revision: ${index.commit || 'untracked'}${index.origin ? ` (${index.origin})` : ''}`
    ];

    const classesCap = capRows(result.classes, limit, tracker);
    lines.push(`Classes (${classesCap.total}):`);
    for (const cls of classesCap.rows) {
        const ntypeTag = cls.ntype ? ` (ntype: ${cls.ntype})` : '';
        lines.push(
            `  ${cls.className}${ntypeTag} — ${cls.sourcePath} ` +
            `[configs=${cls.configCount}, methods=${cls.methodCount}]`
        );
    }
    if (classesCap.omitted > 0) {
        lines.push(`  ... (${classesCap.omitted} rows omitted; ${classesCap.total} total)`);
    }

    const inhInternal = capRows(result.inheritance.internal, limit, tracker);
    lines.push(`Inheritance inside folder (${inhInternal.total}):`);
    if (inhInternal.total === 0) {
        lines.push('  (none)');
    } else {
        inhInternal.rows.forEach(edge => lines.push(`  ${edge.from} -> ${edge.to}`));
        if (inhInternal.omitted > 0) {
            lines.push(`  ... (${inhInternal.omitted} rows omitted; ${inhInternal.total} total)`);
        }
    }

    const inhOut = capRows(result.inheritance.outbound, limit, tracker);
    lines.push(`Inheritance across border — outbound (${inhOut.total}):`);
    if (inhOut.total === 0) {
        lines.push('  (none)');
    } else {
        inhOut.rows.forEach(edge => lines.push(
            `  ${edge.from} -> ${edge.to}${edge.targetPath ? ` (${edge.targetPath})` : ' [unresolved]'}`
        ));
        if (inhOut.omitted > 0) {
            lines.push(`  ... (${inhOut.omitted} rows omitted; ${inhOut.total} total)`);
        }
    }

    const inhIn = capRows(result.inheritance.inbound, limit, tracker);
    lines.push(`Inheritance across border — inbound (${inhIn.total}):`);
    if (inhIn.total === 0) {
        lines.push('  (none)');
    } else {
        inhIn.rows.forEach(edge => lines.push(`  ${edge.from} (${edge.sourcePath}) -> ${edge.to}`));
        if (inhIn.omitted > 0) {
            lines.push(`  ... (${inhIn.omitted} rows omitted; ${inhIn.total} total)`);
        }
    }

    const mixInternal = capRows(result.mixins.internal, limit, tracker);
    const mixOut      = capRows(result.mixins.outbound, limit, tracker);
    const mixIn       = capRows(result.mixins.inbound, limit, tracker);
    lines.push(
        `Mixins (inside=${mixInternal.total}, outbound=${mixOut.total}, inbound=${mixIn.total}):`
    );
    if (mixInternal.total + mixOut.total + mixIn.total === 0) {
        lines.push('  (none)');
    } else {
        mixInternal.rows.forEach(edge => lines.push(`  [inside] ${edge.from} mixes ${edge.mixin}`));
        mixOut.rows.forEach(edge => lines.push(
            `  [outbound] ${edge.from} mixes ${edge.mixin}${edge.targetPath ? ` (${edge.targetPath})` : ''}`
        ));
        mixIn.rows.forEach(edge => lines.push(
            `  [inbound] ${edge.from} (${edge.sourcePath}) mixes ${edge.mixin}`
        ));
        const mixOmitted = mixInternal.omitted + mixOut.omitted + mixIn.omitted;
        if (mixOmitted > 0) {
            lines.push(`  ... (${mixOmitted} mixin rows omitted)`);
        }
    }

    const extCap = capRows(result.externalCalls, limit, tracker);
    lines.push(`Methods called from outside folder (${extCap.total}):`);
    if (extCap.total === 0) {
        lines.push('  (none)');
    } else {
        for (const group of extCap.rows) {
            lines.push(`  ${group.target} (${group.callCount} external sites):`);
            const siteCap = capRows(group.callers, limit, tracker);
            for (const site of siteCap.rows) {
                lines.push(`    ${site.sourcePath}:${site.line} ${site.callerClass}#${site.callerMethod} (${site.receiver})`);
            }
            if (siteCap.omitted > 0) {
                lines.push(`    ... (${siteCap.omitted} caller sites omitted; ${siteCap.total} total)`);
            }
        }
        if (extCap.omitted > 0) {
            lines.push(`  ... (${extCap.omitted} target methods omitted; ${extCap.total} total)`);
        }
    }

    if (tracker.cut) {
        lines.push(`Result cut: ${tracker.omittedRows} rows omitted (pass --limit 0 for all rows).`);
    }

    return `${lines.join('\n')}\n`
}

/**
 * @summary Formats tree summary `stats` in plain text.
 * @param {Object} summary
 * @returns {String}
 */
function formatStatsText(summary) {
    const {stats} = summary;
    const lines   = [
        'Code Index Summary',
        `Root: ${summary.rootDir}`,
        `Origin: ${summary.origin || 'untracked'}`,
        `Revision: ${summary.commit || 'untracked'}`,
        `Extractor version: ${summary.extractorVersion}`,
        `Index build time: ${summary.indexDurationMs} ms`,
        `Files indexed: ${stats.fileCount}`,
        `Classes indexed: ${stats.classCount}`,
        `Classes with resolved superclass: ${stats.superclasses.resolved} / ${stats.superclasses.declared}`,
        'Bound call pairs per receiver:',
        `  this:  ${stats.callPairs.this.bound} / ${stats.callPairs.this.total}`,
        `  me:    ${stats.callPairs.me.bound} / ${stats.callPairs.me.total}`,
        `  super: ${stats.callPairs.super.bound} / ${stats.callPairs.super.total}`,
        `  all:   ${stats.callPairs.all.bound} / ${stats.callPairs.all.total}`,
        `Hooks bound to a config: ${stats.hooks.bound} / ${stats.hooks.total}`,
        `Unresolved targets: ${stats.unresolvedCount}`
    ];

    return `${lines.join('\n')}\n`
}

/**
 * @summary Applies `--limit` truncation to JSON result arrays while recording omitted row counts.
 * @param {String} readMode
 * @param {Object} rawResult
 * @param {Number} limit
 * @param {{cut: Boolean, omittedRows: Number}} tracker
 * @returns {Object}
 */
function buildJsonPayload(readMode, rawResult, limit, tracker) {
    if (limit <= 0) {
        return rawResult
    }

    if (rawResult.found === false) {
        return {
            ...rawResult,
            candidates: capRows(rawResult.candidates || [], limit, tracker).rows
        }
    }

    switch (readMode) {
        case 'card':
            return {
                ...rawResult,
                configs   : capRows(rawResult.configs, limit, tracker).rows,
                methods   : capRows(rawResult.methods, limit, tracker).rows,
                unresolved: capRows(rawResult.unresolved, limit, tracker).rows
            };
        case 'callers':
            return {
                ...rawResult,
                calls             : capRows(rawResult.calls, limit, tracker).rows,
                possibleDispatches: capRows(rawResult.possibleDispatches, limit, tracker).rows,
                overrides         : capRows(rawResult.overrides, limit, tracker).rows
            };
        case 'scene':
            return {
                ...rawResult,
                classes: capRows(rawResult.classes, limit, tracker).rows,
                inheritance: {
                    internal: capRows(rawResult.inheritance.internal, limit, tracker).rows,
                    outbound: capRows(rawResult.inheritance.outbound, limit, tracker).rows,
                    inbound : capRows(rawResult.inheritance.inbound, limit, tracker).rows
                },
                mixins: {
                    internal: capRows(rawResult.mixins.internal, limit, tracker).rows,
                    outbound: capRows(rawResult.mixins.outbound, limit, tracker).rows,
                    inbound : capRows(rawResult.mixins.inbound, limit, tracker).rows
                },
                externalCalls: capRows(rawResult.externalCalls, limit, tracker).rows,
                unresolved   : capRows(rawResult.unresolved, limit, tracker).rows
            };
        case 'stats':
            return {
                ...rawResult,
                unresolved: capRows(rawResult.unresolved, limit, tracker).rows
            };
        default:
            return rawResult;
    }
}

/**
 * @summary Executes the `ai:code-index` CLI workflow and returns structured execution metadata.
 * @param {String[]} [argv]
 * @param {Object} [io]
 * @param {String} [io.cwd]
 * @param {{write: Function}} [io.stdout]
 * @returns {{exitCode: Number, result: Object, output: String, logEntry: Object}}
 */
export function main(argv = process.argv.slice(2), {
    cwd    = process.cwd(),
    stdout = process.stdout
} = {}) {
    const options = parseArgs(argv);

    if (!VALID_READ_MODES.has(options.read)) {
        const error = new Error(
            `Unknown read mode '${options.read}'. Expected one of: card, callers, scene, stats.`
        );
        error.code = 'CODE_INDEX_INVALID_READ';
        throw error
    }

    if (options.read !== 'stats' && !options.target) {
        const error = new Error(`Read mode '${options.read}' requires a target argument.`);
        error.code  = 'CODE_INDEX_MISSING_TARGET';
        throw error
    }

    const rootDir = path.resolve(cwd, options.root);
    const index   = indexSourceTree({rootDir});

    const readStartedAt = performance.now();
    const effectiveLimit = options.limit !== undefined
        ? options.limit
        : (options.json ? 0 : DEFAULT_TEXT_LIMIT);
    const tracker = {cut: false, omittedRows: 0};

    let rawResult;
    switch (options.read) {
        case 'card':
            rawResult = readClassCard(index, options.target);
            break;
        case 'callers':
            rawResult = readMethodCallers(index, options.target);
            break;
        case 'scene':
            rawResult = readFolderScene(index, options.target);
            break;
        case 'stats':
            rawResult = summarizeSourceTreeIndex(index);
            break;
    }

    const unresolvedRows = rawResult.unresolved || [];
    const unresolvedTargets = unresolvedRows.map(row => row.target);

    let output;
    if (options.json) {
        const payload        = buildJsonPayload(options.read, rawResult, effectiveLimit, tracker);
        const readDurationMs = Number((performance.now() - readStartedAt).toFixed(2));
        const envelope       = {
            ...payload,
            meta: {
                read             : options.read,
                argument         : options.target,
                origin           : index.origin,
                commit           : index.commit,
                extractorVersion : index.extractorVersion,
                indexDurationMs  : index.indexDurationMs,
                readDurationMs,
                cut              : tracker.cut,
                omittedRows      : tracker.omittedRows,
                unresolvedCount  : unresolvedTargets.length
            }
        };
        output = `${JSON.stringify(envelope, null, 2)}\n`;
    } else {
        switch (options.read) {
            case 'card':
                output = formatCardText(rawResult, index, effectiveLimit, tracker);
                break;
            case 'callers':
                output = formatCallersText(rawResult, index, effectiveLimit, tracker);
                break;
            case 'scene':
                output = formatSceneText(rawResult, index, effectiveLimit, tracker);
                break;
            case 'stats':
                output = formatStatsText(rawResult);
                break;
        }
    }

    const readDurationMs = Number((performance.now() - readStartedAt).toFixed(2));
    const logEntry       = {
        read            : options.read,
        argument        : options.target,
        origin          : index.origin,
        commit          : index.commit,
        extractorVersion: index.extractorVersion,
        resultBytes     : Buffer.byteLength(output, 'utf8'),
        unresolvedTargets,
        unresolvedCount : unresolvedTargets.length,
        cut             : tracker.cut,
        omittedRows     : tracker.omittedRows,
        indexDurationMs : index.indexDurationMs,
        readDurationMs,
        timestamp       : new Date().toISOString()
    };

    if (options.log) {
        const logPath = path.resolve(cwd, options.log);
        fs.mkdirSync(path.dirname(logPath), {recursive: true});
        fs.appendFileSync(logPath, `${JSON.stringify(logEntry)}\n`, 'utf8');
    }

    stdout.write(output);

    const exitCode = rawResult.found === false ? 1 : 0;

    return {
        exitCode,
        result: rawResult,
        output,
        logEntry
    }
}

if (isEntryModule(import.meta.url)) {
    try {
        const {exitCode} = main(process.argv.slice(2));
        if (exitCode !== 0) {
            process.exitCode = exitCode;
        }
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
    }
}

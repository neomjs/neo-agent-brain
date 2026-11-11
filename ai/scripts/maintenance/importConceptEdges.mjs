import 'dotenv/config';
import fs              from 'fs';
import path            from 'path';
import Neo             from 'neo.mjs/src/Neo.mjs';
import * as core       from 'neo.mjs/src/core/_export.mjs';
import InstanceManager from 'neo.mjs/src/manager/Instance.mjs';
import AiConfig        from '../../config.mjs';
import ConceptService  from '../../services/ConceptService.mjs';
import {isEntryModule} from '../../services/shared/isEntryModule.mjs';

/**
 * @module ai/scripts/maintenance/importConceptEdges
 * @summary Imports curated concept edge additions and decision-backed removals into the plane store.
 *
 * Usage:
 *   node ./ai/scripts/maintenance/importConceptEdges.mjs --tenant <id> [--file <edges.jsonl>] [--dry-run]
 *
 * Contract:
 * - `--tenant <id>` is required and echoed in the JSON report. Today only the shared core corpus
 *   tenant (`kbConfig.defaultTenantId`) is admitted; any other tenant is refused before touching
 *   the store until multi-tenant concept rows and file roots land.
 * - Reads UTF-8 JSONL rows (`{source, target, type, note?}` or `{source, target, type, op: "remove", decision}`)
 *   from `--file <path>`, or from `stdin` when `--file` is omitted.
 * - Rejects malformed JSONL before any store access or write.
 * - Accepts no store-path flag or positional path; reaches the plane store solely via
 *   `ConceptService.getConceptsDir()`, configured here from `AiConfig.plane.dataRoot`.
 */

const FORBIDDEN_STORE_FLAGS = new Set([
    '--store',
    '--store-path',
    '--concepts-dir',
    '--data-root'
]);

export const USAGE_TEXT = [
    'Usage: node ./ai/scripts/maintenance/importConceptEdges.mjs --tenant <id> [--file <path.jsonl>] [--dry-run]',
    '',
    'Options:',
    '  --tenant <id>       Required tenant identifier for the imported rows',
    '  --file <path.jsonl> Read JSONL edge rows from a file (defaults to stdin)',
    '  --dry-run           Classify rows and print the JSON report without writing edges.jsonl',
    '  -h, --help          Print this help message'
].join('\n');

function createCliError(code, message) {
    const error = new Error(message);
    error.code  = code;
    return error;
}

/**
 * @summary Parses CLI arguments and rejects store-path overrides, unknown flags, and positionals.
 * @param {String[]} [argv=[]]
 * @returns {{tenant: (String|null), file: (String|null), dryRun: Boolean, help: Boolean}}
 */
export function parseArgs(argv = []) {
    const parsed = {
        tenant: null,
        file  : null,
        dryRun: false,
        help  : false
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === '-h' || arg === '--help') {
            parsed.help = true;
            continue;
        }

        if (arg === '--dry-run') {
            parsed.dryRun = true;
            continue;
        }

        const eqIndex  = arg.indexOf('='),
              flagName = eqIndex === -1 ? arg : arg.slice(0, eqIndex),
              inline   = eqIndex === -1 ? null : arg.slice(eqIndex + 1);

        if (FORBIDDEN_STORE_FLAGS.has(flagName)) {
            throw createCliError(
                'FORBIDDEN_STORE_ARGUMENT',
                `Store path overrides (${flagName}) are forbidden; importConceptEdges resolves the store exclusively through ConceptService.getConceptsDir().`
            );
        }

        if (flagName === '--tenant') {
            const value = inline !== null ? inline : argv[++i];

            if (value === undefined || (inline === null && value.startsWith('-'))) {
                throw createCliError('MISSING_OPTION_VALUE', 'Option --tenant requires a non-empty tenant identifier.');
            }

            parsed.tenant = value;
            continue;
        }

        if (flagName === '--file') {
            const value = inline !== null ? inline : argv[++i];

            if (value === undefined || value.trim().length === 0 || (inline === null && value.startsWith('-'))) {
                throw createCliError('MISSING_OPTION_VALUE', 'Option --file requires a JSONL file path.');
            }

            parsed.file = value;
            continue;
        }

        if (arg.startsWith('-')) {
            throw createCliError('UNKNOWN_ARGUMENT', `Unknown option: ${arg}`);
        }

        throw createCliError(
            'UNEXPECTED_POSITIONAL_ARGUMENT',
            `Unexpected positional argument '${arg}'; importConceptEdges accepts no store path or positional arguments.`
        );
    }

    return parsed;
}

/**
 * @summary Parses UTF-8 JSONL text into plain row objects, failing closed on any malformed line.
 * @param {String} rawText
 * @param {String} [sourceLabel='stdin']
 * @returns {Object[]}
 */
export function parseJsonlRows(rawText, sourceLabel = 'stdin') {
    if (typeof rawText !== 'string') {
        throw createCliError('MALFORMED_JSONL', `Expected UTF-8 JSONL text from ${sourceLabel}.`);
    }

    const
        lines = rawText.split(/\r?\n/),
        rows  = [];

    for (let index = 0; index < lines.length; index++) {
        const trimmed = lines[index].trim();

        if (!trimmed) {
            continue;
        }

        let record;

        try {
            record = JSON.parse(trimmed);
        } catch (cause) {
            throw createCliError('MALFORMED_JSONL', `Malformed JSONL at ${sourceLabel}:${index + 1}: ${cause.message}`);
        }

        if (!record || typeof record !== 'object' || Array.isArray(record)) {
            throw createCliError('MALFORMED_JSONL', `Malformed JSONL at ${sourceLabel}:${index + 1}: each line must be a JSON object.`);
        }

        rows.push(record);
    }

    return rows;
}

async function readStreamText(stream) {
    const chunks = [];

    for await (const chunk of stream) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    }

    return Buffer.concat(chunks).toString('utf8');
}

function configurePlaneConceptStore() {
    ConceptService.defaultConceptsDir = path.join(AiConfig.plane.dataRoot, 'concepts');
}

/**
 * @summary Executes the concept-edge import CLI against the plane store and emits a JSON report.
 * @param {String[]} [argv=process.argv.slice(2)]
 * @param {Object} [deps={}]
 * @returns {Promise<{ok: Boolean, exitCode: Number, report?: Object, error?: Error}>}
 */
export async function runCli(argv = process.argv.slice(2), deps = {}) {
    const {
        stdin          = process.stdin,
        stdout         = process.stdout,
        stderr         = process.stderr,
        env            = process.env,
        configureStore = configurePlaneConceptStore
    } = deps;

    let args;

    try {
        args = parseArgs(argv);
    } catch (error) {
        stderr.write(`${error.message}\n`);
        return {ok: false, exitCode: 1, error};
    }

    if (args.help) {
        stdout.write(`${USAGE_TEXT}\n`);
        return {ok: true, exitCode: 0};
    }

    if ((!args.tenant || args.tenant.trim().length === 0) && args.file === null && stdin?.isTTY) {
        const report = ConceptService.importEdges({
            rows  : [],
            tenant: args.tenant,
            dryRun: args.dryRun,
            env
        });
        stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return {ok: false, exitCode: 1, report};
    }

    let rawText,
        sourceLabel = 'stdin';

    try {
        if (args.file !== null) {
            const resolvedFile = path.resolve(args.file);
            sourceLabel        = args.file;
            rawText            = fs.readFileSync(resolvedFile, 'utf8');
        } else {
            rawText = await readStreamText(stdin);
        }
    } catch (cause) {
        const error = createCliError('INPUT_READ_FAILED', `Failed to read JSONL input from ${sourceLabel}: ${cause.message}`);
        stderr.write(`${error.message}\n`);
        return {ok: false, exitCode: 1, error};
    }

    let rows;

    try {
        rows = parseJsonlRows(rawText, sourceLabel);
    } catch (error) {
        stderr.write(`${error.message}\n`);
        return {ok: false, exitCode: 1, error};
    }

    try {
        configureStore();

        const report = ConceptService.importEdges({
            rows,
            tenant: args.tenant,
            dryRun: args.dryRun,
            env
        });

        stdout.write(`${JSON.stringify(report, null, 2)}\n`);

        return {
            ok      : report.ok,
            exitCode: report.ok ? 0 : 1,
            report
        };
    } catch (error) {
        stderr.write(`${error.message}\n`);
        return {ok: false, exitCode: 1, error};
    }
}

if (isEntryModule(import.meta.url)) {
    const {exitCode} = await runCli(process.argv.slice(2));
    process.exitCode = exitCode;
}

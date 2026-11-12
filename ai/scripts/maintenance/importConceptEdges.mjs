import 'dotenv/config';
import {Command}       from 'commander';
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
 * - Row classification is non-aborting per row: a `refused` or `differs` row does not prevent valid
 *   `added` or `removed` rows in the same batch from applying, so a run can exit `1` (`ok: false`)
 *   with `written: true`.
 * - Accepts no store-path flag or positional path; reaches the plane store solely via
 *   `ConceptService.getConceptsDir()`, configured here from `AiConfig.plane.dataRoot`.
 */

const FORBIDDEN_STORE_FLAGS = new Set([
    '--store',
    '--store-path',
    '--concepts-dir',
    '--data-root'
]);

/**
 * @summary Creates an `Error` instance tagged with a deterministic CLI error code.
 * @param {String} code
 * @param {String} message
 * @returns {Error}
 */
function createCliError(code, message) {
    const error = new Error(message);
    error.code  = code;
    return error;
}

/**
 * @summary Builds a fresh Commander program instance for isolated CLI option parsing.
 * @returns {Command}
 */
export function createProgram() {
    const program = new Command();

    program
        .name('importConceptEdges')
        .usage('--tenant <id> [--file <path.jsonl>] [--dry-run]')
        .description('Imports curated concept edge additions and decision-backed removals into the plane store.')
        .requiredOption('--tenant <id>', 'Required tenant identifier for the imported rows')
        .option('--file <path.jsonl>', 'Read JSONL edge rows from a file (defaults to stdin)')
        .option('--dry-run', 'Classify rows and print the JSON report without writing edges.jsonl', false)
        .allowUnknownOption(false)
        .allowExcessArguments(false);

    return program;
}

/**
 * @summary Parses CLI arguments with Commander and rejects store-path overrides, unknown flags, and positionals.
 * @param {String[]} [argv=[]]
 * @returns {{tenant: (String|null), file: (String|null), dryRun: Boolean, help: Boolean, helpText: String}}
 */
export function parseArgs(argv = []) {
    for (const arg of argv) {
        if (typeof arg !== 'string') {
            continue;
        }

        const eqIndex  = arg.indexOf('='),
              flagName = eqIndex === -1 ? arg : arg.slice(0, eqIndex);

        if (FORBIDDEN_STORE_FLAGS.has(flagName)) {
            throw createCliError(
                'FORBIDDEN_STORE_ARGUMENT',
                `Store path overrides (${flagName}) are forbidden; importConceptEdges resolves the store exclusively through ConceptService.getConceptsDir().`
            );
        }
    }

    const program = createProgram();

    program.exitOverride();
    program.configureOutput({writeOut: () => {}, writeErr: () => {}});

    try {
        program.parse(argv, {from: 'user'});
    } catch (error) {
        if (error?.code === 'commander.helpDisplayed') {
            return {
                tenant  : null,
                file    : null,
                dryRun  : false,
                help    : true,
                helpText: program.helpInformation()
            };
        }

        throw error;
    }

    const options = program.opts();

    if (typeof options.tenant !== 'string' || options.tenant.trim().length === 0 || options.tenant.startsWith('-')) {
        throw createCliError('MISSING_OPTION_VALUE', 'Option --tenant requires a non-empty tenant identifier.');
    }

    if (options.file !== undefined && (typeof options.file !== 'string' || options.file.trim().length === 0 || options.file.startsWith('-'))) {
        throw createCliError('MISSING_OPTION_VALUE', 'Option --file requires a JSONL file path.');
    }

    return {
        tenant  : options.tenant,
        file    : options.file ?? null,
        dryRun  : Boolean(options.dryRun),
        help    : false,
        helpText: program.helpInformation()
    };
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

/**
 * @summary Collects all chunks from a readable stream into a single UTF-8 string.
 * @param {AsyncIterable<Buffer|String>} stream
 * @returns {Promise<String>}
 */
async function readStreamText(stream) {
    const chunks = [];

    for await (const chunk of stream) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    }

    return Buffer.concat(chunks).toString('utf8');
}

/**
 * @summary Injects the resolved plane concept store directory (`<plane.dataRoot>/concepts`) into `ConceptService`.
 */
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
        stdout.write(args.helpText);
        return {ok: true, exitCode: 0};
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
            dryRun: args.dryRun
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

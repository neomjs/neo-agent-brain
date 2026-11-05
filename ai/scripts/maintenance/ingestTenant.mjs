// Neo namespace bootstrap (entry-point invariant) — KB data-plane CLI.
// `InstanceManager` binds Neo.find/findFirst/get aliases + consumes pre-singleton
// `Neo.idMap`; required for any consumer of the Neo singleton API.
import Neo                 from 'neo.mjs/src/Neo.mjs';
import AiConfig            from '../../config.mjs';
import * as core           from 'neo.mjs/src/core/_export.mjs';
import InstanceManager     from 'neo.mjs/src/manager/Instance.mjs';
import fs                  from 'fs';
import path                from 'node:path';
import KB_Config           from '../../mcp/server/knowledge-base/config.mjs';
import KB_ChromaManager    from '../../services/knowledge-base/ChromaManager.mjs';
import KB_IngestionService from '../../services/knowledge-base/IngestionService.mjs';
import KB_LifecycleService from '../../services/knowledge-base/DatabaseLifecycleService.mjs';
import {
    createLeaseYieldVoter,
    resolveHeavyMaintenanceLeasePath,
    withHeavyMaintenanceLease
} from '../../daemons/orchestrator/services/HeavyMaintenanceLeaseService.mjs';
import {isEntryModule}                                                      from '../../services/shared/isEntryModule.mjs';
import {closeBundlePayload, createBundlePayloadReadStream, openJsonlStream} from '../../services/shared/bundlePayload.mjs';

/**
 * @module ai/scripts/maintenance/ingestTenant
 *
 * @summary Bulk-facade CLI (`npm run ai:ingest-tenant`) for Cloud-Native KB Ingestion.
 *
 * Streams `parsed-chunk-v1` JSONL records (one record per line) from a file or stdin into the
 * Knowledge Base via {@link Neo.ai.services.knowledge-base.IngestionService}. This is
 * the bulk data-plane counterpart to the `ingest_source_files` MCP small-batch facade:
 * initial tenant onboarding (5k–50k chunks) and large `git push` hook bursts exceed the
 * MCP work-volume gate (`aiConfig.mcpSyncMaxChunks`), so the CLI calls `ingestSourceFiles` with
 * `viaMcp: false` — an explicit opt-in to long-running bulk work that bypasses that gate.
 *
 * Records are flushed in batches (`--batch-size`, default 500) so a multi-thousand-record push
 * streams incrementally rather than materializing the whole corpus in memory. The heavy work is
 * wrapped in the shared heavy-maintenance lease so a bulk ingest cannot collide with `ai:sync-kb`
 * or the orchestrator's `kbSync` task on the unified Chroma `knowledge-base` collection.
 *
 * `parseArgs`, `readJsonlRecords`, and `runIngest` are exported as pure, dependency-injectable
 * units; the CLI auto-runs only when invoked directly (the `import.meta` main guard), so the
 * module can be imported substrate-free by unit tests.
 *
 * Usage: `npm run ai:ingest-tenant -- <tenantId> (--from-file <path.jsonl> | --from-stdin) [--batch-size <n>]`
 */

const DEFAULT_BATCH_SIZE = 500;

/**
 * @summary Parses the CLI argv into a structured options object.
 * @param {String[]} argv `process.argv.slice(2)`.
 * @returns {{tenantId: String|null, fromFile: String|null, fromStdin: Boolean, batchSize: Number}}
 */
function parseArgs(argv) {
    const args       = {tenantId: null, fromFile: null, fromStdin: false, batchSize: DEFAULT_BATCH_SIZE};
    const positional = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === '--from-file') {
            args.fromFile = argv[++i];
        } else if (arg === '--from-stdin') {
            args.fromStdin = true;
        } else if (arg === '--batch-size') {
            args.batchSize = Number(argv[++i]);
        } else if (!arg.startsWith('--')) {
            positional.push(arg);
        }
    }

    args.tenantId = positional[0] || null;
    return args;
}

/**
 * @summary Prints CLI usage to stderr.
 * @returns {void}
 */
function printUsage() {
    console.error('Usage: npm run ai:ingest-tenant -- <tenantId> (--from-file <path.jsonl> | --from-stdin) [--batch-size <n>]');
}

/**
 * @summary Async-generates `parsed-chunk-v1` records from a JSONL stream, one record per line.
 *
 * Takes the readable stream directly (not a file path) so unit tests can drive it with an
 * in-memory `Readable`. Blank lines are skipped; a line that fails `JSON.parse` yields a
 * `parseError` entry instead of throwing, so one malformed line never aborts the stream.
 *
 * @param {ReadableStream} input A readable stream of UTF-8 JSONL text (a file stream or stdin).
 * @yields {{record: Object, lineNo: Number}|{parseError: String, lineNo: Number}}
 */
async function* readJsonlRecords(input) {
    const rl     = openJsonlStream(input);
    let   lineNo = 0;

    try {
        for await (const line of rl) {
            lineNo++;
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
                yield {record: JSON.parse(trimmed), lineNo};
            } catch (error) {
                yield {parseError: error.message, lineNo, rawLine: line};
            }
        }
    } finally {
        closeBundlePayload(rl)
    }
}

/**
 * @summary Batches an async stream of parsed records and ingests each batch, aggregating a summary.
 *
 * Pure orchestration: `ingestFn` is injected so unit tests can verify batching, error handling,
 * and summary aggregation without the Knowledge Base substrate. JSONL `parseError` entries are
 * counted and recorded as structured errors; valid records are flushed in `batchSize` groups.
 *
 * @param {Object}        options
 * @param {AsyncIterable} options.records  Async iterable of `readJsonlRecords` entries.
 * @param {Number}        options.batchSize Records per `ingestFn` call.
 * @param {Function}      options.ingestFn `async (files) => summary` — ingests one batch.
 * @param {Function}     [options.onBatch] `(batchNumber, summary) => void` progress callback.
 * @param {Function}     [options.shouldYield] Lease vote, also forwarded to the ingestion service.
 * @returns {Promise<Object>} Totals; a yield retains a private `resume` iterator and incomplete
 * originals. A batch error retains the whole failed batch. The caller must retain or close it.
 */
async function runIngest({records, batchSize, ingestFn, onBatch, shouldYield}) {
    const totals = {ingested: 0, embeddingsGenerated: 0, deleted: 0, batches: 0, parseErrors: 0, errors: [],
        completedInputRecords: 0, acceptedEmbeddingChunks: 0, settledEmbeddingChunks: 0};
    const iterator = records[Symbol.asyncIterator]();
    let   batch    = [];

    const yielded = (pendingRecords, remainingChunks = null) => ({
        ...totals, yielded: true, remainingChunks, resume: {pendingRecords, iterator}
    });

    const flushBatch = async () => {
        if (batch.length === 0) return null;

        if (shouldYield?.()) return yielded(batch);

        totals.batches++;
        const pending = batch;
        let incomplete;
        let summary;
        try {
            summary = await ingestFn(pending, {
                shouldYield,
                onYieldedRecords: records => { incomplete = records }
            });
        } catch {
            summary = {errors: [{code: 'KB_INGEST_CLI_BATCH_FAILED',
                message: 'Batch ingestion failed without a complete settlement receipt; original input retained for retry.'}]};
        }

        // Accepted chunks are not completed work on a yielded call. Preserve the producer's
        // settlement count, and fail closed if it did not retain the original replay records.
        if (summary.yielded && (!Array.isArray(incomplete) || !Number.isSafeInteger(summary.remaining) ||
            summary.remaining < 0 || !Number.isSafeInteger(summary.settled) || summary.settled < 0)) {
            throw new Error('Yielded ingestion omitted replay records or settlement counts');
        }
        totals.ingested            += summary.ingested || 0;
        totals.embeddingsGenerated += summary.embeddingsGenerated || 0;
        totals.deleted             += summary.deleted             || 0;
        for (const [field, value] of [['acceptedEmbeddingChunks', summary.acceptedEmbeddingChunks],
            ['settledEmbeddingChunks', summary.settled]]) {
            totals[field] = totals[field] !== null && Number.isSafeInteger(value) && value >= 0
                ? totals[field] + value : null;
        }
        totals.completedInputRecords = totals.completedInputRecords !== null && !summary.errors?.length
            ? totals.completedInputRecords + pending.length - (incomplete?.length || 0) : null;

        if (summary.errors?.length) {
            totals.errors.push(...summary.errors);
        }

        onBatch?.(totals.batches, summary);
        batch = [];
        if (summary.yielded) return yielded(incomplete, summary.remaining);
        // Stop on an errored batch before a later yield could discard it. Its settlement may
        // be unknown, so retain the batch conservatively; replay skips any landed children.
        return summary.errors?.length ? {...totals, failed: true, resume: {pendingRecords: pending, iterator}} : null;
    };

    // Calling iterator.return() at a yield would destroy stdin. The outer lease owner hands
    // this live cursor to the retention stage after releasing its own lease instead.
    if (shouldYield?.()) return yielded([]);
    while (true) {
        const next = await iterator.next();
        if (next.done) break;
        const {record, parseError, lineNo} = next.value;
        if (parseError) {
            totals.parseErrors++;
            totals.errors.push({
                code   : 'KB_INGEST_CLI_JSONL_PARSE_FAILED',
                message: `Line ${lineNo}: ${parseError}`
            });
            continue;
        }

        batch.push(record);

        if (batch.length >= batchSize) {
            const partial = await flushBatch();
            if (partial) return partial;
        }
    }

    return await flushBatch() || totals;
}

/**
 * @summary Binds an ingestion slice to its original fresh or inherited lease acquisition.
 * @param {Object} options The runIngest inputs.
 * @param {Object} acquisition Actual wrapper acquisition, including the parent's clock if inherited.
 * @returns {Promise<Object>} Completed totals or a retained in-process continuation.
 */
export function runIngestTask(options, acquisition) {
    const voter = createLeaseYieldVoter(acquisition);
    return runIngest({...options, shouldYield: voter?.vote});
}

/**
 * @summary Persists only incomplete original records and the unread stream, with bounded memory.
 * Call after the owned lease is released. A partial file is retained on an I/O error, never
 * advertised as a complete resume bundle. The plane root is a scalar filesystem boundary.
 * @param {Object} options
 * @param {Object} options.resume In-process cursor returned by runIngest.
 * @param {String} options.planeRoot Resolved plane data root.
 * @param {String} options.tenantId Owner of the replay input.
 * @returns {Promise<Object>} Private replay path and remaining input-record counts.
 */
export async function retainIngestRemainder({resume, planeRoot, tenantId}) {
    const root = path.join(planeRoot, 'ingest-resume');
    await fs.promises.mkdir(root, {recursive: true, mode: 0o700});
    if ((await fs.promises.lstat(root)).isSymbolicLink()) throw new Error('Ingest resume root must not be a symlink');
    await fs.promises.chmod(root, 0o700);
    const dir                   = await fs.promises.mkdtemp(path.join(root, 'run-'));
    const partial               = path.join(dir, 'input.partial');
    const file                  = await fs.promises.open(partial, 'wx', 0o600);
    let   remainingInputRecords = 0, remainingMalformedLines = 0, unreadInputRecords = 0;
    try {
        for (const record of resume.pendingRecords) {
            await file.writeFile(JSON.stringify(record) + '\n');
            remainingInputRecords++;
        }
        while (true) {
            const next = await resume.iterator.next();
            if (next.done) break;
            if (next.value.parseError) {
                if (typeof next.value.rawLine !== 'string') throw new Error('Unread malformed input omitted its original line');
                await file.writeFile(next.value.rawLine + '\n');
                remainingMalformedLines++;
            } else {
                await file.writeFile(JSON.stringify(next.value.record) + '\n');
                remainingInputRecords++;
                unreadInputRecords++;
            }
        }
        await file.sync();
    } catch (error) {
        throw new Error(`Ingest resume retention failed; partial input retained at ${partial}`, {cause: error});
    } finally {
        await file.close();
        await resume.iterator.return?.();
    }
    const resumeFile = path.join(dir, 'input.jsonl');
    await fs.promises.rename(partial, resumeFile);
    await fs.promises.writeFile(path.join(dir, 'owner.json'), JSON.stringify({
        kind: 'neo-ingest-resume', version: 1, tenantId, remainingInputRecords
    }), {flag: 'wx', mode: 0o600});
    return {resumeFile, remainingInputRecords, remainingMalformedLines, unreadInputRecords};
}

/**
 * @summary Removes only a completed, same-tenant resume bundle produced by this CLI.
 * Ordinary source files, symlinks and unrelated files are never removed.
 * @param {Object} options
 * @param {String} options.fromFile Completed input path.
 * @param {String} options.planeRoot Resolved plane data root.
 * @param {String} options.tenantId Current tenant.
 * @returns {Promise<Boolean>} Whether the owned payload was removed.
 */
export async function removeIngestResume({fromFile, planeRoot, tenantId}) {
    if (!fromFile) return false;
    const root  = path.resolve(planeRoot, 'ingest-resume'), target = path.resolve(fromFile);
    const parts = path.relative(root, target).split(path.sep);
    if (parts.length !== 2 || !/^run-[\w-]+$/.test(parts[0]) || parts[1] !== 'input.jsonl') return false;
    const dir = path.dirname(target), marker = path.join(dir, 'owner.json');
    try {
        for (const candidate of [root, dir, target, marker]) {
            if ((await fs.promises.lstat(candidate)).isSymbolicLink()) return false;
        }
        const owner = JSON.parse(await fs.promises.readFile(marker, 'utf8'));
        if (owner.kind !== 'neo-ingest-resume' || owner.version !== 1 || owner.tenantId !== tenantId) return false;
        await fs.promises.unlink(target);
        await fs.promises.unlink(marker);
        await fs.promises.rmdir(dir).catch(error => { if (error.code !== 'ENOTEMPTY') throw error });
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

/**
 * @summary Prints the terminal CLI receipt and returns its process exit status.
 * @param {Object} options
 * @param {Object} options.args Validated CLI arguments.
 * @param {Object} options.totals Ingestion summary; private continuation is omitted from output.
 * @param {Object} [options.retained] Durable replay receipt for a yielded or failed run.
 * @param {Function} [options.log=console.log] Output sink.
 * @returns {Number} 75 for a yield, 1 for errors, otherwise 0.
 */
export function reportIngestOutcome({args, totals, retained, log = console.log}) {
    const {resume, remainingChunks, ...counts} = totals;
    if (retained) {
        const quote         = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
        const resumeCommand = `npm run ai:ingest-tenant -- ${quote(args.tenantId)} --from-file ${quote(retained.resumeFile)} --batch-size ${args.batchSize}`;
        log(JSON.stringify({
            status                  : totals.yielded ? 'yielded' : 'failed', tenantId: args.tenantId, ...counts, ...retained,
            acceptedNormalizedChunks: totals.ingested,
            ingested                : totals.completedInputRecords,
            countsUnit              : 'original-input-records',
            // Unread input has not passed parsing/expansion admission, so its embedding-chunk
            // population is unknown. Keep that separate from the measured active-batch remainder.
            remainingEmbeddingChunks           : retained.unreadInputRecords > 0 ? null : remainingChunks ?? null,
            activeBatchRemainingEmbeddingChunks: remainingChunks ?? null,
            resumeCommand
        }));
        return totals.yielded ? 75 : 1;
    }
    log(`ai:ingest-tenant complete: ${totals.ingested} ingested, ${totals.embeddingsGenerated} embedded; ${totals.errors.length} error(s).`);
    log(JSON.stringify({status: totals.errors.length ? 'failed' : 'completed', tenantId: args.tenantId, ...counts}));
    return totals.errors.length > 0 ? 1 : 0;
}

/**
 * @summary Transfers replay custody before retiring a prior owned bundle, then prints the outcome.
 * A failed successor write leaves the previous input intact. Ordinary input files are never removed.
 * @param {Object} options CLI args, totals, resolved planeRoot and optional output sink.
 * @returns {Promise<Number>} The exit status associated with the printed receipt.
 */
export async function finalizeIngestTask({args, totals, planeRoot, log}) {
    const retained = totals.resume ? await retainIngestRemainder({
        resume: totals.resume, planeRoot, tenantId: args.tenantId
    }) : undefined;
    if (retained || totals.errors.length === 0) {
        await removeIngestResume({fromFile: args.fromFile, planeRoot, tenantId: args.tenantId});
    }
    return reportIngestOutcome({args, totals, retained, log});
}

/**
 * @summary CLI entry point — streams a tenant's parsed-chunk-v1 JSONL into the Knowledge Base.
 * @returns {Promise<void>}
 */
async function ingestTenant() {
    const args = parseArgs(process.argv.slice(2));

    if (!args.tenantId || (!args.fromFile && !args.fromStdin) || (args.fromFile && args.fromStdin)) {
        printUsage();
        process.exit(1);
    }

    if (!Number.isInteger(args.batchSize) || args.batchSize < 1) {
        console.error(`❌ Invalid --batch-size '${args.batchSize}'; must be a positive integer.`);
        process.exit(1);
    }

    if (args.fromFile && !fs.existsSync(args.fromFile)) {
        console.error(`❌ --from-file path does not exist: ${args.fromFile}`);
        process.exit(1);
    }

    // Enable debug logging for ingest visibility. B4-safe activation: drive NEO_DEBUG via the
    // Provider override API, never mutate the read-only reactive Provider.
    KB_Config.setEnvOverride('NEO_DEBUG', true);
    console.log(`⏳ ai:ingest-tenant — tenant='${args.tenantId}', source=${args.fromStdin ? 'stdin' : args.fromFile}, batchSize=${args.batchSize}`);

    let outcome, records;

    try {
        outcome = await withHeavyMaintenanceLease(
            async acquisition => {
                await KB_LifecycleService.ready();
                await KB_ChromaManager.ready();
                await KB_IngestionService.ready();
                console.log('✅ KB services ready. Streaming parsed-chunk-v1 records...');

                const input = args.fromStdin ? process.stdin : createBundlePayloadReadStream(args.fromFile);

                records = readJsonlRecords(input);
                return runIngestTask({
                    records,
                    batchSize: args.batchSize,
                    // Bulk path: viaMcp:false bypasses the MCP work-volume gate for tenant-scale ingestion.
                    ingestFn: (files, controls) => KB_IngestionService.ingestSourceFiles({tenantId: args.tenantId, files, viaMcp: false}, controls),
                    onBatch : (batchNumber, summary) => console.log(
                        `   batch ${batchNumber}: ${summary.ingested} ingested, ${summary.embeddingsGenerated} embedded` +
                        (summary.errors?.length ? `, ${summary.errors.length} error(s)` : '')
                    )
                }, acquisition);
            },
            {
                leasePath   : resolveHeavyMaintenanceLeasePath({dataDir: AiConfig.orchestrator.dataDir}),
                owner       : 'kbIngest',
                reason      : 'manual-cli',
                staleAfterMs: AiConfig.orchestrator.heavyMaintenanceLease.staleAfterMs,
                metadata    : {script: 'ai/scripts/maintenance/ingestTenant.mjs', tenantId: args.tenantId}
            }
        );
    } catch (error) {
        await records?.return?.();
        console.error('❌ ai:ingest-tenant failed:', error);
        process.exit(1);
    }

    if (outcome.status === 'held') {
        const held = outcome.lease;
        console.log(`⏸️  Deferred: heavy-maintenance lease held by '${held.owner}' (reason='${held.reason}', pid=${held.pid}). Re-invoke once it completes.`);
        process.exit(0);
    }

    const totals = outcome.result;
    try {
        process.exit(await finalizeIngestTask({args, totals, planeRoot: AiConfig.plane.dataRoot}));
    } catch (error) {
        console.error('ai:ingest-tenant retention failed:', error);
        process.exit(1);
    }
}

// Auto-run only when invoked directly as the CLI — not when imported by unit tests.
if (isEntryModule(import.meta.url)) {
    ingestTenant();
}

export {parseArgs, readJsonlRecords, runIngest};

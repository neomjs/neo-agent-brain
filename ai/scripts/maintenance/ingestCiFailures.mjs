// Neo namespace bootstrap (entry-point invariant) — the config provider and the in-process
// mailbox services both assume the Neo singleton API is bound before they load.
import 'dotenv/config';
import Neo                        from 'neo.mjs/src/Neo.mjs';
import * as core                  from 'neo.mjs/src/core/_export.mjs';
import {Command}                  from 'commander';
import path                       from 'node:path';
import {readFile}                 from 'node:fs/promises';
import {pathToFileURL}            from 'node:url';
import {createPlaneMailboxClient} from '../../services/fleet/planeMailboxClient.mjs';
import {writeFileAtomic}          from '../../services/shared/atomicFileWrite.mjs';
import {
    buildCiThreadId,
    buildDefectNotes,
    isCanonicalNote,
    isSuiteRunGreen,
    parseCiThreadId,
    parsePlaywrightFailures,
    selectRecoveries
} from '../../services/ingestion/CiFailureIngestor.mjs';
import {createGithubActionsClient, resolveGithubToken} from '../../services/ingestion/githubActions.mjs';
import {foldDefectObservations}                        from '../../services/memory-core/helpers/defectObservationFold.mjs';

/**
 * @module ai/scripts/maintenance/ingestCiFailures
 *
 * @summary The defect ledger's machine producer — the supervised one-shot behind the orchestrator's
 * `ci-failure-ingest` task (`npm run ai:ingest-ci-failures` by hand).
 *
 * One tick: read the repository's completed CI runs since the receipt, and for every failed job
 * whose run and job are not yet a thread on the mailbox, parse the job log and broadcast one
 * `defect-note:` per failing test — quiet, low priority, the run and job as the thread. Every job
 * that ran its suite green is recovery evidence: an open CI-filed record whose job went green in a
 * newer run gets its `[recovered]` note. The fold, the triggers, the digest and its task are
 * unchanged; this adds the producer the ledger never had.
 *
 * Two idempotence layers, deliberately unequal: the mailbox thread is correctness (N orchestrators
 * cannot double-file a run and job), the local receipt is cost (this host does not re-read runs it
 * already read). Losing the receipt re-reads a window; it never duplicates an observation.
 *
 * The fleet's mailbox lives on the PLANE, so the plane client is the default; `--local` uses this
 * checkout's in-process store (test/isolated planes). `--dry-run` reads GitHub and the mailbox and
 * prints what it would send, sending nothing and writing no receipt.
 *
 * Usage:
 *   node ai/scripts/maintenance/ingestCiFailures.mjs                       # orchestrator child
 *   node ai/scripts/maintenance/ingestCiFailures.mjs --dry-run --local     # an operator box
 *   node ai/scripts/maintenance/ingestCiFailures.mjs --plane-base http://127.0.0.1:3102 --dry-run
 *
 * `parseArgs` and `runIngest` are pure, dependency-injected units; the CLI auto-runs only when
 * invoked directly, so the module is importable substrate-free by unit tests.
 */

const RECEIPT_VERSION      = 1;
const RECEIPT_RUN_CAPACITY = 2000;
const OVERLAP_MS           = 2 * 60 * 60 * 1000;

/**
 * @summary Builds the Commander program; a fresh instance per call keeps parser tests isolated.
 * @returns {Command}
 */
function createArgParser() {
    const program = new Command();

    program
        .name('ingest-ci-failures')
        .description('File one defect-note per failing CI test into the defect ledger')
        .exitOverride()
        .configureOutput({writeErr: () => {}, writeOut: () => {}})
        .allowExcessArguments(false)
        .option('--repo <slug>', 'Repository to read, owner/name (default: the configured leaf)')
        .option('--lookback-hours <n>', 'How far back one tick looks when the receipt is absent or older')
        .option('--limit <n>', 'How many broadcast messages to fold for recovery and idempotence')
        .option('--plane-base <url>', 'Plane base URL (default: AiConfig.fleet.planeBase)')
        .option('--receipt <path>', 'Receipt file (default: the configured leaf)')
        .option('--local', 'Use this checkout\'s in-process mailbox store instead of the plane')
        .option('--dry-run', 'Print what would be sent; send nothing, write no receipt')
        .option('--json', 'Print the tick summary as JSON');

    return program;
}

/**
 * @summary Parses argv into the tick's options. Numbers are validated here so a bad flag fails
 * before any read; `null` means "read the configured leaf at the use site".
 * @param {String[]} argv `process.argv.slice(2)`.
 * @returns {{repo: String|null, lookbackMs: Number|null, limit: Number|null, planeBase: String|null, receipt: String|null, local: Boolean, dryRun: Boolean, json: Boolean, parseError: String|null}}
 */
export function parseArgs(argv) {
    const program    = createArgParser();
    let   parseError = null;

    try {
        program.parse(argv, {from: 'user'});
    } catch (error) {
        parseError = error.message;
    }

    const options = program.opts(),
          number  = (value, name) => {
              if (value === undefined) return null;
              const parsed = Number(value);
              if (!Number.isFinite(parsed) || parsed <= 0) {
                  parseError = parseError || `${name} must be a positive number, got "${value}"`;
                  return null;
              }
              return parsed;
          };

    const lookbackHours = number(options.lookbackHours, '--lookback-hours');

    return {
        repo      : options.repo || null,
        lookbackMs: lookbackHours === null ? null : lookbackHours * 60 * 60 * 1000,
        limit     : number(options.limit, '--limit'),
        planeBase : options.planeBase || null,
        receipt   : options.receipt || null,
        local     : Boolean(options.local),
        dryRun    : Boolean(options.dryRun),
        json      : Boolean(options.json),
        parseError
    };
}

/**
 * @summary Reads the receipt; an absent or unreadable receipt is an empty one (cost, not correctness).
 * @param {String} filePath
 * @returns {Promise<{version: Number, lastCreatedAt: String|null, runIds: Number[]}>}
 */
export async function readReceipt(filePath) {
    try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));

        if (parsed?.version === RECEIPT_VERSION && Array.isArray(parsed.runIds)) {
            return {version: RECEIPT_VERSION, lastCreatedAt: parsed.lastCreatedAt || null, runIds: parsed.runIds.filter(Number.isFinite)};
        }
    } catch {
        // absent or malformed: re-read the window; the mailbox thread keeps that idempotent
    }

    return {version: RECEIPT_VERSION, lastCreatedAt: null, runIds: []};
}

/**
 * @summary The instant one tick reads from: the receipt's newest run minus an overlap (runs
 * complete out of order), floored by the lookback so a stale receipt never opens an unbounded read.
 * @param {Object} options
 * @param {Object} options.receipt
 * @param {Number} options.now
 * @param {Number} options.lookbackMs
 * @returns {String} ISO-8601
 */
export function resolveSince({receipt, now, lookbackMs}) {
    const floor    = now - lookbackMs,
          fromLast = receipt.lastCreatedAt ? Date.parse(receipt.lastCreatedAt) - OVERLAP_MS : Number.NEGATIVE_INFINITY;

    // Seconds precision — the shape the Actions API documents for its `created` range filter.
    return new Date(Math.max(floor, fromLast)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * @summary One producer tick over injected reads and writes.
 *
 * @param {Object}   options
 * @param {Object}   options.github        `{listCompletedRuns, listJobs, fetchJobLog}`
 * @param {Object}   options.mailbox       `{listMessages, addMessage}` — plane client or in-process adapter
 * @param {String}   options.repoSlug
 * @param {Object}   options.receipt       From {@link readReceipt}.
 * @param {Function} options.writeReceipt  `(receipt) => Promise`
 * @param {Number}   [options.now=Date.now()]
 * @param {Number}   [options.lookbackMs]
 * @param {Number}   [options.recoveryAfterMs] Quiet time before a green job recovers a record.
 * @param {Number}   [options.mailboxLimit]
 * @param {Boolean}  [options.dryRun=false]
 * @param {Function} [options.log=console.error]
 * @returns {Promise<Object>} The tick summary.
 */
export async function runIngest({
    github,
    mailbox,
    repoSlug,
    receipt,
    writeReceipt,
    now             = Date.now(),
    lookbackMs      = 24 * 60 * 60 * 1000,
    recoveryAfterMs = 24 * 60 * 60 * 1000,
    mailboxLimit    = 500,
    dryRun          = false,
    log             = message => console.error(message)
}) {
    const since   = resolveSince({receipt, now, lookbackMs}),
          runs    = await github.listCompletedRuns({since}),
          seen    = new Set(receipt.runIds),
          summary = {since, runsRead: 0, jobsRead: 0, filedJobs: [], skippedJobs: [], notes: [], recoveries: [], skippedTests: []};

    const {messages} = await mailbox.listMessages({to: 'AGENT:*', status: 'all', limit: mailboxLimit}),
          rows       = messages.filter(message => typeof message.subject === 'string' && message.subject.startsWith('defect-note:')),
          greenJobs  = [],
          sentRows   = [];

    // A green run's jobs are read only when an open CI-filed record could recover from them: the
    // workflows of the open records on the mailbox, plus any workflow this tick files under. At
    // ~100 runs an hour, listing every green run's jobs would be the tick's whole cost.
    const openWorkflowPaths = new Set(
        foldDefectObservations(rows, {now})
            .filter(record => record.state === 'red')
            .flatMap(record => (record.threads || []).map(parseCiThreadId).filter(Boolean).map(thread => thread.workflowPath))
    );

    const send = async note => {
        if (!isCanonicalNote(note.subject)) {
            throw new Error(`ingestCiFailures: refusing a non-canonical note: ${note.subject}`);
        }
        if (!dryRun) {
            await mailbox.addMessage({to: 'AGENT:*', subject: note.subject, body: note.body, priority: 'low', partOfThread: note.partOfThread, wakeSuppressed: true});
        }
        sentRows.push({from: '@ci-failure-ingest', sentAt: new Date(now).toISOString(), subject: note.subject, partOfThread: note.partOfThread});
    };

    for (const run of runs) {
        if (seen.has(run.id)) continue;

        summary.runsRead++;

        const failed = run.conclusion === 'failure' || run.conclusion === 'timed_out',
              green  = run.conclusion === 'success' && openWorkflowPaths.has(run.path);

        if (!failed && !green) {
            seen.add(run.id);
            continue;
        }

        const jobs = await github.listJobs(run.id);

        for (const job of jobs) {
            summary.jobsRead++;

            if (isSuiteRunGreen(job)) {
                greenJobs.push({workflowPath: run.path, jobName: job.name, runId: run.id});
                continue;
            }
            if (job.conclusion !== 'failure') continue;

            const thread = buildCiThreadId({workflowPath: run.path, jobName: job.name, runId: run.id}),
                  filed  = await mailbox.listMessages({to: 'AGENT:*', status: 'all', threadId: thread, limit: 1});

            if ((filed.messages || []).length > 0) {
                summary.skippedJobs.push({runId: run.id, job: job.name, reason: 'already-filed'});
                continue;
            }

            const failures         = parsePlaywrightFailures(await github.fetchJobLog(job.id)),
                  {notes, skipped} = buildDefectNotes({failures, run, job, repoSlug});

            summary.skippedTests.push(...skipped.map(entry => ({runId: run.id, job: job.name, ...entry})));

            if (notes.length === 0) {
                summary.skippedJobs.push({runId: run.id, job: job.name, reason: failures.length ? 'no-symptoms' : 'no-playwright-epilogue'});
                continue;
            }

            for (const note of notes) {
                await send(note);
                summary.notes.push({runId: run.id, job: job.name, fingerprint: note.fingerprint, subject: note.subject, thread});
            }

            summary.filedJobs.push({runId: run.id, job: job.name, notes: notes.length});
            openWorkflowPaths.add(run.path);
        }

        seen.add(run.id);
    }

    // Recovery sees this tick's own sightings, so a record sighted in this window is fresh — a
    // flake that just fired stays open however green the suite is now.
    const records    = foldDefectObservations([...rows, ...sentRows], {now}),
          recoveries = selectRecoveries({records, greenJobs, now, recoveryAfterMs});

    for (const recovery of recoveries) {
        await send(recovery);
        summary.recoveries.push({fingerprint: recovery.fingerprint, subject: recovery.subject, thread: recovery.partOfThread});
    }

    if (!dryRun) {
        const newest = runs.reduce((max, run) => Date.parse(run.createdAt) > Date.parse(max) ? run.createdAt : max, receipt.lastCreatedAt || since);

        await writeReceipt({
            version      : RECEIPT_VERSION,
            lastCreatedAt: newest,
            runIds       : [...seen].slice(-RECEIPT_RUN_CAPACITY)
        });
    }

    log(`ci-failure-ingest: ${summary.runsRead} run(s) since ${since}, ${summary.notes.length} note(s), ${summary.recoveries.length} recovery(ies)${dryRun ? ' — dry run, nothing sent' : ''}`);

    return summary;
}

/**
 * @summary The plane mailbox client, initialised as this seat's identity — the digest's own path.
 * @param {Object} AiConfig
 * @param {String|null} planeBaseOverride
 * @returns {Promise<{mailbox: Object, close: Function}>}
 */
async function openPlaneMailbox(AiConfig, planeBaseOverride) {
    const planeBase = (planeBaseOverride ?? AiConfig.fleet.planeBase).trim().replace(/\/+$/, '');

    if (!planeBase) {
        throw new Error('ingestCiFailures: no plane is configured (AiConfig.fleet.planeBase) — pass --plane-base or use --local');
    }

    const client = createPlaneMailboxClient({baseUrl: `${planeBase}/mc/mcp`, credential: AiConfig.fleet.planeBearer}),
          init   = await client.init({expectedIdentity: process.env.NEO_AGENT_IDENTITY || '@system'});

    if (!init.ok) {
        throw new Error(`ingestCiFailures: plane init failed — ${init.reason}`);
    }

    return {mailbox: client, close: () => client.close()};
}

/**
 * @summary This checkout's in-process mailbox store, bound to this seat's identity.
 * @returns {Promise<{mailbox: Object, close: Function}>}
 */
async function openLocalMailbox() {
    const {default: LifecycleService}      = await import('../../services/memory-core/lifecycle/SystemLifecycleService.mjs'),
          {default: GraphService}          = await import('../../services/memory-core/GraphService.mjs'),
          {default: MailboxService}        = await import('../../services/memory-core/MailboxService.mjs'),
          {default: RequestContextService} = await import('../../mcp/server/shared/services/RequestContextService.mjs');

    await LifecycleService.ready();
    await GraphService.ready();

    const context = {agentIdentityNodeId: process.env.NEO_AGENT_IDENTITY || '@system'};

    return {
        mailbox: {
            listMessages: args => RequestContextService.run(context, () => MailboxService.listMessages(args)),
            addMessage  : args => RequestContextService.run(context, () => MailboxService.addMessage(args))
        },
        close: () => {}
    };
}

/**
 * @summary The CLI: resolves config at the use site, opens the reads and writes, runs one tick.
 * @param {String[]} argv
 * @returns {Promise<Number>} Exit code.
 */
export async function main(argv) {
    const args = parseArgs(argv);

    if (args.parseError) {
        console.error(`ingestCiFailures: ${args.parseError}`);
        return 2;
    }

    const {default: AiConfig} = await import('../../config.mjs'),
          repoSlug            = args.repo ?? AiConfig.orchestrator.ciFailureIngest.repoSlug,
          receiptPath         = args.receipt ?? AiConfig.orchestrator.ciFailureIngest.receiptPath,
          github              = createGithubActionsClient({repoSlug, token: resolveGithubToken()}),
          {mailbox, close}    = args.local ? await openLocalMailbox() : await openPlaneMailbox(AiConfig, args.planeBase);

    try {
        const summary = await runIngest({
            github,
            mailbox,
            repoSlug,
            receipt        : await readReceipt(receiptPath),
            writeReceipt   : receipt => writeFileAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {fsync: true}),
            lookbackMs     : args.lookbackMs ?? AiConfig.orchestrator.ciFailureIngest.lookbackMs,
            recoveryAfterMs: AiConfig.orchestrator.ciFailureIngest.recoveryAfterMs,
            mailboxLimit   : args.limit ?? AiConfig.orchestrator.ciFailureIngest.mailboxLimit,
            dryRun         : args.dryRun
        });

        if (args.json || args.dryRun) {
            console.log(JSON.stringify(summary, null, 2));
        }

        return 0;
    } finally {
        await close();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).then(
        code => process.exit(code),
        error => {
            console.error(`ingestCiFailures: ${error?.message || error}`);
            process.exit(1);
        }
    );
}

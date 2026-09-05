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
    buildRecoveryNote,
    isCanonicalNote,
    isSuiteRunGreen,
    parseCiThreadId,
    parsePlaywrightPasses,
    parsePlaywrightReport,
    selectRecoveryCandidates
} from '../../services/ingestion/CiFailureIngestor.mjs';
import {createGithubActionsClient, resolveGithubToken}   from '../../services/ingestion/githubActions.mjs';
import {defectNoteFingerprint, foldDefectObservations} from '../../services/memory-core/helpers/defectObservationFold.mjs';

/**
 * @module ai/scripts/maintenance/ingestCiFailures
 *
 * @summary The defect ledger's machine producer — the supervised one-shot behind the orchestrator's
 * `ci-failure-ingest` task (`npm run ai:ingest-ci-failures` by hand).
 *
 * One tick: read the repository's runs since the receipt, and for every failed job parse the job
 * log and broadcast one `defect-note:` per failing test the run-and-job thread does not hold yet —
 * quiet, low priority, the run and job as the thread. Every job that ran its suite green is
 * candidate recovery evidence: an open CI-filed record whose job went green in a newer run, whose
 * log names the record's test with a pass mark, gets its `[recovered]` note. The fold records the
 * threads a record was sighted under and the promotion trigger reads them as independence; the
 * digest is unchanged; the orchestrator gains this task.
 *
 * Admission is per observation, and the receipt is cost, not correctness. A failed job's thread is
 * read in full and only the notes whose fingerprints it lacks are sent, so a write interrupted after
 * its first note resumes with the second — not with a skipped job. The local receipt holds the runs
 * this host has finished reading, the runs it saw still running (finished by id on a later tick,
 * whatever window they were created in — the API filters on creation time and a run can complete
 * hours after it was created), and the slices of a window a bounded listing did not reach (drained,
 * oldest first, before the next window). Losing the receipt re-reads a window; it never duplicates
 * an observation.
 *
 * Completeness is stated, never assumed: the mailbox is read page by page up to the configured cap,
 * a run listing that exhausted its page bound leaves its unread remainder as a continuation slice,
 * and a tick that hit either bound files sightings but certifies no recovery — a record on an unread
 * page, or a sighting in an unread run, could be fresher than the read ones say.
 *
 * Recovery needs the test, not the job: a green job's colour on a head where the test was renamed,
 * removed or never existed proves nothing about it, so the evidence job's log must name the record's
 * surface with a pass mark. A reporter that names no passing tests — the `unit` job's `github`
 * reporter today — cannot recover a record; those stay red until a human recovers them or the
 * reporter names passes.
 *
 * The fleet's mailbox lives on the PLANE, so the plane client is the default; `--local` uses this
 * checkout's in-process store (test/isolated planes). `--dry-run` reads GitHub and the mailbox and
 * prints what it would send, sending nothing and writing no receipt.
 *
 * Retirement: if the runner gains first-class flake reporting the fold can consume directly, this
 * producer retires with it — the mapping in `CiFailureIngestor.mjs` and this tick are all it adds.
 *
 * Usage:
 *   node ai/scripts/maintenance/ingestCiFailures.mjs                       # orchestrator child
 *   node ai/scripts/maintenance/ingestCiFailures.mjs --dry-run --local     # an operator box
 *   node ai/scripts/maintenance/ingestCiFailures.mjs --plane-base http://127.0.0.1:3102 --dry-run
 *
 * `parseArgs`, `listAllMessages` and `runIngest` are pure, dependency-injected units; the CLI
 * auto-runs only when invoked directly, so the module is importable substrate-free by unit tests.
 */

const RECEIPT_VERSION      = 2;
const RECEIPT_RUN_CAPACITY = 2000;
const OVERLAP_MS           = 2 * 60 * 60 * 1000;
const MAILBOX_PAGE_SIZE    = 100;
const THREAD_READ_CAP      = 500;

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
        .option('--limit <n>', 'How many broadcast messages to read for recovery, across pages')
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
 * @summary Reads the receipt; an absent or unreadable receipt is an empty one (cost, not
 * correctness). A version-1 receipt is read as version 2 with no pending runs and no continuation.
 * @param {String} filePath
 * @returns {Promise<{version: Number, lastCreatedAt: String|null, runIds: Number[], pendingRunIds: Number[], continuations: Array<{since: String, until: String}>}>}
 */
export async function readReceipt(filePath) {
    try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));

        if ((parsed?.version === 1 || parsed?.version === RECEIPT_VERSION) && Array.isArray(parsed.runIds)) {
            return {
                version      : RECEIPT_VERSION,
                lastCreatedAt: parsed.lastCreatedAt || null,
                runIds       : parsed.runIds.filter(Number.isFinite),
                pendingRunIds: Array.isArray(parsed.pendingRunIds) ? parsed.pendingRunIds.filter(Number.isFinite) : [],
                continuations: Array.isArray(parsed.continuations) ? parsed.continuations.filter(slice => slice?.since && slice?.until) : []
            };
        }
    } catch {
        // absent or malformed: re-read the window; per-observation admission keeps that idempotent
    }

    return {version: RECEIPT_VERSION, lastCreatedAt: null, runIds: [], pendingRunIds: [], continuations: []};
}

/**
 * @summary The instant one tick lists from: the receipt's newest run minus an overlap (runs are
 * listed by creation time and complete out of order), floored by the lookback so a stale receipt
 * never opens an unbounded read. Runs still running at a tick are not lost when the window moves
 * past their creation: the receipt carries them as pending and they are read by id. Runs a bounded
 * listing did not reach are not lost either: their slice of the window rides the receipt.
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
 * @summary Walks mailbox pages until the last page or the cap; `complete` says which. A page
 * without `truncated` (an adapter that hands everything back at once) is the last page.
 * @param {{listMessages: Function}} mailbox
 * @param {Object} args The filter — `to`, `status`, `threadId`; `limit` and `offset` are this walk's.
 * @param {Number} cap The most rows one walk reads.
 * @returns {Promise<{messages: Object[], complete: Boolean}>}
 */
export async function listAllMessages(mailbox, args, cap) {
    const messages = [];
    let   offset   = 0;

    while (messages.length < cap) {
        const page = await mailbox.listMessages({...args, limit: Math.min(MAILBOX_PAGE_SIZE, cap - messages.length), offset});

        messages.push(...(page.messages || []));

        if (!page.truncated || page.nextOffset === null || page.nextOffset === undefined) {
            return {messages, complete: true};
        }

        offset = page.nextOffset;
    }

    return {messages, complete: false};
}

/**
 * @summary The oldest creation instant among runs, or `null` for none.
 * @param {Object[]} runs
 * @returns {String|null}
 */
function oldestCreatedAt(runs) {
    return runs.reduce((oldest, run) => (!oldest || Date.parse(run.createdAt) < Date.parse(oldest)) ? run.createdAt : oldest, null);
}

/**
 * @summary Lists the runs one tick works on: the oldest continuation slice the receipt carries
 * (drained one per tick, so a tick stays bounded), then the current window. A listing that exhausted
 * its page bound leaves the unread remainder — `since` up to the oldest run it did read — as a
 * continuation for the next tick; the runs it did read are handled now.
 * @param {Object} options
 * @param {Object} options.github
 * @param {Object} options.receipt
 * @param {String} options.since The current window's start.
 * @returns {Promise<{runs: Object[], continuations: Array<{since: String, until: String}>}>}
 */
async function listTickRuns({github, receipt, since}) {
    const pending       = [...(receipt.continuations || [])],
          continuations = [],
          byId          = new Map();

    const admit = (listing, sliceSince, sliceUntil) => {
        listing.runs.forEach(run => byId.set(run.id, run));

        if (!listing.complete) {
            const oldest = oldestCreatedAt(listing.runs);

            continuations.push({since: sliceSince, until: oldest && Date.parse(oldest) > Date.parse(sliceSince) ? oldest : sliceUntil ?? oldest});
        }
    };

    if (pending.length) {
        const slice = pending.shift();

        admit(await github.listRuns({since: slice.since, until: slice.until}), slice.since, slice.until);
    }

    continuations.push(...pending);

    admit(await github.listRuns({since}), since, null);

    return {
        runs         : [...byId.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
        continuations: continuations.filter(slice => slice.since && slice.until)
    };
}

/**
 * @summary One producer tick over injected reads and writes.
 *
 * @param {Object}   options
 * @param {Object}   options.github        `{listRuns, getRun, listJobs, fetchJobLog}`
 * @param {Object}   options.mailbox       `{listMessages, addMessage}` — plane client or in-process adapter
 * @param {String}   options.repoSlug
 * @param {Object}   options.receipt       From {@link readReceipt}.
 * @param {Function} options.writeReceipt  `(receipt) => Promise`
 * @param {Number}   [options.now=Date.now()]
 * @param {Number}   [options.lookbackMs]
 * @param {Number}   [options.recoveryAfterMs] Quiet time before a green job may recover a record.
 * @param {Number}   [options.mailboxLimit]    The most broadcast rows read for recovery, across pages.
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
    const since                  = resolveSince({receipt, now, lookbackMs}),
          {runs, continuations}  = await listTickRuns({github, receipt, since}),
          seen                   = new Set(receipt.runIds),
          pending                = new Set(receipt.pendingRunIds || []),
          summary                = {
              since,
              runsRead           : 0,
              jobsRead           : 0,
              pendingRuns        : [],
              continuations,
              listingComplete    : continuations.length === 0,
              filedJobs          : [],
              skippedJobs        : [],
              notes              : [],
              skippedNotes       : [],
              recoveries         : [],
              skippedRecoveries  : [],
              skippedTests       : [],
              mailboxScanComplete: true
          };

    // A run still running when its window was read is finished by id, whatever window it was
    // created in. A run the API no longer knows is dropped; any other failure keeps it pending.
    const listedIds = new Set(runs.map(run => run.id));

    for (const runId of [...pending]) {
        if (listedIds.has(runId) || seen.has(runId)) continue;

        try {
            runs.push(await github.getRun(runId));
        } catch (error) {
            const message = error?.message || String(error);

            if (/\b404\b/.test(message)) {
                pending.delete(runId);
            }

            log(`ci-failure-ingest: pending run ${runId} could not be read (${message})`);
        }
    }

    runs.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

    const {messages, complete} = await listAllMessages(mailbox, {to: 'AGENT:*', status: 'all'}, mailboxLimit),
          rows                 = messages.filter(message => typeof message.subject === 'string' && message.subject.startsWith('defect-note:')),
          greenJobs            = [],
          sentRows             = [];

    summary.mailboxScanComplete = complete;

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

        if (run.status !== 'completed') {
            pending.add(run.id);
            summary.pendingRuns.push(run.id);
            continue;
        }

        pending.delete(run.id);
        summary.runsRead++;

        const failed = run.conclusion === 'failure' || run.conclusion === 'timed_out',
              green  = run.conclusion === 'success' && openWorkflowPaths.has(run.path);

        if (!failed && !green) {
            seen.add(run.id);
            continue;
        }

        const jobs        = await github.listJobs(run.id);
        let   runComplete = true;

        for (const job of jobs) {
            summary.jobsRead++;

            if (isSuiteRunGreen(job)) {
                greenJobs.push({workflowPath: run.path, jobName: job.name, runId: run.id, jobId: job.id, headSha: run.headSha, headBranch: run.headBranch});
                continue;
            }
            if (job.conclusion !== 'failure') continue;

            const thread = buildCiThreadId({workflowPath: run.path, jobName: job.name, runId: run.id}),
                  filed  = await listAllMessages(mailbox, {to: 'AGENT:*', status: 'all', threadId: thread}, THREAD_READ_CAP);

            if (!filed.complete) {
                // A thread this long cannot be read to the end: nothing is filed and the run stays
                // unreceipted, so the next tick tries again instead of double-filing.
                summary.skippedJobs.push({runId: run.id, job: job.name, reason: 'thread-read-incomplete'});
                runComplete = false;
                continue;
            }

            const filedFingerprints = new Set(
                filed.messages.filter(message => isCanonicalNote(message.subject)).map(message => defectNoteFingerprint(message.subject))
            );

            const report = parsePlaywrightReport(await github.fetchJobLog(job.id));

            if (!report.complete) {
                summary.skippedJobs.push({
                    runId   : run.id,
                    job     : job.name,
                    reason  : report.declared ? 'epilogue-incomplete' : 'no-playwright-epilogue',
                    declared: report.declared,
                    read    : report.failures.length
                });
                continue;
            }

            const {notes, skipped} = buildDefectNotes({failures: report.failures, run, job, repoSlug});

            summary.skippedTests.push(...skipped.map(entry => ({runId: run.id, job: job.name, ...entry})));

            if (notes.length === 0) {
                summary.skippedJobs.push({runId: run.id, job: job.name, reason: 'no-symptoms'});
                continue;
            }

            const toSend = notes.filter(note => !filedFingerprints.has(note.fingerprint));

            for (const note of notes) {
                if (filedFingerprints.has(note.fingerprint)) {
                    summary.skippedNotes.push({runId: run.id, job: job.name, fingerprint: note.fingerprint, reason: 'already-filed'});
                }
            }

            if (toSend.length === 0) {
                summary.skippedJobs.push({runId: run.id, job: job.name, reason: 'already-filed', notes: notes.length});
                continue;
            }

            for (const note of toSend) {
                await send(note);
                summary.notes.push({runId: run.id, job: job.name, fingerprint: note.fingerprint, subject: note.subject, thread});
            }

            summary.filedJobs.push({runId: run.id, job: job.name, notes: toSend.length, alreadyFiled: notes.length - toSend.length});
            openWorkflowPaths.add(run.path);
        }

        if (runComplete) {
            seen.add(run.id);
        }
    }

    // Recovery sees this tick's own sightings, so a record sighted in this window is fresh — a
    // flake that just fired stays open however green the suite is now. An incomplete mailbox scan
    // or run listing certifies no recovery: a record on an unread page, or a sighting in an unread
    // run, could be fresher than the read ones say.
    if (!complete) {
        summary.skippedRecoveries.push({reason: 'mailbox-scan-incomplete', read: messages.length, cap: mailboxLimit});
    } else if (continuations.length) {
        summary.skippedRecoveries.push({reason: 'run-listing-incomplete', continuations});
    } else {
        const records     = foldDefectObservations([...rows, ...sentRows], {now}),
              candidates  = selectRecoveryCandidates({records, greenJobs, now, recoveryAfterMs}),
              passesByJob = new Map();

        for (const candidate of candidates) {
            const {record, evidence} = candidate;

            let passes = passesByJob.get(evidence.jobId);

            if (!passes) {
                try {
                    passes = parsePlaywrightPasses(await github.fetchJobLog(evidence.jobId));
                } catch (error) {
                    summary.skippedRecoveries.push({fingerprint: record.fingerprint, reason: 'evidence-log-unreadable', runId: evidence.runId, error: error?.message || String(error)});
                    continue;
                }

                passesByJob.set(evidence.jobId, passes);
            }

            if (passes.size === 0) {
                summary.skippedRecoveries.push({fingerprint: record.fingerprint, reason: 'no-per-test-evidence', runId: evidence.runId, job: evidence.jobName});
                continue;
            }

            if (!passes.has(record.surface)) {
                summary.skippedRecoveries.push({fingerprint: record.fingerprint, reason: 'test-not-observed-passing', runId: evidence.runId, job: evidence.jobName});
                continue;
            }

            const recovery = buildRecoveryNote(candidate);

            await send(recovery);
            summary.recoveries.push({fingerprint: recovery.fingerprint, subject: recovery.subject, thread: recovery.partOfThread, evidenceRunId: evidence.runId});
        }
    }

    if (!dryRun) {
        const newest = runs.reduce((max, run) => Date.parse(run.createdAt) > Date.parse(max) ? run.createdAt : max, receipt.lastCreatedAt || since);

        await writeReceipt({
            version      : RECEIPT_VERSION,
            lastCreatedAt: newest,
            runIds       : [...seen].slice(-RECEIPT_RUN_CAPACITY),
            pendingRunIds: [...pending],
            continuations
        });
    }

    log(`ci-failure-ingest: ${summary.runsRead} run(s) since ${since}, ${summary.pendingRuns.length} pending, ${continuations.length} continuation slice(s), ${summary.notes.length} note(s), ${summary.recoveries.length} recovery(ies)${complete && !continuations.length ? '' : ' — incomplete read, no recovery certified'}${dryRun ? ' — dry run, nothing sent' : ''}`);

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

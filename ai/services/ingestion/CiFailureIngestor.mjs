import {defectNoteFingerprint, parseDefectNote} from '../memory-core/helpers/defectObservationFold.mjs';

/**
 * @summary The defect ledger's machine producer: turns a completed CI job's Playwright log into
 * canonical `defect-note:` observations, one per failing test, and turns a later green run of the
 * same job — whose log names the test passing — into the matching `[recovered]` notes.
 *
 * Deliberately PURE — no fetch, no mailbox, no clock. The GitHub reads and the A2A writes belong to
 * `ai/scripts/maintenance/ingestCiFailures.mjs`; this module is the mapping the fold is asserted
 * against, so a note it emits is a note `parseDefectNote` accepts by construction.
 *
 * Identity: the surface is the TEST — `<spec path> › <title path>` — never the job (one job colour
 * standing in for three defects is the failure this producer exists to end) and never the line
 * number (an unrelated edit above the test would fork the record). The symptom is the first
 * `Error:` line of the failure block that carries the same project, location AND title path: two
 * tests declared on one line share a location, and a location-only match would hand both the first
 * one's error. Both reporters CI runs (`list` for components, `github` for unit) print the same
 * epilogue — `N failed`, then one `[project] › path:line:col › titles` line per failing test — and
 * the same numbered failure blocks, so there is one grammar to parse.
 *
 * Non-vacuity: a log without that epilogue yields no notes; an epilogue whose declared count exceeds
 * the rows that follow it is incomplete and yields no notes either; and a failing test whose block
 * carries no `Error:` line yields no note — silence over a fingerprint derived from a truncated
 * read. The producer's own breakage is never filed as a defect in the code under test.
 *
 * Independence: every note travels under `partOfThread = ci:<workflow>:<job>:<run>`. The fold
 * records distinct threads per fingerprint, and the promotion trigger counts two threads from one
 * reporter as independent — a machine producer is one identity, so the run is its independence.
 * The same thread is the admission key, at observation granularity: a note whose fingerprint the
 * run-and-job thread already holds is not sent again, whichever orchestrator sent it.
 *
 * Recovery evidence: a green job is a candidate's evidence, never its proof — the caller files the
 * recovery only when that job's log names the affected test with a pass mark
 * ({@link parsePlaywrightPasses}). A job's colour says nothing about one test; a reporter that
 * names no passing tests (the `github` reporter's dots) can prove nothing, and the record stays red.
 *
 * @module ai/services/ingestion/CiFailureIngestor
 */

const CI_THREAD_PREFIX = 'ci';

const TIMESTAMP_PATTERN     = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/;
const ANSI_PATTERN          = /\x1b\[[0-9;]*[A-Za-z]/g;
const FAILED_COUNT_PATTERN  = /^\s*(\d+) failed\s*$/;
const EPILOGUE_LINE_PATTERN = /^\s+\[([^\]]+)\] › (\S+?):(\d+):(\d+) › (.+?)\s*$/;
const HEADER_LINE_PATTERN   = /^(?:##\[error\])?\s*\d+\) \[([^\]]+)\] › (\S+?):(\d+):(\d+) › (.+?)\s*(?:─+\s*)?$/;
const PASS_LINE_PATTERN     = /^\s*✓\s+\d+\s+\[([^\]]+)\] › (\S+?):(\d+):(\d+) › (.+?)\s*$/;
const PASS_SUFFIX_PATTERN   = /\s*\((?:\d+(?:\.\d+)?(?:ms|s|m)|retry #\d+)\)$/;
const ERROR_LINE_PATTERN    = /^\s*Error: (.+?)\s*$/;
const SUITE_RUN_STEP        = /^Run .+ tests$/;

const SYMPTOM_MAX_LENGTH = 160;
const DETAIL_MAX_LINES   = 12;

/**
 * @summary The thread every note of one CI job travels under — the fold's independence coordinate
 * and the ingestor's admission key.
 * @param {Object} options
 * @param {String} options.workflowPath e.g. `.github/workflows/test.yml`
 * @param {String} options.jobName      e.g. `components`
 * @param {Number|String} options.runId
 * @returns {String}
 */
export function buildCiThreadId({workflowPath, jobName, runId}) {
    return [CI_THREAD_PREFIX, encodeURIComponent(workflowPath), encodeURIComponent(jobName), String(runId)].join(':');
}

/**
 * @summary Reads a CI thread id back; anything else (a human thread, none) is `null`.
 * @param {String} thread
 * @returns {{workflowPath: String, jobName: String, runId: Number}|null}
 */
export function parseCiThreadId(thread) {
    if (typeof thread !== 'string') return null;

    const parts = thread.split(':');

    if (parts.length !== 4 || parts[0] !== CI_THREAD_PREFIX || !/^\d+$/.test(parts[3])) return null;

    try {
        return {
            workflowPath: decodeURIComponent(parts[1]),
            jobName     : decodeURIComponent(parts[2]),
            runId       : Number(parts[3])
        };
    } catch {
        return null;
    }
}

/**
 * @summary Strips the runner's per-line timestamp and any ANSI colour from one log line.
 * @param {String} line
 * @returns {String}
 */
function cleanLine(line) {
    return line.replace(TIMESTAMP_PATTERN, '').replace(ANSI_PATTERN, '').replace(/\r$/, '');
}

/**
 * @summary Collapses an error line into the symptom arm of a note: one line, one space between
 * words, bounded length — the fold's volatility rules do the rest.
 * @param {String} text
 * @returns {String}
 */
export function normalizeSymptom(text) {
    const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim();

    if (collapsed.length <= SYMPTOM_MAX_LENGTH) return collapsed;

    const cut = collapsed.slice(0, SYMPTOM_MAX_LENGTH),
          at  = cut.lastIndexOf(' ');

    return (at > SYMPTOM_MAX_LENGTH / 2 ? cut.slice(0, at) : cut).trim();
}

/**
 * @summary Reads one Playwright job log into its failed set, with the completeness the epilogue
 * declares.
 *
 * The failed set comes from the epilogue only — the `✘` progress lines and the `::error`
 * annotations are reporter-specific echoes of the same tests. Each test's symptom is the first
 * `Error:` line of its own first numbered failure block (retries repeat the block; the first
 * attempt is the observation), matched on the full identity — project, location and title path. A
 * block is matched by location alone only when it is the single block at that location. A log with
 * no epilogue — not a Playwright job, or truncated before the summary — declares nothing; an
 * epilogue whose `N failed` count exceeds the rows read after it is incomplete.
 *
 * @param {String} logText The raw job log as the Actions API serves it (timestamps included).
 * @returns {{failures: Array<{project: String, file: String, line: Number, column: Number, titlePath: String[], symptom: String|null, detail: String[]}>, declared: Number, complete: Boolean}}
 *   `declared` is the epilogue's count (`0` without an epilogue); `complete` is whether every declared row was read.
 */
export function parsePlaywrightReport(logText) {
    if (typeof logText !== 'string' || !logText) return {failures: [], declared: 0, complete: false};

    const lines      = logText.split('\n').map(cleanLine),
          byIdentity = new Map(),
          byLocation = new Map(),
          failures   = [];

    let epilogueAt = -1,
        declared   = 0;

    for (let index = 0; index < lines.length; index++) {
        const header = lines[index].match(HEADER_LINE_PATTERN);

        if (header) {
            const [, project, file, line, column, titles] = header,
                  location                                = `${file}:${line}:${column}`,
                  identity                                = `${project}|${location}|${titles.trim()}`;

            if (!byIdentity.has(identity)) {
                const block = collectBlock(lines, index + 1);

                byIdentity.set(identity, block);
                byLocation.set(location, [...(byLocation.get(location) || []), block]);
            }
            continue;
        }

        if (epilogueAt === -1) {
            const count = lines[index].match(FAILED_COUNT_PATTERN);

            if (count) {
                epilogueAt = index;
                declared   = Number(count[1]);
            }
        }
    }

    if (epilogueAt === -1) return {failures, declared: 0, complete: false};

    for (let index = epilogueAt + 1; index < lines.length; index++) {
        const entry = lines[index].match(EPILOGUE_LINE_PATTERN);

        if (!entry) break;

        const [, project, file, line, column, titles] = entry,
              location                                = `${file}:${line}:${column}`,
              siblings                                = byLocation.get(location) || [],
              block                                   = byIdentity.get(`${project}|${location}|${titles.trim()}`)
                  || (siblings.length === 1 ? siblings[0] : null)
                  || {symptom: null, detail: []};

        failures.push({
            project,
            file,
            line     : Number(line),
            column   : Number(column),
            titlePath: titles.split(' › ').map(title => title.trim()).filter(Boolean),
            symptom  : block.symptom,
            detail   : block.detail
        });
    }

    return {failures, declared, complete: failures.length === declared};
}

/**
 * @summary The failed set of a complete report; an absent or incomplete epilogue yields none.
 * @param {String} logText
 * @returns {Array<{project: String, file: String, line: Number, column: Number, titlePath: String[], symptom: String|null, detail: String[]}>}
 */
export function parsePlaywrightFailures(logText) {
    const report = parsePlaywrightReport(logText);

    return report.complete ? report.failures : [];
}

/**
 * @summary The tests a Playwright job log names as PASSED — the `list` reporter's `✓ N [project] ›
 * path:line:col › titles (duration)` lines — keyed by the surface a note carries (`<spec path> ›
 * <title path>`), whatever project ran them and whatever line they were declared on. A duration or
 * `(retry #n)` suffix is not part of the title; a flaky test that passed on a retry did pass. A log
 * from a reporter that names no passing tests (the `github` reporter's dots) yields an empty set —
 * evidence about no test at all.
 * @param {String} logText The raw job log as the Actions API serves it.
 * @returns {Set<String>} Surfaces observed passing.
 */
export function parsePlaywrightPasses(logText) {
    const passes = new Set();

    if (typeof logText !== 'string' || !logText) return passes;

    for (const raw of logText.split('\n')) {
        const match = cleanLine(raw).match(PASS_LINE_PATTERN);

        if (!match) continue;

        let titles = match[5].trim(),
            stripped;

        while ((stripped = titles.replace(PASS_SUFFIX_PATTERN, '')) !== titles) {
            titles = stripped;
        }

        passes.add(buildSurface({file: match[2], titlePath: titles.split(' › ').map(title => title.trim()).filter(Boolean)}));
    }

    return passes;
}

/**
 * @summary Walks one numbered failure block: the first `Error:` line is the symptom, the lines up
 * to and past it (bounded) are the human-facing detail for the note body.
 * @param {String[]} lines
 * @param {Number} start
 * @returns {{symptom: String|null, detail: String[]}}
 */
function collectBlock(lines, start) {
    const detail  = [];
    let   symptom = null;

    for (let index = start; index < lines.length && detail.length < DETAIL_MAX_LINES; index++) {
        const line = lines[index];

        if (HEADER_LINE_PATTERN.test(line) || FAILED_COUNT_PATTERN.test(line)) break;
        if (!line.trim() || /^\s*Retry #\d+/.test(line)) continue;

        detail.push(line.trim());

        if (symptom === null) {
            const error = line.match(ERROR_LINE_PATTERN);
            if (error) symptom = normalizeSymptom(error[1]);
        }
    }

    return {symptom, detail};
}

/**
 * @summary The surface arm of a note: the test's identity, stable across line shifts.
 * @param {{file: String, titlePath: String[]}} failure
 * @returns {String}
 */
export function buildSurface({file, titlePath}) {
    return [file, ...titlePath].join(' › ');
}

/**
 * @summary Maps one failed job's failures to the notes the ledger accepts.
 *
 * A failure without a symptom is dropped and reported in `skipped` — the test is known to fail,
 * but a note needs its `broke` arm, and inventing one would fork the record the next real
 * sighting creates. Duplicate fingerprints within one job collapse to one note.
 *
 * @param {Object}   options
 * @param {Object[]} options.failures Output of {@link parsePlaywrightReport}.
 * @param {Object}   options.run      `{id, name, path, headBranch, headSha, htmlUrl, event}`
 * @param {Object}   options.job      `{id, name, htmlUrl}`
 * @param {String}   options.repoSlug e.g. `neomjs/neo`
 * @returns {{notes: Object[], skipped: Object[]}}
 */
export function buildDefectNotes({failures, run, job, repoSlug}) {
    const thread  = buildCiThreadId({workflowPath: run.path, jobName: job.name, runId: run.id}),
          seen    = new Set(),
          notes   = [],
          skipped = [];

    for (const failure of Array.isArray(failures) ? failures : []) {
        if (!failure.symptom) {
            skipped.push({file: failure.file, line: failure.line, reason: 'no-error-line'});
            continue;
        }

        const surface     = buildSurface(failure),
              subject     = `defect-note: ${surface} broke ${failure.symptom}`,
              fingerprint = defectNoteFingerprint(subject);

        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);

        notes.push({
            subject,
            fingerprint,
            surface,
            symptom     : failure.symptom,
            partOfThread: thread,
            body        : buildNoteBody({failure, run, job, repoSlug})
        });
    }

    return {notes, skipped};
}

/**
 * @summary The human-facing provenance a note carries; the fold never reads it.
 * @param {Object} options
 * @returns {String}
 */
function buildNoteBody({failure, run, job, repoSlug}) {
    const runUrl = run.htmlUrl || `https://github.com/${repoSlug}/actions/runs/${run.id}`,
          jobUrl = job.htmlUrl || `${runUrl}/job/${job.id}`;

    return [
        `Filed by the CI failure ingestor: one observation per failing test, the run and job as the thread.`,
        '',
        `- test: \`${failure.file}:${failure.line}:${failure.column}\` [${failure.project}]`,
        `- run: ${runUrl} (${run.name || run.path}, ${run.event || 'unknown event'} on \`${run.headBranch || '?'}\` @ ${String(run.headSha || '').slice(0, 10)})`,
        `- job: ${job.name} — ${jobUrl}`,
        '',
        '```',
        ...failure.detail,
        '```'
    ].join('\n');
}

/**
 * @summary A job counts as evidence that its suite ran green only when it succeeded AND its
 * `Run … tests` step ran — the workflow skips a suite with a successful no-op job when nothing
 * in scope changed, and a skipped suite proves nothing about a red test.
 * @param {{conclusion: String, steps: Array<{name: String, conclusion: String}>}} job
 * @returns {Boolean}
 */
export function isSuiteRunGreen(job) {
    return job?.conclusion === 'success'
        && Array.isArray(job.steps)
        && job.steps.some(step => SUITE_RUN_STEP.test(step?.name || '') && step.conclusion === 'success');
}

/**
 * @summary Picks the open CI-filed records a newer green run of their own job MAY recover, each
 * with the evidence job the caller must prove it against.
 *
 * A record belongs to the workflow and job of its newest CI thread; a green job of that identity
 * from a NEWER run (by run id) is its candidate evidence — but only once the record has been quiet
 * for `recoveryAfterMs`. The first green run is not the evidence: a flake passes most of the time,
 * and recovering on its first pass would flip every flake to `recovered` before the digest ever
 * saw it red. A day without a sighting, with the suite green since, is a fixed test; a day with
 * one is a flake the ledger keeps open and counts. Records with no CI thread are the human
 * channel's and stay untouched; `quiet` records are already silent and re-open on their own next
 * sighting.
 *
 * The evidence is a candidate's, not a proof: the caller files the recovery only after the
 * evidence job's log names the record's surface with a pass mark ({@link parsePlaywrightPasses}).
 *
 * @param {Object}   options
 * @param {Object[]} options.records         Fold output (with `threads`).
 * @param {Object[]} options.greenJobs       `{workflowPath, jobName, runId, jobId, headSha, headBranch}` per suite-green job.
 * @param {Number}   options.now             Epoch ms.
 * @param {Number}   options.recoveryAfterMs Quiet time a record needs before green counts.
 * @returns {Array<{record: Object, evidence: Object, newest: Object}>}
 */
export function selectRecoveryCandidates({records, greenJobs, now, recoveryAfterMs}) {
    if (!Number.isFinite(now) || !Number.isFinite(recoveryAfterMs) || recoveryAfterMs < 0) {
        throw new Error('selectRecoveryCandidates: now and a non-negative recoveryAfterMs are required');
    }

    const green = new Map();

    for (const job of Array.isArray(greenJobs) ? greenJobs : []) {
        const key      = `${job.workflowPath} ${job.jobName}`,
              existing = green.get(key);

        if (!existing || job.runId > existing.runId) green.set(key, job);
    }

    const candidates = [];

    for (const record of Array.isArray(records) ? records : []) {
        if (record.state !== 'red' || !record.parseable) continue;
        if (now - Date.parse(record.lastSeenAt) < recoveryAfterMs) continue;

        const newest = (record.threads || [])
            .map(parseCiThreadId)
            .filter(Boolean)
            .sort((a, b) => b.runId - a.runId)[0];

        if (!newest) continue;

        const evidence = green.get(`${newest.workflowPath} ${newest.jobName}`);

        if (!evidence || evidence.runId <= newest.runId) continue;

        candidates.push({record, evidence, newest});
    }

    return candidates;
}

/**
 * @summary The `[recovered]` note for a candidate whose evidence was proven. It re-joins the
 * record's own surface and symptom, so it fingerprints to the observation the fold already holds;
 * the evidence run, its head and the proof ride the body.
 * @param {{record: Object, evidence: Object, newest: Object}} candidate
 * @returns {{subject: String, fingerprint: String, partOfThread: String, body: String}}
 */
export function buildRecoveryNote({record, evidence, newest}) {
    const subject = `defect-note: [recovered] ${record.surface} broke ${record.symptom}`;

    return {
        subject,
        fingerprint : defectNoteFingerprint(subject),
        partOfThread: buildCiThreadId({workflowPath: evidence.workflowPath, jobName: evidence.jobName, runId: evidence.runId}),
        body        : [
            'Filed by the CI failure ingestor: no sighting for the recovery window, and the job that last sighted this test ran its suite green in a newer run whose log names the test passing.',
            '',
            `- recovered by run ${evidence.runId}, job ${evidence.jobName} (${evidence.workflowPath}) on \`${evidence.headBranch || '?'}\` @ ${String(evidence.headSha || '').slice(0, 10)}`,
            `- observed passing in that job's log: \`${record.surface}\``,
            `- last red sighting: run ${newest.runId} at ${record.lastSeenAt}`
        ].join('\n')
    };
}

/**
 * @summary Asserts a note against the shipped grammar before it is sent — the arm that catches
 * a producer drifting away from `parseDefectNote` at authoring time rather than in the ledger.
 * @param {String} subject
 * @returns {Boolean}
 */
export function isCanonicalNote(subject) {
    const parsed = parseDefectNote(subject);

    return /^defect-note: /.test(subject) && parsed.parseable && parsed.surface.length > 0 && parsed.symptom.length > 0;
}

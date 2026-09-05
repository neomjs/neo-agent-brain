import {test, expect}      from '@playwright/test';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir}             from 'node:os';
import path                 from 'node:path';
import {
    listAllMessages,
    parseArgs,
    readReceipt,
    resolveSince,
    runIngest
} from '../../../../../../ai/scripts/maintenance/ingestCiFailures.mjs';
import {defectNoteFingerprint} from '../../../../../../ai/services/memory-core/helpers/defectObservationFold.mjs';

// The script's pure units over injected reads and writes — no GitHub, no mailbox, no plane.

const WORKFLOW  = '.github/workflows/test.yml';
const SPEC      = 'test/playwright/component/tab/OverflowAction.spec.mjs';
const TITLE     = 'Neo.tab.plugin.Overflow — toolbar action projection › renders first, outside focus gating';
const TITLE_TWO = 'Neo.tab.plugin.Overflow — toolbar action projection › the menu closes on Escape';
const DAY       = 24 * 60 * 60 * 1000;

/**
 * A minimal `list`-reporter log of a RED job, timestamped like the Actions API serves it, with one
 * numbered block and one epilogue row per failing test.
 * @param {Array<{title: String, line: Number, symptom: String}>} [tests]
 * @returns {String}
 */
function playwrightLog(tests = [{title: TITLE, line: 134, symptom: 'locator.click: Test timeout of 30000ms exceeded.'}]) {
    const blocks   = tests.flatMap((entry, index) => [
              `2026-09-05T01:00:51.2109221Z   ${index + 1}) [chromium] › ${SPEC}:${entry.line}:5 › ${entry.title} `,
              '2026-09-05T01:00:51.2110458Z ',
              `2026-09-05T01:00:51.2111226Z     Error: ${entry.symptom}`
          ]),
          epilogue = tests.map(entry => `2026-09-05T01:00:51.2136612Z     [chromium] › ${SPEC}:${entry.line}:5 › ${entry.title} `);

    return [...blocks, `2026-09-05T01:00:51.2134944Z   ${tests.length} failed`, ...epilogue, '2026-09-05T01:00:51.2137806Z   240 passed (5.1m)'].join('\n');
}

/**
 * A `list`-reporter log of a GREEN job naming the tests that passed.
 * @param {String[]} [titles] Titles under SPEC that passed.
 * @returns {String}
 */
function passLog(titles = [TITLE]) {
    return [
        ...titles.map((title, index) => `2026-09-05T01:40:51.1405342Z   ✓  ${index + 1} [chromium] › ${SPEC}:${134 + index}:5 › ${title} (738ms)`),
        '2026-09-05T01:40:52.2137806Z   241 passed (5.1m)'
    ].join('\n');
}

// The `github` reporter of the unit job names no passing tests — dots, then the summary.
const DOT_PASS_LOG = '2026-09-05T01:40:51.0000000Z ······································\n2026-09-05T01:40:52.0000000Z   3158 passed (1.4m)';

const NON_PLAYWRIGHT_LOG = '2026-09-05T01:00:00.0000000Z FAIL over-target 1284 code src/dashboard/dock/Workspace.mjs\n2026-09-05T01:00:01.0000000Z ##[error]Process completed with exit code 1.';

function run(id, {createdAt, path = WORKFLOW, status = 'completed', conclusion = 'failure', headSha = 'abc', headBranch = 'dev'} = {}) {
    return {id, name: 'Engine Tests', path, event: 'push', headBranch, headSha, htmlUrl: `https://github.com/neomjs/neo/actions/runs/${id}`, createdAt, updatedAt: createdAt, status, conclusion};
}

function job(id, name, conclusion, stepConclusion = conclusion) {
    return {id, name, conclusion, htmlUrl: `https://example/job/${id}`, steps: [{name: `Skip ${name} tests`, conclusion: 'skipped'}, {name: `Run ${name} tests`, conclusion: stepConclusion}]};
}

function redNote(sentAt, {thread = 'ci:.github%2Fworkflows%2Ftest.yml:components:5', title = TITLE, from = '@ci-failure-ingest'} = {}) {
    return {from, sentAt, subject: `defect-note: ${SPEC} › ${title} broke locator.click: Test timeout of 30000ms exceeded.`, partOfThread: thread};
}

/**
 * Builds the injected GitHub + mailbox pair and records every read and write. The mailbox pages like
 * the real one: `limit`/`offset` in, `truncated`/`nextOffset` out, newest rows included. `listRuns`
 * answers the current window from `runs` (or a `listing` override) and a bounded slice from `slices`.
 * @param {Object} world `{runs, listing, slices, runsById, jobsByRun, logsByJob, messages}`
 * @returns {Object}
 */
function harness({runs = [], listing = null, slices = {}, runsById = {}, jobsByRun = {}, logsByJob = {}, messages = []} = {}) {
    const sent = [], receipts = [], logFetches = [], runReads = [], listCalls = [], runListings = [];

    return {
        sent, receipts, logFetches, runReads, listCalls, runListings,
        github: {
            listRuns   : async ({since, until = null}) => {
                runListings.push({since, until});
                if (until) return slices[`${since}..${until}`] || {runs: [], complete: true};
                return listing || {runs, complete: true};
            },
            getRun     : async runId => {
                runReads.push(runId);
                if (!runsById[runId]) throw new Error(`githubActions: 404 Not Found for /actions/runs/${runId}`);
                if (runsById[runId] instanceof Error) throw runsById[runId];
                return runsById[runId];
            },
            listJobs   : async runId => jobsByRun[runId] || [],
            fetchJobLog: async jobId => {
                logFetches.push(jobId);
                if (logsByJob[jobId] instanceof Error) throw logsByJob[jobId];
                return logsByJob[jobId] ?? '';
            }
        },
        mailbox: {
            listMessages: async ({threadId, limit = 50, offset = 0} = {}) => {
                listCalls.push({threadId, limit, offset});

                const all  = threadId ? [...messages, ...sent].filter(message => message.partOfThread === threadId) : [...messages, ...sent],
                      page = all.slice(offset, offset + limit),
                      end  = offset + page.length;

                return {messages: page, totalCount: all.length, truncated: end < all.length, nextOffset: end < all.length ? end : null};
            },
            addMessage: async message => { sent.push(message); return {messageId: `MESSAGE:${sent.length}`}; }
        },
        writeReceipt: async receipt => { receipts.push(receipt); }
    };
}

const EMPTY_RECEIPT = {version: 2, lastCreatedAt: null, runIds: [], pendingRunIds: [], continuations: []};

function tick(world, overrides = {}) {
    return runIngest({...world, repoSlug: 'neomjs/neo', receipt: EMPTY_RECEIPT, now: Date.parse('2026-09-05T02:00:00Z'), log: () => {}, ...overrides});
}

test.describe('ingestCiFailures — the producer tick over injected reads and writes', () => {
    test('parseArgs: defaults, supplied values, unknown flags, and missing or invalid values', () => {
        expect(parseArgs([])).toEqual({repo: null, lookbackMs: null, limit: null, planeBase: null, receipt: null, local: false, dryRun: false, json: false, parseError: null});

        expect(parseArgs(['--repo', 'neomjs/neo-agent-brain', '--lookback-hours', '6', '--limit', '200', '--plane-base', 'http://127.0.0.1:3102', '--receipt', '/tmp/r.json', '--local', '--dry-run', '--json'])).toEqual({
            repo: 'neomjs/neo-agent-brain', lookbackMs: 6 * 60 * 60 * 1000, limit: 200, planeBase: 'http://127.0.0.1:3102', receipt: '/tmp/r.json', local: true, dryRun: true, json: true, parseError: null
        });

        expect(parseArgs(['--nope']).parseError).toMatch(/unknown option/i);
        expect(parseArgs(['--limit']).parseError).toMatch(/argument missing/i);
        expect(parseArgs(['--lookback-hours', '-2']).parseError).toMatch(/--lookback-hours must be a positive number/);
        expect(parseArgs(['--limit', 'many']).parseError).toMatch(/--limit must be a positive number/);
    });

    test('resolveSince: the receipt minus an overlap, floored by the lookback, at the seconds precision the API filters on', () => {
        const now = Date.parse('2026-09-05T12:00:00.267Z');

        // No receipt reads the whole lookback; milliseconds are dropped to the API's documented filter shape.
        expect(resolveSince({receipt: {lastCreatedAt: null, runIds: []}, now, lookbackMs: DAY})).toBe('2026-09-04T12:00:00Z');
        expect(resolveSince({receipt: {lastCreatedAt: '2026-09-05T10:00:00Z', runIds: []}, now, lookbackMs: DAY})).toBe('2026-09-05T08:00:00Z');
        // A stale receipt never opens an unbounded read.
        expect(resolveSince({receipt: {lastCreatedAt: '2026-08-01T00:00:00Z', runIds: []}, now, lookbackMs: DAY})).toBe('2026-09-04T12:00:00Z');
    });

    test('readReceipt: absent or malformed is an empty receipt, never a throw; a version-1 receipt is read with no pending runs and no continuation', async () => {
        expect(await readReceipt('/nonexistent/ci-failure-ingest.json')).toEqual(EMPTY_RECEIPT);

        const dir = await mkdtemp(path.join(tmpdir(), 'ci-ingest-receipt-')),
              v1  = path.join(dir, 'v1.json');

        await writeFile(v1, JSON.stringify({version: 1, lastCreatedAt: '2026-09-05T01:00:00Z', runIds: [10, 11]}));
        expect(await readReceipt(v1)).toEqual({version: 2, lastCreatedAt: '2026-09-05T01:00:00Z', runIds: [10, 11], pendingRunIds: [], continuations: []});

        await writeFile(v1, '{not json');
        expect(await readReceipt(v1)).toEqual(EMPTY_RECEIPT);
    });

    test('listAllMessages walks the pages the mailbox hands back and says whether it reached the end', async () => {
        const world = harness({messages: Array.from({length: 250}, (_, index) => ({subject: `row ${index}`}))});

        const all = await listAllMessages(world.mailbox, {to: 'AGENT:*', status: 'all'}, 500);

        expect(all.messages).toHaveLength(250);
        expect(all.complete).toBe(true);
        expect(world.listCalls.map(call => [call.limit, call.offset])).toEqual([[100, 0], [100, 100], [100, 200]]);

        const capped = await listAllMessages(world.mailbox, {to: 'AGENT:*', status: 'all'}, 150);

        expect(capped.messages).toHaveLength(150);
        expect(capped.complete, 'rows remain beyond the cap').toBe(false);

        // An adapter that hands everything back at once is one complete page.
        const flat = await listAllMessages({listMessages: async () => ({messages: [{subject: 'a'}]})}, {}, 500);

        expect(flat).toEqual({messages: [{subject: 'a'}], complete: true});
    });

    test('one red run: N failing tests → N quiet low-priority broadcasts under the run+job thread, then a receipt (AC-1)', async () => {
        const world = harness({
            runs     : [run(10, {createdAt: '2026-09-05T01:00:00Z'})],
            jobsByRun: {10: [job(100, 'unit', 'success'), job(101, 'components', 'failure')]},
            logsByJob: {101: playwrightLog()}
        });

        const summary = await tick(world);

        expect(world.logFetches).toEqual([101]);           // the green job's log is never fetched
        expect(world.sent).toHaveLength(1);
        expect(world.sent[0]).toMatchObject({
            to            : 'AGENT:*',
            priority      : 'low',
            wakeSuppressed: true,
            partOfThread  : 'ci:.github%2Fworkflows%2Ftest.yml:components:10',
            subject       : `defect-note: ${SPEC} › ${TITLE} broke locator.click: Test timeout of 30000ms exceeded.`
        });
        expect(summary.filedJobs).toEqual([{runId: 10, job: 'components', notes: 1, alreadyFiled: 0}]);
        expect(summary.notes[0].fingerprint).toBe(defectNoteFingerprint(world.sent[0].subject));
        expect(summary.mailboxScanComplete).toBe(true);
        expect(summary.listingComplete).toBe(true);
        expect(world.receipts).toEqual([{version: 2, lastCreatedAt: '2026-09-05T01:00:00Z', runIds: [10], pendingRunIds: [], continuations: []}]);
    });

    test('an interrupted write resumes at the note it lost: admission is per observation, not per job (RA-1)', async () => {
        const two   = [{title: TITLE, line: 134, symptom: 'expected A'}, {title: TITLE_TWO, line: 134, symptom: 'expected B'}],
              shape = () => ({runs: [run(10, {createdAt: '2026-09-05T01:00:00Z'})], jobsByRun: {10: [job(101, 'components', 'failure')]}, logsByJob: {101: playwrightLog(two)}}),
              world = harness(shape()),
              realAdd = world.mailbox.addMessage;

        // Control: an uninterrupted tick files two notes.
        const control = harness(shape());
        await tick(control);
        expect(control.sent).toHaveLength(2);

        // The first note lands, the second write throws: the tick fails and receipts nothing.
        let writes = 0;
        world.mailbox.addMessage = async message => {
            if (++writes === 2) throw new Error('mailbox unreachable');
            return realAdd(message);
        };

        await expect(tick(world)).rejects.toThrow('mailbox unreachable');
        expect(world.sent).toHaveLength(1);
        expect(world.receipts).toEqual([]);

        // The retry, with the unchanged receipt, sends exactly the missing note and completes the job.
        world.mailbox.addMessage = realAdd;

        const retry = await tick(world);

        expect(world.sent).toHaveLength(2);
        expect(new Set(world.sent.map(message => defectNoteFingerprint(message.subject))).size).toBe(2);
        expect(world.sent.map(message => message.subject).sort()).toEqual(control.sent.map(message => message.subject).sort());
        expect(retry.filedJobs).toEqual([{runId: 10, job: 'components', notes: 1, alreadyFiled: 1}]);
        expect(retry.skippedNotes).toEqual([{runId: 10, job: 'components', fingerprint: defectNoteFingerprint(world.sent[0].subject), reason: 'already-filed'}]);
        expect(world.receipts[0].runIds).toEqual([10]);

        // A third tick over the same run finds every note filed and sends nothing.
        const again = await tick(world);

        expect(world.sent).toHaveLength(2);
        expect(again.skippedJobs).toEqual([{runId: 10, job: 'components', reason: 'already-filed', notes: 2}]);
    });

    test('a note another orchestrator filed under the thread is not filed again; a different note in the same thread does not shadow it', async () => {
        const thread = 'ci:.github%2Fworkflows%2Ftest.yml:components:10',
              mine   = `defect-note: ${SPEC} › ${TITLE} broke locator.click: Test timeout of 30000ms exceeded.`;

        const filed = harness({
            runs     : [run(10, {createdAt: '2026-09-05T01:00:00Z'})],
            jobsByRun: {10: [job(101, 'components', 'failure')]},
            logsByJob: {101: playwrightLog()},
            messages : [{from: '@neo-opus-grace', sentAt: '2026-09-05T01:10:00Z', subject: mine, partOfThread: thread}]
        });

        const summary = await tick(filed);

        expect(filed.sent).toEqual([]);
        expect(summary.skippedJobs).toEqual([{runId: 10, job: 'components', reason: 'already-filed', notes: 1}]);
        expect(filed.receipts[0].runIds, 'the receipt still advances: this host has read the run').toEqual([10]);

        const other = harness({
            runs     : [run(10, {createdAt: '2026-09-05T01:00:00Z'})],
            jobsByRun: {10: [job(101, 'components', 'failure')]},
            logsByJob: {101: playwrightLog()},
            messages : [{from: '@neo-opus-grace', sentAt: '2026-09-05T01:10:00Z', subject: 'defect-note: x › y broke z', partOfThread: thread}]
        });

        await tick(other);

        expect(other.sent).toHaveLength(1);
        expect(other.sent[0].subject).toBe(mine);
    });

    test('a failed job without a Playwright epilogue files nothing; an epilogue shorter than its count files nothing either; a receipted run is not re-read (AC-5, RA-4)', async () => {
        const truncated = playwrightLog([{title: TITLE, line: 134, symptom: 'expected A'}, {title: TITLE_TWO, line: 200, symptom: 'expected B'}])
            .split('\n').filter(line => !line.includes(`:200:5 › ${TITLE_TWO}`) || line.includes(') [chromium]')).join('\n');

        const world = harness({
            runs     : [run(10, {createdAt: '2026-09-05T01:00:00Z', path: '.github/workflows/file-size-guard.yml'}), run(11, {createdAt: '2026-09-05T01:30:00Z'}), run(12, {createdAt: '2026-09-05T01:40:00Z'})],
            jobsByRun: {10: [job(100, 'guard', 'failure')], 11: [job(110, 'components', 'failure')], 12: [job(120, 'components', 'failure')]},
            logsByJob: {100: NON_PLAYWRIGHT_LOG, 110: playwrightLog(), 120: truncated}
        });

        const summary = await tick(world, {receipt: {...EMPTY_RECEIPT, lastCreatedAt: '2026-09-05T01:00:00Z', runIds: [11]}});

        expect(world.logFetches).toEqual([100, 120]);
        expect(world.sent).toEqual([]);
        expect(summary.skippedJobs).toEqual([
            {runId: 10, job: 'guard',      reason: 'no-playwright-epilogue', declared: 0, read: 0},
            {runId: 12, job: 'components', reason: 'epilogue-incomplete',    declared: 2, read: 1}
        ]);
        expect(summary.runsRead).toBe(2);
        expect(world.receipts[0].runIds.sort(), 'a truncated log will not heal: the run is receipted, not re-read every tick').toEqual([10, 11, 12]);
    });

    test('dry run reads everything, sends nothing, writes no receipt', async () => {
        const world = harness({
            runs     : [run(10, {createdAt: '2026-09-05T01:00:00Z'})],
            jobsByRun: {10: [job(101, 'components', 'failure')]},
            logsByJob: {101: playwrightLog()}
        });

        const summary = await tick(world, {dryRun: true});

        expect(summary.notes).toHaveLength(1);
        expect(world.sent).toEqual([]);
        expect(world.receipts).toEqual([]);
    });

    test('a run still running is carried as pending and finished by id on a later tick, whatever window it was created in (RA-3)', async () => {
        const first = harness({
            runs     : [run(20, {createdAt: '2026-09-05T00:30:00Z', status: 'in_progress', conclusion: null})],
            jobsByRun: {20: [job(201, 'components', 'failure')]},
            logsByJob: {201: playwrightLog()}
        });

        const summary = await tick(first);

        expect(first.sent).toEqual([]);
        expect(summary.pendingRuns).toEqual([20]);
        expect(summary.runsRead).toBe(0);
        expect(first.receipts[0]).toMatchObject({runIds: [], pendingRunIds: [20]});

        // The window has moved past the run's creation: it is no longer listed, and read by id.
        const later = harness({
            runs     : [],
            runsById : {20: run(20, {createdAt: '2026-09-05T00:30:00Z'})},
            jobsByRun: {20: [job(201, 'components', 'failure')]},
            logsByJob: {201: playwrightLog()}
        });

        const finished = await tick(later, {receipt: first.receipts[0], now: Date.parse('2026-09-05T05:00:00Z')});

        expect(later.runReads).toEqual([20]);
        expect(later.sent).toHaveLength(1);
        expect(finished.runsRead).toBe(1);
        expect(later.receipts[0]).toMatchObject({runIds: [20], pendingRunIds: []});

        // A pending run the API no longer knows is dropped; one it cannot serve right now stays pending.
        const flaky = harness({runs: [], runsById: {31: new Error('githubActions: 502 Bad Gateway for /actions/runs/31')}});

        await tick(flaky, {receipt: {...EMPTY_RECEIPT, pendingRunIds: [30, 31]}});

        expect(flaky.runReads.sort()).toEqual([30, 31]);
        expect(flaky.receipts[0].pendingRunIds).toEqual([31]);
    });

    test('a listing that exhausted its page bound leaves the unread remainder as a continuation slice, drained before the next window; the oldest run is filed, not lost (RA-3)', async () => {
        // The window holds one more run than the bound reads: the newest are listed, the 00:15 failure is not.
        const newest = [run(41, {createdAt: '2026-09-05T01:00:00Z', conclusion: 'success'}), run(42, {createdAt: '2026-09-05T01:30:00Z', conclusion: 'success'})],
              oldest = run(40, {createdAt: '2026-09-05T00:15:00Z'}),
              first  = harness({
                  listing  : {runs: newest, complete: false},
                  jobsByRun: {40: [job(401, 'components', 'failure')]},
                  logsByJob: {401: playwrightLog()}
              });

        const summary = await tick(first, {lookbackMs: 4 * 60 * 60 * 1000});

        expect(summary.listingComplete).toBe(false);
        expect(summary.continuations).toEqual([{since: '2026-09-04T22:00:00Z', until: '2026-09-05T01:00:00Z'}]);
        expect(summary.skippedRecoveries).toEqual([{reason: 'run-listing-incomplete', continuations: summary.continuations}]);
        expect(first.receipts[0]).toMatchObject({lastCreatedAt: '2026-09-05T01:30:00Z', runIds: [41, 42], continuations: summary.continuations});

        // Next tick: the slice is drained first (bounded above by the oldest run already read), then
        // the current window; the 00:15 failure is filed and the continuation is cleared.
        const second = harness({
            runs     : [run(43, {createdAt: '2026-09-05T02:30:00Z', conclusion: 'success'})],
            slices   : {'2026-09-04T22:00:00Z..2026-09-05T01:00:00Z': {runs: [oldest, newest[0]], complete: true}},
            jobsByRun: {40: [job(401, 'components', 'failure')]},
            logsByJob: {401: playwrightLog()}
        });

        const drained = await tick(second, {receipt: first.receipts[0], now: Date.parse('2026-09-05T03:00:00Z')});

        expect(second.runListings[0]).toEqual({since: '2026-09-04T22:00:00Z', until: '2026-09-05T01:00:00Z'});
        expect(second.runListings[1].until).toBeNull();
        expect(second.sent).toHaveLength(1);
        expect(second.sent[0].partOfThread).toBe('ci:.github%2Fworkflows%2Ftest.yml:components:40');
        expect(drained.listingComplete).toBe(true);
        expect(drained.runsRead, 'run 41 was already receipted; 40 and 43 are new').toBe(2);
        expect(second.receipts[0]).toMatchObject({runIds: [41, 42, 40, 43], continuations: []});

        // A slice that is itself too big to finish stays a slice, narrowed to what was not read.
        const stubborn = harness({
            runs  : [],
            slices: {'2026-09-04T22:00:00Z..2026-09-05T01:00:00Z': {runs: [run(39, {createdAt: '2026-09-05T00:45:00Z', conclusion: 'success'})], complete: false}}
        });

        const narrowed = await tick(stubborn, {receipt: first.receipts[0], now: Date.parse('2026-09-05T03:00:00Z')});

        expect(narrowed.continuations).toEqual([{since: '2026-09-04T22:00:00Z', until: '2026-09-05T00:45:00Z'}]);
    });

    test('a red run followed by a green run of the same job files the sighting, and recovers it only once quiet AND the green job\'s log names the test passing (AC-4, RA-2)', async () => {
        const build = greenLog => harness({
            runs     : [run(10, {createdAt: '2026-09-05T01:00:00Z'}), run(12, {createdAt: '2026-09-05T01:40:00Z', conclusion: 'success', headSha: 'green-sha'})],
            jobsByRun: {10: [job(101, 'components', 'failure')], 12: [job(121, 'components', 'success')]},
            logsByJob: {101: playwrightLog(), 121: greenLog}
        });

        // Under the default day-long window the green run an hour later recovers nothing: this
        // tick's own sighting is fresh, and a flake that just passed is still a flake.
        const fresh = build(passLog());

        expect((await tick(fresh)).recoveries).toEqual([]);
        expect(fresh.sent).toHaveLength(1);
        expect(fresh.logFetches, 'no candidate, no evidence read').toEqual([101]);

        // Quiet, green, and the green job's log names the test passing: recovered by that run.
        const proven  = build(passLog()),
              summary = await tick(proven, {recoveryAfterMs: 0});

        expect(proven.logFetches).toEqual([101, 121]);
        expect(proven.sent).toHaveLength(2);
        expect(proven.sent[1].subject.startsWith(`defect-note: [recovered] ${SPEC}`)).toBe(true);
        expect(proven.sent[1].partOfThread).toBe('ci:.github%2Fworkflows%2Ftest.yml:components:12');
        expect(proven.sent[1].body).toContain('@ green-sha');
        expect(proven.sent[1].body).toContain(`observed passing in that job's log: \`${SPEC} › ${TITLE}\``);
        expect(summary.recoveries[0].fingerprint).toBe(summary.notes[0].fingerprint);

        // The same green job whose log names the SPEC FILE but not this test: the test was renamed,
        // removed, or never ran there — no evidence about it, the record stays red.
        const otherTest = build(passLog([TITLE_TWO])),
              quiet     = await tick(otherTest, {recoveryAfterMs: 0});

        expect(otherTest.sent).toHaveLength(1);
        expect(quiet.recoveries).toEqual([]);
        expect(quiet.skippedRecoveries).toEqual([{fingerprint: quiet.notes[0].fingerprint, reason: 'test-not-observed-passing', runId: 12, job: 'components'}]);

        // A reporter that names no passing tests can prove nothing: red stays red.
        const dots = build(DOT_PASS_LOG),
              blind = await tick(dots, {recoveryAfterMs: 0});

        expect(dots.sent).toHaveLength(1);
        expect(blind.skippedRecoveries).toEqual([{fingerprint: blind.notes[0].fingerprint, reason: 'no-per-test-evidence', runId: 12, job: 'components'}]);

        // An unreadable evidence log is not evidence: the record stays red, the tick goes on and receipts.
        const unreadable = build(new Error('githubActions: 502 Bad Gateway for /actions/jobs/121/logs')),
              held       = await tick(unreadable, {recoveryAfterMs: 0});

        expect(unreadable.sent).toHaveLength(1);
        expect(held.skippedRecoveries[0]).toMatchObject({reason: 'evidence-log-unreadable', runId: 12});
        expect(unreadable.receipts).toHaveLength(1);

        // A green job whose suite was skipped is not evidence: same world, step skipped.
        const skipped = harness({
            runs     : [run(10, {createdAt: '2026-09-05T01:00:00Z'}), run(12, {createdAt: '2026-09-05T01:40:00Z', conclusion: 'success'})],
            jobsByRun: {10: [job(101, 'components', 'failure')], 12: [job(121, 'components', 'success', 'skipped')]},
            logsByJob: {101: playwrightLog(), 121: passLog()}
        });

        await tick(skipped, {recoveryAfterMs: 0});
        expect(skipped.sent).toHaveLength(1);
    });

    test('recovery reads the whole mailbox or certifies nothing: a red record on the second page is found, and a capped scan files sightings but no recovery (RA-3)', async () => {
        const noise   = Array.from({length: 120}, (_, index) => ({from: '@neo-opus-vega', sentAt: '2026-09-05T01:00:00Z', subject: `[lane-claim] #${index}`})),
              old     = redNote('2026-09-03T01:00:00Z'),
              shape   = () => harness({
                  runs     : [run(12, {createdAt: '2026-09-05T01:40:00Z', conclusion: 'success', headSha: 'green-sha'}), run(13, {createdAt: '2026-09-05T01:50:00Z'})],
                  jobsByRun: {12: [job(121, 'components', 'success')], 13: [job(131, 'components', 'failure')]},
                  logsByJob: {121: passLog([TITLE]), 131: playwrightLog([{title: TITLE_TWO, line: 300, symptom: 'expected B'}])},
                  messages : [...noise, old]
              });

        const whole   = shape(),
              summary = await tick(whole, {recoveryAfterMs: DAY});

        expect(summary.mailboxScanComplete).toBe(true);
        expect(summary.recoveries).toHaveLength(1);
        expect(summary.recoveries[0].fingerprint).toBe(defectNoteFingerprint(old.subject));
        expect(whole.sent.map(message => message.subject.startsWith('defect-note: [recovered]'))).toEqual([false, true]);

        const capped  = shape(),
              partial = await tick(capped, {recoveryAfterMs: DAY, mailboxLimit: 100});

        expect(partial.mailboxScanComplete).toBe(false);
        expect(partial.recoveries).toEqual([]);
        expect(partial.skippedRecoveries).toEqual([{reason: 'mailbox-scan-incomplete', read: 100, cap: 100}]);
        expect(capped.sent, 'the new sighting is still filed').toHaveLength(1);
        expect(capped.sent[0].subject.startsWith('defect-note: [recovered]')).toBe(false);
    });
});

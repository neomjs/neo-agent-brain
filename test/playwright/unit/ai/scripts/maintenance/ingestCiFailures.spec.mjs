import {test, expect} from '@playwright/test';
import {
    parseArgs,
    readReceipt,
    resolveSince,
    runIngest
} from '../../../../../../ai/scripts/maintenance/ingestCiFailures.mjs';
import {defectNoteFingerprint} from '../../../../../../ai/services/memory-core/helpers/defectObservationFold.mjs';

// The script's pure units over injected reads and writes — no GitHub, no mailbox, no fs.

const WORKFLOW = '.github/workflows/test.yml';
const TITLE    = 'Neo.tab.plugin.Overflow — toolbar action projection › renders first, outside focus gating';

/**
 * A minimal `list`-reporter log with one failing test, timestamped like the Actions API serves it.
 * @param {String} [symptom]
 * @returns {String}
 */
function playwrightLog(symptom = 'locator.click: Test timeout of 30000ms exceeded.') {
    return [
        `2026-09-05T01:00:51.2109221Z   1) [chromium] › test/playwright/component/tab/OverflowAction.spec.mjs:134:5 › ${TITLE} `,
        '2026-09-05T01:00:51.2110458Z ',
        `2026-09-05T01:00:51.2111226Z     Error: ${symptom}`,
        '2026-09-05T01:00:51.2134944Z   1 failed',
        `2026-09-05T01:00:51.2136612Z     [chromium] › test/playwright/component/tab/OverflowAction.spec.mjs:134:5 › ${TITLE} `,
        '2026-09-05T01:00:51.2137806Z   240 passed (5.1m)'
    ].join('\n');
}

const NON_PLAYWRIGHT_LOG = '2026-09-05T01:00:00.0000000Z FAIL over-target 1284 code src/dashboard/dock/Workspace.mjs\n2026-09-05T01:00:01.0000000Z ##[error]Process completed with exit code 1.';

function run(id, {createdAt, path = WORKFLOW} = {}) {
    return {id, name: 'Engine Tests', path, event: 'push', headBranch: 'dev', headSha: 'abc', htmlUrl: `https://github.com/neomjs/neo/actions/runs/${id}`, createdAt, updatedAt: createdAt, conclusion: 'failure'};
}

function job(id, name, conclusion, stepConclusion = conclusion) {
    return {id, name, conclusion, htmlUrl: `https://example/job/${id}`, steps: [{name: `Skip ${name} tests`, conclusion: 'skipped'}, {name: `Run ${name} tests`, conclusion: stepConclusion}]};
}

/**
 * Builds the injected GitHub + mailbox pair and records every write.
 * @param {Object} world `{runs, jobsByRun, logsByJob, messages}`
 * @returns {Object}
 */
function harness({runs = [], jobsByRun = {}, logsByJob = {}, messages = []} = {}) {
    const sent = [], receipts = [], logFetches = [];

    return {
        sent, receipts, logFetches,
        github: {
            listCompletedRuns: async () => runs,
            listJobs         : async runId => jobsByRun[runId] || [],
            fetchJobLog      : async jobId => { logFetches.push(jobId); return logsByJob[jobId] ?? ''; }
        },
        mailbox: {
            listMessages: async ({threadId} = {}) => ({
                messages: threadId ? [...messages, ...sent].filter(message => message.partOfThread === threadId) : messages
            }),
            addMessage: async message => { sent.push(message); return {messageId: `MESSAGE:${sent.length}`}; }
        },
        writeReceipt: async receipt => { receipts.push(receipt); }
    };
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
        const now = Date.parse('2026-09-05T12:00:00.267Z'),
              day = 24 * 60 * 60 * 1000;

        // No receipt reads the whole lookback; milliseconds are dropped to the API's documented filter shape.
        expect(resolveSince({receipt: {lastCreatedAt: null, runIds: []}, now, lookbackMs: day})).toBe('2026-09-04T12:00:00Z');
        expect(resolveSince({receipt: {lastCreatedAt: '2026-09-05T10:00:00Z', runIds: []}, now, lookbackMs: day})).toBe('2026-09-05T08:00:00Z');
        // A stale receipt never opens an unbounded read.
        expect(resolveSince({receipt: {lastCreatedAt: '2026-08-01T00:00:00Z', runIds: []}, now, lookbackMs: day})).toBe('2026-09-04T12:00:00Z');
    });

    test('readReceipt: absent or malformed is an empty receipt, never a throw', async () => {
        expect(await readReceipt('/nonexistent/ci-failure-ingest.json')).toEqual({version: 1, lastCreatedAt: null, runIds: []});
    });

    test('one red run: N failing tests → N quiet low-priority broadcasts under the run+job thread, then a receipt (AC-1)', async () => {
        const world = harness({
            runs     : [run(10, {createdAt: '2026-09-05T01:00:00Z'})],
            jobsByRun: {10: [job(100, 'unit', 'success'), job(101, 'components', 'failure')]},
            logsByJob: {101: playwrightLog()}
        });

        const summary = await runIngest({...world, repoSlug: 'neomjs/neo', receipt: {version: 1, lastCreatedAt: null, runIds: []}, now: Date.parse('2026-09-05T02:00:00Z'), log: () => {}});

        expect(world.logFetches).toEqual([101]);           // the green job's log is never fetched
        expect(world.sent).toHaveLength(1);
        expect(world.sent[0]).toMatchObject({
            to            : 'AGENT:*',
            priority      : 'low',
            wakeSuppressed: true,
            partOfThread  : 'ci:.github%2Fworkflows%2Ftest.yml:components:10',
            subject       : `defect-note: test/playwright/component/tab/OverflowAction.spec.mjs › ${TITLE} broke locator.click: Test timeout of 30000ms exceeded.`
        });
        expect(summary.filedJobs).toEqual([{runId: 10, job: 'components', notes: 1}]);
        expect(summary.notes[0].fingerprint).toBe(defectNoteFingerprint(world.sent[0].subject));
        expect(world.receipts).toEqual([{version: 1, lastCreatedAt: '2026-09-05T01:00:00Z', runIds: [10]}]);
    });

    test('a run and job already on the mailbox is skipped, whichever orchestrator filed it (idempotence across hosts)', async () => {
        const thread = 'ci:.github%2Fworkflows%2Ftest.yml:components:10',
              world  = harness({
                  runs     : [run(10, {createdAt: '2026-09-05T01:00:00Z'})],
                  jobsByRun: {10: [job(101, 'components', 'failure')]},
                  logsByJob: {101: playwrightLog()},
                  messages : [{from: '@neo-opus-grace', sentAt: '2026-09-05T01:10:00Z', subject: 'defect-note: x › y broke z', partOfThread: thread}]
              });

        const summary = await runIngest({...world, repoSlug: 'neomjs/neo', receipt: {version: 1, lastCreatedAt: null, runIds: []}, now: Date.parse('2026-09-05T02:00:00Z'), log: () => {}});

        expect(world.logFetches).toEqual([]);
        expect(world.sent).toEqual([]);
        expect(summary.skippedJobs).toEqual([{runId: 10, job: 'components', reason: 'already-filed'}]);
        // The receipt still advances: this host has read the run.
        expect(world.receipts[0].runIds).toEqual([10]);
    });

    test('a failed job without a Playwright epilogue files nothing; a receipted run is not re-read (AC-5)', async () => {
        const world = harness({
            runs     : [run(10, {createdAt: '2026-09-05T01:00:00Z', path: '.github/workflows/file-size-guard.yml'}), run(11, {createdAt: '2026-09-05T01:30:00Z'})],
            jobsByRun: {10: [job(100, 'guard', 'failure')], 11: [job(110, 'components', 'failure')]},
            logsByJob: {100: NON_PLAYWRIGHT_LOG, 110: playwrightLog()}
        });

        const summary = await runIngest({...world, repoSlug: 'neomjs/neo', receipt: {version: 1, lastCreatedAt: '2026-09-05T01:00:00Z', runIds: [11]}, now: Date.parse('2026-09-05T02:00:00Z'), log: () => {}});

        expect(world.logFetches).toEqual([100]);
        expect(world.sent).toEqual([]);
        expect(summary.skippedJobs).toEqual([{runId: 10, job: 'guard', reason: 'no-playwright-epilogue'}]);
        expect(summary.runsRead).toBe(1);
    });

    test('dry run reads everything, sends nothing, writes no receipt', async () => {
        const world = harness({
            runs     : [run(10, {createdAt: '2026-09-05T01:00:00Z'})],
            jobsByRun: {10: [job(101, 'components', 'failure')]},
            logsByJob: {101: playwrightLog()}
        });

        const summary = await runIngest({...world, repoSlug: 'neomjs/neo', receipt: {version: 1, lastCreatedAt: null, runIds: []}, now: Date.parse('2026-09-05T02:00:00Z'), dryRun: true, log: () => {}});

        expect(summary.notes).toHaveLength(1);
        expect(world.sent).toEqual([]);
        expect(world.receipts).toEqual([]);
    });

    test('a red run followed by a green run of the same job files the sighting, and the recovery only once the record has been quiet (AC-4)', async () => {
        const world = harness({
            runs     : [run(10, {createdAt: '2026-09-05T01:00:00Z'}), {...run(12, {createdAt: '2026-09-05T01:40:00Z'}), conclusion: 'success'}],
            jobsByRun: {10: [job(101, 'components', 'failure')], 12: [job(121, 'components', 'success')]},
            logsByJob: {101: playwrightLog()}
        });

        // Under the default day-long window the green run an hour later recovers nothing: this
        // tick's own sighting is fresh, and a flake that just passed is still a flake.
        const fresh = await runIngest({...world, repoSlug: 'neomjs/neo', receipt: {version: 1, lastCreatedAt: null, runIds: []}, now: Date.parse('2026-09-05T02:00:00Z'), log: () => {}});

        expect(world.sent).toHaveLength(1);
        expect(fresh.recoveries).toEqual([]);

        // With a window this tick already exceeds, the same green run is the recovery.
        const quick = harness({
            runs     : [run(10, {createdAt: '2026-09-05T01:00:00Z'}), {...run(12, {createdAt: '2026-09-05T01:40:00Z'}), conclusion: 'success'}],
            jobsByRun: {10: [job(101, 'components', 'failure')], 12: [job(121, 'components', 'success')]},
            logsByJob: {101: playwrightLog()}
        });
        const summary = await runIngest({...quick, repoSlug: 'neomjs/neo', receipt: {version: 1, lastCreatedAt: null, runIds: []}, now: Date.parse('2026-09-05T02:00:00Z'), recoveryAfterMs: 0, log: () => {}});

        expect(quick.sent).toHaveLength(2);
        expect(quick.sent[0].subject.startsWith('defect-note: test/playwright/component/tab/OverflowAction.spec.mjs')).toBe(true);
        expect(quick.sent[1].subject.startsWith('defect-note: [recovered] test/playwright/component/tab/OverflowAction.spec.mjs')).toBe(true);
        expect(quick.sent[1].partOfThread).toBe('ci:.github%2Fworkflows%2Ftest.yml:components:12');
        expect(summary.recoveries[0].fingerprint).toBe(summary.notes[0].fingerprint);

        // A green job whose suite was skipped is not evidence: same world, step skipped.
        const skipped = harness({
            runs     : [run(10, {createdAt: '2026-09-05T01:00:00Z'}), {...run(12, {createdAt: '2026-09-05T01:40:00Z'}), conclusion: 'success'}],
            jobsByRun: {10: [job(101, 'components', 'failure')], 12: [job(121, 'components', 'success', 'skipped')]},
            logsByJob: {101: playwrightLog()}
        });
        await runIngest({...skipped, repoSlug: 'neomjs/neo', receipt: {version: 1, lastCreatedAt: null, runIds: []}, now: Date.parse('2026-09-05T02:00:00Z'), recoveryAfterMs: 0, log: () => {}});
        expect(skipped.sent).toHaveLength(1);
    });
});

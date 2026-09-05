import {test, expect} from '@playwright/test';
import {
    buildCiThreadId,
    buildDefectNotes,
    buildSurface,
    isCanonicalNote,
    isSuiteRunGreen,
    normalizeSymptom,
    parseCiThreadId,
    parsePlaywrightFailures,
    selectRecoveries
} from '../../../../../../ai/services/ingestion/CiFailureIngestor.mjs';
import {
    defectNoteFingerprint,
    foldDefectObservations,
    parseDefectNote
} from '../../../../../../ai/services/memory-core/helpers/defectObservationFold.mjs';
import {independentSecondOccurrence} from '../../../../../../ai/services/memory-core/helpers/defectObservationTriggers.mjs';

// Pure module — no fetch, no mailbox, no clock. Every note is asserted against the REAL fold and
// grammar, never a copy: the producer's contract is that the ledger accepts what it emits.

const OVERFLOW_TITLE = 'Neo.tab.plugin.Overflow — toolbar action projection › renders first, outside focus gating, with measured non-overlap and ordinary menu activation';

// Verbatim from the `components` job of neomjs/neo run 33934522638 (the `list` reporter): one
// failure, the numbered block, the epilogue.
const COMPONENTS_LOG = [
    '2026-09-05T01:00:51.1405342Z   ✓  241 [chromium] › test/playwright/component/tooltip/ThemeProjection.spec.mjs:50:5 › Neo.tooltip.Base — a theme-root projection outranks the engine value sheet › control: a token the host does not project still comes from the engine sheet (738ms)',
    '2026-09-05T01:00:51.2094500Z ',
    `2026-09-05T01:00:51.2109221Z   1) [chromium] › test/playwright/component/tab/OverflowAction.spec.mjs:134:5 › ${OVERFLOW_TITLE} `,
    '2026-09-05T01:00:51.2110458Z ',
    '2026-09-05T01:00:51.2110682Z     Test timeout of 30000ms exceeded.',
    '2026-09-05T01:00:51.2110971Z ',
    '2026-09-05T01:00:51.2111226Z     Error: locator.click: Test timeout of 30000ms exceeded.',
    '2026-09-05T01:00:51.2111650Z     Call log:',
    "2026-09-05T01:00:51.2112172Z       - waiting for locator('.neo-tab-overflow-menu:visible .neo-list-item').first()",
    '2026-09-05T01:00:51.2122691Z       - element was detached from the DOM, retrying',
    '2026-09-05T01:00:51.2128997Z     > 173 |         await menuItem.click();',
    '2026-09-05T01:00:51.2132714Z         at /home/runner/work/neo/neo/test/playwright/component/tab/OverflowAction.spec.mjs:173:24',
    '2026-09-05T01:00:51.2133232Z ',
    '2026-09-05T01:00:51.2134010Z     Error Context: test/playwright/test-results/component/tab-OverflowAction-Neo-tab-5fa2a-nd-ordinary-menu-activation-chromium/error-context.md',
    '2026-09-05T01:00:51.2134827Z ',
    '2026-09-05T01:00:51.2134944Z   1 failed',
    `2026-09-05T01:00:51.2136612Z     [chromium] › test/playwright/component/tab/OverflowAction.spec.mjs:134:5 › ${OVERFLOW_TITLE} `,
    '2026-09-05T01:00:51.2137806Z   240 passed (5.1m)',
    '2026-09-05T01:00:51.2283891Z ##[error]Process completed with exit code 1.'
].join('\n');

const DRAG_SUITE = 'Neo.manager.DragCoordinator — the §2.8.1 claim protocol';
const DRAG_A     = 'the winning claimant departing mid-gesture hands over deterministically: leave, then the successor previews';
const DRAG_B     = 'conversion resolver receives one live INNER-viewport frame';
const DRAG_C     = 'THE OVERLAP FALSIFIER: three overlapping windows, one gesture → exactly ONE preview and exactly ONE commit';

// The `github` reporter of the `unit` job of run 33887831112: `::error` annotations, `##[error]`
// block headers whose continuation lines carry no timestamp, retry blocks, then the same epilogue.
// Three failing tests, one of which (C) has no block at all — a truncated read.
const UNIT_LOG = [
    `2026-09-04T15:10:59.2214461Z ···×··×····································F::error file=test/playwright/unit/manager/DragCoordinator.spec.mjs,title=[unit-engine] › test/playwright/unit/manager/DragCoordinator.spec.mjs:979:5 › ${DRAG_SUITE} › ${DRAG_A},line=1000,col=79::Error: expect(received).toEqual(expected) // deep equality`,
    `2026-09-04T15:10:59.2267203Z ##[error]  1) [unit-engine] › test/playwright/unit/manager/DragCoordinator.spec.mjs:979:5 › ${DRAG_SUITE} › ${DRAG_A} `,
    '',
    '    Retry #1 ───────────────────────────────────────────────────────────────────────────────────────',
    '    Error: expect(received).toEqual(expected) // deep equality',
    '',
    '    - Expected  - 18',
    '    + Received  +  1',
    '        at /home/runner/work/neo/neo/test/playwright/unit/manager/DragCoordinator.spec.mjs:1000:79',
    `2026-09-04T15:10:59.2299450Z ##[error]  1) [unit-engine] › test/playwright/unit/manager/DragCoordinator.spec.mjs:979:5 › ${DRAG_SUITE} › ${DRAG_A} `,
    '',
    '    Retry #2 ───────────────────────────────────────────────────────────────────────────────────────',
    '    Error: expect(received).toEqual(expected) // deep equality',
    `2026-09-04T15:11:03.9261414Z ##[error]  2) [unit-engine] › test/playwright/unit/manager/DragCoordinator.spec.mjs:2082:5 › ${DRAG_SUITE} › ${DRAG_B} `,
    '',
    '    Error: expect(received).toMatchObject(expected)',
    '',
    '    - Expected  - 2',
    '    + Received  +  2',
    '2026-09-04T15:11:26.6169837Z   19 failed',
    `2026-09-04T15:11:26.6171145Z     [unit-engine] › test/playwright/unit/manager/DragCoordinator.spec.mjs:635:5 › ${DRAG_SUITE} › ${DRAG_C} `,
    `2026-09-04T15:11:26.6172184Z     [unit-engine] › test/playwright/unit/manager/DragCoordinator.spec.mjs:979:5 › ${DRAG_SUITE} › ${DRAG_A} `,
    `2026-09-04T15:11:26.6173351Z     [unit-engine] › test/playwright/unit/manager/DragCoordinator.spec.mjs:2082:5 › ${DRAG_SUITE} › ${DRAG_B} `,
    '2026-09-04T15:11:26.6190705Z   29 skipped',
    '2026-09-04T15:11:26.6190805Z   3158 passed (1.4m)',
    '2026-09-04T15:11:26.6456550Z ##[error]Process completed with exit code 1.'
].join('\n');

const RUN = {
    id        : 33934522638,
    name      : 'Engine Tests',
    path      : '.github/workflows/test.yml',
    event     : 'push',
    headBranch: 'dev',
    headSha   : '4f5e6d7c8b9a',
    htmlUrl   : 'https://github.com/neomjs/neo/actions/runs/33934522638'
};

const JOB = {id: 101219787939, name: 'components', htmlUrl: 'https://github.com/neomjs/neo/actions/runs/33934522638/job/101219787939'};

test.describe('CiFailureIngestor — the defect ledger\'s machine producer', () => {
    test('the list reporter: one failing test → one note the shipped grammar parses back exactly', () => {
        const failures = parsePlaywrightFailures(COMPONENTS_LOG);

        expect(failures).toEqual([expect.objectContaining({
            project  : 'chromium',
            file     : 'test/playwright/component/tab/OverflowAction.spec.mjs',
            line     : 134,
            column   : 5,
            titlePath: ['Neo.tab.plugin.Overflow — toolbar action projection', 'renders first, outside focus gating, with measured non-overlap and ordinary menu activation'],
            symptom  : 'locator.click: Test timeout of 30000ms exceeded.'
        })]);
        // The block's detail is bounded and starts at the failure, not at the progress line above it.
        expect(failures[0].detail[0]).toBe('Test timeout of 30000ms exceeded.');
        expect(failures[0].detail.length).toBeLessThanOrEqual(12);

        const {notes, skipped} = buildDefectNotes({failures, run: RUN, job: JOB, repoSlug: 'neomjs/neo'});

        expect(skipped).toEqual([]);
        expect(notes).toHaveLength(1);

        const [note] = notes,
              parsed = parseDefectNote(note.subject);

        expect(note.subject).toBe(`defect-note: test/playwright/component/tab/OverflowAction.spec.mjs › ${OVERFLOW_TITLE} broke locator.click: Test timeout of 30000ms exceeded.`);
        expect(parsed).toEqual({
            parseable: true,
            recovered: false,
            surface  : `test/playwright/component/tab/OverflowAction.spec.mjs › ${OVERFLOW_TITLE}`,
            symptom  : 'locator.click: Test timeout of 30000ms exceeded.'
        });
        expect(note.fingerprint).toBe(defectNoteFingerprint(note.subject));
        expect(note.partOfThread).toBe('ci:.github%2Fworkflows%2Ftest.yml:components:33934522638');
        expect(isCanonicalNote(note.subject)).toBe(true);
        // Provenance rides the body; the fold never reads it.
        expect(note.body).toContain('https://github.com/neomjs/neo/actions/runs/33934522638');
        expect(note.body).toContain('`test/playwright/component/tab/OverflowAction.spec.mjs:134:5`');
    });

    test('the github reporter: N failing tests → N notes with N fingerprints; a test without a block is skipped, never invented (AC-1, AC-5)', () => {
        const failures = parsePlaywrightFailures(UNIT_LOG);

        expect(failures.map(failure => [failure.line, failure.symptom])).toEqual([
            [635,  null],
            [979,  'expect(received).toEqual(expected) // deep equality'],
            [2082, 'expect(received).toMatchObject(expected)']
        ]);

        const run              = {...RUN, id: 33887831112, path: '.github/workflows/test.yml'},
              job              = {id: 101072030779, name: 'unit'},
              {notes, skipped} = buildDefectNotes({failures, run, job, repoSlug: 'neomjs/neo'});

        expect(skipped).toEqual([{file: 'test/playwright/unit/manager/DragCoordinator.spec.mjs', line: 635, reason: 'no-error-line'}]);
        expect(notes).toHaveLength(2);
        expect(new Set(notes.map(note => note.fingerprint)).size).toBe(2);
        expect(notes.every(note => isCanonicalNote(note.subject))).toBe(true);
        expect(notes.every(note => note.partOfThread === 'ci:.github%2Fworkflows%2Ftest.yml:unit:33887831112')).toBe(true);
        // The retry echo of test A is one block: its first `Error:` line, not the `Retry #1` rule.
        expect(notes[0].symptom).toBe('expect(received).toEqual(expected) // deep equality');
    });

    test('an unparsable or truncated log yields zero notes (AC-5)', () => {
        expect(parsePlaywrightFailures('')).toEqual([]);
        expect(parsePlaywrightFailures(null)).toEqual([]);
        expect(parsePlaywrightFailures('2026-09-05T01:00:00.0000000Z ##[group]Run node buildScripts/util/check-file-sizes.mjs\n2026-09-05T01:00:01.0000000Z FAIL over-target 1284 code\n2026-09-05T01:00:01.0000000Z ##[error]Process completed with exit code 1.')).toEqual([]);
        // Truncated before the epilogue: the ✘ progress line and the block are echoes, not the set.
        const truncated = COMPONENTS_LOG.split('\n').slice(0, 12).join('\n');
        expect(parsePlaywrightFailures(truncated)).toEqual([]);
        expect(buildDefectNotes({failures: parsePlaywrightFailures(truncated), run: RUN, job: JOB, repoSlug: 'neomjs/neo'}).notes).toEqual([]);
    });

    test('the same test failing in two runs folds to ONE record with two independent sightings (AC-2)', () => {
        const first  = buildDefectNotes({failures: parsePlaywrightFailures(COMPONENTS_LOG), run: RUN, job: JOB, repoSlug: 'neomjs/neo'}).notes[0],
              second = buildDefectNotes({
                  failures: parsePlaywrightFailures(COMPONENTS_LOG.replaceAll('2026-09-05T01:00:51', '2026-09-05T03:10:00')),
                  run     : {...RUN, id: 33940000000, headSha: 'abcdef012345'},
                  job     : {...JOB, id: 101300000000},
                  repoSlug: 'neomjs/neo'
              }).notes[0];

        const records = foldDefectObservations([
            {from: '@neo-fable', sentAt: '2026-09-05T01:05:00Z', subject: first.subject,  partOfThread: first.partOfThread},
            {from: '@neo-fable', sentAt: '2026-09-05T03:15:00Z', subject: second.subject, partOfThread: second.partOfThread}
        ], {now: Date.parse('2026-09-05T04:00:00Z')});

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            count    : 2,
            reporters: ['@neo-fable'],
            threads  : [first.partOfThread, second.partOfThread],
            state    : 'red'
        });
        // One identity, two runs: the trigger reads the threads, so the record qualifies.
        expect(independentSecondOccurrence(records[0])).toBe(true);
    });

    test('a green run of the same job recovers a record that has been quiet for the window; a fresh flake, a skipped suite, an older run, or another job does not (AC-4)', () => {
        const DAY  = 24 * 60 * 60 * 1000,
              note = buildDefectNotes({failures: parsePlaywrightFailures(COMPONENTS_LOG), run: RUN, job: JOB, repoSlug: 'neomjs/neo'}).notes[0],
              rows = [
                  {from: '@neo-fable', sentAt: '2026-09-05T01:05:00Z', subject: note.subject, partOfThread: note.partOfThread},
                  {from: '@tobiu',     sentAt: '2026-09-05T01:06:00Z', subject: 'defect-note: hand-filed surface broke something CI never saw'}
              ],
              greenComponents = {workflowPath: '.github/workflows/test.yml', jobName: 'components', runId: 33940000000},
              olderComponents = {workflowPath: '.github/workflows/test.yml', jobName: 'components', runId: 33900000000},
              greenUnit       = {workflowPath: '.github/workflows/test.yml', jobName: 'unit',       runId: 33950000000};

        // Three hours after the sighting the suite is green — that is a flake passing, not a fix.
        const fresh = foldDefectObservations(rows, {now: Date.parse('2026-09-05T04:00:00Z')});
        expect(selectRecoveries({records: fresh, greenJobs: [greenComponents], now: Date.parse('2026-09-05T04:00:00Z'), recoveryAfterMs: DAY})).toEqual([]);

        // A day without a sighting, and green since: recovered — by the newest green run of ITS job.
        const later    = Date.parse('2026-09-06T02:00:00Z'),
              quietDay = foldDefectObservations(rows, {now: later});

        expect(selectRecoveries({records: quietDay, greenJobs: [olderComponents, greenUnit], now: later, recoveryAfterMs: DAY})).toEqual([]);

        const recoveries = selectRecoveries({records: quietDay, greenJobs: [olderComponents, greenUnit, greenComponents], now: later, recoveryAfterMs: DAY});

        expect(recoveries).toHaveLength(1);
        expect(recoveries[0].subject).toBe(note.subject.replace('defect-note: ', 'defect-note: [recovered] '));
        // The recovery keys to the SAME observation the fold already holds.
        expect(recoveries[0].fingerprint).toBe(note.fingerprint);
        expect(recoveries[0].partOfThread).toBe('ci:.github%2Fworkflows%2Ftest.yml:components:33940000000');

        const afterRecovery = foldDefectObservations([
            ...rows,
            {from: '@neo-fable', sentAt: '2026-09-06T02:05:00Z', subject: recoveries[0].subject, partOfThread: recoveries[0].partOfThread}
        ], {now: Date.parse('2026-09-07T05:00:00Z')});

        expect(afterRecovery[0].state).toBe('recovered');
        // Recovered is terminal for this producer until a fresh sighting — nothing to re-emit.
        expect(selectRecoveries({records: afterRecovery, greenJobs: [greenComponents], now: Date.parse('2026-09-07T05:00:00Z'), recoveryAfterMs: DAY})).toEqual([]);
        expect(() => selectRecoveries({records: afterRecovery, greenJobs: [], now: NaN, recoveryAfterMs: DAY})).toThrow(/now/);

        // The evidence rule: success with the suite step run, never a skipped suite's no-op success.
        expect(isSuiteRunGreen({conclusion: 'success', steps: [{name: 'Skip components tests', conclusion: 'skipped'}, {name: 'Run components tests', conclusion: 'success'}]})).toBe(true);
        expect(isSuiteRunGreen({conclusion: 'success', steps: [{name: 'Skip components tests', conclusion: 'success'}, {name: 'Run components tests', conclusion: 'skipped'}]})).toBe(false);
        expect(isSuiteRunGreen({conclusion: 'failure', steps: [{name: 'Run components tests', conclusion: 'failure'}]})).toBe(false);
        expect(isSuiteRunGreen(null)).toBe(false);
    });

    test('the thread id round-trips through the fold\'s summary projection and encodes its separators', () => {
        const thread = buildCiThreadId({workflowPath: '.github/workflows/test.yml', jobName: 'unit: engine', runId: 42});

        expect(thread).toBe('ci:.github%2Fworkflows%2Ftest.yml:unit%3A%20engine:42');
        expect(parseCiThreadId(thread)).toEqual({workflowPath: '.github/workflows/test.yml', jobName: 'unit: engine', runId: 42});
        expect(parseCiThreadId('lane-claim-18306')).toBeNull();
        expect(parseCiThreadId('ci:wf:job:notarun')).toBeNull();
        expect(parseCiThreadId(null)).toBeNull();
    });

    test('a title containing the grammar\'s own split word still yields one deterministic, parseable note', () => {
        const failure = {
            project  : 'chromium', file: 'test/playwright/component/x.spec.mjs', line: 10, column: 5,
            titlePath: ['a pane that broke its host recovers'], symptom: 'expect(received).toBe(expected)', detail: []
        };
        const {notes} = buildDefectNotes({failures: [failure, failure], run: RUN, job: JOB, repoSlug: 'neomjs/neo'});

        expect(notes).toHaveLength(1); // duplicate fingerprints within one job collapse
        expect(isCanonicalNote(notes[0].subject)).toBe(true);
        expect(defectNoteFingerprint(notes[0].subject)).toBe(notes[0].fingerprint);
        expect(buildSurface(failure)).toBe('test/playwright/component/x.spec.mjs › a pane that broke its host recovers');
    });

    test('symptoms are one bounded line; the fold keeps the numbers that ARE the symptom', () => {
        expect(normalizeSymptom('  locator.click:   Test timeout of 30000ms\n exceeded.  ')).toBe('locator.click: Test timeout of 30000ms exceeded.');

        const long = normalizeSymptom(`expect(received).toEqual(expected) ${'word '.repeat(60)}`);
        expect(long.length).toBeLessThanOrEqual(160);
        expect(long.endsWith('word')).toBe(true);

        // 30000 vs 60000 are different configurations, hence different observations — by design.
        expect(defectNoteFingerprint('defect-note: a › b broke Test timeout of 30000ms exceeded.'))
            .not.toBe(defectNoteFingerprint('defect-note: a › b broke Test timeout of 60000ms exceeded.'));
    });
});

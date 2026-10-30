import fs              from 'node:fs';
import path            from 'node:path';
import {parseArgs}     from 'node:util';
import {isEntryModule} from '../../ai/services/shared/isEntryModule.mjs';

const ANSI_PATTERN  = /\x1b\[[0-9;]*[A-Za-z]/g;
const MESSAGE_LINES = 8;

/**
 * @summary Compares two Playwright JSON reports of the unit config — a change's head and its base —
 * and fails only on the tests the head breaks.
 *
 * Both reports come from the same CI image in the same run, so a red that depends on the host shows
 * on both sides and cancels, and a red the base already carries stays visible without blocking. No
 * baseline is committed: the base's set is measured on every run, so it cannot go stale.
 *
 * A test is keyed by project, testDir-relative file and title path, never by line: a line shift
 * inside a failing spec is not a new failure, and a renamed failing test reads as one fixed and one
 * introduced. A top-level error (a spec that fails to load, a crashed global setup) is keyed by its
 * first message line and diffed the same way.
 *
 * The introduced tests are printed in the reporter's failure grammar — a numbered block per test
 * carrying its error, then the `N failed` epilogue — because the defect ledger's CI ingest
 * (`ai/services/ingestion/CiFailureIngestor.mjs`) reads that grammar from a failed job's log. The
 * suite jobs conclude green, so the ledger hears only about the tests a change introduced.
 *
 * Usage: `node test/playwright/compareUnitFailures.mjs --head <report.json> --base <report.json>`
 *
 * @module test/playwright/compareUnitFailures
 */

/**
 * @summary Reads one side's report.
 * @param {String} side     `head` or `base`, named in a refusal
 * @param {String} filePath
 * @returns {Object} The parsed Playwright JSON report
 * @throws {Error} When the file is missing or is not JSON
 */
export function readReport(side, filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch (error) {
        throw new Error(`the ${side} report cannot be read (${error.code || error.name}): ${filePath}`)
    }
}

/**
 * @summary Folds one report into its failing tests and its outcome counts.
 *
 * A test fails when its final status is `unexpected` or `flaky`: the unit config sets
 * `failOnFlakyTests` in CI, so a pass that needed a retry disqualifies the run there, and it does
 * here. A test with no result never ran: the run ended before reaching it, and its status says
 * nothing about it. A failure's message is its first error's, or the value a test threw that was no
 * error. Printed paths are relative to `repoRoot`, the form the reporter prints and the ledger
 * fingerprints.
 *
 * @param {Object} report   A Playwright JSON report
 * @param {String} side     `head` or `base`, named in a refusal
 * @param {String} repoRoot The checkout printed paths are relative to
 * @returns {{failures: Map<String, Object>, counts: Object, unrun: Set<String>}} Failures keyed by
 *          test identity, and the identities of the tests that never ran
 * @throws {Error} When the report recorded no test result, whatever tests it lists
 */
export function summarizeReport(report, side, repoRoot = process.cwd()) {
    const counts   = {expected: 0, unexpected: 0, flaky: 0, skipped: 0},
          failures = new Map(),
          unrun    = new Set(),
          rootDir  = report?.config?.rootDir ?? repoRoot;

    let recorded = 0;

    function visit(suite, titles) {
        for (const spec of suite.specs ?? []) {
            for (const test of spec.tests ?? []) {
                const titlePath = [...titles, spec.title],
                      project   = test.projectName ?? '',
                      key       = `${project} › ${spec.file} › ${titlePath.join(' › ')}`,
                      error     = test.results?.find(result => result.error)?.error;

                counts[test.status] = (counts[test.status] ?? 0) + 1;
                test.results?.length ? recorded++ : unrun.add(key);

                if (test.status === 'unexpected' || test.status === 'flaky') {
                    failures.set(key, {
                        project,
                        file   : path.relative(repoRoot, path.resolve(rootDir, spec.file)),
                        line   : spec.line,
                        column : spec.column,
                        titlePath,
                        message: clean(error?.message ?? error?.value)
                    })
                }
            }
        }

        for (const child of suite.suites ?? []) visit(child, [...titles, child.title])
    }

    for (const fileSuite of report?.suites ?? []) visit(fileSuite, []);

    for (const error of report?.errors ?? []) {
        const message = clean(error.message ?? error.value),
              first   = message.split('\n').find(line => line.trim())?.trim() || 'unknown error';

        failures.set(`global › ${first}`, {global: true, message: first})
    }

    if (!recorded) {
        throw new Error(`the ${side} report recorded no test result`)
    }

    return {failures, counts, unrun}
}

/**
 * @summary The tests the head never ran although the base did: a head run cut short can vouch for
 * none of them, so any such test refuses the comparison.
 * @param {Object} head {@link summarizeReport} of the head
 * @param {Object} base {@link summarizeReport} of the base
 * @returns {String[]} Sorted test identities
 */
export function cutShort(head, base) {
    return [...head.unrun].filter(key => !base.unrun.has(key)).sort()
}

/**
 * @summary Splits two failing sets into what the head introduced, fixed and kept.
 * @param {Map<String, Object>} head
 * @param {Map<String, Object>} base
 * @returns {{introduced: String[], fixed: String[], preexisting: String[]}} Sorted test identities
 */
export function diffFailures(head, base) {
    const introduced  = [...head.keys()].filter(key => !base.has(key)).sort(),
          fixed       = [...base.keys()].filter(key => !head.has(key)).sort(),
          preexisting = [...head.keys()].filter(key => base.has(key)).sort();

    return {introduced, fixed, preexisting}
}

/**
 * @summary Prints failures in the reporter's failure grammar: a numbered block per test with its
 * error, then the `N failed` epilogue naming each test once. A top-level error has no location, so
 * it is printed as a plain line before the blocks and stays out of the epilogue.
 *
 * The ledger keys a note on the first `Error:` line of a block, so each block opens with one: a
 * typed error, a timeout or a thrown value is prefixed, and a failure the report records no error
 * for says so. No introduced test is dropped for want of a symptom.
 * @param {Object[]} failures Values of {@link summarizeReport}'s map
 * @returns {String}
 */
export function formatFailureLog(failures) {
    const located = failures.filter(failure => !failure.global),
          lines   = failures.filter(failure => failure.global).map(failure => `  top-level error: ${failure.message}`),
          header  = failure => `[${failure.project}] › ${failure.file}:${failure.line}:${failure.column} › ${failure.titlePath.join(' › ')}`;

    located.forEach((failure, index) => {
        const message = failure.message.split('\n'),
              first   = message.findIndex(line => line.trim()),
              error   = first < 0
                  ? ['Error: the report records no error for this test']
                  : [/^\s*Error: /.test(message[first]) ? message[first] : `Error: ${message[first].trim()}`, ...message.slice(first + 1)];

        lines.push('', `  ${index + 1}) ${header(failure)}`, '');

        for (const line of error.slice(0, MESSAGE_LINES)) {
            lines.push(`    ${line}`.trimEnd())
        }
    });

    if (located.length) {
        lines.push('', `  ${located.length} failed`, ...located.map(failure => `    ${header(failure)}`))
    }

    return lines.join('\n')
}

/**
 * @summary The job summary: outcome counts per side, then the introduced, fixed and pre-existing
 * tests.
 * @param {Object} options
 * @param {Object} options.head {@link summarizeReport} of the head
 * @param {Object} options.base {@link summarizeReport} of the base
 * @param {Object} options.diff {@link diffFailures} of the two
 * @returns {String} Markdown
 */
export function formatSummary({head, base, diff}) {
    const row   = (label, key) => `| ${label} | ${head.counts[key] ?? 0} | ${base.counts[key] ?? 0} |`,
          group = (label, keys) => keys.length
              ? [`<details><summary>${label} (${keys.length})</summary>`, '', ...keys.map(key => `- \`${key}\``), '', '</details>', '']
              : [];

    return [
        '### Brain unit: the change against its base',
        '',
        '| | head | base |',
        '|---|---|---|',
        row('passed', 'expected'),
        row('failed', 'unexpected'),
        row('flaky', 'flaky'),
        row('skipped', 'skipped'),
        '',
        `**Introduced: ${diff.introduced.length}** · fixed: ${diff.fixed.length} · pre-existing: ${diff.preexisting.length}`,
        '',
        ...group('Introduced', diff.introduced),
        ...group('Fixed', diff.fixed),
        ...group('Pre-existing', diff.preexisting)
    ].join('\n')
}

/**
 * @summary Compares the two reports, prints the introduced failures in the reporter's grammar, and
 * appends the summary to `GITHUB_STEP_SUMMARY` when the runner provides one.
 * @param {String[]} argv
 * @param {Object}   env
 * @returns {Number} 1 on an introduced failure, an unreadable side, a side that recorded no result or
 *          a head run cut short, else 0
 */
export function main(argv = process.argv.slice(2), env = process.env) {
    try {
        const {values} = parseArgs({args: argv, options: {head: {type: 'string'}, base: {type: 'string'}}});

        if (!values.head || !values.base) throw new Error('both --head and --base are required');

        const head    = summarizeReport(readReport('head', values.head), 'head'),
              base    = summarizeReport(readReport('base', values.base), 'base'),
              missing = cutShort(head, base);

        if (missing.length) {
            throw new Error(`the head run never reached ${missing.length} test(s) the base ran, so it vouches for none of them: ${missing.slice(0, 5).join('; ')}`)
        }

        const diff    = diffFailures(head.failures, base.failures),
              summary = formatSummary({head, base, diff});

        env.GITHUB_STEP_SUMMARY && fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);

        if (diff.introduced.length) {
            console.log(formatFailureLog(diff.introduced.map(key => head.failures.get(key))))
        }

        console.log(`compareUnitFailures: ${diff.introduced.length} introduced, ${diff.fixed.length} fixed, ${diff.preexisting.length} pre-existing`);

        return diff.introduced.length ? 1 : 0
    } catch (error) {
        console.error(`compareUnitFailures: ${error.message}`);
        env.GITHUB_STEP_SUMMARY && fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `### Brain unit: not compared\n\n${error.message}\n`);

        return 1
    }
}

/** @summary Strips ANSI colour from reporter text. @private */
function clean(text) {
    return String(text ?? '').replace(ANSI_PATTERN, '')
}

if (isEntryModule(import.meta.url)) {
    process.exitCode = main()
}

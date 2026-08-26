import './configTemplateResolver.mjs';

import {defineConfig} from '@playwright/test';
import path           from 'path';
import {fileURLToPath} from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

process.env.UNIT_TEST_MODE = 'true';

// Retry backoff bases resolve to 1ms for the whole unit run. These belong here rather than in a
// leaf: a `process.env.UNIT_TEST_MODE ? 1 : 1000` branch inside the leaf bakes imperative
// env-resolution into the declarative config SSOT, and a per-spec write mutates a singleton every
// other spec shares. The env layer is the sanctioned seam. A spec that genuinely tests timing sets
// its own values and says so.
process.env.NEO_KB_EMBEDDING_BACKOFF_BASE_MS = '1';

/**
 * @summary Host-Edge unit run.
 *
 * The source repository needed a `brainTestMatch` regex to separate Brain specs from Body specs
 * because both lived in one tree, plus a `hasBrainTier` probe because the Brain's drivers were an
 * opt-in install tier that could be present, absent, or a partial husk.
 *
 * Neither survives the split, and that is the topology paying for itself rather than a shortcut.
 * The planes ARE the seam now: everything under this root is Host-Edge by construction, and the
 * Cloud drivers are not merely un-installed here — they are undeclared, so no probe could arm them
 * and none is needed. Cloud specs run from `cloud/`, against `cloud/package.json`'s own
 * dependencies, by their own config.
 *
 * A path-matched project list would reintroduce exactly the filename allow-list the plane boundary
 * removed.
 */
export function buildUnitRunPolicy({isCI}) {
    const reporter = [['json', {outputFile: path.join(__dirname, 'test-results/unit/test-results.json')}]];

    isCI && reporter.unshift(['github']);

    return {
        failOnFlakyTests: isCI,
        forbidOnly      : isCI,
        reporter,
        // A retry-pass is disqualifying in CI; the retry count and worker count are a held pair, so
        // changing either alone moves the experiment instead of the result.
        retries: isCI ? 2 : 0,
        workers: isCI ? 4 : undefined
    }
}

const isCI = !!process.env.CI;

export default defineConfig({
    testDir      : path.join(__dirname, 'unit'),
    outputDir    : path.join(__dirname, 'test-results/unit'),
    fullyParallel: true,
    ...buildUnitRunPolicy({isCI}),
    use     : {trace: 'on-first-retry'},
    projects: [{name: 'unit'}]
});

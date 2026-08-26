import './configTemplateResolver.mjs';

import {defineConfig}   from '@playwright/test';
import path             from 'path';
import {fileURLToPath}  from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

process.env.UNIT_TEST_MODE = 'true';
process.env.NEO_KB_EMBEDDING_BACKOFF_BASE_MS = '1';

/**
 * @summary Cloud unit run, executed from the independently installed nested package.
 *
 * The drivers this suite needs — chromadb, better-sqlite3, @chroma-core/default-embed — are
 * DECLARED dependencies of `cloud/package.json` rather than an opt-in tier, so the source
 * repository's `hasBrainTier` probe and its `assertBrainTierForEnvironment` gate are both gone.
 * Their job was to distinguish "installed", "absent", and "present but a husk" for a set that a
 * plain `npm install` would prune; here `npm ci` in this package either produces them or fails,
 * and a suite that cannot resolve its own declared dependency fails loudly at collection.
 *
 * Deleting a gate is worth stating rather than doing quietly: it goes because the condition it
 * detected cannot arise in this package, not because the check was inconvenient. If Cloud drivers
 * ever become optional here, the probe comes back with them.
 *
 * The destructive namespace-isolation specs keep their own project realms. That fragility is not
 * about planes and did not move: those specs unregister and re-register runtime namespaces, and a
 * reused worker cannot replay an already-cached template module after its namespace is deleted.
 */
export const orchestratorDaemonTestMatch = /[\\/]daemons[\\/]orchestrator[\\/]daemon\.spec\.mjs$/;
export const tier1ConfigTemplateTestMatch = /[\\/]config\.template\.spec\.mjs$/;
export const knowledgeBaseConfigTemplateTestMatch =
    /[\\/]mcp[\\/]server[\\/]knowledge-base[\\/]config\.template\.spec\.mjs$/;
export const memoryCoreConfigTemplateTestMatch =
    /[\\/]mcp[\\/]server[\\/]memory-core[\\/]config\.template\.spec\.mjs$/;

export function buildUnitRunPolicy({isCI}) {
    const reporter = [['json', {outputFile: path.join(__dirname, 'test-results/unit/test-results.json')}]];

    isCI && reporter.unshift(['github']);

    return {
        failOnFlakyTests: isCI,
        forbidOnly      : isCI,
        reporter,
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
    projects: [{
        name     : 'chroma-setup',
        testMatch: /chroma\.setup\.mjs$/,
        teardown : 'chroma-teardown'
    }, {
        name     : 'chroma-teardown',
        testMatch: /chroma\.teardown\.mjs$/
    }, {
        name        : 'unit-cloud',
        dependencies: ['chroma-setup'],
        testIgnore  : [
            /chroma\.(setup|teardown)\.mjs$/,
            orchestratorDaemonTestMatch,
            tier1ConfigTemplateTestMatch,
            knowledgeBaseConfigTemplateTestMatch,
            memoryCoreConfigTemplateTestMatch
        ]
    }, {
        name        : 'unit-cloud-orchestrator-daemon',
        dependencies: ['chroma-setup'],
        testMatch   : orchestratorDaemonTestMatch
    }, {
        name        : 'unit-cloud-tier1-config',
        dependencies: ['chroma-setup'],
        testMatch   : tier1ConfigTemplateTestMatch
    }, {
        name        : 'unit-cloud-knowledge-base-config',
        dependencies: ['chroma-setup'],
        testMatch   : knowledgeBaseConfigTemplateTestMatch
    }, {
        name        : 'unit-cloud-memory-core-config',
        dependencies: ['chroma-setup'],
        testMatch   : memoryCoreConfigTemplateTestMatch
    }]
});

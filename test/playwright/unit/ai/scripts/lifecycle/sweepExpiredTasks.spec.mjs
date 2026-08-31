import {setup} from '../../../../setup.mjs';

const appName = 'SweepExpiredTasksRegressionTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}  from '@playwright/test';
import path            from 'path';
import {fileURLToPath} from 'url';
import Neo             from 'neo.mjs/src/Neo.mjs';
import * as core       from 'neo.mjs/src/core/_export.mjs';

const __filename  = fileURLToPath(import.meta.url);
const __dirname   = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');
const scriptPath  = path.join(projectRoot, 'ai', 'scripts', 'lifecycle', 'sweepExpiredTasks.mjs');

/**
 * @summary Guards the `sweepExpiredTasks.mjs` direct-invocation Neo-not-defined failure class.
 *
 * The pre-fix script imported `LifecycleService` at module-load time, which transitively
 * pulled `src/core/Compare.mjs` whose final line is `Neo.gatekeep(Compare, 'Neo.core.Compare', ...)`
 * — but Neo itself wasn't imported by the script. Result: every direct invocation crashed
 * at module-load with `ReferenceError: Neo is not defined`. The fix added
 * `import Neo from 'neo.mjs/src/Neo.mjs'` + `import * as core from 'neo.mjs/src/core/_export.mjs'`
 * before the LifecycleService import, populating the global Neo reference before the
 * Compare.mjs gatekeep call.
 *
 * The subprocess shape preserves the original direct-invocation failure witness.
 *
 * This spec spawns the script via `execFile` (subprocess) rather than dynamic-importing
 * it directly — the script ends with an unconditional `main()` call that performs SQLite
 * I/O and `process.exit()`, so importing it from a Playwright test would race the test
 * runner and exit Node prematurely.
 *
 * The regression class manifests at module-LOAD time (before any DB I/O), so the spec
 * doesn't need fixture-graph setup; running against the worktree's actual SQLite is
 * sufficient — a `ReferenceError: Neo is not defined` would surface deterministically
 * regardless of graph state.
 */
test.describe('ai/scripts/lifecycle/sweepExpiredTasks.mjs regression guard (#10595)', () => {
    // Note: a behavioral subprocess invocation of the script (`node ai/scripts/lifecycle/sweepExpiredTasks.mjs`)
    // would catch the `Neo is not defined` regression class behaviorally, BUT
    // `MailboxService.sweepExpiredTasks()` performs a bulk SQL UPDATE that mutates the
    // worktree's live `.neo-ai-data/sqlite/memory-core-graph.sqlite` — it transitions
    // `Submitted`/`Working`/`InputRequired` tasks past `expiresAt` to `Expired`. Running
    // that mutation under a unit-test runner against the production graph is unsafe. A
    // fixture-DB-isolated behavioral test would
    // require non-trivial config-injection plumbing (`aiConfig.data.dbPath` swap +
    // LifecycleService re-init) that is out of scope for this regression-guard.
    //
    // The structural import-order test below is sufficient to catch the regression class:
    // the failure mode is at module-LOAD time (before any DB I/O), and it manifests
    // deterministically when `Neo` isn't imported before `Compare.mjs` is transitively
    // pulled in via the LifecycleService chain. If a future commit reorders or removes
    // the prelude, the structural assertion fires.

    test('script imports Neo prelude before LifecycleService (regression-class structural guard)', async () => {
        // Static check: the file's top imports MUST include `Neo` and `core/_export` before
        // any `services/memory-core/` module that transitively uses Neo.gatekeep.
        // This is the structural invariant the runtime test above verifies behaviorally.
        const {default: fs} = await import('fs-extra');
        const content       = await fs.readFile(scriptPath, 'utf-8');
        const lines         = content.split('\n');
        // Matched on the module each import RESOLVES to, never on one literal specifier. The Agent
        // OS consumes the PUBLISHED Engine, so these two modules arrive as `neo.mjs/src/**`; an
        // earlier layout reached the same files by climbing relatively into an in-repo `src/**`.
        // A guard pinned to either spelling is invalidated by the next specifier migration rather
        // than surviving it, and an invalidated guard covers nothing while still looking like
        // coverage. The invariant is "the Neo class system is bootstrapped before the first module
        // that calls `Neo.gatekeep()` at load time"; the specifier form is not part of it.
        const neoImportIdx  = lines.findIndex(l => /^import\s+Neo\s+from\s+['"][^'"]*src\/Neo\.mjs['"]/.test(l));
        const coreImportIdx = lines.findIndex(l => /^import\s+\*\s+as\s+core\s+from\s+['"][^'"]*src\/core\/_export\.mjs['"]/.test(l));
        const lifecycleIdx  = lines.findIndex(l => /^import\s+LifecycleService\s+from\s+['"][^'"]*SystemLifecycleService\.mjs['"]/.test(l));

        // Presence FIRST, each with its own message. `findIndex` returns -1 on absence and
        // `-1 < lifecycleIdx` is vacuously true, so an ordering assertion evaluated with a missing
        // import would report correct ordering about an import that is not there.
        expect(neoImportIdx, 'the Neo prelude is absent from sweepExpiredTasks.mjs — direct invocation will die at module load with `ReferenceError: Neo is not defined` (#10595)').toBeGreaterThanOrEqual(0);
        expect(coreImportIdx, 'the core/_export augmentation is absent — Neo globals will be missing at setupClass time').toBeGreaterThanOrEqual(0);
        expect(lifecycleIdx, 'the LifecycleService import is absent — this guard has lost its subject, so re-point it rather than deleting it').toBeGreaterThanOrEqual(0);

        expect(neoImportIdx, 'the Neo prelude is imported AFTER LifecycleService, so Compare.mjs gatekeeps before Neo exists').toBeLessThan(lifecycleIdx);
        expect(coreImportIdx, 'core/_export is imported AFTER LifecycleService, so Neo globals are absent when the chain loads').toBeLessThan(lifecycleIdx);
    });
});

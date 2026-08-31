#!/usr/bin/env node

import path              from 'path';
import {fileURLToPath}   from 'url';
import {
    assertTargetHoldsCorpus,
    resolveEmissionTargetRoot,
    TARGET_ROOT_FLAG
} from './syncGithubWorkflowTargetRoot.mjs';

/**
 * @module ai/scripts/maintenance/emitGithubCorpus
 * @summary Scheduled, target-bound GitHub corpus emission — the producer the split left unowned.
 *
 *     npm run ai:emit-github-corpus -- --target-repo-root /absolute/path/to/neo
 *
 * `resources/content/{issues,pulls,discussions}` is the corpus `ticket-create`'s duplicate sweep
 * greps and the Knowledge Base ingests. It lives in the ENGINE repository; the emitter lives here.
 * The Engine's Data Sync pipeline used to run both halves in one process, which made the coupling
 * invisible: `c623b2f63c` removed the `GitHub Workflow corpus` stage because its script had left in
 * the split, the run got *shorter* rather than red, and the corpus sat frozen from 2026-08-26 while
 * every seat kept querying it. `neomjs/neo#17927` since made the Engine loud about a stale corpus;
 * this is the other half — something that actually produces one.
 *
 * **Why this is a separate entrypoint rather than a flag on `syncGithubWorkflow.mjs`.**
 *
 * The corpus paths are resolved at MODULE LOAD: `ai/mcp/server/github-workflow/configBase.mjs:8`
 * derives `projectRoot` from `process.cwd()`, and every corpus leaf hangs off it. Binding a target
 * therefore has to happen before that graph loads, which inside `syncGithubWorkflow.mjs` would mean
 * converting its config and service imports to dynamic ones. That file is the subject of a
 * calibrated guard: `syncGithubWorkflowImportException.spec.mjs` walks its STATIC import graph to
 * prove the SDK-boundary exception still holds, and asserts a non-vacuity floor of 50 against a
 * measured 63. Dynamic imports collapse that walk, and the spec names lowering the floor as the
 * anti-fix — it would trade a real guard against a real hourly failure for a flag. Re-binding
 * `GH_Config.data.issueSync.*` after import is the other obvious route and is ADR-0019 §3 B4, the
 * safety-critical runtime-write antipattern.
 *
 * So this file takes the shape `postReleaseSync.mjs` already established for the same boundary,
 * against the same target repository: validate the binding, fail closed, set cwd from the VALIDATED
 * value only, then load the graph. `syncGithubWorkflow.mjs` is untouched and its no-flag behavior is
 * unchanged; the operator's manual full-sync keeps working exactly as before.
 *
 * **What this deliberately does not do:** no derivation (the Engine owns `content indexes and SEO`
 * and keeps reading the corpus), no local-to-GitHub issue push, no Native Graph projection. Those
 * belong to `--emit-only`'s contract and to the container-plane projection owner respectively.
 *
 * @keywords Corpus Emission, Data Sync, Engine-Brain Boundary, ADR 0040, Scheduled Producer
 */

const
    modulePath = fileURLToPath(import.meta.url),
    brainRoot  = path.resolve(path.dirname(modulePath), '../../..');

/**
 * @summary Validates the target binding, then runs emit-only emission bound to it.
 * @returns {Promise<void>}
 */
async function main() {
    const targetRoot = resolveEmissionTargetRoot({
        argv       : process.argv.slice(2),
        runtimeRoot: brainRoot
    });

    const corpusRoot = assertTargetHoldsCorpus({targetRoot});

    console.log(`🎯 Emission target: ${targetRoot}`);
    console.log(`📚 Corpus root:     ${corpusRoot}`);

    // Target-bound ConfigProviders derive `projectRoot` when their module graph loads, so cwd is set
    // HERE — from the validated binding, never from where the process happened to start — and before
    // the dynamic import below pulls that graph in. Both refusals above are unconditional, so there
    // is no path on which ambient cwd becomes the target by default.
    process.chdir(targetRoot);

    const {syncGithubWorkflow} = await import('./syncGithubWorkflow.mjs');

    // Emission mode is passed, not spelled into argv. The delegate still defaults both flags from
    // `process.argv` for its own CLI, so an argv-mutation here would work — and would also mean this
    // entrypoint's contract lived in a string that any later argv handling could reinterpret.
    await syncGithubWorkflow({emitOnly: true, verbose: process.argv.includes('--verbose')})
}

// CLI-entry gate: importing this file must never chdir the importing process or start an emission.
// The same entrypoint predicate `postReleaseSync.mjs` uses. `path.resolve` only absolutizes — it
// does NOT follow symlinks, so this comparison holds for direct invocation (what the npm alias and
// the workflow do) and would fail closed, silently, if this file were ever exposed through a
// symlinked bin: `import.meta.url` reports the realpath while `argv[1]` keeps the link. Should that
// day come, the fix is `fs.realpathSync` here, not a looser comparison.
const cliEntryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (cliEntryPath && cliEntryPath === modulePath) {
    main().catch(error => {
        console.error(`\n❌ ${error.message}`);
        process.exit(1)
    })
}

export {main};

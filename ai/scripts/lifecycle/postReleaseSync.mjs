#!/usr/bin/env node

/**
 * @summary Brain-side post-release lifecycle: the Knowledge Base upload, behind a fail-closed preflight.
 *
 * This step used to live inside `buildScripts/release/publish.mjs` as its stage 5.5, which made the
 * ENGINE's release script import `ai/services.host.mjs` and spawn
 * `ai/scripts/maintenance/uploadKnowledgeBase.mjs` — the one coupling that forced the agent OS to
 * be present and importable before the engine could release at all. The engine↔Brain boundary is
 * one-way (the Brain may consume the engine; never the reverse), so this half of the release lives
 * HERE, beside the Knowledge Base it uploads. `publish.mjs` ends after the GitHub release is created
 * and prints this script as the next runbook step. The Engine checkout is a distinct target
 * authority and must be named — the Brain checkout/cwd is never treated as the release:
 *
 *     npm run ai:post-release-sync -- --target-repo-root /absolute/path/to/neo
 *
 * It writes nothing into the Engine checkout. The Engine carries no content mirror: conversations
 * and release notes publish from `neomjs/github-content-sync`, and the release note stays where it
 * was authored, in `.github/RELEASE_NOTES/`.
 *
 * Ordering contract:
 *
 * 0. Preflight (`postReleasePreflight.mjs`): current branch is `dev`; the version derives from
 *    `package.json` only (no CLI override — an interpolated flag is an injection surface) and is
 *    strict semver; the working tree is clean. All three hold before the first irreversible step.
 * 1. Upload the Knowledge Base (the release's own artifacts are what it serves).
 *
 * @keywords Release Automation, Knowledge Base, Engine-Brain Boundary
 */

import {execFileSync, execSync} from 'child_process';
import fs                       from 'fs-extra';
import path                     from 'path';
import {fileURLToPath}          from 'url';
import {isEntryModule}          from '../../services/shared/isEntryModule.mjs';
import {
    assertAdmissibleStartingState,
    assertOnDevBranch,
    buildReleaseChildEnvironment,
    resolveReleaseVersion,
    resolveTargetRepoRoot
} from './postReleasePreflight.mjs';

const
    modulePath = fileURLToPath(import.meta.url),
    brainRoot  = path.resolve(path.dirname(modulePath), '../../..');

/**
 * @summary Runs one Brain-owned Node entrypoint against the explicit target checkout.
 * @param {String} scriptPath Absolute Brain runtime script path.
 * @param {String} errorMessage Message printed when the command fails.
 * @param {String} cwd Explicit Engine target root.
 * @param {Object} [env=process.env] Explicit child process environment.
 * @returns {void}
 */
function runNodeScript(scriptPath, errorMessage, cwd, env = process.env) {
    try {
        console.log(`> ${process.execPath} ${scriptPath}`);
        execFileSync(process.execPath, [scriptPath], {cwd, env, stdio: 'inherit'})
    } catch (error) {
        console.error(`\n❌ Error: ${errorMessage}`);
        console.error(error.message);
        process.exit(1)
    }
}

/**
 * @summary Runs a shell command and returns its trimmed output, or null on failure.
 * @param {String} command The command to execute.
 * @returns {String|null} Trimmed stdout, or null when the command fails.
 */
function runCommandWithOutput(command) {
    try {
        console.log(`> ${command}`);
        return execSync(command, {encoding: 'utf-8'}).trim();
    } catch {
        return null;
    }
}

async function main() {
    const root = resolveTargetRepoRoot({
        argv           : process.argv.slice(2),
        readPackageJson: targetRoot => fs.readJsonSync(path.join(targetRoot, 'package.json')),
        runtimeRoot    : brainRoot
    });

    // Target-bound ConfigProviders still derive `projectRoot` when their module graph loads. Set
    // cwd ONLY from the validated explicit binding, before the upload runs. Missing bindings fail
    // above; ambient cwd never becomes target authority by accident.
    process.chdir(root);

    // --- 0. Fail-closed preflight, before ANY mutation (the KB upload is irreversible) ---
    //
    // The version is derived from package.json ONLY — a CLI flag would be an injection surface
    // and a version-mismatch class; both die by removal.
    const version = resolveReleaseVersion({
        readPackageJson: () => fs.readJsonSync(path.join(root, 'package.json'))
    });

    assertOnDevBranch({
        getCurrentBranch: () => runCommandWithOutput('git rev-parse --abbrev-ref HEAD')
    });

    assertAdmissibleStartingState({
        getPorcelainStatus: () => runCommandWithOutput('git status --porcelain')
    });

    console.log(`\n🧠 Post-release lifecycle for v${version}...\n`);

    // --- 1. Upload Knowledge Base ---

    console.log('🧠 Step 1: Uploading Knowledge Base...');
    runNodeScript(
        path.join(brainRoot, 'ai/scripts/maintenance/uploadKnowledgeBase.mjs'),
        'Failed to upload knowledge base',
        root,
        buildReleaseChildEnvironment({version})
    );

    console.log('\n✨ Post-release lifecycle complete! ✨');
}

// CLI-entry gate: a release-lifecycle script whose IMPORT is execution is a loaded gun — an
// accidental import (a test, a lint walking the module graph, a REPL probe) must never start a
// Knowledge Base upload. `main()` runs only when this file IS the process entrypoint — the same
// checkable entrypoint predicate `runAgent.mjs` uses.
if (isEntryModule(import.meta.url)) {
    main().catch(error => {
        console.error('\n❌ Unhandled Error:', error);
        process.exit(1);
    });
}

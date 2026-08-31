import fs   from 'fs-extra';
import path from 'path';

/**
 * @module ai/scripts/maintenance/syncGithubWorkflowTargetRoot
 * @summary Resolves and validates the Engine checkout that scheduled corpus emission writes into.
 *
 * The corpus (`resources/content/{issues,pulls,discussions}`) lives in the ENGINE repository, and the
 * emitter lives here. Before the split those two facts were reconciled by accident: the Engine's
 * pipeline spawned the emitter with the Engine as cwd, so `configBase.mjs`'s
 * `process.cwd()`-derived `projectRoot` *happened* to name the right repository. `c623b2f63c`
 * removed that stage and the coincidence with it — the corpus then sat frozen for five days while
 * every run reported green, because nothing was left that could notice an absent producer.
 *
 * ADR 0040 §2.5 forbids restoring the coincidence deliberately — *"ambient cwd is never promoted to
 * either authority."* So the target is named explicitly and validated before anything can write, and
 * the checks below are ordered cheapest-first so a misconfigured schedule dies on argument shape
 * rather than on a half-written corpus.
 *
 * This module is the guard half only. It performs no I/O beyond the two existence reads it is asked
 * for, holds no process state, and never changes cwd — {@link module:ai/scripts/maintenance/emitGithubCorpus}
 * owns that step, for the same reason `postReleasePreflight.mjs` is separable from
 * `postReleaseSync.mjs`: a preflight you can call in a test is a preflight that gets tested.
 *
 * @keywords Corpus Emission, Target Repository Root, Engine-Brain Boundary, ADR 0040, Fail-Closed Preflight
 */

/**
 * The CLI flag naming the Engine checkout. Matches `postReleaseSync.mjs`'s spelling deliberately:
 * two Brain-side entrypoints binding the same target authority should not need two vocabularies.
 * @type {String}
 */
export const TARGET_ROOT_FLAG = '--target-repo-root';

/**
 * The package name a valid target must declare. A path check alone would accept any directory that
 * happens to hold `resources/content` — including a stale clone or a sibling repository — and
 * emission into the wrong repository is not distinguishable after the fact from emission into none.
 * @type {String}
 */
export const TARGET_PACKAGE_NAME = 'neo.mjs';

/**
 * @summary Reads the explicit target-root binding out of an argv tail, or refuses.
 *
 * Deliberately a scan rather than `postReleasePreflight`'s exact-arity match: this caller also
 * carries `--verbose`, and an arity check would reject a legitimate invocation for a reason that has
 * nothing to do with the binding. The strictness that matters is kept — an absent flag, an empty
 * value, or a value that is itself a flag (the shape `--target-repo-root --verbose` produces, where
 * the operator forgot the path) all refuse rather than resolve to something plausible.
 *
 * @param {Object} options
 * @param {String[]} options.argv Argument tail, i.e. `process.argv.slice(2)`.
 * @param {String} options.runtimeRoot Absolute path of THIS repository (`agentosRuntimeRoot`).
 * @param {Function} [options.readPackageJson] Reads a target's `package.json`; injectable for tests.
 * @param {Function} [options.resolvePath=path.resolve] Path resolver; injectable for tests.
 * @returns {String} The absolute, validated target repository root.
 * @throws {Error} When the binding is absent, self-aliasing, unreadable, or not the Engine package.
 */
export function resolveEmissionTargetRoot({
    argv,
    runtimeRoot,
    readPackageJson = targetRoot => fs.readJsonSync(path.join(targetRoot, 'package.json')),
    resolvePath     = path.resolve
}) {
    const flagIndex = Array.isArray(argv) ? argv.indexOf(TARGET_ROOT_FLAG) : -1;

    if (flagIndex === -1) {
        throw new Error(
            `Corpus emission refused: the target repository root is required explicitly. ` +
            `Usage: npm run ai:emit-github-corpus -- ${TARGET_ROOT_FLAG} /absolute/path/to/neo. ` +
            'Ambient process.cwd() is never a target-root fallback (ADR 0040 §2.5).'
        )
    }

    const rawValue = argv[flagIndex + 1];

    if (typeof rawValue !== 'string' || !rawValue.trim() || rawValue.startsWith('--')) {
        throw new Error(
            `Corpus emission refused: ${TARGET_ROOT_FLAG} was given without a path ` +
            `(received ${JSON.stringify(rawValue)}).`
        )
    }

    if (typeof runtimeRoot !== 'string' || !runtimeRoot.trim()) {
        throw new Error('Corpus emission refused: the Brain runtime root is unavailable.')
    }

    const
        targetRoot  = resolvePath(rawValue),
        resolvedRun = resolvePath(runtimeRoot);

    // Checked BEFORE the manifest read, because this repository has no `resources/content` at all:
    // pointed at itself, emission would otherwise fail the corpus check below with "no corpus here",
    // which reads as a broken target rather than as the caller naming the wrong repository.
    if (targetRoot === resolvedRun) {
        throw new Error(
            'Corpus emission refused: targetRepoRoot aliases agentosRuntimeRoot. ' +
            'Name the Engine checkout explicitly; the Agent OS checkout never holds the corpus.'
        )
    }

    let manifest;

    try {
        manifest = readPackageJson(targetRoot)
    } catch (error) {
        throw new Error(
            `Corpus emission refused: cannot read target package.json at ${targetRoot}: ${error.message}`
        )
    }

    if (manifest?.name !== TARGET_PACKAGE_NAME) {
        throw new Error(
            `Corpus emission refused: targetRepoRoot must identify the Engine package ` +
            `"${TARGET_PACKAGE_NAME}" (found ${JSON.stringify(manifest?.name)} at ${targetRoot}).`
        )
    }

    return targetRoot
}

/**
 * @summary Refuses a target that cannot already hold a corpus.
 *
 * The failure this exists to prevent is not "emission crashed" — it is emission SUCCEEDING into a
 * tree that never held a corpus. `resources/content/` would be created wherever the process stood,
 * the three facets would be written with fresh timestamps, and the run would report clean. That
 * artifact is indistinguishable from a healthy one by every instrument we have except provenance,
 * and it is strictly worse than the frozen corpus it would appear to fix: a stale corpus at least
 * announces itself by age.
 *
 * So the directory must pre-exist. Emission REFRESHES a corpus; it does not establish one.
 *
 * @param {Object} options
 * @param {String} options.targetRoot Absolute, already-resolved target repository root.
 * @param {Function} [options.directoryExists] Existence predicate; injectable for tests.
 * @param {Function} [options.joinPath=path.join] Path joiner; injectable for tests.
 * @returns {String} The absolute corpus root, for the caller to log.
 * @throws {Error} When the target holds no `resources/content` directory.
 */
export function assertTargetHoldsCorpus({
    targetRoot,
    directoryExists = candidate => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory(),
    joinPath        = path.join
}) {
    const corpusRoot = joinPath(targetRoot, 'resources/content');

    if (!directoryExists(corpusRoot)) {
        throw new Error(
            `Corpus emission refused: ${corpusRoot} does not exist, so this target has never held a ` +
            'corpus. Emission refreshes an existing corpus; creating one here would publish a ' +
            'fresh-looking artifact that belongs to no repository — the failure mode that kept the ' +
            '2026-08-26 freeze invisible for five days.'
        )
    }

    return corpusRoot
}

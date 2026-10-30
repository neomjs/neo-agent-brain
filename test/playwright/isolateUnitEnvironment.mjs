/**
 * @module test/playwright/isolateUnitEnvironment
 * @summary Removes the environment a unit run inherits from the shell that starts it, so the suite behaves as CI
 * does wherever it runs.
 *
 * A seat the Fleet Manager launches carries its runtime placement (`NEO_PLANE_DATA_ROOT`, `NEO_CHROMA_DATA_DIR`,
 * `NEO_AI_DB_PATH`, …) and its git identity (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`). Inherited, the placement moves the
 * config's prod leaves onto the seat's live plane and makes plane members read as explicitly placed, and the identity
 * overrides the one a fixture repository plants. CI carries none of it.
 *
 * It runs once, in the process that starts the run, and before `configTemplateResolver.mjs` binds the harness's own
 * values. Playwright workers inherit the harness boundary (`NEO_TEST_CONFIG_TEMPLATES`) and keep what the runner
 * bound. The harness's own namespace, `NEO_TEST_*`, always survives, since a workflow sets it on purpose.
 *
 * Only placement goes: the plane's identity and every path-valued `NEO_*` name (`*_PATH`, `*_DIR`, `*_ROOT`,
 * `*_BASE`). Endpoints, credentials and the agent identity stay, because the specs CI skips for want of live
 * substrate (`NEO_TEST_SKIP_CI`) reach the developer's model host and remote servers through them.
 */

const INHERITED = /^(?:NEO_(?!TEST_)(?:PLANE_ID$|\w*_(?:PATH|DIR|ROOT|BASE)$)|GIT_AUTHOR_|GIT_COMMITTER_)/;

/**
 * @param {Object} [env=process.env] The environment to clean, in place.
 * @returns {String[]} The names it removed: none inside the harness boundary.
 */
export function isolateUnitEnvironment(env = process.env) {
    if (env.NEO_TEST_CONFIG_TEMPLATES === 'true') {
        return []
    }

    const removed = Object.keys(env).filter(key => INHERITED.test(key));

    removed.forEach(key => delete env[key]);

    return removed
}

isolateUnitEnvironment();

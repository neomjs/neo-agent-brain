/**
 * @module ai/scripts/diagnostics/denyCloudPlanePackages.loader
 * @summary Resolve hook that denies cloud-plane-only packages, simulating a host install.
 *
 * The host plane gets `npm install`; the cloud plane additionally runs `npm run install-brain`
 * (`package.brain.json`). A host process therefore has these packages ABSENT — which is the
 * environment `ai/services.host.mjs` must remain importable in, and the one no full-install CI run
 * can reproduce, because CI installs everything.
 *
 * Denial is by exact specifier and subpath, and it throws the same `ERR_MODULE_NOT_FOUND` code Node
 * raises for a genuinely missing package, so the code under test cannot tell this apart from the
 * real thing.
 *
 * Recovered from a closed, unmerged branch rather than rewritten — the original was reviewed and its
 * failure-code fidelity is the load-bearing part.
 *
 * Lives beside the plane-boundary proof rather than under `test/**` because it has two consumers now:
 * the host-barrel spec and the proof's runtime-denial layer, and the latter is a production
 * diagnostic that must not import an instrument out of the test tree. One loader, two consumers —
 * a copy would fork exactly the failure-code fidelity described above.
 */

/**
 * @summary The Brain tier — the native and vector packages the cloud plane installs and a host
 * process must remain importable without. Named keys let a consumer address one member without
 * spelling its name; {@link BRAIN_TIER_PACKAGES} is the same set as an ordered list.
 *
 * This is the one place the membership is written. The unit config's install gate, its spec and
 * `.github/dependabot.yml`'s `exclude-patterns` are asserted against it instead of repeating it: a
 * hand-copied set fails silently when a member joins, because nothing reds; a set asserted against
 * this one reds.
 * @type {Readonly<{sqlite: String, chroma: String, embed: String}>}
 */
export const BRAIN_TIER = Object.freeze({
    sqlite: 'better-sqlite3',
    chroma: 'chromadb',
    embed : '@chroma-core/default-embed'
});

/**
 * @summary The Brain tier as an ordered list, for consumers that iterate rather than address.
 * @type {ReadonlyArray<String>}
 */
export const BRAIN_TIER_PACKAGES = Object.freeze(Object.values(BRAIN_TIER));

/**
 * @summary Resolves the denied package list: `NEO_DENIED_PACKAGES` when set, else the Brain tier.
 * @param {Object} [env=process.env] Environment to read the override from.
 * @returns {String[]}
 */
export function readDeniedPackages(env = process.env) {
    return (env.NEO_DENIED_PACKAGES || BRAIN_TIER_PACKAGES.join(','))
        .split(',')
        .map(name => name.trim())
        .filter(Boolean)
}

const DENIED = readDeniedPackages();

/**
 * @param {String} specifier
 * @param {Object} context
 * @param {Function} nextResolve
 * @returns {Promise<Object>}
 */
export async function resolve(specifier, context, nextResolve) {
    if (DENIED.some(pkg => specifier === pkg || specifier.startsWith(`${pkg}/`))) {
        const error = new Error(`DENIED_CLOUD_PLANE_PACKAGE: ${specifier}`);

        error.code = 'ERR_MODULE_NOT_FOUND';
        throw error
    }

    return nextResolve(specifier, context)
}

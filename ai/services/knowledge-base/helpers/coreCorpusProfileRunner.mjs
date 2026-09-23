import {createHash, randomUUID}              from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import fs                                    from 'node:fs/promises';
import path                                  from 'node:path';
import {finished}                            from 'node:stream/promises';

import ExtractorCatalogue                                                    from '../source/ExtractorCatalogue.mjs';
import {createExtractionProfileIdentity}                                     from './extractionProfileContract.mjs';
import {compileExtractionProfile, runExtractionProfile}                      from './extractionProfileRunner.mjs';
import {createBrainImageRevisionReader, createInstalledEngineRevisionReader} from './imageRevisionReader.mjs';
import {CORE_CORPUS_REPO_SLUGS, createCoreCorpusProfilePlan}                 from './coreCorpusProfilePlan.mjs';

export const CORE_CORPUS_MANIFEST_SCHEMA = 'neo.shared-core-corpus-profiles/v1';

/**
 * @summary Refuses a missing or inconsistent shared-core profile artifact.
 * @param {String} code
 * @param {String} message
 * @returns {Error}
 * @private
 */
function refuse(code, message) {
    const error = new Error(message);

    error.code = code;
    return error
}

/**
 * @summary Derives the manifest location from the resolved Knowledge Base data-path leaf.
 * @param {String} dataPath
 * @returns {String}
 */
export function coreCorpusManifestPath(dataPath) {
    if (typeof dataPath !== 'string' || !path.isAbsolute(dataPath)) {
        throw refuse('KB_CORE_CORPUS_DATA_PATH_INVALID', 'Shared core corpus requires an absolute data path')
    }

    return `${dataPath}.profiles.json`
}

/**
 * @summary Binds both shared-core revisions and compiles both profiles before any output write.
 *
 * This is the anti-partial-admission gate: a bad Engine package pin, Brain image stamp, route
 * overlap, or hierarchy cannot leave one repository's fresh JSONL beside another's failed scan.
 *
 * @param {Object} options
 * @param {String} options.brainRoot Explicit Brain image or checkout root.
 * @param {String} [options.brainRevision] Exact checkout revision when the image has no stamp.
 * @param {String} options.tenantId Shared Neo tenant id.
 * @param {Object} options.hierarchyResolver Identity-bearing repository hierarchy resolver.
 * @param {Object} [options.catalogue=ExtractorCatalogue]
 * @param {Function} [options.engineReaderFactory]
 * @param {Function} [options.brainReaderFactory]
 * @returns {Promise<Object[]>} Repository plans with compiled route authority.
 */
export async function prepareCoreCorpusProfiles({
    brainRoot,
    brainRevision,
    tenantId,
    hierarchyResolver,
    catalogue = ExtractorCatalogue,
    engineReaderFactory = createInstalledEngineRevisionReader,
    brainReaderFactory = createBrainImageRevisionReader
} = {}) {
    if (!hierarchyResolver?.id || !hierarchyResolver?.version || typeof hierarchyResolver.resolve !== 'function') {
        throw refuse('KB_CORE_CORPUS_HIERARCHY_REQUIRED', 'Shared core corpus requires one identity-bearing hierarchy resolver')
    }

    const prepared = [];

    for (const repoSlug of CORE_CORPUS_REPO_SLUGS) {
        const plan   = createCoreCorpusProfilePlan(repoSlug);
        const reader = repoSlug === 'neo'
            ? await engineReaderFactory({brainRoot, roots: plan.roots, tenantId, repoSlug})
            : await brainReaderFactory({brainRoot, roots: plan.roots, tenantId, repoSlug, revision: brainRevision});

        if (reader.tenantId !== tenantId || reader.repoSlug !== repoSlug) {
            throw refuse('KB_CORE_CORPUS_READER_IDENTITY_MISMATCH', `Shared core reader for '${repoSlug}' has a different owner`)
        }

        const compiled = await compileExtractionProfile({
            profile         : plan.profile,
            catalogue,
            repositoryReader: reader,
            hierarchyResolver
        });
        const extractionIdentity = createExtractionProfileIdentity({
            profile          : compiled.profile,
            catalogue,
            hierarchyIdentity: {id: hierarchyResolver.id, version: hierarchyResolver.version}
        });

        prepared.push({repoSlug, reader, compiled, extractionIdentity});
    }

    return prepared
}

/**
 * @summary Runs both prevalidated profiles into immutable, revision/content-named JSONL artifacts.
 *
 * The final manifest is the only publication pointer. A failed profile leaves its temporary
 * output unreferenced; no caller can accidentally embed half of a two-repository build.
 *
 * @param {Object} options
 * @param {String} options.dataPath Resolved absolute Knowledge Base data path.
 * @param {Object[]} options.prepared From {@link prepareCoreCorpusProfiles}.
 * @param {String} options.tenantId
 * @param {Function} options.createHashFn Hashes a chunk under explicit tenant/repo/profile identity.
 * @returns {Promise<Object>} Durable manifest and summary.
 */
export async function materializeCoreCorpusProfiles({dataPath, prepared, tenantId, createHashFn} = {}) {
    const manifestPath = coreCorpusManifestPath(dataPath);

    if (
        !Array.isArray(prepared) || prepared.length !== CORE_CORPUS_REPO_SLUGS.length
        || prepared.some((item, index) => item.repoSlug !== CORE_CORPUS_REPO_SLUGS[index])
        || typeof createHashFn !== 'function'
    ) {
        throw refuse('KB_CORE_CORPUS_PLAN_INVALID', 'Shared core corpus requires both ordered, prevalidated profiles')
    }

    await fs.mkdir(path.dirname(dataPath), {recursive: true});

    const artifacts      = [];
    const temporaryPaths = [];

    try {
        for (const item of prepared) {
            const artifactPrefix = `${dataPath}.${item.repoSlug}.${item.reader.revision}`;
            const temporaryPath  = `${artifactPrefix}.${randomUUID()}.tmp`;
            const stream         = createWriteStream(temporaryPath, {flags: 'wx'});
            const streamDone     = finished(stream);
            const artifactHash   = createHash('sha256');

            // Attach rejection handling before the extractor can issue thousands of writes.
            streamDone.catch(() => {});

            temporaryPaths.push(temporaryPath);

            try {
                const execution = await runExtractionProfile({
                    compiledProfile  : item.compiled,
                    repositoryReader : item.reader,
                    hierarchyResolver: item.compiled.hierarchyResolver,
                    writeStream      : {
                        write() {
                            throw refuse('KB_CORE_CORPUS_ROUTE_REQUIRED', 'Shared core chunks require a declared extractor route')
                        },
                        forRoute(route) {
                            return {
                                write(line) {
                                    const chunk = JSON.parse(String(line));

                                    chunk.sourcePath = chunk.sourcePath || chunk.source;
                                    chunk.rootKind = item.repoSlug === 'neo' ? 'neo-workspace' : 'external-source';
                                    // `sourcePath` is relative to its owning repository. The legacy
                                    // query API groups by `source`, so retain Engine's installed
                                    // package prefix there to distinguish same-relative-path files
                                    // in Engine and Brain without changing the public result shape.
                                    if (item.repoSlug === 'neo') {
                                        chunk.source = `node_modules/neo.mjs/${chunk.sourcePath}`;
                                    }
                                    chunk.extractorId = route.extractorId;
                                    chunk.extractorVersion = route.version;
                                    chunk.extractionIdentity = item.extractionIdentity;
                                    chunk.hash = createHashFn(chunk, {
                                        tenantId,
                                        repoSlug          : item.repoSlug,
                                        extractionIdentity: item.extractionIdentity
                                    });
                                    const encoded = JSON.stringify(chunk) + '\n';

                                    artifactHash.update(encoded);
                                    stream.write(encoded);
                                }
                            }
                        }
                    },
                    createHashFn: chunk => createHashFn(chunk, {
                        tenantId,
                        repoSlug          : item.repoSlug,
                        extractionIdentity: item.extractionIdentity
                    })
                });

                stream.end();
                await streamDone;
                const sha256       = artifactHash.digest('hex');
                const artifactPath = `${artifactPrefix}.${sha256}.jsonl`;

                await fs.rename(temporaryPath, artifactPath);
                temporaryPaths.pop();

                artifacts.push({
                    tenantId,
                    repoSlug          : item.repoSlug,
                    revision          : item.reader.revision,
                    extractionIdentity: item.extractionIdentity,
                    path              : artifactPath,
                    sha256,
                    count             : execution.count,
                    yieldedSourcePaths: execution.yieldedSourcePaths.length
                })
            } catch (error) {
                stream.destroy();
                await streamDone.catch(() => {});
                throw error
            }
        }

        const manifest = {
            schemaVersion: CORE_CORPUS_MANIFEST_SCHEMA,
            artifacts
        };
        const stagedManifest = `${manifestPath}.${randomUUID()}.tmp`;

        temporaryPaths.push(stagedManifest);
        await fs.writeFile(stagedManifest, JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
        await fs.rename(stagedManifest, manifestPath);
        temporaryPaths.pop();

        return {
            ...manifest,
            manifestPath,
            count  : artifacts.reduce((sum, item) => sum + item.count, 0),
            message: `Knowledge base profiles created with ${artifacts.reduce((sum, item) => sum + item.count, 0)} chunks.`
        }
    } finally {
        await Promise.all(temporaryPaths.map(file => fs.rm(file, {force: true})))
    }
}

/**
 * @summary Reads only the published manifest and checks each artifact remains inside its data directory.
 * @param {String} dataPath
 * @returns {Promise<Object>}
 */
export async function readCoreCorpusManifest(dataPath) {
    const manifest = JSON.parse(await fs.readFile(coreCorpusManifestPath(dataPath), 'utf8'));
    const expected = CORE_CORPUS_REPO_SLUGS;
    const root     = path.dirname(dataPath);

    if (
        manifest?.schemaVersion !== CORE_CORPUS_MANIFEST_SCHEMA
        || !Array.isArray(manifest.artifacts)
        || manifest.artifacts.length !== expected.length
        || manifest.artifacts.some((item, index) =>
            item.repoSlug !== expected[index]
            || typeof item.tenantId !== 'string' || item.tenantId !== manifest.artifacts[0].tenantId
            || typeof item.path !== 'string'
            || path.dirname(item.path) !== root
            || !/^[a-f0-9]{40}$/u.test(item.revision)
            || !/^[a-f0-9]{64}$/u.test(item.extractionIdentity)
            || !/^[a-f0-9]{64}$/u.test(item.sha256)
            || !Number.isSafeInteger(item.count) || item.count < 0
        )
    ) {
        throw refuse('KB_CORE_CORPUS_MANIFEST_INVALID', 'Shared core corpus manifest does not name two bounded repository artifacts')
    }

    for (const artifact of manifest.artifacts) {
        const stats = await fs.lstat(artifact.path);

        if (!stats.isFile() || stats.isSymbolicLink()) {
            throw refuse('KB_CORE_CORPUS_ARTIFACT_INVALID', 'Shared core corpus artifact is not a regular file')
        }

        const digest = createHash('sha256');

        for await (const bytes of createReadStream(artifact.path)) {
            digest.update(bytes)
        }

        if (digest.digest('hex') !== artifact.sha256) {
            throw refuse('KB_CORE_CORPUS_ARTIFACT_CHANGED', 'Shared core corpus artifact changed after materialization')
        }
    }

    return manifest
}

/**
 * @summary Refuses a previously materialized output when either image source has advanced.
 * @param {Object} options
 * @param {Object} options.manifest Validated core artifact manifest.
 * @param {String} options.brainRoot Explicit Brain image or checkout root.
 * @param {String} [options.brainRevision] Exact checkout revision when unstamped.
 * @param {Function} [options.engineReaderFactory]
 * @param {Function} [options.brainReaderFactory]
 * @returns {Promise<void>}
 */
export async function assertCurrentCoreCorpusRevisions({
    manifest,
    brainRoot,
    brainRevision,
    engineReaderFactory = createInstalledEngineRevisionReader,
    brainReaderFactory = createBrainImageRevisionReader
} = {}) {
    for (const artifact of manifest.artifacts) {
        const plan   = createCoreCorpusProfilePlan(artifact.repoSlug);
        const reader = artifact.repoSlug === 'neo'
            ? await engineReaderFactory({brainRoot, roots: plan.roots, tenantId: artifact.tenantId, repoSlug: artifact.repoSlug})
            : await brainReaderFactory({brainRoot, roots: plan.roots, tenantId: artifact.tenantId, repoSlug: artifact.repoSlug, revision: brainRevision});

        if (
            reader.revision !== artifact.revision
            || reader.tenantId !== artifact.tenantId
            || reader.repoSlug !== artifact.repoSlug
        ) {
            throw refuse('KB_CORE_CORPUS_REVISION_CHANGED', `Shared core '${artifact.repoSlug}' changed since its artifact was built`)
        }
    }
}

/**
 * @summary Embeds two separately stamped core repositories without retiring legacy rows.
 *
 * The first delivery is additive by design: `#417` owns old conversation-row retirement, while
 * `#419` owns the separate source-code-row migration receipt required by `#282` AC-9 before
 * routine stale deletion can resume. An explicit staleStrategy must fail instead of overriding
 * `deleteStale: false` inside VectorService.
 *
 * @param {Object} options
 * @param {String} options.dataPath Resolved absolute Knowledge Base data path.
 * @param {String} options.brainRoot Explicit Brain image or checkout root.
 * @param {String} [options.brainRevision] Exact checkout revision when unstamped.
 * @param {Object} options.vectorService VectorService-like embed owner.
 * @param {Boolean} [options.viaMcp=false]
 * @param {Function} [options.shouldYield]
 * @param {String} [options.staleStrategy] Refused until the migration receipt exists.
 * @param {Function} [options.engineReaderFactory]
 * @param {Function} [options.brainReaderFactory]
 * @returns {Promise<Object>} Aggregate of the two embed receipts.
 */
export async function embedCoreCorpusProfiles({
    dataPath,
    brainRoot,
    brainRevision,
    vectorService,
    viaMcp = false,
    shouldYield,
    staleStrategy,
    engineReaderFactory,
    brainReaderFactory
} = {}) {
    if (staleStrategy !== undefined) {
        throw refuse('KB_CORE_CORPUS_STALE_DELETION_DEFERRED', 'Shared core stale deletion requires the separate migration receipt')
    }
    if (typeof vectorService?.embed !== 'function') {
        throw refuse('KB_CORE_CORPUS_VECTOR_SERVICE_REQUIRED', 'Shared core embedding requires VectorService')
    }

    const manifest = await readCoreCorpusManifest(dataPath);

    await assertCurrentCoreCorpusRevisions({
        manifest,
        brainRoot,
        brainRevision,
        ...(engineReaderFactory ? {engineReaderFactory} : {}),
        ...(brainReaderFactory ? {brainReaderFactory} : {})
    });

    const results = [];

    for (const artifact of manifest.artifacts) {
        const result = await vectorService.embed(artifact.path, {
            tenantContext: {tenantId: artifact.tenantId, repoSlug: artifact.repoSlug},
            deleteStale  : false,
            viaMcp,
            shouldYield
        });

        results.push({repoSlug: artifact.repoSlug, result});

        if (result?.error) {
            if (viaMcp) {
                return {...result, repoSlug: artifact.repoSlug, results}
            }

            throw refuse(result.code || 'KB_CORE_CORPUS_EMBED_FAILED', result.error)
        }
        if (result?.yielded === true || result?.remaining > 0) {
            return {message: `Shared core '${artifact.repoSlug}' embedding yielded; retry the same manifest`, yielded: true, results}
        }
    }

    const prunedArtifacts = await pruneCoreCorpusArtifacts(dataPath, manifest);

    return {
        message: 'Shared core Engine and Brain profiles embedded without legacy-row retirement.',
        results,
        prunedArtifacts
    }
}

/**
 * @summary Removes only prior generated core artifacts after both repository embeds succeed.
 *
 * A failed embed leaves the prior generation available for recovery. The fixed filename grammar
 * prevents this maintenance path from touching an unrelated generated file in the data directory.
 *
 * @param {String} dataPath Resolved absolute Knowledge Base data path.
 * @param {Object} manifest Current published manifest.
 * @returns {Promise<Number>} Number of superseded artifacts removed.
 */
export async function pruneCoreCorpusArtifacts(dataPath, manifest) {
    const directory = path.dirname(coreCorpusManifestPath(dataPath)),
          basename  = path.basename(dataPath).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
          candidate = new RegExp(`^${basename}\\.(?:neo|neo-agent-brain)\\.[a-f0-9]{40}\\.[a-f0-9]{64}\\.jsonl$`, 'u'),
          retained  = new Set(manifest.artifacts.map(item => path.basename(item.path)));

    let removed = 0;

    for (const name of await fs.readdir(directory)) {
        if (candidate.test(name) && !retained.has(name)) {
            await fs.rm(path.join(directory, name));
            removed++
        }
    }

    return removed
}

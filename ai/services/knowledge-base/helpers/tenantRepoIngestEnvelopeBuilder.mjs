import {createHash} from 'node:crypto';
import fs           from 'fs-extra';

import GitMirror          from './gitMirror.mjs';
import ExtractorCatalogue from '../source/ExtractorCatalogue.mjs';
import {
    createExtractionProfileIdentity,
    normalizeExtractionProfile
} from './extractionProfileContract.mjs';
import {runExtractionProfile}
    from './extractionProfileRunner.mjs';
import {createRepositoryRevisionReader}
    from './repositoryRevisionReader.mjs';
import {
    deriveTenantRepoMirrorPath,
    normalizeRepoSlug,
    redactTenantRepoSecrets
} from './tenantRepoAccessContract.mjs';

/**
 * @summary Builds `KnowledgeBaseIngestionService.ingestSourceFiles()` envelopes from tenant Git mirrors.
 *
 * `TenantRepoIngestEnvelopeBuilder` is the adapter between the low-level
 * persistent mirror primitive and the tenant KB ingestion payload contract.
 * Linear history advances emit bounded raw-file deltas plus tombstones; bootstrap,
 * missing-baseline, and force-push cases fall back to a full manifest-carrying
 * snapshot so the ingestion service can reconcile the claimed live path set without
 * relying on a stale revision boundary.
 *
 * @see https://github.com/neomjs/neo/issues/11789
 * @see https://github.com/neomjs/neo/issues/16045
 * @see ai/services/knowledge-base/KnowledgeBaseIngestionService.mjs
 */

/**
 * @summary Creates a stable envelope-builder error.
 * @param {String} code Stable `KB_INGEST_ENVELOPE_*` error code.
 * @param {String} message Human-readable message.
 * @param {Object} details={}
 * @returns {Error}
 * @private
 */
function createIngestEnvelopeError(code, message, details = {}) {
    const error = new Error(redactTenantRepoSecrets(message, details));

    error.code = code;

    if (details.stdout) {
        error.stdout = redactTenantRepoSecrets(details.stdout, details);
    }

    if (details.stderr) {
        error.stderr = redactTenantRepoSecrets(details.stderr, details);
    }

    if (details.exitCode !== undefined) {
        error.exitCode = details.exitCode;
    }

    if (details.cause) {
        error.cause = details.cause;
    }

    return error;
}

/**
 * @summary Creates the bounded identity digest for one manifest-bearing pull materialization.
 *
 * The Git head binds source bytes while the manifest and parser bindings distinguish
 * the corpus/parser shape being materialized. The digest intentionally excludes
 * credential and filesystem data so it is safe to persist in the shared manifest graph.
 *
 * @param {Object} envelope Manifest-bearing tenant-repo ingestion envelope.
 * @returns {String} Lowercase SHA-256 digest.
 */
export function createTenantRepoMaterializationDigest({
    repoSlug,
    headRevision,
    extractionIdentity,
    manifestSnapshot,
    files = []
} = {}) {
    const
        normalizedRepoSlug         = normalizeRepoSlug(manifestSnapshot?.repoSlug || repoSlug),
        normalizedHead             = typeof headRevision === 'string' ? headRevision.trim() : '',
        envelopeExtractionIdentity = typeof extractionIdentity === 'string'
            ? extractionIdentity.trim()
            : '',
        manifestExtractionIdentity = typeof manifestSnapshot?.extractionIdentity === 'string'
            ? manifestSnapshot.extractionIdentity.trim()
            : '';

    if (!normalizedHead) {
        throw createIngestEnvelopeError(
            'KB_INGEST_ENVELOPE_REF_NOT_FOUND',
            'Tenant repo materialization identity requires a head revision'
        );
    }

    if (!Array.isArray(manifestSnapshot?.pathsAfterPush)) {
        throw createIngestEnvelopeError(
            'KB_INGEST_ENVELOPE_MANIFEST_INVALID',
            'Tenant repo materialization identity requires manifestSnapshot.pathsAfterPush'
        );
    }

    if (
        envelopeExtractionIdentity
        && manifestExtractionIdentity
        && envelopeExtractionIdentity !== manifestExtractionIdentity
    ) {
        throw createIngestEnvelopeError(
            'KB_INGEST_ENVELOPE_EXTRACTION_IDENTITY_MISMATCH',
            'Tenant repo manifest extraction identity does not match the envelope identity'
        );
    }

    const normalizedExtractionIdentity = envelopeExtractionIdentity || manifestExtractionIdentity;

    if (!/^[a-f0-9]{64}$/u.test(normalizedExtractionIdentity)) {
        throw createIngestEnvelopeError(
            'KB_INGEST_ENVELOPE_EXTRACTION_IDENTITY_INVALID',
            'Tenant repo materialization identity requires a server-owned extraction identity'
        );
    }

    const
        pathsAfterPush = [...new Set(manifestSnapshot.pathsAfterPush
            .filter(sourcePath => typeof sourcePath === 'string' && sourcePath.length > 0))]
            .sort(),
        explicitYieldSet = Object.hasOwn(manifestSnapshot, 'yieldedSourcePaths'),
        yieldedSourcePaths = explicitYieldSet
            ? Array.isArray(manifestSnapshot.yieldedSourcePaths)
                ? [...new Set(manifestSnapshot.yieldedSourcePaths
                    .filter(sourcePath => typeof sourcePath === 'string' && sourcePath.length > 0))]
                    .sort()
                : null
            : [...new Set((Array.isArray(files) ? files : [])
                .map(file => file?.sourcePath)
                .filter(sourcePath => typeof sourcePath === 'string' && sourcePath.length > 0))]
                .sort(),
        parserBindings = (Array.isArray(files) ? files : [])
            .filter(file => typeof file?.sourcePath === 'string' && file.sourcePath.length > 0)
            .map(file => ({
                sourcePath   : file.sourcePath,
                rootKind     : typeof file.rootKind === 'string' ? file.rootKind : null,
                parserId     : typeof file.parserId === 'string' ? file.parserId : null,
                parserVersion: typeof file.parserVersion === 'string' ? file.parserVersion : null
            }))
            .sort((left, right) => {
                const
                    leftKey  = JSON.stringify(left),
                    rightKey = JSON.stringify(right);

                if (leftKey === rightKey) {
                    return 0;
                }

                return leftKey < rightKey ? -1 : 1;
            });

    if (
        explicitYieldSet
        && (
            !Array.isArray(manifestSnapshot.yieldedSourcePaths)
            || manifestSnapshot.yieldedSourcePaths
                .some(sourcePath => typeof sourcePath !== 'string' || sourcePath.length === 0)
        )
    ) {
        throw createIngestEnvelopeError(
            'KB_INGEST_ENVELOPE_MANIFEST_INVALID',
            'Tenant repo yielded source paths must be non-empty strings'
        );
    }

    if (!yieldedSourcePaths) {
        throw createIngestEnvelopeError(
            'KB_INGEST_ENVELOPE_MANIFEST_INVALID',
            'Tenant repo materialization identity requires manifestSnapshot.yieldedSourcePaths to be an array'
        );
    }

    const physicalPaths = new Set(pathsAfterPush);

    if (yieldedSourcePaths.some(sourcePath => !physicalPaths.has(sourcePath))) {
        throw createIngestEnvelopeError(
            'KB_INGEST_ENVELOPE_MANIFEST_INVALID',
            'Tenant repo yielded source path is outside the physical manifest'
        );
    }

    return createHash('sha256')
        .update(JSON.stringify({
            formatVersion     : 2,
            repoSlug          : normalizedRepoSlug,
            headRevision      : normalizedHead,
            extractionIdentity: normalizedExtractionIdentity,
            pathsAfterPush,
            yieldedSourcePaths,
            parserBindings
        }))
        .digest('hex');
}

/**
 * @summary Returns the mirror path while converting contract errors into builder errors.
 * @param {Object} options
 * @returns {String}
 * @private
 */
function getMirrorPath({mirrorRoot, tenantId, repoSlug} = {}) {
    try {
        return deriveTenantRepoMirrorPath({mirrorRoot, tenantId, repoSlug});
    } catch (error) {
        throw createIngestEnvelopeError(
            'KB_INGEST_ENVELOPE_MIRROR_PATH_INVALID',
            error.message,
            {cause: error}
        );
    }
}

/**
 * @summary Resolves and validates a commit ref inside the mirror.
 * @param {Object} options
 * @returns {Promise<String|null>}
 * @private
 */
async function resolveRevision({gitMirror, identity, ref, fallbackToFull = false}) {
    if (!ref) {
        return null;
    }

    try {
        return await gitMirror.resolveHead({...identity, ref});
    } catch (error) {
        if (fallbackToFull && error.code === 'KB_GITMIRROR_REF_NOT_FOUND') {
            return null;
        }

        const code = error.code === 'KB_GITMIRROR_REF_NOT_FOUND'
            ? 'KB_INGEST_ENVELOPE_REF_NOT_FOUND'
            : error.code === 'KB_GITMIRROR_MIRROR_PATH_INVALID'
                ? 'KB_INGEST_ENVELOPE_MIRROR_INVALID'
                : 'KB_INGEST_ENVELOPE_REF_RESOLVE_FAILED';

        throw createIngestEnvelopeError(
            code,
            error.message,
            {cause: error}
        );
    }
}

/**
 * @summary Synthesizes the one compatibility profile used by direct builder callers.
 * @param {Object} options
 * @returns {Object}
 * @private
 */
function createCompatibilityProfile({rootKind, parserId, parserVersion} = {}) {
    const declaredParserId = typeof parserId === 'string' ? parserId.trim() : '';

    return {
        profileSchemaVersion: 1,
        routes              : [{
            territory: {
                roots  : ['.'],
                include: ['**/*']
            },
            extractorId: declaredParserId ? 'ParserSource' : 'RawRepoSource',
            options    : declaredParserId
                ? {
                    parserId     : declaredParserId,
                    parserVersion: typeof parserVersion === 'string' && parserVersion.trim()
                        ? parserVersion.trim()
                        : '1.0.0'
                }
                : {rootKind}
        }],
        fallback: {action: 'exclude'}
    }
}

/**
 * @summary Collects route-bound runner JSONL writes into the canonical ingestion file envelope.
 * @param {Object} options
 * @returns {{files: Object[], writeStream: Object}}
 * @private
 */
function createProfileWriteCollector({extractionIdentity, repoSlug, rootKind} = {}) {
    const files = [];

    return {
        files,
        writeStream: {
            write() {
                throw createIngestEnvelopeError(
                    'KB_INGEST_ENVELOPE_PROVENANCE_UNBOUND',
                    'Profile chunks must be written through a route-bound writer'
                )
            },
            forRoute({extractorId, version, options = {}} = {}) {
                return {
                    write(value) {
                        let chunk;

                        try {
                            chunk = JSON.parse(String(value).trim())
                        } catch (error) {
                            throw createIngestEnvelopeError(
                                'KB_INGEST_ENVELOPE_PROFILE_CHUNK_INVALID',
                                'Profile extractor emitted invalid JSONL',
                                {cause: error}
                            )
                        }

                        const sourcePath = chunk?.sourcePath || chunk?.source;

                        if (typeof sourcePath !== 'string' || !sourcePath) {
                            throw createIngestEnvelopeError(
                                'KB_INGEST_ENVELOPE_PROFILE_CHUNK_INVALID',
                                'Profile extractor chunks require sourcePath or source'
                            )
                        }

                        files.push({
                            sourcePath,
                            repoSlug,
                            rootKind,
                            extractionIdentity,
                            extractorId,
                            extractorVersion: version,
                            parserId        : chunk.parserId || options.parserId || extractorId,
                            parserVersion   : chunk.parserVersion || options.parserVersion || version,
                            profileChunk    : chunk
                        })
                    }
                }
            }
        }
    }
}

/**
 * @summary Creates the legacy Source hash required by built-in extractor ports before adaptation.
 * @param {Object} chunk
 * @returns {String}
 * @private
 */
function createLegacyChunkHash(chunk) {
    return createHash('sha256').update(JSON.stringify(chunk)).digest('hex')
}

/**
 * @summary Builds a profile-executed Knowledge Base ingestion envelope from a tenant Git mirror.
 * @param {Object} options
 * @param {String} options.tenantId Tenant id.
 * @param {String} options.repoSlug Clean tenant repository identity.
 * @param {String} options.mirrorRoot Root directory for tenant repo mirrors.
 * @param {String} [options.lastIngestedRev] Previously ingested commit SHA/ref.
 * @param {String} [options.newHead='HEAD'] New commit SHA/ref to ingest.
 * @param {String} [options.rootKind='external-source'] Raw-file root kind for parser metadata.
 * @param {String} [options.parserId] Optional server parser id.
 * @param {String} [options.parserVersion] Optional parser version.
 * @param {Object} [options.extractionProfile] Canonical per-repo profile; absent synthesizes the
 *     compatibility RawRepoSource/ParserSource route.
 * @param {Object} [options.extractorCatalogue] Tenant-local immutable catalogue.
 * @param {String} [options.extractionIdentity] Pre-envelope identity; must match derived input.
 * @param {Object|null} [options.hierarchyResolver] Optional identity-bearing hierarchy capability.
 * @param {Object|null} [options.parserResolver] IngestionService-owned parser capability.
 * @param {Object} [options.gitMirror=GitMirror] Injectable GitMirror implementation for tests.
 * @param {String|Object|null} [options.credentialRef] Durable credential reference for the tenant
 *     repo. Reaches the content acquisition only, on both tiers: the bulk `prefetchRevisionBlobs` and,
 *     for anything it did not localize, the per-file `show <rev>:<path>` promisor fetch. Omitted, both
 *     are anonymous — correct for a public remote, fatal for a private one.
 * @returns {Promise<Object>}
 */
export async function buildIngestEnvelope({
    tenantId,
    repoSlug,
    mirrorRoot,
    lastIngestedRev,
    newHead = 'HEAD',
    rootKind = 'external-source',
    parserId,
    parserVersion,
    extractionProfile,
    extractorCatalogue = ExtractorCatalogue,
    extractionIdentity,
    hierarchyResolver = null,
    parserResolver = null,
    gitMirror = GitMirror,
    credentialRef
} = {}) {
    const identity = {
        tenantId,
        repoSlug: normalizeRepoSlug(repoSlug),
        mirrorRoot
    };
    const mirrorPath = getMirrorPath(identity);

    if (!await fs.pathExists(mirrorPath)) {
        throw createIngestEnvelopeError(
            'KB_INGEST_ENVELOPE_MIRROR_MISSING',
            'Tenant repo ingest envelope requires an existing GitMirror mirror'
        );
    }

    const profile = normalizeExtractionProfile(
        extractionProfile || createCompatibilityProfile({rootKind, parserId, parserVersion}),
        {catalogue: extractorCatalogue}
    );
    const hierarchyIdentity = hierarchyResolver?.id && hierarchyResolver?.version
        ? {id: hierarchyResolver.id, version: hierarchyResolver.version}
        : null;
    const extractorIds = new Set(profile.routes.map(route => route.extractorId));

    if (profile.fallback?.action === 'extract') {
        extractorIds.add(profile.fallback.extractorId)
    }

    const profileDeltaSafe = [...extractorIds]
        .every(extractorId => extractorCatalogue.get(extractorId).deltaSafe === true);
    const derivedExtractionIdentity = createExtractionProfileIdentity({
        profile,
        catalogue: extractorCatalogue,
        hierarchyIdentity
    });

    if (extractionIdentity && extractionIdentity !== derivedExtractionIdentity) {
        throw createIngestEnvelopeError(
            'KB_INGEST_ENVELOPE_EXTRACTION_IDENTITY_MISMATCH',
            'Pre-envelope extraction identity does not match the executable profile'
        )
    }

    const headRevision = await resolveRevision({gitMirror, identity, ref: newHead});
    const baseRevision = await resolveRevision({
        gitMirror,
        identity,
        ref           : lastIngestedRev,
        fallbackToFull: true
    });
    let fullMaterialization = !baseRevision,
        diff                = null;

    if (baseRevision) {
        const linear = await gitMirror.isAncestor({
            ...identity,
            ancestor  : baseRevision,
            descendant: headRevision
        });

        fullMaterialization = !linear;

        if (linear) {
            diff = await gitMirror.diffRevisions({
                ...identity,
                baseRevision,
                headRevision
            });

            // A linear Git history is not automatically a delta-safe extraction. Parser-backed,
            // hierarchy-aware, and arbitrary custom extractors can depend on unchanged files, so
            // their linear advance is a proof-bearing full materialization.
            fullMaterialization = !profileDeltaSafe;
        }
    }

    const repositoryReader = createRepositoryRevisionReader({
        gitMirror,
        mirrorRoot,
        tenantId,
        repoSlug: identity.repoSlug,
        revision: headRevision,
        credentialRef
    });
    const entries   = await repositoryReader.listEntries();
    const collector = createProfileWriteCollector({
        extractionIdentity: derivedExtractionIdentity,
        repoSlug          : identity.repoSlug,
        rootKind
    });
    const execution = await runExtractionProfile({
        profile,
        catalogue   : extractorCatalogue,
        repositoryReader,
        hierarchyResolver,
        parserResolver,
        changedPaths: fullMaterialization ? undefined : [...new Set(diff?.addedOrChanged || [])].sort(),
        writeStream : collector.writeStream,
        createHashFn: createLegacyChunkHash
    });
    const envelope = {
        tenantId          : identity.tenantId,
        repoSlug          : identity.repoSlug,
        files             : collector.files,
        headRevision,
        extractionIdentity: derivedExtractionIdentity
    };

    if (fullMaterialization) {
        envelope.manifestSnapshot = {
            repoSlug          : identity.repoSlug,
            pathsAfterPush    : entries.map(entry => entry.sourcePath),
            yieldedSourcePaths: execution.yieldedSourcePaths,
            extractionIdentity: derivedExtractionIdentity
        }
    } else {
        const
            yielded         = new Set(execution.yieldedSourcePaths),
            stoppedYielding = [...new Set(diff?.addedOrChanged || [])]
                .filter(sourcePath => !yielded.has(sourcePath));

        envelope.deleted = [...new Set([
            ...(diff?.deleted || []),
            ...stoppedYielding
        ])]
            .sort()
            .map(sourcePath => ({sourcePath, repoSlug: identity.repoSlug}));
    }

    // `baseRevision` is deliberately NOT forwarded. The authoritative delta travels in `deleted`;
    // forwarding the base would ask IngestionService to derive the same set through a resolver with
    // no production implementation.
    return envelope
}

const TenantRepoIngestEnvelopeBuilder = {
    buildIngestEnvelope,
    createTenantRepoMaterializationDigest
};

export default TenantRepoIngestEnvelopeBuilder;

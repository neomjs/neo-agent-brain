import Base               from './Base.mjs';
import crypto             from 'crypto';
import fs                 from 'fs-extra';
import path               from 'path';
import aiConfig           from '../../../mcp/server/knowledge-base/config.mjs';
import {parseAdrRedirect} from '../../shared/adrRedirect.mjs';
import {
    ADR_FILE_REGEX,
    createCodedError,
    parseCanonicalAdrKey,
    validateAdrIdentityFields
} from '../../shared/adrIdentityCodec.mjs';
import {
    SHARED_ADR_CATALOG_STATE,
    bindSharedAdrRecordAliases,
    ensureSharedReservationBucket,
    hydrateAdrAdmissionRecords,
    isAdrReaderAuthorized,
    isReviewedAdrBaselineActive,
    registerSharedForgeRepository,
    rehydrateAdrCatalogFromEvidence,
    resetSharedAdrCatalog,
    resolveSharedAdrReference
} from '../../ingestion/adrAdmissionCatalog.mjs';
import {
    REVIEWED_ADR_CUSTODY_TRANSITIONS,
    REVIEWED_ADR_LEGACY_MANIFEST
} from '../../ingestion/adrRetainedAdmissionRecords.mjs';
import {
    buildAdmittedAdrRecord,
    computeAdrPayloadHash,
    evaluateAdrCandidateConflicts,
    extractAdrTitleAndStatus,
    parseAdrFilename,
    parseAdrOpeningAliases,
    parseAdrSupersedes,
    resolveAdrCandidateIdentity
} from '../../shared/adrDocumentParser.mjs';
import {
    EVIDENCED_ADR_TERRITORY_ROOTS,
    createAdrTerritoryRoute
} from '../helpers/coreCorpusProfilePlan.mjs';

/**
 * @summary Extracts knowledge chunks from Architecture Decision Records (ADRs) across repositories,
 * redirect paths, and evidenced territory layouts (`learn/agentos/decisions` and `learn/decisions`),
 * admitting only against retained admission evidence (`ADR` graph/SQLite records or reviewed manifests)
 * and reporting admission as unavailable when retained evidence cannot be read.
 *
 * @class Neo.ai.services.knowledge-base.source.AdrSource
 * @extends Neo.ai.services.knowledge-base.source.Base
 * @singleton
 */
class AdrSource extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.services.knowledge-base.source.AdrSource'
         * @protected
         */
        className: 'Neo.ai.services.knowledge-base.source.AdrSource',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    kbIndexedDecisions = new Map()
    redirectRegistry   = new Map()
    reconciledStates   = new Map()

    /**
     * @summary Returns the shared admitted ADR catalog shared with `AdrIngestor`.
     * @returns {Map<String, Object>}
     */
    getAdmissionCatalog() {
        return SHARED_ADR_CATALOG_STATE.admissionCatalog;
    }

    /**
     * @summary Resets the shared admitted ADR catalog and KB-local chunk/redirect tracking.
     */
    resetCatalog() {
        resetSharedAdrCatalog();
        this.kbIndexedDecisions.clear();
        this.redirectRegistry.clear();
        this.reconciledStates.clear();
    }

    /**
     * @summary Hydrates retained `adrAdmissionRecord` objects into the shared catalog.
     * @param {Object[]} [records=[]]
     * @returns {Number}
     */
    hydrateAdmissionEvidence(records = []) {
        return hydrateAdrAdmissionRecords(records);
    }

    /**
     * @summary Rehydrates the admitted catalog from explicit `retainedAdmissionRecords`, an open `graphDb`,
     * or the persisted Memory Core SQLite `Nodes` table at `aiConfig.memoryCoreDbPath` so KB extraction
     * in a process without `AdrIngestor` reads the retained admission evidence directly.
     * @param {Object} [options={}]
     * @returns {{available: Boolean, recordCount: Number, hydratedCount: Number, source: String}}
     */
    rehydrateCatalogFromEvidence(options = {}) {
        const hasExplicitSqliteOption = Boolean(
            options &&
            Object.prototype.hasOwnProperty.call(options, 'sqlitePath') &&
            options.sqlitePath !== undefined &&
            options.sqlitePath !== null
        );
        return rehydrateAdrCatalogFromEvidence({
            graphDb                 : options.graphDb || null,
            sqlitePath              : options.sqlitePath || aiConfig.memoryCoreDbPath,
            explicitSqlitePath      : hasExplicitSqliteOption,
            retainedAdmissionRecords: options.retainedAdmissionRecords || null,
            includeReviewedBaseline : options.includeReviewedBaseline !== false
        });
    }

    /**
     * @summary Registers a repository's current namespace occupancy in the shared forge directory.
     * @param {Object} repo
     */
    registerForgeRepository(repo) {
        return registerSharedForgeRepository(repo);
    }

    /**
     * @summary Records a proved repository rename in the shared catalog without rewriting canonical keys.
     * @param {Object} [params={}]
     * @returns {Object}
     */
    recordRepositoryRename({forge = 'github.com', repositoryId, previousNamespace, currentNamespace, proof} = {}) {
        if (!proof) {
            throw createCodedError(
                'ADR_UNPROVED_REPOSITORY_IDENTITY_CHANGE',
                `Repository rename '${previousNamespace}' -> '${currentNamespace}' requires continuity proof.`
            );
        }

        validateAdrIdentityFields({forge, repositoryId, namespace: previousNamespace, number: '0001'});
        validateAdrIdentityFields({forge, repositoryId, namespace: currentNamespace, number: '0001'});
        registerSharedForgeRepository({forge, repositoryId, namespace: currentNamespace, aliases: [previousNamespace]});

        const bucket = ensureSharedReservationBucket(forge, repositoryId);

        for (const record of SHARED_ADR_CATALOG_STATE.admissionCatalog.values()) {
            const touchesRepo = record.assignmentEvidence?.forge === forge && (
                record.assignmentEvidence?.repositoryId === repositoryId ||
                record.sourceTuple?.repositoryId === repositoryId ||
                record.aliasBindings.some(b => b.forge === forge && b.repositoryId === repositoryId)
            );
            if (!touchesRepo) continue;

            record.provenance.repositoryRenames.push({forge, repositoryId, previousNamespace, currentNamespace, proof});

            const existingForRepo = record.aliasBindings.filter(
                b => b.forge === forge && b.repositoryId === repositoryId && b.namespace.toLowerCase() === previousNamespace.toLowerCase()
            );

            for (const binding of existingForRepo) {
                const newBinding = {
                    kind     : binding.kind,
                    value    : binding.value,
                    forge,
                    repositoryId,
                    namespace: currentNamespace,
                    targetKey: record.canonicalKey,
                    current  : binding.current
                };
                if (!record.aliasBindings.some(b => b.kind === newBinding.kind && b.value === newBinding.value && b.namespace.toLowerCase() === currentNamespace.toLowerCase())) {
                    record.aliasBindings.push(newBinding);
                }
                bucket.aliases.set(`${newBinding.kind}:${currentNamespace.toLowerCase()}:${newBinding.value}`, newBinding);
            }
        }

        return {forge, repositoryId, previousNamespace, currentNamespace};
    }

    /**
     * @summary Resolves repository identity metadata from explicit context or the forge adapter directory.
     * @param {Object} [context={}]
     * @returns {{forge: String, repositoryId: String, namespace: String, tenantId: String|null, visibility: String, revision: String|null}|null}
     */
    resolveRepositoryIdentity(context = {}) {
        const
            rawRepo    = context?.repository || null,
            tenantId   = context?.tenantId || rawRepo?.tenantId || null,
            visibility = context?.visibility || rawRepo?.visibility || 'public',
            revision   = context?.revision || rawRepo?.revision || null;

        if (rawRepo?.repositoryId && rawRepo?.namespace) {
            const forge = rawRepo.forge || 'github.com';
            validateAdrIdentityFields({forge, repositoryId: rawRepo.repositoryId, namespace: rawRepo.namespace, number: '0001'});
            registerSharedForgeRepository({forge, repositoryId: rawRepo.repositoryId, namespace: rawRepo.namespace, aliases: rawRepo.aliases || []});
            return {forge, repositoryId: rawRepo.repositoryId, namespace: rawRepo.namespace, tenantId, visibility, revision};
        }

        if (context?.repositoryId && context?.namespace) {
            const forge = context.forge || 'github.com';
            validateAdrIdentityFields({forge, repositoryId: context.repositoryId, namespace: context.namespace, number: '0001'});
            registerSharedForgeRepository({forge, repositoryId: context.repositoryId, namespace: context.namespace});
            return {forge, repositoryId: context.repositoryId, namespace: context.namespace, tenantId, visibility, revision};
        }

        const
            forge       = context?.forge || rawRepo?.forge || 'github.com',
            rawSlug     = context?.repoSlug ? String(context.repoSlug) : null,
            candidateNs = context?.namespace || rawRepo?.namespace || (rawSlug ? (rawSlug.includes('/') ? rawSlug : `neomjs/${rawSlug}`) : null),
            forgeDir    = SHARED_ADR_CATALOG_STATE.forgeDirectory.get(forge);

        if (candidateNs && forgeDir) {
            const resolved = forgeDir.get(String(candidateNs).toLowerCase());
            if (resolved) {
                return {
                    forge       : resolved.forge,
                    repositoryId: resolved.repositoryId,
                    namespace   : resolved.currentNamespace,
                    tenantId,
                    visibility,
                    revision
                };
            }
        }

        return null;
    }

    /**
     * @summary Discovers ADR territories across the evidenced repository layouts (`learn/agentos/decisions`
     * and `learn/decisions`) without hardcoding a single path as universal or broadening private repository visibility.
     * @param {Object} [options={}]
     * @returns {Promise<{repository: Object|null, tenantId: String|null, visibility: String, matchedRoots: String[], files: Object[], route: Object}>}
     */
    async discoverRepositoryAdrTerritories(options = {}) {
        const
            territoryRoots = Array.isArray(options.territoryRoots) && options.territoryRoots.length > 0
                ? options.territoryRoots
                : EVIDENCED_ADR_TERRITORY_ROOTS,
            repository     = this.resolveRepositoryIdentity(options) || options.repository || null,
            tenantId       = options.tenantId || repository?.tenantId || null,
            visibility     = options.visibility || repository?.visibility || 'public',
            matchedRoots   = [],
            files          = [];

        if (Array.isArray(options.entries)) {
            for (const root of territoryRoots) {
                const rootFiles = options.entries
                    .map(entry => typeof entry === 'string' ? entry : entry?.sourcePath)
                    .filter(sourcePath => typeof sourcePath === 'string' && sourcePath.startsWith(`${root}/`))
                    .filter(sourcePath => ADR_FILE_REGEX.test(path.posix.basename(sourcePath)))
                    .sort();

                if (rootFiles.length > 0) {
                    matchedRoots.push(root);
                    for (const sourcePath of rootFiles) {
                        files.push({
                            root,
                            sourcePath,
                            file        : path.posix.basename(sourcePath),
                            relativePath: sourcePath.slice(root.length + 1),
                            tenantId,
                            visibility
                        });
                    }
                }
            }
        } else if (options.rootDir) {
            for (const root of territoryRoots) {
                const fullDir = path.resolve(options.rootDir, root);
                if (await fs.pathExists(fullDir)) {
                    const dirEntries = (await fs.readdir(fullDir))
                        .filter(name => ADR_FILE_REGEX.test(name))
                        .sort();
                    if (dirEntries.length > 0) {
                        matchedRoots.push(root);
                        for (const file of dirEntries) {
                            files.push({
                                root,
                                sourcePath  : path.posix.join(root, file),
                                filePath    : path.join(fullDir, file),
                                file,
                                relativePath: file,
                                tenantId,
                                visibility
                            });
                        }
                    }
                }
            }
        }

        return {
            repository,
            tenantId,
            visibility,
            matchedRoots,
            files,
            route: createAdrTerritoryRoute({
                requiredRoots: matchedRoots,
                optionalRoots: territoryRoots
            })
        };
    }

    /**
     * @summary Evaluates whether a reader context is authorized to resolve or view an admitted ADR record,
     * preserving private repository (`neomjs/neo-stage`) tenant/reader boundaries.
     * @param {Object} record
     * @param {Object} [context={}]
     * @returns {Boolean}
     */
    isReaderAuthorized(record, context = {}) {
        return isAdrReaderAuthorized(record, context);
    }

    /**
     * @summary Resolves a human (`<organization>/<repository>#adr:<slug>`, `adr:<slug>`) or canonical
     * (`adr:<E(forge)>:<E(repositoryId)>:<E(namespace)>:<number>`) ADR reference against the shared
     * admitted catalog using the same context, forge-adapter, and reader-policy controls as `AdrIngestor`.
     * @param {String} reference
     * @param {Object} [context={}]
     * @returns {Object}
     */
    resolveAdrReference(reference, context = {}) {
        this.rehydrateCatalogFromEvidence(context);

        const result = resolveSharedAdrReference(reference, context);

        if (result.resolved && result.canonicalKey) {
            const
                kbChunk     = this.kbIndexedDecisions.get(result.canonicalKey) || null,
                kbAvailable = Boolean((kbChunk || result.record?.kbAvailable) && !result.stale && result.documentAvailable);

            return {
                ...result,
                kbAvailable,
                kbChunk
            };
        }

        if (!result.resolved) {
            const raw = typeof reference === 'string' ? reference.trim() : '';
            if (raw.startsWith('adr:') && raw.split(':').length === 5) {
                try {
                    const
                        parsed     = parseCanonicalAdrKey(raw),
                        reconciled = this.reconciledStates.get(parsed.canonicalKey);
                    if (reconciled && reconciled.identityResolved && !reconciled.documentAvailable) {
                        return {
                            status           : 'retained-stale',
                            resolved         : false,
                            canonicalKey     : parsed.canonicalKey,
                            identityResolved : true,
                            documentAvailable: false,
                            kbAvailable      : false,
                            stale            : Boolean(reconciled.stale),
                            state            : reconciled.state,
                            candidates       : [parsed.canonicalKey],
                            reasonCode       : 'DOCUMENT_UNAVAILABLE'
                        };
                    }
                } catch {}
            }
        }

        return {
            ...result,
            kbAvailable: false,
            kbChunk    : null
        };
    }

    /**
     * @summary Processes a batch of candidate ADR entries (across one or multiple repositories),
     * classifying redirects, parsing opening-table `Aliases`, verifying retained admission evidence
     * before any KB emission (never admitting from source files alone), evaluating conflicts against
     * the admitted catalog, and reconciling `old-only`, `new-only`, `both-present`, `neither-present`,
     * and `interrupted/retried` states.
     * @param {Object} params
     * @returns {Object}
     * @private
     */
    #processCandidateEntries({
        rawEntries            = [],
        custodyTransitions    = [],
        sourceLineageEvidence = [],
        legacyManifest        = null,
        expectedDecisions     = [],
        retryAttempt          = 1,
        evidenceState         = null,
        writeStream           = null,
        createHashFn          = chunk => crypto.createHash('sha256').update(`${chunk.name}:${chunk.content}`).digest('hex')
    }) {
        const
            yieldedSourcePaths    = [],
            skippedSourcePaths    = [],
            redirects             = [],
            refusedSourcePaths    = [],
            admittedDecisions     = [],
            candidates            = [],
            unavailableCandidates = new Map(),
            catalog               = SHARED_ADR_CATALOG_STATE.admissionCatalog;

        for (const item of rawEntries) {
            const
                {sourcePath, file, rawContent, specRepo} = item,
                redirectInfo                             = parseAdrRedirect(rawContent);

            if (redirectInfo.isRedirect) {
                skippedSourcePaths.push({sourcePath, reason: 'redirect'});
                const redirectRecord = {
                    sourcePath,
                    file,
                    target      : redirectInfo.target,
                    valid       : redirectInfo.valid,
                    parsedTarget: redirectInfo.parsedTarget,
                    reasonCode  : redirectInfo.reasonCode,
                    repository  : specRepo || null
                };
                redirects.push(redirectRecord);
                if (redirectInfo.valid && redirectInfo.target) {
                    this.redirectRegistry.set(redirectInfo.target, redirectRecord);
                }
                continue;
            }

            let parsedFilename, aliasResult;
            try {
                parsedFilename = parseAdrFilename(file);
                aliasResult    = parseAdrOpeningAliases(rawContent);
            } catch (error) {
                const code = error.code || 'ADR_PARSE_ERROR';
                refusedSourcePaths.push({sourcePath, file, code, message: error.message});
                skippedSourcePaths.push({sourcePath, reason: code});
                continue;
            }

            const
                {adrNumber, slug}          = parsedFilename,
                {title, rawStatus, status} = extractAdrTitleAndStatus(file, rawContent),
                supersedes                 = parseAdrSupersedes(rawContent),
                identityInfo               = resolveAdrCandidateIdentity({
                    adrNumber,
                    slug,
                    sourcePath,
                    sourceRepo        : specRepo,
                    custodyTransitions: item.custodyTransitions || custodyTransitions,
                    legacyManifest    : item.legacyManifest || legacyManifest,
                    admissionCatalog  : catalog,
                    onRegisterRepo    : repo => registerSharedForgeRepository(repo)
                }),
                adr = {
                    adrNumber,
                    canonicalKey            : identityInfo.canonicalKey,
                    currentSlug             : slug,
                    hasAliasesRow           : aliasResult.hasAliasesRow,
                    hasCanonicalOpeningTable: aliasResult.hasCanonicalOpeningTable,
                    historicalAliases       : aliasResult.aliases,
                    id                      : identityInfo.canonicalKey,
                    rawStatus,
                    source                  : sourcePath,
                    status,
                    supersedes,
                    title
                };

            candidates.push({
                file,
                sourcePath,
                rawContent,
                specRepo,
                adr,
                identityInfo
            });
        }

        const
            refusedCandidates = new Set(),
            refuseCandidate   = (cand, code, message) => {
                if (refusedCandidates.has(cand)) return;
                refusedCandidates.add(cand);
                refusedSourcePaths.push({
                    sourcePath  : cand.sourcePath,
                    file        : cand.file,
                    canonicalKey: cand.adr.canonicalKey,
                    code,
                    message
                });
                skippedSourcePaths.push({sourcePath: cand.sourcePath, reason: code});
            };

        for (const cand of candidates) {
            const hasAdmissionEvidence = Boolean(
                cand.identityInfo.existingRecord ||
                cand.identityInfo.manifestEntry
            );

            if (!hasAdmissionEvidence) {
                unavailableCandidates.set(cand.adr.canonicalKey, cand);
                refuseCandidate(
                    cand,
                    'ADR_ADMISSION_EVIDENCE_UNAVAILABLE',
                    `Retained admission evidence is unavailable for '${cand.adr.canonicalKey}' (${cand.sourcePath}); AdrSource refuses to reconstruct or admit ADR authority from source files alone.`
                );
            }
        }

        const activeCandidates = candidates.filter(c => !refusedCandidates.has(c));
        if (activeCandidates.length > 0) {
            evaluateAdrCandidateConflicts({
                candidates             : activeCandidates,
                admissionCatalog       : catalog,
                ensureReservationBucket: (f, r) => ensureSharedReservationBucket(f, r),
                sourceLineageEvidence,
                legacyManifest,
                refusedCandidates,
                refuseCandidate
            });
        }

        const
            admittedByCanonicalKey = new Map(),
            reconciliation         = new Map();

        for (const cand of candidates) {
            if (refusedCandidates.has(cand)) continue;

            const
                {sourcePath, file, rawContent, specRepo, adr, identityInfo} = cand,
                effectiveRepo                                               = specRepo || (identityInfo.existingRecord?.sourceTuple?.repositoryId ? {
                    forge       : identityInfo.existingRecord.sourceTuple.forge || 'github.com',
                    repositoryId: identityInfo.existingRecord.sourceTuple.repositoryId,
                    namespace   : identityInfo.existingRecord.sourceTuple.namespace,
                    tenantId    : identityInfo.existingRecord.tenantId || null,
                    visibility  : identityInfo.existingRecord.visibility || 'public'
                } : null),
                chunk = {
                    type   : 'adr',
                    kind   : 'adr',
                    name   : path.posix.basename(file, '.md'),
                    content: rawContent.trim(),
                    source : sourcePath,
                    ...(effectiveRepo ? {
                        adrNumber   : adr.adrNumber,
                        slug        : adr.currentSlug,
                        aliases     : adr.historicalAliases,
                        canonicalKey: adr.canonicalKey,
                        title       : adr.title,
                        status      : adr.status,
                        forge       : effectiveRepo.forge || 'github.com',
                        repositoryId: effectiveRepo.repositoryId,
                        namespace   : effectiveRepo.namespace,
                        ...(effectiveRepo.revision ? {revision: effectiveRepo.revision} : {}),
                        ...(effectiveRepo.tenantId ? {tenantId: effectiveRepo.tenantId} : {}),
                        ...(effectiveRepo.visibility ? {visibility: effectiveRepo.visibility} : {})
                    } : {})
                };

            chunk.hash = createHashFn(chunk);

            const
                payloadHash = computeAdrPayloadHash(adr),
                contentHash = crypto.createHash('md5').update(`${adr.title}\n\n${rawContent}`).digest('hex'),
                record      = buildAdmittedAdrRecord({
                    existingRecord: identityInfo.existingRecord,
                    adr,
                    identityInfo,
                    specRepo      : effectiveRepo,
                    payloadHash,
                    contentHash
                });

            record.tenantId   = effectiveRepo?.tenantId || identityInfo.existingRecord?.tenantId || null;
            record.visibility = effectiveRepo?.visibility || identityInfo.existingRecord?.visibility || 'public';

            if (effectiveRepo?.namespace || record.sourceTuple?.namespace || record.assignmentEvidence?.namespace) {
                bindSharedAdrRecordAliases(record, effectiveRepo, adr, identityInfo.isCustodyMove);
            }

            catalog.set(adr.canonicalKey, record);
            this.kbIndexedDecisions.set(adr.canonicalKey, chunk);
            admittedByCanonicalKey.set(adr.canonicalKey, {cand, record, chunk});
            admittedDecisions.push({
                canonicalKey: adr.canonicalKey,
                adrNumber   : adr.adrNumber,
                slug        : adr.currentSlug,
                aliases     : adr.historicalAliases,
                sourcePath,
                repositoryId: effectiveRepo?.repositoryId || null,
                namespace   : effectiveRepo?.namespace || null,
                tenantId    : record.tenantId,
                visibility  : record.visibility
            });

            if (writeStream && typeof writeStream.write === 'function') {
                writeStream.write(JSON.stringify(chunk) + '\n');
            }
            yieldedSourcePaths.push(sourcePath);
        }

        const allTrackedKeys = new Set([
            ...admittedByCanonicalKey.keys(),
            ...unavailableCandidates.keys(),
            ...redirects.filter(r => r.valid && r.target).map(r => r.target),
            ...custodyTransitions.map(t => t.canonicalKey).filter(Boolean),
            ...expectedDecisions
        ]);

        for (const key of allTrackedKeys) {
            const
                admittedEntry   = admittedByCanonicalKey.get(key) || null,
                unavailableCand = unavailableCandidates.get(key) || null,
                redirectMatches = redirects.filter(r => r.valid && r.target === key),
                hasRedirect     = redirectMatches.length > 0,
                refusedForKey   = refusedSourcePaths.filter(r => r.canonicalKey === key),
                retainedRecord  = catalog.get(key) || null;

            if (admittedEntry) {
                const isMoved = Boolean(
                    admittedEntry.cand.identityInfo.isCustodyMove ||
                    admittedEntry.cand.identityInfo.custodyTransitionVerified
                );
                let state = 'old-only';
                if (retryAttempt > 1) {
                    state = 'interrupted/retried';
                } else if (hasRedirect && isMoved) {
                    state = 'both-present';
                } else if (isMoved) {
                    state = 'new-only';
                }

                const stateEntry = {
                    canonicalKey      : key,
                    state,
                    admissionAvailable: true,
                    identityResolved  : true,
                    documentAvailable : true,
                    kbAvailable       : true,
                    stale             : false,
                    redirectSkipped   : hasRedirect,
                    refusedCount      : refusedForKey.length,
                    retryAttempt,
                    sourcePath        : admittedEntry.cand.sourcePath,
                    repositoryId      : admittedEntry.cand.specRepo?.repositoryId || null,
                    namespace         : admittedEntry.cand.specRepo?.namespace || null
                };
                reconciliation.set(key, stateEntry);
                this.reconciledStates.set(key, stateEntry);
            } else if (unavailableCand && !retainedRecord) {
                const stateEntry = {
                    canonicalKey      : key,
                    state             : 'admission-unavailable',
                    admissionAvailable: false,
                    identityResolved  : false,
                    documentAvailable : true,
                    kbAvailable       : false,
                    stale             : false,
                    redirectSkipped   : hasRedirect,
                    refusedCount      : refusedForKey.length,
                    retryAttempt,
                    sourcePath        : unavailableCand.sourcePath,
                    repositoryId      : unavailableCand.specRepo?.repositoryId || null,
                    namespace         : unavailableCand.specRepo?.namespace || null
                };
                reconciliation.set(key, stateEntry);
                this.reconciledStates.set(key, stateEntry);
            } else {
                const identityResolved = Boolean(hasRedirect || retainedRecord);
                if (retainedRecord) {
                    retainedRecord.documentAvailable = false;
                    retainedRecord.kbAvailable       = false;
                    retainedRecord.stale             = true;
                }
                this.kbIndexedDecisions.delete(key);

                const stateEntry = {
                    canonicalKey      : key,
                    state             : refusedForKey.length > 0 ? 'both-present' : 'neither-present',
                    admissionAvailable: Boolean(retainedRecord || evidenceState?.available),
                    identityResolved,
                    documentAvailable : false,
                    kbAvailable       : false,
                    stale             : Boolean(retainedRecord),
                    redirectSkipped   : hasRedirect,
                    refusedCount      : refusedForKey.length,
                    retryAttempt,
                    sourcePath        : null,
                    repositoryId      : retainedRecord?.sourceTuple?.repositoryId || null,
                    namespace         : retainedRecord?.sourceTuple?.namespace || null
                };
                reconciliation.set(key, stateEntry);
                this.reconciledStates.set(key, stateEntry);
            }
        }

        const admissionAvailable = unavailableCandidates.size === 0 && (
            admittedByCanonicalKey.size > 0 ||
            catalog.size > 0 ||
            Boolean(evidenceState?.available)
        );

        return {
            count         : yieldedSourcePaths.length,
            admissionAvailable,
            yieldedSourcePaths,
            skippedSourcePaths,
            redirects,
            admittedDecisions,
            refusedSourcePaths,
            reconciliation: Object.fromEntries(reconciliation)
        };
    }

    /**
     * @summary Reconciles ADR decision availability across `old-only`, `new-only`, `both-present`,
     * `neither-present`, and `interrupted/retried` repository sync states against retained admission evidence,
     * distinguishing `identityResolved`, `documentAvailable`, and `kbAvailable`, and refusing undeclared duplicate full ADR claims.
     * @param {Object} [options={}]
     * @returns {Promise<Object>}
     */
    async reconcileDecisionStates({
        repositories             = [],
        custodyTransitions       = [],
        sourceLineageEvidence    = [],
        legacyManifest           = null,
        expectedDecisions        = [],
        retainedAdmissionRecords = null,
        graphDb                  = null,
        sqlitePath               = null,
        retryAttempt             = 1,
        writeStream              = null,
        createHashFn
    } = {}) {
        const
            evidenceState   = this.rehydrateCatalogFromEvidence({retainedAdmissionRecords, graphDb, sqlitePath}),
            rawEntries      = [],
            writtenChunks   = [],
            effectiveStream = writeStream || {
                write(line) {
                    writtenChunks.push(JSON.parse(String(line).trim()));
                    return true;
                }
            };

        for (const repoSpec of repositories) {
            const
                resolvedRepo = this.resolveRepositoryIdentity(repoSpec) || repoSpec.repository || null,
                filesMap     = repoSpec.files || {};

            for (const sourcePath of Object.keys(filesMap).sort()) {
                const file = path.posix.basename(sourcePath);
                if (!ADR_FILE_REGEX.test(file)) continue;
                rawEntries.push({
                    sourcePath,
                    file,
                    rawContent        : filesMap[sourcePath],
                    specRepo          : resolvedRepo,
                    custodyTransitions: repoSpec.custodyTransitions || custodyTransitions,
                    legacyManifest    : repoSpec.legacyManifest || legacyManifest
                });
            }
        }

        const result = this.#processCandidateEntries({
            rawEntries,
            custodyTransitions,
            sourceLineageEvidence,
            legacyManifest,
            expectedDecisions,
            retryAttempt,
            evidenceState,
            writeStream: effectiveStream,
            createHashFn
        });

        return {
            ...result,
            chunks: writtenChunks
        };
    }

    /**
     * Extracts knowledge chunks from ADR markdown files against retained admission evidence.
     * @param {Object}   writeStream  The JSONL write stream.
     * @param {Function} createHashFn Function to create content hash.
     * @param {Object}   [options={}] Optional repository and discovery options.
     * @returns {Promise<Number>} The number of chunks extracted.
     */
    async extract(writeStream, createHashFn, options = {}) {
        const
            evidenceState = this.rehydrateCatalogFromEvidence(options),
            rootDir       = options.rootDir || aiConfig.neoRootDir,
            specRepo      = this.resolveRepositoryIdentity(options),
            rawEntries    = [];

        if (options.discoverTerritories === true) {
            const discovered = await this.discoverRepositoryAdrTerritories({
                rootDir,
                repository    : specRepo,
                tenantId      : options.tenantId,
                visibility    : options.visibility,
                territoryRoots: options.territoryRoots
            });

            for (const item of discovered.files) {
                const rawContent = await fs.readFile(item.filePath, 'utf-8');
                rawEntries.push({
                    sourcePath: item.sourcePath,
                    file      : item.file,
                    rawContent,
                    specRepo  : discovered.repository
                });
            }
        } else {
            const adrDir = options.adrDir || path.resolve(rootDir, aiConfig.sourcePaths.AdrSource);

            if (await fs.pathExists(adrDir)) {
                const files = (await fs.readdir(adrDir)).sort();

                for (const file of files) {
                    if (!file.match(/^\d{4}-.*\.md$/)) continue;

                    const
                        filePath   = path.join(adrDir, file),
                        rawContent = await fs.readFile(filePath, 'utf-8');

                    rawEntries.push({
                        sourcePath: path.relative(rootDir, filePath),
                        file,
                        rawContent,
                        specRepo
                    });
                }
            }
        }

        const result = this.#processCandidateEntries({
            rawEntries,
            custodyTransitions   : options.custodyTransitions || (isReviewedAdrBaselineActive() ? REVIEWED_ADR_CUSTODY_TRANSITIONS : []),
            sourceLineageEvidence: options.sourceLineageEvidence || [],
            legacyManifest       : options.legacyManifest || (isReviewedAdrBaselineActive() ? REVIEWED_ADR_LEGACY_MANIFEST : null),
            expectedDecisions    : options.expectedDecisions || [],
            retryAttempt         : options.retryAttempt || 1,
            evidenceState,
            writeStream,
            createHashFn
        });

        return result.count;
    }

    /**
     * @summary Extracts top-level ADR files from one assigned repository territory against retained admission evidence.
     * @param {Object} params Repository-bound route invocation.
     * @returns {Promise<{count: Number, admissionAvailable: Boolean, yieldedSourcePaths: String[], skippedSourcePaths: Object[], redirects: Object[], admittedDecisions: Object[], refusedSourcePaths: Object[], reconciliation: Object}>}
     */
    async extractFromRepository({context, writeStream, createHashFn} = {}) {
        const reader = context?.repositoryReader;

        if (!reader || typeof reader.readText !== 'function') {
            throw new TypeError('AdrSource repository extraction requires context.repositoryReader');
        }

        const
            evidenceState = this.rehydrateCatalogFromEvidence(context || {}),
            assignments   = [...(context?.territory?.assignments || [])]
                .sort((left, right) => left.entry.sourcePath === right.entry.sourcePath
                    ? 0
                    : left.entry.sourcePath < right.entry.sourcePath ? -1 : 1),
            specRepo      = this.resolveRepositoryIdentity(context),
            rawEntries    = [],
            preSkipped    = [];

        for (const assignment of assignments) {
            const
                sourcePath = assignment.entry.sourcePath,
                file       = assignment.relativePath;

            if (typeof file !== 'string' || !/^\d{4}-[^/]*\.md$/u.test(file)) {
                preSkipped.push({sourcePath, reason: 'not-adr'});
                continue;
            }

            let rawContent;

            try {
                rawContent = await reader.readText(sourcePath);
            } catch (error) {
                if (error.code === 'KB_REVISION_READER_BINARY_BLOB') {
                    preSkipped.push({sourcePath, reason: 'binary'});
                    continue;
                }
                throw error;
            }

            rawEntries.push({
                sourcePath,
                file,
                rawContent,
                specRepo
            });
        }

        const processed = this.#processCandidateEntries({
            rawEntries,
            custodyTransitions   : context?.custodyTransitions || (isReviewedAdrBaselineActive() ? REVIEWED_ADR_CUSTODY_TRANSITIONS : []),
            sourceLineageEvidence: context?.sourceLineageEvidence || [],
            legacyManifest       : context?.legacyManifest || (isReviewedAdrBaselineActive() ? REVIEWED_ADR_LEGACY_MANIFEST : null),
            expectedDecisions    : context?.expectedDecisions || [],
            retryAttempt         : context?.retryAttempt || 1,
            evidenceState,
            writeStream,
            createHashFn
        });

        const skippedSourcePaths = [...processed.skippedSourcePaths, ...preSkipped]
            .sort((left, right) => left.sourcePath === right.sourcePath
                ? 0
                : left.sourcePath < right.sourcePath ? -1 : 1);

        return {
            count             : processed.count,
            admissionAvailable: processed.admissionAvailable,
            yieldedSourcePaths: processed.yieldedSourcePaths,
            skippedSourcePaths,
            redirects         : processed.redirects,
            admittedDecisions : processed.admittedDecisions,
            refusedSourcePaths: processed.refusedSourcePaths,
            reconciliation    : processed.reconciliation
        };
    }
}

export default Neo.setupClass(AdrSource);

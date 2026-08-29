import fs                from 'fs';
import path              from 'path';
import * as yaml         from 'js-yaml';
import { fileURLToPath } from 'url';
import crypto            from 'crypto';
import Base              from 'neo.mjs/src/core/Base.mjs';
import Json              from 'neo.mjs/src/util/Json.mjs';
import AiConfig          from '../../ai/config.mjs';
import EvolutionConfig   from './config.mjs';
import {
    createRemPhaseState,
    createRemRunStateEntry
} from '../../ai/services/memory-core/helpers/remRunStateStore.mjs';
import {bytesToTokens} from '../../ai/services/memory-core/helpers/consumerFrictionHelper.mjs';
import {
    canonicalizeSessionTurnInput,
    computeSessionTurnInputRevision,
    resolveTurnDocumentForRead
} from '../../ai/services/memory-core/helpers/turnDocumentText.mjs';
import {
    CORPUS_PROJECTION_CONSUMER,
    evaluateCorpusProjectionAdmission
} from '../../ai/services/graph/corpusProjectionContract.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

function estimatePayloadTokens(payload) {
    const text = payload === undefined || payload === null ? '' : String(payload);
    return bytesToTokens(Buffer.byteLength(text, 'utf8'));
}

function isTriVectorFailureDescriptor(value) {
    return value?.ok === false;
}

function getTriVectorFailureAttempts(failure) {
    return Number.isFinite(failure?.evidence?.attempts) ? failure.evidence.attempts : 1;
}

function getTriVectorFailureKind(failure) {
    return failure?.deferReason || failure?.frictionSymptom || 'typed-failure';
}

function getTriVectorFailureMessage(failure) {
    return failure?.evidence?.note ||
           failure?.evidence?.errorMessage ||
           `tri-vector extraction failed (${getTriVectorFailureKind(failure)})`;
}

/**
 * @summary Identifies parser-size failures that must leave the steady REM cadence immediately.
 *
 * Schema failures can still use the historical max-attempts gate; a provider-size
 * failure has already proven that re-serving the same payload just re-pays the
 * model lock cost next cycle.
 *
 * @param {Object|null} failure Typed Tri-Vector failure descriptor.
 * @returns {Boolean}
 */
function isImmediateCadenceTerminalFailure(failure) {
    return failure?.terminalForCadence === true &&
        ['size-precheck-skip', 'context-overflow'].includes(failure?.frictionSymptom);
}

/**
 * @summary Returns true for digest states excluded from the steady REM cadence.
 * @param {String} state
 * @returns {Boolean}
 */
function isSteadyCadenceExcludedDigestState(state) {
    return state === 'deferred' || state === 'undigestible';
}

/**
 * @summary Decides whether a summary row still has Dream work for its current raw-input revision.
 *
 * Revision-aware rows ignore preserved legacy booleans: completion is current only when
 * `dreamCompletedRevision` equals the synthesis-owned `dreamInputRevision`. Terminal cadence
 * states are likewise scoped by `dreamStateRevision`, so an old `undigestible` result cannot hide
 * a newly synthesized input frontier. Rows predating the revision contract retain the bounded
 * legacy boolean/state behavior.
 *
 * Retire the legacy branch after a migration audit reports zero retained summary rows without
 * `dreamInputRevision` for one complete summary-retention window.
 *
 * @param {Object} meta Session-summary metadata.
 * @returns {Boolean}
 */
function isDreamDigestPending(meta) {
    const currentRevision = typeof meta?.dreamInputRevision === 'string' && meta.dreamInputRevision
        ? meta.dreamInputRevision
        : null;

    if (currentRevision) {
        if (meta.dreamCompletedRevision === currentRevision) {
            return false;
        }

        return !(
            meta.dreamStateRevision === currentRevision &&
            isSteadyCadenceExcludedDigestState(meta.digestState)
        );
    }

    return meta?.graphDigested !== true &&
        meta?.graphDigested !== 'true' &&
        !isSteadyCadenceExcludedDigestState(meta?.digestState);
}

/**
 * @summary Reads one complete, de-duplicated raw-turn snapshot for Dream processing.
 *
 * The paging contract mirrors SessionService synthesis so both sides observe the same unbounded
 * input frontier instead of independently accepting Chroma's default result cap. Returned
 * documents are canonicalized before revision verification and are passed unchanged through the
 * remaining Dream phases.
 *
 * @param {Object} collection Memory Chroma collection.
 * @param {String} sessionId Session id to fetch.
 * @returns {Promise<{ids:String[],documents:String[],metadatas:Object[]}>}
 */
async function readSessionTurnInputSnapshot(collection, sessionId) {
    const configuredLimit = EvolutionConfig.sessionScanPageLimit;
    if (!Number.isFinite(configuredLimit)) {
        throw new Error('[RemDigestion] Required EvolutionConfig leaf "sessionScanPageLimit" is missing or invalid.');
    }

    const
        limit    = Math.max(1, Math.floor(configuredLimit)),
        snapshot = {ids: [], documents: [], metadatas: []},
        seenIds  = new Set();
    let offset = 0;

    while (true) {
        const page = await collection.get({
            where  : {sessionId},
            include: ['documents', 'metadatas'],
            limit,
            offset
        });
        const pageCount = page.ids?.length || 0;

        if (pageCount === 0) break;

        let addedThisPage = 0;

        for (let index = 0; index < pageCount; index++) {
            const id = page.ids[index];
            if (seenIds.has(id)) continue;

            const metadata = page.metadatas?.[index] || {};

            seenIds.add(id);
            snapshot.ids.push(id);
            snapshot.documents.push(resolveTurnDocumentForRead({
                documents: [page.documents?.[index]],
                metadata
            }));
            snapshot.metadatas.push(metadata);
            addedThisPage++;
        }

        if (addedThisPage === 0) break;

        offset += pageCount;
    }

    return canonicalizeSessionTurnInput(snapshot);
}

function toErrorMessage(error) {
    return error && error.message !== undefined ? String(error.message) : String(error);
}

function nonEmptyValue(value, fallback) {
    return value === undefined || value === null || value === '' ? fallback : value;
}

function getLastFailedPhase(perPhaseStates) {
    for (let i = perPhaseStates.length - 1; i >= 0; i--) {
        if (perPhaseStates[i].status === 'failed') {
            return perPhaseStates[i].phase;
        }
    }
    return 'processUndigestedSessions';
}

function resolveSessionTimestamp(meta = {}) {
    const value = meta.timestamp ?? meta.lastActivity ?? meta.updatedAt ?? meta.createdAt;

    if (Number.isFinite(value)) {
        return value;
    }

    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
        return numeric;
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function compareSessionRows(direction) {
    return (a, b) => {
        const diff = resolveSessionTimestamp(a.meta) - resolveSessionTimestamp(b.meta);

        if (diff !== 0) {
            return direction === 'ASC' ? diff : -diff;
        }

        return String(a.id).localeCompare(String(b.id));
    }
}

function addUndigestedRowsFromBatch(batch, byId) {
    if (!batch?.ids?.length) {
        return;
    }

    for (let i = 0; i < batch.ids.length; i++) {
        const meta = batch.metadatas?.[i];

        // Revision-aware rows are eligible on current/completed mismatch even when a preserved
        // legacy `graphDigested:true` or terminal state belongs to an older input frontier.
        if (meta && isDreamDigestPending(meta)) {
            byId.set(batch.ids[i], {
                id      : batch.ids[i],
                document: batch.documents?.[i],
                meta
            });
        }
    }
}

function splitFreshAndAgedUndigested(rows, maxToProcess) {
    if (maxToProcess <= 0 || rows.length === 0) {
        return [];
    }

    const undigestedSessionFreshReserve = EvolutionConfig.undigestedSessionFreshReserve;

    if (!Number.isFinite(undigestedSessionFreshReserve)) {
        throw new Error('[RemDigestion] Required EvolutionConfig leaf "undigestedSessionFreshReserve" is missing or invalid.');
    }

    const reserve  = maxToProcess > 1 ? Math.min(undigestedSessionFreshReserve, maxToProcess - 1) : maxToProcess;
    const fresh    = [...rows].sort(compareSessionRows('DESC')).slice(0, reserve);
    const freshIds = new Set(fresh.map(row => row.id));
    const aged     = [...rows]
        .filter(row => !freshIds.has(row.id))
        .sort(compareSessionRows('ASC'))
        .slice(0, maxToProcess - fresh.length);

    return [...fresh, ...aged];
}

/**
 * @summary Service for offline GraphRAG extraction ("REM Sleep").
 *
 * Scans recent session summaries from the `neo-agent-sessions` collection that have not
 * yet been formally digested into Graph Nodes and Edges. Uses the configured model provider
 * via configurable model to extract formal graph structures from episodic memories.
 *
 * @class Neo.brain.evolution.RemDigestion
 * @extends Neo.core.Base
 */
class RemDigestion extends Base {
    static config = {
        /**
         * @member {String} className='Neo.brain.evolution.RemDigestion'
         * @protected
         */
        className                     : 'Neo.brain.evolution.RemDigestion',
        storageRouter_                : null,
        lifecycleService_             : null,
        graphService_                 : null,
        logger_                       : null,
        adrIngestor_                  : null,
        conceptIngestor_              : null,
        fileSystemIngestor_           : null,
        gapInferenceEngine_           : null,
        graphMaintenanceService_      : null,
        memorySessionIngestor_        : null,
        semanticGraphExtractor_       : null,
        topologyInferenceEngine_      : null,
        providerReadiness_            : null,
        appendRemRunStateFn_          : null,
        readCorpusProjectionReceiptFn_: null,
        nowFn_                        : null,
        /**
         * @member {Object|null} sessionsCollection_=null
         * @protected
         * @reactive
         */
        sessionsCollection_: null,
        /**
         * @member {Boolean} isProcessing_=false
         * @protected
         * @reactive
         */
        isProcessing_: false
    }

    /**
     * @returns {Promise<void>}
     */
    async initAsync() {
        await super.initAsync();

        // Wait for ChromaManager to be ready (connected)
        await this.storageRouter.ready();
        this.sessionsCollection = await this.storageRouter.getSummaryCollection();

        // Inter-service dependency lock: ready() reflects the full lifecycle boot (GraphService.db
        // mounted included) — the former `_initPromise` reach-in below it was dead code, since
        // SystemLifecycleService never assigned that field.
        await this.lifecycleService.ready();
    }

    /**
     * @summary Closes one REM phase with the clock supplied by the active execution profile.
     * @param {String} phase Phase identifier.
     * @param {Number} startedAt Epoch-ms start time.
     * @param {String} status Terminal phase status.
     * @param {Object} [details={}] Phase evidence.
     * @returns {Object}
     */
    finishPhase(phase, startedAt, status, details = {}) {
        return createRemPhaseState({
            phase,
            startedAt,
            completedAt: this.nowFn(),
            status,
            details
        });
    }

    /**
     * Identifies session summaries whose current raw-input revision lacks a matching Dream
     * completion. Revision-aware rows use `dreamInputRevision === dreamCompletedRevision`; the
     * legacy `graphDigested`/terminal-state gate remains only for rows predating that contract.
     *
     * The scan samples both the fresh head and aged tail of the Chroma summary collection, then splits
     * the returned REM batch across newest and oldest undigested summaries. This mirrors the
     * miniSummary backfill pattern: keep a small fresh reserve for recent work, while the aged drain
     * steadily reaches long-lived projection lag instead of re-serving the same head window forever.
     *
     * @returns {Promise<Object[]>} List of metadata objects for undigested sessions
     */
    async findUndigestedSessions() {
        // Since ChromaDB filtering on missing attributes can be tricky depending on version,
        // filter in memory after sampling the collection head and tail. Chroma does not expose
        // SQL-style ORDER BY, so metadata timestamps define the fresh/aged split.
        const sessionScanPageLimit = EvolutionConfig.sessionScanPageLimit,
              remSleepBatchLimit   = EvolutionConfig.remSleepBatchLimit;

        if (!Number.isFinite(sessionScanPageLimit)) {
            throw new Error('[RemDigestion] Required EvolutionConfig leaf "sessionScanPageLimit" is missing or invalid.');
        }
        if (!Number.isFinite(remSleepBatchLimit)) {
            throw new Error('[RemDigestion] Required EvolutionConfig leaf "remSleepBatchLimit" is missing or invalid.');
        }

        const limit        = Math.max(1, Math.floor(sessionScanPageLimit));
        const maxToProcess = Math.max(0, Math.floor(remSleepBatchLimit));

        if (maxToProcess === 0) {
            return [];
        }

        try {
            const byId      = new Map();
            const readBatch = offset => this.sessionsCollection.get({
                include: ['metadatas', 'documents'],
                limit,
                offset
            });

            addUndigestedRowsFromBatch(await readBatch(0), byId);

            let collectionCount = null;
            if (typeof this.sessionsCollection.count === 'function') {
                try {
                    collectionCount = await this.sessionsCollection.count();
                } catch (error) {
                    this.logger.warn(`[RemDigestion] count() failed while preparing aged undigested-session scan; using head window only: ${error.message}`);
                }
            }

            const tailOffset = Number.isFinite(collectionCount) ? Math.max(0, collectionCount - limit) : 0;
            if (tailOffset > 0) {
                addUndigestedRowsFromBatch(await readBatch(tailOffset), byId);
            }

            if (byId.size === 0) {
                return [];
            }

            return splitFreshAndAgedUndigested([...byId.values()], maxToProcess);
        } catch (error) {
            this.logger.error('[RemDigestion] Error querying undigested sessions:', error);
            return [];
        }
    }

    /**
     * @summary Resolves the D2 issues-facet admission at the REM graph-commit boundary.
     * A failed admission excludes only ISSUE nodes/edges; the session's independent deterministic
     * and semantic phases continue so projection lag cannot freeze the REM pipeline.
     * @param {Object} [options]
     * @param {Object} [options.config] Corpus-projection policy; defaults to the injected Brain config.
     * @param {Function} [options.readReceipt=readCorpusProjectionReceipt]
     * @returns {Promise<Object>}
     */
    async getCorpusProjectionAdmission({
        config = AiConfig.orchestrator.corpusProjection,
        readReceipt = this.readCorpusProjectionReceiptFn
    } = {}) {
        if (!config.enabled) {
            return {
                admitted      : true,
                fallback      : 'current',
                reasonCode    : 'projection-gate-disabled',
                requiredFacets: ['issues'],
                staleFacets   : []
            }
        }

        let receipt = null;

        try {
            receipt = await readReceipt(config.receiptPath)
        } catch (error) {
            this.logger.warn(`[RemDigestion] Corpus projection receipt unavailable at REM commit: ${error.message}`)
        }

        return evaluateCorpusProjectionAdmission({
            consumer                : CORPUS_PROJECTION_CONSUMER.dreamRem,
            receipt,
            expectedSourceRepository: config.sourceRepository,
            expectedSourceRef       : config.sourceRef
        })
    }

    /**
     * @summary Runs the REM digest pipeline for sessions that are not yet marked graph-digested.
     *
     * The RemDigestion REM pipeline hydrates raw episodic memories, syncs deterministic
     * MEMORY/SESSION graph nodes via `MemorySessionIngestor`, then runs Tri-Vector semantic
     * extraction and ambient graph ingestion. Revision-aware rows first verify that the complete
     * raw-turn snapshot still matches the synthesis-published `dreamInputRevision`, then pass that
     * same immutable snapshot to deterministic ingestion. Completion records the exact processed
     * revision through a Dream-owned partial metadata update, so a late completion for A cannot
     * overwrite or hide a concurrently published B. The legacy `graphDigested` marker remains a
     * compatibility overlay and is only written after every required phase completes without
     * reported errors.
     * @param {Object} [options]
     * @param {Function} [options.fetchProviderModelIds=fetchOpenAiCompatibleModelIds] Provider-model discovery seam.
     * @param {Number} [options.cycleBudgetMs] Wall-clock budget for the session-digest loop; sessions past it
     * are deferred to the next cycle so the caller-held heavy lease releases at the task boundary. At least one
     * session is always digested per cycle. The caller owns the budget; omission/`0` disables it.
     * @param {Function} [options.nowFn=Date.now] Clock seam for the budget arithmetic; fixtures inject a
     * stepping clock while production defaults to `Date.now`.
     */
    async processUndigestedSessions({
        fetchProviderModelIds = this.providerReadiness.fetchOpenAiCompatibleModelIds,
        cycleBudgetMs         = 0,
        nowFn                 = this.nowFn
    } = {}) {
        if (this.isProcessing) {
            this.logger.debug('[RemDigestion] REM pipeline is already running. Skipping trigger.');
            return {
                perPhaseStates   : [this.finishPhase('concurrentGuard', this.nowFn(), 'skipped', {reasonCode: 'already-processing'})],
                perSessionStates : [],
                sessionsProcessed: 0,
                sessionsDeferred : 0
            };
        }

        this.isProcessing = true;
        const cycleStartedAt    = nowFn();
        const perPhaseStates    = [];
        const perSessionStates  = [];
        let   sessionsProcessed = 0,
              sessionsDeferred  = 0;

        if (AiConfig.graphProvider === 'openAiCompatible') {
            const providerStart = this.nowFn();
            try {
                await fetchProviderModelIds({
                    host      : AiConfig.openAiCompatible.host,
                    timeoutMs : AiConfig.orchestrator.providerReadiness.timeoutMs,
                    freshness : 'routine',
                    cacheTtlMs: AiConfig.orchestrator.providerReadiness.routineCacheTtlMs
                });
                perPhaseStates.push(this.finishPhase('legacyProviderProbe', providerStart, 'completed', {
                    provider: AiConfig.graphProvider
                }));
            } catch (e) {
                this.logger.error('[RemDigestion] API provider service is unreachable. Aborting REM pipeline to prevent queue failures.');
                this.isProcessing = false;
                perPhaseStates.push(this.finishPhase('legacyProviderProbe', providerStart, 'failed', {
                    provider: AiConfig.graphProvider,
                    error   : toErrorMessage(e)
                }));
                return {perPhaseStates, perSessionStates, sessionsProcessed: 0, sessionsDeferred: 0};
            }
        }

        try {
            const sessionQueryStart = this.nowFn();
            const sessions          = await this.findUndigestedSessions();
            perPhaseStates.push(this.finishPhase('sessionQuery', sessionQueryStart, 'completed', {
                sessionsFound: sessions.length
            }));

            if (sessions.length === 0) {
                this.logger.info('[RemDigestion] No undigested session memories found. Proceeding to ambient task execution.');
            } else {
                this.logger.info(`[RemDigestion] Found ${sessions.length} undigested session(s). Beginning REM pipeline...`);

                // Phase 0a: Ingest local ADRs as deterministic graph nodes before any LLM
                // extraction while keeping ADRs out of the Tri-Vector VALID_TYPES enum.
                const adrIngestStart = this.nowFn();
                try {
                    await this.adrIngestor.syncAdrsToGraph();
                    perPhaseStates.push(this.finishPhase('adrIngest', adrIngestStart, 'completed'));
                } catch (e) {
                    perPhaseStates.push(this.finishPhase('adrIngest', adrIngestStart, 'failed', {
                        error: toErrorMessage(e)
                    }));
                    throw e;
                }

                // Phase 0b: Ingest the version-controlled Concept Ontology (.neo-ai-data/concepts/*.jsonl)
                // into the Native Edge Graph as first-class CONCEPT nodes + typed edges. Runs BEFORE
                // FileSystemIngestor so downstream gap inference can traverse concept-graph relationships
                // deterministically instead of regex-matching token lists against file paths.
                const conceptIngestStart = this.nowFn();
                try {
                    await this.conceptIngestor.syncConceptsToGraph();
                    perPhaseStates.push(this.finishPhase('conceptIngest', conceptIngestStart, 'completed'));
                } catch (e) {
                    perPhaseStates.push(this.finishPhase('conceptIngest', conceptIngestStart, 'failed', {
                        error: toErrorMessage(e)
                    }));
                    throw e;
                }

                // Phase 1: Ingest Live Workspace Files for Gap Analysis context mapping
                const workspaceIngestStart = this.nowFn();
                try {
                    await this.fileSystemIngestor.syncWorkspaceToGraph();
                    perPhaseStates.push(this.finishPhase('workspaceIngest', workspaceIngestStart, 'completed'));
                } catch (e) {
                    perPhaseStates.push(this.finishPhase('workspaceIngest', workspaceIngestStart, 'failed', {
                        error: toErrorMessage(e)
                    }));
                    throw e;
                }

                for (const session of sessions) {
                    // Cycle budget: a cooperative clip at the session boundary. The lease belongs to the
                    // caller and releases when this method returns, so exceeding the budget defers the
                    // remaining sessions to the next cycle instead of holding the lane for hours — the
                    // saturated outcome re-queues it through the existing backlog catch-up. The check sits
                    // AFTER the first session so a tight budget throttles without stalling forward progress.
                    if (cycleBudgetMs > 0 && sessionsProcessed > 0 && nowFn() - cycleStartedAt >= cycleBudgetMs) {
                        sessionsDeferred = sessions.length - sessionsProcessed;
                        perPhaseStates.push(this.finishPhase('cycleBudget', nowFn(), 'completed', {
                            reasonCode: 'budget-exhausted',
                            budgetMs  : cycleBudgetMs,
                            elapsedMs : nowFn() - cycleStartedAt,
                            sessionsDeferred
                        }));
                        this.logger.info(`[RemDigestion] REM cycle budget ${cycleBudgetMs}ms exhausted after ${sessionsProcessed} session(s); deferring ${sessionsDeferred} to the next cycle.`);
                        break;
                    }

                    sessionsProcessed++;
                    this.logger.info(`[RemDigestion] Preparing session ${session.meta.sessionId} ("${session.meta.title}") for REM extraction.`);

                    const selectedDreamInputRevision = typeof session.meta.dreamInputRevision === 'string'
                        ? session.meta.dreamInputRevision
                        : null;
                    const inputRevisionStartedAt = this.nowFn();
                    let   rawEpisodicMemory      = session.document,
                        turnDocuments            = [session.document],
                        rawMemories              = null,
                        processedInputRevision   = null,
                        inputRevisionError       = null;
                    try {
                        const memoryCollection = await this.storageRouter.getMemoryCollection();
                        if (memoryCollection) {
                            rawMemories = await readSessionTurnInputSnapshot(
                                memoryCollection,
                                session.meta.sessionId
                            );
                            if (rawMemories?.documents?.length > 0) {
                                // Send the full raw memory to the LLM. Lossless context tracking is required.
                                // If local APIs crash, it is a configuration issue with n_ctx, not a client logic error.
                                turnDocuments     = rawMemories.documents;
                                rawEpisodicMemory = turnDocuments.join('\n\n---\n\n');
                            }
                        }

                        if (selectedDreamInputRevision) {
                            if (!rawMemories?.ids?.length) {
                                throw new Error('published Dream input revision has no raw-turn snapshot');
                            }

                            processedInputRevision = computeSessionTurnInputRevision(rawMemories);
                            if (processedInputRevision !== selectedDreamInputRevision) {
                                throw new Error(
                                    `Dream input revision moved before processing ` +
                                    `(${selectedDreamInputRevision} -> ${processedInputRevision})`
                                );
                            }
                        }
                    } catch (e) {
                        this.logger.warn(`[RemDigestion] Could not fetch raw memories for ${session.meta.sessionId}`, e);
                        if (selectedDreamInputRevision) {
                            inputRevisionError = e;
                        }
                    }

                    session.document      = rawEpisodicMemory;
                    session.turnDocuments = turnDocuments;
                    this.logger.info(`[RemDigestion]   -> Payload size (chars): ${session.document.length}`);

                    const sessionState = {
                        sessionId                : session.meta.sessionId,
                        payloadSizeTokens        : estimatePayloadTokens(session.document),
                        memorySessionIngest      : {status: 'skipped', errorReasons: []},
                        triVector                : {status: 'skipped', attempts: 0},
                        topology                 : {status: 'skipped', conflictCount: 0},
                        gapSession               : {status: 'skipped'},
                        corpusProjectionAdmission: null,
                        graphDigestedFlag        : false,
                        dreamInputRevision       : selectedDreamInputRevision,
                        processedInputRevision,
                        failureReasons           : []
                    };
                    perSessionStates.push(sessionState);

                    if (inputRevisionError) {
                        const error = toErrorMessage(inputRevisionError);

                        sessionState.failureReasons.push(error);
                        perPhaseStates.push(this.finishPhase('inputRevision', inputRevisionStartedAt, 'failed', {
                            sessionId: session.meta.sessionId,
                            error
                        }));
                        this.logger.warn(`[RemDigestion] Session ${session.meta.sessionId} input revision is stale or unavailable; leaving it pending.`, inputRevisionError);
                        continue;
                    }

                    // Phase 2a: Memory/Session graph ingestion — runs BEFORE SemanticGraphExtractor
                    // so future provenance edges from extracted entities attach to real
                    // MEMORY/SESSION nodes rather than dangling at `sessionId` scalars. Deterministic
                    // Chroma-ID → graph-node mapping; no LLM cost, idempotent via payloadHash.
                    const ingestStart = this.nowFn();
                    let ingestStats;
                    try {
                        ingestStats = await this.memorySessionIngestor.syncSessionToGraph(
                            session,
                            rawMemories?.ids?.length ? {rawMemories} : undefined
                        );
                    } catch (e) {
                        sessionState.memorySessionIngest = {
                            status      : 'failed',
                            errorReasons: [toErrorMessage(e)]
                        };
                        sessionState.failureReasons.push(toErrorMessage(e));
                        perPhaseStates.push(this.finishPhase('memorySessionIngest', ingestStart, 'failed', {
                            sessionId: session.meta.sessionId,
                            error    : toErrorMessage(e)
                        }));
                        this.logger.warn(`[RemDigestion] Session ${session.meta.sessionId} failed during memory/session graph ingestion; continuing REM batch.`, e);
                        continue;
                    }
                    const rawIngestErrors = Array.isArray(ingestStats.errors) ? ingestStats.errors : [];
                    const ingestErrors    = rawIngestErrors.length;
                    const ingestTime      = ((this.nowFn() - ingestStart) / 1000).toFixed(1);
                    this.logger.info(`[RemDigestion]   -> Memory/Session graph ingestion took: ${ingestTime}s (${ingestStats.memoriesUpserted} upserted, ${ingestStats.memoriesSkipped} skipped, ${ingestErrors} errors)`);

                    const ingestErrorReasons = rawIngestErrors.map(item => toErrorMessage(item));

                    sessionState.memorySessionIngest = {
                        status      : ingestErrors > 0 ? 'failed' : 'completed',
                        errorReasons: ingestErrorReasons
                    };
                    if (ingestErrors > 0) {
                        sessionState.failureReasons.push(...ingestErrorReasons);
                    }
                    perPhaseStates.push(this.finishPhase('memorySessionIngest', ingestStart, ingestErrors > 0 ? 'failed' : 'completed', {
                        sessionId       : session.meta.sessionId,
                        memoriesUpserted: ingestStats.memoriesUpserted,
                        memoriesSkipped : ingestStats.memoriesSkipped,
                        errors          : ingestErrors
                    }));

                    if (ingestErrors > 0) {
                        this.logger.warn(`[RemDigestion] Session ${session.meta.sessionId} had ${ingestErrors} memory-ingestion error(s); graphDigested will NOT be set this cycle.`);
                    }

                    const startTime = this.nowFn();
                    let extractionResult;
                    try {
                        extractionResult = await this.semanticGraphExtractor.executeTriVectorExtraction(session, {
                            beforeCommit: async () => {
                                const admissionStartedAt = this.nowFn();
                                const admission          = await this.getCorpusProjectionAdmission();

                                sessionState.corpusProjectionAdmission = admission;
                                perPhaseStates.push(this.finishPhase(
                                    'corpusProjectionAdmission',
                                    admissionStartedAt,
                                    admission.admitted ? 'completed' : 'skipped',
                                    {
                                        sessionId  : session.meta.sessionId,
                                        reasonCode : admission.reasonCode,
                                        staleFacets: admission.staleFacets
                                    }
                                ));

                                if (!admission.admitted) {
                                    this.logger.warn(
                                        `[RemDigestion] REM continuing without ISSUE projection for ` +
                                        `${session.meta.sessionId}: ${admission.reasonCode}`
                                    )
                                }

                                return {excludedNodeTypes: admission.admitted ? [] : ['ISSUE']}
                            }
                        });
                    } catch (e) {
                        sessionState.triVector = {
                            status   : 'failed',
                            attempts : 1,
                            errorKind: toErrorMessage(e)
                        };
                        sessionState.failureReasons.push(toErrorMessage(e));
                        perPhaseStates.push(this.finishPhase('triVector', startTime, 'failed', {
                            sessionId: session.meta.sessionId,
                            error    : toErrorMessage(e)
                        }));
                        this.logger.warn(`[RemDigestion] Session ${session.meta.sessionId} failed during Tri-Vector extraction; continuing REM batch.`, e);
                        continue;
                    }
                    const triVectorTime = ((this.nowFn() - startTime) / 1000).toFixed(1);
                    this.logger.info(`[RemDigestion]   -> Tri-Vector Synthesis took: ${triVectorTime}s`);
                    const extractionFailure = isTriVectorFailureDescriptor(extractionResult) ? extractionResult : null;
                    const success           = extractionResult && !extractionFailure;
                    sessionState.triVector = {
                        status   : success ? 'completed' : 'failed',
                        attempts : extractionFailure ? getTriVectorFailureAttempts(extractionFailure) : 1,
                        errorKind: success ? undefined : (extractionFailure ? getTriVectorFailureKind(extractionFailure) : 'null-result')
                    };
                    if (extractionFailure) {
                        sessionState.triVector.deferReason        = extractionFailure.deferReason;
                        sessionState.triVector.frictionSymptom    = extractionFailure.frictionSymptom;
                        sessionState.triVector.terminalForCadence = extractionFailure.terminalForCadence === true;
                        sessionState.triVector.evidence           = extractionFailure.evidence;
                    }
                    if (!success) {
                        sessionState.failureReasons.push(extractionFailure ? getTriVectorFailureMessage(extractionFailure) : 'tri-vector extraction returned null');
                    }
                    perPhaseStates.push(this.finishPhase('triVector', startTime, success ? 'completed' : 'failed', {
                        sessionId  : session.meta.sessionId,
                        deferReason: extractionFailure?.deferReason
                    }));

                    const topoStart     = this.nowFn();
                    let   conflictCount = 0,
                          topologyDetails = {};
                    try {
                        const topologyResult = await this.topologyInferenceEngine.extractTopology(session.document, session.meta.sessionId, {
                            turnDocuments: session.turnDocuments
                        });
                        conflictCount = await this.topologyInferenceEngine.getTopologyConflictCount();
                        if (topologyResult?.chunks) {
                            topologyDetails = {
                                chunks : topologyResult.chunks,
                                chunked: topologyResult.chunked
                            };
                        }
                    } catch (e) {
                        sessionState.topology = {
                            status       : 'failed',
                            conflictCount: 0
                        };
                        sessionState.failureReasons.push(toErrorMessage(e));
                        perPhaseStates.push(this.finishPhase('topology', topoStart, 'failed', {
                            sessionId: session.meta.sessionId,
                            error    : toErrorMessage(e)
                        }));
                        this.logger.warn(`[RemDigestion] Session ${session.meta.sessionId} failed during topology inference; continuing REM batch.`, e);
                        continue;
                    }
                    const topoTime = ((this.nowFn() - topoStart) / 1000).toFixed(1);
                    this.logger.info(`[RemDigestion]   -> Topological Conflicts took: ${topoTime}s`);
                    sessionState.topology = {
                        status: 'completed',
                        conflictCount,
                        ...topologyDetails
                    };
                    perPhaseStates.push(this.finishPhase('topology', topoStart, 'completed', {
                        sessionId: session.meta.sessionId,
                        conflictCount,
                        ...topologyDetails
                    }));

                    const capStart = this.nowFn();
                    try {
                        await this.inferTestGapsFromSession(success ? extractionResult : null);
                    } catch (e) {
                        sessionState.gapSession = {
                            status      : 'failed',
                            errorReasons: [toErrorMessage(e)]
                        };
                        sessionState.failureReasons.push(toErrorMessage(e));
                        perPhaseStates.push(this.finishPhase('gapSession', capStart, 'failed', {
                            sessionId: session.meta.sessionId,
                            error    : toErrorMessage(e)
                        }));
                        this.logger.warn(`[RemDigestion] Session ${session.meta.sessionId} failed during TEST_GAP inference; continuing REM batch.`, e);
                        continue;
                    }
                    const capTime = ((this.nowFn() - capStart) / 1000).toFixed(1);
                    this.logger.info(`[RemDigestion]   -> Session TEST_GAP Inference took: ${capTime}s`);
                    sessionState.gapSession = {status: 'completed'};
                    perPhaseStates.push(this.finishPhase('gapSession', capStart, 'completed', {
                        sessionId: session.meta.sessionId
                    }));

                    this.logger.info(`[RemDigestion] Total Session Digest Time: ${((this.nowFn() - startTime) / 1000).toFixed(1)}s`);

                    if (success && ingestErrors === 0) {
                        const revisionMetadata = processedInputRevision
                            ? {
                                dreamCompletedRevision: processedInputRevision,
                                dreamStateRevision    : processedInputRevision
                            }
                            : {};

                        await this.sessionsCollection.update({
                            ids      : [session.id],
                            metadatas: [{
                                graphDigested: true,
                                digestState  : 'digested',
                                ...revisionMetadata
                            }]
                        });
                        sessionState.graphDigestedFlag = true;
                        this.logger.info(`[RemDigestion] Session ${session.meta.sessionId} marked as graphDigested in Memory Core${processedInputRevision ? ` at ${processedInputRevision}` : ''}.`);
                    } else {
                        // Digest failed (typed extractor failure OR memory-ingestion errors). Bound the
                        // re-serve immediately for provider-size failures; ingestion errors and legacy
                        // bare-null returns stay retryable so a storage/transient failure never removes
                        // a digestible session from the steady cadence.
                        const priorDigestAttempts = selectedDreamInputRevision &&
                            session.meta.dreamStateRevision !== selectedDreamInputRevision
                            ? 0
                            : Number(session.meta.digestAttempts) || 0;
                        const digestAttempts    = priorDigestAttempts + 1;
                        const maxDigestAttempts = EvolutionConfig.maxDigestAttempts;
                        if (!Number.isFinite(maxDigestAttempts)) {
                            throw new Error('[RemDigestion] Required EvolutionConfig leaf "maxDigestAttempts" is missing or invalid.');
                        }
                        const terminalForCadence       = ingestErrors === 0 && extractionFailure?.terminalForCadence === true;
                        const immediateTerminalCadence = ingestErrors === 0 && isImmediateCadenceTerminalFailure(extractionFailure);
                        const deferReason              = ingestErrors > 0
                            ? 'ingestion-failure'
                            : (extractionFailure?.deferReason || 'schema-failure');
                        const digestState = immediateTerminalCadence || (terminalForCadence && digestAttempts >= maxDigestAttempts)
                            ? 'undigestible'
                            : 'undigested';

                        await this.sessionsCollection.update({
                            ids      : [session.id],
                            metadatas: [{
                                digestState,
                                digestAttempts,
                                deferReason,
                                ...(processedInputRevision
                                    ? {dreamStateRevision: processedInputRevision}
                                    : {})
                            }]
                        });
                        sessionState.digestState        = digestState;
                        sessionState.deferReason        = deferReason;
                        sessionState.digestAttempts     = digestAttempts;
                        sessionState.terminalForCadence = terminalForCadence;

                        if (digestState === 'undigestible') {
                            this.logger.warn(`[RemDigestion] Session ${session.meta.sessionId} marked 'undigestible' after ${digestAttempts} failed digest attempt(s) (reason: ${deferReason}); excluded from the steady REM cadence to stop the re-serve bleed.`);
                        } else {
                            this.logger.info(`[RemDigestion] Session ${session.meta.sessionId} digest failed (reason: ${deferReason}); attempt ${digestAttempts}/${maxDigestAttempts}, will retry next cycle.`);
                        }
                    }
                }

                // Neural Link action digest is cycle-scoped: it reads the shared forward audit
                // ledger once per REM cycle and adds weak runtime-interaction evidence without
                // erasing TEST_GAPs or synthesizing permanent Playwright coverage.
                const nlActionDigestStart = this.nowFn();
                try {
                    const nlActionDigest = await this.executeNLActionDigest();
                    this.logger.info(`[RemDigestion] Cycle-scope NL_ACTION Digest took: ${((this.nowFn() - nlActionDigestStart) / 1000).toFixed(1)}s`);
                    perPhaseStates.push(this.finishPhase(
                        'nlActionDigest',
                        nlActionDigestStart,
                        nlActionDigest?.status === 'skipped' ? 'skipped' : 'completed',
                        nlActionDigest
                    ));
                } catch (e) {
                    perPhaseStates.push(this.finishPhase('nlActionDigest', nlActionDigestStart, 'failed', {
                        error: toErrorMessage(e)
                    }));
                    throw e;
                }

                // Concept-graph gap inference is ontology-scoped: the output is identical
                // for every invocation within a single REM cycle, so running it once after
                // the session loop replaces redundant traversals.
                const conceptGapStart = this.nowFn();
                try {
                    await this.inferConceptGraphGaps();
                    this.logger.info(`[RemDigestion] Cycle-scope GUIDE_GAP / EXAMPLE_GAP Inference took: ${((this.nowFn() - conceptGapStart) / 1000).toFixed(1)}s`);
                    perPhaseStates.push(this.finishPhase('conceptGap', conceptGapStart, 'completed'));
                } catch (e) {
                    perPhaseStates.push(this.finishPhase('conceptGap', conceptGapStart, 'failed', {
                        error: toErrorMessage(e)
                    }));
                    throw e;
                }
            }

            // Universal Fade (Garbage Collection)
            const garbageCollectionStart = this.nowFn();
            try {
                await this.runGarbageCollection();
                perPhaseStates.push(this.finishPhase('garbageCollection', garbageCollectionStart, 'completed'));
            } catch (e) {
                perPhaseStates.push(this.finishPhase('garbageCollection', garbageCollectionStart, 'failed', {
                    error: toErrorMessage(e)
                }));
                throw e;
            }

            this.logger.info('[RemDigestion] REM pipeline completed.');
            return {perPhaseStates, perSessionStates, sessionsProcessed, sessionsDeferred};
        } catch (error) {
            this.logger.error('[RemDigestion] Failed to process undigested sessions:', error);
            error.remState = {perPhaseStates, perSessionStates};
            throw error;
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * @summary Unified canonical REM (Sandman) cycle entrypoint returning a typed cycle outcome envelope.
     *
     * The orchestrator periodic dream path previously mapped every non-throwing return
     * from `processUndigestedSessions()` to `completed`, hiding zero-session no-ops,
     * concurrent-invocation guards, and provider-unreachable early returns. This method
     * returns one of `completed | skipped | failed` so consumers route each path to
     * the correct task-state / health-telemetry surface.
     *
     * **Outcome status semantics:**
     * - `completed` — provider was ready, undigested sessions existed, processing finished
     *   without throw. `sessionsProcessed` carries the pre-call count.
     * - `skipped`   — ran successfully but did no work (concurrent-invocation guard,
     *   zero undigested sessions, dry-run). `skipReason` carries the diagnostic string.
     * - `failed`    — provider readiness gate rejected OR an in-pipeline throw was caught.
     *   Either `diagnostic` (for provider failure) or `error` (for throws) is populated.
     *
     * **Lease ownership stays with the caller.** The orchestrator periodic dream path
     * runs inside `MaintenanceBackpressureService`'s lease; the standalone Sandman CLI
     * runner acquires its own lease via `withHeavyMaintenanceLease`. Re-acquiring inside
     * this method would double-lease and deadlock, so this method is intentionally
     * lease-agnostic.
     *
     * @param {Object}  [options]
     * @param {String}  [options.reason]            Coordination string for logging + state model (e.g. `periodic-dream:3600000`).
     * @param {String}  [options.mode='periodic']   `'periodic' | 'manual' | 'cli'`.
     * @param {Boolean} [options.includeDecay=true] When true, runs `GraphService.decayGlobalTopology()` as the cycle-finalization step (24-hour Algorithmic Lock self-skips when not due).
     * @param {Boolean} [options.dryRun=false]      Probe-only mode; short-circuits to `skipped` after the readiness gate passes.
     * @param {Number}  [options.cycleBudgetMs=0]   Caller-owned session-digest wall-clock budget; `0` disables.
     * @param {Number}  options.configuredCadenceMs Caller-owned scheduler cadence for run-state evidence.
     * @param {Number}  options.overflowThreshold   Caller-owned cadence-overflow ratio.
     * @param {Function} [options.nowFn]            Clock seam for the budget arithmetic, forwarded to `processUndigestedSessions`.
     * @returns {Promise<Object>} typed outcome envelope (see status semantics above).
     */
    async executeRemCycle({
        reason,
        mode         = 'periodic',
        includeDecay = true,
        dryRun       = false,
        cycleBudgetMs = 0,
        configuredCadenceMs,
        overflowThreshold,
        nowFn
    } = {}) {
        const startedAtMs      = this.nowFn();
        const startedAt        = new Date(startedAtMs);
        const runId            = `rem-${crypto.randomUUID()}`;
        const perPhaseStates   = [];
        let   perSessionStates = [];

        const baseOutcome = {
            runId,
            reason,
            mode,
            startedAt        : startedAt.toISOString(),
            completedAt      : null,
            durationMs       : null,
            sessionsProcessed: null,
            sessionsDeferred : null,
            remBatchLimit    : null,
            remBatchSaturated: false,
            diagnostic       : null,
            skipReason       : null,
            error            : null
        };

        const finalize = async (status, extras = {}) => {
            const completedAtMs = this.nowFn();
            const completedAt   = new Date(completedAtMs).toISOString();
            const durationMs    = completedAtMs - startedAtMs;
            const outcome       = {
                ...baseOutcome,
                ...extras,
                status,
                completedAt,
                durationMs
            };

            try {
                const stateEntry = createRemRunStateEntry({
                    runId,
                    reason,
                    startedAt    : startedAtMs,
                    completedAt  : completedAtMs,
                    configuredCadenceMs,
                    overflowThreshold,
                    outcome      : status,
                    reasonCode   : nonEmptyValue(extras.reasonCode, status),
                    failurePhase : nonEmptyValue(extras.failurePhase, null),
                    failureReason: nonEmptyValue(extras.failureReason, nonEmptyValue(extras.error?.message, nonEmptyValue(extras.diagnostic?.reason, null))),
                    perPhaseStates,
                    perSessionStates
                });

                outcome.cycleOverflowSignal = stateEntry.cycleOverflowSignal;
                outcome.configuredCadenceMs = stateEntry.configuredCadenceMs;
                outcome.overflowThreshold   = overflowThreshold;
                outcome.wallClockMs         = stateEntry.wallClockMs;

                await this.appendRemRunStateFn(stateEntry, {dir: AiConfig.remRunStateDir, retentionLimit: EvolutionConfig.remRunRetentionLimit});
            } catch (e) {
                this.logger.error('[RemDigestion] Failed to write REM run state:', e);
                outcome.stateWriteError = toErrorMessage(e);
            }

            return outcome;
        };

        // Provider gate: abort with rich diagnostic when the configured graph provider
        // is unsupported or unreachable. Downstream pipeline calls would silently no-op
        // on missing provider; the typed `failed` envelope surfaces the root cause to
        // operator-facing health telemetry instead.
        let gate;
        const providerStart = this.nowFn();
        try {
            gate = await this.checkProviderReadiness();
            perPhaseStates.push(this.finishPhase('providerReady', providerStart, gate.ready ? 'completed' : 'failed', {
                diagnostic: nonEmptyValue(gate.diagnostic, null)
            }));
        } catch (e) {
            perPhaseStates.push(this.finishPhase('providerReady', providerStart, 'failed', {
                error: toErrorMessage(e)
            }));
            const message = toErrorMessage(e);
            return await finalize('failed', {
                reasonCode  : 'provider-readiness-threw',
                failurePhase: 'providerReady',
                error       : {message: `checkProviderReadiness threw: ${message}`, stack: e?.stack}
            });
        }
        if (!gate.ready) {
            return await finalize('failed', {
                reasonCode   : 'provider-unreachable',
                failurePhase : 'providerReady',
                failureReason: gate.diagnostic?.reason,
                diagnostic   : gate.diagnostic
            });
        }

        // Dry-run short-circuit: used by callers that want to verify readiness without
        // running the pipeline (e.g. operator probes, smoke tests).
        if (dryRun) {
            perPhaseStates.push(this.finishPhase('dryRun', this.nowFn(), 'skipped', {reasonCode: 'dry-run'}));
            return await finalize('skipped', {reasonCode: 'dry-run', skipReason: 'dry-run requested'});
        }

        // Concurrent-invocation guard: exposes the in-flight state as a stage outcome
        // rather than the prior debug-only log line that hid double-fires from operator
        // health telemetry.
        if (this.isProcessing) {
            perPhaseStates.push(this.finishPhase('concurrentGuard', this.nowFn(), 'skipped', {reasonCode: 'already-processing'}));
            return await finalize('skipped', {
                reasonCode: 'already-processing',
                skipReason: 'remDigestion.isProcessing already true (concurrent invocation)'
            });
        }

        // Pre-count query: distinguishes the no-work `skipped` path from the
        // work-completed `completed` path without requiring a return-value refactor on
        // processUndigestedSessions. A pre-call query is cheaper than the alternative
        // of inspecting graph state after the fact.
        let sessionCount  = 0,
            remBatchLimit = null;
        const sessionQueryStart = this.nowFn();
        try {
            const undigested         = await this.findUndigestedSessions();
            const remSleepBatchLimit = EvolutionConfig.remSleepBatchLimit;
            if (!Number.isFinite(remSleepBatchLimit)) {
                throw new Error('[RemDigestion] Required EvolutionConfig leaf "remSleepBatchLimit" is missing or invalid.');
            }
            sessionCount = Array.isArray(undigested) ? undigested.length : 0;
            remBatchLimit = Math.max(0, Math.floor(remSleepBatchLimit));
            perPhaseStates.push(this.finishPhase('sessionQuery', sessionQueryStart, 'completed', {sessionsFound: sessionCount}));
        } catch (e) {
            const message = toErrorMessage(e);
            perPhaseStates.push(this.finishPhase('sessionQuery', sessionQueryStart, 'failed', {error: message}));
            return await finalize('failed', {
                reasonCode  : 'session-query-failed',
                failurePhase: 'sessionQuery',
                error       : {message: `findUndigestedSessions threw: ${message}`, stack: e?.stack}
            });
        }

        // No-work path: still run decay (it self-skips when the 24-hour Algorithmic
        // Lock isn't due) so decay cadence is not coupled to session-arrival cadence.
        if (sessionCount === 0) {
            if (includeDecay) {
                const decayStart = this.nowFn();
                try {
                    await this.graphService.decayGlobalTopology();
                    perPhaseStates.push(this.finishPhase('decay', decayStart, 'completed', {sessionsProcessed: 0}));
                } catch (e) {
                    const message = toErrorMessage(e);
                    perPhaseStates.push(this.finishPhase('decay', decayStart, 'failed', {error: message}));
                    return await finalize('failed', {
                        reasonCode       : 'decay-failed',
                        failurePhase     : 'decay',
                        error            : {message: `decayGlobalTopology threw on zero-session path: ${message}`, stack: e?.stack},
                        sessionsProcessed: 0
                    });
                }
            }
            return await finalize('skipped', {
                reasonCode       : 'no-undigested-sessions',
                sessionsProcessed: 0,
                remBatchLimit,
                remBatchSaturated: false,
                skipReason       : 'no undigested sessions'
            });
        }

        // Work path: process sessions, then run decay as the cycle-finalization step
        // under the same lease window the caller already holds.
        try {
            const processStart  = this.nowFn();
            const processResult = await this.processUndigestedSessions({cycleBudgetMs, nowFn});
            if (Array.isArray(processResult?.perPhaseStates)) {
                perPhaseStates.push(...processResult.perPhaseStates);
            }
            const actualSessionsProcessed  = processResult?.sessionsProcessed ?? sessionCount;
            const sessionsDeferredByBudget = processResult?.sessionsDeferred ?? 0;
            perPhaseStates.push(this.finishPhase('processUndigestedSessions', processStart, 'completed', {
                sessionsProcessed: actualSessionsProcessed
            }));
            perSessionStates = Array.isArray(processResult?.perSessionStates) ? processResult.perSessionStates : [];

            if (includeDecay) {
                const decayStart = this.nowFn();
                try {
                    await this.graphService.decayGlobalTopology();
                    perPhaseStates.push(this.finishPhase('decay', decayStart, 'completed', {sessionsProcessed: sessionCount}));
                } catch (e) {
                    perPhaseStates.push(this.finishPhase('decay', decayStart, 'failed', {
                        error: toErrorMessage(e)
                    }));
                    throw e;
                }
            }

            // A budget-clipped cycle reports saturated exactly like a count-clipped one: proven-remaining
            // backlog routes through the same catch-up cooldown, and the distinct reasonCode keeps the two
            // clip causes separable in run-state telemetry.
            return await finalize('completed', {
                reasonCode       : sessionsDeferredByBudget > 0 ? 'budget-clipped' : 'ok',
                sessionsProcessed: actualSessionsProcessed,
                sessionsDeferred : sessionsDeferredByBudget,
                remBatchLimit,
                remBatchSaturated: (remBatchLimit > 0 && sessionCount >= remBatchLimit) || sessionsDeferredByBudget > 0
            });
        } catch (e) {
            if (e.remState) {
                if (Array.isArray(e.remState.perPhaseStates)) {
                    perPhaseStates.push(...e.remState.perPhaseStates);
                }
                perSessionStates = Array.isArray(e.remState.perSessionStates) ? e.remState.perSessionStates : [];
            }

            const failedPhase = getLastFailedPhase(perPhaseStates);

            return await finalize('failed', {
                reasonCode       : 'extraction-failed',
                failurePhase     : failedPhase,
                sessionsProcessed: sessionCount,
                error            : {message: toErrorMessage(e), stack: e?.stack}
            });
        }
    }

    /**
     * @summary Probes the configured graph provider before invoking a graph-heavy REM cycle.
     *
     * Returns `{ready: true}` when the configured provider answers the HTTP probe,
     * `{ready: false, diagnostic}` when the provider is unsupported or the readiness
     * loop exhausts its retry budget. The diagnostic envelope carries the full
     * provider-failure context (provider name, host, model, attempts, elapsedMs,
     * nextAction prose) so callers can surface it through observability telemetry
     * without the operator tailing logs.
     *
     * Probe parameters flow from the injected Brain config's `orchestrator.providerReadiness` verbatim
     * (no module-level fallbacks per the config-as-SSOT contract). Daemon-context
     * invocations suppress the dot-progress writer used by the CLI runner.
     *
     * @returns {Promise<{ready: true} | {ready: false, diagnostic: Object}>}
     */
    async checkProviderReadiness() {
        const readinessConfig = this.providerReadiness.assertProviderReadinessConfig(AiConfig.orchestrator.providerReadiness);
        const target          = this.providerReadiness.getGraphProviderReadinessTarget();

        if (!target.supported) {
            return {
                ready     : false,
                diagnostic: this.providerReadiness.createProviderFailureDiagnostic({
                    reason: 'UNSUPPORTED_GRAPH_PROVIDER'
                })
            };
        }

        const waitResult = await this.providerReadiness.waitForProvider({
            attempts                : readinessConfig.attempts,
            delayMs                 : readinessConfig.delayMs,
            timeoutMs               : readinessConfig.timeoutMs,
            modelDiscoveryFreshness : 'routine',
            modelDiscoveryCacheTtlMs: readinessConfig.routineCacheTtlMs,
            output                  : {write: () => {}}
        });

        if (!waitResult.running) {
            return {
                ready     : false,
                diagnostic: this.providerReadiness.createProviderFailureDiagnostic({waitResult})
            };
        }

        const ollamaReadinessConfig = this.providerReadiness.buildOllamaReadinessConfig(AiConfig);
        const capacity              = ollamaReadinessConfig.roles.length > 0
            ? await this.providerReadiness.ensureOllamaModelsReady({
                ...ollamaReadinessConfig,
                attempts    : readinessConfig.attempts,
                delayMs     : readinessConfig.delayMs,
                timeoutMs   : readinessConfig.timeoutMs,
                allowPartial: true
            })
            : await this.providerReadiness.warnProviderParallelModelCapacity({
                config                  : AiConfig,
                timeoutMs               : readinessConfig.timeoutMs,
                modelDiscoveryFreshness : 'routine',
                modelDiscoveryCacheTtlMs: readinessConfig.routineCacheTtlMs
            });

        if (capacity?.degraded) {
            return {
                ready     : false,
                capacity,
                diagnostic: this.providerReadiness.createProviderFailureDiagnostic({
                    reason: 'PROVIDER_MODEL_RESIDENCY_DEGRADED',
                    capacity
                })
            };
        }

        return {ready: true, capacity};
    }

    /**
     * Cycle-scoped GUIDE_GAP / EXAMPLE_GAP inference entry point. Delegates to
     * `GapInferenceEngine` for deterministic concept-graph edge traversal (`EXPLAINED_BY` /
     * `EXEMPLIFIED_BY`). Output depends only on ontology state, not on any individual session —
     * invoked once per REM cycle after the per-session loop, before `runGarbageCollection`.
     * Paired with `inferTestGapsFromSession` (session-scoped) to keep ontology-wide
     * and session-specific gap checks separated.
     */
    async inferConceptGraphGaps() {
        return this.gapInferenceEngine.inferConceptGraphGaps();
    }

    /**
     * Cycle-scoped Neural Link action digest entry point. Delegates to `GapInferenceEngine`
     * for deterministic `nl_action_log` inspection and weak `NL_ACTION_SEQUENCE -> VALIDATES`
     * evidence edges. Invoked once per REM cycle after the per-session TEST_GAP pass and before
     * concept-graph gap inference; it never removes TEST_GAPs because live agent interaction is
     * weaker than durable Playwright coverage.
     */
    async executeNLActionDigest() {
        return this.gapInferenceEngine.inferNlActionDigest();
    }

    /**
     * Session-scoped TEST_GAP inference entry point. Delegates to `GapInferenceEngine` for
     * structural-node (CLASS / METHOD / COMPONENT) test-file coverage checks keyed to the
     * current session's artifact. Invoked inside the REM loop once per session.
     * Paired with `inferConceptGraphGaps` (cycle-scoped) to keep ontology-wide
     * and session-specific gap checks separated.
     * @param {Object} payload The parsed Tri-Vector schema from `SemanticGraphExtractor`
     */
    async inferTestGapsFromSession(payload) {
        return this.gapInferenceEngine.inferTestGapsFromSession(payload);
    }

    /**
     * Executes the global "Fade" algorithm across all Native Graph edges,
     * then executes Vector Apoptosis to clean up resulting orphaned nodes from the hybrid semantic space.
     */
    async runGarbageCollection() {
        return this.graphMaintenanceService.runGarbageCollection();
    }

}

export default Neo.setupClass(RemDigestion);

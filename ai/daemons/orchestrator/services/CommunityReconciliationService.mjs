import Base         from 'neo.mjs/src/core/Base.mjs';
import {randomUUID} from 'node:crypto';

const RESOURCE_FAMILIES = ['issues', 'pulls', 'discussions'];

/** @summary Resolves a registration's GitHub display locator without accepting a URL or path. */
function parseLocator(locator) {
    const match = typeof locator === 'string' && locator.match(/^([^/\s]+)\/([^/\s]+)$/);
    return match ? {owner: match[1], repo: match[2]} : null
}

/** @summary Projects only receipt identifiers and measured counts, never provider content. */
function safeRow(registration, resourceFamily, result = {}, batch = null, receipt = null, now = Date.now(), providerCalls = null) {
    const coverage = receipt?.coverage ?? batch?.coverage;
    return {
        sourceInstanceId : registration.sourceInstanceId,
        resourceFamily,
        registrationEpoch: registration.registrationEpoch,
        status           : result?.status || 'failed',
        attempts         : result?.attempts || 0,
        providerCalls,
        receiptId        : receipt?.receiptId ?? null,
        checkpointVersion: receipt?.nextCheckpointVersion ?? null,
        observationCount : receipt?.observationCount ?? batch?.observations?.length ?? null,
        coverageGaps     : coverage ? (Array.isArray(coverage.gaps) ? coverage.gaps.length : 0) : null,
        coverageComplete : typeof coverage?.complete === 'boolean' ? coverage.complete : null,
        receiptAgeMs     : Number.isFinite(receipt?.admittedAt) ? Math.max(0, now - receipt.admittedAt) : null,
        reasonCode       : result?.reason ?? null
    }
}

/**
 * @summary Coordinates registered GitHub community-family reconciliation without owning provider,
 * tenant, policy, checkpoint, or durable-admission authority.
 * @class Neo.ai.daemons.services.CommunityReconciliationService
 * @extends Neo.core.Base
 * @singleton
 */
class CommunityReconciliationService extends Base {
    static config = {
        /** @member {String} className='Neo.ai.daemons.services.CommunityReconciliationService' */
        className: 'Neo.ai.daemons.services.CommunityReconciliationService',
        /** @member {Boolean} singleton=true */
        singleton: true
    }

    /**
     * @summary Reconciles the current tenant's active sources with attempt-local exact admission retries.
     * Every fresh family pass generates a new batch identity. No captured batch escapes this call;
     * shadow mode reports the acquired metadata without invoking durable admission.
     * @param {Object} [options] Explicit mode, source selectors, attempt policy, and test collaborators.
     * @returns {Promise<Object>} Per-partition status with bounded metadata and observed receipt counts.
     */
    async runOnce({
        mode = 'manual', sourceInstanceIds = null, maxAdmissionAttempts,
        registryService, admissionService, reconcilers, graphqlService, now = Date.now, uuid
    } = {}) {
        if (!['manual', 'shadow'].includes(mode)) throw new TypeError('COMMUNITY_RECONCILIATION_MODE_INVALID');

        if (maxAdmissionAttempts === undefined) {
            const {default: AiConfig} = await import('../../../config.mjs');
            maxAdmissionAttempts = AiConfig.orchestrator.communityReconciliation.maxAdmissionAttempts;
        }
        if (!Number.isInteger(maxAdmissionAttempts) || maxAdmissionAttempts < 1) {
            throw new TypeError('COMMUNITY_RECONCILIATION_MAX_ADMISSION_ATTEMPTS_REQUIRED')
        }
        const defaults = await this.#loadDefaults({registryService, admissionService, reconcilers, graphqlService, uuid});
        ({registryService, admissionService, reconcilers, graphqlService, uuid} = defaults);
        await Promise.all([registryService.ready?.(), admissionService.ready?.(), graphqlService?.ready?.(),
            ...Object.values(reconcilers).map(reconciler => reconciler?.ready?.())]);

        const tenantId = registryService.resolveTenantId?.();
        if (!tenantId) return {status: 'failed', reasonCode: 'COMMUNITY_RECONCILIATION_TENANT_UNBOUND',
            mode, sourceCount: 0, results: [], startedAt: now(), completedAt: now()};

        const registrations = registryService.listRegistrations();
        const selected      = sourceInstanceIds === null
            ? registrations.filter(registration => registration.provider === 'github' && registration.canonicalProviderHost === 'github.com' && registration.resourceKind === 'repository')
            : sourceInstanceIds.map(id => registrations.find(registration => registration.sourceInstanceId === id));
        if (selected.some(registration => !registration)) throw new Error('COMMUNITY_RECONCILIATION_UNKNOWN_SOURCE');
        if (selected.some(registration => registration.provider !== 'github' || registration.canonicalProviderHost !== 'github.com' || registration.resourceKind !== 'repository')) {
            throw new Error('COMMUNITY_RECONCILIATION_UNSUPPORTED_SOURCE')
        }

        const startedAt = now(), results = [];
        for (const registration of selected) {
            if (registration.lifecycleState !== 'ACTIVE') {
                results.push(safeRow(registration, null, {status: 'skipped', reason: 'SOURCE_NOT_ACTIVE'}));
                continue
            }
            const locator = parseLocator(registration.displayLocator);
            if (!locator) {
                results.push(safeRow(registration, null, {status: 'failed', reason: 'SOURCE_LOCATOR_INVALID'}));
                continue
            }

            for (const resourceFamily of RESOURCE_FAMILIES) {
                let current;
                try { current = registryService.getRegistration(registration.sourceInstanceId) }
                catch {
                    results.push(safeRow(registration, resourceFamily, {status: 'failed', reason: 'REGISTRATION_READ_FAILED'}));
                    continue
                }
                if (!current || current.registrationEpoch !== registration.registrationEpoch || current.displayLocator !== registration.displayLocator || current.lifecycleState !== 'ACTIVE') {
                    results.push(safeRow(registration, resourceFamily, {status: 'skipped', reason: 'SOURCE_REGISTRATION_CHANGED'}));
                    continue
                }
                const reconciler = reconcilers[resourceFamily];
                if (!reconciler?.reconcile) {
                    results.push(safeRow(registration, resourceFamily, {status: 'skipped', reason: 'SOURCE_ADAPTER_UNAVAILABLE'}));
                    continue
                }

                let capturedBatch = null, attempts = 0, providerCalls = graphqlService ? 0 : null;
                // Count connector calls, not inferred pages: one GraphQL response can contain
                // several connection pages. Provider-internal HTTP retries are not counted here.
                const measuredProvider = graphqlService ? {
                    query: (...args) => { providerCalls++; return graphqlService.query(...args) },
                    rest : (...args) => { providerCalls++; return graphqlService.rest(...args) }
                } : undefined;
                const boundRegistry = {
                    getRegistration: id => {
                        const fence = registryService.getRegistration(id);
                        return fence?.lifecycleState === 'ACTIVE' && fence.registrationEpoch === registration.registrationEpoch && fence.displayLocator === registration.displayLocator ? fence : null
                    }
                };
                const decoratedAdmission = {
                    getCheckpoint   : (...args) => admissionService.getCheckpoint(...args),
                    listObservations: (...args) => admissionService.listObservations(...args),
                    admitBatch      : async batch => {
                        capturedBatch = batch;
                        if (mode === 'shadow') return {status: 'shadow', receipt: {observationCount: batch.observations.length, coverage: batch.coverage}};
                        while (attempts < maxAdmissionAttempts) {
                            attempts++;
                            try { return await admissionService.admitBatch(batch) }
                            catch (error) { if (attempts >= maxAdmissionAttempts) throw error }
                        }
                    }
                };
                try {
                    const outcome = await reconciler.reconcile({
                        sourceInstanceId: registration.sourceInstanceId,
                        resourceFamily,
                        owner           : locator.owner,
                        repo            : locator.repo,
                        batchId         : uuid(),
                        observedAt      : new Date(now()).toISOString(),
                        admissionService: decoratedAdmission,
                        graphqlService  : measuredProvider,
                        registryService : boundRegistry
                    });
                    const receipt = outcome?.receipt || (capturedBatch && admissionService.getReceipt?.(registration.sourceInstanceId, resourceFamily, capturedBatch.batchId)) || null;
                    results.push(safeRow(registration, resourceFamily, {...outcome, attempts}, capturedBatch, receipt, now(), providerCalls));
                } catch {
                    results.push(safeRow(registration, resourceFamily, {status: 'failed', attempts,
                        reason: capturedBatch ? 'ADMISSION_OUTCOME_UNOBSERVED' : 'ACQUISITION_FAILED'}, capturedBatch, null, now(), providerCalls));
                }
            }
        }
        const unsuccessful = results.filter(row => !['accepted', 'idempotent', 'shadow', 'skipped'].includes(row.status)).length;
        const allSkipped   = results.length > 0 && results.every(row => row.status === 'skipped');
        return {status: !results.length || allSkipped ? 'skipped' : unsuccessful === results.length ? 'failed' : unsuccessful ? 'partial' : 'completed', mode, sourceCount: selected.length, results, startedAt, completedAt: now()}
    }

    /**
     * @summary Binds the deployment-owned tenant for a scheduled run and settles task/health state.
     * Runtime policy is read at its use site; source registrations and admission policy stay with
     * their existing owners. Only the sanitized outcome is persisted, never a pending batch.
     * @param {Object} options Existing Orchestrator task collaborators.
     * @returns {Promise<Object>}
     */
    async runTask({taskName, reason, taskStateService, healthService, writeLog} = {}) {
        const [{default: AiConfig}, {default: RequestContextService}] = await Promise.all([
            import('../../../config.mjs'), import('../../../mcp/server/shared/services/RequestContextService.mjs')
        ]);
        const tenantId = AiConfig.orchestrator.communityReconciliation.tenantId;
        if (!tenantId) {
            const result = {status: 'skipped', reasonCode: 'COMMUNITY_RECONCILIATION_TENANT_UNCONFIGURED'};
            taskStateService?.markSkipped?.(taskName, result);
            healthService?.recordTaskOutcome?.(taskName, 'skipped', result);
            return result
        }
        taskStateService?.markStarted?.(taskName, reason);
        try {
            const result = await RequestContextService.run({userId: tenantId}, () => this.runOnce());
            if (result.status === 'completed') taskStateService?.markCompleted?.(taskName, result);
            else if (result.status === 'skipped') taskStateService?.markSkipped?.(taskName, result);
            else taskStateService?.markFailed?.(taskName, 1, result);
            healthService?.recordTaskOutcome?.(taskName, result.status === 'partial' ? 'failed' : result.status, {...result, reason});
            writeLog?.('INFO', `[CommunityReconciliation] ${result.status}: ${result.sourceCount} source(s).`);
            return result
        } catch {
            const result = {status: 'failed', mode: 'periodic', reasonCode: 'COMMUNITY_RECONCILIATION_FAILED', sourceCount: null, results: []};
            taskStateService?.markFailed?.(taskName, 1, result);
            healthService?.recordTaskOutcome?.(taskName, 'failed', {...result, reason});
            return result
        }
    }

    /** @summary Loads provider/storage owners lazily; injected collaborators remain hermetic. */
    async #loadDefaults({registryService, admissionService, reconcilers, graphqlService, uuid}) {
        if (registryService && admissionService && reconcilers) {
            return {registryService, admissionService, reconcilers, graphqlService, uuid: uuid || randomUUID}
        }
        const [{default: Registry}, {default: Admission}, {default: Issues}, {default: Pulls}, {default: Discussions}, {default: Graphql}] = await Promise.all([
            import('../../../services/memory-core/SourceRegistryService.mjs'),
            import('../../../services/memory-core/CommunityBatchAdmissionService.mjs'),
            import('../../../services/github-workflow/IssueReconciliationService.mjs'),
            import('../../../services/github-workflow/PullRequestReconciliationService.mjs'),
            import('../../../services/github-workflow/DiscussionReconciliationService.mjs'),
            import('../../../services/github-workflow/GraphqlService.mjs')
        ]);
        return {
            registryService : registryService || Registry,
            admissionService: admissionService || Admission,
            reconcilers     : reconcilers || {issues: Issues, pulls: Pulls, discussions: Discussions},
            graphqlService  : graphqlService || Graphql,
            uuid            : uuid || randomUUID
        }
    }
}

export default Neo.setupClass(CommunityReconciliationService);

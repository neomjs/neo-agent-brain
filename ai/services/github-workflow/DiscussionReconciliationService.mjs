import Base                                      from 'neo.mjs/src/core/Base.mjs';
import CommunityBatchAdmissionService            from '../memory-core/CommunityBatchAdmissionService.mjs';
import GraphqlService                            from './GraphqlService.mjs';
import SourceRegistryService                     from '../memory-core/SourceRegistryService.mjs';
import {assembleIssueBatch}                      from './community/assembleIssueBatch.mjs';
import {classifyAbsences, deletionToObservation} from './community/githubIssueAbsence.mjs';
import {reconcileDiscussionActivity}             from './community/githubDiscussionReconciliation.mjs';
import {
    FETCH_RECONCILE_DISCUSSIONS, FETCH_RECONCILE_DISCUSSION_COMMENTS,
    FETCH_RECONCILE_DISCUSSION_REPLIES, FETCH_RECONCILE_DISCUSSION_CENSUS,
    FETCH_RECONCILE_DISCUSSION_CONTENT_EDIT_HEADS, FETCH_RECONCILE_DISCUSSION_CONTENT_EDITS,
    FETCH_RECONCILE_DISCUSSION_CONTENT_REVISIONS
} from './queries/discussionReconciliationQueries.mjs';

/**
 * @summary Reconciles visible Discussion creations and revisions into neutral durable admission.
 * Comments and nested replies have independent pagination; missing deletion/lifecycle history stays
 * explicit in coverage. The local/hosted coordinator owns scheduling and the admission policy, just
 * as for the issue and PR siblings. This family adapter never grants wake or Task authority.
 * @class Neo.ai.services.github-workflow.DiscussionReconciliationService
 * @extends Neo.core.Base
 * @singleton
 */
class DiscussionReconciliationService extends Base {
    static config = {
        /** @member {String} className='Neo.ai.services.github-workflow.DiscussionReconciliationService' */
        className: 'Neo.ai.services.github-workflow.DiscussionReconciliationService',
        /** @member {Boolean} singleton=true */
        singleton: true
    }

    /**
     * @summary Reconciles one ACTIVE source and submits a metadata-only batch for durable admission.
     * The checkpoint is a CAS basis, never a root resume cursor. Provider calls and admission are
     * injected for local/hosted composition; this adapter owns no scheduling or attention policy.
     * @param {Object} spec Source identity, owner/repo, batchId, and optional observedAt.
     * @param {Object} [spec.pageSizes] Root/child/edit provider page sizes.
     * @param {Object} [spec.caps] Optional honest work caps consumed by the runner.
     * @param {Function} [spec.acquireDeletionEvidence] Explicit provider evidence for vanished IDs.
     * @param {Object} [spec.admissionService] Sole checkpoint owner.
     * @param {Object} [spec.graphqlService] Provider acquisition dependency.
     * @param {Object} [spec.registryService] Server-authoritative source registry.
     * @returns {Promise<Object>} The admission receipt, including a conflict when its basis is stale.
     */
    async reconcile({
        sourceInstanceId, resourceFamily = 'discussions', owner, repo, batchId, observedAt,
        pageSizes = {}, caps = {}, acquireDeletionEvidence = async () => ({}), admissionService = CommunityBatchAdmissionService,
        graphqlService = GraphqlService, registryService = SourceRegistryService
    }) {
        const registration = registryService.getRegistration(sourceInstanceId);
        if (!registration || registration.lifecycleState !== 'ACTIVE') throw new Error('DISCUSSION_RECONCILIATION_SOURCE_NOT_ACTIVE');
        const checkpoint       = admissionService.getCheckpoint(sourceInstanceId, resourceFamily),
              prior            = admissionService.listObservations(sourceInstanceId),
              seams            = this.#buildSeams({graphqlService, owner, repo, ...pageSizes}),
              result           = await reconcileDiscussionActivity(seams, caps),
              currentInventory = result.currentInventory,
              currentEntities  = result.currentEntityInventory,
              creates          = new Map(prior
                  .filter(item => ['discussion.opened', 'discussion.comment', 'discussion.reply'].includes(item.occurrenceKind))
                  .map(item => [item.providerEntityId, item])),
              currentSet       = new Set(currentEntities),
              priorIds         = [...creates.keys()],
              vanished         = priorIds.filter(id => !currentSet.has(id)),
              absences         = classifyAbsences(priorIds, currentEntities,
                  vanished.length ? await acquireDeletionEvidence(vanished) : {});

        // The injected provider-proof seam is the only authority for a vanished entity's deletion.
        // Without evidence, disappearance remains an access gap and never erases admitted history.
        const deletionObservations = absences.deleted.map(deletion => {
            const priorCreate = creates.get(deletion.providerEntityId),
                  kind        = priorCreate?.occurrenceKind === 'discussion.comment'
                      ? 'discussion.comment-deleted'
                      : priorCreate?.occurrenceKind === 'discussion.reply'
                      ? 'discussion.reply-deleted'
                      : 'discussion.deleted',
                  observation = deletionToObservation(deletion, {occurrenceKind: kind, observedAt: observedAt ?? new Date().toISOString()});

            return {...observation, parentProviderEntityId: priorCreate?.parentProviderEntityId ?? null}
        });

        result.observations.push(...deletionObservations);

        return admissionService.admitBatch(assembleIssueBatch({
            sourceInstanceId, resourceFamily, registrationEpoch: registration.registrationEpoch,
            baseCheckpointVersion: checkpoint?.checkpointVersion ?? 0,
            baseInventoryHash    : checkpoint?.inventoryHash ?? null,
            runnerResult         : result, absences: {...absences, deleted: []}, currentInventory, batchId,
            observedAt           : observedAt ?? new Date().toISOString(),
            adapterSchemaVersion : 'github-discussion.v1', providerStateSchemaVersion: 'github-discussion-state.v1'
        }))
    }

    /**
     * @summary Adapts independent metadata-only GraphQL connections to the pure runner contract.
     * @param {Object} options Provider dependency, repository coordinates and page sizes.
     * @returns {Object} Acquisition and verification seams.
     */
    #buildSeams({graphqlService, owner, repo, rootPage = 50, childPage = 50, editPage = 100}) {
        const query = (document, variables) => graphqlService.query(document, variables);
        return {
            fetchDiscussionsPage: async ({cursor}) => {
                const c = (await query(FETCH_RECONCILE_DISCUSSIONS, {owner, repo, after: cursor, rootPage}))?.repository?.discussions;
                return {discussions: c?.nodes ?? [], pageInfo: c?.pageInfo, totalCount: c?.totalCount}
            },
            fetchCommentsPage: async ({discussionId, cursor}) => {
                const node = (await query(FETCH_RECONCILE_DISCUSSION_COMMENTS, {discussionId, after: cursor, childPage}))?.node;
                return {id: node?.id, updatedAt: node?.updatedAt, comments: node?.comments}
            },
            fetchRepliesPage: async ({commentId, cursor}) => {
                const node = (await query(FETCH_RECONCILE_DISCUSSION_REPLIES, {commentId, after: cursor, childPage}))?.node;
                return {id: node?.id, updatedAt: node?.updatedAt, replies: node?.replies}
            },
            fetchContentEditHeads: ({entities}) => this.#fetchEntityNodes({entities, query, document: FETCH_RECONCILE_DISCUSSION_CONTENT_EDIT_HEADS, editPage, verifyCreatedAt: true}),
            fetchContentEditsPage: async ({entityNodeId, cursor}) => (await query(FETCH_RECONCILE_DISCUSSION_CONTENT_EDITS, {entityId: entityNodeId, after: cursor, editPage}))?.node,
            verifyContentEntities: ({entities}) => this.#fetchEntityNodes({entities, query, document: FETCH_RECONCILE_DISCUSSION_CONTENT_REVISIONS}),
            fetchCensusPage      : async ({cursor}) => {
                const c = (await query(FETCH_RECONCILE_DISCUSSION_CENSUS, {owner, repo, after: cursor, rootPage}))?.repository?.discussions;
                return {discussions: c?.nodes ?? [], pageInfo: c?.pageInfo, totalCount: c?.totalCount}
            }
        }
    }

    /**
     * @summary Reads bounded node batches and restores input order while refusing missing, duplicate
     * or changed identities. One malformed batch rejects its members, never a guessed empty result.
     * @param {Object} options Entities, query operation and revision-verification mode.
     * @returns {Promise<Object[]>} One settled result per input entity.
     */
    async #fetchEntityNodes({entities, query, document, editPage, verifyCreatedAt = false}) {
        const outcomes = new Array(entities.length);
        for (let offset = 0; offset < entities.length; offset += 100) {
            const batch = entities.slice(offset, offset + 100), ids = batch.map(entity => entity.nodeId ?? entity.id);
            try {
                const nodes = (await query(document, {ids, ...(editPage ? {editPage} : {})}))?.nodes;
                if (!Array.isArray(nodes) || nodes.length !== batch.length) throw new Error('DISCUSSION_RECONCILIATION_ENTITY_BATCH_INVALID');
                const byId = new Map();
                nodes.forEach(node => { if (!node?.id || byId.has(node.id)) throw new Error('DISCUSSION_RECONCILIATION_ENTITY_BATCH_INVALID'); byId.set(node.id, node) });
                batch.forEach((entity, index) => {
                    const node = byId.get(ids[index]);
                    if (!node || !['Discussion', 'DiscussionComment'].includes(node.__typename) || node.updatedAt !== entity.updatedAt || (verifyCreatedAt && node.createdAt !== entity.createdAt)) {
                        outcomes[offset + index] = {status: 'rejected', reason: `DISCUSSION_RECONCILIATION_CONTENT_MUTATED:${entity.id}`};
                    } else outcomes[offset + index] = {status: 'fulfilled', value: node};
                });
            } catch (error) { batch.forEach((_, index) => outcomes[offset + index] = {
                status: 'rejected', reason: error instanceof Error ? error.message : String(error)
            }) }
        }
        return outcomes
    }
}

export default Neo.setupClass(DiscussionReconciliationService);

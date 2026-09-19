import {setup} from '../../../../setup.mjs';

setup({
    neoConfig: {unitTestMode: true},
    appConfig: {name: 'DiscussionReconciliationServiceTest'}
});

import {test, expect}                  from '@playwright/test';
import Neo                             from 'neo.mjs/src/Neo.mjs';
import * as core                       from 'neo.mjs/src/core/_export.mjs';
import DiscussionReconciliationService from '../../../../../../ai/services/github-workflow/DiscussionReconciliationService.mjs';
import {validateBatch}                 from '../../../../../../ai/services/memory-core/communityBatchContract.mjs';

test.describe('DiscussionReconciliationService.reconcile', () => {
    const editConnection = nodes => ({totalCount: nodes.length, nodes, pageInfo: {hasNextPage: false, endCursor: null}});

    const root = (overrides = {}) => ({
        id               : 'D_1',
        number           : 1,
        closed           : true,
        closedAt         : '2026-09-20T09:05:00Z',
        createdAt        : '2026-09-20T09:00:00Z',
        updatedAt        : '2026-09-20T09:10:00Z',
        lastEditedAt     : null,
        authorAssociation: 'CONTRIBUTOR',
        author           : {login: 'external-root', __typename: 'User'},
        comments         : {totalCount: 1},
        ...overrides
    });

    const comment = (overrides = {}) => ({
        id               : 'DC_1',
        createdAt        : '2026-09-20T09:01:00Z',
        updatedAt        : '2026-09-20T09:02:00Z',
        lastEditedAt     : null,
        deletedAt        : null,
        authorAssociation: 'MEMBER',
        author           : {login: 'neo-gpt', __typename: 'User'},
        discussion       : {id: 'D_1'},
        replyTo          : null,
        replies          : {totalCount: 1},
        ...overrides
    });

    const reply = (overrides = {}) => ({
        id               : 'DR_1',
        createdAt        : '2026-09-20T09:03:00Z',
        updatedAt        : '2026-09-20T09:04:00Z',
        lastEditedAt     : '2026-09-20T09:04:00Z',
        deletedAt        : null,
        authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
        author           : {login: 'external-reply', __typename: 'User'},
        discussion       : {id: 'D_1'},
        replyTo          : {id: 'DC_1'},
        ...overrides
    });

    const edit = (id, editedAt, editor = null) => ({id, editedAt, editor});

    const entityHead = entity => ({
        id                 : entity.id,
        __typename         : entity.id === 'D_1' ? 'Discussion' : 'DiscussionComment',
        createdAt          : entity.createdAt,
        updatedAt          : entity.updatedAt,
        lastEditedAt       : entity.lastEditedAt,
        includesCreatedEdit: false,
        userContentEdits   : editConnection(entity.lastEditedAt
            ? [edit(`UCE_${entity.id}`, entity.lastEditedAt, {login: 'editor', __typename: 'User'})]
            : []),
        ...(entity.comments ? {comments: {totalCount: entity.comments.totalCount}} : {}),
        ...(entity.replies ? {replies: {totalCount: entity.replies.totalCount}} : {})
    });

    const makeGraphql = ({roots = [root()], comments = [comment()], replies = [reply()], failReplies = false} = {}) => {
        const calls = [];
        return {
            calls,
            query: async (document, variables) => {
                expect(document).not.toMatch(/\b(?:body|bodyHTML|bodyText|title|diff|excerpt)\b/);
                calls.push({document, variables});

                if (document.includes('ReconcileDiscussions(')) {
                    return {repository: {discussions: {totalCount: roots.length, nodes: roots, pageInfo: {hasNextPage: false, endCursor: 'ROOT_END'}}}}
                }
                if (document.includes('ReconcileDiscussionComments')) {
                    return {node: {id: roots[0]?.id, updatedAt: roots[0]?.updatedAt, comments: {
                        totalCount: comments.length, nodes: comments, pageInfo: {hasNextPage: false, endCursor: 'COMMENTS_END'}
                    }}}
                }
                if (document.includes('ReconcileDiscussionReplies')) {
                    if (failReplies) throw new Error('DISCUSSION_PROVIDER_PERMISSION_DENIED');
                    const parent = comments.find(value => value.id === variables.commentId) ?? comments[0];
                    return {node: {id: parent?.id, updatedAt: parent?.updatedAt, replies: {
                        totalCount: replies.length, nodes: replies, pageInfo: {hasNextPage: false, endCursor: 'REPLIES_END'}
                    }}}
                }
                if (document.includes('ReconcileDiscussionContentEditHeads')) {
                    const entities = [...roots, ...comments, ...replies], byId = new Map(entities.map(entity => [entity.id, entityHead(entity)]));
                    return {nodes: variables.ids.map(id => byId.get(id) ?? null)}
                }
                if (document.includes('ReconcileDiscussionContentRevisions')) {
                    const entities = [...roots, ...comments, ...replies], byId = new Map(entities.map(entity => [entity.id, entityHead(entity)]));
                    return {nodes: variables.ids.map(id => byId.get(id) ?? null)}
                }
                if (document.includes('ReconcileDiscussionContentEdits')) {
                    throw new Error('unexpected edit continuation')
                }
                if (document.includes('ReconcileDiscussionCensus')) {
                    return {repository: {discussions: {totalCount: roots.length, nodes: roots.map(value => ({
                        id: value.id, updatedAt: value.updatedAt, comments: {totalCount: value.comments.totalCount}
                    })), pageInfo: {hasNextPage: false, endCursor: 'CENSUS_END'}}}}
                }
                throw new Error('unexpected GraphQL operation')
            }
        }
    };

    const registryActive = {getRegistration: () => ({lifecycleState: 'ACTIVE', registrationEpoch: 7})};
    const makeAdmission  = (overrides = {}) => ({
        getCheckpoint   : () => null,
        listObservations: () => [],
        admitBatch(batch) { this.admitted = batch; return {status: 'accepted', receipt: {receiptId: 'discussion-r'}} },
        ...overrides
    });
    const runSpec = {
        sourceInstanceId: 'source-discussion', owner: 'neomjs', repo: 'neo', batchId: 'discussion-batch',
        observedAt      : '2026-09-20T12:00:00Z'
    };

    test('refuses an inactive source before any provider request', async () => {
        const graphqlService = makeGraphql();

        await expect(DiscussionReconciliationService.reconcile({
            ...runSpec, graphqlService, admissionService: makeAdmission(), registryService: {getRegistration: () => ({lifecycleState: 'REVOKED'})}
        })).rejects.toThrow('DISCUSSION_RECONCILIATION_SOURCE_NOT_ACTIVE');
        expect(graphqlService.calls).toEqual([]);
    });

    test('admits the closed-root nested-reply edit even when the root timestamp is unchanged', async () => {
        const graphqlService = makeGraphql(), admissionService = makeAdmission();

        const receipt = await DiscussionReconciliationService.reconcile({...runSpec, graphqlService, admissionService, registryService: registryActive});
        const batch   = admissionService.admitted;

        expect(receipt.status).toBe('accepted');
        expect(validateBatch(batch)).toEqual({valid: true, errors: []});
        expect(batch.observations.find(item => item.occurrenceKind === 'discussion.reply-edited')).toMatchObject({
            providerEntityId: 'DR_1', parentProviderEntityId: 'DC_1', occurrenceCoordinate: 'UCE_DR_1'
        });
        const rootCalls = graphqlService.calls.filter(call => call.document.includes('ReconcileDiscussions('));
        expect(rootCalls[0].variables).toMatchObject({owner: 'neomjs', repo: 'neo', after: null, rootPage: 50});
    });

    test('batches content-head and verification node requests at 100 entities', async () => {
        const comments = Array.from({length: 101}, (_, index) => comment({
            id: `DC_${index}`, replies: {totalCount: 0}, updatedAt: '2026-09-20T09:02:00Z'
        }));
        const rootWithManyComments = root({comments: {totalCount: comments.length}});
        const graphqlService       = makeGraphql({roots: [rootWithManyComments], comments, replies: []}), admissionService = makeAdmission();

        await DiscussionReconciliationService.reconcile({...runSpec, graphqlService, admissionService, registryService: registryActive, pageSizes: {childPage: 200}});

        const batchedCalls = graphqlService.calls.filter(call =>
            call.document.includes('ContentEditHeads') || call.document.includes('ContentRevisions'));

        expect(batchedCalls).toHaveLength(4);
        expect(batchedCalls.every(call => call.variables.ids.length <= 100)).toBe(true);
        expect(batchedCalls.map(call => call.variables.ids.length).sort((a, b) => a - b)).toEqual([2, 2, 100, 100]);
    });

    test('provider permission loss lowers coverage without admitting a deletion', async () => {
        const graphqlService = makeGraphql({failReplies: true}), admissionService = makeAdmission();

        await DiscussionReconciliationService.reconcile({...runSpec, graphqlService, admissionService, registryService: registryActive});

        expect(admissionService.admitted.coverage.complete).toBe(false);
        expect(admissionService.admitted.coverage.gaps).toEqual(expect.arrayContaining([
            expect.objectContaining({axis: 'discussion-conversation', reason: 'DISCUSSION_PROVIDER_PERMISSION_DENIED'})
        ]));
        expect(admissionService.admitted.observations.some(item => item.absence === 'deleted')).toBe(false);
    });

    test('unproven root/comment/reply absence is only an access gap', async () => {
        const graphqlService   = makeGraphql({roots: [], comments: [], replies: []});
        const admissionService = makeAdmission({
            listObservations: () => [
                {providerEntityId: 'D_old', occurrenceKind: 'discussion.opened'},
                {providerEntityId: 'DC_old', occurrenceKind: 'discussion.comment', parentProviderEntityId: 'D_old'},
                {providerEntityId: 'DR_old', occurrenceKind: 'discussion.reply', parentProviderEntityId: 'DC_old'}
            ]
        });

        await DiscussionReconciliationService.reconcile({...runSpec, graphqlService, admissionService, registryService: registryActive});

        expect(admissionService.admitted.observations.some(item => item.absence === 'deleted')).toBe(false);
        expect(admissionService.admitted.coverage.gaps).toEqual(expect.arrayContaining([
            {axis: 'inventory-access', providerEntityId: 'D_old'},
            {axis: 'inventory-access', providerEntityId: 'DC_old'},
            {axis: 'inventory-access', providerEntityId: 'DR_old'}
        ]));
    });

    test('provider deletion evidence creates typed root/comment/reply tombstones with parent preservation', async () => {
        const prior = [
            {providerEntityId: 'D_old', occurrenceKind: 'discussion.opened'},
            {providerEntityId: 'DC_old', occurrenceKind: 'discussion.comment', parentProviderEntityId: 'D_old'},
            {providerEntityId: 'DR_old', occurrenceKind: 'discussion.reply', parentProviderEntityId: 'DC_old'}
        ];
        const admissionService = makeAdmission({listObservations: () => prior});

        await DiscussionReconciliationService.reconcile({
            ...runSpec,
            graphqlService         : makeGraphql({roots: [], comments: [], replies: []}),
            admissionService,
            registryService        : registryActive,
            acquireDeletionEvidence: async ids => Object.fromEntries(ids.map(id => [id, {deletedAt: '2026-09-20T12:00:00Z'}]))
        });

        const tombstones = admissionService.admitted.observations.filter(item => item.absence === 'deleted');
        expect(tombstones.map(item => item.occurrenceKind)).toEqual([
            'discussion.deleted', 'discussion.comment-deleted', 'discussion.reply-deleted'
        ]);
        expect(tombstones.find(item => item.providerEntityId === 'DC_old').parentProviderEntityId).toBe('D_old');
        expect(tombstones.find(item => item.providerEntityId === 'DR_old').parentProviderEntityId).toBe('DC_old');
    });

    test('returns an admission conflict without a second checkpoint write', async () => {
        let   checkpointReads  = 0, writes = 0;
        const admissionService = makeAdmission({
            getCheckpoint : () => { checkpointReads++; return {checkpointVersion: 4, inventoryHash: 'basis'} },
            admitBatch    : () => ({status: 'conflict', reason: 'STALE_BASIS'}),
            saveCheckpoint: () => { writes++ }
        });

        const receipt = await DiscussionReconciliationService.reconcile({
            ...runSpec, graphqlService: makeGraphql(), admissionService, registryService: registryActive
        });

        expect(receipt).toEqual({status: 'conflict', reason: 'STALE_BASIS'});
        expect(checkpointReads).toBe(1);
        expect(writes).toBe(0);
    });
});

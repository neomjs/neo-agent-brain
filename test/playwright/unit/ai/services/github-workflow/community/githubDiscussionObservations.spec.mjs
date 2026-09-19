import {setup} from '../../../../../setup.mjs';

setup({
    neoConfig: {unitTestMode: true},
    appConfig: {name: 'GithubDiscussionObservationsTest'}
});

import {test, expect}                        from '@playwright/test';
import Neo                                   from 'neo.mjs/src/Neo.mjs';
import * as core                             from 'neo.mjs/src/core/_export.mjs';
import {BATCH_SCHEMA_VERSION, validateBatch} from '../../../../../../../ai/services/memory-core/communityBatchContract.mjs';
import {classifyAttention}                   from '../../../../../../../ai/services/memory-core/communityAttentionClassifier.mjs';
import {discussionToObservations}            from '../../../../../../../ai/services/github-workflow/community/githubDiscussionObservations.mjs';

test.describe('githubDiscussionObservations normalizer', () => {
    const discussion = {
        id               : 'D_1',
        createdAt        : '2026-09-20T09:00:00Z',
        updatedAt        : '2026-09-20T10:00:00Z',
        lastEditedAt     : '2026-09-20T09:10:00Z',
        authorAssociation: 'CONTRIBUTOR',
        author           : {login: 'external-root', __typename: 'User'},
        contentEdits     : [{id: 'UCE_D_1', editedAt: '2026-09-20T09:10:00Z', editor: {login: 'editor', __typename: 'User'}}],
        comments         : [{
            id               : 'DC_1',
            createdAt        : '2026-09-20T09:20:00Z',
            updatedAt        : '2026-09-20T09:25:00Z',
            lastEditedAt     : '2026-09-20T09:25:00Z',
            authorAssociation: 'MEMBER',
            author           : {login: 'neo-gpt', __typename: 'User'},
            contentEdits     : [{id: 'UCE_DC_1', editedAt: '2026-09-20T09:25:00Z', editor: {login: 'neo-gpt', __typename: 'User'}}],
            replies          : [{
                id               : 'DR_1',
                createdAt        : '2026-09-20T09:30:00Z',
                updatedAt        : '2026-09-20T09:35:00Z',
                lastEditedAt     : '2026-09-20T09:35:00Z',
                authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
                author           : {login: 'external-reply', __typename: 'User'},
                contentEdits     : [{id: 'UCE_DR_1', editedAt: '2026-09-20T09:35:00Z', editor: null}]
            }, {
                id               : 'DR_2',
                createdAt        : '2026-09-20T09:40:00Z',
                updatedAt        : '2026-09-20T09:40:00Z',
                lastEditedAt     : null,
                authorAssociation: 'NONE',
                author           : {login: 'provider-bot', __typename: 'Bot'},
                contentEdits     : []
            }]
        }]
    };

    const batchAround = observations => ({
        schemaVersion             : BATCH_SCHEMA_VERSION,
        sourceInstanceId          : 'src-discussion',
        resourceFamily            : 'discussions',
        adapterSchemaVersion      : 'github-discussion.v1',
        providerStateSchemaVersion: 'github-discussion-state.v1',
        registrationEpoch         : 1,
        baseCheckpointVersion     : 0,
        baseInventoryHash         : null,
        batchId                   : 'batch-discussion',
        observations,
        nextProviderState         : {discussionsCursor: 'end', rootCount: 1},
        nextInventoryHash         : 'inv-discussion',
        coverage                  : {fromBasis: 'genesis', toBasis: 'end', complete: true}
    });

    test('emits stable root, comment, reply, revision, and unexplained snapshot facts without prose', () => {
        const observations = discussionToObservations(discussion),
              kinds        = observations.map(observation => observation.occurrenceKind);

        expect(kinds).toEqual([
            'discussion.opened',
            'discussion.edited',
            'discussion.comment',
            'discussion.comment-edited',
            'discussion.reply',
            'discussion.reply-edited',
            'discussion.reply',
            'discussion.observed-snapshot-change'
        ]);
        expect(observations.find(observation => observation.providerEntityId === 'DC_1')).toMatchObject({
            parentProviderEntityId: 'D_1',
            occurrenceCoordinate  : 'DC_1:created'
        });
        expect(observations.find(observation => observation.providerEntityId === 'DR_1' && observation.occurrenceKind === 'discussion.reply'))
            .toMatchObject({parentProviderEntityId: 'DC_1', occurrenceCoordinate: 'DR_1:created'});
        expect(observations.find(observation => observation.occurrenceCoordinate === 'UCE_DR_1'))
            .toMatchObject({revisionOf: 'DR_1:created', actorId: null, actorKind: 'unknown'});
        expect(validateBatch(batchAround(observations))).toEqual({valid: true, errors: []});
        expect(JSON.stringify(observations)).not.toMatch(/title|body|excerpt|diff/i);
    });

    test('uses the shared attention classifier without choosing eligibility in the adapter', () => {
        const observations = discussionToObservations(discussion),
              policy       = {
                  responseBearingKinds: ['discussion.opened', 'discussion.comment', 'discussion.reply'],
                  rosteredActorIds    : ['neo-gpt']
              },
              root         = observations.find(observation => observation.providerEntityId === 'D_1'),
              internal      = observations.find(observation => observation.providerEntityId === 'DC_1'),
              bot           = observations.find(observation => observation.providerEntityId === 'DR_2');

        expect(root).toMatchObject({actorKind: 'user', sourceAssociation: 'CONTRIBUTOR'});
        expect(classifyAttention(root, policy)).toEqual({disposition: 'eligible', reason: 'external-response-bearing'});
        expect(classifyAttention(internal, policy)).toEqual({disposition: 'ineligible', reason: 'rostered-actor'});
        expect(classifyAttention(bot, policy)).toEqual({disposition: 'ineligible', reason: 'bot-not-attention-eligible-v1'});
    });

    test('emits a deletion only from explicit provider deletedAt evidence', () => {
        const observations = discussionToObservations({
            ...discussion,
            comments: [{...discussion.comments[0], deletedAt: '2026-09-20T09:50:00Z'}]
        });

        expect(observations.find(observation => observation.occurrenceKind === 'discussion.comment-deleted')).toMatchObject({
            providerEntityId: 'DC_1',
            absence         : 'deleted',
            actorKind       : 'unknown',
            deletionEvidence: {deletedAt: '2026-09-20T09:50:00Z'}
        });
        expect(discussionToObservations(discussion).some(observation => observation.occurrenceKind.endsWith('-deleted'))).toBe(false);
    });

    test('a closed root retains external reply attention and excludes popularity/prose input', () => {
        const source = structuredClone(discussion);
        source.closed = true;
        source.closedAt = '2026-09-20T09:01:00Z';
        source.title = source.body = 'UNTRUSTED_PROVIDER_PROSE';
        source.upvoteCount = 42;
        source.timeline = [{id: 'POPULARITY', __typename: 'StarredEvent', title: source.title}];
        source.comments[0].body = source.body;
        source.comments[0].replies[0].body = source.body;
        source.comments[0].replies[0].contentEdits[0].editor = {login: 'external-reply', __typename: 'User'};
        const observations = discussionToObservations(source),
              reply = observations.find(item => item.occurrenceKind === 'discussion.reply' && item.providerEntityId === 'DR_1'),
              revision = observations.find(item => item.occurrenceCoordinate === 'UCE_DR_1'),
              policy = {responseBearingKinds: ['discussion.reply', 'discussion.reply-edited'], rosteredActorIds: ['neo-gpt']};

        expect(classifyAttention(reply, policy).disposition).toBe('eligible');
        expect(classifyAttention(revision, policy).disposition).toBe('eligible');
        expect(JSON.stringify(observations)).not.toMatch(/UNTRUSTED_PROVIDER_PROSE|POPULARITY|upvote|starred/);
        expect(validateBatch(batchAround(observations))).toEqual({valid: true, errors: []});
    });

    test('rejects missing stable child ids or missing revision evidence for a claimed edit', () => {
        expect(() => discussionToObservations({id: 'D', createdAt: 't', comments: [{replies: []}]}))
            .toThrow('DISCUSSION_OBSERVATIONS_REQUIRE_COMMENT_AND_REPLIES');
        expect(() => discussionToObservations({
            id: 'D', createdAt: 't', lastEditedAt: 'later', comments: [], contentEdits: []
        })).toThrow('DISCUSSION_OBSERVATIONS_LAST_EDIT_MISMATCH:D');
        expect(() => discussionToObservations({
            id: 'D', createdAt: 't', lastEditedAt: 'later', comments: []
        })).toThrow('DISCUSSION_OBSERVATIONS_REQUIRE_EXHAUSTIVE_EDITS:D');
        expect(() => discussionToObservations({
            id: 'D', createdAt: '2026-01-01T00:00:00Z', lastEditedAt: '2026-01-02T00:00:00Z', comments: [],
            contentEdits: [
                {id: 'older', editedAt: '2026-01-02T00:00:00Z'},
                {id: 'newer', editedAt: '2026-01-03T00:00:00Z'}
            ]
        })).toThrow('DISCUSSION_OBSERVATIONS_LAST_EDIT_MISMATCH:D');
    });
});

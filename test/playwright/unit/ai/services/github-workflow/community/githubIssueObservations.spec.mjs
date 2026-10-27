import {setup} from '../../../../../setup.mjs';

const appName = 'GithubIssueObservationsTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}                                            from '@playwright/test';
import Neo                                                       from 'neo.mjs/src/Neo.mjs';
import * as core                                                 from 'neo.mjs/src/core/_export.mjs';
import fs                                                        from 'node:fs';
import os                                                        from 'node:os';
import path                                                      from 'node:path';
import RequestContextService                                     from '../../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';
import {BATCH_SCHEMA_VERSION, validateBatch, occurrenceIdentity} from '../../../../../../../ai/services/memory-core/communityBatchContract.mjs';
import {actorKindFromTypename, issueToObservations}              from '../../../../../../../ai/services/github-workflow/community/githubIssueObservations.mjs';

/**
 * @summary Witnesses that the GitHub issue normalizer emits observations the shipped
 * community-activity-batch.v1 contract accepts — admissible, prose-free, stably-identified,
 * and popularity-refusing by construction — with no attention decision taken in the producer.
 */
test.describe('githubIssueObservations normalizer', () => {
    const fullIssue = {
        id          : 'I_root',
        createdAt   : '2026-07-18T09:00:00Z',
        lastEditedAt: '2026-07-18T09:30:00Z',
        author      : {login: 'octo-human', __typename: 'User'}, authorAssociation: 'OWNER',
        comments    : [
            {id: 'IC_1', createdAt: '2026-07-18T10:00:00Z', author: {login: 'replier', __typename: 'User'}, authorAssociation: 'CONTRIBUTOR'},
            {id: 'IC_2', createdAt: '2026-07-18T10:05:00Z', lastEditedAt: '2026-07-18T10:07:00Z', author: {login: 'dependabot', __typename: 'Bot'}, authorAssociation: 'NONE'}
        ],
        timeline    : [
            {id: 'CE_1', __typename: 'ClosedEvent',   createdAt: '2026-07-18T11:00:00Z', actor: {login: 'maintainer', __typename: 'User'}},
            {id: 'RE_1', __typename: 'ReopenedEvent', createdAt: '2026-07-18T11:30:00Z', actor: {login: 'maintainer', __typename: 'User'}},
            {id: 'LE_1', __typename: 'LabeledEvent',  createdAt: '2026-07-18T11:31:00Z', actor: {login: 'maintainer', __typename: 'User'}}
        ]
    };

    const batchAround = observations => ({
        schemaVersion             : BATCH_SCHEMA_VERSION,
        sourceInstanceId          : 'src-1',
        resourceFamily            : 'issues',
        adapterSchemaVersion      : 'github-issue.v1',
        providerStateSchemaVersion: 'gh-state.v1',
        registrationEpoch         : 2,
        baseCheckpointVersion     : 0,
        baseInventoryHash         : null,
        batchId                   : 'batch-1',
        observations,
        nextProviderState         : {cursor: 'x'},
        nextInventoryHash         : 'inv-1',
        coverage                  : {fromBasis: 'c1', toBasis: 'c9', complete: true}
    });

    // ------------------------------------------------------------------ actor kind axis

    test('actor kind is read from the provider typename; absent/unknown fails closed', () => {
        expect(actorKindFromTypename('User')).toBe('user');
        expect(actorKindFromTypename('Bot')).toBe('bot');
        expect(actorKindFromTypename('Organization')).toBe('organization');
        expect(actorKindFromTypename('Mannequin')).toBe('mannequin');
        expect(actorKindFromTypename('EnterpriseUserAccount')).toBe('enterprise-user');
        expect(actorKindFromTypename(undefined), 'a deleted/ghost actor').toBe('unknown');
        expect(actorKindFromTypename('SomethingNew'), 'an unrecognized kind').toBe('unknown')
    });

    test('source-relative trust is a SEPARATE field from actor kind, and orthogonal to it', () => {
        const obs        = issueToObservations(fullIssue),
              root       = obs.find(o => o.providerEntityId === 'I_root' && o.occurrenceKind === 'issue.opened'),
              botComment = obs.find(o => o.providerEntityId === 'IC_2' && o.occurrenceKind === 'issue.comment'),
              closed     = obs.find(o => o.occurrenceKind === 'issue.closed');

        expect(root.actorKind).toBe('user');
        expect(root.sourceAssociation, 'kind and association are distinct fields').toBe('OWNER');
        // Orthogonal axes: a bot may carry any association — here NONE — and the two never conflate.
        expect(botComment.actorKind).toBe('bot');
        expect(botComment.sourceAssociation).toBe('NONE');
        // A lifecycle event has no content authorship, so its association is explicitly null, not guessed.
        expect(closed.sourceAssociation).toBe(null)
    });

    // ------------------------------------------------------------------ the emitted shape is admissible

    test('a fully-populated issue yields observations that form a VALID v1 batch', () => {
        const observations = issueToObservations(fullIssue);

        expect(validateBatch(batchAround(observations))).toEqual({valid: true, errors: []})
    });

    test('the root, an edit, comments, comment-edit, and whitelisted events each become a distinct occurrence', () => {
        const obs   = issueToObservations(fullIssue),
              kinds = obs.map(o => o.occurrenceKind);

        expect(kinds).toEqual([
            'issue.opened', 'issue.edited',
            'issue.comment', 'issue.comment', 'issue.comment-edited',
            'issue.closed', 'issue.reopened', 'issue.labeled'
        ]);

        // Every comment, comment edit, and timeline event carries parentProviderEntityId === issue.id
        const children = obs.filter(o => !['issue.opened', 'issue.edited', 'issue.observed-snapshot-change'].includes(o.occurrenceKind));
        expect(children).toHaveLength(6);
        for (const child of children) {
            expect(child.parentProviderEntityId).toBe(fullIssue.id)
        }
    });

    test('re-reconciling a source whose issues were admitted before #1315 upgrades parentProviderEntityId in place without conflict or duplicate rows (#1315 AC-3)', async () => {
        const Database              = (await import('better-sqlite3')).default,
              SourceRegistryService = (await import('../../../../../../../ai/services/memory-core/SourceRegistryService.mjs')).default,
              AdmissionService      = (await import('../../../../../../../ai/services/memory-core/CommunityBatchAdmissionService.mjs')).default;

        await Promise.all([SourceRegistryService.ready(), AdmissionService.ready()]);

        const tempRoot                = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'neo-issue-reconcile-1315-')),
              dbPath                  = path.join(tempRoot, 'test.sqlite'),
              registryDb              = new Database(dbPath),
              admissionDb             = new Database(dbPath),
              originalRegistryDb      = SourceRegistryService.db,
              originalLocalSubjectId  = SourceRegistryService.localSubjectId,
              originalAdmissionDb     = AdmissionService.db,
              originalAttentionPolicy = AdmissionService.attentionPolicy;

        try {
            SourceRegistryService.set({db: registryDb, localSubjectId: null});
            AdmissionService.set({
                db             : admissionDb,
                attentionPolicy: {
                    responseBearingKinds: ['issue.opened', 'issue.comment'],
                    rosteredActorIds    : ['maintainer']
                }
            });
            SourceRegistryService.ensureSchema();
            AdmissionService.ensureSchema();

            const tenantId = 'tenant-1315',
                  reg      = SourceRegistryService.registerForTenant(tenantId, {
                      canonicalProviderHost: 'github.com',
                      displayLocator       : 'acme-org/widgets',
                      grantRef             : 'grant:acme',
                      provider             : 'github',
                      providerResourceId   : 'repo:acme-org/widgets',
                      resourceKind         : 'repository'
                  }, {actorId: 'operator:acme'});

            SourceRegistryService.transitionLifecycleForTenant(tenantId, reg.sourceInstanceId, 'PROVISIONED', {
                actorId: 'operator:acme', expectedEpoch: 1, expectedState: 'REQUESTED'
            });
            SourceRegistryService.transitionLifecycleForTenant(tenantId, reg.sourceInstanceId, 'ACTIVE', {
                actorId: 'operator:acme', expectedEpoch: 2, expectedState: 'PROVISIONED'
            });

            const currentObservations = issueToObservations(fullIssue),
                  pre1315Observations = currentObservations.map(({parentProviderEntityId: _omitted, ...legacy}) => legacy);

            const firstAdmission = await RequestContextService.run({userId: tenantId}, () =>
                AdmissionService.admitBatch({
                    ...batchAround(pre1315Observations),
                    batchId              : 'batch-pre-1315',
                    baseCheckpointVersion: 0,
                    baseInventoryHash    : null,
                    nextInventoryHash    : 'inv-pre-1315',
                    sourceInstanceId     : reg.sourceInstanceId
                })
            );
            expect(firstAdmission.status).toBe('accepted');

            const rowsBefore = await RequestContextService.run({userId: tenantId}, () =>
                AdmissionService.listObservations(reg.sourceInstanceId)
            );
            expect(rowsBefore).toHaveLength(currentObservations.length);
            expect(rowsBefore.filter(r => r.parentProviderEntityId === fullIssue.id)).toHaveLength(0);

            const secondAdmission = await RequestContextService.run({userId: tenantId}, () =>
                AdmissionService.admitBatch({
                    ...batchAround(currentObservations),
                    batchId              : 'batch-post-1315',
                    baseCheckpointVersion: firstAdmission.receipt.nextCheckpointVersion,
                    baseInventoryHash    : firstAdmission.receipt.nextInventoryHash,
                    nextInventoryHash    : 'inv-post-1315',
                    sourceInstanceId     : reg.sourceInstanceId
                })
            );
            expect(secondAdmission.status).toBe('accepted');

            const rowsAfter = await RequestContextService.run({userId: tenantId}, () =>
                AdmissionService.listObservations(reg.sourceInstanceId)
            );
            expect(rowsAfter).toHaveLength(currentObservations.length);
            const childrenAfter = rowsAfter.filter(r => !['issue.opened', 'issue.edited'].includes(r.occurrenceKind));
            expect(childrenAfter).toHaveLength(6);
            for (const child of childrenAfter) {
                expect(child.parentProviderEntityId).toBe(fullIssue.id)
            }

            // Tampering with a non-parent field still fails closed with OBSERVATION_DIGEST_MISMATCH
            const tamperedObservations = currentObservations.map(o =>
                o.occurrenceKind === 'issue.closed' ? {...o, actorId: 'forged-actor'} : o
            );
            const tamperedAdmission = await RequestContextService.run({userId: tenantId}, () =>
                AdmissionService.admitBatch({
                    ...batchAround(tamperedObservations),
                    batchId              : 'batch-tampered',
                    baseCheckpointVersion: secondAdmission.receipt.nextCheckpointVersion,
                    baseInventoryHash    : secondAdmission.receipt.nextInventoryHash,
                    nextInventoryHash    : 'inv-tampered',
                    sourceInstanceId     : reg.sourceInstanceId
                })
            );
            expect(tamperedAdmission).toMatchObject({
                reason: 'OBSERVATION_DIGEST_MISMATCH',
                status: 'conflict'
            });
        } finally {
            SourceRegistryService.set({db: originalRegistryDb, localSubjectId: originalLocalSubjectId});
            AdmissionService.set({db: originalAdmissionDb, attentionPolicy: originalAttentionPolicy});
            registryDb.close();
            admissionDb.close();
            await fs.promises.rm(tempRoot, {force: true, recursive: true})
        }
    });

    // ------------------------------------------------------------------ stable, revision-distinct identity

    test('a revision is coordinate-distinct from the create, and identity is stable across re-runs', () => {
        const first  = issueToObservations(fullIssue),
              second = issueToObservations(fullIssue),
              open   = first.find(o => o.occurrenceKind === 'issue.opened'),
              edit   = first.find(o => o.occurrenceKind === 'issue.edited');

        expect(occurrenceIdentity('src-1', open), 'edit is not the open')
            .not.toBe(occurrenceIdentity('src-1', edit));
        // Re-reconciling the same node reproduces byte-identical identity for every occurrence.
        expect(second.map(o => occurrenceIdentity('src-1', o)))
            .toEqual(first.map(o => occurrenceIdentity('src-1', o)))
    });

    // ------------------------------------------------------------------ refusal by construction

    test('an unmapped timeline event (popularity or any unknown kind) produces no observation', () => {
        const withNoise = {
            ...fullIssue,
            timeline: [
                {id: 'X_1', __typename: 'StarredEvent',    createdAt: '2026-07-18T12:00:00Z', actor: {login: 'fan', __typename: 'User'}},
                {id: 'X_2', __typename: 'MentionedEvent',  createdAt: '2026-07-18T12:01:00Z', actor: {login: 'fan', __typename: 'User'}}
            ]
        };

        const kinds = issueToObservations(withNoise).map(o => o.occurrenceKind);

        expect(kinds).not.toContain('issue.starred');
        expect(kinds.filter(k => k.startsWith('issue.'))).toEqual(['issue.opened', 'issue.edited', 'issue.comment', 'issue.comment', 'issue.comment-edited'])
    });

    test('a stray IssueComment on the timeline is ignored — the comments axis owns comments (no double-count)', () => {
        const withStray = {
            ...fullIssue,
            timeline: [
                {id: 'IC_x', __typename: 'IssueComment', createdAt: '2026-07-18T12:00:00Z', author: {login: 'replier', __typename: 'User'}},
                {id: 'CE_x', __typename: 'ClosedEvent',   createdAt: '2026-07-18T12:01:00Z', actor: {login: 'maintainer', __typename: 'User'}}
            ]
        };

        const timelineComments = issueToObservations(withStray)
            .filter(o => o.occurrenceKind === 'issue.comment' && o.providerEntityId === 'IC_x');

        expect(timelineComments, 'a timeline IssueComment produces no observation').toHaveLength(0)
    });

    test('a deleted author on the root fails closed to unknown, actorId null', () => {
        const [root] = issueToObservations({id: 'I_ghost', createdAt: '2020-01-01T00:00:00Z', author: null});

        expect(root.actorKind).toBe('unknown');
        expect(root.actorId).toBe(null)
    });

    // ------------------------------------------------------------------ AC4 — honest snapshot-only change

    test('an updatedAt newer than every explained occurrence emits a null-actor snapshot-change marker', () => {
        const changed = {
            id      : 'I_s', createdAt: '2026-07-18T09:00:00Z', updatedAt: '2026-07-18T15:00:00Z',
            author  : {login: 'a', __typename: 'User'}, authorAssociation: 'OWNER',
            timeline: [{id: 'CE', __typename: 'ClosedEvent', createdAt: '2026-07-18T10:00:00Z', actor: {login: 'm', __typename: 'User'}}]
        };

        const marker = issueToObservations(changed).find(o => o.occurrenceKind === 'issue.observed-snapshot-change');

        expect(marker, 'the unexplained change is recorded').toBeTruthy();
        expect(marker.actorId, 'no actor is fabricated').toBe(null);
        expect(marker.actorKind).toBe('unknown');
        expect(marker.lossMarker).toBe('snapshot-without-granular-event');
        expect(validateBatch(batchAround(issueToObservations(changed)))).toEqual({valid: true, errors: []})
    });

    test('an updatedAt explained by a captured occurrence emits NO snapshot-change marker', () => {
        const explained = {
            id      : 'I_e', createdAt: '2026-07-18T09:00:00Z', updatedAt: '2026-07-18T10:00:00Z',
            author  : {login: 'a', __typename: 'User'}, authorAssociation: 'OWNER',
            timeline: [{id: 'CE', __typename: 'ClosedEvent', createdAt: '2026-07-18T10:00:00Z', actor: {login: 'm', __typename: 'User'}}]
        };

        expect(issueToObservations(explained).some(o => o.occurrenceKind === 'issue.observed-snapshot-change')).toBe(false)
    });

    // ------------------------------------------------------------------ edits are unattributed

    test('an edit is NOT attributed to the original author — lastEditedAt proves when, never who', () => {
        const edited = {
            id      : 'I_x', createdAt: '2026-07-18T09:00:00Z', lastEditedAt: '2026-07-18T12:00:00Z',
            author  : {login: 'original-author', __typename: 'User'}, authorAssociation: 'OWNER',
            comments: [{id: 'IC_x', createdAt: '2026-07-18T10:00:00Z', lastEditedAt: '2026-07-18T13:00:00Z', author: {login: 'commenter', __typename: 'User'}, authorAssociation: 'CONTRIBUTOR'}]
        };

        const obs         = issueToObservations(edited),
              issueEdit   = obs.find(o => o.occurrenceKind === 'issue.edited'),
              commentEdit = obs.find(o => o.occurrenceKind === 'issue.comment-edited');

        for (const revision of [issueEdit, commentEdit]) {
            expect(revision.actorId, 'no editor identity is fabricated').toBe(null);
            expect(revision.actorKind).toBe('unknown');
            expect(revision.sourceAssociation).toBe(null);
            expect(revision.lossMarker).toBe('editor-unattributed')
        }

        // the CREATE still carries the real author — only the edit is unattributed
        expect(obs.find(o => o.occurrenceKind === 'issue.opened').actorId).toBe('original-author');
        expect(validateBatch(batchAround(obs))).toEqual({valid: true, errors: []})
    });

    // ------------------------------------------------------------------ identity is mandatory (fail loud)

    test('a node or comment or event without a provider id is refused', () => {
        expect(() => issueToObservations(null)).toThrow('ISSUE_OBSERVATIONS_REQUIRE_NODE_ID');
        expect(() => issueToObservations({id: 'I', createdAt: 't', comments: [{createdAt: 't'}]})).toThrow('ISSUE_OBSERVATIONS_REQUIRE_COMMENT_ID');
        expect(() => issueToObservations({id: 'I', createdAt: 't', timeline: [{__typename: 'ClosedEvent', createdAt: 't'}]})).toThrow('ISSUE_OBSERVATIONS_REQUIRE_EVENT_ID')
    });
});

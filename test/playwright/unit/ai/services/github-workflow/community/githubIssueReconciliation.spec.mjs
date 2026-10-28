import {setup} from '../../../../../setup.mjs';

const appName = 'GithubIssueReconciliationTest';

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

import {test, expect}           from '@playwright/test';
import Neo                      from 'neo.mjs/src/Neo.mjs';
import * as core                from 'neo.mjs/src/core/_export.mjs';
import {reconcileIssueActivity} from '../../../../../../../ai/services/github-workflow/community/githubIssueReconciliation.mjs';
import {validateCommunityCoverage} from '../../../../../../../ai/services/memory-core/communityCoverageContract.mjs';

/**
 * @summary Witnesses that the issue-reconciliation runner exhausts all three pagination axes
 * (issues, per-issue comments, per-issue timeline) behind injected seams, enumerates every
 * issue state without filtering, and reports coverage honestly — a page cap always surfaces as
 * incomplete-with-gap, never a silent truncation.
 */
test.describe('reconcileIssueActivity runner', () => {
    const comment = id => ({id, createdAt: '2026-01-01T09:00:00Z', author: {login: 'commenter', __typename: 'User'}}),
          event   = (id, typename) => ({id, __typename: typename, createdAt: '2026-01-01T10:00:00Z', actor: {login: 'maintainer', __typename: 'User'}});

    const issues = [
        {
            id         : 'I_a', createdAt: '2026-01-01T00:00:00Z', author: {login: 'u1', __typename: 'User'},
            allComments: [comment('IC_a1'), comment('IC_a2'), comment('IC_a3'), comment('IC_a4'), comment('IC_a5')],
            allTimeline: [event('CE_a1', 'ClosedEvent'), event('RE_a1', 'ReopenedEvent'), event('LE_a1', 'LabeledEvent'), event('CE_a2', 'ClosedEvent')]
        },
        {
            id         : 'I_b', createdAt: '2026-01-02T00:00:00Z', author: {login: 'u2', __typename: 'User'},
            allComments: [comment('IC_b1')],
            allTimeline: [event('CE_b1', 'ClosedEvent')]
        },
        {
            id         : 'I_c', createdAt: '2026-01-03T00:00:00Z', author: null, // a deleted account — still enumerated
            allComments: [],
            allTimeline: []
        }
    ];

    // An in-memory paginated source: the first page arrives inline on the node, the overflow is
    // continuation-fetched from the same cursor space, so the runner must walk every page to see all.
    const buildSeams = ({issuePageSize, commentPageSize, timelinePageSize}) => {
        const inline = (items, size) => ({nodes: items.slice(0, size), pageInfo: {hasNextPage: items.length > size, endCursor: String(size)}}),
              pageOf = (items, size, cursor) => {
                  const start = Number(cursor), next = start + size;
                  return {slice: items.slice(start, next), pageInfo: {hasNextPage: next < items.length, endCursor: String(next)}}
              },
              byId   = new Map(issues.map(i => [i.id, i]));

        return {
            fetchIssuesPage: async ({cursor}) => {
                const {slice, pageInfo} = pageOf(issues, issuePageSize, cursor ?? 0);

                return {
                    issues: slice.map(i => ({
                        id      : i.id, createdAt: i.createdAt, author: i.author,
                        comments: inline(i.allComments, commentPageSize),
                        timeline: inline(i.allTimeline, timelinePageSize)
                    })),
                    pageInfo
                }
            },
            fetchCommentsPage: async ({issueId, cursor}) => {
                const {slice, pageInfo} = pageOf(byId.get(issueId).allComments, commentPageSize, cursor);
                return {comments: slice, pageInfo}
            },
            fetchTimelinePage: async ({issueId, cursor}) => {
                const {slice, pageInfo} = pageOf(byId.get(issueId).allTimeline, timelinePageSize, cursor);
                return {events: slice, pageInfo}
            }
        }
    };

    const kindCount = (observations, kind) => observations.filter(o => o.occurrenceKind === kind).length;

    // ------------------------------------------------------------------ full exhaustion across all axes

    test('walks every issue, every comment page, and every timeline page to exhaustion', async () => {
        const {observations, coverage} = await reconcileIssueActivity(buildSeams({issuePageSize: 2, commentPageSize: 2, timelinePageSize: 2}));

        expect(kindCount(observations, 'issue.opened'), 'one root per issue, no state filtered').toBe(3);
        expect(kindCount(observations, 'issue.comment'), 'all 6 comments across 3 comment-pages of I_a').toBe(6);
        expect(kindCount(observations, 'issue.closed'), 'timeline overflow of I_a fully walked').toBe(3);
        expect(coverage.complete).toBe(true);
        expect(coverage.gaps).toBeUndefined();
        expect(coverage.contract).toEqual({
            schemaVersion: 'community-coverage.v1', batchSchemaVersion: 'community-activity-batch.v1',
            resourceFamily: 'issues', adapterSchemaVersion: 'github-issue.v1',
            providerStateSchemaVersion: 'github-issue-state.v1'
        });
        expect(coverage.providerLimitations).toEqual([
            {axis: 'comment-deletion-correlation', reason: 'github-comment-deleted-event-omits-deleted-comment-id'},
            {axis: 'issue-edit-attribution', reason: 'editor-unattributed'},
            {axis: 'issue-snapshot-history', reason: 'snapshot-without-granular-event'}
        ]);
        expect(validateCommunityCoverage(coverage)).toMatchObject({valid: true, qualified: true})
    });

    test('a deleted-author issue is still enumerated, its root actor fails closed to unknown', async () => {
        const {observations} = await reconcileIssueActivity(buildSeams({issuePageSize: 5, commentPageSize: 5, timelinePageSize: 5})),
              ghostRoot      = observations.find(o => o.providerEntityId === 'I_c');

        expect(ghostRoot.occurrenceKind).toBe('issue.opened');
        expect(ghostRoot.actorKind).toBe('unknown')
    });

    // ------------------------------------------------------------------ honest coverage under caps

    test('a per-issue comment cap surfaces as incomplete WITH an explicit gap, not silent truncation', async () => {
        const {observations, coverage} = await reconcileIssueActivity(
            buildSeams({issuePageSize: 5, commentPageSize: 2, timelinePageSize: 5}),
            {maxCommentPagesPerIssue: 1}
        );

        expect(kindCount(observations, 'issue.comment'), 'I_a truncated to its first comment page (2), plus I_b (1)').toBe(3);
        expect(coverage.complete).toBe(false);
        expect(coverage.gaps).toEqual(expect.arrayContaining([{axis: 'comments', issueId: 'I_a'}]))
    });

    test('an issue-list cap drops later pages and is recorded as an issues-axis gap', async () => {
        const {observations, coverage} = await reconcileIssueActivity(
            buildSeams({issuePageSize: 2, commentPageSize: 5, timelinePageSize: 5}),
            {maxIssuePages: 1}
        );

        expect(kindCount(observations, 'issue.opened'), 'only the first issue page [I_a, I_b]').toBe(2);
        expect(coverage.complete).toBe(false);
        expect(coverage.gaps).toEqual([{axis: 'issues', afterCursor: '2'}]);
        expect(validateCommunityCoverage(coverage)).toMatchObject({valid: true, qualified: false})
    });

    test('a genuinely empty root connection qualifies while a missing connection does not', async () => {
        const seams = buildSeams({issuePageSize: 5, commentPageSize: 5, timelinePageSize: 5}),
              empty = await reconcileIssueActivity({...seams, fetchIssuesPage: async () => ({
                  issues: [], pageInfo: {hasNextPage: false, endCursor: null}
              })});

        expect(empty.observations).toEqual([]);
        expect(empty.coverage).toMatchObject({fromBasis: 'genesis', toBasis: 'genesis', complete: true});
        expect(validateCommunityCoverage(empty.coverage)).toMatchObject({valid: true, qualified: true});

        for (const page of [
            {}, {issues: null, pageInfo: {hasNextPage: false}},
            {issues: []}, {issues: [], pageInfo: {}},
            {issues: [], pageInfo: {hasNextPage: 'false'}}
        ]) {
            const result = await reconcileIssueActivity({...seams, fetchIssuesPage: async () => page});

            expect(result.observations).toEqual([]);
            expect(result.coverage.gaps).toEqual([{axis: 'issues', reason: 'ISSUE_RECONCILIATION_ROOT_PAGE_INVALID'}]);
            expect(validateCommunityCoverage(result.coverage)).toMatchObject({valid: true, qualified: false});
        }
    });

    for (const axis of ['comments', 'timeline']) {
        test(`missing or malformed ${axis} is an acquisition gap and excludes only its issue`, async () => {
            for (const connection of [
                undefined, {nodes: null, pageInfo: {hasNextPage: false}},
                {nodes: []}, {nodes: [], pageInfo: {hasNextPage: 'false'}}
            ]) {
                const seams = buildSeams({issuePageSize: 5, commentPageSize: 5, timelinePageSize: 5}),
                      fetch = seams.fetchIssuesPage;

                seams.fetchIssuesPage = async args => {
                    const page = await fetch(args);
                    page.issues[0][axis] = connection;
                    return page
                };

                const result = await reconcileIssueActivity(seams);

                expect(result.observations.some(item => item.providerEntityId === 'I_a')).toBe(false);
                expect(kindCount(result.observations, 'issue.opened')).toBe(2);
                expect(result.coverage.gaps).toEqual([{
                    axis: 'issue-conversation', issueId: 'I_a', reason: 'ISSUE_RECONCILIATION_CHILD_PAGE_INVALID'
                }]);
                expect(validateCommunityCoverage(result.coverage)).toMatchObject({valid: true, qualified: false});
            }
        });
    }

    test('an exhausted suffix remains unqualified and names its omitted root traversal', async () => {
        const result = await reconcileIssueActivity(
            buildSeams({issuePageSize: 2, commentPageSize: 5, timelinePageSize: 5}), {fromBasis: '2'}
        );

        expect(result.observations.map(item => item.providerEntityId)).toEqual(['I_c']);
        expect(result.coverage).toMatchObject({fromBasis: '2', toBasis: '4', complete: false});
        expect(result.coverage.gaps).toEqual([{axis: 'root-traversal', reason: 'not-from-beginning'}]);
        expect(validateCommunityCoverage(result.coverage)).toMatchObject({valid: true, qualified: false});
    });

    test('a zero root-page cap performs no fetch and retains its null cursor gap', async () => {
        let calls = 0;
        const seams = buildSeams({issuePageSize: 2, commentPageSize: 5, timelinePageSize: 5});
        seams.fetchIssuesPage = async () => { calls++; throw new Error('must not fetch') };

        const result = await reconcileIssueActivity(seams, {maxIssuePages: 0});

        expect(calls).toBe(0);
        expect(result.observations).toEqual([]);
        expect(result.coverage.gaps).toEqual([{axis: 'issues', afterCursor: null}]);
        expect(validateCommunityCoverage(result.coverage)).toMatchObject({valid: true, qualified: false});
    });

    test('duplicate roots across pages become gaps without publishing the root twice', async () => {
        const seams = buildSeams({issuePageSize: 1, commentPageSize: 5, timelinePageSize: 5}),
              fetch = seams.fetchIssuesPage;
        let calls = 0;
        seams.fetchIssuesPage = async () => {
            calls++;
            const page = await fetch({cursor: null});
            return {...page, pageInfo: {hasNextPage: calls === 1, endCursor: String(calls)}}
        };

        const result = await reconcileIssueActivity(seams);

        expect(calls).toBe(2);
        expect(kindCount(result.observations, 'issue.opened')).toBe(1);
        expect(result.coverage.gaps).toEqual([{axis: 'issues', reason: 'ISSUE_RECONCILIATION_ROOT_PAGE_INVALID'}]);
        expect(validateCommunityCoverage(result.coverage)).toMatchObject({valid: true, qualified: false});
    });

    test('duplicate child identities exclude the mixed issue snapshot', async () => {
        const seams = buildSeams({issuePageSize: 5, commentPageSize: 1, timelinePageSize: 5});
        seams.fetchCommentsPage = async () => ({
            comments: [comment('IC_a1')], pageInfo: {hasNextPage: false, endCursor: '2'}
        });

        const result = await reconcileIssueActivity(seams);

        expect(result.observations.some(item => item.providerEntityId === 'I_a')).toBe(false);
        expect(kindCount(result.observations, 'issue.opened')).toBe(2);
        expect(result.coverage.gaps).toEqual([{
            axis: 'issue-conversation', issueId: 'I_a', reason: 'ISSUE_RECONCILIATION_CHILD_ID_INVALID'
        }]);
        expect(validateCommunityCoverage(result.coverage)).toMatchObject({valid: true, qualified: false});
    });

    test('root cursors that never advance stop acquisition instead of qualifying a prefix', async () => {
        for (const stallAfterFirst of [false, true]) {
            const seams = buildSeams({issuePageSize: 1, commentPageSize: 5, timelinePageSize: 5}),
                  fetch = seams.fetchIssuesPage;
            let calls = 0;
            seams.fetchIssuesPage = async args => {
                calls++;
                const page = await fetch(args);
                return {...page, pageInfo: {hasNextPage: true, endCursor: stallAfterFirst ? '1' : null}}
            };

            const result = await reconcileIssueActivity(seams);

            expect(calls).toBe(stallAfterFirst ? 2 : 1);
            expect(result.coverage.gaps).toEqual([{
                axis: 'issues', afterCursor: stallAfterFirst ? '1' : null, reason: 'cursor-stalled'
            }]);
            expect(validateCommunityCoverage(result.coverage)).toMatchObject({valid: true, qualified: false});
        }
    });

    test('an empty root cursor cycle stops without requiring repeated entities', async () => {
        const seams = buildSeams({issuePageSize: 1, commentPageSize: 1, timelinePageSize: 1});
        let calls = 0;
        seams.fetchIssuesPage = async () => {
            calls++;
            if (calls > 3) throw new Error('Cycle should have stopped before another request');
            return {issues: [], pageInfo: {hasNextPage: true, endCursor: calls === 2 ? 'b' : 'a'}}
        };

        const result = await reconcileIssueActivity(seams);

        expect(calls).toBe(3);
        expect(result.coverage.gaps).toEqual([{axis: 'issues', afterCursor: 'a', reason: 'cursor-stalled'}]);
        expect(validateCommunityCoverage(result.coverage)).toMatchObject({valid: true, qualified: false});
    });

    test('repeated child cursors stop before another continuation and reject the mixed snapshot', async () => {
        const seams = buildSeams({issuePageSize: 5, commentPageSize: 1, timelinePageSize: 5});
        let calls = 0;
        seams.fetchCommentsPage = async ({cursor}) => {
            calls++;
            expect(cursor).toBe('1');
            return {comments: [comment('IC_a2')], pageInfo: {hasNextPage: true, endCursor: '1'}}
        };

        const result = await reconcileIssueActivity(seams);

        expect(calls).toBe(1);
        expect(result.observations.some(item => item.providerEntityId === 'I_a')).toBe(false);
        expect(kindCount(result.observations, 'issue.opened')).toBe(2);
        expect(result.coverage.gaps).toEqual([{
            axis: 'issue-conversation', issueId: 'I_a', reason: 'ISSUE_RECONCILIATION_CHILD_CURSOR_STALLED'
        }]);
        expect(validateCommunityCoverage(result.coverage)).toMatchObject({valid: true, qualified: false});
    });

    test('missing fetch seams fail loud', async () => {
        await expect(reconcileIssueActivity({fetchIssuesPage: async () => ({})})).rejects.toThrow('ISSUE_RECONCILIATION_REQUIRES_FETCH_SEAMS')
    });
});

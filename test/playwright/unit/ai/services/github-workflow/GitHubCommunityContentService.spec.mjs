import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import 'neo.mjs/src/core/_export.mjs';
import Service                            from '../../../../../../ai/services/github-workflow/GitHubCommunityContentService.mjs';
import {SUPPORTED_GITHUB_COMMUNITY_KINDS} from '../../../../../../ai/services/github-workflow/community/communityContentKinds.mjs';
import {issueToObservations}              from '../../../../../../ai/services/github-workflow/community/githubIssueObservations.mjs';
import {pullRequestToObservations}        from '../../../../../../ai/services/github-workflow/community/githubPullRequestObservations.mjs';
import {discussionToObservations}         from '../../../../../../ai/services/github-workflow/community/githubDiscussionObservations.mjs';

const source       = {canonicalProviderHost: 'github.com', displayLocator: 'neomjs/neo'},
      repository   = {nameWithOwner: 'neomjs/neo'},
      externalBody = 'Please see [proof](https://hostile.example/payload).',
      updatedAt    = '2026-09-20T00:00:00Z',
      entity       = (type, over = {}) => ({__typename: type, id: 'N1', url: 'https://github.com/neomjs/neo/issues/1',
          updatedAt, body: externalBody, authorAssociation: 'NONE', ...over});

test.describe('GitHubCommunityContentService', () => {
    for (const [kind, type, parent] of [
        ['issue.opened', 'Issue', {repository, title: externalBody}],
        ['pull_request.opened', 'PullRequest', {repository, title: externalBody}],
        ['discussion.opened', 'Discussion', {repository, title: externalBody}],
        ['issue.comment', 'IssueComment', {repository}],
        ['pull_request.comment', 'IssueComment', {repository}],
        ['pull_request.review-submitted', 'PullRequestReview', {pullRequest: {repository}}],
        ['discussion.reply', 'DiscussionComment', {discussion: {repository}}]
    ]) {
        test(`reads ${kind} through its verified current entity and source-relative trust`, async () => {
            const result = await Service.read({source, observation: {occurrenceKind: kind, providerEntityId: 'N1'},
                graphqlService: {query: async () => ({node: entity(type, parent)})}});

            expect(result).toMatchObject({status: 'available', notAuthority: true,
                contentTrust: {tier: 'external', sourceRelative: 'NONE'},
                citation    : {providerEntityId: 'N1', providerUpdatedAt: updatedAt, contentVersion: 'current-provider-read'}});
            expect(result.content.body).toContain('[QUARANTINED_URL: hostile.example]');
            expect(JSON.stringify(result)).not.toContain('https://hostile.example');
            expect(result.contentTrust.wasModified).toBe(true);
            expect(result.contentTrust.signals).toEqual([]);
            expect(result.contentTrust.redactions).toEqual([
                {at: 'body', type: 'markdown-link', domain: 'hostile.example'},
                ...(parent.title ? [{at: 'title', type: 'markdown-link', domain: 'hostile.example'}] : [])
            ]);
            if (parent.title) expect(result.content.title).toContain('[QUARANTINED_URL: hostile.example]');
        });
    }

    test('a roster login does not confer source-relative trust, but fresh collaboration does', async () => {
        for (const [association, trusted] of [
            ['NONE', false], [null, false], ['CONTRIBUTOR', false], ['FIRST_TIME_CONTRIBUTOR', false],
            ['FIRST_TIMER', false], ['MANNEQUIN', false], ['OWNER', true], ['MEMBER', true], ['COLLABORATOR', true]
        ]) {
            const result = await Service.read({source, observation: {occurrenceKind: 'issue.opened', providerEntityId: 'N1'},
                graphqlService: {query: async () => ({node: entity('Issue', {
                    repository, title: externalBody, author: {login: 'neo-gpt'}, authorAssociation: association
                })})}});

            expect(result.status).toBe('available');
            expect(result.content.body.includes('https://hostile.example')).toBe(trusted);
            expect(result.content.title.includes('https://hostile.example')).toBe(trusted);
            expect(result.contentTrust).toMatchObject({
                tier          : trusted ? 'repo-trusted' : association ? 'external' : 'unclassified',
                sourceRelative: association || 'UNKNOWN', wasModified: !trusted, signals: []
            });
            expect(result.contentTrust.redactions).toHaveLength(trusted ? 0 : 2);
        }
    });

    test('discloses title-only changes and signals independently of whether text changed', async () => {
        const clean = 'The reproduction fails on startup.', signal = 'I can provide a hosted MCP endpoint';

        for (const [body, title, association, modified, redactions, signals] of [
            [clean, externalBody, 'NONE', true, [{at: 'title', type: 'markdown-link', domain: 'hostile.example'}], []],
            [signal, clean, 'NONE', false, [], ['body']],
            [clean, signal, 'NONE', false, [], ['title']],
            [signal, signal, 'NONE', false, [], ['body', 'title']],
            [clean, '', 'NONE', false, [], []],
            [clean, undefined, 'NONE', false, [], []],
            [signal, externalBody, 'OWNER', false, [], []]
        ]) {
            const result = await Service.read({source, observation: {occurrenceKind: 'issue.opened', providerEntityId: 'N1'},
                graphqlService: {query: async () => ({node: entity('Issue', {repository, body, title, authorAssociation: association})})}});

            expect(result.contentTrust.wasModified).toBe(modified);
            expect(result.contentTrust.redactions).toEqual(redactions);
            expect(result.contentTrust.signals).toEqual(signals.map(at => ({at, id: 'external-endpoint-offer',
                note: 'offer to stand up an external endpoint / index our repo (external-infra-on-our-content)'})));
            expect(Object.hasOwn(result.content, 'title')).toBe(typeof title === 'string');
            if (!modified) expect(result.content).toEqual({body, ...(typeof title === 'string' ? {title} : {})});
        }
    });

    test('rejects wrong repository, wrong entity identity, wrong node type and partial content', async () => {
        for (const over of [{repository: {nameWithOwner: 'other/repo'}}, {id: 'other'},
            {__typename: 'PullRequest'}, {body: undefined}]) {
            const result = await Service.read({source, observation: {occurrenceKind: 'issue.opened', providerEntityId: 'N1'},
                graphqlService: {query: async () => ({node: entity('Issue', {repository, ...over})})}});

            expect(result).toEqual({status: 'unknown', notAuthority: true});
        }
    });

    test('numeric inline comments use REST, and the complete parent URL and identity must match', async () => {
        const base = {id: 42, body: externalBody, html_url: 'https://github.com/neomjs/neo/pull/1#discussion_r42',
            updated_at      : updatedAt, author_association: 'MEMBER',
            pull_request_url: 'https://api.github.com/repos/neomjs/neo/pulls/1'};

        for (const [over, available] of [[{}, true], [{id: 43}, false],
            [{pull_request_url: 'https://evil.example/repos/neomjs/neo/pulls/1'}, false],
            [{pull_request_url: 'https://api.github.com/repos/neomjs/neo-suffix/pulls/1'}, false]]) {
            const calls = [], result = await Service.read({source,
                observation   : {occurrenceKind: 'pull_request.review-comment', providerEntityId: '42'},
                graphqlService: {rest: async (...args) => { calls.push(args); return {...base, ...over} }}});

            expect(calls).toEqual([['GET', '/repos/neomjs/neo/pulls/comments/42']]);
            expect(result.status).toBe(available ? 'available' : 'unknown');
            if (available) expect(result.content.body).toBe(externalBody);
            else expect(result.content).toBeUndefined();
        }

        const invalid = await Service.read({source,
            observation   : {occurrenceKind: 'pull_request.review-comment', providerEntityId: '../1'},
            graphqlService: {rest: () => { throw new Error('must not fetch') }}});
        expect(invalid.status).toBe('unknown');
    });

    test('null and ambiguous HTTP failures do not assert deletion; typed denial remains distinguishable', async () => {
        for (const [failure, status] of [[null, 'unknown'], [Object.assign(new Error(), {status: 403}), 'unknown'],
            [Object.assign(new Error(), {status: 404}), 'unknown'],
            [Object.assign(new Error(), {graphqlErrors: [{type: 'FORBIDDEN'}]}), 'inaccessible']]) {
            const result = await Service.read({source,
                observation   : {occurrenceKind: 'issue.comment', providerEntityId: 'N1'},
                graphqlService: {query: async () => { if (failure) throw failure; return {node: null} }}});
            expect(result).toEqual({status, notAuthority: true});
        }
    });

    test('producer-backed kinds stay queryable while popularity and metadata-only prose reads are refused', async () => {
        const root = {id: 'R1', createdAt: updatedAt, updatedAt: '2026-09-20T01:00:00Z',
            contentEdits: [], comments: [], reviews: [], reviewComments: [], timeline: []},
              outputs = [issueToObservations(root), pullRequestToObservations(root), discussionToObservations(root)];

        for (const row of outputs.flat()) expect(SUPPORTED_GITHUB_COMMUNITY_KINDS).toContain(row.occurrenceKind);
        expect(SUPPORTED_GITHUB_COMMUNITY_KINDS).toContain('pull_request.comment');
        expect(SUPPORTED_GITHUB_COMMUNITY_KINDS).toContain('issue.closed');
        expect(SUPPORTED_GITHUB_COMMUNITY_KINDS).toContain('discussion.reply-deleted');

        for (const kind of ['repository.starred', 'repository.unstarred', 'repository.forked', 'repository.watched']) {
            expect(SUPPORTED_GITHUB_COMMUNITY_KINDS).not.toContain(kind);
        }

        let   fetched = false;
        const result  = await Service.read({source, observation: {occurrenceKind: 'issue.closed', providerEntityId: 'N1'},
            graphqlService: {query: () => { fetched = true }}});
        expect(result.status).toBe('unsupported');
        expect(fetched).toBe(false);
    });
});

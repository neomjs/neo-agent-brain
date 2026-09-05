import {test, expect}                                  from '@playwright/test';
import {createGithubActionsClient, resolveGithubToken} from '../../../../../../ai/services/ingestion/githubActions.mjs';

// Pure over an injected fetch — no network, no shell.

function jsonResponse(body, {status = 200} = {}) {
    return {ok: status >= 200 && status < 300, status, statusText: status === 200 ? 'OK' : 'Error', json: async () => body, text: async () => JSON.stringify(body)};
}

function textResponse(text) {
    return {ok: true, status: 200, statusText: 'OK', json: async () => { throw new Error('not json') }, text: async () => text};
}

test.describe('githubActions — the bounded Actions REST reads', () => {
    test('the credential comes from the environment only, override first, and the failure names the knobs', () => {
        expect(resolveGithubToken({override: ' tok ', env: {GH_TOKEN: 'env'}})).toBe('tok');
        expect(resolveGithubToken({env: {GH_TOKEN: 'gh', GITHUB_TOKEN: 'github'}})).toBe('gh');
        expect(resolveGithubToken({env: {GITHUB_TOKEN: ' github '}})).toBe('github');
        expect(() => resolveGithubToken({env: {}})).toThrow(/GH_TOKEN or GITHUB_TOKEN/);
    });

    test('the client refuses a malformed repo slug or a missing token before any request', () => {
        expect(() => createGithubActionsClient({repoSlug: 'neo', token: 't'})).toThrow(/owner\/name/);
        expect(() => createGithubActionsClient({repoSlug: 'neomjs/neo', token: ''})).toThrow(/token/);
    });

    test('listRuns pages the created window across every status, projects the fields, and returns oldest first', async () => {
        const calls     = [];
        const fetchImpl = async (url, init) => {
            calls.push({url, init});
            const page = new URL(url).searchParams.get('page');
            if (page === '1') {
                return jsonResponse({workflow_runs: [
                    {id: 2, name: 'Engine Tests', path: '.github/workflows/test.yml', event: 'push', head_branch: 'dev', head_sha: 'b', html_url: 'https://github.com/neomjs/neo/actions/runs/2', created_at: '2026-09-05T01:00:00Z', updated_at: '2026-09-05T01:06:00Z', status: 'in_progress', conclusion: null},
                    {id: 1, name: 'File Size Guard', path: '.github/workflows/file-size-guard.yml', event: 'pull_request', head_branch: 'agent/x', head_sha: 'a', html_url: 'https://github.com/neomjs/neo/actions/runs/1', created_at: '2026-09-05T00:00:00Z', updated_at: '2026-09-05T00:01:00Z', status: 'completed', conclusion: 'success'}
                ]});
            }
            return jsonResponse({workflow_runs: []});
        };

        const client = createGithubActionsClient({repoSlug: 'neomjs/neo', token: 'secret', fetchImpl}),
              runs   = await client.listRuns({since: '2026-09-04T00:00:00Z', perPage: 2});

        expect(runs.map(run => run.id)).toEqual([1, 2]);
        expect(runs[1]).toEqual({
            id     : 2, name: 'Engine Tests', path: '.github/workflows/test.yml', event: 'push', headBranch: 'dev', headSha: 'b',
            htmlUrl: 'https://github.com/neomjs/neo/actions/runs/2', createdAt: '2026-09-05T01:00:00Z', updatedAt: '2026-09-05T01:06:00Z', status: 'in_progress', conclusion: null
        });
        // A full page asks for the next one; a short page stops. No status filter: a running run is
        // listed so the caller can carry it as pending.
        expect(calls).toHaveLength(2);
        expect(calls[0].url).toBe('https://api.github.com/repos/neomjs/neo/actions/runs?per_page=2&page=1&created=%3E%3D2026-09-04T00%3A00%3A00Z');
        expect(calls[0].init.headers).toMatchObject({Authorization: 'Bearer secret', 'X-GitHub-Api-Version': '2022-11-28'});
    });

    test('getRun reads one run by id; fileExists answers a Contents read, 404 as absent, anything else as an error', async () => {
        const fetchImpl = async url => {
            if (url.endsWith('/actions/runs/20')) {
                return jsonResponse({id: 20, name: 'Engine Tests', path: '.github/workflows/test.yml', event: 'push', head_branch: 'dev', head_sha: 'c', html_url: 'https://github.com/neomjs/neo/actions/runs/20', created_at: '2026-09-05T00:30:00Z', updated_at: '2026-09-05T02:00:00Z', status: 'completed', conclusion: 'failure'});
            }
            if (url === 'https://api.github.com/repos/neomjs/neo/contents/test/playwright/component/tab/OverflowAction.spec.mjs?ref=green-sha') {
                return jsonResponse({name: 'OverflowAction.spec.mjs', sha: 'blob'});
            }
            if (url.includes('/contents/') && url.endsWith('?ref=gone-sha')) {
                return jsonResponse({message: 'Not Found'}, {status: 404});
            }
            return jsonResponse({message: 'Bad Gateway'}, {status: 502});
        };

        const client = createGithubActionsClient({repoSlug: 'neomjs/neo', token: 'secret', fetchImpl});

        expect(await client.getRun(20)).toMatchObject({id: 20, status: 'completed', conclusion: 'failure', headSha: 'c'});
        expect(await client.fileExists({path: 'test/playwright/component/tab/OverflowAction.spec.mjs', ref: 'green-sha'})).toBe(true);
        expect(await client.fileExists({path: 'test/playwright/component/tab/OverflowAction.spec.mjs', ref: 'gone-sha'})).toBe(false);
        await expect(client.fileExists({path: 'test/playwright/component/tab/OverflowAction.spec.mjs', ref: 'flaky-sha'})).rejects.toThrow(/502/);
    });

    test('listJobs keeps the step conclusions and fetchJobLog returns the redirected text', async () => {
        const fetchImpl = async url => {
            if (url.endsWith('/actions/runs/7/jobs?per_page=100')) {
                return jsonResponse({jobs: [{id: 70, name: 'components', conclusion: 'failure', html_url: 'https://github.com/neomjs/neo/actions/runs/7/job/70', steps: [{name: 'Run components tests', conclusion: 'failure', number: 9}]}]});
            }
            if (url.endsWith('/actions/jobs/70/logs')) {
                return textResponse('2026-09-05T01:00:51.2134944Z   1 failed\n');
            }
            return jsonResponse({message: 'Not Found'}, {status: 404});
        };

        const client = createGithubActionsClient({repoSlug: 'neomjs/neo', token: 'secret', fetchImpl});

        expect(await client.listJobs(7)).toEqual([{id: 70, name: 'components', conclusion: 'failure', htmlUrl: 'https://github.com/neomjs/neo/actions/runs/7/job/70', steps: [{name: 'Run components tests', conclusion: 'failure'}]}]);
        expect(await client.fetchJobLog(70)).toBe('2026-09-05T01:00:51.2134944Z   1 failed\n');
        await expect(client.fetchJobLog(71)).rejects.toThrow(/404/);
    });
});

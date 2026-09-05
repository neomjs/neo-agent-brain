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

        const client           = createGithubActionsClient({repoSlug: 'neomjs/neo', token: 'secret', fetchImpl}),
              {runs, complete} = await client.listRuns({since: '2026-09-04T00:00:00Z', perPage: 2});

        expect(complete, 'the short second page is the window\'s start').toBe(true);
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

    test('a listing that exhausts its page bound says so and hands back the newest runs; an upper bound becomes a created range', async () => {
        const calls     = [];
        const fetchImpl = async url => {
            calls.push(url);
            const page = Number(new URL(url).searchParams.get('page'));
            // Every page full: 2 runs a page, 2 pages allowed — the window is not read to its start.
            return jsonResponse({workflow_runs: [
                {id: 100 - page * 2, name: 'Engine Tests', path: '.github/workflows/test.yml', event: 'push', head_branch: 'dev', head_sha: 'a', html_url: '', created_at: `2026-09-05T0${9 - page}:30:00Z`, updated_at: '', status: 'completed', conclusion: 'failure'},
                {id: 99 - page * 2,  name: 'Engine Tests', path: '.github/workflows/test.yml', event: 'push', head_branch: 'dev', head_sha: 'a', html_url: '', created_at: `2026-09-05T0${9 - page}:00:00Z`, updated_at: '', status: 'completed', conclusion: 'success'}
            ]});
        };

        const client           = createGithubActionsClient({repoSlug: 'neomjs/neo', token: 'secret', fetchImpl}),
              {runs, complete} = await client.listRuns({since: '2026-09-05T00:00:00Z', perPage: 2, maxPages: 2});

        expect(complete).toBe(false);
        expect(runs).toHaveLength(4);
        expect(runs[0].createdAt, 'oldest first; the caller keeps since..this as the slice to drain').toBe('2026-09-05T07:00:00Z');
        expect(calls).toHaveLength(2);

        await client.listRuns({since: '2026-09-05T00:00:00Z', until: '2026-09-05T07:00:00Z', perPage: 2, maxPages: 1});

        expect(calls[2]).toBe('https://api.github.com/repos/neomjs/neo/actions/runs?per_page=2&page=1&created=2026-09-05T00%3A00%3A00Z..2026-09-05T07%3A00%3A00Z');
    });

    test('getRun reads one run by id', async () => {
        const fetchImpl = async url => {
            if (url.endsWith('/actions/runs/20')) {
                return jsonResponse({id: 20, name: 'Engine Tests', path: '.github/workflows/test.yml', event: 'push', head_branch: 'dev', head_sha: 'c', html_url: 'https://github.com/neomjs/neo/actions/runs/20', created_at: '2026-09-05T00:30:00Z', updated_at: '2026-09-05T02:00:00Z', status: 'completed', conclusion: 'failure'});
            }
            return jsonResponse({message: 'Not Found'}, {status: 404});
        };

        const client = createGithubActionsClient({repoSlug: 'neomjs/neo', token: 'secret', fetchImpl});

        expect(await client.getRun(20)).toMatchObject({id: 20, status: 'completed', conclusion: 'failure', headSha: 'c'});
        await expect(client.getRun(21)).rejects.toThrow(/404/);
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

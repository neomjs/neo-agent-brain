/**
 * @summary The GitHub Actions REST reads the CI failure ingestor needs — runs in a window, one run by
 * id, a run's jobs, a job's log — and the one Contents read that proves a spec exists at a run's
 * head, behind an injectable `fetch`.
 *
 * The Actions surface is REST-only (workflow runs, jobs and logs have no GraphQL projection), so
 * this is a sibling of `Neo.ai.services.github-workflow.GraphqlService`, not a replacement. The
 * credential is the same env pair that service reads first (`GH_TOKEN`, then `GITHUB_TOKEN`);
 * its `gh auth token` fallback is deliberately absent here, because this module sits in the
 * closure of a container-plane orchestrator task and a shell-out would pin that task to the host.
 * Pagination is bounded by the caller's window; a log fetch follows the API's redirect to blob
 * storage and returns text.
 *
 * @module ai/services/ingestion/githubActions
 */

const API_VERSION = '2022-11-28';
const USER_AGENT  = 'neo-agent-brain ci-failure-ingestor';

/**
 * @summary Resolves the GitHub credential: explicit override → `GH_TOKEN` → `GITHUB_TOKEN`.
 * The token is never logged; the failure names the knobs to set.
 * @param {Object} [options]
 * @param {String} [options.override]
 * @param {Object} [options.env=process.env]
 * @returns {String}
 * @throws {Error} When no credential is available.
 */
export function resolveGithubToken({override = null, env = process.env} = {}) {
    const token = (override && String(override).trim()) || env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();

    if (token) return token;

    throw new Error('Could not authenticate with GitHub: set GH_TOKEN or GITHUB_TOKEN.');
}

/**
 * @summary Projects one API run into the shape the ingestor reads.
 * @param {Object} run A `workflow_runs` entry.
 * @returns {{id: Number, name: String, path: String, event: String, headBranch: String, headSha: String, htmlUrl: String, createdAt: String, updatedAt: String, status: String, conclusion: String|null}}
 */
function mapRun(run) {
    return {
        id        : run.id,
        name      : run.name,
        path      : run.path,
        event     : run.event,
        headBranch: run.head_branch,
        headSha   : run.head_sha,
        htmlUrl   : run.html_url,
        createdAt : run.created_at,
        updatedAt : run.updated_at,
        status    : run.status,
        conclusion: run.conclusion
    };
}

/**
 * @summary Builds a bounded Actions REST client for one repository.
 * @param {Object}   options
 * @param {String}   options.repoSlug  e.g. `neomjs/neo`
 * @param {String}   options.token
 * @param {Function} [options.fetchImpl=globalThis.fetch]
 * @param {String}   [options.apiBase='https://api.github.com']
 * @param {Number}   [options.timeoutMs=30000] Per-request bound — a supervised child must not hang on one read.
 * @returns {{listRuns: Function, getRun: Function, listJobs: Function, fetchJobLog: Function, fileExists: Function}}
 */
export function createGithubActionsClient({repoSlug, token, fetchImpl = globalThis.fetch, apiBase = 'https://api.github.com', timeoutMs = 30000}) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(String(repoSlug || ''))) {
        throw new Error(`githubActions: repoSlug must be owner/name, got "${repoSlug}"`);
    }
    if (!token) {
        throw new Error('githubActions: a token is required');
    }

    const base    = `${apiBase.replace(/\/+$/, '')}/repos/${repoSlug}`,
          headers = {
              Accept                : 'application/vnd.github+json',
              Authorization         : `Bearer ${token}`,
              'User-Agent'          : USER_AGENT,
              'X-GitHub-Api-Version': API_VERSION
          };

    async function request(url, {text = false, allow404 = false} = {}) {
        const response = await fetchImpl(url, {headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs)});

        if (allow404 && response.status === 404) {
            return null;
        }

        if (!response.ok) {
            throw new Error(`githubActions: ${response.status} ${response.statusText || ''} for ${url.replace(apiBase, '')}`.trim());
        }

        return text ? response.text() : response.json();
    }

    return {
        /**
         * @summary Runs created at or after `since`, oldest first, across every workflow and every
         * status — the caller keeps the ones still running as pending and finishes them by id later,
         * because the API filters on creation time and a run can complete hours after it was created.
         * @param {Object} options
         * @param {String} options.since  ISO-8601 instant.
         * @param {Number} [options.perPage=100]
         * @param {Number} [options.maxPages=5]
         * @returns {Promise<Object[]>} See {@link mapRun}.
         */
        async listRuns({since, perPage = 100, maxPages = 5}) {
            const runs = [];

            for (let page = 1; page <= maxPages; page++) {
                const query = new URLSearchParams({per_page: String(perPage), page: String(page), created: `>=${since}`}),
                      data  = await request(`${base}/actions/runs?${query}`);

                const pageRuns = data.workflow_runs || [];

                for (const run of pageRuns) {
                    if (Date.parse(run.created_at) < Date.parse(since)) continue;

                    runs.push(mapRun(run));
                }

                // Pages come newest first: a page whose oldest run predates the window ends the read,
                // whatever the server made of the `created` filter.
                if (pageRuns.length < perPage || Date.parse(pageRuns[pageRuns.length - 1].created_at) < Date.parse(since)) break;
            }

            return runs.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        },

        /**
         * @summary One run by id — how a run that was still running when its window was read is
         * finished on a later tick.
         * @param {Number} runId
         * @returns {Promise<Object>} See {@link mapRun}.
         */
        async getRun(runId) {
            return mapRun(await request(`${base}/actions/runs/${runId}`));
        },

        /**
         * @summary A run's jobs with their steps — the step conclusions are the evidence rule's input.
         * @param {Number} runId
         * @returns {Promise<Object[]>} `{id, name, conclusion, htmlUrl, steps: [{name, conclusion}]}`
         */
        async listJobs(runId) {
            const data = await request(`${base}/actions/runs/${runId}/jobs?per_page=100`);

            return (data.jobs || []).map(job => ({
                id        : job.id,
                name      : job.name,
                conclusion: job.conclusion,
                htmlUrl   : job.html_url,
                steps     : (job.steps || []).map(step => ({name: step.name, conclusion: step.conclusion}))
            }));
        },

        /**
         * @summary The job's plain-text log, timestamps included.
         * @param {Number} jobId
         * @returns {Promise<String>}
         */
        fetchJobLog(jobId) {
            return request(`${base}/actions/jobs/${jobId}/logs`, {text: true});
        },

        /**
         * @summary Whether a file exists in the repository at a ref — the proof that a test could have
         * run in the job whose green colour is offered as recovery evidence. A 404 is `false`; any
         * other failure throws, so an unreadable answer is never mistaken for an absent file.
         * @param {Object} options
         * @param {String} options.path Repository-relative file path.
         * @param {String} options.ref  A commit SHA or ref name.
         * @returns {Promise<Boolean>}
         */
        async fileExists({path, ref}) {
            const encoded = String(path).split('/').map(encodeURIComponent).join('/'),
                  data    = await request(`${base}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, {allow404: true});

            return data !== null;
        }
    };
}

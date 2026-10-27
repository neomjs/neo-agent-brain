import {test, expect}  from '@playwright/test';
import {execFile}      from 'node:child_process';
import fs              from 'fs/promises';
import os              from 'node:os';
import path            from 'path';
import process         from 'node:process';
import {promisify}     from 'node:util';
import {pathToFileURL} from 'node:url';

const cliScriptPath      = path.resolve(process.cwd(), 'ai/scripts/maintenance/syncGithubWorkflow.mjs');
const configResolverPath = path.resolve(process.cwd(), 'test/playwright/configTemplateResolver.mjs');
const execFileAsync      = promisify(execFile);

/**
 * @summary Runs the pure corpus destination guard in a fresh Node process with template-backed
 * config, so each child gets its own reactive config realm and environment snapshot.
 * @param {Object} [options]
 * @param {String|undefined} [options.contentRoot] Corpus root value; omitted means absent.
 * @param {Object} [options.env] Additional child-only environment overrides.
 * @returns {Promise<{code: Number, stdout: String, stderr: String}>}
 */
async function runCorpusGuardChild({contentRoot, env = {}} = {}) {
    const childEnv = {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${configResolverPath}`]
            .filter(Boolean)
            .join(' '),
        ...env
    };

    if (contentRoot === undefined) delete childEnv.NEO_MCP_GITHUB_CONTENT_ROOT;
    else childEnv.NEO_MCP_GITHUB_CONTENT_ROOT = contentRoot;

    const script = `
        const {assertCorpusDestination} = await import(${JSON.stringify(pathToFileURL(cliScriptPath).href)});
        try {
            await assertCorpusDestination();
            console.log(JSON.stringify({accepted: true}));
        } catch (error) {
            console.log(JSON.stringify({accepted: false, message: error.message}));
            process.exitCode = 1;
        }
    `;

    try {
        const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
            cwd      : process.cwd(),
            env      : childEnv,
            maxBuffer: 1024 * 1024
        });

        return {code: 0, stdout: result.stdout, stderr: result.stderr};
    } catch (error) {
        return {
            code  : typeof error.code === 'number' ? error.code : 1,
            stdout: error.stdout ?? '',
            stderr: error.stderr ?? ''
        };
    }
}

/**
 * @summary Runs the actual CLI in a fresh process with the repository config-template resolver.
 * @param {Object} [options]
 * @param {String[]} [options.args] CLI arguments.
 * @param {String|undefined} [options.contentRoot] Corpus root value; omitted means absent.
 * @param {String} [options.preload] Data URL installing acquisition and forbidden-effect controls.
 * @param {Object} [options.env] Additional child-only environment overrides.
 * @returns {Promise<{code: Number, stdout: String, stderr: String}>}
 */
async function runCliChild({args = [], contentRoot, preload, env = {}} = {}) {
    const childEnv = {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${configResolverPath}`, preload && `--import=${preload}`]
            .filter(Boolean)
            .join(' '),
        ...env
    };

    if (contentRoot === undefined) delete childEnv.NEO_MCP_GITHUB_CONTENT_ROOT;
    else childEnv.NEO_MCP_GITHUB_CONTENT_ROOT = contentRoot;

    try {
        const result = await execFileAsync(process.execPath, [cliScriptPath, ...args], {
            cwd      : process.cwd(),
            env      : childEnv,
            maxBuffer: 1024 * 1024
        });

        return {code: 0, stdout: result.stdout, stderr: result.stderr};
    } catch (error) {
        return {
            code  : typeof error.code === 'number' ? error.code : 1,
            stdout: error.stdout ?? '',
            stderr: error.stderr ?? ''
        };
    }
}

/**
 * @summary Builds one GitHub issue node as the sync queries return it.
 * @param {Object} [overrides] Fields replacing those of the open fixture issue, number 101.
 * @returns {Object}
 */
function issueNode(overrides = {}) {
    return {number: 101, title: 'Corpus issue', body: 'issue body', state: 'OPEN', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', closedAt: null, url: 'https://github.com/neomjs/neo/issues/101', author: {login: 'fixture'}, labels: {nodes: []}, assignees: {nodes: []}, milestone: null, parent: null, subIssues: {nodes: []}, subIssuesSummary: {total: 0, completed: 0, percentCompleted: 0}, blockedBy: {nodes: []}, blocking: {nodes: []}, timelineItems: {nodes: [], pageInfo: {hasNextPage: false, endCursor: null}}, ...overrides};
}

/**
 * @summary Builds one GitHub discussion node as the sync queries return it.
 * @param {Object} [overrides] Fields replacing those of the open fixture discussion, number 102.
 * @returns {Object}
 */
function discussionNode(overrides = {}) {
    return {number: 102, title: 'Corpus discussion', body: 'discussion body', closed: false, closedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', author: {login: 'fixture'}, category: {name: 'General'}, comments: {nodes: [], totalCount: 0, pageInfo: {hasNextPage: false, endCursor: null}}, ...overrides};
}

/**
 * @summary Builds one GitHub pull-request node as the sync queries return it.
 * @param {Object} [overrides] Fields replacing those of the open fixture pull request, number 103.
 * @returns {Object}
 */
function pullNode(overrides = {}) {
    return {number: 103, title: 'Corpus pull', body: 'pull body', state: 'OPEN', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', closedAt: null, mergedAt: null, headRefName: 'fixture', baseRefName: 'dev', url: 'https://github.com/neomjs/neo/pull/103', author: {login: 'fixture'}, milestone: null, comments: {nodes: []}, reviews: {nodes: []}, ...overrides};
}

/**
 * @summary Controls remote acquisition while exercising the actual CLI and filesystem writers. With
 * `fail`, every request throws a marker, so a run that must not reach GitHub can prove it did not.
 * @param {Object} [options]
 * @param {Boolean} [options.fail=false] Refuse all acquisition for the failure control.
 * @param {Boolean} [options.releases=true] False answers as a repository that has never cut a release.
 * @param {Object[]} [options.issues] The delta's issue nodes; defaults to the open fixture issue alone.
 * @param {Object} [options.singles={}] Issue nodes by number for single-issue refetches; others are absent.
 * @param {Object} [options.singlePulls={}] Pull-request nodes by number for single-pull refetches; others are absent.
 * @param {Object} [options.singleDiscussions={}] Discussion nodes by number for single-discussion refetches; others are absent.
 * @returns {String} Node preload data URL.
 */
function corpusAcquisitionPreload({fail = false, releases = true, issues = [issueNode()], singles = {}, singlePulls = {}, singleDiscussions = {}} = {}) {
    const release    = releases ? "{tagName:'v1.0.0',name:'v1.0.0',description:'fixture',publishedAt:'2026-01-03T00:00:00Z',url:'https://example.test/release'}" : '';
    const discussion = discussionNode();
    const pull       = pullNode();
    const source     = `
      import Neo from ${JSON.stringify(pathToFileURL(path.resolve(process.cwd(), 'node_modules/neo.mjs/src/Neo.mjs')).href)};
      import ${JSON.stringify(pathToFileURL(path.resolve(process.cwd(), 'node_modules/neo.mjs/src/core/_export.mjs')).href)};
      import GraphqlService from ${JSON.stringify(pathToFileURL(path.resolve(process.cwd(), 'ai/services/github-workflow/GraphqlService.mjs')).href)};
      ${fail ? "GraphqlService.query = async () => { throw new Error('controlled acquisition failure') };" : `
      GraphqlService.query = async (query, variables) => {
        if (query.includes('FetchLatestRelease')) return {repository:{latestRelease:${releases ? "{tagName:'v1.0.0',publishedAt:'2026-01-03T00:00:00Z'}" : 'null'}}};
        if (query.includes('FetchReleases')) return {repository:{releases:{nodes:[${release}],pageInfo:{hasNextPage:false,endCursor:null}}}};
        if (query.includes('FetchSingleIssue')) return {repository:{issue:${JSON.stringify(singles)}[variables.number] ?? null}};
        if (query.includes('FetchSinglePullForSync')) return {repository:{pullRequest:${JSON.stringify(singlePulls)}[variables.prNumber] ?? null}};
        if (query.includes('FetchSingleDiscussionForSync')) return {repository:{discussion:${JSON.stringify(singleDiscussions)}[variables.number] ?? null}};
        if (query.includes('FetchIssuesForSync')) return {rateLimit:{cost:1,remaining:5000,resetAt:'2026-01-04T00:00:00Z'},repository:{issues:{nodes:${JSON.stringify(issues)},pageInfo:{hasNextPage:false,endCursor:null}}}};
        if (query.includes('FetchDiscussionsForSync')) return {repository:{discussions:{nodes:[${JSON.stringify(discussion)}],pageInfo:{hasNextPage:false,endCursor:null}}}};
        if (query.includes('FetchPullRequestsForSync')) return {repository:{pullRequests:{nodes:[${JSON.stringify(pull)}],pageInfo:{hasNextPage:false,endCursor:null}}}};
        throw new Error('unexpected acquisition query');
      };`}
    `;
    return `data:text/javascript,${encodeURIComponent(source)}`;
}

/**
 * @summary Runs `parseRefetchNumbers` for one flag over each argument list in one fresh Node process.
 * @param {String} flag The refetch flag to parse.
 * @param {String[][]} argvs Argument lists.
 * @returns {Promise<Object[]>} Per list, `{numbers}` or `{error}`.
 */
async function parseRefetchNumbersInChild(flag, argvs) {
    const script = `
        const {parseRefetchNumbers} = await import(${JSON.stringify(pathToFileURL(cliScriptPath).href)});
        console.log(JSON.stringify(${JSON.stringify(argvs)}.map(argv => {
            try { return {numbers: parseRefetchNumbers(argv, ${JSON.stringify(flag)})} } catch (error) { return {error: error.message} }
        })));
    `;
    const {stdout} = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
        cwd      : process.cwd(),
        env      : {...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${configResolverPath}`].filter(Boolean).join(' ')},
        maxBuffer: 1024 * 1024
    });

    return JSON.parse(stdout.trim().split('\n').pop());
}

/**
 * @summary Creates and removes a fixture root owned exclusively by this test file.
 * @param {Function} callback Fixture callback.
 * @returns {Promise<*>}
 */
async function withOwnedFixture(callback) {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-sync-github-workflow-'));

    try {
        return await callback({
            corpusRoot : path.join(fixtureRoot, 'corpus'),
            fixtureRoot,
            outsideRoot: path.join(fixtureRoot, 'outside')
        });
    } finally {
        await fs.rm(fixtureRoot, {force: true, recursive: true});
    }
}

/**
 * @summary Regression coverage for the corpus emission CLI.
 *
 * Every arm runs the real script or its pure destination guard in a fresh process, with acquisition
 * controlled by a preload, so the suite never reaches GitHub. Corpus emission is the CLI's one mode,
 * and a run without `--corpus-only` must refuse before it takes a lease or makes a request.
 */
test.describe('syncGithubWorkflow CLI', () => {
    for (const args of [[], ['--verbose'], ['--emit-only'], ['--corpus-only', '--emit-only'], ['--refetch-issues=5']]) {
        test(`refuses ${JSON.stringify(args)} before the lease or any request, naming --corpus-only`, async () => {
            await withOwnedFixture(async ({corpusRoot}) => {
                await fs.mkdir(corpusRoot);
                const result = await runCliChild({args, contentRoot: corpusRoot, preload: corpusAcquisitionPreload({fail: true})});
                const output = `${result.stdout}\n${result.stderr}`;

                expect(result.code).toBe(1);
                expect(output).toContain('run it with --corpus-only');
                expect(output).not.toContain('controlled acquisition failure');
                expect(output).not.toContain('Starting');
                expect(await fs.readdir(corpusRoot)).toEqual([]);
            });
        });
    }

    test('validates before it loads the emitter, and loads it before the lease', async () => {
        const source = await fs.readFile(cliScriptPath, 'utf8');

        const
            refusalIndex     = source.indexOf("throw new Error('syncGithubWorkflow emits the corpus only"),
            corpusGuardIndex = source.indexOf('await assertCorpusDestination();'),
            importIndex      = source.indexOf(
                "const {default: GH_SyncService} = await import('../../services/github-workflow/SyncService.mjs');"
            ),
            leaseIndex       = source.indexOf('outcome = await withHeavyMaintenanceLease(');

        expect(refusalIndex, 'mode refusal must exist').toBeGreaterThan(-1);
        expect(corpusGuardIndex, 'corpus destination guard call must exist').toBeGreaterThan(-1);
        expect(importIndex, 'SyncService must load dynamically after validation').toBeGreaterThan(-1);
        expect(leaseIndex, 'lease call must exist').toBeGreaterThan(-1);

        expect(refusalIndex).toBeLessThan(corpusGuardIndex);
        expect(corpusGuardIndex).toBeLessThan(importIndex);
        expect(importIndex).toBeLessThan(leaseIndex);
    });

    test('keeps the literals the corpus publisher greps for before it invokes the CLI', async () => {
        const source = await fs.readFile(cliScriptPath, 'utf8');

        // neomjs/github-content-sync publish-corpus.yml refuses a Brain whose CLI lacks a flag it passes.
        expect(source).toContain('corpus-only');
        expect(source).toContain('--refetch-issues');
        expect(source).toContain('--refetch-pulls');
        expect(source).toContain('--refetch-discussions');
    });

    test('a held lease fails the run', async () => {
        const
            source = await fs.readFile(cliScriptPath, 'utf8'),
            held   = source.match(/outcome\.status === 'held'\) \{[\s\S]*?process\.exit\((\d)\)/);

        expect(held?.[1], 'the held branch must exit nonzero').toBe('1')
    });

    test('refuses an absent corpus root in the CLI child before importing the emitter', async () => {
        const result = await runCliChild({args: ['--corpus-only']});
        const output = `${result.stdout}\n${result.stderr}`;

        expect(result.code).toBe(1);
        expect(output).toContain('Corpus emission requires an explicit destination');
        expect(output).not.toContain('Starting origin-qualified conversation corpus emission');
        expect(output).not.toContain('Sync failed');
    });

    test('rejects relative and non-directory corpus roots in fresh guard children', async () => {
        const relative = await runCorpusGuardChild({contentRoot: 'relative/corpus'});

        expect(relative.code).toBe(1);
        expect(relative.stdout).toContain('Corpus contentRoot must be absolute.');

        await withOwnedFixture(async ({fixtureRoot}) => {
            const fileRoot = path.join(fixtureRoot, 'corpus-file');
            await fs.writeFile(fileRoot, 'not a directory');

            const nonDirectory = await runCorpusGuardChild({contentRoot: fileRoot});

            expect(nonDirectory.code).toBe(1);
            expect(nonDirectory.stdout).toContain(
                'Corpus contentRoot must be a directory outside the installed runtime and Engine.'
            );
        });
    });

    test('rejects runtime roots and symlink escapes before corpus emission', async () => {
        const runtimeRoot = await runCorpusGuardChild({contentRoot: process.cwd()});

        expect(runtimeRoot.code).toBe(1);
        expect(runtimeRoot.stdout).toContain(
            'Corpus contentRoot must be a directory outside the installed runtime and Engine.'
        );

        await withOwnedFixture(async ({corpusRoot, outsideRoot}) => {
            await fs.mkdir(corpusRoot);
            await fs.mkdir(outsideRoot);
            await fs.symlink(outsideRoot, path.join(corpusRoot, 'neo'), 'dir');

            const symlinkEscape = await runCorpusGuardChild({contentRoot: corpusRoot});

            expect(symlinkEscape.code).toBe(1);
            expect(symlinkEscape.stdout).toMatch(/Corpus originRoot (escapes contentRoot|must be its own directory)/);
        });
    });

    test('accepts an external root with the default neomjs/neo origin layout', async () => {
        await withOwnedFixture(async ({corpusRoot}) => {
            await fs.mkdir(corpusRoot);

            const result = await runCorpusGuardChild({contentRoot: corpusRoot});

            expect(result.code).toBe(0);
            expect(result.stdout).toContain('"accepted":true');
        });
    });

    test('rejects nested symlinks and dot source names before loading the emitter', async () => {
        await withOwnedFixture(async ({corpusRoot, outsideRoot}) => {
            const issues = path.join(corpusRoot, 'neo', 'issues');
            await fs.mkdir(issues, {recursive: true});
            await fs.mkdir(outsideRoot);
            await fs.symlink(outsideRoot, path.join(issues, 'chunk-1'), 'dir');

            const nested = await runCorpusGuardChild({contentRoot: corpusRoot});
            expect(nested.code).toBe(1);
            expect(nested.stdout).toContain('Corpus origin tree must not contain symbolic links.');
            expect(await fs.readdir(outsideRoot)).toEqual([]);

            const dot = await runCorpusGuardChild({contentRoot: corpusRoot, env: {NEO_MCP_GITHUB_REPO: '.'}});
            expect(dot.code).toBe(1);
            expect(dot.stdout).toContain('Corpus source owner and repo must be GitHub name segments.');
        });
    });

    test('rejects a child directory override that escapes the admitted origin', async () => {
        await withOwnedFixture(async ({corpusRoot, outsideRoot}) => {
            await fs.mkdir(corpusRoot);
            await fs.mkdir(outsideRoot);

            const result = await runCorpusGuardChild({
                contentRoot: corpusRoot,
                env        : {NEO_MCP_GITHUB_ISSUES_DIR: path.join(outsideRoot, 'issues')}
            });

            expect(result.code).toBe(1);
            expect(result.stdout).toContain('Corpus issuesDir escapes its origin root.');

            const notes = await runCorpusGuardChild({
                contentRoot: corpusRoot,
                env        : {NEO_MCP_GITHUB_RELEASE_NOTES_DIR: path.join(outsideRoot, 'release-notes')}
            });

            expect(notes.code).toBe(1);
            expect(notes.stdout).toContain('Corpus releaseNotesDir escapes its origin root.');
        });
    });

    test('actual corpus CLI emits all conversation facets and the release notes into the external destination only', async () => {
        await withOwnedFixture(async ({corpusRoot}) => {
            await fs.mkdir(corpusRoot);
            const result = await runCliChild({
                args       : ['--corpus-only'],
                contentRoot: corpusRoot,
                preload    : corpusAcquisitionPreload()
            });

            expect(result.code, result.stderr).toBe(0);
            expect((await fs.readdir(corpusRoot)).sort()).toEqual(['_index.json', 'neo']);
            const origin = path.join(corpusRoot, 'neo');
            for (const file of ['issues/chunk-1/issue-101.md', 'discussions/chunk-1/discussion-102.md', 'pulls/chunk-1/pr-103.md']) {
                await expect(fs.readFile(path.join(origin, file), 'utf8')).resolves.not.toHaveLength(0);
            }
            const index = JSON.parse(await fs.readFile(path.join(corpusRoot, '_index.json'), 'utf8'));
            expect(index).toEqual(expect.arrayContaining([
                expect.objectContaining({repoSlug: 'neo', type: 'issues', path: 'neo/issues/chunk-1/issue-101.md'}),
                expect.objectContaining({repoSlug: 'neo', type: 'discussions', path: 'neo/discussions/chunk-1/discussion-102.md'}),
                expect.objectContaining({repoSlug: 'neo', type: 'pulls', path: 'neo/pulls/chunk-1/pr-103.md'})
            ]));
            const metadata = JSON.parse(await fs.readFile(path.join(origin, '.sync-metadata.json'), 'utf8'));
            expect(metadata.issues['101'].path).toBe('neo/issues/chunk-1/issue-101.md');
            await expect(fs.readFile(path.join(origin, 'release-notes/chunk-1/v1.0.0.md'), 'utf8')).resolves.toContain('fixture');
            const notesIndex = JSON.parse(await fs.readFile(path.join(origin, 'release-notes/_index.json'), 'utf8'));
            // Each note's corpus-relative path, the form the root index uses: a reader takes identity from the index
            expect(notesIndex.items['v1.0.0']).toEqual({itemIndex: 0, chunk: 1, chunkDir: 'chunk-1', path: 'neo/release-notes/chunk-1/v1.0.0.md'});
            expect(metadata.releases['v1.0.0'].contentHash).toMatch(/^[0-9a-f]{64}$/);

            const second = await runCliChild({
                args   : ['--corpus-only'], contentRoot: corpusRoot,
                preload: corpusAcquisitionPreload(), env: {NEO_MCP_GITHUB_REPO: 'neo-agent-brain'}
            });
            expect(second.code, second.stderr).toBe(0);
            expect(JSON.parse(await fs.readFile(path.join(origin, '.sync-metadata.json'), 'utf8'))).toEqual(metadata);
            const otherMetadata = JSON.parse(await fs.readFile(path.join(corpusRoot, 'neo-agent-brain', '.sync-metadata.json'), 'utf8'));
            expect(otherMetadata.issues['101'].path).toBe('neo-agent-brain/issues/chunk-1/issue-101.md');
            const combined = JSON.parse(await fs.readFile(path.join(corpusRoot, '_index.json'), 'utf8'));
            expect(combined).toHaveLength(6);
            expect(combined.filter(entry => entry.repoSlug === 'neo')).toEqual(index);
            expect(combined.filter(entry => entry.repoSlug === 'neo-agent-brain')).toHaveLength(3);
        });
    });

    test('actual corpus CLI writes the notes for a corpus whose metadata caches releases without them', async () => {
        await withOwnedFixture(async ({corpusRoot}) => {
            const origin = path.join(corpusRoot, 'neo');

            // The published corpus's shape: every release cached as {publishedAt} only, the latest current
            await fs.mkdir(origin, {recursive: true});
            await fs.writeFile(path.join(origin, '.sync-metadata.json'), JSON.stringify({
                lastSync: null, issues: {}, pulls: {}, discussions: {},
                releases: {'v1.0.0': {publishedAt: '2026-01-03T00:00:00Z'}}
            }));

            const result = await runCliChild({args: ['--corpus-only'], contentRoot: corpusRoot, preload: corpusAcquisitionPreload()});

            expect(result.code, result.stderr).toBe(0);
            await expect(fs.readFile(path.join(origin, 'release-notes/chunk-1/v1.0.0.md'), 'utf8')).resolves.toContain('fixture');
        });
    });

    test('actual corpus CLI gives an origin without releases no release-notes folder', async () => {
        await withOwnedFixture(async ({corpusRoot}) => {
            await fs.mkdir(corpusRoot);
            const result = await runCliChild({args: ['--corpus-only'], contentRoot: corpusRoot, preload: corpusAcquisitionPreload({releases: false})});

            expect(result.code, result.stderr).toBe(0);
            await expect(fs.access(path.join(corpusRoot, 'neo', 'issues'))).resolves.toBeUndefined();
            await expect(fs.access(path.join(corpusRoot, 'neo', 'release-notes'))).rejects.toThrow();
        });
    });

    for (const flag of ['--refetch-issues', '--refetch-pulls', '--refetch-discussions']) {
        test(`parseRefetchNumbers reads ${flag} as a list of positive integers and refuses anything else`, async () => {
            const [absent, otherFlag, list, single, ...refused] = await parseRefetchNumbersInChild(flag, [
                [], ['--refetch-other=5'], [`${flag}=19565,19637,19565`], [`${flag}=7`],
                [`${flag}=1;id`], [`${flag}=1 2`], [`${flag}=-1`], [`${flag}=0`],
                [`${flag}=12,`], [`${flag}=99999999999999999999`],
                [flag, '5'], [`${flag}=1`, `${flag}=2`]
            ]);

            expect(absent).toEqual({numbers: []});
            expect(otherFlag).toEqual({numbers: []});
            expect(list).toEqual({numbers: [19565, 19637]});
            expect(single).toEqual({numbers: [7]});
            expect(refused.map(result => result.error)).toEqual([
                ...['1;id', '1 2', '-1', '0', '', '99999999999999999999']
                    .map(token => `${flag} takes positive numbers, not "${token}".`),
                ...Array(2).fill(`${flag} takes one comma-separated list: ${flag}=<n,…>.`)
            ]);
        });
    }

    test('refuses a non-integer --refetch-pulls token in the CLI child before importing the emitter', async () => {
        await withOwnedFixture(async ({corpusRoot}) => {
            await fs.mkdir(corpusRoot);
            const result = await runCliChild({args: ['--corpus-only', '--refetch-pulls=12,1;id'], contentRoot: corpusRoot});
            const output = `${result.stdout}\n${result.stderr}`;

            expect(result.code).toBe(1);
            expect(output).toContain('--refetch-pulls takes positive numbers, not "1;id".');
            expect(output).not.toContain('Starting origin-qualified conversation corpus emission');
            expect(await fs.readdir(corpusRoot)).toEqual([]);
        });
    });

    test('actual corpus CLI rewrites a named issue whose stale copy the delta never revisits', async () => {
        await withOwnedFixture(async ({corpusRoot}) => {
            const
                origin = path.join(corpusRoot, 'neo'),
                stale  = path.join(origin, 'issues/chunk-1/issue-201.md'),
                fresh  = issueNode({number: 201, title: 'Fresh title', state: 'CLOSED', updatedAt: '2026-01-04T00:00:00Z', closedAt: '2026-01-04T00:00:00Z', url: 'https://github.com/neomjs/neo/issues/201'});

            // The drift this flag heals: the metadata holds the fresh `updatedAt`, the file the stale rendering
            await fs.mkdir(path.dirname(stale), {recursive: true});
            await fs.writeFile(stale, "---\nid: 201\ntitle: Stale title\nstate: OPEN\nupdatedAt: '2026-01-02T00:00:00Z'\n---\nissue body\n");
            await fs.writeFile(path.join(origin, '.sync-metadata.json'), JSON.stringify({
                lastSync: '2026-01-05T00:00:00Z', pulls: {}, discussions: {},
                releases: {'v1.0.0': {publishedAt: '2026-01-03T00:00:00Z'}},
                issues  : {201: {state: 'CLOSED', path: 'neo/issues/chunk-1/issue-201.md', updatedAt: '2026-01-04T00:00:00Z', closedAt: '2026-01-04T00:00:00Z', milestone: null, title: 'Fresh title', contentHash: 'stale', commentsTotal: 0}}
            }));

            const result = await runCliChild({
                args       : ['--corpus-only', '--refetch-issues=201'],
                contentRoot: corpusRoot,
                preload    : corpusAcquisitionPreload({issues: [], singles: {201: fresh}})
            });

            expect(result.code, result.stderr).toBe(0);
            const
                copies   = (await fs.readdir(origin, {recursive: true})).filter(file => file.endsWith('issue-201.md')),
                metadata = JSON.parse(await fs.readFile(path.join(origin, '.sync-metadata.json'), 'utf8')),
                index    = JSON.parse(await fs.readFile(path.join(corpusRoot, '_index.json'), 'utf8'));

            expect(copies).toHaveLength(1);
            const markdown = await fs.readFile(path.join(origin, copies[0]), 'utf8');
            expect(markdown).toContain('state: CLOSED');
            expect(markdown).toContain('Fresh title');
            expect(metadata.issues['201']).toMatchObject({state: 'CLOSED', path: `neo/${copies[0]}`});
            expect(metadata.issues['201'].contentHash).not.toBe('stale');
            expect(index).toEqual(expect.arrayContaining([
                expect.objectContaining({repoSlug: 'neo', type: 'issues', id: 201, path: `neo/${copies[0]}`})
            ]));
        });
    });

    test('actual corpus CLI fails the run, and the issues facet, when a named issue does not come back', async () => {
        await withOwnedFixture(async ({corpusRoot}) => {
            await fs.mkdir(corpusRoot);
            const result = await runCliChild({args: ['--corpus-only', '--refetch-issues=202'], contentRoot: corpusRoot, preload: corpusAcquisitionPreload()});

            expect(result.code).toBe(1);
            expect(`${result.stdout}\n${result.stderr}`).toContain('Named issues were not refetched: #202');
            const metadata = JSON.parse(await fs.readFile(path.join(corpusRoot, 'neo', '.sync-metadata.json'), 'utf8'));
            expect(metadata.issues ?? {}).toEqual({});
        });
    });

    test('actual corpus CLI rewrites a named pull and a named discussion whose stale copies the delta never revisits', async () => {
        await withOwnedFixture(async ({corpusRoot}) => {
            const
                origin = path.join(corpusRoot, 'neo'),
                stale  = {pull: 'pulls/chunk-1/pr-301.md', discussion: 'discussions/chunk-1/discussion-302.md'};

            // The drift these flags heal: the metadata holds the current `updatedAt`, the files a stale rendering.
            for (const file of Object.values(stale)) {
                await fs.mkdir(path.join(origin, path.dirname(file)), {recursive: true});
                await fs.writeFile(path.join(origin, file), '---\ntitle: Stale\n---\nstale body\n');
            }
            await fs.writeFile(path.join(origin, '.sync-metadata.json'), JSON.stringify({
                lastSync   : '2026-01-05T00:00:00Z', issues: {},
                releases   : {'v1.0.0': {publishedAt: '2026-01-03T00:00:00Z'}},
                pulls      : {301: {number: 301, state: 'OPEN', path: `neo/${stale.pull}`, updatedAt: '2026-01-02T00:00:00Z', contentHash: 'stale'}},
                discussions: {302: {number: 302, closed: false, closedAt: null, path: `neo/${stale.discussion}`, updatedAt: '2026-01-02T00:00:00Z', contentHash: 'stale'}}
            }));

            const result = await runCliChild({
                args       : ['--corpus-only', '--refetch-pulls=301', '--refetch-discussions=302'],
                contentRoot: corpusRoot,
                preload    : corpusAcquisitionPreload({
                    issues           : [],
                    singlePulls      : {301: pullNode({number: 301, title: 'Fresh pull', url: 'https://github.com/neomjs/neo/pull/301'})},
                    singleDiscussions: {302: discussionNode({number: 302, title: 'Fresh discussion'})}
                })
            });

            expect(result.code, result.stderr).toBe(0);
            const
                files = await fs.readdir(origin, {recursive: true}),
                index = JSON.parse(await fs.readFile(path.join(corpusRoot, '_index.json'), 'utf8'));

            expect(files.filter(file => file.endsWith('pr-301.md'))).toEqual([stale.pull]);
            expect(files.filter(file => file.endsWith('discussion-302.md'))).toEqual([stale.discussion]);
            expect(await fs.readFile(path.join(origin, stale.pull), 'utf8')).toContain('Fresh pull');
            expect(await fs.readFile(path.join(origin, stale.discussion), 'utf8')).toContain('Fresh discussion');
            expect(index).toEqual(expect.arrayContaining([
                expect.objectContaining({repoSlug: 'neo', type: 'pulls', id: 301, path: `neo/${stale.pull}`}),
                expect.objectContaining({repoSlug: 'neo', type: 'discussions', id: 302, path: `neo/${stale.discussion}`})
            ]));
        });
    });

    test('actual corpus CLI fails the run, and each facet, when a named pull or discussion does not come back', async () => {
        await withOwnedFixture(async ({corpusRoot}) => {
            await fs.mkdir(corpusRoot);
            const result = await runCliChild({
                args       : ['--corpus-only', '--refetch-pulls=304', '--refetch-discussions=305'],
                contentRoot: corpusRoot,
                preload    : corpusAcquisitionPreload()
            });
            const output = `${result.stdout}\n${result.stderr}`;

            expect(result.code).toBe(1);
            expect(output).toContain('Named pull requests were not refetched: #304');
            expect(output).toContain('Named discussions were not refetched: #305');
        });
    });

    test('actual corpus CLI returns failure when controlled acquisition fails', async () => {
        await withOwnedFixture(async ({corpusRoot}) => {
            await fs.mkdir(corpusRoot);
            const result = await runCliChild({args: ['--corpus-only'], contentRoot: corpusRoot, preload: corpusAcquisitionPreload({fail: true})});
            expect(result.code).toBe(1);
            expect(`${result.stdout}\n${result.stderr}`).toContain('controlled acquisition failure');
        });
    });
});

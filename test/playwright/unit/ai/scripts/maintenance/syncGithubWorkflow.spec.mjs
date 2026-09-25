import {test, expect} from '@playwright/test';
import {execFile}    from 'node:child_process';
import fs             from 'fs/promises';
import os             from 'node:os';
import path           from 'path';
import process        from 'node:process';
import {promisify}    from 'node:util';
import {pathToFileURL} from 'node:url';

import {
    buildSyncGithubWorkflowDevBranchGuard
} from '../../../../../../ai/scripts/maintenance/syncGithubWorkflowBranchGuard.mjs';

const cliScriptPath = path.resolve(process.cwd(), 'ai/scripts/maintenance/syncGithubWorkflow.mjs');
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
 * @summary Controls remote acquisition while exercising the actual CLI and filesystem writers.
 * @param {Object} [options]
 * @param {Boolean} [options.fail=false] Refuse all acquisition for the failure control.
 * @param {Boolean} [options.releases=true] False answers as a repository that has never cut a release.
 * @returns {String} Node preload data URL.
 */
function corpusAcquisitionPreload({fail = false, releases = true} = {}) {
    const release = releases ? "{tagName:'v1.0.0',name:'v1.0.0',description:'fixture',publishedAt:'2026-01-03T00:00:00Z',url:'https://example.test/release'}" : '';
    const issue = {number: 101, title: 'Corpus issue', body: 'issue body', state: 'OPEN', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', closedAt: null, url: 'https://github.com/neomjs/neo/issues/101', author: {login: 'fixture'}, labels: {nodes: []}, assignees: {nodes: []}, milestone: null, parent: null, subIssues: {nodes: []}, subIssuesSummary: {total: 0, completed: 0, percentCompleted: 0}, blockedBy: {nodes: []}, blocking: {nodes: []}, timelineItems: {nodes: [], pageInfo: {hasNextPage: false, endCursor: null}}};
    const discussion = {number: 102, title: 'Corpus discussion', body: 'discussion body', closed: false, closedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', author: {login: 'fixture'}, category: {name: 'General'}, comments: {nodes: [], totalCount: 0, pageInfo: {hasNextPage: false, endCursor: null}}};
    const pull = {number: 103, title: 'Corpus pull', body: 'pull body', state: 'OPEN', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', closedAt: null, mergedAt: null, headRefName: 'fixture', baseRefName: 'dev', url: 'https://github.com/neomjs/neo/pull/103', author: {login: 'fixture'}, milestone: null, comments: {nodes: []}, reviews: {nodes: []}};
    const source = `
      import Neo from ${JSON.stringify(pathToFileURL(path.resolve(process.cwd(), 'node_modules/neo.mjs/src/Neo.mjs')).href)};
      import ${JSON.stringify(pathToFileURL(path.resolve(process.cwd(), 'node_modules/neo.mjs/src/core/_export.mjs')).href)};
      import GraphqlService from ${JSON.stringify(pathToFileURL(path.resolve(process.cwd(), 'ai/services/github-workflow/GraphqlService.mjs')).href)};
      ${fail ? "GraphqlService.query = async () => { throw new Error('controlled acquisition failure') };" : `
      GraphqlService.query = async query => {
        if (query.includes('FetchLatestRelease')) return {repository:{latestRelease:${releases ? "{tagName:'v1.0.0',publishedAt:'2026-01-03T00:00:00Z'}" : 'null'}}};
        if (query.includes('FetchReleases')) return {repository:{releases:{nodes:[${release}],pageInfo:{hasNextPage:false,endCursor:null}}}};
        if (query.includes('FetchIssuesForSync')) return {rateLimit:{cost:1,remaining:5000,resetAt:'2026-01-04T00:00:00Z'},repository:{issues:{nodes:[${JSON.stringify(issue)}],pageInfo:{hasNextPage:false,endCursor:null}}}};
        if (query.includes('FetchDiscussionsForSync')) return {repository:{discussions:{nodes:[${JSON.stringify(discussion)}],pageInfo:{hasNextPage:false,endCursor:null}}}};
        if (query.includes('FetchPullRequestsForSync')) return {repository:{pullRequests:{nodes:[${JSON.stringify(pull)}],pageInfo:{hasNextPage:false,endCursor:null}}}};
        throw new Error('unexpected acquisition query');
      };`}
      const {default: SyncService} = await import(${JSON.stringify(pathToFileURL(path.resolve(process.cwd(), 'ai/services/github-workflow/SyncService.mjs')).href)});
      for (const name of ['rebuildContentIndexesAndSeo', 'autoPushGeneratedContent']) SyncService[name] = async () => { throw new Error(name + ' must not run') };
      const {default: IssueSyncer} = await import(${JSON.stringify(pathToFileURL(path.resolve(process.cwd(), 'ai/services/github-workflow/sync/IssueSyncer.mjs')).href)});
      IssueSyncer.pushToGitHub = async () => { throw new Error('pushToGitHub must not run') };
    `;
    return `data:text/javascript,${encodeURIComponent(source)}`;
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
 * @summary Regression coverage for the manual GitHub Workflow sync CLI branch guard.
 *
 * The behavior tests exercise the pure guard helper with injected branch detectors so the
 * suite never runs the full GitHub sync. The wiring test source-checks the heavy CLI script
 * because importing it boots the canonical AI services SDK and is intentionally expensive.
 */
test.describe('syncGithubWorkflow CLI dev-branch guard (#12780)', () => {
    test('delegates when the active branch is dev', async () => {
        let   delegateCalls = 0;
        const guarded       = buildSyncGithubWorkflowDevBranchGuard(async (...args) => {
            delegateCalls++;
            return {args};
        }, async () => 'dev');

        const result = await guarded('full-sync');

        expect(delegateCalls).toBe(1);
        expect(result).toEqual({args: ['full-sync']});
    });

    test('rejects feature branches before delegate work begins', async () => {
        let   delegateCalls = 0;
        const guarded       = buildSyncGithubWorkflowDevBranchGuard(async () => {
            delegateCalls++;
        }, async () => 'codex/feature');

        await expect(guarded()).rejects.toThrow(/syncGithubWorkflow REJECTED.*codex\/feature.*not 'dev'/);
        expect(delegateCalls).toBe(0);
    });

    test('rejects main before delegate work begins', async () => {
        let   delegateCalls = 0;
        const guarded       = buildSyncGithubWorkflowDevBranchGuard(async () => {
            delegateCalls++;
        }, async () => 'main');

        await expect(guarded()).rejects.toThrow(/syncGithubWorkflow REJECTED.*main.*not 'dev'/);
        expect(delegateCalls).toBe(0);
    });

    test('names the scheduled Data Sync pipeline in remediation', async () => {
        const guarded = buildSyncGithubWorkflowDevBranchGuard(async () => {}, async () => 'codex/feature');

        await expect(guarded()).rejects.toThrow(/scheduled Data Sync pipeline/);
    });

    test('rejects detached HEAD before delegate work begins', async () => {
        const guarded = buildSyncGithubWorkflowDevBranchGuard(async () => {
            throw new Error('delegate must not run');
        }, async () => '');

        await expect(guarded()).rejects.toThrow(/syncGithubWorkflow REJECTED.*\(detached\)/);
    });

    test('preserves root-mismatch rejections from the branch detector', async () => {
        const guarded = buildSyncGithubWorkflowDevBranchGuard(async () => {
            throw new Error('delegate must not run');
        }, async () => {
            throw new Error('syncGithubWorkflow REJECTED: Root mismatch. CLI projectRoot ...');
        });

        await expect(guarded()).rejects.toThrow(/syncGithubWorkflow REJECTED: Root mismatch/);
    });

    test('wraps generic detector errors with a syncGithubWorkflow rejection', async () => {
        const guarded = buildSyncGithubWorkflowDevBranchGuard(async () => {
            throw new Error('delegate must not run');
        }, async () => {
            throw new Error('git: not a git repository');
        });

        await expect(guarded()).rejects.toThrow(/could not determine current branch.*not a git repository/);
    });

    test('wires both CLI guards before dynamic emitter import and lease acquisition', async () => {
        const source = await fs.readFile(cliScriptPath, 'utf8');

        const
            branchGuardIndex = source.indexOf('await assertSyncGithubWorkflowDevBranch();'),
            corpusGuardIndex = source.indexOf('if (corpusOnly) await assertCorpusDestination();'),
            importIndex      = source.indexOf(
                "const {default: GH_SyncService} = await import('../../services/github-workflow/SyncService.mjs');"
            ),
            startIndex       = source.indexOf('Starting full GitHub Workflow sync'),
            leaseIndex       = source.indexOf('outcome = await withHeavyMaintenanceLease('),
            corpusSyncIndex  = source.indexOf('? GH_SyncService.emitConversationCorpus()', leaseIndex),
            syncIndex        = source.indexOf(': GH_SyncService.runFullSync()', leaseIndex),
            emitIndex        = source.indexOf(
                'GH_SyncService.emitGeneratedContentAndDerive({pushLocalChanges: false})',
                leaseIndex
            ),
            autorunGate      = source.indexOf("if (import.meta.url === pathToFileURL(process.argv[1] || '').href)");

        expect(branchGuardIndex, 'branch guard call must exist').toBeGreaterThan(-1);
        expect(corpusGuardIndex, 'corpus destination guard call must exist').toBeGreaterThan(-1);
        expect(importIndex, 'SyncService must load dynamically after validation').toBeGreaterThan(-1);
        expect(startIndex, 'start log must exist').toBeGreaterThan(-1);
        expect(leaseIndex, 'heavy-maintenance lease call must exist').toBeGreaterThan(-1);
        expect(corpusSyncIndex, 'corpus-only emitter must exist').toBeGreaterThan(-1);
        expect(syncIndex, 'real sync delegate must exist').toBeGreaterThan(-1);
        expect(emitIndex, 'pull-only emission delegate must exist').toBeGreaterThan(-1);
        expect(autorunGate, 'import-safe CLI autorun gate must exist').toBeGreaterThan(-1);

        expect(branchGuardIndex).toBeLessThan(importIndex);
        expect(corpusGuardIndex).toBeLessThan(importIndex);
        expect(importIndex).toBeLessThan(startIndex);
        expect(importIndex).toBeLessThan(leaseIndex);
        expect(importIndex).toBeLessThan(corpusSyncIndex);
        expect(importIndex).toBeLessThan(syncIndex);
        expect(importIndex).toBeLessThan(emitIndex);
    });

    test('a held lease fails scheduled emission but keeps manual deferral non-erroring', async () => {
        const source = await fs.readFile(cliScriptPath, 'utf8');

        expect(source).toContain('process.exit(emitOnly || corpusOnly ? 1 : 0)')
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
                env         : {NEO_MCP_GITHUB_ISSUES_DIR: path.join(outsideRoot, 'issues')}
            });

            expect(result.code).toBe(1);
            expect(result.stdout).toContain('Corpus issuesDir escapes its origin root.');

            const notes = await runCorpusGuardChild({
                contentRoot: corpusRoot,
                env         : {NEO_MCP_GITHUB_RELEASE_NOTES_DIR: path.join(outsideRoot, 'release-notes')}
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
                args: ['--corpus-only'], contentRoot: corpusRoot,
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

    test('actual corpus CLI returns failure when controlled acquisition fails', async () => {
        await withOwnedFixture(async ({corpusRoot}) => {
            await fs.mkdir(corpusRoot);
            const result = await runCliChild({args: ['--corpus-only'], contentRoot: corpusRoot, preload: corpusAcquisitionPreload({fail: true})});
            expect(result.code).toBe(1);
            expect(`${result.stdout}\n${result.stderr}`).toContain('controlled acquisition failure');
        });
    });
});

import {setup} from '../../../../setup.mjs';

const appName = 'ReleaseNotesSyncerTest';

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

import {test, expect}  from '@playwright/test';
import Neo             from 'neo.mjs/src/Neo.mjs';
import * as core       from 'neo.mjs/src/core/_export.mjs';
import InstanceManager from 'neo.mjs/src/manager/Instance.mjs';
import fs              from 'fs-extra';
import path            from 'path';

test.describe('Neo.ai.services.github-workflow.sync.ReleaseNotesSyncer', () => {
    let ReleaseNotesSyncer;
    let GraphqlService;
    let issueSyncConfig;
    let aiConfig;
    let originalQuery;
    let originalContentRootOverride;
    let tmpRoot;
    let logger;

    test.beforeAll(async () => {
        aiConfig = (await import('../../../../../../ai/mcp/server/github-workflow/config.template.mjs')).default;
        issueSyncConfig = aiConfig.issueSync;
        originalContentRootOverride = issueSyncConfig.contentRootOverride;

        tmpRoot = path.resolve(process.cwd(), 'tmp', `release-syncer-test-${process.pid}-${Date.now()}`);
        await fs.ensureDir(tmpRoot);

        issueSyncConfig.contentRootOverride = tmpRoot;

        ReleaseNotesSyncer = (await import('../../../../../../ai/services/github-workflow/sync/ReleaseNotesSyncer.mjs')).default;
        GraphqlService     = (await import('../../../../../../ai/services/github-workflow/GraphqlService.mjs')).default;

        logger = (await import('../../../../../../ai/mcp/server/github-workflow/logger.mjs')).default;
        logger.level = 'silent';

        originalQuery = GraphqlService.query;
    });

    test.afterAll(async () => {
        issueSyncConfig.contentRootOverride = originalContentRootOverride;
        GraphqlService.query = originalQuery;
        await fs.remove(tmpRoot);
    });

    test.afterEach(() => {
        GraphqlService.query = originalQuery;
    });

    test('warm-cache path properly hydrates sortedReleases and skips full fetch', async () => {
        const metadata = {
            releases: {
                'v1.0.0': {publishedAt: '2024-01-01T00:00:00Z', contentHash: 'hash1'},
                'v1.1.0': {publishedAt: '2024-02-01T00:00:00Z', contentHash: 'hash2'}
            }
        };

        // Mock GraphqlService to only return the latest release
        let queryCallCount = 0;
        GraphqlService.query = async (queryName, variables) => {
            queryCallCount++;
            return {
                repository: {
                    latestRelease: { tagName: 'v1.1.0', publishedAt: '2024-02-01T00:00:00Z' }
                }
            };
        };

        await ReleaseNotesSyncer.fetchAndCacheReleases(metadata);

        // It should have hit the quick-check and returned without doing full pagination
        expect(queryCallCount).toBe(1);

        // Crucially, it must have populated sortedReleases
        expect(ReleaseNotesSyncer.sortedReleases).toEqual([
            { tagName: 'v1.0.0', publishedAt: '2024-01-01T00:00:00Z' },
            { tagName: 'v1.1.0', publishedAt: '2024-02-01T00:00:00Z' }
        ]);
        expect(ReleaseNotesSyncer.releases['v1.0.0']).toEqual(expect.objectContaining({
            tagName     : 'v1.0.0',
            publishedAt : '2024-01-01T00:00:00Z',
            contentHash : 'hash1',
            metadataOnly: true
        }));
        expect(ReleaseNotesSyncer.releases['v1.1.0']).toEqual(expect.objectContaining({
            tagName     : 'v1.1.0',
            publishedAt : '2024-02-01T00:00:00Z',
            contentHash : 'hash2',
            metadataOnly: true
        }));
    });

    test('syncNotes keeps a pruned warm-cache release whose note is on disk, without rewriting it', async () => {
        const start    = new Date(issueSyncConfig.syncStartDate).getTime();
        const inWindow = new Date(start + 86400000).toISOString();
        const metadata = {
            releases: {
                vCached: {publishedAt: inWindow, contentHash: 'cached-hash'}
            }
        };

        GraphqlService.query = async () => ({
            repository: {
                latestRelease: {tagName: 'vCached', publishedAt: inWindow}
            }
        });

        await ReleaseNotesSyncer.fetchAndCacheReleases(metadata);

        const releaseDir = issueSyncConfig.releaseNotesDir;
        await fs.emptyDir(releaseDir);
        await fs.outputFile(path.join(releaseDir, 'chunk-1', 'vCached.md'), 'on disk');

        const stats = await ReleaseNotesSyncer.syncNotes(metadata);

        expect(stats.count).toBe(0);
        expect(ReleaseNotesSyncer.releases.vCached.contentHash).toBe('cached-hash');
        expect(await fs.readFile(path.join(releaseDir, 'chunk-1', 'vCached.md'), 'utf-8')).toBe('on disk');

        const indexData = await fs.readJson(path.join(releaseDir, '_index.json'));
        expect(indexData.items.vCached).toEqual({itemIndex: 0, chunk: 1, chunkDir: 'chunk-1'});
    });

    test('syncNotes fails on a pruned release whose note is missing, writing neither markdown nor an index', async () => {
        const start    = new Date(issueSyncConfig.syncStartDate).getTime();
        const inWindow = new Date(start + 86400000).toISOString();
        const metadata = {
            releases: {
                vCached: {publishedAt: inWindow, contentHash: 'cached-hash'}
            }
        };

        GraphqlService.query = async () => ({
            repository: {
                latestRelease: {tagName: 'vCached', publishedAt: inWindow}
            }
        });

        await ReleaseNotesSyncer.fetchAndCacheReleases(metadata);

        const releaseDir = issueSyncConfig.releaseNotesDir;
        await fs.emptyDir(releaseDir);

        await expect(ReleaseNotesSyncer.syncNotes(metadata)).rejects.toThrow('vCached: no body to write');
        expect(await fs.pathExists(path.join(releaseDir, 'chunk-1', 'vCached.md'))).toBe(false);
        expect(await fs.pathExists(path.join(releaseDir, '_index.json'))).toBe(false);
    });

    test('when notes are wanted, a cache whose notes are not on disk fetches the history with bodies', async () => {
        const start    = new Date(issueSyncConfig.syncStartDate).getTime();
        const inWindow = new Date(start + 86400000).toISOString();
        // The published corpus caches every release as {publishedAt} only
        const metadata = {releases: {vIn: {publishedAt: inWindow}}};
        const queries  = [];

        GraphqlService.query = async query => {
            if (query.includes('FetchLatestRelease')) {
                queries.push('latest');
                return {repository: {latestRelease: {tagName: 'vIn', publishedAt: inWindow}}}
            }

            queries.push('releases');
            return {repository: {releases: {
                nodes   : [{tagName: 'vIn', name: 'In', description: 'body', publishedAt: inWindow}],
                pageInfo: {hasNextPage: false, endCursor: null}
            }}}
        };

        const releaseDir = issueSyncConfig.releaseNotesDir;
        await fs.emptyDir(releaseDir);

        await ReleaseNotesSyncer.fetchAndCacheReleases(metadata, {needNotes: true});
        expect(queries).toEqual(['latest', 'releases']);

        const stats = await ReleaseNotesSyncer.syncNotes(metadata);

        expect(stats.synced).toEqual(['vIn']);
        expect(await fs.readFile(path.join(releaseDir, 'chunk-1', 'vIn.md'), 'utf-8')).toContain('body');
        expect(ReleaseNotesSyncer.releases.vIn.contentHash).toMatch(/^[0-9a-f]{64}$/);

        // With the note on disk and hashed, the same cache takes the fast path again
        queries.length = 0;
        await ReleaseNotesSyncer.fetchAndCacheReleases({releases: {vIn: {publishedAt: inWindow, contentHash: 'h'}}}, {needNotes: true});
        expect(queries).toEqual(['latest']);
    });

    test('an origin with no in-window release gets no release-notes folder and no index', async () => {
        const start    = new Date(issueSyncConfig.syncStartDate).getTime();
        const preFloor = new Date(start - 86400000).toISOString();

        ReleaseNotesSyncer.releases       = {vOld: {tagName: 'vOld', name: 'Old', publishedAt: preFloor, description: 'old'}};
        ReleaseNotesSyncer.sortedReleases = [{tagName: 'vOld', publishedAt: preFloor}];

        const releaseDir = issueSyncConfig.releaseNotesDir;
        await fs.remove(releaseDir);

        const stats = await ReleaseNotesSyncer.syncNotes({});

        expect(stats).toEqual({count: 0, synced: []});
        expect(await fs.pathExists(releaseDir)).toBe(false);
    });

    test('a note that cannot be written fails syncNotes and caches no hash for it', async () => {
        const start    = new Date(issueSyncConfig.syncStartDate).getTime();
        const inWindow = new Date(start + 86400000).toISOString();

        ReleaseNotesSyncer.releases       = {vBad: {tagName: 'vBad', name: 'Bad', publishedAt: inWindow, description: 'x'}};
        ReleaseNotesSyncer.sortedReleases = [{tagName: 'vBad', publishedAt: inWindow}];

        const releaseDir = issueSyncConfig.releaseNotesDir;
        await fs.emptyDir(releaseDir);
        // A file where the chunk directory belongs makes the note unwritable
        await fs.writeFile(path.join(releaseDir, 'chunk-1'), '');

        await expect(ReleaseNotesSyncer.syncNotes({})).rejects.toThrow('vBad');
        expect(ReleaseNotesSyncer.releases.vBad.contentHash).toBeUndefined();
        expect(await fs.pathExists(path.join(releaseDir, '_index.json'))).toBe(false);
    });

    test('syncNotes generates ordinal pathing and updates _index.json correctly', async () => {
        // Dates must be >= syncStartDate: syncNotes floors release-notes to the configured window
        // (the bucketing reference `sortedReleases` spans the full history, but on-disk notes do not).
        ReleaseNotesSyncer.releases = {
            'v1.0.0': { tagName: 'v1.0.0', name: 'Release 1', publishedAt: '2025-02-01T00:00:00Z', description: 'First release' },
            'v1.1.0': { tagName: 'v1.1.0', name: 'Release 2', publishedAt: '2025-03-01T00:00:00Z', description: 'Second release' }
        };
        ReleaseNotesSyncer.sortedReleases = [
            { tagName: 'v1.0.0', publishedAt: '2025-02-01T00:00:00Z' },
            { tagName: 'v1.1.0', publishedAt: '2025-03-01T00:00:00Z' }
        ];

        // Ensure the directory is clean
        const releaseDir = issueSyncConfig.releaseNotesDir;
        await fs.emptyDir(releaseDir);

        const stats = await ReleaseNotesSyncer.syncNotes({});
        expect(stats.count).toBe(2);

        // Check ordinal chunk paths
        // v1.0.0 -> index 0 -> chunk 1 -> chunk-1/v1.0.0.md
        // v1.1.0 -> index 1 -> chunk 1 -> chunk-1/v1.1.0.md
        const file1Exists = await fs.pathExists(path.join(releaseDir, 'chunk-1', 'v1.0.0.md'));
        const file2Exists = await fs.pathExists(path.join(releaseDir, 'chunk-1', 'v1.1.0.md'));
        expect(file1Exists).toBe(true);
        expect(file2Exists).toBe(true);

        // Check _index.json
        const indexPath = path.join(releaseDir, '_index.json');
        expect(await fs.pathExists(indexPath)).toBe(true);

        const indexData = await fs.readJson(indexPath);
        expect(indexData.items['v1.0.0']).toEqual({ itemIndex: 0, chunk: 1, chunkDir: 'chunk-1' });
        expect(indexData.items['v1.1.0']).toEqual({ itemIndex: 1, chunk: 1, chunkDir: 'chunk-1' });
    });

    test('cold fetch spans the full release history — no syncStartDate early-exit or filter on sortedReleases', async () => {
        // syncStartDate floors release-NOTES (downstream in syncNotes), but the bucketing reference
        // sortedReleases must span the ENTIRE history; otherwise closed items predating the oldest
        // in-window release collapse into it (the catch-all bucket). Three pages: page 2 + 3 are
        // before the floor — the pre-fix early-exit would stop after page 2 and the filter would drop them.
        const start    = new Date(issueSyncConfig.syncStartDate).getTime();
        const inWindow = new Date(start + 86400000).toISOString();
        const preA     = new Date(start - 86400000).toISOString();
        const preB     = new Date(start - 2 * 86400000).toISOString();

        let page = 0;
        GraphqlService.query = async () => {
            page++;
            if (page === 1) return {repository: {releases: {
                nodes   : [{tagName: 'vIn', publishedAt: inWindow}],
                pageInfo: {hasNextPage: true, endCursor: 'c1'}
            }}};
            if (page === 2) return {repository: {releases: {
                nodes   : [{tagName: 'vOldA', publishedAt: preA}],
                pageInfo: {hasNextPage: true, endCursor: 'c2'}
            }}};
            return {repository: {releases: {
                nodes   : [{tagName: 'vOldB', publishedAt: preB}],
                pageInfo: {hasNextPage: false, endCursor: null}
            }}};
        };

        // Empty cache → fast-path skipped → full cold fetch.
        await ReleaseNotesSyncer.fetchAndCacheReleases({releases: {}});

        // Pagination did not early-exit at the floor boundary (would be 2 pre-fix).
        expect(page).toBe(3);
        // sortedReleases spans the full history, ascending — including the two pre-floor releases.
        expect(ReleaseNotesSyncer.sortedReleases.map(r => r.tagName)).toEqual(['vOldB', 'vOldA', 'vIn']);
    });

    test('syncNotes floors release-notes to syncStartDate while sortedReleases stays full', async () => {
        const start    = new Date(issueSyncConfig.syncStartDate).getTime();
        const inWindow = new Date(start + 86400000).toISOString();
        const preFloor = new Date(start - 86400000).toISOString();

        // Full bucketing reference (pre-floor + in-window); the release map mirrors it.
        ReleaseNotesSyncer.sortedReleases = [
            {tagName: 'vOld', publishedAt: preFloor},
            {tagName: 'vNew', publishedAt: inWindow}
        ];
        ReleaseNotesSyncer.releases = {
            vOld: {tagName: 'vOld', name: 'Old', publishedAt: preFloor, description: 'old'},
            vNew: {tagName: 'vNew', name: 'New', publishedAt: inWindow, description: 'new'}
        };

        const releaseDir = issueSyncConfig.releaseNotesDir;
        await fs.emptyDir(releaseDir);

        const stats = await ReleaseNotesSyncer.syncNotes({});

        // Only the in-window release is written; the pre-floor one is skipped.
        expect(stats.count).toBe(1);
        expect(stats.synced).toEqual(['vNew']);

        // vNew indexes at 0 WITHIN the floored notes set — not its index (1) in the full sortedReleases.
        const indexData = await fs.readJson(path.join(releaseDir, '_index.json'));
        expect(indexData.items['vNew']).toEqual({itemIndex: 0, chunk: 1, chunkDir: 'chunk-1'});
        expect(indexData.items['vOld']).toBeUndefined();
        expect(await fs.pathExists(path.join(releaseDir, 'chunk-1', 'vNew.md'))).toBe(true);
        expect(await fs.pathExists(path.join(releaseDir, 'chunk-1', 'vOld.md'))).toBe(false);
    });
});

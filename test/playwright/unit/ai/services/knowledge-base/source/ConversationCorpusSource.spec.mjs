import {setup} from '../../../../../setup.mjs';

const appName = 'ConversationCorpusSourceTest';

setup({
    neoConfig: {
        allowVdomUpdatesInTests: false,
        unitTestMode           : true,
        useDomApiRenderer      : false
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}                    from '@playwright/test';
import Neo                               from 'neo.mjs/src/Neo.mjs';
import * as core                         from 'neo.mjs/src/core/_export.mjs';
import {ExtractorCatalogue}              from '../../../../../../../ai/services/knowledge-base/source/ExtractorCatalogue.mjs';
import {CONVERSATION_CORPUS_ERROR_CODES} from '../../../../../../../ai/services/knowledge-base/source/ConversationCorpusSource.mjs';
import {createRepositoryRevisionReader}  from '../../../../../../../ai/services/knowledge-base/helpers/repositoryRevisionReader.mjs';
import {runExtractionProfile}            from '../../../../../../../ai/services/knowledge-base/helpers/extractionProfileRunner.mjs';
import {diffTenantManifest}              from '../../../../../../../ai/services/knowledge-base/helpers/kbReconciliationEngine.mjs';

/**
 * @summary The Knowledge Base ingests the org conversation corpus as its own tenant (neo-agent-brain#402).
 *
 * Every arm runs the real profile runner over a real revision reader bound to a fixture Git mirror,
 * so what is asserted is the route contract the deployed tenant executes — not the extractor alone.
 */

const
    NEO_ISSUE_86 = [
        '---', 'id: 86', 'title: Same number, first origin', 'state: OPEN', '---',
        '# Same number, first origin', '', 'Body of neo#86.', '', '## Timeline', '',
        '### @neo-opus-vega - 2026-09-21T20:00:00Z', '', 'First comment.', '',
        '### @neo-gpt - 2026-09-21T20:05:00Z', '', 'Second comment.'
    ].join('\n'),
    BRAIN_ISSUE_86 = '---\nid: 86\ntitle: Same number, second origin\n---\n# Same number, second origin\n\nBody of neo-agent-brain#86.',
    NEO_PR_12      = [
        '---', 'number: 12', 'title: A reviewed pull request', '---',
        '# A reviewed pull request', '', 'PR body.', '', '## Reviews', '',
        '### `@neo-gpt-emmy` (APPROVED) reviewed on 2026-09-21T21:00:00Z', '', 'Looks right.', '',
        '## Comments', '',
        '### `@neo-opus-grace` commented on 2026-09-21T21:10:00Z', '', 'One comment.'
    ].join('\n'),
    NEO_DISCUSSION_7 = [
        '---', 'number: 7', 'title: A converged discussion', '---',
        '# A converged discussion', '', 'Discussion body.', '', '## Comments', '',
        '### `@neo-fable-clio` commented on 2026-09-21T22:00:00Z', '', 'A comment.'
    ].join('\n'),
    NEO_ISSUE_5      = '---\nid: 5\ntitle: Archived under a release\n---\n# Archived under a release\n\nClosed long ago.',
    UNINDEXED_ISSUE  = '---\nid: 999\ntitle: Nobody indexed me\n---\n# Nobody indexed me',
    CORPUS_INCLUDE   = ['_index.json', '*/issues/**/*.md', '*/pulls/**/*.md', '*/discussions/**/*.md', '*/archive/**/*.md'],
    CONVERSATIONS    = Object.freeze({
        'neo/issues/chunk-1/issue-86.md'              : {row: {repoSlug: 'neo',             type: 'issues',      id: 86, version: null,     chunkNumber: 1}, content: NEO_ISSUE_86},
        'neo-agent-brain/issues/chunk-1/issue-86.md'  : {row: {repoSlug: 'neo-agent-brain', type: 'issues',      id: 86, version: null,     chunkNumber: 1}, content: BRAIN_ISSUE_86},
        'neo/pulls/chunk-1/pr-12.md'                  : {row: {repoSlug: 'neo',             type: 'pulls',       id: 12, version: null,     chunkNumber: 1}, content: NEO_PR_12},
        'neo/discussions/chunk-1/discussion-7.md'     : {row: {repoSlug: 'neo',             type: 'discussions', id: 7,  version: null,     chunkNumber: 1}, content: NEO_DISCUSSION_7},
        'neo/archive/issues/v1.0.0/chunk-1/issue-5.md': {row: {repoSlug: 'neo',             type: 'issues',      id: 5,  version: 'v1.0.0', chunkNumber: 1}, content: NEO_ISSUE_5}
    });

/**
 * @summary Builds the fixture corpus: index rows + files, plus the repository's own non-corpus files.
 * @param {Object} [options]
 * @param {Object[]} [options.rows] Index rows; defaults to one row per fixture conversation.
 * @returns {{entries: Object[], contents: Object<String,String>}}
 */
function corpus({rows} = {}) {
    const
        indexRows = rows || Object.entries(CONVERSATIONS).map(([path, {row}]) => ({...row, path})),
        contents  = {
            '_index.json'                    : JSON.stringify(indexRows),
            'README.md'                      : '# github-content-sync\n',
            'neo/.sync-metadata.json'        : '{"cursor":"x"}',
            'neo/issues/chunk-1/issue-999.md': UNINDEXED_ISSUE,
            ...Object.fromEntries(Object.entries(CONVERSATIONS).map(([path, {content}]) => [path, content]))
        };

    return {
        entries: Object.keys(contents).sort().map(sourcePath => ({sourcePath, mode: '100644', type: 'blob', oid: 'a'.repeat(40)})),
        contents
    }
}

/**
 * @summary A revision reader over an in-memory Git mirror — the same primitive the tenant sync binds.
 * @param {{entries: Object[], contents: Object<String,String>}} fixture
 * @returns {Object}
 */
function reader({entries, contents}) {
    return createRepositoryRevisionReader({
        gitMirror: {
            async listRevisionEntries() {
                return entries
            },
            async prefetchRevisionBlobs() {
                return {status: 'local'}
            },
            async readRevisionBlob({sourcePath}) {
                return Buffer.from(contents[sourcePath] ?? '', 'utf8')
            }
        },
        mirrorRoot: '/not-read-by-fixture',
        tenantId  : 'neo-shared',
        repoSlug  : 'github-content-sync',
        revision  : 'f'.repeat(40)
    })
}

/**
 * @summary Runs the corpus route the way `deploy/cloud/kb-config.yaml` declares it.
 * @param {Object} fixture
 * @param {Object} [overrides]
 * @param {String[]} [overrides.include] Territory include patterns.
 * @param {Object} [overrides.options] Route options.
 * @returns {Promise<{execution: Object, chunks: Object[]}>}
 */
async function run(fixture, {include = CORPUS_INCLUDE, options} = {}) {
    const chunks = [];

    const execution = await runExtractionProfile({
        profile: {
            profileSchemaVersion: 1,
            routes              : [{
                territory  : {roots: ['.'], include},
                extractorId: 'ConversationCorpusSource',
                ...(options ? {options} : {})
            }],
            fallback: {action: 'exclude'}
        },
        catalogue       : ExtractorCatalogue,
        repositoryReader: reader(fixture),
        writeStream     : {write: value => chunks.push(JSON.parse(String(value).trim()))},
        createHashFn    : () => 'hash'
    });

    return {execution, chunks}
}

test.describe('Neo.ai.services.knowledge-base.source.ConversationCorpusSource (#402)', () => {
    test('one invocation over two origins sharing #86 yields distinct chunks; origin rides the name and customMeta, never repoSlug', async () => {
        const {execution, chunks} = await run(corpus());

        expect(chunks.map(chunk => chunk.name).sort()).toEqual([
            'neo-agent-brain/issue-86#body',
            'neo/discussion-7#body',
            'neo/discussion-7#comment-1',
            'neo/issue-5#body',
            'neo/issue-86#body',
            'neo/issue-86#comment-1',
            'neo/issue-86#comment-2',
            'neo/pr-12#body',
            'neo/pr-12#comment-1',
            'neo/pr-12#review-1'
        ]);

        for (const chunk of chunks) {
            // Ownership is the server's stamp for the corpus tenant; the extractor never claims it.
            expect(Object.hasOwn(chunk, 'repoSlug')).toBe(false);
            expect(Object.hasOwn(chunk, 'tenantId')).toBe(false);
            expect(chunk.customMeta.origin).toBe(chunk.sourcePath.split('/')[0]);
            expect(chunk.name.startsWith(`${chunk.customMeta.origin}/`)).toBe(true);
            expect(chunk.hashInputs).toContain('name');
        }

        const byName = Object.fromEntries(chunks.map(chunk => [chunk.name, chunk]));

        expect(byName['neo/issue-86#body']).toMatchObject({
            type      : 'ticket', kind: 'ticket', parserId: 'ticket-archive', sourcePath: 'neo/issues/chunk-1/issue-86.md',
            customMeta: {origin: 'neo', facet: 'issues', id: 86, version: null, element: 'body', ordinal: 0}
        });
        expect(byName['neo/issue-86#comment-2'].content).toContain('Second comment.');
        expect(byName['neo-agent-brain/issue-86#body']).toMatchObject({type: 'ticket', customMeta: {origin: 'neo-agent-brain', id: 86}});
        expect(byName['neo/pr-12#review-1']).toMatchObject({type: 'pull', kind: 'pull', parserId: 'pull-request-archive', customMeta: {element: 'review', ordinal: 1}});
        expect(byName['neo/discussion-7#comment-1']).toMatchObject({type: 'discussion', parserId: 'discussion-archive'});
        expect(byName['neo/issue-5#body']).toMatchObject({sourcePath: 'neo/archive/issues/v1.0.0/chunk-1/issue-5.md', customMeta: {version: 'v1.0.0'}});

        // The receipt covers exactly the indexed conversation files: the index yields nothing, and a
        // file the index does not name yields nothing — no id is ever minted from a filename.
        expect(execution.yieldedSourcePaths).toEqual(Object.keys(CONVERSATIONS).sort());
        expect(execution.extractorSkippedPaths).toEqual([
            {sourcePath: '_index.json',                      reason: 'index'},
            {sourcePath: 'neo/issues/chunk-1/issue-999.md',  reason: 'unindexed'}
        ]);
        expect(execution.count).toBe(10);
    });

    test('origins narrows the selection, and the option is canonical (trimmed, deduplicated, sorted)', async () => {
        const {execution, chunks} = await run(corpus(), {options: {origins: ['neo-agent-brain']}});

        expect(chunks.map(chunk => chunk.name)).toEqual(['neo-agent-brain/issue-86#body']);
        expect(execution.yieldedSourcePaths).toEqual(['neo-agent-brain/issues/chunk-1/issue-86.md']);
        expect(execution.extractorSkippedPaths.filter(item => item.reason === 'origin-not-selected').map(item => item.sourcePath))
            .toEqual(Object.keys(CONVERSATIONS).filter(path => path.startsWith('neo/')).sort());

        const {normalizeOptions} = ExtractorCatalogue.get('ConversationCorpusSource');

        expect(normalizeOptions({})).toEqual({});
        expect(normalizeOptions({origins: [' neo ', 'devindex', 'neo']})).toEqual({origins: ['devindex', 'neo']});
        expect(() => normalizeOptions({origins: []})).toThrow(/non-empty array/u);
        expect(() => normalizeOptions({origins: ['neo', '']})).toThrow(/non-empty array/u);
        expect(() => normalizeOptions({repoSlug: 'neo'})).toThrow(/support only origins/u);
    });

    test('an index row without an origin refuses the whole invocation before any chunk is written', async () => {
        const rows = Object.entries(CONVERSATIONS).map(([path, {row}]) => ({...row, path}));

        delete rows[1].repoSlug;

        const chunks = [];

        await expect(run(corpus({rows}), {}).then(result => chunks.push(...result.chunks)))
            .rejects.toMatchObject({code: CONVERSATION_CORPUS_ERROR_CODES.indexRowUnqualified});
        expect(chunks).toEqual([]);
    });

    test('CONTROL: a route that does not declare the root index cannot read it', async () => {
        await expect(run(corpus(), {include: CORPUS_INCLUDE.filter(pattern => pattern !== '_index.json')}))
            .rejects.toMatchObject({code: 'KB_REVISION_READER_PATH_OUTSIDE_SCOPE'});
    });

    test('two artifacts for one conversation identity refuse, per (origin, facet, id), naming both paths', async () => {
        const
            rows    = Object.entries(CONVERSATIONS).map(([path, {row}]) => ({...row, path})),
            fixture = corpus({rows: [...rows, {repoSlug: 'neo', type: 'issues', id: 86, version: 'v1.0.0', chunkNumber: 1, path: 'neo/archive/issues/v1.0.0/chunk-1/issue-86.md'}]});

        fixture.contents['neo/archive/issues/v1.0.0/chunk-1/issue-86.md'] = '# stale copy';
        fixture.entries.push({sourcePath: 'neo/archive/issues/v1.0.0/chunk-1/issue-86.md', mode: '100644', type: 'blob', oid: 'a'.repeat(40)});

        await expect(run(fixture)).rejects.toMatchObject({
            code   : CONVERSATION_CORPUS_ERROR_CODES.duplicateConversation,
            message: expect.stringMatching(/neo\/issues\/86 .*neo\/archive\/issues\/v1\.0\.0\/chunk-1\/issue-86\.md.*neo\/issues\/chunk-1\/issue-86\.md/u)
        });
    });

    test('the built-in descriptor is non-delta-safe: every chunk depends on the root index, an unchanged file', () => {
        expect(ExtractorCatalogue.get('ConversationCorpusSource')).toMatchObject({
            version          : '1.0.0',
            deltaSafe        : false,
            requiresHierarchy: false
        });
    });

    test('OWNERSHIP CONTROL: the corpus tenant’s manifest orphans no engine source row; the same manifest under neo would', () => {
        const
            corpusPaths = Object.keys(CONVERSATIONS),
            engineRows  = [{id: 'engine-source', metadata: {repoSlug: 'neo', sourcePath: 'src/Neo.mjs', ingestedAt: 1_000}}];

        expect(diffTenantManifest({
            rows           : engineRows,
            manifestsByRepo: {'github-content-sync': {pathsAfterPush: corpusPaths, updatedAt: 2_000}}
        })).toMatchObject({actionableCount: 0, orphanCount: 0});

        // Negative control, not shipped: publishing conversations under the origin's tuple makes the
        // origin's source-code rows look stale to the corpus lane.
        expect(diffTenantManifest({
            rows           : engineRows,
            manifestsByRepo: {neo: {pathsAfterPush: corpusPaths, updatedAt: 2_000}}
        })).toMatchObject({actionableCount: 1, actionableIds: ['engine-source']});
    });
});

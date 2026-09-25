import {setup} from '../../../../../setup.mjs';

const appName = 'ReleaseNotesCorpusSourceTest';

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

import {test, expect}                     from '@playwright/test';
import Neo                                from 'neo.mjs/src/Neo.mjs';
import * as core                          from 'neo.mjs/src/core/_export.mjs';
import {ExtractorCatalogue}               from '../../../../../../../ai/services/knowledge-base/source/ExtractorCatalogue.mjs';
import {RELEASE_NOTES_CORPUS_ERROR_CODES} from '../../../../../../../ai/services/knowledge-base/source/ReleaseNotesCorpusSource.mjs';
import {createRepositoryRevisionReader}   from '../../../../../../../ai/services/knowledge-base/helpers/repositoryRevisionReader.mjs';
import {runExtractionProfile}             from '../../../../../../../ai/services/knowledge-base/helpers/extractionProfileRunner.mjs';

/**
 * @summary The corpus tenant reads each origin's release notes through their own index.
 *
 * Every arm runs the real profile runner over a real revision reader bound to a fixture Git mirror,
 * with the two corpus routes `deploy/cloud/kb-config.yaml` declares, so what is asserted is the route
 * contract the deployed tenant executes.
 */

const
    NOTE_13_1 = '---\ntagName: 13.1.0\nname: 13.1.0\n---\n# 13.1.0\n\nThe 13.1 notes.',
    NOTE_13_0 = '---\ntagName: 13.0.0\nname: 13.0.0\n---\n# 13.0.0\n\nThe 13.0 notes.',
    ISSUE_86  = '---\nid: 86\ntitle: A conversation\n---\n# A conversation\n\nBody of neo#86.',
    NOTES_INCLUDE = ['*/release-notes/_index.json', '*/release-notes/**/*.md'];

/**
 * @summary Builds the fixture corpus: one origin with notes, one without, and the conversation layout beside them.
 * @param {Object} [options]
 * @param {Object|String} [options.neoIndex] The `neo/release-notes/_index.json` contents; defaults to a valid index.
 * @returns {{entries: Object[], contents: Object<String,String>}}
 */
function corpus({neoIndex} = {}) {
    const contents = {
        '_index.json'                                  : JSON.stringify([{repoSlug: 'neo', type: 'issues', id: 86, version: null, chunkNumber: 1, path: 'neo/issues/chunk-1/issue-86.md'}]),
        'neo/issues/chunk-1/issue-86.md'               : ISSUE_86,
        'neo/release-notes/_index.json'                : typeof neoIndex === 'string' ? neoIndex : JSON.stringify(neoIndex || {
            metadata: {shardType: 'release-notes', chunkThreshold: 100},
            items   : {
                '13.0.0': {itemIndex: 0, chunk: 1, chunkDir: 'chunk-1', path: 'neo/release-notes/chunk-1/v13.0.0.md'},
                '13.1.0': {itemIndex: 1, chunk: 1, chunkDir: 'chunk-1', path: 'neo/release-notes/chunk-1/v13.1.0.md'}
            }
        }),
        'neo/release-notes/chunk-1/v13.0.0.md'         : NOTE_13_0,
        'neo/release-notes/chunk-1/v13.1.0.md'         : NOTE_13_1,
        'neo/release-notes/chunk-1/v9.9.9.md'          : '# not in the index',
        'neo-agent-brain/issues/chunk-1/issue-1.md'    : '---\nid: 1\n---\n# unindexed here'
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
 * @summary Runs the release-notes route the way `deploy/cloud/kb-config.yaml` declares it.
 * @param {Object} fixture
 * @param {Object} [overrides]
 * @param {String[]} [overrides.include] Territory include patterns.
 * @param {Object} [overrides.options] Route options.
 * @returns {Promise<{execution: Object, chunks: Object[]}>}
 */
async function run(fixture, {include = NOTES_INCLUDE, options} = {}) {
    const chunks = [];

    const execution = await runExtractionProfile({
        profile: {
            profileSchemaVersion: 1,
            routes              : [{
                territory  : {roots: ['.'], include},
                extractorId: 'ReleaseNotesCorpusSource',
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

test.describe('Neo.ai.services.knowledge-base.source.ReleaseNotesCorpusSource', () => {
    test('each indexed note is one release chunk; identity comes from the index, origin rides the name and customMeta', async () => {
        const {execution, chunks} = await run(corpus());

        // The tag is the index's key; the name's last segment is the note's file name, the version as written
        expect(chunks.map(chunk => chunk.name)).toEqual(['neo/v13.0.0', 'neo/v13.1.0']);

        for (const chunk of chunks) {
            // Ownership is the server's stamp for the corpus tenant; the extractor never claims it.
            expect(Object.hasOwn(chunk, 'repoSlug')).toBe(false);
            expect(Object.hasOwn(chunk, 'tenantId')).toBe(false);
            expect(chunk.hashInputs).toContain('name');
        }

        expect(chunks[1]).toMatchObject({
            type      : 'release', kind: 'release', parserId: 'release-note', sourcePath: 'neo/release-notes/chunk-1/v13.1.0.md',
            customMeta: {origin: 'neo', facet: 'release-notes', id: '13.1.0'}
        });
        expect(chunks[1].content).toContain('The 13.1 notes.');

        // A note the index does not name yields nothing: no tag is ever minted from a file name.
        expect(execution.yieldedSourcePaths).toEqual(['neo/release-notes/chunk-1/v13.0.0.md', 'neo/release-notes/chunk-1/v13.1.0.md']);
        expect(execution.extractorSkippedPaths).toEqual([
            {sourcePath: 'neo/release-notes/_index.json',        reason: 'index'},
            {sourcePath: 'neo/release-notes/chunk-1/v9.9.9.md', reason: 'unindexed'}
        ]);
    });

    test('the two corpus routes split the territory: conversations and notes each go to their own extractor', async () => {
        const chunks = [];

        await runExtractionProfile({
            profile: {
                profileSchemaVersion: 1,
                routes              : [{
                    territory  : {roots: ['.'], include: ['_index.json', '*/issues/**/*.md', '*/pulls/**/*.md', '*/discussions/**/*.md', '*/archive/**/*.md']},
                    extractorId: 'ConversationCorpusSource'
                }, {
                    territory  : {roots: ['.'], include: NOTES_INCLUDE},
                    extractorId: 'ReleaseNotesCorpusSource'
                }],
                fallback: {action: 'exclude'}
            },
            catalogue       : ExtractorCatalogue,
            repositoryReader: reader(corpus()),
            writeStream     : {write: value => chunks.push(JSON.parse(String(value).trim()))},
            createHashFn    : () => 'hash'
        });

        expect(chunks.map(chunk => `${chunk.type} ${chunk.name}`).sort()).toEqual([
            'release neo/v13.0.0',
            'release neo/v13.1.0',
            'ticket neo/issue-86#body'
        ]);
    });

    test('origins narrows the selection, with the same canonical options as the conversation route', async () => {
        const {execution, chunks} = await run(corpus(), {options: {origins: ['neo-agent-brain']}});

        expect(chunks).toEqual([]);
        expect(execution.extractorSkippedPaths.filter(item => item.reason === 'origin-not-selected').map(item => item.sourcePath))
            .toEqual(['neo/release-notes/chunk-1/v13.0.0.md', 'neo/release-notes/chunk-1/v13.1.0.md', 'neo/release-notes/chunk-1/v9.9.9.md']);

        const {normalizeOptions} = ExtractorCatalogue.get('ReleaseNotesCorpusSource');

        expect(normalizeOptions({origins: [' neo ', 'devindex', 'neo']})).toEqual({origins: ['devindex', 'neo']});
        expect(() => normalizeOptions({repoSlug: 'neo'})).toThrow(/ReleaseNotesCorpusSource route options support only origins/u);
    });

    test('an index that cannot say which note is which refuses the invocation', async () => {
        for (const neoIndex of [
            '{not json',
            {metadata: {}},
            {items: {'13.1.0': {chunkDir: 'chunk-1'}}},
            {items: {'13.1.0': {path: 'neo-agent-brain/release-notes/chunk-1/v13.1.0.md'}}},
            {items: {'13.0.0': {path: 'neo/release-notes/chunk-1/v13.1.0.md'}, '13.1.0': {path: 'neo/release-notes/chunk-1/v13.1.0.md'}}}
        ]) {
            await expect(run(corpus({neoIndex})), JSON.stringify(neoIndex))
                .rejects.toMatchObject({code: RELEASE_NOTES_CORPUS_ERROR_CODES.indexInvalid});
        }
    });

    test('CONTROL: a route that does not declare the origin index cannot read it', async () => {
        await expect(run(corpus(), {include: ['*/release-notes/**/*.md']}))
            .rejects.toMatchObject({code: RELEASE_NOTES_CORPUS_ERROR_CODES.indexInvalid, cause: {code: 'KB_REVISION_READER_PATH_OUTSIDE_SCOPE'}});
    });

    test('the built-in descriptor is non-delta-safe: every chunk depends on its origin index, an unchanged file', () => {
        expect(ExtractorCatalogue.get('ReleaseNotesCorpusSource')).toMatchObject({
            version          : '1.0.0',
            deltaSafe        : false,
            requiresHierarchy: false
        });
    });
});

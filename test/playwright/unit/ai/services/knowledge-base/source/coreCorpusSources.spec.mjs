import {setup} from '../../../../../setup.mjs';

setup({appConfig: {name: 'CoreCorpusSourcesTest'}});

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

import {createCoreCorpusProfilePlan}    from '../../../../../../../ai/services/knowledge-base/helpers/coreCorpusProfilePlan.mjs';
import {runExtractionProfile}           from '../../../../../../../ai/services/knowledge-base/helpers/extractionProfileRunner.mjs';
import {createRepositoryRevisionReader} from '../../../../../../../ai/services/knowledge-base/helpers/repositoryRevisionReader.mjs';

/**
 * @summary Provides the production revision-reader shape over fixed byte contents.
 * @param {Object<String,String>} files
 * @param {String} repoSlug
 * @returns {Object}
 */
function reader(files, repoSlug) {
    return createRepositoryRevisionReader({
        gitMirror: {
            async listRevisionEntries() {
                return Object.keys(files).sort().map(sourcePath => ({
                    sourcePath, mode: '100644', type: 'blob', oid: 'a'.repeat(40)
                }))
            },
            async readRevisionBlob({sourcePath}) { return Buffer.from(files[sourcePath], 'utf8') },
            async prefetchRevisionBlobs() { return {status: 'local'} }
        },
        mirrorRoot: '/fixture', tenantId: 'neo-shared', repoSlug, revision: 'f'.repeat(40)
    })
}

/**
 * @summary Runs only the non-API routes from one declared core profile.
 * @param {String} repoSlug
 * @param {Object<String,String>} files
 * @returns {Promise<{result: Object, chunks: Object[]}>}
 */
async function extract(repoSlug, files) {
    const plan   = createCoreCorpusProfilePlan(repoSlug);
    const chunks = [];
    const result = await runExtractionProfile({
        profile: {
            ...plan.profile,
            routes: plan.profile.routes.filter(route => route.extractorId !== 'ApiSource')
        },
        repositoryReader: reader(files, repoSlug),
        writeStream     : {write: line => chunks.push(JSON.parse(String(line)))},
        createHashFn    : chunk => `hash:${chunk.type}:${chunk.name}`
    });

    return {result, chunks}
}

const TEST_SOURCE = `import {test, expect} from '@playwright/test';
test('a real test', () => { expect(1).toBe(1) });
`;

test.describe('shared core semantic Sources (#282)', () => {
    test('Engine profile uses its assigned learning tree and retains ADR, concept and test semantics', async () => {
        const {result, chunks} = await extract('neo', {
            'learn/agentos/decisions/0001-example.md': '# Decision\n\nAn accepted rule.',
            'learn/tree.json'                        : JSON.stringify({data: [
                {id: 'guides/One', name: 'One', parentId: 'Guides', isLeaf: true},
                {id: 'comparisons/Skip', name: 'Skip', parentId: 'comparisons', isLeaf: true}
            ]}),
            'learn/guides/One.md'               : '# One\n\nA useful guide section.',
            'learn/comparisons/Skip.md'         : '# Skip\n\nExcluded by the tree contract.',
            'resources/content/concepts/Some.md': '---\nname: Some\ntier: 2\n---\nA concept.',
            'test/playwright/one.spec.mjs'      : TEST_SOURCE
        });

        expect(result.yieldedSourcePaths).toEqual(expect.arrayContaining([
            'learn/agentos/decisions/0001-example.md',
            'learn/guides/One.md',
            'resources/content/concepts/Some.md',
            'test/playwright/one.spec.mjs'
        ]));
        expect(result.extractorSkippedPaths).toEqual(expect.arrayContaining([
            {sourcePath: 'learn/tree.json', reason: 'tree-manifest'},
            {sourcePath: 'learn/comparisons/Skip.md', reason: 'not-in-tree'}
        ]));
        expect(chunks.map(chunk => chunk.type)).toEqual(expect.arrayContaining(['adr', 'concept', 'test']));
        expect(chunks.find(chunk => chunk.type === 'concept')).toMatchObject({name: 'Some', tier: 2});
        expect(chunks.some(chunk => chunk.source === 'learn/guides/One.md')).toBe(true);
    });

    test('Brain profile parses assigned learn files without inventing a tree producer', async () => {
        const {result, chunks} = await extract('neo-agent-brain', {
            'learn/agentos/decisions/0001-brain.md': '# Brain decision\n\nA rule.',
            'learn/agentos/Guide.md'               : '# Guide\n\nA Brain guide.',
            'test/playwright/brain.spec.mjs'       : TEST_SOURCE
        });

        expect(result.yieldedSourcePaths).toEqual(expect.arrayContaining([
            'learn/agentos/decisions/0001-brain.md',
            'learn/agentos/Guide.md',
            'test/playwright/brain.spec.mjs'
        ]));
        expect(chunks.some(chunk => chunk.source === 'learn/agentos/Guide.md')).toBe(true);
        expect(chunks.some(chunk => chunk.type === 'adr')).toBe(true);
    });

    test('Engine tree mode refuses a missing assigned tree before publishing a guide chunk', async () => {
        const writes = [];
        const plan   = createCoreCorpusProfilePlan('neo');

        await expect(runExtractionProfile({
            profile: {
                ...plan.profile,
                routes: plan.profile.routes.filter(route => route.extractorId === 'LearningSource')
            },
            repositoryReader: reader({'learn/guides/One.md': '# One'}, 'neo'),
            writeStream     : {write: line => writes.push(line)},
            createHashFn    : () => 'hash'
        })).rejects.toThrow(/treePath.*outside its assigned territory/u);
        expect(writes).toEqual([]);
    });
});

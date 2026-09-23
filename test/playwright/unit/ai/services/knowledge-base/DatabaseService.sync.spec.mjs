import {setup} from '../../../../setup.mjs';

setup({neoConfig: {unitTestMode: true}, appConfig: {name: 'CoreCorpusDatabaseSyncTest'}});

import {test, expect}     from '@playwright/test';
import Neo                from 'neo.mjs/src/Neo.mjs';
import * as core          from 'neo.mjs/src/core/_export.mjs';
import {execFileSync}     from 'node:child_process';
import fs                 from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import os                 from 'node:os';
import path               from 'node:path';
import readline           from 'node:readline';

import {readCoreCorpusManifest} from '../../../../../../ai/services/knowledge-base/helpers/coreCorpusProfileRunner.mjs';

/**
 * @summary Uses the checked-out commit as the explicit revision for an unstamped test tree.
 * @param {String} root
 * @returns {String}
 */
function checkoutRevision(root) {
    const revision = process.env.NEO_TEST_BRAIN_REVISION || process.env.GITHUB_SHA
        || execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();

    if (!/^[a-f0-9]{40}$/u.test(revision)) {
        throw new Error('The core-corpus unit receipt needs one exact Brain checkout revision')
    }

    return revision
}

/**
 * @summary Reads one named module-context chunk without loading an entire large JSONL into memory.
 * @param {String} file
 * @param {String} sourcePath
 * @returns {Promise<Object|null>}
 */
async function moduleContext(file, sourcePath) {
    for await (const line of readline.createInterface({input: createReadStream(file)})) {
        if (!line) continue;
        const chunk = JSON.parse(line);

        if (chunk.sourcePath === sourcePath && chunk.name.endsWith('[Module Context]')) {
            return chunk
        }
    }

    return null
}

/**
 * @summary Returns the first chunk for one repository-relative source path.
 * @param {String} file
 * @param {String} sourcePath
 * @returns {Promise<Object|null>}
 */
async function firstChunk(file, sourcePath) {
    for await (const line of readline.createInterface({input: createReadStream(file)})) {
        if (!line) continue;
        const chunk = JSON.parse(line);

        if (chunk.sourcePath === sourcePath) return chunk
    }

    return null
}

test.describe('Neo.ai.services.knowledge-base.DatabaseService shared core sync (#282)', () => {
    test('the exact Engine pin and Brain revision compile separately without consulting SourceRegistry', async () => {
        const
            aiConfig           = (await import('../../../../../../ai/mcp/server/knowledge-base/config.template.mjs')).default,
            DatabaseService    = (await import('../../../../../../ai/services.mjs')).KB_DatabaseService,
            VectorService      = (await import('../../../../../../ai/services/knowledge-base/VectorService.mjs')).default,
            SourceRegistry     = (await import('../../../../../../ai/services/knowledge-base/source/SourceRegistry.mjs')).default,
            originalGetSources = SourceRegistry.getSources,
            directory          = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-core-sync-')),
            dataPath           = path.join(directory, 'core.jsonl'),
            brainRevision      = checkoutRevision(aiConfig.neoRootDir);

        // Named mutant: reconnecting the old registry to the core scan makes this arm red.
        SourceRegistry.getSources = () => { throw new Error('legacy SourceRegistry consulted') };

        try {
            const result = await DatabaseService.createKnowledgeBase({
                brainRevision, dataPath, listConfiguredTenantRepos: async () => ({tenantRepos: []})
            });
            const manifest  = await readCoreCorpusManifest(dataPath);
            const enginePin = JSON.parse(await fs.readFile(path.join(aiConfig.neoRootDir, 'package.json'), 'utf8'))
                .dependencies['neo.mjs'].match(/\/archive\/([a-f0-9]{40})\.tar\.gz$/u)?.[1];

            expect(result.count).toBeGreaterThan(0);
            expect(manifest.artifacts.map(item => item.repoSlug)).toEqual(['neo', 'neo-agent-brain']);
            expect(manifest.artifacts[0].revision).toBe(enginePin);
            expect(manifest.artifacts[1].revision).toBe(brainRevision);
            expect(manifest.artifacts.every(item => item.count > 0)).toBe(true);

            // The old global hierarchy cannot represent these copied class names with different
            // parents; the source-path resolver preserves their separate `extends` identities.
            const timer = await moduleContext(manifest.artifacts[0].path, 'examples/component/timer/MainContainer.mjs');
            const video = await moduleContext(manifest.artifacts[0].path, 'examples/component/video/MainContainer.mjs');

            expect(timer?.extends).toBe('Neo.examples.ConfigurationViewport');
            expect(video?.extends).toBe('Neo.container.Viewport');
            expect(await moduleContext(manifest.artifacts[1].path, 'src/evolution/config.mjs'))
                .toMatchObject({extends: 'Neo.brain.evolution.ConfigBase'});

            const sharedPath   = 'test/playwright/setup.mjs';
            const engineShared = await firstChunk(manifest.artifacts[0].path, sharedPath);
            const brainShared  = await firstChunk(manifest.artifacts[1].path, sharedPath);

            expect(engineShared?.sourcePath).toBe(sharedPath);
            expect(brainShared?.sourcePath).toBe(sharedPath);
            expect(engineShared?.source).toBe(`node_modules/neo.mjs/${sharedPath}`);
            expect(brainShared?.source).toBe(sharedPath);
            expect(VectorService.createTenantAwareChunkId(engineShared, {
                tenantId: 'neo-shared', repoSlug: 'neo'
            })).not.toBe(VectorService.createTenantAwareChunkId(engineShared, {
                tenantId: 'neo-shared', repoSlug: 'neo-agent-brain'
            }));
        } finally {
            SourceRegistry.getSources = originalGetSources;
            await fs.rm(directory, {recursive: true, force: true});
        }
    });

    test('a core repo in the effective tenant route refuses before JSONL or standalone embed writes', async () => {
        const DatabaseService           = (await import('../../../../../../ai/services.mjs')).KB_DatabaseService,
              directory                 = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-core-overlap-')),
              dataPath                  = path.join(directory, 'core.jsonl'),
              listConfiguredTenantRepos = async () => ({tenantRepos: [{
                  tenantId: 'neo-shared', repoSlug: 'neo', cloneUrl: 'https://github.com/neomjs/neo.git'
              }]});

        try {
            await expect(DatabaseService.createKnowledgeBase({dataPath, listConfiguredTenantRepos}))
                .rejects.toMatchObject({code: 'KB_CORE_CORPUS_ACQUISITION_OVERLAP'});
            expect(await fs.readdir(directory)).toEqual([]);
            await expect(DatabaseService.embedKnowledgeBase({dataPath, listConfiguredTenantRepos}))
                .rejects.toMatchObject({code: 'KB_CORE_CORPUS_ACQUISITION_OVERLAP'});
            expect(await fs.readdir(directory)).toEqual([])
        } finally {
            await fs.rm(directory, {recursive: true, force: true})
        }
    });
});

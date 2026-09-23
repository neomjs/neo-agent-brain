import {setup} from '../../../../setup.mjs';

setup({appConfig: {name: 'ImageRevisionReaderTest'}});

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import {execFileSync} from 'node:child_process';
import fs             from 'node:fs/promises';
import os             from 'node:os';
import path           from 'node:path';

import {
    createBrainImageRevisionReader,
    createImageRevisionReader,
    createInstalledEngineRevisionReader
} from '../../../../../../ai/services/knowledge-base/helpers/imageRevisionReader.mjs';

const ENGINE_SHA = 'a'.repeat(40),
      BRAIN_SHA  = 'b'.repeat(40),
      ENGINE_URL = `https://github.com/neomjs/neo/archive/${ENGINE_SHA}.tar.gz`;

/**
 * @summary Makes a miniature Brain image with the same manifest/lock/package identity surfaces.
 * @param {String} root
 * @returns {Promise<String>} Installed Engine root.
 */
async function imageFixture(root) {
    const engine = path.join(root, 'node_modules', 'neo.mjs');

    await fs.mkdir(path.join(engine, 'src'), {recursive: true});
    await fs.mkdir(path.join(root, 'ai'), {recursive: true});
    await fs.writeFile(path.join(root, '.neo-revision'), BRAIN_SHA + '\n');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
        name: 'neo-agent-brain', dependencies: {'neo.mjs': ENGINE_URL}
    }));
    await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({packages: {
        ''                    : {dependencies: {'neo.mjs': ENGINE_URL}},
        'node_modules/neo.mjs': {
            resolved : ENGINE_URL,
            integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64'),
            version  : '13.1.0'
        }
    }}));
    await fs.writeFile(path.join(engine, 'package.json'), JSON.stringify({name: 'neo.mjs', version: '13.1.0'}));
    await fs.writeFile(path.join(engine, 'src', 'One.mjs'), 'export const one = 1;\n');
    await fs.writeFile(path.join(root, 'ai', 'Two.mjs'), 'export const two = 2;\n');

    return engine
}

test.describe('image revision reader (#282)', () => {
    let root;

    test.beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-image-reader-'));
        await imageFixture(root);
    });

    test.afterEach(async () => {
        await fs.rm(root, {recursive: true, force: true});
    });

    test('binds Engine to the three matching package SHA carriers and Brain to its image stamp', async () => {
        const engine = await createInstalledEngineRevisionReader({
            brainRoot: root, roots: ['src'], tenantId: 'neo-shared'
        });
        const brain = await createBrainImageRevisionReader({
            brainRoot: root, roots: ['ai'], tenantId: 'neo-shared'
        });

        expect([engine.repoSlug, brain.repoSlug]).toEqual(['neo', 'neo-agent-brain']);
        expect([engine.revision, brain.revision]).toEqual([ENGINE_SHA, BRAIN_SHA]);
        expect((await engine.listRegularEntries()).map(entry => entry.sourcePath))
            .toEqual(['src/One.mjs']);
        expect(await engine.readText('src/One.mjs')).toBe('export const one = 1;\n');
        expect(await brain.readText('ai/Two.mjs')).toBe('export const two = 2;\n');
    });

    test('refuses a changed package pin or contradictory Brain revision before any read', async () => {
        await expect(createBrainImageRevisionReader({
            brainRoot: root, roots: ['ai'], tenantId: 'neo-shared', revision: 'c'.repeat(40)
        })).rejects.toMatchObject({code: 'KB_IMAGE_READER_BRAIN_IDENTITY_INVALID'});

        const lockPath = path.join(root, 'package-lock.json');
        const lock     = JSON.parse(await fs.readFile(lockPath, 'utf8'));

        lock.packages['node_modules/neo.mjs'].resolved = `https://github.com/neomjs/neo/archive/${'c'.repeat(40)}.tar.gz`;
        await fs.writeFile(lockPath, JSON.stringify(lock));

        await expect(createInstalledEngineRevisionReader({
            brainRoot: root, roots: ['src'], tenantId: 'neo-shared'
        })).rejects.toMatchObject({code: 'KB_IMAGE_READER_ENGINE_IDENTITY_INVALID'});
    });

    test('an unstamped checkout must be clean and match the supplied Brain revision', async () => {
        await fs.rm(path.join(root, '.neo-revision'));

        const git = (...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8'}).trim();

        git('init', '-q');
        git('add', '-A');
        git('-c', 'user.name=Neo Unit', '-c', 'user.email=unit@example.test',
            'commit', '-qm', 'image-reader-fixture');

        const revision = git('rev-parse', 'HEAD');
        const options  = {brainRoot: root, roots: ['ai'], tenantId: 'neo-shared', revision};
        const reader   = await createBrainImageRevisionReader(options);
        const inferred = await createBrainImageRevisionReader({
            brainRoot: root, roots: ['ai'], tenantId: 'neo-shared'
        });

        expect(reader.revision).toBe(revision);
        expect(inferred.revision).toBe(revision);
        expect((await reader.listRegularEntries()).map(entry => entry.sourcePath)).toEqual(['ai/Two.mjs']);

        const deferred = await createBrainImageRevisionReader(options);

        await fs.writeFile(path.join(root, 'ai', 'Two.mjs'), 'export const two = 3;\n');
        await expect(deferred.listRegularEntries())
            .rejects.toMatchObject({code: 'KB_CORE_CORPUS_CHECKOUT_DIRTY'});
        await expect(createBrainImageRevisionReader(options))
            .rejects.toMatchObject({code: 'KB_CORE_CORPUS_CHECKOUT_DIRTY'});

        await fs.writeFile(path.join(root, 'ai', 'Two.mjs'), 'export const two = 2;\n');
        await expect(createBrainImageRevisionReader({...options, revision: 'c'.repeat(40)}))
            .rejects.toMatchObject({code: 'KB_IMAGE_READER_BRAIN_IDENTITY_INVALID'});

        await fs.rm(path.join(root, '.git'), {recursive: true, force: true});
        await expect(createBrainImageRevisionReader(options))
            .rejects.toMatchObject({code: 'KB_CORE_CORPUS_CHECKOUT_REVISION_INVALID'});
    });

    test('refuses symlink and traversal, and rechecks bytes against the listed blob identity', async () => {
        const engineRoot = path.join(root, 'node_modules', 'neo.mjs');

        await fs.symlink('One.mjs', path.join(engineRoot, 'src', 'Link.mjs'));

        const reader = await createImageRevisionReader({
            sourceRoot: engineRoot,
            roots     : ['src'],
            tenantId  : 'neo-shared',
            repoSlug  : 'neo',
            revision  : ENGINE_SHA
        });

        expect((await reader.listRegularEntries()).map(entry => entry.sourcePath)).toEqual(['src/One.mjs']);
        await expect(reader.readText('src/Link.mjs'))
            .rejects.toMatchObject({code: 'KB_REVISION_READER_ENTRY_UNSUPPORTED'});
        await expect(createImageRevisionReader({
            sourceRoot: engineRoot, roots: ['../outside'], tenantId: 'neo-shared',
            repoSlug  : 'neo', revision: ENGINE_SHA
        })).rejects.toMatchObject({code: 'KB_REVISION_READER_PATH_INVALID'});

        await fs.writeFile(path.join(engineRoot, 'src', 'One.mjs'), 'export const one = 9;\n');
        await expect(reader.readText('src/One.mjs'))
            .rejects.toMatchObject({code: 'KB_IMAGE_READER_ENTRY_CHANGED'});
    });
});

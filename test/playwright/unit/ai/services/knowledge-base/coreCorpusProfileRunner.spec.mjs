import {setup} from '../../../../setup.mjs';

setup({appConfig: {name: 'CoreCorpusProfileRunnerTest'}});

import {test, expect}           from '@playwright/test';
import Neo                      from 'neo.mjs/src/Neo.mjs';
import * as core                from 'neo.mjs/src/core/_export.mjs';
import {createHash, randomUUID} from 'node:crypto';
import fs                       from 'node:fs/promises';
import os                       from 'node:os';
import path                     from 'node:path';

import {
    CORE_CORPUS_MANIFEST_SCHEMA,
    embedCoreCorpusProfiles,
    materializeCoreCorpusProfiles,
    readCoreCorpusManifest
} from '../../../../../../ai/services/knowledge-base/helpers/coreCorpusProfileRunner.mjs';
import {createRepositoryRevisionReader}       from '../../../../../../ai/services/knowledge-base/helpers/repositoryRevisionReader.mjs';
import {createExtractorCatalogue}             from '../../../../../../ai/services/knowledge-base/source/ExtractorCatalogue.mjs';
import {compileExtractionProfile}             from '../../../../../../ai/services/knowledge-base/helpers/extractionProfileRunner.mjs';
import {assertNoCoreCorpusAcquisitionOverlap} from '../../../../../../ai/services/knowledge-base/helpers/coreCorpusProfilePlan.mjs';

const ENGINE_REVISION = 'a'.repeat(40),
      BRAIN_REVISION  = 'b'.repeat(40),
      IDENTITY        = 'c'.repeat(64);

/**
 * @summary Creates a two-repository manifest over real temporary files for the embed boundary.
 * @param {String} directory
 * @returns {Promise<{dataPath: String, manifest: Object}>}
 */
async function fixtureManifest(directory) {
    const dataPath  = path.join(directory, 'core.jsonl');
    const artifacts = [];

    for (const [repoSlug, revision] of [['neo', ENGINE_REVISION], ['neo-agent-brain', BRAIN_REVISION]]) {
        const
            file  = `${dataPath}.${repoSlug}.${revision}.${randomUUID()}.jsonl`,
            bytes = Buffer.from(JSON.stringify({name: `${repoSlug}/one`}) + '\n');

        await fs.writeFile(file, bytes);
        artifacts.push({
            tenantId: 'neo-shared', repoSlug, revision, extractionIdentity: IDENTITY,
            path    : file, sha256: createHash('sha256').update(bytes).digest('hex'), count: 1
        });
    }

    const manifest = {schemaVersion: CORE_CORPUS_MANIFEST_SCHEMA, artifacts};

    await fs.writeFile(`${dataPath}.profiles.json`, JSON.stringify(manifest));
    return {dataPath, manifest}
}

/**
 * @summary Supplies exact reader identities without touching an installed package in this unit.
 * @param {String} revision
 * @returns {Function}
 */
const readerAt = revision => async ({tenantId, repoSlug}) => ({tenantId, repoSlug, revision});

test.describe('shared core profile publication and additive embed (#282)', () => {
    let directory;

    test.beforeEach(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-core-corpus-'));
    });

    test.afterEach(async () => {
        await fs.rm(directory, {recursive: true, force: true});
    });

    test('effective tenant routes refuse core owner keys and clone aliases; disabled or other-tenant routes remain separate', () => {
        const check = tenantRepos => assertNoCoreCorpusAcquisitionOverlap({tenantId: 'neo-shared', tenantRepos});

        expect(() => check([{tenantId: 'neo-shared', repoSlug: 'neo', cloneUrl: 'https://example.test/other.git'}]))
            .toThrow(expect.objectContaining({code: 'KB_CORE_CORPUS_ACQUISITION_OVERLAP'}));
        expect(() => check([{tenantId: 'neo-shared', repoSlug: 'alias', cloneUrl: 'git@github.com:neomjs/neo-agent-brain.git'}]))
            .toThrow(expect.objectContaining({code: 'KB_CORE_CORPUS_ACQUISITION_OVERLAP'}));
        expect(() => check([])).not.toThrow();
        expect(() => check([{tenantId: 'neo-shared', repoSlug: 'neo', disabled: true}])).not.toThrow();
        expect(() => check([{tenantId: 'other', repoSlug: 'neo', cloneUrl: 'https://github.com/neomjs/neo.git'}])).not.toThrow();
        expect(() => check([{tenantId: 'neo-shared', repoSlug: 'tenant-app', cloneUrl: 'https://example.test/tenant-app.git'}])).not.toThrow()
    });

    test('stamps Engine and Brain in separate additive calls; no stale-deletion option can override the cut', async () => {
        const {dataPath} = await fixtureManifest(directory);
        const calls      = [];
        const options    = {
            dataPath,
            brainRoot          : directory,
            brainRevision      : BRAIN_REVISION,
            engineReaderFactory: readerAt(ENGINE_REVISION),
            brainReaderFactory : readerAt(BRAIN_REVISION),
            vectorService      : {
                async embed(file, opts) {
                    calls.push({file, opts});
                    return {settled: 1, remaining: 0, yielded: false}
                }
            }
        };

        const result = await embedCoreCorpusProfiles(options);

        expect(result.results).toHaveLength(2);
        expect(calls.map(call => call.opts.tenantContext)).toEqual([
            {tenantId: 'neo-shared', repoSlug: 'neo'},
            {tenantId: 'neo-shared', repoSlug: 'neo-agent-brain'}
        ]);
        expect(calls.every(call => call.opts.deleteStale === false)).toBe(true);
        await expect(embedCoreCorpusProfiles({...options, staleStrategy: 'shadow-swap'}))
            .rejects.toMatchObject({code: 'KB_CORE_CORPUS_STALE_DELETION_DEFERRED'});
        expect(calls).toHaveLength(2);
    });

    test('refuses a changed artifact or changed image revision before calling the vector writer', async () => {
        const {dataPath, manifest} = await fixtureManifest(directory);
        const calls                = [];
        const options              = {
            dataPath, brainRoot: directory, brainRevision: BRAIN_REVISION,
            engineReaderFactory: readerAt(ENGINE_REVISION),
            brainReaderFactory : readerAt(BRAIN_REVISION),
            vectorService      : {async embed() { calls.push(true); return {settled: 1} }}
        };

        await fs.appendFile(manifest.artifacts[0].path, 'changed');
        await expect(embedCoreCorpusProfiles(options))
            .rejects.toMatchObject({code: 'KB_CORE_CORPUS_ARTIFACT_CHANGED'});
        expect(calls).toEqual([]);

        await fs.writeFile(manifest.artifacts[0].path, JSON.stringify({name: 'neo/one'}) + '\n');
        await expect(embedCoreCorpusProfiles({...options, engineReaderFactory: readerAt('d'.repeat(40))}))
            .rejects.toMatchObject({code: 'KB_CORE_CORPUS_REVISION_CHANGED'});
        expect(calls).toEqual([]);
    });

    test('does not publish a manifest when the second repository extraction refuses', async () => {
        const catalogue = createExtractorCatalogue([{
            extractorId: 'Fixture', version: '1.0.0',
            extract    : async ({context, writeStream}) => {
                if (context.repoSlug === 'neo-agent-brain') throw new Error('Brain source invalid');
                writeStream.write(JSON.stringify({source: 'src/one.md', type: 'doc', name: 'one', content: 'one'}) + '\n');
                return {count: 1, yieldedSourcePaths: ['src/one.md'], skippedSourcePaths: []}
            }
        }]);
        const profile = {
            profileSchemaVersion: 1,
            routes              : [{extractorId: 'Fixture', territory: {roots: ['src'], include: ['**/*.md']}}],
            fallback            : {action: 'exclude'}
        };
        const prepared = [];

        for (const [repoSlug, revision] of [['neo', ENGINE_REVISION], ['neo-agent-brain', BRAIN_REVISION]]) {
            const reader = createRepositoryRevisionReader({
                gitMirror: {
                    async listRevisionEntries() {
                        return [{sourcePath: 'src/one.md', mode: '100644', type: 'blob', oid: 'f'.repeat(40)}]
                    },
                    async readRevisionBlob() { return Buffer.from('one') },
                    async prefetchRevisionBlobs() { return {status: 'local'} }
                },
                mirrorRoot: directory, tenantId: 'neo-shared', repoSlug, revision
            });
            const compiled = await compileExtractionProfile({profile, catalogue, repositoryReader: reader});

            prepared.push({repoSlug, reader, compiled, extractionIdentity: IDENTITY});
        }

        const dataPath = path.join(directory, 'core.jsonl');

        await expect(materializeCoreCorpusProfiles({
            dataPath, prepared, tenantId: 'neo-shared', createHashFn: () => 'hash'
        })).rejects.toThrow('Brain source invalid');
        await expect(fs.access(`${dataPath}.profiles.json`)).rejects.toMatchObject({code: 'ENOENT'});
    });

    test('turns a provider refusal into a CLI failure while preserving the MCP error receipt', async () => {
        const {dataPath} = await fixtureManifest(directory);
        const options    = {
            dataPath, brainRoot: directory, brainRevision: BRAIN_REVISION,
            engineReaderFactory: readerAt(ENGINE_REVISION),
            brainReaderFactory : readerAt(BRAIN_REVISION),
            vectorService      : {async embed() { return {error: 'provider refused', code: 'KB_PROVIDER_REFUSED'} }}
        };

        await expect(embedCoreCorpusProfiles(options))
            .rejects.toMatchObject({code: 'KB_PROVIDER_REFUSED'});
        await expect(embedCoreCorpusProfiles({...options, viaMcp: true}))
            .resolves.toMatchObject({code: 'KB_PROVIDER_REFUSED', repoSlug: 'neo'});
    });
});

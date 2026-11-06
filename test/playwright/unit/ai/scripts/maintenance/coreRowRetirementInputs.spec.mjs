import {test, expect}                                                  from '@playwright/test';
import {parse}                                                         from 'acorn';
import crypto                                                          from 'node:crypto';
import fs                                                              from 'node:fs/promises';
import {readFileSync}                                                  from 'node:fs';
import os                                                              from 'node:os';
import path                                                            from 'node:path';
import {createCoreRowStoredRowDeriver, prepareCoreRowRetirementInputs} from '../../../../../../ai/scripts/maintenance/coreRowRetirementInputs.mjs';
import {buildCoreRowRetirementPlan, fingerprint}                       from '../../../../../../ai/scripts/maintenance/coreRowRetirementPlan.mjs';
import {buildChunkRowMetadata}                                         from '../../../../../../ai/services/knowledge-base/helpers/chunkRowMetadata.mjs';

const SCOPE = {tenantId: 'input-fixture-tenant', repoSlug: 'legacy-core'};

/** @summary Loads actual storage-ID/stamping/scope methods without initializing VectorService. */
function vectorOwner() {
    const text    = readFileSync(new URL('../../../../../../ai/services/knowledge-base/VectorService.mjs', import.meta.url), 'utf8');
    const cls     = parse(text, {ecmaVersion: 'latest', sourceType: 'module'}).body.find(node => node.type === 'ClassDeclaration' && node.id.name === 'VectorService');
    const methods = ['createTenantAwareChunkId', 'applyTenantStamp', 'buildOwnedScopeFilter'].map(name => {
        const method = cls.body.body.find(node => node.key?.name === name);
        return text.slice(method.start, method.end);
    });
    const owner = new Function('crypto', `return ({${methods.join(',\n')}})`)(crypto);
    const calls = [];
    owner.resolveTenantStamp = context => {calls.push(['resolve', context.repoSlug]); return {...context, tenantConfigVersion: 0, ingestedAt: 1};};
    owner.expandOversizedEmbeddingChunks = chunks => {calls.push(['expand', chunks.length]); return structuredClone(chunks);};
    owner.validateTenantStamp = () => {};
    owner.embed = () => {throw new Error('Input preparation must never embed');};
    return {owner, calls};
}

/** @summary Models only Chroma reads; foreign content is never requested and no write API is supplied. */
function observedCollection(rows) {
    const store = new Map(rows.map(row => [row.id, structuredClone(row.metadata)])), reads = [];
    return {
        store, reads, id: 'input-fixture-collection',
        async count() {return store.size;},
        async get({where, ids, include, limit, offset = 0}) {
            reads.push({where, ids, include});
            const wanted = ids && new Set(ids);
            const hits   = [...store].filter(([id, metadata]) => wanted ? wanted.has(id)
                : !where || where.$and.every(clause => Object.entries(clause).every(([key, filter]) => metadata[key] === filter.$eq)))
                .slice(offset, offset + limit);
            return {ids: hits.map(([id]) => id), metadatas: include.includes('metadatas') ? hits.map(([, metadata]) => structuredClone(metadata)) : null};
        }
    };
}

/** @summary Creates regular physical profile artifacts with the existing manifest reader's real byte contract. */
async function fixture(directory, {sharedPath = false, brainPath = 'src/Other.mjs', brainType = 'brain-source'} = {}) {
    const dataPath = path.join(directory, 'core.jsonl');
    const chunks   = [
        {type: 'src', kind: 'method', name: 'Fact.run', className: 'Neo.Fact', content: 'return 1;', description: 'return 1;',
            sourcePath: 'src/Fact.mjs', source: 'node_modules/neo.mjs/src/Fact.mjs', extractionIdentity: 'a'.repeat(64), hash: 'c'.repeat(64)},
        {type: brainType, kind: 'method', name: 'Fact.run', className: 'Neo.Fact', content: 'return 1;', description: 'return 1;',
            sourcePath        : sharedPath ? 'src/Fact.mjs' : brainPath, source: sharedPath ? 'src/Fact.mjs' : brainPath,
            extractionIdentity: 'b'.repeat(64), hash: 'd'.repeat(64)}
    ];
    const artifacts = [];
    for (const [index, repoSlug] of ['neo', 'neo-agent-brain'].entries()) {
        const text = `${JSON.stringify(chunks[index])}\n`, file = path.join(directory, `${repoSlug}.jsonl`);
        await fs.writeFile(file, text);
        artifacts.push({tenantId: SCOPE.tenantId, repoSlug, revision: String(index + 1).repeat(40),
            extractionIdentity: chunks[index].extractionIdentity, path: file, sha256: fingerprint(text), count: 1});
    }
    await fs.writeFile(`${dataPath}.profiles.json`, JSON.stringify({schemaVersion: 'neo.shared-core-corpus-profiles/v1', artifacts}));
    const {owner, calls} = vectorOwner(), derive = createCoreRowStoredRowDeriver(owner);
    const old            = {id: 'old-fact', metadata: {...SCOPE, type: 'src', kind: 'method', name: 'Fact.run', className: 'Neo.Fact',
        content: 'return 1;', description: 'return 1;', source: 'src/Fact.mjs', hash: 'old-hash', inheritanceChain: '[]'}};
    const landed = chunks.flatMap((chunk, index) => derive(chunk, {tenantId: SCOPE.tenantId, repoSlug: artifacts[index].repoSlug})
        .map(row => ({...row, metadata: {...row.metadata, inheritanceChain: '[]'}})));
    const collection = observedCollection([old, ...landed,
        {id: 'foreign-content', metadata: {tenantId: 'other', repoSlug: 'repo', type: 'src', content: 'must not be fetched'}},
        {id: 'legacy-concept', metadata: {...old.metadata, type: 'concept'}}]);
    calls.length = 0;
    const revisionChecks = [];
    const options        = {collection, vectorService: owner, scope: SCOPE, dataPath, brainRoot: directory, brainRevision: '2'.repeat(40), pageSize: 2,
        assertCurrentRevisions: async value => {revisionChecks.push(value);}};
    return {options, collection, owner, calls, old, landed, artifacts, chunks, revisionChecks,
        prepare: () => prepareCoreRowRetirementInputs(options)};
}

test.describe('manual core retirement input observations', () => {
    let directory;
    test.beforeEach(async () => {directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-core-retire-inputs-'));});
    test.afterEach(async () => {await fs.rm(directory, {recursive: true, force: true});});

    test('real manifest bytes, real owner storage IDs and bounded metadata reads produce planner inputs without writes', async () => {
        const f = await fixture(directory), input = await f.prepare(), map = JSON.parse(input.correspondence.text);
        expect(f.revisionChecks).toHaveLength(1);
        expect(f.revisionChecks[0]).toMatchObject({brainRoot: directory, brainRevision: '2'.repeat(40)});
        expect(f.calls.filter(call => call[0] === 'resolve').map(call => call[1])).toEqual(['neo', 'neo-agent-brain']);
        expect(input.protectedIds).toEqual(['foreign-content']);
        expect(input.census.map(row => row.id)).toContain(f.landed[1].id);
        expect(map.entries.map(entry => entry.oldId)).toEqual(['old-fact']);
        expect(map.conversions.paths).toContainEqual({repoSlug: 'neo-agent-brain', fromPrefix: 'src/ai/', toPrefix: 'ai/'});
        expect(buildCoreRowRetirementPlan(input).retirementIds).toEqual(['old-fact']);
        expect(f.collection.reads.filter(read => read.include.includes('metadatas')).every(read => read.where || !read.ids.includes('foreign-content'))).toBe(true);
        expect(Object.isFrozen(input.scope)).toBe(true);
        expect(Object.isFrozen(input.census[0].metadata)).toBe(true);
    });

    test('identical shared paths yield set-valued correspondences and both fully landed witnesses', async () => {
        const f = await fixture(directory, {sharedPath: true}), input = await f.prepare();
        expect(JSON.parse(input.correspondence.text).entries[0].targets).toHaveLength(2);
        expect(buildCoreRowRetirementPlan(input).candidates[0].replacements).toHaveLength(2);
    });

    test('a missing alternative stays in the proposal while the planner accepts an independent landed witness', async () => {
        const f = await fixture(directory, {sharedPath: true});
        f.collection.store.delete(f.landed[1].id);
        const input = await f.prepare(), plan = buildCoreRowRetirementPlan(input);
        expect(JSON.parse(input.correspondence.text).entries[0].targets).toHaveLength(2);
        expect(plan.retirementIds).toEqual(['old-fact']);
        expect(plan.candidates[0].replacements).toHaveLength(1);
        expect(plan.candidates[0].alternatives).toHaveLength(1);
    });

    test('completed retries still capture actual target rows even when every old candidate is absent', async () => {
        const f = await fixture(directory);
        f.collection.store.delete('old-fact');
        const input = await f.prepare();
        expect(JSON.parse(input.correspondence.text).entries).toEqual([]);
        expect(input.census.map(row => row.id)).toEqual(expect.arrayContaining(f.landed.map(row => row.id)));
    });

    test('every expanded child ID is fetched; an absent child remains visible to the planner', async () => {
        const f = await fixture(directory);
        f.owner.expandOversizedEmbeddingChunks = chunks => chunks.flatMap(chunk => {
            if (!chunk.source.startsWith('node_modules/neo.mjs/')) return [chunk];
            return [0, 1].map(index => {
                const start = index ? 4 : 0, end = index ? chunk.content.length : 4;
                return {...chunk, content: chunk.content.slice(start, end), description: chunk.content.slice(start, end),
                    name                   : `${chunk.name} [part ${index + 1}/2]`, hash: fingerprint({parent: chunk.hash, index}),
                    oversizedSplit         : true, oversizedSplitIndex: index, oversizedSplitTotal: 2,
                    oversizedSplitCharStart: start, oversizedSplitCharEnd: end};
            });
        });
        const children = createCoreRowStoredRowDeriver(f.owner)(f.chunks[0], {tenantId: SCOPE.tenantId, repoSlug: 'neo'});
        f.collection.store.delete(f.landed[0].id);
        for (const row of children) f.collection.store.set(row.id, {...row.metadata, inheritanceChain: '[]'});
        const input = await f.prepare(), plan = buildCoreRowRetirementPlan(input);
        expect(input.census.map(row => row.id)).toEqual(expect.arrayContaining(children.map(row => row.id)));
        expect(plan.candidates[0].replacements[0].ids).toHaveLength(2);
        f.collection.store.delete(children[1].id);
        expect(buildCoreRowRetirementPlan(await f.prepare()).retirementIds).toEqual([]);
    });

    test('generic same-body chunks do not match a moved path or another name', async () => {
        const f = await fixture(directory);
        f.collection.store.get('old-fact').source = 'src/Moved.mjs';
        expect(JSON.parse((await f.prepare()).correspondence.text).entries).toEqual([]);
        f.collection.store.get('old-fact').source = 'src/Fact.mjs';
        f.collection.store.get('old-fact').name = 'Different.run';
        expect(JSON.parse((await f.prepare()).correspondence.text).entries).toEqual([]);
    });

    test('same-path changed content is only a proposal and remains preserved after independent equality', async () => {
        const f = await fixture(directory);
        f.collection.store.get('old-fact').content = 'changed old fact';
        const input = await f.prepare();
        expect(JSON.parse(input.correspondence.text).entries).toHaveLength(1);
        expect(buildCoreRowRetirementPlan(input).retirementIds).toEqual([]);
    });

    test('old src/ai paths use only the explicit ai-infrastructure alias, bound into map bytes', async () => {
        const f = await fixture(directory, {brainPath: 'ai/Fact.mjs', brainType: 'ai-infrastructure'});
        f.collection.store.get('old-fact').source = 'src/ai/Fact.mjs';
        const input = await f.prepare(), entry = JSON.parse(input.correspondence.text).entries[0];
        expect(entry.targets.map(target => target.repoSlug)).toEqual(['neo-agent-brain']);
        expect(entry.targets[0].conversions).toContainEqual({field: 'type', from: 'src', to: 'ai-infrastructure'});
        expect(buildCoreRowRetirementPlan(input).retirementIds).toEqual(['old-fact']);
        const wrong = await fixture(directory, {brainPath: 'ai/Fact.mjs', brainType: 'brain-source'});
        wrong.collection.store.get('old-fact').source = 'src/ai/Fact.mjs';
        expect(JSON.parse((await wrong.prepare()).correspondence.text).entries).toEqual([]);
    });

    test('Skills, release notes, concepts and already-profiled rows never generate correspondences', async () => {
        const f = await fixture(directory);
        for (const type of ['skill', 'release', 'concept']) f.collection.store.set(`old-${type}`, {...f.old.metadata, type});
        f.collection.store.set('profile-old-tuple', {...f.old.metadata, extractionIdentity: 'f'.repeat(64)});
        const input = await f.prepare();
        expect(JSON.parse(input.correspondence.text).entries.map(entry => entry.oldId)).toEqual(['old-fact']);
        expect(input.census.map(row => row.id)).toEqual(expect.arrayContaining(['old-skill', 'old-release', 'old-concept', 'profile-old-tuple']));
    });

    test('absent manifest and changed artifact refuse before collection observation', async () => {
        const f = await fixture(directory);
        await fs.unlink(`${f.options.dataPath}.profiles.json`);
        await expect(f.prepare()).rejects.toHaveProperty('code', 'ENOENT');
        expect(f.collection.reads).toEqual([]);
        const g = await fixture(directory);
        await fs.appendFile(g.artifacts[0].path, ' ');
        await expect(g.prepare()).rejects.toHaveProperty('code', 'KB_CORE_CORPUS_ARTIFACT_CHANGED');
        expect(g.collection.reads).toEqual([]);
    });

    test('a current-revision refusal is not replaced by a passing artifact SHA', async () => {
        const f = await fixture(directory);
        f.options.assertCurrentRevisions = async () => {throw Object.assign(new Error('revision advanced'), {code: 'KB_CORE_CORPUS_REVISION_CHANGED'});};
        await expect(f.prepare()).rejects.toHaveProperty('code', 'KB_CORE_CORPUS_REVISION_CHANGED');
        expect(f.collection.reads).toEqual([]);
    });

    test('manifest pointer movement and collection population movement both refuse', async () => {
        const f     = await fixture(directory);
        let   reads = 0;
        f.options.readText = async file => {
            const text = await fs.readFile(file, 'utf8');
            return file.endsWith('.profiles.json') && ++reads > 1 ? text + ' ' : text;
        };
        await expect(f.prepare()).rejects.toHaveProperty('code', 'KB_CORE_RETIRE_MANIFEST_MOVED');
        expect(f.collection.reads).toEqual([]);
        const g = await fixture(directory), get = g.collection.get;
        g.collection.get = async options => {
            const result = await get(options);
            if (options.where) g.collection.store.delete('foreign-content');
            return result;
        };
        await expect(g.prepare()).rejects.toHaveProperty('code', 'KB_CORE_RETIRE_POPULATION_MOVED');
    });

    test('a leaking legacy filter refuses foreign metadata instead of silently swallowing it', async () => {
        const f = await fixture(directory), get = f.collection.get;
        f.collection.get = options => options.where ? Promise.resolve({ids: ['foreign-content'], metadatas: [f.collection.store.get('foreign-content')]}) : get(options);
        await expect(f.prepare()).rejects.toHaveProperty('code', 'KB_CORE_RETIRE_LEGACY_ROW_INVALID');
    });

    test('owner stamping cannot redirect target IDs into another tenant', async () => {
        const {owner} = vectorOwner();
        owner.resolveTenantStamp = context => ({...context, tenantId: 'other'});
        const derive = createCoreRowStoredRowDeriver(owner);
        expect(() => derive({name: 'Fact', type: 'src', source: 'src/Fact.mjs', hash: 'a'}, SCOPE)).toThrow('KB_CORE_RETIRE_STAMP_CHANGED');
    });
});

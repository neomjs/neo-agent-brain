import Neo                                from 'neo.mjs/src/Neo.mjs';
import * as core                          from 'neo.mjs/src/core/_export.mjs';
import {test, expect}                     from '@playwright/test';
import fs                                 from 'node:fs/promises';
import os                                 from 'node:os';
import path                               from 'node:path';
import {randomUUID}                       from 'node:crypto';
import {runCoreRetirement, createCommand} from '../../../../../../ai/scripts/maintenance/retireLegacyCoreRows.mjs';
import {fingerprint, metadataFingerprint} from '../../../../../../ai/scripts/maintenance/coreRowRetirementPlan.mjs';
import {writeFileAtomic}                  from '../../../../../../ai/services/shared/atomicFileWrite.mjs';

const scope = {tenantId: 'fixture', repoSlug: 'neo'};
let directory;
test.beforeEach(async () => {directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-core-retirement-'));});
test.afterEach(async () => {await fs.rm(directory, {recursive: true, force: true});});

/** @summary Supplies an isolated collection and exact source files; no runtime service is imported. */
function fixture() {
    const chunks = ['neo', 'neo-agent-brain'].map((repoSlug, index) => ({
        type              : 'src', kind: 'method', source: index ? 'src/Other.mjs' : 'src/Fact.mjs',
        sourcePath        : index ? 'src/Other.mjs' : 'src/Fact.mjs', name: index ? 'Other.run' : 'Fact.run',
        content           : 'return 1;', description: 'return 1;', hash: String(index + 1).repeat(64),
        extractionIdentity: String(index + 3).repeat(64)
    }));
    const files     = chunks.map((chunk, index) => ({path: '/fixture/core-' + index + '.jsonl', text: JSON.stringify(chunk) + '\n'}));
    const artifacts = files.map((file, index) => ({
        tenantId: scope.tenantId, repoSlug: index ? 'neo-agent-brain' : 'neo',
        revision: String(index + 5).repeat(40), extractionIdentity: chunks[index].extractionIdentity,
        path    : file.path, sha256: fingerprint(file.text), count: 1
    }));
    const manifestText     = JSON.stringify({schemaVersion: 'neo.shared-core-corpus-profiles/v1', artifacts});
    const deriveStoredRows = (chunk, stamp) => {
        const id = fingerprint([chunk.hash, stamp.repoSlug]);
        return [{id, metadata: {...chunk, ...stamp, id, hash: id}}];
    };
    const {hash, extractionIdentity, sourcePath, ...meaning} = chunks[0];
    const old                                                = {id: 'old-id', metadata: {...meaning, ...scope, hash: 'old-hash'}};
    const newRows                                            = chunks.flatMap((chunk, index) => deriveStoredRows(chunk, {
        tenantId: scope.tenantId, repoSlug: artifacts[index].repoSlug
    }));
    const store = new Map([old, ...newRows, {id: 'foreign', metadata: {
        tenantId: 'other', repoSlug: 'other', type: 'src', content: 'preserve'
    }}].map(row => [row.id, structuredClone(row.metadata)]));
    const target = {
        repoSlug      : artifacts[0].repoSlug, revision: artifacts[0].revision,
        artifactSha256: artifacts[0].sha256, extractionIdentity: artifacts[0].extractionIdentity,
        source        : chunks[0].source, sourcePath: chunks[0].sourcePath, type: chunks[0].type,
        name          : chunks[0].name, kind: chunks[0].kind,
        conversions   : [{field: 'sourcePath', from: null, to: chunks[0].sourcePath}]
    };
    const mapText    = JSON.stringify({entries: [{oldId: old.id, metadataDigest: metadataFingerprint(old.metadata), targets: [target]}]});
    let   deletes    = 0, preparations = 0;
    const collection = {
        id: 'fixture-collection',
        async count() {return store.size;},
        async get({ids, offset = 0, limit, include}) {
            const rows = [...store].filter(([id]) => !ids || ids.includes(id)).slice(offset, offset + limit);
            return {ids: rows.map(([id]) => id), metadatas: include.includes('metadatas') ? rows.map(([, metadata]) => structuredClone(metadata)) : null};
        },
        async delete({ids}) {deletes++; ids.forEach(id => store.delete(id));}
    };
    const options = {
        collection, planPath: path.join(directory, 'plan.json'), pageSize: 2,
        async prepareInputs() {
            preparations++;
            return {
                collectionId  : collection.id, scope,
                manifest      : {text: manifestText, sha256: fingerprint(manifestText)}, artifacts: files,
                census        : [...store].map(([id, metadata]) => ({id, metadata: structuredClone(metadata)})),
                correspondence: {text: mapText, sha256: fingerprint(mapText)}, deriveStoredRows, protectedIds: []
            };
        }
    };
    return {options, store, replacement: newRows[0].id, get deletes() {return deletes;}, get preparations() {return preparations;}};
}

test('dry run writes a private exact-ID preview and no journal or collection mutation', async () => {
    const f       = fixture(), writes = [];
    const receipt = await runCoreRetirement({...f.options, writeAtomic: async (...args) => {
        writes.push(args);
        return writeFileAtomic(...args);
    }});
    const file = JSON.parse(await fs.readFile(f.options.planPath, 'utf8'));
    expect(file.plan.retirementIds).toEqual(['old-id']);
    expect(receipt).toMatchObject({apply: false, executable: true, candidateCount: 1, refusalCount: 0, noOp: false,
        legacyByFamily: {src: 1}, profiles: [{repoSlug: 'neo', landedCount: 1}, {repoSlug: 'neo-agent-brain', landedCount: 1}]});
    expect(writes[0][2]).toMatchObject({fsync: true, mode: 0o600});
    expect((await fs.stat(f.options.planPath)).mode & 0o077).toBe(0);
    await expect(fs.stat(f.options.planPath + '.progress.json')).rejects.toHaveProperty('code', 'ENOENT');
    expect(f.deletes).toBe(0);
});

test('apply reloads private bytes, journals durably and retries without repeating a delete', async () => {
    const f       = fixture();
    const preview = await runCoreRetirement(f.options);
    const apply   = {...f.options, apply: true, confirmation: preview.planDigest};
    const receipt = await runCoreRetirement(apply);
    expect(receipt).toMatchObject({apply: true, complete: true, retiredConfirmed: 1});
    expect(f.store.has('old-id')).toBe(false);
    expect(f.store.has('foreign')).toBe(true);
    expect(f.store.has(f.replacement)).toBe(true);
    const journal = JSON.parse(await fs.readFile(f.options.planPath + '.progress.json', 'utf8'));
    expect(journal).toMatchObject({planDigest: preview.planDigest, confirmed: ['old-id'], complete: true});
    expect((await fs.stat(f.options.planPath + '.progress.json')).mode & 0o077).toBe(0);
    const retry = await runCoreRetirement(apply);
    expect(retry.alreadyComplete).toBe(true);
    expect(f.deletes).toBe(1);
});

test('planning cannot overwrite a plan or an orphaned journal', async () => {
    const a = fixture();
    await runCoreRetirement(a.options);
    await expect(runCoreRetirement(a.options)).rejects.toHaveProperty('code', 'KB_CORE_RETIRE_FILE_EXISTS');
    expect(a.preparations).toBe(1);
    const b = fixture();
    b.options.planPath += '-other';
    await fs.writeFile(b.options.planPath + '.progress.json', '{}', {mode: 0o600});
    await expect(runCoreRetirement(b.options)).rejects.toHaveProperty('code', 'KB_CORE_RETIRE_FILE_EXISTS');
    expect(b.preparations).toBe(0);
});

test('a zero legacy population produces an explicit no-op preview with preservation evidence', async () => {
    const f = fixture();
    f.store.delete('old-id');
    const original = f.options.prepareInputs;
    const receipt  = await runCoreRetirement({...f.options, async prepareInputs() {
        const inputs = await original();
        const text   = JSON.stringify({entries: []});
        return {...inputs, correspondence: {text, sha256: fingerprint(text)}};
    }});
    expect(receipt).toMatchObject({noOp: true, candidateCount: 0, legacyByFamily: {}, preservation: {count: 3}});
    expect(f.deletes).toBe(0);
});

test('wrong confirmation refuses before fresh inputs or journal creation', async () => {
    const f = fixture();
    await runCoreRetirement(f.options);
    await expect(runCoreRetirement({...f.options, apply: true, confirmation: 'wrong'}))
        .rejects.toHaveProperty('code', 'KB_CORE_RETIRE_UNCONFIRMED');
    expect(f.preparations).toBe(1);
    expect(f.deletes).toBe(0);
});

test('changed landed target content refuses even though the artifact and map remain unchanged', async () => {
    const f = fixture(), preview = await runCoreRetirement(f.options);
    f.store.get(f.replacement).content = 'different fact';
    await expect(runCoreRetirement({...f.options, apply: true, confirmation: preview.planDigest}))
        .rejects.toHaveProperty('code', 'KB_CORE_RETIRE_PROOF_CHANGED');
    expect(f.deletes).toBe(0);
    expect(f.store.has('old-id')).toBe(true);
});

for (const carrier of ['permissive', 'symlink']) {
    test('apply refuses a ' + carrier + ' plan carrier before collection mutation', async () => {
        const f = fixture(), preview = await runCoreRetirement(f.options);
        if (carrier === 'permissive') await fs.chmod(f.options.planPath, 0o644);
        else {
            const target = f.options.planPath + '-real';
            await fs.rename(f.options.planPath, target);
            await fs.symlink(target, f.options.planPath);
        }
        await expect(runCoreRetirement({...f.options, apply: true, confirmation: preview.planDigest}))
            .rejects.toHaveProperty('code', 'KB_CORE_RETIRE_FILE_NOT_PRIVATE');
        expect(f.deletes).toBe(0);
    });
}

test('a changed selected scope during revalidation refuses before deletion', async () => {
    const f        = fixture(), preview = await runCoreRetirement(f.options);
    const original = f.options.prepareInputs;
    await expect(runCoreRetirement({...f.options, apply: true, confirmation: preview.planDigest,
        async prepareInputs() {
            const inputs = await original();
            inputs.scope = {...scope, repoSlug: 'different'};
            return inputs;
        }
    })).rejects.toHaveProperty('code', 'KB_CORE_RETIRE_COLLECTION_CHANGED');
    expect(f.deletes).toBe(0);
});

test('the command defaults to preview and requires an explicit plan path', () => {
    const options = createCommand().parse(['node', 'test', '--plan-file', '/private/plan.json']).opts();
    expect(options).toMatchObject({apply: false, confirm: '', pageSize: '2000', planFile: '/private/plan.json'});
});

test('native Chroma applies exact captured IDs and preserves target and foreign metadata across a retry', async () => {
    test.skip(!process.env.NEO_UNIT_CHROMA_PID, 'The canonical Brain unit config supplies a run-scoped Chroma process.');
    const port = Number(process.env.NEO_CHROMA_PORT_TEST);
    expect(Number.isSafeInteger(port) && port > 0).toBe(true);
    expect(process.env.NEO_CHROMA_DATA_DIR_TEST).toBeTruthy();
    const {ChromaClient} = await import('chromadb');
    const client         = new ChromaClient({host: process.env.NEO_CHROMA_HOST_TEST, port, ssl: false, database: 'default_database'});
    const name           = 'core-retirement-' + randomUUID();
    const collection     = await client.createCollection({name, embeddingFunction: null});
    try {
        const f    = fixture(), sourceInputs = await f.options.prepareInputs();
        const rows = sourceInputs.census;
        await collection.add({ids: rows.map(row => row.id), metadatas: rows.map(row => row.metadata), embeddings: rows.map(() => [1, 0])});
        const options = {...f.options, collection, async prepareInputs() {
            const page = await collection.get({include: ['metadatas'], limit: 100});
            return {...sourceInputs, collectionId: collection.id,
                census: page.ids.map((id, index) => ({id, metadata: page.metadatas[index]}))};
        }};
        const preview = await runCoreRetirement(options);
        expect(preview.candidateCount).toBe(1);
        const apply   = {...options, apply: true, confirmation: preview.planDigest};
        const receipt = await runCoreRetirement(apply);
        expect(receipt).toMatchObject({complete: true, retiredConfirmed: 1});
        const after = await collection.get({include: ['metadatas'], limit: 100});
        expect(after.ids.sort()).toEqual(rows.filter(row => row.id !== 'old-id').map(row => row.id).sort());
        for (const row of rows.filter(row => row.id !== 'old-id')) {
            const actual = await collection.get({ids: [row.id], include: ['metadatas']});
            expect(actual.metadatas[0]).toEqual(row.metadata);
        }
        expect((await runCoreRetirement(apply)).alreadyComplete).toBe(true);
        expect(await collection.count()).toBe(rows.length - 1);
    } finally {
        await client.deleteCollection({name});
    }
});

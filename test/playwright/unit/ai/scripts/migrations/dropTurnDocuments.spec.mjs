import {knownEmbeddingFunctions, registerEmbeddingFunction, ChromaClient} from 'chromadb';
import {test, expect}                                                     from '@playwright/test';
import fs                                                                 from 'node:fs/promises';
import os                                                                 from 'node:os';
import path                                                               from 'node:path';
import 'neo.mjs/src/Neo.mjs';
import 'neo.mjs/src/core/_export.mjs';

import {classifyTurnRow, dropTurnDocuments, parseArgs, restoreTurnDocuments} from '../../../../../../ai/scripts/migrations/dropTurnDocuments.mjs';
import {composeTurnDocumentText, resolveTurnDocumentForRead}                 from '../../../../../../ai/services/memory-core/helpers/turnDocumentText.mjs';
import {CHROMA_TEST_DATABASE, ensureChromaTestDatabase}                      from '../../../../../../ai/services/shared/vector/chromaTestIsolation.mjs';

/**
 * The turn-document migration against the run-scoped test Chroma (`chroma.setup.mjs`). Each test seeds its own
 * collection with three turns whose document their split fields rebuild, a turn whose document differs, a turn
 * already stored without one (as turns are written now), and a plan row.
 */
test.describe('Neo.ai.scripts.migrations.dropTurnDocuments against a real Chroma (#1441)', () => {
    const
        host  = process.env.NEO_CHROMA_HOST_TEST,
        port  = Number(process.env.NEO_CHROMA_PORT_TEST),
        names = [];

    let client, root, embedCalls = 0;

    const turn = n => ({type: 'agent-interaction', prompt: `prompt ${n} tok${n}x`, thought: `thought ${n}`, response: `response ${n}`, sessionId: 's1441', timestamp: n});

    // A deterministic, provider-free embedding function that counts its calls, registered so the collection persists it.
    function createEmbeddingFunction() {
        const
            name              = `drop_turn_documents_test_${process.pid}`,
            embeddingFunction = {name, getConfig: () => ({}), generate: async texts => {
                embedCalls++;
                // finite for '' too, so a re-embedded empty document lands and the vector assertions catch it
                return texts.map(text => [text.length % 7 / 7, text ? text.charCodeAt(text.length - 1) / 128 : 0, 0.25])
            }};

        class DropTurnDocumentsTestEmbeddingFunction {
            static buildFromConfig() {
                return embeddingFunction
            }
        }

        embeddingFunction.constructor = DropTurnDocumentsTestEmbeddingFunction;

        if (!knownEmbeddingFunctions.has(name)) {
            registerEmbeddingFunction(name, DropTurnDocumentsTestEmbeddingFunction)
        }

        return embeddingFunction
    }

    async function seed(tag) {
        const name       = `test-drop-turn-documents-${process.pid}-${Date.now()}-${tag}`,
              collection = await client.getOrCreateCollection({name, embeddingFunction: createEmbeddingFunction()}),
              rows       = [
                  {id: 'turn-1', metadata: turn(1)},
                  {id: 'turn-2', metadata: turn(2)},
                  {id: 'turn-3', metadata: turn(3)},
                  {id: 'turn-mismatch', metadata: turn(4), document: 'an older document shape tok4x'},
                  {id: 'plan-1', metadata: {type: 'implementation_plan', sessionId: 's1441'}, document: 'a plan tok5x'}
              ];

        names.push(name);
        await collection.add({ids: rows.map(row => row.id), documents: rows.map(row => row.document ?? composeTurnDocumentText(row.metadata)), metadatas: rows.map(row => row.metadata)});
        await collection.add({ids: ['turn-empty'], embeddings: [[0.5, 0.5, 0.5]], metadatas: [turn(6)]});
        embedCalls = 0;

        return collection
    }

    const read = async collection => {
        const stored = await collection.get({include: ['documents', 'metadatas', 'embeddings']});
        return new Map(stored.ids.map((id, i) => [id, {document: stored.documents[i], metadata: stored.metadatas[i], vector: Array.from(stored.embeddings[i])}]))
    };

    const fullText = async (collection, token) => (await collection.get({whereDocument: {$contains: token}, include: []})).ids;

    test.beforeAll(async () => {
        await ensureChromaTestDatabase({host, port, database: CHROMA_TEST_DATABASE});
        client = new ChromaClient({host, port, ssl: false, database: CHROMA_TEST_DATABASE});
        root   = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-turn-documents-'))
    });

    test.afterAll(async () => {
        for (const name of names) await client?.deleteCollection({name}).catch(() => {});
        await fs.rm(root, {recursive: true, force: true})
    });

    test('classifyTurnRow drops only a turn its split fields rebuild byte for byte', () => {
        const metadata = turn(9);

        expect(classifyTurnRow({document: composeTurnDocumentText(metadata), metadata})).toBe('drop');
        expect(classifyTurnRow({document: `${composeTurnDocumentText(metadata)} `, metadata})).toBe('mismatch');
        expect(classifyTurnRow({document: 'User Prompt: undefined\nAgent Thought: undefined\nAgent Response: undefined', metadata: {type: 'agent-interaction'}})).toBe('mismatch');
        expect(classifyTurnRow({document: '', metadata})).toBe('empty');
        expect(classifyTurnRow({document: null, metadata})).toBe('empty');
        expect(classifyTurnRow({document: 'a plan', metadata: {type: 'implementation_plan'}})).toBe('other');
        expect(classifyTurnRow({document: 'no metadata', metadata: null})).toBe('other')
    });

    test('a dry-run counts every class and writes nothing', async () => {
        const collection = await seed('dry'),
              before     = await read(collection);

        expect(await dropTurnDocuments({collection})).toEqual({
            rows         : 6, drop: 3, mismatch: 1, empty: 1, other: 1, cleared: 0,
            documentBytes: [1, 2, 3].reduce((sum, n) => sum + Buffer.byteLength(composeTurnDocumentText(turn(n))), 0)
        });
        expect(await read(collection)).toEqual(before)
    });

    test('apply clears exactly the qualifying rows, keeps every vector, embeds nothing, and snapshots first', async () => {
        const collection   = await seed('apply'),
              before       = await read(collection),
              snapshotPath = path.join(root, 'apply.jsonl');

        const stats = await dropTurnDocuments({collection, apply: true, snapshotPath, batchSize: 2});
        const after = await read(collection);

        expect(stats).toMatchObject({drop: 3, cleared: 3, mismatch: 1, empty: 1, other: 1});
        expect(embedCalls).toBe(0);

        for (const id of before.keys()) {
            expect(after.get(id).vector).toEqual(before.get(id).vector);
            expect(after.get(id).metadata).toEqual(before.get(id).metadata)
        }
        for (const id of ['turn-1', 'turn-2', 'turn-3']) {
            expect(after.get(id).document).toBe('');
            expect(resolveTurnDocumentForRead({documents: [after.get(id).document], metadata: after.get(id).metadata})).toBe(before.get(id).document)
        }
        for (const id of ['turn-mismatch', 'plan-1', 'turn-empty']) expect(after.get(id).document).toBe(before.get(id).document);

        expect(await fullText(collection, 'tok1x')).toEqual([]);
        expect(await fullText(collection, 'tok4x')).toEqual(['turn-mismatch']);
        expect(await fullText(collection, 'tok5x')).toEqual(['plan-1']);

        const snapshot = (await fs.readFile(snapshotPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(snapshot).toEqual(['turn-1', 'turn-2', 'turn-3'].map(id => ({id, document: before.get(id).document})))
    });

    test('a rerun resumes: rows already empty are skipped and the snapshot does not grow', async () => {
        const collection   = await seed('rerun'),
              snapshotPath = path.join(root, 'rerun.jsonl');

        await dropTurnDocuments({collection, apply: true, snapshotPath});
        const size = (await fs.stat(snapshotPath)).size;

        expect(await dropTurnDocuments({collection, apply: true, snapshotPath})).toMatchObject({drop: 0, cleared: 0, empty: 4, mismatch: 1, other: 1});
        expect((await fs.stat(snapshotPath)).size).toBe(size)
    });

    test('restore writes the snapshot back with each row\'s vector', async () => {
        const collection   = await seed('restore'),
              before       = await read(collection),
              snapshotPath = path.join(root, 'restore.jsonl');

        await dropTurnDocuments({collection, apply: true, snapshotPath});

        expect(await restoreTurnDocuments({collection, snapshotPath, batchSize: 2})).toEqual({snapshotted: 3, restored: 3, missing: 0});
        expect(embedCalls).toBe(0);
        expect(await read(collection)).toEqual(before);
        expect(await fullText(collection, 'tok1x')).toEqual(['turn-1'])
    });

    test('a document holding U+2028 or U+2029 restores whole', async () => {
        const collection   = await seed('separators'),
              snapshotPath = path.join(root, 'separators.jsonl'),
              // JSON.stringify leaves both raw; a line reader that breaks at them splits the snapshot record
              metadata     = {...turn(7), prompt: `line${String.fromCodePoint(0x2028)}break`, thought: `paragraph${String.fromCodePoint(0x2029)}break`};

        await collection.add({ids: ['turn-separators'], documents: [composeTurnDocumentText(metadata)], metadatas: [metadata]});
        const before = await read(collection);

        await dropTurnDocuments({collection, apply: true, snapshotPath});

        expect(await restoreTurnDocuments({collection, snapshotPath})).toEqual({snapshotted: 4, restored: 4, missing: 0});
        expect(await read(collection)).toEqual(before)
    });

    test('a batch whose update commits and then fails is read back and counted as cleared', async () => {
        const collection   = await seed('committed'),
              snapshotPath = path.join(root, 'committed.jsonl'),
              flaky        = {get: options => collection.get(options), update: async options => {
                  await collection.update(options);
                  throw new Error('connection reset after the commit')
              }};

        expect(await dropTurnDocuments({collection: flaky, apply: true, snapshotPath})).toMatchObject({drop: 3, cleared: 3});
        expect((await read(collection)).get('turn-1').document).toBe('')
    });

    test('a batch whose update fails before committing stops the run with its documents snapshotted', async () => {
        const collection   = await seed('failed'),
              before       = await read(collection),
              snapshotPath = path.join(root, 'failed.jsonl'),
              failing      = {get: options => collection.get(options), update: async () => {
                  throw new Error('server unreachable')
              }};

        await expect(dropTurnDocuments({collection: failing, apply: true, snapshotPath})).rejects.toThrow('3 of 3 rows still hold their document');
        expect(await read(collection)).toEqual(before);
        expect((await fs.readFile(snapshotPath, 'utf8')).trim().split('\n')).toHaveLength(3)
    });

    test('parseArgs defaults to a dry-run and refuses an unsafe or malformed command line', () => {
        expect(parseArgs([])).toEqual({apply: false, snapshot: null, restore: null, batch: 250, help: false});
        expect(parseArgs(['--apply', '--snapshot', 'a.jsonl', '--batch', '100'])).toMatchObject({apply: true, snapshot: 'a.jsonl', batch: 100});
        expect(() => parseArgs(['--apply'])).toThrow('--apply needs --snapshot');
        expect(() => parseArgs(['--apply', '--snapshot', 'a.jsonl', '--restore', 'a.jsonl'])).toThrow('exclude each other');
        expect(() => parseArgs(['--snapshot', '--apply'])).toThrow('--snapshot needs a value');
        expect(() => parseArgs(['--batch', '0'])).toThrow('positive integer');
        expect(() => parseArgs(['--force'])).toThrow('unknown argument --force')
    })
});

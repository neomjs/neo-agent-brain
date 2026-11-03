import {knownEmbeddingFunctions, registerEmbeddingFunction, ChromaClient} from 'chromadb';
import {test, expect}                                                      from '@playwright/test';
import fs                                                                  from 'node:fs/promises';
import os                                                                  from 'node:os';
import path                                                                from 'node:path';
import 'neo.mjs/src/Neo.mjs';
import 'neo.mjs/src/core/_export.mjs';

import {embedBatch}                                          from '../../../../../../ai/daemons/embed/drainCycle.mjs';
import {fingerprintRestoreSourceFile}                        from '../../../../../../ai/services/memory-core/helpers/restoreTargetSetAdmission.mjs';
import {composeTurnDocumentText, resolveTurnDocumentForRead} from '../../../../../../ai/services/memory-core/helpers/turnDocumentText.mjs';
import {importVectorJsonlToEmptyCollection}                  from '../../../../../../ai/services/memory-core/helpers/vectorJsonlImport.mjs';
import {CHROMA_TEST_DATABASE, ensureChromaTestDatabase}      from '../../../../../../ai/services/shared/vector/chromaTestIsolation.mjs';

/**
 * Real-Chroma witness against the run-scoped test Chroma (`chroma.setup.mjs`): a turn drained by
 * `embedBatch` lands with its vector and without a stored document, is found by a vector query, has no
 * full-text entry, and reads back whole through `resolveTurnDocumentForRead`. The fake-collection specs in
 * `drainCycle.spec.mjs` pin the payload shape; this one proves chromadb accepts it and stores what it says.
 */
test.describe('Neo.ai.daemons.embed.drainCycle against a real Chroma (#128)', () => {
    const host = process.env.NEO_CHROMA_HOST_TEST,
          port = Number(process.env.NEO_CHROMA_PORT_TEST);

    let client, collectionName;

    // A deterministic, provider-free embedding function, registered so the collection can persist it.
    function createEmbeddingFunction() {
        const name              = `drain_cycle_turn_test_${process.pid}`;
        const embeddingFunction = {name, getConfig: () => ({}), generate: async texts => texts.map(() => [1, 0, 0])};

        class TurnTestEmbeddingFunction {
            static buildFromConfig() {
                return embeddingFunction;
            }
        }

        embeddingFunction.constructor = TurnTestEmbeddingFunction;

        if (!knownEmbeddingFunctions.has(name)) {
            registerEmbeddingFunction(name, TurnTestEmbeddingFunction);
        }

        return embeddingFunction;
    }

    test.beforeAll(async () => {
        await ensureChromaTestDatabase({host, port, database: CHROMA_TEST_DATABASE});

        client         = new ChromaClient({host, port, ssl: false, database: CHROMA_TEST_DATABASE});
        collectionName = `test-drain-cycle-turns-${process.pid}-${Date.now()}`;
    });

    test.afterAll(async () => {
        for (const name of [collectionName, `${collectionName}-source`, `${collectionName}-target`]) {
            await client?.deleteCollection({name}).catch(() => {});
        }
    });

    const drainTurn = (collection, id, metadata) => embedBatch({
        collection,
        records      : [{id, metadata, document: composeTurnDocumentText(metadata), segmentKey: 'unused'}],
        maxRetries   : 0,
        backoffBaseMs: 1,
        sleep        : async () => {},
        log          : () => {}
    });

    test('a drained turn keeps its vector, stores no document, has no full-text entry, and reads back whole', async () => {
        const collection = await client.getOrCreateCollection({name: collectionName, embeddingFunction: createEmbeddingFunction()}),
              metadata   = {type: 'agent-interaction', prompt: 'p128', thought: 't128', response: 'r128', sessionId: 's128', timestamp: 1},
              document   = composeTurnDocumentText(metadata);

        const {succeeded, failed} = await drainTurn(collection, 'turn-128', metadata);

        expect(failed).toEqual([]);
        expect(succeeded.map(record => record.id)).toEqual(['turn-128']);

        const stored = await collection.get({ids: ['turn-128'], include: ['documents', 'metadatas', 'embeddings']});

        expect(stored.documents).toEqual([null]);
        expect(Array.from(stored.embeddings[0])).toEqual([1, 0, 0]);
        expect(resolveTurnDocumentForRead({documents: stored.documents, metadata: stored.metadatas[0]})).toBe(document);

        expect((await collection.query({queryEmbeddings: [[1, 0, 0]], nResults: 1})).ids).toEqual([['turn-128']]);
        expect((await collection.get({whereDocument: {$contains: 'p128'}})).ids).toEqual([]);
    });

    test('a turn without a stored document survives the vector-JSONL restore round trip', async () => {
        const embeddingFunction = createEmbeddingFunction(),
              source            = await client.getOrCreateCollection({name: `${collectionName}-source`, embeddingFunction}),
              target            = await client.getOrCreateCollection({name: `${collectionName}-target`, embeddingFunction}),
              metadata          = {type: 'agent-interaction', prompt: 'pr', thought: 'tr', response: 'rr', sessionId: 'sr', timestamp: 2},
              root              = await fs.mkdtemp(path.join(os.tmpdir(), 'drain-restore-')),
              filePath          = path.join(root, 'memories.jsonl');

        try {
            await drainTurn(source, 'turn-r', metadata);

            const exported = await source.get({ids: ['turn-r'], include: ['embeddings', 'metadatas', 'documents']});

            await fs.writeFile(filePath, JSON.stringify({
                id       : exported.ids[0],
                embedding: Array.from(exported.embeddings[0]),
                metadata : exported.metadatas[0],
                document : exported.documents[0]
            }) + '\n');

            await importVectorJsonlToEmptyCollection({
                collection: target, filePath, expectedDimension: 3, expectedRowCount: 1,
                expectedFileFingerprint: await fingerprintRestoreSourceFile(filePath)
            });

            const restored = await target.get({ids: ['turn-r'], include: ['documents', 'metadatas']});

            expect(restored.documents).toEqual([null]);
            expect(resolveTurnDocumentForRead({documents: restored.documents, metadata: restored.metadatas[0]}))
                .toBe(composeTurnDocumentText(metadata));
            expect((await target.query({queryEmbeddings: [[1, 0, 0]], nResults: 1})).ids).toEqual([['turn-r']]);
        } finally {
            await fs.rm(root, {recursive: true, force: true});
        }
    });
});

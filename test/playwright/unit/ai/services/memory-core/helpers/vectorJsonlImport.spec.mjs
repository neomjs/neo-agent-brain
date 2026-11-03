import {test, expect}                                              from '@playwright/test';
import fs                                                          from 'node:fs/promises';
import os                                                          from 'node:os';
import path                                                        from 'node:path';
import {importVectorJsonlToEmptyCollection}                        from '../../../../../../../ai/services/memory-core/helpers/vectorJsonlImport.mjs';
import {admitRestoreTargetSetBundle, fingerprintRestoreSourceFile} from '../../../../../../../ai/services/memory-core/helpers/restoreTargetSetAdmission.mjs';

test('imports a turn stored without its document as a record set without documents (#128)', async () => {
    const root     = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-jsonl-import-'));
    const turn     = {type: 'agent-interaction', prompt: 'p', thought: 't', response: 'r'};
    const rows     = [
        {id: 's1', embedding: [0.5],  metadata: {type: 'summary'}, document: 'summary text'},
        {id: 't1', embedding: [0.25], metadata: turn,              document: null}
    ];
    const filePath = path.join(root, 'vectors.jsonl');

    try {
        await fs.writeFile(filePath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');

        const byId       = new Map();
        const adds       = [];
        const collection = {
            count: async () => byId.size,
            // chromadb 3.5.0 rejects a non-string entry in `documents` (`validateDocuments`).
            add  : async payload => {
                if (payload.documents?.some(document => typeof document !== 'string')) {
                    throw new Error('Expected each document to be a string');
                }
                adds.push(payload);
                payload.ids.forEach((id, i) => byId.set(id, {
                    embedding: payload.embeddings[i],
                    metadata : payload.metadatas[i],
                    document : payload.documents?.[i] ?? null
                }));
            },
            get: async ({ids}) => ({
                ids,
                embeddings: ids.map(id => byId.get(id).embedding),
                metadatas : ids.map(id => byId.get(id).metadata),
                documents : ids.map(id => byId.get(id).document)
            })
        };

        const result = await importVectorJsonlToEmptyCollection({
            collection, filePath, expectedDimension: 1, expectedRowCount: 2,
            expectedFileFingerprint: await fingerprintRestoreSourceFile(filePath)
        });

        expect(result.rowCount).toBe(2);
        expect(adds.map(payload => [payload.ids, 'documents' in payload])).toEqual([[['s1'], true], [['t1'], false]]);
    } finally {
        await fs.rm(root, {recursive: true, force: true});
    }
});

test('admits graph text and imports vector text containing both Unicode line separators', async () => {
    const root               = await fs.mkdtemp(path.join(os.tmpdir(), 'unicode-jsonl-import-'));
    const vector             = {id: 'v1', embedding: [0.5], metadata: {text: 'a\u2028b\u2029c'}, document: 'd\u2028e\u2029f'};
    const graph              = {type: 'node', data: {id: 'n1', properties: {text: vector.document}}};
    const filePath           = path.join(root, 'vectors.jsonl');
    const graphFile          = path.join(root, 'graph.jsonl');
    const bundleManifestPath = path.join(root, 'manifest.json');

    try {
        await fs.writeFile(filePath, JSON.stringify(vector) + '\n');
        await fs.writeFile(graphFile, JSON.stringify(graph) + '\n');
        await fs.writeFile(bundleManifestPath, '{}');
        const admitted = await admitRestoreTargetSetBundle({
            bundleManifestPath, memoriesFile: filePath, summariesFile: filePath,
            graphFile, expectedDimension: 1
        });
        expect(admitted.components.graph).toMatchObject({rowCount: 1, nodeCount: 1, edgeCount: 0});

        let stored;
        const collection = {
            count: async () => stored ? stored.ids.length : 0,
            add  : async payload => { stored = payload; },
            get  : async () => stored
        };
        const result = await importVectorJsonlToEmptyCollection({
            collection, filePath, expectedDimension: 1, expectedRowCount: 1,
            expectedFileFingerprint: await fingerprintRestoreSourceFile(filePath)
        });
        expect(result.rowCount).toBe(1);
        expect(stored.documents).toEqual([vector.document]);
        expect(stored.metadatas).toEqual([vector.metadata]);
    } finally {
        await fs.rm(root, {recursive: true, force: true});
    }
});

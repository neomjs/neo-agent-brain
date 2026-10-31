import {test, expect}                                              from '@playwright/test';
import fs                                                          from 'node:fs/promises';
import os                                                          from 'node:os';
import path                                                        from 'node:path';
import {importVectorJsonlToEmptyCollection}                        from '../../../../../../../ai/services/memory-core/helpers/vectorJsonlImport.mjs';
import {admitRestoreTargetSetBundle, fingerprintRestoreSourceFile} from '../../../../../../../ai/services/memory-core/helpers/restoreTargetSetAdmission.mjs';

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

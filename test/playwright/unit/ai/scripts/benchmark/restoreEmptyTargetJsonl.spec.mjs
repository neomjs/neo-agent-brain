import {test, expect} from '@playwright/test';
import fs             from 'node:fs/promises';
import os             from 'node:os';
import path           from 'node:path';
import {
    validateVectorFixture,
    validateGraphFixture,
    copyVectorFixtureInBatches
} from '../../../../../../ai/scripts/benchmark/restore-empty-target-meter.mjs';

test('validates and copies benchmark records without splitting Unicode text', async () => {
    const root      = await fs.mkdtemp(path.join(os.tmpdir(), 'unicode-jsonl-meter-'));
    const text      = 'a\u2028b\u2029c';
    const vector    = {id: 'v1', embedding: [0.5], document: text};
    const source    = path.join(root, 'vectors.jsonl');
    const graphFile = path.join(root, 'graph.jsonl');
    const target    = path.join(root, 'copy.jsonl');

    try {
        await fs.writeFile(source, JSON.stringify(vector) + '\n');
        await fs.writeFile(graphFile, JSON.stringify({type: 'node', data: {id: text}}) + '\n');
        expect(await validateVectorFixture({dimension: 1, expectedRows: 1, file: source})).toBe(1);
        expect(await validateGraphFixture({expectedEdges: 0, expectedNodes: 1, file: graphFile})).toEqual({edges: 0, nodes: 1});
        const batches = [];
        expect(await copyVectorFixtureInBatches({
            collection: 'memories', source, target,
            recorder  : {recordBatch: batch => batches.push(batch)}
        })).toBe(1);
        expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual(vector);
        expect(batches).toEqual([{collection: 'memories', size: 1}]);
    } finally {
        await fs.rm(root, {recursive: true, force: true});
    }
});

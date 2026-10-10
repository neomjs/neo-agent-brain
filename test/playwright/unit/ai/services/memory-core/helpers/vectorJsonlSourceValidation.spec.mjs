import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import fs             from 'fs';
import os             from 'os';
import path           from 'path';
import zlib           from 'zlib';

import {validateJsonlSourceFile} from '../../../../../../../ai/services/memory-core/helpers/vectorJsonlSourceValidation.mjs';

/**
 * @summary The replace-mode proof pass reads a bundle payload in either encoding and validates the
 * DECODED rows, so a wrong-dimension row inside a compressed file is refused before the truncate it
 * guards, exactly as a bare file's row would be.
 */
test.describe('ai/services/memory-core/helpers/vectorJsonlSourceValidation — payload encodings (#974)', () => {
    let tmpRoot;

    const rows = dimension => [
        JSON.stringify({id: 'a', embedding: new Array(dimension).fill(0.1), metadata: {}}),
        JSON.stringify({id: 'b', embedding: new Array(dimension).fill(0.2), metadata: {}})
    ];

    test.beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-jsonl-source-'));
    });

    test.afterEach(() => {
        fs.rmSync(tmpRoot, {recursive: true, force: true});
    });

    test('a bare .jsonl validates every row', async () => {
        const filePath = path.join(tmpRoot, 'rows.jsonl');

        fs.writeFileSync(filePath, rows(4).join('\n') + '\n');

        expect(await validateJsonlSourceFile({filePath, expectedDimension: 4})).toEqual({rowCount: 2});
    });

    test('a compressed .jsonl.br validates the decoded rows', async () => {
        const filePath = path.join(tmpRoot, 'rows.jsonl.br');

        fs.writeFileSync(filePath, zlib.brotliCompressSync(Buffer.from(rows(4).join('\n') + '\n')));

        expect(await validateJsonlSourceFile({filePath, expectedDimension: 4})).toEqual({rowCount: 2});
    });

    test('a wrong-dimension row inside a compressed payload is refused by line, like a bare one', async () => {
        const filePath = path.join(tmpRoot, 'rows.jsonl.br');
        const lines    = [rows(4)[0], JSON.stringify({id: 'short', embedding: [0.1], metadata: {}})];

        fs.writeFileSync(filePath, zlib.brotliCompressSync(Buffer.from(lines.join('\n') + '\n')));

        await expect(validateJsonlSourceFile({filePath, expectedDimension: 4})).rejects.toThrow(/\(line 2\): .*dimension/);
    });

    test('graph rows in a compressed payload are parse-checked only', async () => {
        const filePath = path.join(tmpRoot, 'graph-backup.jsonl.br');

        fs.writeFileSync(filePath, zlib.brotliCompressSync(Buffer.from('{"type":"node","data":{"id":"n1"}}\n{"type":"edge","data":{"id":"e1"}}\n')));

        expect(await validateJsonlSourceFile({filePath, expectedDimension: 4, vectorRows: false})).toEqual({rowCount: 2});
    });
});

import {test, expect} from '@playwright/test';
import fs             from 'fs';
import os             from 'os';
import path           from 'path';
import zlib           from 'zlib';

import {
    BUNDLE_EXPORT_ENCODING,
    BUNDLE_PAYLOAD_ENCODINGS,
    BUNDLE_PAYLOAD_EXTENSION,
    bundlePayloadEncoding,
    bundlePayloadFileName,
    closeBundlePayload,
    createBundlePayloadWriteStream,
    endBundlePayload,
    isBundlePayload,
    openBundlePayload
} from '../../../../../../ai/services/shared/bundlePayload.mjs';

/**
 * @summary The one place a bundle payload's encoding is decided, written and read back.
 *
 * Every exporter and every reader of a backup bundle goes through this module, so a bundle written
 * at the head and a bundle retained from before compression landed must both come back line for
 * line. These specs pin the extension vocabulary, the round trip per encoding, and the two failure
 * shapes a compressed payload adds: a torn file must reject rather than read as a shorter valid
 * one, and a missing file must reject rather than hang the reader.
 */
test.describe('ai/services/shared/bundlePayload — one encoding decision for every bundle reader and writer', () => {
    let tmpRoot;

    const rows      = ['{"id":"r-1","embedding":[0.1,0.2]}', '{"id":"r-2","embedding":[0.3,0.4]}', '{"id":"r-3","embedding":[0.5,0.6]}'];
    const text      = rows.join('\n') + '\n';
    const writeRows = async (filePath, lines = rows) => {
        const out = createBundlePayloadWriteStream(filePath);

        for (const line of lines) {
            out.write(line + '\n');
        }

        await endBundlePayload(out);
    };
    const readRows = async filePath => {
        const lines = [];

        for await (const line of openBundlePayload(filePath)) {
            if (line.trim()) lines.push(line);
        }

        return lines;
    };

    test.beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-payload-'));
    });

    test.afterEach(() => {
        fs.rmSync(tmpRoot, {recursive: true, force: true});
    });

    test('the extension decides the encoding, and nothing else is a payload', () => {
        expect(bundlePayloadEncoding('memory-backup-2026.jsonl')).toBe('jsonl');
        expect(bundlePayloadEncoding('memory-backup-2026.jsonl.br')).toBe('jsonl+br');
        expect(bundlePayloadEncoding('memory-backup-2026.jsonl.gz')).toBe('jsonl+gz');
        expect(bundlePayloadEncoding('/abs/dir/knowledge-base-backup-2026.jsonl.br')).toBe('jsonl+br');

        for (const notAPayload of ['bundle-meta.json', 'heal-attempts.json', 'rows.jsonl.tmp', 'rows.br', 'rows.jsonlbr', 'jsonl', '']) {
            expect(bundlePayloadEncoding(notAPayload), notAPayload).toBeNull();
            expect(isBundlePayload(notAPayload), notAPayload).toBe(false);
        }

        expect(isBundlePayload('x.jsonl')).toBe(true);
        expect(isBundlePayload('x.jsonl.br')).toBe(true);
        expect(Object.values(BUNDLE_PAYLOAD_ENCODINGS).sort()).toEqual(['jsonl', 'jsonl+br', 'jsonl+gz']);
    });

    test('an export is plain unless its caller asks; the daily bundle asks in one place', () => {
        expect(BUNDLE_PAYLOAD_EXTENSION).toBe('.jsonl.br');
        expect(BUNDLE_EXPORT_ENCODING).toBe('jsonl+br');
        // The default is the file every exporter consumer received before compression: the release uploader reads it.
        expect(bundlePayloadFileName('knowledge-base-backup', '2026-10-10T13-15-00.000Z')).toBe('knowledge-base-backup-2026-10-10T13-15-00.000Z.jsonl');
        expect(bundlePayloadFileName('memory-backup', '2026-10-10T13-15-00.000Z', BUNDLE_EXPORT_ENCODING)).toBe('memory-backup-2026-10-10T13-15-00.000Z.jsonl.br');
        expect(bundlePayloadEncoding(bundlePayloadFileName('graph-backup', 'ts', 'jsonl+gz'))).toBe('jsonl+gz');
        expect(() => bundlePayloadFileName('graph-backup', 'ts', 'zip')).toThrow(/not a bundle payload/);
    });

    for (const extension of Object.keys(BUNDLE_PAYLOAD_ENCODINGS)) {
        test(`round trip through ${extension}: what the writer ends is what the reader yields`, async () => {
            const filePath = path.join(tmpRoot, `rows${extension}`);

            await writeRows(filePath);

            expect(fs.statSync(filePath).size).toBeGreaterThan(0);
            expect(await readRows(filePath)).toEqual(rows);
        });
    }

    test('a plain .jsonl written through the helper is the bare text — old readers keep working', async () => {
        const filePath = path.join(tmpRoot, 'rows.jsonl');

        await writeRows(filePath);

        expect(fs.readFileSync(filePath, 'utf8')).toBe(text);
    });

    test('the brotli bytes are on disk when end() calls back — a receipt written after it describes a complete file', async () => {
        const filePath = path.join(tmpRoot, 'rows.jsonl.br');

        await writeRows(filePath);

        expect(zlib.brotliDecompressSync(fs.readFileSync(filePath)).toString('utf8')).toBe(text);
    });

    test('a payload of embedding floats compresses to well under half its text size — the lever the ticket measured', async () => {
        const filePath = path.join(tmpRoot, 'vectors.jsonl.br');
        const vectors  = Array.from({length: 200}, (_, i) =>
            JSON.stringify({id: `row-${i}`, embedding: Array.from({length: 256}, (_, k) => Math.sin(i * 0.37 + k * 0.11))})
        );

        await writeRows(filePath, vectors);

        const plainBytes = Buffer.byteLength(vectors.join('\n') + '\n');

        expect(fs.statSync(filePath).size).toBeLessThan(plainBytes / 2);
        expect(await readRows(filePath)).toEqual(vectors);
    });

    test('a torn compressed payload rejects the reader — it never reads as a shorter valid file', async () => {
        const filePath = path.join(tmpRoot, 'torn.jsonl.br');
        const complete = zlib.brotliCompressSync(Buffer.from(Array.from({length: 500}, (_, i) => `{"id":${i}}`).join('\n') + '\n'));

        fs.writeFileSync(filePath, complete.subarray(0, 40));

        await expect(readRows(filePath)).rejects.toThrow(/Z_BUF_ERROR|unexpected end/i);
    });

    test('bytes that are not brotli under a .br name reject the reader', async () => {
        const filePath = path.join(tmpRoot, 'mislabelled.jsonl.br');

        fs.writeFileSync(filePath, text);

        await expect(readRows(filePath)).rejects.toThrow();
    });

    test('a reader closed after leaving its loop early releases the file, and no error escapes — the abort is the close', async () => {
        const filePath = path.join(tmpRoot, 'early-exit.jsonl.br');
        const many     = Array.from({length: 5000}, (_, i) => JSON.stringify({id: `row-${i}`, embedding: Array.from({length: 64}, k => Math.sin(i + k))}));

        await writeRows(filePath, many);

        const rl = openBundlePayload(filePath);

        for await (const line of rl) {
            expect(line).toBe(many[0]);
            break;
        }

        closeBundlePayload(rl);

        // A destroy-time AbortError on the composed stream surfaces as an uncaught exception on a
        // later tick, which fails whichever test is running by then; the wait keeps it on this one.
        await new Promise(resolve => setTimeout(resolve, 25));

        expect(rl.input.destroyed).toBe(true);
    });

    test('a missing payload rejects with ENOENT instead of hanging the reader', async () => {
        for (const extension of Object.keys(BUNDLE_PAYLOAD_ENCODINGS)) {
            await expect(readRows(path.join(tmpRoot, `missing${extension}`)), extension).rejects.toMatchObject({code: 'ENOENT'});
        }
    });

    test('a writer whose directory does not exist rejects at end() instead of reporting success', async () => {
        await expect(writeRows(path.join(tmpRoot, 'no-such-dir', 'rows.jsonl.br'))).rejects.toMatchObject({code: 'ENOENT'});
    });

    test('an extension that is not a payload is refused by both sides before any byte moves', () => {
        expect(() => createBundlePayloadWriteStream(path.join(tmpRoot, 'rows.json'))).toThrow(/not a bundle payload/);
        expect(() => openBundlePayload(path.join(tmpRoot, 'rows.json'))).toThrow(/not a bundle payload/);
        expect(fs.existsSync(path.join(tmpRoot, 'rows.json'))).toBe(false);
    });
});

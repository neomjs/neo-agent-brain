// fs-extra, not node:fs, so the services' existing stream seams keep working: the KB import spec
// swaps `fsExtra.createReadStream` for a gated fixture to prove a batch flushes before EOF.
import fs         from 'fs-extra';
import path       from 'path';
import readline   from 'readline';
import {compose}  from 'stream';
import {finished} from 'stream/promises';
import zlib       from 'zlib';

/**
 * @summary The one encoding decision for every backup-bundle payload: written here, read here.
 *
 * A bundle row is one JSON line whose `embedding` is 4,096 floats serialised as decimal text, 72%
 * of the bytes, and the local plane's daily bundle reached 9.7 GB with nothing in the lane
 * compressing. Whole-stream brotli at quality 4 measured 2.8× on real rows for about 100 s of CPU
 * on a 9 GB export: the lossless lever. A binary float encoding is a separate step that changes
 * what a reader hands to the vector store, and is not taken here.
 *
 * **The extension is the contract.** Readers detect the encoding by file name, never by a flag or
 * by `bundle-meta.json`, so a bundle retained from before compression landed (`.jsonl`) and one
 * written at the head (`.jsonl.br`) go through the same code path and come back line for line; the
 * meta's `payloadEncoding` is a receipt, not an input. Nothing is a payload unless its name ends in
 * one of the {@link BUNDLE_PAYLOAD_ENCODINGS} keys, so `bundle-meta.json`, `heal-attempts.json` and
 * a writer's scratch file never enter a row count.
 *
 * **Why `stream.compose` on both sides.** A bare `fs.createReadStream(...).pipe(decompressor)` does
 * not forward the file stream's errors: a missing payload crashes the process with an unhandled
 * `'error'` while the reader waits for lines that never come. `compose` forwards every member's
 * error to the one stream the reader holds, so a missing file rejects with `ENOENT`, a torn
 * compressed file with `Z_BUF_ERROR`, and bytes that are not brotli under a `.br` name with a
 * format error. A torn bundle therefore fails the restore probe loudly instead of reading as a
 * shorter valid one. On the write side, `compose(compressor, fileStream)` makes `end()`'s callback
 * wait for the FILE to finish and close, so a receipt written after it describes bytes on disk.
 *
 * @module ai/services/shared/bundlePayload
 */

/**
 * @summary Payload file extension → the `payloadEncoding` token a bundle receipt records for it.
 *
 * `.jsonl` is what every bundle before compression holds and what the flat copies (`concepts/`,
 * `trajectories/`, `mailbox/`, `ledgers/`) keep: those are verbatim copies of live files that
 * restore copies back verbatim, under 1% of the bytes. `.jsonl.gz` is read, never written: it lets
 * an operator hand-compress a legacy bundle with the tool at hand.
 * @type {Object<String, String>}
 */
export const BUNDLE_PAYLOAD_ENCODINGS = Object.freeze({
    '.jsonl'   : 'jsonl',
    '.jsonl.br': 'jsonl+br',
    '.jsonl.gz': 'jsonl+gz'
});

/**
 * @summary The extension every exported payload (kb, mc, graph) is written with at the head.
 * @type {String}
 */
export const BUNDLE_PAYLOAD_EXTENSION = '.jsonl.br';

/**
 * @summary Brotli quality for exports. Measured on today's rows: quality 4 gives 2.8× at 2.3 s per
 * 200 MB; higher qualities gain little and land their CPU inside the heavy-maintenance lease.
 * @type {Number}
 */
export const BUNDLE_PAYLOAD_BROTLI_QUALITY = 4;

// Longest suffix first, so `x.jsonl.br` is classified by `.jsonl.br` and never as `.jsonl` plus junk.
const EXTENSIONS_LONGEST_FIRST = Object.keys(BUNDLE_PAYLOAD_ENCODINGS).sort((a, b) => b.length - a.length);

/**
 * @summary Classifies a file name or path by its payload extension.
 * @param {String} name A file name or path.
 * @returns {String|null} The encoding token, or `null` when the name is not a bundle payload.
 */
export function bundlePayloadEncoding(name) {
    if (typeof name !== 'string') {
        return null;
    }

    const base = path.basename(name);

    for (const extension of EXTENSIONS_LONGEST_FIRST) {
        if (base.length > extension.length && base.endsWith(extension)) {
            return BUNDLE_PAYLOAD_ENCODINGS[extension];
        }
    }

    return null
}

/**
 * @summary Whether a directory entry is a bundle payload in any supported encoding.
 * Replaces every `name.endsWith('.jsonl')` filter a bundle reader used to carry.
 * @param {String} name A file name or path.
 * @returns {Boolean}
 */
export function isBundlePayload(name) {
    return bundlePayloadEncoding(name) !== null
}

/**
 * @summary Names a new export payload: `<prefix>-<timestamp><BUNDLE_PAYLOAD_EXTENSION>`.
 * @param {String} prefix The exporter's file prefix, e.g. `memory-backup`.
 * @param {String} timestamp The bundle's file-safe ISO timestamp.
 * @returns {String}
 */
export function bundlePayloadFileName(prefix, timestamp) {
    return `${prefix}-${timestamp}${BUNDLE_PAYLOAD_EXTENSION}`
}

/**
 * @param {String} filePath
 * @returns {Error} Coded `BUNDLE_PAYLOAD_EXTENSION`, thrown before any byte moves.
 */
function notABundlePayload(filePath) {
    const error = new Error(`not a bundle payload: ${filePath} (expected one of ${Object.keys(BUNDLE_PAYLOAD_ENCODINGS).join(', ')})`);

    error.code = 'BUNDLE_PAYLOAD_EXTENSION';

    return error
}

/**
 * @summary Opens a payload as a decoded readable stream, decompressing by extension.
 * @param {String} filePath Absolute path of a `.jsonl`, `.jsonl.br` or `.jsonl.gz` payload.
 * @returns {import('stream').Readable} Rejects (through its consumer) with `ENOENT` for a missing
 *     file and with the decompressor's error for a torn or mislabelled one.
 * @throws {Error} `BUNDLE_PAYLOAD_EXTENSION` when the name is not a payload.
 */
export function createBundlePayloadReadStream(filePath) {
    switch (bundlePayloadEncoding(filePath)) {
        case 'jsonl':
            return fs.createReadStream(filePath, {encoding: 'utf8'});
        case 'jsonl+br':
            return compose(fs.createReadStream(filePath), zlib.createBrotliDecompress());
        case 'jsonl+gz':
            return compose(fs.createReadStream(filePath), zlib.createGunzip());
        default:
            throw notABundlePayload(filePath);
    }
}

/**
 * @summary Opens a payload as a line stream: `for await (const line of openBundlePayload(p))`.
 * Each JSONL record is one line, so the non-empty line count is the row count whatever the
 * encoding. A torn or missing file rejects the loop; it never ends early with fewer lines.
 * @param {String} filePath Absolute path of a payload in any supported encoding.
 * @returns {readline.Interface}
 * @throws {Error} `BUNDLE_PAYLOAD_EXTENSION` when the name is not a payload.
 */
export function openBundlePayload(filePath) {
    return readline.createInterface({
        input    : createBundlePayloadReadStream(filePath),
        crlfDelay: Infinity
    })
}

/**
 * @summary Closes a reader from {@link openBundlePayload} and releases its file, whether the loop
 * ran to the end or left early on a refused row.
 *
 * A composed reader destroyed before its own close reports that destroy as an `AbortError` on the
 * stream. The bare `rl.close(); rl.input.destroy()` the readers used to carry was silent on a plain
 * file stream and, on a compressed one, crashed the process a tick later with an unhandled
 * `'error'` — in whichever caller's turn it was by then. Every read error has already rejected the
 * loop by the time a consumer closes, so an error after the close is the close.
 * @param {readline.Interface} rl A reader from {@link openBundlePayload}.
 */
export function closeBundlePayload(rl) {
    const {input} = rl;

    rl.close();

    if (!input.destroyed) {
        input.on('error', () => {});
        input.destroy();
    }
}

/**
 * @summary Opens a payload for writing, compressing by extension. Pair with {@link endBundlePayload}.
 * @param {String} filePath Absolute path ending in a {@link BUNDLE_PAYLOAD_ENCODINGS} key.
 * @returns {import('stream').Writable} For a compressed extension, a stream whose `end()` callback
 *     waits for the file to finish and close.
 * @throws {Error} `BUNDLE_PAYLOAD_EXTENSION` when the name is not a payload.
 */
export function createBundlePayloadWriteStream(filePath) {
    switch (bundlePayloadEncoding(filePath)) {
        case 'jsonl':
            return fs.createWriteStream(filePath);
        case 'jsonl+br':
            return compose(
                zlib.createBrotliCompress({params: {[zlib.constants.BROTLI_PARAM_QUALITY]: BUNDLE_PAYLOAD_BROTLI_QUALITY}}),
                fs.createWriteStream(filePath)
            );
        case 'jsonl+gz':
            return compose(zlib.createGzip(), fs.createWriteStream(filePath));
        default:
            throw notABundlePayload(filePath);
    }
}

/**
 * @summary Ends a payload writer and resolves once its bytes are on disk, rejecting on any error.
 *
 * Settled through `stream/promises`' `finished`, which waits for `'close'`, because the composed
 * writer emits `'finish'` and calls `end()`'s callback with no error BEFORE a deferred file-open
 * error (a missing directory) surfaces. The bare `new Promise(resolve => stream.end(resolve))` the
 * exporters used to carry resolved on that, so a failed export could still return a receipt.
 * @param {import('stream').Writable} stream A stream from {@link createBundlePayloadWriteStream}.
 * @returns {Promise<void>}
 */
export async function endBundlePayload(stream) {
    const settled = finished(stream);

    stream.end();

    await settled
}

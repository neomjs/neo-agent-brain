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
 * **One stream per side, every error on it.** A bare `fs.createReadStream(...).pipe(decompressor)`
 * does not forward the file stream's errors: a missing payload crashes the process with an unhandled
 * `'error'` while the reader waits for lines that never come. The reader therefore holds the
 * decompressor alone, with the file's errors forwarded onto it and the file closed when it closes,
 * so a missing file rejects with `ENOENT`, a torn compressed file with `Z_BUF_ERROR`, and bytes that
 * are not brotli under a `.br` name with a format error. A torn bundle therefore fails the restore
 * probe loudly instead of reading as a shorter valid one. On the write side the composed writer's
 * `end()` callback fires on `'finish'`, before a deferred file error can surface, so the completion
 * and error boundary is {@link endBundlePayload}: a receipt written after it awaits describes bytes
 * on disk, or never gets written.
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
 * @summary The extension the daily bundle's exported payloads (kb, mc, graph) are written with.
 *
 * The bundle orchestrator asks for it; the exporters themselves default to plain `.jsonl`, because
 * the same export SDK serves the Knowledge Base release artifact, whose staging selector and
 * packer consume plain JSONL and refuse anything else.
 * @type {String}
 */
export const BUNDLE_PAYLOAD_EXTENSION = '.jsonl.br';

/**
 * @summary The `payloadEncoding` token the daily bundle passes to every exporter.
 * @type {String}
 */
export const BUNDLE_EXPORT_ENCODING = BUNDLE_PAYLOAD_ENCODINGS[BUNDLE_PAYLOAD_EXTENSION];

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
 * @summary Names a new export payload: `<prefix>-<timestamp>` plus the extension of its encoding.
 * @param {String} prefix The exporter's file prefix, e.g. `memory-backup`.
 * @param {String} timestamp The bundle's file-safe ISO timestamp.
 * @param {String} [encoding='jsonl'] A {@link BUNDLE_PAYLOAD_ENCODINGS} token; plain JSONL unless
 *     the caller asks, so an exporter's existing consumers keep the file they always received.
 * @returns {String}
 * @throws {Error} `BUNDLE_PAYLOAD_EXTENSION` when the token is not an encoding.
 */
export function bundlePayloadFileName(prefix, timestamp, encoding = 'jsonl') {
    const extension = Object.keys(BUNDLE_PAYLOAD_ENCODINGS).find(key => BUNDLE_PAYLOAD_ENCODINGS[key] === encoding);

    if (!extension) {
        throw notABundlePayload(`${prefix}-${timestamp} (encoding ${encoding})`);
    }

    return `${prefix}-${timestamp}${extension}`
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
            return decodeThrough(filePath, zlib.createBrotliDecompress());
        case 'jsonl+gz':
            return decodeThrough(filePath, zlib.createGunzip());
        default:
            throw notABundlePayload(filePath);
    }
}

/**
 * @summary Pipes a file into a decompressor and hands back the decompressor as the one stream a
 * reader holds, with the file's errors forwarded onto it.
 *
 * `stream.compose` was the first shape here. Under the test runner on Node 24 the composed duplex
 * surfaced a torn file's `Z_BUF_ERROR` a second time, after the reader's loop had already rejected
 * with it, as an uncaught error on a later tick; a plain pipe with one forwarded error has one
 * emission, which readline turns into the loop's rejection.
 * @param {String} filePath
 * @param {import('stream').Transform} decompressor
 * @returns {import('stream').Transform}
 */
function decodeThrough(filePath, decompressor) {
    const file = fs.createReadStream(filePath);

    file.on('error', error => decompressor.destroy(error));
    // A reader that leaves early destroys the decompressor; the file descriptor goes with it.
    decompressor.on('close', () => file.destroy());

    return file.pipe(decompressor)
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
 * The readers used to carry a bare `rl.close(); rl.input.destroy()`, silent on a plain file stream
 * and, on the composed reader this module first shipped, an unhandled `AbortError` a tick later in
 * whichever caller's turn it was by then. The close lives here so no reader reasons about what its
 * input is. Every read error has already rejected the loop by the time a consumer closes, so an
 * error after the close is the close.
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
 * @returns {import('stream').Writable} A stream to write lines to. Its `end()` callback is not the
 *     completion boundary: await {@link endBundlePayload}, which settles on `'close'` and rejects
 *     on any error, including a file that could not be opened.
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

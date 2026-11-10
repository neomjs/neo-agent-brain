import fs              from 'node:fs';
import {createRequire} from 'node:module';

/**
 * @module ai/services/fleet/inspectAppBundle
 * @summary Physical reads of a packaged vendor app bundle for the Fleet's static capability probes
 * (`manageCodexDesktopRuntime.mjs`, `probeClaudeDesktopRuntime.mjs`): the files a probe resolves and checks,
 * and the markers it requires them to carry. A probe pins the contracts a seat depends on, never a version.
 */

/** Electron virtualizes ASAR paths; bundle inspection needs their physical bytes. */
export const bundleFs = process.versions.electron ? createRequire(import.meta.url)('original-fs') : fs;

/**
 * @summary Memory-bounded single-pass scan of one file for required markers, with an optional bounded-window
 * predicate. A tail preserves marker and window matches split across 1 MiB chunk boundaries, and the scan
 * stops as soon as every marker and one window match are found.
 * @param {String} file Absolute path of the file to scan.
 * @param {String[]} markers Byte strings that must each occur.
 * @param {Object} fsImpl Physical fs reader, normally {@link bundleFs}.
 * @param {Object} [options]
 * @param {String|null} [options.windowMarker=null] The marker whose surrounding bytes `windowPredicate` judges.
 * @param {Number} [options.windowRadius=0] Bytes taken on each side of `windowMarker`.
 * @param {Function|null} [options.windowPredicate=null] `(windowText) => Boolean`.
 * @returns {{missing: String[], windowMatched: Boolean}} `windowMatched` is `true` when no window was asked for.
 */
export function scanBundleMarkers(file, markers, fsImpl, {windowMarker = null, windowRadius = 0, windowPredicate = null} = {}) {
    const
        pending          = new Map(markers.map(marker => [marker, Buffer.from(marker)])),
        windowMarkerBuf  = windowMarker ? Buffer.from(windowMarker) : null,
        found            = new Set(),
        chunk            = Buffer.allocUnsafe(1024 * 1024),
        maxMarkerLen     = Math.max(...[...pending.values()].map(marker => marker.length), 1),
        windowTailLength = windowMarkerBuf ? (2 * windowRadius) + windowMarkerBuf.length - 1 : 0,
        tailSize         = Math.max(maxMarkerLen - 1, windowTailLength),
        descriptor       = fsImpl.openSync(file, 'r');

    let tail          = Buffer.alloc(0),
        position      = 0,
        windowMatched = !windowMarkerBuf;

    try {
        while (pending.size || !windowMatched) {
            const bytesRead = fsImpl.readSync(descriptor, chunk, 0, chunk.length, position);
            if (!bytesRead) break;

            position += bytesRead;

            const haystack = Buffer.concat([tail, chunk.subarray(0, bytesRead)]);

            for (const [text, marker] of pending) {
                if (haystack.indexOf(marker) !== -1) {
                    found.add(text);
                    pending.delete(text);
                }
            }

            if (!windowMatched) {
                for (
                    let offset = haystack.indexOf(windowMarkerBuf);
                    offset !== -1;
                    offset = haystack.indexOf(windowMarkerBuf, offset + 1)
                ) {
                    const
                        windowStart = Math.max(0, offset - windowRadius),
                        windowEnd   = Math.min(haystack.length, offset + windowMarkerBuf.length + windowRadius),
                        windowText  = haystack.subarray(windowStart, windowEnd).toString('utf8');

                    if (windowPredicate(windowText)) {
                        windowMatched = true;
                        break;
                    }
                }
            }

            tail = tailSize ? haystack.subarray(Math.max(0, haystack.length - tailSize)) : Buffer.alloc(0);
        }
    } finally {
        fsImpl.closeSync(descriptor);
    }

    return {
        missing: markers.filter(marker => !found.has(marker)),
        windowMatched
    };
}

/**
 * @summary Throws unless `file` is a regular file this process can read.
 * @param {Object} fsImpl
 * @param {String} file
 */
export function assertReadableFile(fsImpl, file) {
    if (!fsImpl.statSync(file).isFile()) throw new Error('not a file');
    fsImpl.accessSync(file, fs.constants.R_OK);
}

/**
 * @summary Throws unless `file` is a regular file this process can execute.
 * @param {Object} fsImpl
 * @param {String} file
 */
export function assertExecutableFile(fsImpl, file) {
    if (!fsImpl.statSync(file).isFile()) throw new Error('not a file');
    fsImpl.accessSync(file, fs.constants.X_OK);
}

/**
 * @summary The physical path of `file`, every symlink resolved.
 * @param {Object} fsImpl
 * @param {String} file
 * @returns {String}
 */
export function physicalRealpath(fsImpl, file) {
    return (fsImpl.realpathSync.native ?? fsImpl.realpathSync)(file);
}

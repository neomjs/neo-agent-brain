import {execFile}            from 'node:child_process';
import fs                    from 'node:fs';
import path                  from 'node:path';
import {promisify}           from 'node:util';
import {writeFileAtomicSync} from '../shared/atomicFileWrite.mjs';

/**
 * @module ai/services/fleet/seatWindowRect
 * @summary A managed GUI seat's window rectangle, kept by the Fleet across stop and start. Two of the
 * three GUI harness families do not persist their own main window where the Fleet's stop lets them
 * (Codex Desktop writes its bounds only at a quit the SIGTERM→SIGKILL stop never completes; Antigravity
 * writes none), so the lifecycle captures the rectangle by pid before it signals a stop and puts it back
 * once the next start has a window. The host reads and sets a window through one System Events query
 * each, addressed by unix id — the address and grant the wake adapter's dialog gate already uses;
 * nothing is written into a vendor's own state files. When macOS TCC denies Accessibility (`-25211`),
 * `readSeatWindowRect`, `placeSeatWindow`, and `waitForSeatWindowRect` return `{refused: true, reason}`
 * immediately without polling. Every host effect is injectable for hermetic unit specs.
 */

/** @summary The Fleet-owned record beside the seat lease in the harness home. */
export const SEAT_WINDOW_FILE = '.neo-fleet-window.json';

/** @summary The record's schema version. */
export const SEAT_WINDOW_RECORD_VERSION = 1;

/** @summary Reason recorded when macOS TCC / System Events denies `osascript` assistive access (`-25211`). */
export const ASSISTIVE_ACCESS_REFUSAL_REASON = 'osascript is not allowed assistive access (-25211)';

const
    ASSISTIVE_ACCESS_DENIED_RE = /not allowed assistive access|not authorized to send apple events|\(-25211\)|\(-1743\)|\(-10004\)/i,
    RECT_KEYS                  = ['x', 'y', 'width', 'height'],
    execFileAsync              = promisify(execFile);

/**
 * @summary Whether a value is a usable window rectangle: four finite numbers and a positive size.
 * @param {*} rect
 * @returns {Boolean}
 */
export function isWindowRect(rect) {
    return Boolean(rect) && typeof rect === 'object' && RECT_KEYS.every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0
}

/**
 * @summary Whether a value is an explicit host window-access refusal (`{refused: true, reason}`).
 * @param {*} value
 * @returns {Boolean}
 */
export function isWindowRefusal(value) {
    return Boolean(value) && typeof value === 'object' && value.refused === true && typeof value.reason === 'string' && value.reason.length > 0
}

/**
 * @summary Whether an `osascript` error reflects a deterministic macOS Accessibility / AppleEvents denial
 * (`-25211`, `-1743`, `-10004`, `not allowed assistive access`) rather than a missing window (`-1719`).
 * @param {*} error
 * @returns {Boolean}
 */
export function isAssistiveAccessError(error) {
    return ASSISTIVE_ACCESS_DENIED_RE.test(`${error?.message ?? ''}\n${error?.stderr ?? ''}`)
}

/**
 * @summary Maps a deterministic macOS Accessibility denial to `{refused: true, reason}`, or `null` otherwise.
 * @param {*} error
 * @returns {{refused: Boolean, reason: String}|null}
 */
export function assistiveAccessRefusal(error) {
    return isAssistiveAccessError(error) ? {refused: true, reason: ASSISTIVE_ACCESS_REFUSAL_REASON} : null
}

/**
 * @summary Whether two rectangles name the same window frame, to the point (the host answers whole points).
 * @param {Object} a
 * @param {Object} b
 * @returns {Boolean}
 */
export function sameWindowRect(a, b) {
    return isWindowRect(a) && isWindowRect(b) && RECT_KEYS.every(key => Math.round(a[key]) === Math.round(b[key]))
}

/**
 * @summary The `osascript` argv that reads the front window's position and size of the process with the
 * unix id: one read-only System Events query, answered as four comma-separated integers.
 * @param {Number} pid
 * @returns {String[]}
 */
export function readWindowRectArgs(pid) {
    return [
        '-e', 'tell application "System Events"',
        '-e', `  tell (first process whose unix id is ${assertPid(pid)})`,
        '-e', '    set {x, y} to position of window 1',
        '-e', '    set {w, h} to size of window 1',
        '-e', '  end tell',
        '-e', 'end tell',
        '-e', 'return (x as text) & "," & (y as text) & "," & (w as text) & "," & (h as text)'
    ]
}

/**
 * @summary The `osascript` argv that moves and sizes the front window of the process with the unix id.
 * @param {Number} pid
 * @param {Object} rect
 * @returns {String[]}
 */
export function placeWindowRectArgs(pid, rect) {
    const {x, y, width, height} = roundRect(rect);

    return [
        '-e', 'tell application "System Events"',
        '-e', `  tell (first process whose unix id is ${assertPid(pid)})`,
        '-e', `    set position of window 1 to {${x}, ${y}}`,
        '-e', `    set size of window 1 to {${width}, ${height}}`,
        '-e', '  end tell',
        '-e', 'end tell'
    ]
}

/**
 * @summary Parses the answer to {@link readWindowRectArgs}.
 * @param {String} stdout
 * @returns {Object|null} `{x, y, width, height}`, or `null` for anything that is not four finite numbers with a positive size.
 */
export function parseWindowRect(stdout) {
    const parts = String(stdout ?? '').trim().split(',').map(part => Number(part.trim()));

    if (parts.length !== 4 || parts.some(part => !Number.isFinite(part))) return null;

    const rect = {x: parts[0], y: parts[1], width: parts[2], height: parts[3]};

    return isWindowRect(rect) ? rect : null
}

/**
 * @summary Reads a seat window's rectangle by pid. `null` when the process has no window yet (`-1719`) or the
 * platform has no adapter; `{refused: true, reason}` when macOS denies Accessibility (`-25211`); never throws.
 * @param {Number} pid
 * @param {Object} [options]
 * @param {Function} [options.execFileFn] `(file, args, options) => Promise<{stdout}>`; defaults to `execFile`.
 * @param {String} [options.platform=process.platform]
 * @param {Number} [options.timeoutMs=3000]
 * @returns {Promise<Object|null>}
 */
export async function readSeatWindowRect(pid, {execFileFn = execFileAsync, platform = process.platform, timeoutMs = 3000} = {}) {
    if (platform !== 'darwin') return null;

    try {
        const {stdout} = await execFileFn('osascript', readWindowRectArgs(pid), {timeout: timeoutMs});

        return parseWindowRect(stdout)
    } catch (error) {
        return assistiveAccessRefusal(error)
    }
}

/**
 * @summary Places a seat window by pid and reads the frame back. The read-back is the proof: the OS may clamp
 * or refuse the frame (a display no longer attached), and only the observed rectangle or TCC refusal is reported.
 * @param {Number} pid
 * @param {Object} rect
 * @param {Object} [options] As {@link readSeatWindowRect}.
 * @returns {Promise<Object|null>} The observed rectangle after the move, `{refused: true, reason}`, or `null`.
 */
export async function placeSeatWindow(pid, rect, {execFileFn = execFileAsync, platform = process.platform, timeoutMs = 3000} = {}) {
    if (platform !== 'darwin' || !isWindowRect(rect)) return null;

    try {
        await execFileFn('osascript', placeWindowRectArgs(pid, rect), {timeout: timeoutMs})
    } catch (error) {
        return assistiveAccessRefusal(error)
    }

    return readSeatWindowRect(pid, {execFileFn, platform, timeoutMs})
}

/**
 * @summary Waits for the process's first window and answers its rectangle, polling the reader unless macOS
 * denies Accessibility (`-25211`), which short-circuits immediately on the first denied attempt.
 * @param {Number} pid
 * @param {Object} options
 * @param {Function} options.readFn `(pid) => Promise<Object|null>`.
 * @param {Number} [options.timeoutMs=20000]
 * @param {Number} [options.pollMs=500]
 * @param {Function} [options.now=Date.now]
 * @param {Function} [options.sleep] `(ms) => Promise`; defaults to a timer.
 * @returns {Promise<Object|null>} Observed rectangle, `{refused: true, reason}`, or `null` on timeout.
 */
export async function waitForSeatWindowRect(pid, {readFn, timeoutMs = 20000, pollMs = 500, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
    const deadline = now() + timeoutMs;

    for (;;) {
        let rect;

        try {
            rect = await readFn(pid)
        } catch (error) {
            const refusal = assistiveAccessRefusal(error);
            if (refusal) return refusal;
            throw error
        }

        if (isWindowRect(rect) || isWindowRefusal(rect)) return rect;
        if (now() >= deadline) return null;

        await sleep(pollMs)
    }
}

/**
 * @summary The record's path in a harness home.
 * @param {String} instanceHome
 * @returns {String}
 */
export function seatWindowRecordPath(instanceHome) {
    return path.join(instanceHome, SEAT_WINDOW_FILE)
}

/**
 * @summary Reads the seat's window record. `null` when it is absent or not a valid record; never throws.
 * @param {String} instanceHome
 * @returns {Object|null} `{version, agentId, harnessType, rect, capturedAt}`.
 */
export function readSeatWindowRecord(instanceHome) {
    try {
        const parsed = JSON.parse(fs.readFileSync(seatWindowRecordPath(instanceHome), 'utf8'));

        return parsed?.version === SEAT_WINDOW_RECORD_VERSION && isWindowRect(parsed.rect) ? parsed : null
    } catch {
        return null
    }
}

/**
 * @summary Writes the seat's window record atomically (mode 0600, fsynced), replacing any previous one.
 * @param {Object} options
 * @param {String} options.instanceHome
 * @param {String} options.agentId
 * @param {String} options.harnessType
 * @param {Object} options.rect
 * @param {String} [options.capturedAt] ISO time; defaults to now.
 * @returns {String|null} Why it could not be written, or `null` once it is on disk.
 */
export function writeSeatWindowRecord({instanceHome, agentId, harnessType, rect, capturedAt = new Date().toISOString()}) {
    if (!isWindowRect(rect)) return 'the rectangle is not usable';

    try {
        writeFileAtomicSync(seatWindowRecordPath(instanceHome), JSON.stringify({
            version: SEAT_WINDOW_RECORD_VERSION,
            agentId,
            harnessType,
            rect   : roundRect(rect),
            capturedAt
        }, null, 4), {mode: 0o600, fsync: true});

        return null
    } catch (error) {
        return error?.message ?? String(error)
    }
}

/**
 * @param {Object} rect
 * @returns {Object} The rectangle in whole points.
 * @private
 */
function roundRect(rect) {
    return Object.fromEntries(RECT_KEYS.map(key => [key, Math.round(rect[key])]))
}

/**
 * @param {*} pid
 * @returns {Number}
 * @private
 */
function assertPid(pid) {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`seatWindowRect: a positive integer pid is required, received '${pid}'.`);

    return pid
}

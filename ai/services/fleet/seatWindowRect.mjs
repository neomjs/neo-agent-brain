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
 * once the next start has a window. Window bounds are read without macOS TCC via CoreGraphics
 * (`CGWindowListCopyWindowInfo`), and placed first via the seat profile's loopback `DevToolsActivePort`
 * CDP endpoint (`Browser.grantPermissions` `windowManagement` + `Runtime.evaluate`) before falling back
 * to `System Events`. When macOS TCC or System Events denies fallback access (`-25211`, `-1743`, `-10004`),
 * `readSeatWindowRect`, `placeSeatWindow`, and `waitForSeatWindowRect` return `{refused: true, reason}`
 * immediately without polling. Every host effect is injectable for hermetic unit specs.
 */

/** @summary The Fleet-owned record beside the seat lease in the harness home. */
export const SEAT_WINDOW_FILE = '.neo-fleet-window.json';

/** @summary Chrome/Electron profile file announcing the loopback DevTools WebSocket endpoint. */
export const DEVTOOLS_ACTIVE_PORT_FILE = 'DevToolsActivePort';

/** @summary The record's schema version. */
export const SEAT_WINDOW_RECORD_VERSION = 1;

/** @summary Reason recorded when macOS TCC / System Events denies `osascript` assistive access (`-25211`). */
export const ASSISTIVE_ACCESS_REFUSAL_REASON = 'osascript is not allowed assistive access (-25211)';

/** @summary Reason recorded when macOS TCC denies `osascript` Automation of System Events (`-1743`). */
export const AUTOMATION_ACCESS_REFUSAL_REASON = 'osascript is not authorized to send Apple events to System Events (-1743)';

/** @summary Reason recorded when System Events reports an AppleEvents privilege violation (`-10004`). */
export const PRIVILEGE_VIOLATION_REFUSAL_REASON = 'osascript privilege violation querying System Events (-10004)';

const
    ASSISTIVE_ACCESS_RE    = /not allowed assistive access|\(-25211\)/i,
    AUTOMATION_ACCESS_RE   = /not authorized to send apple events|\(-1743\)/i,
    PRIVILEGE_VIOLATION_RE = /\(-10004\)/,
    RECT_KEYS              = ['x', 'y', 'width', 'height'],
    execFileAsync          = promisify(execFile);

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
 * @summary Maps a deterministic macOS Accessibility / AppleEvents denial (`-25211`, `-1743`, `-10004`) to
 * `{refused: true, reason}` with the matched class's code preserved, or `null` otherwise.
 * @param {*} error
 * @returns {{refused: Boolean, reason: String}|null}
 */
export function assistiveAccessRefusal(error) {
    const text = `${error?.message ?? ''}\n${error?.stderr ?? ''}`;

    if (ASSISTIVE_ACCESS_RE.test(text))    return {refused: true, reason: ASSISTIVE_ACCESS_REFUSAL_REASON};
    if (AUTOMATION_ACCESS_RE.test(text))   return {refused: true, reason: AUTOMATION_ACCESS_REFUSAL_REASON};
    if (PRIVILEGE_VIOLATION_RE.test(text)) return {refused: true, reason: PRIVILEGE_VIOLATION_REFUSAL_REASON};

    return null
}

/**
 * @summary Whether an `osascript` error reflects a deterministic macOS Accessibility / AppleEvents denial
 * (`-25211`, `-1743`, `-10004`, `not allowed assistive access`) rather than a missing window (`-1719`).
 * @param {*} error
 * @returns {Boolean}
 */
export function isAssistiveAccessError(error) {
    return Boolean(assistiveAccessRefusal(error))
}

/**
 * @summary Returns the System Settings permission remedy when `reason` names its grant (`-25211` Accessibility,
 * `-1743` Automation of System Events), or `null` when the denial class names no single pane (`-10004`).
 * @param {String} reason
 * @returns {String|null}
 */
export function windowRefusalRemedy(reason) {
    const text = String(reason ?? '');

    if (ASSISTIVE_ACCESS_RE.test(text))  return 'grant Accessibility permission to Neo Harness.app in System Settings';
    if (AUTOMATION_ACCESS_RE.test(text)) return 'grant Automation of System Events permission to Neo Harness.app in System Settings';

    return null
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
 * @summary The `osascript` argv that reads the main on-screen layer-0 window's position and size of the
 * process with the unix id via CoreGraphics (`CGWindowListCopyWindowInfo`), requiring no macOS Accessibility
 * or Automation TCC grant and answered as four comma-separated integers.
 * @param {Number} pid
 * @returns {String[]}
 */
export function readWindowRectArgs(pid) {
    const id = assertPid(pid);

    return [
        '-l', 'JavaScript',
        '-e', 'ObjC.import("CoreGraphics");',
        '-e', 'const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];',
        '-e', `const win = list.filter(w => w.kCGWindowOwnerPID === ${id} && w.kCGWindowLayer === 0 && w.kCGWindowBounds && w.kCGWindowBounds.Width > 0 && w.kCGWindowBounds.Height > 0).sort((a, b) => (b.kCGWindowBounds.Width * b.kCGWindowBounds.Height) - (a.kCGWindowBounds.Width * a.kCGWindowBounds.Height))[0];`,
        '-e', 'const b = win && win.kCGWindowBounds;',
        '-e', 'b ? `${Math.round(b.X)},${Math.round(b.Y)},${Math.round(b.Width)},${Math.round(b.Height)}` : "";'
    ]
}

/**
 * @summary Reads `<instanceHome>/DevToolsActivePort` when present and valid.
 * @param {String} instanceHome
 * @param {Object} [options]
 * @param {Object} [options.fileSystem=fs]
 * @returns {{port: Number, browserPath: String, wsUrl: String}|null}
 */
export function readDevToolsActivePort(instanceHome, {fileSystem = fs} = {}) {
    if (typeof instanceHome !== 'string' || !instanceHome) return null;

    try {
        const
            raw    = fileSystem.readFileSync(path.join(instanceHome, DEVTOOLS_ACTIVE_PORT_FILE), 'utf8'),
            lines  = String(raw ?? '').trim().split(/\r?\n/),
            port   = Number(lines[0]?.trim()),
            wsPath = lines[1]?.trim() ?? '';

        if (!Number.isInteger(port) || port <= 0 || port > 65535 || !wsPath.startsWith('/devtools/')) return null;

        return {port, browserPath: wsPath, wsUrl: `ws://127.0.0.1:${port}${wsPath}`}
    } catch {
        return null
    }
}

/**
 * @summary Moves and sizes an Electron/Chromium seat window via its profile-local `DevToolsActivePort`
 * loopback WebSocket (`Browser.grantPermissions` for `windowManagement` + `Runtime.evaluate` with
 * `userGesture: true`), requiring zero macOS Accessibility / AppleEvents TCC grants.
 * @param {Object} rect
 * @param {Object} [options]
 * @param {String} [options.instanceHome]
 * @param {Number} [options.timeoutMs=3000]
 * @param {Number} [options.pollMs=100]
 * @param {Object} [options.fileSystem=fs]
 * @param {Function} [options.WebSocketCtor=globalThis.WebSocket]
 * @param {Function} [options.now=Date.now]
 * @param {Function} [options.sleep]
 * @returns {Promise<Boolean>} `true` when the CDP window move/resize executed on a page target.
 */
export async function placeDevToolsWindowRect(rect, {
    instanceHome,
    timeoutMs     = 3000,
    pollMs        = 100,
    fileSystem    = fs,
    WebSocketCtor = globalThis.WebSocket,
    now           = Date.now,
    sleep         = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
    if (!isWindowRect(rect) || typeof WebSocketCtor !== 'function') return false;

    const endpoint = readDevToolsActivePort(instanceHome, {fileSystem});

    if (!endpoint) return false;

    const
        {x, y, width, height} = roundRect(rect),
        deadline              = now() + timeoutMs,
        pending               = new Map();
    let ws, nextId = 1;

    const settleAll = error => {
        for (const entry of pending.values()) entry.reject(error);
        pending.clear()
    };

    try {
        ws = new WebSocketCtor(endpoint.wsUrl);

        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('DevTools WebSocket open timeout')), Math.max(1, deadline - now()));

            ws.onopen  = () => { clearTimeout(timer); resolve() };
            ws.onerror = err => { clearTimeout(timer); reject(err instanceof Error ? err : new Error('DevTools WebSocket error')) };
            ws.onclose = () => { clearTimeout(timer); reject(new Error('DevTools WebSocket closed')) };
        });

        ws.onmessage = event => {
            try {
                const msg = JSON.parse(typeof event?.data === 'string' ? event.data : String(event?.data ?? ''));

                if (msg?.id && pending.has(msg.id)) {
                    const entry = pending.get(msg.id);
                    pending.delete(msg.id);
                    msg.error ? entry.reject(new Error(msg.error.message || 'CDP error')) : entry.resolve(msg.result)
                }
            } catch {}
        };
        ws.onerror = () => settleAll(new Error('DevTools WebSocket error'));
        ws.onclose = () => settleAll(new Error('DevTools WebSocket closed'));

        const call = (method, params = {}, sessionId = undefined) => new Promise((resolve, reject) => {
            const remaining = deadline - now();

            if (remaining <= 0) return reject(new Error('DevTools RPC timeout'));

            const
                id    = nextId++,
                timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`DevTools RPC timeout: ${method}`))
                }, remaining);

            pending.set(id, {
                resolve: value => { clearTimeout(timer); resolve(value) },
                reject : error => { clearTimeout(timer); reject(error) }
            });

            const payload = {id, method, params};
            if (sessionId) payload.sessionId = sessionId;
            ws.send(JSON.stringify(payload))
        });

        for (;;) {
            const
                targets    = (await call('Target.getTargets'))?.targetInfos ?? [],
                pageTarget = targets.find(t => t?.type === 'page' && /^https?:\/\//i.test(t.url ?? ''));

            if (pageTarget) {
                const origin = new URL(pageTarget.url).origin;

                try {
                    await call('Browser.grantPermissions', {permissions: ['windowManagement'], origin})
                } catch {}

                const {sessionId} = await call('Target.attachToTarget', {targetId: pageTarget.targetId, flatten: true}) ?? {};

                if (!sessionId) return false;

                await call('Runtime.evaluate', {
                    expression   : `window.moveTo(${x}, ${y}); window.resizeTo(${width}, ${height}); window.moveTo(${x}, ${y});`,
                    userGesture  : true,
                    returnByValue: true
                }, sessionId);

                return true
            }

            if (now() >= deadline) return false;

            await sleep(pollMs)
        }
    } catch {
        return false
    } finally {
        settleAll(new Error('DevTools WebSocket closed'));
        try { ws?.close() } catch {}
    }
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
 * platform has no adapter; `{refused: true, reason}` when macOS denies Accessibility / AppleEvents (`-25211`,
 * `-1743`, `-10004`); never throws.
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
 * @summary Places a seat window by pid and reads the frame back. When `instanceHome` exposes a profile-local
 * `DevToolsActivePort`, placement runs over loopback CDP first (`placeDevToolsWindowRect`) before falling
 * back to `System Events`. The read-back is the proof: the OS may clamp or refuse the frame (a display no
 * longer attached), and only the observed rectangle or TCC refusal is reported.
 * @param {Number} pid
 * @param {Object} rect
 * @param {Object} [options] As {@link readSeatWindowRect}, plus optional `instanceHome` / `placeDevToolsFn`.
 * @returns {Promise<Object|null>} The observed rectangle after the move, `{refused: true, reason}`, or `null`.
 */
export async function placeSeatWindow(pid, rect, {
    execFileFn      = execFileAsync,
    platform        = process.platform,
    timeoutMs       = 3000,
    instanceHome    = null,
    placeDevToolsFn = placeDevToolsWindowRect
} = {}) {
    if (platform !== 'darwin' || !isWindowRect(rect)) return null;

    const placedByDevTools = instanceHome
        ? await placeDevToolsFn(rect, {instanceHome, timeoutMs})
        : false;

    if (!placedByDevTools) {
        try {
            await execFileFn('osascript', placeWindowRectArgs(pid, rect), {timeout: timeoutMs})
        } catch (error) {
            return assistiveAccessRefusal(error)
        }
    }

    return readSeatWindowRect(pid, {execFileFn, platform, timeoutMs})
}

/**
 * @summary Waits for the process's first window and answers its rectangle, polling the reader unless macOS
 * denies Accessibility / AppleEvents (`-25211`, `-1743`, `-10004`), which short-circuits immediately on the
 * first denied attempt.
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

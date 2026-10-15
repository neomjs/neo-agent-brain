import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';

/**
 * @module ai/services/fleet/seatExitReason
 * @summary Why a supervised Fleet seat exited without a `stop(id)` request from Fleet Manager.
 *
 * Arbitrary child `stderr` is never status authority. The harness's own update marker in
 * `~/Library/Logs/Claude/main.log` within the 60 s window before the observed exit
 * (`[stealth-update] Triggering stealth update` or `beforeQuitForUpdate`) is the single named match,
 * because it is the harness naming its own act. Any other exit — no match in the window, a missing or
 * unreadable log, or another harness family — reports `state: 'unknown'`.
 */

/**
 * Default path to Claude Desktop's main Electron log on macOS.
 * @type {String}
 */
export const DEFAULT_CLAUDE_MAIN_LOG = path.join(os.homedir(), 'Library', 'Logs', 'Claude', 'main.log');

/**
 * Window (in milliseconds) before `exitedAt` within which a Claude Desktop update marker qualifies.
 * @type {Number}
 */
export const SEAT_EXIT_REASON_WINDOW_MS = 60_000;

const CLAUDE_UPDATE_MARKERS = Object.freeze([
    '[stealth-update] Triggering stealth update',
    'beforeQuitForUpdate'
]);

const LOG_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})?\b/;

/**
 * @summary Classify why a managed seat exited without a `stop(id)` request.
 * @param {Object} options
 * @param {String|null} options.harnessType The seat's harness family (`'claude-desktop'`, etc.).
 * @param {String} options.exitedAt ISO timestamp when Fleet observed the process exit.
 * @param {String} [options.logPath=DEFAULT_CLAUDE_MAIN_LOG] Override path for Claude Desktop's `main.log`.
 * @param {Object} [options.fileSystem=fs] Filesystem seam (`readFileSync`).
 * @returns {{state: ('harness-update'|'unknown'), exitedAt: String, logPath?: String, matchedLine?: String, reason?: String}|null}
 */
export function readSeatExitReason({harnessType, exitedAt, logPath, fileSystem = fs} = {}) {
    if (typeof exitedAt !== 'string' || Number.isNaN(Date.parse(exitedAt))) {
        return null
    }

    if (harnessType !== 'claude-desktop') {
        return {state: 'unknown', exitedAt}
    }

    const
        resolvedLogPath = logPath || DEFAULT_CLAUDE_MAIN_LOG,
        exitedAtMs      = Date.parse(exitedAt),
        windowStartMs   = exitedAtMs - SEAT_EXIT_REASON_WINDOW_MS;

    let content;

    try {
        content = fileSystem.readFileSync(resolvedLogPath, 'utf8')
    } catch (error) {
        return {
            state  : 'unknown',
            exitedAt,
            logPath: resolvedLogPath,
            reason : String(error?.code || error?.message || error)
        }
    }

    let matchedLine = null;

    for (const rawLine of String(content).split(/\r?\n/)) {
        const line = rawLine.trim();

        if (!line || !CLAUDE_UPDATE_MARKERS.some(marker => line.includes(marker))) continue;

        const parsed = parseLogLineTimestamp(line);

        if (!parsed) continue;

        const
            lineStartMs = parsed.timeMs,
            lineEndMs   = parsed.hasSubsecond ? parsed.timeMs : parsed.timeMs + 999,
            exitBoundMs = parsed.hasSubsecond ? exitedAtMs : Math.floor(exitedAtMs / 1000) * 1000 + 999;

        if (lineStartMs <= exitBoundMs && lineEndMs >= windowStartMs) {
            matchedLine = line
        }
    }

    return matchedLine
        ? {state: 'harness-update', exitedAt, logPath: resolvedLogPath, matchedLine}
        : {state: 'unknown', exitedAt, logPath: resolvedLogPath}
}

/**
 * @summary Parse a leading `YYYY-MM-DD HH:MM:SS[.SSS][Z|±HH:MM]` timestamp from a log line.
 * Claude Desktop's `main.log` writes local-clock timestamps without an offset (`YYYY-MM-DD HH:MM:SS`).
 * @param {String} line
 * @returns {{timeMs: Number, hasSubsecond: Boolean}|null}
 * @private
 */
function parseLogLineTimestamp(line) {
    const match = LOG_TIMESTAMP_RE.exec(line);

    if (!match) return null;

    const
        hasSubsecond = match[7] != null,
        ms           = hasSubsecond ? Number(match[7].padEnd(3, '0')) : 0;

    if (match[8]) {
        const timeMs = Date.parse(match[0].replace(' ', 'T'));

        return Number.isNaN(timeMs) ? null : {timeMs, hasSubsecond}
    }

    const timeMs = new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6]),
        ms
    ).getTime();

    return Number.isNaN(timeMs) ? null : {timeMs, hasSubsecond}
}

export default readSeatExitReason;

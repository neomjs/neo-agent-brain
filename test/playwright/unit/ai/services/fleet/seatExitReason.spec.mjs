import {test, expect}       from '@playwright/test';
import fs                   from 'node:fs';
import os                   from 'node:os';
import path                 from 'node:path';
import {readSeatExitReason} from '../../../../../../ai/services/fleet/seatExitReason.mjs';

/**
 * Format a millisecond epoch timestamp as Claude Desktop's local-clock `YYYY-MM-DD HH:MM:SS` log prefix.
 * @param {Number} ms
 * @returns {String}
 */
function formatLocalLogTime(ms) {
    const
        date = new Date(ms),
        pad  = n => String(n).padStart(2, '0');

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * @summary Why a supervised seat exited without a Stop: only Claude Desktop's update markers inside the
 * 60 s window before `exitedAt` classify as `harness-update`, and every other exit is `unknown`.
 */
test.describe('seatExitReason — why a managed seat exited without a Stop', () => {
    const
        exitedAt   = '2026-10-15T12:26:13.450Z',
        exitedAtMs = Date.parse(exitedAt);

    let root, logPath;

    test.beforeEach(() => {
        root    = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-exit-reason-'));
        logPath = path.join(root, 'main.log')
    });

    test.afterEach(() => {
        fs.rmSync(root, {recursive: true, force: true})
    });

    test('matches [stealth-update] Triggering stealth update or beforeQuitForUpdate within the 60 s window before exitedAt', () => {
        const
            stealthLine = `${formatLocalLogTime(exitedAtMs - 5_000)} [info] [stealth-update] Triggering stealth update after idle timeout`,
            quitLine    = `${formatLocalLogTime(exitedAtMs)} [info] beforeQuitForUpdate handler fired, going down for update`;

        fs.writeFileSync(logPath, `${stealthLine}\n`);

        expect(readSeatExitReason({harnessType: 'claude-desktop', exitedAt, logPath})).toEqual({
            state      : 'harness-update',
            exitedAt,
            logPath,
            matchedLine: stealthLine
        });

        fs.writeFileSync(logPath, `${stealthLine}\n${quitLine}\n`);

        expect(readSeatExitReason({harnessType: 'claude-desktop', exitedAt, logPath}), 'latest matching marker inside window wins').toEqual({
            state      : 'harness-update',
            exitedAt,
            logPath,
            matchedLine: quitLine
        })
    });

    test('returns unknown without reason when log lines fall outside the 60 s window or do not match the update markers', () => {
        const
            tooEarly  = `${formatLocalLogTime(exitedAtMs - 65_000)} [info] [stealth-update] Triggering stealth update after idle timeout`,
            afterExit = `${formatLocalLogTime(exitedAtMs + 5_000)} [info] beforeQuitForUpdate handler fired, going down for update`,
            otherLine = `${formatLocalLogTime(exitedAtMs - 2_000)} [info] Window closed by user`;

        fs.writeFileSync(logPath, [tooEarly, otherLine, afterExit].join('\n'));

        const outcome = readSeatExitReason({harnessType: 'claude-desktop', exitedAt, logPath});

        expect(outcome).toEqual({state: 'unknown', exitedAt, logPath});
        expect(Object.hasOwn(outcome, 'reason')).toBe(false)
    });

    test('returns unknown with reason when the claude-desktop log cannot be read, and unknown without logPath for other harnesses', () => {
        const missingOutcome = readSeatExitReason({harnessType: 'claude-desktop', exitedAt, logPath});

        expect(missingOutcome).toEqual({
            state : 'unknown',
            exitedAt,
            logPath,
            reason: 'ENOENT'
        });

        expect(readSeatExitReason({harnessType: 'codex-desktop', exitedAt, logPath})).toEqual({
            state: 'unknown',
            exitedAt
        });
        expect(readSeatExitReason({harnessType: 'claude-desktop', exitedAt: 'not-a-date', logPath})).toBeNull()
    });
});

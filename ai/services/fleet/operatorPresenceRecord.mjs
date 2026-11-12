import fs       from 'node:fs';
import path     from 'node:path';
import AiConfig from '../../config.mjs';

/**
 * @module ai/services/fleet/operatorPresenceRecord
 * @summary The Fleet's host record of the operator's presence: one JSON file that every seat's Stop hook
 * reads with a local file read, so a turn-end never waits on the plane.
 *
 * The plane's `OperatorPresenceService` stays the truth. This file mirrors the reading the Fleet last set or
 * read, `{mode, since, until, writtenAt}`, beneath the Fleet's own data directory, and the Fleet hands each
 * seat its path at Start under {@link OPERATOR_PRESENCE_PATH_ENV_VAR} (the `seat.operatorPresencePath` leaf).
 * The file carries no identity: `setBy` stays on the plane.
 */

/**
 * The reserved seat env slot carrying the record's absolute path. Intentionally NOT configurable: the
 * `seat.operatorPresencePath` leaf binds this exact name, so another name would fill a slot no hook reads.
 * @type {String}
 */
export const OPERATOR_PRESENCE_PATH_ENV_VAR = 'NEO_OPERATOR_PRESENCE_PATH';

/**
 * @summary The record's absolute path, beneath the Fleet's data directory.
 * @returns {String}
 */
export function operatorPresenceRecordPath() {
    return path.join(AiConfig.fleet.dataDir, 'operator-presence.json')
}

/**
 * @summary Whether two presence readings show the same state: the same mode, since and until.
 * @param {Object|null} a A reading `{mode, since, until}`.
 * @param {Object|null} b A reading `{mode, since, until}`.
 * @returns {Boolean} false when either reading is missing.
 */
export function sameOperatorPresence(a, b) {
    return !!a && !!b && a.mode === b.mode && (a.since ?? null) === (b.since ?? null) && (a.until ?? null) === (b.until ?? null)
}

/**
 * @summary Writes `{mode, since, until, writtenAt}` through a temp file and a rename, so a reader never
 * sees half a record.
 * @param {Object} presence The plane's reading `{mode, since, until}`.
 * @param {Object} [options]
 * @param {String} [options.filePath=operatorPresenceRecordPath()] Where the record lives.
 * @param {Number} [options.now=Date.now()] Clock source for `writtenAt`.
 * @returns {Boolean} true when written. A failure leaves the previous record in place and returns false.
 */
export function writeOperatorPresenceRecord(presence, {filePath = operatorPresenceRecordPath(), now = Date.now()} = {}) {
    const temp = `${filePath}.${process.pid}.tmp`;

    try {
        fs.mkdirSync(path.dirname(filePath), {recursive: true});
        fs.writeFileSync(temp, JSON.stringify({
            mode     : presence.mode,
            since    : presence.since ?? null,
            until    : presence.until ?? null,
            writtenAt: new Date(now).toISOString()
        }));
        fs.renameSync(temp, filePath);

        return true
    } catch {
        try {
            fs.rmSync(temp, {force: true})
        } catch {
            // An unreadable directory keeps the temp file too; the next write from this process replaces it.
        }

        return false
    }
}

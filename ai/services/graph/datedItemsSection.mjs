import fs from 'node:fs';

/**
 * @module ai/services/graph/datedItemsSection
 * @summary Pure scalar-path reader for the business repository's `strategy/dated-items.json`
 * (`dated-items.v1` schema).
 *
 * Reads the dated-items register from an operator-placed file path (`datedItemsSourcePath`)
 * without reading environment variables or persisting any derived state. Partitioning is
 * computed on read against the UTC calendar date of `now`:
 * - `overdue`: `state !== 'receipted'` and `due` is an ISO date (`YYYY-MM-DD`) strictly before today (UTC).
 * - `next`: `state !== 'receipted'` and `due` is an ISO date (`YYYY-MM-DD`) today or later (UTC),
 *   sorted by `due` ascending and bounded to the three soonest rows.
 * - `missing`: `state !== 'receipted'` and `due` is `null`.
 *
 * Load-bearing invariants:
 * 1. Only `state === 'receipted'` lets a row leave; the text in `receipt` is never read.
 * 2. Nothing is stored — overdue state is derived on every read, avoiding stale stored flags.
 * 3. An empty `sourcePath` returns `{status: 'unconfigured'}`; a missing/corrupt file or any
 *    `schema` other than `'dated-items.v1'` returns `{status: 'unreadable', reason}`.
 */

/**
 * Canonical schema identifier for `strategy/dated-items.json`.
 * @type {String}
 */
export const DATED_ITEMS_SCHEMA = 'dated-items.v1';

/**
 * Maximum number of upcoming rows returned in the `next` bucket.
 * @type {Number}
 */
export const DATED_ITEMS_NEXT_LIMIT = 3;

const
    DAY_MS          = 86_400_000,
    ISO_DATE_REGEXP = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @summary Normalizes a Date, ISO string, `'YYYY-MM-DD'` date string, or epoch millisecond timestamp
 * into a UTC `'YYYY-MM-DD'` date string.
 * @param {Date|String|Number} [now=new Date()] Clock input.
 * @returns {String} UTC calendar date (`YYYY-MM-DD`).
 */
export function toUtcDateString(now = new Date()) {
    if (typeof now === 'string' && ISO_DATE_REGEXP.test(now.trim())) {
        return now.trim();
    }

    const date = now instanceof Date ? now : new Date(now);

    if (Number.isNaN(date.getTime())) {
        throw new TypeError(`readDatedItems: invalid "now" value: ${String(now)}`);
    }

    return date.toISOString().slice(0, 10);
}

/**
 * @summary Computes the number of whole UTC calendar days a `YYYY-MM-DD` due date is past `today`.
 * @param {String} due ISO calendar date (`YYYY-MM-DD`).
 * @param {String} today Current UTC calendar date (`YYYY-MM-DD`).
 * @returns {Number} Whole UTC days past due (`>= 0`).
 */
export function computeDaysOverdue(due, today) {
    const dueMs   = Date.parse(`${due}T00:00:00.000Z`),
          todayMs = Date.parse(`${today}T00:00:00.000Z`);

    if (!Number.isFinite(dueMs) || !Number.isFinite(todayMs) || todayMs <= dueMs) {
        return 0;
    }

    return Math.round((todayMs - dueMs) / DAY_MS);
}

/**
 * @summary Reads and partitions the `dated-items.v1` register into `overdue`, `next`, and `missing` buckets.
 *
 * Pure function over its scalar `sourcePath` and `now` inputs; reads no environment variables.
 *
 * @param {Object} [options={}]
 * @param {String} [options.sourcePath=''] Resolved `datedItemsSourcePath` leaf value.
 * @param {Date|String|Number} [options.now=new Date()] Current time used to derive the UTC calendar date.
 * @param {Function} [options.readFile=fs.readFileSync] Injectable file reader (`(path, 'utf8') => string`).
 * @returns {{
 *   status: ('unconfigured'|'unreadable'|'ok'),
 *   sourcePath: String,
 *   today: String,
 *   reason?: String,
 *   overdue: Object[],
 *   next: Object[],
 *   missing: Object[]
 * }}
 */
export function readDatedItems({
    sourcePath = '',
    now        = new Date(),
    readFile   = fs.readFileSync
} = {}) {
    const today = toUtcDateString(now);

    if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
        return {
            status    : 'unconfigured',
            sourcePath: '',
            today,
            overdue   : [],
            next      : [],
            missing   : []
        };
    }

    const trimmedPath = sourcePath.trim();
    let   rawText;

    try {
        rawText = readFile(trimmedPath, 'utf8');
    } catch (error) {
        return {
            status    : 'unreadable',
            sourcePath: trimmedPath,
            today,
            reason    : error?.code || error?.message || 'unreadable',
            overdue   : [],
            next      : [],
            missing   : []
        };
    }

    let parsed;

    try {
        parsed = JSON.parse(rawText);
    } catch (error) {
        return {
            status    : 'unreadable',
            sourcePath: trimmedPath,
            today,
            reason    : error?.message || 'invalid JSON',
            overdue   : [],
            next      : [],
            missing   : []
        };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
            status    : 'unreadable',
            sourcePath: trimmedPath,
            today,
            reason    : 'register root must be a JSON object',
            overdue   : [],
            next      : [],
            missing   : []
        };
    }

    if (parsed.schema !== DATED_ITEMS_SCHEMA) {
        return {
            status    : 'unreadable',
            sourcePath: trimmedPath,
            today,
            reason    : `unexpected schema: ${String(parsed.schema ?? 'missing')} (expected ${DATED_ITEMS_SCHEMA})`,
            overdue   : [],
            next      : [],
            missing   : []
        };
    }

    if (!Array.isArray(parsed.rows)) {
        return {
            status    : 'unreadable',
            sourcePath: trimmedPath,
            today,
            reason    : 'missing rows array',
            overdue   : [],
            next      : [],
            missing   : []
        };
    }

    const overdue        = [],
          nextCandidates = [],
          missing        = [];

    parsed.rows.forEach((row, index) => {
        if (!row || typeof row !== 'object') {
            return;
        }

        // Only `state: 'receipted'` lets a row leave; `row.receipt` is never read.
        if (row.state === 'receipted') {
            return;
        }

        if (row.due === null || row.due === undefined) {
            missing.push(row);
            return;
        }

        if (typeof row.due === 'string' && ISO_DATE_REGEXP.test(row.due)) {
            if (row.due < today) {
                overdue.push(row);
            } else {
                nextCandidates.push({row, index});
            }
        }
    });

    const next = nextCandidates
        .sort((a, b) => a.row.due !== b.row.due ? a.row.due.localeCompare(b.row.due) : a.index - b.index)
        .slice(0, DATED_ITEMS_NEXT_LIMIT)
        .map(entry => entry.row);

    return {
        status    : 'ok',
        sourcePath: trimmedPath,
        today,
        overdue,
        next,
        missing
    };
}

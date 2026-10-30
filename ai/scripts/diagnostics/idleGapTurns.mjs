/**
 * @module ai/scripts/diagnostics/idleGapTurns
 * @summary Counts, per seat and ISO week, the turns that began more than a gap after the seat's
 * previous known activity — the number the heartbeat floor exists to drive to zero — read-only from
 * an explicitly named graph SQLite file.
 *
 * A turn is an `AGENT_TURN_PRESENCE` interval where the presence hook is wired: its `startedAt` is
 * the turn start and its `lastProgressAt` is activity. For a seat with no presence rows in the
 * window, each `AGENT_MEMORY` is the turn marker instead; the consolidate-then-save memory lands at
 * the turn's end, so that gap is measured to the memory and undercounts by the turn's length — the
 * row names the marker it used. Outbound `MESSAGE` rows count as activity for every seat.
 *
 * Mirrors `mailboxReadStateProbe.mjs`: no AiConfig, no repair, no write. The plane's store lives in
 * a container volume, so the reading runs against a copy or inside the container.
 *
 * @example
 * node ai/scripts/diagnostics/idleGapTurns.mjs --db-path /path/to/graph.sqlite --gap-minutes 60 --weeks 2
 */
import Database        from 'better-sqlite3';
import {isEntryModule} from '../../services/shared/isEntryModule.mjs';

export const HELP_TEXT = `Usage:
  node ai/scripts/diagnostics/idleGapTurns.mjs --db-path <graph.sqlite> [--gap-minutes 60] [--weeks 2] [--identity @seat] [--json]

The database path is mandatory and is opened read-only. Counts, per seat and ISO week, the turns
that began more than --gap-minutes after the seat's previous known activity (memory, presence
beacon or outbound message) over the last --weeks weeks.`;

/**
 * The gap, in minutes, past which a turn start counts as an idle-gap turn: the hour after which a
 * provider prompt cache is cold.
 * @type {Number}
 */
export const DEFAULT_GAP_MINUTES = 60;

/**
 * How many ISO weeks the report covers by default.
 * @type {Number}
 */
export const DEFAULT_WEEKS = 2;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @summary Parses a positive number argument or throws with the argument's name.
 * @param {String} name
 * @param {String} raw
 * @returns {Number}
 * @private
 */
function positiveNumber(name, raw) {
    const value = Number(raw);

    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} requires a positive number, got '${raw}'.`)
    }

    return value
}

/**
 * @summary Brings a stored identity to the canonical `@<identity>` form.
 * @param {String|null} identity
 * @returns {String|null}
 * @private
 */
function canonicalIdentity(identity) {
    if (typeof identity !== 'string' || identity.length === 0) return null;

    return identity.startsWith('@') ? identity : `@${identity}`
}

/**
 * @summary Parses the CLI arguments without consulting process config.
 * @param {String[]} argv CLI arguments excluding node and script path.
 * @returns {{help: Boolean}|{dbPath: String, gapMinutes: Number, weeks: Number, identity: String|null, json: Boolean}}
 * @throws {Error} For a missing database path, an unknown argument or a malformed number.
 */
export function parseArgs(argv = []) {
    if (!Array.isArray(argv)) {
        throw new Error('Arguments must be an array.')
    }
    if (argv.includes('--help') || argv.includes('-h')) {
        return {help: true}
    }

    const options = {dbPath: null, gapMinutes: DEFAULT_GAP_MINUTES, weeks: DEFAULT_WEEKS, identity: null, json: false};

    for (let index = 0; index < argv.length; index++) {
        const arg  = argv[index];
        const next = () => {
            const value = argv[++index];

            if (value === undefined || value.startsWith('--')) {
                throw new Error(`${arg} requires a value.`)
            }

            return value
        };

        switch (arg) {
            case '--db-path':     options.dbPath     = next(); break;
            case '--gap-minutes': options.gapMinutes = positiveNumber(arg, next()); break;
            case '--weeks':       options.weeks      = positiveNumber(arg, next()); break;
            case '--identity':    options.identity   = canonicalIdentity(next()); break;
            case '--json':        options.json       = true; break;
            default:
                throw new Error(`Unknown argument: ${arg}`)
        }
    }

    if (!options.dbPath) {
        throw new Error('--db-path is required.')
    }

    return options
}

/**
 * @summary The ISO week a timestamp falls in, as `YYYY-Www`.
 * @param {Number} ms Epoch milliseconds.
 * @returns {String}
 */
export function isoWeekKey(ms) {
    const date          = new Date(ms),
          mondayOffset  = (date.getUTCDay() + 6) % 7,
          thursday      = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - mondayOffset + 3)),
          firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4)),
          week          = 1 + Math.round(((thursday - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);

    return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/**
 * @summary Reads every activity event since a point in time: turn starts and progress beacons,
 * memories, and outbound messages, oldest first.
 * @param {Object} db Open `better-sqlite3` handle (read-only is enough).
 * @param {Object} [options]
 * @param {Number} [options.since=0] Epoch milliseconds; rows older than this are not read.
 * @param {String|null} [options.identity=null] Restrict to one canonical identity.
 * @returns {Array<{identity: String, kind: 'turn'|'progress'|'memory'|'message', at: String, atMs: Number}>}
 */
export function readActivityEvents(db, {since = 0, identity = null} = {}) {
    const sinceIso = new Date(since).toISOString(),
          events   = [];

    const presence = db.prepare(`
        SELECT identity, startedAt, lastProgressAt FROM (
            SELECT json_extract(data, '$.properties.agentIdentity')  AS identity,
                   json_extract(data, '$.properties.startedAt')      AS startedAt,
                   json_extract(data, '$.properties.lastProgressAt') AS lastProgressAt
            FROM Nodes
            WHERE json_extract(data, '$.label') = 'AGENT_TURN_PRESENCE'
        )
        WHERE startedAt >= ?
    `).all(sinceIso);

    for (const row of presence) {
        const id = canonicalIdentity(row.identity);
        if (!id || (identity && id !== identity)) continue;

        events.push({identity: id, kind: 'turn', at: row.startedAt});
        if (row.lastProgressAt) events.push({identity: id, kind: 'progress', at: row.lastProgressAt});
    }

    const memories = db.prepare(`
        SELECT identity, at FROM (
            SELECT COALESCE(json_extract(data, '$.properties.agentIdentity'), json_extract(data, '$.properties.userId')) AS identity,
                   json_extract(data, '$.properties.timestamp') AS at
            FROM Nodes
            WHERE json_extract(data, '$.label') = 'AGENT_MEMORY'
        )
        WHERE at >= ?
    `).all(sinceIso);

    for (const row of memories) {
        const id = canonicalIdentity(row.identity);
        if (!id || (identity && id !== identity)) continue;

        events.push({identity: id, kind: 'memory', at: row.at});
    }

    const messages = db.prepare(`
        SELECT identity, at FROM (
            SELECT e.target AS identity, json_extract(n.data, '$.properties.sentAt') AS at
            FROM Edges e
            JOIN Nodes n ON n.id = e.source
            WHERE e.type = 'SENT_BY'
              AND json_extract(n.data, '$.label') = 'MESSAGE'
        )
        WHERE at >= ?
    `).all(sinceIso);

    for (const row of messages) {
        const id = canonicalIdentity(row.identity);
        if (!id || (identity && id !== identity)) continue;

        events.push({identity: id, kind: 'message', at: row.at});
    }

    return events
        .map(event => ({...event, atMs: Date.parse(event.at)}))
        .filter(event => Number.isFinite(event.atMs))
        .sort((a, b) => a.atMs - b.atMs)
}

/**
 * @summary Counts the turns, per identity and ISO week, that began more than `gapMs` after the
 * identity's previous activity.
 *
 * Every event advances the identity's "previous activity"; only turn markers are counted. A seat
 * with presence rows in the window uses its turn starts as markers; a seat without uses its memories.
 * The first marker an identity ever shows has no previous activity and is never an idle-gap turn.
 *
 * @param {Array} events Output of {@link readActivityEvents}, oldest first.
 * @param {Object} [options]
 * @param {Number} [options.gapMs=DEFAULT_GAP_MINUTES * 60000]
 * @param {Number} [options.now=Date.now()]
 * @param {Number} [options.weeks=DEFAULT_WEEKS] Only markers inside the last `weeks` weeks are counted.
 * @returns {Array<{identity: String, week: String, marker: 'turn-presence'|'memory', turns: Number, idleGapTurns: Number, share: Number}>}
 */
export function computeIdleGapTurns(events, {gapMs = DEFAULT_GAP_MINUTES * 60000, now = Date.now(), weeks = DEFAULT_WEEKS} = {}) {
    const windowStartMs = now - weeks * WEEK_MS,
          byIdentity    = new Map();

    for (const event of events) {
        if (!byIdentity.has(event.identity)) byIdentity.set(event.identity, []);
        byIdentity.get(event.identity).push(event);
    }

    const rows = [];

    for (const [identity, list] of [...byIdentity.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const hasPresence = list.some(event => event.kind === 'turn' && event.atMs >= windowStartMs),
              markerKind  = hasPresence ? 'turn' : 'memory',
              weeksMap    = new Map();

        let lastActivityMs = null;

        for (const event of list) {
            if (event.kind === markerKind && event.atMs >= windowStartMs) {
                const week   = isoWeekKey(event.atMs),
                      bucket = weeksMap.get(week) || {turns: 0, idleGapTurns: 0};

                bucket.turns++;
                if (lastActivityMs !== null && event.atMs - lastActivityMs > gapMs) bucket.idleGapTurns++;
                weeksMap.set(week, bucket);
            }

            lastActivityMs = lastActivityMs === null ? event.atMs : Math.max(lastActivityMs, event.atMs);
        }

        for (const [week, bucket] of [...weeksMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            rows.push({
                identity,
                week,
                marker: hasPresence ? 'turn-presence' : 'memory',
                ...bucket,
                share : bucket.turns ? Math.round((bucket.idleGapTurns / bucket.turns) * 1000) / 10 : 0
            });
        }
    }

    return rows
}

/**
 * @summary Renders the rows as a fixed-width text table.
 * @param {Array} rows Output of {@link computeIdleGapTurns}.
 * @param {Object} [options]
 * @param {Number} [options.gapMinutes=DEFAULT_GAP_MINUTES]
 * @returns {String}
 */
export function formatReport(rows, {gapMinutes = DEFAULT_GAP_MINUTES} = {}) {
    if (rows.length === 0) return 'No turns in the window.';

    const width = Math.max(8, ...rows.map(row => row.identity.length)),
          lines = [
              `${'identity'.padEnd(width)}  week      marker         turns  idle-gap(>${gapMinutes}m)  share`,
              ...rows.map(row =>
                  `${row.identity.padEnd(width)}  ${row.week}  ${row.marker.padEnd(13)}  ${String(row.turns).padStart(5)}  ` +
                  `${String(row.idleGapTurns).padStart(16)}  ${String(row.share).padStart(4)}%`)
          ];

    return lines.join('\n')
}

/**
 * @summary Opens the database read-only, reads one extra week of lookback for the previous-activity
 * clock, and returns the rows.
 * @param {Object} options
 * @param {String} options.dbPath
 * @param {Number} [options.gapMinutes=DEFAULT_GAP_MINUTES]
 * @param {Number} [options.weeks=DEFAULT_WEEKS]
 * @param {String|null} [options.identity=null]
 * @param {Number} [options.now=Date.now()]
 * @returns {Array} The rows of {@link computeIdleGapTurns}.
 */
export function runIdleGapTurns({dbPath, gapMinutes = DEFAULT_GAP_MINUTES, weeks = DEFAULT_WEEKS, identity = null, now = Date.now()}) {
    const db = new Database(dbPath, {readonly: true, fileMustExist: true});

    try {
        const events = readActivityEvents(db, {since: now - (weeks + 1) * WEEK_MS, identity});

        return computeIdleGapTurns(events, {gapMs: gapMinutes * 60000, now, weeks})
    } finally {
        db.close()
    }
}

if (isEntryModule(import.meta.url)) {
    let options;

    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        console.error(HELP_TEXT);
        process.exit(1);
    }

    if (options.help) {
        console.log(HELP_TEXT);
        process.exit(0);
    }

    try {
        const rows = runIdleGapTurns(options);

        console.log(options.json ? JSON.stringify(rows, null, 2) : formatReport(rows, options));
    } catch (error) {
        console.error(`idleGapTurns failed: ${error.message}`);
        process.exit(1);
    }
}

import {test, expect} from '@playwright/test';
import Database       from 'better-sqlite3';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import {
    computeIdleGapTurns,
    DEFAULT_GAP_MINUTES,
    DEFAULT_WEEKS,
    formatReport,
    isoWeekKey,
    parseArgs,
    readActivityEvents,
    runIdleGapTurns
} from '../../../../../../ai/scripts/diagnostics/idleGapTurns.mjs';

const NOW  = Date.parse('2026-10-30T20:00:00.000Z'); // a Friday, ISO week 44
const HOUR = 60 * 60 * 1000;
const MIN  = 60 * 1000;

const PRESENCE_SEAT = '@neo-presence-seat';
const MEMORY_SEAT   = '@neo-memory-seat';

function seedGraph(db) {
    db.exec(`
        CREATE TABLE Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL);
        CREATE TABLE Edges (id TEXT PRIMARY KEY, user_id TEXT, source TEXT NOT NULL, target TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
    `);

    const node = (id, label, properties) => db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, ?, ?)')
        .run(id, properties.agentIdentity || null, JSON.stringify({id, label, type: label, properties}));
    const iso = agoMs => new Date(NOW - agoMs).toISOString();

    // The presence seat: three turns. The second begins 1h55m after the first turn's last beacon
    // (an idle-gap turn); the third begins 20 minutes after the second's beacon (not one).
    node('turn-1', 'AGENT_TURN_PRESENCE', {agentIdentity: PRESENCE_SEAT, startedAt: iso(5 * HOUR), lastProgressAt: iso(5 * HOUR - 5 * MIN)});
    node('turn-2', 'AGENT_TURN_PRESENCE', {agentIdentity: PRESENCE_SEAT, startedAt: iso(3 * HOUR), lastProgressAt: iso(3 * HOUR - 10 * MIN)});
    node('turn-3', 'AGENT_TURN_PRESENCE', {agentIdentity: PRESENCE_SEAT, startedAt: iso(3 * HOUR - 30 * MIN), lastProgressAt: iso(2 * HOUR)});
    // Its memory lands at the first turn's end and is activity too.
    node('mem-p-1', 'AGENT_MEMORY', {agentIdentity: PRESENCE_SEAT, timestamp: iso(5 * HOUR - 5 * MIN)});

    // The memory seat (no presence hook): memories mark its turns. A message 30 minutes before the
    // second memory keeps that gap under the hour; the first memory has nothing before it.
    node('mem-m-1', 'AGENT_MEMORY', {agentIdentity: MEMORY_SEAT, timestamp: iso(6 * HOUR)});
    node('mem-m-2', 'AGENT_MEMORY', {userId: MEMORY_SEAT.slice(1), timestamp: iso(3 * HOUR)});
    node('msg-m-1', 'MESSAGE', {subject: 's', bodyText: 'b', sentAt: iso(3 * HOUR + 30 * MIN), from: MEMORY_SEAT});
    db.prepare('INSERT INTO Edges (id, user_id, source, target, type, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run('edge-msg-m-1', MEMORY_SEAT, 'msg-m-1', MEMORY_SEAT, 'SENT_BY', JSON.stringify({type: 'SENT_BY'}));
    // A third memory two hours after the message: an idle-gap turn.
    node('mem-m-3', 'AGENT_MEMORY', {agentIdentity: MEMORY_SEAT, timestamp: iso(1 * HOUR)});

    // A stamp older than the read window must not surface.
    node('mem-ancient', 'AGENT_MEMORY', {agentIdentity: PRESENCE_SEAT, timestamp: iso(40 * 24 * HOUR)});
}

test.describe('ai/scripts/diagnostics/idleGapTurns', () => {
    let workRoot, dbPath;

    test.beforeAll(() => {
        workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-idle-gap-turns-'));
        dbPath   = path.join(workRoot, 'graph.sqlite');

        const db = new Database(dbPath);
        seedGraph(db);
        db.close();
    });

    test.afterAll(() => {
        fs.rmSync(workRoot, {recursive: true, force: true});
    });

    test('parseArgs requires the database path and refuses unknown or malformed arguments', () => {
        expect(parseArgs(['--db-path', '/tmp/g.sqlite'])).toEqual({
            dbPath: '/tmp/g.sqlite', gapMinutes: DEFAULT_GAP_MINUTES, weeks: DEFAULT_WEEKS, identity: null, json: false
        });
        expect(parseArgs(['--db-path', '/tmp/g.sqlite', '--gap-minutes', '45', '--weeks', '1', '--identity', 'neo-x', '--json']))
            .toEqual({dbPath: '/tmp/g.sqlite', gapMinutes: 45, weeks: 1, identity: '@neo-x', json: true});
        expect(parseArgs(['--help'])).toEqual({help: true});
        expect(() => parseArgs([])).toThrow('--db-path is required');
        expect(() => parseArgs(['--db-path', '/tmp/g.sqlite', '--gap-minutes', 'soon'])).toThrow('positive number');
        expect(() => parseArgs(['--db-path', '/tmp/g.sqlite', '--bogus'])).toThrow('Unknown argument');
        expect(() => parseArgs(['--db-path'])).toThrow('requires a value');
    });

    test('isoWeekKey follows the ISO calendar across a year boundary', () => {
        expect(isoWeekKey(NOW)).toBe('2026-W44');
        expect(isoWeekKey(Date.parse('2027-01-01T12:00:00.000Z'))).toBe('2026-W53');
        expect(isoWeekKey(Date.parse('2027-01-04T12:00:00.000Z'))).toBe('2027-W01');
    });

    test('readActivityEvents returns every stamp kind since the lookback, oldest first, identities canonical', () => {
        const db     = new Database(dbPath, {readonly: true});
        const events = readActivityEvents(db, {since: NOW - 7 * 24 * HOUR});
        db.close();

        expect(events.map(event => event.kind)).toEqual(expect.arrayContaining(['turn', 'progress', 'memory', 'message']));
        expect(events.every((event, index) => index === 0 || event.atMs >= events[index - 1].atMs)).toBe(true);
        expect(events.some(event => event.identity === MEMORY_SEAT && event.kind === 'memory' && event.atMs === NOW - 3 * HOUR)).toBe(true);
        expect(events.some(event => event.atMs === NOW - 40 * 24 * HOUR)).toBe(false);
    });

    test('computeIdleGapTurns counts turn starts past the gap, with presence starts or memories as the marker', () => {
        const db   = new Database(dbPath, {readonly: true});
        const rows = computeIdleGapTurns(readActivityEvents(db, {since: NOW - 7 * 24 * HOUR}), {gapMs: HOUR, now: NOW, weeks: 1});
        db.close();

        expect(rows).toEqual([
            {identity: MEMORY_SEAT,   week: '2026-W44', marker: 'memory',        turns: 3, idleGapTurns: 1, share: 33.3},
            {identity: PRESENCE_SEAT, week: '2026-W44', marker: 'turn-presence', turns: 3, idleGapTurns: 1, share: 33.3}
        ]);
    });

    test('runIdleGapTurns opens the file read-only, honours the identity filter, and formatReport renders a table', () => {
        const rows = runIdleGapTurns({dbPath, gapMinutes: 60, weeks: 1, identity: PRESENCE_SEAT, now: NOW});

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({identity: PRESENCE_SEAT, idleGapTurns: 1});

        const report = formatReport(rows, {gapMinutes: 60});

        expect(report).toContain('idle-gap(>60m)');
        expect(report).toContain(PRESENCE_SEAT);
        expect(formatReport([])).toBe('No turns in the window.');
    });

    test('a shorter gap raises the count: the presence seat\'s third turn began 20 minutes after its second beacon', () => {
        const rows = runIdleGapTurns({dbPath, gapMinutes: 15, weeks: 1, identity: PRESENCE_SEAT, now: NOW});

        expect(rows[0].idleGapTurns).toBe(2);
    });
});

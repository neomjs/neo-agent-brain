import {test, expect}                            from '@playwright/test';
import Database                                  from 'better-sqlite3';
import {ACTIVITY_SOURCES, readLastKnownActivity} from '../../../../../../ai/scripts/lifecycle/lastKnownActivity.mjs';

const IDENTITY = '@neo-activity-test';
const NOW      = Date.parse('2026-10-30T20:00:00.000Z');
const MIN      = 60 * 1000;

/**
 * @summary A graph with the two tables the read touches, in memory.
 * @returns {Object}
 */
function createGraph() {
    const db = new Database(':memory:');

    db.exec(`
        CREATE TABLE Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL);
        CREATE TABLE Edges (id TEXT PRIMARY KEY, user_id TEXT, source TEXT NOT NULL, target TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
    `);

    return db
}

function insertNode(db, id, label, properties) {
    db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, ?, ?)')
        .run(id, properties.agentIdentity || properties.userId || null, JSON.stringify({id, label, type: label, properties}));
}

function insertMemory(db, id, agoMs, {sessionId = 'session-1', legacy = false} = {}) {
    const at = new Date(NOW - agoMs).toISOString();

    insertNode(db, id, 'AGENT_MEMORY', legacy
        ? {agentIdentity: IDENTITY, name: `Memory: ${at}`, description: `Agent thought flow inside session ${sessionId}.`}
        : {agentIdentity: IDENTITY, userId: IDENTITY, timestamp: at, sessionId, name: `Memory: ${at}`});
}

function insertPresence(db, id, startedAgoMs, progressAgoMs) {
    insertNode(db, id, 'AGENT_TURN_PRESENCE', {
        agentIdentity : IDENTITY,
        turnId        : id,
        startedAt     : new Date(NOW - startedAgoMs).toISOString(),
        lastProgressAt: progressAgoMs === null ? null : new Date(NOW - progressAgoMs).toISOString(),
        status        : 'active'
    });
}

function insertOutboundMessage(db, id, agoMs, {target = IDENTITY} = {}) {
    insertNode(db, id, 'MESSAGE', {subject: 'subject', bodyText: 'body', sentAt: new Date(NOW - agoMs).toISOString(), from: IDENTITY});
    db.prepare('INSERT INTO Edges (id, user_id, source, target, type, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run(`edge-${id}`, IDENTITY, id, target, 'SENT_BY', JSON.stringify({id: `edge-${id}`, source: id, target, type: 'SENT_BY'}));
}

test.describe('ai/scripts/lifecycle/lastKnownActivity', () => {
    test('names the three stamp kinds in the order they are consulted', () => {
        expect(ACTIVITY_SOURCES).toEqual(['memory', 'turn-presence', 'message']);
    });

    test('a memory alone is the activity, and its session rides along', () => {
        const db = createGraph();
        insertMemory(db, 'mem-1', 45 * MIN, {sessionId: 'session-45'});
        insertMemory(db, 'mem-2', 90 * MIN, {sessionId: 'session-90'});

        const activity = readLastKnownActivity(db, IDENTITY, {now: NOW});

        expect(activity).toMatchObject({
            identity          : IDENTITY,
            lastActivitySource: 'memory',
            ageMs             : 45 * MIN,
            lastMemoryAgeMs   : 45 * MIN,
            lastSessionId     : 'session-45'
        });
        expect(activity.lastActivityAt).toBe(activity.lastMemoryAt);
    });

    test('a presence beacon younger than the memory wins, while the memory half still reports the memory', () => {
        const db = createGraph();
        insertMemory(db, 'mem-1', 45 * MIN);
        insertPresence(db, 'turn-1', 12 * MIN, 2 * MIN);

        const activity = readLastKnownActivity(db, IDENTITY, {now: NOW});

        expect(activity.lastActivitySource).toBe('turn-presence');
        expect(activity.ageMs).toBe(2 * MIN);
        expect(activity.lastActivityAt).toBe(new Date(NOW - 2 * MIN).toISOString());
        expect(activity.lastMemoryAgeMs).toBe(45 * MIN);
    });

    test('a turn start without a progress beacon counts from the start', () => {
        const db = createGraph();
        insertPresence(db, 'turn-1', 7 * MIN, null);

        const activity = readLastKnownActivity(db, IDENTITY, {now: NOW});

        expect(activity).toMatchObject({lastActivitySource: 'turn-presence', ageMs: 7 * MIN});
    });

    test('an outbound message is activity, whether the edge names the @-form or the bare login', () => {
        const db = createGraph();
        insertMemory(db, 'mem-1', 45 * MIN);
        insertOutboundMessage(db, 'msg-1', 20 * MIN);
        insertOutboundMessage(db, 'msg-2', 5 * MIN, {target: IDENTITY.slice(1)});

        const activity = readLastKnownActivity(db, IDENTITY, {now: NOW});

        expect(activity).toMatchObject({lastActivitySource: 'message', ageMs: 5 * MIN});
    });

    test('an identity without any stamp reads as never active', () => {
        const activity = readLastKnownActivity(createGraph(), IDENTITY, {now: NOW});

        expect(activity).toEqual({
            identity          : IDENTITY,
            lastActivityAt    : null,
            lastActivityAtMs  : null,
            lastActivitySource: null,
            ageMs             : null,
            lastMemoryAt      : null,
            lastMemoryAtMs    : null,
            lastMemoryAgeMs   : null,
            lastSessionId     : ''
        });
    });

    test('a legacy memory row carries its stamp in the name', () => {
        const db = createGraph();
        insertMemory(db, 'mem-legacy', 30 * MIN, {legacy: true});

        const activity = readLastKnownActivity(db, IDENTITY, {now: NOW});

        expect(activity).toMatchObject({lastActivitySource: 'memory', ageMs: 30 * MIN});
    });

    test('legacy and current rows are ordered by the same parsed time: an old legacy row never hides a fresh session', () => {
        // Compared as text, `Memory: 2026-10-01…` sorts above `2026-10-30…` by its prefix alone, and the
        // helper returned the month-old row with its empty session while a one-minute-old row existed.
        const db = createGraph();
        insertMemory(db, 'mem-legacy-old', 30 * 24 * 60 * MIN, {legacy: true});
        insertMemory(db, 'mem-fresh', 1 * MIN, {sessionId: 'session-fresh'});

        expect(readLastKnownActivity(db, IDENTITY, {now: NOW})).toMatchObject({
            lastActivitySource: 'memory', ageMs: 1 * MIN, lastMemoryAgeMs: 1 * MIN, lastSessionId: 'session-fresh'
        });

        // The other direction holds too: a legacy row newer than every modern row is the newest.
        insertMemory(db, 'mem-legacy-new', 0, {legacy: true});

        expect(readLastKnownActivity(db, IDENTITY, {now: NOW})).toMatchObject({ageMs: 0, lastSessionId: ''});
    });

    test('refuses to run without a database handle or an identity', () => {
        expect(() => readLastKnownActivity(null, IDENTITY)).toThrow('database handle');
        expect(() => readLastKnownActivity(createGraph(), '')).toThrow('agent identity');
    });
});

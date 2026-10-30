import {test, expect} from '@playwright/test';
import Database       from 'better-sqlite3';
import {
    DEFAULT_CONTEXT_GATE_MAX_TOKENS,
    DEFAULT_CONTEXT_GATE_WARN_TOKENS
} from '../../../../../../ai/daemons/wake/contextGatePolicy.mjs';
import {
    buildIdleOutPulseId,
    buildIdleOutPulseSummary,
    encodeIdleOutPulseId,
    findLaneStateLine,
    IDLE_OUT_PULSE_SOURCE,
    LANE_STATE_MAX_CHARS,
    readLastLaneStateLine
} from '../../../../../../ai/scripts/lifecycle/idleOutPulseSummary.mjs';

const IDENTITY = '@neo-pulse-test';
const NOW      = Date.parse('2026-10-30T20:00:00.000Z');
const MIN      = 60 * 1000;

function createGraph() {
    const db = new Database(':memory:');

    db.exec(`
        CREATE TABLE Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL);
        CREATE TABLE Edges (id TEXT PRIMARY KEY, user_id TEXT, source TEXT NOT NULL, target TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
    `);

    return db
}

function insertOutboundMessage(db, id, agoMs, {subject = 'subject', bodyText = 'body'} = {}) {
    db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, ?, ?)').run(id, IDENTITY, JSON.stringify({
        id, label: 'MESSAGE', type: 'MESSAGE',
        properties: {subject, bodyText, sentAt: new Date(NOW - agoMs).toISOString(), from: IDENTITY}
    }));
    db.prepare('INSERT INTO Edges (id, user_id, source, target, type, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run(`edge-${id}`, IDENTITY, id, IDENTITY, 'SENT_BY', JSON.stringify({type: 'SENT_BY'}));
}

function decode(pulseId) {
    return JSON.parse(Buffer.from(pulseId.slice(pulseId.indexOf('.') + 1), 'base64url').toString('utf8'))
}

test.describe('ai/scripts/lifecycle/idleOutPulseSummary', () => {
    test.describe('findLaneStateLine', () => {
        test('returns the first declaration in order, prefixed and trimmed', () => {
            const line = findLaneStateLine([
                'no declaration here',
                null,
                'body text\nlane-state:   next-lane (picking up #1380)  \nmore',
                'lane-state: older one'
            ]);

            expect(line).toBe('lane-state: next-lane (picking up #1380)');
        });

        test('bounds a long declaration', () => {
            const line = findLaneStateLine([`lane-state: ${'x'.repeat(400)}`]);

            expect(line.length).toBe(LANE_STATE_MAX_CHARS);
            expect(line.endsWith('…')).toBe(true);
        });

        test('returns null when no text declares a lane state', () => {
            expect(findLaneStateLine(['nothing', undefined, 'still nothing'])).toBeNull();
            expect(findLaneStateLine([])).toBeNull();
        });
    });

    test.describe('readLastLaneStateLine', () => {
        test('reads the newest outbound declaration, skipping newer messages without one', () => {
            const db = createGraph();
            insertOutboundMessage(db, 'msg-old',    60 * MIN, {bodyText: 'done.\nlane-state: in-progress (old lane)'});
            insertOutboundMessage(db, 'msg-mid',    30 * MIN, {bodyText: 'folded.\nlane-state: next-lane (the newest declared)'});
            insertOutboundMessage(db, 'msg-newest',  5 * MIN, {bodyText: 'a plain reply with no declaration'});

            expect(readLastLaneStateLine(db, IDENTITY)).toBe('lane-state: next-lane (the newest declared)');
        });

        test('a declaration in the subject counts, and an identity without messages reads null', () => {
            const db = createGraph();
            insertOutboundMessage(db, 'msg-subject', 10 * MIN, {subject: '[sunset] lane-state: parked (sunset)', bodyText: 'see subject'});

            expect(readLastLaneStateLine(db, IDENTITY)).toBe('lane-state: parked (sunset)');
            expect(readLastLaneStateLine(db, '@neo-nobody')).toBeNull();
        });
    });

    test.describe('buildIdleOutPulseSummary', () => {
        test('carries the idle minutes, the last activity stamp, the lane state and the gate-derived sunset rule', () => {
            const summary = buildIdleOutPulseSummary({
                identity          : IDENTITY,
                now               : NOW,
                lastActivityAtMs  : NOW - 34 * MIN,
                lastActivitySource: 'turn-presence',
                laneState         : 'lane-state: next-lane (#1380)'
            });

            expect(summary).toEqual({
                source            : IDLE_OUT_PULSE_SOURCE,
                reason            : 'idle: 34 min since the last known activity',
                nextAction        : 'run /post-review-pickup — own-PR changes, then requested reviews, then the next lane; answer in one line if nothing moved',
                laneState         : 'lane-state: next-lane (#1380)',
                idleMinutes       : 34,
                lastActivityAt    : new Date(NOW - 34 * MIN).toISOString(),
                lastActivitySource: 'turn-presence',
                sunsetRule        : `sunset at or below ${DEFAULT_CONTEXT_GATE_WARN_TOKENS / 1000}k tokens of context; wakes defer above ${DEFAULT_CONTEXT_GATE_MAX_TOKENS / 1000}k`
            });
        });

        test('an identity with no known activity says so instead of inventing a number', () => {
            const summary = buildIdleOutPulseSummary({identity: IDENTITY, now: NOW});

            expect(summary.reason).toBe(`idle: no known activity for ${IDENTITY}`);
            expect(summary.idleMinutes).toBeNull();
            expect(summary.lastActivityAt).toBeNull();
            expect(summary.laneState).toBeNull();
        });

        test('custom gate levels flow into the sunset rule', () => {
            const summary = buildIdleOutPulseSummary({identity: IDENTITY, now: NOW, warnContextTokens: 120_000, maxContextTokens: 150_000});

            expect(summary.sunsetRule).toBe('sunset at or below 120k tokens of context; wakes defer above 150k');
        });
    });

    test.describe('encodeIdleOutPulseId', () => {
        test('encodes as <source>.<base64url> without the colon the pulse entity id reserves, and decodes to the summary', () => {
            const summary = buildIdleOutPulseSummary({identity: IDENTITY, now: NOW, lastActivityAtMs: NOW - 31 * MIN, laneState: 'lane-state: a:b'});
            const pulseId = encodeIdleOutPulseId(summary);

            expect(pulseId.startsWith(`${IDLE_OUT_PULSE_SOURCE}.`)).toBe(true);
            expect(pulseId).not.toContain(':');
            expect(decode(pulseId)).toEqual(summary);
        });

        test('buildIdleOutPulseId builds and encodes in one step', () => {
            const pulseId = buildIdleOutPulseId({identity: IDENTITY, now: NOW, lastActivityAtMs: NOW - 40 * MIN});

            expect(decode(pulseId)).toMatchObject({source: IDLE_OUT_PULSE_SOURCE, idleMinutes: 40});
        });
    });
});

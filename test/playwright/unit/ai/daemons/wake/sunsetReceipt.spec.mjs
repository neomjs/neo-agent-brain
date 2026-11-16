import {test, expect} from '@playwright/test';
import Database       from 'better-sqlite3';
import {
    WRITER_STAMP_MAX_CHARS,
    readSunsetReceipt,
    writerStamp
} from '../../../../../../ai/daemons/wake/sunsetReceipt.mjs';
import {decideRotation} from '../../../../../../ai/daemons/wake/sessionRotation.mjs';

// The rotation slice's design histories, run through the real reader: synthetic ids,
// an in-memory Nodes table, the stored shapes the lane reads. `ago` is minutes before NOW; a fractional one is
// seconds (19 - 8 / 60 is eight seconds after 19 minutes ago).
const SEAT = '@seat', MIN = 60_000, WINDOW_MS = 180 * MIN, MIN_GAP_MS = 30 * MIN,
      NOW   = Date.parse('2026-11-16T05:00:00.000Z'),
      at    = ago => new Date(NOW - ago * MIN).toISOString(),
      SINCE = new Date(NOW - 2 * WINDOW_MS - MIN_GAP_MS).toISOString(),
      NONCE = '00000000-0000-4000-8000-000000000001';

const graph = () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL);');
    return db
};
const put      = (db, id, label, properties) => db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, ?, ?)').run(id, null, JSON.stringify({id, label, type: label, properties}));
const stamp    = (key, turn) => ({...(key ? {writerKey: key.includes(':') ? key : `v1:${key}`} : {}), ...(turn ? {writerTurn: turn} : {})});
const handover = (db, id, ago, {key, turn, origin, rotation} = {}) => put(db, `MESSAGE:${id}`, 'MESSAGE', {
    from: SEAT, to: SEAT, subject: '[sunset]', sentAt: at(ago), taggedConcepts: ['sunset-protocol-handover'],
    focusItemsReceipt: {named: 1, placed: 1}, ...(origin ? {originSessionId: origin} : {}), ...stamp(key, turn),
    ...(rotation ? {sessionRotation: rotation} : {})
});
const marker   = (db, id, ago, replyTo, key, turn) => put(db, `MESSAGE:${id}`, 'MESSAGE', {
    from: SEAT, to: SEAT, subject: '[sunset successor]', sentAt: at(ago), inReplyTo: `MESSAGE:${replyTo}`,
    taggedConcepts: ['sunset-successor'], ...stamp(key, turn)
});
const save     = (db, id, ago, session, key, turn) => put(db, `MEM:${id}`, 'AGENT_MEMORY', {
    agentIdentity: SEAT, userId: SEAT, timestamp: at(ago), sessionId: session, ...stamp(key, turn)
});
const interval = (db, turn, {started, progress = started, closed = false, wake = false}) => put(db, `AGENT_TURN_PRESENCE:${SEAT}:${turn}`, 'AGENT_TURN_PRESENCE', {
    agentIdentity: SEAT, turnId: turn, startedAt: at(started), lastProgressAt: at(progress),
    status: closed ? 'terminal' : 'active', terminalState: closed ? 'completed' : null,
    expiresAt: new Date(Date.parse(at(progress)) + 60 * MIN).toISOString(), ...(wake ? {wakeSubmitNonce: NONCE} : {})
});
// predecessor A wrote rA at -150; the plane requested at -149; its successor (key `succKey`) sent the marker at -140
const chain = (db, {aKey = 'kA', succKey = 'kB', stamped = true} = {}) => {
    const k = key => stamped ? key : null, t = turn => stamped ? turn : null;
    save(db, 'a1', 200, 'mcA', k(aKey), t('tA1'));
    handover(db, 'rA', 150, {key: k(aKey), turn: t('tA2'), origin: 'mcA', rotation: {
        state: 'completed', requestedAt: at(149), deliveredAt: at(149), completedAt: at(139), oldSessionId: 'mcA'
    }});
    save(db, 'a2', 149.9, 'mcA', k(aKey), t('tA2'));
    marker(db, 'mB', 140, 'rA', k(succKey), t('tB1'));
    save(db, 'b1', 120, 'mcB1', k(succKey), t('tB1'));
    save(db, 'b2', 60, 'mcB1', k(succKey), t('tB2'));
};
// B's sunset: handover rX at -20 in turn tB3, its save at -19 (session mcB2 = a reconnect after b2)
const sunsetB = (db, {origin = 'mcB2'} = {}) => {
    handover(db, 'rX', 20, {key: 'kB', turn: 'tB3', origin});
    save(db, 'bX', 19, origin, 'kB', 'tB3');
};

const verdictOf = db => {
    const verdict = decideRotation({read: readSunsetReceipt(db, SEAT, {sinceIso: SINCE, nowIso: at(0)}), now: NOW, windowMs: WINDOW_MS, minIntervalMs: MIN_GAP_MS});
    return verdict.reason ? `${verdict.action}: ${verdict.reason}` : verdict.action
};

const histories = [
    ['the marked successor sunsets after a Memory Core reconnect, beside an unexpired orphan', 'request', db => {
        chain(db); interval(db, 'orphan', {started: 30, progress: 26}); interval(db, 'tB3', {started: 25, progress: 19, closed: true}); sunsetB(db)
    }],
    ['the predecessor writes late; its save closes the successor\'s newer interval', 'wait: live-turn', db => {
        chain(db); interval(db, 'aLate', {started: 30, progress: 22}); interval(db, 'bWork', {started: 28, progress: 19, closed: true});
        handover(db, 'rX', 20, {key: 'kA', turn: 'tA3', origin: 'mcA2'}); save(db, 'aX', 19, 'mcA2', 'kA', 'tA3')
    }],
    ['no reconnect, the writer\'s interval closing 8 s after its save, beside an unexpired orphan', 'request', db => {
        chain(db); handover(db, 'rX', 20, {key: 'kB', turn: 'tB3', origin: 'mcB1'}); save(db, 'bX', 19, 'mcB1', 'kB', 'tB3');
        interval(db, 'tB3', {started: 25, progress: 19 - 8 / 60, closed: true}); interval(db, 'orphan', {started: 30, progress: 26})
    }],
    ['a hand-started S2 sunsets after the plane\'s successor S1', 'wait: writer-close-pending', db => {
        chain(db, {succKey: 'kS1'}); save(db, 's2a', 80, 'mcS2', 'kS2', 'tS1');
        handover(db, 'rX', 20, {key: 'kS2', turn: 'tS2', origin: 'mcS2b'}); save(db, 's2X', 19, 'mcS2b', 'kS2', 'tS2')
    }],
    ['S1 writes late after S2 took the seat by hand', 'wait: writer-close-pending', db => {
        chain(db, {succKey: 'kS1'}); save(db, 's2a', 80, 'mcS2', 'kS2', 'tS1');
        handover(db, 'rX', 20, {key: 'kS1', turn: 'tS1x', origin: 'mcS1b'}); save(db, 's1X', 19, 'mcS1b', 'kS1', 'tS1x')
    }],
    ['B sunsets while a third chat of the seat has written', 'wait: writer-close-pending', db => {
        chain(db); save(db, 'c1', 50, 'mcC', 'kC', 'tC1'); sunsetB(db)
    }],
    ['the third chat sunsets', 'wait: writer-close-pending', db => {
        chain(db); save(db, 'c1', 50, 'mcC', 'kC', 'tC1'); handover(db, 'rX', 20, {key: 'kC', turn: 'tC2', origin: 'mcC2'}); save(db, 'cX', 19, 'mcC2', 'kC', 'tC2')
    }],
    ['the receipt carries no stamp', 'wait: writer-close-pending', db => {
        chain(db); handover(db, 'rX', 20, {origin: 'mcB2'}); save(db, 'bX', 19, 'mcB2')
    }],
    ['the predecessor chain predates the stamps', 'wait: writer-close-pending', db => {
        chain(db, {stamped: false}); sunsetB(db)
    }],
    ['a first rotation with a reconnect before its save', 'request', db => {
        save(db, 'f1', 60, 'mcF1', 'kF', 'tF1'); handover(db, 'rX', 20, {key: 'kF', turn: 'tF2', origin: 'mcF2'}); save(db, 'fX', 19, 'mcF2', 'kF', 'tF2')
    }],
    ['B retries its handover after a lost response, then saves', 'request', db => {
        chain(db); handover(db, 'rX1', 21, {key: 'kB', turn: 'tB3', origin: 'mcB1'}); sunsetB(db)
    }],
    ['the key derivation changed before the predecessor\'s late write', 'wait: writer-close-pending', db => {
        chain(db); handover(db, 'rX', 20, {key: 'v2:kA', turn: 'tA3', origin: 'mcA2'}); save(db, 'aX', 19, 'mcA2', 'v2:kA', 'tA3')
    }],
    ['another seat\'s chat is not this seat\'s writer', 'request', db => {
        chain(db); put(db, 'MEM:other', 'AGENT_MEMORY', {agentIdentity: '@other', timestamp: at(30), sessionId: 'mcO', ...stamp('kO', 'tO1')}); sunsetB(db)
    }],
    ['control 1: B writes its handover, no save follows', 'wait: writer-close-pending', db => {
        chain(db); handover(db, 'rX', 20, {key: 'kB', turn: 'tB3', origin: 'mcB2'})
    }],
    ['control 2: B is live; a parallel chat writes a handover and saves', 'wait: live-turn', db => {
        chain(db); interval(db, 'bLive', {started: 40, progress: 5}); handover(db, 'rX', 20, {key: 'kC', turn: 'tC1', origin: 'mcC'}); save(db, 'cX', 19, 'mcC', 'kC', 'tC1')
    }],
    ['control 3: a prompt in B\'s chat starts a turn that supplies the only save', 'wait: live-turn', db => {
        chain(db); interval(db, 'orphan', {started: 45, progress: 30}); handover(db, 'rX', 20, {key: 'kB', turn: 'tB3', origin: 'mcB2'});
        interval(db, 'bNext', {started: 15, progress: 10}); save(db, 'bNextSave', 10, 'mcB2', 'kB', 'tB4')
    }],
    ['control 4: B closes its sunset turn, then a person starts a new turn in B\'s chat', 'refuse: prompted-after-receipt', db => {
        chain(db); sunsetB(db); interval(db, 'tB3', {started: 25, progress: 19, closed: true}); interval(db, 'tB4', {started: 18, progress: 5})
    }],
    ['control 5: an unstamped write of the seat since the marker, beside a live interval', 'wait: live-turn', db => {
        chain(db); save(db, 'unknown', 30, 'mcU'); interval(db, 'live', {started: 32, progress: 4}); sunsetB(db)
    }],
    ['control 6: a later turn saves while its presence was lost', 'refuse: prompted-after-receipt', db => {
        chain(db); interval(db, 'orphan', {started: 45, progress: 10, closed: true}); sunsetB(db); save(db, 'bNext', 10, 'mcB2', 'kB', 'tB4')
    }],
    ['control 7: an open pre-receipt interval progresses after the close', 'refuse: prompted-after-receipt', db => {
        chain(db); interval(db, 'tOther', {started: 32, progress: 4}); sunsetB(db); interval(db, 'tB3', {started: 25, progress: 19, closed: true})
    }],
    ['control 8: a typed wake in B\'s reconnected chat saves after the close', 'request', db => {
        chain(db); sunsetB(db); interval(db, 'tB3', {started: 25, progress: 19, closed: true});
        interval(db, 'tB4', {started: 12, progress: 10, closed: true, wake: true}); save(db, 'bWake', 10, 'mcB2', 'kB', 'tB4')
    }],
    ['control 9: control 8 without the reconnect', 'request', db => {
        chain(db); sunsetB(db, {origin: 'mcB1'}); interval(db, 'tB3', {started: 25, progress: 19, closed: true});
        interval(db, 'tB4', {started: 12, progress: 10, closed: true, wake: true}); save(db, 'bWake', 10, 'mcB1', 'kB', 'tB4')
    }],
    ['control 10: a pre-receipt interval progresses after the close, then ends', 'refuse: prompted-after-receipt', db => {
        chain(db); interval(db, 'tOther', {started: 32, progress: 4, closed: true}); sunsetB(db); interval(db, 'tB3', {started: 25, progress: 19, closed: true})
    }],
    ['Clio\'s shape: the sunset continues a turn an earlier save closed', 'request', db => {
        chain(db); interval(db, 'tB3', {started: 25, progress: 22.5, closed: true}); save(db, 'bEarlier', 22.5, 'mcB2', 'kB', 'tB3');
        handover(db, 'rX', 20, {key: 'kB', turn: 'tB3', origin: 'mcB2'}); save(db, 'bX', 19.5, 'mcB2', 'kB', 'tB3')
    }],
    ['Clio\'s shape: a new prompt whose presence start was lost', 'request', db => {
        chain(db); interval(db, 'tB3', {started: 25, progress: 22.5, closed: true}); save(db, 'bEarlier', 22.5, 'mcB2', 'kB', 'tB3');
        handover(db, 'rX', 20, {key: 'kB', turn: 'tB4', origin: 'mcB2'}); save(db, 'bX', 19.5, 'mcB2', 'kB', 'tB4')
    }],
    ['the writer\'s own interval is still open after its same-turn save', 'request', db => {
        chain(db); interval(db, 'tB3', {started: 25, progress: 18.9}); sunsetB(db)
    }],
    ['a parallel chat ticked during the sunset turn, is still open, no tick since', 'wait: live-turn', db => {
        chain(db); interval(db, 'tB3', {started: 25, progress: 19, closed: true}); interval(db, 'tOther', {started: 22, progress: 20.5}); sunsetB(db)
    }],
    ['Grace\'s founding shape: an unexpired orphan from an earlier, saveless turn', 'request', db => {
        chain(db); interval(db, 'tShort', {started: 26.5, progress: 26.25}); interval(db, 'tB3', {started: 26, progress: 19, closed: true}); sunsetB(db)
    }],
    // a first rotation, so no marker rule intervenes: the later unstamped write must read as a prompt
    ['an unstamped write never matches a wake row missing its turn id', 'refuse: prompted-after-receipt', db => {
        save(db, 'f1', 60, 'mcF', 'kF', 'tF1'); handover(db, 'rX', 20, {key: 'kF', turn: 'tF2', origin: 'mcF'}); save(db, 'fX', 19, 'mcF', 'kF', 'tF2');
        interval(db, 'tF2', {started: 25, progress: 19, closed: true});
        put(db, `AGENT_TURN_PRESENCE:${SEAT}:noTurn`, 'AGENT_TURN_PRESENCE', {agentIdentity: SEAT, startedAt: at(25), lastProgressAt: at(25),
            status: 'terminal', expiresAt: at(-35), wakeSubmitNonce: NONCE});
        put(db, 'MEM:late', 'AGENT_MEMORY', {agentIdentity: SEAT, userId: SEAT, timestamp: at(10), sessionId: 'mcF'})
    }]
];

test.describe('ai/daemons/wake/sunsetReceipt — the writer stamp', () => {
    test('keeps a short non-empty string stamp and drops anything else', () => {
        expect(writerStamp({writerKey: 'v1:k', writerTurn: 't'})).toEqual({writerKey: 'v1:k', writerTurn: 't'});
        expect(writerStamp({writerKey: '', writerTurn: 7})).toEqual({});
        expect(writerStamp({writerKey: 'x'.repeat(WRITER_STAMP_MAX_CHARS + 1), writerTurn: 't'})).toEqual({writerTurn: 't'});
        expect(writerStamp()).toEqual({});
    });

    for (const [name, want, build] of histories) {
        test(name, () => {
            const db = graph();
            build(db);
            expect(verdictOf(db)).toBe(want);
            db.close();
        });
    }
});

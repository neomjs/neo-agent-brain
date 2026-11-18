import {setup} from '../../../../../setup.mjs';

const appName = 'SessionRotationLaneTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}         from '@playwright/test';
import crypto                 from 'node:crypto';
import fs                     from 'node:fs/promises';
import os                     from 'node:os';
import path                   from 'node:path';
import Database               from 'better-sqlite3';
import Neo                    from 'neo.mjs/src/Neo.mjs';
import * as core              from 'neo.mjs/src/core/_export.mjs';
import GraphService           from '../../../../../../../ai/services/memory-core/GraphService.mjs';
import WebhookDeliveryService from '../../../../../../../ai/services/memory-core/WebhookDeliveryService.mjs';
import {Orchestrator}         from '../../../../../../../ai/daemons/orchestrator/Orchestrator.mjs';
import {TASK_REGISTRY}        from '../../../../../../../ai/daemons/orchestrator/scheduling/registry.mjs';
import {runSessionRotation}   from '../../../../../../../ai/daemons/orchestrator/scheduling/sessionRotation.mjs';
import {executeCandidate}     from '../../../../../../../ai/daemons/orchestrator/scheduling/pipeline.mjs';
import {readSunsetReceipt}    from '../../../../../../../ai/daemons/wake/sunsetReceipt.mjs';
import {
    ORCHESTRATOR_AUTHORITY_CLASS,
    getTaskAuthorityClass
} from '../../../../../../../ai/daemons/orchestrator/taskAuthority.mjs';
import {
    SESSION_ROTATE_EVENT_TYPE,
    buildRotationPrompt,
    decideRotation,
    holdsWakes,
    rotationEventId
} from '../../../../../../../ai/daemons/wake/sessionRotation.mjs';
import {createWakeReceiver} from '../../../../../../../ai/daemons/wake/receiver.mjs';
import {WakeReceiverState}  from '../../../../../../../ai/daemons/wake/receiverState.mjs';
import {parseDefectNote}    from '../../../../../../../ai/services/memory-core/helpers/defectObservationFold.mjs';

/**
 * @summary Unit coverage for the `session-rotation` lane: a seat's sunset handover becomes
 * one signed `session/rotate` request to its `SESSION_ROTATE` route, the guards refuse it with a
 * recorded reason, and the plane holds the seat's wakes while the receipt waits.
 */

const LANE       = 'session-rotation';
const SEAT       = '@neo-rotation-seat';
const MIN        = 60 * 1000;
const WINDOW_MS  = 3 * 60 * MIN;
const MIN_GAP_MS = 30 * MIN;
const NOW        = Date.parse('2026-11-13T22:00:00.000Z');
const descriptor = TASK_REGISTRY.find(entry => entry.taskName === LANE);
const at         = minutesAgo => new Date(NOW - minutesAgo * MIN).toISOString();

/**
 * @summary A graph with the two tables the lane touches, in memory.
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
    db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, ?, ?)').run(id, null, JSON.stringify({id, label, type: label, properties}))
}

function insertRoute(db, {identity = SEAT, id = 'WAKE_SUB:rotate', url = 'http://127.0.0.1:9/wake', signingKey = 'k'.repeat(64)} = {}) {
    insertNode(db, id, 'WAKE_SUBSCRIPTION', {
        agentIdentity        : identity, trigger: 'SESSION_ROTATE', status: 'active', harnessTarget: 'a2a-webhook',
        harnessTargetMetadata: {adapter: 'osascript', appName: 'Claude', url, signingKey}
    })
}

function insertSelfMessage(db, id, minutesAgo, {identity = SEAT, handover = true, focusItemsReceipt = {named: 2, placed: 2}, sessionRotation} = {}) {
    insertNode(db, id, 'MESSAGE', {
        from          : identity, to: identity, subject: handover ? '[sunset]' : '[sunset-rescinded]', sentAt: at(minutesAgo),
        taggedConcepts: handover ? ['sunset-protocol-handover'] : ['sunset-rescinded'],
        ...(focusItemsReceipt === 'unconsumed' ? {} : {focusItemsReceipt}),
        ...(sessionRotation ? {sessionRotation} : {})
    })
}

// The live shape of a successor marker (Vega's MESSAGE:8a2e1490, replying to her handover MESSAGE:a55cc803).
function insertSuccessor(db, id, minutesAgo, inReplyTo, identity = SEAT) {
    insertNode(db, id, 'MESSAGE', {
        from          : identity, to: identity, subject: '[sunset successor]', sentAt: at(minutesAgo), inReplyTo,
        taggedConcepts: ['sunset-successor'], wakeSuppressed: true
    })
}

function insertMemory(db, id, minutesAgo, sessionId, identity = SEAT) {
    insertNode(db, id, 'AGENT_MEMORY', {agentIdentity: identity, userId: identity, timestamp: at(minutesAgo), sessionId})
}

function insertTurn(db, turnId, minutesAgo, {identity = SEAT, wakeSubmitNonce} = {}) {
    insertNode(db, `AGENT_TURN_PRESENCE:${identity}:${turnId}`, 'AGENT_TURN_PRESENCE', {
        agentIdentity: identity, turnId, startedAt: at(minutesAgo), status: 'active', ...(wakeSubmitNonce ? {wakeSubmitNonce} : {})
    })
}

// The stored interval shape: every event rewrites `lastProgressAt`, and only a close sets `terminal`.
function insertInterval(db, turnId, {startedAgo, progressAgo = startedAgo, closed = false, expiresIn = 60}) {
    insertNode(db, `AGENT_TURN_PRESENCE:${SEAT}:${turnId}`, 'AGENT_TURN_PRESENCE', {
        agentIdentity: SEAT, turnId, startedAt: at(startedAgo), lastProgressAt: at(progressAgo),
        status       : closed ? 'terminal' : 'active', terminalState: closed ? 'completed' : null, expiresAt: at(-expiresIn)
    })
}

function insertDirectMessage(db, id, minutesAgo, to = SEAT) {
    insertNode(db, id, 'MESSAGE', {from: '@neo-peer', to, subject: 'a review request', sentAt: at(minutesAgo), taggedConcepts: []});
    db.prepare('INSERT INTO Edges (id, user_id, source, target, type, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run(`edge-${id}`, null, id, to, 'SENT_TO', JSON.stringify({id: `edge-${id}`, source: id, target: to, type: 'SENT_TO'}))
}

const rotationOf = (db, id) => JSON.parse(db.prepare('SELECT data FROM Nodes WHERE id = ?').get(id).data).properties.sessionRotation;

/**
 * @summary One lane pass over `db` with a recording sender and defect-note publisher.
 * @returns {Promise<{outcome: Object, sent: Object[], logs: Object[], notes: Object[]}>}
 */
async function runLane(db, {now = NOW, delivery = 'delivered', operatorPresence = {mode: 'present', until: null}, publishDefectNote, waitsLogged} = {}) {
    const sent    = [], logs = [], notes = [];
    const outcome = await runSessionRotation({
        db,
        deliver          : async (subscription, envelope) => { sent.push({subscription, envelope}); return delivery },
        operatorPresence,
        windowMs         : WINDOW_MS,
        minIntervalMs    : MIN_GAP_MS,
        writeLog         : (level, message) => logs.push({level, message}),
        publishDefectNote: publishDefectNote || (async note => { notes.push(note) }),
        waitsLogged,
        now
    });

    return {outcome, sent, logs, notes}
}

test.describe('session-rotation lane (#1383)', () => {
    test('AC-3 + AC-8: a handover, no prompt since and a consumed count → exactly one request, and the next pass sends nothing', async () => {
        const db = createGraph();

        insertRoute(db);
        insertMemory(db, 'mem-old', 12, 'session-old');
        insertSelfMessage(db, 'MESSAGE:receipt', 10);
        insertTurn(db, 'sunset-turn', 20); // the turn that wrote the handover started before it

        const first = await runLane(db);

        expect(first.outcome).toMatchObject({requested: 1, refused: 0});
        expect(first.sent).toHaveLength(1);
        expect(first.sent[0].envelope).toMatchObject({
            schemaVersion : '1.0',
            eventType     : SESSION_ROTATE_EVENT_TYPE,
            eventId       : rotationEventId('MESSAGE:receipt'),
            subscriptionId: 'WAKE_SUB:rotate',
            agentIdentity : SEAT,
            payload       : {
                receiptMessageId: 'MESSAGE:receipt', oldSessionId: 'session-old', reason: 'sunset_restart',
                // The plane's hold travels with the request, so a receiver behind a locked screen never
                // types after it.
                holdUntil       : new Date(Date.parse(at(10)) + WINDOW_MS).toISOString()
            }
        });
        expect(first.notes).toEqual([]);
        expect(rotationOf(db, 'MESSAGE:receipt')).toMatchObject({
            state: 'requested', eventId: rotationEventId('MESSAGE:receipt'), oldSessionId: 'session-old', deliveredAt: at(0)
        });

        const second = await runLane(db, {now: NOW + MIN});

        expect(second.sent).toEqual([]);
        expect(second.outcome).toMatchObject({requested: 0, waiting: 1})
    });

    test('AC-8: a turn still live from before the receipt waits, and the request goes once it is closed or expired', async () => {
        const db = createGraph();

        insertRoute(db);
        insertSelfMessage(db, 'MESSAGE:receipt', 2);
        insertNode(db, `AGENT_TURN_PRESENCE:${SEAT}:sunset-turn`, 'AGENT_TURN_PRESENCE', {
            agentIdentity: SEAT, turnId: 'sunset-turn', startedAt: at(15), status: 'active', expiresAt: at(-20)
        });

        expect((await runLane(db)).outcome).toMatchObject({requested: 0, waiting: 1});
        expect((await runLane(db, {now: NOW + 21 * MIN})).sent).toHaveLength(1)
    });

    test('AC-9: the newest self-message decides, so a note after the handover turns the rotation off', async () => {
        const db = createGraph();

        insertRoute(db);
        insertSelfMessage(db, 'MESSAGE:receipt', 30);
        insertSelfMessage(db, 'MESSAGE:rescinded', 5, {handover: false});

        const {outcome, sent} = await runLane(db);

        expect(sent).toEqual([]);
        expect(outcome).toEqual({requested: 0, completed: 0, refused: 0, incomplete: 0, waiting: 0});
        expect(rotationOf(db, 'MESSAGE:receipt')).toBeUndefined()
    });

    test('#1712 AC-1: a Memory Core id that changes inside the old transcript neither holds back the request nor completes it (Clio\'s three ids)', async () => {
        const db = createGraph();

        insertRoute(db);
        insertMemory(db, 'mem-c3373e53', 14, 'c3373e53');
        insertSelfMessage(db, 'MESSAGE:receipt', 10);
        insertMemory(db, 'mem-3c9a08d0', 10 - 19 / 60, '3c9a08d0'); // the sunset turn's own diary, 19 s after the receipt

        expect(holdsWakes({read: readSunsetReceipt(db, SEAT, {sinceIso: at(WINDOW_MS / MIN)}), hasRotationRoute: true, now: NOW, windowMs: WINDOW_MS})).toBe(true);
        expect((await runLane(db)).sent).toHaveLength(1);
        expect(rotationOf(db, 'MESSAGE:receipt')).toMatchObject({state: 'requested', oldSessionId: 'c3373e53'});

        insertMemory(db, 'mem-9ed19770', 3, '9ed19770'); // a turn woken later in the same transcript

        expect((await runLane(db, {now: NOW + MIN})).outcome).toMatchObject({completed: 0, waiting: 1});
        expect(rotationOf(db, 'MESSAGE:receipt').state).toBe('requested')
    });

    test('#1712 AC-2: a marker replying to the receipt refuses a rotation not yet requested; one replying to another message changes nothing', async () => {
        const answered = createGraph();

        insertRoute(answered);
        insertSelfMessage(answered, 'MESSAGE:receipt', 10);
        insertSuccessor(answered, 'MESSAGE:successor', 4, 'receipt'); // a bare id names the same message

        expect((await runLane(answered)).sent).toEqual([]);
        expect(rotationOf(answered, 'MESSAGE:receipt')).toMatchObject({state: 'refused', reason: 'successor-present'});

        const elsewhere = createGraph();

        insertRoute(elsewhere);
        insertSelfMessage(elsewhere, 'MESSAGE:receipt', 10);
        insertSuccessor(elsewhere, 'MESSAGE:other-successor', 4, 'MESSAGE:an-older-handover');

        expect((await runLane(elsewhere)).sent).toHaveLength(1)
    });

    test('#1712 AC-3: a successor marker never switches its receipt off as the newest self-message; a rescinding note still does', () => {
        const db   = createGraph(),
              read = () => readSunsetReceipt(db, SEAT, {sinceIso: at(WINDOW_MS / MIN)});

        insertSelfMessage(db, 'MESSAGE:receipt', 10);
        insertSuccessor(db, 'MESSAGE:successor', 4, 'MESSAGE:receipt');

        expect(read()).toMatchObject({receipt: {id: 'MESSAGE:receipt'}, successor: {id: 'MESSAGE:successor', sentAt: at(4)}});

        insertSelfMessage(db, 'MESSAGE:rescinded', 2, {handover: false});

        expect(read()).toBeNull()
    });

    test('AC-7: a prompt after the receipt refuses it; with no prompt since, the request goes whether the operator is present or away', async () => {
        const prompted = createGraph();

        insertRoute(prompted);
        insertSelfMessage(prompted, 'MESSAGE:receipt', 10);
        insertTurn(prompted, 'operator-turn', 3);

        const refused = await runLane(prompted);

        expect(refused.sent).toEqual([]);
        expect(rotationOf(prompted, 'MESSAGE:receipt')).toMatchObject({state: 'refused', reason: 'prompted-after-receipt'});

        for (const operatorPresence of [{mode: 'present', until: null}, {mode: 'away', until: '2026-11-14T08:00:00.000Z'}]) {
            const db = createGraph();

            insertRoute(db);
            insertSelfMessage(db, 'MESSAGE:receipt', 10);

            const {sent} = await runLane(db, {operatorPresence});

            expect(sent).toHaveLength(1)
        }
    });

    test('AC-10: wakes after the receipt do not refuse it — five direct messages and a typed wake turn, and the request still goes', async () => {
        const db = createGraph();

        insertRoute(db);
        insertMemory(db, 'mem-old', 60, 'session-old');
        insertSelfMessage(db, 'MESSAGE:receipt', 49);

        for (let i = 0; i < 5; i++) insertDirectMessage(db, `MESSAGE:wake-${i}`, 45 - i * 8);

        insertTurn(db, 'typed-wake', 20, {wakeSubmitNonce: crypto.randomUUID()});

        const {sent} = await runLane(db);

        expect(sent).toHaveLength(1)
    });

    test('AC-5: a second request of one seat inside the minimum interval is refused with its reason; 42 minutes apart passes', async () => {
        const tooSoon = createGraph();

        insertRoute(tooSoon);
        insertSelfMessage(tooSoon, 'MESSAGE:first', 20, {sessionRotation: {state: 'completed', requestedAt: at(19)}});
        insertSelfMessage(tooSoon, 'MESSAGE:second', 5);

        const refused = await runLane(tooSoon);

        expect(refused.sent).toEqual([]);
        expect(refused.notes).toEqual([]);
        expect(rotationOf(tooSoon, 'MESSAGE:second')).toMatchObject({state: 'refused', reason: 'minimum-interval', nextEligibleAt: at(19 - 30)});
        expect(refused.logs.some(({message}) => message.includes('minimum-interval'))).toBe(true);

        const apart = createGraph();

        insertRoute(apart);
        insertSelfMessage(apart, 'MESSAGE:first', 43, {sessionRotation: {state: 'completed', requestedAt: at(42)}});
        insertSelfMessage(apart, 'MESSAGE:second', 1);

        expect((await runLane(apart)).sent).toHaveLength(1)
    });

    test('AC-6: the first prompt carries the seat, /context-recovery, the operator\'s mode and the handover id', () => {
        const away    = buildRotationPrompt({agentIdentity: SEAT, receiptMessageId: 'MESSAGE:receipt', operatorPresence: {mode: 'away', until: '2026-11-14T08:00:00.000Z'}}),
              present = buildRotationPrompt({agentIdentity: SEAT, receiptMessageId: 'MESSAGE:receipt', operatorPresence: {mode: 'present', until: null}});

        expect(away.startsWith('/context-recovery ')).toBe(true);

        for (const part of [SEAT, 'MESSAGE:receipt', 'away until 2026-11-14T08:00:00.000Z']) expect(away).toContain(part);

        // the fresh session learns the marker that completes its rotation from the prompt itself
        for (const part of ['[sunset successor]', 'tagged sunset-successor', 'inReplyTo MESSAGE:receipt']) expect(present).toContain(part);

        expect(present).toContain('The operator is present.')
    });

    test('the receipt count (#1401): an unstamped receipt reads its count from its subject, so a deferred summary lane holds nothing (Vega\'s 02:23:24Z sunset)', async () => {
        const read    = db => readSunsetReceipt(db, SEAT, {sinceIso: at(WINDOW_MS / MIN)}),
              counted = createGraph();

        insertRoute(counted);
        insertNode(counted, 'MESSAGE:receipt', 'MESSAGE', {
            from: SEAT, to: SEAT, subject: '[sunset · focus items: 6, 6 placed]', sentAt: at(10), taggedConcepts: ['sunset-protocol-handover']
        });

        expect(read(counted).receipt.focusItemsReceipt).toEqual({named: 6, placed: 6});
        expect((await runLane(counted)).sent).toHaveLength(1);

        const uncounted = createGraph();

        insertRoute(uncounted);
        insertSelfMessage(uncounted, 'MESSAGE:receipt', 10, {focusItemsReceipt: 'unconsumed'}); // subject `[sunset]`, no stamp

        expect(read(uncounted).receipt.focusItemsReceipt).toBe('missing');
        expect((await runLane(uncounted)).sent).toHaveLength(1);

        const stamped = createGraph();

        insertRoute(stamped);
        insertSelfMessage(stamped, 'MESSAGE:receipt', 10, {focusItemsReceipt: {named: 2, placed: 2}}); // the lane's stamp wins

        expect(read(stamped).receipt.focusItemsReceipt).toEqual({named: 2, placed: 2})
    });

    test('AC-11 + #1712 AC-2: the earliest marker after the request completes the rotation with the marker, the old id and the messages the hold kept', async () => {
        const db = createGraph();

        insertRoute(db);
        insertMemory(db, 'mem-old', 40, 'session-old');
        insertSelfMessage(db, 'MESSAGE:receipt', 30, {sessionRotation: {
            state       : 'requested', eventId: rotationEventId('MESSAGE:receipt'), subscriptionId: 'WAKE_SUB:rotate',
            oldSessionId: 'session-old', requestedAt: at(29), deliveredAt: at(29)
        }});
        insertDirectMessage(db, 'MESSAGE:held-1', 20);
        insertDirectMessage(db, 'MESSAGE:held-2', 12);
        insertSuccessor(db, 'MESSAGE:successor', 8, 'MESSAGE:receipt');
        insertSuccessor(db, 'MESSAGE:successor-again', 7, 'MESSAGE:receipt');
        insertMemory(db, 'mem-resumed', 6, 'session-old-resumed'); // the first memory after the marker is the old transcript's, resumed
        insertMemory(db, 'mem-fresh', 5, 'session-fresh');
        insertDirectMessage(db, 'MESSAGE:after', 2);

        const {outcome, sent, logs, notes} = await runLane(db);

        expect(sent).toEqual([]);
        expect(notes).toEqual([]);
        expect(outcome.completed).toBe(1);
        // a marker names no sender session, so no memory after it is attributed to the successor
        expect(rotationOf(db, 'MESSAGE:receipt')).toMatchObject({
            state: 'completed', successorMessageId: 'MESSAGE:successor', oldSessionId: 'session-old', newSessionId: null, heldMessages: 2
        });
        expect(logs.some(({level, message}) => level === 'INFO' && message.includes('session-old → successor MESSAGE:successor'))).toBe(true)
    });

    test('AC-12: a rotation open past its window is recorded incomplete and requests nothing else', async () => {
        const db = createGraph();

        insertRoute(db);
        insertSelfMessage(db, 'MESSAGE:receipt', 181, {sessionRotation: {
            state: 'requested', eventId: rotationEventId('MESSAGE:receipt'), requestedAt: at(180), deliveredAt: at(180)
        }});

        const {outcome, sent, logs, notes} = await runLane(db);

        expect(sent).toEqual([]);
        expect(outcome.incomplete).toBe(1);
        expect(rotationOf(db, 'MESSAGE:receipt')).toMatchObject({state: 'incomplete', reason: 'no-fresh-session'});
        expect(logs.some(({level}) => level === 'ERROR')).toBe(true);

        // The plane cannot read the receiver's records, so this note is the failure's only voice.
        expect(notes).toHaveLength(1);
        // The plane knows only that no successor marker came, so the note says that and nothing more.
        expect(notes[0].subject).toBe(`defect-note: session rotation broke ${SEAT}: no successor marker within 180 min of its sunset handover MESSAGE:receipt`);
        expect(parseDefectNote(notes[0].subject)).toMatchObject({parseable: true, surface: 'session rotation'});
        // A session may have opened without its marker, or the released wake may have resumed the old one: the
        // seat's window is checked before a second one starts.
        expect(notes[0].body).toContain('Check the seat\'s window first. A session working there needs no second one: a fresh one, or the old one a released wake resumed, which writes `[sunset rescinded]`.');
        // A hand start says it was one, never that the plane opened the session.
        expect(notes[0].body).toContain(`/context-recovery Fresh session for ${SEAT}, started by hand after your sunset handover MESSAGE:receipt`);
        expect(notes[0].body).not.toMatch(/opened by the plane|opened none/);
        expect(notes[0].taggedConcepts).toEqual(['defect-note', 'session-rotation']);

        const next = await runLane(db, {now: NOW + MIN});

        expect(next.outcome).toEqual({requested: 0, completed: 0, refused: 0, incomplete: 0, waiting: 0});
        expect(next.notes).toEqual([])
    });

    test('#1770: a note that fails to publish is logged, and the incomplete record still stands', async () => {
        const db = createGraph();

        insertRoute(db);
        insertSelfMessage(db, 'MESSAGE:receipt', 181, {sessionRotation: {
            state: 'requested', eventId: rotationEventId('MESSAGE:receipt'), requestedAt: at(180), deliveredAt: at(180)
        }});

        const {outcome, logs} = await runLane(db, {publishDefectNote: async () => { throw new Error('mailbox unavailable') }});

        expect(outcome.incomplete).toBe(1);
        expect(rotationOf(db, 'MESSAGE:receipt')).toMatchObject({state: 'incomplete', reason: 'no-fresh-session'});
        expect(logs.some(({level, message}) => level === 'WARN' && message.includes('mailbox unavailable'))).toBe(true)
    });

    test('a send the receiver never accepted goes again under the same event id, and the id was on the receipt before the first send', async () => {
        const db = createGraph();

        insertRoute(db);
        insertSelfMessage(db, 'MESSAGE:receipt', 10);

        const failed = await runLane(db, {delivery: 'failed'});

        expect(rotationOf(db, 'MESSAGE:receipt')).toMatchObject({state: 'requested', lastDelivery: 'failed'});
        expect(rotationOf(db, 'MESSAGE:receipt').deliveredAt).toBeUndefined();

        const retried = await runLane(db, {now: NOW + MIN});

        expect(retried.sent[0].envelope.eventId).toBe(failed.sent[0].envelope.eventId);
        expect(rotationOf(db, 'MESSAGE:receipt')).toMatchObject({requestedAt: at(0), deliveredAt: new Date(NOW + MIN).toISOString()})
    });

    test('a prompt after a send the receiver never accepted refuses the re-send, and the record keeps its event id and its failed attempt', async () => {
        const db = createGraph();

        insertRoute(db);
        insertSelfMessage(db, 'MESSAGE:receipt', 10);

        const failed = await runLane(db, {delivery: 'failed'});

        insertTurn(db, 'person-at-the-old-session', -0.5); // typed after the failed send, no wake nonce

        const retried = await runLane(db, {now: NOW + MIN});

        expect(retried.sent).toEqual([]);
        expect(retried.outcome).toMatchObject({requested: 0, refused: 1});
        expect(rotationOf(db, 'MESSAGE:receipt')).toMatchObject({
            state: 'refused', reason: 'prompted-after-receipt', eventId: failed.sent[0].envelope.eventId, lastDelivery: 'failed'
        });
        expect((await runLane(db, {now: NOW + 2 * MIN})).sent).toEqual([])
    });

    test('a turn live after a send the receiver never accepted holds the re-send, which goes under the same event id once the turn ends', async () => {
        const db = createGraph();

        insertRoute(db);
        insertSelfMessage(db, 'MESSAGE:receipt', 10);

        const failed = await runLane(db, {delivery: 'failed'});

        insertNode(db, `AGENT_TURN_PRESENCE:${SEAT}:sunset-turn`, 'AGENT_TURN_PRESENCE', {
            agentIdentity: SEAT, turnId: 'sunset-turn', startedAt: at(15), status: 'active', expiresAt: at(-20)
        });

        const held = await runLane(db, {now: NOW + MIN});

        expect(held.sent).toEqual([]);
        expect(held.outcome).toMatchObject({requested: 0, waiting: 1});

        const retried = await runLane(db, {now: NOW + 21 * MIN});

        expect(retried.sent).toHaveLength(1);
        expect(retried.sent[0].envelope.eventId).toBe(failed.sent[0].envelope.eventId)
    });

    test('the wake hold: an open receipt with a rotation route inside its window, released by a prompt, a settlement or the window', () => {
        const db = createGraph();

        insertSelfMessage(db, 'MESSAGE:receipt', 10);

        const read  = () => readSunsetReceipt(db, SEAT, {sinceIso: at(WINDOW_MS / MIN)}),
              holds = (overrides = {}) => holdsWakes({read: read(), hasRotationRoute: true, now: NOW, windowMs: WINDOW_MS, ...overrides});

        expect(holds()).toBe(true);
        expect(holds({hasRotationRoute: false})).toBe(false);
        expect(holds({now: NOW + WINDOW_MS})).toBe(false);

        insertTurn(db, 'fresh-session', 1);

        expect(holds()).toBe(false);
        expect(decideRotation({read: null, now: NOW, windowMs: WINDOW_MS, minIntervalMs: MIN_GAP_MS})).toEqual({action: 'none'})
    });

    test('the lane is container-plane work, due once per cadence and off at a cadence of 0', () => {
        expect(getTaskAuthorityClass(LANE)).toBe(ORCHESTRATOR_AUTHORITY_CLASS.containerPlane);
        expect(descriptor).toMatchObject({executionKind: 'in-process-async', maintenanceClass: 'lightweight-signal', backpressure: 'none'});

        const due = ({lastRunAt, now, cadence = MIN}) => descriptor.getDueTask({
            state    : lastRunAt === undefined ? {} : {[LANE]: {lastRunAt}},
            now,
            intervals: {sessionRotation: cadence}
        });

        expect(due({now: NOW})).toMatchObject({taskName: LANE, reason: `periodic-session-rotation:${MIN}`});
        expect(due({lastRunAt: NOW, now: NOW + MIN - 1})).toBeNull();
        expect(due({now: NOW, cadence: 0})).toBeNull()
    });

    test('Orchestrator#rotateSunsetSessions throws without a graph, so the lane records a failed run', async () => {
        await GraphService.ready();

        const graph = GraphService.db;
        GraphService.db = null;

        try {
            await expect(Orchestrator.prototype.rotateSunsetSessions.call({writeLog() {}}))
                .rejects.toThrow('[Orchestrator.rotateSunsetSessions] GraphService unavailable')
        } finally {
            GraphService.db = graph
        }
    });

    test('end to end: the lane signs one envelope the live receiver admits on the seat\'s rotation route, and records the run', async () => {
        await GraphService.ready();

        const signingKey = 'c'.repeat(64),
              stateDir   = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-rotation-lane-')),
              state      = new WakeReceiverState({stateDir}),
              dispatched = [],
              seat       = '@neo-rotation-e2e',
              sqlite     = GraphService.db.storage.db,
              ids        = ['WAKE_SUB:rotation-e2e', 'MESSAGE:rotation-e2e-receipt'];

        await state.init();

        const receiver = createWakeReceiver({
            manifest: {schemaVersion: 1, routes: {'WAKE_SUB:rotation-e2e': {
                signingKey,
                agentIdentity        : seat,
                admits               : SESSION_ROTATE_EVENT_TYPE,
                harnessTargetMetadata: {adapter: 'osascript', appName: 'Claude', addressType: 'userDataDir', instanceAddress: '/seats/e2e'},
                adapterConfig        : {attemptTimeoutMs: 100}
            }}},
            state,
            dispatch        : async record => { dispatched.push(record); return 'delivered' },
            logger          : {error() {}, warn() {}, log() {}},
            readScreenLocked: () => false
        });

        await new Promise(resolve => receiver.server.listen(0, '127.0.0.1', resolve));

        const url = `http://127.0.0.1:${receiver.server.address().port}/wake`;

        insertRoute(sqlite, {identity: seat, id: 'WAKE_SUB:rotation-e2e', url, signingKey});
        sqlite.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, ?, ?)').run('MESSAGE:rotation-e2e-receipt', null, JSON.stringify({
            id        : 'MESSAGE:rotation-e2e-receipt', label: 'MESSAGE', type: 'MESSAGE',
            properties: {from: seat, to: seat, sentAt: new Date(Date.now() - MIN).toISOString(), taggedConcepts: ['sunset-protocol-handover'], focusItemsReceipt: {named: 1, placed: 1}}
        }));

        const records  = {completed: [], failed: []},
              services = {
                  healthService   : {recordTaskOutcome() {}},
                  taskStateService: {
                      getTaskState : () => ({}),
                      markStarted  : () => {},
                      markCompleted: (taskName, details) => records.completed.push(details),
                      markFailed   : (taskName, code)    => records.failed.push(code)
                  },
                  rotateSunsetSessions: () => Orchestrator.prototype.rotateSunsetSessions.call({writeLog() {}})
              },
              run      = () => executeCandidate({
                  candidate      : {taskName: LANE, descriptor, trigger: {reason: 'spec'}},
                  activeHeavyTask: {name: null},
                  services,
                  runtime        : {writeLog() {}}
              });

        WebhookDeliveryService.configure({attemptTimeoutSeconds: 5});

        try {
            await run();
            await run();
            await receiver.drain();

            expect(records.failed).toEqual([]);
            expect(records.completed[0]).toMatchObject({requested: 1});
            expect(dispatched).toHaveLength(1);
            expect(dispatched[0].envelope).toMatchObject({
                eventId: rotationEventId('MESSAGE:rotation-e2e-receipt'),
                payload: {receiptMessageId: 'MESSAGE:rotation-e2e-receipt', reason: 'sunset_restart', holdUntil: expect.any(String)}
            });
            expect(dispatched[0].envelope.payload.prompt).toContain(seat)
        } finally {
            await new Promise(resolve => receiver.server.close(resolve));
            await fs.rm(stateDir, {recursive: true, force: true});
            sqlite.prepare(`DELETE FROM Nodes WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)
        }
    });
});

test.describe('session-rotation lane: the receipt turn ends at its writer\'s close (#1722)', () => {
    const SEC = 1 / 60; // `at` counts minutes

    function closeInterval(db, turnId, closedAgo) {
        const id   = `AGENT_TURN_PRESENCE:${SEAT}:${turnId}`,
              node = JSON.parse(db.prepare('SELECT data FROM Nodes WHERE id = ?').get(id).data);

        Object.assign(node.properties, {status: 'terminal', terminalState: 'completed', lastProgressAt: at(closedAgo)});
        db.prepare('UPDATE Nodes SET data = ? WHERE id = ?').run(JSON.stringify(node), id)
    }

    // An add_memory of one Memory Core session: the writer's own closes its turn within milliseconds.
    const save = (db, id, ago, sessionId) => insertMemory(db, id, ago, sessionId);

    test('Mnemosyne\'s 22:04:52Z sunset: an interval its own turn opened 280 ms after the receipt is no prompt; the turn waits until its close, then rotates', async () => {
        const db = createGraph();

        insertRoute(db);
        save(db, 'mem-before', 10 + 343.060 * SEC, 'writer');            // her previous diary, 21:59:09Z
        insertSelfMessage(db, 'MESSAGE:receipt', 10);
        // Times relative to the receipt, read from the live rows.
        insertInterval(db, 'prompt-start',  {startedAgo: 10 + 318.654 * SEC, expiresIn: 45});                                // UserPromptSubmit, never closed
        insertInterval(db, 'tool-beacon',   {startedAgo: 10 + 101.655 * SEC, progressAgo: 10 - 0.229 * SEC, expiresIn: 50}); // PostToolUse, never closed
        insertInterval(db, 'receipt-tail',  {startedAgo: 10 - 0.280 * SEC, expiresIn: 60});                                  // opened after the receipt

        const open = await runLane(db);

        expect(open.sent).toEqual([]);
        expect(open.outcome).toMatchObject({requested: 0, refused: 0, waiting: 1});

        closeInterval(db, 'receipt-tail', 10 - 82.453 * SEC); // its add_memory, 82 s after the receipt
        save(db, 'mem-close', 10 - 82.451 * SEC, 'writer');   // that add_memory's own row, 2 ms earlier

        const closed = await runLane(db, {now: NOW + MIN});

        expect(closed.sent).toHaveLength(1);
        expect(rotationOf(db, 'MESSAGE:receipt')).toMatchObject({state: 'requested'})
    });

    test('activity after the writer\'s close refuses the request, and so does an interval its close did not close', async () => {
        const restarted = createGraph();

        insertRoute(restarted);
        save(restarted, 'mem-before', 14, 'writer');
        insertSelfMessage(restarted, 'MESSAGE:receipt', 10);
        insertInterval(restarted, 'sunset-turn', {startedAgo: 12, progressAgo: 9.7, closed: true});
        save(restarted, 'mem-close', 9.7, 'writer');
        insertInterval(restarted, 'fresh-by-hand', {startedAgo: 5}); // a person restarted the seat after the sunset

        expect((await runLane(restarted)).sent).toEqual([]);
        expect(rotationOf(restarted, 'MESSAGE:receipt')).toMatchObject({state: 'refused', reason: 'prompted-after-receipt'});

        // Opened after the receipt and left open by the writer's close: the writer's or another session's, so no request.
        const ambiguous = createGraph();

        insertRoute(ambiguous);
        save(ambiguous, 'mem-before', 14, 'writer');
        insertSelfMessage(ambiguous, 'MESSAGE:receipt', 10);
        insertInterval(ambiguous, 'sunset-turn', {startedAgo: 12, progressAgo: 9.7, closed: true});
        save(ambiguous, 'mem-close', 9.7, 'writer');
        insertInterval(ambiguous, 'opened-after-receipt', {startedAgo: 9.9, expiresIn: 55});

        expect((await runLane(ambiguous)).sent).toEqual([])
    });

    test('older intervals that never closed hold nothing once the writer closed (the 18:49Z receipt)', async () => {
        const db = createGraph();

        insertRoute(db);
        save(db, 'mem-before', 19, 'writer');
        insertSelfMessage(db, 'MESSAGE:receipt', 10);
        insertInterval(db, 'task-notification-turn', {startedAgo: 17.7, progressAgo: 16.9, expiresIn: 53});
        insertInterval(db, 'stop-hook-turn',         {startedAgo: 14.4, progressAgo: 13.7, expiresIn: 56});
        insertInterval(db, 'sunset-turn',            {startedAgo: 12.1, progressAgo: 9.8, closed: true});
        save(db, 'mem-close', 9.8, 'writer');

        expect(readSunsetReceipt(db, SEAT, {sinceIso: at(WINDOW_MS / MIN), nowIso: at(0)}).liveTurnUntil).toBeNull();
        expect((await runLane(db)).sent).toHaveLength(1)
    });

    test('the wake hold stays on through the writer\'s own tail and ends with activity after its close', () => {
        const db    = createGraph(),
              holds = () => holdsWakes({read: readSunsetReceipt(db, SEAT, {sinceIso: at(WINDOW_MS / MIN), nowIso: at(0)}), hasRotationRoute: true, now: NOW, windowMs: WINDOW_MS});

        save(db, 'mem-before', 14, 'writer');
        insertSelfMessage(db, 'MESSAGE:receipt', 10);
        insertInterval(db, 'receipt-tail', {startedAgo: 10 - 0.28 * SEC});

        expect(holds()).toBe(true);

        closeInterval(db, 'receipt-tail', 9);
        save(db, 'mem-close', 9, 'writer');

        expect(holds()).toBe(true);

        insertInterval(db, 'fresh-by-hand', {startedAgo: 4});

        expect(holds()).toBe(false)
    });

    test('Emmy\'s control: another session of the seat closing a turn while the writer is still active authorizes nothing', async () => {
        const db = createGraph();

        insertRoute(db);
        save(db, 'mem-a', 20, 'session-a');
        insertSelfMessage(db, 'MESSAGE:receipt', 10);
        insertInterval(db, 'a-turn', {startedAgo: 12, progressAgo: 10, expiresIn: 50}); // A wrote the receipt, still active
        insertInterval(db, 'b-turn', {startedAgo: 14, progressAgo: 5, closed: true});   // B closes at t=15, no memory of A's

        expect((await runLane(db)).outcome).toMatchObject({requested: 0, refused: 0, waiting: 1});

        // B's memories show a session that was already writing before A's last save: another live session.
        save(db, 'mem-b-before', 25, 'session-b');
        save(db, 'mem-b-close', 5, 'session-b');

        expect((await runLane(db, {now: NOW + MIN})).sent).toEqual([]);
        expect(rotationOf(db, 'MESSAGE:receipt')).toMatchObject({state: 'refused', reason: 'prompted-after-receipt'})
    });

    test('Emmy\'s control: a session opened by hand between the receipt and an unrelated close never gets a fresh session beside it', async () => {
        const db = createGraph();

        insertRoute(db);
        save(db, 'mem-a', 20, 'session-a');
        insertSelfMessage(db, 'MESSAGE:receipt', 10);
        insertInterval(db, 'a-turn',  {startedAgo: 12, progressAgo: 10, expiresIn: 50});
        insertInterval(db, 'by-hand', {startedAgo: 7, expiresIn: 53});                  // t=13
        insertInterval(db, 'b-turn',  {startedAgo: 14, progressAgo: 5, closed: true});  // t=15, unrelated

        expect((await runLane(db)).sent).toEqual([]);

        closeInterval(db, 'a-turn', 2); // the writer closes later, with its own memory
        save(db, 'mem-a-close', 2, 'session-a');

        expect((await runLane(db, {now: NOW + MIN})).sent).toEqual([]);
        expect(rotationOf(db, 'MESSAGE:receipt')).toMatchObject({state: 'refused', reason: 'prompted-after-receipt'})
    });

    test('Emmy\'s Round-2 control: a session first seen after the receipt is not the writer, so its close authorizes nothing', async () => {
        const db = createGraph();

        insertRoute(db);
        save(db, 'mem-a', 20, 'session-a');
        insertSelfMessage(db, 'MESSAGE:receipt', 10);
        insertInterval(db, 'a-turn',   {startedAgo: 12, progressAgo: 10, expiresIn: 50}); // the writer, still active
        insertInterval(db, 'new-turn', {startedAgo: 8, progressAgo: 6, closed: true});     // a new session's turn...
        save(db, 'mem-new', 6, 'session-new');                                             // ...saving alongside its close

        expect((await runLane(db)).sent).toEqual([])
    });
});

test.describe('session-rotation lane: an amendment is not a new receipt, and the receipt names its writer (#1739)', () => {
    const SEC  = 1 / 60;
    const OPEN = {
        state       : 'requested', eventId: rotationEventId('MESSAGE:receipt'), subscriptionId: 'WAKE_SUB:rotate',
        oldSessionId: 'session-old', requestedAt: at(29), deliveredAt: at(29)
    };

    test('Grace\'s 01:41:58Z sunset: an amendment after the request folds into the open receipt, its marker completes it, and the amendment never rotates the seat', async () => {
        const db = createGraph();

        insertRoute(db);
        insertMemory(db, 'mem-old', 40, 'session-old');
        insertSelfMessage(db, 'MESSAGE:receipt', 30, {sessionRotation: OPEN});
        insertSuccessor(db, 'MESSAGE:successor', 28, 'MESSAGE:receipt');               // the fresh session's marker
        insertSelfMessage(db, 'MESSAGE:addendum', 27, {focusItemsReceipt: 'missing'}); // the old session, woken by a subagent

        const {outcome, sent} = await runLane(db);

        expect(sent).toEqual([]);
        expect(outcome.completed).toBe(1);
        expect(rotationOf(db, 'MESSAGE:receipt')).toMatchObject({state: 'completed', successorMessageId: 'MESSAGE:successor'});

        insertSelfMessage(db, 'MESSAGE:v10-1', 26); // the old session again, after the successor's marker

        // 70 minutes after the request, past the minimum interval: no close attributes the post-successor
        // handover, so it stays pending, and nothing is sent or recorded
        const later = await runLane(db, {now: NOW + 40 * MIN});

        expect(later.sent).toEqual([]);
        expect(later.outcome.waiting).toBe(1);
        expect(rotationOf(db, 'MESSAGE:v10-1')).toBeUndefined();
        expect(rotationOf(db, 'MESSAGE:addendum')).toBeUndefined()
    });

    test('Emmy\'s overlap controls: the old writer\'s counted addendum while the successor\'s turn is live sends nothing, 38 minutes or 3 h 13 min after the marker, with or without successor progress since, and under a reconnected Memory Core id', async () => {
        // `sinceMarker` 38.3 is Round 1's fixture; 193.3 is Round 2's: marker 00:02, successor turn 03:00 and
        // diary 03:01, addendum 03:15, its close 03:15:10, the lane at 03:15:20
        const build = ({sinceMarker, successorProgressAgo, writer}) => {
            const db = createGraph();

            insertRoute(db);
            insertMemory(db, 'mem-old', sinceMarker + 1.7, 'session-old');
            insertSelfMessage(db, 'MESSAGE:receipt', sinceMarker + 1, {focusItemsReceipt: {named: 1, placed: 1}, sessionRotation: {
                ...OPEN, requestedAt: at(sinceMarker + 0.9), deliveredAt: at(sinceMarker + 0.9), state: 'completed', completedAt: at(sinceMarker - 1)
            }});
            insertSuccessor(db, 'MESSAGE:successor', sinceMarker, 'MESSAGE:receipt');
            insertInterval(db, 'successor-turn', {startedAgo: 15.3, progressAgo: successorProgressAgo, expiresIn: 44.7});
            insertMemory(db, 'mem-successor', 14.3, 'session-new');
            insertNode(db, 'MESSAGE:addendum', 'MESSAGE', {
                from             : SEAT, to: SEAT, subject: '[sunset] focus items: 1, 1 placed', sentAt: at(20 * SEC),
                focusItemsReceipt: {named: 1, placed: 1}, taggedConcepts: ['sunset-protocol-handover'], originSessionId: writer
            });
            insertInterval(db, 'old-writer-close', {startedAgo: 1, progressAgo: 10 * SEC, closed: true}); // its close, 10 s later
            insertMemory(db, 'mem-old-close', 10 * SEC, writer);

            return db
        };

        for (const sinceMarker of [38.3, 193.3]) {
            // no successor progress since its save; progress after the old close; the old native writer after a reconnect.
            // A close by a session that saved before the receipt is another live session of the seat, so it refuses;
            // a reconnected id is first seen after the receipt, so the receipt waits on the successor's live turn.
            for (const [successorProgressAgo, writer, expected] of [
                [14.3,    'session-old',         {state: 'refused', reason: 'prompted-after-receipt'}],
                [5 * SEC, 'session-old',         {state: 'refused', reason: 'prompted-after-receipt'}],
                [14.3,    'session-reconnected', undefined]
            ]) {
                const db  = build({sinceMarker, successorProgressAgo, writer}),
                      run = await runLane(db);

                expect(run.sent, `${sinceMarker} min, ${writer}`).toEqual([]);
                expected
                    ? expect(rotationOf(db, 'MESSAGE:addendum')).toMatchObject(expected)
                    : expect(rotationOf(db, 'MESSAGE:addendum')).toBeUndefined();

                // once the successor's turn expires, the stamp still releases nothing: the receipt stays pending
                expect((await runLane(db, {now: NOW + 50 * MIN})).sent).toEqual([])
            }
        }
    });

    test('Emmy\'s positive control: a successor\'s own sunset 1 h 43 min after its marker rotates once its own close lands, as it does 40 minutes after; before that close it stays pending', async () => {
        // tonight's seat: marker 01:43:44Z, the successor's diaries, its handover 03:27:09Z and its add_memory 39 s later
        const build = ({sinceMarker, closed}) => {
            const db = createGraph();

            insertRoute(db);
            insertSelfMessage(db, 'MESSAGE:receipt', sinceMarker + 2, {sessionRotation: {
                ...OPEN, requestedAt: at(sinceMarker + 1.5), deliveredAt: at(sinceMarker + 1.5), state: 'completed', completedAt: at(sinceMarker - 1)
            }});
            insertSuccessor(db, 'MESSAGE:successor', sinceMarker, 'MESSAGE:receipt');
            insertMemory(db, 'mem-successor', 16, 'session-new');
            insertNode(db, 'MESSAGE:next', 'MESSAGE', {
                from          : SEAT, to: SEAT, subject: '[sunset] focus items: 9, 9 placed', sentAt: at(1),
                taggedConcepts: ['sunset-protocol-handover'], originSessionId: 'session-new'
            });

            if (closed) {
                insertInterval(db, 'successor-close', {startedAgo: 2, progressAgo: 21 * SEC, closed: true});
                insertMemory(db, 'mem-successor-close', 21 * SEC, 'session-new')
            }

            return db
        };

        for (const sinceMarker of [103.4, 40]) {
            const rotated = build({sinceMarker, closed: true});

            expect((await runLane(rotated)).sent, `${sinceMarker} min`).toHaveLength(1);
            expect(rotationOf(rotated, 'MESSAGE:next')).toMatchObject({state: 'requested', oldSessionId: 'session-new'});

            const pending = build({sinceMarker, closed: false});

            expect((await runLane(pending)).outcome).toMatchObject({requested: 0, waiting: 1})
        }
    });

    test('Emmy\'s Round-1 inverse ordering: a successor\'s sunset after its marker but before the completion stamp waits for the predecessor to settle, then gets its own disposition', async () => {
        const build = writer => {
            const db = createGraph();

            insertRoute(db);
            insertMemory(db, 'mem-old', 50, 'session-old');
            insertSelfMessage(db, 'MESSAGE:receipt', 46, {sessionRotation: {...OPEN, requestedAt: at(45), deliveredAt: at(45)}}); // no completion stamp yet
            insertSuccessor(db, 'MESSAGE:successor', 44, 'MESSAGE:receipt');
            insertNode(db, 'MESSAGE:next', 'MESSAGE', {
                from          : SEAT, to: SEAT, subject: '[sunset] focus items: 1, 1 placed', sentAt: at(2),
                taggedConcepts: ['sunset-protocol-handover'], ...(writer ? {originSessionId: writer} : {})
            });

            return db
        };

        // with no close in view, a stamped and an unstamped handover alike stay pending: the ambiguity is kept, never sent
        for (const writer of ['session-new', null]) {
            const db = build(writer);

            expect((await runLane(db)).outcome.completed).toBe(1); // the predecessor settles first
            expect(rotationOf(db, 'MESSAGE:next')).toBeUndefined();

            const next = await runLane(db, {now: NOW + MIN});

            expect(next.sent, String(writer)).toEqual([]);
            expect(next.outcome.waiting).toBe(1);
            expect(rotationOf(db, 'MESSAGE:next')).toBeUndefined()
        }
    });

    test('a marker replying to the amendment completes the open receipt', async () => {
        const db = createGraph();

        insertRoute(db);
        insertMemory(db, 'mem-old', 40, 'session-old');
        insertSelfMessage(db, 'MESSAGE:receipt', 30, {sessionRotation: OPEN});
        insertSelfMessage(db, 'MESSAGE:addendum', 27);
        insertSuccessor(db, 'MESSAGE:successor', 25, 'MESSAGE:addendum'); // the newest handover the fresh session read

        expect((await runLane(db)).outcome.completed).toBe(1);
        expect(rotationOf(db, 'MESSAGE:receipt')).toMatchObject({state: 'completed', successorMessageId: 'MESSAGE:successor'});
        expect(rotationOf(db, 'MESSAGE:addendum')).toBeUndefined()
    });

    test('a handover sent after the receipt settled is a new receipt: inside the minimum interval it is refused, past it the request goes', async () => {
        const settled = minutesAgo => ({...OPEN, state: 'completed', requestedAt: at(minutesAgo), deliveredAt: at(minutesAgo), completedAt: at(minutesAgo - 2)});

        const tooSoon = createGraph();

        insertRoute(tooSoon);
        insertSelfMessage(tooSoon, 'MESSAGE:receipt', 21, {sessionRotation: settled(20)});
        insertSelfMessage(tooSoon, 'MESSAGE:next', 5); // the fresh session's own sunset

        expect((await runLane(tooSoon)).sent).toEqual([]);
        expect(rotationOf(tooSoon, 'MESSAGE:next')).toMatchObject({state: 'refused', reason: 'minimum-interval'});

        const apart = createGraph();

        insertRoute(apart);
        insertSelfMessage(apart, 'MESSAGE:receipt', 50, {sessionRotation: settled(49)});
        insertSelfMessage(apart, 'MESSAGE:next', 5);

        expect((await runLane(apart)).sent).toHaveLength(1);
        expect(rotationOf(apart, 'MESSAGE:next')).toMatchObject({state: 'requested'})
    });

    test('Mnemosyne\'s 01:50:08Z sunset: a receipt naming its writer is closed by that session\'s add_memory, though its last earlier diary is another session\'s', async () => {
        // Times relative to the receipt, read from the live rows; between her last diary and the receipt the bridge reconnected.
        const build = originSessionId => {
            const db = createGraph();

            insertRoute(db);
            insertMemory(db, 'mem-before-reconnect', 10 + 57.44, 'session-before');
            insertNode(db, 'MESSAGE:receipt', 'MESSAGE', {
                from          : SEAT, to: SEAT, subject: '[sunset]', sentAt: at(10), focusItemsReceipt: {named: 5, placed: 5},
                taggedConcepts: ['sunset-protocol-handover'], ...(originSessionId ? {originSessionId} : {})
            });
            insertInterval(db, 'tool-beacon',  {startedAgo: 10 + 39.36, progressAgo: 10 + 46.9 * SEC, expiresIn: 49.2});     // PostToolUse, never closed
            insertInterval(db, 'memory-close', {startedAgo: 10 + 40.2 * SEC, progressAgo: 10 - 26.9 * SEC, closed: true}); // the closing add_memory
            insertMemory(db, 'mem-close', 10 - 26.9 * SEC, 'session-writer');                                             // that add_memory's row

            return db
        };

        // without the stamp, today's inference: the close is a session first seen after the receipt, so the turn waits
        expect((await runLane(build(null))).outcome).toMatchObject({requested: 0, waiting: 1});

        const stamped = build('session-writer');

        expect((await runLane(stamped)).sent).toHaveLength(1);
        expect(rotationOf(stamped, 'MESSAGE:receipt')).toMatchObject({state: 'requested', oldSessionId: 'session-writer'})
    });

    test('each wait reason logs once per receipt across passes, and again when the receipt waits for another reason', async () => {
        const db          = createGraph(),
              waitsLogged = new Map(),
              waits       = ({logs}) => logs.map(log => log.message).filter(message => message.includes('session-rotation: waiting'));

        insertRoute(db);
        insertSelfMessage(db, 'MESSAGE:receipt', 2);
        insertNode(db, `AGENT_TURN_PRESENCE:${SEAT}:sunset-turn`, 'AGENT_TURN_PRESENCE', {
            agentIdentity: SEAT, turnId: 'sunset-turn', startedAt: at(15), status: 'active', expiresAt: at(-20)
        });

        expect(waits(await runLane(db, {waitsLogged}))).toEqual([`[Orchestrator] session-rotation: waiting for ${SEAT} (live-turn), receipt MESSAGE:receipt`]);
        expect(waits(await runLane(db, {waitsLogged, now: NOW + MIN}))).toEqual([]);

        // the turn expires, the request goes, and the receipt then waits on its receiver
        expect((await runLane(db, {waitsLogged, now: NOW + 21 * MIN})).sent).toHaveLength(1);
        expect(waits(await runLane(db, {waitsLogged, now: NOW + 22 * MIN}))).toEqual([`[Orchestrator] session-rotation: waiting for ${SEAT} (receiver-has-request), receipt MESSAGE:receipt`]);
        expect(waits(await runLane(db, {waitsLogged, now: NOW + 23 * MIN}))).toEqual([]);

        // the successor answers: nothing waits any more, so nothing stays remembered
        insertSuccessor(db, 'MESSAGE:successor', -24, 'MESSAGE:receipt');
        expect((await runLane(db, {waitsLogged, now: NOW + 25 * MIN})).outcome.completed).toBe(1);
        expect(waitsLogged.size).toBe(0)
    });

    test('a receipt waiting for its writer\'s close logs that reason once', async () => {
        const db          = createGraph(),
              waitsLogged = new Map(),
              waits       = ({logs}) => logs.map(log => log.message).filter(message => message.includes('session-rotation: waiting'));

        insertRoute(db);
        insertMemory(db, 'mem-old', 50, 'session-old');
        insertSelfMessage(db, 'MESSAGE:receipt', 46, {sessionRotation: {...OPEN, requestedAt: at(45), deliveredAt: at(45)}});
        insertSuccessor(db, 'MESSAGE:successor', 44, 'MESSAGE:receipt');
        insertNode(db, 'MESSAGE:next', 'MESSAGE', {
            from: SEAT, to: SEAT, subject: '[sunset] focus items: 1, 1 placed', sentAt: at(2), taggedConcepts: ['sunset-protocol-handover']
        });

        expect((await runLane(db, {waitsLogged})).outcome.completed).toBe(1);
        expect(waits(await runLane(db, {waitsLogged, now: NOW + MIN}))).toEqual([`[Orchestrator] session-rotation: waiting for ${SEAT} (writer-close-pending), receipt MESSAGE:next`]);
        expect(waits(await runLane(db, {waitsLogged, now: NOW + 2 * MIN}))).toEqual([])
    });
});

test.describe('session-rotation lane: async PostToolUse overlap and pre-request addenda (#1841)', () => {
    const KEY   = 'v1:307def5255aca2a8e72d087143a8b2f1';
    const OTHER = 'v1:other0000000000000000000000000';
    const MS    = 1 / 60000;

    function buildOverlapCase({otherKey} = {}) {
        const db = createGraph();

        insertRoute(db);
        insertNode(db, 'MEM:b-before', 'AGENT_MEMORY', {
            agentIdentity: SEAT, userId: SEAT, timestamp: at(10), sessionId: 's1', writerKey: KEY, writerTurn: 'b4622140'
        });
        insertNode(db, `AGENT_TURN_PRESENCE:${SEAT}:b4622140`, 'AGENT_TURN_PRESENCE', {
            agentIdentity: SEAT, turnId: 'b4622140', startedAt: at(4), lastProgressAt: at(2 - 2 * MS),
            status       : 'active', expiresAt: at(-58), ...(otherKey ? {writerKey: otherKey} : {})
        });
        insertNode(db, `AGENT_TURN_PRESENCE:${SEAT}:1267b06e`, 'AGENT_TURN_PRESENCE', {
            agentIdentity: SEAT, turnId: '1267b06e', startedAt: at(2), lastProgressAt: at(1),
            status       : 'terminal', terminalState: 'completed', expiresAt: at(-59), writerKey: KEY
        });
        insertNode(db, 'MESSAGE:de397fdd', 'MESSAGE', {
            from             : SEAT, to: SEAT, subject: '[sunset] focus items: 1, 1 placed', sentAt: at(2 + 1 * MS),
            focusItemsReceipt: {named: 1, placed: 1}, taggedConcepts: ['sunset-protocol-handover'],
            writerKey        : KEY, writerTurn: '1267b06e'
        });
        insertNode(db, 'MEM:b-close', 'AGENT_MEMORY', {
            agentIdentity: SEAT, userId: SEAT, timestamp: at(1), sessionId: 's1', writerKey: KEY, writerTurn: '1267b06e'
        });

        return db
    }

    test('AC-2: same-writerKey predecessor active interval with +2 ms async PostToolUse overlap yields liveTurnUntil null and rotates', async () => {
        const db   = buildOverlapCase({otherKey: KEY}),
              read = readSunsetReceipt(db, SEAT, {sinceIso: at(WINDOW_MS / MIN), nowIso: at(0)});

        expect(read.liveTurnUntil).toBeNull();
        expect(decideRotation({read, now: NOW, windowMs: WINDOW_MS, minIntervalMs: MIN_GAP_MS}).action).toBe('request');

        const {sent, outcome} = await runLane(db);

        expect(outcome).toMatchObject({requested: 1, refused: 0, waiting: 0});
        expect(sent).toHaveLength(1);
        expect(sent[0].envelope.payload.receiptMessageId).toBe('MESSAGE:de397fdd')
    });

    test('AC-3: active interval with a different or missing writerKey and lastProgressAt >= ownStart still holds live-turn', async () => {
        for (const otherKey of [OTHER, undefined]) {
            const db   = buildOverlapCase({otherKey}),
                  read = readSunsetReceipt(db, SEAT, {sinceIso: at(WINDOW_MS / MIN), nowIso: at(0)});

            expect(read.liveTurnUntil, String(otherKey)).not.toBeNull();
            expect(decideRotation({read, now: NOW, windowMs: WINDOW_MS, minIntervalMs: MIN_GAP_MS})).toMatchObject({action: 'wait', reason: 'live-turn'});

            const {sent, outcome} = await runLane(db);

            expect(sent, String(otherKey)).toEqual([]);
            expect(outcome).toMatchObject({requested: 0, waiting: 1})
        }
    });

    test('AC-4: pre-requestedAt same-writerKey handover addendum folds into one rotation whose marker on either completes it', async () => {
        for (const replyTarget of ['MESSAGE:de397fdd', 'MESSAGE:4d664b7c']) {
            const db = createGraph();

            insertRoute(db);
            insertNode(db, `AGENT_TURN_PRESENCE:${SEAT}:b4622140`, 'AGENT_TURN_PRESENCE', {
                agentIdentity: SEAT, turnId: 'b4622140', startedAt: at(4), lastProgressAt: at(2 - 2 * MS),
                status       : 'active', expiresAt: at(-58), writerKey: KEY
            });
            insertNode(db, 'MESSAGE:de397fdd', 'MESSAGE', {
                from             : SEAT, to: SEAT, subject: '[sunset] focus items: 1, 1 placed', sentAt: at(2.1),
                focusItemsReceipt: {named: 1, placed: 1}, taggedConcepts: ['sunset-protocol-handover'],
                writerKey        : KEY, writerTurn: 'b4622140'
            });
            insertNode(db, `AGENT_TURN_PRESENCE:${SEAT}:1267b06e`, 'AGENT_TURN_PRESENCE', {
                agentIdentity: SEAT, turnId: '1267b06e', startedAt: at(2), lastProgressAt: at(1.2),
                status       : 'terminal', terminalState: 'completed', expiresAt: at(-59), writerKey: KEY
            });
            insertNode(db, 'MESSAGE:4d664b7c', 'MESSAGE', {
                from          : SEAT, to: SEAT, subject: '[sunset] focus items: 1, 1 placed', sentAt: at(1.5),
                inReplyTo     : 'MESSAGE:de397fdd', focusItemsReceipt: {named: 1, placed: 1},
                taggedConcepts: ['sunset-protocol-handover'], writerKey: KEY, writerTurn: '1267b06e'
            });
            insertNode(db, 'MEM:close', 'AGENT_MEMORY', {
                agentIdentity: SEAT, userId: SEAT, timestamp: at(1.2), sessionId: 's1', writerKey: KEY, writerTurn: '1267b06e'
            });

            const first = await runLane(db);

            expect(first.sent, replyTarget).toHaveLength(1);
            expect(first.sent[0].envelope.payload.receiptMessageId).toBe('MESSAGE:4d664b7c');
            expect(rotationOf(db, 'MESSAGE:4d664b7c')).toMatchObject({state: 'requested'});

            insertSuccessor(db, 'MESSAGE:succ', 0.5, replyTarget);

            const second = await runLane(db, {now: NOW + MIN});

            expect(second.sent, replyTarget).toEqual([]);
            expect(second.outcome.completed).toBe(1);
            expect(rotationOf(db, 'MESSAGE:4d664b7c')).toMatchObject({state: 'completed', successorMessageId: 'MESSAGE:succ'});
            expect(rotationOf(db, 'MESSAGE:de397fdd')).toBeUndefined()
        }
    });
});

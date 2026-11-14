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

function insertDirectMessage(db, id, minutesAgo, to = SEAT) {
    insertNode(db, id, 'MESSAGE', {from: '@neo-peer', to, subject: 'a review request', sentAt: at(minutesAgo), taggedConcepts: []});
    db.prepare('INSERT INTO Edges (id, user_id, source, target, type, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run(`edge-${id}`, null, id, to, 'SENT_TO', JSON.stringify({id: `edge-${id}`, source: id, target: to, type: 'SENT_TO'}))
}

const rotationOf = (db, id) => JSON.parse(db.prepare('SELECT data FROM Nodes WHERE id = ?').get(id).data).properties.sessionRotation;

/**
 * @summary One lane pass over `db` with a recording sender.
 * @returns {Promise<{outcome: Object, sent: Object[], logs: Object[]}>}
 */
async function runLane(db, {now = NOW, delivery = 'delivered', operatorPresence = {mode: 'present', until: null}} = {}) {
    const sent    = [], logs = [];
    const outcome = await runSessionRotation({
        db,
        deliver      : async (subscription, envelope) => { sent.push({subscription, envelope}); return delivery },
        operatorPresence,
        windowMs     : WINDOW_MS,
        minIntervalMs: MIN_GAP_MS,
        writeLog     : (level, message) => logs.push({level, message}),
        now
    });

    return {outcome, sent, logs}
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
            payload       : {receiptMessageId: 'MESSAGE:receipt', oldSessionId: 'session-old', reason: 'sunset_restart'}
        });
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

        // no memory after the marker yet, so the successor's session is still unknown
        expect(read()).toMatchObject({receipt: {id: 'MESSAGE:receipt'}, successor: {id: 'MESSAGE:successor', sentAt: at(4), sessionId: null}});

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

    test('the receipt count (#1401): an absent count waits for the summary lane, a missing one rotates anyway', async () => {
        const pending = createGraph();

        insertRoute(pending);
        insertSelfMessage(pending, 'MESSAGE:receipt', 10, {focusItemsReceipt: 'unconsumed'});

        expect((await runLane(pending)).outcome).toMatchObject({requested: 0, waiting: 1});

        const missing = createGraph();

        insertRoute(missing);
        insertSelfMessage(missing, 'MESSAGE:receipt', 10, {focusItemsReceipt: 'missing'});

        expect((await runLane(missing)).sent).toHaveLength(1)
    });

    test('AC-11 + #1712 AC-2: the earliest marker after the request completes the rotation with both ids and the messages the hold kept', async () => {
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
        insertMemory(db, 'mem-fresh', 6, 'session-fresh');
        insertDirectMessage(db, 'MESSAGE:after', 2);

        const {outcome, sent, logs} = await runLane(db);

        expect(sent).toEqual([]);
        expect(outcome.completed).toBe(1);
        expect(rotationOf(db, 'MESSAGE:receipt')).toMatchObject({
            state: 'completed', successorMessageId: 'MESSAGE:successor', oldSessionId: 'session-old', newSessionId: 'session-fresh', heldMessages: 2
        });
        expect(logs.some(({level, message}) => level === 'INFO' && message.includes('session-old → session-fresh'))).toBe(true)
    });

    test('AC-12: a rotation open past its window is recorded incomplete and requests nothing else', async () => {
        const db = createGraph();

        insertRoute(db);
        insertSelfMessage(db, 'MESSAGE:receipt', 181, {sessionRotation: {
            state: 'requested', eventId: rotationEventId('MESSAGE:receipt'), requestedAt: at(180), deliveredAt: at(180)
        }});

        const {outcome, sent, logs} = await runLane(db);

        expect(sent).toEqual([]);
        expect(outcome.incomplete).toBe(1);
        expect(rotationOf(db, 'MESSAGE:receipt')).toMatchObject({state: 'incomplete', reason: 'no-fresh-session'});
        expect(logs.some(({level}) => level === 'ERROR')).toBe(true);

        expect((await runLane(db, {now: NOW + MIN})).outcome).toEqual({requested: 0, completed: 0, refused: 0, incomplete: 0, waiting: 0})
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
            dispatch: async record => { dispatched.push(record); return 'delivered' },
            logger  : {error() {}, warn() {}, log() {}}
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
                payload: {receiptMessageId: 'MESSAGE:rotation-e2e-receipt', reason: 'sunset_restart'}
            });
            expect(dispatched[0].envelope.payload.prompt).toContain(seat)
        } finally {
            await new Promise(resolve => receiver.server.close(resolve));
            await fs.rm(stateDir, {recursive: true, force: true});
            sqlite.prepare(`DELETE FROM Nodes WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)
        }
    });
});

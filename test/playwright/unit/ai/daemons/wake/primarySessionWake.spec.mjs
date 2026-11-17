import {test, expect}                                                                                from '@playwright/test';
import fs                                                                                            from 'node:fs/promises';
import os                                                                                            from 'node:os';
import path                                                                                          from 'node:path';
import {bindPrimarySession, deliverPrimarySessionWake, readPrimarySessionWake, revokePrimarySession} from '../../../../../../ai/daemons/wake/primarySessionWake.mjs';
import {withOutboxLock}                                                                              from '../../../../../../ai/daemons/wake/outboxLock.mjs';
import {randomUUID}                                                                                  from 'node:crypto';
import {
    primaryWakeSpoolPath,
    SPOOL_CONTENTION_REASONS,
    stagePrimaryWake,
    urgentPrimaryWakeSpoolPath
} from '../../../../../../ai/daemons/wake/primaryWakeSpool.mjs';
import {WakeReceiverState} from '../../../../../../ai/daemons/wake/receiverState.mjs';

test.describe('primary session wake ownership', () => {
    let dir, statePath, binding, recorded, sends;
    const first   = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', key = 'a'.repeat(64);
    const proof   = binding => ({root: true, threadId: binding.threadId});
    const bind    = (threadId = first, expectedVersion = 0) => bindPrimarySession({statePath, ...binding, threadId, expectedVersion, proveTarget: proof});
    const deliver = (extra = {}) => deliverPrimarySessionWake({statePath, ...binding, recordKey: key,
        readTarget : proof, send: async () => { sends++; return {status: 'accepted'} },
        readReceipt: async () => null, isRecordedDelivered: async () => recorded, ...extra});

    test.beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-primary-wake-'));
        statePath = path.join(dir, 'state.json');
        binding = {seat: '@test-seat', generation: 'epoch-1', family: 'codex-desktop'};
        recorded = false; sends = 0;
    });
    test.afterEach(async () => fs.rm(dir, {recursive: true, force: true}));

    test('CAS rejects child proof and mismatched seat, with private durable state', async () => {
        expect((await bindPrimarySession({statePath, ...binding, threadId: first, expectedVersion: 0, proveTarget: () => ({root: false, threadId: first})})).status).toBe('pending');
        expect((await bind()).status).toBe('bound');
        expect((await bind(second, 0)).status).toBe('pending');
        expect((await bindPrimarySession({statePath, ...binding, seat: '@other', threadId: second, expectedVersion: 1, proveTarget: proof})).status).toBe('pending');
        expect((await fs.stat(statePath)).mode & 0o777).toBe(0o600);
    });

    test('accepted but unconfirmed is held across restart, handoff and duplicate', async () => {
        await bind();
        const unknown = await deliver();
        expect(unknown.status).toBe('unknown');
        expect((await bind(second, 1)).status).toBe('unknown');
        expect((await revokePrimarySession({statePath, seat: binding.seat, expectedVersion: 1})).status).toBe('unknown');
        expect((await deliver()).status).toBe('unknown');
        expect(sends).toBe(1);
        const receipt = {status: 'consumed', ...binding, threadId: first, recordKey: key, nonce: unknown.nonce};
        expect((await deliver({readReceipt: async () => receipt})).status).toBe('delivered');
        expect((await deliver({recordKey: 'b'.repeat(64)})).status).toBe('unknown');
        recorded = true;
        expect((await deliver()).status).toBe('delivered');
        expect((await bind(second, 1)).status).toBe('bound');
        expect((await readPrimarySessionWake({statePath})).binding.threadId).toBe(second);
    });

    test('concurrent handoff cannot cross an admitted busy old-root effect', async () => {
        await bind();
        let release, entered;
        const gate      = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { entered = resolve });
        const operation = deliver({send: async () => { sends++; entered(); await gate; return {status: 'accepted'} }});
        await ready;
        const handoff = bind(second, 1);
        release();
        expect((await operation).status).toBe('unknown');
        expect((await handoff).status).toBe('unknown');
        expect(sends).toBe(1);
    });

    test('native send can re-enter the seat lock while a duplicate cannot send', async () => {
        await bind();
        let release, entered;
        const gate      = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { entered = resolve });
        const operation = deliver({send: async () => {
            sends++;
            await withOutboxLock(statePath, async () => { entered(); await gate });
            return {status: 'accepted'}
        }});
        await ready;
        const duplicate = deliver();
        release();
        expect((await operation).status).toBe('unknown');
        expect((await duplicate).status).toBe('unknown');
        expect(sends).toBe(1);
    });

    test('only a proven non-send releases for handoff and correct-generation retry', async () => {
        await bind();
        expect((await deliver({generation: 'old'})).status).toBe('pending');
        expect((await deliver({readTarget: () => ({root: false, threadId: first})})).status).toBe('pending');
        expect((await deliver({send: async () => ({status: 'not-sent'})})).status).toBe('pending');
        expect((await bind(second, 1)).status).toBe('bound');
        expect((await deliver()).status).toBe('unknown');
        expect(sends).toBe(1);
    });

    test('a foreign or stale receipt never releases an ambiguous attempt', async () => {
        await bind();
        const firstAttempt = await deliver();
        for (const change of [{seat: '@other'}, {generation: 'old'}, {threadId: second},
            {recordKey: 'b'.repeat(64)}, {nonce: 'other'}]) {
            const receipt = {status: 'consumed', ...binding, threadId: first, recordKey: key, nonce: firstAttempt.nonce, ...change};
            expect((await deliver({readReceipt: async () => receipt})).status).toBe('unknown');
        }
        expect(sends).toBe(1);
        expect((await bind(second, 1)).status).toBe('unknown');
    });

    test('a durable not-sent receipt releases the old owner for a later handoff', async () => {
        await bind();
        const firstAttempt = await deliver();
        const receipt      = {status: 'not-sent', ...binding, threadId: first, recordKey: key, nonce: firstAttempt.nonce};
        expect((await deliver({readReceipt: async () => receipt})).status).toBe('pending');
        expect((await bind(second, 1)).status).toBe('bound');
        expect((await deliver()).status).toBe('unknown');
        expect(sends).toBe(2);
    });

    test('handoff directly retires a receiver-committed delivered receipt', async () => {
        await bind();
        const result  = await deliver();
        const receipt = {status: 'consumed', ...binding, threadId: first, recordKey: key, nonce: result.nonce};
        expect((await deliver({readReceipt: async () => receipt})).status).toBe('delivered');
        const handoff = () => bindPrimarySession({statePath, ...binding, threadId: second, expectedVersion: 1,
            proveTarget: proof, isRecordedDelivered: async id => id === key && recorded});
        expect((await handoff()).status).toBe('unknown');
        recorded = true;
        expect((await handoff()).status).toBe('bound');
    });

    test('urgent delivery uses urgentInflight without evicting an unresolved ordinary inflight attempt', async () => {
        await bind();
        const normalKey  = '1'.repeat(64),
              urgentKey  = '2'.repeat(64),
              urgentKey2 = '3'.repeat(64),
              delivered  = new Set(),
              sentCalls  = [];

        const runAttempt = (recordKey, urgent, readReceipt = async () => null) => deliverPrimarySessionWake({
            statePath,
            ...binding,
            recordKey,
            urgent,
            readTarget         : proof,
            send               : async req => { sentCalls.push({recordKey: req.recordKey, urgent: req.urgent, nonce: req.nonce}); return {status: 'accepted'} },
            readReceipt,
            isRecordedDelivered: async id => delivered.has(id)
        });

        const normalAttempt = await runAttempt(normalKey, false);
        expect(normalAttempt.status).toBe('unknown');
        expect(sentCalls).toHaveLength(1);

        expect((await runAttempt('4'.repeat(64), false)).status).toBe('unknown');
        expect(sentCalls, 'second ordinary attempt stays blocked behind normal inflight').toHaveLength(1);

        const urgentAttempt = await runAttempt(urgentKey, true);
        expect(urgentAttempt.status).toBe('unknown');
        expect(urgentAttempt.nonce).not.toBe(normalAttempt.nonce);
        expect(sentCalls).toHaveLength(2);
        expect(sentCalls[1]).toMatchObject({recordKey: urgentKey, urgent: true});

        const persisted = await readPrimarySessionWake({statePath});
        expect(persisted.inflight).toMatchObject({status: 'unknown', recordKey: normalKey, nonce: normalAttempt.nonce});
        expect(persisted.urgentInflight).toMatchObject({status: 'unknown', recordKey: urgentKey, nonce: urgentAttempt.nonce});

        expect((await runAttempt(urgentKey, true)).status).toBe('unknown');
        expect((await runAttempt(urgentKey2, true)).status).toBe('unknown');
        expect(sentCalls, 'duplicate and second urgent attempts never double-send').toHaveLength(2);

        expect((await bind(second, 1)).status).toBe('unknown');
        expect((await revokePrimarySession({statePath, seat: binding.seat, expectedVersion: 1})).status).toBe('unknown');

        const urgentSettled = await runAttempt(urgentKey, true, async () => ({
            status    : 'consumed',
            ...binding,
            threadId  : first,
            recordKey : urgentKey,
            nonce     : urgentAttempt.nonce,
            observedAt: '2026-11-15T09:05:00.000Z'
        }));
        expect(urgentSettled).toMatchObject({
            status             : 'delivered',
            nonce              : urgentAttempt.nonce,
            recipientObservedAt: '2026-11-15T09:05:00.000Z'
        });
        delivered.add(urgentKey);

        expect((await readPrimarySessionWake({statePath})).inflight).toMatchObject({
            status   : 'unknown',
            recordKey: normalKey,
            nonce    : normalAttempt.nonce
        });

        const normalSettled = await runAttempt(normalKey, false, async () => ({
            status   : 'consumed',
            ...binding,
            threadId : first,
            recordKey: normalKey,
            nonce    : normalAttempt.nonce
        }));
        expect(normalSettled).toMatchObject({status: 'delivered', nonce: normalAttempt.nonce});
        delivered.add(normalKey);
        expect(sentCalls).toHaveLength(2);

        expect((await bindPrimarySession({
            statePath,
            ...binding,
            threadId           : second,
            expectedVersion    : 1,
            proveTarget        : proof,
            isRecordedDelivered: async id => delivered.has(id)
        })).status).toBe('bound');
    });
});

test.describe('stagePrimaryWake & deliverPrimarySessionWake urgent guards (RA-1 & RA-5)', () => {
    const
        seat  = '@spool-fixture',
        sub   = 'WAKE_SUB:spool-fixture',
        route = {agentIdentity: seat, harnessTargetMetadata: {adapter: 'primary-session'}};

    const makeHighEnvelope = (eventId, sentAt) => ({
        schemaVersion : '1.0',
        eventType     : 'wake/digest',
        eventId,
        agentIdentity : seat,
        subscriptionId: sub,
        payload       : {
            totalEvents: 1,
            breakdown  : {sent_to_me: {count: 1, highestPriority: 'high', latest: {priority: 'high', sentAt}}}
        },
        emittedAt: sentAt
    });

    test('RA-1 — legacy record without record.urgent stays ordinary and settles cleanly past the 1h horizon without wedging', async () => {
        const dir   = await fs.mkdtemp(path.join(os.tmpdir(), 'primary-spool-legacy-'));
        const state = new WakeReceiverState({stateDir: dir});
        await state.init();

        try {
            const freshIso     = new Date().toISOString();
            const {record}     = await state.accept({subscriptionId: sub, eventId: 'legacy-1', envelope: makeHighEnvelope('legacy-1', freshIso), route});
            const legacyRecord = {...record};
            delete legacyRecord.urgent;

            const staged = await stagePrimaryWake(legacyRecord, {state, stateDir: dir});
            expect(staged).toEqual({status: 'pending', reason: 'awaiting the native recipient'});

            const normalPtr = primaryWakeSpoolPath(dir, seat),
                  urgentPtr = urgentPrimaryWakeSpoolPath(dir, seat);
            expect(JSON.parse(await fs.readFile(normalPtr, 'utf8')).recordKey).toBe(legacyRecord.recordKey);
            await expect(fs.stat(urgentPtr)).rejects.toMatchObject({code: 'ENOENT'});

            await fs.writeFile(`${normalPtr}.result`, JSON.stringify({
                recordKey     : legacyRecord.recordKey,
                subscriptionId: sub,
                recipient     : {seat, generation: '100:birth', threadId: randomUUID(), recordKey: legacyRecord.recordKey, nonce: randomUUID()}
            }), {mode: 0o600});

            const expiredView = {...legacyRecord, envelope: makeHighEnvelope('legacy-1', '2020-01-01T00:00:00.000Z')};
            const settled     = await stagePrimaryWake(expiredView, {state, stateDir: dir});
            expect(settled.status).toBe('delivered');
            await state.transition(legacyRecord.recordKey, 'pending', 'delivered');

            const nextAccepted = await state.accept({
                subscriptionId: sub,
                eventId       : 'after-legacy-1',
                envelope      : makeHighEnvelope('after-legacy-1', freshIso),
                route,
                metadata      : {urgent: true}
            });
            expect(await stagePrimaryWake(nextAccepted.record, {state, stateDir: dir})).toEqual({
                status: 'pending',
                reason: 'awaiting the native recipient'
            });
        } finally {
            await fs.rm(dir, {recursive: true, force: true});
        }
    });

    test('RA-1 — pre-staged legacy .urgent.request.json without record.urgent still settles from its urgent result past 1h', async () => {
        const dir   = await fs.mkdtemp(path.join(os.tmpdir(), 'primary-spool-legacy-ptr-'));
        const state = new WakeReceiverState({stateDir: dir});
        await state.init();

        try {
            const {record} = await state.accept({
                subscriptionId: sub,
                eventId       : 'legacy-pre-urgent',
                envelope      : makeHighEnvelope('legacy-pre-urgent', '2020-01-01T00:00:00.000Z'),
                route
            });
            const legacyRecord = {...record};
            delete legacyRecord.urgent;

            const urgentPtr = urgentPrimaryWakeSpoolPath(dir, seat);
            await fs.mkdir(path.dirname(urgentPtr), {recursive: true, mode: 0o700});
            await fs.writeFile(urgentPtr, JSON.stringify({recordKey: legacyRecord.recordKey, urgent: true}), {mode: 0o600});
            await fs.writeFile(`${urgentPtr}.result`, JSON.stringify({
                recordKey     : legacyRecord.recordKey,
                subscriptionId: sub,
                recipient     : {seat, generation: '100:birth', threadId: randomUUID(), recordKey: legacyRecord.recordKey, nonce: randomUUID()}
            }), {mode: 0o600});

            const settled = await stagePrimaryWake(legacyRecord, {state, stateDir: dir});
            expect(settled.status).toBe('delivered');
            await state.transition(legacyRecord.recordKey, 'pending', 'delivered');

            const followUp = await state.accept({
                subscriptionId: sub,
                eventId       : 'follow-up',
                envelope      : makeHighEnvelope('follow-up', new Date().toISOString()),
                route,
                metadata      : {urgent: false}
            });
            const stagedFollowUp = await stagePrimaryWake(followUp.record, {state, stateDir: dir});
            expect(stagedFollowUp).toEqual({status: 'pending', reason: 'awaiting the native recipient'});
        } finally {
            await fs.rm(dir, {recursive: true, force: true});
        }
    });

    test('RA-5 — stagePrimaryWake preserves active normal pointer/.status during urgent staging and refuses contention cleanly', async () => {
        const dir   = await fs.mkdtemp(path.join(os.tmpdir(), 'primary-spool-guards-'));
        const state = new WakeReceiverState({stateDir: dir});
        await state.init();

        try {
            const nowIso    = new Date().toISOString();
            const normal1   = (await state.accept({subscriptionId: sub, eventId: 'n1', envelope: makeHighEnvelope('n1', nowIso), route, metadata: {urgent: false}})).record;
            const urgent1   = (await state.accept({subscriptionId: sub, eventId: 'u1', envelope: makeHighEnvelope('u1', nowIso), route, metadata: {urgent: true}})).record;
            const normal2   = (await state.accept({subscriptionId: sub, eventId: 'n2', envelope: makeHighEnvelope('n2', nowIso), route, metadata: {urgent: false}})).record;
            const normalPtr = primaryWakeSpoolPath(dir, seat),
                  urgentPtr = urgentPrimaryWakeSpoolPath(dir, seat);

            expect(await stagePrimaryWake(normal1, {state, stateDir: dir})).toEqual({status: 'pending', reason: 'awaiting the native recipient'});
            await fs.writeFile(`${normalPtr}.status`, JSON.stringify({
                recordKey     : normal1.recordKey,
                subscriptionId: sub,
                reason        : 'native-recipient:active-turn-adapter-unavailable',
                dependency    : '#1741'
            }), {mode: 0o600});

            const sessionFile = path.join(dir, 'primary-sessions', `${seat.slice(1)}.json`);
            await fs.writeFile(sessionFile, JSON.stringify({
                version       : 1,
                binding       : {seat, generation: '100:birth', family: 'codex-desktop', threadId: randomUUID()},
                inflight      : {status: 'unknown', recordKey: normal1.recordKey, nonce: randomUUID()},
                urgentInflight: null
            }), {mode: 0o600});

            expect(await stagePrimaryWake(urgent1, {state, stateDir: dir})).toEqual({status: 'pending', reason: 'awaiting the native recipient'});
            expect(JSON.parse(await fs.readFile(normalPtr, 'utf8')).recordKey).toBe(normal1.recordKey);
            expect(JSON.parse(await fs.readFile(`${normalPtr}.status`, 'utf8')).recordKey).toBe(normal1.recordKey);
            expect(JSON.parse(await fs.readFile(urgentPtr, 'utf8')).recordKey).toBe(urgent1.recordKey);

            const blockedNormal = await stagePrimaryWake(normal2, {state, stateDir: dir});
            expect(blockedNormal.status).toBe('pending');
            expect(SPOOL_CONTENTION_REASONS).toContain(blockedNormal.reason);
            expect(JSON.parse(await fs.readFile(normalPtr, 'utf8')).recordKey).toBe(normal1.recordKey);
        } finally {
            await fs.rm(dir, {recursive: true, force: true});
        }
    });

    test('RA-5 — deliverPrimarySessionWake defers ordinary delivery when an urgent attempt is unresolved', async () => {
        const dir       = await fs.mkdtemp(path.join(os.tmpdir(), 'primary-deliver-urgent-guard-'));
        const statePath = path.join(dir, 'seat.json');
        const threadId  = randomUUID(),
              urgentKey = 'e'.repeat(64),
              normalKey = 'f'.repeat(64),
              binding   = {seat: '@deliver-guard', generation: '200:birth', family: 'codex-desktop', threadId};

        try {
            const targetProof = async () => ({root: true, threadId, generation: '200:birth'});
            await bindPrimarySession({
                statePath,
                ...binding,
                expectedVersion    : 0,
                proveTarget        : targetProof,
                isRecordedDelivered: async () => false
            });

            let   sendCalls     = 0;
            const urgentAttempt = await deliverPrimarySessionWake({
                statePath,
                ...binding,
                recordKey          : urgentKey,
                urgent             : true,
                readTarget         : targetProof,
                send               : async () => { sendCalls++; return {status: 'accepted'} },
                readReceipt        : async () => null,
                isRecordedDelivered: async () => false
            });
            expect(urgentAttempt.status).toBe('unknown');

            const ordinaryDeferred = await deliverPrimarySessionWake({
                statePath,
                ...binding,
                recordKey          : normalKey,
                urgent             : false,
                readTarget         : targetProof,
                send               : async () => { sendCalls++; return {status: 'accepted'} },
                readReceipt        : async () => null,
                isRecordedDelivered: async () => false
            });
            expect(ordinaryDeferred).toEqual({status: 'pending', reason: 'urgent delivery in progress'});
            expect(sendCalls).toBe(1);
        } finally {
            await fs.rm(dir, {recursive: true, force: true});
        }
    });

    test('an unacknowledged urgent receipt settles its slot as delivered without the digest, and the ordinary wake behind it sends', async () => {
        const dir       = await fs.mkdtemp(path.join(os.tmpdir(), 'primary-deliver-unacknowledged-'));
        const statePath = path.join(dir, 'seat.json');
        const threadId  = randomUUID(),
              urgentKey = 'e'.repeat(64),
              normalKey = 'f'.repeat(64),
              binding   = {seat: '@deliver-guard', generation: '200:birth', family: 'codex-desktop', threadId};

        try {
            const targetProof = async () => ({root: true, threadId, generation: '200:birth'});
            await bindPrimarySession({statePath, ...binding, expectedVersion: 0, proveTarget: targetProof, isRecordedDelivered: async () => false});

            let   sendCalls = 0, receipt = null, recorded = false;
            const deliver   = (recordKey, urgent) => deliverPrimarySessionWake({statePath, ...binding, recordKey, urgent,
                readTarget         : targetProof,
                send               : async () => { sendCalls++; return {status: 'accepted'} },
                readReceipt        : async () => receipt,
                isRecordedDelivered: async key => recorded && key === urgentKey
            });

            const urgentAttempt = await deliver(urgentKey, true);
            expect(urgentAttempt.status).toBe('unknown');
            expect(await deliver(normalKey, false)).toEqual({status: 'pending', reason: 'urgent delivery in progress'});

            receipt = {status: 'unacknowledged', ...binding, recordKey: urgentKey, nonce: urgentAttempt.nonce};
            expect(await deliver(urgentKey, true)).toEqual({status: 'delivered', nonce: urgentAttempt.nonce, acknowledged: false});
            expect((await readPrimarySessionWake({statePath})).urgentInflight).toMatchObject({status: 'delivered', acknowledged: false});

            recorded = true;
            receipt  = null;
            expect((await deliver(normalKey, false)).status).toBe('unknown');
            expect(sendCalls).toBe(2);
        } finally {
            await fs.rm(dir, {recursive: true, force: true});
        }
    });
});

import {test, expect}                                                                                from '@playwright/test';
import fs                                                                                            from 'node:fs/promises';
import os                                                                                            from 'node:os';
import path                                                                                          from 'node:path';
import {bindPrimarySession, deliverPrimarySessionWake, readPrimarySessionWake, revokePrimarySession} from '../../../../../../ai/daemons/wake/primarySessionWake.mjs';
import {withOutboxLock}                                                                              from '../../../../../../ai/daemons/wake/outboxLock.mjs';

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
});

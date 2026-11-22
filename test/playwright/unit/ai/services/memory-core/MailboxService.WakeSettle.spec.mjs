import {setup} from '../../../../setup.mjs';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : 'MailboxWakeSettleTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import                             'neo.mjs/src/manager/Instance.mjs';
import fs                    from 'node:fs/promises';
import os                    from 'node:os';
import path                  from 'node:path';
import RequestContextService from '../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';
import {createWakeReceiver}  from '../../../../../../ai/daemons/wake/receiver.mjs';
import {WakeReceiverState}   from '../../../../../../ai/daemons/wake/receiverState.mjs';
import {readWakeDelivery}    from '../../../../../../ai/services/memory-core/wakeDeliveryReader.mjs';

test.describe.configure({mode: 'serial'});

test.describe('MailboxService ↔ WakeSubscriptionService ↔ createWakeReceiver settled-source skip', () => {
    let GraphService, LifecycleService, MailboxService, WakeSubscriptionService, WebhookDeliveryService;
    let baseUrl, originalReadFn, receiver, signingKey, state, stateDir, subscriptionId;

    const SENDER    = '@wake-settle-sender',
          RECIPIENT = '@wake-settle-recipient';

    test.beforeAll(async () => {
        GraphService            = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        MailboxService          = (await import('../../../../../../ai/services/memory-core/MailboxService.mjs')).default;
        WakeSubscriptionService = (await import('../../../../../../ai/services/memory-core/WakeSubscriptionService.mjs')).default;
        WebhookDeliveryService  = (await import('../../../../../../ai/services/memory-core/WebhookDeliveryService.mjs')).default;
        LifecycleService        = (await import('../../../../../../ai/services/memory-core/lifecycle/SystemLifecycleService.mjs')).default;

        if (!LifecycleService._initPromise) {
            await LifecycleService.initAsync();
        } else {
            await LifecycleService.ready();
        }

        originalReadFn = WakeSubscriptionService.wakeDeliveryReadFn;
        WebhookDeliveryService.configure({attemptTimeoutSeconds: 5});

        GraphService.upsertNode({id: SENDER,    type: 'AgentIdentity', name: 'Wake Settle Sender',    properties: {accountType: 'agent'}});
        GraphService.upsertNode({id: RECIPIENT, type: 'AgentIdentity', name: 'Wake Settle Recipient', properties: {accountType: 'agent'}});
    });

    test.afterAll(() => {
        WakeSubscriptionService.wakeDeliveryReadFn = originalReadFn;
        GraphService.removeNodes([SENDER, RECIPIENT]);
    });

    test.beforeEach(async () => {
        stateDir       = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-mailbox-wake-settle-'));
        state          = new WakeReceiverState({stateDir});
        signingKey     = 'b'.repeat(64);
        subscriptionId = `WAKE_SUB:settle-${Date.now()}`;

        await state.init();
        receiver = createWakeReceiver({
            manifest: {
                schemaVersion: 1,
                routes       : {
                    [subscriptionId]: {
                        signingKey,
                        agentIdentity        : RECIPIENT,
                        admits               : 'wake/digest',
                        harnessTargetMetadata: {adapter: 'tmux', tmuxSession: 'settle-spec'},
                        adapterConfig        : {attemptTimeoutMs: 100}
                    }
                }
            },
            state,
            // Park every dispatch as deferred so accepted digests remain `pending` in WakeReceiverState.
            dispatch: async () => ({outcome: 'deferred', outcomeReason: 'interactive-dialog-pending'}),
            logger  : {error() {}, warn() {}, log() {}}
        });

        await new Promise((resolve, reject) => {
            receiver.server.once('error', reject);
            receiver.server.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${receiver.server.address().port}`;

        GraphService.upsertNode({
            id        : subscriptionId,
            type      : 'WAKE_SUBSCRIPTION',
            properties: {
                agentIdentity        : RECIPIENT,
                trigger              : 'SENT_TO_ME',
                status               : 'active',
                harnessTarget        : 'a2a-webhook',
                harnessTargetMetadata: {
                    url        : `${baseUrl}/wake`,
                    signingKey,
                    adapter    : 'tmux',
                    tmuxSession: 'settle-spec'
                }
            }
        });

        WakeSubscriptionService.wakeDeliveryReadFn = opts => readWakeDelivery({...opts, recordsDir: state.recordsDir});
    });

    test.afterEach(async () => {
        GraphService.removeNodes([subscriptionId]);
        await new Promise(resolve => receiver.server.close(resolve));
        await fs.rm(stateDir, {recursive: true, force: true});
    });

    const asRecipient = callback => RequestContextService.run({agentIdentityNodeId: RECIPIENT}, callback);
    const sendDirect  = (subject, extra = {}) => RequestContextService.run({agentIdentityNodeId: SENDER}, () =>
        MailboxService.addMessage({to: RECIPIENT, subject, body: 'fixture', ...extra}));

    const acceptPendingDigest = async (eventId, sourceEventIds) => (await state.accept({
        subscriptionId,
        eventId,
        sourceEventIds,
        route   : {agentIdentity: RECIPIENT, harnessTargetMetadata: {adapter: 'tmux', tmuxSession: 'settle-spec'}, adapterConfig: {attemptTimeoutMs: 100}},
        envelope: {
            schemaVersion: '1.0',
            eventType    : 'wake/digest',
            eventId,
            subscriptionId,
            agentIdentity: RECIPIENT,
            payload      : {
                totalEvents: sourceEventIds.length,
                sourceEventIds,
                breakdown  : {sent_to_me: {count: sourceEventIds.length}}
            }
        }
    })).record;

    test('incremental markRead and terminal transitionTask settle matching pending receiver records while preserving unread digests', async () => {
        const msg1    = await sendDirect('incremental 1');
        const msg2    = await sendDirect('incremental 2');
        const taskMsg = await sendDirect('task item', {
            task: {id: 'open-work-review-1', state: 'Submitted', assignee: RECIPIENT}
        });

        const recMsg1 = await acceptPendingDigest('wake-digest:inc-1', [msg1.messageId]);
        const recMsg2 = await acceptPendingDigest('wake-digest:inc-2', [msg2.messageId]);
        const recTask = await acceptPendingDigest('wake-digest:inc-task', ['TASK:open-work-review-1', taskMsg.messageId]);

        await asRecipient(() => MailboxService.markRead({messageId: [msg1.messageId, taskMsg.messageId]}));

        expect((await state.read(recMsg1.recordKey)).state).toBe('skipped');
        expect((await state.read(recMsg1.recordKey)).outcomeReason).toBe('source-events-already-handled');
        expect((await state.read(recMsg2.recordKey)).state).toBe('pending');
        // recTask still awaits TASK:open-work-review-1 terminal transition
        expect((await state.read(recTask.recordKey)).state).toBe('pending');

        await asRecipient(() => MailboxService.transitionTask({taskId: taskMsg.messageId, newState: 'Working'}));
        expect((await state.read(recTask.recordKey)).state).toBe('pending');

        await asRecipient(() => MailboxService.transitionTask({taskId: taskMsg.messageId, newState: 'Completed'}));
        expect((await state.read(recTask.recordKey)).state).toBe('skipped');
        expect((await state.read(recTask.recordKey)).outcomeReason).toBe('source-events-already-handled');

        // Clean up unread msg2 so next serial test starts at unreadCount === 0
        await asRecipient(() => MailboxService.markRead({messageId: msg2.messageId}));
    });

    test('historical 189-record pending backlog settles on unreadCount === 0 while unhandled records stay pending', async () => {
        const settledIds = [];
        for (let bit = 0; bit < 8; bit++) {
            const msg = await sendDirect(`historical already-read ${bit}`);
            settledIds.push(msg.messageId);
        }
        // Mark read BEFORE the 189 historical pending records are written (simulating pre-existing queue)
        await asRecipient(() => MailboxService.markRead({messageId: settledIds}));

        const historicalKeys = [];
        for (let mask = 1; mask <= 189; mask++) {
            const subset = settledIds.filter((_, bit) => (mask & (1 << bit)) !== 0);
            const record = await acceptPendingDigest(`wake-digest:hist-${mask}`, subset);
            historicalKeys.push(record.recordKey);
        }
        const unhandledRecord = await acceptPendingDigest('wake-digest:hist-unhandled', ['MESSAGE:not-in-graph']);

        expect((await state.list('pending')).length).toBe(190);

        const counts = await asRecipient(() => MailboxService.listMessages({status: 'unread', projection: 'counts'}));
        expect(counts.unreadCount).toBe(0);

        const skipped = await state.list('skipped');
        expect(skipped.length).toBe(189);
        expect(new Set(skipped.map(r => r.recordKey))).toEqual(new Set(historicalKeys));
        expect((await state.read(unhandledRecord.recordKey)).state).toBe('pending');
    });
});

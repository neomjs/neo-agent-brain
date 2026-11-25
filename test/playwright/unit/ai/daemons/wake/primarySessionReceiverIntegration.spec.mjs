import {test, expect}                                                                                                                       from '@playwright/test';
import crypto                                                                                                                               from 'node:crypto';
import fs                                                                                                                                   from 'node:fs/promises';
import os                                                                                                                                   from 'node:os';
import path                                                                                                                                 from 'node:path';
import {createWakeReceiver, loadWakeReceiverManifest}                                                                                       from '../../../../../../ai/daemons/wake/receiver.mjs';
import {formatPrimaryWakeBatch, selectUrgentPrimaryWakeBatch, selectUrgentPrimaryWakeTurn}                                                  from '../../../../../../ai/daemons/wake/primaryWakeBatch.mjs';
import {projectMessageDelivery}                                                                                                             from '../../../../../../ai/services/memory-core/wakeDeliveryProjection.mjs';
import {WakeReceiverState}                                                                                                                  from '../../../../../../ai/daemons/wake/receiverState.mjs';
import {dispatchFleetPrimarySessionWake, drainFleetPrimaryWakeRecord, startFleetPrimaryWakePump, consumeNativeWakePrompt, enrollNativeWake} from '../../../../../../ai/daemons/wake/fleetPrimarySessionWake.mjs';

test.describe('signed native wake receiver integration', () => {
    let root, stateDir, manifestPath, state, server, receiver, url, manifest, delivered, sends, consumed, mode, lastNonce, nativeInputs;
    const agentId  = 'fixture-seat', seat = '@fixture', family = 'codex-desktop', sub = 'WAKE_SUB:fixture', key = 'a'.repeat(64),
          threadId = '01990000-0000-7000-8000-000000000001';
    let config, transport;
    const resident = async () => ({pid: 123, startedAt: 'start', generation: '123:start', workspaceRoot: '/fixture/work'});
    const env      = (index, sourceEventIds = [`MESSAGE:${index}`]) => ({schemaVersion:'1.0',eventType:'wake/digest',eventId:`event-${index}`,subscriptionId:sub,
        agentIdentity:seat,payload:{totalEvents:sourceEventIds.length,sourceEventIds,breakdown:{sent_to_me:{count:sourceEventIds.length,latest:{messageId:sourceEventIds.at(-1),subject:'fixture'}}}}});

    test.beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(),'neo-primary-integration-'));
        stateDir = path.join(root,'state'); manifestPath = path.join(root,'routes.json');
        state = new WakeReceiverState({stateDir}); await state.init();
        const instanceHome = path.join(root,'agents',agentId,'harness',family);
        config = {agentId,family,instanceHome,appBundle:path.join(root,'generation','Codex.app'),hookNodePath:'/bin/node',hookModulePath:'/brain/hook.mjs'};
        manifest = {schemaVersion:1,routes:{[sub]:{agentIdentity:seat,signingKey:key,admits:'wake/digest',
            harnessTargetMetadata:{adapter:'primary-session',addressType:'userDataDir',instanceAddress:path.join(instanceHome,'electron-profile')},
            adapterConfig:{attemptTimeoutMs:1000,primarySession:config}}}};
        await fs.writeFile(manifestPath,JSON.stringify(manifest),{mode:0o600});
        await loadWakeReceiverManifest(manifestPath);
        await enrollNativeWake({manifestPath,stateDir,agentId,family});
        delivered = new Set(); sends = 0; consumed = []; nativeInputs = []; mode = 'consume';
        transport = {
            listCodexWakeTargets    : async () => [{root:true,threadId,startedAt:100,receiptOffset:0}],
            readCodexWakeActivity   : async () => ({state:'idle'}),
            verifyCodexWakeAdmission: async () => ({verified:true}),
            sendCodexSessionWake    : async ({text}) => {
                sends++;
                nativeInputs.push(text);
                const nonce = text.match(/\[NEO_WAKE_V1:([^\]]+)\]/)[1];
                lastNonce = nonce;
                if (mode === 'consume') {
                    const claim = await consumeNativeWakePrompt({manifestPath,stateDir,agentId,family,threadId,nonce,turnId:'turn-1',
                        inspectResident:resident,codexTransport:transport});
                    if (claim.admitted) {consumed.push(claim.digest); delivered.add(nonce)}
                }
                return {status:'accepted'}
            },
            readCodexWakeReceipt: async ({text}) => ({state: delivered.has(text.match(/\[NEO_WAKE_V1:([^\]]+)\]/)[1]) ? 'turn-started' : 'unknown',turnId:'turn-1'})
        };
        receiver = createWakeReceiver({manifest,state,manifestPath,logger:{log(){},warn(){},error(){}},
            dispatchPrimary:(record, options) => dispatchFleetPrimarySessionWake(record,{...options,inspectResident:resident,codexTransport:transport})});
        server = receiver.server; await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
        url = `http://127.0.0.1:${server.address().port}/wake`;
    });
    test.afterEach(async () => {await new Promise(resolve => server.close(resolve)); await fs.rm(root,{recursive:true,force:true})});
    async function post(index, sourceEventIds, decorate = () => {}) {
        const envelope = env(index, sourceEventIds);
        decorate(envelope);
        const body = JSON.stringify(envelope), signature = crypto.createHmac('sha256',key).update(body).digest('hex');
        return fetch(url,{method:'POST',headers:{'content-type':'application/json','x-neo-wake-subscription-id':envelope.subscriptionId,
            'x-neo-wake-event-id':envelope.eventId,'x-neo-wake-schema-version':'1.0','x-neo-wake-signature':signature},body})
    }

    test('signed events reach one admitted main chat, dedupe, and never leak digest into native input', async () => {
        expect((await post(1)).status).toBe(202); await receiver.drain();
        expect(await state.list('delivered')).toHaveLength(1);
        expect((await post(1)).status).toBe(200); await receiver.drain();
        expect(sends).toBe(1); expect(consumed).toHaveLength(1);
        expect((await post(2)).status).toBe(202); await receiver.drain();
        expect(await state.list('delivered')).toHaveLength(2); expect(sends).toBe(2);
        expect(nativeInputs.every(text => /^\[NEO_WAKE_V1:[0-9a-f-]{36}\] \[WAKE\]$/.test(text))).toBe(true);
    });

    test('unconfirmed send survives restart and cannot duplicate; changed host route refuses redemption', async () => {
        mode = 'hold'; expect((await post(1)).status).toBe(202); await receiver.drain();
        const [pending] = await state.list('pending'); expect(sends).toBe(1);
        await state.transition(pending.recordKey,'pending','dispatching');
        expect(await state.recoverInterrupted()).toBe(1);
        const altered = structuredClone(manifest); altered.routes[sub].harnessTargetMetadata.adapter = 'osascript';
        await fs.writeFile(manifestPath,JSON.stringify(altered),{mode:0o600}); receiver.setManifest(altered);
        const rejected = await consumeNativeWakePrompt({manifestPath,stateDir,agentId,family,threadId,nonce:lastNonce,turnId:'turn-1',
            inspectResident:resident,codexTransport:transport});
        expect(rejected).toEqual({admitted:false});
        await receiver.drain(); expect(sends).toBe(1);
        expect((await state.list('pending'))[0].deferReason).toBe('primary-session-route-unavailable');
    });

    test('receiver restart reconciles a later matching recipient claim without resending', async () => {
        mode = 'hold'; expect((await post(1)).status).toBe(202); await receiver.drain();
        const [pending] = await state.list('pending');
        await state.transition(pending.recordKey,'pending','dispatching');
        await state.recoverInterrupted();
        const claim = await consumeNativeWakePrompt({manifestPath,stateDir,agentId,family,threadId,nonce:lastNonce,turnId:'turn-1',
            inspectResident:resident,codexTransport:transport});
        expect(claim.admitted).toBe(true); delivered.add(lastNonce);
        await receiver.drain();
        expect(await state.list('delivered')).toHaveLength(1);
        expect(sends).toBe(1);
    });

    test('the receiver holds an unproven 13 ms rewrite, reconciles the same bound root and drains the next record', async () => {
        await new Promise(resolve => server.close(resolve));
        receiver = createWakeReceiver({manifest,state,manifestPath,logger:{log(){},warn(){},error(){}}});
        server = receiver.server; await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
        url = `http://127.0.0.1:${server.address().port}/wake`;
        const urgent = envelope => {envelope.payload.urgent = true; envelope.payload.breakdown.sent_to_me.highestPriority = 'high'};
        expect((await post(1, undefined, urgent)).status).toBe(202);
        await receiver.drain();
        expect(await state.list('pending')).toHaveLength(1);
        expect(sends).toBe(0);
        const pump = route => drainFleetPrimaryWakeRecord({state,stateDir,manifestPath,subscriptionId:sub,route,
            dispatch:(record, options) => dispatchFleetPrimarySessionWake(record,{...options,inspectResident:resident,codexTransport:transport})});
        const [target] = await transport.listCodexWakeTargets();
        transport.readCodexWakeActivity = async () => ({state:'busy'});
        await pump(manifest.routes[sub]); // Save the original selection without initiating a send.
        transport.readCodexWakeActivity = async () => ({state:'idle'});
        transport.listCodexWakeTargets = async () => [{...target, startedAt:target.startedAt + 13}];
        expect((await post(2)).status).toBe(202);
        await pump(manifest.routes[sub]); await receiver.drain();
        expect(await state.list('pending')).toEqual(expect.arrayContaining([
            expect.objectContaining({eventId:'event-1',urgent:true,deferReason:'native-recipient:selection-root-start-changed',waitStage:'waiting-for-chat-boundary'}),
            expect.objectContaining({eventId:'event-2',urgent:false,deferReason:'urgent native wake outstanding',waitStage:'waiting-for-spool'})
        ]));
        expect(sends).toBe(0);
        transport.listCodexWakeTargets = async () => [{...target, startedAt:target.startedAt + 13,
            threadStartMs:0x019900000000, workspaceRoot:'/fixture/work'}];
        await pump(manifest.routes[sub]);
        await receiver.drain();
        expect(await state.list('delivered')).toHaveLength(1);
        expect(sends).toBe(1);
        expect((await post(1, undefined, urgent)).status).toBe(200);
        await receiver.drain();
        await pump(manifest.routes[sub]); await receiver.drain();
        expect((await state.list('delivered')).map(record => record.eventId).sort()).toEqual(['event-1','event-2']);
        expect(sends).toBe(2);
        expect((await post(3)).status).toBe(202); await receiver.drain();
        const changed = structuredClone(manifest); changed.routes[sub].harnessTargetMetadata.adapter = 'osascript';
        await fs.writeFile(manifestPath,JSON.stringify(changed),{mode:0o600}); receiver.setManifest(changed);
        await pump(changed.routes[sub]); await receiver.drain();
        expect(sends).toBe(2);
        expect(await state.list('delivered')).toHaveLength(2);
    });

    test('one idle catch-up handoff delivers every source event in the staged normal backlog', async () => {
        await new Promise(resolve => server.close(resolve));
        let activity = 'busy',
            now      = Date.now();
        receiver = createWakeReceiver({manifest, state, manifestPath, clock: () => now++, logger: {log(){}, warn(){}, error(){}}});
        server = receiver.server;
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        url = `http://127.0.0.1:${server.address().port}/wake`;

        const targets         = [],
              sendSessionWake = transport.sendCodexSessionWake,
              pump            = () => drainFleetPrimaryWakeRecord({
                  state,
                  stateDir,
                  manifestPath,
                  subscriptionId: sub,
                  route         : manifest.routes[sub],
                  dispatch      : (record, options) => dispatchFleetPrimarySessionWake(record, {...options, inspectResident: resident, codexTransport: transport})
              });

        transport.readCodexWakeActivity = async () => ({state: activity});
        transport.sendCodexSessionWake  = async (input) => {
            targets.push(input.threadId);
            return sendSessionWake(input)
        };

        const olderBatches = Array.from({length: 16}, (_, index) =>
                  Array.from({length: index < 5 ? 2 : 1}, (_, event) => `MESSAGE:older-${index + 1}-${event + 1}`)),
              freshProbe   = ['MESSAGE:fresh-probe', 'MESSAGE:fresh-peer'],
              batches      = [...olderBatches, freshProbe],
              sourceIds    = batches.flat();

        for (const [index, ids] of olderBatches.entries()) {
            expect((await post(index, ids)).status).toBe(202);
        }
        await receiver.drain();
        await pump();
        expect((await post(olderBatches.length, freshProbe)).status).toBe(202);
        await receiver.drain();
        await pump();
        await receiver.drain();

        const pending = await state.list('pending');
        expect(pending.map(record => record.sourceEventIds)).toEqual(batches);
        expect(pending.every(record => record.urgent === false)).toBe(true);
        expect(sourceIds).toHaveLength(23);
        expect(sends).toBe(0);

        activity = 'idle';
        await pump();
        await receiver.drain();
        const firstIdleDelivered = (await state.list('delivered')).length;

        // Let the legacy one-record spool finish too, so the red control measures its extra sends.
        for (let index = 1; index < batches.length && (await state.list('pending')).length > 0; index++) {
            await pump();
            await receiver.drain();
        }

        expect(sends, 'all 17 records share one native handoff').toBe(1);
        expect(firstIdleDelivered).toBe(batches.length);
        expect(targets).toEqual([threadId]);
        expect(consumed).toHaveLength(1);
        expect(consumed[0]).toContain('23 events for @fixture');
        expect(nativeInputs).toEqual([expect.stringMatching(/^\[NEO_WAKE_V1:[0-9a-f-]{36}\] \[WAKE\]$/)]);

        const records = await new WakeReceiverState({stateDir}).list();
        expect(records.map(record => record.sourceEventIds)).toEqual(batches);
        expect(projectMessageDelivery(records, sourceIds)).toEqual(
            Object.fromEntries(sourceIds.map(id => [id, expect.objectContaining({state: 'delivered'})]))
        );

        expect((await post(0, batches[0])).status).toBe(200);
        expect((await post(olderBatches.length, freshProbe)).status).toBe(200);
        await receiver.drain();
        await pump();
        expect(sends).toBe(1);
        expect(consumed).toHaveLength(1);
    });

    /** @summary Restarts the graphless receiver in its normal staged mode for the catch-up controls. */
    async function useStagedReceiver({drain = true, subscriptionId = sub, contextProbe} = {}) {
        if (drain) await receiver.drain();
        await new Promise(resolve => server.close(resolve));
        if (contextProbe) {
            const route = manifest.routes[subscriptionId];
            manifest = {
                ...manifest,
                routes: {
                    ...manifest.routes,
                    [subscriptionId]: {
                        ...route,
                        adapterConfig: {
                            ...route.adapterConfig,
                            contextGate: {maxContextTokens:100,warnContextTokens:90,activeWithinMs:5000}
                        }
                    }
                }
            };
            await fs.writeFile(manifestPath,JSON.stringify(manifest),{mode:0o600});
        }
        let now = Date.now();
        receiver = createWakeReceiver({manifest,state,manifestPath,contextProbe,clock: () => now++,logger:{log(){},warn(){},error(){}}});
        server = receiver.server;
        await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
        url = `http://127.0.0.1:${server.address().port}/wake`;
        return () => drainFleetPrimaryWakeRecord({state,stateDir,manifestPath,subscriptionId,route:manifest.routes[subscriptionId],
            dispatch:(record, options) => dispatchFleetPrimarySessionWake(record,{...options,inspectResident:resident,codexTransport:transport})})
    }

    test('a bounded native batch keeps excess source events pending in acceptance order', async () => {
        const pump    = await useStagedReceiver();
        const sources = prefix => Array.from({length:24}, (_, index) => `MESSAGE:${prefix}-${index}`);
        const batches = [sources('a'), sources('b'), ['MESSAGE:overflow']];

        for (const [index, ids] of batches.entries()) expect((await post(index,ids)).status).toBe(202);
        await receiver.drain(); await pump(); await receiver.drain();

        expect(sends).toBe(1);
        expect(consumed[0]).toContain('48 events for @fixture');
        expect((await state.list('delivered')).map(record => record.sourceEventIds)).toEqual(batches.slice(0,2));
        expect((await state.list('pending')).map(record => record.sourceEventIds)).toEqual(batches.slice(2));

        await pump(); await receiver.drain();
        expect(sends).toBe(2);
        expect(consumed[1]).toContain('1 events for @fixture');
        expect((await state.list('delivered')).map(record => record.sourceEventIds)).toEqual(batches)
    });

    test('a bounded native batch stops before the rendered UTF-8 byte limit', async () => {
        const pump      = await useStagedReceiver();
        const largeText = 'é'.repeat(4600);
        expect((await post(1, ['MESSAGE:wide-subject'], envelope => {
            envelope.payload.breakdown.sent_to_me.latest.subject = largeText;
        })).status).toBe(202);
        expect((await post(2, ['MESSAGE:wide-task'], envelope => {
            envelope.payload.breakdown = {task_state_changed:{count:1,latest:{taskId:largeText,newState:'Working'}}};
        })).status).toBe(202);
        await receiver.drain(); await pump(); await receiver.drain();

        expect(sends).toBe(1);
        expect(Buffer.byteLength(consumed[0], 'utf8')).toBeLessThanOrEqual(16 * 1024);
        expect((await state.list('delivered')).map(record => record.sourceEventIds)).toEqual([['MESSAGE:wide-subject']]);
        expect((await state.list('pending')).map(record => record.sourceEventIds)).toEqual([['MESSAGE:wide-task']]);

        await pump(); await receiver.drain();
        expect(sends).toBe(2);
        expect((await state.list('pending'))).toHaveLength(0)
    });

    test('receiver restart finishes a partially projected native batch without resending or expanding its membership', async () => {
        let pump = await useStagedReceiver();
        mode = 'hold';
        expect((await post(1)).status).toBe(202);
        expect((await post(2)).status).toBe(202);
        await receiver.drain();
        const [anchor, member] = await state.list('pending');
        await pump();
        const nonce = lastNonce, claimArgs = {manifestPath,stateDir,agentId,family,threadId,nonce,turnId:'turn-1',codexTransport:transport};
        expect(sends).toBe(1);
        expect(await state.list('delivered')).toHaveLength(0);

        expect((await post(3)).status).toBe(202);
        await receiver.drain();
        expect(await consumeNativeWakePrompt({...claimArgs,inspectResident: async () => ({generation:'old:process'})})).toEqual({admitted:false});
        await pump();
        expect(sends).toBe(1);
        const claim = await consumeNativeWakePrompt({...claimArgs,inspectResident:resident});
        expect(claim).toMatchObject({admitted:true,digest: expect.stringContaining('2 events for @fixture')});
        delivered.add(nonce);
        await pump();

        const transition = state.transition;
        state.transition = async function(key, from, to, details) {
            if (key === member.recordKey && to === 'delivered') throw Error('fixture interruption during batch projection');
            return transition.call(this,key,from,to,details)
        };
        try {
            await receiver.drain();
            expect((await state.read(anchor.recordKey)).state).toBe('delivered');
            expect((await state.read(member.recordKey)).state).toBe('pending');
        } finally {
            state.transition = transition;
        }

        // The verified attempt survives the spool receipt, receiver restart and old subscription.
        await fs.rm(path.join(stateDir,'primary-sessions','fixture.request.json.result'));
        const replacement = 'WAKE_SUB:replacement';
        manifest = {...manifest,routes:{[replacement]:manifest.routes[sub]}};
        await fs.writeFile(manifestPath,JSON.stringify(manifest),{mode:0o600});
        pump = await useStagedReceiver({drain:false,subscriptionId:replacement});
        await receiver.drain();
        expect(sends).toBe(1);
        expect((await state.read(member.recordKey)).expectedRecipient).toMatchObject({recordKey:member.recordKey,nonce});
        expect((await state.list('pending')).map(record => record.sourceEventIds)).toEqual([['MESSAGE:3']]);
        await expect(consumeNativeWakePrompt({...claimArgs,inspectResident:resident})).resolves.toEqual({admitted:false});

        mode = 'consume';
        expect((await post(4,['MESSAGE:replacement'],envelope => {envelope.subscriptionId = replacement})).status).toBe(202);
        await receiver.drain(); await pump(); await receiver.drain();
        expect(sends).toBe(2);
        expect((await state.list('delivered')).map(record => record.sourceEventIds)).toEqual(
            [['MESSAGE:1'],['MESSAGE:2'],['MESSAGE:replacement']]
        );
        expect((await state.list('pending')).map(record => record.sourceEventIds)).toEqual([['MESSAGE:3']]);
    });

    test('a verified batch settles before a newer context deferral blocks fresh handoffs', async () => {
        let   contextTokens = 10;
        const pump          = await useStagedReceiver({contextProbe: async () => ({contextTokens})});
        for (const index of [1,2]) expect((await post(index)).status).toBe(202);
        await receiver.drain();
        await pump();
        expect(sends).toBe(1);
        expect(consumed[0]).toContain('2 events for @fixture');

        // The verified batch can settle after context growth now blocks all future sends.
        contextTokens = 101;
        await receiver.drain();
        expect((await state.list('delivered')).map(record => record.sourceEventIds)).toEqual([['MESSAGE:1'],['MESSAGE:2']]);

        expect((await post(3)).status).toBe(202);
        await receiver.drain(); await pump(); await receiver.drain();
        expect(sends).toBe(1);
        expect(await state.list('pending')).toEqual([
            expect.objectContaining({eventId:'event-3',deferReason:'context-gate:101>100'})
        ]);
    });

    for (const hold of ['dispatching', 'context deferred']) {
        test(`preserves acceptance order when an older staged candidate is ${hold}`, async () => {
            let   blocked = true;
            const pump    = await useStagedReceiver({contextProbe: async record => ({
                contextTokens: blocked && record.eventId === 'event-2' ? 101 : 10
            })});

            for (const index of [1,2,3]) expect((await post(index)).status).toBe(202);
            await receiver.drain();
            // B was held on the first pass, so it stages after C when the gate opens.
            blocked = false;
            await receiver.drain();
            const [, b, c] = await state.list('pending');
            const pointer  = JSON.parse(await fs.readFile(path.join(stateDir,'primary-sessions','fixture.request.json'),'utf8'));
            expect(pointer.candidates).toEqual([c.recordKey,b.recordKey]);

            if (hold === 'dispatching') {
                // Interrupt between the receiver's dispatching transition and its fresh eligibility check.
                await state.transition(b.recordKey,'pending','dispatching');
            } else {
                blocked = true;
                await receiver.drain();
                expect((await state.read(b.recordKey)).deferReason).toBe('context-gate:101>100');
            }

            await pump();
            expect(sends).toBe(1);
            expect(consumed[0]).toContain('1 events for @fixture');

            if (hold === 'dispatching') await state.transition(b.recordKey,'dispatching','pending');
            blocked = false;
            await receiver.drain();
            expect((await state.list('delivered')).map(record => record.eventId)).toEqual(['event-1']);
            await pump(); await receiver.drain();
            expect(sends).toBe(2);
            expect(consumed[1]).toContain('2 events for @fixture');
            expect((await state.list('delivered')).map(record => record.eventId)).toEqual(['event-1','event-2','event-3'])
        });
    }

    test('an idle-only nudge uses its individual receipt while content batches around it', async () => {
        const pump = await useStagedReceiver();
        expect((await post(1)).status).toBe(202);
        expect((await post(2,['PULSE:idle-nudge'],envelope => {
            envelope.payload.breakdown = {heartbeat_pulse:{count:1,sources:{'idle-out-nudge':1}}}
        })).status).toBe(202);
        expect((await post(3)).status).toBe(202);
        await receiver.drain(); await pump(); await receiver.drain();
        expect(sends).toBe(1);
        expect((await state.list('delivered')).map(record => record.eventId)).toEqual(['event-1','event-3']);
        expect((await state.list('pending')).map(record => record.eventId)).toEqual(['event-2']);
        await receiver.drain(); await pump(); await receiver.drain();
        expect(sends).toBe(2);
        const [ordinary,nudge] = await state.list('delivered');
        expect(nudge.expectedRecipient.nonce).not.toBe(ordinary.expectedRecipient.nonce);
    });

    test('an urgent pointer staged during the idle proof preempts the ordinary batch before its claim', async () => {
        const pump = await useStagedReceiver();
        expect((await post(1)).status).toBe(202);
        expect((await post(2)).status).toBe(202);
        await receiver.drain();

        let enterProof, continueProof;
        const proving = new Promise(resolve => {enterProof = resolve});
        const proof   = new Promise(resolve => {continueProof = resolve});
        transport.readCodexWakeActivity = async () => {
            enterProof();
            await proof;
            return {state:'idle'}
        };
        const ordinary = pump();
        try {
            await proving;
            expect((await post(3, ['MESSAGE:urgent'], envelope => {
                envelope.payload.breakdown.sent_to_me.highestPriority = 'high';
                envelope.payload.breakdown.sent_to_me.latest.priority = 'high';
                envelope.payload.breakdown.sent_to_me.latest.subject = 'urgent fixture';
            })).status).toBe(202);
            await receiver.drain();
        } finally {
            continueProof();
        }
        await ordinary;
        expect(sends).toBe(0);

        await pump(); await receiver.drain();
        expect(sends).toBe(1);
        expect(consumed[0]).toContain('urgent fixture');
        expect((await state.list('delivered')).map(record => record.sourceEventIds)).toEqual([['MESSAGE:urgent']]);
        expect(await state.list('pending')).toHaveLength(2);

        await pump(); await receiver.drain();
        expect(sends).toBe(2);
        expect(consumed[1]).toContain('2 events for @fixture');
        expect(await state.list('delivered')).toHaveLength(3)
    });

    test('a wake turn that ended without the hook reaches its record as delivered without acknowledgement, and is not sent again', async () => {
        await new Promise(resolve => server.close(resolve));
        receiver = createWakeReceiver({manifest,state,manifestPath,logger:{log(){},warn(){},error(){}}});
        server = receiver.server; await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
        url = `http://127.0.0.1:${server.address().port}/wake`;
        mode = 'silent';
        const ended = new Set();
        transport.readCodexWakeReceipt = async ({text}) => ended.has(text) ? {state:'turn-unacknowledged',threadId,turnId:'turn-bare'} : {state:'unknown'};
        const pump = () => drainFleetPrimaryWakeRecord({state,stateDir,manifestPath,subscriptionId:sub,route:manifest.routes[sub],
            dispatch:(record, options) => dispatchFleetPrimarySessionWake(record,{...options,inspectResident:resident,codexTransport:transport})});
        expect((await post(1)).status).toBe(202);
        await receiver.drain(); await pump(); await receiver.drain();
        expect(sends).toBe(1);
        expect(await state.list('delivered')).toHaveLength(0);
        ended.add(nativeInputs[0]);
        await pump(); await receiver.drain(); await pump();
        expect(await state.list('delivered')).toEqual([expect.objectContaining({acknowledged: false})]);
        expect(sends).toBe(1);
    });

    test('a missing first seat record cannot starve the next seat in the Fleet pump', async () => {
        await new Promise(resolve => server.close(resolve));
        receiver = createWakeReceiver({manifest,state,manifestPath,logger:{log(){},warn(){},error(){}}});
        server = receiver.server; await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
        url = `http://127.0.0.1:${server.address().port}/wake`;
        expect((await post(1)).status).toBe(202); await receiver.drain();
        const bad = structuredClone(manifest.routes[sub]);
        bad.agentIdentity = '@broken';
        bad.adapterConfig = {...bad.adapterConfig, primarySession:{...bad.adapterConfig.primarySession,agentId:'broken'}};
        manifest.routes = {'WAKE_SUB:broken':bad, ...manifest.routes};
        await fs.writeFile(manifestPath,JSON.stringify(manifest),{mode:0o600});
        await enrollNativeWake({manifestPath,stateDir,agentId:'broken',family});
        await fs.writeFile(path.join(stateDir,'primary-sessions','broken.request.json'),JSON.stringify({recordKey:'f'.repeat(64)}),{mode:0o600});
        let finish;
        const done     = new Promise(resolve => {finish=resolve});
        const warnings = [];
        const pump     = startFleetPrimaryWakePump({manifestPath,intervalMs:10000,logger:{warn:message => warnings.push(message)},
            verifyCodexRoute:async (candidate, live) => candidate.agentId === config.agentId && live.generation === '123:start',
            drainRecord:async options => {
                await drainFleetPrimaryWakeRecord({...options,dispatch:(record, driverOptions) =>
                    dispatchFleetPrimarySessionWake(record,{...driverOptions,inspectResident:resident,codexTransport:transport})});
                if (options.subscriptionId === sub) finish()
            }});
        let timeout;
        try {
            await Promise.race([done,new Promise((_,reject) => {timeout=setTimeout(() => reject(new Error('later seat starved')),2000)})]);
        } finally { clearTimeout(timeout); await pump.stop() }
        await receiver.drain();
        expect(warnings.some(message => message.includes('WAKE_SUB:broken'))).toBe(true);
        expect(await state.list('delivered')).toHaveLength(1);
        expect(sends).toBe(1);
    });

    test('AC-2 — before native send, urgent record preempts unsent ordinary pointer with zero GUI fallback and ordinary delivers afterward', async () => {
        let guiCalls = 0;
        await new Promise(resolve => server.close(resolve));
        receiver = createWakeReceiver({
            manifest,
            state,
            manifestPath,
            logger  : {log(){}, warn(){}, error(){}},
            dispatch: async () => { guiCalls++; return 'delivered' }
        });
        server = receiver.server;
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        url = `http://127.0.0.1:${server.address().port}/wake`;

        const postCustom = envelope => {
            const body      = JSON.stringify(envelope),
                  signature = crypto.createHmac('sha256', key).update(body).digest('hex');
            return fetch(url, {
                method : 'POST',
                headers: {
                    'content-type'              : 'application/json',
                    'x-neo-wake-subscription-id': envelope.subscriptionId,
                    'x-neo-wake-event-id'       : envelope.eventId,
                    'x-neo-wake-schema-version' : '1.0',
                    'x-neo-wake-signature'      : signature
                },
                body
            });
        };

        const nowIso    = new Date().toISOString();
        const normalEnv = {
            schemaVersion : '1.0',
            eventType     : 'wake/digest',
            eventId       : 'event-normal-unsent',
            subscriptionId: sub,
            agentIdentity : seat,
            payload       : {
                totalEvents   : 1,
                sourceEventIds: ['MESSAGE:normal-unsent'],
                breakdown     : {sent_to_me: {count: 1, highestPriority: 'normal', latest: {messageId: 'MESSAGE:normal-unsent', priority: 'normal', sentAt: nowIso, subject: 'ordinary digest'}}}
            }
        };
        const urgentEnv = {
            schemaVersion : '1.0',
            eventType     : 'wake/digest',
            eventId       : 'event-urgent-preempt',
            subscriptionId: sub,
            agentIdentity : seat,
            payload       : {
                totalEvents   : 1,
                urgent        : true,
                sourceEventIds: ['MESSAGE:urgent-preempt'],
                breakdown     : {sent_to_me: {count: 1, highestPriority: 'high', latest: {messageId: 'MESSAGE:urgent-preempt', priority: 'high', sentAt: nowIso, subject: 'urgent interrupt'}}}
            }
        };

        expect((await postCustom(normalEnv)).status).toBe(202);
        await receiver.drain();
        expect(sends, 'ordinary record staged on host spool but not yet sent to native queue').toBe(0);
        expect(guiCalls).toBe(0);

        expect((await postCustom(urgentEnv)).status).toBe(202);
        await receiver.drain();
        expect(guiCalls, 'pending primary-session never falls back to GUI typing').toBe(0);

        await expect(fs.stat(path.join(stateDir, 'primary-sessions', 'fixture.request.json'))).rejects.toMatchObject({code: 'ENOENT'});
        const urgentPointer = JSON.parse(await fs.readFile(path.join(stateDir, 'primary-sessions', 'fixture.urgent.request.json'), 'utf8'));
        expect(urgentPointer.urgent).toBe(true);

        const pump = () => drainFleetPrimaryWakeRecord({
            state,
            stateDir,
            manifestPath,
            subscriptionId: sub,
            route         : manifest.routes[sub],
            dispatch      : (record, options) => dispatchFleetPrimarySessionWake(record, {...options, inspectResident: resident, codexTransport: transport})
        });

        await pump();
        await receiver.drain();
        expect(consumed).toHaveLength(1);
        expect(consumed[0]).toContain('urgent interrupt');
        expect(sends).toBe(1);

        await pump();
        await receiver.drain();
        expect(consumed).toHaveLength(2);
        expect(consumed[1]).toContain('ordinary digest');
        expect(sends).toBe(2);
        expect(guiCalls).toBe(0);

        expect((await postCustom(urgentEnv)).status).toBe(200);
        expect((await postCustom(normalEnv)).status).toBe(200);
        expect(sends, 'deduplication history preserved for both records').toBe(2);
    });

    test('AC-2 & AC-3 — after queue acceptance without receipt, ambiguous normal is preserved while urgent delivers once, survives restart, and isolates seats', async () => {
        let guiCalls  = 0,
            busyState = 'idle';
        await new Promise(resolve => server.close(resolve));

        const subPeer    = 'WAKE_SUB:peer-two',
              seatPeer   = '@peertwo',
              agentPeer  = 'peertwo',
              threadPeer = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              peerHome   = path.join(root, 'agents', agentPeer, 'harness', family),
              peerConfig = {agentId: agentPeer, family, instanceHome: peerHome, appBundle: path.join(root, 'generation', 'Codex.app'), hookNodePath: '/bin/node', hookModulePath: '/brain/hook.mjs'};

        manifest.routes[subPeer] = {
            agentIdentity        : seatPeer,
            signingKey           : key,
            admits               : 'wake/digest',
            harnessTargetMetadata: {adapter: 'primary-session', addressType: 'userDataDir', instanceAddress: path.join(peerHome, 'electron-profile')},
            adapterConfig        : {attemptTimeoutMs: 1000, primarySession: peerConfig}
        };
        await fs.writeFile(manifestPath, JSON.stringify(manifest), {mode: 0o600});
        await enrollNativeWake({manifestPath, stateDir, agentId: agentPeer, family});

        const sentByThread   = [];
        const multiTransport = {
            listCodexWakeTargets    : async ({home}) => [{root: true, threadId: home.includes(agentPeer) ? threadPeer : threadId, startedAt: 100, receiptOffset: 0}],
            readCodexWakeActivity   : async ({threadId: tid}) => ({state: tid === threadId ? busyState : 'idle'}),
            verifyCodexWakeAdmission: async () => ({verified: true}),
            sendCodexSessionWake    : async ({threadId: tid, text}) => {
                sends++;
                const nonce = text.match(/\[NEO_WAKE_V1:([^\]]+)\]/)[1];
                sentByThread.push({threadId: tid, nonce});
                if (mode === 'consume' || tid === threadPeer) {
                    const claim = await consumeNativeWakePrompt({
                        manifestPath,
                        stateDir,
                        agentId        : tid === threadPeer ? agentPeer : agentId,
                        family,
                        threadId       : tid,
                        nonce,
                        turnId         : `turn-${sentByThread.length}`,
                        inspectResident: resident,
                        codexTransport : multiTransport
                    });
                    if (claim.admitted) {
                        consumed.push(claim.digest);
                        delivered.add(nonce);
                    }
                }
                return {status: 'accepted'}
            },
            readCodexWakeReceipt    : async ({text, threadId: tid}) => {
                const nonce = text.match(/\[NEO_WAKE_V1:([^\]]+)\]/)[1];
                return delivered.has(nonce) ? {state: 'turn-started', threadId: tid, turnId: `turn-${sentByThread.findIndex(x => x.nonce === nonce) + 1}`} : {state: 'unknown'}
            }
        };

        receiver = createWakeReceiver({
            manifest,
            state,
            manifestPath,
            logger  : {log(){}, warn(){}, error(){}},
            dispatch: async () => { guiCalls++; return 'delivered' }
        });
        server = receiver.server;
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        url = `http://127.0.0.1:${server.address().port}/wake`;

        const postCustom = envelope => {
            const body      = JSON.stringify(envelope),
                  signature = crypto.createHmac('sha256', key).update(body).digest('hex');
            return fetch(url, {
                method : 'POST',
                headers: {
                    'content-type'              : 'application/json',
                    'x-neo-wake-subscription-id': envelope.subscriptionId,
                    'x-neo-wake-event-id'       : envelope.eventId,
                    'x-neo-wake-schema-version' : '1.0',
                    'x-neo-wake-signature'      : signature
                },
                body
            });
        };

        const pumpSeat = targetSub => drainFleetPrimaryWakeRecord({
            state,
            stateDir,
            manifestPath,
            subscriptionId: targetSub,
            route         : manifest.routes[targetSub],
            dispatch      : (record, options) => dispatchFleetPrimarySessionWake(record, {...options, inspectResident: resident, codexTransport: multiTransport})
        });

        const nowIso      = new Date().toISOString();
        const normalAmbig = {
            schemaVersion : '1.0',
            eventType     : 'wake/digest',
            eventId       : 'event-normal-ambig',
            subscriptionId: sub,
            agentIdentity : seat,
            payload       : {
                totalEvents   : 1,
                sourceEventIds: ['MESSAGE:normal-ambig'],
                breakdown     : {sent_to_me: {count: 1, highestPriority: 'normal', latest: {messageId: 'MESSAGE:normal-ambig', priority: 'normal', sentAt: nowIso, subject: 'ambiguous normal'}}}
            }
        };
        const urgentLater = {
            schemaVersion : '1.0',
            eventType     : 'wake/digest',
            eventId       : 'event-urgent-later',
            subscriptionId: sub,
            agentIdentity : seat,
            payload       : {
                totalEvents   : 1,
                urgent        : true,
                sourceEventIds: ['MESSAGE:urgent-later'],
                breakdown     : {sent_to_me: {count: 1, highestPriority: 'high', latest: {messageId: 'MESSAGE:urgent-later', priority: 'high', sentAt: nowIso, subject: 'urgent while normal unconfirmed'}}}
            }
        };
        const peerUrgent = {
            schemaVersion : '1.0',
            eventType     : 'wake/digest',
            eventId       : 'event-peer-two',
            subscriptionId: subPeer,
            agentIdentity : seatPeer,
            payload       : {
                totalEvents   : 1,
                urgent        : true,
                sourceEventIds: ['MESSAGE:peer-two'],
                breakdown     : {sent_to_me: {count: 1, highestPriority: 'high', latest: {messageId: 'MESSAGE:peer-two', priority: 'high', sentAt: nowIso, subject: 'second seat independent'}}}
            }
        };

        mode = 'hold';
        expect((await postCustom(normalAmbig)).status).toBe(202);
        await receiver.drain();
        await pumpSeat(sub);
        await receiver.drain();
        expect(sends).toBe(1);
        const normalNonce = sentByThread[0].nonce;

        const [normalPending] = await state.list('pending');
        expect(normalPending.waitStage).toBe('waiting-for-receipt');
        expect(normalPending.deferReason).toBe('native-recipient:receipt-unproven');

        busyState = 'busy';
        expect((await postCustom(urgentLater)).status).toBe(202);
        expect((await postCustom(peerUrgent)).status).toBe(202);
        await receiver.drain();
        await pumpSeat(sub);
        await pumpSeat(subPeer);
        await receiver.drain();

        expect(consumed.some(d => d.includes('second seat independent')), 'second seat delivers independently').toBe(true);

        const pendingRecords = await state.list('pending');
        const heldUrgent     = pendingRecords.find(r => r.eventId === 'event-urgent-later');
        expect(heldUrgent).toMatchObject({
            deferReason    : 'native-recipient:active-turn-adapter-unavailable',
            namedDependency: '#1741',
            waitStage      : 'waiting-for-chat-boundary'
        });
        expect(guiCalls).toBe(0);

        await state.transition(heldUrgent.recordKey, 'pending', 'dispatching');
        expect(await state.recoverInterrupted()).toBe(1);

        busyState = 'idle';
        mode      = 'consume';
        await receiver.drain();
        await pumpSeat(sub);
        await receiver.drain();

        const deliveredAfterUrgent = await state.list('delivered');
        expect(deliveredAfterUrgent.map(r => r.eventId)).toContain('event-urgent-later');
        expect(consumed.some(d => d.includes('urgent while normal unconfirmed'))).toBe(true);
        expect(sends, '1 normal + 1 peer + 1 urgent — normal was never resent').toBe(3);

        const normalClaim = await consumeNativeWakePrompt({
            manifestPath,
            stateDir,
            agentId,
            family,
            threadId,
            nonce          : normalNonce,
            turnId         : 'turn-1',
            inspectResident: resident,
            codexTransport : multiTransport
        });
        expect(normalClaim.admitted).toBe(true);
        expect(normalClaim.digest).toContain('ambiguous normal');
        delivered.add(normalNonce);

        await pumpSeat(sub);
        await receiver.drain();

        const allDelivered = await state.list('delivered');
        expect(allDelivered.map(r => r.eventId).sort()).toEqual(['event-normal-ambig', 'event-peer-two', 'event-urgent-later']);
        expect(sends, 'normal reconciled from its original send without duplicate turn').toBe(3);
        expect(guiCalls).toBe(0);
    });

    test.describe('Antigravity primary-session catch-up batching (#1887)', () => {
        let agySub, agySeat, agyAgent, agyThread, agyHome, agyAppBundle, agyDataDir, agySidecar, agyStatus, agySends, agyConsumed, agyOutcomes, agyTransport;

        async function setupAntigravityRoute({contextProbe} = {}) {
            await new Promise(resolve => server.close(resolve));
            agySub       = 'WAKE_SUB:antigravity-seat';
            agySeat      = '@neo-gemini-julia';
            agyAgent     = 'neo-gemini-julia';
            agyThread    = '79e7688c-da7a-4106-8be6-396cbf27c38f';
            agyHome      = path.join(root, 'agents', agyAgent, 'harness', 'antigravity');
            agyAppBundle = path.join(root, 'generation', 'Antigravity.app');
            agyDataDir   = path.join(root, 'agy-appdata');
            agySidecar   = {
                appPid      : 405,
                appStart    : 'birth',
                appBundle   : agyAppBundle,
                instanceHome: agyHome,
                environment : {ANTIGRAVITY_AGENTAPI_EXE: '/bin/language_server'}
            };
            agyStatus   = 'CASCADE_RUN_STATUS_IDLE';
            agySends    = [];
            agyConsumed = [];
            agyOutcomes = new Map();

            const agyConfig = {
                agentId     : agyAgent,
                family      : 'antigravity',
                instanceHome: agyHome,
                appBundle   : agyAppBundle,
                projectId   : 'proj-1',
                projectRoot : '/fixture/work'
            };

            manifest = {
                schemaVersion: 1,
                routes       : {
                    [agySub]: {
                        agentIdentity        : agySeat,
                        signingKey           : key,
                        admits               : 'wake/digest',
                        harnessTargetMetadata: {adapter: 'primary-session', addressType: 'userDataDir', instanceAddress: agyHome},
                        adapterConfig        : {
                            attemptTimeoutMs: 1000,
                            primarySession  : agyConfig,
                            ...(contextProbe ? {contextGate: {maxContextTokens: 100, warnContextTokens: 90, activeWithinMs: 5000}} : {})
                        }
                    }
                }
            };
            await fs.writeFile(manifestPath, JSON.stringify(manifest), {mode: 0o600});
            await loadWakeReceiverManifest(manifestPath);
            await enrollNativeWake({manifestPath, stateDir, agentId: agyAgent, family: 'antigravity'});

            const agyResident = async () => ({pid: 405, startedAt: 'birth', generation: '405:birth', workspaceRoot: '/fixture/work'});
            agyTransport = {
                latestAntigravityWakeTarget   : async () => ({root: true, threadId: agyThread, startSequence: 1, status: agyStatus}),
                readAntigravityWakeTarget     : async () => ({threadId: agyThread, projectId: 'proj-1', status: agyStatus}),
                verifyAntigravityWakeAdmission: async () => ({verified: true}),
                captureAntigravityWakeCursor  : () => ({dev: 1, ino: 1, offset: 0, tailHash: 'a'.repeat(64)}),
                sendAntigravitySessionWake    : async req => {
                    agySends.push(req);
                    const nonce = req.message.match(/\[NEO_WAKE_V1:([^\]]+)\]/)[1];
                    lastNonce = nonce;
                    if (mode === 'consume') {
                        const claim = await consumeNativeWakePrompt({
                            manifestPath,
                            stateDir,
                            agentId             : agyAgent,
                            family              : 'antigravity',
                            threadId            : agyThread,
                            nonce,
                            inspectResident     : agyResident,
                            antigravityTransport: agyTransport,
                            appDataDir          : agyDataDir
                        });
                        if (claim.admitted) {
                            agyConsumed.push(claim.digest);
                            agyOutcomes.set(nonce, {outcome: 'observed', reason: 'private-model-ack'});
                        }
                    }
                    return {outcome: 'unknown', reason: 'agentapi-dispatch-exited-zero'}
                },
                readAntigravityWakeReceipt    : ({text}) => {
                    const nonce = text.match(/\[NEO_WAKE_V1:([^\]]+)\]/)[1];
                    return agyOutcomes.get(nonce) || {outcome: 'unknown'}
                }
            };

            let now = Date.now();
            receiver = createWakeReceiver({manifest, state, manifestPath, contextProbe, clock: () => now++, logger: {log(){}, warn(){}, error(){}}});
            server   = receiver.server;
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            url = `http://127.0.0.1:${server.address().port}/wake`;

            const postAgy = (index, sourceEventIds = [`MESSAGE:agy-${index}`], decorate = () => {}) => post(index, sourceEventIds, envelope => {
                envelope.subscriptionId = agySub;
                envelope.agentIdentity  = agySeat;
                decorate(envelope);
            });
            const pumpAgy = () => drainFleetPrimaryWakeRecord({
                state,
                stateDir,
                manifestPath,
                subscriptionId: agySub,
                route         : manifest.routes[agySub],
                sidecar       : agySidecar,
                dispatch      : (record, options) => dispatchFleetPrimarySessionWake(record, {
                    ...options,
                    inspectResident     : agyResident,
                    antigravityTransport: agyTransport,
                    appDataDir          : agyDataDir
                })
            });

            return {postAgy, pumpAgy, agyResident}
        }

        test('batches queued ordinary wakes while CASCADE_RUN_STATUS_RUNNING into one PreInvocation digest at CASCADE_RUN_STATUS_IDLE', async () => {
            const {postAgy, pumpAgy} = await setupAntigravityRoute();
            agyStatus = 'CASCADE_RUN_STATUS_RUNNING';

            const batches   = [['MESSAGE:nov15-1'], ['MESSAGE:nov15-2', 'MESSAGE:nov15-3'], ['MESSAGE:nov16-1'], ['MESSAGE:nov16-2'], ['MESSAGE:fresh-1', 'MESSAGE:fresh-2']],
                  sourceIds = batches.flat();

            for (const [index, ids] of batches.entries()) {
                expect((await postAgy(index, ids)).status).toBe(202);
            }
            await receiver.drain();
            await pumpAgy();
            await receiver.drain();

            expect(agySends, 'no sidecar dispatch while Antigravity root is running').toBeTruthy();
            expect(agySends).toHaveLength(0);
            expect(await state.list('pending')).toHaveLength(batches.length);

            agyStatus = 'CASCADE_RUN_STATUS_IDLE';
            await pumpAgy();
            await receiver.drain();

            for (let index = 1; index < batches.length && (await state.list('pending')).length > 0; index++) {
                await pumpAgy();
                await receiver.drain();
            }

            expect(agySends, 'all queued Antigravity batches coalesce into one sidecar handoff').toHaveLength(1);
            expect(agyConsumed).toHaveLength(1);
            expect(agyConsumed[0]).toContain('7 events for @neo-gemini-julia');
            expect(agyConsumed[0]).toMatch(/\[NEO_WAKE_RECEIVED:[0-9a-f-]{36}\]/);

            const records = await state.list('delivered');
            expect(records).toHaveLength(batches.length);
            expect(projectMessageDelivery(records, sourceIds)).toEqual(
                Object.fromEntries(sourceIds.map(id => [id, expect.objectContaining({state: 'delivered'})]))
            );
        });

        test('enforces 48-event overflow, urgent preemption, frozen-member restart recovery, and turn-unacknowledged propagation on Antigravity', async () => {
            const {postAgy, pumpAgy, agyResident} = await setupAntigravityRoute();
            const chunk                           = prefix => Array.from({length: 24}, (_, i) => `MESSAGE:${prefix}-${i}`);

            expect((await postAgy(1, chunk('a'))).status).toBe(202);
            expect((await postAgy(2, chunk('b'))).status).toBe(202);
            expect((await postAgy(3, ['MESSAGE:overflow-49'])).status).toBe(202);
            await receiver.drain();

            // Stage an urgent wake before the sidecar dispatches the ordinary batch -> urgent preempts first
            expect((await postAgy(4, ['MESSAGE:urgent-dm'], envelope => {
                envelope.payload.urgent = true;
                envelope.payload.breakdown.sent_to_me.highestPriority = 'high';
                envelope.payload.breakdown.sent_to_me.latest.priority = 'high';
            })).status).toBe(202);
            await receiver.drain();
            await pumpAgy();
            await receiver.drain();

            expect(agySends).toHaveLength(1);
            expect((await state.list('delivered')).map(r => r.sourceEventIds)).toEqual([['MESSAGE:urgent-dm']]);
            expect(await state.list('pending')).toHaveLength(3);

            // Re-stage the 3 ordinary records, hold redemption across a restart, then settle as turn-unacknowledged
            mode = 'hold';
            await receiver.drain();
            await pumpAgy();
            expect(agySends).toHaveLength(2);
            const batchNonce = lastNonce;

            const claim = await consumeNativeWakePrompt({
                manifestPath,
                stateDir,
                agentId             : agyAgent,
                family              : 'antigravity',
                threadId            : agyThread,
                nonce               : batchNonce,
                inspectResident     : agyResident,
                antigravityTransport: agyTransport,
                appDataDir          : agyDataDir
            });
            expect(claim).toMatchObject({admitted: true, digest: expect.stringContaining('48 events for @neo-gemini-julia')});

            // Finished idle turn never echoed NEO_WAKE_RECEIVED -> settles with acknowledged: false across frozen members
            agyOutcomes.set(batchNonce, {outcome: 'turn-unacknowledged'});
            await pumpAgy();
            await fs.rm(path.join(stateDir, 'primary-sessions', 'neo-gemini-julia.request.json.result'));
            await receiver.drain();

            const deliveredAfterUnack = await state.list('delivered');
            expect(deliveredAfterUnack).toHaveLength(3);
            expect(deliveredAfterUnack.filter(r => r.acknowledged === false)).toHaveLength(2);
            expect((await state.list('pending')).map(r => r.sourceEventIds)).toEqual([['MESSAGE:overflow-49']]);

            // Overflow record delivers cleanly on the next idle handoff
            mode = 'consume';
            await pumpAgy();
            await receiver.drain();
            expect(agySends).toHaveLength(3);
            expect(await state.list('pending')).toHaveLength(0);
            expect(await state.list('delivered')).toHaveLength(4);
        });

        test('reconciles an admitted prior-launch unacknowledged inflight across an App generation restart while urgent and batched ordinary wakes wait behind it (#1901)', async () => {
            const {postAgy} = await setupAntigravityRoute();
            let   livePid   = 405,
                liveStart   = 'birth',
                liveThread  = agyThread;

            const dynamicResident = async () => ({
                pid          : livePid,
                startedAt    : liveStart,
                generation   : `${livePid}:${liveStart}`,
                workspaceRoot: '/fixture/work'
            });
            agyTransport.latestAntigravityWakeTarget = async () => ({root: true, threadId: liveThread, startSequence: 1, status: agyStatus});
            agyTransport.readAntigravityWakeTarget   = async ({threadId}) => ({threadId, projectId: 'proj-1', status: agyStatus});
            agyTransport.sendAntigravitySessionWake  = async req => {
                agySends.push(req);
                const nonce = req.message.match(/\[NEO_WAKE_V1:([^\]]+)\]/)[1];
                lastNonce = nonce;
                if (mode === 'consume') {
                    const claim = await consumeNativeWakePrompt({
                        manifestPath,
                        stateDir,
                        agentId             : agyAgent,
                        family              : 'antigravity',
                        threadId            : liveThread,
                        nonce,
                        inspectResident     : dynamicResident,
                        antigravityTransport: agyTransport,
                        appDataDir          : agyDataDir
                    });
                    if (claim.admitted) {
                        agyConsumed.push(claim.digest);
                        agyOutcomes.set(nonce, {outcome: 'observed', reason: 'private-model-ack'});
                    }
                }
                return {outcome: 'unknown', reason: 'agentapi-dispatch-exited-zero'}
            };
            agyTransport.readAntigravityWakeReceipt = ({text, ownerTerminated}) => {
                const nonce = text.match(/\[NEO_WAKE_V1:([^\]]+)\]/)[1];
                return agyOutcomes.get(nonce) || (ownerTerminated ? {outcome: 'turn-unacknowledged'} : {outcome: 'unknown'})
            };
            const pumpDynamic = () => drainFleetPrimaryWakeRecord({
                state,
                stateDir,
                manifestPath,
                subscriptionId: agySub,
                route         : manifest.routes[agySub],
                sidecar       : {...agySidecar, appPid: livePid, appStart: liveStart},
                dispatch      : (record, options) => dispatchFleetPrimarySessionWake(record, {
                    ...options,
                    inspectResident     : dynamicResident,
                    antigravityTransport: agyTransport,
                    appDataDir          : agyDataDir
                })
            });

            // 1. Launch A (405:birth) dispatches and redeems ordinary wake 0, then exits without echoing NEO_WAKE_RECEIVED.
            mode = 'hold';
            expect((await postAgy(0, ['MESSAGE:prior-launch-wedged'])).status).toBe(202);
            await receiver.drain();
            await pumpDynamic();
            expect(agySends).toHaveLength(1);
            const oldNonce = lastNonce;
            const oldClaim = await consumeNativeWakePrompt({
                manifestPath,
                stateDir,
                agentId             : agyAgent,
                family              : 'antigravity',
                threadId            : agyThread,
                nonce               : oldNonce,
                inspectResident     : dynamicResident,
                antigravityTransport: agyTransport,
                appDataDir          : agyDataDir
            });
            expect(oldClaim.admitted).toBe(true);

            // 2. App restarts on Launch B (506:relaunch, newThread); an urgent DM and two ordinary digests arrive.
            livePid    = 506;
            liveStart  = 'relaunch';
            liveThread = '9f4290dd-8776-4a35-ab3c-72a32d314f35';
            mode       = 'consume';

            expect((await postAgy(1, ['MESSAGE:urgent-after-restart'], envelope => {
                envelope.payload.urgent = true;
                envelope.payload.breakdown.sent_to_me.highestPriority = 'high';
                envelope.payload.breakdown.sent_to_me.latest.priority = 'high';
                envelope.payload.breakdown.sent_to_me.latest.subject  = 'urgent after restart';
            })).status).toBe(202);
            expect((await postAgy(2, ['MESSAGE:ord-after-1', 'MESSAGE:ord-after-2'])).status).toBe(202);
            expect((await postAgy(3, ['MESSAGE:ord-after-3'])).status).toBe(202);
            await receiver.drain();

            // Pass 1: settles Launch A's inflight behind the waiting urgent pointer; receiver marks event-0 delivered (acknowledged: false).
            await pumpDynamic();
            await receiver.drain();
            // Pass 2: retires Launch A's slot, binds Launch B's root, and delivers the urgent DM first.
            await pumpDynamic();
            await receiver.drain();
            // Pass 3: coalesces the waiting ordinary records into one catch-up batch on Launch B's root.
            await pumpDynamic();
            await receiver.drain();

            expect(await state.list('pending')).toHaveLength(0);
            const deliveredRecords = await state.list('delivered');
            expect(deliveredRecords).toHaveLength(4);
            const priorSettled = deliveredRecords.find(r => r.eventId === 'event-0');
            expect(priorSettled).toMatchObject({
                acknowledged     : false,
                expectedRecipient: {generation: '405:birth', threadId: agyThread, nonce: oldNonce}
            });
            expect(agySends.slice(1).map(s => s.threadId)).toEqual([liveThread, liveThread]);
            expect(agyConsumed).toHaveLength(2);
            expect(agyConsumed[0]).toContain('urgent after restart');
            expect(agyConsumed[1]).toContain('3 events for @neo-gemini-julia');
        });

        test('coalesces returning-seat Antigravity urgent backlog with a fresh urgent arrival at idle', async () => {
            const {postAgy, pumpAgy} = await setupAntigravityRoute();
            agyStatus = 'CASCADE_RUN_STATUS_RUNNING';

            const decorateUrgent = subject => envelope => {
                envelope.payload.urgent = true;
                envelope.payload.breakdown.sent_to_me.highestPriority = 'high';
                envelope.payload.breakdown.sent_to_me.latest.priority = 'high';
                envelope.payload.breakdown.sent_to_me.latest.subject  = subject;
            };

            expect((await postAgy(1, ['MESSAGE:agy-old-u1', 'MESSAGE:agy-old-u2'], decorateUrgent('older agy urgent 1'))).status).toBe(202);
            expect((await postAgy(2, ['MESSAGE:agy-old-u3'], decorateUrgent('older agy urgent 2'))).status).toBe(202);
            await receiver.drain();
            await pumpAgy();
            expect(agySends).toHaveLength(0);

            expect((await postAgy(3, ['MESSAGE:agy-fresh-u4'], decorateUrgent('fresh agy urgent probe'))).status).toBe(202);
            await receiver.drain();

            agyStatus = 'CASCADE_RUN_STATUS_IDLE';
            await pumpAgy();
            await receiver.drain();

            expect(agySends).toHaveLength(1);
            expect(agyConsumed).toHaveLength(1);
            expect(agyConsumed[0]).toContain('[WAKE][priority:high] 4 events for @neo-gemini-julia');
            expect(agyConsumed[0]).toContain('fresh agy urgent probe');
            expect(await state.list('pending')).toHaveLength(0);
            expect(await state.list('delivered')).toHaveLength(3);
        });
    });

    test.describe('returning-seat urgent catch-up batching', () => {
        const urgentDecorate = subject => envelope => {
            envelope.payload.urgent                               = true;
            envelope.payload.breakdown.sent_to_me.highestPriority = 'high';
            envelope.payload.breakdown.sent_to_me.latest.priority = 'high';
            envelope.payload.breakdown.sent_to_me.latest.subject  = subject;
        };

        test('selector enforces fit, fresh-tail visibility under overflow, UTF-8 byte cap, and oversize head-tail fallback', () => {
            const makeRecord = (idx, ids, subject = `subj-${idx}`, customDecorate = null) => {
                const recordKey = String(idx + 1).padStart(64, '0');
                const envelope  = env(idx, ids);
                urgentDecorate(subject)(envelope);
                if (customDecorate) customDecorate(envelope);
                return {recordKey, sourceEventIds: ids, envelope};
            };

            const fitRecords = [
                makeRecord(0, ['MESSAGE:u0-a', 'MESSAGE:u0-b'], 'old-0'),
                makeRecord(1, ['MESSAGE:u1'], 'old-1'),
                makeRecord(2, ['MESSAGE:u2'], 'fresh-2')
            ];
            expect(selectUrgentPrimaryWakeBatch(fitRecords)).toEqual(
                fitRecords.map(({recordKey, sourceEventIds}) => ({recordKey, sourceEventIds}))
            );

            const overflowRecords = Array.from({length: 55}, (_, idx) =>
                makeRecord(idx, [`MESSAGE:over-${idx}`], idx === 54 ? 'fresh-tail' : `older-${idx}`)
            );
            const overflowSelected = selectUrgentPrimaryWakeBatch(overflowRecords);
            expect(overflowSelected).toHaveLength(48);
            expect(overflowSelected[0].recordKey).toBe(overflowRecords[0].recordKey);
            expect(overflowSelected.at(-1).recordKey).toBe(overflowRecords[54].recordKey);
            const byKey = new Map(overflowRecords.map(r => [r.recordKey, r]));
            expect(selectUrgentPrimaryWakeBatch(overflowSelected.map(m => byKey.get(m.recordKey)))).toEqual(overflowSelected);

            const byteRecords = [
                makeRecord(0, ['MESSAGE:b0'], 'head-task', envelope => {
                    envelope.payload.breakdown = {task_state_changed: {count: 1, latest: {taskId: 'é'.repeat(4500), newState: 'Working'}}};
                }),
                makeRecord(1, ['MESSAGE:b1'], 'middle-task', envelope => {
                    envelope.payload.breakdown = {task_state_changed: {count: 1, latest: {taskId: 'é'.repeat(5000), newState: 'Working'}}};
                }),
                makeRecord(2, ['MESSAGE:b2'], 'é'.repeat(3400))
            ];
            const byteSelected = selectUrgentPrimaryWakeBatch(byteRecords);
            expect(byteSelected).toEqual([
                {recordKey: byteRecords[0].recordKey, sourceEventIds: ['MESSAGE:b0']},
                {recordKey: byteRecords[2].recordKey, sourceEventIds: ['MESSAGE:b2']}
            ]);

            const makeSpan               = (prefix, count) => Array.from({length: count}, (_, i) => `MESSAGE:${prefix}-${i}`);
            const incompatibleWithMiddle = [
                makeRecord(0, makeSpan('head', 30), 'big-head'),
                makeRecord(1, makeSpan('mid', 10), 'fits-with-head'),
                makeRecord(2, makeSpan('tail', 25), 'big-tail')
            ];
            expect(selectUrgentPrimaryWakeBatch(incompatibleWithMiddle)).toEqual([
                {recordKey: incompatibleWithMiddle[0].recordKey, sourceEventIds: incompatibleWithMiddle[0].sourceEventIds},
                {recordKey: incompatibleWithMiddle[1].recordKey, sourceEventIds: incompatibleWithMiddle[1].sourceEventIds}
            ]);

            const incompatiblePairOnly = [
                makeRecord(0, makeSpan('head-only', 30), 'big-head'),
                makeRecord(1, makeSpan('tail-only', 25), 'big-tail')
            ];
            expect(selectUrgentPrimaryWakeBatch(incompatiblePairOnly)).toBeUndefined();
        });

        test('coalesces replayed older urgent records with a fresh urgent probe into one turn when all fit', async () => {
            let   activity = 'busy';
            const pump     = await useStagedReceiver();
            transport.readCodexWakeActivity = async () => ({state: activity});

            const olderRecords = [
                {ids: ['MESSAGE:old-nov18-a', 'MESSAGE:old-nov18-b'], subject: 'old nov 18 batch'},
                {ids: ['MESSAGE:old-nov19'], subject: 'old nov 19'},
                {ids: ['MESSAGE:old-nov20-a', 'MESSAGE:old-nov20-b'], subject: 'old nov 20 batch'},
                {ids: ['MESSAGE:old-nov21'], subject: 'old nov 21'},
                {ids: ['MESSAGE:old-nov22-early'], subject: 'old nov 22 early'}
            ];
            for (const [idx, item] of olderRecords.entries()) {
                expect((await post(idx + 1, item.ids, urgentDecorate(item.subject))).status).toBe(202);
            }
            await receiver.drain();
            await pump();
            expect(sends).toBe(0);

            const freshIds = ['MESSAGE:fresh-probe-1', 'MESSAGE:fresh-probe-2'];
            expect((await post(99, freshIds, urgentDecorate('fresh returning-seat probe'))).status).toBe(202);
            await receiver.drain();

            const pendingBefore = await state.list('pending');
            expect(pendingBefore).toHaveLength(6);
            expect(pendingBefore.every(r => r.urgent === true)).toBe(true);

            activity = 'idle';
            await pump();
            await receiver.drain();

            expect(sends).toBe(1);
            expect(consumed).toHaveLength(1);
            expect(consumed[0]).toContain('[WAKE][priority:high] 9 events for @fixture');
            expect(consumed[0]).toContain('fresh returning-seat probe');
            expect(await state.list('pending')).toHaveLength(0);

            const deliveredRecords = await state.list('delivered');
            expect(deliveredRecords).toHaveLength(6);
            const allSourceIds = [...olderRecords.flatMap(r => r.ids), ...freshIds];
            expect(deliveredRecords.flatMap(r => r.sourceEventIds)).toEqual(allSourceIds);
            expect(new Set(deliveredRecords.map(r => r.expectedRecipient.nonce)).size).toBe(1);
            expect(projectMessageDelivery(deliveredRecords, allSourceIds)).toEqual(
                Object.fromEntries(allSourceIds.map(id => [id, expect.objectContaining({state: 'delivered'})]))
            );
        });

        test('surfaces fresh urgent work on turn 1 under overflow beyond 48 events and drains remaining older plus new arrivals without starvation', async () => {
            let   activity = 'busy';
            const pump     = await useStagedReceiver();
            transport.readCodexWakeActivity = async () => ({state: activity});

            const olderWave = Array.from({length: 50}, (_, idx) => ({
                ids    : idx < 4 ? [`MESSAGE:old-u-${idx}-a`, `MESSAGE:old-u-${idx}-b`] : [`MESSAGE:old-u-${idx}`],
                subject: `older-urgent-${idx}`
            }));
            for (const [idx, item] of olderWave.entries()) {
                expect((await post(idx + 1, item.ids, urgentDecorate(item.subject))).status).toBe(202);
            }
            await receiver.drain();
            await pump();

            const freshWave1 = [
                {ids: ['MESSAGE:fresh-w1-1'], subject: 'fresh wave 1 lead'},
                {ids: ['MESSAGE:fresh-w1-2a', 'MESSAGE:fresh-w1-2b'], subject: 'fresh wave 1 latest'}
            ];
            expect((await post(101, freshWave1[0].ids, urgentDecorate(freshWave1[0].subject))).status).toBe(202);
            expect((await post(102, freshWave1[1].ids, urgentDecorate(freshWave1[1].subject))).status).toBe(202);
            await receiver.drain();
            expect(sends).toBe(0);

            activity = 'idle';
            await pump();
            await receiver.drain();

            expect(sends).toBe(1);
            expect(consumed).toHaveLength(1);
            expect(consumed[0]).toContain('[WAKE][priority:high] 48 events for @fixture');
            expect(consumed[0]).toContain('fresh wave 1 latest');

            const deliveredTurn1 = await state.list('delivered');
            const pendingAfter1  = await state.list('pending');
            expect(deliveredTurn1.flatMap(r => r.sourceEventIds)).toContain('MESSAGE:old-u-0-a');
            expect(deliveredTurn1.flatMap(r => r.sourceEventIds)).toContain('MESSAGE:fresh-w1-2b');
            expect(pendingAfter1).toHaveLength(9);
            expect(pendingAfter1.flatMap(r => r.sourceEventIds)).toHaveLength(9);

            activity = 'busy';
            const freshWave2 = [
                {ids: ['MESSAGE:fresh-w2-1', 'MESSAGE:fresh-w2-2'], subject: 'fresh wave 2 first'},
                {ids: ['MESSAGE:fresh-w2-3', 'MESSAGE:fresh-w2-4'], subject: 'fresh wave 2 latest'}
            ];
            expect((await post(201, freshWave2[0].ids, urgentDecorate(freshWave2[0].subject))).status).toBe(202);
            expect((await post(202, freshWave2[1].ids, urgentDecorate(freshWave2[1].subject))).status).toBe(202);
            await receiver.drain();

            activity = 'idle';
            await pump();
            await receiver.drain();

            expect(sends).toBe(2);
            expect(consumed).toHaveLength(2);
            expect(consumed[1]).toContain('[WAKE][priority:high] 13 events for @fixture');
            expect(consumed[1]).toContain('fresh wave 2 latest');
            expect(await state.list('pending')).toHaveLength(0);

            const allExpectedIds = [
                ...olderWave.flatMap(r => r.ids),
                ...freshWave1.flatMap(r => r.ids),
                ...freshWave2.flatMap(r => r.ids)
            ];
            expect(allExpectedIds).toHaveLength(61);
            const finalDelivered = await state.list('delivered');
            expect(finalDelivered).toHaveLength(54);
            expect(new Set(finalDelivered.flatMap(r => r.sourceEventIds))).toEqual(new Set(allExpectedIds));
            expect(projectMessageDelivery(finalDelivered, allExpectedIds)).toEqual(
                Object.fromEntries(allExpectedIds.map(id => [id, expect.objectContaining({state: 'delivered'})]))
            );
        });

        test('preserves immediate singleton and active-turn urgent sends, isolates recipients, keeps normal catch-up intact, and reconciles crash/retry on an in-flight urgent batch', async () => {
            await new Promise(resolve => server.close(resolve));
            let busyState      = 'idle',
                activeTurnOpen = false,
                steered        = 0;

            const subPeer    = 'WAKE_SUB:peer-isolated',
                  seatPeer   = '@peerisolated',
                  agentPeer  = 'peerisolated',
                  threadPeer = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                  peerHome   = path.join(root, 'agents', agentPeer, 'harness', family),
                  peerConfig = {agentId: agentPeer, family, instanceHome: peerHome, appBundle: path.join(root, 'generation', 'Codex.app'), hookNodePath: '/bin/node', hookModulePath: '/brain/hook.mjs'};

            manifest.routes[subPeer] = {
                agentIdentity        : seatPeer,
                signingKey           : key,
                admits               : 'wake/digest',
                harnessTargetMetadata: {adapter: 'primary-session', addressType: 'userDataDir', instanceAddress: path.join(peerHome, 'electron-profile')},
                adapterConfig        : {attemptTimeoutMs: 1000, primarySession: peerConfig}
            };
            await fs.writeFile(manifestPath, JSON.stringify(manifest), {mode: 0o600});
            await enrollNativeWake({manifestPath, stateDir, agentId: agentPeer, family});

            const sentLog         = [];
            const peerConsumed    = [];
            const customTransport = {
                listCodexWakeTargets : async ({home}) => [{root: true, threadId: home.includes(agentPeer) ? threadPeer : threadId, startedAt: 100, receiptOffset: 0, activeTurnId: 'active-turn-1'}],
                readCodexWakeActivity: async ({threadId: tid}) => tid === threadId
                    ? (busyState === 'busy' ? {state: 'busy', turnId: 'active-turn-1'} : {state: 'idle'})
                    : {state: 'idle'},
                verifyCodexWakeAdmission: async () => ({verified: true}),
                sendCodexSessionWake    : async ({threadId: tid, text}) => {
                    sends++;
                    const nonce = text.match(/\[NEO_WAKE_V1:([^\]]+)\]/)[1];
                    lastNonce   = nonce;
                    sentLog.push({threadId: tid, nonce, kind: 'idle'});
                    if (mode === 'consume' || tid === threadPeer) {
                        const claim = await consumeNativeWakePrompt({
                            manifestPath,
                            stateDir,
                            agentId        : tid === threadPeer ? agentPeer : agentId,
                            family,
                            threadId       : tid,
                            nonce,
                            turnId         : `turn-${sentLog.length}`,
                            inspectResident: resident,
                            codexTransport : customTransport
                        });
                        if (claim.admitted) {
                            (tid === threadPeer ? peerConsumed : consumed).push(claim.digest);
                            delivered.add(nonce);
                        }
                    }
                    return {status: 'accepted'};
                },
                readCodexWakeReceipt    : async ({text, threadId: tid}) => {
                    const nonce = text.match(/\[NEO_WAKE_V1:([^\]]+)\]/)[1];
                    const idx   = sentLog.findIndex(entry => entry.nonce === nonce);
                    return delivered.has(nonce) ? {state: 'turn-started', threadId: tid, turnId: `turn-${idx + 1}`} : {state: 'unknown'};
                }
            };

            let now = Date.now();
            receiver = createWakeReceiver({manifest, state, manifestPath, clock: () => now++, logger: {log(){}, warn(){}, error(){}}});
            server   = receiver.server;
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            url = `http://127.0.0.1:${server.address().port}/wake`;

            const pumpSeat = targetSub => {
                const transportView = activeTurnOpen
                    ? {
                        ...customTransport,
                        sendCodexActiveTurnWake   : async ({threadId: tid, text}) => {
                            steered++;
                            const nonce = text.match(/\[NEO_WAKE_V1:([^\]]+)\]/)[1];
                            sentLog.push({threadId: tid, nonce, kind: 'active-turn'});
                            const claim = await consumeNativeWakePrompt({
                                manifestPath,
                                stateDir,
                                agentId,
                                family,
                                threadId       : tid,
                                nonce,
                                turnId         : 'active-turn-1',
                                inspectResident: resident,
                                codexTransport : customTransport
                            });
                            if (claim.admitted) {
                                consumed.push(claim.digest);
                                delivered.add(nonce);
                            }
                            return {status: 'accepted'};
                        },
                        readCodexActiveTurnReceipt: async ({text, threadId: tid}) => {
                            const nonce = text.match(/\[NEO_WAKE_V1:([^\]]+)\]/)[1];
                            return delivered.has(nonce) ? {state: 'turn-steered', threadId: tid, turnId: 'active-turn-1'} : {state: 'unknown'};
                        }
                    }
                    : customTransport;
                return drainFleetPrimaryWakeRecord({
                    state,
                    stateDir,
                    manifestPath,
                    subscriptionId: targetSub,
                    route         : manifest.routes[targetSub],
                    dispatch      : (record, options) => dispatchFleetPrimarySessionWake(record, {...options, inspectResident: resident, codexTransport: transportView})
                });
            };

            expect((await post(1, ['MESSAGE:single-fresh-urgent'], urgentDecorate('immediate singleton urgent'))).status).toBe(202);
            await receiver.drain();
            await pumpSeat(sub);
            await receiver.drain();
            expect(sends).toBe(1);
            expect(consumed[0]).toContain('[WAKE][priority:high] 1 events for @fixture');
            expect(consumed[0]).toContain('immediate singleton urgent');

            busyState      = 'busy';
            activeTurnOpen = true;
            expect((await post(2, ['MESSAGE:steer-urgent'], urgentDecorate('active-turn singleton steer'))).status).toBe(202);
            await receiver.drain();
            await pumpSeat(sub);
            await receiver.drain();
            expect(steered).toBe(1);
            expect(consumed[1]).toContain('active-turn singleton steer');

            activeTurnOpen = false;
            expect((await post(3, ['MESSAGE:batch-hold-1'], urgentDecorate('held urgent 1'))).status).toBe(202);
            expect((await post(4, ['MESSAGE:batch-hold-2'], urgentDecorate('held urgent 2'))).status).toBe(202);
            await receiver.drain();
            await pumpSeat(sub);
            expect(sends).toBe(1);

            busyState = 'idle';
            mode      = 'hold';
            await pumpSeat(sub);
            await receiver.drain();
            expect(sends).toBe(2);
            const heldBatchNonce = lastNonce;

            expect((await post(5, ['MESSAGE:late-urgent-3'], urgentDecorate('late urgent arrival'))).status).toBe(202);
            expect((await post(6, ['MESSAGE:normal-catchup-1', 'MESSAGE:normal-catchup-2'])).status).toBe(202);
            expect((await post(7, ['MESSAGE:normal-catchup-3'])).status).toBe(202);
            expect((await post(8, ['MESSAGE:peer-urgent-1'], envelope => {
                envelope.subscriptionId = subPeer;
                envelope.agentIdentity  = seatPeer;
                urgentDecorate('peer urgent isolated')(envelope);
            })).status).toBe(202);
            await receiver.drain();

            await pumpSeat(subPeer);
            await receiver.drain();
            expect(peerConsumed).toHaveLength(1);
            expect(peerConsumed[0]).toContain('peer urgent isolated');

            const [heldAnchor] = (await state.list('pending')).filter(r => r.eventId === 'event-3');
            await state.transition(heldAnchor.recordKey, 'pending', 'dispatching');
            expect(await state.recoverInterrupted()).toBe(1);

            await pumpSeat(sub);
            expect(sends, 'crash/retry does not resend an uncertain urgent batch').toBe(3);

            const batchClaim = await consumeNativeWakePrompt({
                manifestPath,
                stateDir,
                agentId,
                family,
                threadId,
                nonce          : heldBatchNonce,
                turnId         : `turn-${sentLog.findIndex(entry => entry.nonce === heldBatchNonce) + 1}`,
                inspectResident: resident,
                codexTransport : customTransport
            });
            expect(batchClaim.admitted).toBe(true);
            expect(batchClaim.digest).toContain('[WAKE][priority:high] 2 events for @fixture');
            expect(batchClaim.digest).toContain('held urgent 2');
            expect(batchClaim.digest).not.toContain('late urgent arrival');
            delivered.add(heldBatchNonce);

            mode = 'consume';
            await pumpSeat(sub);
            await receiver.drain();

            await pumpSeat(sub);
            await receiver.drain();
            expect(consumed.at(-1)).toContain('[WAKE][priority:high] 1 events for @fixture');
            expect(consumed.at(-1)).toContain('late urgent arrival');

            await pumpSeat(sub);
            await receiver.drain();
            expect(consumed.at(-1)).toContain('[WAKE][priority:normal] 3 events for @fixture');

            expect(await state.list('pending')).toHaveLength(0);
            const allDelivered = await state.list('delivered');
            const expectedIds  = [
                'MESSAGE:single-fresh-urgent',
                'MESSAGE:steer-urgent',
                'MESSAGE:batch-hold-1',
                'MESSAGE:batch-hold-2',
                'MESSAGE:late-urgent-3',
                'MESSAGE:normal-catchup-1',
                'MESSAGE:normal-catchup-2',
                'MESSAGE:normal-catchup-3',
                'MESSAGE:peer-urgent-1'
            ];
            expect(new Set(allDelivered.flatMap(r => r.sourceEventIds))).toEqual(new Set(expectedIds));
            expect(sends, '1 singleton urgent + 1 held urgent batch + 1 peer urgent + 1 late urgent + 1 normal batch').toBe(5);
        });

        test('admits eligible waiters persisted behind a legacy uncommitted urgent pointer on upgrade while keeping frozen attempts immutable', async () => {
            let activity = 'busy';
            let pump     = await useStagedReceiver();
            transport.readCodexWakeActivity = async () => ({state: activity});

            for (const [idx, subject] of ['legacy-1', 'legacy-2', 'legacy-3'].entries()) {
                expect((await post(idx + 1, [`MESSAGE:legacy-u-${idx + 1}`], urgentDecorate(subject))).status).toBe(202);
            }
            await receiver.drain();

            const [r1, r2, r3]    = await state.list('pending'),
                  urgentSpoolFile = path.join(stateDir, 'primary-sessions', 'fixture.urgent.request.json');
            // Emulate base-format upgrade state: uncommitted urgent pointer without `candidates`,
            // while r2 and r3 already persisted `earlier urgent native wake outstanding` behind r1.
            await fs.writeFile(urgentSpoolFile, JSON.stringify({recordKey: r1.recordKey, urgent: true}), {mode: 0o600});
            expect(r2.deferReason).toBe('earlier urgent native wake outstanding');
            expect(r2.blockedByWake).toBe(r1.recordKey);
            expect(r3.deferReason).toBe('earlier urgent native wake outstanding');
            expect(r3.blockedByWake).toBe(r1.recordKey);

            pump = await useStagedReceiver({drain: false});
            expect((await post(4, ['MESSAGE:fresh-u-4'], urgentDecorate('fresh after upgrade'))).status).toBe(202);
            await receiver.drain();

            activity = 'idle';
            await pump();
            await receiver.drain();

            expect(sends).toBe(1);
            expect(consumed).toHaveLength(1);
            expect(consumed[0]).toContain('[WAKE][priority:high] 4 events for @fixture');
            expect(consumed[0]).toContain('fresh after upgrade');
            expect(await state.list('pending')).toHaveLength(0);
            expect((await state.list('delivered')).map(r => r.eventId)).toEqual(['event-1', 'event-2', 'event-3', 'event-4']);

            // Frozen in-flight attempts retain exact membership across legacy-pointer rewrites and fresh arrivals.
            activity = 'busy';
            expect((await post(11, ['MESSAGE:frozen-1'], urgentDecorate('frozen 1'))).status).toBe(202);
            expect((await post(12, ['MESSAGE:frozen-2'], urgentDecorate('frozen 2'))).status).toBe(202);
            expect((await post(13, ['MESSAGE:unfrozen-3'], urgentDecorate('unfrozen 3'))).status).toBe(202);
            await receiver.drain();

            const pendingBatch = await state.list('pending'),
                  f1           = pendingBatch.find(r => r.eventId === 'event-11'),
                  f2           = pendingBatch.find(r => r.eventId === 'event-12');
            await fs.writeFile(urgentSpoolFile, JSON.stringify({recordKey: f1.recordKey, urgent: true, candidates: [f2.recordKey]}), {mode: 0o600});

            activity = 'idle';
            mode     = 'hold';
            await pump();
            expect(sends).toBe(2);
            const frozenNonce = lastNonce;

            await fs.writeFile(urgentSpoolFile, JSON.stringify({recordKey: f1.recordKey, urgent: true}), {mode: 0o600});
            expect((await post(14, ['MESSAGE:late-4'], urgentDecorate('late 4'))).status).toBe(202);
            await receiver.drain();

            const frozenClaim = await consumeNativeWakePrompt({
                manifestPath,
                stateDir,
                agentId,
                family,
                threadId,
                nonce          : frozenNonce,
                turnId         : 'turn-frozen',
                inspectResident: resident,
                codexTransport : transport
            });
            expect(frozenClaim.admitted).toBe(true);
            expect(frozenClaim.digest).toContain('[WAKE][priority:high] 2 events for @fixture');
            expect(frozenClaim.digest).toContain('frozen 2');
            expect(frozenClaim.digest).not.toContain('unfrozen 3');
            expect(frozenClaim.digest).not.toContain('late 4');
        });

        test('preserves all eligible candidates in one turn when an older deferred record regains eligibility behind a newer urgent anchor', async () => {
            let   deferOldest = true,
                  activity    = 'busy';
            const pump = await useStagedReceiver({
                contextProbe: async record => ({
                    contextTokens: deferOldest && record.eventId === 'event-1' ? 101 : 10
                })
            });
            transport.readCodexWakeActivity = async () => ({state: activity});

            expect((await post(1, ['MESSAGE:reentry-a'], urgentDecorate('oldest deferred A'))).status).toBe(202);
            expect((await post(2, ['MESSAGE:reentry-b'], urgentDecorate('anchor B'))).status).toBe(202);
            expect((await post(3, ['MESSAGE:reentry-c'], urgentDecorate('freshest C'))).status).toBe(202);
            await receiver.drain();

            const [recA, recB, recC] = await state.list('pending');
            expect(recA.deferReason).toBe('context-gate:101>100');

            deferOldest = false;
            await receiver.drain();

            const pointerBeforeIdle = JSON.parse(await fs.readFile(path.join(stateDir, 'primary-sessions', 'fixture.urgent.request.json'), 'utf8'));
            expect(pointerBeforeIdle.recordKey).toBe(recB.recordKey);
            expect(pointerBeforeIdle.candidates).toEqual([recC.recordKey, recA.recordKey]);

            activity = 'idle';
            await pump();
            await receiver.drain();

            expect(sends).toBe(1);
            expect(consumed).toHaveLength(1);
            expect(consumed[0]).toContain('[WAKE][priority:high] 3 events for @fixture');
            expect(consumed[0]).toContain('freshest C');
            expect(await state.list('pending')).toHaveLength(0);
            expect((await state.list('delivered')).map(r => r.eventId).sort()).toEqual(['event-1', 'event-2', 'event-3']);
        });

        test('bounds fresh-work delivery to at most 2 turns across 4, 16, and 64 consecutive full 48-event records and continuing arrivals while retiring old backlog', async () => {
            const makeFullIds         = (tag, idx) => Array.from({length: 48}, (_, eventIdx) => `MESSAGE:${tag}-full-${idx}-${eventIdx}`);
            const makeSyntheticRecord = (idx, ids, subject) => {
                const recordKey = String(idx + 1).padStart(64, '0'),
                      envelope  = env(idx, ids);
                urgentDecorate(subject)(envelope);
                return {recordKey, sourceEventIds: ids, envelope};
            };

            for (const fullCount of [4, 16, 64]) {
                const queue = [
                    ...Array.from({length: fullCount}, (_, idx) => makeSyntheticRecord(idx, makeFullIds(`s${fullCount}`, idx), `full-${idx}`)),
                    makeSyntheticRecord(fullCount, [`MESSAGE:s${fullCount}-fresh`], `fresh-after-${fullCount}`)
                ];
                let preferFreshTail = false,
                    freshTurn       = null,
                    turns           = 0;
                while (queue.length > 0) {
                    turns++;
                    const plan = selectUrgentPrimaryWakeTurn(queue, {preferFreshTail});
                    expect(plan).not.toBeNull();
                    const deliveredKeys = new Set(plan.members ? plan.members.map(m => m.recordKey) : [plan.anchorRecord.recordKey]);
                    if (deliveredKeys.has(queue.at(-1)?.recordKey) && queue.at(-1)?.sourceEventIds[0] === `MESSAGE:s${fullCount}-fresh`) {
                        freshTurn = turns;
                    }
                    for (let i = queue.length - 1; i >= 0; i--) {
                        if (deliveredKeys.has(queue[i].recordKey)) queue.splice(i, 1);
                    }
                    preferFreshTail = plan.nextPreferFreshTail;
                }
                expect(freshTurn, `fresh single-event wake behind ${fullCount} full records delivers on turn 2`).toBe(2);
                expect(turns).toBe(fullCount + 1);
            }

            // Full receiver + Fleet pump + hook integration with 4 full records + continuing fresh & full arrivals
            let   activity = 'busy';
            const pump     = await useStagedReceiver();
            transport.readCodexWakeActivity = async () => ({state: activity});

            for (let idx = 0; idx < 4; idx++) {
                expect((await post(idx + 1, makeFullIds('int', idx), urgentDecorate(`old-full-${idx}`))).status).toBe(202);
            }
            expect((await post(100, ['MESSAGE:cont-fresh-1'], urgentDecorate('continuing fresh 1'))).status).toBe(202);
            await receiver.drain();

            // Turn 1: retires oldest full record (old-full-0) and arms fresh-tail promotion for Turn 2
            activity = 'idle';
            await pump();
            await receiver.drain();
            expect(sends).toBe(1);
            expect(consumed[0]).toContain('old-full-0');

            // Continuing arrivals while busy before Turn 2: another full record + fresh-2
            activity = 'busy';
            expect((await post(101, makeFullIds('int', 4), urgentDecorate('arriving-full-4'))).status).toBe(202);
            expect((await post(102, ['MESSAGE:cont-fresh-2'], urgentDecorate('continuing fresh 2'))).status).toBe(202);
            await receiver.drain();

            // Abort-safety check on `fallbackPreferFreshTail`: an aborted send before delivery preserves `preferFreshTail === true`.
            const origSend = transport.sendCodexSessionWake;
            transport.sendCodexSessionWake = async () => ({status: 'not-sent'});
            activity = 'idle';
            await pump();
            await receiver.drain();
            expect(sends).toBe(1);
            transport.sendCodexSessionWake = origSend;

            // Turn 2: skips incompatible `arriving-full-4` and delivers BOTH `continuing fresh 1` and `continuing fresh 2` together on Turn 2!
            await pump();
            await receiver.drain();
            expect(sends).toBe(2);
            expect(consumed[1]).toContain('[WAKE][priority:high] 2 events for @fixture');
            expect(consumed[1]).toContain('continuing fresh 2');
            const deliveredAfterTurn2 = (await state.list('delivered')).flatMap(r => r.sourceEventIds);
            expect(deliveredAfterTurn2, 'overtaken continuing fresh 1 delivers on Turn 2 alongside fresh 2').toContain('MESSAGE:cont-fresh-1');
            expect(deliveredAfterTurn2).toContain('MESSAGE:cont-fresh-2');

            // Continuing arrival before Turn 3: fresh-3 arrives alongside fresh-4
            activity = 'busy';
            expect((await post(103, ['MESSAGE:cont-fresh-3'], urgentDecorate('continuing fresh 3'))).status).toBe(202);
            expect((await post(104, ['MESSAGE:cont-fresh-4'], urgentDecorate('continuing fresh 4'))).status).toBe(202);
            await receiver.drain();

            // Turn 3: guarantees old-backlog progress (delivers old-full-1, never starved by continuing arrivals)
            activity = 'idle';
            await pump();
            await receiver.drain();
            expect(sends).toBe(3);
            expect(consumed[2]).toContain('old-full-1');

            // Turn 4: coalesces and delivers both continuing fresh-3 & fresh-4 within <= 2 turns of arrival
            await pump();
            await receiver.drain();
            expect(sends).toBe(4);
            expect(consumed[3]).toContain('[WAKE][priority:high] 2 events for @fixture');
            expect(consumed[3]).toContain('continuing fresh 4');

            // Remaining 3 full records (`old-full-2`, `arriving-full-4`, `old-full-3`) drain in 3 turns (7 total sends) with zero lost events
            while ((await state.list('pending')).length > 0) {
                await pump();
                await receiver.drain();
            }
            expect(sends).toBe(7);
            const deliveredAll = await state.list('delivered');
            expect(deliveredAll).toHaveLength(9);
            expect(deliveredAll.flatMap(r => r.sourceEventIds)).toContain('MESSAGE:cont-fresh-1');
            expect(deliveredAll.flatMap(r => r.sourceEventIds)).toContain('MESSAGE:cont-fresh-4');
        });

        test('preserves source-time freshness in the recipient digest when a delayed older message arrives last', async () => {
            let   activity = 'busy';
            const pump     = await useStagedReceiver();
            transport.readCodexWakeActivity = async () => ({state: activity});

            const baseMs        = Date.now(),
                  initialIso    = new Date(baseMs - 180_000).toISOString(),
                  freshIso      = new Date(baseMs - 10_000).toISOString(),
                  delayedOldIso = new Date(baseMs - 120_000).toISOString(),
                  decorateTimed = (subject, sentAtIso) => envelope => {
                      urgentDecorate(subject)(envelope);
                      envelope.payload.latestUrgentSentAt                 = sentAtIso;
                      envelope.payload.breakdown.sent_to_me.latest.sentAt = sentAtIso;
                      envelope.payload.breakdown.sent_to_me.latestTs      = Date.parse(sentAtIso);
                  };

            expect((await post(1, ['MESSAGE:timed-old-1'], decorateTimed('initial older request', initialIso))).status).toBe(202);
            expect((await post(2, ['MESSAGE:timed-fresh-2'], decorateTimed('current fresh request', freshIso))).status).toBe(202);
            expect((await post(3, ['MESSAGE:timed-delayed-3'], decorateTimed('delayed older request', delayedOldIso))).status).toBe(202);
            expect((await post(4, ['MESSAGE:clockless-4'], urgentDecorate('clockless late arrival'))).status).toBe(202);
            await receiver.drain();

            const pendingOrdered = await state.list('pending');
            expect(pendingOrdered.every(r => r.urgent === true)).toBe(true);
            expect(formatPrimaryWakeBatch(pendingOrdered)).toContain('4 message events (latest: "current fresh request"');
            expect(formatPrimaryWakeBatch(pendingOrdered)).not.toContain('delayed older request');
            expect(formatPrimaryWakeBatch(pendingOrdered)).not.toContain('clockless late arrival');

            activity = 'idle';
            await pump();
            await receiver.drain();

            expect(sends).toBe(1);
            expect(consumed).toHaveLength(1);
            expect(consumed[0]).toContain('[WAKE][priority:high] 4 events for @fixture');
            expect(consumed[0]).toContain('4 message events (latest: "current fresh request"');
            expect(consumed[0]).not.toContain('delayed older request');
            expect(consumed[0]).not.toContain('clockless late arrival');

            const settled = await state.list('delivered');
            expect(settled.flatMap(r => r.sourceEventIds)).toEqual([
                'MESSAGE:timed-old-1',
                'MESSAGE:timed-fresh-2',
                'MESSAGE:timed-delayed-3',
                'MESSAGE:clockless-4'
            ]);
        });
    });
});

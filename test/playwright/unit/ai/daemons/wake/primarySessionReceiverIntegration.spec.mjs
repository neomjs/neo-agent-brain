import {test, expect}                                                                                                                       from '@playwright/test';
import crypto                                                                                                                               from 'node:crypto';
import fs                                                                                                                                   from 'node:fs/promises';
import os                                                                                                                                   from 'node:os';
import path                                                                                                                                 from 'node:path';
import {createWakeReceiver, loadWakeReceiverManifest}                                                                                       from '../../../../../../ai/daemons/wake/receiver.mjs';
import {projectMessageDelivery}                                                                                                            from '../../../../../../ai/services/memory-core/wakeDeliveryProjection.mjs';
import {WakeReceiverState}                                                                                                                  from '../../../../../../ai/daemons/wake/receiverState.mjs';
import {dispatchFleetPrimarySessionWake, drainFleetPrimaryWakeRecord, startFleetPrimaryWakePump, consumeNativeWakePrompt, enrollNativeWake} from '../../../../../../ai/daemons/wake/fleetPrimarySessionWake.mjs';

test.describe('signed native wake receiver integration', () => {
    let root, stateDir, manifestPath, state, server, receiver, url, manifest, delivered, sends, consumed, mode, lastNonce, nativeInputs;
    const agentId  = 'fixture-seat', seat = '@fixture', family = 'codex-desktop', sub = 'WAKE_SUB:fixture', key = 'a'.repeat(64),
          threadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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

    test('default signed receiver stages for Fleet and consumes its correlated result', async () => {
        await new Promise(resolve => server.close(resolve));
        receiver = createWakeReceiver({manifest,state,manifestPath,logger:{log(){},warn(){},error(){}}});
        server = receiver.server; await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
        url = `http://127.0.0.1:${server.address().port}/wake`;
        expect((await post(1)).status).toBe(202);
        await receiver.drain();
        expect(await state.list('pending')).toHaveLength(1);
        expect(sends).toBe(0);
        const pump = route => drainFleetPrimaryWakeRecord({state,stateDir,manifestPath,subscriptionId:sub,route,
            dispatch:(record, options) => dispatchFleetPrimarySessionWake(record,{...options,inspectResident:resident,codexTransport:transport})});
        await pump(manifest.routes[sub]);
        await receiver.drain();
        expect(await state.list('delivered')).toHaveLength(1);
        expect(sends).toBe(1);
        expect((await post(1)).status).toBe(200);
        await receiver.drain(); await pump(manifest.routes[sub]);
        expect(sends).toBe(1);
        expect((await post(2)).status).toBe(202); await receiver.drain();
        const changed = structuredClone(manifest); changed.routes[sub].harnessTargetMetadata.adapter = 'osascript';
        await fs.writeFile(manifestPath,JSON.stringify(changed),{mode:0o600}); receiver.setManifest(changed);
        await pump(changed.routes[sub]); await receiver.drain();
        expect(sends).toBe(1);
        expect(await state.list('delivered')).toHaveLength(1);
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
        let now = Date.now();
        receiver = createWakeReceiver({manifest,state,manifestPath,contextProbe,clock: () => now++,logger:{log(){},warn(){},error(){}}});
        server = receiver.server;
        await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
        url = `http://127.0.0.1:${server.address().port}/wake`;
        return () => drainFleetPrimaryWakeRecord({state,stateDir,manifestPath,subscriptionId,route:manifest.routes[subscriptionId],
            dispatch:(record, options) => dispatchFleetPrimarySessionWake(record,{...options,inspectResident:resident,codexTransport:transport})})
    }

    test('a bounded native batch keeps excess source events pending in acceptance order', async () => {
        const pump = await useStagedReceiver();
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
        const pump = await useStagedReceiver();
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
        manifest.routes[sub].adapterConfig.contextGate = {maxContextTokens:100,warnContextTokens:90,activeWithinMs:5000};
        await fs.writeFile(manifestPath,JSON.stringify(manifest),{mode:0o600});
        let blocked = new Set();
        const pump = await useStagedReceiver({contextProbe: async record => ({
            contextTokens: blocked.has(record.eventId) ? 101 : 10
        })});
        for (const index of [1,2,3]) expect((await post(index)).status).toBe(202);
        await receiver.drain();
        // A pointer can still list a member whose newest context check deferred it.
        blocked = new Set(['event-2']);
        await receiver.drain();
        await pump();
        expect(sends).toBe(1);
        expect(consumed[0]).toContain('2 events for @fixture');

        // The verified batch can settle after context growth now blocks all future sends.
        blocked = new Set(['event-1','event-2','event-3','event-4']);
        await receiver.drain();
        expect((await state.list('delivered')).map(record => record.sourceEventIds)).toEqual([['MESSAGE:1'],['MESSAGE:3']]);

        expect((await post(4)).status).toBe(202);
        await receiver.drain(); await pump(); await receiver.drain();
        expect(sends).toBe(1);
        expect(await state.list('pending')).toEqual([2,4].map(index =>
            expect.objectContaining({eventId:`event-${index}`,deferReason:'context-gate:101>100'})
        ));
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
});

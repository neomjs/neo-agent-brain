import {test, expect}                                                                                                                       from '@playwright/test';
import crypto                                                                                                                               from 'node:crypto';
import fs                                                                                                                                   from 'node:fs/promises';
import os                                                                                                                                   from 'node:os';
import path                                                                                                                                 from 'node:path';
import {createWakeReceiver, loadWakeReceiverManifest}                                                                                       from '../../../../../../ai/daemons/wake/receiver.mjs';
import {WakeReceiverState}                                                                                                                  from '../../../../../../ai/daemons/wake/receiverState.mjs';
import {dispatchFleetPrimarySessionWake, drainFleetPrimaryWakeRecord, startFleetPrimaryWakePump, consumeNativeWakePrompt, enrollNativeWake} from '../../../../../../ai/daemons/wake/fleetPrimarySessionWake.mjs';

test.describe('signed native wake receiver integration', () => {
    let root, stateDir, manifestPath, state, server, receiver, url, manifest, delivered, sends, consumed, mode, lastNonce, nativeInputs;
    const agentId  = 'fixture-seat', seat = '@fixture', family = 'codex-desktop', sub = 'WAKE_SUB:fixture', key = 'a'.repeat(64),
          threadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    let config, transport;
    const resident = async () => ({pid: 123, startedAt: 'start', generation: '123:start', workspaceRoot: '/fixture/work'});
    const env      = index => ({schemaVersion:'1.0',eventType:'wake/digest',eventId:`event-${index}`,subscriptionId:sub,
        agentIdentity:seat,payload:{totalEvents:1,sourceEventIds:[`MESSAGE:${index}`],breakdown:{sent_to_me:{count:1,latest:{messageId:`MESSAGE:${index}`,subject:'fixture'}}}}});

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
    async function post(index) {
        const envelope = env(index), body = JSON.stringify(envelope), signature = crypto.createHmac('sha256',key).update(body).digest('hex');
        return fetch(url,{method:'POST',headers:{'content-type':'application/json','x-neo-wake-subscription-id':sub,
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
});

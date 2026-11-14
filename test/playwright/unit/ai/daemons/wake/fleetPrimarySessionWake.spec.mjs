import {test, expect}                                                                                    from '@playwright/test';
import fs                                                                                                from 'node:fs/promises';
import os                                                                                                from 'node:os';
import path                                                                                              from 'node:path';
import {randomUUID}                                                                                      from 'node:crypto';
import {WakeReceiverState}                                                                               from '../../../../../../ai/daemons/wake/receiverState.mjs';
import {dispatchFleetPrimarySessionWake, enrollNativeWake, readNativeWakeOptIn, consumeNativeWakePrompt} from '../../../../../../ai/daemons/wake/fleetPrimarySessionWake.mjs';
import {runPrimarySessionWakeCli}                                                                        from '../../../../../../ai/scripts/fleet/primarySessionWake.mjs';

let tempDir, state, manifestPath, stateDir;
test.beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-main-wake-'));
    manifestPath = path.join(tempDir, 'routes.json');
    stateDir = path.join(tempDir, 'receiver');
    state = new WakeReceiverState({stateDir});
    await state.init();
    await fs.writeFile(manifestPath,JSON.stringify({schemaVersion:1,routes:{}}),{mode:0o600})
});
test.afterEach(async () => fs.rm(tempDir,{force:true,recursive:true}));

test('enrolling one host agent is explicit and idempotent; another family or state directory cannot consume it', async () => {
    const input = {agentId:'fixture', family:'codex-desktop', manifestPath, stateDir};
    expect(await readNativeWakeOptIn(input)).toBe(null);
    const args = ['enroll','--agent','fixture','--family','codex-desktop','--manifest',manifestPath,'--state',stateDir];
    expect((await runPrimarySessionWakeCli(args)).enrollment).toEqual(await enrollNativeWake(input));
    expect(await readNativeWakeOptIn({...input,agentId:'peer'})).toBe(null);
    await expect(readNativeWakeOptIn({...input,family:'antigravity'})).rejects.toThrow();
    await expect(enrollNativeWake({...input,agentId:'../fixture'})).rejects.toThrow()
});

test('native dispatch holds a busy or unguarded root, then waits for exact recipient evidence across a receiver restart', async () => {
    const seat      = '@fixture', threadId = randomUUID(), generation = '123:birth', sent = [];
    const latest    = {root:true,threadId,startedAt:1000,receiptOffset:120};
    let   idle      = false, verified = false, accepted = false;
    const transport = {
        listCodexWakeTargets    : async () => [latest],
        readCodexWakeActivity   : async () => ({state:idle?'idle':'busy'}),
        verifyCodexWakeAdmission: async () => ({verified}),
        sendCodexSessionWake    : async request => { sent.push(request); return {state:'enqueued'} },
        readCodexWakeReceipt    : async request => accepted && request.threadId===threadId && request.text===sent[0].text &&
            request.receiptOffset===120 ? {state:'turn-started',threadId,turnId:'fixture-turn'} : {state:'unknown'}
    };
    const envelope = {eventType:'wake/digest',agentIdentity:seat,subscriptionId:'WAKE_SUB:fixture',payload:{totalEvents:1,breakdown:{sent_to_me:{count:1,latest:{subject:'Only the peer may read this'}}}}};
    const route    = {agentIdentity:seat,harnessTargetMetadata:{adapter:'primary-session'},adapterConfig:{primarySession:{agentId:'fixture',family:'codex-desktop',
        instanceHome:path.join(tempDir,'home'),appBundle:path.join(tempDir,'ChatGPT.app')}}};
    const record = (await state.accept({subscriptionId:'WAKE_SUB:fixture',eventId:'one',envelope,route})).record;
    await enrollNativeWake({manifestPath,stateDir,agentId:'fixture',family:'codex-desktop'});
    await fs.writeFile(manifestPath,JSON.stringify({schemaVersion:1,routes:{'WAKE_SUB:fixture':route}}));
    const options = {state,stateDir,manifestPath,codexTransport:transport,inspectResident:async () => ({generation,workspaceRoot:tempDir})};
    expect((await dispatchFleetPrimarySessionWake(record,options)).status).toBe('pending');
    idle = true;
    expect((await dispatchFleetPrimarySessionWake(record,options)).status).toBe('pending');
    expect(sent).toHaveLength(0);
    verified = true;
    expect((await dispatchFleetPrimarySessionWake(record,options)).status).toBe('unknown');
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/^\[NEO_WAKE_V1:[0-9a-f-]{36}\] \[WAKE\]/);
    const restarted = new WakeReceiverState({stateDir});
    expect((await dispatchFleetPrimarySessionWake(record,{...options,state:restarted})).status).toBe('unknown');
    const nonce = sent[0].text.match(/^\[NEO_WAKE_V1:([^\]]+)\]/)[1];
    expect(sent[0].text).not.toContain('Only the peer');
    const request = {...options, family:'codex-desktop',agentId:'fixture',threadId,nonce,turnId:'fixture-turn'};
    expect(await consumeNativeWakePrompt({...request,threadId:randomUUID()})).toEqual({admitted:false});
    const redemption = await consumeNativeWakePrompt(request);
    expect(redemption.admitted).toBe(true);
    expect(redemption.digest).toContain('Only the peer may read this');
    expect(await consumeNativeWakePrompt(request)).toEqual({admitted:false});
    accepted = true;
    const receipt = await dispatchFleetPrimarySessionWake(record,{...options,state:restarted});
    expect(receipt.status).toBe('delivered');
    expect(receipt.recipient).toMatchObject({seat,generation,threadId,recordKey:record.recordKey});
    expect(sent).toHaveLength(1)
});

test('a pending marker follows the peer across a new main start and an old root or child obtains no digest', async () => {
    const seat      = '@fixture', oldRoot = randomUUID(), newRoot = randomUUID(), helper = randomUUID();
    const sub       = 'WAKE_SUB:handoff', generation = '203:birth', family = 'codex-desktop';
    let   latest    = oldRoot, attempt, admitted;
    const sent      = [];
    const transport = {
        listCodexWakeTargets    : async () => [{root:true,threadId:latest,startedAt:latest===oldRoot?1:2,receiptOffset:0}],
        readCodexWakeActivity   : async () => ({state:'idle'}),
        verifyCodexWakeAdmission: async () => ({verified:true}),
        sendCodexSessionWake    : async request => { sent.push(request); attempt = request; return {state:'enqueued'} },
        readCodexWakeReceipt    : async ({threadId,text}) => admitted && admitted.threadId === threadId && text === attempt.text ?
            {state:'turn-started',threadId,turnId:'recipient-turn'} : {state:'unknown'}
    };
    const config = {agentId:'fixture',family,instanceHome:path.join(tempDir,'home'),appBundle:path.join(tempDir,'ChatGPT.app')};
    const route  = {agentIdentity:seat,harnessTargetMetadata:{adapter:'primary-session'},adapterConfig:{primarySession:config}};
    await enrollNativeWake({manifestPath,stateDir,agentId:config.agentId,family});
    await fs.writeFile(manifestPath,JSON.stringify({schemaVersion:1,routes:{[sub]:route}}));
    const envelope = {eventType:'wake/digest',agentIdentity:seat,subscriptionId:sub,
        payload:{totalEvents:1,breakdown:{sent_to_me:{count:1,latest:{subject:'private subject'}}}}};
    const record   = (await state.accept({subscriptionId:sub,eventId:'handoff',envelope,route})).record;
    const options  = {state,stateDir,manifestPath,codexTransport:transport,inspectResident:async () => ({generation,workspaceRoot:tempDir})};
    const dispatch = () => dispatchFleetPrimarySessionWake(record,options);
    const redeem   = (threadId,text) => consumeNativeWakePrompt({...options,agentId:config.agentId,family,threadId,
        turnId:'recipient-turn',nonce:text.match(/^\[NEO_WAKE_V1:([^\]]+)\]/)[1]});

    expect((await dispatch()).status).toBe('unknown');
    const staleMarker = attempt.text;
    latest = newRoot;
    expect(await redeem(oldRoot,staleMarker)).toEqual({admitted:false});
    expect((await dispatch()).status).toBe('unknown');
    expect(sent.map(s => s.threadId)).toEqual([oldRoot,newRoot]);
    expect(attempt.text).not.toContain('private subject');
    expect(await redeem(oldRoot,staleMarker)).toEqual({admitted:false});
    expect(await redeem(helper,attempt.text)).toEqual({admitted:false});
    expect(await redeem(newRoot,attempt.text)).toEqual({admitted:true,digest:expect.stringContaining('private subject')});
    admitted = {threadId:newRoot};
    expect((await dispatch()).recipient.threadId).toBe(newRoot);
    expect(sent).toHaveLength(2)
});

test('withdrawal of enrollment while a recipient is proving its root prevents content redemption', async () => {
    const agentId = 'fixture', seat = '@fixture', family = 'codex-desktop', threadId = randomUUID(), nonce = randomUUID();
    const config  = {agentId,family,instanceHome:path.join(tempDir,'home'),appBundle:path.join(tempDir,'ChatGPT.app')};
    const sub     = 'WAKE_SUB:revocation';
    const route   = {agentIdentity:seat,harnessTargetMetadata:{adapter:'primary-session'},adapterConfig:{primarySession:config}};
    await enrollNativeWake({manifestPath,stateDir,agentId,family});
    await fs.writeFile(manifestPath,JSON.stringify({schemaVersion:1,routes:{[sub]:route}}));
    const envelope  = {eventType:'wake/digest',agentIdentity:seat,subscriptionId:sub,payload:{totalEvents:1}};
    const {record}  = await state.accept({subscriptionId:sub,eventId:'revocation',envelope,route});
    const directory = path.join(stateDir,'primary-sessions');
    await fs.mkdir(directory,{mode:0o700});
    await fs.writeFile(path.join(directory,'fixture.json'),JSON.stringify({version:1,
        binding:{seat,family,generation:'live',threadId},inflight:{status:'unknown',nonce,recordKey:record.recordKey}}),{mode:0o600});
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const attempt = consumeNativeWakePrompt({manifestPath,stateDir,agentId,family,threadId,nonce,
        inspectResident:async () => ({generation:'live',workspaceRoot:tempDir}),
        codexTransport:{listCodexWakeTargets:async () => {
            entered.resolve();
            await release.promise;
            return [{root:true,threadId,startedAt:100}]
        }}});
    await entered.promise;
    try { await fs.unlink(path.join(tempDir,'primary-session-seats','fixture.json')) } finally { release.resolve() }
    expect(await attempt).toEqual({admitted:false});
    await expect(fs.stat(path.join(directory,'fixture.json.claim.json'))).rejects.toMatchObject({code:'ENOENT'})
});

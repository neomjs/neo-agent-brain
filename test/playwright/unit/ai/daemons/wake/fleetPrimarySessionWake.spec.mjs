import {test, expect}                                                                                                                 from '@playwright/test';
import fs                                                                                                                             from 'node:fs/promises';
import os                                                                                                                             from 'node:os';
import path                                                                                                                           from 'node:path';
import {randomUUID}                                                                                                                   from 'node:crypto';
import {WakeReceiverState}                                                                                                            from '../../../../../../ai/daemons/wake/receiverState.mjs';
import {dispatchFleetPrimarySessionWake, drainFleetPrimaryWakeRecord, enrollNativeWake, readNativeWakeOptIn, consumeNativeWakePrompt} from '../../../../../../ai/daemons/wake/fleetPrimarySessionWake.mjs';
import {stagePrimaryWake}                                                                                                             from '../../../../../../ai/daemons/wake/primaryWakeSpool.mjs';
import {runPrimarySessionWakeCli}                                                                                                     from '../../../../../../ai/scripts/fleet/primarySessionWake.mjs';
import {withOutboxLock}                                                                                                               from '../../../../../../ai/daemons/wake/outboxLock.mjs';

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

test('Stop while enrollment waits on the lock leaves no new marker and preserves an existing one', async () => {
    const input = {agentId:'fixture', family:'codex-desktop', manifestPath, stateDir}, controller = new AbortController();
    const file  = path.join(tempDir, 'primary-session-seats', 'fixture.json');
    await fs.mkdir(path.dirname(file), {recursive:true});
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const holding = withOutboxLock(file, async () => { entered.resolve(); await release.promise });
    await entered.promise;
    const waiting = Promise.withResolvers();
    const pending = enrollNativeWake({...input, signal:controller.signal,
        lock:(target, fn) => { waiting.resolve(); return withOutboxLock(target, fn) }});
    await waiting.promise;
    controller.abort(); release.resolve(); await holding;
    await expect(pending).rejects.toThrow();
    expect(await readNativeWakeOptIn(input)).toBeNull();
    const existing = await enrollNativeWake(input), canceled = new AbortController();
    canceled.abort();
    await expect(enrollNativeWake({...input, signal:canceled.signal})).rejects.toThrow();
    expect(await readNativeWakeOptIn(input)).toEqual(existing)
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
    for (const verifyCodexRoute of [async () => false, async () => { throw new Error('custody unavailable') }]) {
        expect((await dispatchFleetPrimarySessionWake(record,{...options,verifyCodexRoute})).status).toBe('pending');
        expect(sent).toHaveLength(0)
    }
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
    latest.startedAt += 13; // An already-admitted receipt still settles when a fresh selection would be held.
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

for (const [failure, reason] of Object.entries({
    'resident-unavailable': 'resident-unavailable',
    'selection-null'      : 'selection-unavailable',
    'selection-throws'    : 'selection-unavailable',
    'root-start-changed'  : 'selection-root-start-changed'
})) {
    test(`a spent same-root denial recovers exactly once after ${failure}`, async () => {
        const seat      = '@fixture', threadId = randomUUID(), generation = '123:birth', turnId = randomUUID(), sent = [];
        const agentId   = 'fixture', family = 'codex-desktop', sub = 'WAKE_SUB:retry';
        let   selector  = 'ready', proof = null;
        const live      = async () => ({generation,workspaceRoot:tempDir});
        const transport = {
            listCodexWakeTargets: async () => {
                if (selector === 'selection-throws') throw new Error('private driver detail');
                if (selector === 'selection-null') return [];
                return [{root:true,threadId,startedAt:selector === 'root-start-changed' ? 1013 : 1000,receiptOffset:0}]
            },
            readCodexWakeActivity   : async () => ({state:'idle'}),
            verifyCodexWakeAdmission: async () => ({verified:true}),
            sendCodexSessionWake    : async request => {sent.push(request); return {state:'enqueued'}},
            readCodexWakeReceipt    : async ({text}) => proof === text ? {state:'turn-started',threadId,turnId} : {state:'unknown'}
        };
        const route = {agentIdentity:seat,admits:'wake/digest',harnessTargetMetadata:{adapter:'primary-session'},adapterConfig:{primarySession:{agentId,family,
            instanceHome:path.join(tempDir,'home'),appBundle:path.join(tempDir,'ChatGPT.app')}}};
        const envelope = {eventType:'wake/digest',agentIdentity:seat,subscriptionId:sub,
            payload:{totalEvents:1,breakdown:{sent_to_me:{count:1,latest:{subject:'private digest'}}}}};
        const {record} = await state.accept({subscriptionId:sub,eventId:failure,envelope,route});
        await enrollNativeWake({manifestPath,stateDir,agentId,family});
        await fs.writeFile(manifestPath,JSON.stringify({schemaVersion:1,routes:{[sub]:route}}));
        const options = {state,stateDir,manifestPath,codexTransport:transport,inspectResident:live};
        const pump    = () => drainFleetPrimaryWakeRecord({state,stateDir,manifestPath,subscriptionId:sub,route,
            dispatch:(item, extra) => dispatchFleetPrimarySessionWake(item,{...extra,...options})});
        const claimPath = path.join(stateDir,'primary-sessions','fixture.json.claim.json');
        await stagePrimaryWake(record,{state,stateDir}); await pump();
        expect(sent).toHaveLength(1);
        const oldNonce = sent[0].text.match(/^\[NEO_WAKE_V1:([^\]]+)\]/)[1];
        const base     = {manifestPath,stateDir,agentId,family,threadId,turnId,nonce:oldNonce,codexTransport:transport,inspectResident:live};
        // A different thread, nonce or unproven native turn cannot spend this attempt.
        expect(await consumeNativeWakePrompt({...base,threadId:randomUUID()})).toEqual({admitted:false});
        expect(await consumeNativeWakePrompt({...base,nonce:randomUUID()})).toEqual({admitted:false});
        expect(await consumeNativeWakePrompt({...base,turnId:null,inspectResident:async()=>null})).toEqual({admitted:false});
        await expect(fs.stat(claimPath)).rejects.toMatchObject({code:'ENOENT'});
        // An unknown submit/crash or a different process generation alone never triggers retry.
        expect(await consumeNativeWakePrompt({...base,inspectResident:async()=>({generation:'other',workspaceRoot:tempDir})})).toEqual({admitted:false});
        await pump(); expect(sent).toHaveLength(1);
        // A failed claim read/write, like a crash before the denial is durable, is still unknown.
        await fs.mkdir(claimPath);
        await expect(consumeNativeWakePrompt({...base,inspectResident:async()=>null})).rejects.toThrow();
        await fs.rmdir(claimPath);
        await pump(); expect(sent).toHaveLength(1);
        selector = failure;
        const failedResident = failure === 'resident-unavailable' ? async()=>null : live;
        expect(await consumeNativeWakePrompt({...base,inspectResident:failedResident})).toEqual({admitted:false});
        const claim = JSON.parse(await fs.readFile(claimPath,'utf8'));
        expect(claim).toMatchObject({nonce:oldNonce,threadId,turnId,generation,admitted:false,reason});
        expect(await consumeNativeWakePrompt(base)).toEqual({admitted:false});
        selector = 'ready'; await pump();
        expect((await stagePrimaryWake(record,{state,stateDir})).reason).toBe(`native-recipient:${claim.reason}`);
        expect(sent).toHaveLength(1);
        await pump(); expect(sent).toHaveLength(2);
        const newNonce = sent[1].text.match(/^\[NEO_WAKE_V1:([^\]]+)\]/)[1];
        expect(newNonce).not.toBe(oldNonce);
        expect(await consumeNativeWakePrompt(base)).toEqual({admitted:false});
        const granted = await consumeNativeWakePrompt({...base,nonce:newNonce});
        expect(granted.admitted).toBe(true); expect(granted.digest).toContain('private digest');
        expect(await consumeNativeWakePrompt({...base,nonce:newNonce})).toEqual({admitted:false});
        proof = sent[1].text; await pump();
        expect((await stagePrimaryWake(record,{state,stateDir})).status).toBe('delivered');
        expect(sent).toHaveLength(2)
    })
}

test('App denial-only cannot spend another attempt, epoch, or an already granted claim', async () => {
    const agentId = 'fixture', seat = '@fixture', family = 'antigravity', threadId = randomUUID(), nonce = randomUUID(), generation = '123:birth';
    const sub     = 'WAKE_SUB:deny-only', route = {agentIdentity:seat,admits:'wake/digest',harnessTargetMetadata:{adapter:'primary-session'},
        adapterConfig:{primarySession:{agentId,family,instanceHome:path.join(tempDir,'home'),appBundle:path.join(tempDir,'App.app')}}};
    const envelope = {eventType:'wake/digest',agentIdentity:seat,subscriptionId:sub,payload:{totalEvents:1}};
    await enrollNativeWake({manifestPath,stateDir,agentId,family});
    await fs.writeFile(manifestPath,JSON.stringify({schemaVersion:1,routes:{[sub]:route}}));
    const {record}  = await state.accept({subscriptionId:sub,eventId:'deny-only',envelope,route});
    const directory = path.join(stateDir,'primary-sessions'), statePath = path.join(directory,'fixture.json'), claimPath = statePath + '.claim.json';
    await fs.mkdir(directory,{mode:0o700});
    await fs.writeFile(statePath,JSON.stringify({version:1,binding:{seat,family,generation,threadId},
        inflight:{status:'unknown',nonce,recordKey:record.recordKey}}),{mode:0o600});
    const request = {manifestPath,stateDir,agentId,family,threadId,nonce,denyOnly:true,expectedGeneration:generation};
    for (const changed of [{threadId:randomUUID()},{nonce:randomUUID()},{expectedGeneration:'other'}]) {
        expect(await consumeNativeWakePrompt({...request,...changed})).toEqual({admitted:false})
    }
    await expect(fs.stat(claimPath)).rejects.toMatchObject({code:'ENOENT'});
    const granted = {nonce,threadId,generation,recordKey:record.recordKey,admitted:true};
    await fs.writeFile(claimPath,JSON.stringify(granted),{mode:0o600});
    expect(await consumeNativeWakePrompt(request)).toEqual({admitted:false});
    expect(JSON.parse(await fs.readFile(claimPath,'utf8'))).toEqual(granted);
    await fs.unlink(claimPath);
    expect(await consumeNativeWakePrompt(request)).toEqual({admitted:false});
    expect(JSON.parse(await fs.readFile(claimPath,'utf8'))).toMatchObject({nonce,threadId,generation,admitted:false,reason:'selection-unavailable'})
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

test('urgent wake follows main-session handoff and steers an active turn when the active-turn adapter seam is present', async () => {
    const seat      = '@fixture', oldRoot = randomUUID(), newRoot = randomUUID();
    const sub       = 'WAKE_SUB:urgent-handoff', generation = '301:birth', family = 'codex-desktop';
    let   latest    = oldRoot, activity = 'idle', steered = [], idleSent = [], admittedNonce = null;
    const transport = {
        listCodexWakeTargets      : async () => [{root: true, threadId: latest, startedAt: latest === oldRoot ? 1 : 2, receiptOffset: 0}],
        readCodexWakeActivity     : async () => ({state: activity, turnId: activity === 'busy' ? 'active-turn-1' : null}),
        verifyCodexWakeAdmission  : async () => ({verified: true}),
        sendCodexSessionWake      : async req => { idleSent.push(req); return {state: 'enqueued'} },
        readCodexWakeReceipt      : async () => ({state: 'unknown'}),
        sendCodexActiveTurnWake   : async req => { steered.push(req); return {state: 'steered'} },
        readCodexActiveTurnReceipt: async ({threadId, text}) => {
            const nonce = text.match(/^\[NEO_WAKE_V1:([^\]]+)\]/)[1];
            return admittedNonce === nonce ? {state: 'turn-steered', threadId, turnId: 'active-turn-1', observedAt: '2026-11-15T09:12:00.000Z'} : {state: 'unknown'}
        }
    };
    const config = {agentId: 'fixture', family, instanceHome: path.join(tempDir, 'home'), appBundle: path.join(tempDir, 'ChatGPT.app')};
    const route  = {agentIdentity: seat, harnessTargetMetadata: {adapter: 'primary-session'}, adapterConfig: {primarySession: config}};
    await enrollNativeWake({manifestPath, stateDir, agentId: config.agentId, family});
    await fs.writeFile(manifestPath, JSON.stringify({schemaVersion: 1, routes: {[sub]: route}}));
    const nowIso   = new Date().toISOString();
    const envelope = {
        eventType     : 'wake/digest',
        agentIdentity : seat,
        subscriptionId: sub,
        payload       : {
            totalEvents: 1,
            urgent     : true,
            breakdown  : {sent_to_me: {count: 1, highestPriority: 'high', latest: {priority: 'high', sentAt: nowIso, subject: 'urgent handoff + steer'}}}
        }
    };
    const {record} = await state.accept({subscriptionId: sub, eventId: 'urgent-handoff', envelope, route, metadata: {urgent: true}});
    const options  = {state, stateDir, manifestPath, codexTransport: transport, inspectResident: async () => ({generation, workspaceRoot: tempDir})};

    expect((await dispatchFleetPrimarySessionWake(record, options)).status).toBe('unknown');
    expect(idleSent).toHaveLength(1);
    const staleNonce = idleSent[0].text.match(/^\[NEO_WAKE_V1:([^\]]+)\]/)[1];

    latest   = newRoot;
    activity = 'busy';
    expect(await consumeNativeWakePrompt({...options, agentId: config.agentId, family, threadId: oldRoot, turnId: 'active-turn-1', nonce: staleNonce})).toEqual({admitted: false});
    expect((await dispatchFleetPrimarySessionWake(record, options)).status).toBe('unknown');
    expect(steered).toHaveLength(1);
    expect(steered[0]).toMatchObject({threadId: newRoot, turnId: 'active-turn-1'});

    const newNonce   = steered[0].text.match(/^\[NEO_WAKE_V1:([^\]]+)\]/)[1];
    const redemption = await consumeNativeWakePrompt({...options, agentId: config.agentId, family, threadId: newRoot, turnId: 'active-turn-1', nonce: newNonce});
    expect(redemption.admitted).toBe(true);
    expect(redemption.digest).toContain('urgent handoff + steer');
    admittedNonce = newNonce;

    const settled = await dispatchFleetPrimarySessionWake(record, options);
    expect(settled).toMatchObject({
        status             : 'delivered',
        recipientObservedAt: '2026-11-15T09:12:00.000Z',
        recipient          : {seat, generation, threadId: newRoot, recordKey: record.recordKey, nonce: newNonce}
    });
});

test('RA-5 — consumeNativeWakePrompt records non-root refusal onto .urgent.claim.json without touching normal .claim.json', async () => {
    const seat      = '@fixture', rootThread = randomUUID(), subThread = randomUUID();
    const sub       = 'WAKE_SUB:urgent-deny', generation = '302:birth', family = 'codex-desktop';
    const nonces    = [];
    const transport = {
        listCodexWakeTargets    : async () => [{root: true, threadId: rootThread, startedAt: 10, receiptOffset: 0}],
        readCodexWakeActivity   : async () => ({state: 'idle'}),
        verifyCodexWakeAdmission: async () => ({verified: true}),
        sendCodexSessionWake    : async ({text}) => {
            nonces.push(text.match(/^\[NEO_WAKE_V1:([^\]]+)\]/)[1]);
            return {status: 'accepted'}
        },
        readCodexWakeReceipt    : async () => ({state: 'unknown'})
    };
    const config = {agentId: 'fixture', family, instanceHome: path.join(tempDir, 'home'), appBundle: path.join(tempDir, 'ChatGPT.app')};
    const route  = {agentIdentity: seat, harnessTargetMetadata: {adapter: 'primary-session'}, adapterConfig: {primarySession: config}};
    await enrollNativeWake({manifestPath, stateDir, agentId: config.agentId, family});
    await fs.writeFile(manifestPath, JSON.stringify({schemaVersion: 1, routes: {[sub]: route}}));
    const options = {state, stateDir, manifestPath, codexTransport: transport, inspectResident: async () => ({generation, workspaceRoot: tempDir})};
    const nowIso  = new Date().toISOString();

    const {record: urgentRecord} = await state.accept({
        subscriptionId: sub,
        eventId       : 'urgent-refuse',
        envelope      : {
            eventType: 'wake/digest', agentIdentity: seat, subscriptionId: sub,
            payload  : {totalEvents: 1, urgent: true, breakdown: {sent_to_me: {count: 1, highestPriority: 'high', latest: {priority: 'high', sentAt: nowIso}}}}
        },
        route,
        metadata: {urgent: true}
    });
    expect((await dispatchFleetPrimarySessionWake(urgentRecord, options)).status).toBe('unknown');
    expect(nonces).toHaveLength(1);

    const stateFile           = path.join(stateDir, 'primary-sessions', 'fixture.json');
    const sentinelNormalClaim = {nonce: randomUUID(), recordKey: 'a'.repeat(64), admitted: true};
    await fs.writeFile(`${stateFile}.claim.json`, JSON.stringify(sentinelNormalClaim), {mode: 0o600});

    const denied = await consumeNativeWakePrompt({
        ...options,
        agentId : config.agentId,
        family,
        threadId: subThread,
        turnId  : randomUUID(),
        nonce   : nonces[0]
    });
    expect(denied).toEqual({admitted: false});

    // Unknown threadId fails the binding check before any claim file is touched; force root: false
    // on rootThread to verify the refuseSpent path writes .urgent.claim.json directly.
    expect(JSON.parse(await fs.readFile(`${stateFile}.claim.json`, 'utf8'))).toEqual(sentinelNormalClaim);

    const refuseTransport = {
        ...transport,
        listCodexWakeTargets: async () => [{root: false, threadId: rootThread, startedAt: 10, receiptOffset: 0}]
    };
    const turnId = randomUUID();
    expect(await consumeNativeWakePrompt({
        ...options,
        codexTransport: refuseTransport,
        agentId       : config.agentId,
        family,
        threadId      : rootThread,
        turnId,
        nonce         : nonces[0]
    })).toEqual({admitted: false});

    const urgentClaim = JSON.parse(await fs.readFile(`${stateFile}.urgent.claim.json`, 'utf8'));
    expect(urgentClaim).toMatchObject({
        nonce    : nonces[0],
        recordKey: urgentRecord.recordKey,
        admitted : false,
        reason   : 'selection-unavailable'
    });
    expect(JSON.parse(await fs.readFile(`${stateFile}.claim.json`, 'utf8'))).toEqual(sentinelNormalClaim);

    // Replaying the same spent urgent nonce stays denied without touching .claim.json.
    expect(await consumeNativeWakePrompt({
        ...options,
        agentId : config.agentId,
        family,
        threadId: rootThread,
        turnId,
        nonce   : nonces[0]
    })).toEqual({admitted: false});
});

test('RA-5 — concurrent normal (.claim.json) and urgent (.urgent.claim.json) claims remain isolated through settlement', async () => {
    const seat      = '@fixture', threadId = randomUUID();
    const sub       = 'WAKE_SUB:concurrent-claims', generation = '303:birth', family = 'codex-desktop';
    const sent      = [];
    const transport = {
        listCodexWakeTargets    : async () => [{root: true, threadId, startedAt: 10, receiptOffset: 0}],
        readCodexWakeActivity   : async () => ({state: 'idle'}),
        verifyCodexWakeAdmission: async () => ({verified: true}),
        sendCodexSessionWake    : async req => {
            sent.push(req);
            return {status: 'accepted'}
        },
        readCodexWakeReceipt    : async () => ({state: 'turn-started', threadId, turnId: 'turn-shared', observedAt: '2026-11-15T10:00:00.000Z'})
    };
    const config = {agentId: 'fixture', family, instanceHome: path.join(tempDir, 'home'), appBundle: path.join(tempDir, 'ChatGPT.app')};
    const route  = {agentIdentity: seat, harnessTargetMetadata: {adapter: 'primary-session'}, adapterConfig: {primarySession: config}};
    await enrollNativeWake({manifestPath, stateDir, agentId: config.agentId, family});
    await fs.writeFile(manifestPath, JSON.stringify({schemaVersion: 1, routes: {[sub]: route}}));
    const options = {state, stateDir, manifestPath, codexTransport: transport, inspectResident: async () => ({generation, workspaceRoot: tempDir})};
    const nowIso  = new Date().toISOString();

    const {record: normalRecord} = await state.accept({
        subscriptionId: sub,
        eventId       : 'concurrent-normal',
        envelope      : {
            eventType: 'wake/digest', agentIdentity: seat, subscriptionId: sub,
            payload  : {totalEvents: 1, urgent: false, breakdown: {sent_to_me: {count: 1, highestPriority: 'normal', latest: {priority: 'normal', sentAt: nowIso, subject: 'ordinary msg'}}}}
        },
        route,
        metadata: {urgent: false}
    });
    const {record: urgentRecord} = await state.accept({
        subscriptionId: sub,
        eventId       : 'concurrent-urgent',
        envelope      : {
            eventType: 'wake/digest', agentIdentity: seat, subscriptionId: sub,
            payload  : {totalEvents: 1, urgent: true, breakdown: {sent_to_me: {count: 1, highestPriority: 'high', latest: {priority: 'high', sentAt: nowIso, subject: 'urgent msg'}}}}
        },
        route,
        metadata: {urgent: true}
    });

    expect((await dispatchFleetPrimarySessionWake(normalRecord, options)).status).toBe('unknown');
    expect((await dispatchFleetPrimarySessionWake(urgentRecord, options)).status).toBe('unknown');
    expect(sent).toHaveLength(2);

    const normalNonce = sent[0].text.match(/^\[NEO_WAKE_V1:([^\]]+)\]/)[1];
    const urgentNonce = sent[1].text.match(/^\[NEO_WAKE_V1:([^\]]+)\]/)[1];
    const stateFile   = path.join(stateDir, 'primary-sessions', 'fixture.json');

    const urgentConsume = await consumeNativeWakePrompt({...options, agentId: config.agentId, family, threadId, turnId: 'turn-shared', nonce: urgentNonce});
    expect(urgentConsume.admitted).toBe(true);
    expect(urgentConsume.digest).toContain('urgent msg');
    await expect(fs.stat(`${stateFile}.claim.json`)).rejects.toMatchObject({code: 'ENOENT'});

    expect(await dispatchFleetPrimarySessionWake(urgentRecord, options)).toMatchObject({status: 'delivered'});
    await state.transition(urgentRecord.recordKey, 'pending', 'delivered');

    const normalConsume = await consumeNativeWakePrompt({...options, agentId: config.agentId, family, threadId, turnId: 'turn-shared', nonce: normalNonce});
    expect(normalConsume.admitted).toBe(true);
    expect(normalConsume.digest).toContain('ordinary msg');
    expect(JSON.parse(await fs.readFile(`${stateFile}.urgent.claim.json`, 'utf8')).nonce).toBe(urgentNonce);
    expect(JSON.parse(await fs.readFile(`${stateFile}.claim.json`, 'utf8')).nonce).toBe(normalNonce);

    expect(await dispatchFleetPrimarySessionWake(normalRecord, options)).toMatchObject({status: 'delivered'});
});

test('an idle wake whose turn ended without the hook settles unacknowledged, an admitted claim never does, and a late hook gets nothing', async () => {
    const seat      = '@fixture', threadId = randomUUID();
    const sub       = 'WAKE_SUB:unacknowledged', generation = '404:birth', family = 'codex-desktop';
    const sent      = [], ended = new Set();
    const transport = {
        listCodexWakeTargets    : async () => [{root: true, threadId, startedAt: 10, receiptOffset: 0}],
        readCodexWakeActivity   : async () => ({state: 'idle'}),
        verifyCodexWakeAdmission: async () => ({verified: true}),
        sendCodexSessionWake    : async req => { sent.push(req); return {status: 'accepted'} },
        // A turn listed in `ended` finished without the acknowledgement, whether or not its hook admitted.
        readCodexWakeReceipt    : async ({text}) => ended.has(text)
            ? {state: 'turn-unacknowledged', threadId, turnId: 'turn-bare'} : {state: 'unknown'}
    };
    const config = {agentId: 'fixture', family, instanceHome: path.join(tempDir, 'home'), appBundle: path.join(tempDir, 'ChatGPT.app')};
    const route  = {agentIdentity: seat, harnessTargetMetadata: {adapter: 'primary-session'}, adapterConfig: {primarySession: config}};
    await enrollNativeWake({manifestPath, stateDir, agentId: config.agentId, family});
    await fs.writeFile(manifestPath, JSON.stringify({schemaVersion: 1, routes: {[sub]: route}}));
    const options = {state, stateDir, manifestPath, codexTransport: transport, inspectResident: async () => ({generation, workspaceRoot: tempDir})};
    const accept  = async (eventId, urgent) => (await state.accept({
        subscriptionId: sub, eventId, route, metadata: {urgent},
        envelope      : {eventType: 'wake/digest', agentIdentity: seat, subscriptionId: sub, payload: {totalEvents: 1, urgent,
            breakdown: {sent_to_me: {count: 1, highestPriority: urgent ? 'high' : 'normal', latest: {priority: urgent ? 'high' : 'normal', sentAt: new Date().toISOString(), subject: eventId}}}}}
    })).record;
    const urgentRecord = await accept('bare-urgent', true), normalRecord = await accept('held-ordinary', false);
    const nonceOf      = req => req.text.match(/^\[NEO_WAKE_V1:([^\]]+)\]/)[1];

    expect((await dispatchFleetPrimarySessionWake(urgentRecord, options)).status).toBe('unknown');
    expect(await dispatchFleetPrimarySessionWake(normalRecord, options)).toMatchObject({status: 'pending', reason: 'urgent delivery in progress'});
    expect(sent).toHaveLength(1);

    ended.add(sent[0].text);
    expect(await dispatchFleetPrimarySessionWake(urgentRecord, options)).toMatchObject({status: 'delivered', acknowledged: false});
    expect(await consumeNativeWakePrompt({...options, agentId: config.agentId, family, threadId, turnId: 'turn-bare', nonce: nonceOf(sent[0])})).toEqual({admitted: false});

    await state.transition(urgentRecord.recordKey, 'pending', 'delivered');
    expect((await dispatchFleetPrimarySessionWake(normalRecord, options)).status).toBe('unknown');
    expect(sent).toHaveLength(2);
    const redemption = await consumeNativeWakePrompt({...options, agentId: config.agentId, family, threadId, turnId: 'turn-held', nonce: nonceOf(sent[1])});
    expect(redemption.admitted).toBe(true);
    ended.add(sent[1].text);
    expect((await dispatchFleetPrimarySessionWake(normalRecord, options)).status).toBe('unknown');
    expect((await readPrimarySessionWakeState()).inflight).toMatchObject({status: 'unknown', nonce: nonceOf(sent[1])});

    async function readPrimarySessionWakeState() {
        return JSON.parse(await fs.readFile(path.join(stateDir, 'primary-sessions', 'fixture.json'), 'utf8'))
    }
});

test('finished unacknowledged or unechoed Antigravity idle turns settle as acknowledged: false and unblock subsequent wakes', async () => {
    const seat    = '@fixture', threadId = randomUUID();
    const sub     = 'WAKE_SUB:agy-unacknowledged', generation = '405:birth', family = 'antigravity';
    const home    = path.join(tempDir, 'home'), projectRoot = tempDir, appBundle = path.join(tempDir, 'gen', 'Antigravity.app');
    const sent    = [], finished = new Set();
    const sidecar = {appPid:405, appStart:'birth', appBundle, instanceHome:home, environment:{ANTIGRAVITY_AGENTAPI_EXE:'/bin/language_server'}};
    const logsDir = path.join(tempDir, 'agy', 'brain', threadId, '.system_generated', 'logs');
    await fs.mkdir(logsDir, {recursive:true});
    await fs.writeFile(path.join(logsDir, 'transcript.jsonl'), '');
    const transport = {
        latestAntigravityWakeTarget   : async () => ({root:true, threadId, startSequence:1, status:'CASCADE_RUN_STATUS_IDLE'}),
        readAntigravityWakeTarget     : async () => ({threadId, projectId:'p', status:'CASCADE_RUN_STATUS_IDLE'}),
        verifyAntigravityWakeAdmission: async () => ({verified:true}),
        captureAntigravityWakeCursor  : () => ({dev:1, ino:1, offset:0, tailHash:'a'.repeat(64)}),
        sendAntigravitySessionWake    : async req => { sent.push(req); return {outcome:'unknown', reason:'agentapi-dispatch-exited-zero'} },
        readAntigravityWakeReceipt    : ({text}) => finished.has(text) ? {outcome:'turn-unacknowledged'} : {outcome:'unknown'}
    };
    const config = {agentId:'fixture', family, instanceHome:home, appBundle, projectId:'p', projectRoot};
    const route  = {agentIdentity:seat, harnessTargetMetadata:{adapter:'primary-session'}, adapterConfig:{primarySession:config}};
    await enrollNativeWake({manifestPath, stateDir, agentId:config.agentId, family});
    await fs.writeFile(manifestPath, JSON.stringify({schemaVersion:1, routes:{[sub]:route}}));
    const options = {state, stateDir, manifestPath, sidecar, antigravityTransport:transport, appDataDir:path.join(tempDir, 'agy'),
        inspectResident:async () => ({generation, pid:405, startedAt:'birth', workspaceRoot:projectRoot})};
    const accept = async (eventId, urgent) => (await state.accept({
        subscriptionId:sub, eventId, route, metadata:{urgent},
        envelope:{eventType:'wake/digest', agentIdentity:seat, subscriptionId:sub, payload:{totalEvents:1, urgent,
            breakdown:{sent_to_me:{count:1, highestPriority:urgent ? 'high' : 'normal', latest:{priority:urgent ? 'high' : 'normal', sentAt:new Date().toISOString(), subject:eventId}}}}}
    })).record;
    const first = await accept('agy-unredeemed', false), second = await accept('agy-unechoed', false);

    expect((await dispatchFleetPrimarySessionWake(first, options)).status).toBe('unknown');
    expect(sent).toHaveLength(1);
    finished.add(sent[0].message);
    expect(await dispatchFleetPrimarySessionWake(first, options)).toMatchObject({status:'delivered', acknowledged:false});
    await state.transition(first.recordKey, 'pending', 'delivered');

    expect((await dispatchFleetPrimarySessionWake(second, options)).status).toBe('unknown');
    expect(sent).toHaveLength(2);
    const secondNonce = sent[1].message.match(/^\[NEO_WAKE_V1:([^\]]+)\]/)[1];
    const redemption  = await consumeNativeWakePrompt({...options, agentId:config.agentId, family, threadId, nonce:secondNonce});
    expect(redemption.admitted).toBe(true);
    finished.add(sent[1].message);
    expect(await dispatchFleetPrimarySessionWake(second, options)).toMatchObject({status:'delivered', acknowledged:false});
});

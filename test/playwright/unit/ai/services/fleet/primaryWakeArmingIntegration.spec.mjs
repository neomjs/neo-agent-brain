import {test, expect}             from '@playwright/test';
import fs                         from 'node:fs/promises';
import os                         from 'node:os';
import path                       from 'node:path';
import {armFleetSeatWake}         from '../../../../../../ai/services/fleet/armFleetSeatWake.mjs';
import {armSeatWakeRoute}         from '../../../../../../ai/daemons/wake/armSeatWakeRoute.mjs';
import {loadWakeReceiverManifest} from '../../../../../../ai/daemons/wake/receiver.mjs';

test.describe('real primary wake arming publication', () => {
    let dir, manifestPath;
    const sub    = 'WAKE_SUB:fixture', login = 'fixture', receiver = 'http://127.0.0.1:3199';
    const logger = {log(){},info(){},warn(){},error(){}};
    test.beforeEach(async () => {dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-arm-real-')); manifestPath = path.join(dir,'routes.json')});
    test.afterEach(async () => fs.rm(dir,{recursive:true,force:true}));

    const configFor = (family, home) => ({family,agentId:'seat-a',instanceHome:home,appBundle:'/Applications/Test.app',
        ...(family === 'codex-desktop' ? {hookNodePath:'/bin/node',hookModulePath:'/tmp/hook.mjs'} : {projectId:'project',projectRoot:'/tmp/project'})});
    const row = (id, adapter, trigger = 'SENT_TO_ME') => ({id,status:'active',agentIdentity:`@${login}`,trigger,
        harnessTarget:'a2a-webhook',harnessTargetMetadata:{adapter, url:`${receiver}/wake`, signingKey:'a'.repeat(64),
            ...(adapter === 'osascript' ? {appName:'Codex', focusSeedKey:'r'} : {})}});
    function client(rows, returned = sub, signal) {
        return () => ({init:async()=>({ok:true}),callTool:async (_name,args)=> {
            if (args.action === 'subscribe') {signal?.abort(); return {subscriptionId:returned}}
            if (args.action === 'list') return {subscriptions:rows};
            return {}
        },close:async()=>{}})
    }
    const tenantService = {resolveMcpResources:()=>({endpoint:'http://127.0.0.1:3102',resources:{'memory-core':{url:'http://127.0.0.1:3102/mc/mcp'}}}), resolveMcpCredential:()=> 'fixture'};
    const run           = ({family, rows, native=true, returned=sub, signal}) => {
        const home = path.join(dir,'agents','seat-a','harness',family), agent = {id:'seat-a',githubUsername:login,harnessType:family,mcpTarget:{kind:'tenant',tenantId:'x'}};
        return armFleetSeatWake({agent,instanceHome:home,planeBase:'http://127.0.0.1:3102',receiverBase:receiver,manifestPath,tenantService,
            createClient:client(rows,returned,signal),startSignal:signal?.signal,primarySession:native ? configFor(family,home) : null,logger})
    };

    for (const family of ['codex-desktop','antigravity']) {
        test(`${family} publishes the signed native route through the real builder`, async () => {
            const result = await run({family,rows:[row(sub,'primary-session')]});
            expect(result).toMatchObject({state:'ready',adapter:'primary-session',subscriptionId:sub,recipientState:'unknown'});
            expect((await loadWakeReceiverManifest(manifestPath)).routes[sub]).toMatchObject({agentIdentity:`@${login}`,admits:'wake/digest',
                harnessTargetMetadata:{adapter:'primary-session'},adapterConfig:{primarySession:{agentId:'seat-a',family}}});
        });
    }

    test('legacy stays strict, a native request cannot accept legacy or a wrong target', async () => {
        expect((await run({family:'codex-desktop',rows:[row(sub,'osascript')],native:false})).state).toBe('ready');
        expect((await run({family:'codex-desktop',rows:[row(sub,'osascript')]})).state).toBe('unarmed');
        expect((await run({family:'codex-desktop',rows:[row('WAKE_SUB:other','osascript')],native:false})).state).toBe('unarmed');
    });

    test('legacy re-arm cannot mistake a retained native target for the requested GUI adapter', async () => {
        expect((await run({family:'codex-desktop',rows:[row(sub,'primary-session')]})).state).toBe('ready');
        const result = await run({family:'codex-desktop',rows:[row(sub,'primary-session')],native:false});
        expect(result.state).toBe('unarmed');
        expect(result.reason).toContain('requested osascript');
    });

    test('an unrelated unknown or missing adapter cannot be hidden by a valid native target', async () => {
        for (const adapter of ['opencode-server', undefined]) {
            const other = row('WAKE_SUB:other',adapter);
            if (adapter === undefined) delete other.harnessTargetMetadata.adapter;
            const result = await run({family:'codex-desktop',rows:[row(sub,'primary-session'),other]});
            expect(result.state).toBe('unarmed');
        }
    });

    test('rotation publish retains a separately admitted native wake, but not a different seat profile', async () => {
        const family = 'codex-desktop', home=path.join(dir,'agents','seat-a','harness',family), native=row(sub,'primary-session');
        expect((await run({family,rows:[native]})).state).toBe('ready');
        const rotation = row('WAKE_SUB:rotation','osascript','SESSION_ROTATE');
        const args     = {listSubscriptions:async()=>[native,rotation],manifestPath,tuple:{identity:`@${login}`,instanceType:'userDataDir',instanceAddress:path.join(home,'electron-profile')},
            desiredSubscriptionId:rotation.id,desiredAdapter:'osascript',logger};
        const published = await armSeatWakeRoute(args);
        expect(published.armed).toBe(true);
        expect(published.subscriptionIds).toContain(sub);
        const mismatched = await armSeatWakeRoute({...args,tuple:{...args.tuple,instanceAddress:'/other/profile'}});
        expect(mismatched.armed).toBe(false);
    });

    test('canceled Start withdraws before real manifest publication', async () => {
        const abort  = new AbortController();
        const result = await run({family:'codex-desktop',rows:[],signal:abort});
        expect(result.state).toBe('unarmed');
        await expect(fs.stat(manifestPath)).rejects.toMatchObject({code:'ENOENT'});
    });
});

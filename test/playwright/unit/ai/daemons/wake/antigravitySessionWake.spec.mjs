import {test, expect}                                                                                                                                                                                                                                                                                                                                from '@playwright/test';
import fs                                                                                                                                                                                                                                                                                                                                            from 'node:fs';
import {execFileSync}                                                                                                                                                                                                                                                                                                                                from 'node:child_process';
import os                                                                                                                                                                                                                                                                                                                                            from 'node:os';
import path                                                                                                                                                                                                                                                                                                                                          from 'node:path';
import Database                                                                                                                                                                                                                                                                                                                                      from 'better-sqlite3';
import {readAntigravityWakeTarget, sendAntigravitySessionWake, captureAntigravityWakeCursor, readAntigravityWakeReceipt, classifyAntigravitySessionStart, initializeAntigravityStarts, observeAntigravitySessionStart, latestAntigravityWakeTarget, observeAntigravityPreInvocation, verifyAntigravityWakeAdmission, handleAntigravityPreInvocation} from '../../../../../../ai/daemons/wake/antigravitySessionWake.mjs';

test('selects only an explicit live root in the selected project', () => {
    const root         = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-target-'));
    const databasePath = path.join(root, 'summary.db'), db = new Database(databasePath);
    const a            = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    try {
        db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, project_id TEXT, parent_conversation_id TEXT, nesting_depth INTEGER, killed INTEGER, source TEXT, status TEXT)');
        const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?)');
        insert.run(a, 'project', '', 0, 0, '', 'CASCADE_RUN_STATUS_IDLE');
        insert.run(b, 'project', a, 1, 0, '', 'CASCADE_RUN_STATUS_IDLE');
        expect(readAntigravityWakeTarget({databasePath, projectId:'project', threadId:a})?.threadId).toBe(a);
        expect(readAntigravityWakeTarget({databasePath, projectId:'wrong', threadId:a})).toBeNull();
        expect(readAntigravityWakeTarget({databasePath, projectId:'project', threadId:b})).toBeNull();
        db.prepare('UPDATE conversation_summaries SET killed = 1 WHERE conversation_id = ?').run(a);
        expect(readAntigravityWakeTarget({databasePath, projectId:'project', threadId:a})).toBeNull();
    } finally { db.close(); fs.rmSync(root, {recursive:true, force:true}) }
});

test('uses the provided sidecar executor without shell and never reports a turn', async () => {
    const threadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', calls = [];
    const result   = await sendAntigravitySessionWake({threadId, message:'test', agentapiExecutable:'/app/language_server', environment:{}, exec:async (...args) => { calls.push(args); return {stdout:'{}'} }});
    expect(calls[0][1]).toEqual(['agentapi', 'send-message', threadId, 'test']);
    expect(result.outcome).toBe('unknown');
    await expect(sendAntigravitySessionWake({threadId:'not-a-uuid', message:'test', agentapiExecutable:'/app/language_server'})).rejects.toThrow();
});

test('receipt requires post-cursor exact user input followed by a model response', () => {
    const root     = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-receipt-'));
    const threadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const dir      = path.join(root, 'brain', threadId, '.system_generated', 'logs');
    fs.mkdirSync(dir, {recursive:true});
    const file = path.join(dir, 'transcript.jsonl');
    const row  = value => JSON.stringify(value) + '\n';
    try {
        fs.writeFileSync(file, row({type:'USER_INPUT',source:'USER_EXPLICIT',status:'DONE',content:'wake',step_index:1}));
        const cursor       = captureAntigravityWakeCursor({appDataDir:root, threadId});
        const receiptToken = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
        const check        = () => readAntigravityWakeReceipt({appDataDir:root,threadId,text:'wake',cursor,receiptToken});
        fs.appendFileSync(file, row({type:'GENERIC',source:'MODEL',status:'DONE',content:'wake',step_index:2}));
        expect(check().outcome).toBe('unknown');
        fs.appendFileSync(file, row({type:'USER_INPUT',source:'USER_EXPLICIT',status:'DONE',content:'wake plus',step_index:3}));
        expect(check().outcome).toBe('unknown');
        fs.appendFileSync(file, row({type:'USER_INPUT',source:'USER_EXPLICIT',status:'DONE',content:'wake',step_index:4}));
        expect(check().outcome).toBe('unknown');
        fs.appendFileSync(file, row({type:'PLANNER_RESPONSE',source:'MODEL',status:'DONE',step_index:5,content:'[NEO_WAKE_RECEIVED:'+receiptToken+']'}));
        expect(check().outcome).toBe('observed');
        fs.renameSync(file, file + '.old');
        fs.writeFileSync(file, '');
        expect(check().outcome).toBe('unknown');
    } finally { fs.rmSync(root,{recursive:true,force:true}) }
});

test('SessionStart classification refuses existing, helper, killed and concurrent roots', () => {
    const root         = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-start-'));
    const databasePath = path.join(root, 'summary.db'), db = new Database(databasePath);
    const a            = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', c = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    try {
        db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, project_id TEXT, parent_conversation_id TEXT, nesting_depth INTEGER, killed INTEGER, source TEXT, status TEXT)');
        const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?)');
        insert.run(a, 'p', '', 0, 0, '', 'CASCADE_RUN_STATUS_IDLE');
        const classify = (threadId, priorThreadIds) => classifyAntigravitySessionStart({databasePath,projectId:'p',threadId,priorThreadIds});
        expect(classify(a,[a])).toBeNull();
        insert.run(b, 'p', a, 1, 0, '', 'CASCADE_RUN_STATUS_IDLE');
        expect(classify(b,[a])).toBeNull();
        insert.run(c, 'p', '', 0, 0, '', 'CASCADE_RUN_STATUS_IDLE');
        expect(classify(c,[a])?.threadId).toBe(c);
        db.prepare('UPDATE conversation_summaries SET killed=1 WHERE conversation_id=?').run(c);
        expect(classify(c,[a])).toBeNull();
        db.prepare('UPDATE conversation_summaries SET parent_conversation_id=\'\', nesting_depth=0 WHERE conversation_id=?').run(b);
        expect(classify(c,[a])).toBeNull();
    } finally { db.close(); fs.rmSync(root,{recursive:true,force:true}) }
});

import {resolveAntigravitySidecarAncestor, runAntigravitySidecar, materializeAntigravitySidecar, validateAntigravitySidecarCapability, materializeAntigravityWakeHooks} from '../../../../../../ai/daemons/wake/antigravityWakeSidecar.mjs';

test('sidecar requires a unique exact App ancestor and passes lease facts to the dispatcher', async () => {
    const rows = [
        {pid:1,ppid:0,command:'/os',startedAt:'epoch'},
        {pid:10,ppid:1,command:'/g/Antigravity.app/Contents/MacOS/Antigravity --user-data-dir=/seat/profile',startedAt:'epoch'},
        {pid:11,ppid:10,command:'/g/language_server',startedAt:'later'},
        {pid:12,ppid:11,command:'sidecar',startedAt:'later'}
    ];
    expect(resolveAntigravitySidecarAncestor({sidecarPid:12,rows})).toEqual({
        appPid:10,appStart:'epoch',appBundle:'/g/Antigravity.app',instanceHome:'/seat/profile'
    });
    expect(resolveAntigravitySidecarAncestor({sidecarPid:1,rows})).toBeNull();
    const abort = new AbortController(), calls = [];
    await runAntigravitySidecar({stateDir:'/state',manifestPath:'/manifest',sidecarPid:12,readRows:()=>rows,
        signal:abort.signal, validateCapability:()=>true, dispatch:async value => {calls.push(value); abort.abort()}});
    expect(calls).toHaveLength(1);
    expect(calls[0].appPid).toBe(10);
});

test('sidecar materializer preserves unrelated configuration and refuses a different owned target', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-install-'));
    try {
        fs.writeFileSync(path.join(root,'config.json'), JSON.stringify({theme:'dark',sidecars:{foreign:{enabled:true}}}));
        const args = {configDir:root,nodePath:'/pinned/helper',modulePath:'/brain/sidecar.mjs',manifestPath:'/wake/manifest',stateDir:'/wake/state'};
        await materializeAntigravitySidecar(args);
        const config = JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'));
        expect(config.theme).toBe('dark');
        expect(config.sidecars.foreign).toEqual({enabled:true});
        expect(config.sidecars['neo-primary-session']).toEqual({enabled:true});
        await materializeAntigravitySidecar(args);
        await expect(materializeAntigravitySidecar({...args,stateDir:'/different'})).rejects.toThrow(/Conflicting/);
    } finally { fs.rmSync(root,{recursive:true,force:true}) }
});

test('native sidecar capability requires loopback and exact bundle executable', () => {
    const resolve = x => x;
    expect(validateAntigravitySidecarCapability({appBundle:'/a/Antigravity.app',realpath:resolve,environment:{
        ANTIGRAVITY_LS_ADDRESS:'https://127.0.0.1:4444',
        ANTIGRAVITY_AGENTAPI_EXE:'/a/Antigravity.app/Contents/Resources/bin/language_server'
    }})).toBe(true);
    expect(validateAntigravitySidecarCapability({appBundle:'/a/Antigravity.app',realpath:resolve,environment:{
        ANTIGRAVITY_LS_ADDRESS:'https://other.example:4444',
        ANTIGRAVITY_AGENTAPI_EXE:'/a/Antigravity.app/Contents/Resources/bin/language_server'
    }})).toBe(false);
});

test('generation census and hook admission reject stale, helper, replay and unobserved successors', async () => {
    const root         = fs.mkdtempSync(path.join(os.tmpdir(),'agy-epoch-'));
    const databasePath = path.join(root,'summary.db'), statePath=path.join(root,'seat.json'), db=new Database(databasePath);
    const old          = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', current='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        successor='cccccccc-cccc-4ccc-8ccc-cccccccccccc', nonce='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const ctx = {databasePath,projectId:'p',projectRoot:'/project',generation:'9:epoch',statePath};
    try {
        db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, project_id TEXT, parent_conversation_id TEXT, nesting_depth INTEGER, killed INTEGER, source TEXT, status TEXT)');
        const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?)');
        insert.run(old,'p','',0,0,'','CASCADE_RUN_STATUS_IDLE');
        await initializeAntigravityStarts(ctx);
        expect(latestAntigravityWakeTarget(ctx)).toBeNull();
        insert.run(current,'p','',0,0,'','CASCADE_RUN_STATUS_IDLE');
        await observeAntigravitySessionStart({...ctx,input:{conversationId:current,workspacePaths:['/project']}});
        expect(latestAntigravityWakeTarget(ctx)?.threadId).toBe(current);
        const input = {conversationId:current,workspacePaths:['/project'],invocationNum:0,lastUserInput:'hello'};
        expect(await observeAntigravityPreInvocation({...ctx,input})).toBe(true);
        expect(verifyAntigravityWakeAdmission({...ctx,threadId:current}).verified).toBe(true);
        expect(latestAntigravityWakeTarget({...ctx,generation:'10:new'})).toBeNull();
        expect(verifyAntigravityWakeAdmission({...ctx,threadId:current,generation:'10:new'}).verified).toBe(false);
        let   calls   = 0;
        const consume = async()=>{ calls++; return {admitted:true,digest:'private\n[NEO_WAKE_RECEIVED:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee]'} };
        const marker  = '[NEO_WAKE_V1:'+nonce+'] [WAKE]';
        expect((await handleAntigravityPreInvocation({...ctx,input:{...input,lastUserInput:marker},consume})).injectSteps[0].ephemeralMessage).toContain('private');
        expect(calls).toBe(1);
        fs.writeFileSync(statePath+'.claim.json',JSON.stringify({admitted:true,nonce,threadId:current,generation:ctx.generation}));
        expect(await handleAntigravityPreInvocation({...ctx,input:{...input,lastUserInput:marker,invocationNum:1},consume})).toEqual({});
        expect(calls).toBe(1);
        expect((await handleAntigravityPreInvocation({...ctx,input:{...input,conversationId:old,lastUserInput:marker},consume})).terminationBehavior).toBe('terminate');
        insert.run(successor,'p','',0,1,'','CASCADE_RUN_STATUS_IDLE');
        expect(latestAntigravityWakeTarget(ctx)).toBeNull();
        expect((await handleAntigravityPreInvocation({...ctx,input:{...input,lastUserInput:marker},consume})).terminationBehavior).toBe('terminate');
    } finally { db.close(); fs.rmSync(root,{recursive:true,force:true}) }
});

test('hook preparation preserves foreign groups and rejects a different owner', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'agy-hooks-'));
    try {
        fs.mkdirSync(path.join(root,'.agents'));
        fs.writeFileSync(path.join(root,'.agents','hooks.json'),JSON.stringify({foreign:{enabled:false}}));
        const args = {workspaceRoot:root,nodePath:'/pinned/helper',hookPath:'/brain/hook.mjs',manifestPath:'/wake/manifest',stateDir:'/wake/state'};
        await materializeAntigravityWakeHooks(args);
        const config = JSON.parse(fs.readFileSync(path.join(root,'.agents','hooks.json'),'utf8'));
        expect(config.foreign).toEqual({enabled:false});
        expect(config['neo-primary-session'].SessionStart).toHaveLength(1);
        expect(config['neo-primary-session'].PreInvocation).toHaveLength(1);
        await expect(materializeAntigravityWakeHooks({...args,stateDir:'/other'})).rejects.toThrow(/Conflicting/);
    } finally { fs.rmSync(root,{recursive:true,force:true}) }
});

import {handleAntigravityWakeHook} from '../../../../../../ai/daemons/wake/antigravityWakeHook.mjs';

test('native hook callback binds a verified lease and rejects a foreign conversation', async () => {
    const root        = fs.mkdtempSync(path.join(os.tmpdir(),'agy-hook-'));
    const home        = path.join(root,'profile'), data=path.join(root,'data'), stateDir=path.join(root,'state');
    const projectRoot = path.join(root,'project'), appBundle=path.join(root,'gen','Antigravity.app');
    const id          = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nonce='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const generation  = '10:epoch', statePath=path.join(stateDir,'primary-sessions','neo-test.json');
    fs.mkdirSync(home,{recursive:true}); fs.mkdirSync(data); fs.mkdirSync(path.dirname(statePath),{recursive:true});
    const databasePath = path.join(data,'conversation_summaries.db'), db=new Database(databasePath);
    try {
        db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, project_id TEXT, parent_conversation_id TEXT, nesting_depth INTEGER, killed INTEGER, source TEXT, status TEXT)');
        const route = {agentIdentity:'@neo-test',harnessTargetMetadata:{adapter:'primary-session'},adapterConfig:{primarySession:{
            family:'antigravity',agentId:'neo-test',instanceHome:home,appBundle,projectId:'p',projectRoot}}};
        const manifestPath = path.join(root,'manifest.json');
        fs.writeFileSync(manifestPath,JSON.stringify({routes:{route}}),{mode:0o600});
        fs.writeFileSync(path.join(home,'.neo-fleet-seat-lease.json'),JSON.stringify({pid:10,pidStartedAt:'epoch',
            agentId:'neo-test',harnessType:'antigravity',cwd:projectRoot,harnessGenerationId:'gen'}),{mode:0o600});
        const rows = [{pid:10,ppid:1,startedAt:'epoch',command:appBundle+'/Contents/MacOS/Antigravity --user-data-dir='+home},
            {pid:11,ppid:10,startedAt:'epoch',command:'hook'}];
        await initializeAntigravityStarts({databasePath,projectId:'p',generation,statePath});
        db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?)').run(id,'p','',0,0,'','CASCADE_RUN_STATUS_IDLE');
        const base = {manifestPath,stateDir,appDataDir:data,sidecarPid:11,readRows:()=>rows};
        await handleAntigravityWakeHook({...base,event:'SessionStart',input:{conversationId:id,workspacePaths:[projectRoot]}});
        let   calls  = 0;
        const input  = {conversationId:id,workspacePaths:[projectRoot],invocationNum:0,lastUserInput:'[NEO_WAKE_V1:'+nonce+'] [WAKE]'};
        const output = await handleAntigravityWakeHook({...base,event:'PreInvocation',input,consume:async()=>{calls++;return {admitted:true,digest:'safe'}}});
        expect(output.injectSteps[0].ephemeralMessage).toContain('safe');
        expect(calls).toBe(1);
        const denied = await handleAntigravityWakeHook({...base,event:'PreInvocation',input:{...input,conversationId:nonce},consume:async()=>{calls++;}});
        expect(denied.terminationBehavior).toBe('terminate');
        expect(calls).toBe(1);
    } finally { db.close(); fs.rmSync(root,{recursive:true,force:true}) }
});

test('hook entrypoint is neutral for malformed and oversized ordinary input', () => {
    const script = path.resolve('ai/daemons/wake/antigravityWakeHook.mjs');
    const args   = [script,'--event','PreInvocation','--manifest','/missing','--state','/missing'];
    for (const input of ['not-json',JSON.stringify({lastUserInput:'ordinary'.repeat(160000)})]) {
        expect(JSON.parse(execFileSync(process.execPath,args,{input,encoding:'utf8'}))).toEqual({});
    }
});

import {resolveAntigravitySidecarAncestor, runAntigravitySidecar, materializeAntigravitySidecar, validateAntigravitySidecarCapability, materializeAntigravityWakeHooks} from '../../../../../../ai/daemons/wake/antigravityWakeSidecar.mjs';
import protobuf                                                                                                                                                         from 'protobufjs/minimal.js';
import {test, expect}                                                                                                                                                   from '@playwright/test';
import fs                                                                                                                                                               from 'node:fs';
import {execFileSync}                                                                                                                                                   from 'node:child_process';
import os                                                                                                                                                               from 'node:os';
import path                                                                                                                                                             from 'node:path';
import Database                                                                                                                                                         from 'better-sqlite3';
import {
    readAntigravityWakeTarget,
    sendAntigravitySessionWake,
    captureAntigravityWakeCursor,
    readAntigravityWakeReceipt,
    isAntigravityWakeSystemMessage,
    isAntigravityExternalSystemMessage,
    hasAntigravityPendingSystemWake,
    initializeAntigravityStarts,
    reconcileAntigravityStarts,
    observeAntigravitySessionStart,
    latestAntigravityWakeTarget,
    observeAntigravityPreInvocation,
    verifyAntigravityWakeAdmission,
    handleAntigravityPreInvocation,
    stageAntigravityLaunchCensus,
    bindAntigravityLaunchGeneration,
    cleanupAntigravityLaunchCensus
} from '../../../../../../ai/daemons/wake/antigravitySessionWake.mjs';
import {WakeReceiverState}                                                            from '../../../../../../ai/daemons/wake/receiverState.mjs';
import {consumeNativeWakePrompt, dispatchAntigravitySidecarRecords, enrollNativeWake} from '../../../../../../ai/daemons/wake/fleetPrimarySessionWake.mjs';
import {stagePrimaryWake}                                                             from '../../../../../../ai/daemons/wake/primaryWakeSpool.mjs';


function fixtureSummary(id, project, parent = '', depth = 0, fork = '', createdAtMs = null) {
    const metadata = protobuf.Writer.create();
    if (parent) metadata.uint32(42).string(parent);
    metadata.uint32(50).string(id);
    if (depth) metadata.uint32(136).uint32(depth);
    metadata.uint32(146).string(project);
    const summary = protobuf.Writer.create().uint32(34).string('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    if (createdAtMs !== null) {
        const seconds = Math.floor(createdAtMs / 1000);
        const nanos   = Math.max(0, Math.round((createdAtMs - seconds * 1000) * 1_000_000));
        const ts      = protobuf.Writer.create().uint32(8).int64(seconds).uint32(16).uint32(nanos).finish();
        summary.uint32(58).bytes(ts);
    }
    summary.uint32(138).bytes(metadata.finish());
    if (fork) summary.uint32(194).string(fork);
    return Buffer.from(summary.finish());
}

function prepareFixtureDb(db) {
    db.exec('ALTER TABLE conversation_summaries ADD COLUMN raw_summary BLOB');
}

function insertFixture(db, id, project, parent, depth, killed, source, status, createdAtMs = null, fork = '') {
    db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?)')
        .run(id,project,parent,depth,killed,source,status,fixtureSummary(id,project,parent,depth,fork,createdAtMs));
}

test('selects only an explicit live root in the selected project', () => {
    const root         = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-target-'));
    const databasePath = path.join(root, 'summary.db'), db = new Database(databasePath);
    const a            = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    try {
        db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, project_id TEXT, parent_conversation_id TEXT, nesting_depth INTEGER, killed INTEGER, source TEXT, status TEXT)');
        prepareFixtureDb(db);
        const insert = (...args) => insertFixture(db,...args);
        insert(a, 'project', '', 0, 0, '', 'CASCADE_RUN_STATUS_IDLE');
        insert(b, 'project', a, 1, 0, '', 'CASCADE_RUN_STATUS_IDLE');
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

test('sidecar ancestor resolves instanceHome across 2.32.2 and 2.33.0 --remote-debugging-port=0 argv shapes', () => {
    for (const command of [
        '/g/Antigravity.app/Contents/MacOS/Antigravity --user-data-dir=/seat/profile',
        '/g/Antigravity.app/Contents/MacOS/Antigravity --user-data-dir=/seat/profile --remote-debugging-port=0'
    ]) {
        const rows = [
            {pid: 1,  ppid: 0,  command: '/os',               startedAt: 'epoch'},
            {pid: 10, ppid: 1,  command,                      startedAt: 'epoch'},
            {pid: 11, ppid: 10, command: '/g/language_server', startedAt: 'later'},
            {pid: 12, ppid: 11, command: 'sidecar',            startedAt: 'later'}
        ];

        expect(resolveAntigravitySidecarAncestor({sidecarPid: 12, rows}), command).toEqual({
            appPid      : 10,
            appStart    : 'epoch',
            appBundle   : '/g/Antigravity.app',
            instanceHome: '/seat/profile'
        });
    }
});

test('sidecar materializer preserves unrelated configuration and refuses a different owned target', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-install-')));
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

test('legacy project metadata survives repeat and authorized runtime upgrade without adopting a foreign executable', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-legacy-sidecar-')));
    try {
        const old = {configDir:root,nodePath:'/old/node',modulePath:'/old/sidecar.mjs',manifestPath:'/wake/manifest',stateDir:'/wake/state'};
        await materializeAntigravitySidecar(old);
        const file  = path.join(root,'config.json'), entry = {enabled:true,projectId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',schemaVersion:1};
        const bytes = JSON.stringify({other:{keep:true},sidecars:{'neo-primary-session':entry}},null,3)+'\n';
        fs.writeFileSync(file,bytes); fs.chmodSync(file,0o640);
        await materializeAntigravitySidecar(old);
        const next = {...old,nodePath:'/new/node',modulePath:'/new/sidecar.mjs',previous:{nodePath:old.nodePath,modulePath:old.modulePath}};
        await materializeAntigravitySidecar(next);
        expect(fs.readFileSync(file,'utf8')).toBe(bytes);
        expect(fs.statSync(file).mode & 0o777).toBe(0o640);
        await expect(materializeAntigravitySidecar({...next,nodePath:'/foreign/node'})).rejects.toThrow(/Conflicting/);
        expect(fs.readFileSync(file,'utf8')).toBe(bytes)
    } finally { fs.rmSync(root,{recursive:true,force:true}) }
});

test('legacy sidecar metadata rejects disabled, malformed, unsupported and orphaned entries', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-legacy-invalid-')));
    try {
        const args = {configDir:root,nodePath:'/old/node',modulePath:'/old/sidecar.mjs',manifestPath:'/wake/manifest',stateDir:'/wake/state'};
        await materializeAntigravitySidecar(args);
        const file = path.join(root,'config.json'), definition=path.join(root,'sidecars','neo-primary-session','sidecar.json');
        for (const entry of [{enabled:false}, {enabled:true,projectId:''}, {enabled:true,projectId:42},
            {enabled:true,schemaVersion:2}, {enabled:true,schemaVersion:'1'}, {enabled:true,unknown:true}]) {
            const bytes = JSON.stringify({sidecars:{'neo-primary-session':entry}}); fs.writeFileSync(file,bytes);
            await expect(materializeAntigravitySidecar(args)).rejects.toThrow(/Conflicting/);
            expect(fs.readFileSync(file,'utf8')).toBe(bytes)
        }
        fs.writeFileSync(file,JSON.stringify({sidecars:{'neo-primary-session':{enabled:true,projectId:'other'}}}));
        fs.rmSync(definition);
        await expect(materializeAntigravitySidecar(args)).rejects.toThrow(/Conflicting/)
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
        prepareFixtureDb(db);
        const insert = (...args) => insertFixture(db,...args);
        insert(old,'p','',0,0,'','CASCADE_RUN_STATUS_IDLE');
        await initializeAntigravityStarts(ctx);
        expect(latestAntigravityWakeTarget(ctx)).toBeNull();
        insert(current,'p','',0,0,'','CASCADE_RUN_STATUS_IDLE');
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
        expect((await handleAntigravityPreInvocation({...ctx,input:{...input,lastUserInput:marker},consume})).injectSteps[0].systemMessage.systemMessage).toContain('private');
        expect(calls).toBe(1);
        fs.writeFileSync(statePath+'.claim.json',JSON.stringify({admitted:true,nonce,threadId:current,generation:ctx.generation}));
        expect(await handleAntigravityPreInvocation({...ctx,input:{...input,lastUserInput:marker,invocationNum:1},consume})).toEqual({});
        expect(calls).toBe(1);
        const {invocationNum: _omitted, ...omittedInvocationInput} = {...input, lastUserInput: marker};
        expect(await observeAntigravityPreInvocation({...ctx,input:{conversationId:current,workspacePaths:['/project'],lastUserInput:'hello'}})).toBe(true);
        expect((await handleAntigravityPreInvocation({...ctx,input:omittedInvocationInput,consume})).injectSteps[0].systemMessage.systemMessage).toContain('private');
        expect(calls).toBe(2);
        expect((await handleAntigravityPreInvocation({...ctx,input:{...input,conversationId:old,lastUserInput:marker},consume})).terminationBehavior).toBe('terminate');
        insert(successor,'p','',0,1,'','CASCADE_RUN_STATUS_IDLE');
        expect(latestAntigravityWakeTarget(ctx)).toBeNull();
        expect((await handleAntigravityPreInvocation({...ctx,input:{...input,lastUserInput:marker},consume})).terminationBehavior).toBe('terminate');
    } finally { db.close(); fs.rmSync(root,{recursive:true,force:true}) }
});

test('hook preparation preserves foreign groups and rejects a different owner', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'agy-hooks-')));
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
        prepareFixtureDb(db);
        const route = {agentIdentity:'@neo-test',harnessTargetMetadata:{adapter:'primary-session'},adapterConfig:{primarySession:{
            family:'antigravity',agentId:'neo-test',instanceHome:home,appBundle,projectId:'p',projectRoot}}};
        const manifestPath = path.join(root,'manifest.json');
        fs.writeFileSync(manifestPath,JSON.stringify({routes:{route}}),{mode:0o600});
        fs.writeFileSync(path.join(home,'.neo-fleet-seat-lease.json'),JSON.stringify({pid:10,pidStartedAt:'epoch',
            agentId:'neo-test',harnessType:'antigravity',cwd:projectRoot,harnessGenerationId:'gen'}),{mode:0o600});
        const rows = [{pid:10,ppid:1,startedAt:'epoch',command:appBundle+'/Contents/MacOS/Antigravity --user-data-dir='+home},
            {pid:11,ppid:10,startedAt:'epoch',command:'hook'}];
        await initializeAntigravityStarts({databasePath,projectId:'p',generation,statePath});
        insertFixture(db,id,'p','',0,0,'','CASCADE_RUN_STATUS_IDLE');
        const base = {manifestPath,stateDir,appDataDir:data,sidecarPid:11,readRows:()=>rows};
        await handleAntigravityWakeHook({...base,event:'SessionStart',input:{conversationId:id,workspacePaths:[projectRoot]}});
        let   calls  = 0;
        const input  = {conversationId:id,workspacePaths:[projectRoot],invocationNum:0,lastUserInput:'[NEO_WAKE_V1:'+nonce+'] [WAKE]'};
        const output = await handleAntigravityWakeHook({...base,event:'PreInvocation',input,consume:async()=>{calls++;return {admitted:true,digest:'safe'}}});
        expect(output.injectSteps[0].systemMessage.systemMessage).toContain('safe');
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

test('native system envelope binds nonce and produces receipt only with private model echo', () => {
    const root     = fs.mkdtempSync(path.join(os.tmpdir(),'agy-native-'));
    const threadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nonce='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        receiptToken='cccccccc-cccc-4ccc-8ccc-cccccccccccc', marker='[NEO_WAKE_V1:'+nonce+'] [WAKE]';
    const dir = path.join(root,'brain',threadId,'.system_generated','logs');
    fs.mkdirSync(dir,{recursive:true}); const file=path.join(dir,'transcript.jsonl');
    const row = x=>JSON.stringify(x)+'\n';
    try {
        fs.writeFileSync(file,'');
        const cursor   = captureAntigravityWakeCursor({appDataDir:root,threadId});
        const envelope = markerText=>'The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-14T16:24:03Z sender=system priority=MESSAGE_PRIORITY_HIGH content='+markerText+'\n</SYSTEM_MESSAGE>';
        const item     = {type:'SYSTEM_MESSAGE',source:'SYSTEM',status:'DONE',step_index:1,content:envelope(marker)};
        expect(isAntigravityWakeSystemMessage({...item,source:'MODEL'},marker)).toBe(false);
        expect(isAntigravityWakeSystemMessage({...item,content:envelope(marker+'extra')},marker)).toBe(false);
        fs.appendFileSync(file,row(item));
        expect(hasAntigravityPendingSystemWake({appDataDir:root,threadId,text:marker,cursor})).toBe(true);
        const read = ()=>readAntigravityWakeReceipt({appDataDir:root,threadId,text:marker,cursor,receiptToken});
        fs.appendFileSync(file,row({type:'GENERIC',source:'MODEL',status:'DONE',step_index:2,content:'[NEO_WAKE_RECEIVED:'+receiptToken+']'}));
        expect(read().outcome).toBe('unknown');
        fs.appendFileSync(file,row({type:'PLANNER_RESPONSE',source:'MODEL',status:'DONE',step_index:3,content:'prefix [NEO_WAKE_RECEIVED:'+receiptToken+']'}));
        expect(read().outcome).toBe('unknown');
        fs.appendFileSync(file,row({type:'PLANNER_RESPONSE',source:'MODEL',status:'DONE',step_index:4,content:'[NEO_WAKE_RECEIVED:'+receiptToken+']'}));
        expect(read().outcome).toBe('observed');
    } finally { fs.rmSync(root,{recursive:true,force:true}) }
});

test('App callback redeems a bound native system wake with unrelated lastUserInput', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'agy-native-hook-'));
    const home = path.join(root,'profile'), data=path.join(root,'data'), stateDir=path.join(root,'state'),
        projectRoot=path.join(root,'project'), appBundle=path.join(root,'gen','Antigravity.app'),
        id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nonce='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        generation='10:epoch', statePath=path.join(stateDir,'primary-sessions','neo-test.json');
    fs.mkdirSync(home,{recursive:true});fs.mkdirSync(data);fs.mkdirSync(path.dirname(statePath),{recursive:true});
    const databasePath = path.join(data,'conversation_summaries.db'), db=new Database(databasePath);
    try {
        db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, project_id TEXT, parent_conversation_id TEXT, nesting_depth INTEGER, killed INTEGER, source TEXT, status TEXT)');
        prepareFixtureDb(db);
        const route = {agentIdentity:'@neo-test',harnessTargetMetadata:{adapter:'primary-session'},adapterConfig:{primarySession:{
            family:'antigravity',agentId:'neo-test',instanceHome:home,appBundle,projectId:'p',projectRoot}}};
        const manifestPath = path.join(root,'manifest.json');
        fs.writeFileSync(manifestPath,JSON.stringify({routes:{route}}),{mode:0o600});
        fs.writeFileSync(path.join(home,'.neo-fleet-seat-lease.json'),JSON.stringify({pid:10,pidStartedAt:'epoch',
            agentId:'neo-test',harnessType:'antigravity',cwd:projectRoot,harnessGenerationId:'gen'}),{mode:0o600});
        const rows = [{pid:10,ppid:1,startedAt:'epoch',command:appBundle+'/Contents/MacOS/Antigravity --user-data-dir='+home},
            {pid:11,ppid:10,startedAt:'epoch',command:'hook'}];
        await initializeAntigravityStarts({databasePath,projectId:'p',generation,statePath});
        insertFixture(db,id,'p','',0,0,'','CASCADE_RUN_STATUS_IDLE');
        const base = {manifestPath,stateDir,appDataDir:data,sidecarPid:11,readRows:()=>rows};
        await handleAntigravityWakeHook({...base,event:'SessionStart',input:{conversationId:id,workspacePaths:[projectRoot]}});
        const logs       = path.join(data,'brain',id,'.system_generated','logs');fs.mkdirSync(logs,{recursive:true});
        const transcript = path.join(logs,'transcript.jsonl');fs.writeFileSync(transcript,'');
        const cursor     = captureAntigravityWakeCursor({appDataDir:data,threadId:id});
        fs.writeFileSync(statePath,JSON.stringify({version:1,binding:{threadId:id,generation},inflight:{status:'unknown',nonce}}),{mode:0o600});
        fs.writeFileSync(statePath+'.cursor.json',JSON.stringify({nonce,cursor}),{mode:0o600});
        const marker  = '[NEO_WAKE_V1:'+nonce+'] [WAKE]';
        const content = 'The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-14T16:24:03Z sender=system priority=MESSAGE_PRIORITY_HIGH content='+marker+'\n</SYSTEM_MESSAGE>';
        fs.appendFileSync(transcript,JSON.stringify({type:'SYSTEM_MESSAGE',source:'SYSTEM',status:'DONE',step_index:1,content})+'\n');
        let   calls            = 0;
        const input            = {conversationId:id,workspacePaths:[projectRoot],invocationNum:2,lastUserInput:'unrelated human input'};
        const negativeRequests = [];
        const starts           = fs.readFileSync(statePath+'.starts.json','utf8');
        fs.unlinkSync(statePath+'.starts.json');
        const denied = await handleAntigravityWakeHook({...base,event:'PreInvocation',input,
            consume:async request=>{negativeRequests.push(request);return {admitted:false}}});
        expect(denied.terminationBehavior).toBe('terminate');
        expect(negativeRequests).toEqual([{manifestPath,stateDir,agentId:'neo-test',family:'antigravity',
            threadId:id,nonce,denyOnly:true,expectedGeneration:generation,appDataDir:data}]);
        fs.writeFileSync(statePath+'.starts.json',starts,{mode:0o600});
        const consume = async()=>{calls++;return {admitted:true,digest:'safe'}};
        expect((await handleAntigravityWakeHook({...base,event:'PreInvocation',input,consume})).injectSteps[0].systemMessage.systemMessage).toContain('safe');
        expect(calls).toBe(1);
        fs.writeFileSync(statePath+'.claim.json',JSON.stringify({admitted:true,nonce,threadId:id,generation}),{mode:0o600});
        expect(await handleAntigravityWakeHook({...base,event:'PreInvocation',input:{...input,invocationNum:3},consume})).toEqual({});
        expect(calls).toBe(1);
        fs.appendFileSync(transcript,JSON.stringify({type:'USER_INPUT',source:'USER_EXPLICIT',status:'DONE',step_index:2,content:'new human prompt'})+'\n');
        expect(await handleAntigravityWakeHook({...base,event:'PreInvocation',input:{...input,invocationNum:0,lastUserInput:'new human prompt'},consume})).toEqual({});
        expect(calls).toBe(1);
    } finally {db.close();fs.rmSync(root,{recursive:true,force:true})}
});

test('streams long deltas after an orphaned cursor line and fences intervening inputs', () => {
    const root     = fs.mkdtempSync(path.join(os.tmpdir(),'agy-long-'));
    const threadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nonce='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        token='cccccccc-cccc-4ccc-8ccc-cccccccccccc', marker='[NEO_WAKE_V1:'+nonce+'] [WAKE]';
    const dir     = path.join(root,'brain',threadId,'.system_generated','logs');fs.mkdirSync(dir,{recursive:true});
    const file    = path.join(dir,'transcript.jsonl'), row=x=>JSON.stringify(x)+'\n';
    const content = 'The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-14T16:24:03Z sender=system priority=MESSAGE_PRIORITY_HIGH content='+marker+'\n</SYSTEM_MESSAGE>';
    const wake    = {type:'SYSTEM_MESSAGE',source:'SYSTEM',status:'DONE',step_index:10000,content};
    const ack     = {type:'PLANNER_RESPONSE',source:'MODEL',status:'DONE',step_index:10001,content:'[NEO_WAKE_RECEIVED:'+token+']'};
    try {
        fs.writeFileSync(file,'{"partial":');
        const cursor = captureAntigravityWakeCursor({appDataDir:root,threadId});
        fs.appendFileSync(file,'true}\n'+row({type:'GENERIC',source:'MODEL',status:'DONE',content:'x'.repeat(1024)}).repeat(6000)+row(wake));
        expect(hasAntigravityPendingSystemWake({appDataDir:root,threadId,text:marker,cursor})).toBe(true);
        const read = ()=>readAntigravityWakeReceipt({appDataDir:root,threadId,text:marker,cursor,receiptToken:token});
        expect(read().outcome).toBe('unknown');
        fs.appendFileSync(file,row({type:'USER_INPUT',source:'USER_EXPLICIT',status:'DONE',content:'later',step_index:10001})+row(ack));
        expect(hasAntigravityPendingSystemWake({appDataDir:root,threadId,text:marker,cursor})).toBe(false);
        expect(read().outcome).toBe('unknown');
        fs.appendFileSync(file,row({...wake,step_index:10002})+row({...ack,step_index:10003}));
        expect(read().outcome).toBe('observed');
        fs.truncateSync(file,0);
        expect(read().outcome).toBe('unknown');
        fs.writeFileSync(file, 'x'.repeat(128)+'\\n'+row(wake)+row(ack));
        expect(read().outcome).toBe('unknown');
    } finally {fs.rmSync(root,{recursive:true,force:true})}
});

test('transcript cursor refuses a symlinked conversation ancestor', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'agy-link-'));
    const id   = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    try {
        const dir = path.join(root,'brain',other,'.system_generated','logs');fs.mkdirSync(dir,{recursive:true});
        fs.writeFileSync(path.join(dir,'transcript.jsonl'),'');
        fs.symlinkSync(other,path.join(root,'brain',id));
        expect(()=>captureAntigravityWakeCursor({appDataDir:root,threadId:id})).toThrow();
    } finally {fs.rmSync(root,{recursive:true,force:true})}
});

test('native metadata fences forks, malformed summaries and changing identity tuples', async () => {
    const root         = fs.mkdtempSync(path.join(os.tmpdir(),'agy-proto-'));
    const databasePath = path.join(root,'summary.db'),statePath=path.join(root,'seat.json'),db=new Database(databasePath);
    const old          = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', fork='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        current='cccccccc-cccc-4ccc-8ccc-cccccccccccc', unknown='dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        child='ffffffff-ffff-4fff-8fff-ffffffffffff';
    const ctx = {databasePath,projectId:'p',projectRoot:'/p',generation:'g',statePath};
    try {
        db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, project_id TEXT, parent_conversation_id TEXT, nesting_depth INTEGER, killed INTEGER, source TEXT, status TEXT)');
        prepareFixtureDb(db);
        const put  = (...args)=>insertFixture(db,...args);
        const blob = db.prepare('UPDATE conversation_summaries SET raw_summary=? WHERE conversation_id=?');
        put(old,'p','',0,0,'','CASCADE_RUN_STATUS_IDLE');
        await initializeAntigravityStarts(ctx);
        put(child,'p',old,1,0,'','CASCADE_RUN_STATUS_IDLE');
        expect(await observeAntigravitySessionStart({...ctx,input:{conversationId:child,workspacePaths:['/p']}})).toBeNull();
        put(fork,'p','',0,0,'','CASCADE_RUN_STATUS_IDLE');
        blob.run(fixtureSummary(fork,'p','',0,old),fork);
        expect(readAntigravityWakeTarget({...ctx,threadId:fork})).toBeNull();
        put(current,'p','',0,0,'','CASCADE_RUN_STATUS_IDLE');
        expect((await observeAntigravitySessionStart({...ctx,input:{conversationId:current,workspacePaths:['/p']}}))?.threadId).toBe(current);
        expect(await observeAntigravitySessionStart({...ctx,input:{conversationId:fork,workspacePaths:['/p']}})).toBeNull();
        expect(latestAntigravityWakeTarget(ctx)?.threadId).toBe(current);
        blob.run(fixtureSummary(current,'other'),current);
        expect(latestAntigravityWakeTarget(ctx)).toBeNull();
        blob.run(fixtureSummary(current,'p'),current);
        expect(latestAntigravityWakeTarget(ctx)?.threadId).toBe(current);
        put(unknown,'p','',0,0,'','CASCADE_RUN_STATUS_IDLE');
        blob.run(Buffer.from([0x8a,0x01,0xff]),unknown);
        expect(await observeAntigravitySessionStart({...ctx,input:{conversationId:unknown,workspacePaths:['/p']}})).toBeNull();
        expect(latestAntigravityWakeTarget(ctx)).toBeNull();
        blob.run(Buffer.concat([fixtureSummary(unknown,'p'),Buffer.from([0x22,0x24]),Buffer.from('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')]),unknown);
        expect(readAntigravityWakeTarget({...ctx,threadId:unknown})).toBeNull();
        blob.run(Buffer.concat([fixtureSummary(unknown,'p'),Buffer.from([0x20,0x01])]),unknown);
        expect(readAntigravityWakeTarget({...ctx,threadId:unknown})).toBeNull();
        blob.run(Buffer.alloc(0),unknown);
        expect(readAntigravityWakeTarget({...ctx,threadId:unknown})).toBeNull();
        const duplicateMetadata = protobuf.Writer.create().uint32(50).string(unknown)
            .uint32(146).string('p').uint32(146).string('p').finish();
        blob.run(Buffer.from(protobuf.Writer.create().uint32(34).string(unknown)
            .uint32(138).bytes(duplicateMetadata).finish()),unknown);
        expect(readAntigravityWakeTarget({...ctx,threadId:unknown})).toBeNull();
        blob.run(Buffer.from(protobuf.Writer.create().uint32(34).string(unknown)
            .uint32(138).bytes(protobuf.Writer.create().uint32(146).string('p').finish()).finish()),unknown);
        expect(readAntigravityWakeTarget({...ctx,threadId:unknown})).toBeNull();
        blob.run(fixtureSummary(unknown,'p'),unknown);
        expect((await observeAntigravitySessionStart({...ctx,input:{conversationId:unknown,workspacePaths:['/p']}}))?.threadId).toBe(unknown);
        expect(latestAntigravityWakeTarget(ctx)?.threadId).toBe(unknown);
    } finally {db.close();fs.rmSync(root,{recursive:true,force:true})}
});

test('an authenticated spent marker requests only a negative claim when root observation is unavailable', async () => {
    const root     = fs.mkdtempSync(path.join(os.tmpdir(),'agy-negative-'));
    const threadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nonce = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const context  = {databasePath:path.join(root,'missing.db'),projectId:'p',projectRoot:'/project',generation:'10:epoch',statePath:path.join(root,'seat')};
    const input    = {conversationId:threadId,workspacePaths:['/project'],invocationNum:0,lastUserInput:`[NEO_WAKE_V1:${nonce}] [WAKE]`};
    const requests = [];
    try {
        const consume = async request => {requests.push(request);return {admitted:false}};
        const denied  = await handleAntigravityPreInvocation({...context,input,consume});
        expect(denied.terminationBehavior).toBe('terminate');
        expect(requests).toEqual([{threadId,nonce,denyOnly:true}]);
        requests.length=0;
        await handleAntigravityPreInvocation({...context,input:{...input,workspacePaths:['/wrong']},consume});
        await handleAntigravityPreInvocation({...context,input:{...input,conversationId:'invalid'},consume});
        await handleAntigravityPreInvocation({...context,input:{...input,lastUserInput:'ordinary'},consume});
        expect(requests).toEqual([]);
    } finally {fs.rmSync(root,{recursive:true,force:true})}
});

test('sidecar accepts only canonical loopback endpoints without altering the environment', async () => {
    const exe     = '/a/Antigravity.app/Contents/Resources/bin/language_server';
    const env     = address=>({ANTIGRAVITY_LS_ADDRESS:address,ANTIGRAVITY_AGENTAPI_EXE:exe,fixtureSecret:'sentinel'});
    const valid   = ['127.0.0.1:1','localhost:65535','[::1]:4444','http://localhost:8080','https://[::1]:443/'];
    const invalid = ['127.0.0.1:0','localhost:65536','localhost:01','localhost:123/','localhost:123/path',
        'https://localhost:443/path','https://user@localhost:123','http://localhost:123/#fragment',
        '0.0.0.0:123','127.0.0.2:123','example.com:123','localhost:123?x=1','http://localhost'];
    for (const address of valid) expect(validateAntigravitySidecarCapability({environment:env(address),appBundle:'/a/Antigravity.app',realpath:x=>x}),address).toBe(true);
    for (const address of invalid) expect(validateAntigravitySidecarCapability({environment:env(address),appBundle:'/a/Antigravity.app',realpath:x=>x}),address).toBe(false);
    const supplied = env('127.0.0.1:123'),controller=new AbortController(); let received;
    const rows     = [{pid:1,ppid:0,command:'/a/Antigravity.app/Contents/MacOS/Antigravity --user-data-dir=/profile',startedAt:'epoch'},
        {pid:2,ppid:1,command:'/a/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper worker',startedAt:'epoch'},
        {pid:3,ppid:2,command:'sidecar',startedAt:'epoch'}];
    await runAntigravitySidecar({stateDir:'/state',manifestPath:'/manifest',sidecarPid:3,readRows:()=>rows,
        environment:supplied,signal:controller.signal,validateCapability:args=>validateAntigravitySidecarCapability({...args,realpath:x=>x}),
        dispatch:async args=>{received=args;controller.abort()}});
    expect(received.environment).toBe(supplied);
    expect(received.appPid).toBe(1);
});

test('sidecar startup classifies ancestor and capability failures without values', async () => {
    const rows = [{pid:1,ppid:0,command:'/a/Antigravity.app/Contents/MacOS/Antigravity --user-data-dir=/profile',startedAt:'epoch'}];
    await expect(runAntigravitySidecar({stateDir:'/state',manifestPath:'/manifest',sidecarPid:9,readRows:()=>rows,dispatch:async()=>{}})).rejects.toMatchObject({code:'AGY_ANCESTOR_UNAVAILABLE'});
    await expect(runAntigravitySidecar({stateDir:'/state',manifestPath:'/manifest',sidecarPid:1,readRows:()=>rows,environment:{},dispatch:async()=>{}})).rejects.toMatchObject({code:'AGY_CAPABILITY_UNAVAILABLE'});
});

test('wake correlation survives truncated steps and internal Plan Mode/task envelopes, and settles finished unacknowledged turns', () => {
    const root     = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-planmode-'));
    const threadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nonce = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        token      = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', marker = `[NEO_WAKE_V1:${nonce}] [WAKE]`;
    const dir = path.join(root, 'brain', threadId, '.system_generated', 'logs');
    fs.mkdirSync(dir, {recursive:true});
    const file    = path.join(dir, 'transcript.jsonl'), row = x => JSON.stringify(x) + '\n';
    const sysEnv  = (sender, body) => `The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-18T21:25:03Z sender=${sender} priority=MESSAGE_PRIORITY_HIGH content=${body}\n</SYSTEM_MESSAGE>`;
    const planEnv = body => `The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n${body}\n</SYSTEM_MESSAGE>`;
    try {
        fs.writeFileSync(file, '');
        const cursor = captureAntigravityWakeCursor({appDataDir:root, threadId});
        const wake   = {type:'SYSTEM_MESSAGE', source:'SYSTEM', status:'DONE', step_index:10, content:sysEnv('system', marker)};
        const trunc  = {type:'GENERIC', source:'MODEL', status:'DONE', step_index:11, truncated_fields:['content'], content:'x'.repeat(4000)};
        const pDue   = {type:'SYSTEM_MESSAGE', source:'SYSTEM', status:'DONE', step_index:12, truncated_fields:['content'], content:planEnv('[plan review due] ...')};
        const pOn    = {type:'SYSTEM_MESSAGE', source:'SYSTEM', status:'DONE', step_index:13, truncated_fields:['content'], content:planEnv('[plan review] Plan mode is on...')};
        const pOff   = {type:'SYSTEM_MESSAGE', source:'SYSTEM', status:'DONE', step_index:14, content:planEnv('Plan mode is off: execution turn')};
        const task   = {type:'SYSTEM_MESSAGE', source:'SYSTEM', status:'DONE', step_index:15, content:sysEnv(`${threadId}/task-1`, 'done')};
        const call   = {type:'PLANNER_RESPONSE', source:'MODEL', status:'DONE', step_index:16, truncated_fields:['tool_calls'], tool_calls:[{name:'run_command'}], content:''};

        expect(isAntigravityExternalSystemMessage(wake)).toBe(true);
        expect(isAntigravityExternalSystemMessage(pOff)).toBe(false);
        expect(isAntigravityExternalSystemMessage(task)).toBe(false);

        fs.appendFileSync(file, row(wake) + row(trunc) + row(pDue) + row(pOn) + row(pOff) + row(task) + row(call));
        expect(hasAntigravityPendingSystemWake({appDataDir:root, threadId, text:marker, cursor})).toBe(true);
        expect(readAntigravityWakeReceipt({appDataDir:root, threadId, text:marker, cursor, receiptToken:token, targetStatus:'CASCADE_RUN_STATUS_IDLE', settleUnacknowledged:true}).outcome).toBe('unknown');

        fs.appendFileSync(file, row({type:'PLANNER_RESPONSE', source:'MODEL', status:'DONE', step_index:17, content:`Done.\n[NEO_WAKE_RECEIVED:${token}]`}));
        expect(readAntigravityWakeReceipt({appDataDir:root, threadId, text:marker, cursor, receiptToken:token}).outcome).toBe('observed');

        // Without the model echo, a finished IDLE turn (or an external/human supersession) settles as turn-unacknowledged.
        fs.truncateSync(file, 0);
        const freshCursor = captureAntigravityWakeCursor({appDataDir:root, threadId});
        fs.appendFileSync(file, row(wake) + row(trunc) + row(pOff) + row({type:'PLANNER_RESPONSE', source:'MODEL', status:'DONE', step_index:18, content:'Forgot ack'}));
        expect(readAntigravityWakeReceipt({appDataDir:root, threadId, text:marker, cursor:freshCursor, receiptToken:token, targetStatus:'CASCADE_RUN_STATUS_RUNNING', settleUnacknowledged:true}).outcome).toBe('unknown');
        expect(readAntigravityWakeReceipt({appDataDir:root, threadId, text:marker, cursor:freshCursor, targetStatus:'CASCADE_RUN_STATUS_IDLE', settleUnacknowledged:true}).outcome).toBe('turn-unacknowledged');

        const extMsg = {type:'SYSTEM_MESSAGE', source:'SYSTEM', status:'DONE', step_index:19, content:sysEnv('system', 'unrelated external notice')};
        fs.appendFileSync(file, row(extMsg));
        expect(hasAntigravityPendingSystemWake({appDataDir:root, threadId, text:marker, cursor:freshCursor})).toBe(false);
        expect(readAntigravityWakeReceipt({appDataDir:root, threadId, text:marker, cursor:freshCursor, targetStatus:'CASCADE_RUN_STATUS_RUNNING', settleUnacknowledged:true}).outcome).toBe('turn-unacknowledged');
    } finally { fs.rmSync(root, {recursive:true, force:true}) }
});

for (const order of [
    'census-metadata-start-preinvocation',
    'launch-metadata-start-preinvocation-premanifest-census-repeat',
    'census-start-metadata-preinvocation',
    'census-start-preinvocation-metadata-reconcile',
    'census-metadata-preinvocation-start'
]) {
    test(`first main chat selects, witnesses and redeems signed wake once under order: ${order}`, async () => {
        const root        = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-order-')));
        const home        = path.join(root, 'profile'), data = path.join(root, 'data'), stateDir = path.join(root, 'state');
        const projectRoot = path.join(root, 'project'), appBundle = path.join(root, 'gen', 'Antigravity.app');
        const oldRoot     = '11111111-1111-4111-8111-111111111111';
        const mainRoot    = '22222222-2222-4222-8222-222222222222';
        const launchId    = '33333333-3333-4333-8333-333333333333';
        const pid         = process.pid;
        const procOut     = execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=,command='], {
            encoding: 'utf8', env: {LC_ALL: 'C', TZ: 'UTC'}
        }).trim();
        const startedAt  = procOut.match(/^(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+/)[1].replace(/\s+/g, ' ');
        const generation = `${pid}:${startedAt}`;
        const baselineMs = Date.parse(startedAt + ' UTC') + 500;
        const createdMs  = baselineMs + 1500;
        const statePath  = path.join(stateDir, 'primary-sessions', 'neo-test.json');
        const manifest   = path.join(root, 'routes.json');
        for (const dir of [home, data, stateDir, projectRoot, path.dirname(statePath)]) fs.mkdirSync(dir, {recursive: true, mode: 0o700});
        const databasePath = path.join(data, 'conversation_summaries.db'), db = new Database(databasePath);
        try {
            db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, project_id TEXT, parent_conversation_id TEXT, nesting_depth INTEGER, killed INTEGER, source TEXT, status TEXT)');
            prepareFixtureDb(db);
            insertFixture(db, oldRoot, 'p', '', 0, 0, '', 'CASCADE_RUN_STATUS_IDLE', baselineMs - 60_000);

            fs.writeFileSync(manifest, JSON.stringify({schemaVersion: 1, routes: {}}), {mode: 0o600});
            const receiverState = new WakeReceiverState({stateDir});
            await receiverState.init();
            await enrollNativeWake({manifestPath: manifest, stateDir, agentId: 'neo-test', family: 'antigravity'});

            fs.writeFileSync(path.join(home, '.neo-fleet-seat-lease.json'), JSON.stringify({
                pid, pidStartedAt: startedAt, agentId: 'neo-test', harnessType: 'antigravity', cwd: projectRoot, harnessGenerationId: 'gen'
            }), {mode: 0o600});
            fs.writeFileSync(path.join(home, '.neo-fleet-project-binding.json'), JSON.stringify({
                version: 1, projectId: 'p', projectName: 'neo-test', projectRoot
            }), {mode: 0o600});

            const route = {
                agentIdentity        : '@neo-test',
                admits               : 'wake/digest',
                harnessTargetMetadata: {adapter: 'primary-session'},
                adapterConfig        : {primarySession: {family: 'antigravity', agentId: 'neo-test', instanceHome: home, appBundle, projectId: 'p', projectRoot}}
            };
            const publishManifest = () => fs.writeFileSync(manifest, JSON.stringify({schemaVersion: 1, routes: {'WAKE_SUB:test': route}}), {mode: 0o600});
            const rows            = [
                {pid, ppid: 1, startedAt, command: `${appBundle}/Contents/MacOS/Antigravity --user-data-dir=${home}`},
                {pid: pid + 100000, ppid: pid, startedAt, command: 'hook'}
            ];
            const hookBase = {
                manifestPath: manifest, stateDir, appDataDir: data, sidecarPid: pid + 100000, readRows: () => rows,
                consume     : req => consumeNativeWakePrompt({
                    ...req, inspectResident: async () => ({pid, startedAt, generation, workspaceRoot: projectRoot})
                })
            };
            const logsDir = path.join(data, 'brain', mainRoot, '.system_generated', 'logs');
            fs.mkdirSync(logsDir, {recursive: true});
            const transcript = path.join(logsDir, 'transcript.jsonl');
            fs.writeFileSync(transcript, JSON.stringify({
                step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE',
                created_at: new Date(createdMs).toISOString().replace(/\.\d{3}Z$/, 'Z'), content: 'hello'
            }) + '\n');

            const insertMain = () => insertFixture(db, mainRoot, 'p', '', 0, 0, '', 'CASCADE_RUN_STATUS_IDLE', createdMs);
            const fireStart  = () => handleAntigravityWakeHook({...hookBase, event: 'SessionStart', input: {conversationId: mainRoot, workspacePaths: [projectRoot]}});
            const firePre    = (invocationNum = 0) => handleAntigravityWakeHook({...hookBase, event: 'PreInvocation', input: {conversationId: mainRoot, workspacePaths: [projectRoot], invocationNum, lastUserInput: 'hello'}});
            const runCensus  = () => initializeAntigravityStarts({databasePath, appDataDir: data, projectId: 'p', generation, statePath, stateDir, agentId: 'neo-test', baselineAtMs: baselineMs});

            if (order === 'census-metadata-start-preinvocation') {
                publishManifest();
                await runCensus();
                insertMain();
                await fireStart();
                await firePre();
            } else if (order === 'launch-metadata-start-preinvocation-premanifest-census-repeat') {
                await stageAntigravityLaunchCensus({
                    stateDir, databasePath, appDataDir: data, launchId, agentId: 'neo-test',
                    instanceHome: home, projectId: 'p', projectRoot, authorized: true, baselineAtMs: baselineMs
                });
                insertMain();
                // Callbacks arrive before manifest publication!
                await fireStart();
                await firePre(0);
                await bindAntigravityLaunchGeneration({
                    stateDir, agentId: 'neo-test', launchId, instanceHome: home, projectId: 'p', projectRoot, generation
                });
                publishManifest();
                await runCensus();
                // Repeated ordinary invocation/start for that same chat stays idempotent at sequence 1.
                await fireStart();
                await firePre(1);
            } else if (order === 'census-start-metadata-preinvocation') {
                publishManifest();
                await runCensus();
                await fireStart();
                expect(latestAntigravityWakeTarget({databasePath, projectId: 'p', generation, statePath})).toBeNull();
                insertMain();
                await firePre();
            } else if (order === 'census-start-preinvocation-metadata-reconcile') {
                publishManifest();
                await runCensus();
                await fireStart();
                await firePre();
                expect(latestAntigravityWakeTarget({databasePath, projectId: 'p', generation, statePath})).toBeNull();
                insertMain();
                await runCensus();
            } else if (order === 'census-metadata-preinvocation-start') {
                publishManifest();
                await runCensus();
                insertMain();
                await firePre();
                expect(latestAntigravityWakeTarget({databasePath, projectId: 'p', generation, statePath})).toBeNull();
                await fireStart();
            }

            const target = latestAntigravityWakeTarget({databasePath, projectId: 'p', generation, statePath});
            expect(target).toMatchObject({threadId: mainRoot, root: true, startSequence: 1});
            expect(verifyAntigravityWakeAdmission({databasePath, appDataDir: data, projectId: 'p', threadId: mainRoot, generation, statePath}).verified).toBe(true);

            // Prove end-to-end signed event redemption & single disclosure via real receiver spool + hook.
            const envelope = {
                eventType     : 'wake/digest',
                agentIdentity : '@neo-test',
                subscriptionId: 'WAKE_SUB:test',
                payload       : {totalEvents: 1, breakdown: {sent_to_me: {count: 1, latest: {subject: 'Confidential order ' + order}}}}
            };
            const accepted = (await receiverState.accept({subscriptionId: 'WAKE_SUB:test', eventId: 'ev-' + order, envelope, route})).record;
            await stagePrimaryWake(accepted, {state: receiverState, stateDir});
            const cursor = captureAntigravityWakeCursor({appDataDir: data, threadId: mainRoot});
            const nonce  = '44444444-4444-4444-8444-444444444444';
            fs.writeFileSync(statePath, JSON.stringify({
                version : 1,
                binding : {seat: '@neo-test', family: 'antigravity', threadId: mainRoot, generation},
                inflight: {recordKey: accepted.recordKey, nonce, status: 'unknown'}
            }), {mode: 0o600});
            fs.writeFileSync(statePath + '.cursor.json', JSON.stringify({nonce, cursor}), {mode: 0o600});
            const marker  = `[NEO_WAKE_V1:${nonce}] [WAKE]`;
            const sysBody = `The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-19T20:00:00Z sender=system priority=MESSAGE_PRIORITY_HIGH content=${marker}\n</SYSTEM_MESSAGE>`;
            fs.appendFileSync(transcript, JSON.stringify({type: 'SYSTEM_MESSAGE', source: 'SYSTEM', status: 'DONE', step_index: 1, content: sysBody}) + '\n');

            const redeemed = await handleAntigravityWakeHook({
                ...hookBase, event: 'PreInvocation',
                input: {conversationId: mainRoot, workspacePaths: [projectRoot], invocationNum: 0, lastUserInput: 'continue'}
            });
            expect(redeemed.injectSteps[0].systemMessage.systemMessage).toContain('Confidential order ' + order);

            // A duplicate invocation cannot disclose twice.
            const duplicate = await handleAntigravityWakeHook({
                ...hookBase, event: 'PreInvocation',
                input: {conversationId: mainRoot, workspacePaths: [projectRoot], invocationNum: 0, lastUserInput: marker}
            });
            expect(duplicate.terminationBehavior).toBe('terminate');
        } finally {
            db.close();
            fs.rmSync(root, {recursive: true, force: true});
        }
    });
}

test('fences historical resume, post-census restore/import, untrusted pre-census callbacks, multiple unordered roots, stale birth, fork, helper, cancellation and newer main handoff', async () => {
    const root        = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fences-')));
    const home        = path.join(root, 'profile'), data = path.join(root, 'data'), stateDir = path.join(root, 'state');
    const projectRoot = path.join(root, 'project'), appBundle = path.join(root, 'gen', 'Antigravity.app');
    const oldRoot     = '11111111-1111-4111-8111-111111111111';
    const preCensusId = '22222222-2222-4222-8222-222222222222';
    const restored1   = '33333333-3333-4333-8333-333333333333';
    const restored2   = '44444444-4444-4444-8444-444444444444';
    const unattested  = '55555555-5555-4555-8555-555555555555';
    const main1       = '66666666-6666-4666-8666-666666666666';
    const helperLate  = '77777777-7777-4777-8777-777777777777';
    const forkId      = '88888888-8888-4888-8888-888888888888';
    const main2       = '99999999-9999-4999-8999-999999999999';
    const unorderedA  = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const unorderedB  = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const statePath   = path.join(stateDir, 'primary-sessions', 'neo-test.json');
    const manifest    = path.join(root, 'routes.json');
    for (const dir of [home, data, stateDir, projectRoot, path.dirname(statePath)]) fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const databasePath = path.join(data, 'conversation_summaries.db'), db = new Database(databasePath);
    const generation   = '77:Thu Nov 19 18:49:13 2026';
    const baselineMs   = Date.parse('Thu Nov 19 18:49:13 2026 UTC') + 1000;
    try {
        db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, project_id TEXT, parent_conversation_id TEXT, nesting_depth INTEGER, killed INTEGER, source TEXT, status TEXT)');
        prepareFixtureDb(db);
        insertFixture(db, oldRoot, 'p', '', 0, 0, '', 'CASCADE_RUN_STATUS_IDLE', baselineMs - 120_000);
        insertFixture(db, preCensusId, 'p', '', 0, 0, '', 'CASCADE_RUN_STATUS_IDLE', baselineMs - 30_000);

        fs.writeFileSync(manifest, JSON.stringify({schemaVersion: 1, routes: {}}), {mode: 0o600});
        fs.writeFileSync(path.join(home, '.neo-fleet-seat-lease.json'), JSON.stringify({
            pid: 77, pidStartedAt: 'Thu Nov 19 18:49:13 2026', agentId: 'neo-test', harnessType: 'antigravity', cwd: projectRoot, harnessGenerationId: 'gen'
        }), {mode: 0o600});
        fs.writeFileSync(path.join(home, '.neo-fleet-project-binding.json'), JSON.stringify({
            version: 1, projectId: 'p', projectName: 'neo-test', projectRoot
        }), {mode: 0o600});
        const rows = [
            {pid: 77, ppid: 1, startedAt: 'Thu Nov 19 18:49:13 2026', command: `${appBundle}/Contents/MacOS/Antigravity --user-data-dir=${home}`},
            {pid: 78, ppid: 77, startedAt: 'Thu Nov 19 18:49:13 2026', command: 'hook'}
        ];
        const hookBase = {manifestPath: manifest, stateDir, appDataDir: data, sidecarPid: 78, readRows: () => rows};

        // 1. Untrusted pre-census callback (no published route AND no staged launch census) retains nothing.
        await handleAntigravityWakeHook({...hookBase, event: 'SessionStart', input: {conversationId: preCensusId, workspacePaths: [projectRoot]}});
        await handleAntigravityWakeHook({...hookBase, event: 'PreInvocation', input: {conversationId: preCensusId, workspacePaths: [projectRoot], invocationNum: 0, lastUserInput: 'hi'}});
        expect(fs.existsSync(path.join(stateDir, 'primary-session-launches', 'neo-test.json'))).toBe(false);

        const route = {
            agentIdentity        : '@neo-test',
            admits               : 'wake/digest',
            harnessTargetMetadata: {adapter: 'primary-session'},
            adapterConfig        : {primarySession: {family: 'antigravity', agentId: 'neo-test', instanceHome: home, appBundle, projectId: 'p', projectRoot}}
        };
        fs.writeFileSync(manifest, JSON.stringify({schemaVersion: 1, routes: {'WAKE_SUB:test': route}}), {mode: 0o600});

        // Untrusted pre-census callback even WITH published route before census retains nothing.
        await handleAntigravityWakeHook({...hookBase, event: 'SessionStart', input: {conversationId: preCensusId, workspacePaths: [projectRoot]}});
        await initializeAntigravityStarts({databasePath, appDataDir: data, projectId: 'p', generation, statePath, stateDir, agentId: 'neo-test', baselineAtMs: baselineMs});
        expect(latestAntigravityWakeTarget({databasePath, projectId: 'p', generation, statePath})).toBeNull();

        // 2. Historical resume in census cannot select.
        await handleAntigravityWakeHook({...hookBase, event: 'SessionStart', input: {conversationId: oldRoot, workspacePaths: [projectRoot]}});
        await handleAntigravityWakeHook({...hookBase, event: 'PreInvocation', input: {conversationId: oldRoot, workspacePaths: [projectRoot], invocationNum: 0, lastUserInput: 'resume'}});
        expect(latestAntigravityWakeTarget({databasePath, projectId: 'p', generation, statePath})).toBeNull();

        // 3. Post-census historical restore/import (both Order 1 and deferred Order 3) + unattested deferred row stay rejected/pending.
        insertFixture(db, restored1, 'p', '', 0, 0, '', 'CASCADE_RUN_STATUS_IDLE', baselineMs - 10_000);
        await handleAntigravityWakeHook({...hookBase, event: 'SessionStart', input: {conversationId: restored1, workspacePaths: [projectRoot]}});
        await handleAntigravityWakeHook({...hookBase, event: 'PreInvocation', input: {conversationId: restored1, workspacePaths: [projectRoot], invocationNum: 0, lastUserInput: 'restored'}});
        expect(latestAntigravityWakeTarget({databasePath, projectId: 'p', generation, statePath})).toBeNull();
        db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(restored1);

        await handleAntigravityWakeHook({...hookBase, event: 'SessionStart', input: {conversationId: restored2, workspacePaths: [projectRoot]}});
        insertFixture(db, restored2, 'p', '', 0, 0, '', 'CASCADE_RUN_STATUS_IDLE', baselineMs - 5_000);
        await handleAntigravityWakeHook({...hookBase, event: 'PreInvocation', input: {conversationId: restored2, workspacePaths: [projectRoot], invocationNum: 0, lastUserInput: 'restored-late'}});
        expect(latestAntigravityWakeTarget({databasePath, projectId: 'p', generation, statePath})).toBeNull();
        db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(restored2);

        // Deferred Order 3 row lacking creation proof (createdAtMs === null and no transcript) stays pending.
        await handleAntigravityWakeHook({...hookBase, event: 'SessionStart', input: {conversationId: unattested, workspacePaths: [projectRoot]}});
        insertFixture(db, unattested, 'p', '', 0, 0, '', 'CASCADE_RUN_STATUS_IDLE', null);
        await handleAntigravityWakeHook({...hookBase, event: 'PreInvocation', input: {conversationId: unattested, workspacePaths: [projectRoot], invocationNum: 0, lastUserInput: 'unattested'}});
        expect(latestAntigravityWakeTarget({databasePath, projectId: 'p', generation, statePath})).toBeNull();
        db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(unattested);

        // 4. Genuine main1 selects & witnesses; delayed helper and fork never steal or block main1.
        await handleAntigravityWakeHook({...hookBase, event: 'SessionStart', input: {conversationId: main1, workspacePaths: [projectRoot]}});
        insertFixture(db, main1, 'p', '', 0, 0, '', 'CASCADE_RUN_STATUS_IDLE', baselineMs + 2_000);
        await handleAntigravityWakeHook({...hookBase, event: 'PreInvocation', input: {conversationId: main1, workspacePaths: [projectRoot], invocationNum: 0, lastUserInput: 'main1'}});
        expect(verifyAntigravityWakeAdmission({databasePath, appDataDir: data, projectId: 'p', threadId: main1, generation, statePath}).verified).toBe(true);

        await handleAntigravityWakeHook({...hookBase, event: 'SessionStart', input: {conversationId: helperLate, workspacePaths: [projectRoot]}});
        insertFixture(db, helperLate, 'p', main1, 1, 0, '', 'CASCADE_RUN_STATUS_IDLE', baselineMs + 3_000);
        await reconcileAntigravityStarts({databasePath, appDataDir: data, projectId: 'p', generation, statePath, stateDir, agentId: 'neo-test'});
        insertFixture(db, forkId, 'p', '', 0, 0, '', 'CASCADE_RUN_STATUS_IDLE', baselineMs + 3_500, main1);
        await handleAntigravityWakeHook({...hookBase, event: 'SessionStart', input: {conversationId: forkId, workspacePaths: [projectRoot]}});
        expect(latestAntigravityWakeTarget({databasePath, projectId: 'p', generation, statePath})?.threadId).toBe(main1);

        // 5. Newer genuine main2 immediately fences main1, does not inherit main1's witness before PreInvocation(main2), and advances sequence to 2.
        insertFixture(db, main2, 'p', '', 0, 0, '', 'CASCADE_RUN_STATUS_IDLE', baselineMs + 5_000);
        expect(latestAntigravityWakeTarget({databasePath, projectId: 'p', generation, statePath})).toBeNull();
        expect(verifyAntigravityWakeAdmission({databasePath, appDataDir: data, projectId: 'p', threadId: main1, generation, statePath}).verified).toBe(false);
        await handleAntigravityWakeHook({...hookBase, event: 'SessionStart', input: {conversationId: main2, workspacePaths: [projectRoot]}});
        expect(latestAntigravityWakeTarget({databasePath, projectId: 'p', generation, statePath})).toMatchObject({threadId: main2, startSequence: 2});
        expect(verifyAntigravityWakeAdmission({databasePath, appDataDir: data, projectId: 'p', threadId: main2, generation, statePath}).verified).toBe(false);
        await handleAntigravityWakeHook({...hookBase, event: 'PreInvocation', input: {conversationId: main2, workspacePaths: [projectRoot], invocationNum: 0, lastUserInput: 'main2'}});
        expect(verifyAntigravityWakeAdmission({databasePath, appDataDir: data, projectId: 'p', threadId: main2, generation, statePath}).verified).toBe(true);

        // 6. Multiple unordered roots fence selection and stay pending.
        insertFixture(db, unorderedA, 'p', '', 0, 0, '', 'CASCADE_RUN_STATUS_IDLE', baselineMs + 8_000);
        insertFixture(db, unorderedB, 'p', '', 0, 0, '', 'CASCADE_RUN_STATUS_IDLE', baselineMs + 8_500);
        await handleAntigravityWakeHook({...hookBase, event: 'SessionStart', input: {conversationId: unorderedA, workspacePaths: [projectRoot]}});
        await handleAntigravityWakeHook({...hookBase, event: 'PreInvocation', input: {conversationId: unorderedA, workspacePaths: [projectRoot], invocationNum: 0, lastUserInput: 'a'}});
        expect(latestAntigravityWakeTarget({databasePath, projectId: 'p', generation, statePath})).toBeNull();
        expect(verifyAntigravityWakeAdmission({databasePath, appDataDir: data, projectId: 'p', threadId: unorderedA, generation, statePath}).verified).toBe(false);

        // 7. Stale PID/birth and canceled Start cleanup withdraw launch baselines cleanly.
        const cancelLaunchId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
        await stageAntigravityLaunchCensus({
            stateDir, databasePath, appDataDir: data, launchId: cancelLaunchId, agentId: 'neo-test',
            instanceHome: home, projectId: 'p', projectRoot, authorized: true, baselineAtMs: baselineMs + 10_000
        });
        await expect(bindAntigravityLaunchGeneration({
            stateDir, agentId: 'neo-test', launchId: cancelLaunchId, instanceHome: home, projectId: 'p', projectRoot: '/wrong', generation
        })).rejects.toThrow();
        await stageAntigravityLaunchCensus({
            stateDir, databasePath, appDataDir: data, launchId: cancelLaunchId, agentId: 'neo-test',
            instanceHome: home, projectId: 'p', projectRoot, authorized: true, baselineAtMs: baselineMs + 10_000
        });
        await cleanupAntigravityLaunchCensus({stateDir, agentId: 'neo-test', launchId: cancelLaunchId});
        expect(fs.existsSync(path.join(stateDir, 'primary-session-launches', 'neo-test.json'))).toBe(false);
    } finally {
        db.close();
        fs.rmSync(root, {recursive: true, force: true});
    }
});

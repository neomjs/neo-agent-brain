import {test, expect}                                                  from '@playwright/test';
import fs                                                              from 'node:fs/promises';
import os                                                              from 'node:os';
import path                                                            from 'node:path';
import {execFileSync}                                                  from 'node:child_process';
import {prepareFleetNativeWake, resolveCodexWakeRuntime}               from '../../../../../../ai/services/fleet/prepareFleetNativeWake.mjs';
import {materializeAntigravitySidecar,materializeAntigravityWakeHooks} from '../../../../../../ai/daemons/wake/antigravityWakeSidecar.mjs';
import {readRuntimeGenerationRecord, runtimeGenerationPin}             from '../../../../../../ai/services/fleet/runtimeGeneration.mjs';
import {sealRuntimeGeneration, removeSealed, changePayloadBytes}       from './fixtures/sealedRuntimeGeneration.mjs';
import {readCodexWakeArtifact}                                         from '../../../../../../ai/services/fleet/readCodexWakeArtifact.mjs';

test.describe('Fleet native wake preparation', () => {
    let root, instanceHome, workspaceRoot, stateDir, configDir, manifestPath;
    test.beforeEach(async () => {
        root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neo-native-prepare-')));
        [instanceHome, workspaceRoot, stateDir, configDir] = ['instance', 'workspace', 'state', 'config'].map(name => path.join(root, name));
        await Promise.all([instanceHome, workspaceRoot, stateDir, configDir, path.join(instanceHome, 'codex-home')].map(dir => fs.mkdir(dir, {recursive:true})));
        await fs.chmod(stateDir,0o700);
        execFileSync('git',['init','-q',workspaceRoot]);
        manifestPath = path.join(root, 'routes.json');
        await fs.writeFile(manifestPath, '{}')
    });
    test.afterEach(async () => fs.rm(root, {recursive:true, force:true}));

    test('a package-only Start keeps its hook, a changed consumer selects a new hook, and rollback selects the old one', async () => {
        const generations = path.join(root,'generations');
        await fs.mkdir(generations);
        const agent = {id:'fixture',harnessType:'codex-desktop'}, options = {agent,instanceHome,workspaceRoot,manifestPath,stateDir};
        const home  = path.join(instanceHome,'codex-home'), hooks = path.join(home,'hooks.json'), trust = path.join(home,'config.toml');
        await fs.writeFile(trust, 'trusted_hash = "prior"\n');
        const assertStart = async retained => {
            const generation = await readRuntimeGenerationRecord({directory:retained.directory});
            const selected   = await readCodexWakeArtifact(generation);
            expect((await prepareFleetNativeWake({...options,...selected})).state).toBe('prepared');
            const arm = await resolveCodexWakeRuntime({...options,agentId:agent.id,enrolled:true,runtime:{...runtimeGenerationPin(generation),pin:'held'}});
            expect(arm).toEqual(selected);
            return fs.readFile(hooks,'utf8')
        };
        try {
            const a      = await sealRuntimeGeneration(generations,{revision:'a',artifactConsumer:'consumer 1'});
            const b      = await sealRuntimeGeneration(generations,{revision:'b',artifactConsumer:'consumer 1'});
            const c      = await sealRuntimeGeneration(generations,{revision:'c',artifactConsumer:'consumer 2'});
            const unheld = {...runtimeGenerationPin(await readRuntimeGenerationRecord({directory:a.directory})),pin:'unknown'};
            await expect(resolveCodexWakeRuntime({...options,agentId:agent.id,enrolled:false,runtime:unheld})).rejects.toThrow('not retained');
            await expect(fs.stat(hooks)).rejects.toMatchObject({code:'ENOENT'});
            const before = await assertStart(a);
            expect(await assertStart(b)).toBe(before);
            expect(await assertStart(c)).not.toBe(before);
            expect(await assertStart(a)).toBe(before);
            expect(await fs.readFile(trust,'utf8')).toBe('trusted_hash = "prior"\n')
        } finally { await removeSealed(generations) }
    });

    test('withdrawn custody, escaping storage and same-length transitive tamper cannot reuse the Start proof', async () => {
        const generations = path.join(root,'generations');
        await fs.mkdir(generations);
        try {
            const sealed     = await sealRuntimeGeneration(generations,{revision:'a',artifactConsumer:'consumer 1'});
            const generation = await readRuntimeGenerationRecord({directory:sealed.directory});
            let unchanged;
            const pair = await readCodexWakeArtifact(generation, check => { unchanged = check });
            expect(await unchanged()).toBe(true);
            const consumer = path.join(path.dirname(pair.hookModulePath),'fleetPrimarySessionWake.mjs');
            const prior    = await fs.stat(consumer);
            await fs.chmod(consumer,0o644);
            await fs.writeFile(consumer,'consumer 2');
            await fs.utimes(consumer,prior.atime,prior.mtime);
            await fs.chmod(consumer,prior.mode & 0o777);
            expect(await unchanged()).toBe(false);
            await expect(readCodexWakeArtifact(generation)).rejects.toThrow();
            await fs.chmod(consumer,0o644);
            await fs.writeFile(consumer,'consumer 1');
            await fs.chmod(consumer,prior.mode & 0o777);
            expect(await readCodexWakeArtifact(generation)).toEqual(pair);
            const moved = path.join(path.dirname(sealed.artifactRoot),'moved');
            await fs.rename(sealed.artifactRoot,moved);
            await expect(readCodexWakeArtifact(generation)).rejects.toThrow();
            await fs.symlink(moved,sealed.artifactRoot);
            await expect(readCodexWakeArtifact(generation)).rejects.toThrow()
        } finally { await removeSealed(generations) }
    });

    test('an unsealed retained runtime cannot bind an outside executable', async () => {
        const
            runtimeRoot = path.join(root, 'forged', 'organism'),
            wakeDir     = path.join(runtimeRoot, 'ai', 'daemons', 'wake');

        await fs.mkdir(wakeDir, {recursive: true});
        await fs.writeFile(path.join(wakeDir, 'codexWakeHook.mjs'), '// fixture');
        await fs.writeFile(path.join(wakeDir, 'codexWakeProtocol.json'), JSON.stringify({wire: 'neo-codex-primary-wake-v1'}));

        const runtime = {
            id        : 'a'.repeat(64), directory: path.join(root, 'forged'), runtimeRoot,
            executable: process.execPath, payloadDigest: 'b'.repeat(64), pin: 'held'
        };

        await expect(resolveCodexWakeRuntime({
            agentId: 'fixture', instanceHome, workspaceRoot, manifestPath, stateDir, runtime, enrolled: true
        })).rejects.toThrow()
    });

    test('a surviving enrolled seat preserves its sealed A hook when the host uses B', async () => {
        const generations = path.join(root, 'generations');
        await fs.mkdir(generations);
        const retained = await sealRuntimeGeneration(generations, {revision: 'a', codexWake: true});

        try {
            const
                agent          = {id: 'fixture', harnessType: 'codex-desktop'},
                options        = {agent, instanceHome, workspaceRoot, manifestPath, stateDir},
                hookModulePath = path.join(retained.runtimeRoot, 'ai/daemons/wake/codexWakeHook.mjs'),
                runtime        = {...runtimeGenerationPin(await readRuntimeGenerationRecord({directory: retained.directory})), pin: 'held'},
                hookFile       = path.join(instanceHome, 'codex-home', 'hooks.json'),
                trustFile      = path.join(instanceHome, 'codex-home', 'config.toml');

            await fs.writeFile(trustFile, 'trusted_hash = "fixture-approved"\n');
            const initial = await prepareFleetNativeWake({...options, nodePath: retained.executable, hookModulePath});
            expect(initial.state).toBe('prepared');

            const before   = await fs.readFile(hookFile), trust = await fs.readFile(trustFile);
            const selected = await resolveCodexWakeRuntime({...options, agentId: agent.id, runtime, enrolled: true});

            expect(selected).toEqual({nodePath: retained.executable, hookModulePath});
            expect((await prepareFleetNativeWake({...options, ...selected})).state).toBe('prepared');
            expect(await fs.readFile(hookFile)).toEqual(before);
            expect(await fs.readFile(trustFile)).toEqual(trust);

            for (const invalid of [{...runtime, pin: 'unknown'}, {...runtime, payloadDigest: 'f'.repeat(64)}]) {
                await expect(resolveCodexWakeRuntime({
                    ...options, agentId: agent.id, runtime: invalid, enrolled: true
                })).rejects.toThrow();
                expect(await fs.readFile(hookFile)).toEqual(before)
            }

            const declaration = path.join(retained.runtimeRoot, 'ai/daemons/wake/codexWakeProtocol.json');
            await fs.chmod(declaration, 0o644);
            await fs.writeFile(declaration, JSON.stringify({wire: 'neo-codex-primary-wake-v1', tampered: true}));
            await fs.chmod(declaration, 0o444);
            await expect(resolveCodexWakeRuntime({...options, agentId: agent.id, runtime, enrolled: true})).rejects.toThrow();
            expect(await fs.readFile(hookFile)).toEqual(before)
        } finally {
            await removeSealed(retained.directory)
        }
    });

    test('a retained runtime refuses changed executable or transitive wake consumer bytes', async () => {
        const generations = path.join(root, 'generations');
        await fs.mkdir(generations);

        for (const [revision, kind] of [['a', 'executable'], ['b', 'consumer']]) {
            const retained = await sealRuntimeGeneration(generations, {revision, codexWake: true});

            try {
                const
                    runtime = {...runtimeGenerationPin(await readRuntimeGenerationRecord({directory: retained.directory})), pin: 'held'},
                    options = {agentId: 'fixture', instanceHome, workspaceRoot, manifestPath, stateDir, runtime, enrolled: true};

                expect((await resolveCodexWakeRuntime(options)).nodePath).toBe(retained.executable);
                if (kind === 'executable') {
                    await changePayloadBytes(retained)
                } else {
                    const consumer = path.join(retained.runtimeRoot, 'ai/daemons/wake/fleetPrimarySessionWake.mjs');
                    const mode     = (await fs.stat(consumer)).mode & 0o777;

                    await fs.chmod(consumer, 0o644);
                    await fs.writeFile(consumer, '// substituted consumer\n');
                    await fs.chmod(consumer, mode)
                }
                await expect(resolveCodexWakeRuntime(options), kind).rejects.toThrow()
            } finally {
                await removeSealed(retained.directory)
            }
        }
    });
    test('Codex prepares its seat hook while preserving other entries on retry', async () => {
        const file = path.join(instanceHome, 'codex-home', 'hooks.json');
        await fs.writeFile(file, JSON.stringify({foreign:true, hooks:{Stop:[{hooks:[]}]}}));
        const args = {agent:{id:'fixture', harnessType:'codex-desktop'}, instanceHome, workspaceRoot, stateDir, manifestPath};
        expect(await prepareFleetNativeWake(args)).toEqual({state:'prepared', completed:['hook']});
        expect(await prepareFleetNativeWake(args)).toEqual({state:'prepared', completed:['hook']});
        const config = JSON.parse(await fs.readFile(file, 'utf8'));
        expect(config.foreign).toBe(true);
        expect(config.hooks.Stop).toEqual([{hooks:[]}]);
        expect(config.hooks.UserPromptSubmit).toHaveLength(1)
    });

    test('Antigravity requires shared consent and preserves unrelated configuration', async () => {
        const excludeFile    = path.join(workspaceRoot,'.git','info','exclude');
        const existingBlocks = '# BEGIN fleetManagedWorkspace — generated\n/foreign-a\n# END fleetManagedWorkspace\n# BEGIN fleetSeatHooks — generated\n/foreign-b\n# END fleetSeatHooks\n';
        await fs.writeFile(excludeFile, existingBlocks);
        await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({foreign:true, sidecars:{other:{enabled:true}}}));
        const args = {agent:{id:'fixture', harnessType:'antigravity'}, instanceHome, workspaceRoot, stateDir, configDir, manifestPath};
        expect((await prepareFleetNativeWake(args)).reason).toBe('shared-config-not-authorized');
        await expect(fs.stat(path.join(workspaceRoot, '.agents'))).rejects.toMatchObject({code:'ENOENT'});
        expect(await prepareFleetNativeWake({...args, allowSharedConfig:true})).toEqual({state:'prepared', completed:['hooks','sidecar']});
        expect(await prepareFleetNativeWake({...args, allowSharedConfig:true})).toEqual({state:'prepared', completed:['hooks','sidecar']});
        const config = JSON.parse(await fs.readFile(path.join(configDir, 'config.json'), 'utf8'));
        expect(config.foreign).toBe(true);
        expect(config.sidecars.other).toEqual({enabled:true});
        const hooks = JSON.parse(await fs.readFile(path.join(workspaceRoot, '.agents', 'hooks.json'), 'utf8'));
        expect(Object.keys(hooks['neo-primary-session'])).toEqual(['SessionStart','PreInvocation'])
        expect(execFileSync('git',['-C',workspaceRoot,'check-ignore','--no-index','.agents/hooks.json'],{encoding:'utf8'}).trim()).toBe('.agents/hooks.json');
        expect(execFileSync('git',['-C',workspaceRoot,'status','--porcelain'],{encoding:'utf8'})).toBe('');
        expect(await fs.readFile(excludeFile,'utf8')).toContain(existingBlocks.trim())
    });

    test('a conflicting sidecar reports partial work and a matching retry can finish', async () => {
        const sidecar = path.join(configDir, 'sidecars', 'neo-primary-session');
        await fs.mkdir(sidecar, {recursive:true});
        await fs.writeFile(path.join(sidecar, 'sidecar.json'), '{}');
        const args   = {agent:{id:'fixture', harnessType:'antigravity'}, instanceHome, workspaceRoot, stateDir, configDir, manifestPath, allowSharedConfig:true};
        const result = await prepareFleetNativeWake(args);
        expect(result).toMatchObject({state:'refused', reason:'preparation-failed', completed:[]});
        await expect(fs.stat(path.join(workspaceRoot, '.agents'))).rejects.toMatchObject({code:'ENOENT'});
        expect(await fs.readFile(path.join(sidecar, 'sidecar.json'), 'utf8')).toBe('{}');
        await fs.rm(path.join(sidecar, 'sidecar.json'));
        expect(await prepareFleetNativeWake(args)).toEqual({state:'prepared', completed:['hooks','sidecar']})
    });

    test('a proven prior runtime is replaced; repeat preparation leaves all files untouched', async () => {
        const agent = {id:'fixture',harnessType:'antigravity'};
        const args  = {agent,instanceHome,workspaceRoot,configDir,manifestPath,stateDir,allowSharedConfig:true};
        expect(await prepareFleetNativeWake({...args,nodePath:'/usr/bin/true'})).toEqual({state:'prepared',completed:['hooks','sidecar']});
        expect(await prepareFleetNativeWake(args)).toEqual({state:'prepared',completed:['hooks','sidecar']});
        const files  = [path.join(configDir,'config.json'),path.join(configDir,'sidecars','neo-primary-session','sidecar.json'),path.join(workspaceRoot,'.agents','hooks.json')];
        const before = await Promise.all(files.map(file=>fs.stat(file)));
        expect(await prepareFleetNativeWake(args)).toEqual({state:'prepared',completed:['hooks','sidecar']});
        const after = await Promise.all(files.map(file=>fs.stat(file)));
        expect(after.map(s=>s.ino)).toEqual(before.map(s=>s.ino))
    });

    test('a recorded runtime upgrades with unrelated vendor project metadata preserved byte-for-byte', async () => {
        const args = {agent:{id:'fixture',harnessType:'antigravity'},instanceHome,workspaceRoot,configDir,manifestPath,stateDir,allowSharedConfig:true};
        expect((await prepareFleetNativeWake({...args,nodePath:'/usr/bin/true'})).state).toBe('prepared');
        const file = path.join(configDir,'config.json'), legacy={sidecars:{'neo-primary-session':{
            enabled:true,projectId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',schemaVersion:1}},foreign:{keep:true}};
        const bytes  = JSON.stringify(legacy,null,3)+'\n'; await fs.writeFile(file,bytes);await fs.chmod(file,0o640);
        const before = await fs.stat(file);
        expect((await prepareFleetNativeWake(args)).state).toBe('prepared');
        expect(await fs.readFile(file,'utf8')).toBe(bytes);
        const after = await fs.stat(file);
        expect(after.mode).toBe(before.mode);
        expect(after.ino).toBe(before.ino)
    });

    test('a symbolic-link configuration ancestor cannot redirect preparation', async () => {
        const outside = path.join(root,'outside'); await fs.mkdir(outside);
        await fs.symlink(outside,path.join(workspaceRoot,'.agents'));
        const result = await prepareFleetNativeWake({agent:{id:'fixture',harnessType:'antigravity'},instanceHome,workspaceRoot,configDir,manifestPath,stateDir,allowSharedConfig:true});
        expect(result.state).toBe('refused');
        expect(await fs.readdir(outside)).toEqual([])
    });

    test('a disabled or altered old sidecar and mismatched prior coordinates remain untouched', async () => {
        const agent = {id:'fixture',harnessType:'antigravity'};
        const args  = {agent,instanceHome,workspaceRoot,configDir,manifestPath,stateDir,allowSharedConfig:true};
        expect(await prepareFleetNativeWake({...args,nodePath:'/usr/bin/true'})).toEqual({state:'prepared',completed:['hooks','sidecar']});
        expect((await prepareFleetNativeWake({...args,previous:{nodePath:'/arbitrary'},nodePath:'/usr/bin/true'})).state).toBe('prepared');
        const configPath = path.join(configDir,'config.json'), config=JSON.parse(await fs.readFile(configPath,'utf8'));
        config.sidecars['neo-primary-session'].enabled=false;
        await fs.writeFile(configPath,JSON.stringify(config));
        const before = await fs.readFile(path.join(workspaceRoot,'.agents','hooks.json'),'utf8');
        expect((await prepareFleetNativeWake(args)).state).toBe('refused');
        expect(await fs.readFile(path.join(workspaceRoot,'.agents','hooks.json'),'utf8')).toBe(before);
        expect(JSON.parse(await fs.readFile(configPath,'utf8')).sidecars['neo-primary-session'].enabled).toBe(false)
    });

    test('seat provenance tampering refuses an update without changing either vendor file', async () => {
        const args = {agent:{id:'fixture',harnessType:'antigravity'},instanceHome,workspaceRoot,configDir,manifestPath,stateDir,allowSharedConfig:true};
        expect((await prepareFleetNativeWake({...args,nodePath:'/usr/bin/true'})).state).toBe('prepared');
        const recordPath = path.join(stateDir,'native-wake-preparation','fixture.json');
        const record     = JSON.parse(await fs.readFile(recordPath,'utf8')); record.workspaceRoot='/wrong';
        await fs.writeFile(recordPath,JSON.stringify(record));
        const files  = [path.join(workspaceRoot,'.agents','hooks.json'),path.join(configDir,'sidecars','neo-primary-session','sidecar.json')];
        const before = await Promise.all(files.map(file=>fs.readFile(file,'utf8')));
        expect((await prepareFleetNativeWake(args)).state).toBe('refused');
        expect(await Promise.all(files.map(file=>fs.readFile(file,'utf8')))).toEqual(before)
    });

    test('another seat reuses the host-owned shared sidecar without taking its project', async () => {
        const args = {agent:{id:'fixture',harnessType:'antigravity'},instanceHome,workspaceRoot,configDir,manifestPath,stateDir,allowSharedConfig:true};
        expect((await prepareFleetNativeWake({...args,nodePath:'/usr/bin/true'})).state).toBe('prepared');
        const otherHome = path.join(root,'other-home'),otherWorkspace=path.join(root,'other-workspace');
        await fs.mkdir(otherHome); await fs.mkdir(otherWorkspace);
        execFileSync('git',['init','-q',otherWorkspace]);
        const other = {...args,agent:{id:'other',harnessType:'antigravity'},instanceHome:otherHome,workspaceRoot:otherWorkspace};
        expect((await prepareFleetNativeWake(other)).state).toBe('prepared');
        expect((await prepareFleetNativeWake(args)).state).toBe('prepared')
    });

    test('a second Codex start upgrades the previously recorded runtime', async () => {
        const args = {agent:{id:'fixture',harnessType:'codex-desktop'},instanceHome,workspaceRoot,manifestPath,stateDir};
        expect((await prepareFleetNativeWake({...args,nodePath:'/usr/bin/true'})).state).toBe('prepared');
        expect(await prepareFleetNativeWake(args)).toEqual({state:'prepared',completed:['hook']});
        const data = JSON.parse(await fs.readFile(path.join(instanceHome,'codex-home','hooks.json'),'utf8'));
        expect(data.hooks.UserPromptSubmit[0].hooks[0].command).toContain(process.execPath)
    });

    test('an older unrecorded canary is not adopted as prior runtime', async () => {
        await materializeAntigravitySidecar({configDir,nodePath:'/old/node',modulePath:'/old/sidecar.mjs',manifestPath,stateDir});
        await materializeAntigravityWakeHooks({workspaceRoot,nodePath:'/old/node',hookPath:'/old/hook.mjs',manifestPath,stateDir});
        const args = {agent:{id:'fixture',harnessType:'antigravity'},instanceHome,workspaceRoot,configDir,manifestPath,stateDir,allowSharedConfig:true};
        expect((await prepareFleetNativeWake(args)).state).toBe('refused');
        await expect(fs.stat(path.join(stateDir,'native-wake-preparation','fixture.json'))).rejects.toMatchObject({code:'ENOENT'})
    });

    test('a tracked workspace hook refuses optional preparation without changing it', async () => {
        const dir = path.join(workspaceRoot,'.agents'), file=path.join(dir,'hooks.json');
        await fs.mkdir(dir); await fs.writeFile(file,'{"foreign":true}');
        execFileSync('git',['-C',workspaceRoot,'add','-f','.agents/hooks.json']);
        const result = await prepareFleetNativeWake({agent:{id:'fixture',harnessType:'antigravity'},instanceHome,workspaceRoot,configDir,manifestPath,stateDir,allowSharedConfig:true});
        expect(result).toEqual({state:'refused',reason:'workspace-hook-tracked',completed:[]});
        expect(await fs.readFile(file,'utf8')).toBe('{"foreign":true}');
        await expect(fs.stat(path.join(configDir,'config.json'))).rejects.toMatchObject({code:'ENOENT'})
    })
});

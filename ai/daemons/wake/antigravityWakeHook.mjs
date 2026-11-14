import fs                                                                                              from 'node:fs';
import os                                                                                              from 'node:os';
import path                                                                                            from 'node:path';
import {fileURLToPath}                                                                                 from 'node:url';
import {resolveAntigravitySidecarAncestor,readAntigravityProcessRows}                                  from './antigravityWakeSidecar.mjs';
import {observeAntigravitySessionStart,observeAntigravityPreInvocation,handleAntigravityPreInvocation} from './antigravitySessionWake.mjs';
import {consumeNativeWakePrompt}                                                                       from './fleetPrimarySessionWake.mjs';

/** @module ai/daemons/wake/antigravityWakeHook
 * @summary App hook callback. No registration occurs merely by importing this module.
 */
function privateJson(file) {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077)) throw new Error('Private authority unavailable');
    return JSON.parse(fs.readFileSync(file,'utf8'));
}

/** @summary Handles a native hook after positively binding its process ancestry and Fleet lease. */
export async function handleAntigravityWakeHook({event,input,manifestPath,stateDir,sidecarPid=process.pid,
    readRows=readAntigravityProcessRows,consume=consumeNativeWakePrompt,appDataDir=path.join(os.homedir(),'.gemini','antigravity')}) {
    const reserved = typeof input?.lastUserInput === 'string' && input.lastUserInput.startsWith('[NEO_WAKE_V1:');
    const deny     = {terminationBehavior:'terminate',injectSteps:[{errorMessage:{userMessage:'Wake admission refused.'}}]};
    try {
        const app = resolveAntigravitySidecarAncestor({sidecarPid,rows:readRows()});
        if (!app) return reserved ? deny : {};
        const manifest = privateJson(manifestPath);
        const routes   = Object.values(manifest.routes || {}).filter(r => {
            const c = r?.adapterConfig?.primarySession;
            return r?.harnessTargetMetadata?.adapter === 'primary-session' && c?.family === 'antigravity' &&
                c.instanceHome === app.instanceHome && c.appBundle === app.appBundle;
        });
        if (routes.length !== 1) return reserved ? deny : {};
        const route = routes[0], config=route.adapterConfig.primarySession;
        const lease = privateJson(path.join(config.instanceHome,'.neo-fleet-seat-lease.json'));
        if (lease.pid !== app.appPid || lease.pidStartedAt !== app.appStart || lease.agentId !== config.agentId ||
            lease.harnessType !== 'antigravity' || lease.cwd !== config.projectRoot ||
            path.basename(path.dirname(app.appBundle)) !== lease.harnessGenerationId ||
            !/^@[a-z0-9][a-z0-9-]*$/.test(route.agentIdentity || '')) return reserved ? deny : {};
        const generation = app.appPid+':'+app.appStart, statePath=path.join(stateDir,'primary-sessions',route.agentIdentity.slice(1)+'.json');
        const context    = {databasePath:path.join(appDataDir,'conversation_summaries.db'),projectId:config.projectId,
            projectRoot:config.projectRoot,generation,statePath,input};
        if (event === 'SessionStart') { await observeAntigravitySessionStart(context); return {} }
        if (event !== 'PreInvocation') return reserved ? deny : {};
        if (!reserved) { await observeAntigravityPreInvocation(context); return {} }
        return await handleAntigravityPreInvocation({...context,consume:({threadId,nonce}) =>
            consume({manifestPath,stateDir,agentId:config.agentId,family:'antigravity',threadId,nonce})});
    } catch { return reserved ? deny : {} }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length!==6 || args[0]!=='--event' || args[2]!=='--manifest' || args[4]!=='--state') throw new Error('Invalid hook arguments');
    let text = '', oversized=false;
    for await (const chunk of process.stdin) {
        if (!oversized) { text+=chunk; if (text.length>1024*1024) { text=''; oversized=true } }
    }
    if (oversized) { process.stdout.write('{}'); return }
    const result = await handleAntigravityWakeHook({event:args[1],manifestPath:args[3],stateDir:args[5],input:JSON.parse(text)});
    process.stdout.write(JSON.stringify(result));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(() => { process.stdout.write('{}'); });
}

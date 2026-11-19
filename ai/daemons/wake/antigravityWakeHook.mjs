import fs                                                                                                                                                                  from 'node:fs';
import os                                                                                                                                                                  from 'node:os';
import path                                                                                                                                                                from 'node:path';
import {fileURLToPath}                                                                                                                                                     from 'node:url';
import {resolveAntigravitySidecarAncestor,readAntigravityProcessRows}                                                                                                      from './antigravityWakeSidecar.mjs';
import {observeAntigravitySessionStart,observeAntigravityPreInvocation,observeAntigravityPendingLaunchHook,handleAntigravityPreInvocation,hasAntigravityPendingSystemWake} from './antigravitySessionWake.mjs';
import {readPrimarySessionWake}                                                                                                                                            from './primarySessionWake.mjs';
import {consumeNativeWakePrompt}                                                                                                                                           from './fleetPrimarySessionWake.mjs';

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
        if (routes.length > 1) return reserved ? deny : {};
        if (routes.length === 0) {
            if (reserved || (event !== 'SessionStart' && event !== 'PreInvocation')) return reserved ? deny : {};
            const lease   = privateJson(path.join(app.instanceHome, '.neo-fleet-seat-lease.json'));
            const binding = privateJson(path.join(app.instanceHome, '.neo-fleet-project-binding.json'));
            if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(lease.agentId || '') ||
                lease.pid !== app.appPid || lease.pidStartedAt !== app.appStart ||
                lease.harnessType !== 'antigravity' || !path.isAbsolute(lease.cwd || '') ||
                path.basename(path.dirname(app.appBundle)) !== lease.harnessGenerationId ||
                binding.version !== 1 || binding.projectName !== lease.agentId ||
                binding.projectRoot !== lease.cwd || typeof binding.projectId !== 'string' || !binding.projectId) {
                return {};
            }
            await observeAntigravityPendingLaunchHook({
                event,
                stateDir,
                appDataDir,
                databasePath: path.join(appDataDir, 'conversation_summaries.db'),
                agentId     : lease.agentId,
                instanceHome: app.instanceHome,
                projectId   : binding.projectId,
                projectRoot : lease.cwd,
                generation  : app.appPid + ':' + app.appStart,
                input
            });
            return {};
        }
        const route = routes[0], config=route.adapterConfig.primarySession;
        const lease = privateJson(path.join(config.instanceHome,'.neo-fleet-seat-lease.json'));
        if (lease.pid !== app.appPid || lease.pidStartedAt !== app.appStart || lease.agentId !== config.agentId ||
            lease.harnessType !== 'antigravity' || lease.cwd !== config.projectRoot ||
            path.basename(path.dirname(app.appBundle)) !== lease.harnessGenerationId ||
            !/^@[a-z0-9][a-z0-9-]*$/.test(route.agentIdentity || '')) return reserved ? deny : {};
        const generation = app.appPid+':'+app.appStart, statePath=path.join(stateDir,'primary-sessions',route.agentIdentity.slice(1)+'.json');
        const context    = {databasePath:path.join(appDataDir,'conversation_summaries.db'),appDataDir,projectId:config.projectId,
            projectRoot:config.projectRoot,generation,statePath,stateDir,agentId:config.agentId,input};
        if (event === 'SessionStart') { await observeAntigravitySessionStart(context); return {} }
        if (event !== 'PreInvocation') return reserved ? deny : {};
        let   wakeInput     = input;
        const invocationNum = input?.invocationNum === undefined ? 0 : input.invocationNum;
        if (!reserved) {
            const state = await readPrimarySessionWake({statePath});
            for (const [slotKey, cursorSuffix, claimSuffix] of [
                ['urgentInflight', '.urgent.cursor.json', '.urgent.claim.json'],
                ['inflight',       '.cursor.json',        '.claim.json']
            ]) {
                const attempt = state[slotKey], nonce = attempt?.nonce;
                if (attempt?.status === 'unknown' && state.binding?.threadId === input.conversationId &&
                    state.binding?.generation === generation && typeof nonce === 'string') {
                    try {
                        const cursor     = privateJson(statePath + cursorSuffix);
                        const marker     = '[NEO_WAKE_V1:' + nonce + '] [WAKE]';
                        let   continuing = false;
                        if (invocationNum > 0) {
                            try {
                                const claim = privateJson(statePath + claimSuffix);
                                continuing = claim.admitted === true && claim.nonce === nonce &&
                                    claim.threadId === input.conversationId && claim.generation === generation;
                            } catch { /* No admitted wake in this invocation. */ }
                        }
                        if (cursor.nonce === nonce &&
                            hasAntigravityPendingSystemWake({appDataDir,threadId:input.conversationId,text:marker,cursor:cursor.cursor})) {
                            if (continuing) return {};
                            wakeInput = {...input,lastUserInput:marker,invocationNum:0};
                            break;
                        }
                    } catch { /* Slot cursor unavailable; inspect remaining slot. */ }
                }
            }
        }
        if (wakeInput === input && !reserved) { await observeAntigravityPreInvocation(context); return {} }
        return await handleAntigravityPreInvocation({...context,input:wakeInput,consume:async ({threadId,nonce,denyOnly}) => {
            if (denyOnly) {
                // No negative claim request for an unrelated thread or an unbound nonce.
                const current       = await readPrimarySessionWake({statePath}),
                      matchesNormal = current.inflight?.status === 'unknown' && current.inflight?.nonce === nonce,
                      matchesUrgent = current.urgentInflight?.status === 'unknown' && current.urgentInflight?.nonce === nonce;
                if (current.binding?.threadId !== threadId || current.binding?.generation !== generation ||
                    (!matchesNormal && !matchesUrgent)) return {admitted:false};
            }
            return consume({manifestPath,stateDir,agentId:config.agentId,family:'antigravity',threadId,nonce,denyOnly,expectedGeneration:generation,appDataDir})
        }});
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

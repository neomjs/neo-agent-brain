/**
 * @module ai/daemons/wake/fleetPrimarySessionWake
 * @summary Delivers an accepted receiver record to the newest started main session of its live Fleet instance.
 * The signed event identifies a peer. Only the host manifest, admitted bundle and live process lease
 * supply local paths. An opt-in is scoped to one Fleet agent and one receiver state directory.
 */
import {execFile}                                                              from 'node:child_process';
import {randomUUID}                                                            from 'node:crypto';
import fs                                                                      from 'node:fs/promises';
import os                                                                      from 'node:os';
import path                                                                    from 'node:path';
import {isDeepStrictEqual, promisify}                                          from 'node:util';
import {deriveCodexHome, guiProfileDir}                                        from '../../services/fleet/deriveHarnessLaunchSpec.mjs';
import {writeFileAtomic}                                                       from '../../services/shared/atomicFileWrite.mjs';
import * as antigravity                                                        from './antigravitySessionWake.mjs';
import * as codex                                                              from './codexSessionWake.mjs';
import {formatLocalWakeDigest}                                                 from './localWakeAdapters.mjs';
import {withOutboxLock}                                                        from './outboxLock.mjs';
import {bindPrimarySession, deliverPrimarySessionWake, readPrimarySessionWake} from './primarySessionWake.mjs';
import {primaryWakeSpoolPath}                                                  from './primaryWakeSpool.mjs';
import {WakeReceiverState}                                                     from './receiverState.mjs';
import {observePrimaryWakeSelection}                                           from './primaryWakeSelection.mjs';
import {readPrivateWakeJson as readPrivate, readNativeWakeOptIn}               from './nativeWakeEnrollment.mjs';
export {enrollNativeWake, readNativeWakeOptIn}                                  from './nativeWakeEnrollment.mjs';

const exec       = promisify(execFile);
const bareFamily = new Set(['antigravity', 'codex-desktop']);
const isKey      = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const UUID       = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const pending    = reason => ({status: 'pending', reason});
const unknown    = reason => ({status: 'unknown', reason});

function absolute(value) {
    return typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && value !== path.parse(value).root
}

function statePathFor(stateDir, seat) {
    if (!absolute(stateDir) || !/^@[a-z0-9][a-z0-9-]*$/.test(seat)) throw new Error('Invalid receiver seat');
    return path.join(stateDir, 'primary-sessions', seat.slice(1) + '.json')
}

async function processAt(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const {stdout} = await exec('/bin/ps', ['-ww', '-p', String(pid), '-o', 'stat=,lstart=,command='], {
        timeout: 2000, maxBuffer: 65536, env: {LC_ALL: 'C', TZ: 'UTC'}
    });
    const match = stdout.trim().match(/^(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/);
    return match && !match[1].startsWith('Z') ? {startedAt:match[2].replace(/\s+/g, ' '),command:match[3]} : null
}

/** @summary Re-proves the instance's admitted executable, profile and PID birth time for each send. */
export async function observePrimaryWakeResident(config, inspect = processAt) {
    const {instanceHome, family, appBundle, agentId} = config;
    const lease                                      = await readPrivate(path.join(instanceHome, '.neo-fleet-seat-lease.json'));
    if (!lease || lease.agentId !== agentId || lease.harnessType !== family || !absolute(lease.cwd) ||
        !isKey(lease.harnessGenerationId) || path.basename(path.dirname(appBundle)) !== lease.harnessGenerationId) return null;
    const proc    = await inspect(lease.pid);
    const main    = path.join(appBundle, 'Contents', 'MacOS', family === 'antigravity' ? 'Antigravity' : 'ChatGPT');
    const profile = ' --user-data-dir=' + guiProfileDir(family,instanceHome);
    if (!proc || proc.startedAt !== lease.pidStartedAt || !proc.command.startsWith(main + ' ') ||
        !(proc.command.endsWith(profile) || proc.command.includes(profile + ' '))) return null;
    return {pid: lease.pid, startedAt: proc.startedAt, generation: lease.pid + ':' + proc.startedAt, workspaceRoot: lease.cwd}
}

function wakeText(nonce) {
    return '[NEO_WAKE_V1:' + nonce + '] [WAKE]'
}

/** @summary Reads the latest real main-session start with the owning harness's native metadata. */
async function latestRoot(config, live, statePath, appDataDir, codexTransport, antigravityTransport, seat, inspectResident) {
    const {family, instanceHome, projectId} = config;
    const isCodex                           = family === 'codex-desktop';
    const target                            = isCodex
        ? (await codexTransport.listCodexWakeTargets({home:deriveCodexHome({harnessType:family,instanceHome}),workspaceRoot:live.workspaceRoot}))[0]
        : await antigravityTransport.latestAntigravityWakeTarget({instanceHome,appDataDir,databasePath:path.join(appDataDir,'conversation_summaries.db'),
            projectId,projectRoot:live.workspaceRoot,generation:live.generation,statePath});
    if (target?.root !== true) return null;
    const observation = await observePrimaryWakeSelection({
        selectionPath:statePath + '.selection.json',seat,family,generation:live.generation,threadId:target.threadId,
        order:isCodex ? target.startedAt : target.startSequence,
        proof:{verified:true,kind:isCodex ? 'codex-start' : 'antigravity-sequence'},
        verifyGeneration:async () => (await inspectResident(config))?.generation === live.generation
    });
    return observation.status === 'accepted' ? target : null
}

/**
 * @summary Redeems a wake inside its recipient hook. Native transports carry only an opaque nonce.
 * The admission checks the current signed route, current process lifetime, outstanding intent and
 * newest main session before revealing any mailbox data. A refusing old owner leaves the event
 * available for its successor. The private claim is also required alongside the native turn receipt.
 */
export async function consumeNativeWakePrompt({manifestPath,stateDir,agentId,family,threadId,nonce,turnId,
    inspectResident = observePrimaryWakeResident,codexTransport = codex,antigravityTransport = antigravity,
    appDataDir = path.join(os.homedir(),'.gemini','antigravity')}) {
    const denied = {admitted:false};
    if (!UUID.test(nonce ?? '') || !UUID.test(threadId ?? '')) return denied;
    const enrollment = await readNativeWakeOptIn({manifestPath,agentId,family});
    if (!enrollment || enrollment.stateDir !== stateDir) return denied;
    const manifest = await readPrivate(manifestPath);
    const routes   = Object.entries(manifest?.routes ?? {}).filter(([,route]) =>
        route?.harnessTargetMetadata?.adapter === 'primary-session' &&
        route.adapterConfig?.primarySession?.agentId === agentId && route.adapterConfig.primarySession.family === family);
    if (routes.length !== 1) return denied;
    const [subscriptionId,route] = routes[0], config = route.adapterConfig.primarySession;
    const statePath              = statePathFor(stateDir,route.agentIdentity);
    return withOutboxLock(statePath, async () => {
        const {binding,inflight} = await readPrimarySessionWake({statePath});
        if (inflight?.status !== 'unknown' || inflight.nonce !== nonce || binding?.threadId !== threadId ||
            binding.seat !== route.agentIdentity || binding.family !== family) return denied;
        const state = new WakeReceiverState({stateDir}), record = await state.read(inflight.recordKey);
        if (record.subscriptionId !== subscriptionId || record.envelope?.agentIdentity !== binding.seat ||
            !['pending','dispatching'].includes(record.state) || record.envelope.eventType !== 'wake/digest') return denied;
        const claimPath = statePath + '.claim.json';
        const previous  = await readPrivate(claimPath);
        if (previous?.nonce === nonce) return denied;
        const live = await Promise.resolve().then(() => inspectResident(config)).catch(() => null);
        if (!live || live.generation !== binding.generation) return denied;
        const selected = await latestRoot(config,live,statePath,appDataDir,codexTransport,antigravityTransport,binding.seat,inspectResident);
        const matches  = selected?.root === true && selected.threadId === threadId;
        // A known successor is a positive rejection. An incomplete inventory can recover.
        if (selected?.root !== true) return denied;
        const receiptToken = randomUUID();
        await writeFileAtomic(claimPath, JSON.stringify({nonce,receiptToken,recordKey:inflight.recordKey,threadId,generation:binding.generation,
            turnId: typeof turnId === 'string' ? turnId : null, admitted:matches}), {mode:0o600,fsync:true});
        return matches ? {admitted:true,digest:formatLocalWakeDigest(record.envelope)+'\n[NEO_WAKE_RECEIVED:'+receiptToken+']'} : denied
    })
}

/**
 * @summary Reconciles one native record. Antigravity's App-owned sidecar takes the same record and lock.
 * @param {Object} record Signed receiver record with its local manifest projection.
 * @param {Object} options Receiver state plus optional App-sidecar process proof.
 * @returns {Promise<Object>} Delivered only on recipient evidence. Uncertain sends stay pending for reconciliation.
 */
export async function dispatchFleetPrimarySessionWake(record, {state, stateDir, manifestPath, sidecar, inspectResident = observePrimaryWakeResident,
    codexTransport = codex, antigravityTransport = antigravity, appDataDir = path.join(os.homedir(), '.gemini', 'antigravity')} = {}) {
    const route = record?.route, config = route?.adapterConfig?.primarySession, seat = route?.agentIdentity;
    if (!config || !bareFamily.has(config.family) || !isKey(record.recordKey)) return pending('invalid native route');
    const {family, instanceHome, appBundle, projectId} = config;
    const statePath                                    = statePathFor(stateDir, seat);
    await fs.mkdir(path.dirname(statePath), {recursive: true, mode: 0o700});
    const live = await inspectResident(config).catch(() => null);
    if (!live) return pending('harness instance unproven');
    if (config.projectRoot && config.projectRoot !== live.workspaceRoot) return pending('workspace changed');
    const isCodex     = family === 'codex-desktop', home = isCodex && deriveCodexHome({harnessType:family, instanceHome});
    const generation  = live.generation;
    const recorded    = async key => (await state.read(key)).state === 'delivered';
    const readBinding = () => readPrimarySessionWake({statePath});
    const select      = async () => {
        const now = await inspectResident(config);
        if (now?.generation !== generation) return null;
        return latestRoot(config,live,statePath,appDataDir,codexTransport,antigravityTransport,seat,inspectResident)
    };
    let before = await readBinding();
    if (before.inflight?.status === 'unknown' && before.binding) {
        // The nonce conveys no message. Redemption and withdrawal of its unclaimed grant share
        // the recipient lock, so a late marker cannot disclose the digest after replacement.
        await withOutboxLock(statePath, async () => {
            const current = await readBinding();
            if (current.version !== before.version || current.inflight?.nonce !== before.inflight.nonce) return;
            const claim = await readPrivate(statePath + '.claim.json');
            if (claim?.nonce === current.inflight.nonce && claim.admitted === true) return;
            const next = await select().catch(() => null);
            if (next?.root && (current.binding.generation !== generation || current.binding.threadId !== next.threadId)) {
                await writeFileAtomic(statePath, JSON.stringify({...current,inflight:null}), {mode:0o600,fsync:true})
            }
        });
        before = await readBinding()
    }

    if (!isCodex && !sidecar) return pending('awaiting App sidecar');
    if (!isCodex && (sidecar.appPid !== live.pid || sidecar.appStart !== live.startedAt ||
        sidecar.appBundle !== appBundle || sidecar.instanceHome !== instanceHome)) return pending('sidecar does not own instance');
    let selected;
    if (!before.inflight || before.inflight.status === 'delivered' && await recorded(before.inflight.recordKey)) {
        selected = await select().catch(() => null);
        if (!selected?.root) return pending('latest started main session is unproven');
        if (before.binding?.threadId !== selected.threadId || before.binding?.generation !== generation) {
            const result = await bindPrimarySession({statePath,seat,generation,family,threadId:selected.threadId,
                expectedVersion:before.version,proveTarget:select,isRecordedDelivered:recorded});
            if (result.status !== 'bound') return pending(result.reason)
        }
    }
    const prior = await readBinding();
    if (!prior.binding || (prior.binding.generation !== generation && prior.inflight?.recordKey !== record.recordKey)) {
        return unknown('previous launch has an unresolved wake')
    }
    const deliveryGeneration = prior.binding.generation;
    const binary             = path.join(appBundle, 'Contents/Resources/codex-cli/bin/codex');
    const verifyCodex        = ({threadId}) => codexTransport.verifyCodexWakeAdmission({
        home, binary, threadId, workspaceRoot:live.workspaceRoot, generation, manifestPath, stateDir, agentId:config.agentId,
        runtimePid:live.pid, nodePath:config.hookNodePath, modulePath:config.hookModulePath
    });
    const cursorPath = statePath + '.cursor.json';
    let   result     = await deliverPrimarySessionWake({
        statePath,seat,generation:deliveryGeneration,family,recordKey:record.recordKey,isRecordedDelivered:recorded,
        readTarget: async binding => {
            if (binding.generation !== generation) return null;
            const root = await select();
            if (root?.threadId !== binding.threadId) return null;
            if (isCodex) {
                const activity = await codexTransport.readCodexWakeActivity({home, threadId:root.threadId});
                if (activity.state !== 'idle') return null;
                const admission = await verifyCodex(root);
                return admission?.verified === true ? root : null
            }
            if (root.status !== 'CASCADE_RUN_STATUS_IDLE') return null;
            const admission = await antigravityTransport.verifyAntigravityWakeAdmission({instanceHome,appDataDir,projectId,threadId:root.threadId,generation,statePath});
            return admission?.verified === true ? root : null
        },
        send: async ({binding,nonce}) => {
            if (binding.generation !== generation) return {status:'not-sent'};
            const {threadId} = binding, text = wakeText(nonce), root = await select();
            if (root?.threadId !== threadId) return {status:'not-sent'};
            const cursor = isCodex ? root.receiptOffset : antigravityTransport.captureAntigravityWakeCursor({appDataDir,threadId});
            await writeFileAtomic(cursorPath, JSON.stringify({nonce,cursor}), {mode:0o600,fsync:true});
            if (isCodex) return codexTransport.sendCodexSessionWake({binary,home,threadId,text,verifyAdmission:verifyCodex});
            return antigravityTransport.sendAntigravitySessionWake({threadId,message:text,
                agentapiExecutable:sidecar.environment.ANTIGRAVITY_AGENTAPI_EXE, environment:sidecar.environment})
        },
        readReceipt: async ({binding,nonce,recordKey}) => {
            const {threadId} = binding, text = wakeText(nonce), saved = await readPrivate(cursorPath);
            if (saved?.nonce !== nonce) return null;
            const claim = await readPrivate(statePath + '.claim.json');
            if (claim?.nonce !== nonce || claim.recordKey !== recordKey || claim.generation !== binding.generation || claim.threadId !== threadId) return null;
            if (claim.admitted === false) return {...binding,recordKey,nonce,status:'not-sent'};
            if (claim.admitted !== true) return null;
            const proof = isCodex ? await codexTransport.readCodexWakeReceipt({home,threadId,text,receiptToken:claim.receiptToken,receiptOffset:saved.cursor}) :
                antigravityTransport.readAntigravityWakeReceipt({appDataDir,threadId,text,receiptToken:claim.receiptToken,cursor:saved.cursor});
            if (proof?.state !== 'turn-started' && proof?.outcome !== 'observed') return null;
            if (isCodex && claim.turnId && claim.turnId !== proof.turnId) return null;
            return {...binding,recordKey,nonce,status:'consumed'}
        }
    });
    if (result.status === 'delivered' && result.nonce) result = {...result,recipient:{...prior.binding,recordKey:record.recordKey,nonce:result.nonce}};
    return result
}

/**
 * @summary Handles only receiver records for the sidecar's own running App instance. The host manifest supplies
 * the address; the host-private pointer supplies only a record key, never a recipient or executable.
 */
export async function dispatchAntigravitySidecarRecords({manifestPath,stateDir,environment,...app}) {
    const manifest = await readPrivate(manifestPath);
    const state    = new WakeReceiverState({stateDir});
    for (const [subscriptionId, route] of Object.entries(manifest?.routes ?? {})) {
        const config = route?.adapterConfig?.primarySession;
        if (config?.family !== 'antigravity' || config.instanceHome !== app.instanceHome || config.appBundle !== app.appBundle ||
            route.harnessTargetMetadata?.adapter !== 'primary-session') continue;
        const enrollment = await readNativeWakeOptIn({manifestPath,agentId:config.agentId,family:config.family});
        if (enrollment?.stateDir !== stateDir) continue;
        const live = await observePrimaryWakeResident(config).catch(() => null);
        if (!live || live.pid !== app.appPid || live.startedAt !== app.appStart || config.projectRoot !== live.workspaceRoot) continue;
        const statePath  = statePathFor(stateDir,route.agentIdentity);
        const appDataDir = path.join(os.homedir(),'.gemini','antigravity');
        await fs.mkdir(path.dirname(statePath),{recursive:true,mode:0o700});
        await antigravity.initializeAntigravityStarts({databasePath:path.join(appDataDir,'conversation_summaries.db'),
            projectId:config.projectId,generation:live.generation,statePath});
        await drainFleetPrimaryWakeRecord({state,stateDir,manifestPath,subscriptionId,route,sidecar:{environment,...app}})
    }
}

/** @summary Revalidates the host route, reads a signed receiver record, and publishes only correlated receipt fields. */
export async function drainFleetPrimaryWakeRecord({state,stateDir,manifestPath,subscriptionId,route,sidecar,dispatch = dispatchFleetPrimarySessionWake}) {
    if (route.harnessTargetMetadata?.adapter !== 'primary-session') return;
    const config = route.adapterConfig?.primarySession;
    if (!config || (await readNativeWakeOptIn({manifestPath,agentId:config.agentId,family:config.family}))?.stateDir !== stateDir) return;
    const current = (await readPrivate(manifestPath))?.routes?.[subscriptionId];
    if (!current || current.agentIdentity !== route.agentIdentity || current.harnessTargetMetadata?.adapter !== 'primary-session' ||
        current.admits !== 'wake/digest' || !isDeepStrictEqual(current.adapterConfig?.primarySession,config)) return;
    const pointerPath = primaryWakeSpoolPath(stateDir,route.agentIdentity);
    const pointer     = await readPrivate(pointerPath);
    if (!pointer || !isKey(pointer.recordKey)) return;
    const record = await state.read(pointer.recordKey);
    if (!['pending','dispatching'].includes(record.state) || record.subscriptionId !== subscriptionId ||
        record.envelope?.subscriptionId !== subscriptionId || record.route?.agentIdentity !== route.agentIdentity ||
        record.envelope?.agentIdentity !== route.agentIdentity || record.envelope?.eventType !== 'wake/digest') return;
    const publicRoute = {agentIdentity:route.agentIdentity,harnessTargetMetadata:route.harnessTargetMetadata,adapterConfig:route.adapterConfig};
    // Manifest publication uses this same lock; ownership and route cannot change between the
    // last manifest check and acceptance of the bounded native send. The recipient independently
    // verifies ownership again when it attempts to claim the content.
    const result = await withOutboxLock(manifestPath,async () => {
        const latest = (await readPrivate(manifestPath))?.routes?.[subscriptionId];
        if (!isDeepStrictEqual(latest,current)) return pending('manifest changed');
        return dispatch({...record,route:publicRoute},{state,stateDir,manifestPath,sidecar})
    });
    if (result?.status === 'delivered' && result.recipient?.seat === route.agentIdentity &&
        result.recipient.recordKey === record.recordKey && UUID.test(result.recipient.nonce ?? '') &&
        UUID.test(result.recipient.threadId ?? '') && typeof result.recipient.generation === 'string' && result.recipient.generation) {
        const {recordKey} = record;
        await writeFileAtomic(pointerPath+'.result', JSON.stringify({recordKey,subscriptionId,recipient:result.recipient}), {mode:0o600,fsync:true})
    }
}

/**
 * @summary Owns native Codex dispatch in the host Fleet process. Antigravity's App sidecar
 * independently consumes its requests. An inactive host reads only its enrollment directory.
 * @returns {{stop:Function}} Stops scheduling and waits for an in-flight pass.
 */
export function startFleetPrimaryWakePump({manifestPath,intervalMs=5000,logger=console}) {
    let timer, stopped=false, running=Promise.resolve();
    async function tick() {
        try {
            const dir     = path.join(path.dirname(manifestPath),'primary-session-seats');
            const entries = await fs.readdir(dir).catch(error => { if(error.code==='ENOENT') return []; throw error });
            if (entries.length) {
                const manifest = await readPrivate(manifestPath);
                for (const [subscriptionId,route] of Object.entries(manifest?.routes ?? {})) {
                    const config = route?.adapterConfig?.primarySession;
                    if (config?.family !== 'codex-desktop' || route.harnessTargetMetadata?.adapter !== 'primary-session') continue;
                    const enrollment = await readNativeWakeOptIn({manifestPath,agentId:config.agentId,family:config.family});
                    if (!enrollment) continue;
                    const stateDir = enrollment.stateDir, state=new WakeReceiverState({stateDir});
                    await drainFleetPrimaryWakeRecord({state,stateDir,manifestPath,subscriptionId,route})
                }
            }
        } catch { logger.warn?.('Native wake pass could not reconcile a seat; signed records remain pending.') }
        if (!stopped) schedule(intervalMs)
    }
    function schedule(delay) {
        timer=setTimeout(() => { running=tick() },delay);
        timer.unref?.()
    }
    schedule(0);
    return {stop: async () => { stopped=true; clearTimeout(timer); await running }}
}

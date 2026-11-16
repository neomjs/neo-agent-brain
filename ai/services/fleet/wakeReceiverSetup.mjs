/**
 * @module ai/services/fleet/wakeReceiverSetup
 * @summary Host bootstrap, ownership reconciliation, owner-private records preparation, and cold zero-route
 * manifest setup for the per-user macOS desktop wake receiver (`com.neomjs.agent-os-wake`).
 *
 * Designed as one shared substrate for both CLI (`ai/scripts/setup/firstRun.mjs`) and Fleet setup callers
 * without reading Agent OS config (`AiConfig`) or `process.env` directly: callers pass resolved paths and a
 * `createHost()` adapter (filesystem, command runner, clock, platform, UID, HTTP listener probe).
 */

import http                   from 'node:http';
import os                     from 'node:os';
import path                   from 'node:path';
import {writeFileAtomic}      from '../shared/atomicFileWrite.mjs';
import {runtimeGenerationPin} from './runtimeGeneration.mjs';
import {contentDigest}        from './setupRunRecord.mjs';
import {
    PRIVATE_DIR_MODE,
    PRIVATE_FILE_MODE,
    WAKE_RECEIVER_CUSTODY_FILE,
    WAKE_RECEIVER_CUSTODY_SCHEMA_VERSION,
    WAKE_RECEIVER_MANIFEST_SCHEMA_VERSION,
    inspectWakeSetupState,
    resolveHostUid,
    safeLstat,
    sameOptionalUid,
    summarizeOwnedCustodySpec,
    supervisorMatchesDeclaration,
    writeCustodyRecord
} from './wakeReceiverCustody.mjs';
import {
    WAKE_RECEIVER_DEFAULT_HOST,
    WAKE_RECEIVER_DEFAULT_PORT,
    WAKE_RECEIVER_ENTRYPOINT,
    WAKE_RECEIVER_LABEL,
    WAKE_RECEIVER_PLIST_NAME,
    assertSafeAbsolutePath,
    extractReceiverDeclaration,
    parseLaunchAgentPlist,
    serializeWakeReceiverPlist
} from './wakeReceiverPlist.mjs';

export {
    WAKE_RECEIVER_CUSTODY_FILE,
    WAKE_RECEIVER_CUSTODY_SCHEMA_VERSION,
    WAKE_RECEIVER_DEFAULT_HOST,
    WAKE_RECEIVER_DEFAULT_PORT,
    WAKE_RECEIVER_ENTRYPOINT,
    WAKE_RECEIVER_LABEL,
    WAKE_RECEIVER_MANIFEST_SCHEMA_VERSION,
    WAKE_RECEIVER_PLIST_NAME,
    extractReceiverDeclaration,
    parseLaunchAgentPlist,
    serializeWakeReceiverPlist
};

/**
 * Allowed consent choices for the `desktop-wake` recipe question.
 * @type {Object}
 */
export const DESKTOP_WAKE_CHOICES = Object.freeze({
    enabled : 'enabled',
    declined: 'declined'
});

/**
 * Host OS platforms where user-owned `launchd` receiver supervision is supported.
 * @type {String[]}
 */
export const SUPPORTED_WAKE_PLATFORMS = Object.freeze(['darwin']);

const LAUNCHD_READY_ATTEMPTS = 20;
const LAUNCHD_READY_DELAY_MS = 100;

function resolvePlatform(host) {
    if (typeof host?.platform === 'function') {
        return host.platform();
    }

    return typeof host?.platform === 'string' ? host.platform : null;
}

/**
 * @summary Resolves all host paths and endpoint defaults for the desktop wake receiver from a setup layout.
 * Resolves `LaunchAgents` from `layout.homeDir` or `os.homedir()`, independent of `stateRoot`.
 * @param {Object} [layout={}]
 * @param {Object} [options={}]
 * @param {Boolean} [options.declined=false]
 * @param {Boolean} [options.supported=true]
 * @returns {Object}
 */
export function resolveWakeSetupPaths(layout = {}, {declined = false, supported = true} = {}) {
    const
        stateRoot                = layout.stateRoot ?? (layout.secretsDir ? path.dirname(layout.secretsDir) : null),
        homeDir                  = layout.homeDir ? path.resolve(layout.homeDir) : os.homedir(),
        wakeStateDir             = layout.wakeStateDir ?? (stateRoot ? path.join(stateRoot, 'wake-receiver') : null),
        receiverlessWakeStateDir = layout.receiverlessWakeStateDir ?? (stateRoot ? path.join(stateRoot, 'wake-receiver-disabled') : null),
        selectedStateDir         = declined || !supported ? receiverlessWakeStateDir : wakeStateDir,
        recordsDir               = selectedStateDir ? path.join(selectedStateDir, 'records') : null,
        manifestPath             = layout.wakeManifestPath ?? (wakeStateDir ? path.join(wakeStateDir, 'manifest.json') : null),
        custodyPath              = layout.wakeCustodyPath ?? (wakeStateDir ? path.join(wakeStateDir, WAKE_RECEIVER_CUSTODY_FILE) : null),
        envFile                  = layout.envFile ?? (stateRoot ? path.join(stateRoot, 'config', 'local-agent-os.env') : null),
        plistPath                = layout.wakePlistPath ?? path.join(homeDir, 'Library', 'LaunchAgents', WAKE_RECEIVER_PLIST_NAME),
        host                     = layout.wakeHost ?? WAKE_RECEIVER_DEFAULT_HOST,
        port                     = layout.wakePort ?? WAKE_RECEIVER_DEFAULT_PORT,
        runtimeGeneration        = layout.runtime?.generation ? runtimeGenerationPin(layout.runtime.generation) : null,
        runtimeRoot              = runtimeGeneration?.runtimeRoot ?? layout.runtime?.runtimeRoot ?? layout.repoRoot ?? null,
        executable               = runtimeGeneration?.executable ?? layout.runtime?.executable ?? layout.nodeBin ?? null,
        templatePath             = layout.wakeTemplatePath ?? (layout.repoRoot ? path.join(layout.repoRoot, 'deploy', 'host', WAKE_RECEIVER_PLIST_NAME) : null),
        extraEnv                 = layout.runtime?.env && typeof layout.runtime.env === 'object' ? {...layout.runtime.env} : {};

    return {
        stateRoot,
        homeDir,
        wakeStateDir,
        receiverlessWakeStateDir,
        selectedStateDir,
        recordsDir,
        manifestPath,
        custodyPath,
        envFile,
        plistPath,
        host,
        port,
        runtimeRoot,
        executable,
        runtimeGeneration,
        templatePath,
        extraEnv
    };
}

/**
 * @summary Selects which receiver state directory supplies `<stateDir>/records` for Compose (`write-env`).
 * @param {Object} [layout={}]
 * @param {Object} [options={}]
 * @param {String|null} [options.consentAnswer=null]
 * @param {Boolean}     [options.supported=true]
 * @returns {String|null}
 */
export function selectWakeRecordsStateDir(layout = {}, {consentAnswer = null, supported = true} = {}) {
    const
        declined = consentAnswer === DESKTOP_WAKE_CHOICES.declined,
        paths    = resolveWakeSetupPaths(layout, {declined, supported});

    if (!paths.selectedStateDir) {
        return null;
    }

    return assertSafeAbsolutePath(paths.selectedStateDir, 'wake records stateDir');
}

/**
 * @summary Inspects `<stateDir>/records` without mutating it, verifying ownership, non-symlink safety, and `0700` privacy.
 * @param {String} stateDir
 * @param {Object} host
 * @returns {Promise<{ok:Boolean, stateDir:String, recordsDir:String, reason:String|null}>}
 */
export async function inspectWakeRecordsDir(stateDir, host) {
    assertSafeAbsolutePath(stateDir, 'stateDir');

    const
        fsModule   = host.fsModule,
        hostUid    = resolveHostUid(host),
        recordsDir = path.join(stateDir, 'records');

    let stateStat;

    try {
        stateStat = await safeLstat(fsModule, stateDir);
    } catch (error) {
        return error?.code === 'ENOENT'
            ? {ok: false, stateDir, recordsDir, reason: `${recordsDir} does not exist`}
            : {ok: false, stateDir, recordsDir, reason: `${stateDir} cannot be inspected (${error.message})`};
    }

    if (typeof stateStat.isSymbolicLink === 'function' && stateStat.isSymbolicLink()) {
        return {ok: false, stateDir, recordsDir, reason: `refusing symbolic link for wake stateDir at ${stateDir}`};
    }

    if (typeof stateStat.isDirectory === 'function' && !stateStat.isDirectory()) {
        return {ok: false, stateDir, recordsDir, reason: `wake stateDir at ${stateDir} is not a directory`};
    }

    if (!sameOptionalUid(stateStat, hostUid)) {
        return {ok: false, stateDir, recordsDir, reason: `wake stateDir at ${stateDir} is owned by UID ${stateStat.uid}, expected ${hostUid}`};
    }

    let recordsStat;

    try {
        recordsStat = await safeLstat(fsModule, recordsDir);
    } catch (error) {
        return error?.code === 'ENOENT'
            ? {ok: false, stateDir, recordsDir, reason: `${recordsDir} does not exist`}
            : {ok: false, stateDir, recordsDir, reason: `${recordsDir} cannot be inspected (${error.message})`};
    }

    if (typeof recordsStat.isSymbolicLink === 'function' && recordsStat.isSymbolicLink()) {
        return {ok: false, stateDir, recordsDir, reason: `refusing symbolic link for wake records directory at ${recordsDir}`};
    }

    if (typeof recordsStat.isDirectory === 'function' && !recordsStat.isDirectory()) {
        return {ok: false, stateDir, recordsDir, reason: `wake records path at ${recordsDir} is not a directory`};
    }

    if (!sameOptionalUid(recordsStat, hostUid)) {
        return {ok: false, stateDir, recordsDir, reason: `wake records directory at ${recordsDir} is owned by UID ${recordsStat.uid}, expected ${hostUid}`};
    }

    if (typeof recordsStat.mode === 'number' && (recordsStat.mode & 0o077) !== 0) {
        return {ok: false, stateDir, recordsDir, reason: `wake records directory at ${recordsDir} is accessible beyond its owner`};
    }

    return {ok: true, stateDir, recordsDir, reason: null};
}

/**
 * @summary Prepares owner-private `<stateDir>/records` (`0700`) for the local Compose bind while refusing symlinks
 * or foreign ownership and preserving existing records and unrelated file permissions.
 * @param {String} stateDir
 * @param {Object} host
 * @returns {Promise<{stateDir:String, recordsDir:String, created:Boolean}>}
 */
export async function prepareWakeRecordsDir(stateDir, host) {
    assertSafeAbsolutePath(stateDir, 'stateDir');

    const
        fsModule   = host.fsModule,
        hostUid    = resolveHostUid(host),
        recordsDir = path.join(stateDir, 'records');

    let stateExists = false;

    try {
        const stateStat = await safeLstat(fsModule, stateDir);

        if (typeof stateStat.isSymbolicLink === 'function' && stateStat.isSymbolicLink()) {
            throw new Error(`wakeReceiverSetup: refusing symbolic link for stateDir at ${stateDir}.`);
        }

        if (typeof stateStat.isDirectory === 'function' && !stateStat.isDirectory()) {
            throw new Error(`wakeReceiverSetup: '${stateDir}' exists and is not a directory.`);
        }

        if (!sameOptionalUid(stateStat, hostUid)) {
            throw new Error(`wakeReceiverSetup: refusing foreign ownership on '${stateDir}' (uid ${stateStat.uid}, expected ${hostUid}).`);
        }

        stateExists = true;
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }

    if (!stateExists) {
        await fsModule.mkdir(stateDir, {recursive: true, mode: PRIVATE_DIR_MODE});
    }

    let created = false, recordsStat = null;

    try {
        recordsStat = await safeLstat(fsModule, recordsDir);

        if (typeof recordsStat.isSymbolicLink === 'function' && recordsStat.isSymbolicLink()) {
            throw new Error(`wakeReceiverSetup: refusing symbolic link for records directory at ${recordsDir}.`);
        }

        if (typeof recordsStat.isDirectory === 'function' && !recordsStat.isDirectory()) {
            throw new Error(`wakeReceiverSetup: '${recordsDir}' exists and is not a directory.`);
        }

        if (!sameOptionalUid(recordsStat, hostUid)) {
            throw new Error(`wakeReceiverSetup: refusing foreign ownership on '${recordsDir}' (uid ${recordsStat.uid}, expected ${hostUid}).`);
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }

        await fsModule.mkdir(recordsDir, {mode: PRIVATE_DIR_MODE});
        created     = true;
        recordsStat = await safeLstat(fsModule, recordsDir);
    }

    if (typeof recordsStat?.mode === 'number' && (recordsStat.mode & 0o777) !== PRIVATE_DIR_MODE && typeof fsModule.chmod === 'function') {
        await fsModule.chmod(recordsDir, PRIVATE_DIR_MODE);
    }

    return {stateDir, recordsDir, created};
}

/**
 * @summary Ensures a valid owner-private (`0600`) zero-route manifest exists only when creating on a fresh
 * owned path; never overwrites an existing valid, signed, or ambiguous manifest.
 * @param {String} manifestPath
 * @param {Object} host
 * @returns {Promise<{created:Boolean, existing:Boolean, path:String, routeCount:Number}>}
 */
export async function ensureColdWakeManifest(manifestPath, host) {
    assertSafeAbsolutePath(manifestPath, 'manifestPath');

    const
        fsModule  = host.fsModule,
        hostUid   = resolveHostUid(host),
        parentDir = path.dirname(manifestPath);

    try {
        const parentStat = await safeLstat(fsModule, parentDir);

        if (typeof parentStat.isSymbolicLink === 'function' && parentStat.isSymbolicLink()) {
            throw new Error(`wakeReceiverSetup: refusing symbolic link for manifest parent at ${parentDir}.`);
        }

        if (!sameOptionalUid(parentStat, hostUid)) {
            throw new Error(`wakeReceiverSetup: refusing foreign ownership on manifest parent '${parentDir}' (uid ${parentStat.uid}, expected ${hostUid}).`);
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }

        await fsModule.mkdir(parentDir, {recursive: true, mode: PRIVATE_DIR_MODE});
    }

    try {
        const stat = await safeLstat(fsModule, manifestPath);

        if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) {
            throw new Error(`wakeReceiverSetup: refusing symbolic link for manifest at ${manifestPath}.`);
        }

        if (typeof stat.isFile === 'function' && !stat.isFile()) {
            throw new Error(`wakeReceiverSetup: '${manifestPath}' exists and is not a regular file.`);
        }

        if (!sameOptionalUid(stat, hostUid)) {
            throw new Error(`wakeReceiverSetup: refusing foreign ownership on manifest '${manifestPath}' (uid ${stat.uid}, expected ${hostUid}).`);
        }

        const parsed = JSON.parse(await fsModule.readFile(manifestPath, 'utf8'));

        return {
            created   : false,
            existing  : true,
            path      : manifestPath,
            routeCount: parsed?.routes && typeof parsed.routes === 'object' ? Object.keys(parsed.routes).length : 0
        };
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }

    const coldContent = `${JSON.stringify({schemaVersion: WAKE_RECEIVER_MANIFEST_SCHEMA_VERSION, routes: {}}, null, 2)}\n`;

    await fsModule.writeFile(manifestPath, coldContent, {mode: PRIVATE_FILE_MODE, flag: 'wx'});

    if (typeof fsModule.chmod === 'function') {
        await fsModule.chmod(manifestPath, PRIVATE_FILE_MODE);
    }

    return {created: true, existing: false, path: manifestPath, routeCount: 0};
}

/**
 * @summary Sends a non-mutating unknown-subscription `POST /wake` probe to verify whether a Neo wake receiver
 * daemon (rather than a foreign listener) is serving on `host:port`.
 * @param {Object} [options={}]
 * @param {String} [options.host='127.0.0.1']
 * @param {Number} options.port
 * @param {Number} [options.timeoutMs=1500]
 * @returns {Promise<{listening:Boolean, wakeReceiver:Boolean, statusCode:Number|null, reason:String|null}>}
 */
export function probeWakeReceiverHttp({host = WAKE_RECEIVER_DEFAULT_HOST, port, timeoutMs = 1500} = {}) {
    return new Promise(resolve => {
        let settled = false;

        const finish = result => {
            if (!settled) {
                settled = true;
                resolve(result);
            }
        };

        const req = http.request({
            host,
            port,
            path   : '/wake',
            method : 'POST',
            headers: {
                'content-type'              : 'application/json',
                'content-length'            : '2',
                'x-neo-wake-subscription-id': '__setup_probe__'
            }
        }, res => {
            let body = '';

            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk });
            res.on('end', () => {
                let parsed = null;

                try {
                    parsed = JSON.parse(body);
                } catch {
                    parsed = null;
                }

                if (res.statusCode === 404 && parsed?.error === 'unknown-subscription') {
                    finish({listening: true, wakeReceiver: true, statusCode: 404, reason: null});
                    return;
                }

                finish({
                    listening   : true,
                    wakeReceiver: false,
                    statusCode  : res.statusCode ?? null,
                    reason      : `foreign HTTP listener on ${host}:${port} answered HTTP ${res.statusCode}`
                });
            });
        });

        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`timed out after ${timeoutMs} ms probing ${host}:${port}`));
        });
        req.on('error', error => {
            const listening = error?.code === 'ECONNRESET' || error?.code === 'EPIPE';

            finish({listening, wakeReceiver: false, statusCode: null, reason: error.message});
        });
        req.end('{}');
    });
}

function launchctlDomain(hostUid) {
    return hostUid !== null && hostUid !== undefined ? `gui/${hostUid}` : 'gui/501';
}

function parseLaunchctlEnvBlock(blockBody) {
    const env        = {};
    let   currentKey = null;

    for (const rawLine of blockBody.split(/\r?\n/)) {
        const match = rawLine.match(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:=>|=)[ \t]*(.*)$/);

        if (match) {
            currentKey      = match[1];
            env[currentKey] = match[2].trim();
        } else if (currentKey !== null && rawLine.trim().length > 0) {
            env[currentKey] = `${env[currentKey]}\n${rawLine.trim()}`;
        }
    }

    return env;
}

function parseLaunchctlPrint(stdout) {
    const
        fields        = new Map(),
        blocks        = new Map(),
        collectedKeys = new Set(['arguments', 'default environment', 'environment']),
        stack         = [];
    let topDepth = 0,
        sawRoot  = false;

    for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) {
            continue;
        }

        if (!sawRoot) {
            sawRoot = true;

            if (!/^[ \t]*(?:arguments|default environment|environment|properties|endpoints|spawned environment|resource limits)[ \t]*=/i.test(line) &&
                /^[ \t]*[^\s=].*=[ \t]*\{[ \t]*$/.test(line)) {
                topDepth = 1;
                stack.push(null);
                continue;
            }
        }

        if (stack.length === topDepth) {
            const blockMatch = line.match(/^[ \t]*([A-Za-z][A-Za-z0-9 ]*?)[ \t]*=[ \t]*\{[ \t]*$/);

            if (blockMatch) {
                const key = blockMatch[1].toLowerCase();
                stack.push({key, lines: collectedKeys.has(key) ? [] : null});
                continue;
            }

            const scalarMatch = line.match(/^[ \t]*([A-Za-z][A-Za-z0-9 ]*?)[ \t]*=[ \t]*(?!>)(.*)$/);

            if (scalarMatch) {
                fields.set(scalarMatch[1].toLowerCase(), scalarMatch[2].trim());
            }

            continue;
        }

        const current = stack[stack.length - 1] ?? null;

        if (/^[ \t]*\}[ \t]*$/.test(line)) {
            const closed = stack.pop();

            if (closed?.lines && stack.length === topDepth) {
                blocks.set(closed.key, closed.lines);
            }

            continue;
        }

        if (current?.lines) {
            current.lines.push(line);
        } else if (!/=>/.test(line) && /^[ \t]*[^\s=].*=[ \t]*\{[ \t]*$/.test(line)) {
            stack.push({key: null, lines: null});
        }
    }

    const
        stateRaw   = fields.get('state') ?? '',
        pidRaw     = fields.get('pid') ?? '',
        pid        = /^\d+$/.test(pidRaw) ? Number(pidRaw) : null,
        argLines   = blocks.get('arguments'),
        defEnvList = blocks.get('default environment'),
        envList    = blocks.get('environment');

    return {
        loaded            : true,
        running           : stateRaw.toLowerCase() === 'running' || (Number.isInteger(pid) && pid > 0),
        pid,
        program           : fields.get('program') || null,
        plist             : fields.get('path') || null,
        workingDirectory  : fields.get('working directory') || null,
        arguments         : argLines ? argLines.map(item => item.trim()).filter(Boolean) : null,
        defaultEnvironment: defEnvList ? parseLaunchctlEnvBlock(defEnvList.join('\n')) : null,
        environment       : envList ? parseLaunchctlEnvBlock(envList.join('\n')) : null
    };
}

async function inspectSupervisor(host, hostUid) {
    const
        domain        = launchctlDomain(hostUid),
        serviceTarget = `${domain}/${WAKE_RECEIVER_LABEL}`;

    try {
        const result = await host.run('launchctl', ['print', serviceTarget], {});

        return {domain, serviceTarget, ...parseLaunchctlPrint(result?.stdout ?? '')};
    } catch (error) {
        const text = `${error?.stderr ?? ''}\n${error?.stdout ?? ''}\n${error?.message ?? ''}`;

        if (/Could not find service|service cannot be found|No such process|113/i.test(text)) {
            return {domain, serviceTarget, loaded: false, running: false, pid: null, program: null, plist: null, workingDirectory: null, arguments: null, defaultEnvironment: null, environment: null};
        }

        return {domain, serviceTarget, loaded: false, running: false, pid: null, program: null, plist: null, workingDirectory: null, arguments: null, defaultEnvironment: null, environment: null, queryError: error.message};
    }
}

/**
 * @summary Observes host OS support and whether installing, adopting, upgrading, or starting `com.neomjs.agent-os-wake`
 * is planned for the `desktop-wake` recipe question.
 * @param {Object} options
 * @param {Object} options.layout
 * @param {Object} options.host
 * @param {Object} [options.target={}]
 * @returns {Promise<Object>}
 */
export async function observeDesktopWakeQuestion({layout, host, target = {}}) {
    const
        platform = resolvePlatform(host),
        paths    = resolveWakeSetupPaths(layout);

    if (!SUPPORTED_WAKE_PLATFORMS.includes(platform)) {
        return {
            supported   : false,
            platform    : platform ?? 'unknown',
            serviceLabel: WAKE_RECEIVER_LABEL,
            plistPath   : paths.plistPath,
            endpoint    : `http://${paths.host}:${paths.port}`,
            action      : 'unsupported',
            reason      : `host OS '${platform ?? 'unknown'}' has no launchd desktop wake receiver; wake delivery unavailable while ordinary local plane setup remains available`
        };
    }

    const inspection = await inspectWakeSetupState({
        paths,
        target,
        host,
        inspectSupervisor,
        defaultProbeListener: probeWakeReceiverHttp
    });

    const actionByKind = {
        absent                  : 'install and start',
        'owned-absent'          : 'install and start',
        'owned-stopped'         : 'start',
        'owned-upgrade'         : inspection.endpointMoved ? 'rebind and restart' : 'upgrade and restart',
        'owned-installing-ready': 'finalize ownership custody',
        'owned-running'         : 'adopt running service',
        'corroborated-legacy'   : 'adopt corroborated legacy service',
        conflict                : 'resolve custody conflict before install'
    };

    const action = actionByKind[inspection.kind] ?? 'install and start';

    return {
        supported    : true,
        platform,
        serviceLabel : WAKE_RECEIVER_LABEL,
        plistPath    : paths.plistPath,
        stateDir     : paths.wakeStateDir,
        manifestPath : paths.manifestPath,
        endpoint     : `http://${paths.host}:${paths.port}`,
        action,
        conflict     : inspection.conflict ?? null,
        planSummary  : `${WAKE_RECEIVER_LABEL} (${action} at http://${paths.host}:${paths.port})`,
        promptSummary: `choose 'enabled' to ${action} ${WAKE_RECEIVER_LABEL}, or 'declined' for a receiver-less local plane`
    };
}

/**
 * @summary Live observation of the `start-wake-receiver` effect: requires custody/corroboration, loaded running
 * supervisor with matching program, live `/wake` listener, and matching runtime/endpoint declaration.
 * @param {Object} options
 * @param {Object} options.layout
 * @param {Object} options.target
 * @param {Object|null} [options.record=null]
 * @param {Object} options.host
 * @returns {Promise<Object>}
 */
export async function observeWakeReceiverEffect({layout, target, record = null, host}) {
    const
        platform = resolvePlatform(host),
        consent  = record?.consents?.find(row => row.stepId === 'desktop-wake')?.answer ?? null;

    if (!SUPPORTED_WAKE_PLATFORMS.includes(platform)) {
        return {
            present              : false,
            running              : false,
            skipped              : true,
            wakeDeliveryAvailable: false,
            digest               : null,
            reason               : `host OS '${platform ?? 'unknown'}' does not support LaunchAgent wake receivers`
        };
    }

    if (consent === DESKTOP_WAKE_CHOICES.declined) {
        return {
            present              : false,
            running              : false,
            skipped              : true,
            wakeDeliveryAvailable: false,
            digest               : null,
            reason               : 'desktop wake receiver declined; local plane uses receiver-less records dir'
        };
    }

    const
        paths      = resolveWakeSetupPaths(layout),
        inspection = await inspectWakeSetupState({
            paths,
            target,
            host,
            inspectSupervisor,
            defaultProbeListener: probeWakeReceiverHttp
        });

    if (inspection.kind === 'conflict') {
        return {
            present: true,
            running: Boolean(inspection.supervisor?.running),
            owned  : Boolean(inspection.owned),
            digest : null,
            problem: inspection.conflict
        };
    }

    if (inspection.kind === 'absent' || inspection.kind === 'owned-absent') {
        return {
            present    : false,
            running    : false,
            owned      : Boolean(inspection.owned),
            cleanAbsent: inspection.kind === 'absent',
            digest     : null,
            reason     : `LaunchAgent '${WAKE_RECEIVER_LABEL}' is not installed`
        };
    }

    if (inspection.kind === 'owned-stopped') {
        return {
            present: false,
            running: false,
            owned  : true,
            digest : inspection.plistRead?.digest ?? null,
            reason : `LaunchAgent '${WAKE_RECEIVER_LABEL}' exists on disk but is not loaded or listening on ${paths.host}:${paths.port}`
        };
    }

    if (inspection.kind === 'owned-upgrade') {
        return {
            present       : true,
            running       : Boolean(inspection.supervisor?.running && inspection.activeListener?.wakeReceiver),
            owned         : true,
            upgradePending: true,
            digest        : inspection.plistRead?.digest ?? null,
            problem       : null,
            reason        : `LaunchAgent '${WAKE_RECEIVER_LABEL}' declaration differs from current runtime or endpoint; update required`
        };
    }

    if (inspection.kind === 'owned-installing-ready') {
        return {
            present       : true,
            running       : true,
            owned         : true,
            upgradePending: true,
            digest        : inspection.plistRead?.digest ?? null,
            problem       : null,
            reason        : `LaunchAgent '${WAKE_RECEIVER_LABEL}' is running and awaiting custody finalization`
        };
    }

    return {
        present              : true,
        running              : true,
        owned                : Boolean(inspection.owned),
        wakeDeliveryAvailable: true,
        adopted              : inspection.kind === 'corroborated-legacy' || inspection.kind === 'owned-running',
        digest               : inspection.plistRead?.digest ?? null,
        problem              : null
    };
}

async function waitForListenerAndSupervisor({paths, expectedDeclaration, host, hostUid}) {
    const
        probeFn     = host.probeWakeListener ?? probeWakeReceiverHttp,
        maxAttempts = Number.isInteger(host.wakeReadinessAttempts) && host.wakeReadinessAttempts > 0
            ? host.wakeReadinessAttempts
            : LAUNCHD_READY_ATTEMPTS,
        delayMs     = Number.isInteger(host.wakeReadinessDelayMs) && host.wakeReadinessDelayMs >= 0
            ? host.wakeReadinessDelayMs
            : LAUNCHD_READY_DELAY_MS;

    let lastSupervisor = null, lastListener = null, supervisorMismatch = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        lastSupervisor     = await inspectSupervisor(host, hostUid);
        lastListener       = await probeFn({host: paths.host, port: paths.port});
        supervisorMismatch = supervisorMatchesDeclaration(lastSupervisor, paths.plistPath, expectedDeclaration);

        if (lastSupervisor.loaded && lastSupervisor.running && !supervisorMismatch && lastListener.wakeReceiver) {
            return {supervisor: lastSupervisor, listener: lastListener};
        }

        if (attempt + 1 < maxAttempts && delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    const detail = !lastSupervisor?.loaded
        ? `launchd service '${WAKE_RECEIVER_LABEL}' is not loaded`
        : supervisorMismatch
            ? supervisorMismatch
            : !lastSupervisor.running
                ? `launchd service '${WAKE_RECEIVER_LABEL}' is not running`
                : lastListener?.reason ?? `wake listener did not answer on ${paths.host}:${paths.port}`;

    throw new Error(`wakeReceiverSetup: ${detail} after launchctl bootstrap.`);
}

function verificationLayoutOf(paths) {
    return {
        stateRoot       : paths.stateRoot,
        homeDir         : paths.homeDir,
        wakeStateDir    : paths.wakeStateDir,
        wakeManifestPath: paths.manifestPath,
        wakeCustodyPath : paths.custodyPath,
        wakePlistPath   : paths.plistPath,
        envFile         : paths.envFile,
        wakeHost        : paths.host,
        wakePort        : paths.port,
        runtime         : {
            runtimeRoot: paths.runtimeRoot,
            executable : paths.executable,
            ...(paths.runtimeGeneration ? {generation: paths.runtimeGeneration} : {}),
            ...(paths.extraEnv && Object.keys(paths.extraEnv).length > 0 ? {env: paths.extraEnv} : {})
        }
    };
}

async function assertObservedReady({paths, target, host}) {
    const observed = await observeWakeReceiverEffect({
        layout: verificationLayoutOf(paths),
        target,
        host
    });

    if (!observed.present || !observed.running || observed.problem || observed.upgradePending) {
        throw new Error(`wakeReceiverSetup: post-reconciliation observation failed — ${observed.problem ?? observed.reason ?? 'receiver not ready'}.`);
    }

    return observed;
}

/**
 * @summary Handler for `start-wake-receiver`: enforces ownership/custody before any mutation, prepares owner-private
 * records + cold zero-route manifest if genuinely fresh, persists intended custody prior to the first service mutation
 * so interrupted installs recover cleanly, adopts corroborated running services with zero extra listeners, installs or
 * upgrades cleanly via `launchctl`, and re-observes completion before returning accepted.
 * @param {Object} input
 * @param {Object} host
 * @returns {Promise<{digest:String, references:String[], action:String}>}
 */
export async function reconcileWakeReceiverService(input, host) {
    const
        platform = resolvePlatform(host),
        hostUid  = resolveHostUid(host);

    if (!SUPPORTED_WAKE_PLATFORMS.includes(platform)) {
        throw new Error(`wakeReceiverSetup: cannot start LaunchAgent on unsupported OS '${platform ?? 'unknown'}'.`);
    }

    if (!input?.target?.planeId) {
        throw new Error('wakeReceiverSetup: target.planeId is required before binding the wake receiver.');
    }

    const paths = resolveWakeSetupPaths({
        stateRoot       : input.stateRoot ?? (input.stateDir ? path.dirname(input.stateDir) : null),
        homeDir         : input.homeDir,
        envFile         : input.envFile,
        wakeStateDir    : input.stateDir,
        wakeManifestPath: input.manifestPath,
        wakeCustodyPath : input.custodyPath,
        wakePlistPath   : input.plistPath,
        wakeHost        : input.host,
        wakePort        : input.port,
        runtime         : {
            runtimeRoot: input.runtimeRoot,
            executable : input.executable,
            generation : input.runtimeGeneration,
            env        : input.extraEnv
        }
    });

    assertSafeAbsolutePath(paths.plistPath, 'plistPath');
    assertSafeAbsolutePath(paths.manifestPath, 'manifestPath');
    assertSafeAbsolutePath(paths.wakeStateDir, 'stateDir');
    assertSafeAbsolutePath(paths.runtimeRoot, 'runtimeRoot');
    assertSafeAbsolutePath(paths.executable, 'executable');

    const entrypointPath = path.join(paths.runtimeRoot, WAKE_RECEIVER_ENTRYPOINT);

    try {
        const entryStat = await safeLstat(host.fsModule, entrypointPath);

        if (typeof entryStat.isFile === 'function' && !entryStat.isFile()) {
            throw new Error(`wakeReceiverSetup: '${entrypointPath}' is not a regular file.`);
        }
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw new Error(`wakeReceiverSetup: runtimeRoot '${paths.runtimeRoot}' carries no ${WAKE_RECEIVER_ENTRYPOINT}.`);
        }

        throw error;
    }

    const inspection = await inspectWakeSetupState({
        paths,
        target              : input.target,
        host,
        inspectSupervisor,
        defaultProbeListener: probeWakeReceiverHttp
    });

    if (inspection.kind === 'conflict') {
        throw new Error(`wakeReceiverSetup: refusing takeover — ${inspection.conflict}.`);
    }

    await prepareWakeRecordsDir(paths.wakeStateDir, host);
    await ensureColdWakeManifest(paths.manifestPath, host);

    if (inspection.kind === 'owned-running') {
        await assertObservedReady({paths, target: input.target, host});

        return {
            digest    : inspection.plistRead.digest,
            references: [paths.plistPath, paths.manifestPath],
            action    : 'adopted'
        };
    }

    if (inspection.kind === 'owned-installing-ready') {
        await writeCustodyRecord({
            custodyPath : paths.custodyPath,
            hostUid,
            target      : input.target,
            paths,
            plistDigest : inspection.plistRead.digest,
            environment : inspection.plistRead.declaration?.environment ?? {},
            adoptedFrom : inspection.custodyRead.value?.adoptedFrom ?? 'fresh-install',
            installState: 'active',
            host
        });
        await assertObservedReady({paths, target: input.target, host});

        return {
            digest    : inspection.plistRead.digest,
            references: [paths.plistPath, paths.manifestPath],
            action    : 'adopted'
        };
    }

    if (inspection.kind === 'corroborated-legacy') {
        await writeCustodyRecord({
            custodyPath : paths.custodyPath,
            hostUid,
            target      : input.target,
            paths,
            plistDigest : inspection.plistRead.digest,
            environment : inspection.plistRead.declaration?.environment ?? {},
            adoptedFrom : 'corroborated-legacy',
            installState: 'active',
            host
        });
        await assertObservedReady({paths, target: input.target, host});

        return {
            digest    : inspection.plistRead.digest,
            references: [paths.plistPath, paths.manifestPath],
            action    : 'adopted-legacy'
        };
    }

    if (typeof input.templateXml !== 'string' || input.templateXml.length === 0) {
        throw new Error('wakeReceiverSetup: LaunchAgent template XML is required when installing or upgrading.');
    }

    const
        xml      = serializeWakeReceiverPlist({
            templateXml      : input.templateXml,
            executable       : paths.executable,
            runtimeRoot      : paths.runtimeRoot,
            manifestPath     : paths.manifestPath,
            stateDir         : paths.wakeStateDir,
            host             : paths.host,
            port             : paths.port,
            runtimeGeneration: paths.runtimeGeneration,
            extraEnv         : paths.extraEnv
        }),
        expectedDeclaration = extractReceiverDeclaration(parseLaunchAgentPlist(xml, {allowComments: false})),
        digest              = contentDigest(xml),
        domain              = launchctlDomain(hostUid),
        service             = `${domain}/${WAKE_RECEIVER_LABEL}`,
        adoptedFrom         = inspection.kind === 'owned-upgrade'
            ? (inspection.endpointMoved ? 'endpoint-move' : 'upgrade')
            : inspection.kind === 'owned-stopped'
                ? 'restarted'
                : 'fresh-install';

    if (inspection.kind === 'owned-upgrade') {
        const recheck = await inspectWakeSetupState({
            paths,
            target              : input.target,
            host,
            inspectSupervisor,
            defaultProbeListener: probeWakeReceiverHttp
        });

        if (recheck.kind === 'conflict') {
            throw new Error(`wakeReceiverSetup: custody recheck before replacement failed — ${recheck.conflict}.`);
        }
    }

    // Persist intended ownership BEFORE writing the plist or mutating launchd so interrupted installs never look foreign.
    await writeCustodyRecord({
        custodyPath  : paths.custodyPath,
        hostUid,
        target       : input.target,
        paths,
        plistDigest  : digest,
        environment  : expectedDeclaration.environment,
        adoptedFrom,
        installState : 'installing',
        previousOwned: inspection.custodyRead?.exists ? summarizeOwnedCustodySpec(inspection.custodyRead.value) : null,
        host
    });

    if (inspection.supervisor?.loaded || inspection.kind === 'owned-upgrade' || inspection.kind === 'owned-stopped') {
        await host.run('launchctl', ['bootout', service], {}).catch(() => null);
    }

    await host.fsModule.mkdir(path.dirname(paths.plistPath), {recursive: true, mode: 0o755});
    await writeFileAtomic(paths.plistPath, xml, {mode: PRIVATE_FILE_MODE, fsModule: host.fsModule});

    await host.run('launchctl', ['bootstrap', domain, paths.plistPath], {});
    await waitForListenerAndSupervisor({paths, expectedDeclaration, host, hostUid});

    await writeCustodyRecord({
        custodyPath : paths.custodyPath,
        hostUid,
        target      : input.target,
        paths,
        plistDigest : digest,
        environment : expectedDeclaration.environment,
        adoptedFrom,
        installState: 'active',
        host
    });
    await assertObservedReady({paths, target: input.target, host});

    return {
        digest,
        references: [paths.plistPath, paths.manifestPath],
        action    : inspection.kind === 'owned-upgrade'
            ? (inspection.endpointMoved ? 'rebound' : 'upgraded')
            : inspection.kind === 'owned-stopped'
                ? 'started'
                : 'installed'
    };
}

/**
 * @module ai/services/fleet/wakeReceiverCustody
 * @summary Ownership custody sidecar, LaunchAgent declaration matching, manifest validation, legacy
 * deployment corroboration, and inspection state machine for `com.neomjs.agent-os-wake`.
 */

import path                       from 'node:path';
import {loadWakeReceiverManifest} from '../../daemons/wake/receiver.mjs';
import {writeFileAtomic}          from '../shared/atomicFileWrite.mjs';
import {contentDigest}            from './setupRunRecord.mjs';
import {
    WAKE_RECEIVER_ENTRYPOINT,
    WAKE_RECEIVER_LABEL,
    extractReceiverDeclaration,
    parseLaunchAgentPlist
} from './wakeReceiverPlist.mjs';

/**
 * Custody sidecar stored inside the receiver state directory to bind a managed installation to UID + plane.
 * @type {String}
 */
export const WAKE_RECEIVER_CUSTODY_FILE = 'setup-custody.json';

/**
 * Current schema version for `setup-custody.json`.
 * @type {Number}
 */
export const WAKE_RECEIVER_CUSTODY_SCHEMA_VERSION = 1;

/**
 * Schema version of `manifest.json` accepted by `ai/daemons/wake/receiver.mjs`.
 * @type {Number}
 */
export const WAKE_RECEIVER_MANIFEST_SCHEMA_VERSION = 1;

/**
 * Owner-only directory mode for receiver state and queued wake records (`0700`).
 * @type {Number}
 */
export const PRIVATE_DIR_MODE = 0o700;

/**
 * Owner-only regular file mode for secrets, manifests, custody records, and plists (`0600`).
 * @type {Number}
 */
export const PRIVATE_FILE_MODE = 0o600;

const
    LOOPBACK_WAKE_HOSTS         = new Set(['127.0.0.1', '::1', 'localhost']),
    LAUNCHD_INTRINSIC_ENV_KEYS  = new Set(['XPC_SERVICE_NAME', 'OSLogRateLimit', 'MallocSpaceEfficient', 'ASL_DISABLE']),
    EXECUTION_OVERRIDE_PREFIXES = ['NODE_', 'DYLD_', 'LD_', 'OPENSSL_', 'SSL_', 'UV_'];

function isExecutionOverrideEnvKey(key) {
    return EXECUTION_OVERRIDE_PREFIXES.some(prefix => key.startsWith(prefix));
}

function normalizeEnvMap(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }

    const result = {};

    for (const key of Object.keys(raw).sort()) {
        if (typeof raw[key] === 'string') {
            result[key] = raw[key];
        }
    }

    return result;
}

function sameEnvMap(left, right) {
    const
        a     = normalizeEnvMap(left),
        b     = normalizeEnvMap(right),
        aKeys = Object.keys(a),
        bKeys = Object.keys(b);

    return aKeys.length === bKeys.length && aKeys.every((key, index) => key === bKeys[index] && a[key] === b[key]);
}

/**
 * @summary Resolves the integer host UID from a setup host adapter when provided.
 * @param {Object} host
 * @returns {Number|null}
 */
export function resolveHostUid(host) {
    if (typeof host?.uid === 'function') {
        const uid = host.uid();

        return Number.isInteger(uid) ? uid : null;
    }

    return Number.isInteger(host?.uid) ? host.uid : null;
}

/**
 * @summary Checks whether a filesystem `stat` UID matches the active host UID when both are known.
 * @param {Object} stat
 * @param {Number|null} hostUid
 * @returns {Boolean}
 */
export function sameOptionalUid(stat, hostUid) {
    return hostUid === null || !Number.isInteger(stat?.uid) || stat.uid === hostUid;
}

/**
 * @summary Runs `lstat` when available on `fsModule`, falling back to `stat` for minimal fixture adapters.
 * @param {Object} fsModule
 * @param {String} targetPath
 * @returns {Promise<Object>}
 */
export async function safeLstat(fsModule, targetPath) {
    if (typeof fsModule.lstat === 'function') {
        return fsModule.lstat(targetPath);
    }

    return fsModule.stat(targetPath);
}

async function readOwnedJson(filePath, fsModule, hostUid, label) {
    try {
        const stat = await safeLstat(fsModule, filePath);

        if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) {
            return {exists: true, valid: false, value: null, conflict: `refusing symbolic link for ${label} at ${filePath}`};
        }

        if (typeof stat.isFile === 'function' && !stat.isFile()) {
            return {exists: true, valid: false, value: null, conflict: `${label} at ${filePath} is not a regular file`};
        }

        if (!sameOptionalUid(stat, hostUid)) {
            return {exists: true, valid: false, value: null, conflict: `${label} at ${filePath} is owned by UID ${stat.uid}, expected ${hostUid}`};
        }

        const raw = await fsModule.readFile(filePath, 'utf8');

        return {exists: true, valid: true, value: JSON.parse(raw), conflict: null, stat};
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return {exists: false, valid: false, value: null, conflict: null};
        }

        return {exists: true, valid: false, value: null, conflict: `${label} at ${filePath} cannot be read (${error.message})`};
    }
}

async function readOwnedPlist(plistPath, fsModule, hostUid) {
    try {
        const stat = await safeLstat(fsModule, plistPath);

        if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) {
            return {exists: true, valid: false, conflict: `refusing symbolic link for LaunchAgent plist at ${plistPath}`};
        }

        if (typeof stat.isFile === 'function' && !stat.isFile()) {
            return {exists: true, valid: false, conflict: `LaunchAgent plist at ${plistPath} is not a regular file`};
        }

        if (!sameOptionalUid(stat, hostUid)) {
            return {exists: true, valid: false, conflict: `LaunchAgent plist at ${plistPath} is owned by UID ${stat.uid}, expected ${hostUid}`};
        }

        const
            xml         = await fsModule.readFile(plistPath, 'utf8'),
            parsed      = parseLaunchAgentPlist(xml, {allowComments: false}),
            declaration = extractReceiverDeclaration(parsed);

        return {exists: true, valid: true, xml, digest: contentDigest(xml), declaration, conflict: null};
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return {exists: false, valid: false, conflict: null};
        }

        return {exists: true, valid: false, conflict: `LaunchAgent plist at ${plistPath} cannot be read (${error.message})`};
    }
}

async function inspectOwnedManifest(manifestPath, fsModule, hostUid) {
    try {
        const stat = await safeLstat(fsModule, manifestPath);

        if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) {
            return {exists: true, valid: false, routeCount: 0, manifest: null, conflict: `refusing symbolic link for wake manifest at ${manifestPath}`};
        }

        if (typeof stat.isFile === 'function' && !stat.isFile()) {
            return {exists: true, valid: false, routeCount: 0, manifest: null, conflict: `wake manifest at ${manifestPath} is not a regular file`};
        }

        if (!sameOptionalUid(stat, hostUid)) {
            return {exists: true, valid: false, routeCount: 0, manifest: null, conflict: `wake manifest at ${manifestPath} is owned by UID ${stat.uid}, expected ${hostUid}`};
        }

        if (typeof stat.mode === 'number' && (stat.mode & 0o077) !== 0) {
            return {exists: true, valid: false, routeCount: 0, manifest: null, conflict: `wake manifest '${manifestPath}' must be mode 0600`};
        }

        const parsed = JSON.parse(await fsModule.readFile(manifestPath, 'utf8'));

        if (parsed?.schemaVersion === WAKE_RECEIVER_MANIFEST_SCHEMA_VERSION &&
            parsed.routes && typeof parsed.routes === 'object' && !Array.isArray(parsed.routes) &&
            Object.keys(parsed.routes).length === 0) {
            return {exists: true, valid: true, routeCount: 0, manifest: parsed, conflict: null};
        }

        const validated = await loadWakeReceiverManifest(manifestPath, {fsModule});

        return {
            exists    : true,
            valid     : true,
            routeCount: Object.keys(validated.routes).length,
            manifest  : validated,
            conflict  : null
        };
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return {exists: false, valid: false, routeCount: 0, manifest: null, conflict: null};
        }

        return {exists: true, valid: false, routeCount: 0, manifest: null, conflict: `wake manifest at ${manifestPath} failed validation (${error.message})`};
    }
}

function custodyMatchesDeployment(custody, {hostUid, target, paths}) {
    if (!custody || custody.schemaVersion !== WAKE_RECEIVER_CUSTODY_SCHEMA_VERSION || custody.label !== WAKE_RECEIVER_LABEL) {
        return 'custody record has an unrecognized schema or label';
    }

    if (hostUid !== null && Number.isInteger(custody.ownerUid) && custody.ownerUid !== hostUid) {
        return `wake receiver custody belongs to UID ${custody.ownerUid}, current UID is ${hostUid}`;
    }

    if (!target?.planeId) {
        return 'target has no bound planeId to corroborate wake receiver custody';
    }

    if (custody.planeId !== target.planeId) {
        return `wake receiver custody belongs to plane '${custody.planeId}', expected '${target.planeId}'`;
    }

    if (target.dataRoot && custody.dataRoot && custody.dataRoot !== target.dataRoot) {
        return `wake receiver custody belongs to dataRoot '${custody.dataRoot}', expected '${target.dataRoot}'`;
    }

    if (custody.stateDir !== paths.wakeStateDir || custody.manifestPath !== paths.manifestPath) {
        return `wake receiver custody points to '${custody.stateDir}', expected '${paths.wakeStateDir}'`;
    }

    if (custody.plistPath && custody.plistPath !== paths.plistPath) {
        return `wake receiver custody points to plist '${custody.plistPath}', expected '${paths.plistPath}'`;
    }

    return null;
}

function declarationMatchesTarget(declaration, paths) {
    if (!declaration || declaration.ambiguousFlags || declaration.label !== WAKE_RECEIVER_LABEL) {
        return false;
    }

    const
        expectedGenDir  = paths.runtimeGeneration?.directory ?? null,
        actualGenDir    = declaration.runtimeGenerationDir ?? null,
        sameRuntimeRoot = !paths.runtimeRoot || declaration.runtimeRoot === paths.runtimeRoot,
        sameExecutable  = !paths.executable || declaration.executable === paths.executable,
        expectedExtra   = normalizeEnvMap(paths.extraEnv),
        declaredEnv     = normalizeEnvMap(declaration.environment);

    for (const [key, value] of Object.entries(expectedExtra)) {
        if (declaredEnv[key] !== value) {
            return false;
        }
    }

    for (const key of Object.keys(declaredEnv)) {
        if (isExecutionOverrideEnvKey(key) && !Object.hasOwn(expectedExtra, key)) {
            return false;
        }
    }

    return LOOPBACK_WAKE_HOSTS.has(declaration.host) &&
        declaration.manifestPath === paths.manifestPath &&
        declaration.stateDir === paths.wakeStateDir &&
        declaration.host === paths.host &&
        declaration.port === paths.port &&
        declaration.entrypoint === WAKE_RECEIVER_ENTRYPOINT &&
        sameRuntimeRoot &&
        sameExecutable &&
        actualGenDir === expectedGenDir;
}

function declarationMatchesCustodySpec(declaration, digest, spec) {
    if (!declaration || !spec || declaration.ambiguousFlags || declaration.label !== WAKE_RECEIVER_LABEL) {
        return false;
    }

    if (!LOOPBACK_WAKE_HOSTS.has(declaration.host) || declaration.entrypoint !== WAKE_RECEIVER_ENTRYPOINT) {
        return false;
    }

    const
        expectedStateDir = spec.stateDir ?? null,
        expectedGenDir   = spec.runtimeGeneration?.directory ?? null,
        actualGenDir     = declaration.runtimeGenerationDir ?? null;

    if (spec.manifestPath && declaration.manifestPath !== spec.manifestPath) {
        return false;
    }

    if (expectedStateDir && declaration.stateDir !== expectedStateDir) {
        return false;
    }

    if (spec.host && declaration.host !== spec.host) {
        return false;
    }

    if (Number.isInteger(spec.port) && declaration.port !== spec.port) {
        return false;
    }

    if (spec.executable && declaration.executable !== spec.executable) {
        return false;
    }

    if (spec.runtimeRoot && declaration.runtimeRoot !== spec.runtimeRoot) {
        return false;
    }

    if (actualGenDir !== expectedGenDir) {
        return false;
    }

    if (spec.environment && typeof spec.environment === 'object' && !sameEnvMap(declaration.environment, spec.environment)) {
        return false;
    }

    return !spec.plistDigest || digest === spec.plistDigest;
}

function normalizeDeclarationSpec(spec) {
    if (!spec || typeof spec !== 'object') {
        return null;
    }

    return {
        executable          : spec.executable ?? null,
        runtimeRoot         : spec.runtimeRoot ?? null,
        manifestPath        : spec.manifestPath ?? null,
        stateDir            : spec.stateDir ?? spec.wakeStateDir ?? null,
        host                : spec.host ?? null,
        port                : Number.isInteger(spec.port) ? spec.port : null,
        runtimeGenerationDir: spec.runtimeGenerationDir ?? spec.runtimeGeneration?.directory ?? null,
        environment         : spec.environment && typeof spec.environment === 'object' && !Array.isArray(spec.environment)
            ? normalizeEnvMap(spec.environment)
            : {}
    };
}

function supervisorEnvironmentMatches(supervisor, expectedEnv) {
    const
        loadedEnv       = supervisor.environment,
        loadedDefault   = supervisor.defaultEnvironment,
        loadedInherited = supervisor.inheritedEnvironment;

    if (!loadedEnv || typeof loadedEnv !== 'object' || Array.isArray(loadedEnv)) {
        return false;
    }

    if (loadedEnv.XPC_SERVICE_NAME !== undefined && loadedEnv.XPC_SERVICE_NAME !== WAKE_RECEIVER_LABEL) {
        return false;
    }

    const comparableEnv = {};

    for (const [key, value] of Object.entries(loadedEnv)) {
        if (!LAUNCHD_INTRINSIC_ENV_KEYS.has(key) || Object.hasOwn(expectedEnv, key)) {
            comparableEnv[key] = value;
        }
    }

    if (!sameEnvMap(comparableEnv, expectedEnv)) {
        return false;
    }

    for (const fallbackEnv of [loadedDefault, loadedInherited]) {
        if (!fallbackEnv || typeof fallbackEnv !== 'object' || Array.isArray(fallbackEnv)) {
            continue;
        }

        for (const [key, value] of Object.entries(fallbackEnv)) {
            if (isExecutionOverrideEnvKey(key) && !Object.hasOwn(loadedEnv, key) && expectedEnv[key] !== value) {
                return false;
            }
        }
    }

    return true;
}

function declarationMatchesLoadedSpec(loadedDecl, spec, supervisor) {
    return Boolean(loadedDecl.executable) &&
        Boolean(loadedDecl.runtimeRoot) &&
        Boolean(loadedDecl.manifestPath) &&
        Boolean(loadedDecl.stateDir) &&
        Number.isInteger(loadedDecl.port) &&
        (!spec.executable || loadedDecl.executable === spec.executable) &&
        (!spec.runtimeRoot || loadedDecl.runtimeRoot === spec.runtimeRoot) &&
        (!spec.manifestPath || loadedDecl.manifestPath === spec.manifestPath) &&
        (!spec.stateDir || loadedDecl.stateDir === spec.stateDir) &&
        (!spec.host || loadedDecl.host === spec.host) &&
        (!Number.isInteger(spec.port) || loadedDecl.port === spec.port) &&
        (loadedDecl.runtimeGenerationDir ?? null) === (spec.runtimeGenerationDir ?? null) &&
        supervisorEnvironmentMatches(supervisor, spec.environment);
}

/**
 * @summary Verifies that a loaded `launchd` service matches the expected plist path, program binary,
 * working directory, receiver invocation arguments (`--manifest`, `--state-dir`, `--host`, `--port`,
 * `--neo-runtime-generation`), and effective launchd environment across `environment`, `default environment`,
 * and `inherited environment` (rejecting unmasked `NODE_OPTIONS` / preload overrides) against at least one
 * owned declaration spec before adopting, probing, or mutating supervision.
 * @param {Object|null} supervisor
 * @param {String} plistPath
 * @param {Object|Object[]} allowedSpecs
 * @returns {String|null}
 */
export function supervisorMatchesDeclaration(supervisor, plistPath, allowedSpecs) {
    if (!supervisor?.loaded) {
        return null;
    }

    if (!supervisor.plist || supervisor.plist !== plistPath) {
        return `loaded launchd service '${WAKE_RECEIVER_LABEL}' reports unproven or foreign plist '${supervisor.plist ?? '<missing>'}', expected '${plistPath}'`;
    }

    const
        specs           = (Array.isArray(allowedSpecs) ? allowedSpecs : [allowedSpecs]).map(normalizeDeclarationSpec).filter(Boolean),
        allowedPrograms = specs.map(spec => spec.executable).filter(Boolean);

    if (!supervisor.program || !allowedPrograms.includes(supervisor.program)) {
        return `loaded launchd service '${WAKE_RECEIVER_LABEL}' runs unproven or foreign program '${supervisor.program ?? '<missing>'}', expected '${allowedPrograms[0] ?? '<unknown>'}'`;
    }

    if (!Array.isArray(supervisor.arguments) || supervisor.arguments.length === 0 ||
        typeof supervisor.workingDirectory !== 'string' || supervisor.workingDirectory.length === 0) {
        return `loaded launchd service '${WAKE_RECEIVER_LABEL}' lacks proven working directory or receiver arguments`;
    }

    if (!supervisor.environment || typeof supervisor.environment !== 'object' || Array.isArray(supervisor.environment)) {
        return `loaded launchd service '${WAKE_RECEIVER_LABEL}' lacks proven launchd environment`;
    }

    const loadedDecl = extractReceiverDeclaration({
        Label           : WAKE_RECEIVER_LABEL,
        ProgramArguments: supervisor.arguments,
        WorkingDirectory: supervisor.workingDirectory
    });

    if (loadedDecl.ambiguousFlags || loadedDecl.entrypoint !== WAKE_RECEIVER_ENTRYPOINT ||
        !LOOPBACK_WAKE_HOSTS.has(loadedDecl.host) || loadedDecl.executable !== supervisor.program) {
        return `loaded launchd service '${WAKE_RECEIVER_LABEL}' declares unproven or foreign receiver arguments (${loadedDecl.entrypoint ?? '<missing>'})`;
    }

    if (!specs.some(spec => declarationMatchesLoadedSpec(loadedDecl, spec, supervisor))) {
        return `loaded launchd service '${WAKE_RECEIVER_LABEL}' runs foreign or mismatched receiver declaration or environment (runtime '${loadedDecl.runtimeRoot ?? '<missing>'}', stateDir '${loadedDecl.stateDir ?? '<missing>'}', manifest '${loadedDecl.manifestPath ?? '<missing>'}')`;
    }

    return null;
}

async function corroborateLegacyDeployment({manifest, paths, target, fsModule, hostUid}) {
    if (!target?.planeId) {
        return 'target has no bound planeId to corroborate legacy wake receiver';
    }

    if (!paths.envFile || !paths.stateRoot) {
        return 'deployment layout lacks envFile or stateRoot for legacy wake corroboration';
    }

    let envContent;

    try {
        const envStat = await safeLstat(fsModule, paths.envFile);

        if (typeof envStat.isSymbolicLink === 'function' && envStat.isSymbolicLink()) {
            return `refusing symbolic link for env carrier '${paths.envFile}' during legacy corroboration`;
        }

        if (typeof envStat.isFile === 'function' && !envStat.isFile()) {
            return `env carrier '${paths.envFile}' is not a regular file`;
        }

        if (!sameOptionalUid(envStat, hostUid)) {
            return `env carrier '${paths.envFile}' is owned by UID ${envStat.uid}, expected ${hostUid}`;
        }

        envContent = await fsModule.readFile(paths.envFile, 'utf8');
    } catch (error) {
        return `legacy wake receiver requires env carrier at ${paths.envFile} for deployment corroboration (${error.message})`;
    }

    const readEnv = key => {
        const match = envContent.match(new RegExp(`^${key}=(.+)$`, 'm'));

        return match ? match[1].trim() : null;
    };

    const planeId = readEnv('NEO_PLANE_ID');

    if (planeId !== target.planeId) {
        return `env carrier binds plane '${planeId ?? '<missing>'}', expected '${target.planeId}'`;
    }

    const dataRoot = readEnv('NEO_PLANE_DATA_ROOT');

    if (target.dataRoot && dataRoot !== target.dataRoot) {
        return `env carrier binds dataRoot '${dataRoot ?? '<missing>'}', expected '${target.dataRoot}'`;
    }

    const
        recordsHostDir     = readEnv('NEO_WAKE_RECEIVER_RECORDS_HOST_DIR'),
        expectedRecordsDir = path.join(paths.wakeStateDir, 'records');

    if (recordsHostDir && recordsHostDir !== expectedRecordsDir) {
        return `env carrier binds records directory '${recordsHostDir}', expected '${expectedRecordsDir}'`;
    }

    const entries = Object.entries(manifest?.routes ?? {});

    if (entries.length === 0) {
        return `legacy manifest at ${paths.manifestPath} has no signed seat routes`;
    }

    const normalizedStateRoot = path.normalize(paths.stateRoot);

    const assertOwnedSeatDir = async (subscriptionId, candidatePath, roleLabel) => {
        if (typeof candidatePath !== 'string' || !path.isAbsolute(candidatePath)) {
            return `legacy wake route '${subscriptionId}' carries no deployment-corroborated ${roleLabel} under '${paths.stateRoot}'`;
        }

        const normalizedSeat = path.normalize(candidatePath);

        if (normalizedSeat === normalizedStateRoot || !normalizedSeat.startsWith(`${normalizedStateRoot}${path.sep}`)) {
            return `legacy wake route '${subscriptionId}' ${roleLabel} points to '${normalizedSeat}', outside deployment state root '${normalizedStateRoot}'`;
        }

        let seatStat;

        try {
            seatStat = await safeLstat(fsModule, normalizedSeat);
        } catch (error) {
            return error?.code === 'ENOENT'
                ? `legacy wake route '${subscriptionId}' references missing seat directory '${normalizedSeat}'`
                : `legacy wake route '${subscriptionId}' cannot inspect '${normalizedSeat}' (${error.message})`;
        }

        if (typeof seatStat.isSymbolicLink === 'function' && seatStat.isSymbolicLink()) {
            return `legacy wake route '${subscriptionId}' references symbolic link '${normalizedSeat}'`;
        }

        if (typeof seatStat.isDirectory === 'function' && !seatStat.isDirectory()) {
            return `legacy wake route '${subscriptionId}' seat target '${normalizedSeat}' is not a directory`;
        }

        if (!sameOptionalUid(seatStat, hostUid)) {
            return `legacy wake route '${subscriptionId}' seat directory '${normalizedSeat}' is owned by UID ${seatStat.uid}, expected ${hostUid}`;
        }

        return null;
    };

    for (const [subscriptionId, route] of entries) {
        const
            meta    = route?.harnessTargetMetadata ?? {},
            adapter = meta.adapter ?? 'osascript';

        if (adapter === 'primary-session') {
            const
                homeError = await assertOwnedSeatDir(subscriptionId, route?.adapterConfig?.primarySession?.instanceHome, 'primarySession.instanceHome'),
                addrError = homeError ?? await assertOwnedSeatDir(subscriptionId, meta.addressType === 'userDataDir' ? meta.instanceAddress : null, 'userDataDir instanceAddress');

            if (addrError) {
                return addrError;
            }

            continue;
        }

        if (adapter === 'osascript') {
            // Only instanceAddress + addressType drive osascript delivery; ignore unused primarySession fields.
            const addrError = await assertOwnedSeatDir(subscriptionId, meta.addressType === 'userDataDir' ? meta.instanceAddress : null, 'userDataDir instanceAddress');

            if (addrError) {
                return addrError;
            }

            continue;
        }

        return `legacy wake route '${subscriptionId}' uses unsupported adapter '${adapter}' for legacy corroboration`;
    }

    return null;
}

/**
 * @summary Comprehensive inspection of LaunchAgent plist, custody sidecar, manifest routes, `launchd` state,
 * and live `/wake` HTTP listener to drive both read-only observers and guarded writes. Foreign/tampered
 * services and declarations are rejected before probing declared foreign endpoints or issuing supervisor mutations.
 * @param {Object} options
 * @param {Object} options.paths
 * @param {Object} options.target
 * @param {Object} options.host
 * @param {Function} options.inspectSupervisor
 * @param {Function} options.defaultProbeListener
 * @returns {Promise<Object>}
 */
export async function inspectWakeSetupState({paths, target, host, inspectSupervisor, defaultProbeListener}) {
    const
        fsModule = host.fsModule,
        hostUid  = resolveHostUid(host),
        probeFn  = host.probeWakeListener ?? defaultProbeListener;

    for (const candidate of [paths.wakeStateDir, paths.plistPath ? path.dirname(paths.plistPath) : null]) {
        if (!candidate) {
            continue;
        }

        try {
            const stat = await safeLstat(fsModule, candidate);

            if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) {
                return {kind: 'conflict', owned: false, conflict: `refusing symbolic link at ${candidate}`};
            }

            if (!sameOptionalUid(stat, hostUid)) {
                return {kind: 'conflict', owned: false, conflict: `refusing foreign ownership on '${candidate}' (uid ${stat.uid}, expected ${hostUid})`};
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                return {kind: 'conflict', owned: false, conflict: `${candidate} cannot be inspected (${error.message})`};
            }
        }
    }

    const
        custodyRead   = await readOwnedJson(paths.custodyPath, fsModule, hostUid, 'wake setup custody'),
        manifestCheck = await inspectOwnedManifest(paths.manifestPath, fsModule, hostUid),
        plistRead     = await readOwnedPlist(paths.plistPath, fsModule, hostUid);

    if (custodyRead.conflict) {
        return {kind: 'conflict', owned: false, conflict: custodyRead.conflict};
    }

    if (manifestCheck.conflict) {
        return {kind: 'conflict', owned: false, conflict: manifestCheck.conflict};
    }

    if (plistRead.conflict) {
        return {kind: 'conflict', owned: false, conflict: plistRead.conflict};
    }

    const supervisor = await inspectSupervisor(host, hostUid);

    if (supervisor.queryError) {
        return {kind: 'conflict', owned: false, conflict: `failed querying launchd for ${WAKE_RECEIVER_LABEL}: ${supervisor.queryError}`};
    }

    if (custodyRead.exists) {
        const
            custody      = custodyRead.value,
            custodyError = custodyMatchesDeployment(custody, {hostUid, target, paths});

        if (custodyError) {
            return {kind: 'conflict', owned: false, conflict: custodyError, supervisor, plistRead, manifestCheck, custodyRead};
        }

        if (plistRead.exists) {
            const
                d             = plistRead.declaration,
                matchesActive = declarationMatchesCustodySpec(d, plistRead.digest, custody),
                matchesPrev   = custody.installState === 'installing' &&
                    Boolean(custody.previousOwned) &&
                    declarationMatchesCustodySpec(d, plistRead.digest, {...custody.previousOwned, manifestPath: custody.manifestPath, stateDir: custody.stateDir});

            if (!matchesActive && !matchesPrev) {
                return {
                    kind    : 'conflict',
                    owned   : false,
                    conflict: `LaunchAgent at ${paths.plistPath} diverges from owned custody record (${custody.plistDigest ?? '<missing>'} vs ${plistRead.digest})`,
                    supervisor, plistRead, manifestCheck, custodyRead
                };
            }

            const allowedSpecs = [
                d,
                ...(custody.installState === 'installing' && custody.previousOwned
                    ? [{
                        ...custody.previousOwned,
                        manifestPath: custody.previousOwned.manifestPath ?? custody.manifestPath,
                        stateDir    : custody.previousOwned.stateDir ?? custody.stateDir,
                        environment : custody.previousOwned.environment ?? d.environment
                    }]
                    : [])
            ];
            const supervisorError = supervisorMatchesDeclaration(supervisor, paths.plistPath, allowedSpecs);

            if (supervisorError) {
                return {kind: 'conflict', owned: false, conflict: supervisorError, supervisor, plistRead, manifestCheck, custodyRead};
            }

            const
                activeListener  = await probeFn({host: d.host, port: d.port}),
                desiredListener = (d.host === paths.host && d.port === paths.port)
                    ? activeListener
                    : await probeFn({host: paths.host, port: paths.port});

            if (!declarationMatchesTarget(d, paths)) {
                const endpointMoved = d.host !== paths.host || d.port !== paths.port;

                if (endpointMoved && desiredListener.listening) {
                    return {
                        kind    : 'conflict',
                        owned   : true,
                        conflict: desiredListener.reason ?? `target endpoint ${paths.host}:${paths.port} is already occupied`,
                        supervisor, plistRead, manifestCheck, custodyRead
                    };
                }

                if (!endpointMoved && activeListener.listening && !activeListener.wakeReceiver) {
                    return {
                        kind    : 'conflict',
                        owned   : true,
                        conflict: activeListener.reason ?? `foreign listener occupies ${d.host}:${d.port}`,
                        supervisor, plistRead, manifestCheck, custodyRead
                    };
                }

                return {
                    kind : 'owned-upgrade',
                    owned: true,
                    endpointMoved,
                    supervisor, plistRead, manifestCheck, custodyRead, activeListener, desiredListener
                };
            }

            if (!supervisor.loaded || !supervisor.running || !activeListener.wakeReceiver) {
                if (activeListener.listening && !activeListener.wakeReceiver) {
                    return {
                        kind    : 'conflict',
                        owned   : true,
                        conflict: activeListener.reason ?? `foreign listener occupies ${d.host}:${d.port}`,
                        supervisor, plistRead, manifestCheck, custodyRead
                    };
                }

                return {kind: 'owned-stopped', owned: true, supervisor, plistRead, manifestCheck, custodyRead, activeListener};
            }

            if (custody.installState === 'installing') {
                return {kind: 'owned-installing-ready', owned: true, supervisor, plistRead, manifestCheck, custodyRead, activeListener};
            }

            return {kind: 'owned-running', owned: true, supervisor, plistRead, manifestCheck, custodyRead, activeListener};
        }

        if (supervisor.loaded) {
            return {
                kind    : 'conflict',
                owned   : false,
                conflict: `loaded launchd service '${WAKE_RECEIVER_LABEL}' exists without owned plist '${paths.plistPath}'`,
                supervisor, plistRead, manifestCheck, custodyRead
            };
        }

        const desiredListener = await probeFn({host: paths.host, port: paths.port});

        if (desiredListener.listening) {
            return {
                kind    : 'conflict',
                owned   : true,
                conflict: desiredListener.reason ?? `port ${paths.host}:${paths.port} is already occupied before wake receiver bootstrap`,
                supervisor, plistRead, manifestCheck, custodyRead
            };
        }

        return {kind: 'owned-absent', owned: true, supervisor, plistRead, manifestCheck, custodyRead, desiredListener};
    }

    // No custody sidecar: either clean absent host, corroborated legacy install, or an unproven/foreign service.
    if (!plistRead.exists && !supervisor.loaded) {
        const desiredListener = await probeFn({host: paths.host, port: paths.port});

        if (desiredListener.listening) {
            return {
                kind    : 'conflict',
                owned   : false,
                conflict: desiredListener.reason ?? `foreign listener already occupies ${paths.host}:${paths.port}`,
                supervisor, plistRead, manifestCheck, custodyRead
            };
        }

        return {kind: 'absent', owned: false, supervisor, plistRead, manifestCheck, custodyRead, desiredListener};
    }

    if (!plistRead.exists && supervisor.loaded) {
        return {
            kind    : 'conflict',
            owned   : false,
            conflict: `foreign launchd service '${WAKE_RECEIVER_LABEL}' is loaded without an owned LaunchAgent plist at ${paths.plistPath}`,
            supervisor, plistRead, manifestCheck, custodyRead
        };
    }

    const d = plistRead.declaration;

    // Corroborate plist target, supervisor program/plist, manifest validation, and deployment/routes BEFORE HTTP probing.
    if (!declarationMatchesTarget(d, paths)) {
        return {
            kind    : 'conflict',
            owned   : false,
            conflict: `foreign LaunchAgent '${WAKE_RECEIVER_LABEL}' at ${paths.plistPath} declares non-matching runtime, stateDir, or endpoint`,
            supervisor, plistRead, manifestCheck, custodyRead
        };
    }

    if (!supervisor.loaded || !supervisor.running) {
        return {
            kind    : 'conflict',
            owned   : false,
            conflict: `uncorroborated legacy LaunchAgent '${WAKE_RECEIVER_LABEL}' at ${paths.plistPath} is stopped or lacks custody proof`,
            supervisor, plistRead, manifestCheck, custodyRead
        };
    }

    const supervisorError = supervisorMatchesDeclaration(supervisor, paths.plistPath, d);

    if (supervisorError) {
        return {kind: 'conflict', owned: false, conflict: supervisorError, supervisor, plistRead, manifestCheck, custodyRead};
    }

    if (!manifestCheck.exists || manifestCheck.routeCount === 0) {
        return {
            kind    : 'conflict',
            owned   : false,
            conflict: `uncorroborated legacy LaunchAgent at ${paths.plistPath} has no signed seat routes in ${paths.manifestPath}; refusing automatic takeover`,
            supervisor, plistRead, manifestCheck, custodyRead
        };
    }

    const legacyError = await corroborateLegacyDeployment({
        manifest: manifestCheck.manifest,
        paths,
        target,
        fsModule,
        hostUid
    });

    if (legacyError) {
        return {kind: 'conflict', owned: false, conflict: legacyError, supervisor, plistRead, manifestCheck, custodyRead};
    }

    const activeListener = await probeFn({host: paths.host, port: paths.port});

    if (!activeListener.wakeReceiver) {
        return {
            kind    : 'conflict',
            owned   : false,
            conflict: activeListener.reason ?? `uncorroborated legacy LaunchAgent at ${paths.plistPath} is not answering on ${paths.host}:${paths.port}`,
            supervisor, plistRead, manifestCheck, custodyRead
        };
    }

    return {kind: 'corroborated-legacy', owned: false, supervisor, plistRead, manifestCheck, custodyRead, activeListener};
}

/**
 * @summary Atomically persists the setup custody sidecar (`0600`) binding the managed wake receiver
 * installation to UID, deployment `planeId`/`dataRoot`, plist digest, executable/runtime generation,
 * and lifecycle `installState` (`'installing'` | `'active'`).
 * @param {Object} options
 * @param {String} options.custodyPath
 * @param {Number|null} options.hostUid
 * @param {Object} options.target
 * @param {Object} options.paths
 * @param {String} options.plistDigest
 * @param {String} options.adoptedFrom
 * @param {String} [options.installState='active']
 * @param {Object|null} [options.previousOwned=null]
 * @param {Object} options.host
 * @returns {Promise<void>}
 */
export function writeCustodyRecord({
    custodyPath,
    hostUid,
    target,
    paths,
    plistDigest,
    environment = null,
    adoptedFrom,
    installState = 'active',
    previousOwned = null,
    host
}) {
    const custody = {
        schemaVersion    : WAKE_RECEIVER_CUSTODY_SCHEMA_VERSION,
        label            : WAKE_RECEIVER_LABEL,
        ownerUid         : hostUid,
        planeId          : target.planeId,
        dataRoot         : target.dataRoot ?? null,
        plistPath        : paths.plistPath,
        manifestPath     : paths.manifestPath,
        stateDir         : paths.wakeStateDir,
        host             : paths.host,
        port             : paths.port,
        executable       : paths.executable,
        runtimeRoot      : paths.runtimeRoot,
        runtimeGeneration: paths.runtimeGeneration,
        environment      : environment ? normalizeEnvMap(environment) : null,
        plistDigest,
        installState,
        ...(previousOwned ? {previousOwned} : {}),
        adoptedFrom,
        updatedAt        : new Date(host.now()).toISOString()
    };

    return host.fsModule.mkdir(path.dirname(custodyPath), {recursive: true, mode: PRIVATE_DIR_MODE})
        .then(() => writeFileAtomic(custodyPath, `${JSON.stringify(custody, null, 2)}\n`, {mode: PRIVATE_FILE_MODE, fsModule: host.fsModule}));
}

/**
 * @summary Extracts the comparable prior-generation declaration fields from an active custody record
 * so interrupted upgrades can distinguish their previous owned binary/digest from foreign services.
 * @param {Object|null} custody
 * @returns {Object|null}
 */
export function summarizeOwnedCustodySpec(custody) {
    if (!custody) {
        return null;
    }

    return {
        plistDigest      : custody.plistDigest ?? null,
        executable       : custody.executable ?? null,
        runtimeRoot      : custody.runtimeRoot ?? null,
        runtimeGeneration: custody.runtimeGeneration ?? null,
        manifestPath     : custody.manifestPath ?? null,
        stateDir         : custody.stateDir ?? null,
        host             : custody.host ?? null,
        port             : custody.port ?? null,
        environment      : custody.environment ?? null
    };
}

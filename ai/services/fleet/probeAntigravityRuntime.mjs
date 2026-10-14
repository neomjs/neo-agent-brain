import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const
    // Electron virtualizes app.asar as a directory; this probe needs the physical bundle bytes.
    bundleFs = process.versions.electron ? createRequire(import.meta.url)('original-fs') : fs,
    PLIST_BUDDY = '/usr/libexec/PlistBuddy',
    LSOF = '/usr/sbin/lsof',
    PS = '/bin/ps',
    ACTIVE_PORT_FILE = 'DevToolsActivePort',
    BROWSER_PATH = /^\/devtools\/browser\/[A-Za-z0-9_-]+$/,
    PROCESS_CHAIN_LIMIT = 16,
    PROCESS_QUERY_TIMEOUT_MS = 200,
    MAX_HASH_BYTES = 512 * 1024 * 1024;

/**
 * @summary The measured Antigravity build whose profile anchor and workspace MCP loading were witnessed natively.
 * Every field is required: version text alone does not establish the private launch contracts.
 * Re-measure and review this tuple after an Antigravity update before admitting another build.
 * @type {Readonly<Object>}
 */
export const ANTIGRAVITY_RUNTIME_FINGERPRINT = Object.freeze({
    platform: 'darwin',
    architecture: 'arm64',
    bundleId: 'com.google.antigravity',
    shortVersion: '2.23.0',
    buildVersion: '2.23.0',
    appAsarSha256: '4e99093662d797ecba823e92823d352413e3bf2ca721257df4a255c045df1598',
    languageServerSha256: 'c1dd0c9940f712adf2185e756470752d5f5afee15441e32879e4a0f127e18273'
});

/**
 * @summary Compare measured bundle identity and physical content to the one native-proven build.
 * The function is pure so unknown platform, app identity, version, or changed bytes fail closed
 * without requiring Electron, an installed app, credentials, a process launch, or a network call.
 * @param {Object} actual Fingerprint fields collected from the selected installed bundle.
 * @returns {{available: Boolean, reason: String|null}}
 */
export function classifyAntigravityRuntimeFingerprint(actual = {}) {
    if (actual.platform !== ANTIGRAVITY_RUNTIME_FINGERPRINT.platform ||
        actual.architecture !== ANTIGRAVITY_RUNTIME_FINGERPRINT.architecture) {
        return unavailable('unsupported-platform-or-architecture')
    }

    if (actual.bundleId !== ANTIGRAVITY_RUNTIME_FINGERPRINT.bundleId) {
        return unavailable('unsupported-bundle-identity')
    }

    if (actual.shortVersion !== ANTIGRAVITY_RUNTIME_FINGERPRINT.shortVersion ||
        actual.buildVersion !== ANTIGRAVITY_RUNTIME_FINGERPRINT.buildVersion) {
        return unavailable('unsupported-app-version')
    }

    if (actual.appAsarSha256 !== ANTIGRAVITY_RUNTIME_FINGERPRINT.appAsarSha256) {
        return unavailable('app-asar-fingerprint-mismatch')
    }

    if (actual.languageServerSha256 !== ANTIGRAVITY_RUNTIME_FINGERPRINT.languageServerSha256) {
        return unavailable('language-server-fingerprint-mismatch')
    }

    return {available: true, reason: null}
}

/**
 * @summary Probe the config-selected Antigravity main binary and stream-hash its app code and MCP runtime.
 * A positive result is scoped to the measured macOS arm64 2.23.0 bundle above; an update, unknown
 * build, missing file, alternate path shape, or hash mismatch refuses. Native receipts establish
 * this build's profile anchor and workspace MCP loading. This fingerprint does not prove the
 * candidate CDP route or listener behavior, Fleet admission, hooks, wake delivery, or a usable
 * managed session.
 * @param {Object} options
 * @param {String} options.selectedBinaryPath Explicit binary already resolved by the caller's harness selection.
 * @param {Object} [options.fsImpl] Physical fs reader; defaults to Electron `original-fs` or Node fs.
 * @param {String} [options.platform] Platform seam for deterministic classification.
 * @param {String} [options.architecture] Architecture seam for deterministic classification.
 * @param {Function} [options.readBundleMetadata] `(Info.plist) => {bundleId, shortVersion, buildVersion}`.
 * @param {Function} [options.hashFile] Async streaming `(path, fsImpl) => sha256` seam.
 * @returns {Promise<Object>} Safe capability posture and selected bundle paths/fingerprints.
 */
export async function probeAntigravityRuntime({
    selectedBinaryPath,
    fsImpl = bundleFs,
    platform = process.platform,
    architecture = process.arch,
    readBundleMetadata = readPlistMetadata,
    hashFile = hashFileSha256
} = {}) {
    if (typeof selectedBinaryPath !== 'string' || !path.isAbsolute(selectedBinaryPath)) {
        return unavailable('selected-binary-path-must-be-absolute')
    }

    if (platform !== ANTIGRAVITY_RUNTIME_FINGERPRINT.platform ||
        architecture !== ANTIGRAVITY_RUNTIME_FINGERPRINT.architecture) {
        return unavailable('unsupported-platform-or-architecture')
    }

    let binaryPath;

    try {
        binaryPath = fsImpl.realpathSync(selectedBinaryPath);
        assertFile(fsImpl, binaryPath, true);
    } catch {
        return unavailable('selected-binary-unavailable')
    }

    const macos = path.dirname(binaryPath), contents = path.dirname(macos);

    if (path.basename(macos) !== 'MacOS' || path.basename(contents) !== 'Contents' ||
        path.basename(binaryPath) !== 'Antigravity') {
        return unavailable('selected-binary-is-not-antigravity-app-main', {binaryPath})
    }

    const
        appBundle = path.dirname(contents),
        infoPlist = path.join(contents, 'Info.plist'),
        appAsar = path.join(contents, 'Resources', 'app.asar'),
        languageServer = path.join(contents, 'Resources', 'bin', 'language_server');

    let metadata, appAsarSha256, languageServerSha256;

    try {
        metadata = readBundleMetadata(infoPlist);
        assertFile(fsImpl, appAsar);
        assertFile(fsImpl, languageServer, true);

        [appAsarSha256, languageServerSha256] = await Promise.all([
            hashFile(appAsar, fsImpl),
            hashFile(languageServer, fsImpl)
        ]);
    } catch {
        return unavailable('required-app-resource-or-fingerprint-unavailable', {binaryPath, appBundle})
    }

    const fingerprints = {
        platform,
        architecture,
        bundleId: metadata?.bundleId,
        shortVersion: metadata?.shortVersion,
        buildVersion: metadata?.buildVersion,
        appAsarSha256,
        languageServerSha256
    };
    const classification = classifyAntigravityRuntimeFingerprint(fingerprints);

    return {
        ...classification,
        binaryPath,
        appBundle,
        appAsar,
        languageServer,
        fingerprints
    }
}

/**
 * @summary Prove one profile's active CDP port belongs to the caller's original Start process tree.
 * The probe reads only that profile's DevToolsActivePort, queries lsof for that exact TCP port, then
 * walks parent PID + process-birth observations from its sole listener to the supplied Start PID.
 * It repeats the endpoint, listener and ancestry reads before returning, so PID reuse, a reparented
 * renderer, an unrelated listener, or an unobservable process refuses. It never reads command lines,
 * process environments, or port-file content beyond the bounded endpoint record.
 * @param {Object} options
 * @param {String} options.profileDirectory The exact app-owned userData profile for this Start.
 * @param {Number} options.port The port parsed by the calling project-binding flow.
 * @param {String} options.browserPath The browser endpoint parsed by the calling project-binding flow.
 * @param {{pid: Number, startedAt: String}} options.expectedProcess Original Start PID and its `pidStartedAt`
 *     birth token from the lifecycle lease. This is the `ps` birth string, not the status `startedAt` wall clock.
 * @param {Object} [options.fileSystem] Physical filesystem reader for the profile endpoint.
 * @param {Function} [options.execFileImpl] Injectable shell-free process-inspection command runner.
 * @returns {{verified: Boolean, processTreeVerified: Boolean, profileDirectory: String,
 *            port: Number, browserPath: String, pid: Number|null, startedAt: String|null}}
 */
export function verifyAntigravityProfileListener({
    profileDirectory,
    port,
    browserPath,
    expectedProcess,
    fileSystem = bundleFs,
    execFileImpl = execFileSync
} = {}) {
    const
        profile = typeof profileDirectory === 'string' && path.isAbsolute(profileDirectory) ? path.resolve(profileDirectory) : '',
        pid = expectedProcess?.pid,
        startedAt = expectedProcess?.startedAt,
        proof = {
            verified: false,
            processTreeVerified: false,
            profileDirectory: profile,
            port,
            browserPath,
            pid: Number.isSafeInteger(pid) ? pid : null,
            startedAt: typeof startedAt === 'string' ? startedAt : null
        };

    if (!profile || !Number.isSafeInteger(port) || port < 1 || port > 65535 ||
        typeof browserPath !== 'string' || !BROWSER_PATH.test(browserPath) ||
        !Number.isSafeInteger(pid) || pid < 1 || typeof startedAt !== 'string' || !startedAt.trim() ||
        !fileSystem || typeof execFileImpl !== 'function') {
        return proof
    }

    try {
        const firstEndpoint = readProfileEndpoint(fileSystem, profile);
        if (firstEndpoint.port !== port || firstEndpoint.browserPath !== browserPath) return proof;

        const firstListeners = readListenerPids(port, execFileImpl);
        if (firstListeners.length !== 1) return proof;

        const firstChain = readProcessChain(firstListeners[0], {pid, startedAt}, execFileImpl);
        if (!firstChain) return proof;

        const secondEndpoint = readProfileEndpoint(fileSystem, profile);
        if (secondEndpoint.port !== firstEndpoint.port || secondEndpoint.browserPath !== firstEndpoint.browserPath) return proof;

        const secondListeners = readListenerPids(port, execFileImpl);
        if (secondListeners.length !== 1 || secondListeners[0] !== firstListeners[0]) return proof;

        const secondChain = readProcessChain(secondListeners[0], {pid, startedAt}, execFileImpl);
        if (!secondChain || !sameProcessChain(firstChain, secondChain)) return proof;

        return {...proof, verified: true, processTreeVerified: true}
    } catch {
        // A missing tool, denied process table, malformed endpoint, or timeout is not ownership proof.
        return proof
    }
}

/** @summary Read the exact profile's small endpoint file without following links or accepting extra content. */
function readProfileEndpoint(fileSystem, profile) {
    const
        profileStat = fileSystem.lstatSync(profile),
        endpointPath = path.join(profile, ACTIVE_PORT_FILE),
        endpointStat = fileSystem.lstatSync(endpointPath);

    if (!profileStat.isDirectory() || profileStat.isSymbolicLink() || !endpointStat.isFile() ||
        endpointStat.isSymbolicLink() || endpointStat.size > 512) {
        throw new Error('profile endpoint is not a bounded regular file')
    }

    const lines = String(fileSystem.readFileSync(endpointPath, 'utf8')).split('\n');

    if (lines.length !== 2 || !/^[1-9]\d{0,4}$/.test(lines[0]) || !BROWSER_PATH.test(lines[1])) {
        throw new Error('profile endpoint is malformed')
    }

    const parsedPort = Number(lines[0]);
    if (parsedPort > 65535) throw new Error('profile endpoint port is invalid');

    return {port: parsedPort, browserPath: lines[1]}
}

/** @summary Query lsof for LISTEN rows on one port only and return unique PIDs, without command names. */
function readListenerPids(port, execFileImpl) {
    let output;

    try {
        output = execFileImpl(LSOF, ['-nP', '-a', '-iTCP:' + port, '-sTCP:LISTEN', '-Fp'], processQueryOptions());
    } catch (error) {
        if (error?.status === 1) return [];
        throw error
    }

    const lines = String(output).split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];

    const pids = [];
    let currentPid = null, descriptorCount = 0;

    for (const line of lines) {
        if (/^p[1-9]\d*$/.test(line)) {
            if (currentPid !== null && descriptorCount === 0) throw new Error('listener PID record has no file descriptor');
            currentPid = Number(line.slice(1));
            if (!Number.isSafeInteger(currentPid)) throw new Error('listener PID is invalid');
            pids.push(currentPid);
            descriptorCount = 0
        } else if (/^f\d+[A-Za-z]*$/.test(line) && currentPid !== null) {
            descriptorCount++
        } else {
            throw new Error('listener PID output is ambiguous')
        }
    }

    if (descriptorCount === 0) throw new Error('listener PID record has no file descriptor');

    return [...new Set(pids)]
}

/** @summary Walk only the listener's bounded ancestor chain to the exact Start PID/birth. */
function readProcessChain(listenerPid, expected, execFileImpl) {
    const chain = [];
    let pid = listenerPid;

    for (let depth = 0; depth < PROCESS_CHAIN_LIMIT; depth++) {
        const process = readProcessIdentity(pid, execFileImpl);
        if (!process || process.exited) return null;
        chain.push(process);

        if (pid === expected.pid) return process.startedAt === expected.startedAt ? chain : null;
        if (!Number.isSafeInteger(process.parentPid) || process.parentPid < 1 || process.parentPid === pid) return null;
        pid = process.parentPid
    }

    return null
}

/** @summary Read only PPID, state and lstart; command line and environment are never requested. */
function readProcessIdentity(pid, execFileImpl) {
    let output;

    try {
        output = String(execFileImpl(PS, ['-p', String(pid), '-o', 'ppid=', '-o', 'stat=', '-o', 'lstart='], processQueryOptions())).trim();
    } catch {
        return null
    }

    const [parentPid, state, ...birthTokens] = output.split(/\s+/);
    const startedAt = birthTokens.join(' ');
    if (!/^\d+$/.test(parentPid || '') || !state || !startedAt) return null;

    return {
        pid,
        parentPid: Number(parentPid),
        exited: state.startsWith('Z'),
        startedAt
    }
}

/** @summary Compare re-read process births and parent edges, not just the root PID. */
function sameProcessChain(first, second) {
    return first.length === second.length && first.every((process, index) => {
        const again = second[index];
        return process.pid === again.pid && process.parentPid === again.parentPid &&
            process.exited === again.exited && process.startedAt === again.startedAt
    })
}

/** @summary Keep process inspection independent of inherited credentials and locale. */
function processQueryOptions() {
    return {
        encoding: 'utf8',
        timeout: PROCESS_QUERY_TIMEOUT_MS,
        maxBuffer: 4096,
        env: {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', TZ: 'UTC'}
    }
}

/** @summary Read only the three bundle identity fields used by this probe, without invoking a shell. */
function readPlistMetadata(infoPlist) {
    const read = key => execFileSync(PLIST_BUDDY, ['-c', `Print :${key}`, infoPlist], {
        encoding: 'utf8',
        maxBuffer: 4096,
        timeout: 2000
    }).trim();

    return {
        bundleId: read('CFBundleIdentifier'),
        shortVersion: read('CFBundleShortVersionString'),
        buildVersion: read('CFBundleVersion')
    }
}

/** @summary Stream a physical file into SHA-256 without buffering its contents in memory. */
async function hashFileSha256(filePath, fsImpl) {
    const hash = createHash('sha256');
    let bytes = 0;

    for await (const chunk of fsImpl.createReadStream(filePath)) {
        bytes += chunk.length;
        if (bytes > MAX_HASH_BYTES) throw new Error('fingerprint input exceeds the bounded file size');
        hash.update(chunk)
    }

    return hash.digest('hex')
}

/** @summary Require one readable regular file and, when requested, an executable mode bit. */
function assertFile(fsImpl, filePath, executable = false) {
    const stats = fsImpl.statSync(filePath);

    if (!stats.isFile() || executable && (stats.mode & 0o111) === 0) {
        throw new Error('selected bundle resource is not an executable regular file')
    }
}

/** @summary Return a stable refusal shape without exposing subprocess output or file contents. */
function unavailable(reason, extra = {}) {
    return {available: false, reason, binaryPath: extra.binaryPath ?? null, appBundle: extra.appBundle ?? null}
}

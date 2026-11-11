import {spawnSync}                     from 'node:child_process';
import {createHash, randomUUID}        from 'node:crypto';
import nodeFs                          from 'node:fs';
import {createRequire}                 from 'node:module';
import path                            from 'node:path';
import {writeFileAtomicSync}           from '../shared/atomicFileWrite.mjs';
import {readClaudeDesktopUpdatePolicy} from './claudeDesktopUpdatePolicy.mjs';
import {probeCodexDesktopCapabilities} from './manageCodexDesktopRuntime.mjs';
import {probeAntigravityRuntime}       from './probeAntigravityRuntime.mjs';
import {probeClaudeDesktopRuntime}     from './probeClaudeDesktopRuntime.mjs';

/**
 * @module ai/services/fleet/harnessGeneration
 * @summary Immutable, admitted copies of vendor GUI harness builds — the vendor-bundle sibling of
 * `runtimeGeneration.mjs`. A seat that launches a generation never shares a mutable
 * bundle with an updater, and a build that fails admission never replaces the selected one.
 * The Fleet service is the store's only writer; runs for one family are serialized in-process.
 */

// Bundle bytes are data: Electron's ASAR view must not turn a copied app.asar into a directory.
const fs = process.versions.electron ? createRequire(import.meta.url)('original-fs') : nodeFs;

const
    LEDGER         = 'ledger.json',
    LEDGER_VERSION = 1,
    MAX_REJECTIONS = 20,
    STAGING_PREFIX = '.staging-',
    PLIST_BUDDY    = '/usr/libexec/PlistBuddy',
    chains         = new Map();

/**
 * Vendor identity per GUI harness family. Bundle id and Team ID pin WHO built a candidate, never
 * WHICH build, so every new vendor version stays admissible without a Fleet release.
 */
export const HARNESS_GENERATION_FAMILIES = Object.freeze({
    'antigravity'   : Object.freeze({bundleId: 'com.google.antigravity',         teamId: 'EQHXZ8M8AV'}),
    'claude-desktop': Object.freeze({bundleId: 'com.anthropic.claudefordesktop', teamId: 'Q6L2SF6YDW'}),
    'codex-desktop' : Object.freeze({bundleId: 'com.openai.codex',               teamId: '2DC432GLL2'})
});

// The capability contract each family's seats depend on, run against the copy. A family without
// one is refused rather than admitted on its signature alone.
const FAMILY_PROBES = {
    'antigravity'   : ({binaryPath}) => probeAntigravityRuntime({selectedBinaryPath: binaryPath}),
    'claude-desktop': ({binaryPath}) => probeClaudeDesktopRuntime({binaryPath}),
    'codex-desktop' : ({binaryPath}) => probeCodexDesktopCapabilities({binaryPath})
};

// What the host must hold before a family's seats may run its generations, as `(seams) => {inForce, reason}`.
// Claude Desktop's updater has no per-seat switch, only a machine policy the operator installs once.
const FAMILY_HOST_GATES = {
    'claude-desktop': readClaudeDesktopUpdatePolicy
};

/** @summary A named refusal for invalid arguments or an unreadable store. */
function refusal(code, detail = '') {
    return Object.assign(new Error(`harnessGeneration: ${code}${detail ? ` — ${detail}` : ''}`), {code})
}

/** @summary A path segment taken from bundle metadata or the ledger must name one entry, never a route. */
function isPlainName(value) {
    return typeof value === 'string' && value.length > 0 && path.basename(value) === value && value !== '..' && value !== '.'
}

/** @summary Runs one host tool without a shell; a missing tool reads as a failed status. */
function run(command, args) {
    const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10 * 60 * 1000});
    return {status: result.error ? null : result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? ''}
}

/** macOS host tools behind each admission step; tests replace them per call. */
const HOST_SEAMS = Object.freeze({
    copyBundle(source, target) {
        // An APFS clone is instant and shares blocks until the vendor replaces the source;
        // ditto is the cross-volume fallback and also preserves the bundle's metadata.
        if (run('/bin/cp', ['-c', '-R', source, target]).status === 0) return;
        fs.rmSync(target, {recursive: true, force: true});
        const copied = run('/usr/bin/ditto', [source, target]);
        if (copied.status !== 0) throw refusal('copy-failed', copied.stderr.trim())
    },
    readBundleInfo(appBundle) {
        const
            plist = path.join(appBundle, 'Contents', 'Info.plist'),
            read  = key => run(PLIST_BUDDY, ['-c', `Print :${key}`, plist]).stdout.trim();

        return {
            bundleId    : read('CFBundleIdentifier'),
            shortVersion: read('CFBundleShortVersionString'),
            buildVersion: read('CFBundleVersion'),
            executable  : read('CFBundleExecutable')
        }
    },
    inspectSignature(appBundle) {
        const details = run('/usr/bin/codesign', ['-dvvv', appBundle]).stderr;

        return {
            verified: run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appBundle]).status === 0,
            teamId  : details.match(/^TeamIdentifier=(\S+)$/m)?.[1] ?? null,
            cdhash  : details.match(/^CandidateCDHashFull sha256=([a-f0-9]{64})$/m)?.[1] ??
                      details.match(/^CDHash=([a-f0-9]{40,64})$/m)?.[1] ?? null
        }
    },
    assessGatekeeper(appBundle) {
        return run('/usr/sbin/spctl', ['--assess', '--type', 'execute', appBundle]).status === 0
    }
});

/**
 * @summary The generation id: SHA-256 of the JSON array `[bundleId, shortVersion, buildVersion, cdhash]`.
 * Location and staging time are not identity. The cdhash seals the signed contents, so one id can
 * never name two different payloads that both pass `codesign --verify --deep --strict`.
 * @param {Object} identity
 * @param {String} identity.bundleId
 * @param {String} identity.shortVersion
 * @param {String} identity.buildVersion
 * @param {String} identity.cdhash Hex code-directory hash of the main executable.
 * @returns {String} 64 hex characters.
 * @throws {Error} `identity-invalid` when a field is empty or the cdhash is not hex.
 */
export function harnessGenerationId({bundleId, shortVersion, buildVersion, cdhash} = {}) {
    const identity = [bundleId, shortVersion, buildVersion, cdhash];

    if (identity.some(value => typeof value !== 'string' || !value.trim()) || !/^[a-f0-9]{40,64}$/.test(cdhash)) {
        throw refusal('identity-invalid')
    }

    return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

/** @summary Validates the arguments every entry point shares. */
function familyDirectory(root, family) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw refusal('root-must-be-absolute');
    if (!Object.hasOwn(HARNESS_GENERATION_FAMILIES, family)) throw refusal('unknown-family', String(family));
    return path.join(root, family)
}

/** @summary Reads one family's ledger; a missing ledger is empty, a malformed one refuses. */
function readLedger(directory) {
    let source;

    try {
        source = fs.readFileSync(path.join(directory, LEDGER), 'utf8')
    } catch (error) {
        if (error.code === 'ENOENT') return {version: LEDGER_VERSION, admitted: [], rejected: []};
        throw error
    }

    let ledger;

    try {
        ledger = JSON.parse(source)
    } catch {
        throw refusal('ledger-invalid', directory)
    }

    if (ledger?.version !== LEDGER_VERSION || !Array.isArray(ledger.admitted) || !Array.isArray(ledger.rejected) ||
        !ledger.admitted.every(entry => /^[a-f0-9]{64}$/.test(entry?.id) && isPlainName(entry.appName) && isPlainName(entry.executable))) {
        throw refusal('ledger-invalid', directory)
    }

    return ledger
}

/**
 * @summary Reads one family's generation ledger (`{version, admitted, rejected}`), returning
 * an empty ledger when absent and throwing `ledger-invalid` when malformed.
 * @param {Object} options
 * @param {String} options.root Absolute store root.
 * @param {String} options.family A key of {@link HARNESS_GENERATION_FAMILIES}.
 * @returns {{version: Number, admitted: Object[], rejected: Object[]}}
 * @throws {Error} `root-must-be-absolute`, `unknown-family`, or `ledger-invalid`.
 */
export function readHarnessGenerationLedger({root, family} = {}) {
    const ledger = readLedger(familyDirectory(root, family));

    return {
        version : ledger.version,
        admitted: ledger.admitted.map(entry => ({...entry})),
        rejected: ledger.rejected.map(entry => ({...entry}))
    }
}

/**
 * @summary The family's admitted generations whose copy is present, newest admission first, each with
 * the paths derived from the store root and its ledger entry. A seat that runs any of them is a seat
 * of this family, whichever one is selected now.
 * @param {Object} options
 * @param {String} options.root Absolute store root.
 * @param {String} options.family A key of {@link HARNESS_GENERATION_FAMILIES}.
 * @returns {Array<{id: String, appBundle: String, binaryPath: String, shortVersion: String, buildVersion: String}>}
 */
export function listHarnessGenerations({root, family} = {}) {
    const directory = familyDirectory(root, family);

    return [...readLedger(directory).admitted].reverse().map(entry => {
        const appBundle = path.join(directory, entry.id, entry.appName);

        return {id: entry.id, appBundle, binaryPath: path.join(appBundle, 'Contents', 'MacOS', entry.executable),
            shortVersion: entry.shortVersion, buildVersion: entry.buildVersion}
    }).filter(generation => fs.existsSync(generation.binaryPath))
}

/**
 * @summary The family's selected generation: the most recently admitted build whose copy is present.
 * Re-admitting a known build never reorders the ledger, so an older bundle seen again (for example
 * the untouched `/Applications` copy) cannot displace a newer admitted one.
 * @param {Object} options
 * @param {String} options.root Absolute store root.
 * @param {String} options.family A key of {@link HARNESS_GENERATION_FAMILIES}.
 * @returns {{id: String, appBundle: String, binaryPath: String, shortVersion: String, buildVersion: String}|null}
 */
export function selectHarnessGeneration({root, family} = {}) {
    return listHarnessGenerations({root, family})[0] ?? null
}

/**
 * @summary Whether this host lets a family's seats run its admitted generations. A family without a host
 * gate is always ready. Claude Desktop is ready only while its own updater is off by policy, because that
 * updater would replace the bundle under its seats and relaunch the default app.
 * @param {Object} options
 * @param {String} options.family A key of {@link HARNESS_GENERATION_FAMILIES}.
 * @param {Object} [options.seams] Passed to the family's gate (Claude Desktop: `plistPath`, `extract`).
 * @returns {{ready: Boolean, reason: String|null}} `reason` says what the host lacks and how to supply it.
 * @throws {Error} `unknown-family`.
 */
export function readHarnessHostGate({family, seams = {}} = {}) {
    if (!Object.hasOwn(HARNESS_GENERATION_FAMILIES, family)) throw refusal('unknown-family', String(family));

    const gate = FAMILY_HOST_GATES[family];

    if (!gate) return {ready: true, reason: null};

    const {inForce, reason} = gate(seams);

    return {ready: inForce, reason}
}

/**
 * @summary Reads a bundle's identity fields from its `Info.plist` with the read admission runs on a copy,
 * so a caller can tell whether a build is new to a ledger without copying it.
 * @param {String} appBundle Absolute path of a `.app`.
 * @returns {{bundleId: String, shortVersion: String, buildVersion: String, executable: String}}
 */
export function readHarnessBundleInfo(appBundle) {
    return HOST_SEAMS.readBundleInfo(appBundle)
}

/**
 * @summary Copies a candidate bundle into the family's store and admits it only if, ON THE COPY, its
 * bundle id and signing Team ID match the family's vendor, `codesign --verify --deep --strict` and
 * the Gatekeeper assessment pass, and the family's capability probe answers `available`.
 * An admitted copy is published by one atomic rename to `<root>/<family>/<id>/`; an interrupted
 * run leaves only a staging directory, which is never selectable and is swept by the family's next
 * run. A rejection records its reason in the ledger and never changes the selection.
 * @param {Object} options
 * @param {String} options.root Absolute store root.
 * @param {String} options.family A key of {@link HARNESS_GENERATION_FAMILIES}.
 * @param {String} options.sourceBundle Absolute path of the candidate `.app`.
 * @param {String} [options.source='installed'] Provenance recorded with the verdict (e.g. a feed URL).
 * @param {Object} [options.seams] Replaces any of `copyBundle`, `readBundleInfo`, `inspectSignature`,
 * `assessGatekeeper` and `probe` (`({binaryPath}) => {available, reason}`).
 * @param {Function} [options.now] Clock seam.
 * @returns {Promise<{admitted: Boolean, id: String|null, appBundle: String|null, binaryPath: String|null, reason: String|null}>}
 * @throws {Error} `root-must-be-absolute`, `unknown-family`, `source-must-be-an-app-bundle` or `ledger-invalid`.
 */
export function materializeHarnessGeneration({root, family, sourceBundle, source = 'installed', seams = {}, now = () => new Date()} = {}) {
    const directory = familyDirectory(root, family);

    if (typeof sourceBundle !== 'string' || !path.isAbsolute(sourceBundle) || !sourceBundle.endsWith('.app')) {
        throw refusal('source-must-be-an-app-bundle', String(sourceBundle))
    }

    const
        key  = `${directory}\0`,
        next = (chains.get(key) ?? Promise.resolve()).then(() =>
            materialize({directory, family, sourceBundle, source, host: {...HOST_SEAMS, probe: FAMILY_PROBES[family], ...seams}, now}));

    chains.set(key, next.catch(() => {}));
    return next
}

/** @summary One serialized admission run; see {@link materializeHarnessGeneration}. */
async function materialize({directory, family, sourceBundle, source, host, now}) {
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});

    const ledger = readLedger(directory);

    for (const entry of fs.readdirSync(directory)) {
        if (entry.startsWith(STAGING_PREFIX)) fs.rmSync(path.join(directory, entry), {recursive: true, force: true})
    }

    const
        vendor    = HARNESS_GENERATION_FAMILIES[family],
        appName   = path.basename(sourceBundle),
        staging   = path.join(directory, STAGING_PREFIX + randomUUID()),
        stagedApp = path.join(staging, appName),
        verdict   = {id: null, shortVersion: null, buildVersion: null};

    const reject = reason => {
        fs.rmSync(staging, {recursive: true, force: true});
        ledger.rejected = [...ledger.rejected, {...verdict, source, at: now().toISOString(), reason}].slice(-MAX_REJECTIONS);
        writeFileAtomicSync(path.join(directory, LEDGER), JSON.stringify(ledger, null, 4));
        return {admitted: false, id: verdict.id, appBundle: null, binaryPath: null, reason}
    };

    // A host step that throws is that step's refusal, never an escape that skips the ledger.
    const attempt = async (step, ...args) => {
        try { return await host[step](...args) } catch { return null }
    };

    fs.mkdirSync(staging, {mode: 0o700});

    try {
        await host.copyBundle(sourceBundle, stagedApp)
    } catch {
        return reject('copy-failed')
    }

    const info = await attempt('readBundleInfo', stagedApp);
    Object.assign(verdict, {shortVersion: info?.shortVersion || null, buildVersion: info?.buildVersion || null});

    if (!info?.bundleId || !verdict.shortVersion || !verdict.buildVersion || !isPlainName(info.executable)) return reject('bundle-metadata-invalid');
    if (info.bundleId !== vendor.bundleId) return reject('bundle-identity-mismatch');

    const signature = await attempt('inspectSignature', stagedApp);

    if (!signature?.verified)                return reject('signature-invalid');
    if (signature.teamId !== vendor.teamId)  return reject('team-identity-mismatch');

    try {
        verdict.id = harnessGenerationId({...info, cdhash: signature.cdhash})
    } catch {
        return reject('identity-invalid')
    }

    if (!await attempt('assessGatekeeper', stagedApp)) return reject('gatekeeper-rejected');
    if (typeof host.probe !== 'function')              return reject('family-probe-unavailable');

    const probed = await attempt('probe', {binaryPath: path.join(stagedApp, 'Contents', 'MacOS', info.executable)});
    if (!probed?.available) return reject(`probe-refused:${probed?.reason ?? 'error'}`);

    const target = path.join(directory, verdict.id);

    if (fs.existsSync(target)) {
        // Only admitted copies are ever renamed into place; one whose seal no longer verifies was
        // altered after admission and is reported, never silently replaced.
        const existing = await attempt('inspectSignature', path.join(target, appName));
        if (!existing?.verified || existing.cdhash !== signature.cdhash) return reject('existing-generation-invalid');
        fs.rmSync(staging, {recursive: true, force: true})
    } else {
        fs.renameSync(staging, target)
    }

    if (!ledger.admitted.some(entry => entry.id === verdict.id)) {
        ledger.admitted.push({
            id          : verdict.id,
            bundleId    : info.bundleId,
            shortVersion: verdict.shortVersion,
            buildVersion: verdict.buildVersion,
            cdhash      : signature.cdhash,
            teamId      : signature.teamId,
            appName,
            executable  : info.executable,
            source,
            at          : now().toISOString()
        });
        writeFileAtomicSync(path.join(directory, LEDGER), JSON.stringify(ledger, null, 4))
    }

    const appBundle = path.join(target, appName);
    return {admitted: true, id: verdict.id, appBundle, binaryPath: path.join(appBundle, 'Contents', 'MacOS', info.executable), reason: null}
}

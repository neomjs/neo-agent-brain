import {spawnSync}                               from 'node:child_process';
import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import nodeFs                                    from 'node:fs';
import {createRequire}                           from 'node:module';
import path                                      from 'node:path';
import {fileURLToPath}                           from 'node:url';
import {
    HARNESS_GENERATION_FAMILIES,
    materializeHarnessGeneration,
    readHarnessGenerationLedger,
    selectHarnessGeneration
} from './harnessGeneration.mjs';

/**
 * @module ai/services/fleet/antigravityUpdate
 * @summary Acquires Antigravity (`Antigravity.app`) updates from its `electron-updater` feed
 * (`Contents/Resources/app-update.yml` -> `latest-${arch}-mac.yml`), verifies the archive's
 * byte length and SHA-512 digest against the manifest BEFORE extracting, and hands the
 * extracted `.app` bundle to `materializeHarnessGeneration` (`family: 'antigravity'`).
 */

// Physical fs reader so Electron's ASAR virtualization never intercepts bundle inspection.
const fs = process.versions.electron ? createRequire(import.meta.url)('original-fs') : nodeFs;

const
    PLIST_BUDDY                    = '/usr/libexec/PlistBuddy',
    DITTO                          = '/usr/bin/ditto',
    ANTIGRAVITY_FAMILY             = 'antigravity',
    ANTIGRAVITY_BUNDLE_ID          = HARNESS_GENERATION_FAMILIES[ANTIGRAVITY_FAMILY].bundleId,
    DEFAULT_ANTIGRAVITY_APP_BUNDLE = '/Applications/Antigravity.app',
    MAX_MANIFEST_BYTES             = 1024 * 1024,
    MAX_ARCHIVE_BYTES              = 1024 * 1024 * 1024,
    SHA512_BYTE_LENGTH             = 64,
    MODULE_DIR                     = path.dirname(fileURLToPath(import.meta.url)),
    acquireChains                  = new Map(),
    inProcessRejections            = new Map();

let cachedDefaultAdmitterId;

/**
 * @summary Construct a deterministic refusal Error with `.code`.
 * @param {String} code
 * @param {String} [detail='']
 * @returns {Error}
 */
function refusal(code, detail = '') {
    return Object.assign(new Error(`antigravityUpdate: ${code}${detail ? ` — ${detail}` : ''}`), {code})
}

/**
 * @summary Computes the SHA-256 fingerprint of the active Antigravity admission & probe modules
 * so an in-process `already-rejected` guard automatically expires when the admitting code changes.
 * @returns {String}
 */
function defaultAdmitterId() {
    if (cachedDefaultAdmitterId) return cachedDefaultAdmitterId;

    const hash = createHash('sha256');
    for (const file of ['harnessGeneration.mjs', 'probeAntigravityRuntime.mjs', 'antigravityUpdate.mjs']) {
        try {
            hash.update(fs.readFileSync(path.join(MODULE_DIR, file)))
        } catch {
            hash.update(file)
        }
    }

    cachedDefaultAdmitterId = hash.digest('hex');
    return cachedDefaultAdmitterId
}

/**
 * @summary Read one key from a macOS `.plist` via `/usr/libexec/PlistBuddy` without invoking a shell.
 * @param {String} plistPath
 * @param {String} key
 * @returns {String}
 */
function defaultReadPlistKey(plistPath, key) {
    const result = spawnSync(PLIST_BUDDY, ['-c', `Print :${key}`, plistPath], {
        encoding : 'utf8',
        maxBuffer: 64 * 1024,
        timeout  : 5000
    });
    if (result.error || result.status !== 0) {
        throw refusal('plist-key-unavailable', `${key} in ${plistPath}`)
    }
    return (result.stdout ?? '').trim()
}

/**
 * @summary Extract a `.zip` archive into `destinationDir` using macOS `/usr/bin/ditto -x -k`.
 * @param {String} archivePath
 * @param {String} destinationDir
 */
function defaultExtractZipArchive(archivePath, destinationDir) {
    const result = spawnSync(DITTO, ['-x', '-k', archivePath, destinationDir], {
        encoding : 'utf8',
        maxBuffer: 1024 * 1024,
        timeout  : 5 * 60 * 1000
    });
    if (result.error || result.status !== 0) {
        throw refusal('archive-extract-failed', (result.stderr || result.error?.message || '').trim())
    }
}

/**
 * @summary Read Antigravity's `electron-updater` feed configuration and current version metadata
 * from an installed or admitted `Antigravity.app` bundle (`Contents/Resources/app-update.yml` + `Contents/Info.plist`).
 * @param {String} [appBundle='/Applications/Antigravity.app']
 * @param {Object} [options]
 * @param {Object} [options.fsImpl]
 * @param {String} [options.architecture=process.arch]
 * @param {Function} [options.readPlistKey]
 * @returns {{appBundle: String, bundleId: String, shortVersion: String, buildVersion: String,
 *            provider: String, baseUrl: String, channel: String, manifestUrl: String, updaterCacheDirName: String|null}}
 */
export function readAntigravityUpdateConfig(appBundle = DEFAULT_ANTIGRAVITY_APP_BUNDLE, {
    fsImpl = fs,
    architecture = process.arch,
    readPlistKey = defaultReadPlistKey
} = {}) {
    if (typeof appBundle !== 'string' || !path.isAbsolute(appBundle)) {
        throw refusal('invalid-app-bundle-path', String(appBundle))
    }

    if (architecture !== 'arm64' && architecture !== 'x64') {
        throw refusal('unsupported-architecture', String(architecture))
    }

    const
        resolvedBundle = path.resolve(appBundle),
        infoPlist      = path.join(resolvedBundle, 'Contents', 'Info.plist'),
        appUpdateYml   = path.join(resolvedBundle, 'Contents', 'Resources', 'app-update.yml');

    if (!fsImpl.existsSync(infoPlist)) {
        throw refusal('info-plist-missing', infoPlist)
    }
    if (!fsImpl.existsSync(appUpdateYml)) {
        throw refusal('update-config-missing', appUpdateYml)
    }

    const
        bundleId     = readPlistKey(infoPlist, 'CFBundleIdentifier'),
        shortVersion = readPlistKey(infoPlist, 'CFBundleShortVersionString'),
        buildVersion = readPlistKey(infoPlist, 'CFBundleVersion');

    if (bundleId !== ANTIGRAVITY_BUNDLE_ID) {
        throw refusal('unsupported-bundle-identity', bundleId)
    }

    const
        rawYml              = String(fsImpl.readFileSync(appUpdateYml, 'utf8')),
        fields              = parseTopLevelYamlScalars(rawYml),
        provider            = fields.get('provider') ?? '',
        rawUrl              = fields.get('url') ?? '',
        updaterCacheDirName = fields.get('updaterCacheDirName') ?? null;

    if (provider !== 'generic') {
        throw refusal('update-provider-unsupported', provider || 'missing')
    }

    let parsedBaseUrl;
    try {
        parsedBaseUrl = new URL(rawUrl);
    } catch {
        throw refusal('update-url-invalid', rawUrl)
    }
    if (parsedBaseUrl.protocol !== 'https:') {
        throw refusal('update-url-insecure', parsedBaseUrl.protocol)
    }

    const
        baseUrl     = parsedBaseUrl.href.endsWith('/') ? parsedBaseUrl.href : `${parsedBaseUrl.href}/`,
        channel     = `latest-${architecture}`,
        manifestUrl = new URL(`${channel}-mac.yml`, baseUrl).href;

    return {
        appBundle: resolvedBundle,
        bundleId,
        shortVersion,
        buildVersion,
        provider,
        baseUrl,
        channel,
        manifestUrl,
        updaterCacheDirName
    }
}

/**
 * @summary Parse top-level `key: value` scalar pairs from a simple YAML document.
 * @param {String} yamlText
 * @returns {Map<String, String>}
 */
function parseTopLevelYamlScalars(yamlText) {
    const map = new Map();
    for (const rawLine of String(yamlText).split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, '').trimEnd();
        if (!line || /^\s/.test(line)) continue;
        const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (!match) continue;
        const value = unquoteYamlScalar(match[2].trim());
        if (value !== '') map.set(match[1], value);
    }
    return map
}

/**
 * @summary Strip optional single or double quotes around a YAML scalar value.
 * @param {String} raw
 * @returns {String}
 */
function unquoteYamlScalar(raw) {
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        return raw.slice(1, -1)
    }
    return raw
}

/**
 * @summary Parse an `electron-updater` `latest-${arch}-mac.yml` manifest and validate its HTTPS archive URL,
 * 64-byte base64 SHA-512 digest, and positive archive byte size.
 * @param {String} yamlText Raw YAML string from `latest-${arch}-mac.yml`.
 * @param {Object} [options]
 * @param {String} [options.manifestUrl=''] Optional manifest URL used to resolve relative file paths.
 * @returns {{version: String, archiveUrl: String, sha512: String, size: Number, releaseDate: String|null}}
 */
export function parseAntigravityUpdateManifest(yamlText, {manifestUrl = ''} = {}) {
    if (typeof yamlText !== 'string' || !yamlText.trim()) {
        throw refusal('manifest-empty')
    }
    if (Buffer.byteLength(yamlText, 'utf8') > MAX_MANIFEST_BYTES) {
        throw refusal('manifest-too-large')
    }

    const
        topLevel    = parseTopLevelYamlScalars(yamlText),
        version     = topLevel.get('version') ?? '',
        releaseDate = topLevel.get('releaseDate') ?? null;

    if (!version) {
        throw refusal('manifest-version-missing')
    }

    const
        fileEntries = parseYamlFilesList(yamlText),
        primaryFile = fileEntries.find(entry => (entry.url || '').endsWith('.zip')) ?? fileEntries[0] ?? {},
        rawUrl      = primaryFile.url || topLevel.get('path') || topLevel.get('url') || '',
        rawSha512   = primaryFile.sha512 || topLevel.get('sha512') || '',
        rawSize     = primaryFile.size ?? topLevel.get('size') ?? '';

    if (!rawUrl) {
        throw refusal('manifest-files-missing', `version ${version} has no downloadable file entry`)
    }

    let parsedUrl;
    try {
        parsedUrl = manifestUrl ? new URL(rawUrl, manifestUrl) : new URL(rawUrl);
    } catch {
        throw refusal('manifest-url-invalid', rawUrl)
    }
    if (parsedUrl.protocol !== 'https:') {
        throw refusal('manifest-url-insecure', parsedUrl.protocol)
    }

    decodeSha512Base64(rawSha512);

    const size = Number(rawSize);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ARCHIVE_BYTES) {
        throw refusal('manifest-size-invalid', String(rawSize))
    }

    return {
        version,
        archiveUrl: parsedUrl.href,
        sha512    : rawSha512,
        size,
        releaseDate
    }
}

/**
 * @summary Parse the `files:` block of an `electron-updater` YAML manifest into `{url, sha512, size}` objects.
 * @param {String} yamlText
 * @returns {Array<{url?: String, sha512?: String, size?: String}>}
 */
function parseYamlFilesList(yamlText) {
    const
        lines   = String(yamlText).split(/\r?\n/),
        entries = [];
    let inFiles = false,
        current = null;

    for (const rawLine of lines) {
        const stripped = rawLine.replace(/#.*$/, '').trimEnd();
        if (!stripped.trim()) continue;

        if (/^files\s*:\s*$/.test(stripped)) {
            inFiles = true;
            continue
        }

        if (inFiles && !/^\s/.test(stripped)) {
            break
        }

        if (!inFiles) continue;

        const itemStart = stripped.match(/^\s*-\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (itemStart) {
            current = {[itemStart[1]]: unquoteYamlScalar(itemStart[2].trim())};
            entries.push(current);
            continue
        }

        const itemProp = stripped.match(/^\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (itemProp && current) {
            current[itemProp[1]] = unquoteYamlScalar(itemProp[2].trim())
        }
    }

    return entries
}

/**
 * @summary Decode and validate a base64-encoded 64-byte (512-bit) SHA-512 digest.
 * @param {String} sha512Base64
 * @returns {Buffer}
 */
function decodeSha512Base64(sha512Base64) {
    if (typeof sha512Base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(sha512Base64.trim())) {
        throw refusal('manifest-sha512-invalid')
    }
    const bytes = Buffer.from(sha512Base64.trim(), 'base64');
    if (bytes.length !== SHA512_BYTE_LENGTH) {
        throw refusal('manifest-sha512-invalid', `expected ${SHA512_BYTE_LENGTH} bytes, got ${bytes.length}`)
    }
    return bytes
}

/**
 * @summary Verify an archive Buffer's byte length and SHA-512 digest against the `electron-updater`
 * manifest before any archive extraction occurs.
 * @param {Buffer} archiveBuffer
 * @param {Object} options
 * @param {String} options.expectedSha512 Base64-encoded SHA-512 digest from `latest-${arch}-mac.yml`.
 * @param {Number|null} [options.expectedSize=null] Expected byte length from `latest-${arch}-mac.yml`.
 * @returns {{verified: Boolean, sha512: String, byteLength: Number}}
 */
export function verifyAntigravityArchive(archiveBuffer, {expectedSha512, expectedSize = null} = {}) {
    if (!Buffer.isBuffer(archiveBuffer) || archiveBuffer.length === 0) {
        throw refusal('archive-empty')
    }
    if (archiveBuffer.length > MAX_ARCHIVE_BYTES) {
        throw refusal('archive-too-large', String(archiveBuffer.length))
    }

    if (expectedSize !== null && expectedSize !== undefined) {
        if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
            throw refusal('manifest-size-invalid', String(expectedSize))
        }
        if (archiveBuffer.length !== expectedSize) {
            throw refusal('archive-size-mismatch', `expected ${expectedSize}, got ${archiveBuffer.length}`)
        }
    }

    const
        expectedDigest = decodeSha512Base64(expectedSha512),
        actualDigest   = createHash('sha512').update(archiveBuffer).digest();

    if (!timingSafeEqual(actualDigest, expectedDigest)) {
        throw refusal('sha512-mismatch')
    }

    return {
        verified  : true,
        sha512    : actualDigest.toString('base64'),
        byteLength: archiveBuffer.length
    }
}

/**
 * @summary Compare two dotted numeric version strings (`2.29.1` vs `2.28.0`).
 * @param {String} left
 * @param {String} right
 * @returns {Number} `1` if `left > right`, `-1` if `left < right`, `0` if equal.
 */
export function compareDottedVersions(left, right) {
    const
        a = String(left ?? '').split(/[^0-9]+/).filter(Boolean).map(Number),
        b = String(right ?? '').split(/[^0-9]+/).filter(Boolean).map(Number),
        n = Math.max(a.length, b.length);

    for (let i = 0; i < n; i++) {
        const av = a[i] ?? 0, bv = b[i] ?? 0;
        if (av !== bv) return av > bv ? 1 : -1
    }
    return 0
}

/**
 * @summary Check Antigravity's `electron-updater` feed for a newer build than the currently admitted
 * or installed `Antigravity.app` bundle. Sends `x-app-version: 0.0.0` so the Cloud Run updater
 * always returns the full manifest with `files`, `sha512`, and `size`.
 * @param {Object} [options]
 * @param {String|null} [options.root=null] Optional harness generation store root to inspect admitted versions.
 * @param {String} [options.appBundle='/Applications/Antigravity.app'] Reference bundle providing `app-update.yml`.
 * @param {Function} [options.fetchImpl=globalThis.fetch] Fetch implementation (`(url, options) => Promise<Response>`).
 * @param {Object} [options.fsImpl]
 * @param {String} [options.architecture=process.arch]
 * @param {Function} [options.readPlistKey]
 * @param {Function} [options.readLedger] Injectable ledger reader (`readHarnessGenerationLedger`).
 * @returns {Promise<{updateAvailable: Boolean, alreadyAdmitted: Boolean, currentVersion: String,
 *                    selectedGenerationId: String|null, candidate: Object, feedUrl: String}>}
 */
export async function checkAntigravityUpdate({
    root = null,
    appBundle = DEFAULT_ANTIGRAVITY_APP_BUNDLE,
    fetchImpl = globalThis.fetch,
    fsImpl = fs,
    architecture = process.arch,
    readPlistKey = defaultReadPlistKey,
    readLedger = readHarnessGenerationLedger
} = {}) {
    if (typeof fetchImpl !== 'function') {
        throw refusal('fetch-unavailable')
    }

    const
        config   = readAntigravityUpdateConfig(appBundle, {fsImpl, architecture, readPlistKey}),
        response = await fetchImpl(config.manifestUrl, {
            headers: {
                'Accept'       : 'text/yaml, text/plain, */*',
                'x-app-version': '0.0.0'
            }
        });

    if (!response?.ok) {
        throw refusal('manifest-fetch-failed', `HTTP ${response?.status ?? 'unknown'}`)
    }

    const
        yamlText  = await response.text(),
        candidate = parseAntigravityUpdateManifest(yamlText, {manifestUrl: config.manifestUrl});

    let selectedGeneration = null,
        alreadyAdmitted    = false;

    if (typeof root === 'string' && path.isAbsolute(root)) {
        selectedGeneration = selectHarnessGeneration({root, family: ANTIGRAVITY_FAMILY});
        const ledger = readLedger({root, family: ANTIGRAVITY_FAMILY});
        alreadyAdmitted    = ledger.admitted.some(gen => gen.shortVersion === candidate.version)
    }

    const
        currentVersion     = selectedGeneration?.shortVersion ?? config.shortVersion,
        isNewerThanCurrent = compareDottedVersions(candidate.version, currentVersion) > 0;

    return {
        updateAvailable     : !alreadyAdmitted && isNewerThanCurrent,
        alreadyAdmitted,
        currentVersion,
        selectedGenerationId: selectedGeneration?.id ?? null,
        candidate,
        feedUrl             : config.manifestUrl
    }
}

/**
 * @summary Locate the single `.app` bundle inside an extracted staging directory.
 * @param {String} directory
 * @param {Object} fsImpl
 * @returns {String}
 */
function findExtractedAppBundle(directory, fsImpl) {
    const
        entries = fsImpl.readdirSync(directory, {withFileTypes: true}),
        apps    = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.endsWith('.app'));

    if (apps.length !== 1) {
        throw refusal('extracted-bundle-ambiguous', `found ${apps.length} .app bundles in staging`)
    }
    return path.join(directory, apps[0].name)
}

/**
 * @summary Fetch, SHA-512-verify, extract, and admit a new Antigravity build from its `electron-updater`
 * feed into the Fleet harness generation store.
 *
 * Security & operational invariants:
 * 1. If the feed's candidate version is already admitted (or not newer than `currentVersion` unless `force: true`),
 *    returns `{status: 'up-to-date'}` without downloading the archive.
 * 2. If the candidate version was already rejected by the current `admitterId` in this process (unless `retryRejected: true`),
 *    returns `{status: 'already-rejected'}` without re-downloading, while automatically expiring when the admitting code changes.
 * 3. The archive bytes are verified against both `candidate.size` and `candidate.sha512` BEFORE writing or extracting.
 * 4. Extraction runs inside a temporary directory under `<root>/antigravity/.update-staging-<uuid>` that is always
 *    removed in `finally`, and the extracted `.app` is handed to `materializeHarnessGeneration`.
 *
 * @param {Object} options
 * @param {String} options.root Absolute directory for the harness generation store.
 * @param {String} [options.appBundle='/Applications/Antigravity.app'] Reference bundle providing `app-update.yml`.
 * @param {Function} [options.fetchImpl=globalThis.fetch]
 * @param {Object} [options.fsImpl]
 * @param {String} [options.architecture=process.arch]
 * @param {Function} [options.readPlistKey]
 * @param {Function} [options.readLedger]
 * @param {Function} [options.extractArchive] Injectable `(archivePath, destinationDir) => void` seam.
 * @param {Function} [options.materializeGeneration] Injectable `materializeHarnessGeneration` seam.
 * @param {String} [options.admitterId] Injectable admitter fingerprint for rejection-skip scoping.
 * @param {Boolean} [options.retryRejected=false] When `false`, skips a build already rejected by the current `admitterId`.
 * @param {Boolean} [options.force=false] When true, downloads and admits even if `updateAvailable` is false.
 * @returns {Promise<{status: 'up-to-date'|'already-rejected'|'admitted'|'rejected', check: Object,
 *                    generation: Object|null, reason?: String|null, verification?: Object}>}
 */
export function acquireAntigravityUpdate(options = {}) {
    const root = options?.root;
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
        return Promise.reject(refusal('invalid-root', 'root must be an absolute path'))
    }

    const
        familyRoot = path.join(root, ANTIGRAVITY_FAMILY),
        key        = `${familyRoot}\0`,
        next       = (acquireChains.get(key) ?? Promise.resolve()).then(() => runAcquireAntigravityUpdate(options));

    acquireChains.set(key, next.catch(() => {}));
    return next
}

/** @summary One serialized acquisition run for `antigravity`; see {@link acquireAntigravityUpdate}. */
async function runAcquireAntigravityUpdate({
    root,
    appBundle = DEFAULT_ANTIGRAVITY_APP_BUNDLE,
    fetchImpl = globalThis.fetch,
    fsImpl = fs,
    architecture = process.arch,
    readPlistKey = defaultReadPlistKey,
    readLedger = readHarnessGenerationLedger,
    extractArchive = defaultExtractZipArchive,
    materializeGeneration = materializeHarnessGeneration,
    admitterId = defaultAdmitterId(),
    retryRejected = false,
    force = false
} = {}) {
    const check = await checkAntigravityUpdate({
        root,
        appBundle,
        fetchImpl,
        fsImpl,
        architecture,
        readPlistKey,
        readLedger
    });

    if (!force && (!check.updateAvailable || check.alreadyAdmitted)) {
        return {status: 'up-to-date', check, generation: null}
    }

    const
        {candidate}  = check,
        rejectionKey = `${path.resolve(root)}\0${candidate.version}\0${admitterId}`;

    if (!retryRejected) {
        const priorReason = inProcessRejections.get(rejectionKey);
        if (priorReason) {
            return {
                status    : 'already-rejected',
                check,
                generation: null,
                reason    : priorReason
            }
        }
    }

    const response = await fetchImpl(candidate.archiveUrl);

    if (!response?.ok) {
        throw refusal('archive-fetch-failed', `HTTP ${response?.status ?? 'unknown'}`)
    }

    const
        archiveBuffer = Buffer.from(await response.arrayBuffer()),
        verification  = verifyAntigravityArchive(archiveBuffer, {
            expectedSha512: candidate.sha512,
            expectedSize  : candidate.size
        }),
        familyRoot    = path.join(root, ANTIGRAVITY_FAMILY),
        stagingRoot   = path.join(familyRoot, `.update-staging-${randomUUID()}`),
        archivePath   = path.join(stagingRoot, 'update.zip'),
        extractDir    = path.join(stagingRoot, 'extracted');

    fsImpl.mkdirSync(extractDir, {recursive: true});

    try {
        fsImpl.writeFileSync(archivePath, archiveBuffer);
        extractArchive(archivePath, extractDir);

        const
            extractedBundle = findExtractedAppBundle(extractDir, fsImpl),
            admission       = await materializeGeneration({
                root,
                family      : ANTIGRAVITY_FAMILY,
                sourceBundle: extractedBundle,
                source      : candidate.archiveUrl
            });

        if (!admission.admitted) {
            inProcessRejections.set(rejectionKey, admission.reason ?? 'rejected')
        } else {
            inProcessRejections.delete(rejectionKey)
        }

        return {
            status    : admission.admitted ? 'admitted' : 'rejected',
            check,
            generation: admission,
            reason    : admission.reason ?? null,
            verification
        }
    } finally {
        fsImpl.rmSync(stagingRoot, {recursive: true, force: true})
    }
}

import {spawnSync}                                       from 'node:child_process';
import {createHash, createPublicKey, randomUUID, verify} from 'node:crypto';
import nodeFs                                            from 'node:fs';
import {createRequire}                                   from 'node:module';
import path                                              from 'node:path';
import {Readable, Transform}                             from 'node:stream';
import {pipeline}                                        from 'node:stream/promises';
import {fileURLToPath}                                   from 'node:url';
import {
    materializeHarnessGeneration,
    readHarnessGenerationLedger,
    selectHarnessGeneration
} from './harnessGeneration.mjs';

/**
 * @module ai/services/fleet/codexDesktopUpdate
 * @summary Acquires Codex Desktop (`ChatGPT.app`) releases from OpenAI's Sparkle appcast,
 * verifies the downloaded archive's Ed25519 signature against the bundle's `SUPublicEDKey`
 * before extraction, and hands the extracted `ChatGPT.app` bundle to
 * {@link materializeHarnessGeneration} for immutable generation admission.
 */

// Electron virtualizes app.asar as a directory; reading ASAR headers requires physical bytes.
const bundleFs = process.versions.electron ? createRequire(import.meta.url)('original-fs') : nodeFs;

const
    ACQUIRE_PREFIX      = '.acquire-',
    CODEX_BUNDLE_ID     = 'com.openai.codex',
    CODEX_FAMILY        = 'codex-desktop',
    CODEX_APP_NAME      = 'ChatGPT.app',
    ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex'),
    PLIST_BUDDY         = '/usr/libexec/PlistBuddy',
    SW_VERS             = '/usr/bin/sw_vers',
    MODULE_DIR          = path.dirname(fileURLToPath(import.meta.url)),
    acquireChains       = new Map(),
    inProcessRejections = new Map();

let cachedHostSystemVersion,
    cachedDefaultAdmitterId;

/** @summary Creates a named refusal Error with a stable `code` property. */
function refusal(code, detail = '') {
    return Object.assign(new Error(`codexDesktopUpdate: ${code}${detail ? ` — ${detail}` : ''}`), {code});
}

/**
 * @summary Computes the SHA-256 fingerprint of the active Codex admission & probe modules so an
 * in-process `already-rejected` guard automatically expires whenever the admitting code changes.
 * @returns {String}
 */
function defaultAdmitterId() {
    if (cachedDefaultAdmitterId) return cachedDefaultAdmitterId;

    const hash = createHash('sha256');
    for (const file of ['harnessGeneration.mjs', 'manageCodexDesktopRuntime.mjs', 'codexDesktopUpdate.mjs']) {
        try {
            hash.update(bundleFs.readFileSync(path.join(MODULE_DIR, file)));
        } catch {
            hash.update(file);
        }
    }

    cachedDefaultAdmitterId = hash.digest('hex');
    return cachedDefaultAdmitterId;
}

/**
 * @summary Reads the host macOS product version (`sw_vers -productVersion`) once per process.
 * @returns {String|null}
 */
function defaultHostSystemVersion() {
    if (cachedHostSystemVersion !== undefined) return cachedHostSystemVersion;

    const res = spawnSync(SW_VERS, ['-productVersion'], {
        encoding : 'utf8',
        maxBuffer: 4096,
        timeout  : 5000
    });

    cachedHostSystemVersion = res.status === 0 && res.stdout?.trim() ? res.stdout.trim() : null;
    return cachedHostSystemVersion;
}

/** @summary Decodes strict standard base64 and verifies exact decoded byte length. */
function decodeBase64Strict(value, expectedBytes) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || !/^[A-Za-z0-9+/]+=*$/.test(trimmed) || trimmed.length % 4 !== 0) return null;

    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length !== expectedBytes) return null;
    if (decoded.toString('base64') !== trimmed) return null;

    return decoded;
}

/** @summary Default `Info.plist` reader using macOS `/usr/libexec/PlistBuddy`. */
function defaultReadPlist(infoPlistPath) {
    const readKey = key => {
        const res = spawnSync(PLIST_BUDDY, ['-c', `Print :${key}`, infoPlistPath], {
            encoding : 'utf8',
            maxBuffer: 1024 * 1024,
            timeout  : 30_000
        });
        return res.status === 0 ? (res.stdout ?? '').trim() : '';
    };

    return {
        bundleId    : readKey('CFBundleIdentifier'),
        shortVersion: readKey('CFBundleShortVersionString'),
        buildVersion: readKey('CFBundleVersion'),
        publicKey   : readKey('SUPublicEDKey')
    };
}

/**
 * @summary Reads `package.json` directly from an Electron `app.asar` archive without unpacking.
 * @param {String} appAsarPath Absolute path to `Contents/Resources/app.asar`.
 * @param {Object} fsImpl Physical filesystem implementation.
 * @returns {Object} Parsed `package.json` object.
 */
function readAsarPackageJson(appAsarPath, fsImpl) {
    const fd = fsImpl.openSync(appAsarPath, 'r');

    try {
        const preamble = Buffer.alloc(16);
        if (fsImpl.readSync(fd, preamble, 0, 16, 0) !== 16) {
            throw refusal('sparkle-config-invalid', 'asar-preamble-truncated');
        }

        const
            headerPayloadSize = preamble.readUInt32LE(4),
            jsonByteLength    = preamble.readUInt32LE(12);

        if (jsonByteLength <= 0 || jsonByteLength > 64 * 1024 * 1024) {
            throw refusal('sparkle-config-invalid', 'asar-header-size-invalid');
        }

        const headerBuf = Buffer.alloc(jsonByteLength);
        if (fsImpl.readSync(fd, headerBuf, 0, jsonByteLength, 16) !== jsonByteLength) {
            throw refusal('sparkle-config-invalid', 'asar-header-truncated');
        }

        const
            tree  = JSON.parse(headerBuf.toString('utf8')),
            entry = tree?.files?.['package.json'];

        if (!entry || !Number.isInteger(entry.size) || entry.size <= 0 || entry.size > 4 * 1024 * 1024) {
            throw refusal('sparkle-config-invalid', 'asar-package-json-missing');
        }

        const
            dataOffset = 8 + headerPayloadSize + Number(entry.offset),
            pkgBuf     = Buffer.alloc(entry.size);

        if (fsImpl.readSync(fd, pkgBuf, 0, entry.size, dataOffset) !== entry.size) {
            throw refusal('sparkle-config-invalid', 'asar-package-json-truncated');
        }

        return JSON.parse(pkgBuf.toString('utf8'));
    } finally {
        fsImpl.closeSync(fd);
    }
}

/**
 * @summary Reads the Sparkle appcast URL, Ed25519 public key (`SUPublicEDKey`), and version
 * metadata from a Codex Desktop `.app` bundle's `Info.plist` and `Contents/Resources/app.asar`.
 * @param {Object} options
 * @param {String} options.appBundle Absolute path to `ChatGPT.app`.
 * @param {Object} [options.fsImpl] Physical filesystem implementation.
 * @param {Function} [options.readPlist] Injectable `(infoPlistPath) => {bundleId, shortVersion, buildVersion, publicKey}` seam.
 * @returns {{bundleId: String, shortVersion: String, buildVersion: String, feedUrl: String, publicKey: String}}
 */
export function readCodexSparkleConfig({
    appBundle,
    fsImpl = bundleFs,
    readPlist = defaultReadPlist
} = {}) {
    if (typeof appBundle !== 'string' || !path.isAbsolute(appBundle) || !appBundle.endsWith('.app')) {
        throw refusal('source-must-be-an-app-bundle', String(appBundle));
    }

    const
        infoPlist = path.join(appBundle, 'Contents', 'Info.plist'),
        appAsar   = path.join(appBundle, 'Contents', 'Resources', 'app.asar');

    let plist, pkg;

    try {
        plist = readPlist(infoPlist);
        pkg   = readAsarPackageJson(appAsar, fsImpl);
    } catch (error) {
        if (error?.code?.startsWith?.('sparkle-')) throw error;
        throw refusal('sparkle-config-invalid', error?.message || 'bundle-unreadable');
    }

    const
        bundleId         = plist?.bundleId?.trim?.() || '',
        shortVersion     = plist?.shortVersion?.trim?.() || pkg?.version?.trim?.() || '',
        buildVersion     = plist?.buildVersion?.trim?.() || pkg?.codexBuildNumber?.trim?.() || '',
        plistPublicKey   = plist?.publicKey?.trim?.() || '',
        packagePublicKey = pkg?.codexSparklePublicKey?.trim?.() || '',
        feedUrl          = pkg?.codexSparkleFeedUrl?.trim?.() || '';

    if (bundleId !== CODEX_BUNDLE_ID) {
        throw refusal('sparkle-config-invalid', 'bundle-identity-mismatch');
    }

    if (!shortVersion || !buildVersion) {
        throw refusal('sparkle-config-invalid', 'version-metadata-missing');
    }

    if (plistPublicKey && packagePublicKey && plistPublicKey !== packagePublicKey) {
        throw refusal('sparkle-public-key-mismatch');
    }

    const publicKey = plistPublicKey || packagePublicKey;
    if (!decodeBase64Strict(publicKey, 32)) {
        throw refusal('sparkle-config-invalid', 'public-key-invalid');
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(feedUrl);
    } catch {
        throw refusal('sparkle-config-invalid', 'feed-url-invalid');
    }

    if (parsedUrl.protocol !== 'https:') {
        throw refusal('sparkle-config-invalid', 'feed-url-must-be-https');
    }

    return {
        bundleId,
        shortVersion,
        buildVersion,
        feedUrl,
        publicKey
    };
}

/** @summary Extracts the text content of a single XML tag inside an `<item>` block. */
function extractXmlTag(block, tagName) {
    const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match   = block.match(new RegExp(`<${escaped}>\\s*([^<]+?)\\s*</${escaped}>`));
    return match ? match[1].trim() : null;
}

/** @summary Extracts an XML attribute value (`name="value"` or `name='value'`) from a tag's attribute string. */
function extractXmlAttribute(attributes, attrName) {
    const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match   = attributes.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(['"])(.*?)\\1`));
    return match ? match[2].trim() : null;
}

/**
 * @summary Compares two dotted numeric version strings (`14.2.1` vs `13.0`).
 * @param {String} left
 * @param {String} right
 * @returns {Number} `1` if `left > right`, `-1` if `left < right`, `0` if equal.
 */
function compareDottedVersions(left, right) {
    const
        a = String(left ?? '').split(/[^0-9]+/).filter(Boolean).map(Number),
        b = String(right ?? '').split(/[^0-9]+/).filter(Boolean).map(Number),
        n = Math.max(a.length, b.length);

    for (let i = 0; i < n; i++) {
        const av = a[i] ?? 0, bv = b[i] ?? 0;
        if (av !== bv) return av > bv ? 1 : -1;
    }

    return 0;
}

/** @summary Compares two `buildVersion` strings newest-first (numeric when digits-only, else dotted numeric). */
function compareBuildVersionsDesc(left, right) {
    if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
        const diff = BigInt(right) - BigInt(left);
        return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    }

    return compareDottedVersions(right, left) || right.localeCompare(left);
}

/**
 * @summary Parses a Sparkle 2 RSS appcast XML document and returns full-archive release items
 * compatible with both `hardwareRequirements` and the host macOS version (`minimumSystemVersion`),
 * ordered newest-first by `buildVersion`. Nested `<sparkle:deltas>` blocks and `sparkle:deltaFrom`
 * enclosures are stripped so binary deltas are never selected as full bundles.
 * @param {String} xml Raw `appcast.xml` string.
 * @param {Object} [options]
 * @param {String} [options.hardwareRequirements='arm64'] Required hardware architecture tag when present on an item.
 * @param {String|null} [options.hostSystemVersion] Host macOS version (`sw_vers -productVersion`) compared against `<sparkle:minimumSystemVersion>`.
 * @returns {Array<{shortVersion: String, buildVersion: String, minimumSystemVersion: String|null,
 *                  hardwareRequirements: String|null, pubDate: String|null, archiveUrl: String,
 *                  length: Number, edSignature: String}>}
 */
export function parseCodexSparkleAppcast(xml, {
    hardwareRequirements = 'arm64',
    hostSystemVersion = defaultHostSystemVersion()
} = {}) {
    if (typeof xml !== 'string' || !xml.trim()) {
        throw refusal('appcast-invalid', 'empty-xml');
    }

    const
        items    = [],
        itemExpr = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;

    let itemMatch;

    while ((itemMatch = itemExpr.exec(xml)) !== null) {
        // Strip nested <sparkle:deltas> blocks first so delta enclosures are never matched.
        const bodyWithoutDeltas = itemMatch[1].replace(/<sparkle:deltas\b[^>]*>[\s\S]*?<\/sparkle:deltas>/gi, '');

        const
            buildVersion         = extractXmlTag(bodyWithoutDeltas, 'sparkle:version'),
            shortVersion         = extractXmlTag(bodyWithoutDeltas, 'sparkle:shortVersionString') || extractXmlTag(bodyWithoutDeltas, 'title'),
            minimumSystemVersion = extractXmlTag(bodyWithoutDeltas, 'sparkle:minimumSystemVersion'),
            itemHardware         = extractXmlTag(bodyWithoutDeltas, 'sparkle:hardwareRequirements'),
            pubDate              = extractXmlTag(bodyWithoutDeltas, 'pubDate');

        if (hardwareRequirements && itemHardware && itemHardware !== hardwareRequirements) {
            continue;
        }

        if (minimumSystemVersion && hostSystemVersion && compareDottedVersions(hostSystemVersion, minimumSystemVersion) < 0) {
            continue;
        }

        const enclosureExpr = /<enclosure\b([^>]*?)\/?>/gi;
        let enclosureMatch, selectedEnclosure = null;

        while ((enclosureMatch = enclosureExpr.exec(bodyWithoutDeltas)) !== null) {
            const attrs = enclosureMatch[1];
            if (extractXmlAttribute(attrs, 'sparkle:deltaFrom')) continue;
            selectedEnclosure = attrs;
            break;
        }

        if (!selectedEnclosure || !buildVersion || !shortVersion) {
            continue;
        }

        const
            archiveUrl  = extractXmlAttribute(selectedEnclosure, 'url'),
            lengthRaw   = extractXmlAttribute(selectedEnclosure, 'length'),
            edSignature = extractXmlAttribute(selectedEnclosure, 'sparkle:edSignature'),
            length      = Number(lengthRaw);

        let validHttps = false;
        try {
            validHttps = new URL(archiveUrl).protocol === 'https:';
        } catch {
            validHttps = false;
        }

        if (!validHttps || !Number.isSafeInteger(length) || length <= 0 || !decodeBase64Strict(edSignature, 64)) {
            continue;
        }

        items.push({
            shortVersion,
            buildVersion,
            minimumSystemVersion,
            hardwareRequirements: itemHardware,
            pubDate,
            archiveUrl,
            length,
            edSignature
        });
    }

    if (!items.length) {
        throw refusal('appcast-invalid', 'no-compatible-release');
    }

    return items
        .map((item, index) => ({item, index}))
        .sort((a, b) => compareBuildVersionsDesc(a.item.buildVersion, b.item.buildVersion) || (a.index - b.index))
        .map(entry => entry.item);
}

/**
 * @summary Verifies a downloaded Sparkle archive's exact byte length and Ed25519 signature
 * (`sparkle:edSignature`) against the bundle's 32-byte base64 `SUPublicEDKey`.
 * @param {Object} options
 * @param {String} options.archivePath Absolute path to the downloaded archive file.
 * @param {String} options.edSignature Base64-encoded 64-byte Ed25519 signature from `<enclosure sparkle:edSignature>`.
 * @param {String} options.publicKey Base64-encoded 32-byte raw Ed25519 public key (`SUPublicEDKey`).
 * @param {Number} options.length Expected archive byte length from `<enclosure length>`.
 * @param {Object} [options.fsImpl] Physical filesystem implementation.
 * @returns {{verified: Boolean, reason: String|null}}
 */
export function verifySparkleEdSignature({
    archivePath,
    edSignature,
    publicKey,
    length,
    fsImpl = bundleFs
} = {}) {
    if (typeof archivePath !== 'string' || !path.isAbsolute(archivePath)) {
        return {verified: false, reason: 'archive-path-must-be-absolute'};
    }

    if (!Number.isSafeInteger(length) || length <= 0) {
        return {verified: false, reason: 'archive-length-invalid'};
    }

    const keyBytes = decodeBase64Strict(publicKey, 32);
    if (!keyBytes) {
        return {verified: false, reason: 'sparkle-public-key-invalid'};
    }

    const signatureBytes = decodeBase64Strict(edSignature, 64);
    if (!signatureBytes) {
        return {verified: false, reason: 'sparkle-signature-invalid'};
    }

    let stat;
    try {
        stat = fsImpl.statSync(archivePath);
    } catch {
        return {verified: false, reason: 'archive-unreadable'};
    }

    if (!stat.isFile() || stat.size !== length) {
        return {verified: false, reason: 'archive-length-mismatch'};
    }

    try {
        const
            spkiDer   = Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]),
            keyObject = createPublicKey({key: spkiDer, format: 'der', type: 'spki'}),
            payload   = fsImpl.readFileSync(archivePath),
            verified  = verify(null, payload, keyObject, signatureBytes);

        return verified
            ? {verified: true, reason: null}
            : {verified: false, reason: 'sparkle-signature-invalid'};
    } catch {
        return {verified: false, reason: 'sparkle-signature-invalid'};
    }
}

/** @summary Default HTTPS appcast fetcher. */
async function defaultFetchAppcast(feedUrl) {
    const response = await fetch(feedUrl, {headers: {'Accept': 'application/rss+xml, application/xml, text/xml'}});
    if (!response.ok) {
        throw refusal('appcast-fetch-failed', `HTTP ${response.status}`);
    }
    return response.text();
}

/** @summary Default streaming HTTPS archive downloader with bounded byte-length guard. */
async function defaultDownloadArchive({url, destination, expectedLength, fsImpl = bundleFs}) {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
        throw refusal('archive-download-failed', `HTTP ${response.status}`);
    }

    let   bytes   = 0;
    const limiter = new Transform({
        transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            if (Number.isSafeInteger(expectedLength) && expectedLength > 0 && bytes > expectedLength) {
                callback(refusal('archive-length-mismatch', 'response-exceeds-expected-length'));
                return;
            }
            callback(null, chunk);
        }
    });

    const writer = fsImpl.createWriteStream(destination, {mode: 0o600});
    await pipeline(Readable.fromWeb(response.body), limiter, writer);
}

/** @summary Default macOS `.zip` extractor using `/usr/bin/ditto -x -k`. */
function defaultExtractArchive({archivePath, extractDir}) {
    const res = spawnSync('/usr/bin/ditto', ['-x', '-k', archivePath, extractDir], {
        encoding : 'utf8',
        maxBuffer: 1024 * 1024,
        timeout  : 10 * 60 * 1000
    });
    if (res.status !== 0) {
        throw refusal('archive-extract-failed', (res.stderr ?? '').trim());
    }
}

/**
 * @summary Checks the Codex Desktop Sparkle appcast for a newer release, verifies its Ed25519
 * signature against `SUPublicEDKey` before extraction, and admits the extracted `ChatGPT.app`
 * into the Fleet harness generation store via {@link materializeHarnessGeneration}.
 * @param {Object} options
 * @param {String} options.root Absolute store root for harness generations.
 * @param {String} [options.appBundle='/Applications/ChatGPT.app'] Fallback Codex `.app` bundle when no generation is selected yet.
 * @param {Boolean} [options.checkOnly=false] When `true`, parses the appcast and reports availability without downloading.
 * @param {Boolean} [options.retryRejected=false] When `false`, skips re-downloading a build already rejected by the current admitter identity in this process.
 * @param {Object} [options.seams] Injectable test seams (`fsImpl`, `readConfig`, `fetchAppcast`, `downloadArchive`, `extractArchive`, `materialize`, `select`, `readLedger`, `admitterId`, `hostSystemVersion`).
 * @returns {Promise<{status: String, admitted: Boolean, candidate: Object, selected: Object|null, generation: Object|null, reason: String|null}>}
 */
export function acquireCodexDesktopUpdate(options = {}) {
    const root = options?.root;
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
        return Promise.reject(refusal('root-must-be-absolute', String(root)));
    }

    const
        familyDir = path.join(root, CODEX_FAMILY),
        key       = `${familyDir}\0`,
        next      = (acquireChains.get(key) ?? Promise.resolve()).then(() => runAcquireCodexDesktopUpdate(options));

    acquireChains.set(key, next.catch(() => {}));
    return next;
}

/** @summary One serialized acquisition run for `codex-desktop`; see {@link acquireCodexDesktopUpdate}. */
async function runAcquireCodexDesktopUpdate({
    root,
    appBundle = '/Applications/ChatGPT.app',
    checkOnly = false,
    retryRejected = false,
    seams = {}
} = {}) {
    const
        fsImpl            = seams.fsImpl ?? bundleFs,
        readConfig        = seams.readConfig ?? (bundle => readCodexSparkleConfig({appBundle: bundle, fsImpl})),
        fetchAppcast      = seams.fetchAppcast ?? defaultFetchAppcast,
        downloadArchive   = seams.downloadArchive ?? (args => defaultDownloadArchive({...args, fsImpl})),
        extractArchive    = seams.extractArchive ?? defaultExtractArchive,
        materialize       = seams.materialize ?? materializeHarnessGeneration,
        select            = seams.select ?? selectHarnessGeneration,
        readLedger        = seams.readLedger ?? readHarnessGenerationLedger,
        admitterId        = seams.admitterId ?? defaultAdmitterId(),
        hostSystemVersion = seams.hostSystemVersion !== undefined ? seams.hostSystemVersion : defaultHostSystemVersion(),
        familyDir         = path.join(root, CODEX_FAMILY);

    const
        selected        = select({root, family: CODEX_FAMILY}),
        referenceBundle = selected?.appBundle ?? appBundle,
        config          = readConfig(referenceBundle),
        appcastXml      = await fetchAppcast(config.feedUrl),
        releases        = parseCodexSparkleAppcast(appcastXml, {hostSystemVersion}),
        candidate       = releases[0],
        ledger          = readLedger({root, family: CODEX_FAMILY});

    const alreadyAdmitted = ledger.admitted.some(
        entry => entry.shortVersion === candidate.shortVersion && entry.buildVersion === candidate.buildVersion
    );

    if (alreadyAdmitted) {
        return {
            status    : 'up-to-date',
            admitted  : false,
            candidate,
            selected,
            generation: null,
            reason    : null
        };
    }

    const rejectionKey = `${path.resolve(root)}\0${candidate.shortVersion}\0${candidate.buildVersion}\0${admitterId}`;

    if (!retryRejected) {
        const inProcessReason = inProcessRejections.get(rejectionKey);
        const ledgerMatch     = [...ledger.rejected]
            .reverse()
            .find(entry =>
                entry.shortVersion === candidate.shortVersion &&
                entry.buildVersion === candidate.buildVersion &&
                entry.admitterId === admitterId
            );
        const priorReason = inProcessReason ?? ledgerMatch?.reason ?? null;

        if (priorReason) {
            return {
                status    : 'already-rejected',
                admitted  : false,
                candidate,
                selected,
                generation: null,
                reason    : priorReason
            };
        }
    }

    if (checkOnly) {
        return {
            status    : 'update-available',
            admitted  : false,
            candidate,
            selected,
            generation: null,
            reason    : null
        };
    }

    fsImpl.mkdirSync(familyDir, {recursive: true, mode: 0o700});

    for (const entry of fsImpl.readdirSync(familyDir)) {
        if (entry.startsWith(ACQUIRE_PREFIX)) {
            fsImpl.rmSync(path.join(familyDir, entry), {recursive: true, force: true});
        }
    }

    const
        stagingDir  = path.join(familyDir, ACQUIRE_PREFIX + randomUUID()),
        archivePath = path.join(stagingDir, 'codex-update.zip'),
        extractDir  = path.join(stagingDir, 'extracted');

    fsImpl.mkdirSync(extractDir, {recursive: true, mode: 0o700});

    try {
        try {
            await downloadArchive({
                url           : candidate.archiveUrl,
                destination   : archivePath,
                expectedLength: candidate.length
            });
        } catch {
            return {
                status    : 'rejected',
                admitted  : false,
                candidate,
                selected,
                generation: null,
                reason    : 'archive-download-failed'
            };
        }

        const signatureCheck = verifySparkleEdSignature({
            archivePath,
            edSignature: candidate.edSignature,
            publicKey  : config.publicKey,
            length     : candidate.length,
            fsImpl
        });

        if (!signatureCheck.verified) {
            return {
                status    : 'rejected',
                admitted  : false,
                candidate,
                selected,
                generation: null,
                reason    : signatureCheck.reason
            };
        }

        try {
            await extractArchive({archivePath, extractDir});
        } catch {
            return {
                status    : 'rejected',
                admitted  : false,
                candidate,
                selected,
                generation: null,
                reason    : 'archive-extract-failed'
            };
        }

        const extractedBundle = path.join(extractDir, CODEX_APP_NAME);

        let hasExtractedBundle = false;
        try {
            hasExtractedBundle = fsImpl.statSync(extractedBundle).isDirectory();
        } catch {
            hasExtractedBundle = false;
        }

        if (!hasExtractedBundle) {
            return {
                status    : 'rejected',
                admitted  : false,
                candidate,
                selected,
                generation: null,
                reason    : 'extracted-bundle-missing'
            };
        }

        const generation = await materialize({
            root,
            family      : CODEX_FAMILY,
            sourceBundle: extractedBundle,
            source      : candidate.archiveUrl
        });

        if (!generation.admitted) {
            inProcessRejections.set(rejectionKey, generation.reason ?? 'rejected');
        } else {
            inProcessRejections.delete(rejectionKey);
        }

        return {
            status  : generation.admitted ? 'admitted' : 'rejected',
            admitted: generation.admitted,
            candidate,
            selected: select({root, family: CODEX_FAMILY}),
            generation,
            reason  : generation.reason
        };
    } finally {
        fsImpl.rmSync(stagingDir, {recursive: true, force: true});
    }
}

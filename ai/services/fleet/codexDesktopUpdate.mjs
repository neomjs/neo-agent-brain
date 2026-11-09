import {spawnSync}                                             from 'node:child_process';
import {createPublicKey, randomUUID, verify}                   from 'node:crypto';
import nodeFs                                                  from 'node:fs';
import {createRequire}                                         from 'node:module';
import path                                                    from 'node:path';
import { Readable }                                            from 'node:stream';
import { pipeline }                                            from 'node:stream/promises';
import {materializeHarnessGeneration, selectHarnessGeneration} from './harnessGeneration.mjs';

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
    LEDGER_FILE         = 'ledger.json',
    PLIST_BUDDY         = '/usr/libexec/PlistBuddy';

/** @summary Creates a named refusal Error with a stable `code` property. */
function refusal(code, detail = '') {
    return Object.assign(new Error(`codexDesktopUpdate: ${code}${detail ? ` — ${detail}` : ''}`), {code});
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

/** @summary Compares two `buildVersion` strings newest-first (numeric when digits-only, else lexical). */
function compareBuildVersionsDesc(left, right) {
    if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
        const diff = BigInt(right) - BigInt(left);
        return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    }

    return right.localeCompare(left);
}

/**
 * @summary Parses a Sparkle 2 RSS appcast XML document and returns compatible full-archive
 * release items ordered newest-first by `buildVersion`. Nested `<sparkle:deltas>` blocks and
 * `sparkle:deltaFrom` enclosures are stripped so binary deltas are never selected as full bundles.
 * @param {String} xml Raw `appcast.xml` string.
 * @param {Object} [options]
 * @param {String} [options.hardwareRequirements='arm64'] Required hardware architecture tag when present on an item.
 * @returns {Array<{shortVersion: String, buildVersion: String, minimumSystemVersion: String|null,
 *                  hardwareRequirements: String|null, pubDate: String|null, archiveUrl: String,
 *                  length: Number, edSignature: String}>}
 */
export function parseCodexSparkleAppcast(xml, {hardwareRequirements = 'arm64'} = {}) {
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

/** @summary Reads the family ledger if present so acquisition can skip already-admitted or already-rejected builds. */
function readFamilyLedger(familyDir, fsImpl) {
    try {
        const parsed = JSON.parse(fsImpl.readFileSync(path.join(familyDir, LEDGER_FILE), 'utf8'));
        return {
            admitted: Array.isArray(parsed?.admitted) ? parsed.admitted : [],
            rejected: Array.isArray(parsed?.rejected) ? parsed.rejected : []
        };
    } catch (error) {
        if (error?.code === 'ENOENT') return {admitted: [], rejected: []};
        throw refusal('ledger-invalid', familyDir);
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

/** @summary Default streaming HTTPS archive downloader. */
async function defaultDownloadArchive({url, destination, fsImpl = bundleFs}) {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
        throw refusal('archive-download-failed', `HTTP ${response.status}`);
    }
    const writer = fsImpl.createWriteStream(destination, {mode: 0o600});
    await pipeline(Readable.fromWeb(response.body), writer);
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
 * @param {Boolean} [options.retryRejected=false] When `false`, skips re-downloading a build already recorded in `ledger.rejected`.
 * @param {Object} [options.seams] Injectable test seams (`fsImpl`, `readConfig`, `fetchAppcast`, `downloadArchive`, `extractArchive`, `materialize`, `select`).
 * @returns {Promise<{status: String, admitted: Boolean, candidate: Object, selected: Object|null, generation: Object|null, reason: String|null}>}
 */
export async function acquireCodexDesktopUpdate({
    root,
    appBundle = '/Applications/ChatGPT.app',
    checkOnly = false,
    retryRejected = false,
    seams = {}
} = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
        throw refusal('root-must-be-absolute', String(root));
    }

    const
        fsImpl          = seams.fsImpl ?? bundleFs,
        readConfig      = seams.readConfig ?? (bundle => readCodexSparkleConfig({appBundle: bundle, fsImpl})),
        fetchAppcast    = seams.fetchAppcast ?? defaultFetchAppcast,
        downloadArchive = seams.downloadArchive ?? (args => defaultDownloadArchive({...args, fsImpl})),
        extractArchive  = seams.extractArchive ?? defaultExtractArchive,
        materialize     = seams.materialize ?? materializeHarnessGeneration,
        select          = seams.select ?? selectHarnessGeneration,
        familyDir       = path.join(root, CODEX_FAMILY);

    const
        selected        = select({root, family: CODEX_FAMILY}),
        referenceBundle = selected?.appBundle ?? appBundle,
        config          = readConfig(referenceBundle),
        appcastXml      = await fetchAppcast(config.feedUrl),
        releases        = parseCodexSparkleAppcast(appcastXml),
        candidate       = releases[0],
        ledger          = readFamilyLedger(familyDir, fsImpl);

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

    if (!retryRejected) {
        const priorRejection = [...ledger.rejected]
            .reverse()
            .find(entry => entry.shortVersion === candidate.shortVersion && entry.buildVersion === candidate.buildVersion);

        if (priorRejection) {
            return {
                status    : 'already-rejected',
                admitted  : false,
                candidate,
                selected,
                generation: null,
                reason    : priorRejection.reason ?? 'rejected'
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

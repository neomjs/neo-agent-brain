import {spawnSync}                               from 'node:child_process';
import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import nodeFs                                    from 'node:fs';
import {createRequire}                           from 'node:module';
import path                                      from 'node:path';
import {Readable, Transform}                     from 'node:stream';
import {pipeline}                                from 'node:stream/promises';
import {fileURLToPath}                           from 'node:url';
import {materializeHarnessGeneration}            from './harnessGeneration.mjs';

/**
 * @module ai/services/fleet/acquireHarnessArchive
 * @summary The half of a harness acquisition that does not depend on the vendor. Runs for one family never
 * overlap; a build the same admitting code already rejected is not fetched again; the archive streams into the
 * family's staging directory under a byte cap while its digest is computed; nothing is extracted unless that
 * digest equals the one the source named; and the one extracted `.app` goes to `materializeHarnessGeneration`,
 * which alone decides admission. A family's acquisition module only says where its candidate comes from.
 */

// Physical fs, so Electron's ASAR virtualization never intercepts the staging reads.
const fs = process.versions.electron ? createRequire(import.meta.url)('original-fs') : nodeFs;

const
    DITTO      = '/usr/bin/ditto',
    MODULE_DIR = path.dirname(fileURLToPath(import.meta.url)),
    // The largest archive a run accepts; vendor archives run to about 400 MB.
    MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024,
    STAGING_PREFIX    = '.update-staging-',
    admitterIds       = new Map(),
    chains            = new Map(),
    rejections        = new Map();

/**
 * @summary A refusal with a stable `.code`.
 * @param {String} code
 * @param {String} [detail='']
 * @returns {Error}
 */
function refusal(code, detail = '') {
    return Object.assign(new Error(`acquireHarnessArchive: ${code}${detail ? ` — ${detail}` : ''}`), {code})
}

/**
 * @summary Compares two dotted numeric versions (`5.11492.0` vs `5.1231.0`) one numeric part at a time.
 * @param {String} left
 * @param {String} right
 * @returns {Number} `1` if `left` is newer, `-1` if older, `0` if equal.
 */
export function compareDottedVersions(left, right) {
    const
        a = String(left ?? '').split(/[^0-9]+/).filter(Boolean).map(Number),
        b = String(right ?? '').split(/[^0-9]+/).filter(Boolean).map(Number);

    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const av = a[i] ?? 0, bv = b[i] ?? 0;

        if (av !== bv) return av > bv ? 1 : -1
    }

    return 0
}

/**
 * @summary The fingerprint of the code that admits a family's builds, so a rejection this process remembers
 * expires as soon as that code changes.
 * @param {String[]} files Module file names in this directory.
 * @returns {String}
 */
export function harnessAdmitterId(files) {
    const key = files.join('\0');

    if (!admitterIds.has(key)) {
        const hash = createHash('sha256');

        for (const file of files) {
            try {
                hash.update(fs.readFileSync(path.join(MODULE_DIR, file)))
            } catch {
                hash.update(file)
            }
        }

        admitterIds.set(key, hash.digest('hex'))
    }

    return admitterIds.get(key)
}

/**
 * @summary Runs `run` once every earlier acquisition of the same family in the same store has settled, so a
 * run can sweep the family's staging without touching a live one.
 * @param {Object} options
 * @param {String} options.root Absolute store root.
 * @param {String} options.family A harness generation family.
 * @param {Function} run `() => Promise`.
 * @returns {Promise}
 */
export function serializeHarnessAcquisition({root, family}, run) {
    const
        key  = `${path.resolve(root)}\0${family}`,
        next = (chains.get(key) ?? Promise.resolve()).then(run);

    chains.set(key, next.catch(() => {}));
    return next
}

/**
 * @summary Extracts a `.zip` with macOS `ditto -x -k`, without a shell.
 * @param {String} archivePath
 * @param {String} destinationDir
 */
export function extractZipArchive(archivePath, destinationDir) {
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
 * @summary Streams a response body to `destination` under the byte limit while hashing every byte. It refuses
 * before anything can be extracted unless the digest, and the size when the source named one, match.
 * @param {Object} options
 * @param {Object} options.response A fetch `Response` (a web stream, an iterable or `arrayBuffer()`).
 * @param {String} options.destination
 * @param {String} options.algorithm A Node digest name.
 * @param {Buffer} options.expectedDigest
 * @param {Number|null} options.expectedSize
 * @param {Number} options.maxBytes
 * @param {Object} options.fsImpl
 * @returns {Promise<{byteLength: Number, digest: String}>} `digest` in hex.
 */
async function streamVerifiedArchive({response, destination, algorithm, expectedDigest, expectedSize, maxBytes, fsImpl}) {
    if (expectedSize !== null) {
        if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) throw refusal('archive-size-invalid', String(expectedSize));
        if (expectedSize > maxBytes)                                   throw refusal('archive-too-large', String(expectedSize))
    }

    let source;

    if (typeof response?.body?.getReader === 'function') {
        source = Readable.fromWeb(response.body)
    } else if (response?.body && (typeof response.body[Symbol.asyncIterator] === 'function' || typeof response.body.pipe === 'function')) {
        source = Readable.from(response.body)
    } else if (typeof response?.arrayBuffer === 'function') {
        source = Readable.from([Buffer.from(await response.arrayBuffer())])
    } else {
        throw refusal('archive-fetch-failed', 'missing response body')
    }

    const
        hash  = createHash(algorithm),
        limit = expectedSize ?? maxBytes;

    let byteLength = 0;

    const limiter = new Transform({
        transform(chunk, _encoding, callback) {
            byteLength += chunk.length;

            if (byteLength > limit) {
                callback(expectedSize === null
                    ? refusal('archive-too-large', `over ${maxBytes} bytes`)
                    : refusal('archive-size-mismatch', `expected ${expectedSize}, exceeded at ${byteLength}`));
                return
            }

            hash.update(chunk);
            callback(null, chunk)
        }
    });

    await pipeline(source, limiter, fsImpl.createWriteStream(destination, {mode: 0o600}));

    if (byteLength === 0) throw refusal('archive-empty');

    if (expectedSize !== null && byteLength !== expectedSize) {
        throw refusal('archive-size-mismatch', `expected ${expectedSize}, got ${byteLength}`)
    }

    const digest = hash.digest();

    if (digest.length !== expectedDigest.length || !timingSafeEqual(digest, expectedDigest)) {
        throw refusal('digest-mismatch', algorithm)
    }

    return {byteLength, digest: digest.toString('hex')}
}

/**
 * @summary The one `.app` an extracted archive holds; none or several refuse.
 * @param {String} directory
 * @param {Object} fsImpl
 * @returns {String}
 */
function findExtractedAppBundle(directory, fsImpl) {
    const apps = fsImpl.readdirSync(directory, {withFileTypes: true})
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.endsWith('.app'));

    if (apps.length !== 1) throw refusal('extracted-bundle-ambiguous', `found ${apps.length} .app bundles`);

    return path.join(directory, apps[0].name)
}

/**
 * @summary Fetches a candidate build's archive, verifies it, extracts it and hands its one `.app` to admission,
 * recording the archive URL as the generation's `source`. Callers run it inside
 * {@link serializeHarnessAcquisition}: it sweeps the family's staging left by a killed run, and the staging
 * it creates is always removed.
 * @param {Object} options
 * @param {String} options.root Absolute store root.
 * @param {String} options.family A harness generation family.
 * @param {String} options.version The candidate's short version.
 * @param {String} options.archiveUrl
 * @param {String} options.algorithm A Node digest name (`sha256`, `sha512`).
 * @param {Buffer} options.expectedDigest The digest the source named.
 * @param {Number|null} [options.expectedSize=null] The byte length the source named, if it names one.
 * @param {String} options.admitterId {@link harnessAdmitterId} of the family's admitting code.
 * @param {Boolean} [options.retryRejected=false] Fetch a build this admitter already rejected.
 * @param {Number} [options.maxBytes=MAX_ARCHIVE_BYTES]
 * @param {Function} [options.fetchImpl=globalThis.fetch]
 * @param {Function} [options.extractArchive=extractZipArchive] `(archivePath, destinationDir) => void`.
 * @param {Function} [options.materializeGeneration=materializeHarnessGeneration]
 * @param {Object} [options.fsImpl]
 * @returns {Promise<{status: 'already-rejected'|'admitted'|'rejected', generation: Object|null, reason: String|null,
 *     verification?: {byteLength: Number, digest: String}}>}
 */
export async function acquireHarnessArchive({
    root,
    family,
    version,
    archiveUrl,
    algorithm,
    expectedDigest,
    expectedSize          = null,
    admitterId,
    retryRejected         = false,
    maxBytes              = MAX_ARCHIVE_BYTES,
    fetchImpl             = globalThis.fetch,
    extractArchive        = extractZipArchive,
    materializeGeneration = materializeHarnessGeneration,
    fsImpl                = fs
}) {
    const rejectionKey = [path.resolve(root), family, version, admitterId].join('\0');

    if (!retryRejected && rejections.has(rejectionKey)) {
        return {status: 'already-rejected', generation: null, reason: rejections.get(rejectionKey)}
    }

    const response = await fetchImpl(archiveUrl);

    if (!response?.ok) throw refusal('archive-fetch-failed', `HTTP ${response?.status ?? 'unknown'}`);

    const
        familyRoot  = path.join(root, family),
        stagingRoot = path.join(familyRoot, `${STAGING_PREFIX}${randomUUID()}`),
        archivePath = path.join(stagingRoot, 'update.zip'),
        extractDir  = path.join(stagingRoot, 'extracted');

    fsImpl.mkdirSync(familyRoot, {recursive: true, mode: 0o700});

    for (const entry of fsImpl.readdirSync(familyRoot)) {
        if (entry.startsWith(STAGING_PREFIX)) fsImpl.rmSync(path.join(familyRoot, entry), {recursive: true, force: true})
    }

    fsImpl.mkdirSync(extractDir, {recursive: true, mode: 0o700});

    try {
        const verification = await streamVerifiedArchive({
            response, destination: archivePath, algorithm, expectedDigest, expectedSize, maxBytes, fsImpl
        });

        extractArchive(archivePath, extractDir);

        const admission = await materializeGeneration({
            root, family, sourceBundle: findExtractedAppBundle(extractDir, fsImpl), source: archiveUrl
        });

        if (admission.admitted) {
            rejections.delete(rejectionKey)
        } else {
            rejections.set(rejectionKey, admission.reason ?? 'rejected')
        }

        return {status: admission.admitted ? 'admitted' : 'rejected', generation: admission, reason: admission.reason ?? null, verification}
    } finally {
        fsImpl.rmSync(stagingRoot, {recursive: true, force: true})
    }
}

export default acquireHarnessArchive;

import path from 'node:path';
import {
    acquireHarnessArchive,
    compareDottedVersions,
    harnessAdmitterId,
    serializeHarnessAcquisition
} from './acquireHarnessArchive.mjs';
import {
    readHarnessBundleInfo,
    readHarnessGenerationLedger,
    selectHarnessGeneration
} from './harnessGeneration.mjs';

/**
 * @module ai/services/fleet/claudeDesktopUpdate
 * @summary Acquires Claude Desktop (`Claude.app`) builds. Anthropic publishes no feed an unattended client can
 * read: the app's own update feed needs the installation's device id, and the download link answers automated
 * clients with a bot challenge. The versioned zip under `downloads.claude.ai` is served freely, but its name
 * carries the build's commit, which nothing first-party announces. Homebrew's public cask record names that zip
 * and its SHA-256 within hours of a release, so the record is the pointer, and an untrusted one. It only decides
 * whether to download: its URL must have the vendor's release shape and carry the record's own version and
 * commit, and the bytes must match its digest before anything is extracted. Admission then proves the bundle
 * itself (Team ID, codesign, Gatekeeper, the runtime probe), exactly as it proves an installed build.
 */

const
    FAMILY             = 'claude-desktop',
    DEFAULT_APP_BUNDLE = '/Applications/Claude.app',
    // Homebrew's JSON API for the `claude` cask: `version` is `<version>,<commit>`, `url` the zip, `sha256` its digest
    CASK_RECORD_URL    = 'https://formulae.brew.sh/api/cask/claude.json',
    MAX_RECORD_CHARS   = 1024 * 1024,
    RELEASE_URL        = /^https:\/\/downloads\.claude\.ai\/releases\/darwin\/universal\/(\d+(?:\.\d+)+)\/Claude-([0-9a-f]{7,64})\.zip$/,
    // the code whose verdict a remembered rejection stands for
    ADMITTER_FILES     = ['harnessGeneration.mjs', 'probeClaudeDesktopRuntime.mjs', 'acquireHarnessArchive.mjs', 'claudeDesktopUpdate.mjs'];

/**
 * @summary A refusal with a stable `.code`.
 * @param {String} code
 * @param {String} [detail='']
 * @returns {Error}
 */
function refusal(code, detail = '') {
    return Object.assign(new Error(`claudeDesktopUpdate: ${code}${detail ? ` — ${detail}` : ''}`), {code})
}

/**
 * @summary Reads the candidate a cask record names, refusing any record whose URL is not the vendor's release
 * zip for the record's own version and commit, or whose digest is not a SHA-256.
 * @param {Object} record The parsed `claude.json`.
 * @returns {{version: String, commit: String, archiveUrl: String, sha256: String}} `sha256` in lowercase hex.
 * @throws {Error} `record-version-invalid`, `record-url-invalid`, `record-url-mismatch` or `record-digest-invalid`.
 */
export function parseClaudeCaskRecord(record) {
    const [version = '', commit = ''] = typeof record?.version === 'string' ? record.version.split(',') : [];

    if (!/^\d+(\.\d+)+$/.test(version) || !/^[0-9a-f]{7,64}$/.test(commit)) {
        throw refusal('record-version-invalid', String(record?.version))
    }

    const match = typeof record.url === 'string' ? RELEASE_URL.exec(record.url) : null;

    if (!match)                                      throw refusal('record-url-invalid', String(record.url));
    if (match[1] !== version || match[2] !== commit) throw refusal('record-url-mismatch', `${record.url} for ${record.version}`);

    const sha256 = typeof record.sha256 === 'string' ? record.sha256.toLowerCase() : '';

    if (!/^[0-9a-f]{64}$/.test(sha256)) throw refusal('record-digest-invalid', String(record.sha256));

    return {version, commit, archiveUrl: record.url, sha256}
}

/**
 * @summary Fetches and parses the cask record.
 * @param {Function} fetchImpl
 * @param {String} recordUrl
 * @returns {Promise<Object>}
 */
async function fetchCaskRecord(fetchImpl, recordUrl) {
    const response = await fetchImpl(recordUrl, {headers: {Accept: 'application/json'}});

    if (!response?.ok) throw refusal('record-fetch-failed', `HTTP ${response?.status ?? 'unknown'}`);

    const text = await response.text();

    if (text.length > MAX_RECORD_CHARS) throw refusal('record-too-large', String(text.length));

    try {
        return JSON.parse(text)
    } catch {
        throw refusal('record-invalid', 'not JSON')
    }
}

/**
 * @summary Asks the cask record for a build newer than the one Claude seats start from next: the selected
 * generation, else the installed bundle. A host with neither takes any candidate.
 * @param {Object} [options]
 * @param {String|null} [options.root=null] Absolute store root; without it no generation is selected or admitted.
 * @param {String} [options.appBundle='/Applications/Claude.app'] The installed bundle.
 * @param {Function} [options.fetchImpl=globalThis.fetch]
 * @param {Function} [options.readBundleInfo=readHarnessBundleInfo]
 * @param {Function} [options.readLedger=readHarnessGenerationLedger]
 * @param {Function} [options.select=selectHarnessGeneration]
 * @param {String} [options.recordUrl] The cask record's URL.
 * @returns {Promise<{updateAvailable: Boolean, alreadyAdmitted: Boolean, currentVersion: String|null,
 *     selectedGenerationId: String|null, candidate: Object, recordUrl: String}>}
 */
export async function checkClaudeDesktopUpdate({
    root           = null,
    appBundle      = DEFAULT_APP_BUNDLE,
    fetchImpl      = globalThis.fetch,
    readBundleInfo = readHarnessBundleInfo,
    readLedger     = readHarnessGenerationLedger,
    select         = selectHarnessGeneration,
    recordUrl      = CASK_RECORD_URL
} = {}) {
    if (typeof fetchImpl !== 'function') throw refusal('fetch-unavailable');

    const
        storeRoot = typeof root === 'string' && path.isAbsolute(root) ? root : null,
        selected  = storeRoot ? select({root: storeRoot, family: FAMILY}) : null,
        candidate = parseClaudeCaskRecord(await fetchCaskRecord(fetchImpl, recordUrl));

    let currentVersion = selected?.shortVersion ?? null;

    if (!currentVersion) {
        try {
            currentVersion = readBundleInfo(appBundle).shortVersion || null
        } catch {
            currentVersion = null
        }
    }

    const alreadyAdmitted = storeRoot !== null &&
        readLedger({root: storeRoot, family: FAMILY}).admitted.some(generation => generation.shortVersion === candidate.version);

    return {
        updateAvailable     : !alreadyAdmitted && (currentVersion === null || compareDottedVersions(candidate.version, currentVersion) > 0),
        alreadyAdmitted,
        currentVersion,
        selectedGenerationId: selected?.id ?? null,
        candidate,
        recordUrl
    }
}

/**
 * @summary One acquisition run for Claude Desktop: {@link checkClaudeDesktopUpdate}, then, for a newer build,
 * {@link acquireHarnessArchive} with the record's SHA-256. Runs for one store never overlap.
 * @param {Object} options
 * @param {String} options.root Absolute store root.
 * @param {String} [options.appBundle] The installed bundle.
 * @param {Boolean} [options.force=false] Download even when the record names no newer build.
 * @param {Boolean} [options.retryRejected=false] Download a build this admitting code already rejected.
 * @param {String} [options.admitterId] The admitting code's fingerprint.
 * @param {Object} [options.seams] The remaining options: {@link checkClaudeDesktopUpdate}'s (`fetchImpl`,
 * `readBundleInfo`, `readLedger`, `select`, `recordUrl`) and {@link acquireHarnessArchive}'s (`fetchImpl`,
 * `maxBytes`, `extractArchive`, `materializeGeneration`, `fsImpl`); each reads its own and ignores the rest.
 * @returns {Promise<{status: 'up-to-date'|'already-rejected'|'admitted'|'rejected', check: Object,
 *     generation: Object|null, reason?: String|null, verification?: Object}>}
 */
export function acquireClaudeDesktopUpdate({root, appBundle, force = false, retryRejected = false, admitterId, ...seams} = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
        return Promise.reject(refusal('invalid-root', 'root must be an absolute path'))
    }

    return serializeHarnessAcquisition({root, family: FAMILY}, async () => {
        const check = await checkClaudeDesktopUpdate({...seams, root, appBundle});

        if (!force && !check.updateAvailable) return {status: 'up-to-date', check, generation: null};

        const {candidate} = check;

        return {
            check,
            ...await acquireHarnessArchive({
                ...seams,
                root,
                family        : FAMILY,
                version       : candidate.version,
                archiveUrl    : candidate.archiveUrl,
                algorithm     : 'sha256',
                expectedDigest: Buffer.from(candidate.sha256, 'hex'),
                admitterId    : admitterId ?? harnessAdmitterId(ADMITTER_FILES),
                retryRejected
            })
        }
    })
}

export default acquireClaudeDesktopUpdate;

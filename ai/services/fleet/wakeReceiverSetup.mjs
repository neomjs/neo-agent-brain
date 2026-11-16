/**
 * @module ai/services/fleet/wakeReceiverSetup
 * @summary Host bootstrap, ownership reconciliation, plist serialization, owner-private records preparation,
 * and cold zero-route manifest setup for the per-user macOS desktop wake receiver (`com.neomjs.agent-os-wake`).
 *
 * Designed as one shared substrate for both CLI (`ai/scripts/setup/firstRun.mjs`) and Fleet setup callers
 * without reading Agent OS config (`AiConfig`) or `process.env` directly: callers pass resolved paths and a
 * `createHost()` adapter (filesystem, command runner, clock, platform, UID, HTTP listener probe).
 */

import http                                           from 'node:http';
import path                                           from 'node:path';
import {writeFileAtomic}                              from '../shared/atomicFileWrite.mjs';
import {runtimeGenerationArguments, runtimeGenerationPin} from './runtimeGeneration.mjs';
import {contentDigest}                                from './setupRunRecord.mjs';

/**
 * Canonical macOS per-user LaunchAgent label for the wake receiver.
 * @type {String}
 */
export const WAKE_RECEIVER_LABEL = 'com.neomjs.agent-os-wake';

/**
 * Canonical LaunchAgent plist filename under `~/Library/LaunchAgents`.
 * @type {String}
 */
export const WAKE_RECEIVER_PLIST_NAME = 'com.neomjs.agent-os-wake.plist';

/**
 * Relative receiver entrypoint resolved under the Agent OS runtime root (`WorkingDirectory`).
 * @type {String}
 */
export const WAKE_RECEIVER_ENTRYPOINT = 'ai/daemons/wake/receiver.mjs';

/**
 * Default loopback bind host declared for local wake delivery.
 * @type {String}
 */
export const WAKE_RECEIVER_DEFAULT_HOST = '127.0.0.1';

/**
 * Default loopback port declared for local wake delivery.
 * @type {Number}
 */
export const WAKE_RECEIVER_DEFAULT_PORT = 3199;

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

const PRIVATE_DIR_MODE  = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const LAUNCHD_READY_ATTEMPTS = 12;
const LAUNCHD_READY_DELAY_MS = 100;

const XML_ENTITIES = Object.freeze({
    amp : '&',
    lt  : '<',
    gt  : '>',
    quot: '"',
    apos: '\''
});

/**
 * @summary Validates an unambiguous, normalized absolute non-root path without NUL bytes.
 * @param {String} value
 * @param {String} label
 * @returns {String}
 */
function assertSafeAbsolutePath(value, label) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0') ||
        !path.isAbsolute(value) || path.normalize(value) !== value || value === path.parse(value).root) {
        throw new Error(`wakeReceiverSetup: ${label} must be a normalized absolute non-root path.`);
    }

    return value;
}

function escapeXml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&apos;');
}

function unescapeXml(value, contextLabel) {
    return value.replace(/&([a-z]+);/gi, (match, name) => {
        const mapped = XML_ENTITIES[name.toLowerCase()];

        if (!mapped) {
            throw new Error(`wakeReceiverSetup: unknown XML entity '${match}' in ${contextLabel}.`);
        }

        return mapped;
    });
}

function resolvePlatform(host) {
    if (typeof host?.platform === 'function') {
        return host.platform();
    }

    return typeof host?.platform === 'string' ? host.platform : null;
}

function resolveHostUid(host) {
    if (typeof host?.uid === 'function') {
        const uid = host.uid();

        return Number.isInteger(uid) ? uid : null;
    }

    return Number.isInteger(host?.uid) ? host.uid : null;
}

function sameOptionalUid(stat, hostUid) {
    return hostUid === null || !Number.isInteger(stat?.uid) || stat.uid === hostUid;
}

async function safeLstat(fsModule, targetPath) {
    if (typeof fsModule.lstat === 'function') {
        return fsModule.lstat(targetPath);
    }

    return fsModule.stat(targetPath);
}

/**
 * @summary Resolves all host paths and endpoint defaults for the desktop wake receiver from a setup layout.
 * @param {Object} [layout={}]
 * @param {Object} [options={}]
 * @param {Boolean} [options.declined=false]
 * @param {Boolean} [options.supported=true]
 * @returns {Object}
 */
export function resolveWakeSetupPaths(layout = {}, {declined = false, supported = true} = {}) {
    const
        stateRoot                = layout.stateRoot ?? (layout.secretsDir ? path.dirname(layout.secretsDir) : null),
        homeDir                  = layout.homeDir ?? (stateRoot ? path.dirname(stateRoot) : null),
        wakeStateDir             = layout.wakeStateDir ?? (stateRoot ? path.join(stateRoot, 'wake-receiver') : null),
        receiverlessWakeStateDir = layout.receiverlessWakeStateDir ?? (stateRoot ? path.join(stateRoot, 'wake-receiver-disabled') : null),
        selectedStateDir         = declined || !supported ? receiverlessWakeStateDir : wakeStateDir,
        recordsDir               = selectedStateDir ? path.join(selectedStateDir, 'records') : null,
        manifestPath             = layout.wakeManifestPath ?? (wakeStateDir ? path.join(wakeStateDir, 'manifest.json') : null),
        custodyPath              = layout.wakeCustodyPath ?? (wakeStateDir ? path.join(wakeStateDir, WAKE_RECEIVER_CUSTODY_FILE) : null),
        plistPath                = layout.wakePlistPath ?? (homeDir ? path.join(homeDir, 'Library', 'LaunchAgents', WAKE_RECEIVER_PLIST_NAME) : null),
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
 * Enabled macOS setup binds the active receiver's `wake-receiver/records`; declined or unsupported OS setup
 * binds an explicit empty receiver-less directory (`wake-receiver-disabled/records`).
 * @param {Object} layout
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
 * @summary Strict parser for XML LaunchAgent property lists. Rejects XML comments by default so materialized
 * plists stay compatible with strict readers (`neo-agent-institution/harness/wakeReceiver.mjs#parsePlist`),
 * while allowing `allowComments: true` solely for reading the commented repository template.
 * @param {String} xml
 * @param {Object} [options={}]
 * @param {Boolean} [options.allowComments=false]
 * @returns {Object} Root dictionary parsed from `<plist><dict>...</dict></plist>`.
 */
export function parseLaunchAgentPlist(xml, {allowComments = false} = {}) {
    if (typeof xml !== 'string' || xml.trim().length === 0) {
        throw new Error('wakeReceiverSetup: property list content must be a non-empty XML string.');
    }

    if (xml.startsWith('bplist')) {
        throw new Error('wakeReceiverSetup: binary property lists are unsupported; expected XML plist.');
    }

    const
        source = xml.trim(),
        tokens = [];
    let cursor      = 0,
        seenXmlDecl = false,
        seenDoctype = false,
        seenRoot    = false;

    while (cursor < source.length) {
        const lt = source.indexOf('<', cursor);

        if (lt < 0) {
            if (source.slice(cursor).trim().length > 0) {
                throw new Error('wakeReceiverSetup: unexpected trailing text in property list.');
            }

            break;
        }

        const inLeaf = tokens.at(-1)?.type === 'open' && ['key', 'string', 'integer'].includes(tokens.at(-1).name);

        if (lt > cursor) {
            const text = source.slice(cursor, lt);

            if (inLeaf) {
                tokens.push({type: 'text', value: text});
            } else if (text.trim().length > 0) {
                throw new Error(`wakeReceiverSetup: unexpected text '${text.trim()}' between tags.`);
            }
        }

        if (source.startsWith('<!--', lt)) {
            if (!allowComments) {
                throw new Error('wakeReceiverSetup: materialized LaunchAgent plist must not contain XML comments.');
            }

            if (inLeaf) {
                throw new Error('wakeReceiverSetup: XML comments are not permitted inside scalar plist values.');
            }

            const commentEnd = source.indexOf('-->', lt + 4);

            if (commentEnd < 0) {
                throw new Error('wakeReceiverSetup: unclosed XML comment in property list.');
            }

            const commentBody = source.slice(lt + 4, commentEnd);

            if (commentBody.includes('--') || commentBody.endsWith('-')) {
                throw new Error('wakeReceiverSetup: invalid "--" inside XML comment in property list.');
            }

            cursor = commentEnd + 3;
            continue;
        }

        if (source.startsWith('<?', lt)) {
            if (lt !== 0 || seenXmlDecl || seenDoctype || seenRoot || !/^<\?xml[\s]/.test(source)) {
                throw new Error('wakeReceiverSetup: unexpected processing instruction inside property list.');
            }

            const declEnd = source.indexOf('?>', lt + 5);

            if (declEnd < 0) {
                throw new Error('wakeReceiverSetup: unclosed XML declaration in property list.');
            }

            if (source.slice(lt + 5, declEnd).includes('<')) {
                throw new Error('wakeReceiverSetup: malformed XML declaration in property list.');
            }

            seenXmlDecl = true;
            cursor      = declEnd + 2;
            continue;
        }

        if (source.startsWith('<!', lt)) {
            if (seenDoctype || seenRoot || !/^<!DOCTYPE[\s]+plist\b/.test(source.slice(lt))) {
                throw new Error('wakeReceiverSetup: unexpected declaration inside property list.');
            }

            const doctypeEnd = source.indexOf('>', lt + 9);

            if (doctypeEnd < 0) {
                throw new Error('wakeReceiverSetup: unclosed DOCTYPE declaration in property list.');
            }

            if (source.slice(lt + 9, doctypeEnd).includes('<')) {
                throw new Error('wakeReceiverSetup: malformed DOCTYPE declaration in property list.');
            }

            seenDoctype = true;
            cursor      = doctypeEnd + 1;
            continue;
        }

        const gt = source.indexOf('>', lt + 1);

        if (gt < 0) {
            throw new Error('wakeReceiverSetup: unclosed XML tag in property list.');
        }

        const rawTag = source.slice(lt + 1, gt).trim();

        if (rawTag.includes('<')) {
            throw new Error('wakeReceiverSetup: malformed XML tag in property list.');
        }

        seenRoot = true;

        const
            closeMatch = /^\/([A-Za-z]+)$/.exec(rawTag),
            selfMatch  = !closeMatch && /^([A-Za-z]+)\s*\/$/.exec(rawTag),
            openMatch  = !closeMatch && !selfMatch && /^(?:(plist)(?:\s+version="1\.0")?|([A-Za-z]+))$/.exec(rawTag);

        if (closeMatch) {
            tokens.push({type: 'close', name: closeMatch[1]});
        } else if (selfMatch) {
            tokens.push({type: 'self', name: selfMatch[1]});
        } else if (openMatch) {
            tokens.push({type: 'open', name: openMatch[1] || openMatch[2]});
        } else {
            throw new Error(`wakeReceiverSetup: malformed XML tag '<${rawTag}>'.`);
        }

        cursor = gt + 1;
    }

    let index = 0;
    const peek = () => tokens[index];
    const next = () => tokens[index++];

    const readTextValue = tagName => {
        const maybeText = peek();
        let raw = '';

        if (maybeText?.type === 'text') {
            raw = next().value;
        }

        const closing = next();

        if (!closing || closing.type !== 'close' || closing.name !== tagName) {
            throw new Error(`wakeReceiverSetup: expected </${tagName}> in property list.`);
        }

        return unescapeXml(raw, `<${tagName}>`);
    };

    const parseDict = () => {
        const dict = {};

        while (peek()) {
            const token = peek();

            if (token.type === 'close' && token.name === 'dict') {
                next();

                return dict;
            }

            const keyOpen = next();

            if (!keyOpen || keyOpen.type !== 'open' || keyOpen.name !== 'key') {
                throw new Error('wakeReceiverSetup: expected <key> inside <dict>.');
            }

            const key = readTextValue('key');

            if (Object.hasOwn(dict, key)) {
                throw new Error(`wakeReceiverSetup: duplicate <key> '${key}' in <dict>.`);
            }

            dict[key] = parseValue();
        }

        throw new Error('wakeReceiverSetup: unclosed <dict> in property list.');
    };

    const parseArray = () => {
        const list = [];

        while (peek()) {
            const token = peek();

            if (token.type === 'close' && token.name === 'array') {
                next();

                return list;
            }

            list.push(parseValue());
        }

        throw new Error('wakeReceiverSetup: unclosed <array> in property list.');
    };

    const parseValue = () => {
        const token = next();

        if (!token) {
            throw new Error('wakeReceiverSetup: unexpected end of property list.');
        }

        if (token.type === 'self') {
            if (token.name === 'true') {
                return true;
            }

            if (token.name === 'false') {
                return false;
            }

            if (token.name === 'string') {
                return '';
            }

            if (token.name === 'array') {
                return [];
            }

            if (token.name === 'dict') {
                return {};
            }

            throw new Error(`wakeReceiverSetup: unsupported self-closing tag <${token.name}/>.`);
        }

        if (token.type !== 'open') {
            throw new Error(`wakeReceiverSetup: expected value tag, got ${token.type} '${token.name ?? ''}'.`);
        }

        switch (token.name) {
            case 'dict':
                return parseDict();
            case 'array':
                return parseArray();
            case 'string':
                return readTextValue('string');
            case 'integer': {
                const raw = readTextValue('integer').trim();

                if (!/^-?\d+$/.test(raw)) {
                    throw new Error(`wakeReceiverSetup: invalid <integer> value '${raw}'.`);
                }

                return Number(raw);
            }
            default:
                throw new Error(`wakeReceiverSetup: unsupported plist value tag <${token.name}>.`);
        }
    };

    const rootOpen = next();

    if (!rootOpen || rootOpen.type !== 'open' || rootOpen.name !== 'plist') {
        throw new Error('wakeReceiverSetup: property list must begin with <plist>.');
    }

    const root = parseValue();
    const rootClose = next();

    if (!rootClose || rootClose.type !== 'close' || rootClose.name !== 'plist') {
        throw new Error('wakeReceiverSetup: expected closing </plist>.');
    }

    if (peek() !== undefined) {
        throw new Error('wakeReceiverSetup: trailing content follows </plist>.');
    }

    if (!root || typeof root !== 'object' || Array.isArray(root)) {
        throw new Error('wakeReceiverSetup: property list root must be a <dict>.');
    }

    return root;
}

function renderPlistValue(value, indent) {
    const pad = ' '.repeat(indent);

    if (typeof value === 'boolean') {
        return `${pad}<${value ? 'true' : 'false'}/>`;
    }

    if (typeof value === 'number' && Number.isInteger(value)) {
        return `${pad}<integer>${value}</integer>`;
    }

    if (typeof value === 'string') {
        return `${pad}<string>${escapeXml(value)}</string>`;
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            return `${pad}<array/>`;
        }

        return [
            `${pad}<array>`,
            ...value.map(item => renderPlistValue(item, indent + 4)),
            `${pad}</array>`
        ].join('\n');
    }

    if (value && typeof value === 'object') {
        const entries = Object.entries(value);

        return [
            `${pad}<dict>`,
            ...entries.flatMap(([key, child]) => [
                `${' '.repeat(indent + 4)}<key>${escapeXml(key)}</key>`,
                renderPlistValue(child, indent + 4)
            ]),
            `${pad}</dict>`
        ].join('\n');
    }

    throw new Error(`wakeReceiverSetup: unsupported plist value of type ${typeof value}.`);
}

/**
 * @summary Materializes the canonical LaunchAgent template (`deploy/host/com.neomjs.agent-os-wake.plist`)
 * into a clean, comment-free XML plist pinned to exact runtime, manifest, stateDir, and endpoint coordinates.
 * @param {Object} options
 * @param {String}      options.templateXml Raw contents of `deploy/host/com.neomjs.agent-os-wake.plist`.
 * @param {String}      options.executable Absolute path to the Node executable.
 * @param {String}      options.runtimeRoot Absolute Agent OS runtime root directory (`WorkingDirectory`).
 * @param {String}      options.manifestPath Absolute wake receiver manifest path.
 * @param {String}      options.stateDir Absolute wake receiver state directory.
 * @param {String}      [options.host='127.0.0.1']
 * @param {Number}      [options.port=3199]
 * @param {Object|null} [options.runtimeGeneration=null] Optional verified runtime generation descriptor.
 * @param {Object}      [options.extraEnv={}] Optional additional environment variables layered after template defaults.
 * @returns {String}
 */
export function serializeWakeReceiverPlist({
    templateXml,
    executable,
    runtimeRoot,
    manifestPath,
    stateDir,
    host              = WAKE_RECEIVER_DEFAULT_HOST,
    port              = WAKE_RECEIVER_DEFAULT_PORT,
    runtimeGeneration = null,
    extraEnv          = {}
} = {}) {
    const template = parseLaunchAgentPlist(templateXml, {allowComments: true});

    if (template.Label !== WAKE_RECEIVER_LABEL) {
        throw new Error(`wakeReceiverSetup: LaunchAgent template must declare Label '${WAKE_RECEIVER_LABEL}', got '${template.Label ?? '<missing>'}'.`);
    }

    assertSafeAbsolutePath(executable, 'executable');
    assertSafeAbsolutePath(runtimeRoot, 'runtimeRoot');
    assertSafeAbsolutePath(manifestPath, 'manifestPath');
    assertSafeAbsolutePath(stateDir, 'stateDir');

    if (typeof host !== 'string' || host.trim().length === 0) {
        throw new Error('wakeReceiverSetup: wake receiver host must be a non-empty string.');
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`wakeReceiverSetup: wake receiver port must be an integer in 1..65535, got '${port}'.`);
    }

    const
        pinnedGen   = runtimeGeneration ? runtimeGenerationPin(runtimeGeneration) : null,
        programArgs = [
            executable,
            WAKE_RECEIVER_ENTRYPOINT,
            '--manifest',
            manifestPath,
            '--state-dir',
            stateDir,
            '--host',
            host.trim(),
            '--port',
            String(port),
            ...(pinnedGen ? runtimeGenerationArguments(pinnedGen) : [])
        ],
        envDict     = {
            ...(template.EnvironmentVariables && typeof template.EnvironmentVariables === 'object' ? template.EnvironmentVariables : {}),
            ...(extraEnv && typeof extraEnv === 'object' ? extraEnv : {})
        },
        materialized = {
            Label               : WAKE_RECEIVER_LABEL,
            ProgramArguments    : programArgs,
            WorkingDirectory    : runtimeRoot,
            EnvironmentVariables: envDict,
            RunAtLoad           : Boolean(template.RunAtLoad ?? true),
            KeepAlive           : Boolean(template.KeepAlive ?? true),
            ThrottleInterval    : Number.isInteger(template.ThrottleInterval) ? template.ThrottleInterval : 10,
            StandardOutPath     : path.join(stateDir, 'launchd.out.log'),
            StandardErrorPath   : path.join(stateDir, 'launchd.err.log'),
            ProcessType         : typeof template.ProcessType === 'string' ? template.ProcessType : 'Background'
        };

    const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        renderPlistValue(materialized, 0),
        '</plist>',
        ''
    ].join('\n');

    if (/__[A-Z0-9_]+__/.test(xml)) {
        throw new Error('wakeReceiverSetup: unsubstituted placeholder survived in serialized LaunchAgent plist.');
    }

    // Self-check against the comment-strict parser shared with the Fleet LaunchAgent reader.
    parseLaunchAgentPlist(xml, {allowComments: false});

    return xml;
}

/**
 * @summary Extracts declared runtime, manifest, stateDir, and endpoint fields from a parsed LaunchAgent dict.
 * @param {Object} plist Parsed plist dictionary from {@link parseLaunchAgentPlist}.
 * @returns {Object}
 */
export function extractReceiverDeclaration(plist) {
    const
        args       = Array.isArray(plist?.ProgramArguments) && plist.ProgramArguments.every(item => typeof item === 'string') ? plist.ProgramArguments : [],
        occurrences = flag => args.filter(item => item === flag).length,
        hasEquals   = flag => args.some(item => item.startsWith(`${flag}=`)),
        after       = flag => (occurrences(flag) === 1 && !hasEquals(flag)) ? args[args.indexOf(flag) + 1] : undefined,
        genFlag     = args.find(item => item.startsWith('--neo-runtime-generation=')),
        portRaw     = after('--port'),
        port        = /^\d+$/.test(portRaw ?? '') ? Number(portRaw) : null;

    return {
        label                  : typeof plist?.Label === 'string' ? plist.Label : null,
        executable             : args[0] ?? null,
        entrypoint             : args[1] ?? null,
        runtimeRoot            : typeof plist?.WorkingDirectory === 'string' ? plist.WorkingDirectory : null,
        manifestPath           : after('--manifest') ?? null,
        stateDir               : after('--state-dir') ?? null,
        host                   : after('--host') ?? WAKE_RECEIVER_DEFAULT_HOST,
        port,
        runtimeGenerationDir   : genFlag ? genFlag.slice('--neo-runtime-generation='.length) : null,
        ambiguousFlags         : ['--manifest', '--state-dir', '--port', '--host'].some(flag => occurrences(flag) > 1 || hasEquals(flag))
    };
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
 * @param {Object} options
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

function parseLaunchctlPrint(stdout) {
    const
        runningState = /state\s*=\s*running/i.test(stdout),
        pidMatch     = stdout.match(/\bpid\s*=\s*(\d+)/i),
        pid          = pidMatch ? Number(pidMatch[1]) : null,
        programMatch = stdout.match(/\bprogram\s*=\s*(.+)/i),
        pathMatch    = stdout.match(/\bpath\s*=\s*(.+)/i);

    return {
        loaded  : true,
        running : runningState || (Number.isInteger(pid) && pid > 0),
        pid,
        program : programMatch ? programMatch[1].trim() : null,
        plist   : pathMatch ? pathMatch[1].trim() : null
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
            return {domain, serviceTarget, loaded: false, running: false, pid: null, program: null, plist: null};
        }

        return {domain, serviceTarget, loaded: false, running: false, pid: null, program: null, plist: null, queryError: error.message};
    }
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
        sameExecutable  = !paths.executable || declaration.executable === paths.executable;

    return declaration.manifestPath === paths.manifestPath &&
        declaration.stateDir === paths.wakeStateDir &&
        declaration.host === paths.host &&
        declaration.port === paths.port &&
        declaration.entrypoint === WAKE_RECEIVER_ENTRYPOINT &&
        sameRuntimeRoot &&
        sameExecutable &&
        actualGenDir === expectedGenDir;
}

/**
 * @summary Comprehensive inspection of LaunchAgent plist, custody sidecar, manifest routes, `launchd` state,
 * and live `/wake` HTTP listener to drive both read-only observers and guarded writes.
 */
async function inspectWakeSetupState({paths, target, host}) {
    const
        fsModule = host.fsModule,
        hostUid  = resolveHostUid(host),
        probeFn  = host.probeWakeListener ?? probeWakeReceiverHttp;

    for (const candidate of [paths.wakeStateDir, paths.plistPath ? path.dirname(paths.plistPath) : null]) {
        if (!candidate) {
            continue;
        }

        try {
            const stat = await safeLstat(fsModule, candidate);

            if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) {
                return {kind: 'conflict', conflict: `refusing symbolic link at ${candidate}`};
            }

            if (!sameOptionalUid(stat, hostUid)) {
                return {kind: 'conflict', conflict: `refusing foreign ownership on '${candidate}' (uid ${stat.uid}, expected ${hostUid})`};
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                return {kind: 'conflict', conflict: `${candidate} cannot be inspected (${error.message})`};
            }
        }
    }

    const
        custodyRead  = await readOwnedJson(paths.custodyPath, fsModule, hostUid, 'wake setup custody'),
        manifestRead = await readOwnedJson(paths.manifestPath, fsModule, hostUid, 'wake manifest'),
        plistRead    = await readOwnedPlist(paths.plistPath, fsModule, hostUid);

    if (custodyRead.conflict) {
        return {kind: 'conflict', conflict: custodyRead.conflict};
    }

    if (manifestRead.conflict) {
        return {kind: 'conflict', conflict: manifestRead.conflict};
    }

    if (plistRead.conflict) {
        return {kind: 'conflict', conflict: plistRead.conflict};
    }

    const supervisor = await inspectSupervisor(host, hostUid);

    if (supervisor.queryError) {
        return {kind: 'conflict', conflict: `failed querying launchd for ${WAKE_RECEIVER_LABEL}: ${supervisor.queryError}`};
    }

    const
        activeHost      = plistRead.declaration?.host ?? paths.host,
        activePort      = plistRead.declaration?.port ?? paths.port,
        activeListener  = await probeFn({host: activeHost, port: activePort}),
        desiredListener = (activeHost === paths.host && activePort === paths.port)
            ? activeListener
            : await probeFn({host: paths.host, port: paths.port});

    if (custodyRead.exists) {
        const custodyError = custodyMatchesDeployment(custodyRead.value, {hostUid, target, paths});

        if (custodyError) {
            return {kind: 'conflict', conflict: custodyError, supervisor, plistRead, manifestRead, custodyRead};
        }

        if (plistRead.exists) {
            const d = plistRead.declaration;

            if (d.ambiguousFlags || d.label !== WAKE_RECEIVER_LABEL || d.manifestPath !== paths.manifestPath || d.stateDir !== paths.wakeStateDir) {
                return {
                    kind: 'conflict',
                    conflict: `LaunchAgent at ${paths.plistPath} declares a foreign target (--state-dir='${d.stateDir}', --manifest='${d.manifestPath}')`,
                    supervisor, plistRead, manifestRead, custodyRead
                };
            }

            if (supervisor.loaded && supervisor.plist && supervisor.plist !== paths.plistPath) {
                return {
                    kind: 'conflict',
                    conflict: `loaded launchd service '${WAKE_RECEIVER_LABEL}' comes from '${supervisor.plist}', expected '${paths.plistPath}'`,
                    supervisor, plistRead, manifestRead, custodyRead
                };
            }

            if (!declarationMatchesTarget(d, paths)) {
                if ((d.host !== paths.host || d.port !== paths.port) && desiredListener.listening) {
                    return {
                        kind: 'conflict',
                        conflict: desiredListener.reason ?? `target endpoint ${paths.host}:${paths.port} is already occupied`,
                        supervisor, plistRead, manifestRead, custodyRead
                    };
                }

                return {
                    kind       : 'owned-upgrade',
                    endpointMoved: d.host !== paths.host || d.port !== paths.port,
                    supervisor, plistRead, manifestRead, custodyRead, activeListener, desiredListener
                };
            }

            if (!supervisor.loaded || !supervisor.running || !activeListener.wakeReceiver) {
                if (activeListener.listening && !activeListener.wakeReceiver) {
                    return {
                        kind: 'conflict',
                        conflict: activeListener.reason ?? `foreign listener occupies ${activeHost}:${activePort}`,
                        supervisor, plistRead, manifestRead, custodyRead
                    };
                }

                return {kind: 'owned-stopped', supervisor, plistRead, manifestRead, custodyRead, activeListener};
            }

            return {kind: 'owned-running', supervisor, plistRead, manifestRead, custodyRead, activeListener};
        }

        if (supervisor.loaded) {
            return {
                kind: 'conflict',
                conflict: `loaded launchd service '${WAKE_RECEIVER_LABEL}' exists without owned plist '${paths.plistPath}'`,
                supervisor, plistRead, manifestRead, custodyRead
            };
        }

        if (desiredListener.listening) {
            return {
                kind: 'conflict',
                conflict: desiredListener.reason ?? `port ${paths.host}:${paths.port} is already occupied before wake receiver bootstrap`,
                supervisor, plistRead, manifestRead, custodyRead
            };
        }

        return {kind: 'owned-absent', supervisor, plistRead, manifestRead, custodyRead, activeListener};
    }

    // No custody sidecar: either clean absent host, corroborated legacy install, or an unproven/foreign service.
    if (!plistRead.exists && !supervisor.loaded) {
        if (desiredListener.listening) {
            return {
                kind: 'conflict',
                conflict: desiredListener.reason ?? `foreign listener already occupies ${paths.host}:${paths.port}`,
                supervisor, plistRead, manifestRead, custodyRead
            };
        }

        return {kind: 'absent', supervisor, plistRead, manifestRead, custodyRead, activeListener};
    }

    if (!plistRead.exists && supervisor.loaded) {
        return {
            kind: 'conflict',
            conflict: `foreign launchd service '${WAKE_RECEIVER_LABEL}' is loaded without an owned LaunchAgent plist at ${paths.plistPath}`,
            supervisor, plistRead, manifestRead, custodyRead
        };
    }

    const
        d           = plistRead.declaration,
        routeCount  = manifestRead.value?.routes && typeof manifestRead.value.routes === 'object' ? Object.keys(manifestRead.value.routes).length : 0,
        pathsMatch  = !d.ambiguousFlags && d.label === WAKE_RECEIVER_LABEL && d.manifestPath === paths.manifestPath && d.stateDir === paths.wakeStateDir && (!paths.runtimeRoot || d.runtimeRoot === paths.runtimeRoot),
        plistMatch  = !supervisor.plist || supervisor.plist === paths.plistPath,
        corroborated = Boolean(pathsMatch && plistMatch && supervisor.loaded && supervisor.running && activeListener.wakeReceiver && manifestRead.exists && manifestRead.valid && routeCount > 0);

    if (!corroborated) {
        const reason = !pathsMatch || !plistMatch
            ? `foreign LaunchAgent '${WAKE_RECEIVER_LABEL}' exists at ${paths.plistPath} with non-matching target declaration`
            : !supervisor.loaded || !supervisor.running || !activeListener.wakeReceiver
                ? `uncorroborated legacy LaunchAgent '${WAKE_RECEIVER_LABEL}' at ${paths.plistPath} is stopped or lacks custody proof`
                : `uncorroborated legacy LaunchAgent at ${paths.plistPath} has no signed seat routes in ${paths.manifestPath}; refusing automatic takeover`;

        return {kind: 'conflict', conflict: reason, supervisor, plistRead, manifestRead, custodyRead};
    }

    if (!declarationMatchesTarget(d, paths)) {
        return {
            kind: 'conflict',
            conflict: `corroborated legacy LaunchAgent at ${paths.plistPath} targets ${d.host}:${d.port} / ${d.runtimeRoot}, which differs from requested setup without an owned custody record`,
            supervisor, plistRead, manifestRead, custodyRead
        };
    }

    return {kind: 'corroborated-legacy', supervisor, plistRead, manifestRead, custodyRead, activeListener};
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

    const inspection = await inspectWakeSetupState({paths, target, host});

    const actionByKind = {
        absent               : 'install and start',
        'owned-absent'       : 'install and start',
        'owned-stopped'      : 'start',
        'owned-upgrade'      : inspection.endpointMoved ? 'rebind and restart' : 'upgrade and restart',
        'owned-running'      : 'adopt running service',
        'corroborated-legacy': 'adopt corroborated legacy service',
        conflict             : 'resolve custody conflict before install'
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
 * supervisor, live `/wake` listener, and matching runtime/endpoint declaration. A dead plist never turns `ok`.
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
        inspection = await inspectWakeSetupState({paths, target, host});

    if (inspection.kind === 'conflict') {
        return {
            present: true,
            running: Boolean(inspection.supervisor?.running),
            digest : null,
            problem: inspection.conflict
        };
    }

    if (inspection.kind === 'absent' || inspection.kind === 'owned-absent') {
        return {
            present: false,
            running: false,
            digest : null,
            reason : `LaunchAgent '${WAKE_RECEIVER_LABEL}' is not installed`
        };
    }

    if (inspection.kind === 'owned-stopped') {
        return {
            present: false,
            running: false,
            digest : inspection.plistRead?.digest ?? null,
            reason : `LaunchAgent '${WAKE_RECEIVER_LABEL}' exists on disk but is not loaded or listening on ${paths.host}:${paths.port}`
        };
    }

    if (inspection.kind === 'owned-upgrade') {
        return {
            present       : true,
            running       : Boolean(inspection.supervisor?.running && inspection.activeListener?.wakeReceiver),
            upgradePending: true,
            digest        : inspection.plistRead?.digest ?? null,
            problem       : null,
            reason        : `LaunchAgent '${WAKE_RECEIVER_LABEL}' declaration differs from current runtime or endpoint; update required`
        };
    }

    return {
        present              : true,
        running              : true,
        wakeDeliveryAvailable: true,
        adopted              : inspection.kind === 'corroborated-legacy' || inspection.kind === 'owned-running',
        digest               : inspection.plistRead?.digest ?? null,
        problem              : null
    };
}

async function waitForListenerAndSupervisor({paths, host, hostUid}) {
    const
        probeFn     = host.probeWakeListener ?? probeWakeReceiverHttp,
        maxAttempts = typeof host.probeWakeListener === 'function' ? 2 : LAUNCHD_READY_ATTEMPTS;

    let lastSupervisor = null, lastListener = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        lastSupervisor = await inspectSupervisor(host, hostUid);
        lastListener   = await probeFn({host: paths.host, port: paths.port});

        if (lastSupervisor.loaded && lastSupervisor.running && lastListener.wakeReceiver) {
            return {supervisor: lastSupervisor, listener: lastListener};
        }

        if (attempt + 1 < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, LAUNCHD_READY_DELAY_MS));
        }
    }

    const detail = !lastSupervisor?.loaded
        ? `launchd service '${WAKE_RECEIVER_LABEL}' is not loaded`
        : !lastSupervisor.running
            ? `launchd service '${WAKE_RECEIVER_LABEL}' is not running`
            : lastListener?.reason ?? `wake listener did not answer on ${paths.host}:${paths.port}`;

    throw new Error(`wakeReceiverSetup: ${detail} after launchctl bootstrap.`);
}

async function writeCustodyRecord({custodyPath, hostUid, target, paths, plistDigest, adoptedFrom, host}) {
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
        plistDigest,
        adoptedFrom,
        updatedAt        : new Date(host.now()).toISOString()
    };

    await host.fsModule.mkdir(path.dirname(custodyPath), {recursive: true, mode: PRIVATE_DIR_MODE});
    await writeFileAtomic(custodyPath, `${JSON.stringify(custody, null, 2)}\n`, {mode: PRIVATE_FILE_MODE, fsModule: host.fsModule});
}

/**
 * @summary Handler for `start-wake-receiver`: enforces ownership/custody before any mutation, prepares owner-private
 * records + cold zero-route manifest if genuinely fresh, adopts matching running services with zero extra listeners,
 * and installs/upgrades/rebinds `com.neomjs.agent-os-wake` cleanly via `launchctl`.
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
        stateRoot       : input.stateDir ? path.dirname(input.stateDir) : null,
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

    const inspection = await inspectWakeSetupState({paths, target: input.target, host});

    if (inspection.kind === 'conflict') {
        throw new Error(`wakeReceiverSetup: refusing takeover — ${inspection.conflict}.`);
    }

    await prepareWakeRecordsDir(paths.wakeStateDir, host);
    await ensureColdWakeManifest(paths.manifestPath, host);

    if (inspection.kind === 'owned-running') {
        return {
            digest    : inspection.plistRead.digest,
            references: [paths.plistPath, paths.manifestPath],
            action    : 'adopted'
        };
    }

    if (inspection.kind === 'corroborated-legacy') {
        await writeCustodyRecord({
            custodyPath: paths.custodyPath,
            hostUid,
            target     : input.target,
            paths,
            plistDigest: inspection.plistRead.digest,
            adoptedFrom: 'corroborated-legacy',
            host
        });

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
        digest   = contentDigest(xml),
        domain   = launchctlDomain(hostUid),
        service  = `${domain}/${WAKE_RECEIVER_LABEL}`;

    if (inspection.kind === 'owned-upgrade') {
        const recheck = await inspectWakeSetupState({paths, target: input.target, host});

        if (recheck.kind === 'conflict') {
            throw new Error(`wakeReceiverSetup: custody recheck before replacement failed — ${recheck.conflict}.`);
        }
    }

    if (inspection.supervisor?.loaded || inspection.kind === 'owned-upgrade' || inspection.kind === 'owned-stopped') {
        await host.run('launchctl', ['bootout', service], {}).catch(() => null);
    }

    await host.fsModule.mkdir(path.dirname(paths.plistPath), {recursive: true, mode: 0o755});
    await writeFileAtomic(paths.plistPath, xml, {mode: PRIVATE_FILE_MODE, fsModule: host.fsModule});

    await host.run('launchctl', ['bootstrap', domain, paths.plistPath], {});
    await waitForListenerAndSupervisor({paths, host, hostUid});

    const adoptedFrom = inspection.kind === 'owned-upgrade'
        ? (inspection.endpointMoved ? 'endpoint-move' : 'upgrade')
        : inspection.kind === 'owned-stopped'
            ? 'restarted'
            : 'fresh-install';

    await writeCustodyRecord({
        custodyPath: paths.custodyPath,
        hostUid,
        target     : input.target,
        paths,
        plistDigest: digest,
        adoptedFrom,
        host
    });

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

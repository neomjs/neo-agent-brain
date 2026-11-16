/**
 * @module ai/services/fleet/wakeReceiverPlist
 * @summary Strict XML parser, placeholder-free serializer, and declaration extractor for the per-user
 * macOS LaunchAgent plist (`com.neomjs.agent-os-wake`).
 *
 * Uses single-pass lexical comment tokenization rather than regex pre-stripping so malformed or
 * element-splitting XML comments cannot splice adjacent tags in either template or strict mode.
 */

import path                                               from 'node:path';
import {runtimeGenerationArguments, runtimeGenerationPin} from './runtimeGeneration.mjs';

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
export function assertSafeAbsolutePath(value, label) {
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

    let   index = 0;
    const peek  = () => tokens[index];
    const next  = () => tokens[index++];

    const readTextValue = tagName => {
        const maybeText = peek();
        let   raw       = '';

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

    const root      = parseValue();
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
 * @summary Extracts declared runtime, manifest, stateDir, endpoint, and environment fields from a parsed LaunchAgent dict.
 * @param {Object} plist Parsed plist dictionary from {@link parseLaunchAgentPlist}.
 * @returns {Object}
 */
export function extractReceiverDeclaration(plist) {
    const
        args            = Array.isArray(plist?.ProgramArguments) && plist.ProgramArguments.every(item => typeof item === 'string') ? plist.ProgramArguments : [],
        occurrences     = flag => args.filter(item => item === flag).length,
        hasEquals       = flag => args.some(item => item.startsWith(`${flag}=`)),
        after           = flag => (occurrences(flag) === 1 && !hasEquals(flag)) ? args[args.indexOf(flag) + 1] : undefined,
        genFlags        = args.filter(item => item.startsWith('--neo-runtime-generation=')),
        genFlag         = genFlags.length === 1 ? genFlags[0] : undefined,
        portRaw         = after('--port'),
        port            = /^\d+$/.test(portRaw ?? '') ? Number(portRaw) : null,
        pairedFlags     = ['--manifest', '--state-dir', '--host', '--port'],
        pairedCount     = pairedFlags.reduce((sum, flag) => sum + (occurrences(flag) === 1 ? 2 : 0), 0),
        expectedLen     = (args[0] ? 1 : 0) + (args[1] ? 1 : 0) + pairedCount + genFlags.length,
        rawEnv          = plist?.EnvironmentVariables,
        hasNonStringEnv = rawEnv !== undefined && (typeof rawEnv !== 'object' || rawEnv === null || Array.isArray(rawEnv) || Object.values(rawEnv).some(value => typeof value !== 'string')),
        environment     = {};

    if (rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)) {
        for (const key of Object.keys(rawEnv).sort()) {
            if (typeof rawEnv[key] === 'string') {
                environment[key] = rawEnv[key];
            }
        }
    }

    return {
        label               : typeof plist?.Label === 'string' ? plist.Label : null,
        executable          : args[0] ?? null,
        entrypoint          : args[1] ?? null,
        runtimeRoot         : typeof plist?.WorkingDirectory === 'string' ? plist.WorkingDirectory : null,
        manifestPath        : after('--manifest') ?? null,
        stateDir            : after('--state-dir') ?? null,
        host                : after('--host') ?? WAKE_RECEIVER_DEFAULT_HOST,
        port,
        runtimeGenerationDir: genFlag ? genFlag.slice('--neo-runtime-generation='.length) : null,
        environment,
        ambiguousFlags      : pairedFlags.some(flag => occurrences(flag) > 1 || hasEquals(flag)) || genFlags.length > 1 || args.length !== expectedLen || hasNonStringEnv
    };
}

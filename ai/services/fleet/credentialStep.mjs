/**
 * @module ai/services/fleet/credentialStep
 * @summary The first run's credential step as pure data: from a consented preset and the operator's
 * credential files it composes the host effects — the secret files to write (owner-only) and the
 * `_FILE` env values the plane's profile consumes — and refuses BEFORE anything is written when the
 * preset's env set names a key the profile does not read or a leaf `configBase` does not declare.
 *
 * Custody is by reference: the plane credential (the operator's PAT) becomes the admission token file
 * the profile mounts as `mcp-auth-token` (bootstrap PAT and healthcheck token, one class), the Fleet's
 * own plane bearer is a distinct mint the step generates (the credential-class ledger forbids one
 * secret serving both classes), and a hosted preset's provider key becomes the `gemini-api-key` secret
 * read through the `GEMINI_API_KEY_FILE` leaf (chat and embeddings) and the
 * `NEO_OPENAI_COMPATIBLE_API_KEY_FILE` leaf (graph generation, through Gemini's OpenAI-compatible
 * endpoint). No value crosses the env set, the record or a log — the env set carries paths, and the
 * host-effect receipts carry digests and paths.
 */

import {randomBytes} from 'node:crypto';
import path          from 'node:path';
import {declaredEnvBindings, profileInputs, unconsumedPresetEnvKeys, unknownPresetEnvKeys} from './placementPresets.mjs';

/**
 * The secret files the step writes under the host state root's secrets directory, by role.
 * @type {Object}
 */
export const SECRET_FILES = Object.freeze({
    admissionToken: 'mcp-auth-token',
    fleetPlaneToken: 'fleet-plane-token',
    geminiApiKey   : 'gemini-api-key'
});

/**
 * Where the profile mounts the secrets inside the containers (its `secrets:` entries).
 * @type {Object}
 */
export const SECRET_MOUNTS = Object.freeze({
    geminiApiKey: '/run/secrets/gemini-api-key'
});

const text = value => typeof value === 'string' ? value.trim() : '';

/**
 * @summary A fresh Fleet plane bearer: 32 random bytes, hex. A distinct mint, never derived from the PAT.
 * @param {Function} [random=randomBytes]
 * @returns {String}
 */
export function mintFleetPlaneToken(random = randomBytes) {
    return random(32).toString('hex');
}

/**
 * @summary Refuses a preset whose env set the profile would not honour — before any file is written.
 * @param {Object} options
 * @param {Object}   options.preset
 * @param {String}   options.configSource  The text of `ai/configBase.mjs`.
 * @param {String[]} options.composeTexts  The profile's Compose files, in order.
 * @returns {String[]} The refusal reasons; empty when the preset is honoured.
 */
export function presetEnvRefusals({preset, configSource, composeTexts}) {
    const
        declared = declaredEnvBindings(configSource),
        profile  = profileInputs(composeTexts),
        leafOnly = {...preset, env: Object.fromEntries(Object.entries(preset?.env ?? {}).filter(([key]) => !profile.mappings.has(key) && !profile.bareInputs.has(key)))};

    return [
        ...unconsumedPresetEnvKeys(preset, profile, declared),
        ...unknownPresetEnvKeys(leafOnly, declared).map(key => `${key}: not a binding configBase declares`)
    ];
}

/**
 * @summary Composes the credential effects for a consented preset. Pure: nothing is read or written.
 * @param {Object} options
 * @param {Object} options.preset            The consented preset (`requires` decides whether a provider key is needed).
 * @param {String} options.pat               The plane credential's value (read by the caller from the operator's file).
 * @param {String} [options.providerKey]     The provider key's value (hosted presets).
 * @param {String} options.secretsDir        The host state root's secrets directory (absolute).
 * @param {String} [options.fleetPlaneToken] A minted bearer; minted here when absent.
 * @param {Function} [options.random]        Injected for the mint.
 * @returns {{secretFiles: Object[], envEntries: Object, refusals: String[]}} `secretFiles` `[{path, content, role}]`; `envEntries` the `_FILE` values; `refusals` non-empty when an input is missing.
 */
export function composeCredentialEffects({preset, pat, providerKey = '', secretsDir, fleetPlaneToken = null, random = randomBytes}) {
    const refusals = [];

    if (typeof secretsDir !== 'string' || !path.isAbsolute(secretsDir)) {
        refusals.push('secretsDir must be an absolute path');
    }

    if (!text(pat)) {
        refusals.push('the plane credential (PAT) is empty');
    }

    const needsProviderKey = Array.isArray(preset?.requires) && preset.requires.includes('providerKey');

    if (needsProviderKey && !text(providerKey)) {
        refusals.push(`the '${preset.id}' preset requires a provider key and none was given`);
    }

    if (!needsProviderKey && text(providerKey)) {
        refusals.push(`the '${preset?.id}' preset takes no provider key; refusing to write one`);
    }

    if (refusals.length > 0) {
        return {secretFiles: [], envEntries: {}, refusals};
    }

    const
        admissionPath   = path.join(secretsDir, SECRET_FILES.admissionToken),
        fleetTokenPath  = path.join(secretsDir, SECRET_FILES.fleetPlaneToken),
        secretFiles     = [
            {path: admissionPath, content: text(pat), role: 'admissionToken'},
            {path: fleetTokenPath, content: text(fleetPlaneToken) || mintFleetPlaneToken(random), role: 'fleetPlaneToken'}
        ],
        envEntries      = {
            NEO_MCP_AUTH_TOKEN_FILE   : admissionPath,
            NEO_FLEET_PLANE_TOKEN_FILE: fleetTokenPath
        };

    if (needsProviderKey) {
        const keyPath = path.join(secretsDir, SECRET_FILES.geminiApiKey);

        secretFiles.push({path: keyPath, content: text(providerKey), role: 'geminiApiKey'});
        envEntries.NEO_GEMINI_API_KEY_FILE            = keyPath;
        envEntries.GEMINI_API_KEY_FILE                = SECRET_MOUNTS.geminiApiKey;
        // the graph lane reads the same mount: Gemini's OpenAI-compatible endpoint takes the same key
        envEntries.NEO_OPENAI_COMPATIBLE_API_KEY_FILE = SECRET_MOUNTS.geminiApiKey;
    }

    return {secretFiles, envEntries, refusals: []};
}

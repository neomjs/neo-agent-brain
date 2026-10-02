import {expect, test}  from '@playwright/test';
import fs              from 'node:fs';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    SECRET_FILES,
    SECRET_MOUNTS,
    composeCredentialEffects,
    mintFleetPlaneToken,
    presetEnvRefusals
} from '../../../../../../ai/services/fleet/credentialStep.mjs';
import {PLANE_PROFILE, presets} from '../../../../../../ai/services/fleet/placementPresets.mjs';

// Pure: nothing is written; the refusal arms read the real config and Compose sources.

const
    REPO_ROOT    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..'),
    CONFIG       = fs.readFileSync(path.join(REPO_ROOT, 'ai/configBase.mjs'), 'utf8'),
    COMPOSE      = PLANE_PROFILE.composeFiles.map(file => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')),
    PAT          = 'ghp_SENTINELPAT0123456789abcdefghijklmnop',
    KEY          = 'AIzaSENTINELPROVIDERKEY0123456789abcdefgh',
    byId         = id => presets.find(preset => preset.id === id),
    fixedRandom  = () => Buffer.alloc(32, 7);

test.describe('credentialStep', () => {
    test('AC-2 (red-first): the hosted preset yields three owner-only secret files and _FILE env values; no value appears in the env set', () => {
        const result = composeCredentialEffects({preset: byId('hosted'), pat: `${PAT}\n`, providerKey: ` ${KEY} `, secretsDir: '/srv/state/secrets', random: fixedRandom});

        expect(result.refusals).toEqual([]);
        expect(result.secretFiles.map(file => [file.role, file.path])).toEqual([
            ['admissionToken', `/srv/state/secrets/${SECRET_FILES.admissionToken}`],
            ['fleetPlaneToken', `/srv/state/secrets/${SECRET_FILES.fleetPlaneToken}`],
            ['geminiApiKey', `/srv/state/secrets/${SECRET_FILES.geminiApiKey}`]
        ]);
        expect(result.secretFiles[0].content).toBe(PAT);
        expect(result.secretFiles[2].content).toBe(KEY);
        // the Fleet bearer is a distinct mint, never the PAT
        expect(result.secretFiles[1].content).toBe('07'.repeat(32));
        expect(result.secretFiles[1].content).not.toBe(PAT);

        // one written key, three env values: the Gemini client's two and the graph lane's (the same mount)
        expect(result.envEntries).toEqual({
            NEO_MCP_AUTH_TOKEN_FILE           : '/srv/state/secrets/mcp-auth-token',
            NEO_FLEET_PLANE_TOKEN_FILE        : '/srv/state/secrets/fleet-plane-token',
            NEO_GEMINI_API_KEY_FILE           : '/srv/state/secrets/gemini-api-key',
            GEMINI_API_KEY_FILE               : SECRET_MOUNTS.geminiApiKey,
            NEO_OPENAI_COMPATIBLE_API_KEY_FILE: SECRET_MOUNTS.geminiApiKey
        });
        expect(JSON.stringify(result.envEntries)).not.toContain(PAT);
        expect(JSON.stringify(result.envEntries)).not.toContain(KEY);
        expect(mintFleetPlaneToken()).toMatch(/^[0-9a-f]{64}$/);
        expect(mintFleetPlaneToken()).not.toBe(mintFleetPlaneToken());
    });

    test('a local preset takes no provider key: two files, no key env; a key offered anyway is refused before anything is composed', () => {
        const local = composeCredentialEffects({preset: byId('local-small'), pat: PAT, secretsDir: '/srv/state/secrets', random: fixedRandom});

        expect(local.refusals).toEqual([]);
        expect(local.secretFiles.map(file => file.role)).toEqual(['admissionToken', 'fleetPlaneToken']);
        expect(Object.keys(local.envEntries)).toEqual(['NEO_MCP_AUTH_TOKEN_FILE', 'NEO_FLEET_PLANE_TOKEN_FILE']);

        const offered = composeCredentialEffects({preset: byId('local-small'), pat: PAT, providerKey: KEY, secretsDir: '/srv/state/secrets'});

        expect(offered.secretFiles).toEqual([]);
        expect(offered.refusals).toEqual(["the 'local-small' preset takes no provider key; refusing to write one"]);

        const missing = composeCredentialEffects({preset: byId('hosted'), pat: PAT, secretsDir: '/srv/state/secrets'});

        expect(missing.secretFiles).toEqual([]);
        expect(missing.refusals).toEqual(["the 'hosted' preset requires a provider key and none was given"]);

        const empty = composeCredentialEffects({preset: byId('hosted'), pat: '  ', providerKey: KEY, secretsDir: 'relative/secrets'});

        expect(empty.refusals).toEqual(['secretsDir must be an absolute path', 'the plane credential (PAT) is empty']);
        // a supplied bearer is kept, trimmed
        expect(composeCredentialEffects({preset: byId('local-full'), pat: PAT, secretsDir: '/s', fleetPlaneToken: ' abc '}).secretFiles[1].content).toBe('abc');
    });

    test('AC-3: refuse-before-mutation — the three presets pass the profile and leaf checks; an unknown or shadowed key refuses with its reason', () => {
        for (const preset of presets) {
            expect(presetEnvRefusals({preset, configSource: CONFIG, composeTexts: COMPOSE}), preset.id).toEqual([]);
        }

        // the credential step's own env values are profile inputs: a bare secret source and a leaf-landing mount
        const withCredentials = {...byId('hosted'), env: {...byId('hosted').env, NEO_GEMINI_API_KEY_FILE: '/srv/state/secrets/gemini-api-key', GEMINI_API_KEY_FILE: '/run/secrets/gemini-api-key', NEO_OPENAI_COMPATIBLE_API_KEY_FILE: '/run/secrets/gemini-api-key', NEO_MCP_AUTH_TOKEN_FILE: '/x', NEO_FLEET_PLANE_TOKEN_FILE: '/y'}};
        expect(presetEnvRefusals({preset: withCredentials, configSource: CONFIG, composeTexts: COMPOSE})).toEqual([]);

        const typo = {...byId('hosted'), env: {...byId('hosted').env, NEO_GEMINI_MODLE: 'x'}};
        expect(presetEnvRefusals({preset: typo, configSource: CONFIG, composeTexts: COMPOSE})).toEqual([
            "NEO_GEMINI_MODLE: not an input of the profile's Compose files",
            'NEO_GEMINI_MODLE: not a binding configBase declares'
        ]);

        // declared in configBase yet shadowed by the overlay: refused at the profile, not the leaf
        const shadowed = {...byId('local-small'), env: {...byId('local-small').env, NEO_OPENAI_COMPATIBLE_MODEL: 'm'}};
        expect(presetEnvRefusals({preset: shadowed, configSource: CONFIG, composeTexts: COMPOSE})).toEqual(["NEO_OPENAI_COMPATIBLE_MODEL: not an input of the profile's Compose files"]);
    });

    test('the profile mounts the provider key as a secret on every provider consumer and nowhere else; a local plane mounts /dev/null', () => {
        const overlay = COMPOSE[1];

        expect(overlay).toMatch(/gemini-api-key:\n\s+file: \$\{NEO_GEMINI_API_KEY_FILE:-\/dev\/null\}/);
        expect(overlay).toMatch(/GEMINI_API_KEY_FILE: \$\{GEMINI_API_KEY_FILE:-\}/);
        expect(overlay.match(/^\s+- gemini-api-key$/gm)).toHaveLength(3);
        expect(overlay).not.toContain(KEY);
    });
});

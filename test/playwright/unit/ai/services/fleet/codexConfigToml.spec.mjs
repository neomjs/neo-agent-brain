import {test, expect} from '@playwright/test';
import {applyCodexSeatSettings, parseTomlTableHeader, readCodexSeatSettings} from '../../../../../../ai/services/fleet/codexConfigToml.mjs';

// The layout a Fleet-provisioned Codex Desktop home carries: Fleet's policy keys, the app's own top-level
// settings written inside Fleet's trust comments, then tables. Pure functions over text, no filesystem.
const SEAT_CONFIG = [
    '# Fleet-owned Codex home policy. Authentication material itself is created by Codex login, never by Fleet.',
    'cli_auth_credentials_store = "file"',
    'mcp_oauth_credentials_store = "file"',
    '',
    '# Fleet-managed remote MCP project trust begin',
    'notify = ["/fixture/native-notify", "turn-ended"]',
    'model = "gpt-6-astra"',
    "model_reasoning_effort = 'ultra' # picked in the app",
    'service_tier = "flex"',
    '',
    '[projects."/agents/sophie/neomjs/neo"]',
    'trust_level = "trusted"',
    '# Fleet-managed remote MCP project trust end',
    '',
    '[features]',
    'memories = true',
    '',
    '[profiles.fast]',
    'model = "gpt-6-mini"',
    ''
].join('\n');

test.describe('codexConfigToml — a Codex config\'s seat settings, as text', () => {
    test('reads the top level\'s model and effort, quoted either way, a trailing comment allowed — never a table\'s', () => {
        expect(readCodexSeatSettings(SEAT_CONFIG)).toEqual({model: 'gpt-6-astra', reasoningEffort: 'ultra'});
        expect(readCodexSeatSettings('[profiles.fast]\nmodel = "gpt-6-mini"\n'), 'a profile\'s model is not the seat\'s').toEqual({model: null, reasoningEffort: null});
        expect(readCodexSeatSettings('model_reasoning_effort = "max"\n'), 'one key is not mistaken for the other').toEqual({model: null, reasoningEffort: 'max'});
        expect(readCodexSeatSettings('model = 5\n'), 'a value that is no string reads as unset').toEqual({model: null, reasoningEffort: null});
        expect(readCodexSeatSettings('')).toEqual({model: null, reasoningEffort: null});
    });

    test('a declaration replaces the app\'s pick where the app put it, and leaves every other line as it was', () => {
        const next = applyCodexSeatSettings(SEAT_CONFIG, {model: 'gpt-6-sol', reasoningEffort: 'max'});

        expect(readCodexSeatSettings(next)).toEqual({model: 'gpt-6-sol', reasoningEffort: 'max'});
        expect(next.split('\n').filter((line, index) => line !== SEAT_CONFIG.split('\n')[index]), 'two lines changed, in place')
            .toEqual(['model = "gpt-6-sol"', 'model_reasoning_effort = "max"']);
        expect(next).toContain('[profiles.fast]\nmodel = "gpt-6-mini"');
    });

    test('a key nothing sets goes in after Fleet\'s policy keys, outside the trust block', () => {
        const
            fresh = SEAT_CONFIG.replace('model = "gpt-6-astra"\n', '').replace("model_reasoning_effort = 'ultra' # picked in the app\n", ''),
            next  = applyCodexSeatSettings(fresh, {model: 'gpt-6-astra', reasoningEffort: 'ultra'});

        expect(next.split('\n').slice(1, 5)).toEqual([
            'cli_auth_credentials_store = "file"',
            'mcp_oauth_credentials_store = "file"',
            'model = "gpt-6-astra"',
            'model_reasoning_effort = "ultra"'
        ]);
    });

    test('nothing declared, or the same values, changes nothing: the text comes back as it went in', () => {
        expect(applyCodexSeatSettings(SEAT_CONFIG, {})).toBe(SEAT_CONFIG);
        expect(applyCodexSeatSettings(SEAT_CONFIG, {model: null, reasoningEffort: undefined}), 'a withdrawal leaves the file alone').toBe(SEAT_CONFIG);
        expect(applyCodexSeatSettings(SEAT_CONFIG, {model: 'gpt-6-astra', reasoningEffort: 'ultra'}), 'the same values in another quoting').toBe(SEAT_CONFIG);
        expect(applyCodexSeatSettings(SEAT_CONFIG, {reasoningEffort: 'max'}), 'one field declared, the other stays')
            .toContain('model = "gpt-6-astra"');
    });

    test('a written value is always one TOML string, whatever the record holds', () => {
        expect(applyCodexSeatSettings('', {model: 'a"b\\c'})).toBe('model = "a\\"b\\\\c"\n');
        expect(readCodexSeatSettings(applyCodexSeatSettings('', {model: 'a"b\\c'})).model).toBe('a"b\\c');
    });

    test('the table header parser it shares with the workspace converge keeps its contract', () => {
        expect(parseTomlTableHeader('[projects."/a]b # c"] # trailing')).toEqual({array: false, body: 'projects."/a]b # c"'});
        expect(parseTomlTableHeader('[[array.table]]')).toEqual({array: true, body: 'array.table'});
        expect(parseTomlTableHeader('model = "x"')).toBeNull();
    });
});

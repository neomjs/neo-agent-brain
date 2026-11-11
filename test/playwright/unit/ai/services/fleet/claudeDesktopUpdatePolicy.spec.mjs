import {test, expect} from '@playwright/test';
import {spawnSync}    from 'node:child_process';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import {
    CLAUDE_DESKTOP_MANAGED_PLIST,
    claudeDesktopUpdatePolicyProfile,
    readClaudeDesktopUpdatePolicy
} from '../../../../../../ai/services/fleet/claudeDesktopUpdatePolicy.mjs';

/** @summary A property list holding one boolean, written as XML so `plutil` can read it. */
function plistWith(directory, value) {
    const file = path.join(directory, `policy-${value}.plist`);

    fs.writeFileSync(file, '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n' +
        `    <key>disableAutoUpdates</key>\n    <${value}/>\n</dict>\n</plist>\n`);
    return file
}

test.describe('claudeDesktopUpdatePolicy', () => {
    test('the policy is in force only when the machine-level managed plist sets disableAutoUpdates to true', () => {
        const reads = [];

        for (const [value, inForce] of [['true', true], ['false', false], ['1', false], [null, false]]) {
            const policy = readClaudeDesktopUpdatePolicy({extract: (plistPath, key) => (reads.push([plistPath, key]), value)});

            expect(policy, String(value)).toMatchObject({inForce, path: CLAUDE_DESKTOP_MANAGED_PLIST});
            expect(policy.reason === null, String(value)).toBe(inForce)
        }

        expect(CLAUDE_DESKTOP_MANAGED_PLIST).toBe('/Library/Managed Preferences/com.anthropic.claudefordesktop.plist');
        expect(new Set(reads.map(read => read.join(' ')))).toEqual(new Set([`${CLAUDE_DESKTOP_MANAGED_PLIST} disableAutoUpdates`]))
    });

    test('a host without the policy names the file it read and the command that writes the profile', () => {
        const {reason} = readClaudeDesktopUpdatePolicy({plistPath: '/elsewhere/policy.plist', extract: () => null});

        expect(reason).toContain('/elsewhere/policy.plist does not set disableAutoUpdates');
        expect(reason).toContain('node ai/scripts/fleet/claudeDesktopUpdatePolicy.mjs --write <file>');
        // an opened profile waits eight minutes for approval, then macOS discards it
        expect(reason).toContain('System Settings → General → Device Management within eight minutes')
    });

    test('the profile forces disableAutoUpdates in the Claude Desktop domain at System scope, under fixed identifiers', () => {
        const profile = claudeDesktopUpdatePolicyProfile();

        expect(profile).toBe(claudeDesktopUpdatePolicyProfile());
        expect(profile).toMatch(/<key>com\.anthropic\.claudefordesktop<\/key>\s*<dict>\s*<key>Forced<\/key>\s*<array>\s*<dict>\s*<key>mcx_preference_settings<\/key>\s*<dict>\s*<key>disableAutoUpdates<\/key>\s*<true\/>/);

        for (const [key, value] of [
            ['PayloadType',       'com.apple.ManagedClient.preferences'],
            ['PayloadIdentifier', 'com.neomjs.fleet.claude-desktop-updates.preferences'],
            ['PayloadIdentifier', 'com.neomjs.fleet.claude-desktop-updates'],
            ['PayloadScope',      'System'],
            ['PayloadType',       'Configuration']
        ]) {
            expect(profile, `${key} ${value}`).toMatch(new RegExp(`<key>${key}</key>\\s*<string>${value.replaceAll('.', '\\.')}</string>`))
        }
    });

    test.describe('on macOS, through plutil', () => {
        test.skip(process.platform !== 'darwin', 'plutil and managed preferences exist only on macOS');

        let directory;

        test.beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-policy-')) });
        test.afterEach(() => fs.rmSync(directory, {recursive: true, force: true}));

        test('the reader reads a real property list: true is in force, false and a missing file are not', () => {
            expect(readClaudeDesktopUpdatePolicy({plistPath: plistWith(directory, 'true')}).inForce).toBe(true);
            expect(readClaudeDesktopUpdatePolicy({plistPath: plistWith(directory, 'false')}).inForce).toBe(false);
            expect(readClaudeDesktopUpdatePolicy({plistPath: path.join(directory, 'none.plist')}).inForce).toBe(false)
        });

        test('the profile is a valid property list whose payload macOS writes as the policy', () => {
            const file = path.join(directory, 'policy.mobileconfig');

            fs.writeFileSync(file, claudeDesktopUpdatePolicyProfile());

            expect(spawnSync('/usr/bin/plutil', ['-lint', file], {encoding: 'utf8'}).status).toBe(0);

            const profile   = JSON.parse(spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], {encoding: 'utf8'}).stdout),
                  [payload] = profile.PayloadContent;

            expect(profile.PayloadScope).toBe('System');
            expect(payload.PayloadContent['com.anthropic.claudefordesktop'].Forced[0].mcx_preference_settings).toEqual({disableAutoUpdates: true})
        })
    })
});

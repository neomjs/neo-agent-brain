import {test, expect} from '@playwright/test';
import path           from 'node:path';
import {claudeDesktopUpdatePolicyProfile} from '../../../../../../ai/services/fleet/claudeDesktopUpdatePolicy.mjs';
import {parseArgs, runCli, validateArgs}  from '../../../../../../ai/scripts/fleet/claudeDesktopUpdatePolicy.mjs';

const POLICY = {inForce: false, path: '/Library/Managed Preferences/com.anthropic.claudefordesktop.plist', reason: 'not in force'};

test.describe('claudeDesktopUpdatePolicy CLI', () => {
    test('parses --write and refuses anything else', () => {
        expect(parseArgs([])).toEqual({write: null});
        expect(parseArgs(['--write', 'off.mobileconfig'])).toEqual({write: 'off.mobileconfig'});
        expect(parseArgs(['--apply']).parseError).toBeTruthy()
    });

    test('writes only to a .mobileconfig file', () => {
        expect(validateArgs({write: null})).toEqual([]);
        expect(validateArgs({write: 'off.mobileconfig'})).toEqual([]);
        expect(validateArgs({write: 'off.plist'})).toEqual(['macOS installs a profile only from a .mobileconfig file.'])
    });

    test('reports the policy, and writes the profile world-readable when asked', () => {
        const writes = [];
        const write  = (...args) => writes.push(args);

        expect(runCli({args: {write: null}, readPolicy: () => POLICY, write})).toEqual({written: null, ...POLICY});
        expect(writes).toEqual([]);

        expect(runCli({args: {write: 'off.mobileconfig'}, readPolicy: () => POLICY, write}))
            .toEqual({written: path.resolve('off.mobileconfig'), ...POLICY});
        expect(writes).toEqual([[path.resolve('off.mobileconfig'), claudeDesktopUpdatePolicyProfile(), {mode: 0o644}]])
    })
});

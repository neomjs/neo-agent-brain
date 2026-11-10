import {test, expect}  from '@playwright/test';
import nodeFs          from 'node:fs';
import {createRequire} from 'node:module';
import os              from 'node:os';
import path            from 'node:path';
import {probeClaudeDesktopRuntime} from '../../../../../../ai/services/fleet/probeClaudeDesktopRuntime.mjs';

const fs = process.versions.electron ? createRequire(import.meta.url)('original-fs') : nodeFs;

const
    POLICY_PATH  = '/Library/Managed Preferences/com.anthropic.claudefordesktop.plist',
    ASAR_MARKERS = [POLICY_PATH, 'disableAutoUpdates', 'Auto-updates disabled by enterprise policy'];

/** @summary A physical Claude Desktop bundle whose `app.asar` and Electron Framework hold the given bytes. */
function makeBundle(roots, {asar = ASAR_MARKERS.join('\n'), framework = 'user-data-dir'} = {}) {
    const
        parent        = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-probe-')),
        appBundle     = path.join(parent, 'Claude.app'),
        main          = path.join(appBundle, 'Contents', 'MacOS', 'Claude'),
        appAsar       = path.join(appBundle, 'Contents', 'Resources', 'app.asar'),
        frameworkPath = path.join(appBundle, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework');

    for (const file of [main, appAsar, frameworkPath]) fs.mkdirSync(path.dirname(file), {recursive: true});

    fs.writeFileSync(main, '#!/bin/sh\n', {mode: 0o755});
    if (asar !== null) fs.writeFileSync(appAsar, asar);
    fs.writeFileSync(frameworkPath, framework);
    roots.push(parent);

    return {appBundle, main}
}

test.describe('probeClaudeDesktopRuntime', () => {
    const roots = [];

    test.afterEach(() => {
        for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true})
    });

    test('admits a bundle that carries the updater gate, its policy path and the profile switch', () => {
        const {appBundle, main} = makeBundle(roots);

        expect(probeClaudeDesktopRuntime({binaryPath: main})).toEqual({
            available : true,
            reason    : null,
            binaryPath: fs.realpathSync(main),
            appBundle : fs.realpathSync(appBundle)
        })
    });

    test('each missing contract marker refuses by name', () => {
        for (const marker of ASAR_MARKERS) {
            const {main} = makeBundle(roots, {asar: ASAR_MARKERS.filter(other => other !== marker).join('\n')});

            expect(probeClaudeDesktopRuntime({binaryPath: main}), marker)
                .toMatchObject({available: false, reason: `app-contract-marker-missing:${marker}`})
        }

        const {main} = makeBundle(roots, {framework: 'no switch here'});

        expect(probeClaudeDesktopRuntime({binaryPath: main}))
            .toMatchObject({available: false, reason: 'chromium-contract-marker-missing:user-data-dir'})
    });

    test('a marker split across the scanner\'s 1 MiB chunk boundary still counts', () => {
        const {main} = makeBundle(roots, {asar: 'x'.repeat(1024 * 1024 - 20) + ASAR_MARKERS.join('\n')});

        expect(probeClaudeDesktopRuntime({binaryPath: main})).toMatchObject({available: true, reason: null})
    });

    test('refuses a path that is not an app bundle\'s main executable, and a bundle without its resources', () => {
        const {appBundle, main} = makeBundle(roots, {asar: null}), outside = path.join(path.dirname(appBundle), 'Claude');

        fs.writeFileSync(outside, '#!/bin/sh\n', {mode: 0o755});

        for (const [binaryPath, reason] of [
            ['Claude.app/Contents/MacOS/Claude',            'binary-path-must-be-absolute'],
            [path.join(path.dirname(main), 'Missing'),      'packaged-main-unavailable'],
            [outside,                                       'binary-is-not-an-app-bundle-main'],
            [main,                                          'required-app-bundle-resource-unavailable']
        ]) {
            expect(probeClaudeDesktopRuntime({binaryPath}), reason).toMatchObject({available: false, reason})
        }
    })
});

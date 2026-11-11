import path                           from 'node:path';
import {CLAUDE_DESKTOP_MANAGED_PLIST} from './claudeDesktopUpdatePolicy.mjs';
import {
    assertExecutableFile,
    assertReadableFile,
    bundleFs,
    physicalRealpath,
    scanBundleMarkers
} from './inspectAppBundle.mjs';

const
    // The updater contract: where the build reads its policy (the file the Fleet's profile writes), the
    // policy key, and the log line of the startup gate that returns before any update check.
    ASAR_MARKERS = Object.freeze([
        CLAUDE_DESKTOP_MANAGED_PLIST,
        'disableAutoUpdates',
        'Auto-updates disabled by enterprise policy'
    ]),
    // The profile contract: each seat's own data folder comes from Chromium's `--user-data-dir` switch,
    // which deriveHarnessLaunchSpec passes. Signed builds ignore `CLAUDE_USER_DATA_DIR`, so it is not pinned.
    FRAMEWORK_MARKERS = Object.freeze(['user-data-dir']);

/**
 * @summary Probes a Claude Desktop bundle for the contracts the Fleet's seats rely on, statically and
 * without a version allowlist: the updater's gate on the `disableAutoUpdates` policy, read from the
 * managed-preference file the Fleet's profile writes, and Chromium's `--user-data-dir` switch, which gives
 * each seat its own profile. A missing marker refuses by name, so a vendor build that drops a contract is
 * rejected at admission and the selected generation stays.
 * @param {Object} options
 * @param {String} options.binaryPath The bundle's main executable, `<app>/Contents/MacOS/<executable>`.
 * @param {Object} [options.fsImpl] Physical fs reader; defaults to Electron's `original-fs` or Node fs.
 * @returns {{available: Boolean, reason: String|null, binaryPath: String|null, appBundle: String|null}}
 */
export function probeClaudeDesktopRuntime({binaryPath, fsImpl = bundleFs} = {}) {
    if (typeof binaryPath !== 'string' || !path.isAbsolute(binaryPath)) return unavailable('binary-path-must-be-absolute');

    let mainBinary;

    try {
        mainBinary = physicalRealpath(fsImpl, binaryPath);
        assertExecutableFile(fsImpl, mainBinary)
    } catch {
        return unavailable('packaged-main-unavailable')
    }

    const
        macosDir = path.dirname(mainBinary),
        contents = path.dirname(macosDir);

    if (path.basename(macosDir) !== 'MacOS' || path.basename(contents) !== 'Contents') return unavailable('binary-is-not-an-app-bundle-main');

    const
        appBundle = path.dirname(contents),
        found     = {binaryPath: mainBinary, appBundle},
        appAsar   = path.join(contents, 'Resources', 'app.asar'),
        framework = path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Electron Framework');

    try {
        assertReadableFile(fsImpl, appAsar);
        assertReadableFile(fsImpl, framework)
    } catch {
        return unavailable('required-app-bundle-resource-unavailable', found)
    }

    const asarMissing = scanBundleMarkers(appAsar, ASAR_MARKERS, fsImpl).missing;

    if (asarMissing.length) return unavailable(`app-contract-marker-missing:${asarMissing.join(',')}`, found);

    const frameworkMissing = scanBundleMarkers(framework, FRAMEWORK_MARKERS, fsImpl).missing;

    if (frameworkMissing.length) return unavailable(`chromium-contract-marker-missing:${frameworkMissing.join(',')}`, found);

    return {available: true, reason: null, ...found}
}

/** @summary A refusal, with whatever paths the probe had resolved. */
function unavailable(reason, {binaryPath = null, appBundle = null} = {}) {
    return {available: false, reason, binaryPath, appBundle}
}

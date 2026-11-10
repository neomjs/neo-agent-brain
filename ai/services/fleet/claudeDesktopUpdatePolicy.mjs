import {spawnSync} from 'node:child_process';

/**
 * @module ai/services/fleet/claudeDesktopUpdatePolicy
 * @summary Claude Desktop's one updater off-switch, the enterprise policy `disableAutoUpdates`: the
 * configuration profile the Fleet generates for the operator to install once, and the read that says
 * whether the policy is in force. No seat may run its vendor's updater: Claude's rewrites the bundle
 * every seat shares, and its installer relaunches the default-profile app.
 * The app's update gate on this policy runs before any download and before its bundle-ownership dialog.
 */

/** The preference domain Claude Desktop reads its enterprise policy from. */
export const CLAUDE_DESKTOP_POLICY_DOMAIN = 'com.anthropic.claudefordesktop';

/** The machine-level file a System-scope profile for that domain writes, the first one the app reads. */
export const CLAUDE_DESKTOP_MANAGED_PLIST = `/Library/Managed Preferences/${CLAUDE_DESKTOP_POLICY_DOMAIN}.plist`;

/** The profile's identifier; installing a profile with the same identifier replaces it in place. */
export const CLAUDE_DESKTOP_POLICY_PROFILE_ID = 'com.neomjs.fleet.claude-desktop-updates';

const PLUTIL = '/usr/bin/plutil';

/**
 * @summary One key of a property list as `plutil` prints it raw, or `null` when the file, the key or the
 * tool is missing.
 * @param {String} plistPath
 * @param {String} key
 * @returns {String|null}
 */
function extractPlistValue(plistPath, key) {
    const result = spawnSync(PLUTIL, ['-extract', key, 'raw', '-o', '-', plistPath], {encoding: 'utf8', timeout: 10_000});

    return result.status === 0 ? result.stdout.trim() : null
}

/**
 * @summary Whether Claude Desktop's own updater is off by policy on this host: the machine-level managed
 * preference sets `disableAutoUpdates` to `true`. A missing file, a missing key and any other value all
 * mean it is not in force, and `reason` then names the profile that puts it in force.
 * @param {Object} [options]
 * @param {String} [options.plistPath=CLAUDE_DESKTOP_MANAGED_PLIST]
 * @param {Function} [options.extract] `(plistPath, key) => String|null`, the seam over `plutil`.
 * @returns {{inForce: Boolean, path: String, reason: String|null}}
 */
export function readClaudeDesktopUpdatePolicy({plistPath = CLAUDE_DESKTOP_MANAGED_PLIST, extract = extractPlistValue} = {}) {
    const inForce = extract(plistPath, 'disableAutoUpdates') === 'true';

    return {
        inForce,
        path  : plistPath,
        reason: inForce ? null : `${plistPath} does not set disableAutoUpdates, so Claude's own updater still runs; ` +
            'write the profile with `node ai/scripts/fleet/claudeDesktopUpdatePolicy.mjs --write <file>` and install it'
    }
}

/**
 * @summary The configuration profile that turns Claude Desktop's updater off on this Mac: a System-scope
 * `com.apple.ManagedClient.preferences` payload that forces `disableAutoUpdates: true` in
 * {@link CLAUDE_DESKTOP_POLICY_DOMAIN}. The operator installs it once (System Settings → Profiles); macOS then
 * writes {@link CLAUDE_DESKTOP_MANAGED_PLIST}. Its identifiers and UUIDs are fixed, so every copy is the same
 * profile, including the one staged for the operator on 2026-11-10.
 * @returns {String} The `.mobileconfig` property list.
 */
export function claudeDesktopUpdatePolicyProfile() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>PayloadContent</key>
            <dict>
                <key>${CLAUDE_DESKTOP_POLICY_DOMAIN}</key>
                <dict>
                    <key>Forced</key>
                    <array>
                        <dict>
                            <key>mcx_preference_settings</key>
                            <dict>
                                <key>disableAutoUpdates</key>
                                <true/>
                            </dict>
                        </dict>
                    </array>
                </dict>
            </dict>
            <key>PayloadDisplayName</key>
            <string>Claude Desktop: no self-updates</string>
            <key>PayloadEnabled</key>
            <true/>
            <key>PayloadIdentifier</key>
            <string>${CLAUDE_DESKTOP_POLICY_PROFILE_ID}.preferences</string>
            <key>PayloadType</key>
            <string>com.apple.ManagedClient.preferences</string>
            <key>PayloadUUID</key>
            <string>0319D4FD-B008-4F22-B145-2682323E1E15</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
        </dict>
    </array>
    <key>PayloadDescription</key>
    <string>Sets disableAutoUpdates for Claude Desktop, so the app never updates itself under running Fleet seats (neomjs/neo-agent-brain#1531). Remove this profile to let Claude update itself again.</string>
    <key>PayloadDisplayName</key>
    <string>Neo Fleet: Claude Desktop updates off</string>
    <key>PayloadIdentifier</key>
    <string>${CLAUDE_DESKTOP_POLICY_PROFILE_ID}</string>
    <key>PayloadOrganization</key>
    <string>neomjs</string>
    <key>PayloadRemovalDisallowed</key>
    <false/>
    <key>PayloadScope</key>
    <string>System</string>
    <key>PayloadType</key>
    <string>Configuration</string>
    <key>PayloadUUID</key>
    <string>72C8B998-AE13-4647-87AB-62FFE67B1554</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
</dict>
</plist>
`
}

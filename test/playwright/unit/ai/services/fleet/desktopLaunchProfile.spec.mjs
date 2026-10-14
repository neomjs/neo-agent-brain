import {expect, test} from '@playwright/test';
import fs             from 'node:fs/promises';
import os             from 'node:os';
import path           from 'node:path';
import {
    DESKTOP_PROFILE_RECEIPT,
    createDesktopLaunchBinding,
    recoverDesktopLaunchGrants
} from '../../../../../../ai/services/fleet/desktopLaunchProfile.mjs';
import {mintLaunchGrant} from '../../../../../../ai/services/fleet/mcpLaunchAdmission.mjs';

let root, home, profile, receipt, rows, binding, grant;

/** @summary Writes fixture JSON with the same owner-only custody as the production writer. */
async function write(file, value) {
    await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), {mode: 0o600});
}

test.beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-launch-profile-')));
    home = path.join(root, 'seat', 'profile');
    await fs.mkdir(home, {recursive: true});
    profile = path.join(home, 'claude_desktop_config.json');
    receipt = path.join(home, DESKTOP_PROFILE_RECEIPT);
    grant = mintLaunchGrant();
    rows = {'neo-mjs-memory-core': {
        command: '/runtime/host', args: ['/runtime/ai/mcp/client/fleetMcpLauncher.mjs', '--server', 'memory-core'],
        env    : {NEO_AGENT_IDENTITY: 'seat-login', NEO_FLEET_LAUNCH_ISSUER: 'http://127.0.0.1:47123', NEO_FLEET_LAUNCH_GRANT: grant.capability}
    }};
    binding = createDesktopLaunchBinding({rows, identity: 'seat-login', issuer: 'http://127.0.0.1:47123'});
    await write(profile, {mcpServers: {...rows, foreign: {command: '/operator/server'}}, preferences: {theme: 'dark'}});
    await write(receipt, {version: 2, artifact: 'claude_desktop_config.json', sha256: binding.projectionSha256, previous: null});
});
test.afterEach(async () => { await fs.rm(root, {recursive: true, force: true}); });

/** @summary Calls recovery only against this test's isolated managed root. */
function recover(options = {}) {
    return recoverDesktopLaunchGrants({managedRoot: root, instanceHome: home, binding, ...options});
}

test('the original receipt-matching profile returns transient grants while its binding carries hashes only', async () => {
    const before = await fs.readFile(profile, 'utf8');
    expect(await recover()).toEqual({'memory-core': grant.capability});
    expect(JSON.stringify(binding)).not.toContain(grant.secret);
    expect(JSON.stringify(binding)).not.toContain(grant.capability);
    expect(await fs.readFile(profile, 'utf8')).toBe(before);
});

test('foreign preferences and MCP rows can change without changing the owned projection', async () => {
    const data = JSON.parse(await fs.readFile(profile, 'utf8'));
    data.preferences.theme = 'light';
    data.mcpServers.foreign.command = '/operator/new-server';
    await write(profile, data);
    expect(await recover()).toEqual({'memory-core': grant.capability});
});

test('a changed owned row and a rewritten matching receipt cannot replace the original Start binding', async () => {
    rows['neo-mjs-memory-core'].command = '/other/runtime';
    const replacement = createDesktopLaunchBinding({rows, identity: binding.identity, issuer: binding.issuer});
    await write(profile, {mcpServers: rows});
    await write(receipt, {version: 2, artifact: 'claude_desktop_config.json', sha256: replacement.projectionSha256, previous: binding.projectionSha256});
    await expect(recover()).rejects.toMatchObject({reason: 'receipt-mismatch'});
});

test('a previous receipt hash is not authority for the current running profile', async () => {
    await write(receipt, {version: 2, artifact: 'claude_desktop_config.json', sha256: 'a'.repeat(64), previous: binding.projectionSha256});
    await expect(recover()).rejects.toMatchObject({reason: 'receipt-mismatch'});
});

test('malformed or oversized files refuse without echoing parser input', async () => {
    await write(profile, '{"secret":"' + grant.secret + '", broken');
    const error = await recover().catch(error => error);
    expect(error.reason).toBe('invalid-json');
    expect(error.message).not.toContain(grant.secret);
    await fs.truncate(profile, 8 * 1024 * 1024 + 1);
    await expect(recover()).rejects.toMatchObject({reason: 'file-custody'});
});

test('an invalid issuer has a bounded binding refusal', () => {
    for (const issuer of ['http://127.0.0.1:99999', 'https://127.0.0.1:443', 'http://localhost:47123']) {
        expect(() => createDesktopLaunchBinding({rows, identity: 'seat-login', issuer}))
            .toThrow('Desktop launch profile is unverified: invalid-binding.');
    }
});

for (const target of ['profile', 'receipt']) {
    test(`${target} must be a regular owner-only file, not a symlink`, async () => {
        const file = target === 'profile' ? profile : receipt;
        await fs.rename(file, file + '.other');
        await fs.symlink(file + '.other', file);
        await expect(recover()).rejects.toMatchObject({code: 'FLEET_LAUNCH_PROFILE_UNVERIFIED'});
    });
    test(`${target} with widened permissions refuses`, async () => {
        await fs.chmod(target === 'profile' ? profile : receipt, 0o644);
        await expect(recover()).rejects.toMatchObject({reason: 'file-custody'});
    });
}

test('an unexpected owner or a home outside the managed root refuses', async () => {
    await expect(recover({uid: process.getuid() + 1})).rejects.toMatchObject({reason: 'directory-custody'});
    await expect(recover({instanceHome: path.dirname(root)})).rejects.toMatchObject({reason: 'managed-root-mismatch'});
});

test('a linked ancestor refuses even when the final profile and its digest match', async () => {
    const parent = path.dirname(home);
    await fs.rename(parent, parent + '-moved');
    await fs.symlink(parent + '-moved', parent);
    await expect(recover()).rejects.toMatchObject({reason: 'directory-custody'});
});

test('duplicate owned keys and escaped duplicate spellings refuse instead of accepting JSON last-wins behavior', async () => {
    const row = JSON.stringify(rows['neo-mjs-memory-core']);
    for (const key of ['neo-mjs-memory-core', 'neo-mjs-memory-cor\\u0065']) {
        await write(profile, `{"mcpServers":{"neo-mjs-memory-core":${row},"${key}":${row}}}`);
        await expect(recover()).rejects.toMatchObject({reason: 'duplicate-json-key'});
    }
});

test('a profile swapped after its descriptor was opened refuses even if its content matches', async () => {
    let   swapped    = false;
    const fileSystem = {...fs, open: async (...args) => {
        const handle = await fs.open(...args);
        if (args[0] === receipt && !swapped) {
            swapped = true;
            const source = await fs.readFile(profile, 'utf8');
            await fs.rename(profile, profile + '.previous');
            await write(profile, source);
        }
        return handle;
    }};
    await expect(recover({fileSystem})).rejects.toMatchObject({reason: 'file-changed'});
});

test('a directory swapped during the receipt read refuses', async () => {
    const fileSystem = {...fs, open: async (...args) => {
        const handle = await fs.open(...args);
        if (args[0] === receipt) {
            const profileBytes = await fs.readFile(profile, 'utf8'), receiptBytes = await fs.readFile(receipt, 'utf8');
            await fs.rename(home, home + '-previous');
            await fs.mkdir(home);
            await write(profile, profileBytes);
            await write(receipt, receiptBytes);
        }
        return handle;
    }};
    await expect(recover({fileSystem})).rejects.toMatchObject({code: 'FLEET_LAUNCH_PROFILE_UNVERIFIED'});
});

test('a capability hash or original identity mismatch refuses without disclosing its value', async () => {
    for (const changed of [
        {...binding, identity: 'another-seat'},
        {...binding, issuer: 'http://127.0.0.1:47124'},
        {...binding, grants: {'memory-core': {...binding.grants['memory-core'], sha256: 'b'.repeat(64)}}}
    ]) {
        const error = await recover({binding: changed}).catch(error => error);
        expect(error.reason).toBe('grant-mismatch');
        expect(error.message).not.toContain(grant.capability);
        expect(error.message).not.toContain(grant.secret);
    }
});

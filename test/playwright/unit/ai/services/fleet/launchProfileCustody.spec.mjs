import {expect, test} from '@playwright/test';
import fs             from 'node:fs/promises';
import os             from 'node:os';
import path           from 'node:path';
import {createHash}   from 'node:crypto';
import {
    DESKTOP_PROFILE_RECEIPT,
    createDesktopLaunchBinding,
    createAntigravityLaunchBinding,
    createCodexLaunchBinding,
    isLaunchProfileBinding,
    recoverLaunchProfileGrants
} from '../../../../../../ai/services/fleet/launchProfileCustody.mjs';
import {mintLaunchGrant}                                         from '../../../../../../ai/services/fleet/mcpLaunchAdmission.mjs';
import {generateAntigravityMcpFiles, parseAntigravityMcpInvoker} from '../../../../../../ai/services/fleet/generateAntigravityMcpFiles.mjs';

let root, home, profile, receipt, rows, binding, grant, workspace;
const hash = source => createHash('sha256').update(source).digest('hex');

/** @summary Writes fixture JSON with the same owner-only custody as the production writer. */
async function write(file, value) {
    await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), {mode: 0o600});
}

test.beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-launch-profile-')));
    home = path.join(root, 'seat', 'profile');
    workspace = null;
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
    return recoverLaunchProfileGrants({managedRoot: root, instanceHome: home, workspaceRoot: workspace, binding, ...options});
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
            .toThrow('Launch profile is unverified: invalid-binding.');
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

test.describe('Antigravity original profile custody', () => {
    let generated, invokers, invoker, invokerReceipt, workspaceFile, marker;
    test.beforeEach(async () => {
        workspace = path.join(root, 'workspace');
        workspaceFile = path.join(workspace, '.agents/mcp_config.json');
        invokers = path.join(home, '.neo-fleet-mcp');
        invoker = path.join(invokers, 'memory-core.sh');
        invokerReceipt = path.join(home, '.neo-fleet-antigravity-memory-core.json');
        marker = path.join(root, 'must-not-execute');
        await fs.mkdir(invokers, {mode: 0o700});
        await fs.mkdir(path.dirname(workspaceFile), {recursive: true, mode: 0o700});
        generated = generateAntigravityMcpFiles({profileHome: home, rows,
            processEnvironment: {HOME: home, PATH: '/usr/bin:/bin', USER: `literal'name\n$(touch ${marker})`}});
        binding = createAntigravityLaunchBinding({identity: 'seat-login', issuer: 'http://127.0.0.1:47123',
            instanceHome: home, workspaceRoot: workspace, files: generated.files});
        for (const file of generated.files) {
            await write(file.path, file.content);
            await write(path.join(home, `.neo-fleet-antigravity-${path.basename(file.path, '.sh')}.json`),
                {version: 1, artifact: path.basename(file.path), sha256: hash(file.content)});
        }
        await write(workspaceFile, {mcpServers: {...generated.mcpServers, 'neo-mjs-personal': {command: '/operator/server'}}, preferences: {theme: 'dark'}});
        await fs.chmod(workspaceFile, 0o644);
    });

    test('unchanged literal invokers recover existing grants without execution or persisted secrets', async () => {
        const before = await fs.readFile(invoker, 'utf8');
        expect(isLaunchProfileBinding(binding)).toBe(true);
        expect(await recover()).toEqual({'memory-core': grant.capability});
        expect(parseAntigravityMcpInvoker({profileHome: home, key: 'memory-core', source: before})).toEqual(rows['neo-mjs-memory-core']);
        expect(JSON.stringify(binding)).not.toContain(grant.secret);
        expect(JSON.stringify(binding)).not.toContain('literal');
        expect(await fs.readFile(invoker, 'utf8')).toBe(before);
        await expect(fs.stat(marker)).rejects.toMatchObject({code: 'ENOENT'});
    });

    test('editing an invoker and its mutable receipt cannot replace the original Start', async () => {
        const changed = (await fs.readFile(invoker, 'utf8')).replace("'/runtime/host'", "'/other/runtime'");
        await write(invoker, changed);
        await write(invokerReceipt, {version: 1, artifact: 'memory-core.sh', sha256: hash(changed)});
        await expect(recover()).rejects.toMatchObject({reason: 'invoker-mismatch'});
        expect(await fs.readFile(invoker, 'utf8')).toBe(changed);
    });

    test('a valid invoker copied between profiles cannot borrow the original binding', async () => {
        const other = path.join(root, 'other-seat/profile');
        await fs.cp(home, other, {recursive: true});
        await expect(recover({instanceHome: other})).rejects.toMatchObject({reason: 'profile-binding-mismatch'});
        await expect(recover({instanceHome: other, binding: {...binding, instanceHome: other}}))
            .rejects.toMatchObject({reason: 'invalid-invoker'});
    });

    test('foreign workspace settings remain editable while changed Fleet routes refuse', async () => {
        const content = JSON.parse(await fs.readFile(workspaceFile, 'utf8'));
        content.preferences.theme = 'light';
        content.mcpServers['neo-mjs-personal'].command = '/operator/new-server';
        await write(workspaceFile, content);
        expect(await recover()).toEqual({'memory-core': grant.capability});
        content.mcpServers['neo-mjs-memory-core'].command = '/bin/false';
        await write(workspaceFile, content);
        await expect(recover()).rejects.toMatchObject({reason: 'workspace-mismatch'});
        await expect(recover({workspaceRoot: root})).rejects.toMatchObject({reason: 'profile-binding-mismatch'});
    });

    test('the original enabled-server set excludes missing or extra invokers', async () => {
        await write(path.join(invokers, 'knowledge-base.sh'), generated.files[0].content);
        await expect(recover()).rejects.toMatchObject({reason: 'invoker-set-mismatch'});
        await fs.unlink(path.join(invokers, 'knowledge-base.sh'));
        await fs.unlink(invoker);
        await expect(recover()).rejects.toMatchObject({reason: 'invoker-set-mismatch'});
    });

    test('shell syntax outside the literal writer format refuses even against caller-supplied matching hashes', async () => {
        const original = await fs.readFile(invoker, 'utf8');
        for (const changed of [original.replace('exec /usr/bin/env -i ', 'exec /usr/bin/env '),
            original + `touch ${marker}\n`, original.replace("'HOME=", 'HOME=')]) {
            await write(invoker, changed);
            await write(invokerReceipt, {version: 1, artifact: 'memory-core.sh', sha256: hash(changed)});
            const error = await recover({binding: {...binding, invokerSha256: {'memory-core': hash(changed)}}}).catch(error => error);
            expect(error.reason).toBe('invalid-invoker');
            expect(error.message).not.toContain(grant.capability);
            await expect(fs.stat(marker)).rejects.toMatchObject({code: 'ENOENT'});
        }
    });

    for (const target of ['invoker', 'receipt', 'directory', 'workspace']) {
        test(`${target} cannot be redirected through a link`, async () => {
            const file = {invoker, receipt: invokerReceipt, directory: invokers, workspace: workspaceFile}[target];
            await fs.rename(file, file + '.other');
            await fs.symlink(file + '.other', file);
            await expect(recover()).rejects.toMatchObject({code: 'FLEET_LAUNCH_PROFILE_UNVERIFIED'});
        });
    }

    test('widened secret-file modes, mutable workspace modes and oversized invokers refuse', async () => {
        await fs.chmod(invoker, 0o644);
        await expect(recover()).rejects.toMatchObject({reason: 'file-custody'});
        await fs.chmod(invoker, 0o600);
        await fs.chmod(workspaceFile, 0o664);
        await expect(recover()).rejects.toMatchObject({reason: 'file-custody'});
        await fs.chmod(workspaceFile, 0o644);
        await fs.truncate(invoker, 8 * 1024 * 1024 + 1);
        await expect(recover()).rejects.toMatchObject({reason: 'file-custody'});
    });

    test('an invoker replaced after descriptor acquisition refuses even with identical bytes', async () => {
        const fileSystem = {...fs, open: async (...args) => {
            const handle = await fs.open(...args);
            if (args[0] === invokerReceipt) {
                const source = await fs.readFile(invoker, 'utf8');
                await fs.rename(invoker, invoker + '.old');
                await write(invoker, source);
                await fs.unlink(invoker + '.old');
            }
            return handle;
        }};
        await expect(recover({fileSystem})).rejects.toMatchObject({reason: 'file-changed'});
    });

    test('replacing the invoker subdirectory during workspace inspection refuses', async () => {
        const fileSystem = {...fs, open: async (...args) => {
            const handle = await fs.open(...args);
            if (args[0] === workspaceFile) {
                await fs.rename(invokers, invokers + '-old');
                await fs.cp(invokers + '-old', invokers, {recursive: true});
            }
            return handle;
        }};
        await expect(recover({fileSystem})).rejects.toMatchObject({code: 'FLEET_LAUNCH_PROFILE_UNVERIFIED'});
    });

    test('the closed codec refuses extra fields, mismatched server sets and wrong original capabilities', async () => {
        for (const invalid of [{...binding, capability: grant.capability}, {...binding, kind: 'other'},
            {...binding, workspaceRoot: 'relative'}, {...binding, invokerSha256: {}}]) {
            expect(isLaunchProfileBinding(invalid)).toBe(false);
            await expect(recover({binding: invalid})).rejects.toMatchObject({reason: 'invalid-binding'});
        }
        const wrong = {...binding, grants: {'memory-core': {...binding.grants['memory-core'], sha256: 'a'.repeat(64)}}};
        await expect(recover({binding: wrong})).rejects.toMatchObject({reason: 'grant-mismatch'});
    });
});

test.describe('Codex original profile custody', () => {
    let codexHome, homeConfig, projectConfig, row, homeSource;

    /** @summary One Codex MCP table in the literal shape the Fleet renders. */
    const table = (name, server) => [
        `[mcp_servers."${name}"]`,
        `command = ${JSON.stringify(server.command)}`,
        `args = ${JSON.stringify(server.args)}`,
        `env = { ${Object.entries(server.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ')} }`,
        'startup_timeout_sec = 30'
    ].join('\n');

    test.beforeEach(async () => {
        workspace     = path.join(root, 'workspace');
        codexHome     = path.join(home, 'codex-home');
        homeConfig    = path.join(codexHome, 'config.toml');
        projectConfig = path.join(workspace, '.codex', 'config.toml');
        await fs.mkdir(codexHome, {mode: 0o700});
        await fs.mkdir(path.dirname(projectConfig), {recursive: true, mode: 0o700});
        row = {command: '/runtime/host', args: ['/runtime/ai/mcp/client/fleetMcpLauncher.mjs', '--server', 'neural-link'],
            env: {NEO_AGENT_IDENTITY: 'seat-login', NEO_FLEET_LAUNCH_ISSUER: 'http://127.0.0.1:47123', NEO_FLEET_LAUNCH_GRANT: grant.capability}};
        homeSource = ['model = "gpt-test"', '', table('neo-mjs-neural-link', row), ''].join('\n');
        binding    = createCodexLaunchBinding({identity: 'seat-login', issuer: 'http://127.0.0.1:47123', codexHome, workspaceRoot: workspace, source: homeSource});
        await write(homeConfig, homeSource);
        await write(projectConfig, [table('neo-mjs-memory-core', rows['neo-mjs-memory-core']), '', '[mcp_servers.personal]', 'command = "/operator/server"', ''].join('\n'));
    });

    test('the unchanged home tables recover the grant while the binding carries hashes only', async () => {
        expect(isLaunchProfileBinding(binding)).toBe(true);
        expect(await recover()).toEqual({'neural-link': grant.capability});
        expect(JSON.stringify(binding)).not.toContain(grant.secret);
        expect(JSON.stringify(binding)).not.toContain(grant.capability);
    });

    test('operator settings and foreign tables stay editable in both files', async () => {
        await write(homeConfig, homeSource.replace('gpt-test', 'gpt-other') + '\n[mcp_servers.mine]\ncommand = "/operator/mine"\n');
        await write(projectConfig, '[mcp_servers.personal]\ncommand = "/operator/new"\n');
        expect(await recover()).toEqual({'neural-link': grant.capability});
    });

    test('the seat switching the bound table off or on keeps custody', async () => {
        const switched = homeSource.replace('startup_timeout_sec = 30', 'startup_timeout_sec = 30\nenabled = false');
        await write(homeConfig, switched);
        expect(await recover()).toEqual({'neural-link': grant.capability});
        await write(homeConfig, switched.replace('enabled = false', 'enabled = true'));
        expect(await recover()).toEqual({'neural-link': grant.capability});
    });

    test('an edited Fleet table in the home config refuses', async () => {
        await write(homeConfig, homeSource.replace('/runtime/host', '/other/runtime'));
        await expect(recover()).rejects.toMatchObject({reason: 'projection-mismatch'});
    });

    test('a project table that would win over the bound home table refuses', async () => {
        await write(projectConfig, table('neo-mjs-neural-link', {...row, command: '/operator/node'}) + '\n');
        await expect(recover()).rejects.toMatchObject({reason: 'workspace-mismatch'});
        await write(projectConfig, '[mcp_servers."neo-mjs-neural-link"]\nenv = { NEO_FLEET_LAUNCH_GRANT = "forged" }\n');
        await expect(recover()).rejects.toMatchObject({reason: 'workspace-mismatch'});
    });

    test('the resident\'s tool approvals for the bound table merge under its launcher and keep custody', async () => {
        await write(projectConfig, [
            '[mcp_servers."neo-mjs-neural-link".tools."healthcheck"]', 'approval_mode = "approve"', '',
            '[mcp_servers."neo-mjs-neural-link".tools."query_vdom"]', 'approval_mode = "approve"', ''
        ].join('\n'));
        expect(await recover()).toEqual({'neural-link': grant.capability});
    });

    test('no project config is no override, but one that appears during recovery refuses', async () => {
        await fs.rm(path.dirname(projectConfig), {recursive: true});
        expect(await recover()).toEqual({'neural-link': grant.capability});

        let created = false;
        const fileSystem = {...fs, lstat: async (file, ...rest) => {
            try {
                return await fs.lstat(file, ...rest)
            } catch (error) {
                if (file === path.dirname(projectConfig) && !created) {
                    created = true;
                    await fs.mkdir(file, {mode: 0o700});
                }
                throw error
            }
        }};
        await expect(recover({fileSystem})).rejects.toMatchObject({reason: 'file-changed'});
    });

    test('another workspace or a home outside the seat profile refuses', async () => {
        await expect(recover({workspaceRoot: root})).rejects.toMatchObject({reason: 'profile-binding-mismatch'});
        const outside = createCodexLaunchBinding({identity: 'seat-login', issuer: 'http://127.0.0.1:47123',
            codexHome: path.join(root, 'elsewhere'), workspaceRoot: workspace, source: homeSource});
        await expect(recover({binding: outside})).rejects.toMatchObject({reason: 'profile-binding-mismatch'});
    });

    test('a home config others can read refuses', async () => {
        await fs.chmod(homeConfig, 0o644);
        await expect(recover()).rejects.toMatchObject({reason: 'file-custody'});
    });

    test('the closed codec refuses extra fields, a foreign kind and a relative home', async () => {
        for (const invalid of [{...binding, capability: grant.capability}, {...binding, kind: 'desktop'}, {...binding, codexHome: 'relative'}]) {
            expect(isLaunchProfileBinding(invalid)).toBe(false);
            await expect(recover({binding: invalid})).rejects.toMatchObject({reason: 'invalid-binding'});
        }
    });
});

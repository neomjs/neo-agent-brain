import {test, expect}                        from '@playwright/test';
import {spawn}                               from 'node:child_process';
import crypto                                from 'node:crypto';
import fs                                    from 'node:fs';
import os                                    from 'node:os';
import path                                  from 'node:path';
import {fileURLToPath}                       from 'node:url';
import {STAND_IN_RECORD_FILE, resolveLaunch} from '../../../../../../ai/scripts/fleet/seatStandIn.mjs';

const
    __dirname   = path.dirname(fileURLToPath(import.meta.url)),
    standInPath = path.resolve(__dirname, '../../../../../../ai/scripts/fleet/seatStandIn.mjs'),
    fixturePath = path.join(__dirname, 'fixtures', 'healthcheckMcpServer.mjs');

/**
 * @summary A stdio row that runs the fixture server with a marker and a pid file.
 * @param {String} root
 * @param {String} marker
 * @returns {Object}
 */
function fixtureRow(root, marker) {
    return {command: process.execPath, args: [fixturePath], env: {FIXTURE_MARKER: marker, FIXTURE_PID_FILE: path.join(root, `${marker}.pid`)}}
}

/**
 * @summary Starts the stand-in as the Fleet would and waits for the record its launch writes.
 * @param {Object}   options
 * @param {String[]} options.args
 * @param {Object}   options.env
 * @param {String}   options.instanceHome
 * @returns {Promise<{child: ChildProcess, record: Object}>}
 */
async function launch({args = [], env, instanceHome}) {
    const
        child    = spawn(process.execPath, [standInPath, ...args], {env: {PATH: process.env.PATH, HOME: process.env.HOME, ...env}, stdio: 'ignore'}),
        file     = path.join(instanceHome, STAND_IN_RECORD_FILE),
        deadline = Date.now() + 20_000;

    while (Date.now() < deadline) {
        const record = fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).records.find(entry => entry.pid === child.pid);
        if (record) return {child, record};
        await new Promise(resolve => setTimeout(resolve, 100))
    }

    child.kill('SIGKILL');
    throw new Error('the stand-in wrote no record for its launch')
}

/**
 * @summary Whether a pid still names a live process.
 * @param {Number} pid
 * @returns {Boolean}
 */
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true
    } catch {
        return false
    }
}

test.describe('ai/scripts/fleet/seatStandIn', () => {
    let root;

    test.beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-stand-in-'))
    });

    test.afterEach(() => {
        fs.rmSync(root, {recursive: true, force: true})
    });

    test('a Claude Desktop launch probes every row, records the launch, and reaps its servers on SIGTERM', async () => {
        const configPath = path.join(root, 'claude_desktop_config.json');

        fs.writeFileSync(configPath, JSON.stringify({mcpServers: {
            answering: fixtureRow(root, 'claude-marker'),
            absent   : {command: process.execPath, args: [path.join(root, 'missing-server.mjs')]}
        }}));

        const {child, record} = await launch({env: {CLAUDE_USER_DATA_DIR: root}, instanceHome: root});

        expect(record.family).toBe('claude-desktop');
        expect(record.configs).toEqual([{path: configPath, sha256: crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex')}]);
        expect(record.rows.find(row => row.name === 'answering')).toMatchObject({ok: true, tools: 1, healthcheck: {status: 'healthy', marker: 'claude-marker'}});
        expect(record.rows.find(row => row.name === 'absent')).toMatchObject({ok: false, step: 'initialize'});

        const serverPid = Number(fs.readFileSync(path.join(root, 'claude-marker.pid'), 'utf8'));
        expect(isAlive(serverPid), 'the stand-in holds its servers like a session').toBe(true);

        const exitCode = await new Promise(resolve => {
            child.once('exit', resolve);
            child.kill('SIGTERM')
        });

        expect(exitCode).toBe(0);
        await expect.poll(() => isAlive(serverPid), {timeout: 5_000}).toBe(false)
    });

    test('a Codex Desktop launch reads the home config, then the project config, whose rows win by name', async () => {
        const
            codexHome = path.join(root, 'codex-home'),
            project   = path.join(root, 'repo'),
            tomlRow   = (name, row) => [
                `[mcp_servers.${name}]`,
                `command = ${JSON.stringify(row.command)}`,
                `args = ${JSON.stringify(row.args)}`,
                `[mcp_servers.${name}.env]`,
                ...Object.entries(row.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
            ].join('\n');

        fs.mkdirSync(codexHome, {recursive: true});
        fs.mkdirSync(path.join(project, '.codex'), {recursive: true});
        fs.writeFileSync(path.join(codexHome, 'config.toml'), [tomlRow('shared', fixtureRow(root, 'home-marker')), tomlRow('home_only', fixtureRow(root, 'home-only'))].join('\n\n'));
        fs.writeFileSync(path.join(project, '.codex', 'config.toml'), tomlRow('shared', fixtureRow(root, 'project-marker')));

        const {child, record} = await launch({args: [`--user-data-dir=${path.join(root, 'electron-profile')}`, `--open-project=${project}`], env: {CODEX_HOME: codexHome}, instanceHome: root});

        child.kill('SIGTERM');

        expect(record.family).toBe('codex-desktop');
        expect(record.configs.map(config => config.path)).toEqual([path.join(codexHome, 'config.toml'), path.join(project, '.codex', 'config.toml')]);
        expect(record.rows.map(row => [row.name, row.ok, row.healthcheck?.marker])).toEqual([
            ['shared', true, 'project-marker'],
            ['home_only', true, 'home-only']
        ])
    });

    test('a version probe answers and exits without reading any config', async () => {
        const output = await new Promise((resolve, reject) => {
            const child  = spawn(process.execPath, [standInPath, `--user-data-dir=${root}`, '--version'], {env: {PATH: process.env.PATH}});
            let   stdout = '';

            child.stdout.on('data', chunk => stdout += chunk);
            child.once('error', reject);
            child.once('exit', code => code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}`)))
        });

        expect(output.trim()).toBe('seat-stand-in 1.0.0')
    });

    test('a launch without a family environment is refused by name', () => {
        expect(() => resolveLaunch({argv: [], env: {}})).toThrow('expected CLAUDE_USER_DATA_DIR or CODEX_HOME')
    });

    test('a server without a healthcheck tool, or one answering isError, fails that ask by name', async () => {
        const
            silent  = fixtureRow(root, 'no-tool'),
            failing = fixtureRow(root, 'is-error');

        silent.env.FIXTURE_TOOL    = 'ping';
        failing.env.FIXTURE_HEALTH = 'error';
        fs.writeFileSync(path.join(root, 'claude_desktop_config.json'), JSON.stringify({mcpServers: {silent, failing}}));

        const {child, record} = await launch({env: {CLAUDE_USER_DATA_DIR: root}, instanceHome: root});

        child.kill('SIGTERM');

        expect(record.rows.find(row => row.name === 'silent')).toMatchObject({ok: false, step: 'healthcheck', reason: 'the server lists no healthcheck tool'});
        expect(record.rows.find(row => row.name === 'failing')).toMatchObject({ok: false, step: 'healthcheck'});
        expect(record.rows.find(row => row.name === 'failing').reason).toContain('answered isError')
    });

    test('a row its config switches off is recorded as disabled and never started, in both formats', async () => {
        const codexHome = path.join(root, 'codex-home');

        fs.mkdirSync(codexHome, {recursive: true});
        fs.writeFileSync(path.join(codexHome, 'config.toml'), [
            '[mcp_servers.off]',
            `command = ${JSON.stringify(process.execPath)}`,
            `args = ${JSON.stringify([fixturePath])}`,
            'enabled = false',
            '[mcp_servers.off.env]',
            `FIXTURE_PID_FILE = ${JSON.stringify(path.join(root, 'toml-off.pid'))}`
        ].join('\n'));
        fs.writeFileSync(path.join(root, 'claude_desktop_config.json'), JSON.stringify({mcpServers: {
            off: {...fixtureRow(root, 'json-off'), disabled: true}
        }}));

        const codex  = await launch({env: {CODEX_HOME: codexHome}, instanceHome: root}),
              claude = await launch({env: {CLAUDE_USER_DATA_DIR: root}, instanceHome: root});

        codex.child.kill('SIGTERM');
        claude.child.kill('SIGTERM');

        expect(codex.record.rows).toEqual([{name: 'off', disabled: true}]);
        expect(claude.record.rows).toEqual([{name: 'off', disabled: true}]);
        expect(fs.existsSync(path.join(root, 'toml-off.pid')), 'the TOML row never started').toBe(false);
        expect(fs.existsSync(path.join(root, 'json-off.pid')), 'the JSON row never started').toBe(false)
    });

    test('a Stop while a server is still answering reaps that server, and the launch writes no record', async () => {
        const slow = fixtureRow(root, 'slow');

        slow.env.FIXTURE_DELAY_MS = '30000';
        fs.writeFileSync(path.join(root, 'claude_desktop_config.json'), JSON.stringify({mcpServers: {slow}}));

        const
            child   = spawn(process.execPath, [standInPath], {env: {PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_USER_DATA_DIR: root}, stdio: 'ignore'}),
            pidFile = path.join(root, 'slow.pid');

        await expect.poll(() => fs.existsSync(pidFile), {timeout: 20_000}).toBe(true);
        const serverPid = Number(fs.readFileSync(pidFile, 'utf8'));

        // the healthcheck is still pending: the server holds it for 30 s
        await new Promise(resolve => setTimeout(resolve, 500));

        const exitCode = await new Promise(resolve => {
            child.once('exit', resolve);
            child.kill('SIGTERM')
        });

        expect(exitCode).toBe(0);
        await expect.poll(() => isAlive(serverPid), {timeout: 5_000}).toBe(false);
        expect(fs.existsSync(path.join(root, STAND_IN_RECORD_FILE))).toBe(false)
    })
});

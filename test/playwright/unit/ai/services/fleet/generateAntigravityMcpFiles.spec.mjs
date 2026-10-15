import {expect, test}                                             from '@playwright/test';
import {spawn, spawnSync}                                         from 'node:child_process';
import fs                                                         from 'node:fs';
import http                                                       from 'node:http';
import os                                                         from 'node:os';
import path                                                       from 'node:path';
import {fileURLToPath}                                            from 'node:url';
import {generateAntigravityMcpFiles}                              from '../../../../../../ai/services/fleet/generateAntigravityMcpFiles.mjs';
import {MCP_SERVERS}                                              from '../../../../../../src/fleet/contract/mcpServers.mjs';
import {mintLaunchGrant, signLaunchResponse, verifyLaunchRequest} from '../../../../../../ai/services/fleet/mcpLaunchAdmission.mjs';

const SERVER = 'neo-mjs-memory-core';

/** @summary Execute the emitted carrier with inert launcher bytes, never an MCP server or vendor process. */
function fixture(root, name) {
    const profileHome = path.join(root, name), launcher = path.join(root, `${name}-runtime`, 'fleetMcpLauncher.mjs');
    fs.mkdirSync(path.dirname(launcher), {recursive: true});
    fs.writeFileSync(launcher, 'process.stdout.write(JSON.stringify({argv: process.argv.slice(2), env: process.env}));');
    const rows = {[SERVER]: {
        command: process.execPath,
        args   : [launcher, '--server', 'memory-core'],
        env    : {
            NEO_AGENT_IDENTITY     : name.replace(/[^a-z0-9]/g, '-'),
            NEO_FLEET_LAUNCH_GRANT : mintLaunchGrant().capability,
            NEO_FLEET_LAUNCH_ISSUER: 'http://127.0.0.1:12345'
        }
    }};
    const processEnvironment = {HOME: root, PATH: '/usr/bin:/bin', LANG: 'C', USER: "literal'$(touch ignored)\nvalue"};
    const generated          = generateAntigravityMcpFiles({profileHome, rows, processEnvironment});
    for (const file of generated.files) {
        fs.mkdirSync(path.dirname(file.path), {recursive: true});
        fs.writeFileSync(file.path, file.content, {mode: file.mode});
    }
    return {profileHome, rows, processEnvironment, generated}
}

/** @summary Supply a locator as the installed app would; the app's assignment itself needs native proof. */
function run(f, environment = {}) {
    const row = f.generated.mcpServers[SERVER];
    return spawnSync(row.command, row.args, {
        env     : {AGY_BROWSER_ACTIVE_PORT_FILE: path.join(f.profileHome, 'DevToolsActivePort'), ...environment},
        encoding: 'utf8', timeout: 5000
    })
}

test.describe('Antigravity profile MCP carrier', () => {
    let root;
    test.beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'neo-antigravity-carrier-'))) });
    test.afterEach(() => { fs.rmSync(root, {recursive: true, force: true}) });

    test('one neutral workspace declaration reaches distinct profile runtimes and grants', () => {
        const a = fixture(root, "seat-a's profile"), b = fixture(root, 'seat-b');
        expect(a.generated.mcpServers).toEqual(b.generated.mcpServers);
        expect(JSON.stringify(a.generated.mcpServers)).not.toContain(root);
        for (const f of [a, b]) {
            const result = run(f);
            expect(result.error).toBeUndefined();
            expect(result.status, result.stderr).toBe(0);
            const observed = JSON.parse(result.stdout);
            expect(observed.argv).toEqual(['--server', 'memory-core']);
            expect(observed.env).toMatchObject({...f.processEnvironment, ...f.rows[SERVER].env});
            expect(fs.statSync(f.generated.files[0].path).mode & 0o777).toBe(0o600);
        }
    });

    test('hostile credentials, process options and shell startup files never enter the launcher', () => {
        const f = fixture(root, 'seat-a'), hook = path.join(root, 'startup.sh'), marker = path.join(root, 'executed');
        fs.writeFileSync(hook, `touch '${marker}'`);
        const result = run(f, {
            GH_TOKEN              : 'foreign-pat', GITHUB_TOKEN: 'foreign-alias', GEMINI_API_KEY: 'foreign-provider',
            NEO_AGENT_IDENTITY    : 'foreign-seat', NEO_MCP_REMOTE_TOKEN: 'foreign-plane',
            NEO_FLEET_LAUNCH_GRANT: 'foreign-grant', NODE_OPTIONS: '--not-a-node-option',
            NODE_PATH             : '/foreign/modules', PATH: '/foreign/bin', ENV: hook, BASH_ENV: hook,
            SHELLOPTS             : 'xtrace', BASHOPTS: 'expand_aliases', PS4: `$(/usr/bin/touch '${marker}') `,
            'BASH_FUNC_read%%'    : `() { /usr/bin/touch '${marker}'; }`,
            'BASH_FUNC_exec%%'    : `() { /usr/bin/touch '${marker}'; }`
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe('');
        expect(fs.existsSync(marker)).toBe(false);
        const env = JSON.parse(result.stdout).env;
        expect(env.NEO_AGENT_IDENTITY).toBe('seat-a');
        for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GEMINI_API_KEY', 'NEO_MCP_REMOTE_TOKEN', 'NODE_OPTIONS',
            'NODE_PATH', 'ENV', 'BASH_ENV', 'SHELLOPTS', 'BASHOPTS', 'AGY_BROWSER_ACTIVE_PORT_FILE']) {
            expect(env[key], key).toBeUndefined();
        }
    });

    test('missing anchor, unmanaged profile, unmarked or foreign invoker and symlink refuse', () => {
        const f = fixture(root, 'seat-a');
        for (const anchor of ['', 'relative/DevToolsActivePort', path.join(root, 'unmanaged', 'DevToolsActivePort')]) {
            const result = run(f, {AGY_BROWSER_ACTIVE_PORT_FILE: anchor});
            expect(result.status).toBe(78);
            expect(result.stdout).toBe('');
        }
        const file = f.generated.files[0].path;
        fs.writeFileSync(file, 'echo unauthorized');
        expect(run(f).status).toBe(78);
        const foreign = fixture(root, 'seat-b').generated.files[0].path;
        fs.copyFileSync(foreign, file);
        const copied = run(f);
        expect(copied.status).toBe(78);
        expect(copied.stdout).toBe('');
        fs.unlinkSync(file);
        fs.symlinkSync(foreign, file);
        expect(run(f).status).toBe(78);
    });

    test('a server without a profile invoker stays refused even if another seat declares it', () => {
        const f     = fixture(root, 'seat-a');
        const empty = generateAntigravityMcpFiles({profileHome: path.join(root, 'seat-disabled'), rows: {}, processEnvironment: {}});
        expect(empty.files).toEqual([]);
        expect(Object.keys(empty.mcpServers).sort()).toEqual(MCP_SERVERS.map(({key}) => `neo-mjs-${key}`).sort());
        for (const row of Object.values(empty.mcpServers)) expect(row).toEqual({command: '/usr/bin/false', disabled: true});
        expect(f.generated.mcpServers[SERVER].disabled).toBeUndefined();
        expect(f.generated.mcpServers['neo-mjs-github-workflow'].disabled).toBe(true);
        expect(empty.projectMcpAllowRules).toEqual([
            'mcp(neo-mjs-memory-core/*)', 'mcp(neo-mjs-knowledge-base/*)', 'mcp(neo-mjs-neural-link/*)',
            'mcp(neo-mjs-github-workflow/*)', 'mcp(neo-mjs-gitlab-workflow/*)'
        ]);
        expect(run(f, {AGY_BROWSER_ACTIVE_PORT_FILE: path.join(root, 'seat-disabled', 'DevToolsActivePort')}).status).toBe(78);
    });

    test('refuses credential-bearing or process-controlling profile inputs', () => {
        const f = fixture(root, 'seat-a');
        for (const key of ['GH_TOKEN', 'GEMINI_API_KEY', 'NODE_OPTIONS', 'NEO_MCP_REMOTE_TOKEN']) {
            expect(() => generateAntigravityMcpFiles({...f, processEnvironment: {[key]: 'untrusted'}})).toThrow();
            expect(() => generateAntigravityMcpFiles({...f, rows: {[SERVER]: {...f.rows[SERVER], env: {...f.rows[SERVER].env, [key]: 'untrusted'}}}})).toThrow();
        }
    });

    test('existing launcher authenticates each grant and rejects another generation target', async () => {
        const records = new Map();
        const server  = http.createServer((req, res) => {
            let data = '';
            req.on('data', chunk => { data += chunk });
            req.on('end', () => {
                const request = JSON.parse(data), record = records.get(request.grant);
                const valid   = record && request.identity === record.identity && request.server === 'memory-core' &&
                    verifyLaunchRequest(record.grant.secret, request);
                const answer = valid ? signLaunchResponse(record.grant.secret, request, {
                    outcome: 'admitted', generationRoot: record.generation, args: [record.target], env: {GH_TOKEN: 'admitted-fixture-token'}
                }) : {outcome: 'refused', code: 'unknown-grant'};
                res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(answer));
            });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const seats = ['alpha', 'beta'].map(identity => {
                const generation = path.join(root, identity), profileHome = path.join(root, `${identity}-profile`);
                for (const relative of ['ai/mcp/client/fleetMcpLauncher.mjs', 'ai/services/fleet/mcpLaunchAdmission.mjs',
                    'src/fleet/contract/launchAdmission.mjs']) {
                    const target = path.join(generation, relative);
                    fs.mkdirSync(path.dirname(target), {recursive: true});
                    fs.copyFileSync(fileURLToPath(new URL(`../../../../../../${relative}`, import.meta.url)), target);
                }
                const target = path.join(generation, 'target.mjs'), grant = mintLaunchGrant();
                fs.writeFileSync(target, `process.stdout.write(JSON.stringify({identity:process.env.NEO_AGENT_IDENTITY,
                    tokenAdmitted:process.env.GH_TOKEN==='admitted-fixture-token',
                    aliasAbsent:!('GITHUB_TOKEN' in process.env), grantConsumed:!('NEO_FLEET_LAUNCH_GRANT' in process.env)}));`);
                const record = {identity, target, grant, generation};
                records.set(grant.id, record);
                const generated = generateAntigravityMcpFiles({profileHome, processEnvironment: {PATH: '/usr/bin:/bin', LANG: 'C'}, rows: {
                    [SERVER]: {command: process.execPath, args: [path.join(generation, 'ai/mcp/client/fleetMcpLauncher.mjs'), '--server', 'memory-core'],
                        env: {NEO_AGENT_IDENTITY: identity, NEO_FLEET_LAUNCH_GRANT: grant.capability,
                            NEO_FLEET_LAUNCH_ISSUER: `http://127.0.0.1:${server.address().port}`}}
                }});
                for (const file of generated.files) {
                    fs.mkdirSync(path.dirname(file.path), {recursive: true});
                    fs.writeFileSync(file.path, file.content, {mode: file.mode});
                }
                return {profileHome, generated, record};
            });
            const launch = seat => new Promise((resolve, reject) => {
                const row   = seat.generated.mcpServers[SERVER];
                const child = spawn(row.command, row.args, {env: {
                    AGY_BROWSER_ACTIVE_PORT_FILE: path.join(seat.profileHome, 'DevToolsActivePort'),
                    NEO_AGENT_IDENTITY          : 'foreign', GH_TOKEN: 'inherited-foreign', GITHUB_TOKEN: 'inherited-alias'
                }, stdio: ['ignore', 'pipe', 'pipe']});
                let   stdout = '', stderr = '';
                const timer  = setTimeout(() => child.kill('SIGKILL'), 5000);
                child.stdout.on('data', data => { stdout += data });
                child.stderr.on('data', data => { stderr += data });
                child.once('error', error => { clearTimeout(timer); reject(error) });
                child.once('close', (code, signal) => { clearTimeout(timer); resolve({code, signal, stdout, stderr}) });
            });
            expect(seats[0].generated.mcpServers).toEqual(seats[1].generated.mcpServers);
            const results = await Promise.all(seats.map(launch));
            results.forEach((result, index) => {
                expect(result.code, result.stderr).toBe(0);
                expect(JSON.parse(result.stdout)).toEqual({identity: seats[index].record.identity,
                    tokenAdmitted: true, aliasAbsent: true, grantConsumed: true});
            });
            seats[0].record.target = seats[1].record.target;
            const foreignTarget = await launch(seats[0]);
            expect(foreignTarget.code).toBe(1);
            expect(foreignTarget.stdout).toBe('');
            expect(foreignTarget.stderr).toContain('target-invalid');
            seats[0].record.target = path.join(seats[0].record.generation, 'target.mjs');
            seats[0].record.generation = seats[1].record.generation;
            const foreignGeneration = await launch(seats[0]);
            expect(foreignGeneration.code).toBe(1);
            expect(foreignGeneration.stdout).toBe('');
            expect(foreignGeneration.stderr).toContain('target-invalid');
            records.delete(seats[1].record.grant.id);
            const revoked = await launch(seats[1]);
            expect(revoked.code).toBe(1);
            expect(revoked.stderr).toContain('unknown-grant');
            expect(revoked.stdout).toBe('');
        } finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    });
});

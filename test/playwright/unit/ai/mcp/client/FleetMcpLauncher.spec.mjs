import {expect, test}  from '@playwright/test';
import {spawn}         from 'node:child_process';
import fs              from 'node:fs/promises';
import os              from 'node:os';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    LaunchRefusal,
    admitLaunch,
    composeTargetEnv,
    issuerOrigin,
    parseLauncherArgs,
    resolveTarget,
    runTarget
} from '../../../../../../ai/mcp/client/fleetMcpLauncher.mjs';
import {
    launchRefusal,
    mintLaunchGrant,
    parseLaunchRequest,
    signLaunchResponse
} from '../../../../../../ai/services/fleet/mcpLaunchAdmission.mjs';

const
    REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..'),
    TARGET    = path.join(REPO_ROOT, 'ai/mcp/server/github-workflow/mcp-server.mjs');

/** @summary The environment Desktop gives a profile row: a stripped base plus the row's own values. */
function rowEnv(grant, overrides = {}) {
    return {
        HOME                   : '/Users/seat',
        PATH                   : '/usr/bin:/bin',
        NEO_AGENT_IDENTITY     : 'neo-opus-ada',
        NEO_PLANE_DATA_ROOT    : '/plane',
        NEO_FLEET_LAUNCH_ISSUER: 'http://127.0.0.1:47123',
        NEO_FLEET_LAUNCH_GRANT : grant.capability,
        ...overrides
    }
}

/** @summary An issuer stand-in that answers with what `answer(request, grant)` returns, recording each call. */
function issuer(grant, answer) {
    const calls   = [];
    const request = async (origin, body) => {
        calls.push({origin, body});
        return answer(parseLaunchRequest(body), grant)
    };

    request.calls = calls;
    return request
}

const admitted = (request, grant) => signLaunchResponse(grant.secret, request, {outcome: 'admitted', env: {GH_TOKEN: 'ghp_fixture'}, args: [TARGET]});

test.describe('fleetMcpLauncher', () => {
    test('its grammar is exactly --server <key>; the issuer is a loopback origin and nothing else', () => {
        expect(parseLauncherArgs(['--server', 'github-workflow'])).toEqual({server: 'github-workflow'});

        for (const argv of [[], ['--server'], ['--server', 'github-workflow', '--cwd', '/tmp'], ['--target', 'x'], ['--server', '../x']]) {
            expect(() => parseLauncherArgs(argv), argv.join(' ')).toThrow(LaunchRefusal)
        }

        expect(issuerOrigin('http://127.0.0.1:47123')).toBe('http://127.0.0.1:47123');

        for (const value of ['http://localhost:47123', 'https://127.0.0.1:47123', 'http://127.0.0.1:0', 'http://127.0.0.1:47123/x', 'http://10.0.0.1:47123', undefined]) {
            expect(issuerOrigin(value), String(value)).toBeNull()
        }
    });

    test('an admitted grant starts its target with the admitted values, and the grant never reaches the target', async () => {
        const
            grant   = mintLaunchGrant(),
            request = issuer(grant, admitted),
            launch  = await admitLaunch({argv: ['--server', 'github-workflow'], env: rowEnv(grant), request});

        expect(launch.args).toEqual([TARGET]);
        expect(launch.env).toEqual({HOME: '/Users/seat', PATH: '/usr/bin:/bin', NEO_AGENT_IDENTITY: 'neo-opus-ada', NEO_PLANE_DATA_ROOT: '/plane', GH_TOKEN: 'ghp_fixture'});
        expect(request.calls[0].origin).toBe('http://127.0.0.1:47123');
        expect(request.calls[0].body).toMatchObject({server: 'github-workflow', identity: 'neo-opus-ada'});
        expect(JSON.stringify(request.calls)).not.toContain(grant.secret)
    });

    test('nothing unsigned admits: a forged or unsigned admission is refused, an unsigned refusal is believed', async () => {
        const
            grant = mintLaunchGrant(),
            run   = answer => admitLaunch({argv: ['--server', 'github-workflow'], env: rowEnv(grant), request: issuer(grant, answer)});

        await expect(run(() => ({outcome: 'admitted', env: {GH_TOKEN: 'attacker'}, args: [TARGET]}))).rejects.toMatchObject({code: 'unauthenticated-response'});
        await expect(run(request => signLaunchResponse(mintLaunchGrant().secret, request, {outcome: 'admitted', env: {}, args: [TARGET]})))
            .rejects.toMatchObject({code: 'unauthenticated-response'});
        await expect(run(() => launchRefusal('unknown-grant'))).rejects.toMatchObject({code: 'unknown-grant'});
        await expect(run(() => ({outcome: 'refused', code: 'made-up'}))).rejects.toMatchObject({code: 'unauthenticated-response'});
        await expect(run((request, owned) => signLaunchResponse(owned.secret, request, {outcome: 'refused', code: 'revoked', reason: 'stop-requested'})))
            .rejects.toMatchObject({code: 'revoked', reason: 'stop-requested', message: expect.stringContaining('restart the seat there')})
    });

    test('a row without a well-formed grant, issuer or identity refuses before it asks anyone', async () => {
        const grant = mintLaunchGrant();

        for (const overrides of [{NEO_FLEET_LAUNCH_GRANT: 'not-a-grant'}, {NEO_FLEET_LAUNCH_ISSUER: 'http://example.com:1'}, {NEO_AGENT_IDENTITY: undefined}]) {
            const request = issuer(grant, admitted);

            await expect(admitLaunch({argv: ['--server', 'github-workflow'], env: rowEnv(grant, overrides), request})).rejects.toMatchObject({code: 'malformed'});
            expect(request.calls).toEqual([])
        }
    });

    test('an admitted target must be a module this installation ships', async () => {
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-outside-'));
        const linked  = path.join(REPO_ROOT, 'test/playwright/test-results', `launcher-link-${process.pid}.mjs`);

        try {
            const escape = path.join(outside, 'payload.mjs');

            await fs.writeFile(escape, '');
            await fs.mkdir(path.dirname(linked), {recursive: true});
            await fs.symlink(escape, linked);

            for (const args of [[escape], [linked], ['relative/target.mjs'], [path.join(REPO_ROOT, 'package.json')], [path.join(REPO_ROOT, 'missing.mjs')], []]) {
                expect(() => resolveTarget(args, REPO_ROOT), String(args[0])).toThrow(expect.objectContaining({code: 'target-invalid'}))
            }

            expect(resolveTarget([TARGET, '--cwd', REPO_ROOT], REPO_ROOT)).toEqual([TARGET, '--cwd', REPO_ROOT])
        } finally {
            await fs.rm(linked, {force: true});
            await fs.rm(outside, {recursive: true, force: true})
        }
    });

    test('an admitted value may neither override the row nor steer the process that runs the target', () => {
        const env = {PATH: '/usr/bin', NEO_PLANE_DATA_ROOT: '/plane', NEO_FLEET_LAUNCH_GRANT: 'g', NEO_FLEET_LAUNCH_ISSUER: 'i'};

        expect(composeTargetEnv(env, {GH_TOKEN: 'pat'})).toEqual({PATH: '/usr/bin', NEO_PLANE_DATA_ROOT: '/plane', GH_TOKEN: 'pat'});

        for (const admittedEnv of [{NEO_PLANE_DATA_ROOT: '/elsewhere'}, {NODE_OPTIONS: '--require /tmp/x.js'}, {DYLD_INSERT_LIBRARIES: '/tmp/x'}, {GH_TOKEN: 7}, null]) {
            expect(() => composeTargetEnv(env, admittedEnv), JSON.stringify(admittedEnv)).toThrow(expect.objectContaining({code: 'malformed'}))
        }
    });

    test('the target runs on the launcher\'s stdio, gets the signals the launcher gets, and its exit is the launcher\'s', async () => {
        const
            before = new Set(process.listeners('SIGTERM')),
            seen   = {options: null, output: ''},
            run    = runTarget({
                args   : ['-e', 'process.on("SIGTERM", () => process.exit(7)); console.log(process.env.GH_TOKEN); setInterval(() => {}, 1000)'],
                env    : {GH_TOKEN: 'from-the-issuer'},
                spawnFn: (command, args, options) => {
                    seen.options = options;
                    // read what the inherited stdout would show
                    const child = spawn(command, args, {...options, stdio: ['ignore', 'pipe', 'inherit']});

                    child.stdout.on('data', chunk => seen.output += chunk);
                    return child
                }
            });

        expect(seen.options.stdio).toBe('inherit');
        await expect.poll(() => seen.output).toContain('from-the-issuer');

        // call only the forwarder the launcher added, so the test runner's own SIGTERM handling stays out of it
        process.listeners('SIGTERM').filter(listener => !before.has(listener)).forEach(listener => listener());

        expect(await run).toEqual({code: 7, signal: null});
        expect(process.listeners('SIGTERM').filter(listener => !before.has(listener)), 'the forwarders are removed').toEqual([])
    });
});

import {test, expect}                from '@playwright/test';
import {spawn, spawnSync}            from 'node:child_process';
import crypto                        from 'node:crypto';
import fs                            from 'node:fs';
import net                           from 'node:net';
import os                            from 'node:os';
import path                          from 'node:path';
import {fileURLToPath}               from 'node:url';
import {createOnboardingFleetBridge} from '../../../../../../ai/scripts/fleet/onboardPeer.mjs';
import {
    compareOperatorContent,
    expectedRows,
    judgeRecord,
    readOperatorContent,
    runSeatJourney,
    seedOperatorContent,
    seedSeatCheckout,
    writeCodexStandInBundle,
    writeStandInLauncher
} from '../../../../../../ai/services/fleet/seatJourney.mjs';

const
    __dirname  = path.dirname(fileURLToPath(import.meta.url)),
    BRAIN_ROOT = path.resolve(__dirname, '../../../../../..'),
    VIEWER     = '@neo-seat-journey';

test.describe('ai/services/fleet/seatJourney — judgements', () => {
    test('operator content survives fresh Fleet rows, and a change to it is named', () => {
        const
            directory = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-journey-content-')),
            json      = path.join(directory, 'claude_desktop_config.json'),
            toml      = path.join(directory, 'config.toml'),
            row       = grant => ({command: 'node', args: ['launcher.mjs'], env: {NEO_FLEET_LAUNCH_GRANT: grant}});

        try {
            fs.writeFileSync(json, JSON.stringify({mcpServers: {'neo-mjs-neural-link': row('a'), mine: row('m')}, theme: 'dark'}));
            fs.writeFileSync(toml, '[approvals]\nlevel = 2\n\n[mcp_servers.neo-mjs-neural-link]\ncommand = "node"\n');

            seedOperatorContent(json, 'seeded');
            seedOperatorContent(toml, 'seeded');
            expect(readOperatorContent(json)).toEqual({mcpServers: {mine: row('m')}, theme: 'dark', neoSeatJourney: {marker: 'seeded'}});
            expect(readOperatorContent(toml)).toEqual({approvals: {level: 2}, mcp_servers: {}, neo_seat_journey: {marker: 'seeded'}});

            const before = {[json]: readOperatorContent(json), [toml]: readOperatorContent(toml)};

            // a fresh grant in the Fleet's own row is not the operator's content
            fs.writeFileSync(json, JSON.stringify({...JSON.parse(fs.readFileSync(json, 'utf8')), mcpServers: {'neo-mjs-neural-link': row('b'), mine: row('m')}}));
            expect(compareOperatorContent(before)).toEqual({ok: true, changed: []});

            fs.writeFileSync(toml, '[mcp_servers.neo-mjs-neural-link]\ncommand = "node"\n');
            expect(compareOperatorContent(before)).toEqual({ok: false, changed: [toml]})
        } finally {
            fs.rmSync(directory, {recursive: true, force: true})
        }
    });

    test("the switch inside a Fleet row is the operator's: a fresh grant passes, a flipped switch fails", () => {
        const
            directory = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-journey-switch-')),
            toml      = path.join(directory, 'config.toml'),
            write     = (grant, enabled) => fs.writeFileSync(toml, [
                '[mcp_servers."neo-mjs-neural-link"]', 'command = "node"', `enabled = ${enabled}`,
                '[mcp_servers."neo-mjs-neural-link".env]', `NEO_FLEET_LAUNCH_GRANT = "${grant}"`
            ].join('\n'));

        try {
            write('a', true);
            expect(readOperatorContent(toml)).toEqual({mcp_servers: {'neo-mjs-neural-link': {enabled: true}}});

            const before = {[toml]: readOperatorContent(toml)};

            write('b', true);
            expect(compareOperatorContent(before), 'a fresh grant').toEqual({ok: true, changed: []});

            write('b', false);
            expect(compareOperatorContent(before), 'the operator switched the row off').toEqual({ok: false, changed: [toml]})
        } finally {
            fs.rmSync(directory, {recursive: true, force: true})
        }
    });

    test('expectedRows names a Fleet row for every server the seat matrix enables', () => {
        expect(expectedRows({mcpServers: {'memory-core': false, 'knowledge-base': false, 'github-workflow': false}})).toEqual(['neo-mjs-neural-link']);
        expect(expectedRows({})).toEqual(['neo-mjs-memory-core', 'neo-mjs-knowledge-base', 'neo-mjs-neural-link', 'neo-mjs-github-workflow'])
    });

    test('judgeRecord passes only on positive evidence for every expected row', () => {
        const
            expected = ['neo-mjs-neural-link'],
            healthy  = {name: 'neo-mjs-neural-link', ok: true, healthcheck: {status: 'healthy', bridge: {connected: true, port: 4321}}},
            judge    = (rows, bridgePort = 4321) => judgeRecord({rows}, {expected, bridgePort});

        expect(judge([healthy])).toEqual({ok: true, reason: null});
        expect(judge([]).reason).toBe('neo-mjs-neural-link is missing from the harness config');
        expect(judge([{name: 'neo-mjs-neural-link', disabled: true}]).reason).toBe('neo-mjs-neural-link is switched off in the harness config');
        expect(judge([{name: 'neo-mjs-neural-link', ok: false, step: 'initialize', reason: 'exited'}]).reason).toBe('neo-mjs-neural-link failed at initialize: exited');
        expect(judge([{...healthy, healthcheck: null}]).reason).toContain("reported 'no status', not healthy");
        expect(judge([{...healthy, healthcheck: {status: 'unhealthy', bridge: {connected: true, port: 4321}}}]).reason).toBe("neural-link reported 'unhealthy', not healthy");
        expect(judge([{...healthy, healthcheck: {status: 'healthy'}}]).reason).toBe('neural-link reported no connected Bridge');
        expect(judge([healthy], 8081).reason).toBe("neural-link reached the Bridge on port 4321, not the run's 8081");
        expect(judge([healthy, {name: 'neo-mjs-memory-core', ok: true, healthcheck: {}}]).reason).toBe("neo-mjs-memory-core runs although the seat's matrix does not enable it");
        expect(judge([healthy, {name: 'neo-mjs-memory-core', disabled: true}, {name: 'mine', ok: false, step: 'initialize', reason: 'x'}]), "a switched-off Fleet row and the operator's own rows are not the journey's").toEqual({ok: true, reason: null})
    });

    test('a failing wire call becomes a named row, and the journey still stops every seat it defined', async () => {
        const
            stops = [],
            fleet = {
                defineAgent       : async () => ({}),
                setRepo           : async () => ({}),
                startAgent        : async () => {throw new Error('connection reset')},
                stopAgent         : async id => stops.push(id),
                fleetRuntimeStatus: async () => []
            },
            seat   = {definition: {id: 'wire-seat', harnessType: 'claude-desktop', mcpServers: {}}, repo: {repoSlug: 'x/y'}},
            result = await runSeatJourney({fleet, restartFleet: async () => fleet, seats: [seat], timeoutMs: 1_000});

        expect(result.ok).toBe(false);
        expect(result.rows.map(row => [row.step, row.ok, row.reason])).toEqual([
            ['define', true, null],
            ['start', false, 'the wire call failed: connection reset']
        ]);
        expect(stops).toEqual(['wire-seat'])
    });

    test('a recorded config that is gone becomes a named operator-content row, and the journey still resolves and stops', async () => {
        const
            home    = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-journey-gone-')),
            deadPid = spawnSync(process.execPath, ['-e', '']).pid,
            stops   = [];
        let phase = 'stopped';

        fs.writeFileSync(path.join(home, 'seat-stand-in.json'), JSON.stringify({version: 1, records: [
            {family: 'claude-desktop', pid: deadPid, configs: [{path: path.join(home, 'gone.json'), sha256: 'x'}], rows: []}
        ]}));

        const
            seat  = {definition: {id: 'gone-config-seat', harnessType: 'claude-desktop', mcpServers: {'memory-core': false, 'knowledge-base': false, 'neural-link': false, 'github-workflow': false}}, repo: {repoSlug: 'x/y'}},
            fleet = {
                defineAgent       : async () => ({}),
                setRepo           : async () => ({}),
                startAgent        : async () => {phase = 'running'; return {pid: deadPid, instanceHome: home}},
                stopAgent         : async id => {stops.push(id); phase = 'stopped'},
                fleetRuntimeStatus: async () => [{agentId: seat.definition.id, state: phase}]
            };

        try {
            const result = await runSeatJourney({fleet, restartFleet: async () => {throw new Error('no restart in this control')}, seats: [seat], timeoutMs: 2_000});
            const failed = result.rows.find(row => row.step === 'operator-content');

            expect(result.ok).toBe(false);
            expect(result.rows.slice(0, 3).map(row => [row.step, row.ok])).toEqual([['define', true], ['start', true], ['stop', true]]);
            expect(failed.ok).toBe(false);
            expect(failed.reason).toMatch(/^reading the harness config failed: ENOENT/);
            expect(stops.at(-1), 'the closing Stop ran after the failed step').toBe(seat.definition.id);
            expect(fs.existsSync(path.join(home, 'gone.json')), 'the gone config is not written anew').toBe(false);
            expect(() => seedOperatorContent(path.join(home, 'gone.toml'), 'marker'), 'nor is a gone TOML config').toThrow(/ENOENT/);
            expect(fs.existsSync(path.join(home, 'gone.toml'))).toBe(false)
        } finally {
            fs.rmSync(home, {recursive: true, force: true})
        }
    });

    test('writeStandInLauncher writes an executable that runs the stand-in on the given runtime', () => {
        const
            directory = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-journey-launcher-')),
            launcher  = writeStandInLauncher({directory}),
            version   = spawnSync(launcher, ['--version'], {encoding: 'utf8'});

        try {
            expect(fs.statSync(launcher).mode & 0o111).not.toBe(0);
            expect(version.stdout.trim()).toBe('seat-stand-in 1.0.0')
        } finally {
            fs.rmSync(directory, {recursive: true, force: true})
        }
    })
});

/**
 * @summary A free loopback port.
 * @returns {Promise<Number>}
 */
function allocatePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
            const {port} = server.address();
            server.close(() => resolve(port))
        })
    })
}

/**
 * @summary Starts a Brain entry as a child with exactly the given env, keeping its output for a failure message.
 * @param {String}   entry
 * @param {Object}   env
 * @returns {{child: ChildProcess, output: String[]}}
 */
function startEntry(entry, env) {
    const
        output = [],
        child  = spawn(process.execPath, [path.join(BRAIN_ROOT, entry)], {cwd: BRAIN_ROOT, env, stdio: ['ignore', 'pipe', 'pipe']});

    child.stdout.on('data', chunk => output.push(String(chunk)));
    child.stderr.on('data', chunk => output.push(String(chunk)));
    return {child, output}
}

/**
 * @summary Stops a child and waits for its exit.
 * @param {ChildProcess} child
 * @param {String}       signal
 * @returns {Promise<void>}
 */
function stopChild(child, signal = 'SIGTERM') {
    return child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise(resolve => {
            child.once('exit', () => resolve());
            child.kill(signal)
        })
}

/**
 * @summary Polls until the fleet server answers a wire read with its bearer.
 * @param {Object} options
 * @returns {Promise<Object>} A wire client.
 */
async function waitForFleet({port, bearerToken, process: fleet}) {
    const
        client   = createOnboardingFleetBridge({url: `http://127.0.0.1:${port}/fleet`, bearerToken}),
        deadline = Date.now() + 60_000;

    while (Date.now() < deadline) {
        if (fleet.child.exitCode !== null) break;

        try {
            await client.listAgents();
            return client
        } catch {
            await new Promise(resolve => setTimeout(resolve, 250))
        }
    }

    throw new Error(`the fleet server did not answer:\n${fleet.output.join('').slice(-4000)}`)
}

test.describe('ai/services/fleet/seatJourney — end to end against a fleet server', () => {
    test.setTimeout(300_000);

    let root, children = [];

    test.afterEach(async () => {
        await Promise.allSettled(children.map(child => stopChild(child, 'SIGKILL')));
        children = [];
        root && fs.rmSync(root, {recursive: true, force: true})
    });

    test('Claude Desktop and Codex Desktop seats start, stop, start again keeping operator content, recover stopped from an unclean restart, and start', async () => {
        // canonical: launch-profile custody refuses a managed root whose realpath differs (macOS tmp is a symlink)
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seat-journey-')));

        const
            [fleetPort, nlPort]     = await Promise.all([allocatePort(), allocatePort()]),
            bearerToken             = crypto.randomBytes(32).toString('base64url'),
            {privateKey, publicKey} = crypto.generateKeyPairSync('ed25519'),
            agentsRoot              = path.join(root, 'fleet', 'agents'),
            standIn                 = writeStandInLauncher({directory: path.join(root, 'bin')}),
            codex                   = writeCodexStandInBundle({directory: path.join(root, 'apps')}),
            base                    = {PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: os.tmpdir(), LANG: 'C.UTF-8'},
            profile                 = {
                ...base,
                UNIT_TEST_MODE        : '1',
                NEO_AI_DEPLOYMENT_MODE: 'local',
                NEO_PLANE_DATA_ROOT   : path.join(root, 'plane'),
                NEO_AI_DB_PATH        : path.join(root, 'sqlite', 'memory-core-graph.sqlite'),
                // test mode keeps the graph in memory per process; the seeder and every fleet boot share this file
                NEO_MEMORY_DB_PATH_TEST     : path.join(root, 'sqlite', 'memory-core-graph.sqlite'),
                NEO_AI_ORCHESTRATOR_DIR     : path.join(root, 'orchestrator'),
                NEO_BACKUP_PATH             : path.join(root, 'backups'),
                NEO_CHROMA_DATA_DIR_TEST    : path.join(root, 'chroma'),
                NEO_REM_RUN_STATE_DIR       : path.join(root, 'rem-runs'),
                NEO_FLEET_DATA_DIR          : path.join(root, 'fleet'),
                NEO_FLEET_AGENTS_ROOT       : agentsRoot,
                NEO_FLEET_PORT              : String(fleetPort),
                NEO_FLEET_BEARER            : bearerToken,
                NEO_FLEET_PLANE_BASE        : '',
                NEO_FLEET_PLANE_BEARER      : '',
                NEO_FLEET_SIGNING_KEY       : privateKey.export({type: 'pkcs8', format: 'pem'}),
                NEO_AGENT_IDENTITY          : VIEWER,
                NEO_NL_PORT                 : String(nlPort),
                NEO_FLEET_CLAUDE_DESKTOP_BIN: standIn,
                // pinned on every host: an installed ChatGPT app must not be what makes Codex Desktop start
                NEO_FLEET_CODEX_DESKTOP_BIN: codex.binary,
                NEO_FLEET_CODEX_BIN        : codex.cli,
                ...(process.env.NEO_CHROMA_PORT_TEST ? {NEO_CHROMA_PORT_TEST: process.env.NEO_CHROMA_PORT_TEST} : {})
            };

        // the fleet verifies its viewer against the host graph in in-process mode, so the viewer is seeded first
        const seeded = spawnSync(process.execPath, ['--input-type=module', '-e', [
            "import Neo from 'neo.mjs/src/Neo.mjs';",
            "import * as core from 'neo.mjs/src/core/_export.mjs';",
            "import InstanceManager from 'neo.mjs/src/manager/Instance.mjs';",
            "import {seedAgentIdentities} from './ai/scripts/setup/seedAgentIdentities.mjs';",
            `const seeded = await seedAgentIdentities({identities: [{id: ${JSON.stringify(VIEWER)}, name: 'Seat journey', type: 'AgentIdentity', description: 'The seat journey viewer', properties: {accountType: 'agent', displayName: 'Seat journey', githubLogin: ${JSON.stringify(VIEWER)}}}], log: () => {}});`,
            "process.stdout.write(JSON.stringify({seeded}), () => process.exit(0));"
        ].join('\n')], {cwd: BRAIN_ROOT, env: profile, encoding: 'utf8', timeout: 60_000});

        expect(seeded.status, seeded.stderr).toBe(0);

        const bridge = startEntry('ai/mcp/server/neural-link/run-bridge.mjs', {
            ...base,
            UNIT_TEST_MODE             : '1',
            NEO_NL_PORT                : String(nlPort),
            NEO_FLEET_BRIDGE_PUBLIC_KEY: publicKey.export({type: 'spki', format: 'pem'})
        });
        children.push(bridge.child);

        let fleetProcess = startEntry('ai/services/fleet/devFleetServer.mjs', profile);
        children.push(fleetProcess.child);

        const
            fleet = await waitForFleet({port: fleetPort, bearerToken, process: fleetProcess}),
            seats = ['claude-desktop', 'codex-desktop'].map(harnessType => {
                const id = `journey-${harnessType}`;

                return {
                    definition: {
                        id,
                        githubUsername: `neo-${id}`,
                        harnessType,
                        credential    : 'ghp_fixture_only',
                        gitName       : `Journey ${harnessType}`,
                        gitEmail      : `${id}@example.invalid`,
                        // MC/KB need a plane and github-workflow a provable PAT; Neural Link carries the launch-admission path
                        mcpServers    : {'memory-core': false, 'knowledge-base': false, 'github-workflow': false}
                    },
                    repo: {repoSlug: 'journey/seat', cloneUrl: 'https://example.invalid/journey/seat.git'}
                }
            });

        seats.forEach(seat => seedSeatCheckout({managedRoot: agentsRoot, agentId: seat.definition.id, repoSlug: seat.repo.repoSlug}));

        const result = await runSeatJourney({
            fleet,
            seats,
            bridgePort  : nlPort,
            log         : line => console.log(`[seat-journey] ${line}`),
            restartFleet: async ({beforeBoot}) => {
                await stopChild(fleetProcess.child, 'SIGKILL');
                await beforeBoot();
                fleetProcess = startEntry('ai/services/fleet/devFleetServer.mjs', profile);
                children.push(fleetProcess.child);
                return waitForFleet({port: fleetPort, bearerToken, process: fleetProcess})
            }
        });

        expect(result.ok, `${JSON.stringify(result.rows, null, 2)}\n--- fleet output ---\n${fleetProcess.output.join('').slice(-4000)}`).toBe(true);
        seats.forEach(seat => expect(result.rows.filter(row => row.seat === seat.definition.id).map(row => row.step))
            .toEqual(['define', 'start', 'stop', 'start-again', 'operator-content', 'recover', 'start-after-recovery']));

        // the journey's closing Stop leaves no seat process behind
        const seatPids = result.rows.map(row => row.detail?.pid).filter(Boolean);
        expect(seatPids).toHaveLength(6);
        await expect.poll(() => seatPids.filter(pid => {
            try {
                process.kill(pid, 0);
                return true
            } catch {
                return false
            }
        }), {timeout: 30_000}).toEqual([])
    })
});

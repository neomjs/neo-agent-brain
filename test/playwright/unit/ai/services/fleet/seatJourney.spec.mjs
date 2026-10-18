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

    test('judgeRecord fails a row that did not answer, a Neural Link without a connected Bridge, and one on another port', () => {
        const answered = {name: 'neo-mjs-neural-link', ok: true, healthcheck: {status: 'healthy', bridge: {connected: true, port: 4321}}};

        expect(judgeRecord({rows: [answered]}, 4321)).toEqual({ok: true, reason: null});
        expect(judgeRecord({rows: [answered, {name: 'neo-mjs-github-workflow', ok: false, step: 'initialize', reason: 'exited'}]}).reason)
            .toBe('neo-mjs-github-workflow failed at initialize: exited');
        expect(judgeRecord({rows: [{...answered, healthcheck: {bridge: {connected: false, port: 4321}}}]}, 4321).ok).toBe(false);
        expect(judgeRecord({rows: [answered]}, 8081).reason).toBe("neural-link reached the Bridge on port 4321, not the run's 8081")
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
                NEO_FLEET_CODEX_DESKTOP_BIN : writeCodexStandInBundle({directory: path.join(root, 'apps')}),
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
            .toEqual(['define', 'start', 'stop', 'start-again', 'operator-content', 'recover', 'start-after-recovery']))
    })
});

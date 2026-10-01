import {setup} from '../../setup.mjs';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : 'FleetLifecycleServiceTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}                  from '@playwright/test';
import {execFile, execFileSync, spawn} from 'child_process';
import {EventEmitter}                  from 'events';
import fs                              from 'fs';
import os                              from 'os';
import path                            from 'path';

import Neo                          from 'neo.mjs/src/Neo.mjs';
import * as core                    from 'neo.mjs/src/core/_export.mjs';
import AiConfig                     from '../../../../ai/config.template.mjs';
import FleetLifecycleService        from '../../../../ai/services/fleet/FleetLifecycleService.mjs';
import FleetManager                 from '../../../../ai/services/fleet/FleetManager.mjs';
import ToolService                  from '../../../../ai/mcp/ToolService.mjs';
import {generateOpenCodeSeatConfig} from '../../../../ai/services/fleet/generateOpenCodeSeatConfig.mjs';

let nextPid = 1000;

/**
 * A stub child process: an EventEmitter that dies (emits `exit`) on the first `kill()`, recording
 * the signals it received. No real process is ever launched.
 */
class FakeChild extends EventEmitter {
    constructor() {
        super();
        this.pid     = ++nextPid;
        this.signals = [];
        this.stderr  = new EventEmitter();
        this.stdout  = new EventEmitter();
    }

    kill(signal) {
        this.signals.push(signal);
        queueMicrotask(() => this.emit('exit', 0, signal));
        return true;
    }

    unref() {
        this.unrefed = true
    }
}

/** A recording spawn stub (the supervisor test seam). */
function makeSpawnStub() {
    const calls = [];
    const fn    = (command, args, opts) => {
        const child = new FakeChild();
        calls.push({command, args, opts, child});
        return child;
    };
    fn.calls = calls;
    return fn;
}

/** Every agent holds a GitHub PAT; a known agent resolves this one unless `creds` names another. */
const FIXTURE_PAT = 'ghp_fixture_only';

/** App-bundle seats lease their pid in the harness home, so their agents root must be writable. */
const DESKTOP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-desktop-instances-'));

/** A minimal registry stub so lifecycle specs never touch the real on-disk credential store. */
function makeRegistry(agents, creds) {
    return {
        getAgent         : id => agents[id] || null,
        // The spawn path reads the RAW definition (launch visible) — the public getAgent
        // projection redacts metadata.launch, so the service consumes this surface instead.
        getDefinition    : id => agents[id] || null,
        // `creds: {id: null}` models an agent stored without a PAT.
        resolveCredential: id => (Object.hasOwn(creds, id) ? creds[id] : (agents[id] ? FIXTURE_PAT : null)),
        // Stub the Bridge-token mint with a deterministic per-id token, so spawn-injection specs can
        // assert env carriage without touching the real registry's crypto store.
        mintBridgeToken  : id => ({token: `bridge_${id}_token`, expiresAt: Date.now() + 3_600_000})
    };
}

// A REAL path-shaped binary: the spawn stays stubbed, but the executable preflight stats the
// command for path-shaped AND bare forms, so the fixture must exist on disk.
const LAUNCH = {command: process.execPath, args: ['--serve']};

function agentDef(id, extra = {}) {
    return {id, githubUsername: id, harnessType: 'codex', metadata: {launch: LAUNCH}, ...extra};
}

/** Exact non-secret renderer input returned by prepareManagedAgentWorkspace for a tenant Codex seat. */
function tenantMcpPlan(resources, matrix) {
    return Object.entries(matrix).map(([key, enabled]) => {
        const remote = ['memory-core', 'knowledge-base'].includes(key);

        return {
            key,
            name              : `neo-mjs-${key}`,
            enabled,
            target            : remote ? 'tenant' : 'resident',
            transport         : remote ? 'streamable-http' : 'stdio',
            url               : remote ? resources[key].url : null,
            credentialEnvVar  : remote ? 'NEO_MCP_REMOTE_TOKEN' : null,
            command           : process.execPath,
            sourceRoot        : '/installed/neo',
            args              : [`/installed/neo/ai/mcp/server/${key}/mcp-server.mjs`],
            runtimeEnv        : ['NEO_AGENT_IDENTITY'],
            requiredRuntimeEnv: ['NEO_AGENT_IDENTITY'],
            secretEnv         : [],
            unsupportedReason : null
        }
    })
}

/** Reset the singleton + inject fresh test doubles. Returns the spawn stub. */
function install({agents = {}, creds = {}} = {}) {
    const spawnStub = makeSpawnStub();
    for (const record of FleetLifecycleService.processes.values()) {
        clearTimeout(record.openCodeBootstrapTimer);
    }
    FleetLifecycleService.processes.clear();
    FleetLifecycleService.spawnFn         = spawnStub;
    // Stub the version probe by default so no spec spawns a real auxiliary subprocess; the
    // env-boundary test injects its own recorder.
    FleetLifecycleService.execFileFn      = () => {};
    FleetLifecycleService.claudeDesktopBridgeCapabilityProbeFn = null;
    FleetLifecycleService.fetchFn         = null;
    FleetLifecycleService.openCodeHookExecFileFn = null;
    FleetLifecycleService.openCodeBootstrapTimeoutMs = 10000;
    FleetLifecycleService.registry        = makeRegistry(agents, creds);
    FleetLifecycleService.sigkillTimeoutMs = 50;
    // Reset the configurable env-key fields to their defaults so a collision test cannot bleed into
    // the next serial sibling (singleton-stateful service).
    FleetLifecycleService.credentialEnvVar          = 'GH_TOKEN';
    FleetLifecycleService.bridgeTokenEnvVar         = 'NEO_FLEET_BRIDGE_TOKEN';
    // Reset the curated-launch resolution fields too — fallback tests set them explicitly.
    FleetLifecycleService.instanceRoot       = null;
    FleetLifecycleService.harnessBinaryPaths = null;
    FleetLifecycleService.codexDesktopCapabilityProbeFn = null;
    FleetLifecycleService.codexDesktopCleanupFn         = null;
    // Seat-lease seams: no spec reads or signals a host process unless it opts in. Every stub child
    // reads as born at one fixed time, so an app-bundle start can lease it.
    FleetLifecycleService.processInspectFn  = () => ({startedAt: 'Thu Oct  1 08:00:00 2026', command: ''});
    FleetLifecycleService.processSignalFn   = () => { throw Object.assign(new Error('no such process'), {code: 'ESRCH'}) };
    FleetLifecycleService.adoptedExitPollMs = 5;
    FleetLifecycleService.leasesAdopted     = false;
    return spawnStub;
}

// Singleton-stateful service → run serially in one worker so per-test install() resets are not
// raced by Playwright's parallel worker reuse.
test.describe.configure({mode: 'serial'});

test.describe('Neo.ai.services.fleet.FleetLifecycleService', () => {
    test('start spawns the launch command and reports running', () => {
        const spawn  = install({agents: {a: agentDef('a')}, creds: {a: 'ghp_x'}}),
              status = FleetLifecycleService.start('a');

        expect(spawn.calls).toHaveLength(1);
        expect(spawn.calls[0].command).toBe(process.execPath);
        expect(spawn.calls[0].args).toEqual(['--serve']);
        expect(status.running).toBe(true);
        expect(status.state).toBe('running');
        expect(status.pid).toBeGreaterThan(0);
    });

    test('start passes opts.cwd through to the spawn options (the harness runs in its provisioned repo)', () => {
        const spawn = install({agents: {a: agentDef('a')}});
        FleetLifecycleService.start('a', {cwd: '/managed/a/neomjs-neo'});

        expect(spawn.calls[0].opts.cwd).toBe('/managed/a/neomjs-neo');
    });

    test('start without opts.cwd spawns with no cwd (inherited — unchanged legacy behavior)', () => {
        const spawn = install({agents: {a: agentDef('a')}});
        FleetLifecycleService.start('a');

        expect(spawn.calls[0].opts.cwd).toBeUndefined();
    });

    test('SECURITY: PAT injected into the child env copy only — never argv / record / live parent env', () => {
        const pat    = 'ghp_SECRET_injected_value',
              spawn  = install({agents: {a: agentDef('a')}, creds: {a: pat}}),
              status = FleetLifecycleService.start('a'),
              call   = spawn.calls[0];

        // injected under the configured var, on a COPY of process.env (not the live object)
        expect(call.opts.env.GH_TOKEN).toBe(pat);
        expect(call.opts.env.NEO_MCP_REMOTE_TOKEN).toBeUndefined();
        expect(call.opts.env).not.toBe(process.env);
        // never in argv or the command
        expect(JSON.stringify(call.args)).not.toContain(pat);
        expect(call.command).not.toContain(pat);
        // never in the status snapshot
        expect(JSON.stringify(status)).not.toContain(pat);
        // the live parent env was not mutated to carry the secret
        expect(process.env.GH_TOKEN).not.toBe(pat);
    });

    test('start provisions Bridge authentication without imposing an NL projection', () => {
        const pat   = 'ghp_dual_class';
        const spawn = install({agents: {a: agentDef('a')}, creds: {a: pat}});
        FleetLifecycleService.start('a');
        const env = spawn.calls[0].opts.env;

        // Bridge token under its OWN var — a credential class distinct from the PAT
        expect(env.NEO_FLEET_BRIDGE_TOKEN).toBe('bridge_a_token');
        expect(env.NEO_FLEET_BRIDGE_TOKEN).not.toBe(env.GH_TOKEN);
        expect(env.NEO_FLEET_BRIDGE_TOKEN).not.toBe(env.NEO_MCP_REMOTE_TOKEN);
        expect(env.NEO_NL_TOOL_PROJECTION_MODE).toBeUndefined();
        // the PAT injection is unaffected
        expect(env.GH_TOKEN).toBe(pat);
        // injected on a COPY of process.env; parent env never mutated to carry the bridge token
        expect(env).not.toBe(process.env);
        expect(process.env.NEO_FLEET_BRIDGE_TOKEN).not.toBe('bridge_a_token');
    });

    test('SECURITY: the injected Bridge token never enters the process record / status', () => {
        const spawn  = install({agents: {a: agentDef('a')}}),
              status = FleetLifecycleService.start('a'),
              token  = spawn.calls[0].opts.env.NEO_FLEET_BRIDGE_TOKEN;

        expect(token).toBe('bridge_a_token');                                       // it WAS injected
        expect(JSON.stringify(status)).not.toContain(token);                        // never via status
        expect(JSON.stringify(FleetLifecycleService.status('a'))).not.toContain(token);
    });

    test('an FM-launched agent can list and call an NL mutation while explicit restrictions still apply', async () => {
        const spawn = install({agents: {a: agentDef('a')}});
        FleetLifecycleService.start('a');

        const target = {text: 'before'},
              tools  = Neo.create(ToolService, {
                  openApiFilePath: path.resolve(import.meta.dirname, '../../../../ai/mcp/server/neural-link/openapi.yaml'),
                  serviceMapping : {
                      set_instance_properties: async ({properties}) => Object.assign(target, properties)
                  }
              }),
              options = {toolProjection: spawn.calls[0].opts.env.NEO_NL_TOOL_PROJECTION_MODE};

        try {
            expect(tools.listTools(options).tools.some(tool => tool.name === 'set_instance_properties')).toBe(true);
            await tools.callTool('set_instance_properties', {id: 'fixture', properties: {text: 'after'}}, options);
            expect(target.text).toBe('after');

            for (const mode of ['harness-embedded', 'local-readonly-probe', 'unknown-profile']) {
                const restricted = {toolProjection: mode};
                expect(tools.listTools(restricted).tools.some(tool => tool.name === 'set_instance_properties')).toBe(false);
                await expect(tools.callTool('set_instance_properties', {
                    id: 'fixture', properties: {text: 'forbidden'}
                }, restricted)).rejects.toThrow(/not visible/);
                expect(target.text).toBe('after');
            }
        } finally {
            tools.destroy();
        }
    });

    test('SECURITY: start fails fast when bridgeTokenEnvVar collides with credentialEnvVar (Bridge token would land in the PAT slot)', () => {
        const spawn = install({agents: {a: agentDef('a')}, creds: {a: 'ghp_x'}});
        FleetLifecycleService.bridgeTokenEnvVar = 'GH_TOKEN'; // === credentialEnvVar ⇒ credential classes collapse
        expect(() => FleetLifecycleService.start('a')).toThrow(/env-key contract/);
        expect(spawn.calls).toHaveLength(0); // guard is fail-fast: never spawned, no secret injected
    });

    test('SECURITY: start fails fast when a key collides with the reserved NL-policy var, or is empty', () => {
        install({agents: {a: agentDef('a')}, creds: {a: 'ghp_x'}});
        FleetLifecycleService.bridgeTokenEnvVar = 'NEO_NL_TOOL_PROJECTION_MODE'; // reserved NL policy slot
        expect(() => FleetLifecycleService.start('a')).toThrow(/env-key contract/);

        const spawn = install({agents: {a: agentDef('a')}, creds: {a: 'ghp_x'}}); // fresh install resets the keys
        FleetLifecycleService.credentialEnvVar = 'NEO_MCP_REMOTE_TOKEN'; // repository PAT cannot collapse onto the fixed remote plane slot
        expect(() => FleetLifecycleService.start('a')).toThrow(/env-key contract/);
        expect(spawn.calls).toHaveLength(0); // never spawned

        install({agents: {a: agentDef('a')}, creds: {a: 'ghp_x'}});
        FleetLifecycleService.credentialEnvVar = ''; // empty key ⇒ contract violation
        expect(() => FleetLifecycleService.start('a')).toThrow(/env-key contract/)
    });

    test('an agent without a GitHub PAT is refused before the spawn — it never runs on the parent\'s ambient token', () => {
        // untokened, the seat's `gh` would fall back to the machine's keyring account: refused, not
        // spawned with an empty slot. A blank value stored before the requirement is no PAT either.
        for (const stored of [null, '', '   ']) {
            const spawn = install({agents: {a: agentDef('a')}, creds: {a: stored}});

            expect(() => FleetLifecycleService.start('a')).toThrow(/agent 'a' has no GitHub PAT stored/);
            expect(spawn.calls).toHaveLength(0);
            expect(FleetLifecycleService.isRunning('a')).toBe(false)
        }
    });

    test('start refuses an unknown agent', () => {
        install({agents: {}, creds: {}});
        expect(() => FleetLifecycleService.start('ghost')).toThrow(/unknown agent/);
    });

    test('start refuses an agent with no launch override and no built-in launch template (untemplated harnessType)', () => {
        install({agents: {a: {id: 'a', githubUsername: 'a', harnessType: 'gemini-cli', metadata: {}}}, creds: {}});
        expect(() => FleetLifecycleService.start('a')).toThrow(/no launch template/);
    });

    test('start refuses an agent whose explicit metadata.launch carries no command', () => {
        install({agents: {a: {id: 'a', githubUsername: 'a', harnessType: 'codex', metadata: {launch: {args: ['--serve']}}}}, creds: {}});
        expect(() => FleetLifecycleService.start('a')).toThrow(/no launch spec/);
    });

    test('start is idempotent while running (no double spawn)', () => {
        const spawn = install({agents: {a: agentDef('a')}, creds: {a: 'ghp_x'}});
        FleetLifecycleService.start('a');
        FleetLifecycleService.start('a');
        expect(spawn.calls).toHaveLength(1);
    });

    test('raw compatibility launches expose neither launchCommand nor authCommand through status', () => {
        install({agents: {a: agentDef('a')}, creds: {}});

        const status = FleetLifecycleService.start('a');

        expect(status.launchCommand).toBeNull();
        expect(status.authCommand).toBeNull();
        expect(status.authHome).toBeNull();
    });

    test('stop sends SIGTERM and transitions to stopped', async () => {
        const spawn = install({agents: {a: agentDef('a')}, creds: {a: 'ghp_x'}});
        FleetLifecycleService.start('a');

        const res = await FleetLifecycleService.stop('a');
        expect(res.success).toBe(true);
        expect(spawn.calls[0].child.signals).toContain('SIGTERM');
        expect(FleetLifecycleService.isRunning('a')).toBe(false);
        expect(FleetLifecycleService.status('a').state).toBe('stopped');
    });

    test('stop of a non-running agent is a no-op (success:false)', async () => {
        install({agents: {a: agentDef('a')}, creds: {}});
        const res = await FleetLifecycleService.stop('a');
        expect(res.success).toBe(false);
    });

    test('restart stops the old process and starts a fresh one', async () => {
        const spawn = install({agents: {a: agentDef('a')}, creds: {a: 'ghp_x'}}),
              first = FleetLifecycleService.start('a'),
              after = await FleetLifecycleService.restart('a');

        expect(spawn.calls).toHaveLength(2);
        expect(after.running).toBe(true);
        expect(after.pid).not.toBe(first.pid);
    });

    test('restart re-spawns at the cwd the agent was started with (provisioned restart preserves the checkout)', async () => {
        const spawn = install({agents: {a: agentDef('a')}, creds: {a: 'ghp_x'}});
        FleetLifecycleService.start('a', {cwd: '/managed/a/neomjs-neo'});
        await FleetLifecycleService.restart('a');

        expect(spawn.calls).toHaveLength(2);
        // The re-spawn re-uses the recorded cwd → it lands in the agent's checkout, not the FM dir
        // (otherwise the checkout-path-keyed auto-memory would silently fork).
        expect(spawn.calls[1].opts.cwd).toBe('/managed/a/neomjs-neo');
    });

    test('restart of a cwd-less agent re-spawns with no cwd (unchanged legacy behavior)', async () => {
        const spawn = install({agents: {a: agentDef('a')}, creds: {a: 'ghp_x'}});
        FleetLifecycleService.start('a');
        await FleetLifecycleService.restart('a');

        expect(spawn.calls[1].opts.cwd).toBeUndefined();
    });

    test('listRunning reflects the running set', () => {
        install({agents: {a: agentDef('a'), b: agentDef('b')}, creds: {a: 'x', b: 'y'}});
        FleetLifecycleService.start('a');
        FleetLifecycleService.start('b');

        expect(FleetLifecycleService.listRunning().map(s => s.id).sort()).toEqual(['a', 'b']);
    });

    test('status of a never-started agent is stopped', () => {
        install({agents: {a: agentDef('a')}, creds: {}});
        expect(FleetLifecycleService.status('a')).toMatchObject({state: 'stopped', running: false});
    });

    test('drains stderr (no backpressure) but never surfaces its content through status — counts bytes only', () => {
        install({agents: {a: agentDef('a')}, creds: {a: 'ghp_x'}});
        FleetLifecycleService.start('a');
        const child = FleetLifecycleService.processes.get('a').child;

        // a misbehaving harness echoes its injected token to stderr — status must NOT surface it
        child.stderr.emit('data', Buffer.from('[ERROR] auth failed with token ghp_LEAKED_via_stderr\n'));

        const status = FleetLifecycleService.status('a');
        expect(JSON.stringify(status)).not.toContain('ghp_LEAKED_via_stderr');  // content never surfaced
        expect(status.recentStderr).toBeUndefined();                            // no raw-content field at all
        expect(status.stderrBytes).toBeGreaterThan(0);                          // but it WAS drained (counted)
    });
});

// The positive lifecycle matrix: curated launch derivation, the minimal-env credential boundary,
// reserved/prototype env-key rejection, identity injection, the stdio liveness topology, and the
// live per-home authRequired surface. The final case is a REAL-process falsifier: it spawns an
// actual `node` child through the service's exact spawn path and proves the held-open-stdin
// topology keeps it alive — pure launch-shape tests cannot establish process liveness (the exact
// gap the cycle-1 review demonstrated on the real harness binaries).
test.describe('Neo.ai.services.fleet.FleetLifecycleService — curated launch + security matrix', () => {
    const curatedAgent = (id, harnessType = 'codex') => ({id, githubUsername: id, harnessType, metadata: {}});

    test('without an injected root, harness homes derive under the AiConfig agents root', () => {
        install();

        expect(FleetLifecycleService.instanceRoot).toBeNull();
        expect(FleetLifecycleService.getInstanceRoot()).toBe(AiConfig.fleet.agentsRoot);
        expect(path.isAbsolute(FleetLifecycleService.getInstanceRoot())).toBe(true)
    });

    test('curated codex derivation: template args + isolated CODEX_HOME under instanceRoot, keyed by agent id', () => {
        const spawn = install({agents: {peer2: curatedAgent('peer2')}, creds: {}});
        FleetLifecycleService.instanceRoot       = '/srv/fleet/instances';
        // a REAL path-shaped binary so the existence preflight passes (spawn itself is stubbed)
        FleetLifecycleService.harnessBinaryPaths = {codex: process.execPath};

        FleetLifecycleService.start('peer2');

        const {command, args, opts} = spawn.calls[0];
        expect(command).toBe(process.execPath);
        expect(args).toEqual(['app-server']);                                   // the long-lived mode is template-owned
        expect(opts.env.CODEX_HOME.startsWith('/srv/fleet/instances/')).toBe(true);
        expect(opts.env.CODEX_HOME).toContain('peer2');                         // agent.id keys the home, never githubUsername-only grain
    });

    test('Fleet-managed OpenCode boot creates one top-level owner session before publishing the generated wake envelope', async () => {
        const
            root       = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-opencode-owner-')),
            cwd        = path.join(root, 'repo'),
            agent      = curatedAgent('open-owner', 'opencode'),
            spawn      = install({agents: {'open-owner': agent}, creds: {}}),
            fetchCalls = [],
            hookCalls  = [];

        fs.mkdirSync(cwd);
        FleetLifecycleService.instanceRoot       = path.join(root, 'instances');
        FleetLifecycleService.harnessBinaryPaths = {opencode: process.execPath};

        const launch       = FleetLifecycleService.resolveLaunch(agent, {cwd});
        const hookPath     = path.join(launch.instanceHome, 'write-wake-envelope.mjs');
        const envelopePath = path.join(launch.instanceHome, 'opencode', 'wake-envelope.json');

        fs.mkdirSync(launch.instanceHome, {recursive: true});
        fs.writeFileSync(hookPath, '// generated test hook\n');

        FleetLifecycleService.fetchFn = async (url, opts) => {
            fetchCalls.push({url, opts});
            return {
                ok    : true,
                status: 200,
                json  : async () => ({
                    id       : 'ses_owner',
                    projectID: 'project_owner',
                    directory: fs.realpathSync(cwd)
                })
            };
        };
        FleetLifecycleService.openCodeHookExecFileFn = (command, args, opts, callback) => {
            hookCalls.push({command, args, opts});
            fs.mkdirSync(path.dirname(envelopePath), {recursive: true});
            fs.writeFileSync(envelopePath, JSON.stringify({
                agentIdentity: `@${opts.env.NEO_AGENT_IDENTITY}`,
                hostname     : '127.0.0.1',
                port         : 45678,
                sessionId    : 'ses_owner',
                projectId    : 'project_owner',
                directory    : fs.realpathSync(cwd),
                username     : opts.env.OPENCODE_SERVER_USERNAME,
                password     : opts.env.OPENCODE_SERVER_PASSWORD,
                updatedAt    : new Date().toISOString()
            }));
            fs.chmodSync(envelopePath, 0o600);
            callback(null, '', '');
        };

        const starting = FleetLifecycleService.start('open-owner', {cwd});
        const call     = spawn.calls[0];
        const password = call.opts.env.OPENCODE_SERVER_PASSWORD;

        expect(starting.wakeRoute).toMatchObject({state: 'starting', directory: fs.realpathSync(cwd), envelopePath});
        expect(call.opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
        expect(call.opts.env.OPENCODE_SERVER_USERNAME).toBe('opencode');
        expect(password).toMatch(/^[A-Za-z0-9_-]{40,}$/);
        expect(JSON.stringify(starting)).not.toContain(password);

        // Chunk boundary is deliberate: only a complete newline-terminated authoritative banner
        // may start the bootstrap.
        call.child.stdout.emit('data', Buffer.from('opencode server listening on http://127.0.0.'));
        expect(fetchCalls).toHaveLength(0);
        call.child.stdout.emit('data', Buffer.from('1:45678\n'));

        await expect.poll(() => FleetLifecycleService.status('open-owner').wakeRoute?.state).toBe('ready');

        expect(fetchCalls).toHaveLength(1);
        const createUrl = new URL(fetchCalls[0].url);
        expect(createUrl.pathname).toBe('/api/session');
        expect(createUrl.searchParams.get('directory')).toBe(fs.realpathSync(cwd));
        expect(fetchCalls[0].opts).toMatchObject({method: 'POST', body: '{}', redirect: 'error'});
        expect(fetchCalls[0].opts.headers.authorization)
            .toBe('Basic ' + Buffer.from(`opencode:${password}`).toString('base64'));

        expect(hookCalls).toHaveLength(1);
        expect(hookCalls[0].command).toBe(process.execPath);
        expect(hookCalls[0].args).toEqual([
            hookPath,
            '--data-home', launch.instanceHome,
            '--port', '45678',
            '--session-id', 'ses_owner',
            '--project-id', 'project_owner',
            '--directory', fs.realpathSync(cwd)
        ]);
        expect(JSON.stringify(hookCalls[0].args)).not.toContain(password);
        expect(hookCalls[0].opts.env.NEO_FLEET_BRIDGE_TOKEN).toBeUndefined();
        expect(hookCalls[0].opts.env.NEO_MCP_REMOTE_TOKEN).toBeUndefined();
        expect(hookCalls[0].opts.env.GH_TOKEN).toBeUndefined();
        // Beyond the verbatim ambient allowlist, the hook receives exactly the identity it stamps and
        // its own server credential pair.
        expect(Object.keys(hookCalls[0].opts.env).filter(key => hookCalls[0].opts.env[key] !== process.env[key]).sort())
            .toEqual(['NEO_AGENT_IDENTITY', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME']);
        expect(hookCalls[0].opts.env.NEO_AGENT_IDENTITY).toBe('open-owner');

        const ready = FleetLifecycleService.status('open-owner');
        expect(ready.wakeRoute).toMatchObject({
            state: 'ready', port: 45678, sessionId: 'ses_owner', projectId: 'project_owner'
        });
        expect(JSON.stringify(ready)).not.toContain(password);
        expect(fs.statSync(envelopePath).mode & 0o777).toBe(0o600);

        call.child.emit('exit', 0, 'SIGTERM');
        await expect.poll(() => FleetLifecycleService.status('open-owner').state).toBe('stopped');
        expect(FleetLifecycleService.status('open-owner').wakeRoute).toMatchObject({
            state: 'degraded', port: null, sessionId: null, projectId: null
        });
        expect(fs.existsSync(envelopePath)).toBe(false);

        FleetLifecycleService.processes.clear();
        fs.rmSync(root, {recursive: true, force: true});
    });

    test('Fleet-managed OpenCode runs the REAL generated wake hook with the env it builds, and the envelope carries the seat identity', async () => {
        // The arm above fakes the hook, so it cannot see what the generated script refuses: the
        // real hook throws without NEO_AGENT_IDENTITY. Only the real script, run by the real
        // execFile with the env the service builds, proves the route can reach `ready`.
        const
            root  = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-opencode-real-hook-')),
            cwd   = path.join(root, 'repo'),
            agent = curatedAgent('open-real', 'opencode'),
            spawn = install({agents: {'open-real': agent}, creds: {}}),
            envs  = [];

        fs.mkdirSync(cwd);
        FleetLifecycleService.instanceRoot       = path.join(root, 'instances');
        FleetLifecycleService.harnessBinaryPaths = {opencode: process.execPath};

        const
            launch       = FleetLifecycleService.resolveLaunch(agent, {cwd}),
            hookPath     = path.join(launch.instanceHome, 'write-wake-envelope.mjs'),
            envelopePath = path.join(launch.instanceHome, 'opencode', 'wake-envelope.json'),
            {files}      = generateOpenCodeSeatConfig({
                agentosRuntimeRoot: root,
                targetRepoRoot    : cwd,
                seatEnvFile       : path.join(cwd, '.env'),
                memoryDir         : path.join(launch.instanceHome, 'memory'),
                nodeBinary        : process.execPath,
                wakeHookPath      : hookPath
            });

        fs.mkdirSync(launch.instanceHome, {recursive: true});
        fs.writeFileSync(hookPath, files.find(file => file.path === hookPath).content);

        FleetLifecycleService.fetchFn = async () => ({
            ok  : true,
            json: async () => ({id: 'ses_real', projectID: 'project_real', directory: fs.realpathSync(cwd)})
        });
        // Records the env, then runs the real hook through the real execFile.
        FleetLifecycleService.openCodeHookExecFileFn = (command, args, opts, callback) => {
            envs.push(opts.env);
            return execFile(command, args, opts, callback);
        };

        FleetLifecycleService.start('open-real', {cwd});
        spawn.calls[0].child.stdout.emit('data', Buffer.from('opencode server listening on http://127.0.0.1:45679\n'));

        await expect.poll(() => FleetLifecycleService.status('open-real').wakeRoute?.state, {timeout: 10000}).not.toBe('starting');
        expect(FleetLifecycleService.status('open-real').wakeRoute).toMatchObject({state: 'ready', reason: null, sessionId: 'ses_real'});
        expect(envs).toHaveLength(1);
        expect(JSON.parse(fs.readFileSync(envelopePath, 'utf8')).agentIdentity).toBe('@open-real');

        spawn.calls[0].child.emit('exit', 0, 'SIGTERM');
        await expect.poll(() => FleetLifecycleService.status('open-real').state).toBe('stopped');

        FleetLifecycleService.processes.clear();
        fs.rmSync(root, {recursive: true, force: true});
    });

    test('Fleet-managed OpenCode rejects sibling-workspace, child, or malformed creation tuples and never invokes the hook', async () => {
        const cases = [
            {
                id            : 'open-sibling',
                response      : {id: 'ses_sibling', projectID: 'project_sibling'},
                wrongDirectory: true
            },
            {
                id      : 'open-child',
                response: {id: 'ses_child', projectID: 'project_child', parentID: 'ses_parent'}
            },
            {
                id      : 'open-missing',
                response: {id: '', projectID: 'project_missing'}
            }
        ];

        for (const entry of cases) {
            const
                root  = fs.mkdtempSync(path.join(os.tmpdir(), `fleet-${entry.id}-`)),
                cwd   = path.join(root, 'repo'),
                agent = curatedAgent(entry.id, 'opencode'),
                spawn = install({agents: {[entry.id]: agent}, creds: {}});

            fs.mkdirSync(cwd);
            FleetLifecycleService.instanceRoot       = path.join(root, 'instances');
            FleetLifecycleService.harnessBinaryPaths = {opencode: process.execPath};

            const launch       = FleetLifecycleService.resolveLaunch(agent, {cwd});
            const hookPath     = path.join(launch.instanceHome, 'write-wake-envelope.mjs');
            const envelopePath = path.join(launch.instanceHome, 'opencode', 'wake-envelope.json');
            let   hookCalls    = 0;

            fs.mkdirSync(launch.instanceHome, {recursive: true});
            fs.writeFileSync(hookPath, '// generated test hook\n');
            FleetLifecycleService.fetchFn = async () => ({
                ok  : true,
                json: async () => ({
                    ...entry.response,
                    directory: entry.wrongDirectory ? path.join(root, 'sibling-repo') : fs.realpathSync(cwd)
                })
            });
            FleetLifecycleService.openCodeHookExecFileFn = () => { hookCalls++ };

            FleetLifecycleService.start(entry.id, {cwd});
            spawn.calls[0].child.stdout.emit('data', Buffer.from('opencode server listening on http://127.0.0.1:45679\n'));

            await expect.poll(() => FleetLifecycleService.status(entry.id).wakeRoute?.state).toBe('degraded');
            expect(hookCalls).toBe(0);
            expect(fs.existsSync(envelopePath)).toBe(false);

            FleetLifecycleService.processes.clear();
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    test('Fleet-managed OpenCode removes stale coordinates and degrades fail-closed when owner-session creation fails', async () => {
        const
            root  = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-opencode-create-fail-')),
            cwd   = path.join(root, 'repo'),
            agent = curatedAgent('open-fail', 'opencode'),
            spawn = install({agents: {'open-fail': agent}, creds: {}});

        fs.mkdirSync(cwd);
        FleetLifecycleService.instanceRoot       = path.join(root, 'instances');
        FleetLifecycleService.harnessBinaryPaths = {opencode: process.execPath};

        const launch       = FleetLifecycleService.resolveLaunch(agent, {cwd});
        const hookPath     = path.join(launch.instanceHome, 'write-wake-envelope.mjs');
        const envelopePath = path.join(launch.instanceHome, 'opencode', 'wake-envelope.json');
        let   hookCalls    = 0;

        fs.mkdirSync(path.dirname(envelopePath), {recursive: true});
        fs.writeFileSync(hookPath, '// generated test hook\n');
        fs.writeFileSync(envelopePath, '{"port":1234}\n');
        FleetLifecycleService.fetchFn = async () => { throw new Error('fetch leaked-secret-value') };
        FleetLifecycleService.openCodeHookExecFileFn = () => { hookCalls++ };

        FleetLifecycleService.start('open-fail', {cwd});
        expect(fs.existsSync(envelopePath)).toBe(false);

        spawn.calls[0].child.stdout.emit('data', Buffer.from('opencode server listening on http://127.0.0.1:45680\n'));

        await expect.poll(() => FleetLifecycleService.status('open-fail').wakeRoute?.state).toBe('degraded');
        const status = FleetLifecycleService.status('open-fail');

        expect(hookCalls).toBe(0);
        expect(fs.existsSync(envelopePath)).toBe(false);
        expect(status.running).toBe(true);
        expect(status.failureReason).toBe('OpenCode wake bootstrap failed during session creation');
        expect(JSON.stringify(status)).not.toContain('leaked-secret-value');

        FleetLifecycleService.processes.clear();
        fs.rmSync(root, {recursive: true, force: true});
    });

    test('curated codex-desktop derivation composes exact cwd, dual homes, typed auth, and direct packaged-main supervision', () => {
        const
            cwd   = '/srv/checkouts/peer-desktop/neomjs/neo',
            spawn = install({agents: {desktop: curatedAgent('desktop', 'codex-desktop')}, creds: {}});

        FleetLifecycleService.instanceRoot       = DESKTOP_ROOT;
        FleetLifecycleService.harnessBinaryPaths = {'codex-desktop': process.execPath, codex: '/bin/sh'};
        FleetLifecycleService.codexDesktopCapabilityProbeFn = () => ({
            available         : true,
            reason            : null,
            crashpadExecutable: '/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/browser_crashpad_handler'
        });
        FleetLifecycleService.codexDesktopCleanupFn = async () => ({terminated: [], escalated: []});

        const status       = FleetLifecycleService.start('desktop', {cwd});
        const {args, opts} = spawn.calls[0];

        expect(args).toEqual([
            `--user-data-dir=${opts.env.CODEX_ELECTRON_USER_DATA_PATH}`,
            `--open-project=${cwd}`
        ]);
        expect(opts.cwd).toBe(cwd);
        expect(opts.env.CODEX_HOME).toBe(status.authHome);
        expect(opts.env.CODEX_ELECTRON_USER_DATA_PATH).toContain('electron-profile');
        expect(opts.env.CODEX_SPARKLE_ENABLED).toBe('false');
        expect(opts.env.CODEX_THREAD_ID).toBeUndefined();
        expect(status.instanceHome).not.toBe(status.authHome);
        expect(status.launchCommand).toBe(process.execPath);
        expect(status.authCommand).toBe('/bin/sh');
        expect(status.authCommand).not.toBe(status.launchCommand);
        expect(status.authRequired).toBe(true);
    });

    test('codex-desktop refuses before capability probe/spawn when the final provisioned cwd is absent', () => {
        const spawn = install({agents: {desktop: curatedAgent('desktop', 'codex-desktop')}, creds: {}});

        FleetLifecycleService.instanceRoot       = DESKTOP_ROOT;
        FleetLifecycleService.harnessBinaryPaths = {'codex-desktop': process.execPath, codex: process.execPath};
        FleetLifecycleService.codexDesktopCapabilityProbeFn = () => {
            throw new Error('must not run');
        };

        expect(() => FleetLifecycleService.start('desktop')).toThrow(/cwd.*absolute provisioned checkout/);
        expect(spawn.calls).toHaveLength(0);
    });

    test('codex-desktop capability failure publishes unavailable and never spawns', () => {
        const spawn = install({agents: {desktop: curatedAgent('desktop', 'codex-desktop')}, creds: {}});

        FleetLifecycleService.instanceRoot       = DESKTOP_ROOT;
        FleetLifecycleService.harnessBinaryPaths = {'codex-desktop': process.execPath, codex: process.execPath};
        FleetLifecycleService.codexDesktopCapabilityProbeFn = () => ({available: false, reason: 'updater-disable-predicate-missing'});

        expect(() => FleetLifecycleService.start('desktop', {cwd: '/srv/checkouts/desktop'})).toThrow(/codex-desktop is unavailable.*updater-disable-predicate-missing/);
        expect(spawn.calls).toHaveLength(0);
        expect(FleetLifecycleService.status('desktop')).toMatchObject({
            state        : 'unavailable',
            running      : false,
            failureReason: 'updater-disable-predicate-missing'
        });
    });

    test('codex-desktop missing bundled CLI publishes unavailable before capability probing or spawn', () => {
        const spawn  = install({agents: {desktop: curatedAgent('desktop', 'codex-desktop')}, creds: {}});
        let   probed = false;

        FleetLifecycleService.instanceRoot       = DESKTOP_ROOT;
        FleetLifecycleService.harnessBinaryPaths = {'codex-desktop': process.execPath, codex: '/definitely/missing/codex'};
        FleetLifecycleService.codexDesktopCapabilityProbeFn = () => {
            probed = true;
            return {available: true, crashpadExecutable: '/app/browser_crashpad_handler'};
        };

        expect(() => FleetLifecycleService.start('desktop', {cwd: '/srv/checkouts/desktop'})).toThrow(/bundled Codex CLI auth command is unavailable/);
        expect(probed).toBe(false);
        expect(spawn.calls).toHaveLength(0);
        expect(FleetLifecycleService.status('desktop')).toMatchObject({
            state        : 'unavailable',
            failureReason: 'bundled Codex CLI auth command is unavailable'
        });
    });

    test('codex-desktop child never inherits an ambient CODEX_THREAD_ID', () => {
        const
            previous = process.env.CODEX_THREAD_ID,
            spawn    = install({agents: {desktop: curatedAgent('desktop', 'codex-desktop')}, creds: {}});

        FleetLifecycleService.instanceRoot       = DESKTOP_ROOT;
        FleetLifecycleService.harnessBinaryPaths = {'codex-desktop': process.execPath, codex: process.execPath};
        FleetLifecycleService.codexDesktopCapabilityProbeFn = () => ({
            available         : true,
            crashpadExecutable: '/app/browser_crashpad_handler'
        });
        process.env.CODEX_THREAD_ID = 'ambient-thread-must-not-cross';

        try {
            FleetLifecycleService.start('desktop', {cwd: '/srv/checkouts/desktop'});
            expect(spawn.calls[0].opts.env.CODEX_THREAD_ID).toBeUndefined();
        } finally {
            if (previous === undefined) delete process.env.CODEX_THREAD_ID;
            else process.env.CODEX_THREAD_ID = previous;
        }
    });

    test('codex-desktop auth marker is scoped to the nested authHome, never the parent instanceHome', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-codex-desktop-auth-'));

        try {
            install({agents: {desktop: curatedAgent('desktop', 'codex-desktop')}, creds: {}});
            FleetLifecycleService.instanceRoot       = root;
            FleetLifecycleService.harnessBinaryPaths = {'codex-desktop': process.execPath, codex: process.execPath};
            FleetLifecycleService.codexDesktopCapabilityProbeFn = () => ({
                available         : true,
                crashpadExecutable: '/app/browser_crashpad_handler'
            });

            const started = FleetLifecycleService.start('desktop', {cwd: '/srv/checkouts/desktop'});

            fs.mkdirSync(started.instanceHome, {recursive: true});
            fs.writeFileSync(path.join(started.instanceHome, 'auth.json'), '{}');
            expect(FleetLifecycleService.status('desktop').authRequired).toBe(true);

            fs.mkdirSync(started.authHome, {recursive: true});
            fs.writeFileSync(path.join(started.authHome, 'auth.json'), '{}');
            expect(FleetLifecycleService.status('desktop').authRequired).toBe(false);
        } finally {
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    test('codex-desktop stop waits for exact-profile helper cleanup before reporting stopped', async () => {
        const spawn = install({agents: {desktop: curatedAgent('desktop', 'codex-desktop')}, creds: {}}),
              calls = [];

        FleetLifecycleService.instanceRoot       = DESKTOP_ROOT;
        FleetLifecycleService.harnessBinaryPaths = {'codex-desktop': process.execPath, codex: process.execPath};
        FleetLifecycleService.codexDesktopCapabilityProbeFn = () => ({
            available         : true,
            crashpadExecutable: '/app/browser_crashpad_handler'
        });
        FleetLifecycleService.codexDesktopCleanupFn = async options => {
            calls.push(options);
            await Promise.resolve();
            return {terminated: [1, 2], escalated: []};
        };

        FleetLifecycleService.start('desktop', {cwd: '/srv/checkouts/desktop'});
        const stopped = await FleetLifecycleService.stop('desktop');

        expect(spawn.calls[0].child.signals).toContain('SIGTERM');
        expect(calls).toHaveLength(1);
        expect(calls[0].electronProfile).toContain('electron-profile');
        expect(stopped).toMatchObject({success: true, state: 'stopped'});
        expect(FleetLifecycleService.status('desktop').state).toBe('stopped');
    });

    test('codex-desktop stop joins helper finalization already started by a natural main exit', async () => {
        const spawn = install({agents: {desktop: curatedAgent('desktop', 'codex-desktop')}, creds: {}});
        let releaseCleanup;

        FleetLifecycleService.instanceRoot       = DESKTOP_ROOT;
        FleetLifecycleService.harnessBinaryPaths = {'codex-desktop': process.execPath, codex: process.execPath};
        FleetLifecycleService.codexDesktopCapabilityProbeFn = () => ({
            available         : true,
            crashpadExecutable: '/app/browser_crashpad_handler'
        });
        FleetLifecycleService.codexDesktopCleanupFn = () => new Promise(resolve => { releaseCleanup = resolve });

        FleetLifecycleService.start('desktop', {cwd: '/srv/checkouts/desktop'});
        spawn.calls[0].child.emit('exit', 0, null);
        await Promise.resolve();

        expect(FleetLifecycleService.status('desktop').state).toBe('stopping');
        expect(() => FleetLifecycleService.start('desktop', {cwd: '/srv/checkouts/desktop'})).toThrow(/still being finalized/);
        expect(spawn.calls).toHaveLength(1);

        let   settled = false;
        const stop    = FleetLifecycleService.stop('desktop').then(result => {
            settled = true;
            return result;
        });

        await Promise.resolve();
        expect(settled).toBe(false);

        releaseCleanup({terminated: [], escalated: []});

        await expect(stop).resolves.toMatchObject({success: true, state: 'stopped'});
    });

    test('codex-desktop ambiguous helper ownership fails stop status instead of broadening cleanup', async () => {
        const spawn           = install({agents: {desktop: curatedAgent('desktop', 'codex-desktop')}, creds: {}});
        let   cleanupAttempts = 0;

        FleetLifecycleService.instanceRoot       = DESKTOP_ROOT;
        FleetLifecycleService.harnessBinaryPaths = {'codex-desktop': process.execPath, codex: process.execPath};
        FleetLifecycleService.codexDesktopCapabilityProbeFn = () => ({
            available         : true,
            crashpadExecutable: '/app/browser_crashpad_handler'
        });
        FleetLifecycleService.codexDesktopCleanupFn = async () => {
            if (++cleanupAttempts === 1) throw new Error('ambiguous profile-owned process identity');
            return {terminated: [], escalated: []};
        };

        FleetLifecycleService.start('desktop', {cwd: '/srv/checkouts/desktop'});
        const stopped = await FleetLifecycleService.stop('desktop');

        expect(stopped).toMatchObject({success: false, state: 'failed'});
        expect(stopped.cleanupUnresolved).toBe(true);
        expect(FleetLifecycleService.status('desktop').failureReason).toContain('ambiguous profile-owned process identity');
        expect(() => FleetLifecycleService.start('desktop', {cwd: '/srv/checkouts/desktop'})).toThrow(/refusing to spawn.*lifecycle failure/);

        await expect(FleetLifecycleService.stop('desktop')).resolves.toMatchObject({success: true, state: 'stopped', cleanupUnresolved: false});
        expect(cleanupAttempts).toBe(2);

        expect(FleetLifecycleService.start('desktop', {cwd: '/srv/checkouts/desktop'})).toMatchObject({state: 'running'});
        expect(spawn.calls).toHaveLength(2);
    });

    test('codex-desktop child error after spawn preserves stop authority until helper cleanup succeeds', async () => {
        const spawn = install({agents: {desktop: curatedAgent('desktop', 'codex-desktop')}, creds: {}});

        FleetLifecycleService.instanceRoot       = DESKTOP_ROOT;
        FleetLifecycleService.harnessBinaryPaths = {'codex-desktop': process.execPath, codex: process.execPath};
        FleetLifecycleService.codexDesktopCapabilityProbeFn = () => ({
            available         : true,
            crashpadExecutable: '/app/browser_crashpad_handler'
        });
        FleetLifecycleService.codexDesktopCleanupFn = async () => ({terminated: [], escalated: []});

        FleetLifecycleService.start('desktop', {cwd: '/srv/checkouts/desktop'});
        spawn.calls[0].child.emit('error', new Error('synthetic child error'));

        expect(FleetLifecycleService.status('desktop')).toMatchObject({state: 'failed', cleanupUnresolved: true});
        expect(() => FleetLifecycleService.start('desktop', {cwd: '/srv/checkouts/desktop'})).toThrow(/unresolved after a lifecycle failure/);

        await expect(FleetLifecycleService.stop('desktop')).resolves.toMatchObject({state: 'stopped', cleanupUnresolved: false});
    });

    test('curated claude-code derivation pins strict per-home MCP config plus stream-json mode', () => {
        const spawn = install({agents: {c2: curatedAgent('c2', 'claude-code')}, creds: {}});
        FleetLifecycleService.instanceRoot       = DESKTOP_ROOT;
        FleetLifecycleService.harnessBinaryPaths = {'claude-code': process.execPath};

        FleetLifecycleService.start('c2');

        const {args, opts} = spawn.calls[0];
        expect(args).toEqual([
            '--mcp-config', path.join(FleetLifecycleService.instanceRoot, 'c2', 'harness', 'claude-code', 'mcp-config.json'),
            '--strict-mcp-config',
            '--input-format', 'stream-json',
            '--output-format', 'stream-json',
            '--print',
            '--verbose'
        ]);
        expect(Object.keys(opts.env)).toContain('CLAUDE_CONFIG_DIR');
    });

    test('SECURITY: the child env is the minimal allowlist — an ambient parent secret NEVER crosses into a peer', () => {
        process.env.NEO_TEST_AMBIENT_SECRET = 'sk_parent_secret';
        try {
            const spawn = install({agents: {a: agentDef('a')}, creds: {}});
            FleetLifecycleService.start('a');

            const env = spawn.calls[0].opts.env;
            expect(env.NEO_TEST_AMBIENT_SECRET).toBeUndefined();  // a peer cannot inherit parent secrets
            expect(env.PATH).toBe(process.env.PATH);              // benign runtime vars DO cross (the allowlist)
            expect(env.GH_TOKEN).toBe(FIXTURE_PAT);               // the agent's own PAT, never the parent's GH_TOKEN
            expect(env.NEO_MCP_REMOTE_TOKEN).toBeUndefined();     // no selected plane credential ⇒ remote slot stays empty
        } finally {
            delete process.env.NEO_TEST_AMBIENT_SECRET;
        }
    });

    test('SECURITY: codex-desktop never inherits the packaged parent Node execution mode', () => {
        const previous = process.env.ELECTRON_RUN_AS_NODE;
        const spawn    = install({agents: {desktop: curatedAgent('desktop', 'codex-desktop')}, creds: {}});

        FleetLifecycleService.instanceRoot       = DESKTOP_ROOT;
        FleetLifecycleService.harnessBinaryPaths = {'codex-desktop': process.execPath, codex: process.execPath};
        FleetLifecycleService.codexDesktopCapabilityProbeFn = () => ({
            available         : true,
            crashpadExecutable: '/app/browser_crashpad_handler'
        });
        process.env.ELECTRON_RUN_AS_NODE = '1';

        try {
            FleetLifecycleService.start('desktop', {cwd: '/srv/checkouts/desktop'});
            expect(spawn.calls).toHaveLength(1);
            expect(spawn.calls[0].opts.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
        } finally {
            if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
            else process.env.ELECTRON_RUN_AS_NODE = previous;
        }
    });

    test('SECURITY: a launch env naming a reserved slot is rejected fail-fast, before any secret is minted', () => {
        install({agents: {a: agentDef('a', {metadata: {launch: {command: 'x', args: [], env: {NEO_AGENT_IDENTITY: 'spoofed'}}}})}, creds: {}});
        expect(() => FleetLifecycleService.start('a')).toThrow(/collides with a reserved env slot/);
    });

    test('SECURITY: a prototype-mutating launch env key is rejected, never assigned', () => {
        // JSON.parse creates `__proto__` as an OWN key — exactly what registry-authored JSON yields
        const launch = JSON.parse('{"command": "x", "args": [], "env": {"__proto__": "polluted"}}');
        install({agents: {a: agentDef('a', {metadata: {launch}})}, creds: {}});
        expect(() => FleetLifecycleService.start('a')).toThrow(/prototype-mutating key/);
    });

    test('every FM spawn binds NEO_AGENT_IDENTITY to githubUsername, never the per-instance fleet id', () => {
        const spawn = install({
            agents: {
                'codex-2': agentDef('codex-2', {githubUsername: 'neo-gpt'})
            },
            creds: {}
        });

        FleetLifecycleService.start('codex-2');

        expect(spawn.calls[0].opts.env.NEO_AGENT_IDENTITY).toBe('neo-gpt');
    });

    test('the stdio topology holds stdin open as a pipe — the liveness contract for CLI harnesses', () => {
        const spawn = install({agents: {a: agentDef('a')}, creds: {}});
        FleetLifecycleService.start('a');
        expect(spawn.calls[0].opts.stdio).toEqual(['pipe', 'ignore', 'pipe']);
    });

    test('start fails loud (pre-spawn, pre-secret) on a path-shaped binary that does not exist', () => {
        install({agents: {ghostbin: curatedAgent('ghostbin')}, creds: {}});
        FleetLifecycleService.instanceRoot       = os.tmpdir();
        FleetLifecycleService.harnessBinaryPaths = {codex: '/definitely/not/a/real/binary'};
        expect(() => FleetLifecycleService.start('ghostbin')).toThrow(/harness binary .* not found/);
    });

    test('a remote start launches the exact binary snapshot carried by its capability proof', () => {
        const spawn = install({agents: {remote: curatedAgent('remote')}, creds: {}});

        FleetLifecycleService.instanceRoot       = os.tmpdir();
        FleetLifecycleService.harnessBinaryPaths = {codex: '/mutated/after-capability-probe'};

        FleetLifecycleService.start('remote', {
            remoteMcpCapability: {
                harnessType     : 'codex',
                binaryPath      : process.execPath,
                launchBinaryPath: process.execPath
            }
        });

        expect(spawn.calls).toHaveLength(1);
        expect(spawn.calls[0].command).toBe(process.execPath)
    });

    test('a malformed or cross-family capability proof rejects before spawn', () => {
        const spawn = install({agents: {remote: curatedAgent('remote')}, creds: {}});

        FleetLifecycleService.instanceRoot = os.tmpdir();

        expect(() => FleetLifecycleService.start('remote', {
            remoteMcpCapability: {
                harnessType     : 'claude-code',
                binaryPath      : process.execPath,
                launchBinaryPath: process.execPath
            }
        })).toThrow(/invalid remote MCP capability proof/);
        expect(spawn.calls).toEqual([])
    });

    test('authRequired surfaces the LIVE per-home auth-marker state for curated launches — and flips without a restart', () => {
        const root  = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-auth-')),
              spawn = install({agents: {peer2: curatedAgent('peer2')}, creds: {}});
        FleetLifecycleService.instanceRoot       = root;
        FleetLifecycleService.harnessBinaryPaths = {codex: process.execPath};  // any real path-shaped binary passes preflight

        FleetLifecycleService.start('peer2');

        const
            home   = spawn.calls[0].opts.env.CODEX_HOME,
            status = FleetLifecycleService.status('peer2');

        expect(status.authRequired).toBe(true);  // fresh home: login pending
        expect(status.instanceHome).toBe(home); // exact non-secret owner path for the login handoff
        expect(status.launchCommand).toBe(process.execPath); // actual AiConfig/lifecycle binary, not PATH

        fs.mkdirSync(home, {recursive: true});
        fs.writeFileSync(path.join(home, 'auth.json'), '{}');

        expect(FleetLifecycleService.status('peer2').authRequired).toBe(false); // marker present: recomputed live

        fs.rmSync(root, {recursive: true, force: true});
    });

    test('the version probe runs under the SAME minimal env as the supervised child — no ambient-secret leak through the auxiliary subprocess', () => {
        const spawn     = install({agents: {a: agentDef('a')}, creds: {}}),
              execCalls = [];

        FleetLifecycleService.execFileFn = (command, args, opts) => execCalls.push({command, args, opts});

        FleetLifecycleService.start('a');

        expect(execCalls).toHaveLength(1);
        expect(execCalls[0].args).toEqual(['--version']);
        // identity, not similarity: the probe must receive the exact child-env object — a probe
        // built from process.env would carry every ambient provider secret to the probed binary
        expect(execCalls[0].opts.env).toBe(spawn.calls[0].opts.env);
    });

    test('a BARE command missing from the child PATH fails synchronously — never a transient running/pid:null state', () => {
        const spawn = install({agents: {ghost: {id: 'ghost', githubUsername: 'ghost', harnessType: 'codex', metadata: {launch: {
            command: 'definitely-not-a-real-harness-xyz',
            args   : [],
            env    : {}
        }}}}, creds: {}});

        expect(() => FleetLifecycleService.start('ghost')).toThrow(/harness binary .* not found/);
        expect(spawn.calls).toHaveLength(0);                        // preflight fired BEFORE any spawn
        expect(FleetLifecycleService.isRunning('ghost')).toBe(false);
        expect(FleetLifecycleService.processes.has('ghost')).toBe(false);   // no zombie/false-running record
    });

    test('a bare command that DOES resolve on the child PATH passes preflight', () => {
        const spawn = install({agents: {bare: {id: 'bare', githubUsername: 'bare', harnessType: 'codex', metadata: {launch: {
            command: 'node',
            args   : ['--version'],
            env    : {}
        }}}}, creds: {}});

        FleetLifecycleService.start('bare');

        expect(spawn.calls).toHaveLength(1);
        expect(FleetLifecycleService.isRunning('bare')).toBe(true);
    });

    test('EXECUTABILITY, not existence: a mode-0644 PATH candidate fails synchronously — no record, no async permission-flip', () => {
        // the exact falsifier shape: a real file that EXISTS on the child PATH but is not
        // executable — an existence-only preflight passes it, publishes running/pid:null, then
        // flips to failed on the child's asynchronous permission error
        const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-noexec-'));
        fs.writeFileSync(path.join(binDir, 'plainfile-harness'), '#!/bin/sh\nexit 0\n', {mode: 0o644});

        const spawn = install({agents: {noexec: {id: 'noexec', githubUsername: 'noexec', harnessType: 'codex', metadata: {launch: {
            command: 'plainfile-harness',
            args   : [],
            env    : {PATH: binDir}
        }}}}, creds: {}});

        expect(() => FleetLifecycleService.start('noexec')).toThrow(/not found or not executable/);
        expect(spawn.calls).toHaveLength(0);
        expect(FleetLifecycleService.processes.has('noexec')).toBe(false);

        fs.rmSync(binDir, {recursive: true, force: true});
    });

    test('REAL-PROCESS child-cwd resolution: a relative ./bin command under opts.cwd preflights AND spawns consistently', async () => {
        // spawn-equivalence end-to-end: the resolver accepts the relative command against the
        // CHILD's cwd, and the real spawn (which chdirs before exec) resolves it identically —
        // the child stays alive on the held-open stdin pipe, then stops on SIGTERM
        const childCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-relcwd-'));
        fs.mkdirSync(path.join(childCwd, 'bin'));
        fs.writeFileSync(path.join(childCwd, 'bin', 'h'), '#!/bin/sh\ncat\n', {mode: 0o755});

        install({agents: {rel: {id: 'rel', githubUsername: 'rel', harnessType: 'codex', metadata: {launch: {
            command: './bin/h',
            args   : [],
            env    : {}
        }}}}, creds: {}});
        FleetLifecycleService.spawnFn = null;   // the REAL child_process.spawn

        FleetLifecycleService.start('rel', {cwd: childCwd});

        await new Promise(resolve => setTimeout(resolve, 300));
        expect(FleetLifecycleService.isRunning('rel')).toBe(true);

        const stopped = await FleetLifecycleService.stop('rel');
        expect(stopped.success).toBe(true);

        fs.rmSync(childCwd, {recursive: true, force: true});
    });

    test('REAL-PROCESS relative child PATH: spawn and version probe reuse the same resolved executable', async () => {
        const childCwd       = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-relpath-')),
              executablePath = path.join(childCwd, 'bin', 'h'),
              processCalls   = {spawn: [], execFile: []};

        fs.mkdirSync(path.dirname(executablePath));
        fs.writeFileSync(executablePath, '#!/bin/sh\nif [ "$1" = "--version" ]; then\n    echo relpath-v1\n    exit 0\nfi\nIFS= read -r line\n', {mode: 0o755});

        install({agents: {relpath: {id: 'relpath', githubUsername: 'relpath', harnessType: 'codex', metadata: {launch: {
            command: 'h',
            args   : [],
            env    : {PATH: 'bin'}
        }}}}, creds: {}});
        FleetLifecycleService.spawnFn = (command, args, opts) => {
            processCalls.spawn.push({command, args, opts});
            return spawn(command, args, opts);
        };
        FleetLifecycleService.execFileFn = (command, args, opts, callback) => {
            processCalls.execFile.push({command, args, opts});
            return execFile(command, args, opts, callback);
        };

        try {
            FleetLifecycleService.start('relpath', {cwd: childCwd});

            await expect.poll(() => FleetLifecycleService.status('relpath').binaryVersion).toBe('relpath-v1');
            expect(FleetLifecycleService.isRunning('relpath')).toBe(true);
            expect(processCalls.spawn).toHaveLength(1);
            expect(processCalls.execFile).toHaveLength(1);
            expect(processCalls.spawn[0].command).toBe(executablePath);
            expect(processCalls.execFile[0].command).toBe(executablePath);
        } finally {
            if (FleetLifecycleService.isRunning('relpath')) await FleetLifecycleService.stop('relpath');
            fs.rmSync(childCwd, {recursive: true, force: true});
        }
    });

    test('REAL-PROCESS liveness falsifier: the service topology keeps an actual child alive; SIGTERM stops it', async () => {
        // Through the service's EXACT spawn path (no stub): a real `node` child that only survives
        // if stdin stays open — precisely the property the harness CLIs demand. A regression to
        // stdio 'ignore' makes this child exit instantly and the assertion below fail.
        install({agents: {live: {id: 'live', githubUsername: 'live', harnessType: 'codex', metadata: {launch: {
            command: process.execPath,
            args   : ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'],
            env    : {}
        }}}}, creds: {}});
        FleetLifecycleService.spawnFn = null;  // the REAL child_process.spawn

        FleetLifecycleService.start('live');

        await new Promise(resolve => setTimeout(resolve, 400));
        expect(FleetLifecycleService.isRunning('live')).toBe(true);             // alive BECAUSE stdin is a held pipe

        const stopped = await FleetLifecycleService.stop('live');
        expect(stopped.success).toBe(true);
        expect(FleetLifecycleService.isRunning('live')).toBe(false);
    });
});

test.describe('Neo.ai.services.fleet.FleetLifecycleService — remote MCP capability admission', () => {
    test('the default Claude Desktop probe executes the reviewed bridge grammar', async () => {
        install();
        FleetLifecycleService.harnessBinaryPaths = {'claude-desktop': process.execPath};

        const proof = await FleetLifecycleService.assertRemoteMcpCapability({
            id         : 'seat-claude-desktop',
            harnessType: 'claude-desktop'
        }, {
            mainCheckout: process.cwd(),
            nodePath    : process.execPath
        });

        expect(proof.bridge).toEqual({
            kind      : 'neo-stdio-streamable-http',
            command   : process.execPath,
            entrypoint: path.join(process.cwd(), 'ai/mcp/client/stdioToStreamableHttp.mjs')
        })
    });

    test('accepts only the exact adapter grammar for every supported harness family', async () => {
        install();
        FleetLifecycleService.harnessBinaryPaths = {
            codex           : process.execPath,
            'codex-desktop' : process.execPath,
            'claude-code'   : process.execPath,
            'claude-desktop': process.execPath,
            'kimi-code'     : process.execPath,
            opencode        : process.execPath
        };

        const
            desktopBridge = {
                kind      : 'neo-stdio-streamable-http',
                command   : process.execPath,
                entrypoint: '/installed/neo/ai/mcp/client/stdioToStreamableHttp.mjs'
            },
            outputs       = new Map([
                ['codex',         'Usage: mcp add --url <URL> --bearer-token-env-var <ENV>'],
                ['codex-desktop', 'Usage: mcp add --url <URL> --bearer-token-env-var <ENV>'],
                ['claude-desktop', null],
                ['claude-code',   'Usage: mcp add --transport http --header Header'],
                ['kimi-code',     'kimi 0.29.1'],
                ['opencode',      'opencode 1.18.5']
            ]),
            calls   = [];

        FleetLifecycleService.execFileFn = (command, args, opts, callback) => {
            const harnessType = calls.at(-1)?.pendingHarness;
            calls.push({command, args, opts, harnessType});
            callback(null, outputs.get(harnessType), '')
        };
        FleetLifecycleService.claudeDesktopBridgeCapabilityProbeFn = () => desktopBridge;

        for (const harnessType of outputs.keys()) {
            calls.push({pendingHarness: harnessType});

            const expected = {
                harnessType,
                binaryPath      : process.execPath,
                launchBinaryPath: process.execPath
            };

            if (harnessType === 'claude-desktop') expected.bridge = desktopBridge;

            await expect(FleetLifecycleService.assertRemoteMcpCapability({
                id: `seat-${harnessType}`, harnessType
            })).resolves.toEqual(expected)
        }

        const probeCalls = calls.filter(call => call.command);

        expect(probeCalls.map(call => call.args)).toEqual([
            ['mcp', 'add', '--help'],
            ['mcp', 'add', '--help'],
            ['mcp', 'add', '--help'],
            ['--version'],
            ['--version']
        ])
    });

    test('rejects missing flags, wrong bridge kinds, unknown families, and unavailable binaries', async () => {
        install();
        FleetLifecycleService.harnessBinaryPaths = {
            codex           : process.execPath,
            'claude-code'   : process.execPath,
            'claude-desktop': process.execPath,
            'kimi-code'     : process.execPath,
            opencode        : process.execPath
        };

        const rejects = [
            {harnessType: 'codex',       output: '--url only'},
            {harnessType: 'claude-code', output: '--transport only'},
            {harnessType: 'kimi-code',   output: 'kimi 0.29.0'},
            {harnessType: 'opencode',    output: 'opencode 1.18.6'}
        ];

        for (const {harnessType, output} of rejects) {
            FleetLifecycleService.execFileFn = (command, args, opts, callback) => callback(null, output, '');

            await expect(FleetLifecycleService.assertRemoteMcpCapability({
                id: `seat-${harnessType}`, harnessType
            })).rejects.toThrow(/does not expose Fleet's required remote MCP grammar/)
        }

        FleetLifecycleService.claudeDesktopBridgeCapabilityProbeFn = () => ({
            kind      : 'generic-proxy',
            command   : process.execPath,
            entrypoint: '/installed/neo/ai/mcp/client/stdioToStreamableHttp.mjs'
        });

        await expect(FleetLifecycleService.assertRemoteMcpCapability({
            id: 'seat-claude-desktop', harnessType: 'claude-desktop'
        })).rejects.toThrow(/does not expose Fleet's required Neo stdio-to-Streamable-HTTP bridge/)

        FleetLifecycleService.claudeDesktopBridgeCapabilityProbeFn = () => {
            throw new Error('missing bridge')
        };

        await expect(FleetLifecycleService.assertRemoteMcpCapability({
            id: 'seat-claude-desktop', harnessType: 'claude-desktop'
        })).rejects.toThrow(/bridge capability probe failed/)

        FleetLifecycleService.harnessBinaryPaths['native-neo'] = process.execPath;

        await expect(FleetLifecycleService.assertRemoteMcpCapability({
            id: 'seat-native', harnessType: 'native-neo'
        })).rejects.toThrow(/has no remote MCP artifact grammar/)

        FleetLifecycleService.harnessBinaryPaths = {codex: '/definitely/missing/codex'};

        await expect(FleetLifecycleService.assertRemoteMcpCapability({
            id: 'seat-missing', harnessType: 'codex'
        })).rejects.toThrow(/harness binary .* is unavailable/)
    });

    test('capability probes receive only the benign runtime env allowlist', async () => {
        install();
        FleetLifecycleService.harnessBinaryPaths = {codex: process.execPath};

        const
            secretKey    = 'NEO_TEST_REMOTE_CAPABILITY_SECRET',
            priorSecret  = process.env[secretKey],
            capturedEnvs = [];

        process.env[secretKey] = 'must-not-cross';
        FleetLifecycleService.execFileFn = (command, args, opts, callback) => {
            capturedEnvs.push(opts.env);
            callback(null, '--url --bearer-token-env-var', '')
        };

        try {
            await FleetLifecycleService.assertRemoteMcpCapability({
                id: 'seat-codex', harnessType: 'codex'
            })
        } finally {
            if (priorSecret === undefined) {
                delete process.env[secretKey]
            } else {
                process.env[secretKey] = priorSecret
            }
        }

        expect(capturedEnvs).toHaveLength(1);
        expect(capturedEnvs[0][secretKey]).toBeUndefined();
        expect(capturedEnvs[0].GH_TOKEN).toBeUndefined();
        expect(capturedEnvs[0].NEO_MCP_REMOTE_TOKEN).toBeUndefined();
        expect(Object.keys(capturedEnvs[0]).every(key =>
            ['HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'USER'].includes(key)
        )).toBe(true)
    });

    test('the installed Codex parser must consume the exact generated remote projection before spawn', async () => {
        install();

        const
            resources = {
                'memory-core'   : {url: 'https://tenant.example.com/mc/mcp'},
                'knowledge-base': {url: 'https://tenant.example.com/kb/mcp'}
            },
            matrix = {
                'memory-core'    : true,
                'knowledge-base' : true,
                'neural-link'    : true,
                'github-workflow': false,
                'gitlab-workflow': false
            },
            rows = Object.entries(matrix).map(([key, enabled]) => ({
                name     : `neo-mjs-${key}`,
                enabled,
                transport: ['memory-core', 'knowledge-base'].includes(key)
                    ? {
                        type                : 'streamable_http',
                        url                 : resources[key].url,
                        bearer_token_env_var: 'NEO_MCP_REMOTE_TOKEN',
                        http_headers        : null,
                        env_http_headers    : null
                    }
                    : {type: 'stdio'}
            })),
            calls = [];

        FleetLifecycleService.execFileFn = (command, args, opts, callback) => {
            calls.push({command, args, opts});
            callback(null, JSON.stringify(rows), 'WARNING: benign launcher warning')
        };

        await expect(FleetLifecycleService.inspectPreparedRemoteMcpAdapter({
            agent       : {id: 'seat-codex', githubUsername: 'neo-gpt', harnessType: 'codex'},
            binaryPath  : process.execPath,
            repoPath    : '/managed/seat-codex/neo',
            instanceHome: '/instances/seat-codex',
            mcpMatrix   : matrix,
            mcpTarget   : {kind: 'tenant', resources},
            mcpPlan     : tenantMcpPlan(resources, matrix)
        })).resolves.toEqual({
            harnessType: 'codex',
            inspected  : true,
            serverNames: Object.keys(matrix).map(key => `neo-mjs-${key}`),
            capturePlan: {
                producer        : 'installed-codex-mcp-list',
                harnessType     : 'codex',
                repoPath        : '/managed/seat-codex/neo',
                sourceRoot      : '/installed/neo',
                expectedIdentity: '@neo-gpt',
                servers         : {
                    'memory-core': {
                        name   : 'neo-mjs-memory-core',
                        enabled: true,
                        stdio  : {
                            command: process.execPath,
                            args   : ['/installed/neo/ai/mcp/server/memory-core/mcp-server.mjs'],
                            envVars: ['NEO_AGENT_IDENTITY']
                        },
                        remote: {
                            url             : resources['memory-core'].url,
                            credentialEnvVar: 'NEO_MCP_REMOTE_TOKEN'
                        }
                    },
                    'knowledge-base': {
                        name   : 'neo-mjs-knowledge-base',
                        enabled: true,
                        stdio  : {
                            command: process.execPath,
                            args   : ['/installed/neo/ai/mcp/server/knowledge-base/mcp-server.mjs'],
                            envVars: ['NEO_AGENT_IDENTITY']
                        },
                        remote: {
                            url             : resources['knowledge-base'].url,
                            credentialEnvVar: 'NEO_MCP_REMOTE_TOKEN'
                        }
                    }
                }
            }
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].command).toBe(process.execPath);
        expect(calls[0].args).toEqual(['mcp', 'list', '--json']);
        expect(calls[0].opts.cwd).toBe('/managed/seat-codex/neo');
        expect(calls[0].opts.env.CODEX_HOME).toBe('/instances/seat-codex');
        expect(calls[0].opts.env.GH_TOKEN).toBeUndefined();
        expect(calls[0].opts.env.NEO_MCP_REMOTE_TOKEN).toBeUndefined();

        const mcpPlan = tenantMcpPlan(resources, matrix).map(server => ({
            ...server, environment: {ELECTRON_RUN_AS_NODE: '1'}
        }));
        for (const row of rows) {
            if (row.transport.type === 'stdio') row.transport.env = {ELECTRON_RUN_AS_NODE: '1'};
        }
        const inspection = {
            agent       : {id: 'seat-codex', githubUsername: 'neo-gpt', harnessType: 'codex'},
            binaryPath  : process.execPath,
            repoPath    : '/managed/seat-codex/neo',
            instanceHome: '/instances/seat-codex',
            mcpMatrix   : matrix,
            mcpTarget   : {kind: 'tenant', resources},
            mcpPlan
        };
        const receipt = await FleetLifecycleService.inspectPreparedRemoteMcpAdapter(inspection);
        expect(receipt.capturePlan.servers['memory-core'].stdio.environment).toEqual({ELECTRON_RUN_AS_NODE: '1'});

        delete rows.find(row => row.transport.type === 'stdio').transport.env;
        await expect(FleetLifecycleService.inspectPreparedRemoteMcpAdapter(inspection)).rejects.toThrow(/stdio execution contract/);
    });

    test('the installed Codex projection fails closed on residue, wrong routing, or static auth', async () => {
        install();

        const
            resources = {
                'memory-core'   : {url: 'https://tenant.example.com/mc/mcp'},
                'knowledge-base': {url: 'https://tenant.example.com/kb/mcp'}
            },
            matrix = {
                'memory-core'    : true,
                'knowledge-base' : true,
                'neural-link'    : true,
                'github-workflow': false,
                'gitlab-workflow': false
            },
            canonicalRows = Object.entries(matrix).map(([key, enabled]) => ({
                name     : `neo-mjs-${key}`,
                enabled,
                transport: ['memory-core', 'knowledge-base'].includes(key)
                    ? {
                        type                : 'streamable_http',
                        url                 : resources[key].url,
                        bearer_token_env_var: 'NEO_MCP_REMOTE_TOKEN',
                        http_headers        : null,
                        env_http_headers    : null
                    }
                    : {type: 'stdio'}
            })),
            mutations = [
                rows => rows.slice(1),
                rows => [...rows, structuredClone(rows[0])],
                rows => { rows[0].enabled = false; return rows; },
                rows => { rows[0].transport.url = 'https://wrong.example.com/mc/mcp'; return rows; },
                rows => { rows[0].transport.bearer_token_env_var = 'GH_TOKEN'; return rows; },
                rows => { rows[0].transport.http_headers = {Authorization: 'Bearer static'}; return rows; },
                rows => { rows[2].transport = {type: 'streamable_http', url: 'https://wrong.example.com/nl'}; return rows; }
            ];

        for (const mutate of mutations) {
            const rows = mutate(structuredClone(canonicalRows));

            FleetLifecycleService.execFileFn = (command, args, opts, callback) => {
                callback(null, JSON.stringify(rows), '')
            };

            await expect(FleetLifecycleService.inspectPreparedRemoteMcpAdapter({
                agent       : {id: 'seat-codex', githubUsername: 'neo-gpt', harnessType: 'codex'},
                binaryPath  : process.execPath,
                repoPath    : '/managed/seat-codex/neo',
                instanceHome: '/instances/seat-codex',
                mcpMatrix   : matrix,
                mcpTarget   : {kind: 'tenant', resources},
                mcpPlan     : tenantMcpPlan(resources, matrix)
            })).rejects.toThrow(/inspectPreparedRemoteMcpAdapter/)
        }

        FleetLifecycleService.execFileFn = (command, args, opts, callback) => {
            callback(new Error('adapter read failed'))
        };

        await expect(FleetLifecycleService.inspectPreparedRemoteMcpAdapter({
            agent       : {id: 'seat-codex', githubUsername: 'neo-gpt', harnessType: 'codex'},
            binaryPath  : process.execPath,
            repoPath    : '/managed/seat-codex/neo',
            instanceHome: '/instances/seat-codex',
            mcpMatrix   : matrix,
            mcpTarget   : {kind: 'tenant', resources},
            mcpPlan     : tenantMcpPlan(resources, matrix)
        })).rejects.toThrow(/could not consume the generated MCP projection/)
    });

    test('explicit repository and plane credentials are injected verbatim without authority collapse or a second registry read', () => {
        const
            repositoryPat = 'ghp_exact_authenticated_value',
            planePat      = 'glpat_exact_authenticated_value',
            spawn         = install({agents: {a: agentDef('a')}, creds: {a: 'stale-registry-value'}}),
            registry      = FleetLifecycleService.registry;
        let credentialReads = 0;

        registry.resolveCredential = () => {
            credentialReads++;
            return 'unexpected-second-read'
        };

        FleetLifecycleService.start('a', {
            resolvedCredential   : repositoryPat,
            resolvedMcpCredential: planePat
        });

        expect(credentialReads).toBe(0);
        expect(spawn.calls[0].opts.env.GH_TOKEN).toBe(repositoryPat);
        expect(spawn.calls[0].opts.env.NEO_MCP_REMOTE_TOKEN).toBe(planePat);
        expect(spawn.calls[0].opts.env.GH_TOKEN).not.toBe(spawn.calls[0].opts.env.NEO_MCP_REMOTE_TOKEN)
    });
});

// A seat outlives the Fleet server: the app-bundle families spawn detached and lease their pid; a
// later Fleet server re-adopts a lease the live process still matches, and Stop ends it.
test.describe('Neo.ai.services.fleet.FleetLifecycleService — seat survival', () => {
    const
        LEASE_FILE   = '.neo-fleet-seat-lease.json',
        STARTED_AT   = 'Thu Oct  1 09:00:00 2026',
        CHECKOUT     = '/srv/checkouts/seat/neomjs/neo',
        CRASHPAD     = '/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/browser_crashpad_handler',
        curatedAgent = (id, harnessType) => ({id, githubUsername: id, harnessType, metadata: {}});

    /** One registered seat under a fresh agents root; returns its derived harness home. */
    function installSeat(harnessType) {
        const
            root  = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-seat-survival-')),
            spawn = install({agents: {seat: curatedAgent('seat', harnessType)}}),
            home  = path.join(root, 'seat', 'harness', harnessType);

        fs.mkdirSync(home, {recursive: true});
        FleetLifecycleService.instanceRoot        = root;
        FleetLifecycleService.harnessBinaryPaths  = {[harnessType]: process.execPath, codex: '/bin/sh'};
        FleetLifecycleService.registry.listAgents = () => [{id: 'seat'}];
        FleetLifecycleService.codexDesktopCapabilityProbeFn = () => ({available: true, reason: null, crashpadExecutable: CRASHPAD});

        return {spawn, home, profile: harnessType === 'codex-desktop' ? path.join(home, 'electron-profile') : home}
    }

    /** The lease a previous Fleet server left behind. */
    function writeLease(home, extra = {}) {
        fs.writeFileSync(path.join(home, LEASE_FILE), JSON.stringify({
            version  : 1, agentId: 'seat', harnessType: 'claude-desktop', pid: 4242, pidStartedAt: STARTED_AT,
            startedAt: '2026-10-01T09:00:00.000Z', cwd: null, ...extra
        }))
    }

    /**
     * A host process table behind both seams: `pid → {alive, startedAt, command, dieOn, reusedOn, hidden}`.
     * `reusedOn` hands the pid to a newer process on that signal; `hidden` makes a live row uninspectable.
     */
    function stubProcessTable(rows) {
        const signals = [];

        FleetLifecycleService.processInspectFn = pid => rows[pid]?.alive && !rows[pid].hidden ? {startedAt: rows[pid].startedAt, command: rows[pid].command} : null;
        FleetLifecycleService.processSignalFn  = (pid, signal) => {
            const row = rows[pid];

            if (!row?.alive) throw Object.assign(new Error('no such process'), {code: 'ESRCH'});
            if (signal === 0) return;
            signals.push(signal);
            if (row.dieOn?.includes(signal)) row.alive = false;
            if (row.reusedOn === signal) row.startedAt = 'Thu Oct  1 09:45:00 2026'
        };

        return signals
    }

    /** The leased seat's own main process, exactly as launched. */
    const seatRow = (profile, extra = {}) => ({4242: {alive: true, startedAt: STARTED_AT, command: `${process.execPath} --user-data-dir=${profile}`, ...extra}});

    test('an app-bundle seat spawns detached with no pipe held by the Fleet server; a CLI seat keeps its held stdin', () => {
        for (const harnessType of ['antigravity', 'claude-desktop', 'codex-desktop']) {
            const {spawn} = installSeat(harnessType);

            FleetLifecycleService.start('seat', {cwd: CHECKOUT});

            expect(spawn.calls[0].opts.detached, harnessType).toBe(true);
            expect(spawn.calls[0].opts.stdio, harnessType).toBe('ignore');
            expect(spawn.calls[0].child.unrefed, harnessType).toBe(true)
        }

        const {spawn} = installSeat('codex');

        FleetLifecycleService.start('seat');

        expect(spawn.calls[0].opts.detached).toBeUndefined();
        expect(spawn.calls[0].opts.stdio).toEqual(['pipe', 'ignore', 'pipe']);
        expect(spawn.calls[0].child.unrefed).toBeUndefined()
    });

    test('an app-bundle seat leases its pid at spawn without a secret, and drops the lease when it stops', async () => {
        const {home} = installSeat('claude-desktop');

        FleetLifecycleService.processInspectFn = () => ({startedAt: STARTED_AT, command: `${process.execPath} --user-data-dir=${home}`});

        const
            {pid} = FleetLifecycleService.start('seat'),
            raw   = fs.readFileSync(path.join(home, LEASE_FILE), 'utf8');

        expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['agentId', 'cwd', 'harnessType', 'pid', 'pidStartedAt', 'startedAt', 'version']);
        expect(JSON.parse(raw)).toMatchObject({agentId: 'seat', harnessType: 'claude-desktop', pid, pidStartedAt: STARTED_AT});
        expect(raw).not.toContain(FIXTURE_PAT);
        expect(raw).not.toContain('bridge_seat_token');

        await FleetLifecycleService.stop('seat');

        expect(fs.existsSync(path.join(home, LEASE_FILE))).toBe(false)
    });

    test('a fresh Fleet server re-adopts a seat whose lease the live process matches: running, adopted, the leased pid', () => {
        const {home, profile} = installSeat('claude-desktop');

        // The seat can write its own lease: a command it names is never what the status reports.
        writeLease(home, {launchCommand: '/tmp/planted', authCommand: '/tmp/planted'});
        stubProcessTable({4242: {alive: true, startedAt: STARTED_AT, command: `${process.execPath} --user-data-dir=${profile}`}});

        expect(FleetLifecycleService.status('seat')).toMatchObject({
            state: 'running', running: true, adopted: true, pid: 4242, instanceHome: home, launchCommand: process.execPath, authCommand: null
        });
        expect(FleetLifecycleService.listRunning().map(row => row.id)).toEqual(['seat'])
    });

    test('a lease whose pid is free or now belongs to a newer process is removed, and the agent reads an observed stop with why', () => {
        const cases = {
            gone  : () => ({}),
            reused: profile => seatRow(profile, {startedAt: 'Thu Oct  1 09:30:00 2026'})
        };

        for (const [name, rows] of Object.entries(cases)) {
            const {home, profile} = installSeat('claude-desktop');

            writeLease(home);
            stubProcessTable(rows(profile));

            expect(FleetLifecycleService.status('seat'), name).toMatchObject({
                state: 'stopped', running: false, adopted: false, failureReason: 'the seat exited while no Fleet server supervised it'
            });
            expect(fs.existsSync(path.join(home, LEASE_FILE)), name).toBe(false);
            // The fleet view: an observed stop with that reason, never "outside fleet supervision".
            expect(FleetManager.fleetRuntimeStatus(), name).toEqual([{
                agentId      : 'seat', state: 'stopped', running: false, confidence: 'observed', source: 'fleet:runtimeStatus',
                failureReason: 'the seat exited while no Fleet server supervised it'
            }])
        }
    });

    test('a lease that is unreadable or names another agent is invalid: removed, and nothing is adopted', () => {
        const cases = {
            stranger  : home => writeLease(home, {agentId: 'another-seat'}),   // pid, start time and profile all match
            unreadable: home => fs.writeFileSync(path.join(home, LEASE_FILE), '{"pid": 42')
        };

        for (const [name, plant] of Object.entries(cases)) {
            const {home, profile} = installSeat('claude-desktop');

            plant(home);
            stubProcessTable(seatRow(profile));

            expect(FleetLifecycleService.status('seat'), name).toMatchObject({state: 'stopped', adopted: false, failureReason: 'the seat lease is invalid'});
            expect(fs.existsSync(path.join(home, LEASE_FILE)), name).toBe(false)
        }
    });

    test('only the exact main process is adopted: a longer profile, an embedded profile, a helper or another program is held unidentified', () => {
        const cases = {
            prefix  : profile => `${process.execPath} --user-data-dir=${profile}-other`,
            embedded: profile => `/unrelated/app --note=--user-data-dir=${profile}`,
            helper  : profile => `/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=renderer --user-data-dir=${profile}`,
            program : profile => `/unrelated/app --user-data-dir=${profile}`,
            // A binary launch has no interpreter, so another program holding the launch path as an operand is not the seat.
            operand : profile => `/usr/bin/yes ${process.execPath} --user-data-dir=${profile}`
        };

        for (const [name, command] of Object.entries(cases)) {
            const {home, profile} = installSeat('claude-desktop');

            writeLease(home);
            stubProcessTable(seatRow(profile, {command: command(profile)}));

            expect(FleetLifecycleService.status('seat'), name).toMatchObject({
                state: 'failed', running: false, failureReason: 'the leased seat process is alive but cannot be identified as this seat'
            });
            expect(fs.existsSync(path.join(home, LEASE_FILE)), name).toBe(true);
            expect(() => FleetLifecycleService.start('seat'), name).toThrow(/alive but cannot be identified/)
        }
    });

    test('a launched script is adopted only behind the exact interpreter line its shebang names', () => {
        for (const [interpreter, expected] of [['/opt/interp/node --flag', 'running'], ['/usr/bin/yes', 'failed']]) {
            const
                {home, profile} = installSeat('claude-desktop'),
                script          = path.join(home, '..', 'seat-app.mjs');

            fs.writeFileSync(script, '#!/opt/interp/node --flag\n', {mode: 0o755});
            FleetLifecycleService.harnessBinaryPaths = {'claude-desktop': script};
            writeLease(home);
            stubProcessTable(seatRow(profile, {command: `${interpreter} ${script} --user-data-dir=${profile}`}));

            expect(FleetLifecycleService.status('seat'), interpreter).toMatchObject({state: expected})
        }
    });

    test('a seat that cannot be inspected while its pid answers is held, never taken for exited, and runs again once identified', async () => {
        const
            {home, profile} = installSeat('claude-desktop'),
            rows            = seatRow(profile),
            signals         = stubProcessTable(rows);

        writeLease(home);

        expect(FleetLifecycleService.status('seat')).toMatchObject({state: 'running', adopted: true});

        rows[4242].hidden = true;

        expect(FleetLifecycleService.status('seat')).toMatchObject({state: 'failed', failureReason: 'the leased seat process is alive but cannot be identified as this seat'});
        expect(fs.existsSync(path.join(home, LEASE_FILE))).toBe(true);
        expect(() => FleetLifecycleService.start('seat')).toThrow(/alive but cannot be identified/);
        expect(await FleetLifecycleService.stop('seat')).toMatchObject({success: false, state: 'failed'});
        expect(signals).toEqual([]);

        rows[4242].hidden = false;

        expect(FleetLifecycleService.status('seat')).toMatchObject({state: 'running', adopted: true, failureReason: null})
    });

    test('Stop never sends the seat\'s SIGKILL to a newer process that took its pid during the grace period', async () => {
        const {home, profile} = installSeat('claude-desktop');

        writeLease(home);

        // The seat exits on SIGTERM and a newer process takes its pid at once.
        const signals = stubProcessTable(seatRow(profile, {reusedOn: 'SIGTERM'}));

        expect(await FleetLifecycleService.stop('seat')).toMatchObject({success: true, state: 'stopped'});
        expect(signals).toEqual(['SIGTERM'])
    });

    test('a seat that cannot be leased is stopped while the server holds it, and its Start fails with why', () => {
        const cases = {
            birth : ({home}) => {
                FleetLifecycleService.processInspectFn = () => null
            },
            write : ({home}) => {
                fs.rmSync(home, {recursive: true, force: true});
                fs.writeFileSync(home, '')   // a file where the harness home belongs
            },
            rename: ({home}) => {
                fs.mkdirSync(path.join(home, LEASE_FILE, 'occupied'), {recursive: true})
            }
        };

        for (const [name, breakLease] of Object.entries(cases)) {
            const seat = installSeat('claude-desktop');

            FleetLifecycleService.processInspectFn = () => ({startedAt: STARTED_AT, command: ''});
            breakLease(seat);

            expect(() => FleetLifecycleService.start('seat'), name).toThrow(/the seat could not be leased \(.+\), so it was stopped/);
            expect(seat.spawn.calls[0].child.signals, name).toEqual(['SIGTERM']);
            expect(fs.existsSync(path.join(seat.home, `${LEASE_FILE}.${process.pid}.tmp`)), name).toBe(false)
        }
    });

    test('an adopted Codex Desktop seat whose helper proof is gone is never reported as a clean stop, and retries once the bundle proves it', async () => {
        for (const probe of [() => ({available: false, reason: 'bundle changed'}), () => { throw new Error('unreadable bundle') }]) {
            const
                {home, profile} = installSeat('codex-desktop'),
                cleanups        = [];

            FleetLifecycleService.codexDesktopCapabilityProbeFn = probe;
            FleetLifecycleService.codexDesktopCleanupFn         = async options => {
                cleanups.push(options);
                return {terminated: [], escalated: []}
            };
            writeLease(home, {harnessType: 'codex-desktop', cwd: CHECKOUT});
            stubProcessTable(seatRow(profile, {command: `${process.execPath} --user-data-dir=${profile} --open-project=${CHECKOUT}`, dieOn: ['SIGTERM']}));

            expect(await FleetLifecycleService.stop('seat')).toMatchObject({success: false, state: 'failed', cleanupUnresolved: true});
            expect(cleanups).toEqual([]);
            expect(() => FleetLifecycleService.start('seat')).toThrow(/unresolved/);
            await expect(FleetLifecycleService.restart('seat')).rejects.toThrow(/cleanup failed/);

            FleetLifecycleService.codexDesktopCapabilityProbeFn = () => ({available: true, reason: null, crashpadExecutable: CRASHPAD});

            expect(await FleetLifecycleService.stop('seat')).toMatchObject({success: true, state: 'stopped', cleanupUnresolved: false});
            expect(cleanups).toEqual([{electronProfile: profile, crashpadExecutable: CRASHPAD}])
        }
    });

    test('Stop ends an adopted seat by pid: SIGTERM, then SIGKILL when the seat lingers', async () => {
        for (const [dieOn, sent] of [[['SIGTERM'], ['SIGTERM']], [['SIGKILL'], ['SIGTERM', 'SIGKILL']]]) {
            const {home, profile} = installSeat('claude-desktop');

            writeLease(home);

            const signals = stubProcessTable({4242: {alive: true, startedAt: STARTED_AT, command: `${process.execPath} --user-data-dir=${profile}`, dieOn}});

            expect(await FleetLifecycleService.stop('seat')).toMatchObject({success: true, state: 'stopped'});
            expect(signals).toEqual(sent);
            expect(fs.existsSync(path.join(home, LEASE_FILE))).toBe(false)
        }
    });

    test('an adopted Codex Desktop seat still runs its exact-profile helper finalizer on Stop', async () => {
        const
            {home, profile} = installSeat('codex-desktop'),
            cleanups        = [];

        FleetLifecycleService.codexDesktopCleanupFn = async options => {
            cleanups.push(options);
            return {terminated: [], escalated: []}
        };
        writeLease(home, {harnessType: 'codex-desktop', cwd: CHECKOUT});
        stubProcessTable({4242: {alive: true, startedAt: STARTED_AT, command: `${process.execPath} --user-data-dir=${profile} --open-project=${CHECKOUT}`, dieOn: ['SIGTERM']}});

        expect(await FleetLifecycleService.stop('seat')).toMatchObject({success: true, state: 'stopped', cleanupUnresolved: false});
        expect(cleanups).toEqual([{electronProfile: profile, crashpadExecutable: CRASHPAD}])
    });

    test('an adopted seat that exits on its own reads stopped on the next read, and its lease is gone', () => {
        const
            {home, profile} = installSeat('claude-desktop'),
            rows            = {4242: {alive: true, startedAt: STARTED_AT, command: `${process.execPath} --user-data-dir=${profile}`}};

        writeLease(home);
        stubProcessTable(rows);

        expect(FleetLifecycleService.isRunning('seat')).toBe(true);

        rows[4242].alive = false;

        expect(FleetLifecycleService.status('seat')).toMatchObject({state: 'stopped', running: false, adopted: true});
        expect(fs.existsSync(path.join(home, LEASE_FILE))).toBe(false)
    });

    test('REAL-PROCESS: an app-bundle seat leaves the Fleet server\'s process group; a fresh server adopts and stops it', async () => {
        const
            root    = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-seat-real-')),
            fakeApp = path.join(root, 'fake-app.mjs'),
            pgidOf  = pid => execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {encoding: 'utf8'}).trim();

        // A desktop stand-in: it ignores its argv, the profile flag included, and lives until signalled.
        fs.writeFileSync(fakeApp, `#!${process.execPath}\nsetInterval(() => {}, 1 << 30);\n`, {mode: 0o755});
        fs.mkdirSync(path.join(root, 'seat', 'harness', 'claude-desktop'), {recursive: true});

        install({agents: {seat: curatedAgent('seat', 'claude-desktop')}});
        FleetLifecycleService.instanceRoot        = root;
        FleetLifecycleService.harnessBinaryPaths  = {'claude-desktop': fakeApp};
        FleetLifecycleService.registry.listAgents = () => [{id: 'seat'}];
        FleetLifecycleService.spawnFn             = null;  // the REAL child_process.spawn
        FleetLifecycleService.processInspectFn    = null;  // the REAL ps read
        FleetLifecycleService.processSignalFn     = null;  // the REAL process.kill
        FleetLifecycleService.sigkillTimeoutMs    = 2000;

        const
            {pid}  = FleetLifecycleService.start('seat'),
            // This runner is the seat's parent here, so the seat lingers as a zombie until it is reaped.
            reaped = new Promise(resolve => FleetLifecycleService.processes.get('seat').child.once('exit', resolve));

        try {
            expect(pgidOf(pid)).toBe(String(pid));                // its own group leader,
            expect(pgidOf(pid)).not.toBe(pgidOf(process.pid));    // outside the Fleet server's group

            FleetLifecycleService.processes.clear();              // a fresh Fleet server process
            FleetLifecycleService.leasesAdopted = false;

            expect(FleetLifecycleService.status('seat')).toMatchObject({running: true, adopted: true, pid});
            expect(await FleetLifecycleService.stop('seat')).toMatchObject({success: true, state: 'stopped'});

            await reaped;
            expect(() => process.kill(pid, 0)).toThrow()
        } finally {
            try { process.kill(pid, 'SIGKILL') } catch {}
        }
    });
});

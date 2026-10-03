import {setup} from '../../../../../setup.mjs';

const appName = 'TurnPresenceHookProjectionTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}                            from '@playwright/test';
import {createMcpExpressApp}                     from '@modelcontextprotocol/sdk/server/express.js';
import {McpServer}                               from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport}           from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Neo                                       from 'neo.mjs/src/Neo.mjs';
import * as core                                 from 'neo.mjs/src/core/_export.mjs';
import {spawn}                                   from 'node:child_process';
import crypto                                    from 'node:crypto';
import fs                                        from 'node:fs';
import net                                       from 'node:net';
import os                                        from 'node:os';
import path                                      from 'node:path';
import {pathToFileURL}                           from 'node:url';
import {z}                                       from 'zod';
import {reconcileClaudeEvents, renderProjection} from '../../../../../../../ai/scripts/lifecycle/hooks/projectSeatHooks.mjs';
import {HOOK_PROCESS_SHARE_MS}                   from '../../../../../../../ai/scripts/lifecycle/hooks/seatConfig.mjs';
import {generateKimiSeatConfig}                  from '../../../../../../../ai/services/fleet/generateKimiSeatConfig.mjs';

const
    REPO_ROOT   = path.resolve(process.cwd()),
    HOOKS_DIR   = path.join(REPO_ROOT, 'ai/scripts/lifecycle/hooks'),
    HOOK_SOURCE = path.join(HOOKS_DIR, 'claude/turnPresenceHook.mjs'),
    MANIFEST    = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, 'claude/events.manifest.json'), 'utf8')),
    PRESENCE    = '/.claude/hooks/turnPresenceHook.mjs',
    // each harness's presence hook: its source, and where a seat receives the projected copy
    HOOKS       = {
        claude: [HOOK_SOURCE,                                            '.claude/hooks/turnPresenceHook.mjs'],
        codex : [path.join(HOOKS_DIR, 'codex/codex-context.mjs'),        '.codex/hooks/codex-context.mjs'],
        kimi  : [path.join(HOOKS_DIR, 'kimi-code/turnPresenceHook.mjs'), '.kimi-code/hooks/turnPresenceHook.mjs']
    };

let scratchDirs = [];

/**
 * @summary Writes a harness's projected presence hook into a fresh scratch checkout.
 *
 * Rendered through the real {@link renderProjection}, so this is the byte-for-byte artifact a seat
 * receives — not the source module with its relative specifiers still intact. Importing the source
 * would test a file no seat ever runs.
 * @param {String} label Distinguishes the location.
 * @param {String} [harness='claude'] A key of `HOOKS`.
 * @returns {{dir: String, target: String}} The checkout, and the projected hook's path in it.
 */
function projectInto(label, harness = 'claude') {
    const
        [source, relative] = HOOKS[harness],
        dir                = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `presence-${label}-`))),
        target             = path.join(dir, relative);

    scratchDirs.push(dir);

    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, renderProjection(source, REPO_ROOT).contents, 'utf8');

    return {dir, target}
}

/**
 * @summary Materializes a projected hook at an arbitrary location and imports it.
 * @param {String} label Distinguishes the location.
 * @param {String} [harness='claude'] A key of `HOOKS`.
 * @returns {Promise<Object>} The imported module namespace.
 */
async function projectedAt(label, harness) {
    return import(pathToFileURL(projectInto(label, harness).target).href)
}

/**
 * @summary Runs a projected hook the way its harness does: a fresh process, the payload on stdin, and
 * the seat's env with nothing else inherited.
 * @param {String} target The projected hook.
 * @param {Object} [options]
 * @param {String[]} [options.args=[]]
 * @param {Object} [options.env={}] Added to the seat's identity and credential.
 * @param {String} [options.stdin='{}']
 * @returns {Promise<{code: Number, stderr: String, stdout: String}>}
 */
function runHook(target, {args = [], env = {}, stdin = '{}'} = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [target, ...args], {
            cwd: REPO_ROOT,
            env: {
                PATH                : process.env.PATH,
                UNIT_TEST_MODE      : 'true',
                NEO_AGENT_IDENTITY  : 'AGENT:neo-opus-grace',
                NEO_MCP_REMOTE_TOKEN: 'seat-plane-pat',
                ...env
            }
        });
        let stderr = '', stdout = '';

        child.stderr.on('data', chunk => {stderr += chunk});
        child.stdout.on('data', chunk => {stdout += chunk});
        child.on('error', reject);
        child.on('close', code => resolve({code, stderr, stdout}));
        child.stdin.end(stdin)
    })
}

/**
 * @summary A plane that accepts every connection and never answers.
 * @returns {Promise<{baseUrl: String, close: Function, connections: Function}>}
 */
async function listenSilently() {
    const
        sockets = new Set(),
        server  = net.createServer(socket => sockets.add(socket));

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    return {
        baseUrl    : `http://127.0.0.1:${server.address().port}`,
        close      : () => {sockets.forEach(socket => socket.destroy()); return new Promise(resolve => server.close(resolve))},
        connections: () => sockets.size
    }
}

/**
 * @summary A Memory Core plane that answers `record_turn_presence`, keeping each call's arguments and
 * the identity and bearer every request arrived under.
 * @returns {Promise<{baseUrl: String, calls: Object[], close: Function, headers: Object[]}>}
 */
async function startPresencePlane() {
    const
        app        = createMcpExpressApp({allowedHosts: ['127.0.0.1']}),
        calls      = [],
        headers    = [],
        sessions   = new Map(),
        mcpServers = new Set(),
        transports = new Set();

    app.use((request, response, next) => {
        headers.push({authorization: request.headers.authorization, identity: request.headers['x-preferred-username']});
        next()
    });

    app.all('/mc/mcp', async (request, response) => {
        const sessionId = request.headers['mcp-session-id'];
        let   transport = sessionId && sessions.get(sessionId);

        if (!transport) {
            const mcpServer = new McpServer({name: 'presence-plane-fixture', version: '1.0.0'});

            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator  : () => crypto.randomUUID(),
                onsessioninitialized: id => sessions.set(id, transport),
                onsessionclosed     : id => sessions.delete(id)
            });
            mcpServer.registerTool('record_turn_presence', {
                inputSchema: {action: z.string(), note: z.string().optional(), source: z.string().optional()}
            }, async args => {
                calls.push(args);
                return {content: [{type: 'text', text: JSON.stringify({status: 'recorded'})}]}
            });
            mcpServers.add(mcpServer);
            transports.add(transport);
            await mcpServer.connect(transport)
        }

        await transport.handleRequest(request, response, request.body)
    });

    const httpServer = await new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
        server.once('error', reject)
    });

    return {
        baseUrl: `http://127.0.0.1:${httpServer.address().port}`,
        calls,
        close  : async () => {
            await Promise.allSettled([...mcpServers].map(server => server.close()));
            await Promise.allSettled([...transports].map(transport => transport.close()));
            await new Promise(resolve => httpServer.close(resolve))
        },
        headers
    }
}

test.afterAll(() => {
    scratchDirs.forEach(dir => fs.rmSync(dir, {force: true, recursive: true}));
    scratchDirs = []
});

/**
 * The presence hooks still emit after their move into the Brain, with the MCP storage path unchanged.
 *
 * The hazard is named in `turnPresenceHook.mjs`'s own JSDoc: an earlier shape let the writer derive
 * a filesystem path from its own module location, "which is how every beacon ended up in a private
 * checkout that no reader queries". Every beacon was written, nothing failed, and no reader ever saw
 * one.
 *
 * Moving the hook out of the Engine and projecting it into arbitrary target checkouts is precisely
 * the change that would resurrect that bug, and it would resurrect it silently. So the property is
 * not "presence still works here" — it is that **where the file sits cannot affect where the record
 * goes**, tested by varying the only thing that moved.
 */
test.describe('turnPresenceHook — emission survives projection to an arbitrary location', () => {
    const ENV = {NEO_AGENT_IDENTITY: 'AGENT:neo-opus-grace'};

    test('the projected hook records against the injected plane', async () => {
        const
            calls  = [],
            hook   = await projectedAt('emits'),
            result = await hook.recordClaudeTurnPresence({
                actionArg : 'start',
                deadlineMs: 1500,
                env       : ENV,
                plane     : {baseUrl: 'https://plane.example/mc/mcp', credential: 'token'},
                record    : async payload => {calls.push(payload); return {status: 'recorded'}}
            });

        expect(result.status, `presence was not recorded: ${result.reason ?? ''}`).toBe('recorded');
        expect(calls).toHaveLength(1);
        expect(calls[0].baseUrl).toBe('https://plane.example/mc/mcp');
        expect(calls[0].identity).toBe('AGENT:neo-opus-grace');
        expect(calls[0].action).toBe('start');
        expect(calls[0].deadlineMs, 'the entrypoint\'s deadline reaches the transport').toBe(1500)
    });

    test('two projections at different paths emit IDENTICAL records', async () => {
        // The falsifier for location-derived state. If any part of the destination leaked into the
        // record — a path, a root, a resolved directory — these two would differ, and the difference
        // is exactly the silent misrouting this hook was rebuilt to end.
        const capture = async label => {
            const
                calls = [],
                hook  = await projectedAt(label);

            await hook.recordClaudeTurnPresence({
                actionArg : 'progress',
                deadlineMs: 1500,
                env       : ENV,
                now       : '2026-08-31T00:00:00.000Z',
                plane     : {baseUrl: 'https://plane.example/mc/mcp', credential: 'token'},
                record    : async payload => {calls.push(payload); return {status: 'recorded'}}
            });

            return calls[0]
        };

        const [first, second] = await Promise.all([capture('root-a'), capture('root-b')]);

        expect(first).toBeDefined();
        expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    });

    test('an unconfigured plane is a NAMED skip, never a guessed local endpoint', async () => {
        // The other half of "storage path unchanged": with nowhere to write, the hook must decline
        // and say so. Falling back to a filesystem path or localhost is how the beacons went to a
        // checkout nobody reads — a silent success is worse here than a loud refusal.
        const
            calls  = [],
            hook   = await projectedAt('no-plane'),
            result = await hook.recordClaudeTurnPresence({
                actionArg : 'start',
                deadlineMs: 1500,
                env       : ENV,
                plane     : {baseUrl: '', credential: ''},
                record    : async payload => {calls.push(payload); return {status: 'recorded'}}
            });

        expect(result.status).toBe('skipped');
        expect(result.reason).toContain('plane');
        expect(calls, 'the transport ran despite there being no configured destination').toHaveLength(0)
    });

    test('a hook that injects no deadline, as a copy projected before its runtime does, is a named skip that names the repair', async () => {
        // Seats are never re-projected unattended (`seatProjectionCheck` reports, never repairs), and a
        // projected copy reaches the writer in its runtime by absolute path. So the writer, not the copy,
        // decides what a stale copy's write does.
        const
            {recordTurnPresenceFromHook} = await import('../../../../../../../ai/mcp/server/memory-core/helpers/TurnPresenceHookWriter.mjs'),
            calls                        = [],
            result                       = await recordTurnPresenceFromHook({
                env   : ENV,
                plane : {baseUrl: 'https://plane.example/mc/mcp', credential: 'token'},
                record: async payload => {calls.push(payload); return {status: 'recorded'}}
            });

        expect(result).toMatchObject({
            status: 'skipped',
            reason: 'the hook injected no turn-presence deadline: re-project the seat\'s hooks if this copy predates its runtime'
        });
        expect(calls, 'nothing is sent without a deadline').toHaveLength(0)
    });

    test('the projected hook resolves its plane from the runtime\'s seat config, not from its own location', () => {
        // Asserted on the projected BYTES rather than by executing readPlaneConfig(), which would
        // boot the config singleton inside a unit run (seatConfig.spec reads it in a child). What
        // matters structurally is that the only thing the endpoint is derived from is the config.
        const contents = renderProjection(HOOK_SOURCE, REPO_ROOT).contents;

        expect(contents).toContain(`from '${path.join(REPO_ROOT, 'ai/scripts/lifecycle/hooks/seatConfig.mjs')}'`);

        // No self-location derivation. These are the constructs that produced the original defect.
        expect(contents).not.toMatch(/import\.meta\.url[^\n]*\b(dirname|resolve|join)\b/);
        expect(contents).not.toMatch(/\bprocess\.cwd\(\)/)
    })
});

/**
 * Presence is never a precondition, so no tool call waits on its progress beacon. The harness enforces no
 * timeout on an async hook, which leaves the writer's own deadline as the only bound — a `timeout` on the
 * entry would read as one. The start stays in the prompt's path: it opens the turn's interval, and a start
 * landing after the turn completed would open one for a finished turn.
 */
test.describe('turnPresenceHook — progress runs in the background, start before the turn can complete', () => {
    const
        presenceEntries = events => Object.entries(events).flatMap(([event, buckets]) =>
            buckets.flatMap(bucket => bucket.hooks.filter(entry => entry.command.includes(PRESENCE)).map(entry => ({event, entry})))),
        commandFor      = action => `/usr/bin/env node "$(git rev-parse --show-toplevel)${PRESENCE}" ${action}`;

    test('progress is async with no timeout; start is synchronous within its 2 s bound; both keep their commands', () => {
        const byEvent = Object.fromEntries(presenceEntries(MANIFEST.events).map(({event, entry}) => [event, entry]));

        expect(Object.keys(byEvent).sort()).toEqual(['PostToolUse', 'UserPromptSubmit']);

        expect(byEvent.PostToolUse.async, 'PostToolUse would block every tool call on presence').toBe(true);
        expect('timeout' in byEvent.PostToolUse, 'PostToolUse carries a timeout the harness never enforces').toBe(false);
        expect(byEvent.PostToolUse.command).toBe(commandFor('progress'));

        expect(byEvent.UserPromptSubmit.async, 'an async start can land after its turn completed').toBeUndefined();
        expect(byEvent.UserPromptSubmit.timeout).toBe(2);
        expect(byEvent.UserPromptSubmit.command).toBe(commandFor('start'))
    });

    test('a seat\'s synchronous progress entry is replaced by the async one on reconciliation; start stays synchronous', () => {
        const
            operator   = {command: 'echo operator-hook', type: 'command'},
            sync       = action => ({command: commandFor(action), timeout: 2, type: 'command'}),
            {settings} = reconcileClaudeEvents({
                isOwned : command => command.includes(PRESENCE),
                manifest: MANIFEST,
                settings: {hooks: {
                    PostToolUse     : [{hooks: [sync('progress'), operator]}],
                    UserPromptSubmit: [{hooks: [sync('start')]}]
                }}
            }),
            byEvent    = Object.fromEntries(presenceEntries(settings.hooks).map(({event, entry}) => [event, entry]));

        expect(presenceEntries(settings.hooks)).toHaveLength(2);
        expect(byEvent.PostToolUse.async).toBe(true);
        expect('timeout' in byEvent.PostToolUse).toBe(false);
        expect(byEvent.UserPromptSubmit).toEqual({type: 'command', command: commandFor('start'), timeout: 2});
        expect(settings.hooks.PostToolUse.flatMap(bucket => bucket.hooks)).toContainEqual(operator)
    })
});

/**
 * A synchronous hook the harness kills at its registered timeout never reaches its own named skip: the
 * kill is the silent failure. So each presence hook names its registration, the deadline it spends must
 * leave the hook process its share of it, and a configured value that does not is refused by name
 * (`seatConfig.spec`). A named registration and the harness config holding the real one drift silently,
 * so they are held equal here.
 */
test.describe('turnPresenceHook — the writer\'s deadline fits inside every synchronous registration', () => {
    test('each presence hook names its harness\'s registration, and the default deadline leaves every hook process its share', async () => {
        const
            memoryCoreConfig         = (await import('../../../../../../../ai/mcp/server/memory-core/config.template.mjs')).default,
            deadlineMs               = memoryCoreConfig.turnPresence.hookWriteTimeoutMs,
            {SYNC_REGISTRATION_MS}   = await projectedAt('registration-claude'),
            {PROMPT_REGISTRATION_MS} = await projectedAt('registration-codex', 'codex'),
            {REGISTRATION_MS}        = await projectedAt('registration-kimi', 'kimi'),
            claudeStart              = MANIFEST.events.UserPromptSubmit.flatMap(bucket => bucket.hooks).find(entry => entry.command.includes(PRESENCE)),
            codexConfig              = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, 'codex/hooks.json'), 'utf8')),
            codexPrompt              = (codexConfig.hooks ?? codexConfig).UserPromptSubmit.flatMap(bucket => bucket.hooks ?? [bucket]).find(entry => entry.command.includes('codex-context.mjs')),
            {files}                  = generateKimiSeatConfig({
                agentosRuntimeRoot: '/runtime', targetRepoRoot: '/repo', seatEnvFile: '/seat.env', kimiHome: '/kimi-home', memoryDir: '/memory', nodeBinary: '/node'
            }),
            kimiToml                 = files.find(file => file.path.endsWith('config.toml')).content,
            kimiTimeouts             = [...kimiToml.matchAll(/command = '[^']*turnPresenceHook\.mjs'\ntimeout = (\d+)/g)].map(match => Number(match[1]));

        expect(claudeStart.async, 'Claude\'s start is synchronous').toBeUndefined();
        expect(claudeStart.timeout * 1000, 'Claude\'s start').toBe(SYNC_REGISTRATION_MS);
        expect(codexPrompt.timeout * 1000, 'Codex\'s prompt hook').toBe(PROMPT_REGISTRATION_MS);
        expect(kimiTimeouts, 'Kimi registers presence on five events, all synchronous').toHaveLength(5);
        kimiTimeouts.forEach(timeout => expect(timeout * 1000, 'a Kimi presence hook').toBe(REGISTRATION_MS));

        [SYNC_REGISTRATION_MS, PROMPT_REGISTRATION_MS, REGISTRATION_MS].forEach(registrationMs =>
            expect(deadlineMs, `the default deadline inside ${registrationMs} ms`).toBeLessThanOrEqual(registrationMs - HOOK_PROCESS_SHARE_MS))
    });

    test('the Claude hook spends the async deadline on exactly the actions its manifest registers async', async () => {
        const
            {ASYNC_ACTIONS} = await projectedAt('async-actions'),
            registered      = Object.values(MANIFEST.events)
                .flatMap(buckets => buckets.flatMap(bucket => bucket.hooks))
                .filter(entry => entry.command.includes(PRESENCE))
                .map(entry => [entry.command.split(' ').at(-1), entry.async === true]);

        expect(registered.length).toBeGreaterThan(0);
        registered.forEach(([action, async]) => expect(ASYNC_ACTIONS.has(action), action).toBe(async));
        expect([...ASYNC_ACTIONS].every(action => registered.some(([registeredAction]) => registeredAction === action))).toBe(true)
    })
});

/**
 * The deadline exists so a plane that does not answer costs a bounded wait and says so. Spent, it must
 * surface as the hook's named warning on stderr, where the harness captures it, while the hook still
 * exits 0: presence never fails a session, and it is never silent either.
 */
test.describe('turnPresenceHook — a spent deadline is a visible skip, never a silent one', () => {
    // both leaves are set to distinct values in every run, so the warning names which one was spent
    for (const [action, spentMs] of [['start', 200], ['progress', 300]]) {
        test(`${action}: a plane that accepts the connection and never answers ends in a named warning on its own deadline, and the hook exits 0`, async () => {
            const
                plane    = await listenSilently(),
                {target} = projectInto('deadline');

            try {
                const {code, stderr} = await runHook(target, {args: [action], env: {
                    NEO_SEAT_PLANE_BASE                          : plane.baseUrl,
                    NEO_TURN_PRESENCE_HOOK_WRITE_TIMEOUT_MS      : '200',
                    NEO_TURN_PRESENCE_ASYNC_HOOK_WRITE_TIMEOUT_MS: '300'
                }});

                expect(code).toBe(0);
                expect(stderr).toMatch(new RegExp(`\\[WARN\\] \\[turn-presence\\] not recorded — turn-presence threw: turn-presence MCP connect timed out with \\d+ms left of the ${spentMs}ms deadline`))
            } finally {
                await plane.close()
            }
        })
    }
});

/**
 * A configured synchronous deadline is checked against the registration of the hook that spends it. One
 * that does not fit is refused before the plane is dialled, and the refusal is the hook's named warning:
 * the alternative is a harness kill that reports nothing.
 */
test.describe('turnPresenceHook — a synchronous deadline that cannot fit its registration is refused by name', () => {
    for (const [harness, registrationMs, warning, run] of [
        ['claude', 2000,  '[WARN] [turn-presence] not recorded — ', {args: ['start']}],
        ['codex',  10000, '[WARN] [turn-presence] not recorded — ', {}],
        ['kimi',   5000,  'kimi turnPresenceHook: not recorded — ', {stdin: JSON.stringify({hook_event_name: 'UserPromptSubmit'})}]
    ]) {
        test(`${harness}: a 15000 ms deadline is refused against its ${registrationMs} ms registration, the plane is never dialled, and the hook exits 0`, async () => {
            const
                plane         = await listenSilently(),
                {dir, target} = projectInto(`oversized-${harness}`, harness);

            try {
                const {code, stderr} = await runHook(target, {...run, env: {
                    NEO_AI_DAEMON_DIR                      : path.join(dir, 'daemon'),
                    NEO_SEAT_PLANE_BASE                    : plane.baseUrl,
                    NEO_TURN_PRESENCE_HOOK_WRITE_TIMEOUT_MS: '15000'
                }});

                expect(code).toBe(0);
                expect(stderr).toContain(
                    `${warning}turn-presence threw: the synchronous turn-presence deadline (15000 ms) does not fit this hook's ` +
                    `${registrationMs} ms registration; set NEO_TURN_PRESENCE_HOOK_WRITE_TIMEOUT_MS to at most ${registrationMs - HOOK_PROCESS_SHARE_MS} ms`
                );
                expect(plane.connections(), 'a refused deadline never dials the plane').toBe(0)
            } finally {
                await plane.close()
            }
        })
    }
});

/**
 * Codex's prompt hook loads the seat's context whatever presence does, and a write that did not record
 * says so on stderr, in the Claude hook's words, instead of being swallowed. Its stdout is the context
 * alone: Codex injects it into the prompt.
 */
test.describe('codex-context — the prompt\'s context loads whatever presence does, and a failed write is named', () => {
    const CONTEXT = 'context the seat authors for every prompt';

    /**
     * @summary Projects the Codex hook with the target-authored context file beside it.
     * @param {String} label
     * @returns {{dir: String, target: String}}
     */
    function projectCodex(label) {
        const projection = projectInto(label, 'codex');

        fs.writeFileSync(path.join(projection.dir, '.codex/CODEX.md'), `${CONTEXT}\n`, 'utf8');

        return projection
    }

    test('a plane that never answers ends in the named warning on the synchronous deadline; the context still loads and the hook exits 0', async () => {
        const
            plane         = await listenSilently(),
            {dir, target} = projectCodex('codex-silent');

        try {
            const {code, stderr, stdout} = await runHook(target, {env: {
                NEO_AI_DAEMON_DIR                      : path.join(dir, 'daemon'),
                NEO_SEAT_PLANE_BASE                    : plane.baseUrl,
                NEO_TURN_PRESENCE_HOOK_WRITE_TIMEOUT_MS: '200'
            }});

            expect(code).toBe(0);
            expect(stderr).toMatch(/\[WARN\] \[turn-presence\] not recorded — turn-presence threw: turn-presence MCP connect timed out with \d+ms left of the 200ms deadline/);
            expect(stdout).toBe(`${CONTEXT}\n`)
        } finally {
            await plane.close()
        }
    });

    test('a plane that answers records the start under the seat\'s identity and bearer; the context loads and nothing is warned', async () => {
        const
            plane         = await startPresencePlane(),
            {dir, target} = projectCodex('codex-answers');

        try {
            const {code, stderr, stdout} = await runHook(target, {env: {
                NEO_AI_DAEMON_DIR  : path.join(dir, 'daemon'),
                NEO_SEAT_PLANE_BASE: plane.baseUrl
            }});

            expect(code).toBe(0);
            expect(stderr, 'a recorded write warns nothing').not.toContain('[turn-presence]');
            expect(stdout).toBe(`${CONTEXT}\n`);
            expect(plane.calls).toEqual([{action: 'start', note: 'codex UserPromptSubmit', source: 'codex-user-prompt-submit'}]);
            expect(plane.headers.length).toBeGreaterThan(0);
            plane.headers.forEach(header => expect(header).toEqual({authorization: 'Bearer seat-plane-pat', identity: 'AGENT:neo-opus-grace'}))
        } finally {
            await plane.close()
        }
    })
});

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
import Neo                                       from 'neo.mjs/src/Neo.mjs';
import * as core                                 from 'neo.mjs/src/core/_export.mjs';
import {spawn}                                   from 'node:child_process';
import fs                                        from 'node:fs';
import net                                       from 'node:net';
import os                                        from 'node:os';
import path                                      from 'node:path';
import {pathToFileURL}                           from 'node:url';
import {reconcileClaudeEvents, renderProjection} from '../../../../../../../ai/scripts/lifecycle/hooks/projectSeatHooks.mjs';
import {generateKimiSeatConfig}                  from '../../../../../../../ai/services/fleet/generateKimiSeatConfig.mjs';

const
    REPO_ROOT   = path.resolve(process.cwd()),
    HOOK_SOURCE = path.join(REPO_ROOT, 'ai/scripts/lifecycle/hooks/claude/turnPresenceHook.mjs'),
    MANIFEST    = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ai/scripts/lifecycle/hooks/claude/events.manifest.json'), 'utf8')),
    PRESENCE    = '/.claude/hooks/turnPresenceHook.mjs';

let scratchDirs = [];

/**
 * @summary Materializes the projected hook at an arbitrary location and imports it.
 *
 * Rendered through the real {@link renderProjection}, so this is the byte-for-byte artifact a seat
 * receives — not the source module with its relative specifiers still intact. Importing the source
 * would test a file no seat ever runs.
 * @param {String} label Distinguishes the location.
 * @returns {Promise<Object>} The imported module namespace.
 */
async function projectedAt(label) {
    const
        dir    = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `presence-${label}-`))),
        target = path.join(dir, '.claude/hooks/turnPresenceHook.mjs');

    scratchDirs.push(dir);

    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, renderProjection(HOOK_SOURCE, REPO_ROOT).contents, 'utf8');

    return import(pathToFileURL(target).href)
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
 * kill is the silent failure. So every synchronous registration that runs a presence write must allow
 * more than the writer's deadline, across every harness that writes presence. The numbers live in four
 * places (the leaf and three harness configs), and two places holding related numbers drift silently.
 */
test.describe('turnPresenceHook — the writer\'s deadline fits inside every synchronous registration', () => {
    test('Claude\'s start, Codex\'s prompt hook and every Kimi presence hook allow more time than the deadline', async () => {
        const
            memoryCoreConfig = (await import('../../../../../../../ai/mcp/server/memory-core/config.template.mjs')).default,
            deadlineMs       = memoryCoreConfig.turnPresence.hookWriteTimeoutMs,
            claudeStart      = MANIFEST.events.UserPromptSubmit.flatMap(bucket => bucket.hooks).find(entry => entry.command.includes(PRESENCE)),
            codexConfig      = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ai/scripts/lifecycle/hooks/codex/hooks.json'), 'utf8')),
            codexPrompt      = (codexConfig.hooks ?? codexConfig).UserPromptSubmit.flatMap(bucket => bucket.hooks ?? [bucket]).find(entry => entry.command.includes('codex-context.mjs')),
            {files}          = generateKimiSeatConfig({
                agentosRuntimeRoot: '/runtime', targetRepoRoot: '/repo', seatEnvFile: '/seat.env', kimiHome: '/kimi-home', memoryDir: '/memory', nodeBinary: '/node'
            }),
            kimiToml         = files.find(file => file.path.endsWith('config.toml')).content,
            kimiTimeouts     = [...kimiToml.matchAll(/command = '[^']*turnPresenceHook\.mjs'\ntimeout = (\d+)/g)].map(match => Number(match[1]));

        expect(claudeStart.async, 'Claude\'s start is synchronous').toBeUndefined();
        expect(claudeStart.timeout * 1000).toBeGreaterThan(deadlineMs);
        expect(codexPrompt.timeout * 1000).toBeGreaterThan(deadlineMs);
        expect(kimiTimeouts, 'Kimi registers presence on five events, all synchronous').toHaveLength(5);
        kimiTimeouts.forEach(timeout => expect(timeout * 1000).toBeGreaterThan(deadlineMs))
    })
});

/**
 * The deadline exists so a plane that does not answer costs a bounded wait and says so. Spent, it must
 * surface as the hook's named warning on stderr, where the harness captures it, while the hook still
 * exits 0: presence never fails a session, and it is never silent either.
 */
test.describe('turnPresenceHook — a spent deadline is a visible skip, never a silent one', () => {
    test('a plane that accepts the connection and never answers ends in a named warning, and the hook exits 0', async () => {
        const
            silentPlane = net.createServer(() => {}),
            dir         = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'presence-deadline-'))),
            target      = path.join(dir, '.claude/hooks/turnPresenceHook.mjs');

        scratchDirs.push(dir);
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.writeFileSync(target, renderProjection(HOOK_SOURCE, REPO_ROOT).contents, 'utf8');

        await new Promise(resolve => silentPlane.listen(0, '127.0.0.1', resolve));

        try {
            const {code, stderr} = await new Promise((resolve, reject) => {
                const child = spawn(process.execPath, [target, 'start'], {
                    cwd: REPO_ROOT,
                    env: {
                        PATH                                   : process.env.PATH,
                        UNIT_TEST_MODE                         : 'true',
                        NEO_AGENT_IDENTITY                     : 'AGENT:neo-opus-grace',
                        NEO_MCP_REMOTE_TOKEN                   : 'seat-plane-pat',
                        NEO_SEAT_PLANE_BASE                    : `http://127.0.0.1:${silentPlane.address().port}`,
                        NEO_TURN_PRESENCE_HOOK_WRITE_TIMEOUT_MS: '200'
                    }
                });
                let stderr = '';

                child.stderr.on('data', chunk => {stderr += chunk});
                child.on('error', reject);
                child.on('close', code => resolve({code, stderr}));
                child.stdin.end('{}')
            });

            expect(code).toBe(0);
            expect(stderr).toMatch(/\[WARN\] \[turn-presence\] not recorded — turn-presence threw: turn-presence MCP connect timed out with \d+ms left of the 200ms deadline/)
        } finally {
            silentPlane.close()
        }
    })
});

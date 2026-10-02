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
import fs                                        from 'node:fs';
import os                                        from 'node:os';
import path                                      from 'node:path';
import {pathToFileURL}                           from 'node:url';
import {reconcileClaudeEvents, renderProjection} from '../../../../../../../ai/scripts/lifecycle/hooks/projectSeatHooks.mjs';

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
                actionArg: 'start',
                env      : ENV,
                plane    : {baseUrl: 'https://plane.example/mc/mcp', credential: 'token'},
                record   : async payload => {calls.push(payload); return {status: 'recorded'}}
            });

        expect(result.status, `presence was not recorded: ${result.reason ?? ''}`).toBe('recorded');
        expect(calls).toHaveLength(1);
        expect(calls[0].baseUrl).toBe('https://plane.example/mc/mcp');
        expect(calls[0].identity).toBe('AGENT:neo-opus-grace');
        expect(calls[0].action).toBe('start')
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
                actionArg: 'progress',
                env      : ENV,
                now      : '2026-08-31T00:00:00.000Z',
                plane    : {baseUrl: 'https://plane.example/mc/mcp', credential: 'token'},
                record   : async payload => {calls.push(payload); return {status: 'recorded'}}
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
                actionArg: 'start',
                env      : ENV,
                plane    : {baseUrl: '', credential: ''},
                record   : async payload => {calls.push(payload); return {status: 'recorded'}}
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

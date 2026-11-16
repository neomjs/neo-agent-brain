import {test, expect}  from '@playwright/test';
import {spawnSync}     from 'node:child_process';
import fs              from 'node:fs';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';

import {
    WRITER_KEY_VERSION,
    decideWriterStamp,
    deriveWriterKey
} from '../../../../../../../ai/scripts/lifecycle/hooks/claude/writerStampHook.mjs';
import {sessionTurnStore}      from '../../../../../../../ai/scripts/lifecycle/hooks/claude/turnPresenceHook.mjs';
import {reconcileClaudeEvents} from '../../../../../../../ai/scripts/lifecycle/hooks/projectSeatHooks.mjs';
import {writerStamp}           from '../../../../../../../ai/daemons/wake/sunsetReceipt.mjs';

/**
 * The Claude seat's writer stamp (`writerStampHook.mjs`): `add_memory` and `add_message` carry a key derived
 * from the seat and its harness session plus the session's stored turn, in the shape the plane's reader keeps.
 * The ids below are synthetic.
 */

const
    HOOK       = fileURLToPath(new URL('../../../../../../../ai/scripts/lifecycle/hooks/claude/writerStampHook.mjs', import.meta.url)),
    MANIFEST   = fileURLToPath(new URL('../../../../../../../ai/scripts/lifecycle/hooks/claude/events.manifest.json', import.meta.url)),
    SEAT       = '@spec-seat',
    SESSION_ID = 'abcdef12-3456-4789-abcd-ef0123456789',
    TURN_ID    = '0f1e2d3c-4b5a-4987-8765-43210fedcba9',
    ADD_MEMORY = 'mcp__neo-mjs-memory-core__add_memory';

const
    store   = turns => ({read: sessionId => turns[sessionId] ?? null}),
    payload = (toolInput, sessionId = SESSION_ID) => ({hook_event_name: 'PreToolUse', session_id: sessionId, tool_name: ADD_MEMORY, tool_input: toolInput}),
    decide  = (input, {identity = SEAT, turns = {[SESSION_ID]: TURN_ID}, sessionId} = {}) =>
        decideWriterStamp({identity, payload: payload(input, sessionId), turnStore: store(turns)});

test('stamps the call with the seat\'s key and the stored turn, and keeps the rest of its input', () => {
    const input = {prompt: 'p', response: 'r', decisionContext: 'd'};

    expect(decide(input)).toEqual({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput : {...input, writerKey: deriveWriterKey(SEAT, SESSION_ID), writerTurn: TURN_ID}
        }
    })
});

test('the stamp is one the plane\'s reader keeps', () => {
    const {writerKey, writerTurn} = decide({to: SEAT, subject: 's', body: 'b'}).hookSpecificOutput.updatedInput;

    expect(writerStamp({writerKey, writerTurn})).toEqual({writerKey, writerTurn})
});

test('the key hides the session id, is stable for one seat and session, and differs by seat and by session', () => {
    const key = deriveWriterKey(SEAT, SESSION_ID);

    expect(key).toMatch(new RegExp(`^${WRITER_KEY_VERSION}:[0-9a-f]{32}$`));
    expect(key.toLowerCase()).not.toContain(SESSION_ID.toLowerCase());
    expect(deriveWriterKey(SEAT, SESSION_ID)).toBe(key);
    expect(deriveWriterKey('@other-seat', SESSION_ID)).not.toBe(key);
    expect(deriveWriterKey(SEAT, 'fedcba98-7654-4321-8fed-cba987654321')).not.toBe(key)
});

test('a stamp the caller supplied is replaced by the seat\'s own', () => {
    const {updatedInput} = decide({prompt: 'p', writerKey: 'v1:forged', writerTurn: 'forged'}).hookSpecificOutput;

    expect(updatedInput).toEqual({prompt: 'p', writerKey: deriveWriterKey(SEAT, SESSION_ID), writerTurn: TURN_ID})
});

test('stamps nothing without a seat, a session id, a stored turn or an object input', () => {
    expect(decide({prompt: 'p'}, {identity: null})).toBeNull();
    expect(decide({prompt: 'p'}, {sessionId: ''})).toBeNull();
    expect(decide({prompt: 'p'}, {turns: {}})).toBeNull();
    expect(decide({prompt: 'p'}, {turns: {[SESSION_ID]: 7}})).toBeNull();
    expect(decide(null)).toBeNull();
    expect(decide(['p'])).toBeNull();
    expect(decideWriterStamp({identity: SEAT, payload: null, turnStore: store({})})).toBeNull()
});

test('the entrypoint prints the stamp Claude Code reads, and nothing for a session without a stored turn', () => {
    const
        turnStore = sessionTurnStore(),
        sessionId = `spec-${process.pid}-${SESSION_ID}`,
        env       = {PATH: process.env.PATH, UNIT_TEST_MODE: 'true', NEO_AGENT_IDENTITY: SEAT, ...(process.env.TMPDIR ? {TMPDIR: process.env.TMPDIR} : {})},
        run       = input => spawnSync(process.execPath, [HOOK], {input, encoding: 'utf8', env});

    turnStore.write(sessionId, TURN_ID);

    try {
        const stamped = run(JSON.stringify(payload({prompt: 'p'}, sessionId)));

        expect(stamped.status).toBe(0);
        expect(JSON.parse(stamped.stdout).hookSpecificOutput.updatedInput).toEqual({
            prompt: 'p', writerKey: deriveWriterKey(SEAT, sessionId), writerTurn: TURN_ID
        });

        expect(run(JSON.stringify(payload({prompt: 'p'}, `${sessionId}-unknown`))).stdout).toBe('');
        expect(run('{not json').stdout).toBe('')
    } finally {
        turnStore.remove(sessionId)
    }
});

test('the published matcher, tested unanchored as Claude tests it, selects the two writes only, and the hook runs sync', () => {
    const
        buckets = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).events.PreToolUse,
        stamps  = buckets.filter(bucket => bucket.hooks.some(hook => hook.command.endsWith(`/.claude/hooks/${path.basename(HOOK)}"`))),
        matcher = new RegExp(stamps[0].matcher);

    expect(stamps.length).toBe(1);
    expect(stamps[0].hooks.some(hook => hook.async || hook.asyncRewake)).toBe(false);

    ['mcp__neo-mjs-memory-core__add_memory', 'mcp__neo-mjs-memory-core__add_message']
        .forEach(tool => expect(matcher.test(tool), tool).toBe(true));

    ['mcp__neo-mjs-memory-core__list_messages', 'mcp__neo-mjs-memory-core__add_memory_batch', 'mcp__other__add_memory',
        'mcp__neo-mjs-memory-core__add_messages', 'Bash', 'Write']
        .forEach(tool => expect(matcher.test(tool), tool).toBe(false))
});

test('reconciled into hydrated settings, the stamp sits beside the Engine guard and the harness id guard', () => {
    const
        engine     = {matcher: 'Bash', hooks: [{type: 'command', command: '/usr/bin/env node ".claude/hooks/rgReplaceGuardHook.mjs"'}]},
        manifest   = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')),
        {settings} = reconcileClaudeEvents({isOwned: () => false, manifest, settings: {hooks: {PreToolUse: [engine]}}}),
        commands   = settings.hooks.PreToolUse.flatMap(bucket => bucket.hooks.map(hook => hook.command));

    expect(settings.hooks.PreToolUse[0]).toEqual(engine);
    expect(commands.filter(command => command.includes('writerStampHook.mjs')).length).toBe(1);
    expect(commands.filter(command => command.includes('harnessIdGuardHook.mjs')).length).toBe(1)
});

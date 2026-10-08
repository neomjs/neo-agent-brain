import {test, expect}  from '@playwright/test';
import {spawnSync}     from 'node:child_process';
import fs              from 'node:fs';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';

import {
    HARNESS_ID_GUARD_MESSAGE,
    decideHarnessIdGuard
} from '../../../../../../../ai/scripts/lifecycle/hooks/claude/harnessIdGuardHook.mjs';
import {reconcileClaudeEvents} from '../../../../../../../ai/scripts/lifecycle/hooks/projectSeatHooks.mjs';

/**
 * The Claude seat's harness-id guard (`harnessIdGuardHook.mjs`): a publishing or writing call whose
 * input carries the seat's own `session_id` is refused, everything else runs, and a malformed payload
 * fails open. The ids below are synthetic.
 */

const
    HOOK       = fileURLToPath(new URL('../../../../../../../ai/scripts/lifecycle/hooks/claude/harnessIdGuardHook.mjs', import.meta.url)),
    MANIFEST   = fileURLToPath(new URL('../../../../../../../ai/scripts/lifecycle/hooks/claude/events.manifest.json', import.meta.url)),
    SESSION_ID = 'abcdef12-3456-4789-abcd-ef0123456789',
    OTHER_ID   = 'fedcba98-7654-4321-8fed-cba987654321';

const payload = toolInput => ({hook_event_name: 'PreToolUse', session_id: SESSION_ID, tool_name: 'Bash', tool_input: toolInput});

test('a call whose input carries the session id is refused, wherever the id sits', () => {
    const blocked = {decision: 'block', reason: HARNESS_ID_GUARD_MESSAGE};

    expect(decideHarnessIdGuard(payload({command: `gh issue comment 1 --body "session ${SESSION_ID}"`}))).toEqual(blocked);
    expect(decideHarnessIdGuard(payload({sessionId: SESSION_ID, prompt: 'p', thought: 't', response: 'r'}))).toEqual(blocked);
    expect(decideHarnessIdGuard(payload({file_path: '/tmp/body.md', content: `Origin Session ID: ${SESSION_ID.toUpperCase()}`}))).toEqual(blocked);
    expect(HARNESS_ID_GUARD_MESSAGE).not.toContain(SESSION_ID)
});

test('a call without the session id runs, including one that stamps a different id', () => {
    expect(decideHarnessIdGuard(payload({command: 'gh issue view 1'}))).toBeNull();
    expect(decideHarnessIdGuard(payload({body: `Origin Session ID: ${OTHER_ID}`}))).toBeNull()
});

test('a malformed, short or input-less payload fails open', () => {
    expect(decideHarnessIdGuard(null)).toBeNull();
    expect(decideHarnessIdGuard('not an object')).toBeNull();
    expect(decideHarnessIdGuard({session_id: SESSION_ID})).toBeNull();
    expect(decideHarnessIdGuard({session_id: 'short', tool_input: {command: 'short'}})).toBeNull();
    expect(decideHarnessIdGuard({session_id: 42, tool_input: {command: '42'}})).toBeNull()
});

test('the entrypoint prints the block decision for a matching payload and nothing otherwise', () => {
    const run = input => spawnSync(process.execPath, [HOOK], {input, encoding: 'utf8'});

    const refused = run(JSON.stringify(payload({command: `echo ${SESSION_ID}`})));
    expect(refused.status).toBe(0);
    expect(JSON.parse(refused.stdout)).toEqual({decision: 'block', reason: HARNESS_ID_GUARD_MESSAGE});

    expect(run(JSON.stringify(payload({command: 'ls'}))).stdout).toBe('');
    expect(run('{not json').stdout).toBe('')
});

test('the published matcher, tested unanchored as Claude tests it, selects the publishing and writing tools only', () => {
    const
        buckets = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).events.PreToolUse,
        guarded = buckets.filter(bucket => bucket.hooks.some(hook => hook.command.endsWith(`/.claude/hooks/${path.basename(HOOK)}"`))),
        matcher = new RegExp(guarded[0].matcher);

    expect(guarded.length).toBe(1);

    ['Bash', 'Write', 'Edit', 'mcp__neo-mjs-github-workflow__create_issue', 'mcp__neo-mjs-github-workflow__manage_pr_review',
        'mcp__neo-mjs-memory-core__add_message', 'mcp__neo-mjs-memory-core__add_memory']
        .forEach(tool => expect(matcher.test(tool), tool).toBe(true));

    ['Read', 'Grep', 'mcp__neo-mjs-memory-core__list_messages', 'mcp__neo-mjs-memory-core__query_raw_memories',
        'mcp__unrelated__BashHistory', 'mcp__neo-mjs-memory-core__add_memory_extra']
        .forEach(tool => expect(matcher.test(tool), tool).toBe(false))
});

test('reconciled into hydrated settings, the guard sits beside the Engine guard instead of replacing it', () => {
    const
        engine     = {matcher: 'Bash', hooks: [{type: 'command', command: '/usr/bin/env node ".claude/hooks/rgReplaceGuardHook.mjs"'}]},
        manifest   = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')),
        {settings} = reconcileClaudeEvents({isOwned: () => false, manifest, settings: {hooks: {PreToolUse: [engine]}}}),
        commands   = settings.hooks.PreToolUse.flatMap(bucket => bucket.hooks.map(hook => hook.command));

    expect(settings.hooks.PreToolUse[0]).toEqual(engine);
    expect(commands.filter(command => command.includes('harnessIdGuardHook.mjs')).length).toBe(1)
});

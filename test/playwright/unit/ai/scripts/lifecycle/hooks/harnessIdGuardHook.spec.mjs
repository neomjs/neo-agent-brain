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
 * The Claude seat's harness-id guard (`harnessIdGuardHook.mjs`): a call on a way into an artifact whose
 * input carries the seat's own `session_id` is refused, everything else runs, and a malformed payload
 * fails open. The ids below are synthetic.
 */

const
    HOOK          = fileURLToPath(new URL('../../../../../../../ai/scripts/lifecycle/hooks/claude/harnessIdGuardHook.mjs', import.meta.url)),
    MANIFEST      = fileURLToPath(new URL('../../../../../../../ai/scripts/lifecycle/hooks/claude/events.manifest.json', import.meta.url)),
    SESSION_ID    = 'abcdef12-3456-4789-abcd-ef0123456789',
    OTHER_ID      = 'fedcba98-7654-4321-8fed-cba987654321',
    TEMP_ROOT     = `/private/tmp/claude-501/-Users-someone-neomjs-neo/${SESSION_ID}`,
    ISSUE_COMMENT = 'mcp__neo-mjs-github-workflow__manage_issue_comment';

const
    blocked = {decision: 'block', reason: HARNESS_ID_GUARD_MESSAGE},
    payload = (toolInput, toolName = 'Bash') => ({hook_event_name: 'PreToolUse', session_id: SESSION_ID, tool_name: toolName, tool_input: toolInput});

test('a call whose input carries the session id is refused, wherever the id sits', () => {
    expect(decideHarnessIdGuard(payload({command: `gh issue comment 1 --body "session ${SESSION_ID}"`}))).toEqual(blocked);
    expect(decideHarnessIdGuard(payload({issue_number: 1, body: `Origin Session ID: ${SESSION_ID}`}, ISSUE_COMMENT))).toEqual(blocked);
    expect(decideHarnessIdGuard(payload({file_path: '/tmp/body.md', content: `Origin Session ID: ${SESSION_ID.toUpperCase()}`}, 'Write'))).toEqual(blocked);
    expect(HARNESS_ID_GUARD_MESSAGE).not.toContain(SESSION_ID)
});

test('the session temp root is a location: a path or command naming it runs, content carrying the id does not', () => {
    expect(decideHarnessIdGuard(payload({file_path: `${TEMP_ROOT}/scratchpad/body.md`, content: 'a body'}, 'Write'))).toBeNull();
    expect(decideHarnessIdGuard(payload({file_path: `${TEMP_ROOT}/scratchpad/body.md`, old_string: 'a', new_string: 'b'}, 'Edit'))).toBeNull();
    expect(decideHarnessIdGuard(payload({command: `tail ${TEMP_ROOT}/tasks/b1.output && gh pr create --body-file ${TEMP_ROOT}/scratchpad/body.md`}))).toBeNull();
    expect(decideHarnessIdGuard(payload({command: `ls "/tmp/claude-501/-Users-someone-neomjs-neo/${SESSION_ID.toUpperCase()}"`}))).toBeNull();

    expect(decideHarnessIdGuard(payload({file_path: `${TEMP_ROOT}/scratchpad/body.md`, content: `Session ${SESSION_ID}`}, 'Write'))).toEqual(blocked);
    expect(decideHarnessIdGuard(payload({file_path: `/repo/learn/${SESSION_ID}.md`, content: 'a body'}, 'Write'))).toEqual(blocked);
    expect(decideHarnessIdGuard(payload({issue_number: 1, body: `log: ${TEMP_ROOT}/scratchpad/log.txt`}, ISSUE_COMMENT))).toEqual(blocked);
    expect(decideHarnessIdGuard(payload({command: `echo ${SESSION_ID} > ${TEMP_ROOT}/scratchpad/id.txt`}))).toEqual(blocked);
    expect(decideHarnessIdGuard(payload({command: `grep x ~/.claude/projects/-Users-someone-neomjs-neo/${SESSION_ID}.jsonl`}))).toEqual(blocked);
    expect(decideHarnessIdGuard(payload({command: `ls /tmp/claude-501/-Users-someone-neomjs-neo/${SESSION_ID}0`}))).toEqual(blocked)
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

test('the published matcher, tested unanchored as Claude tests it, selects the ways into an artifact only', () => {
    const
        buckets = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).events.PreToolUse,
        guarded = buckets.filter(bucket => bucket.hooks.some(hook => hook.command.endsWith(`/.claude/hooks/${path.basename(HOOK)}"`))),
        matcher = new RegExp(guarded[0].matcher);

    expect(guarded.length).toBe(1);

    ['Bash', 'Write', 'Edit', 'mcp__neo-mjs-github-workflow__create_issue', 'mcp__neo-mjs-github-workflow__manage_pr_review']
        .forEach(tool => expect(matcher.test(tool), tool).toBe(true));

    ['Read', 'Grep', 'mcp__neo-mjs-memory-core__add_message', 'mcp__neo-mjs-memory-core__add_memory',
        'mcp__neo-mjs-memory-core__list_messages', 'mcp__unrelated__BashHistory']
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

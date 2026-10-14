import {test, expect}  from '@playwright/test';
import {spawnSync}     from 'node:child_process';
import fs              from 'node:fs';
import os              from 'node:os';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';

import {
    GUARD_DIR,
    MODEL_OK,
    decideSeatModelGuard,
    modelFamily,
    readLastRunModel,
    readSessionModel,
    resolveUserDataDir,
    runSeatModelGuard
} from '../../../../../../../ai/scripts/lifecycle/hooks/claude/seatModelGuardHook.mjs';

/**
 * The Claude Desktop seat model guard (`seatModelGuardHook.mjs`): a prompt is blocked while the
 * session's model family differs from the family the seat last ran, `model-ok` runs it on purpose, and
 * every missing or unexpected input fails open. Records follow the app's session-record shape; ids are
 * synthetic.
 */

const
    HOOK        = fileURLToPath(new URL('../../../../../../../ai/scripts/lifecycle/hooks/claude/seatModelGuardHook.mjs', import.meta.url)),
    MANIFEST    = fileURLToPath(new URL('../../../../../../../ai/scripts/lifecycle/hooks/claude/events.manifest.json', import.meta.url)),
    SESSION_ID  = 'abcdef12-3456-4789-abcd-ef0123456789',
    HOST_ID     = 'local_0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e',
    APP_VERSION = '2.37337.1';

/**
 * @summary Builds a fake Desktop user-data dir holding one session record, and the env Desktop gives its CLI.
 * @param {Object} [record] The record's fields; `null` writes no record.
 * @returns {{userData: String, env: Object}}
 */
function seat(record = {model: 'claude-fable-5-1', cliSessionId: SESSION_ID}) {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-model-guard-'));

    if (record) {
        const dir = path.join(userData, 'claude-code-sessions', 'account-uuid', 'scope-uuid');

        fs.mkdirSync(dir, {recursive: true});
        fs.writeFileSync(path.join(dir, `${HOST_ID}.json`), JSON.stringify({sessionId: HOST_ID, title: 'x', ...record}))
    }

    return {
        userData,
        env: {
            CLAUDE_CODE_ENTRYPOINT         : 'claude-desktop',
            CLAUDE_CODE_EXECPATH           : path.join(userData, 'claude-code', '2.1.295', 'hash', 'claude.app', 'Contents', 'MacOS', 'claude'),
            CLAUDE_CODE_HOST_SESSION_ID    : HOST_ID,
            CLAUDE_CODE_DESKTOP_APP_VERSION: APP_VERSION
        }
    }
}

function lastRun(userData, model) {
    fs.mkdirSync(path.join(userData, GUARD_DIR), {recursive: true});
    fs.writeFileSync(path.join(userData, GUARD_DIR, 'model.json'), JSON.stringify({lastRunModel: model}))
}

function transcript(dir, ...models) {
    const file = path.join(dir, 'transcript.jsonl');

    fs.writeFileSync(file, models.map(model => JSON.stringify({type: 'assistant', message: {model}})).concat(JSON.stringify({type: 'last-prompt'})).join('\n'));

    return file
}

const prompt = text => ({hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt: text});

test('families, not ids: version bumps, aliases and [1m] variants share a family; unknown names have none', () => {
    expect(['claude-opus-5-5', 'claude-opus-5-5[1m]', 'opus', 'Claude-Opus-6'].map(modelFamily)).toEqual(['opus', 'opus', 'opus', 'opus']);
    expect(modelFamily('claude-fable-5-1')).toBe('fable');
    expect([null, undefined, '', '<synthetic>', 'gpt-6.1', 42].map(modelFamily)).toEqual([null, null, null, null, null, null])
});

test('the decision table: only a known family differing from a known expected family blocks, and model-ok runs it', () => {
    expect(decideSeatModelGuard({currentModel: 'claude-opus-5-5', expectedModel: 'claude-opus-5'}).block).toBe(false);
    expect(decideSeatModelGuard({currentModel: 'claude-opus-5-5[1m]', expectedModel: 'claude-opus-5-5'}).block).toBe(false);
    expect(decideSeatModelGuard({currentModel: 'mystery-model', expectedModel: 'claude-opus-5-5'}).block).toBe(false);
    expect(decideSeatModelGuard({currentModel: 'claude-fable-5-1', expectedModel: null}).block).toBe(false);
    expect(decideSeatModelGuard({currentModel: null, expectedModel: 'claude-opus-5-5'}).block).toBe(false);

    const mismatch = decideSeatModelGuard({currentModel: 'claude-fable-5-1', expectedModel: 'claude-opus-5-5', prompt: 'continue'});

    expect(mismatch).toMatchObject({block: true, expected: 'opus', current: 'fable'});
    expect(mismatch.reason).toContain('Switch the model picker to opus');
    expect(mismatch.reason).toContain(MODEL_OK);
    expect(decideSeatModelGuard({currentModel: 'claude-fable-5-1', expectedModel: 'claude-opus-5-5', prompt: `  ${MODEL_OK} today runs on fable`}).block).toBe(false);
    expect(decideSeatModelGuard({currentModel: 'claude-fable-5-1', expectedModel: 'claude-opus-5-5', prompt: `please ${MODEL_OK}`}).block).toBe(true)
});

test('the user-data dir comes from the bundled CLI path; anything else fails open', () => {
    expect(resolveUserDataDir('/Users/x/agents/vega/harness/claude-desktop/claude-code/2.1.295/h/claude.app/Contents/MacOS/claude'))
        .toBe('/Users/x/agents/vega/harness/claude-desktop');
    expect([undefined, '', 'relative/claude-code/x', '/usr/local/bin/claude'].map(resolveUserDataDir)).toEqual([null, null, null, null])
});

test('the record counts only when its cliSessionId joins the hook session and its id is a host session id', () => {
    const {userData} = seat();

    expect(readSessionModel(userData, HOST_ID, SESSION_ID)).toBe('claude-fable-5-1');
    expect(readSessionModel(userData, HOST_ID, 'another-session')).toBeNull();
    expect(readSessionModel(userData, '../../etc/passwd', SESSION_ID)).toBeNull();
    expect(readSessionModel(userData, undefined, SESSION_ID)).toBeNull();
    expect(readSessionModel(seat(null).userData, HOST_ID, SESSION_ID)).toBeNull();

    const broken = seat();
    fs.writeFileSync(path.join(broken.userData, 'claude-code-sessions', 'account-uuid', 'scope-uuid', `${HOST_ID}.json`), '{not json');
    expect(readSessionModel(broken.userData, HOST_ID, SESSION_ID)).toBeNull()
});

test('stop records the last real assistant model and skips synthetic ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-model-transcript-'));

    expect(readLastRunModel(transcript(dir, 'claude-opus-5-5', 'claude-fable-5-1', '<synthetic>'))).toBe('claude-fable-5-1');
    expect(readLastRunModel(path.join(dir, 'missing.jsonl'))).toBeNull();
    expect(readLastRunModel(undefined)).toBeNull()
});

test('a mismatched prompt blocks with exit 2 and one log line without session ids; a corrected or model-ok prompt runs', () => {
    const {userData, env} = seat();
    lastRun(userData, 'claude-opus-5-5');

    expect(runSeatModelGuard('prompt', prompt('hello'), env)).toBe(2);

    const log = fs.readFileSync(path.join(userData, GUARD_DIR, 'model.log'), 'utf8');

    expect(log.trim().split('\n')).toHaveLength(1);
    expect(log).toContain(`expected=opus\tcurrent=fable\tapp=${APP_VERSION}`);
    expect(log).not.toContain(SESSION_ID);
    expect(log).not.toContain(HOST_ID);
    expect(runSeatModelGuard('prompt', prompt(`${MODEL_OK} go`), env)).toBe(0);

    const record = path.join(userData, 'claude-code-sessions', 'account-uuid', 'scope-uuid', `${HOST_ID}.json`);
    fs.writeFileSync(record, JSON.stringify({model: 'claude-opus-5-5', cliSessionId: SESSION_ID}));
    expect(runSeatModelGuard('prompt', prompt('hello again'), env)).toBe(0)
});

test('stop makes the model that ran the expected one, so a model-ok session is not blocked again', () => {
    const {userData, env} = seat();
    lastRun(userData, 'claude-opus-5-5');

    expect(runSeatModelGuard('stop', {transcript_path: transcript(userData, 'claude-fable-5-1')}, env)).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(userData, GUARD_DIR, 'model.json'), 'utf8')).lastRunModel).toBe('claude-fable-5-1');
    expect(runSeatModelGuard('prompt', prompt('next'), env)).toBe(0)
});

test('fails open: a first session, a CLI seat, a missing record and a missing env never block', () => {
    const {userData, env} = seat();

    expect(runSeatModelGuard('prompt', prompt('first session'), env)).toBe(0);

    lastRun(userData, 'claude-opus-5-5');
    expect(runSeatModelGuard('prompt', prompt('cli'), {...env, CLAUDE_CODE_ENTRYPOINT: 'cli'})).toBe(0);
    expect(runSeatModelGuard('prompt', prompt('no exec path'), {...env, CLAUDE_CODE_EXECPATH: undefined})).toBe(0);
    expect(runSeatModelGuard('prompt', prompt('no host id'), {...env, CLAUDE_CODE_HOST_SESSION_ID: undefined})).toBe(0);
    expect(runSeatModelGuard('prompt', {session_id: 'someone-else', prompt: 'x'}, env)).toBe(0);
    expect(runSeatModelGuard('prompt', null, env)).toBe(0);
    expect(runSeatModelGuard('unknown', prompt('x'), env)).toBe(0)
});

test('as a process: a malformed payload exits 0 and a mismatch exits 2 with the reason on stderr', () => {
    const {userData, env} = seat();
    lastRun(userData, 'claude-opus-5-5');

    const
        run     = (input, arg = 'prompt') => spawnSync(process.execPath, [HOOK, arg], {input, env: {...process.env, ...env}, encoding: 'utf8'}),
        blocked = run(JSON.stringify(prompt('hi')));

    expect(run('{not json').status).toBe(0);
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('This seat expects opus; this session runs fable')
});

test('a joined session whose prompt is missing or not a string fails open and logs nothing', () => {
    const {userData, env} = seat();
    lastRun(userData, 'claude-opus-5-5');

    [{session_id: SESSION_ID}, {session_id: SESSION_ID, prompt: null}, {session_id: SESSION_ID, prompt: 42}, {session_id: SESSION_ID, prompt: {text: 'hi'}}]
        .forEach(payload => expect(runSeatModelGuard('prompt', payload, env)).toBe(0));

    expect(fs.existsSync(path.join(userData, GUARD_DIR, 'model.log'))).toBe(false);
    expect(runSeatModelGuard('prompt', prompt('a string prompt still blocks'), env)).toBe(2)
});

test('an id that merely contains a family name is unknown, as current and as expected model', () => {
    expect(['not-a-claude-opus-model', 'mystery-fable-opus', 'claude-opus-fable', 'xopus', 'opus-latest-maybe'].map(modelFamily))
        .toEqual([null, null, null, null, null]);
    expect(['claude-haiku-4-5-20251001', 'opus[1m]', ' claude-sonnet-5 '].map(modelFamily)).toEqual(['haiku', 'opus', 'sonnet']);

    expect(decideSeatModelGuard({currentModel: 'not-a-claude-opus-model', expectedModel: 'claude-fable-5-1', prompt: 'x'}).block).toBe(false);
    expect(decideSeatModelGuard({currentModel: 'claude-fable-5-1', expectedModel: 'mystery-fable-opus', prompt: 'x'}).block).toBe(false)
});

test('the manifest projects both arms with bounded timeouts', () => {
    const
        events  = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).events,
        command = arm => hooks => hooks.flatMap(group => group.hooks).find(hook => hook.command.includes(`seatModelGuardHook.mjs" ${arm}`));

    expect(command('prompt')(events.UserPromptSubmit)).toMatchObject({type: 'command', timeout: 2});
    expect(command('stop')(events.Stop)).toMatchObject({type: 'command', timeout: 5})
});

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
    accountSharedWithAnotherSeat,
    readLastRunModel,
    readSessionRecord,
    resolveUserDataDir,
    runSeatModelGuard
} from '../../../../../../../ai/scripts/lifecycle/hooks/claude/seatModelGuardHook.mjs';

/**
 * The Claude Desktop seat model guard (`seatModelGuardHook.mjs`): a prompt is blocked while the
 * session's model family differs from the family the seat last ran, but only on an account another seat
 * shares; `model-ok` runs it on purpose, and every missing or unexpected input fails open. Seats follow
 * Fleet's `<agentsRoot>/<agentId>/harness/claude-desktop` layout, records the app's session-record
 * shape; ids are synthetic.
 */

const
    HOOK        = fileURLToPath(new URL('../../../../../../../ai/scripts/lifecycle/hooks/claude/seatModelGuardHook.mjs', import.meta.url)),
    MANIFEST    = fileURLToPath(new URL('../../../../../../../ai/scripts/lifecycle/hooks/claude/events.manifest.json', import.meta.url)),
    SESSION_ID  = 'abcdef12-3456-4789-abcd-ef0123456789',
    HOST_ID     = 'local_0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e',
    APP_VERSION = '2.37337.1';

/**
 * @summary Builds a fake seat in Fleet's layout holding one session record, and the env Desktop gives its CLI.
 * @param {Object|null} [record]  The record's fields; `null` writes no record.
 * @param {Object}      [options]
 * @param {String|null} [options.partnerAccount='account-uuid'] The account folder a second seat has
 * sessions under; the default shares this seat's account, `null` adds no second seat.
 * @param {Boolean}     [options.fleetLayout=true] `false` places the user-data dir outside Fleet's layout.
 * @returns {{userData: String, env: Object}}
 */
function seat(record = {model: 'claude-fable-5-1', cliSessionId: SESSION_ID}, {partnerAccount = 'account-uuid', fleetLayout = true} = {}) {
    const
        agentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-model-guard-')),
        userData   = fleetLayout ? path.join(agentsRoot, 'neo-opus-a', 'harness', 'claude-desktop') : path.join(agentsRoot, 'profile');

    fs.mkdirSync(userData, {recursive: true});

    if (record) {
        const dir = path.join(userData, 'claude-code-sessions', 'account-uuid', 'scope-uuid');

        fs.mkdirSync(dir, {recursive: true});
        fs.writeFileSync(path.join(dir, `${HOST_ID}.json`), JSON.stringify({sessionId: HOST_ID, title: 'x', ...record}))
    }

    if (partnerAccount) {
        fs.mkdirSync(path.join(agentsRoot, 'neo-fable-b', 'harness', 'claude-desktop', 'claude-code-sessions', partnerAccount), {recursive: true})
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

    expect(readSessionRecord(userData, HOST_ID, SESSION_ID)).toEqual({model: 'claude-fable-5-1', account: 'account-uuid'});
    expect(readSessionRecord(userData, HOST_ID, 'another-session')).toBeNull();
    expect(readSessionRecord(userData, '../../etc/passwd', SESSION_ID)).toBeNull();
    expect(readSessionRecord(userData, undefined, SESSION_ID)).toBeNull();
    expect(readSessionRecord(seat(null).userData, HOST_ID, SESSION_ID)).toBeNull();

    const broken = seat();
    fs.writeFileSync(path.join(broken.userData, 'claude-code-sessions', 'account-uuid', 'scope-uuid', `${HOST_ID}.json`), '{not json');
    expect(readSessionRecord(broken.userData, HOST_ID, SESSION_ID)).toBeNull()
});

test('an account no other seat uses never blocks: every family change there is a deliberate switch', () => {
    const solo = seat(undefined, {partnerAccount: null});
    lastRun(solo.userData, 'claude-opus-5-5');
    expect(accountSharedWithAnotherSeat(solo.userData, 'account-uuid')).toBe(false);
    expect(runSeatModelGuard('prompt', prompt('weekly switch to fable'), solo.env)).toBe(0);

    const otherAccount = seat(undefined, {partnerAccount: 'another-account'});
    lastRun(otherAccount.userData, 'claude-opus-5-5');
    expect(runSeatModelGuard('prompt', prompt('partner is on another account'), otherAccount.env)).toBe(0);

    const shared = seat();
    lastRun(shared.userData, 'claude-opus-5-5');
    expect(accountSharedWithAnotherSeat(shared.userData, 'account-uuid')).toBe(true);
    expect(runSeatModelGuard('prompt', prompt('the partner picked fable'), shared.env)).toBe(2)
});

test('outside Fleet\'s seat layout the sharing check fails open', () => {
    const {userData, env} = seat(undefined, {fleetLayout: false});
    lastRun(userData, 'claude-opus-5-5');

    expect(accountSharedWithAnotherSeat(userData, 'account-uuid')).toBe(false);
    expect(runSeatModelGuard('prompt', prompt('unknown layout'), env)).toBe(0)
});

/**
 * @summary A solo seat that last ran Opus, plus one sibling seat whose account entry `place` builds.
 * @param {Function} place Receives the sibling's `claude-code-sessions` path and creates its entry.
 * @returns {{userData: String, env: Object, sessions: String}}
 */
function soloWithSibling(place) {
    const fixture  = seat(undefined, {partnerAccount: null}),
          sessions = path.join(fixture.userData, '..', '..', '..', 'neo-fable-b', 'harness', 'claude-desktop', 'claude-code-sessions');

    fs.mkdirSync(sessions, {recursive: true});
    place(sessions);
    lastRun(fixture.userData, 'claude-opus-5-5');

    return {...fixture, sessions}
}

test('a regular file named like the account in a sibling seat is no sharing evidence', () => {
    const {userData, env} = soloWithSibling(sessions => fs.writeFileSync(path.join(sessions, 'account-uuid'), 'not a directory'));

    expect(accountSharedWithAnotherSeat(userData, 'account-uuid')).toBe(false);
    expect(runSeatModelGuard('prompt', prompt('a file is not a seat'), env)).toBe(0)
});

test('a symbolic link named like the account in a sibling seat is no sharing evidence', () => {
    const {userData, env} = soloWithSibling(sessions =>
        fs.symlinkSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unrelated-')), path.join(sessions, 'account-uuid')));

    expect(accountSharedWithAnotherSeat(userData, 'account-uuid')).toBe(false);
    expect(runSeatModelGuard('prompt', prompt('a link is not a seat'), env)).toBe(0)
});

test('a sibling listing that cannot be read fails open, even when the account directory is there', () => {
    // Root ignores permission bits, so the listing would succeed and the control would prove nothing.
    test.skip(process.getuid?.() === 0, 'permission bits do not bind root');

    const {userData, env, sessions} = soloWithSibling(sessions => fs.mkdirSync(path.join(sessions, 'account-uuid')));

    // Searchable but not listable: the account directory still stats, its listing refuses.
    fs.chmodSync(sessions, 0o311);

    try {
        expect(accountSharedWithAnotherSeat(userData, 'account-uuid')).toBe(false);
        expect(runSeatModelGuard('prompt', prompt('no listing, no evidence'), env)).toBe(0)
    } finally {
        fs.chmodSync(sessions, 0o755)
    }
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

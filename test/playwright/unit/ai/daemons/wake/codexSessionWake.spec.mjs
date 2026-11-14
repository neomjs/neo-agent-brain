import {test, expect}                                                                                                 from '@playwright/test';
import Database                                                                                                       from 'better-sqlite3';
import fs                                                                                                             from 'node:fs/promises';
import os                                                                                                             from 'node:os';
import path                                                                                                           from 'node:path';
import {listCodexWakeTargets, readCodexWakeActivity, readCodexWakeTarget, sendCodexSessionWake, readCodexWakeReceipt} from '../../../../../../ai/daemons/wake/codexSessionWake.mjs';

test.describe('Codex session wake', () => {
    const id      = '01a1da8b-d4ea-76c0-9d88-f413805c5389', turn = '01a1da8b-fbf9-7c61-afc0-cfd98cc35ffd',
          queueId = '01a1da8b-d525-72a0-8215-fe8590975cbf';
    let home, file;
    const line = value => JSON.stringify(value) + '\n';
    const meta = (overrides = {}) => ({type: 'session_meta', payload: {
        id, session_id: id, source: 'vscode', thread_source: 'user', originator: 'Codex Desktop', ...overrides
    }});
    const start = (overrides = {}) => ({type: 'event_msg', payload: {
        type            : 'task_started', turn_id: turn, root_turn_id: turn,
        turn_attribution: {turn_trigger: 'queue', parent_turn_id: null, ...overrides}
    }});
    const message = (text, turnId = turn) => ({type: 'response_item', payload: {
        type                                      : 'message', role: 'user', content: [{type: 'input_text', text}],
        internal_chat_message_metadata_passthrough: {turn_id: turnId}
    }});

    test.beforeEach(async () => {
        home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-wake-unit-')));
        const dir = path.join(home, 'sessions', '2026', '11', '14');
        await fs.mkdir(dir, {recursive: true});
        file = path.join(dir, `rollout-2026-11-14-${id}.jsonl`);
        await fs.writeFile(file, line(meta()) + line(start()) + line({type: 'event_msg', payload: {type: 'task_complete', turn_id: turn}}))
        const db = new Database(path.join(home, 'state_5.sqlite'));
        db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, created_at_ms INTEGER, archived INTEGER, source TEXT, thread_source TEXT, originator TEXT, attached_thread_parent_id TEXT)');
        db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL)').run(id, file, home, 1, 'vscode', 'user', 'Codex Desktop');
        db.close()
    });
    test.afterEach(async () => fs.rm(home, {recursive: true, force: true}));

    test('admits only an explicitly selected Desktop root; helper and ambiguous roots fail closed', async () => {
        expect((await readCodexWakeTarget({home, threadId: id})).threadId).toBe(id);
        await fs.writeFile(file, line(meta({source: {subagent: {thread_spawn: {parent_thread_id: id}}}, thread_source: 'subagent'})));
        await expect(readCodexWakeTarget({home, threadId: id})).rejects.toThrow('not a proven');
        await fs.writeFile(file, line(meta()));
        await fs.writeFile(file, line(meta({forked_from_id: id})));
        await expect(readCodexWakeTarget({home, threadId: id})).rejects.toThrow('fork')
    });

    test('queues with isolated environment and reports enqueue, never delivery', async () => {
        let args;
        const result = await sendCodexSessionWake({binary: '/bin/codex', home, threadId: id, text: `[NEO_WAKE_V1:${queueId}] [WAKE]`,
            verifyAdmission: async () => ({verified: true}),
            execute        : async (...input) => { args = input; return {stdout: `Queued message ${queueId} for thread ${id}.\n`} }});
        expect(result).toMatchObject({state: 'enqueued', threadId: id, queueId, receiptOffset: expect.any(Number)});
        expect(args[1]).toEqual(['queue', '--thread', id, '--message', `[NEO_WAKE_V1:${queueId}] [WAKE]`]);
        expect(args[2].env.CODEX_HOME).toBe(home);
        expect(Object.keys(args[2].env).sort()).toEqual(['CODEX_HOME', 'HOME', 'PATH']);
        await expect(sendCodexSessionWake({binary: '/bin/codex', home, threadId: id, text: `[NEO_WAKE_V1:${queueId}] [WAKE]`,
            verifyAdmission: async () => ({verified: true}), execute: async () => ({stdout: 'success'})})).rejects.toThrow('ambiguous');
        await expect(sendCodexSessionWake({binary: '/bin/codex', home, threadId: id, text: `[NEO_WAKE_V1:${queueId}] [WAKE]`,
            execute: async () => ({})})).rejects.toThrow('not runtime verified')
    });

    test('latest start wins; forks are excluded and an unusable latest root fails closed', async () => {
        const newer     = '01a1da8b-fbf9-7c61-afc0-cfd98cc35ffd';
        const newerFile = path.join(path.dirname(file), `rollout-2026-11-14-${newer}.jsonl`);
        const db        = new Database(path.join(home, 'state_5.sqlite'));
        db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL)').run(newer, newerFile, home, 2, 'vscode', 'user', 'Codex Desktop');
        await fs.writeFile(newerFile, line({type: 'session_meta', payload: {id: newer, session_id: newer,
            source: 'vscode', thread_source: 'user', originator: 'Codex Desktop', forked_from_id: id}}));
        expect((await listCodexWakeTargets({home, workspaceRoot: home}))[0].threadId).toBe(id);
        await fs.writeFile(newerFile, line({type: 'session_meta', payload: {id: newer, session_id: newer,
            source: 'vscode', thread_source: 'user', originator: 'Codex Desktop'}}));
        expect((await listCodexWakeTargets({home, workspaceRoot: home}))[0].threadId).toBe(newer);
        await expect(sendCodexSessionWake({binary: '/bin/codex', home, threadId: id, text: `[NEO_WAKE_V1:${queueId}] [WAKE]`, execute: async () => ({})})).rejects.toThrow('no longer latest');
        await fs.writeFile(newerFile, 'malformed\n');
        await expect(listCodexWakeTargets({home, workspaceRoot: home})).rejects.toThrow('Invalid');
        await fs.writeFile(newerFile, line({type: 'session_meta', payload: {id: newer, session_id: newer,
            source: 'vscode', thread_source: 'user', originator: 'Codex Desktop'}}));
        db.prepare('UPDATE threads SET created_at_ms = 1 WHERE id = ?').run(newer);
        await expect(listCodexWakeTargets({home, workspaceRoot: home})).rejects.toThrow('ambiguous');
        db.prepare('UPDATE threads SET archived = 1 WHERE id = ?').run(newer);
        await expect(listCodexWakeTargets({home, workspaceRoot: home})).rejects.toThrow('not a proven');
        db.close()
    });

    test('holds busy and unknown activity instead of queueing', async () => {
        expect(await readCodexWakeActivity({home, threadId: id})).toEqual({state: 'idle'});
        await fs.appendFile(file, line(start()));
        expect(await readCodexWakeActivity({home, threadId: id})).toEqual({state: 'busy'});
        await expect(sendCodexSessionWake({binary: '/bin/codex', home, threadId: id, text: `[NEO_WAKE_V1:${queueId}] [WAKE]`, execute: async () => ({})})).rejects.toThrow('busy');
        await fs.writeFile(file, line(meta()));
        expect(await readCodexWakeActivity({home, threadId: id})).toEqual({state: 'unknown'});
        await expect(sendCodexSessionWake({binary: '/bin/codex', home, threadId: id, text: `[NEO_WAKE_V1:${queueId}] [WAKE]`, execute: async () => ({})})).rejects.toThrow('unknown')
    });

    test('receipt requires the exact text and a matching queued root turn, not a substring or another turn', async () => {
        const text = `[NEO_WAKE_V1:${queueId}] [WAKE]`;
        await fs.appendFile(file, line(start()) + line(message(text)));
        expect(await readCodexWakeReceipt({home, threadId: id, text, receiptToken: id})).toEqual({state: 'unknown'});
        const context = turnId => ({type: 'response_item', payload: {type: 'message', role: 'developer',
            content                                   : [{type: 'input_text', text: `digest\n[NEO_WAKE_RECEIVED:${id}]`}],
            internal_chat_message_metadata_passthrough: {turn_id: turnId, content_item_kinds: ['hooks.additional_context'],
                content_item_metadata: [{provenance: {type: 'harness', hook: true}}]}}});
        await fs.appendFile(file, line(context('other')));
        expect(await readCodexWakeReceipt({home, threadId: id, text, receiptToken: id})).toEqual({state: 'unknown'});
        await fs.appendFile(file, line(context(turn)));
        expect(await readCodexWakeReceipt({home, threadId: id, text, receiptToken: turn})).toEqual({state: 'unknown'});
        expect(await readCodexWakeReceipt({home, threadId: id, text, receiptToken: id})).toEqual({state: 'turn-started', threadId: id, turnId: turn});
        await fs.appendFile(file, line(message(text)));
        await expect(readCodexWakeReceipt({home, threadId: id, text, receiptToken: id})).rejects.toThrow('ambiguous')
    });
});

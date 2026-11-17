import {test, expect}                                                                                                                                from '@playwright/test';
import crypto                                                                                                                                        from 'node:crypto';
import Database                                                                                                                                      from 'better-sqlite3';
import fs                                                                                                                                            from 'node:fs/promises';
import os                                                                                                                                            from 'node:os';
import path                                                                                                                                          from 'node:path';
import {listCodexWakeTargets, materializeCodexWakeAdmission, readCodexWakeActivity, readCodexWakeTarget, sendCodexSessionWake, readCodexWakeReceipt} from '../../../../../../ai/daemons/wake/codexSessionWake.mjs';

test.describe('Codex wake hook materialization', () => {
    let root, home, other, options;
    test.beforeEach(async () => {
        root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-wake-hooks-')));
        home = path.join(root, 'first'); other = path.join(root, 'second');
        await Promise.all([fs.mkdir(home), fs.mkdir(other)]);
        options = {home, workspaceRoot: root, nodePath: '/bin/node', modulePath: '/opt/neo/codexWakeHook.mjs',
            manifestPath: '/opt/neo/routes.json', stateDir: '/opt/neo/state', agentId: 'neo-gpt-fixture'}
    });
    test.afterEach(async () => fs.rm(root, {recursive: true, force: true}));

    test('preserves foreign hooks and trust, and identical starts preserve bytes and mode in each home', async () => {
        const foreign = {hooks: {Stop: [{hooks: [{type: 'command', command: 'foreign-stop'}]}],
            UserPromptSubmit: [{hooks: [{type: 'command', command: 'foreign-submit'}, {type: 'prompt', prompt: 'foreign'}]}]}, extra: {owner: 'other'}};
        const file = path.join(home, 'hooks.json'), trust = path.join(home, 'config.toml');
        await fs.writeFile(file, JSON.stringify(foreign), {mode: 0o640});
        await fs.writeFile(trust, 'trusted_hash = "unchanged"\n');
        const initialTrust = await fs.readFile(trust, 'utf8');
        const result       = await materializeCodexWakeAdmission(options);
        const first        = await fs.readFile(file, 'utf8'), parsed = JSON.parse(first), stat = await fs.stat(file);
        expect(stat.mode & 0o777).toBe(0o640);
        expect(parsed.extra).toEqual(foreign.extra);
        expect(parsed.hooks.Stop).toEqual(foreign.hooks.Stop);
        expect(parsed.hooks.UserPromptSubmit[0]).toEqual(foreign.hooks.UserPromptSubmit[0]);
        expect(parsed.hooks.UserPromptSubmit[1].hooks[0].command).toBe(result.command);
        await Promise.all(Array.from({length: 5}, () => materializeCodexWakeAdmission(options)));
        expect(await fs.readFile(file, 'utf8')).toBe(first);
        expect((await fs.stat(file)).mode & 0o777).toBe(stat.mode & 0o777);
        expect(await fs.readFile(trust, 'utf8')).toBe(initialTrust);
        await materializeCodexWakeAdmission({...options, home: other, agentId: 'neo-gpt-other'});
        expect((await fs.readFile(path.join(other, 'hooks.json'), 'utf8'))).not.toBe(first);
        expect(await fs.readFile(file, 'utf8')).toBe(first)
    });

    test('refuses altered, disabled and duplicate owned hooks without changing foreign bytes', async () => {
        const file = path.join(home, 'hooks.json');
        await materializeCodexWakeAdmission(options);
        const original = JSON.parse(await fs.readFile(file, 'utf8'));
        for (const mutate of [
            x => { x.hooks.UserPromptSubmit[0].hooks[0].command += ' --other' },
            x => { x.hooks.UserPromptSubmit[0].hooks[0].enabled = false },
            x => { x.hooks.UserPromptSubmit.push(structuredClone(x.hooks.UserPromptSubmit[0])) },
            x => { x.hooks.UserPromptSubmit[0].matcher = 'foreign' },
            x => { x.hooks.UserPromptSubmit[0].hooks[0].statusMessage = 'foreign' }
        ]) {
            const value = structuredClone(original); mutate(value);
            const bytes = JSON.stringify(value, null, 1) + '\n';
            await fs.writeFile(file, bytes);
            await expect(materializeCodexWakeAdmission(options)).rejects.toThrow('Conflicting or ambiguous');
            expect(await fs.readFile(file, 'utf8')).toBe(bytes)
        }
    });

    test('reclaims a dead owner lock and refuses a symlink target', async () => {
        const file = path.join(home, 'hooks.json');
        await fs.writeFile(file + '.neo-wake.lock', JSON.stringify({pid: 2147483647, startedAt: 1}));
        await materializeCodexWakeAdmission(options);
        await fs.rm(file);
        const outside = path.join(other, 'outside.json');
        await fs.writeFile(outside, '{}'); await fs.symlink(outside, file);
        await expect(materializeCodexWakeAdmission(options)).rejects.toThrow('regular file');
        expect(await fs.readFile(outside, 'utf8')).toBe('{}')
    })

    test('refuses malformed foreign hook containers without replacing them', async () => {
        const file = path.join(home, 'hooks.json');
        for (const value of [null, false, 0, [], 'foreign']) {
            const bytes = JSON.stringify({hooks: value});
            await fs.writeFile(file, bytes);
            await expect(materializeCodexWakeAdmission(options)).rejects.toThrow('Invalid Codex hooks config');
            expect(await fs.readFile(file, 'utf8')).toBe(bytes)
        }
    })

    test('upgrades only an authenticated prior seat command in place without changing trust', async () => {
        const file = path.join(home, 'hooks.json'), trust = path.join(home, 'config.toml');
        const old  = {...options, nodePath: '/old/node', modulePath: '/old/codexWakeHook.mjs'};
        await fs.writeFile(file, JSON.stringify({hooks: {UserPromptSubmit: [
            {hooks: [{type: 'command', command: 'foreign-before'}]},
            {hooks: [{type: 'command', command: 'foreign-after'}]}
        ]}}));
        await fs.writeFile(trust, 'trusted_hash = "old-vendor-hash"\n');
        await materializeCodexWakeAdmission(old);
        const prior  = {...old, family: 'codex-desktop'};
        const before = await fs.readFile(file, 'utf8');
        await expect(materializeCodexWakeAdmission(options)).rejects.toThrow('Conflicting or ambiguous');
        await expect(materializeCodexWakeAdmission({...options, previous: {...prior, home: other}})).rejects.toThrow('does not match');
        expect(await fs.readFile(file, 'utf8')).toBe(before);
        const result = await materializeCodexWakeAdmission({...options, previous: prior});
        const groups = JSON.parse(await fs.readFile(file, 'utf8')).hooks.UserPromptSubmit;
        expect(groups.map(group => group.hooks[0].command)).toEqual(['foreign-before', 'foreign-after', result.command]);
        expect(await fs.readFile(trust, 'utf8')).toBe('trusted_hash = "old-vendor-hash"\n');
        const after = await fs.readFile(file, 'utf8');
        await materializeCodexWakeAdmission({...options, previous: prior});
        expect(await fs.readFile(file, 'utf8')).toBe(after)
    })
});

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
        await fs.writeFile(file, line(meta()) + line(start()) + line({type: 'event_msg', payload: {type: 'task_complete', turn_id: turn, root_turn_id: turn}}))
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
        expect(result).toMatchObject({state: 'enqueued', threadId: id, queueId, receiptOffset: {offset: expect.any(Number), device: expect.any(Number), inode: expect.any(Number)}});
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


    test('the 101-row sentinel holds only when an unseen newest root or tie remains possible', async () => {
        const db     = new Database(path.join(home, 'state_5.sqlite'));
        const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL)');
        const ids    = [];
        try {
            for (let i = 0; i < 101; i++) {
                const candidate = crypto.randomUUID();
                const rollout   = path.join(path.dirname(file), `rollout-2026-11-14-${candidate}.jsonl`);
                await fs.writeFile(rollout, line(meta({id:candidate, session_id:candidate, forked_from_id:id})));
                insert.run(candidate, rollout, home, 2, 'vscode', 'user', 'Codex Desktop');
                ids.push(candidate);
            }
            // 101 newer excluded forks leave the true latest root beyond the query bound.
            await expect(listCodexWakeTargets({home, workspaceRoot:home})).rejects.toThrow('candidate bound');
            db.prepare('UPDATE threads SET created_at_ms=3 WHERE id=?').run(id);
            // The sentinel is strictly older than the proven root: no unseen tie can exist.
            expect((await listCodexWakeTargets({home, workspaceRoot:home}))[0].threadId).toBe(id);
            db.prepare('UPDATE threads SET created_at_ms=3 WHERE id!=?').run(id);
            // Even if all fetched ties except the root are excluded, a further tied root may exist.
            await expect(listCodexWakeTargets({home, workspaceRoot:home})).rejects.toThrow('candidate bound');
        } finally { db.close() }
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

    test('reverse lifecycle scan handles long rows and refuses an incomplete tail', async () => {
        await fs.writeFile(file, line(meta()) + line(start()) + line({type: 'padding', payload: 'x'.repeat(5 * 1024 * 1024)}));
        expect(await readCodexWakeActivity({home, threadId: id})).toEqual({state: 'busy'});
        await fs.appendFile(file, line({type: 'event_msg', payload: {type: 'task_complete', turn_id: turn, root_turn_id: turn}}));
        expect(await readCodexWakeActivity({home, threadId: id})).toEqual({state: 'idle'});
        await fs.appendFile(file, line({type: 'event_msg', payload: {type: 'task_started', turn_id: 'child', root_turn_id: turn}}));
        expect(await readCodexWakeActivity({home, threadId: id})).toEqual({state: 'idle'});
        await fs.appendFile(file, '{"type":');
        expect(await readCodexWakeActivity({home, threadId: id})).toEqual({state: 'unknown'});
        await fs.writeFile(file, line(meta()) + line({type: 'event_msg', payload: {type: 'task_complete', turn_id: turn, root_turn_id: turn}}));
        expect(await readCodexWakeActivity({home, threadId: id})).toEqual({state: 'idle'})
    });

    test('receipt requires the exact text and a matching queued root turn, not a substring or another turn', async () => {
        const text          = `[NEO_WAKE_V1:${queueId}] [WAKE]`;
        const receiptOffset = (await readCodexWakeTarget({home, threadId: id})).receiptOffset;
        await fs.appendFile(file, line(start()) + line(message(text)));
        expect(await readCodexWakeReceipt({home, threadId: id, text, receiptOffset, receiptToken: id})).toEqual({state: 'unknown'});
        const context = turnId => ({type: 'response_item', payload: {type: 'message', role: 'developer',
            content                                   : [{type: 'input_text', text: `digest\n[NEO_WAKE_RECEIVED:${id}]`}],
            internal_chat_message_metadata_passthrough: {turn_id: turnId, content_item_kinds: ['hooks.additional_context'],
                content_item_metadata: [{provenance: {type: 'harness', hook: true}}]}}});
        await fs.appendFile(file, line(context('other')));
        expect(await readCodexWakeReceipt({home, threadId: id, text, receiptOffset, receiptToken: id})).toEqual({state: 'unknown'});
        await fs.appendFile(file, line(context(turn)));
        expect(await readCodexWakeReceipt({home, threadId: id, text, receiptOffset, receiptToken: turn})).toEqual({state: 'unknown'});
        expect(await readCodexWakeReceipt({home, threadId: id, text, receiptOffset, receiptToken: id})).toEqual({state: 'turn-started', threadId: id, turnId: turn});
        await fs.appendFile(file, line(start()) + line(message(text)) + line(context(turn)));
        await expect(readCodexWakeReceipt({home, threadId: id, text, receiptOffset, receiptToken: id})).rejects.toThrow('ambiguous')
    });

    test('a wake turn that ends without any hook acknowledgement reads as unacknowledged; a running or acknowledged one does not', async () => {
        const text          = `[NEO_WAKE_V1:${queueId}] [WAKE]`;
        const receiptOffset = (await readCodexWakeTarget({home, threadId: id})).receiptOffset;
        const read          = receiptToken => readCodexWakeReceipt({home, threadId: id, text, receiptOffset, receiptToken});
        const end           = (type, turnId = turn) => line({type: 'event_msg', payload: {type, turn_id: turnId, root_turn_id: turnId}});
        const context       = token => line({type: 'response_item', payload: {type: 'message', role: 'developer',
            content                                   : [{type: 'input_text', text: `digest\n[NEO_WAKE_RECEIVED:${token}]`}],
            internal_chat_message_metadata_passthrough: {turn_id: turn, content_item_kinds: ['hooks.additional_context'],
                content_item_metadata: [{provenance: {type: 'harness', hook: true}}]}}});
        await fs.appendFile(file, line(start()) + line(message(text)));
        expect(await read()).toEqual({state: 'unknown'});
        await fs.appendFile(file, end('task_complete', queueId));
        expect(await read()).toEqual({state: 'unknown'});
        await fs.appendFile(file, end('turn_aborted'));
        expect(await read()).toEqual({state: 'turn-unacknowledged', threadId: id, turnId: turn});
        await expect(read('not-a-token')).rejects.toThrow('Invalid Codex receipt token');

        await fs.truncate(file, receiptOffset.offset);
        await fs.appendFile(file, line(start()) + line(message(text)) + context(id) + end('task_complete'));
        expect(await read()).toEqual({state: 'unknown'});
        expect(await read(id)).toEqual({state: 'turn-started', threadId: id, turnId: turn})
    });

    test('streams large post-send logs and refuses rotation or incomplete data', async () => {
        const text  = `[NEO_WAKE_V1:${queueId}] [WAKE]`, receiptToken = id;
        const proof = line(start()) + line(message(text)) + line({type: 'response_item', payload: {
            type                                      : 'message', role: 'developer', content: [{type: 'input_text', text: `digest\n[NEO_WAKE_RECEIVED:${receiptToken}]`}],
            internal_chat_message_metadata_passthrough: {turn_id: turn, content_item_kinds: ['hooks.additional_context'],
                content_item_metadata: [{provenance: {type: 'harness', hook: true}}]}
        }});
        const padding = line({type: 'padding', payload: 'x'.repeat(1024)}).repeat(5200);
        const cursor  = (await readCodexWakeTarget({home, threadId: id})).receiptOffset;
        const read    = () => readCodexWakeReceipt({home, threadId: id, text, receiptToken, receiptOffset: cursor});
        await fs.appendFile(file, proof + padding);
        expect(await read()).toEqual({state: 'turn-started', threadId: id, turnId: turn});
        await fs.truncate(file, cursor.offset);
        await fs.appendFile(file, padding + proof);
        expect(await read()).toEqual({state: 'turn-started', threadId: id, turnId: turn});
        await fs.truncate(file, cursor.offset);
        await fs.appendFile(file, padding);
        expect(await read()).toEqual({state: 'unknown'});
        await fs.appendFile(file, proof + '{"partial":');
        expect(await read()).toEqual({state: 'unknown'});
        await fs.truncate(file, cursor.offset);
        await fs.appendFile(file, 'invalid\n' + proof);
        expect(await read()).toEqual({state: 'unknown'});
        await fs.writeFile(file, line(meta()) + line({type: 'changed', payload: 'z'.repeat(cursor.offset)}) + proof);
        expect(await read()).toEqual({state: 'unknown'});
        await fs.rename(file, file + '.old');
        await fs.writeFile(file, line(meta()) + proof);
        expect(await read()).toEqual({state: 'unknown'})
    });
});

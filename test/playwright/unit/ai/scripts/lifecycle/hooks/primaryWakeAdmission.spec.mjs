import {test, expect}                                            from '@playwright/test';
import fs                                                        from 'node:fs/promises';
import {createHash}                                              from 'node:crypto';
import {execFileSync}                                            from 'node:child_process';
import os                                                        from 'node:os';
import path                                                      from 'node:path';
import {materializeCodexWakeAdmission, verifyCodexWakeAdmission} from '../../../../../../../ai/daemons/wake/codexSessionWake.mjs';
import {decidePrimaryWakeAdmission}                              from '../../../../../../../ai/daemons/wake/codexWakeHook.mjs';

test('only an exact canary envelope for the selected root is admitted', async () => {
    const session = '01a1dabf-2363-77d1-8214-100d0ba4de47';
    const nonce   = '01a1dabf-23f6-7202-8120-8694f91ab226';
    const payload = {session_id: session, turn_id: nonce, hook_event_name: 'UserPromptSubmit', prompt: `[NEO_WAKE_V1:${nonce}] [WAKE]`};
    const options = {manifestPath: '/seat/manifest', stateDir: '/seat/state', agentId: '@seat', consume: async ({threadId}) => ({admitted: threadId === session, digest: 'private digest'})};
    expect(await decidePrimaryWakeAdmission(payload, options)).toEqual({hookSpecificOutput: {hookEventName: 'UserPromptSubmit', additionalContext: 'private digest'}});
    expect((await decidePrimaryWakeAdmission({...payload, session_id: nonce}, options)).decision).toBe('block');
    expect((await decidePrimaryWakeAdmission({...payload, agent_id: 'child'}, options)).decision).toBe('block');
    expect((await decidePrimaryWakeAdmission({...payload, prompt: '[NEO_WAKE_V1:bad] [WAKE]'}, options)).decision).toBe('block');
    expect((await decidePrimaryWakeAdmission(payload, {...options, consume: async () => { throw new Error('offline') }})).decision).toBe('block');
    expect(await decidePrimaryWakeAdmission({...payload, prompt: 'ordinary human prompt'}, {})).toEqual({})
});

test('materialization preserves other hooks and is idempotent without granting trust', async () => {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-hook-unit-')));
    try {
        const file = path.join(home, 'hooks.json');
        await fs.writeFile(file, JSON.stringify({hooks: {Stop: [{hooks: [{type: 'command', command: 'existing'}]}]}}));
        const options = {home, workspaceRoot: "/seat/repo's", nodePath: '/usr/bin/node', modulePath: '/trusted/hook.mjs', manifestPath: "/seat/manifest's", stateDir: '/seat/state', agentId: '@seat'};
        const first   = await materializeCodexWakeAdmission(options);
        const before  = await fs.readFile(file, 'utf8');
        const second  = await materializeCodexWakeAdmission(options);
        const config  = JSON.parse(await fs.readFile(file, 'utf8'));
        expect(second).toEqual(first);
        expect(await fs.readFile(file, 'utf8')).toBe(before);
        expect(config.hooks.Stop[0].hooks[0].command).toBe('existing');
        expect(config.hooks.UserPromptSubmit).toHaveLength(1);
        expect(first.command).toContain("'\\''")
    } finally { await fs.rm(home, {recursive: true, force: true}) }
});

test('verification requires trusted exact hook and same-process epoch marker', async () => {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-proof-unit-')));
    try {
        const threadId   = '01a1dabf-2363-77d1-8214-100d0ba4de47', stateDir = path.join(home, 'state');
        const modulePath = path.resolve('ai/daemons/wake/codexWakeHook.mjs');
        const options    = {home, workspaceRoot: home, nodePath: process.execPath, modulePath, manifestPath: path.join(home, 'manifest'), stateDir, agentId: '@seat'};
        const installed  = await materializeCodexWakeAdmission(options);
        const hash       = bytes => createHash('sha256').update(bytes).digest('hex');
        await fs.mkdir(path.join(stateDir, 'codex-hook-presence'), {recursive: true});
        const startedAt = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], {encoding: 'utf8'}).trim();
        await fs.writeFile(path.join(stateDir, 'codex-hook-presence', `${threadId}.json`), JSON.stringify({sessionId: threadId, turnId: threadId,
            agentId  : '@seat', configHash: hash(await fs.readFile(installed.sourcePath)), moduleHash: hash(await fs.readFile(modulePath)),
            ancestors: [{pid: process.pid, startedAt}], observedAt: Date.now()}));
        const hook = {sourcePath: installed.sourcePath, eventName: 'userPromptSubmit', command: installed.command,
            enabled: true, trustStatus: 'trusted', currentHash: 'sha256:fixture'};
        const readInventory = async () => ({data: [{cwd: home, errors: [], hooks: [hook]}]});
        const check         = {...options, binary: '/bin/codex', threadId, runtimePid: process.pid, readInventory};
        expect((await verifyCodexWakeAdmission(check)).verified).toBe(true);
        hook.trustStatus = 'modified';
        expect((await verifyCodexWakeAdmission(check)).verified).toBe(false);
        hook.trustStatus = 'trusted';
        await fs.appendFile(installed.sourcePath, ' ');
        expect((await verifyCodexWakeAdmission(check)).verified).toBe(false)
    } finally { await fs.rm(home, {recursive: true, force: true}) }
});

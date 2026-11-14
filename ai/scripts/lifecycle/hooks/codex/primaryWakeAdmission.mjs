/**
 * @module ai/scripts/lifecycle/hooks/codex/primaryWakeAdmission
 * @summary Canary UserPromptSubmit guard for opaque Codex wake tokens.
 * A trusted, installed hook is required: an absent or untrusted hook cannot enforce this guard.
 */
import path                     from 'node:path';
import {fileURLToPath}          from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync}           from 'node:child_process';
import fs                       from 'node:fs/promises';

const PREFIX = '[NEO_WAKE_V1:', TOKEN = /^\[NEO_WAKE_V1:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\] \[WAKE\]$/i;

/**
 * @summary Refuses a canary wake when its receiving thread is not the current selected root.
 * @param {Object} payload Codex UserPromptSubmit payload.
 * @param {Object} options
 * @param {String} options.home Seat Codex home.
 * @param {String} options.workspaceRoot Seat's exact workspace.
 * @param {Function} [options.listTargets] Test seam for the indexed root selector.
 * @returns {Promise<Object>} Empty output for ordinary or admitted prompts; block otherwise.
 */
export async function decidePrimaryWakeAdmission(payload, {manifestPath, stateDir, agentId, consume} = {}) {
    const prompt = payload?.prompt;
    if (typeof prompt !== 'string' || !prompt.startsWith(PREFIX)) return {};
    const refuse = {decision: 'block', reason: 'Wake deferred: this session is not the proven current seat root.'};
    const match  = TOKEN.exec(prompt);
    if (!match || !path.isAbsolute(manifestPath || '') || !path.isAbsolute(stateDir || '') || !agentId ||
        typeof payload?.session_id !== 'string' || typeof payload?.turn_id !== 'string' || payload.agent_id != null || payload.hook_event_name !== 'UserPromptSubmit') return refuse;
    try {
        const consumer = consume || (await import('../../../../daemons/wake/fleetPrimarySessionWake.mjs')).consumeNativeWakePrompt;
        const result   = await consumer({manifestPath, stateDir, agentId, family: 'codex-desktop', threadId: payload.session_id, turnId: payload.turn_id, nonce: match[1]});
        return result?.admitted === true && typeof result.digest === 'string' && result.digest
            ? {hookSpecificOutput: {hookEventName: 'UserPromptSubmit', additionalContext: result.digest}}
            : refuse
    } catch {
        return refuse
    }
}
/**
 * @summary Records an ordinary submit-hook invocation without storing prompt contents.
 * @param {Object} payload Native hook payload.
 * @param {Object} options Trusted canary paths and identity.
 * @returns {Promise<void>}
 */
export async function writePrimaryWakePresence(payload, {home, stateDir, agentId}) {
    if (!path.isAbsolute(home || '') || !path.isAbsolute(stateDir || '') || !agentId ||
        !/^[0-9a-f-]{36}$/i.test(payload?.session_id || '') || !payload?.turn_id || payload.agent_id != null) return;
    const hash       = bytes => createHash('sha256').update(bytes).digest('hex');
    const configHash = hash(await fs.readFile(path.join(home, 'hooks.json'))),
          moduleHash = hash(await fs.readFile(fileURLToPath(import.meta.url))), chain = [];
    let pid = process.ppid;
    for (let i = 0; i < 12 && pid > 1; i++) {
        const output = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'lstart='], {encoding: 'utf8', timeout: 1000}).trim();
        const match  = /^(\d+)\s+(.+)$/.exec(output);
        if (!match) break;
        chain.push({pid, startedAt: match[2]}); pid = Number(match[1])
    }
    const dir = path.join(stateDir, 'codex-hook-presence');
    await fs.mkdir(dir, {recursive: true, mode: 0o700});
    const file = path.join(dir, `${payload.session_id}.json`), tmp = `${file}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(tmp, JSON.stringify({sessionId: payload.session_id, turnId: payload.turn_id,
            agentId, configHash, moduleHash, ancestors: chain, observedAt: Date.now()}), {mode: 0o600, flag: 'wx'});
        await fs.rename(tmp, file)
    } finally { await fs.rm(tmp, {force: true}) }
}

/** @summary Reads one bounded hook payload and writes the admission decision. */
async function main() {
    let input = '';
    for await (const chunk of process.stdin) {
        input += chunk;
        if (input.length > 1048576) { process.stdout.write('{}'); return }
    }
    let payload;
    try { payload = JSON.parse(input) } catch { process.stdout.write('{}'); return }
    const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1] };
    if (typeof payload?.prompt === 'string' && !payload.prompt.startsWith(PREFIX) && payload.hook_event_name === 'UserPromptSubmit') {
        // Presence is best effort and never changes an ordinary prompt's outcome.
        try { await writePrimaryWakePresence(payload, {home: process.env.CODEX_HOME, stateDir: arg('--state-dir'), agentId: arg('--agent-id')}) } catch {}
    }
    const decision = await decidePrimaryWakeAdmission(payload, {
        manifestPath: arg('--manifest'), stateDir: arg('--state-dir'), agentId: arg('--agent-id')
    });
    process.stdout.write(JSON.stringify(decision))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(() => process.stdout.write('{}'))
}

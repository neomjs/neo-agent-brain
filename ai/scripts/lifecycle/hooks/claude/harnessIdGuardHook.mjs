import {pathToFileURL} from 'node:url';

/**
 * @module ai/scripts/lifecycle/hooks/claude/harnessIdGuardHook
 * @summary Claude Code `PreToolUse` guard: a seat never publishes its own harness session id.
 *
 * Memory Core mints its own session ids. The harness's id addresses records whose access control is
 * not ours, so it never goes into an artifact, a receipt, a written file or `add_memory`'s
 * `sessionId`. Only the seat knows that id when it publishes — a body lint cannot tell a harness UUID
 * from a Memory Core UUID — so the check sits here, on the payload's own `session_id`.
 *
 * It runs before every call its matcher selects, so it imports nothing beyond node builtins, and it
 * fails open: a malformed payload passes, because a broken guard must never block ordinary work.
 */

/**
 * @summary The shortest `session_id` the guard matches. A shorter value would match ordinary text.
 * @type {Number}
 */
export const MIN_SESSION_ID_LENGTH = 16;

/**
 * @summary What the agent reads when a call is refused. It names the remedy and never the id.
 * @type {String}
 */
export const HARNESS_ID_GUARD_MESSAGE = 'This call carries this session\'s harness session id. Harness ids never go into ' +
    'artifacts, receipts, written files or add_memory\'s sessionId. Stamp the Memory Core session id that add_memory ' +
    'echoes, write "this session", or reach your own transcript through a glob rather than its literal path.';

/**
 * @summary Decides one `PreToolUse` payload. Pure.
 * @param {*} payload The hook's parsed stdin: `session_id` and `tool_input`.
 * @returns {{decision: 'block', reason: String}|null} `null` lets the call run.
 */
export function decideHarnessIdGuard(payload) {
    const sessionId = typeof payload?.session_id === 'string' ? payload.session_id.trim().toLowerCase() : '';

    if (sessionId.length < MIN_SESSION_ID_LENGTH || payload.tool_input == null) return null;

    return JSON.stringify(payload.tool_input).toLowerCase().includes(sessionId)
        ? {decision: 'block', reason: HARNESS_ID_GUARD_MESSAGE}
        : null
}

function parseHookPayload(raw) {
    try {
        return JSON.parse(raw)
    } catch {
        return null
    }
}

async function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data',  chunk => data += chunk);
        process.stdin.on('end',   ()    => resolve(data));
        process.stdin.on('error', reject);
    });
}

async function main() {
    const decision = decideHarnessIdGuard(parseHookPayload(await readStdin()));

    if (decision) {
        process.stdout.write(`${JSON.stringify(decision)}\n`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main().catch(() => {});
}

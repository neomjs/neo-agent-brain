import {pathToFileURL} from 'node:url';

/**
 * @module ai/scripts/lifecycle/hooks/claude/harnessIdGuardHook
 * @summary Claude Code `PreToolUse` guard: a seat never publishes its own harness session id.
 *
 * Artifacts carry the session ids Memory Core mints. The harness's id addresses records whose access
 * control is not ours, so it never goes into an artifact: not through a GitHub tool, the shell, or a
 * written file, which becomes one as a body file or a commit. Memory Core is our own store and may hold
 * it, so its tools are not on the matcher. Only the seat knows that id when it publishes — a body lint
 * cannot tell a harness UUID from a Memory Core UUID — so the check sits here, on the payload's own
 * `session_id`.
 *
 * The harness keeps the session's scratchpad, task output and pasted images under a temp root whose
 * path holds the id. That path is a location, not content, so it is masked in a command or a file path
 * before the match. A command that pastes it into a GitHub body therefore passes: telling locations
 * from content inside a shell command would take a parser.
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
export const HARNESS_ID_GUARD_MESSAGE = 'This call would put this session\'s harness session id into an artifact, or into ' +
    'a file that can become one. Stamp the Memory Core session id instead: omit add_memory\'s sessionId and use the id ' +
    'it echoes. In prose, write "this session"; reach your own transcript through a glob rather than its literal path.';

/**
 * @summary The `tool_input` fields that name a local location, per tool.
 * @type {Object<String, String[]>}
 */
const LOCATION_FIELDS = {Bash: ['command'], Edit: ['file_path'], Write: ['file_path']};

/**
 * @summary Decides one `PreToolUse` payload. Pure.
 * @param {*} payload The hook's parsed stdin: `session_id`, `tool_name` and `tool_input`.
 * @returns {{decision: 'block', reason: String}|null} `null` lets the call run.
 */
export function decideHarnessIdGuard(payload) {
    const sessionId = typeof payload?.session_id === 'string' ? payload.session_id.trim().toLowerCase() : '';

    if (sessionId.length < MIN_SESSION_ID_LENGTH || payload.tool_input == null) return null;

    return JSON.stringify(maskSessionTempRoot(payload, sessionId)).toLowerCase().includes(sessionId)
        ? {decision: 'block', reason: HARNESS_ID_GUARD_MESSAGE}
        : null
}

/**
 * @summary Masks the session temp root, `…/claude-<uid>/<project-key>/<session-id>`, in location fields.
 * @param {Object} payload   The hook payload: `tool_name` and `tool_input`.
 * @param {String} sessionId The lower-cased harness session id.
 * @returns {*} The input to match.
 */
function maskSessionTempRoot({tool_name, tool_input}, sessionId) {
    if (!Object.hasOwn(LOCATION_FIELDS, tool_name) || typeof tool_input !== 'object') return tool_input;

    const
        escaped  = sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        tempRoot = new RegExp(`/claude-\\d+/[^/\\s]+/${escaped}(?![0-9a-z-])`, 'g'),
        masked   = {...tool_input};

    LOCATION_FIELDS[tool_name].forEach(field => {
        if (typeof masked[field] === 'string') {
            masked[field] = masked[field].toLowerCase().replace(tempRoot, '/claude-<uid>/<project-key>/<session>')
        }
    });

    return masked
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

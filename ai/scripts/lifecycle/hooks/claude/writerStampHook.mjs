import crypto from 'node:crypto';

import {readHookPayload}  from '../../../../mcp/server/memory-core/helpers/TurnPresenceHookWriter.mjs';
import {readSeatConfig}   from '../seatConfig.mjs';
import {isEntryModule}    from '../../../../services/shared/isEntryModule.mjs';
import {sessionTurnStore} from './turnPresenceHook.mjs';

/**
 * @module ai/scripts/lifecycle/hooks/claude/writerStampHook
 * @summary Claude Code `PreToolUse` stamp: every `add_memory` and `add_message` call names its writer.
 *
 * The plane attributes a sunset receipt's close by its writer (`sunsetReceipt.releaseByWriterStamp`), and the
 * Memory Core session cannot name that writer, because a reconnect mints a new one mid-session. The harness
 * session can. So this hook adds two values to the call through `updatedInput`: `writerKey`, a hash of the seat
 * and its harness session id, so the clear id never leaves the host, and `writerTurn`, the turn id the presence
 * hook minted at this session's prompt. Without a session id, a stored turn or a seat it stamps nothing, and the
 * write keeps today's verdict. It returns no permission decision, so the call's own permission check still runs.
 */

/**
 * @summary The key derivation's version, which prefixes every key. A changed derivation must change it: the
 * plane then reads the old and the new key as two writers and holds the rotation instead of releasing it.
 * @type {String}
 */
export const WRITER_KEY_VERSION = 'v1';

/**
 * @summary Derives a seat's writer key for one harness session. Pure.
 * @param {String} identity  The seat.
 * @param {String} sessionId The hook payload's `session_id`.
 * @returns {String} The version, a colon and 32 hex characters.
 */
export function deriveWriterKey(identity, sessionId) {
    return `${WRITER_KEY_VERSION}:${crypto.createHash('sha256').update(`${identity}\n${sessionId}`).digest('hex').slice(0, 32)}`
}

/**
 * @summary Decides one `PreToolUse` payload. A stamp the caller supplied is replaced, never kept.
 * @param {Object} options
 * @param {String|null} options.identity  The seat.
 * @param {*}           options.payload   The hook's parsed stdin: `session_id` and `tool_input`.
 * @param {Object}      options.turnStore The session's turn ids ({@link sessionTurnStore}).
 * @returns {Object|null} The hook output, or `null` to leave the call as it is.
 */
export function decideWriterStamp({identity, payload, turnStore}) {
    const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : '',
          toolInput = payload?.tool_input;

    if (!identity || !sessionId || !toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return null;

    const writerTurn = turnStore.read(sessionId);

    if (typeof writerTurn !== 'string' || !writerTurn) return null;

    return {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput : {...toolInput, writerKey: deriveWriterKey(identity, sessionId), writerTurn}
        }
    }
}

function parseHookPayload(raw) {
    try {
        return JSON.parse(raw)
    } catch {
        return null
    }
}

async function main() {
    const payload = parseHookPayload(await readHookPayload());

    // Only a payload the hook could stamp pays for the config read
    if (!payload?.session_id) return;

    const output = decideWriterStamp({identity: (await readSeatConfig()).identity, payload, turnStore: sessionTurnStore()});

    if (output) process.stdout.write(`${JSON.stringify(output)}\n`)
}

if (isEntryModule(import.meta.url)) {
    // A failed stamp leaves the call unstamped, never blocked
    await main().catch(() => {});
}

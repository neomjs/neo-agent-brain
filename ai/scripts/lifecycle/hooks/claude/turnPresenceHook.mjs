import {pathToFileURL} from 'node:url';
import {
    readHookPayload,
    recordTurnPresenceFromHook
} from '../../../../mcp/server/memory-core/helpers/TurnPresenceHookWriter.mjs';
import {readPlaneConfig, readTurnPresenceDeadlineMs} from '../seatConfig.mjs';

/**
 * @summary The actions `events.manifest.json` registers asynchronously. Progress runs in the background,
 * so it spends the async deadline; every other action runs in the prompt's path and spends the
 * synchronous one. A spec holds this set equal to the manifest's async registrations.
 * @type {Set<String>}
 */
export const ASYNC_ACTIONS = new Set(['progress']);

function parseHookPayload(raw) {
    if (!raw) return null;

    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

function normalizeHookEventName(hookPayload) {
    return typeof hookPayload?.hook_event_name === 'string' ? hookPayload.hook_event_name : null;
}

function resolveAction({actionArg, hookPayload} = {}) {
    if (actionArg) return actionArg;

    const eventName = normalizeHookEventName(hookPayload);
    return eventName === 'PostToolUse' ? 'progress' : 'start';
}

function resolveSource({action, hookPayload} = {}) {
    const eventName = normalizeHookEventName(hookPayload);
    if (eventName === 'UserPromptSubmit') return 'claude-user-prompt-submit';
    if (eventName === 'PostToolUse')      return 'claude-post-tool-use';
    return `claude-${action}`;
}

function resolveNote({action, hookPayload} = {}) {
    const eventName = normalizeHookEventName(hookPayload);
    if (eventName === 'PostToolUse' && typeof hookPayload?.tool_name === 'string') {
        return `claude PostToolUse ${hookPayload.tool_name}`;
    }
    if (eventName) {
        return `claude ${eventName}`;
    }
    return `claude ${action}`;
}

/**
 * @summary Records Claude Code turn-presence into the store the deployment serves.
 *
 * **This is the entrypoint, and the only place config is resolved.** It reads the seat's plane
 * (`seatConfig.readPlaneConfig`) and the writer's deadline (`seatConfig.readTurnPresenceDeadlineMs`)
 * and injects both into a writer that resolves nothing — the same split `wakeArmingHook` uses. The
 * previous shape let the writer derive a filesystem path from its own module location, which is how
 * every beacon ended up in a private checkout that no reader queries.
 *
 * @param {Object} options
 * @param {'start'|'progress'|'terminal'} [options.actionArg] Optional action override.
 * @param {Number} [options.deadlineMs] Injected deadline; read from the `turnPresence` leaf when absent.
 * @param {Object} [options.env=process.env] Environment source.
 * @param {*} [options.hookPayload] Parsed Claude Code hook payload.
 * @param {String|Date|Number} [options.now] Clock override for tests.
 * @param {Object} [options.plane] Injected `{baseUrl, credential}`; read from the seat leaves when absent.
 * @param {Function} [options.record] Transport seam.
 * @returns {Promise<Object>} `{status}` — `recorded`, or `skipped` with a reason.
 */
export async function recordClaudeTurnPresence({
    actionArg,
    deadlineMs,
    env = process.env,
    hookPayload,
    now,
    plane,
    record
} = {}) {
    const action = resolveAction({actionArg, hookPayload});

    return recordTurnPresenceFromHook({
        action,
        deadlineMs: deadlineMs ?? await readTurnPresenceDeadlineMs({async: ASYNC_ACTIONS.has(action)}),
        env,
        hookPayload,
        note      : resolveNote({action, hookPayload}),
        now,
        plane     : plane ?? await readPlaneConfig(),
        source    : resolveSource({action, hookPayload}),
        ...(record ? {record} : {})
    });
}

async function main() {
    const hookPayload = parseHookPayload(await readHookPayload());

    // Never fails the session — presence is an enhancement, not a precondition for working. But it is
    // never silent either: a skip or a throw says so on stderr, where the harness captures it. The
    // failure this replaces was invisible precisely because it reported nothing and wrote anyway.
    const result = await recordClaudeTurnPresence({
        actionArg: process.argv[2],
        hookPayload
    }).catch(error => ({status: 'failed', reason: `turn-presence threw: ${error?.message || error}`}));

    if (result?.status && result.status !== 'recorded') {
        console.error(`[WARN] [turn-presence] not recorded — ${result.reason || result.status}`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}

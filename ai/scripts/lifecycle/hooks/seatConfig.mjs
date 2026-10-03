/**
 * @module ai/scripts/lifecycle/hooks/seatConfig
 * @summary The config every seat hook reads: the plane it reaches, from the seat-side leaves
 * (`AiConfig.seat`) the seat's launcher injects with its own credential — never `fleet.*`, the Fleet
 * transport's — and the turn-presence writer's deadline.
 *
 * Not projected (only `hooks/<harness>/*.mjs` are): a projected hook reaches it through its rewritten
 * import. The config is imported lazily so the hook modules load without booting the Neo Provider.
 */

/**
 * @summary Boots the Neo namespace the configs need: `ai/config.mjs` throws `Neo is not defined` at
 * module-load without it.
 * @returns {Promise<void>}
 */
async function bootNeo() {
    await import('neo.mjs/src/Neo.mjs');
    await import('neo.mjs/src/core/_export.mjs')
}

/**
 * @summary The seat's plane, credential and identity.
 * @returns {Promise<Object>} `{planeBase, planeBearer, identity}`; `planeBase` carries no trailing slash
 */
export async function readSeatConfig() {
    await bootNeo();

    const {default: AiConfig} = await import('../../../config.mjs');

    return {
        planeBase  : AiConfig.seat.planeBase.trim().replace(/\/+$/, ''),
        planeBearer: AiConfig.seat.planeBearer,
        identity   : AiConfig.stopHook.projection.agentId
    }
}

/**
 * @summary The turn-presence writer's view of the seat's plane: its Memory Core endpoint and credential.
 * @returns {Promise<Object>} `{baseUrl, credential}`; `baseUrl` is empty when the seat names no plane
 */
export async function readPlaneConfig() {
    const {planeBase, planeBearer} = await readSeatConfig();

    return {
        baseUrl   : planeBase ? `${planeBase}/mc/mcp` : '',
        credential: planeBearer
    }
}

/**
 * @summary The part of a synchronous registration the hook process itself spends (boot, config, the
 * MCP client) before and after the writer's exchange. A synchronous deadline must leave it free.
 * @type {Number}
 */
export const HOOK_PROCESS_SHARE_MS = 500;

/**
 * @summary The turn-presence writer's deadline, one budget for its whole MCP exchange, by how the
 * harness registered the calling hook: `turnPresence.asyncHookWriteTimeoutMs` for an asynchronous
 * registration, which the harness never times out, else `turnPresence.hookWriteTimeoutMs`.
 *
 * A synchronous registration kills the hook at its own timeout, before the named skip. So a synchronous
 * deadline that does not leave {@link HOOK_PROCESS_SHARE_MS} of the calling hook's registration free is
 * refused here, by name, and the hook reports that instead of being killed silently.
 * @param {Object} options
 * @param {Boolean} [options.async=false] Whether the calling hook's registration is asynchronous.
 * @param {Number} [options.registrationMs] The calling hook's registration timeout; required unless `async`.
 * @returns {Promise<Number>}
 * @throws {Error} When the synchronous deadline does not fit `registrationMs`.
 */
export async function readTurnPresenceDeadlineMs({async = false, registrationMs} = {}) {
    await bootNeo();

    const
        {default: memoryCoreConfig}                   = await import('../../../mcp/server/memory-core/config.mjs'),
        {asyncHookWriteTimeoutMs, hookWriteTimeoutMs} = memoryCoreConfig.turnPresence;

    if (async) return asyncHookWriteTimeoutMs;

    const ceilingMs = registrationMs - HOOK_PROCESS_SHARE_MS;

    if (!(hookWriteTimeoutMs <= ceilingMs)) {
        throw new Error(
            `the synchronous turn-presence deadline (${hookWriteTimeoutMs} ms) does not fit this hook's ` +
            `${registrationMs} ms registration; set NEO_TURN_PRESENCE_HOOK_WRITE_TIMEOUT_MS to at most ${ceilingMs} ms`
        )
    }

    return hookWriteTimeoutMs
}

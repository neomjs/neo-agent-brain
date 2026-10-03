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
 * @summary The turn-presence writer's deadline, one budget for its whole MCP exchange, by how the
 * harness registered the calling hook: `turnPresence.hookWriteTimeoutMs` for a synchronous registration,
 * which it must stay below, or the harness kills the hook before its named skip;
 * `turnPresence.asyncHookWriteTimeoutMs` for an asynchronous one, which the harness never times out.
 * @param {Object} [options]
 * @param {Boolean} [options.async=false] Whether the calling hook's registration is asynchronous.
 * @returns {Promise<Number>}
 */
export async function readTurnPresenceDeadlineMs({async = false} = {}) {
    await bootNeo();

    const {default: memoryCoreConfig} = await import('../../../mcp/server/memory-core/config.mjs');

    return async ? memoryCoreConfig.turnPresence.asyncHookWriteTimeoutMs : memoryCoreConfig.turnPresence.hookWriteTimeoutMs
}

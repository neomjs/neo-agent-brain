/**
 * @module ai/scripts/lifecycle/hooks/seatConfig
 * @summary The plane every seat hook reaches, read from the seat-side leaves (`AiConfig.seat`) the
 * seat's launcher injects with its own credential — never `fleet.*`, the Fleet transport's.
 *
 * Not projected (only `hooks/<harness>/*.mjs` are): a projected hook reaches it through its rewritten
 * import. The config is imported lazily so the hook modules load without booting the Neo Provider.
 */

/**
 * @summary The seat's plane, credential and identity.
 * @returns {Promise<Object>} `{planeBase, planeBearer, identity}`; `planeBase` carries no trailing slash
 */
export async function readSeatConfig() {
    // `ai/config.mjs` throws `Neo is not defined` at module-load without the namespace bootstrap
    await import('neo.mjs/src/Neo.mjs');
    await import('neo.mjs/src/core/_export.mjs');

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

const COMMUNITY_ACTIVITY_TOOL_NAMES = new Set([
    'get_community_activity',
    'get_community_activity_content',
    'mark_community_activity_seen'
]);

const FORBIDDEN_AUTHORITY_FIELDS = new Set([
    'tenantId',
    'userId',
    'viewerId',
    'sessionId',
    'registrationEpoch',
    'agentIdentityNodeId'
]);

/** @summary Resolves a namespaced MCP tool id to the operation id guarded by this boundary. */
const getEffectiveToolName = toolName => {
    const index = toolName.lastIndexOf('__');

    return index === -1 ? toolName : toolName.substring(index + 2)
};

/** @summary Finds the first caller-supplied field that could forge request authority. */
function findForbiddenField(value, path='args') {
    if (!value || typeof value !== 'object') return null;

    for (const [key, child] of Object.entries(value)) {
        const childPath = `${path}.${key}`;

        if (FORBIDDEN_AUTHORITY_FIELDS.has(key)) return childPath;

        const nested = findForbiddenField(child, childPath);

        if (nested) return nested
    }

    return null
}

/**
 * @summary Rejects caller-supplied request authority before OpenAPI normalization.
 * @param {String} toolName
 * @param {Object} args
 * @returns {void}
 */
export function assertCommunityActivityToolBoundary(toolName, args) {
    if (!COMMUNITY_ACTIVITY_TOOL_NAMES.has(getEffectiveToolName(toolName))) return;

    const forbidden = findForbiddenField(args);

    if (forbidden) {
        throw new Error(`COMMUNITY_ACTIVITY_AUTHORITY_FIELD_FORBIDDEN:${forbidden}`)
    }
}

/** @summary Loads the activity service only when a guarded operation is actually dispatched. */
async function getService() {
    return (await import('../../../services/memory-core/CommunityActivityService.mjs')).default
}

/** @summary Dispatches the metadata-only community activity query through the Memory Core service. */
export async function getCommunityActivity(args = {}) {
    const service                                                    = await getService(),
          {cursor, limit, sourceInstanceIds, windowEnd, windowStart} = args;

    return service.query({
        cursor,
        limit,
        sourceInstanceIds,
        windowEnd,
        windowStart
    })
}

/** @summary Dispatches one explicit transient community-content read. */
export async function getCommunityActivityContent({sourceEventId} = {}) {
    const service = await getService();

    return service.getContent({sourceEventId})
}

/** @summary Dispatches one idempotent zero-authority seen marker write. */
export async function markCommunityActivitySeen({sourceEventId} = {}) {
    const service = await getService(),
          result  = await service.markSeen({sourceEventId});

    return {...result, notAuthority: true, sourceEventId}
}

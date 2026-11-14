import crypto                    from 'node:crypto';
import path                      from 'node:path';
import {fileURLToPath}           from 'node:url';
import Neo                       from 'neo.mjs/src/Neo.mjs';
import ToolService               from '../../ToolService.mjs';
import {appendWalMemory}         from '../../../services/memory-core/helpers/memoryWalStore.mjs';
import {composeTurnDocumentText} from '../../../services/memory-core/helpers/turnDocumentText.mjs';

const __filename      = fileURLToPath(import.meta.url);
const __dirname       = path.dirname(__filename);
const openApiFilePath = path.join(__dirname, 'openapi.yaml');

export const STANDALONE_TOOL_PROJECTION = Object.freeze({mode: 'standalone'});

export const STANDALONE_APPROVED_TOOLS = Object.freeze([
    'healthcheck',
    'get_mcp_tool_handbook',
    'add_memory',
    'query_recent_turns',
    'query_raw_memories',
    'get_session_memories'
]);

/**
 * @summary Validates a required non-empty string field on `add_memory`.
 * @param {*} value Field value.
 * @param {String} fieldName Parameter name.
 * @returns {String}
 */
function requireNonEmptyString(value, fieldName) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`Invalid add_memory payload: "${fieldName}" must be a non-empty string.`);
    }
    return value;
}

/**
 * @summary Throws a fail-closed `POLICY_REFUSED` error for non-standalone operations.
 * @param {String} toolName Requested operation id.
 */
function throwStandalonePolicyRefused(toolName) {
    const error = new Error(`Tool "${toolName}" is not visible in the standalone projection.`);
    error.code   = 'POLICY_REFUSED';
    error.reason = error.message;
    throw error;
}

/**
 * @summary Creates an isolated `ToolService` binder for the standalone 6-tool Memory Core profile.
 * @param {Object} options
 * @param {Function} options.getConfig Returns the resolved standalone config proxy.
 * @param {Function} options.getSqliteIndex Returns the active `StandaloneSqliteIndex` instance.
 * @param {Function} options.getWorkspaceInfo Returns `{workspace, workspaceSource}`.
 * @param {Function} options.runHealthcheck Returns the standalone healthcheck payload.
 * @param {String} [options.defaultSessionId=crypto.randomUUID()] Per-process fallback session ID.
 * @returns {{buildToolCatalog: Function, callTool: Function, describeAdvertisedSurface: Function, destroy: Function, listTools: Function, surfaceDigestCarrierTool: String}}
 */
export function createStandaloneToolService({
    getConfig,
    getSqliteIndex,
    getWorkspaceInfo,
    runHealthcheck,
    defaultSessionId = crypto.randomUUID()
}) {
    let toolService = null;

    const resolveEffectiveWorkspace = explicitWorkspace => {
        if (typeof explicitWorkspace === 'string' && explicitWorkspace.trim().length > 0) {
            return explicitWorkspace.trim();
        }
        return getWorkspaceInfo().workspace;
    };

    const handlers = {
        healthcheck: async () => runHealthcheck(),

        get_mcp_tool_handbook: toolId => {
            const requestedId = String(toolId || '').trim();
            if (!STANDALONE_APPROVED_TOOLS.includes(requestedId)) {
                return {
                    toolId : requestedId,
                    found  : false,
                    code   : 'POLICY_REFUSED',
                    message: `Tool "${requestedId}" is not available in the standalone Memory Core profile.`
                };
            }

            const entry         = toolService.getToolHandbook(requestedId);
            const profileSchema = toolService.exactToolProfiles?.standalone?.tools?.[requestedId]?.inputJsonSchema;

            return profileSchema ? {...entry, inputSchema: profileSchema} : entry;
        },

        add_memory: async (args = {}) => {
            const prompt          = requireNonEmptyString(args.prompt, 'prompt');
            const decisionContext = requireNonEmptyString(args.decisionContext, 'decisionContext');
            const response        = requireNonEmptyString(args.response, 'response');

            const config        = getConfig();
            const sqliteIndex   = getSqliteIndex();
            const workspaceInfo = getWorkspaceInfo();
            const sessionId     = (typeof args.sessionId === 'string' && args.sessionId.trim().length > 0)
                ? args.sessionId.trim()
                : ((typeof config.sessionId === 'string' && config.sessionId.trim().length > 0)
                    ? config.sessionId.trim()
                    : defaultSessionId);

            const now          = Date.now();
            const isoTimestamp = new Date(now).toISOString();
            const memoryId     = crypto.randomUUID();
            const combinedText = composeTurnDocumentText({
                prompt,
                thought: decisionContext,
                response
            });

            const record = {
                id             : memoryId,
                timestamp      : now,
                workspace      : workspaceInfo.workspace,
                workspaceSource: workspaceInfo.workspaceSource,
                metadata       : {
                    prompt,
                    response,
                    thought        : decisionContext,
                    sessionId,
                    timestamp      : now,
                    type           : 'agent-interaction',
                    workspace      : workspaceInfo.workspace,
                    workspaceSource: workspaceInfo.workspaceSource,
                    ...(args.agent ? {agent: args.agent} : {}),
                    ...(args.model ? {model: args.model} : {}),
                    ...(args.amountToolCalls !== undefined ? {amountToolCalls: args.amountToolCalls} : {}),
                    ...(args.toolsUsed !== undefined ? {
                        toolsUsed: typeof args.toolsUsed === 'string'
                            ? args.toolsUsed
                            : JSON.stringify(args.toolsUsed)
                    } : {})
                },
                document              : combinedText,
                graphProjectionVersion: 1,
                graphProjection       : {
                    requestIdentity : null,
                    // Standalone cannot vouch for rostered identities; promotion stamps verified `--owner` agentIdentity.
                    memoryProperties: {
                        sessionId,
                        timestamp: isoTimestamp,
                        workspace: workspaceInfo.workspace
                    }
                }
            };

            const walReceipt = await appendWalMemory(record, {
                dir    : config.memoryWal.dirProd,
                planeId: config.plane.id
            });

            sqliteIndex.upsertMemory({
                ...record,
                planeId   : config.plane.id,
                segmentKey: walReceipt.segmentKey
            });

            return {
                id             : memoryId,
                sessionId,
                timestamp      : isoTimestamp,
                workspace      : workspaceInfo.workspace,
                workspaceSource: workspaceInfo.workspaceSource,
                persisted      : true,
                retrievalMode  : 'lexical-fts5',
                message        : 'Memory durably logged to standalone WAL and indexed in local SQLite FTS5.'
            };
        },

        query_recent_turns: async (args = {}) => {
            const sqliteIndex = getSqliteIndex();
            const workspace   = resolveEffectiveWorkspace(args.workspace);
            return sqliteIndex.queryRecentTurns({...args, workspace});
        },

        query_raw_memories: async (args = {}) => {
            const sqliteIndex = getSqliteIndex();
            const workspace   = resolveEffectiveWorkspace(args.workspace);
            return sqliteIndex.queryRawMemories({...args, workspace});
        },

        get_session_memories: async (args = {}) => {
            const sqliteIndex = getSqliteIndex();
            const workspace   = resolveEffectiveWorkspace(args.workspace);
            return sqliteIndex.getSessionMemories({...args, workspace});
        }
    };

    const serviceMapping = new Proxy(handlers, {
        get(target, prop) {
            if (typeof prop === 'symbol' || prop in Object.prototype) {
                return Reflect.get(target, prop);
            }
            if (Object.hasOwn(target, prop)) {
                return target[prop];
            }
            return () => throwStandalonePolicyRefused(String(prop));
        }
    });

    toolService = Neo.create(ToolService, {
        compactToolDescriptions     : true,
        compactToolSchemas          : true,
        openApiFilePath,
        serviceMapping,
        toolListDescriptionMaxLength: 120
    });

    return {
        get surfaceDigestCarrierTool() {
            return toolService.surfaceDigestCarrierTool;
        },

        listTools(options = {}) {
            return toolService.listTools({
                ...options,
                toolProjection: options.toolProjection ?? STANDALONE_TOOL_PROJECTION
            });
        },

        callTool(name, args = {}, options = {}) {
            return toolService.callTool(name, args, {
                ...options,
                toolProjection: options.toolProjection ?? STANDALONE_TOOL_PROJECTION
            });
        },

        buildToolCatalog(options = {}) {
            const toolProjection  = options.toolProjection ?? STANDALONE_TOOL_PROJECTION;
            const listedToolNames = options.listedToolNames
                ?? toolService.listTools({toolProjection}).tools.map(tool => tool.name);

            return toolService.buildToolCatalog({
                ...options,
                listedToolNames,
                toolProjection
            });
        },

        describeAdvertisedSurface(toolProjection = STANDALONE_TOOL_PROJECTION) {
            return toolService.describeAdvertisedSurface(toolProjection);
        },

        destroy() {
            if (toolService) {
                toolService.destroy();
                toolService = null;
            }
        }
    };
}

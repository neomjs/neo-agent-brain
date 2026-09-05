/**
 * @module ai/services/fleet/mcpServers
 * @summary Private MCP target and credential policy used by Fleet provisioning.
 * Client-safe catalog and matrix definitions live in src/fleet/contract/mcpServers.mjs.
 */

/**
 * Harness families whose installed configuration grammar can represent remote HTTP MCP servers.
 * For Fleet-owned local/private endpoints, Claude Desktop uses Neo's local stdio↔Streamable-HTTP
 * bridge rather than a direct HTTP entry; account-level public connectors are outside this generated
 * artifact. Antigravity and Native stay local: presenting a tenant choice for a harness whose
 * artifact cannot encode it would turn a product selection into a late boot failure.
 * @type {ReadonlyArray<String>}
 */
export const TENANT_MCP_HARNESS_TYPES = Object.freeze([
    'codex',
    'codex-desktop',
    'claude-code',
    'claude-desktop',
    'opencode',
    'kimi-code'
]);

/**
 * The fixed child-environment slot every remote MC/KB adapter references. Repository credentials
 * occupy a different authority and may never be substituted here.
 * @type {String}
 */
export const REMOTE_MCP_CREDENTIAL_ENV_VAR = 'NEO_MCP_REMOTE_TOKEN';

/**
 * @summary Validate and canonicalize the deliberately tiny MCP target intent. The resident target
 * is represented as `null`; a connected tenant carries only its public id. URLs, transports,
 * headers, environment bags, commands, and credentials have no grammar here, so they cannot cross
 * the Body→Brain wire.
 * @param {Object|null} target
 * @returns {{kind: 'tenant', tenantId: String}|null}
 */
export function normalizeMcpTarget(target) {
    if (target === null) {
        return null
    }

    if (!target || typeof target !== 'object' || Array.isArray(target)) {
        throw new TypeError('MCP target must be an object or null.')
    }

    const
        {kind}  = target,
        allowed = kind === 'tenant'
            ? new Set(['kind', 'tenantId'])
            : new Set(['kind']),
        unknown = Object.keys(target).find(key => !allowed.has(key));

    if (unknown) {
        throw new TypeError(`Unsupported MCP target field '${unknown}'.`)
    }

    if (kind === 'resident') {
        return null
    }

    if (kind !== 'tenant') {
        throw new TypeError(`Unsupported MCP target kind '${kind}'.`)
    }

    if (typeof target.tenantId !== 'string' || !target.tenantId.trim()) {
        throw new TypeError("Tenant MCP target requires a non-empty 'tenantId'.")
    }

    return {kind: 'tenant', tenantId: target.tenantId.trim()}
}

/**
 * @summary Whether a registered harness family can consume a connected tenant MCP target.
 * @param {String} harnessType
 * @returns {Boolean}
 */
export function supportsTenantMcpTarget(harnessType) {
    return TENANT_MCP_HARNESS_TYPES.includes(harnessType)
}

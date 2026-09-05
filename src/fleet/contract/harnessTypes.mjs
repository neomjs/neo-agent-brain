/**
 * @module src/fleet/contract/harnessTypes
 * @summary Canonical harness keys, labels and configuration capabilities, without Fleet services.
 * Codex leads the display order as the add-form default; returned records are caller-owned and unknown keys resolve null.
 */

/**
 * The capability includes generated adapters as well as direct HTTP configuration. It makes
 * no transport choice and grants no access to a tenant.
 * @type {ReadonlyArray<{type: String, label: String, tenantMcpTarget: Boolean}>}
 */
export const HARNESS_TYPES = Object.freeze([
    Object.freeze({type: 'codex',          label: 'Codex',         tenantMcpTarget: true}),
    Object.freeze({type: 'codex-desktop',  label: 'Codex Desktop', tenantMcpTarget: true}),
    Object.freeze({type: 'claude-code',    label: 'Claude Code',   tenantMcpTarget: true}),
    Object.freeze({type: 'claude-desktop', label: 'Claude',        tenantMcpTarget: true}),
    Object.freeze({type: 'opencode',       label: 'OpenCode',      tenantMcpTarget: true}),
    Object.freeze({type: 'kimi-code',      label: 'Kimi Code',     tenantMcpTarget: true}),
    Object.freeze({type: 'antigravity',    label: 'Antigravity',    tenantMcpTarget: false}),
    Object.freeze({type: 'native-neo',     label: 'Native',        tenantMcpTarget: false})
]);

/**
 * @summary List every registered harness type in display order. Caller-owned copies: mutating a
 * result never corrupts the registry (the frozen source is the second line of defense).
 * @returns {Object[]} `[{type, label, tenantMcpTarget}]`
 */
export function listHarnessTypes() {
    return HARNESS_TYPES.map(entry => ({...entry}))
}

/**
 * @summary Resolve one harness-type entry by its durable key — null for unregistered types
 * (consumers render fail-closed "Unknown harness", never a guess). Caller-owned copy.
 * @param {String} type
 * @returns {{type: String, label: String, tenantMcpTarget: Boolean}|null}
 */
export function resolveHarnessType(type) {
    const entry = HARNESS_TYPES.find(item => item.type === type);

    return entry ? {...entry} : null
}

/**
 * @summary Whether the registered harness grammar can represent a remote tenant MCP target.
 * This is a configuration capability, not authorization. Target validation and credential
 * handling remain private; unknown types refuse.
 * @param {String} type
 * @returns {Boolean}
 */
export function supportsTenantMcpTarget(type) {
    return HARNESS_TYPES.some(entry => entry.type === type && entry.tenantMcpTarget)
}

/**
 * @module src/fleet/contract/mcpServers
 * @summary Canonical MCP catalog and sparse-override rules for Fleet clients and producers.
 * Credential slots, target normalization and tenant transport policy remain Brain-private.
 */

/**
 * A workflow server names its `forge`: it works with that forge's PAT, which the Fleet injects only into a seat
 * bound to that forge.
 * @type {ReadonlyArray<{key: String, label: String, core: Boolean, defaultEnabled: Boolean, forge?: String}>}
 */
export const MCP_SERVERS = Object.freeze([
    Object.freeze({key: 'memory-core',     label: 'Memory Core',     core: true,  defaultEnabled: true}),
    Object.freeze({key: 'knowledge-base',  label: 'Knowledge Base',  core: true,  defaultEnabled: true}),
    Object.freeze({key: 'neural-link',     label: 'Neural Link',     core: true,  defaultEnabled: true}),
    Object.freeze({key: 'github-workflow', label: 'GitHub workflow', core: false, defaultEnabled: true,  forge: 'github'}),
    Object.freeze({key: 'gitlab-workflow', label: 'GitLab workflow', core: false, defaultEnabled: false, forge: 'gitlab'})
]);

/**
 * @summary List every registered MCP server in display order. Every result is caller-owned.
 * @returns {Object[]} `[{key, label, core, defaultEnabled}]`
 */
export function listMcpServers() {
    return MCP_SERVERS.map(entry => ({...entry}))
}

/**
 * The catalog per forge: the forge's own workflow server defaults on, every other forge's off.
 * @type {Readonly<Object<String, ReadonlyArray<Object>>>}
 * @private
 */
const FORGE_CATALOGS = Object.freeze(Object.fromEntries([...new Set(MCP_SERVERS.map(entry => entry.forge).filter(Boolean))]
    .map(forge => [forge, Object.freeze(MCP_SERVERS.map(entry => entry.forge
        ? Object.freeze({...entry, defaultEnabled: entry.forge === forge})
        : entry))])));

/**
 * @summary The catalog a seat resolves and normalizes against, so its defaults follow its forge: a GitLab seat
 * starts its GitLab workflow server, not GitHub's. GitHub's catalog has today's defaults. Normalizing and resolving
 * one seat must use the same catalog, or a stored override is read against defaults it was not written for.
 * @param {String} [forge='github'] The forge the seat's PAT is bound to.
 * @returns {ReadonlyArray<Object>}
 * @throws {TypeError} For a forge no workflow server names.
 */
export function mcpCatalogFor(forge='github') {
    if (!Object.hasOwn(FORGE_CATALOGS, forge)) {
        throw new TypeError(`Unknown forge '${forge}'.`)
    }

    return FORGE_CATALOGS[forge]
}

/**
 * @summary Build the effective default matrix for the supplied catalog. The optional catalog seam
 * makes default-evolution behavior directly falsifiable without mutating the frozen authority.
 * @param {Object[]} [catalog=MCP_SERVERS]
 * @returns {Object} `{serverKey: Boolean}`
 */
export function defaultMcpMatrix(catalog=MCP_SERVERS) {
    return Object.fromEntries(catalog.map(entry => [entry.key, entry.defaultEnabled]))
}

/**
 * @summary Resolve sparse stored overrides over the live catalog defaults. Unknown stored keys are
 * ignored so retired servers cannot reappear in the projection; non-boolean legacy values fail
 * closed to `false` rather than truthy-coercing.
 * @param {Object|null} overrides Sparse persisted overrides; `null` follows every default.
 * @param {Object[]} [catalog=MCP_SERVERS]
 * @returns {Object} Effective `{serverKey: Boolean}` matrix for every registered server.
 */
export function resolveMcpMatrix(overrides, catalog=MCP_SERVERS) {
    const
        matrix = defaultMcpMatrix(catalog),
        keys   = new Set(catalog.map(entry => entry.key));

    Object.entries(overrides || {}).forEach(([key, enabled]) => {
        if (keys.has(key)) {
            matrix[key] = enabled === true
        }
    });

    return matrix
}

/**
 * @summary Validate one complete sparse-override intent and canonicalize it against the current
 * defaults. Only registered boolean entries may cross the wire. Values equal to their catalog
 * default disappear; an empty result becomes `null`, preserving future default evolution.
 * @param {Object|null} overrides Sparse overrides or an effective matrix to reduce.
 * @param {Object[]} [catalog=MCP_SERVERS]
 * @returns {Object|null} Canonical sparse overrides, in catalog order.
 */
export function normalizeMcpOverrides(overrides, catalog=MCP_SERVERS) {
    if (overrides === null) {
        return null
    }

    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
        throw new TypeError('MCP overrides must be an object or null.')
    }

    const
        byKey   = new Map(catalog.map(entry => [entry.key, entry])),
        unknown = Object.keys(overrides).find(key => !byKey.has(key));

    if (unknown) {
        throw new TypeError(`Unknown MCP server '${unknown}'.`)
    }

    const nonBoolean = Object.entries(overrides).find(([, value]) => typeof value !== 'boolean');

    if (nonBoolean) {
        throw new TypeError(`MCP override '${nonBoolean[0]}' must be boolean.`)
    }

    const sparse = {};

    catalog.forEach(entry => {
        if (Object.hasOwn(overrides, entry.key) && overrides[entry.key] !== entry.defaultEnabled) {
            sparse[entry.key] = overrides[entry.key]
        }
    });

    return Object.keys(sparse).length ? sparse : null
}

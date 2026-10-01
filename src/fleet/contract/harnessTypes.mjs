/**
 * @module src/fleet/contract/harnessTypes
 * @summary Canonical harness keys, labels and configuration capabilities, without Fleet services.
 * Codex leads the display order as the add-form default; returned records are caller-owned and unknown keys resolve null.
 */

/**
 * The capability includes generated adapters as well as direct HTTP configuration. It makes
 * no transport choice and grants no access to a tenant.
 * `modelFamily` is display vocabulary; any-provider harnesses remain unclassified.
 * `product` is what a person chooses; `runsAs` is how that product runs, an `'app'` or a `'cli'`
 * (`null` for a type that cannot be launched), so a form shows one choice per product.
 * @type {ReadonlyArray<{type: String, label: String, tenantMcpTarget: Boolean, modelFamily: String|null, product: String, runsAs: String|null}>}
 */
export const HARNESS_TYPES = Object.freeze([
    Object.freeze({type: 'codex',          label: 'Codex',         tenantMcpTarget: true,  modelFamily: 'gpt',    product: 'codex',       runsAs: 'cli'}),
    Object.freeze({type: 'codex-desktop',  label: 'Codex Desktop', tenantMcpTarget: true,  modelFamily: 'gpt',    product: 'codex',       runsAs: 'app'}),
    Object.freeze({type: 'claude-code',    label: 'Claude Code',   tenantMcpTarget: true,  modelFamily: 'claude', product: 'claude',      runsAs: 'cli'}),
    Object.freeze({type: 'claude-desktop', label: 'Claude',        tenantMcpTarget: true,  modelFamily: 'claude', product: 'claude',      runsAs: 'app'}),
    Object.freeze({type: 'opencode',       label: 'OpenCode',      tenantMcpTarget: true,  modelFamily: null,     product: 'opencode',    runsAs: 'cli'}),
    Object.freeze({type: 'kimi-code',      label: 'Kimi Code',     tenantMcpTarget: true,  modelFamily: 'kimi',   product: 'kimi-code',   runsAs: 'cli'}),
    Object.freeze({type: 'antigravity',    label: 'Antigravity',   tenantMcpTarget: false, modelFamily: 'gemini', product: 'antigravity', runsAs: 'app'}),
    Object.freeze({type: 'native-neo',     label: 'Native',        tenantMcpTarget: false, modelFamily: null,     product: 'native-neo',  runsAs: null})
]);

/**
 * Each product's display label: the name a person chooses before how it runs.
 * @type {Readonly<Object<String, String>>}
 * @private
 */
const PRODUCT_LABELS = Object.freeze({
    codex       : 'Codex',
    claude      : 'Claude',
    opencode    : 'OpenCode',
    'kimi-code' : 'Kimi Code',
    antigravity : 'Antigravity',
    'native-neo': 'Native'
});

/**
 * @summary List every product in display order, each with its harness types: one choice per product,
 * with an app or a command line behind it where a product has both. Caller-owned copies.
 * @returns {Object[]} `[{product, label, types: [{type, label, tenantMcpTarget, modelFamily, product, runsAs}]}]`
 */
export function listHarnessProducts() {
    const products = new Map();

    for (const entry of HARNESS_TYPES) {
        if (!products.has(entry.product)) {
            products.set(entry.product, {product: entry.product, label: PRODUCT_LABELS[entry.product], types: []})
        }

        products.get(entry.product).types.push({...entry})
    }

    return [...products.values()]
}

/**
 * @summary List every registered harness type in display order. Caller-owned copies: mutating a
 * result never corrupts the registry (the frozen source is the second line of defense).
 * @returns {Object[]} `[{type, label, tenantMcpTarget, modelFamily, product, runsAs}]`
 */
export function listHarnessTypes() {
    return HARNESS_TYPES.map(entry => ({...entry}))
}

/**
 * @summary Resolve one harness-type entry by its durable key — null for unregistered types
 * (consumers render fail-closed "Unknown harness", never a guess). Caller-owned copy.
 * @param {String} type
 * @returns {{type: String, label: String, tenantMcpTarget: Boolean, modelFamily: String|null, product: String, runsAs: String|null}|null}
 */
export function resolveHarnessType(type) {
    const entry = HARNESS_TYPES.find(item => item.type === type);

    return entry ? {...entry} : null
}

/**
 * @summary Resolve the declared display family; any-provider or unknown harnesses return null.
 * @param {String} type
 * @returns {String|null}
 */
export function resolveHarnessFamily(type) {
    return HARNESS_TYPES.find(entry => entry.type === type)?.modelFamily ?? null
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

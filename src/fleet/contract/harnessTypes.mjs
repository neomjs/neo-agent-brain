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
 * `seatSettings` is where the type reads a seat's declared model and reasoning effort at launch: `'args'`
 * (`--model` / `--effort`), `'codex-config'` (`model` / `model_reasoning_effort` in its `config.toml`), or `null`
 * where Fleet cannot set both. `seatSettingOverrides` describes a partial capability: Claude Desktop
 * accepts effort through `CLAUDE_CODE_EFFORT_LEVEL`, while its model remains app-owned. Consumers
 * offering individual fields use {@link resolveHarnessSeatSetting}; paired readers stay conservative.
 * @type {ReadonlyArray<{type: String, label: String, tenantMcpTarget: Boolean, modelFamily: String|null, product: String, runsAs: String|null, seatSettings: String|null, seatSettingOverrides?: Object}>}
 */
export const HARNESS_TYPES = Object.freeze([
    Object.freeze({type: 'codex',          label: 'Codex',         tenantMcpTarget: true,  modelFamily: 'gpt',    product: 'codex',       runsAs: 'cli', seatSettings: 'codex-config'}),
    Object.freeze({type: 'codex-desktop',  label: 'Codex Desktop', tenantMcpTarget: true,  modelFamily: 'gpt',    product: 'codex',       runsAs: 'app', seatSettings: 'codex-config'}),
    Object.freeze({type: 'claude-code',    label: 'Claude Code',   tenantMcpTarget: true,  modelFamily: 'claude', product: 'claude',      runsAs: 'cli', seatSettings: 'args'}),
    Object.freeze({type: 'claude-desktop', label: 'Claude',        tenantMcpTarget: true,  modelFamily: 'claude', product: 'claude',      runsAs: 'app', seatSettings: null, seatSettingOverrides: Object.freeze({reasoningEffort: 'claude-env'})}),
    Object.freeze({type: 'opencode',       label: 'OpenCode',      tenantMcpTarget: true,  modelFamily: null,     product: 'opencode',    runsAs: 'cli', seatSettings: null}),
    Object.freeze({type: 'kimi-code',      label: 'Kimi Code',     tenantMcpTarget: true,  modelFamily: 'kimi',   product: 'kimi-code',   runsAs: 'cli', seatSettings: null}),
    Object.freeze({type: 'antigravity',    label: 'Antigravity',   tenantMcpTarget: false, modelFamily: 'gemini', product: 'antigravity', runsAs: 'app', seatSettings: null}),
    Object.freeze({type: 'native-neo',     label: 'Native',        tenantMcpTarget: false, modelFamily: null,     product: 'native-neo',  runsAs: null,  seatSettings: null})
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
 * @summary Copy a catalog entry, including its optional per-setting capability map.
 * @param {Object} entry Frozen source record.
 * @returns {Object} Caller-owned record and nested overrides.
 * @private
 */
function copyHarnessType(entry) {
    return {...entry, ...(entry.seatSettingOverrides ? {seatSettingOverrides: {...entry.seatSettingOverrides}} : {})}
}

/**
 * @summary List every product in display order, each with its harness types: one choice per product,
 * with an app or a command line behind it where a product has both. Caller-owned copies.
 * @returns {Object[]} Product groups with caller-owned type records, including optional setting overrides.
 */
export function listHarnessProducts() {
    const products = new Map();

    for (const entry of HARNESS_TYPES) {
        if (!products.has(entry.product)) {
            products.set(entry.product, {product: entry.product, label: PRODUCT_LABELS[entry.product], types: []})
        }

        products.get(entry.product).types.push(copyHarnessType(entry))
    }

    return [...products.values()]
}

/**
 * @summary List every registered harness type in display order. Caller-owned copies: mutating a
 * result never corrupts the registry (the frozen source is the second line of defense).
 * @returns {Object[]} Harness records, including caller-owned optional `seatSettingOverrides` maps.
 */
export function listHarnessTypes() {
    return HARNESS_TYPES.map(copyHarnessType)
}

/**
 * @summary Resolve one harness-type entry by its durable key — null for unregistered types
 * (consumers render fail-closed "Unknown harness", never a guess). Caller-owned copy.
 * @param {String} type
 * @returns {{type: String, label: String, tenantMcpTarget: Boolean, modelFamily: String|null, product: String, runsAs: String|null, seatSettings: String|null, seatSettingOverrides?: Object}|null}
 */
export function resolveHarnessType(type) {
    const entry = HARNESS_TYPES.find(item => item.type === type);

    return entry ? copyHarnessType(entry) : null
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

/**
 * @summary The paired model-and-effort carrier: `'args'`, `'codex-config'`, or `null` when Fleet
 * cannot set both. Partial capabilities do not widen this legacy paired answer.
 * @param {String} type
 * @returns {'args'|'codex-config'|null}
 */
export function resolveHarnessSeatSettings(type) {
    return HARNESS_TYPES.find(entry => entry.type === type)?.seatSettings ?? null
}

/**
 * @summary Where a harness reads one declared field. Desktop's effort environment carrier does not
 * imply model support; unknown fields and harnesses refuse rather than inherit a capability.
 * @param {String} type Harness key.
 * @param {'model'|'reasoningEffort'} field Declared setting.
 * @returns {'args'|'codex-config'|'claude-env'|null} The carrier, or no supported write path.
 */
export function resolveHarnessSeatSetting(type, field) {
    if (field !== 'model' && field !== 'reasoningEffort') return null;

    const entry = HARNESS_TYPES.find(item => item.type === type);

    return entry?.seatSettingOverrides && Object.hasOwn(entry.seatSettingOverrides, field)
        ? entry.seatSettingOverrides[field]
        : entry?.seatSettings ?? null
}

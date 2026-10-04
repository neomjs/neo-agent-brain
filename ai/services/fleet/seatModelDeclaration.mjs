import {getHarnessSeatSettings} from './deriveHarnessLaunchSpec.mjs';

/**
 * A model id as harnesses name one: an alias (`opus`), a full id (`claude-opus-5-5`) or a provider path
 * (`kimi-code/k3`). The value reaches a command line and a TOML string, so nothing else gets through.
 * @type {RegExp}
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/**
 * An effort level as harnesses name one (`max`, `xhigh`, `ultra`). The word stays open: a harness's levels can
 * differ per model, and its own catalog judges them.
 * @type {RegExp}
 */
const EFFORT_LEVEL = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * @summary Validates the model and reasoning effort an operator declares for a seat, which its harness reads at
 * the next Start. Each field is set, or handed back with `null`: Fleet stops setting it, and the harness keeps
 * whatever its own configuration says. A field the intent does not name stays as it is. A harness that chooses
 * both itself takes no declaration: the `claude-desktop` app passes its own on every session it starts.
 * @param {String} harnessType The seat's harness family once the change applies.
 * @param {Object} fields      The intent, read for `model` and `reasoningEffort` only.
 * @returns {{model?: String|null, reasoningEffort?: String|null}} The fields the intent names, validated.
 * @throws {TypeError} On a malformed value, or on a value for a harness that takes none.
 */
export function normalizeSeatModelDeclaration(harnessType, fields) {
    const declaration = {};

    for (const [key, pattern, example] of [['model', MODEL_ID, "'claude-opus-5-5'"], ['reasoningEffort', EFFORT_LEVEL, "'max'"]]) {
        if (!Object.hasOwn(fields, key)) continue;

        const value = fields[key];

        if (value !== null && (typeof value !== 'string' || !pattern.test(value))) {
            throw new TypeError(`'${key}' must be one id as the harness names it, such as ${example}, or null.`)
        }

        declaration[key] = value
    }

    if (!getHarnessSeatSettings(harnessType) && Object.values(declaration).some(value => value !== null)) {
        throw new TypeError(`a '${harnessType}' seat takes no declared model or reasoning effort: its harness chooses them itself.`)
    }

    return declaration
}

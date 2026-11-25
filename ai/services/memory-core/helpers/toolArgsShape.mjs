/**
 * @module ai/services/memory-core/helpers/toolArgsShape
 * @summary Pure reduction of a tool call's arguments to a shape that names its query without
 * carrying its content.
 *
 * The tool-call start row is the only record left of a call that wedges the process, and its query
 * shape is what an attribution needs: `list_messages` builds a different synchronous query for
 * every `box` × `status` combination and every optional filter. Arguments themselves carry message
 * text, identities and ids, so they are never stored. A shape keeps the VALUE of an allow-listed,
 * enumerated argument, and only the KEY of everything else the caller supplied.
 *
 * A value is kept only if it is closed: a boolean, a finite number, or a short lower-camel word.
 * Even an allow-listed key cannot carry an identity (`@…`), an id (`MESSAGE:…`) or prose.
 *
 * This helper performs no I/O, configuration lookup, or mutation.
 */

/**
 * The arguments whose values a shape keeps, per tool: each takes values from a closed set.
 * @type {Object<String, String[]>}
 */
export const ARGS_SHAPE_ALLOW_LIST = Object.freeze({
    list_messages     : ['box', 'directOnly', 'includeArchived', 'limit', 'offset', 'projection', 'status'],
    query_recent_turns: ['detail', 'limit', 'projection'],
    who_is_online     : ['verbose']
});

const CLOSED_WORD = /^[a-z][a-zA-Z-]{0,31}$/;

/**
 * @summary Reports whether a value comes from a closed set, so storing it names no content.
 * @param {*} value
 * @returns {Boolean}
 */
function isClosedValue(value) {
    return typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && CLOSED_WORD.test(value))
}

/**
 * @summary Reduces one call's arguments to `{values, keys}`: the closed values of the tool's
 * allow-listed arguments, and the sorted keys of every other argument supplied.
 * @param {String} toolName
 * @param {Object} args
 * @returns {{values: Object, keys: String[]}|null} `null` when there are no object arguments.
 */
export function buildArgsShape(toolName, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;

    const
        allowed = new Set(ARGS_SHAPE_ALLOW_LIST[toolName] ?? []),
        values  = {},
        keys    = [];

    for (const [key, value] of Object.entries(args)) {
        if (value === undefined) continue;

        if (allowed.has(key) && isClosedValue(value)) {
            values[key] = value
        } else {
            keys.push(key)
        }
    }

    return {values, keys: keys.sort()}
}

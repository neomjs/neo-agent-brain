/**
 * @module ai/services/fleet/codexConfigToml
 * @summary What Fleet reads and writes in a Codex `config.toml` as text, so every other key and comment stays as
 * its writer left it: where a table header starts, and the seat settings at the top level (`model`,
 * `model_reasoning_effort`). A seat's declaration replaces those at Start, and its status reads them back.
 */

/**
 * The seat settings at a Codex config's top level, each with the record field that declares it.
 * @type {Object[]}
 */
const SEAT_KEYS = [{key: 'model', field: 'model'}, {key: 'model_reasoning_effort', field: 'reasoningEffort'}];

/**
 * @summary Parse a TOML table header without mistaking brackets or `#` inside quoted keys for the
 * structural close/comment boundary. Both `[table]` and `[[array.table]]` forms are recognized,
 * including legal trailing comments.
 * @param {String} line One physical TOML line.
 * @returns {{array: Boolean, body: String}|null}
 */
export function parseTomlTableHeader(line) {
    const
        source    = String(line).trimStart(),
        array     = source.startsWith('[['),
        openWidth = array ? 2 : 1;

    if ((!array && !source.startsWith('[')) || source.length <= openWidth) return null;

    let quote = null, escaped = false;

    for (let index = openWidth; index < source.length; index++) {
        const char = source[index];

        if (quote) {
            if (quote === '"' && escaped) {
                escaped = false
            } else if (quote === '"' && char === '\\') {
                escaped = true
            } else if (char === quote) {
                quote = null
            }

            continue
        }

        if (char === '"' || char === "'") {
            quote = char;
            continue
        }

        if (char === '#') return null;

        const closes = array
            ? char === ']' && source[index + 1] === ']'
            : char === ']';

        if (!closes) continue;

        const
            body   = source.slice(openWidth, index).trim(),
            suffix = source.slice(index + (array ? 2 : 1)).trim();

        if (!body || (suffix && !suffix.startsWith('#'))) return null;

        return {array, body}
    }

    return null
}

/**
 * @summary The index of the first table header: the lines before it are the top level.
 * @param {String[]} lines
 * @returns {Number}
 */
function topLevelEnd(lines) {
    const index = lines.findIndex(line => parseTomlTableHeader(line));

    return index === -1 ? lines.length : index
}

/**
 * @summary One top-level key's assignment and its string value, a trailing comment allowed.
 * @param {String} key
 * @returns {RegExp} Group 1 a basic string's body, group 2 a literal string's
 */
const assignment = key => new RegExp(`^\\s*${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)'|[^#]*?)\\s*(?:#.*)?$`);

/**
 * @summary The string a top-level key is set to, or `null` when the top level does not set it as one.
 * @param {String[]} lines The top level's lines
 * @param {String}   key
 * @returns {{index: Number, value: String|null}|null}
 */
function readKey(lines, key) {
    const index = lines.findIndex(line => assignment(key).test(line));

    if (index === -1) return null;

    const [, basic, literal] = lines[index].match(assignment(key));

    if (basic === undefined) return {index, value: literal ?? null};

    try {
        return {index, value: JSON.parse(`"${basic}"`)}
    } catch {
        // a TOML escape JSON does not know, such as `\e`: the body as written
        return {index, value: basic}
    }
}

/**
 * @summary The model and reasoning effort a Codex config is set to now: configured state, which a running or
 * resumed thread may override, so never proof of what a chat runs on.
 * @param {String} source The file's text.
 * @returns {{model: String|null, reasoningEffort: String|null}} `null` for a key the top level does not set.
 */
export function readCodexSeatSettings(source) {
    const
        lines = String(source).split(/\r?\n/),
        top   = lines.slice(0, topLevelEnd(lines));

    return Object.fromEntries(SEAT_KEYS.map(({key, field}) => [field, readKey(top, key)?.value ?? null]))
}

/**
 * @summary Writes a seat's declared settings into a Codex config's top level. The line that sets one is
 * replaced wherever its writer put it. A key nothing sets goes in after Fleet's own policy keys, or at the top
 * of a file without them, in the order the record names them. A field the seat does not declare stays as it
 * is, because Fleet cannot tell its own earlier write from the app's pick.
 * @param {String} source The file's text.
 * @param {Object} seat   The seat's record, read for `model` and `reasoningEffort`.
 * @returns {String} The text to publish, the same text when nothing changes.
 */
export function applyCodexSeatSettings(source, seat) {
    const
        lines  = String(source).split('\n'),
        policy = lines.slice(0, topLevelEnd(lines)).findIndex(text => /^\s*mcp_oauth_credentials_store\s*=/.test(text));

    let insertAt = policy + 1;

    for (const {key, field} of SEAT_KEYS) {
        const value = seat?.[field];

        if (typeof value !== 'string' || !value) continue;

        const
            existing = readKey(lines.slice(0, topLevelEnd(lines)), key),
            line     = `${key} = ${JSON.stringify(value)}`;

        if (existing) {
            existing.value !== value && (lines[existing.index] = line)
        } else {
            lines.splice(insertAt++, 0, line)
        }
    }

    return lines.join('\n')
}

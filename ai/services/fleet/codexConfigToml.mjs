import {isDeepStrictEqual}  from 'node:util';
import {parse as parseToml} from 'smol-toml';

/**
 * @module ai/services/fleet/codexConfigToml
 * @summary What Fleet reads and writes in a Codex `config.toml`, so every other key and comment stays as its writer
 * left it: where a table header starts, and the seat settings at the top level (`model`, `model_reasoning_effort`).
 * A seat's declaration replaces those at Start, and its status reads them back.
 *
 * Reads go through a TOML parser. A write replaces only the value of the root assignment it means: a lexer finds
 * the statements of the top level, quoted keys, multiline strings, arrays and inline tables included, so text that
 * merely looks like an assignment is never touched. Every write is checked by parsing it: the result equals the
 * source except for the declared values, or nothing is written.
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
 * @summary The statements of a TOML document's top level, before its first table header: each one's key, when it is a
 * single key rather than a dotted one, its extent, and its value's extent.
 * @param {String} source
 * @returns {Object[]} `{name: String|null, start, end, valueStart, valueEnd}`, offsets into `source`
 * @throws {Error} On text the lexer cannot read as TOML.
 */
function rootStatements(source) {
    const
        statements = [],
        length     = source.length,
        malformed  = what => new Error(`not valid TOML at offset ${index}: ${what}`);

    let index = 0;

    const
        skipSpace = () => { while (source[index] === ' ' || source[index] === '\t') index++ },
        skipLine  = () => { while (index < length && source[index] !== '\n') index++ },
        // one string of any of TOML's four kinds, the cursor on its opening quote
        skipString = () => {
            const quote = source[index], triple = source.startsWith(quote.repeat(3), index);

            index += triple ? 3 : 1;

            while (index < length) {
                if (quote === '"' && source[index] === '\\') {
                    index += 2;
                    continue
                }

                if (triple && source.startsWith(quote.repeat(3), index)) {
                    index += 3;
                    // up to two more quotes belong to the content
                    while (source[index] === quote && index < length) index++;
                    return
                }

                if (!triple && source[index] === quote) {
                    index++;
                    return
                }

                if (!triple && source[index] === '\n') throw malformed('a string runs past its line');

                index++
            }

            throw malformed('an unterminated string')
        },
        // an array or inline table, the cursor on its opening bracket
        skipNested = () => {
            let depth = 0;

            while (index < length) {
                const char = source[index];

                if (char === '"' || char === "'") {
                    skipString();
                    continue
                }

                if (char === '#') {
                    skipLine();
                    continue
                }

                if (char === '[' || char === '{') depth++;
                if (char === ']' || char === '}') depth--;

                index++;

                if (depth === 0) return
            }

            throw malformed('an unterminated array or inline table')
        },
        simpleKey = () => {
            if (source[index] === '"') {
                const start = index;

                skipString();

                try {
                    return JSON.parse(source.slice(start, index))
                } catch {
                    return source.slice(start + 1, index - 1)
                }
            }

            if (source[index] === "'") {
                const start = index + 1;

                skipString();

                return source.slice(start, index - 1)
            }

            const start = index;

            while (index < length && /[A-Za-z0-9_-]/.test(source[index])) index++;

            if (start === index) throw malformed('a key was expected');

            return source.slice(start, index)
        };

    while (index < length) {
        skipSpace();

        const char = source[index];

        if (char === '\n' || char === '\r') {
            index++;
            continue
        }

        if (char === '#') {
            skipLine();
            continue
        }

        // a table header ends the top level
        if (char === '[' || index >= length) break;

        const
            start = index,
            parts = [simpleKey()];

        skipSpace();

        while (source[index] === '.') {
            index++;
            skipSpace();
            parts.push(simpleKey());
            skipSpace()
        }

        if (source[index] !== '=') throw malformed('an assignment was expected');

        index++;
        skipSpace();

        const valueStart = index;

        if (source[index] === '"' || source[index] === "'") {
            skipString()
        } else if (source[index] === '[' || source[index] === '{') {
            skipNested()
        } else {
            while (index < length && source[index] !== '\n' && source[index] !== '#') index++;
            while (source[index - 1] === ' ' || source[index - 1] === '\t' || source[index - 1] === '\r') index--
        }

        const valueEnd = index;

        skipSpace();
        source[index] === '#' && skipLine();

        statements.push({name: parts.length === 1 ? parts[0] : null, start, end: index, valueStart, valueEnd})
    }

    return statements
}

/**
 * @summary The model and reasoning effort a Codex config is set to now: configured state, which a running or resumed
 * thread may override, so never proof of what a chat runs on.
 * @param {String} source The file's text.
 * @returns {{model: String|null, reasoningEffort: String|null}} `null` for a key the top level does not set as a string.
 * @throws {Error} On text that is not valid TOML.
 */
export function readCodexSeatSettings(source) {
    const parsed = parseToml(String(source));

    return Object.fromEntries(SEAT_KEYS.map(({key, field}) => [field, typeof parsed[key] === 'string' ? parsed[key] : null]))
}

/**
 * @summary Writes a seat's declared settings into a Codex config's top level. The value of the root assignment that
 * sets one is replaced wherever its writer put it, quoted key included. A key nothing sets goes in after Fleet's own
 * policy keys, or at the top of a file without them. A field the seat does not declare stays as it is, because Fleet
 * cannot tell its own earlier write from anyone else's.
 * @param {String} source The file's text.
 * @param {Object} seat   The seat's record, read for `model` and `reasoningEffort`.
 * @returns {String} The text to publish, the same text when nothing changes.
 * @throws {Error} On a source that is not valid TOML, or a result that would change anything but the declared values;
 * nothing is to be written then.
 */
export function applyCodexSeatSettings(source, seat) {
    const declared = SEAT_KEYS.filter(({field}) => typeof seat?.[field] === 'string' && seat[field]);

    if (!declared.length) return source;

    const
        text     = String(source),
        before   = parseToml(text),
        changing = declared.filter(({key, field}) => before[key] !== seat[field]);

    if (!changing.length) return text;

    const
        statements = rootStatements(text),
        policy     = statements.find(statement => statement.name === 'mcp_oauth_credentials_store'),
        edits      = [],
        inserted   = [];

    for (const {key, field} of changing) {
        const statement = statements.find(candidate => candidate.name === key);

        statement
            ? edits.push({start: statement.valueStart, end: statement.valueEnd, text: JSON.stringify(seat[field])})
            : inserted.push(`${key} = ${JSON.stringify(seat[field])}`)
    }

    if (inserted.length) {
        edits.push(policy
            ? {start: policy.end, end: policy.end, text: `\n${inserted.join('\n')}`}
            : {start: 0, end: 0, text: `${inserted.join('\n')}\n`})
    }

    const next = edits
        .sort((left, right) => right.start - left.start)
        .reduce((result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end), text);

    // parsed again rather than copied, so it carries the parser's own object shape
    const expected = parseToml(text);

    for (const {key, field} of declared) expected[key] = seat[field];

    if (!isDeepStrictEqual(parseToml(next), expected)) {
        throw new Error('writing the declared model and effort would change other settings in the file')
    }

    return next
}

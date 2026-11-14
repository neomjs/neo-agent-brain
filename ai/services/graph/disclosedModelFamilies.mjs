/**
 * @module ai/services/graph/disclosedModelFamilies
 * @summary The model families an outside pull request names. Outside pull requests are presumed
 * model-written (operator ruling, 2026-11-14): one that names a family needs an approval from another
 * family, and one that names none may be approved by any seat.
 *
 * Only a disclosure counts: a body line that says what produced the change (`Authored by … (Claude Opus
 * 5.5, Claude Code)`, `🤖 Generated with [Claude Code]`, `Prepared with OpenAI Codex (GPT-6.1)`, an
 * `AI assistance:` line), or a `Co-Authored-By` trailer in the body or in any commit. A commit's other
 * lines state its topic, never its author. A model name anywhere else names no author: a path such as
 * `.gemini/concepts/…`, or a sentence about what Claude Code reads. A provider's model id
 * (`anthropic/claude-sonnet-4-5`) and a versioned name (`Qwen3-Coder`) name their family. A harness
 * alone (Cursor, Copilot, OpenCode, Antigravity) names no family either, because it runs several
 * vendors' models.
 *
 * Pure and roster-free: the merge-readiness verdict and the Fleet's open-work rows both read it, and
 * neither may load the identity roster to do so.
 */

/**
 * Model and vendor names, by the family key the cross-family test compares. The keys are the ones
 * seats record as `modelFamily`; a family with no seat still counts, so a PR naming only it may be
 * approved by any seat. A name ends at any non-letter, so a version suffix (`Qwen3`, `Llama3.1`) keeps it.
 * @type {Array<Array>}
 */
const FAMILY_NAMES = Object.freeze([
    ['claude',   /\b(?:claude|anthropic|opus|sonnet|haiku|fable)(?![a-z])/i],
    ['gpt',      /\b(?:gpt|chatgpt|codex|openai)(?![a-z])/i],
    ['gemini',   /\b(?:gemini|jules)(?![a-z])/i],
    ['deepseek', /\bdeepseek(?![a-z])/i],
    ['glm',      /\bglm-?\d/i],
    ['grok',     /\bgrok(?![a-z])/i],
    ['kimi',     /\b(?:kimi|moonshot)(?![a-z])/i],
    ['llama',    /\bllama(?![a-z])/i],
    ['mistral',  /\b(?:mistral|devstral|codestral)(?![a-z])/i],
    ['qwen',     /\bqwen(?![a-z])/i]
]);

/**
 * A disclosure line, once its list, quote, heading, emphasis and emoji markers are stripped: it opens with a
 * verb that says what produced the change (optionally after "this PR was"), a `Co-Authored-By`
 * trailer, or an AI or model disclosure label.
 * @type {RegExp}
 */
const DISCLOSURE = new RegExp(
    '^(?:(?:this|the) (?:pr|pull request|change|patch|commit|code) (?:was|is) |i |we )?' +
    '(?:(?:authored|assisted|automated|built|co-authored|coded|created|developed|drafted|generated|implemented|made|' +
    'opened|prepared|produced|used|written)\\b|(?:ai|model) (?:assistance|assisted|disclosure|usage|use|tools?)\\b)',
    'i'
);

/**
 * A `Co-Authored-By` trailer, the only commit line that names who wrote the change.
 * @type {RegExp}
 */
const TRAILER = /^co-authored-by:/i;

/**
 * A provider's model id: one slash between two names, the second not ending in a file extension
 * (`anthropic/claude-sonnet-4-5`, `qwen/qwen3-coder`). Quotes, brackets and trailing punctuation
 * around it are not part of it.
 * @type {RegExp}
 */
const MODEL_ID = /^[`'"(<[]*([a-z\d][\w-]*\/[a-z\d][\w.:-]*?)[`'")>\].,;:!?]*$/i;

/**
 * @summary Whether a token holding a slash names a place (a URL or a path) rather than a model.
 * @param {String} token
 * @returns {Boolean}
 * @private
 */
function isPlace(token) {
    const id = MODEL_ID.exec(token)?.[1];
    return !id || /\.[a-z][a-z\d]*$/i.test(id)
}

/**
 * @summary The families one disclosure line names, once its places are removed: markdown link targets,
 * slash tokens that are no model id, and tokens starting with a dot (a dotfile or dot-folder). A
 * model name inside a place names that place, not an author.
 * @param {String} line A disclosure line, markers stripped.
 * @returns {String[]}
 * @private
 */
function familiesIn(line) {
    const text = line
        .replace(/\]\([^)]*\)/g, ' ')
        .replace(/\S*\/\S*/g, token => isPlace(token) ? ' ' : token)
        .replace(/(^|\s)\.[\w-]\S*/g, ' ');

    return FAMILY_NAMES.filter(([, pattern]) => pattern.test(text)).map(([family]) => family)
}

/**
 * @summary The model families a pull request discloses: its body's disclosure lines and the
 * `Co-Authored-By` trailers of its commits. Every disclosure counts, so a PR that names two families
 * names both. A commit's subject and body describe the change, so they name no author.
 * @param {Object} [source]
 * @param {String}   [source.body='']           The pull request body.
 * @param {String[]} [source.commitMessages=[]] Full commit messages, every commit's; only their trailers count.
 * @returns {String[]} Sorted family keys; empty when the PR names no model.
 */
export function disclosedFamiliesOf({body = '', commitMessages = []} = {}) {
    const
        families = new Set(),
        read     = (text, disclosure) => {
            if (typeof text !== 'string') return;

            for (const raw of text.split(/\r?\n/)) {
                const line = raw.replace(/^(?:[\s>#*_-]|\d+[.)]\s|🤖)*/u, '');

                if (disclosure.test(line)) {
                    familiesIn(line).forEach(family => families.add(family))
                }
            }
        };

    read(body, DISCLOSURE);
    (Array.isArray(commitMessages) ? commitMessages : []).forEach(message => read(message, TRAILER));

    return [...families].sort()
}

export default disclosedFamiliesOf;

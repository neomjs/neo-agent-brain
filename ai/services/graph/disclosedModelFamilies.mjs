/**
 * @module ai/services/graph/disclosedModelFamilies
 * @summary The model families an outside pull request names. Outside pull requests are presumed
 * model-written (operator ruling, 2026-11-14): one that names a family needs an approval from another
 * family, and one that names none may be approved by any seat.
 *
 * Only a disclosure counts: a line that says what produced the change (`Authored by … (Claude Opus
 * 5.5, Claude Code)`, `🤖 Generated with [Claude Code]`, `Prepared with OpenAI Codex (GPT-6.1)`, an
 * `AI assistance:` line) or a `Co-Authored-By` trailer. A model name anywhere else names no author:
 * a path such as `.gemini/concepts/…`, or a sentence about what Claude Code reads. A harness alone
 * (Cursor, Copilot, OpenCode, Antigravity) names no family either, because it runs several vendors'
 * models.
 *
 * Pure and roster-free: the merge-readiness verdict and the Fleet's open-work rows both read it, and
 * neither may load the identity roster to do so.
 */

/**
 * Model and vendor names, by the family key the cross-family test compares. The keys are the ones
 * seats record as `modelFamily`; a family with no seat still counts, so a PR naming only it may be
 * approved by any seat.
 * @type {Array<Array>}
 */
const FAMILY_NAMES = Object.freeze([
    ['claude',   /\b(?:claude|anthropic|opus|sonnet|haiku|fable)\b/i],
    ['gpt',      /\b(?:gpt|chatgpt|codex|openai)\b|\bgpt-?\d/i],
    ['gemini',   /\b(?:gemini|jules)\b/i],
    ['deepseek', /\bdeepseek\b/i],
    ['glm',      /\bglm-?\d/i],
    ['grok',     /\bgrok\b/i],
    ['kimi',     /\b(?:kimi|moonshot)\b/i],
    ['llama',    /\bllama\b/i],
    ['mistral',  /\b(?:mistral|devstral|codestral)\b/i],
    ['qwen',     /\bqwen\b/i]
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
 * Markdown link targets, then any token holding a slash (a URL or a path) or starting with a dot (a
 * dotfile or dot-folder). A model name inside one of them names a place, not an author.
 * @type {RegExp[]}
 */
const NOT_A_NAME = Object.freeze([/\]\([^)]*\)/g, /\S*\/\S*/g, /(^|\s)\.[\w-]\S*/g]);

/**
 * @summary The families one disclosure line names, after its places are removed.
 * @param {String} line A disclosure line, markers stripped.
 * @returns {String[]}
 * @private
 */
function familiesIn(line) {
    const text = NOT_A_NAME.reduce((value, pattern) => value.replace(pattern, ' '), line);
    return FAMILY_NAMES.filter(([, pattern]) => pattern.test(text)).map(([family]) => family)
}

/**
 * @summary The model families a pull request discloses, read from its body and its commit messages.
 * Every disclosure line counts, so a PR that names two families names both.
 * @param {Object} [source]
 * @param {String}   [source.body='']           The pull request body.
 * @param {String[]} [source.commitMessages=[]] Full commit messages; their trailers count like body lines.
 * @returns {String[]} Sorted family keys; empty when the PR names no model.
 */
export function disclosedFamiliesOf({body = '', commitMessages = []} = {}) {
    const families = new Set();

    for (const text of [body, ...(Array.isArray(commitMessages) ? commitMessages : [])]) {
        if (typeof text !== 'string') continue;

        for (const raw of text.split(/\r?\n/)) {
            const line = raw.replace(/^(?:[\s>#*_-]|\d+[.)]\s|🤖)*/u, '');

            if (DISCLOSURE.test(line)) {
                familiesIn(line).forEach(family => families.add(family))
            }
        }
    }

    return [...families].sort()
}

export default disclosedFamiliesOf;

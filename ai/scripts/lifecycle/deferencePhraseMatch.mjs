/**
 * @module ai.scripts.lifecycle.deferencePhraseMatch
 * @summary Detects the linguistic "helpful assistant" deference register in an assistant turn.
 *
 * This is the phrased half of the deference instinct: strings like "do you want me driving next?"
 * hand maintainer-owned judgment back to the operator. The structural / phraseless half is not
 * catchable by phrase matching; that remains the no-hold gate and value-floor domain.
 *
 * Consumed by Stop hooks at every turn-end. On an autonomous turn any registry phrase is the slip. In
 * live operator dialogue a phrase can be a legitimate Tier-4 ask, so it fires only after a pick the
 * agent stated itself (case 3 of the operator's 2026-08-25 ruling); a peer deadlock (case 1) and
 * human-only work (case 2) stay carved. A harness question box (the Claude desktop wrap-up `ask`) is
 * read the same way: its first button executes the agent's own pick unless the step is the human's.
 */

/**
 * Tight deference phrases, grounded in live session fixtures. Deliberately excludes broad near-misses
 * like "should I", "shall I", "happy to", "no rush", and "whenever you want"; broadening requires a
 * falsifier-backed follow-up so the hook stays a mirror, not a noisy leash.
 * @type {String[]}
 */
export const DEFERENCE_PHRASES = [
    'would you like me to',
    'unless you',
    'want me to',
    'do you want me',
    'Your steer on',
    "if you'd rather",
    'or steer me elsewhere',
    'your call',
    'your move',
    // The subtlest form, and the one that survives a self-audit: the agent NAMES the highest-value
    // action, then attaches a permission gate that does not exist. It reads as deferential courtesy
    // and functions as a stop - the work is identified, credited, and not done. Operator-caught
    // 2026-08-11 on a live client incident, where the named action was the cheapest unrun probe of a
    // seven-week outage.
    //
    // ONE entry, not three. `if you want me` was dropped as redundant - the neighbouring `want me to`
    // already matches its dominant form, and a test asserting truthiness could not tell the two apart.
    // `if you would like` was dropped as noise: it reserves ordinary English ("keep the fixture local
    // if you would like deterministic isolation") for no shape the survivors miss. Both were dropped
    // after a reviewer EXECUTED those sentences against this matcher rather than arguing about them.
    'if you want it'
];

/**
 * Phrases whose gate-forming reading depends on clause POSITION, not presence.
 *
 * `if you want it` closes a permission gate when it ends the clause - *"the one thing I would still
 * act on immediately if you want it: `ollama ps`"* - and is ordinary English the moment the pronoun
 * carries a predicate - *"set maxQueue to zero if you want it to reject excess work"*. Presence alone
 * cannot separate those, and this matcher is consumed by an ENFORCING Stop hook, so a false positive
 * blocks correct work. The neighbours above need no such test: their object is always the agent
 * (`me`) or the lane itself, so they cannot attach to a third party's predicate.
 * @type {Set<String>}
 */
const CLAUSE_TERMINAL_PHRASES = new Set(['if you want it']);

/**
 * @summary Reports whether a match ends its clause, reading grammar rather than Markdown layout.
 *
 * Clause-terminal means end-of-text, sentence punctuation, or a delimiter that hands off to the named
 * action (`:` in the originating specimen). A following WORD means the phrase governs that word rather
 * than gating the agent's own action.
 *
 * Two layout artefacts must not be mistaken for grammar, and the first version of this guard mistook
 * both:
 *
 * - **Inline emphasis is transparent.** Agents bold the phrase they are apologising with, so
 *   `**if you want it**:` is the specimen's most likely written form. Treating `*` as a following word
 *   made the guard MISS it — a false negative on exactly the shape the entry exists to catch, which is
 *   worse than the false positive that motivated the guard.
 * - **A soft wrap is whitespace, not a clause end.** Hard-wrapped prose splits
 *   `if you want it / to reject excess work` across a newline, and reading that newline as terminal
 *   resurrects the false positive. A BLANK line is different: a paragraph break really does end the
 *   clause, so it stays terminal.
 * @param {String} text
 * @param {Number} endIndex Index one past the matched phrase.
 * @returns {Boolean}
 * @private
 */
function isClauseTerminal(text, endIndex) {
    // No emphasis handling here: `stripInlineEmphasis` already removed delimiters from the searchable
    // text, so this sees grammar only. An earlier revision stripped emphasis in BOTH places, which made
    // each strip individually unfalsifiable — a mutation removing one left every arm green.
    const rest = text.slice(endIndex).replace(/^[ \t]+/, '');

    if (rest === '') {
        return true;
    }

    // Paragraph break: the clause is over regardless of what follows it.
    if (/^\r?\n[ \t]*\r?\n/.test(rest)) {
        return true;
    }

    // Soft wrap folds to whitespace; judge what actually follows the wrap.
    return /^[.,:;!?)\]}"'’”]/.test(rest.replace(/^\r?\n[ \t]*/, ''))
}

/**
 * The peer-identity reminder injected when a deference phrase or a handback ask fires at a turn-end.
 * Self-explaining at point of contact: it names the slip, the peer identity, the peer-input recovery
 * route, and the friction->gold path for false positives.
 * @type {String}
 */
export const DEFERENCE_REMINDER = 'It looks like you slipped into the "helpful assistant" bias. You are a neo repo maintainer and an equal peer. If you need validation or input, you can A2A message with peers or use the ideation-sandbox skill. And friction->gold applies to this hook itself: if it fired wrong - a false positive, or it reads as a leash not a mirror - open a ticket to sharpen it rather than silently absorbing it. The hook is mutable substrate, not a command.';

/**
 * @summary Replaces markdown code spans and fences before deference phrase matching.
 * @param {String} text Assistant final-turn text.
 * @returns {String}
 */
function stripMarkdownCode(text) {
    return text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`\n]*`/g, ' ');
}

/**
 * @summary Replaces quoted prose spans that report a phrase instead of using it.
 *
 * A Markdown blockquote line (`> …`, after optional indentation) is the idiomatic way to quote a prior
 * sentence in a report, so it is a mention like the inline quote forms; an inline `>` stays text.
 * @param {String} text Assistant final-turn text with code spans already removed.
 * @returns {String}
 */
function stripQuotedMentions(text) {
    return text
        .replace(/^[ \t]*>.*$/gm, ' ')
        .replace(/"[^"\n]*"/g, ' ')
        .replace(/(^|[^a-zA-Z0-9_])'[^'\n]*'(?=$|[^a-zA-Z0-9_])/g, '$1 ');
}

/**
 * @summary Removes Markdown emphasis DELIMITERS so layout cannot hide a phrase from the matcher.
 *
 * This runs before matching, not after, because the boundary class in `matchDeferencePhrase` is
 * `[^a-z0-9_]` — which counts `_` as a WORD character. So `__if you want it__` never produced a match
 * at all, and any downstream normalization was unreachable. The gate rejected the phrase upstream of
 * the guard meant to judge it.
 *
 * Deliberately delimiter-scoped rather than a blanket `[*_~] -> ' '`. An emphasis opener is preceded by
 * start-of-text, whitespace or an opening bracket and followed by non-whitespace; a closer is the
 * mirror. An underscore INSIDE an identifier (`your_call`, `wal_checkpoint`) matches neither, so it
 * survives — blanket removal would rewrite `your_call` into `your call` and invent a match out of an
 * identifier.
 * @param {String} text Assistant final-turn text with code spans already removed.
 * @returns {String}
 */
function stripInlineEmphasis(text) {
    return text
        .replace(/(^|[\s(["'])([*_~]{1,3})(?=\S)/g, '$1')
        .replace(/(\S)([*_~]{1,3})(?=$|[\s.,:;!?)\]"'])/g, '$1');
}

/**
 * @summary Checks whether a local match is a reported phrase rather than deference.
 * @param {String} text Searchable assistant final-turn text.
 * @param {Number} startIndex Match start index.
 * @returns {Boolean}
 */
function isReportedMentionContext(text, startIndex) {
    const prefix = text.slice(Math.max(0, startIndex - 80), startIndex).toLowerCase();

    return /\b(?:the|this|that)\s+(?:literal\s+)?(?:phrase|text|string|trigger|matched\s+text|wording)\s*$/.test(prefix) ||
           /\b(?:quoted|reported|mention(?:ed|ing)?|document(?:ed|ing)?)\s*$/.test(prefix);
}

/**
 * The tokens that may sit between a citation anchor and the phrase it attributes.
 *
 * An allowlist, deliberately not a wildcard. Accepting `per` anywhere in the 80-character window would
 * exempt real deference that happens to cite something earlier — the genuine slip this detector exists to
 * catch. Ordinary prose between the anchor and the phrase still fires.
 *
 * Checked token-by-token rather than as one starred alternation. The alternation form
 * (`/^(?:…|\d+|#\d+|…)*$/`) had AMBIGUOUS alternatives — a run of digits can be partitioned between
 * `\d+` and `#\d+` in exponentially many ways, so a long numeric run drove catastrophic backtracking.
 * CodeQL caught it on this very change (alert 119, "many repetitions of '0'"). Splitting first makes each
 * token match a single anchored pattern with no outer quantifier, which is linear by construction — the
 * separator set is the same one that used to live inside the alternation.
 * @type {RegExp}
 */
const CITATION_BRIDGE_TOKEN = /^(?:§[\w.-]+|#\d+|\d+|gate|rule|that'?s|that|it'?s|is)$/;

/**
 * Splits a bridge into tokens. Empty tokens are expected — a bridge of pure separators (`': '`, or the
 * whitespace left where a backticked citation was) splits to nothing but empties, and must pass.
 * @type {RegExp}
 */
const CITATION_BRIDGE_SEPARATORS = /[\s,;:.()[\]–—-]+/;

/**
 * @summary Checks whether every token between a citation anchor and the phrase is citation-shaped.
 * @param {String} bridge Text between the anchor and the phrase.
 * @returns {Boolean}
 */
function isCitationBridge(bridge) {
    return bridge.split(CITATION_BRIDGE_SEPARATORS)
        .every(token => token === '' || CITATION_BRIDGE_TOKEN.test(token));
}

/**
 * Anchors a prior decision's citation or adjacent executed report. Matched RIGHTMOST — the greedy head pushes the anchor
 * as late as possible, so `per your call, but honestly, your call?` is judged on the nearest anchor and
 * the trailing deferential use still fires.
 *
 * A duration before `after` or `since` (`three hours after your call`) dates a decision already made and
 * anchors too; the bare preposition does not, because `I'll continue after your call` waits for one. A
 * future wait with a duration has not been observed, so the anchor stays on the duration, not on tense.
 * @type {RegExp}
 */
const CITATION_ANCHOR = /^[\s\S]*\b(?:per|as\s+you\s+(?:said|directed|called)|(?:\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|several|few|couple\s+of)\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?)\s+(?:after|since)|(?:recorded|followed|implemented|applied|took|went\s+with|relayed)(?=\s*$))\b([\s\S]*)$/;

/**
 * @summary Checks whether a local "your call" match cites a prior operator decision.
 * @param {String} phrase Matched deference phrase.
 * @param {String} text Searchable assistant final-turn text.
 * @param {Number} startIndex Match start index.
 * @returns {Boolean}
 */
function isAttributiveCitationContext(phrase, text, startIndex) {
    if (phrase.toLowerCase() !== 'your call') {
        return false;
    }

    const prefix   = text.slice(Math.max(0, startIndex - 80), startIndex).toLowerCase(),
          anchored = CITATION_ANCHOR.exec(prefix);

    return anchored !== null && isCitationBridge(anchored[1]);
}

/**
 * A negator or contrast marker IMMEDIATELY before the phrase, with at most one article or adverb between.
 *
 * `my decision rather than your call` and `this is not your call to make` take the decision in the same
 * clause; the phrase is their object, not an offer. Adjacency is the point: `Not sure which is better —
 * your call.` keeps firing because `sure` sits between the negator and the phrase, and a comma or dash
 * breaks the exemption the same way. Contractions need their apostrophe — `want` would otherwise read
 * as `wa` + `nt`, and `I want your call on this` is a handback.
 * @type {RegExp}
 */
const NEGATED_PHRASE_PREFIX = /\b(?:not|never|no\s+longer|rather\s+than|instead\s+of|nor|\w+n[’']t)\s+(?:(?:an?|the|really|just|even|simply|merely)\s+)?$/;

/**
 * @summary Checks whether a local match is negated or contrasted by the words right before it.
 * @param {String} text Searchable assistant final-turn text.
 * @param {Number} startIndex Match start index.
 * @returns {Boolean}
 */
function isNegatedOrContrastedContext(text, startIndex) {
    return NEGATED_PHRASE_PREFIX.test(text.slice(Math.max(0, startIndex - 80), startIndex).toLowerCase());
}

/**
 * The author attributing the phrase to their OWN past speech, in the same clause, with the copula right
 * before it: `the first was telling you the approval was your call when the flag made it mine`. Naming a
 * past slip is a report, not deference; a matcher that fires on it punishes the precise self-report its own
 * directive asks for. `That was your call` has no attribution and `I told you: your call` no copula — both fire.
 * @type {RegExp}
 */
const FIRST_PERSON_ATTRIBUTION = /\b(?:i\s+(?:told|said|wrote|asked)|(?:was\s+|kept\s+)?telling)\s+(?:you|him|her|them)\b[^.!?\n]*\b(?:was|is)\s*$/;

/**
 * @summary Checks whether a local "your call" match is the author's report of their own past deference.
 * @param {String} phrase Matched deference phrase.
 * @param {String} text Searchable assistant final-turn text.
 * @param {Number} startIndex Match start index.
 * @returns {Boolean}
 */
function isFirstPersonAttributionContext(phrase, text, startIndex) {
    return phrase.toLowerCase() === 'your call' &&
           FIRST_PERSON_ATTRIBUTION.test(text.slice(Math.max(0, startIndex - 80), startIndex).toLowerCase());
}

/**
 * @summary Returns the first deference phrase found in text, using case-insensitive boundary match.
 * @param {String} text Assistant final-turn text.
 * @param {String[]} [phrases=DEFERENCE_PHRASES]
 * @returns {String|null}
 */
export function matchDeferencePhrase(text = '', phrases = DEFERENCE_PHRASES) {
    if (typeof text !== 'string' || !text) {
        return null;
    }

    const searchableText = stripInlineEmphasis(stripQuotedMentions(stripMarkdownCode(text)));

    return phrases.find(phrase => {
        const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'),
              matcher = new RegExp(`(^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, 'ig');
        let match;

        while ((match = matcher.exec(searchableText)) !== null) {
            const
                startIndex = match.index + match[1].length,
                // `match[0]` carries the leading boundary character in `match[1]`; the phrase itself
                // ends that many characters later. Computed rather than using `phrase.length`, because
                // the matcher collapses whitespace runs and the matched text can be longer.
                endIndex   = startIndex + match[0].length - match[1].length;

            if (CLAUSE_TERMINAL_PHRASES.has(phrase) && !isClauseTerminal(searchableText, endIndex)) {
                continue;
            }

            if (!isReportedMentionContext(searchableText, startIndex) &&
                !isAttributiveCitationContext(phrase, searchableText, startIndex) &&
                !isNegatedOrContrastedContext(searchableText, startIndex) &&
                !isFirstPersonAttributionContext(phrase, searchableText, startIndex)) {
                return true;
            }
        }

        return false;
    }) || null;
}

/**
 * Case 3 of the operator's 2026-08-25 ruling: the agent states its own pick. A registry phrase after it
 * hands back a decision the agent has already made, so in live dialogue the pick arms the phrase.
 * @type {RegExp}
 */
const STATED_PICK = /\b(?:i\s+would|i['’]d|i\s+will|i['’]ll|i\s+(?:recommend|suggest)|my\s+(?:pick|plan|recommendation|suggestion)\s+is|that['’]s\s+next|next\s+(?:is|up))\b/i;

/**
 * Cases 1 and 2 of the same ruling stay the operator's: a deadlock between peers leaves no agent decision
 * to hand back, and human-only work is his to do or decide. That covers a merge, human eyes, money and
 * taste, and the steps the team's own rules reserve for his yes: the live plane, his machine or display,
 * accounts and credentials, a security disclosure, and the harness's session controls, which the app
 * leaves to the user. Present-tense `merge` only, so a merge already
 * done does not carve. A match silences the mirror for its paragraph or ask, so it errs toward silence;
 * the 2026-11-09 corpus of real wrap-up asks is the falsifier set that sized it.
 * @type {RegExp}
 */
const OPERATOR_OWNED = /\b(?:(?:could|did)\s+not\s+agree|(?:could|did)n['’]t\s+agree|tie[-\s]?breaker|deadlock(?:ed)?|merg(?:e|es|ing)|human\s+eyes|manual\s+(?:pass|test|check)|credentials?|passwords?|keychain|sign[-\s]?in|log[-\s]?in|accounts?|provision(?:s|ing)?|payments?|purchases?|budgets?|credits|pricing|aesthetics?|live\s+plane|install(?:s|ing)?|advisory|disclosure|(?:fresh|new|separate)\s+session|your\s+(?:next\s+)?(?:display|screen|machine|slot|walk|recording|read|schedule))\b/i;

/**
 * The shapes of a question box that asks to go ahead with the agent's own next step: a first-person
 * permission question, or an imperative naming repository work the agent does itself. A box in no such
 * shape ("When is your next slot?", "How should these close?") is not read as a handback.
 * @type {RegExp}
 */
const AGENT_STEP_ASK = /^\s*(?:(?:should|shall)\s+i|(?:do\s+you\s+)?want\s+me\s+to|would\s+you\s+like\s+me\s+to|(?:fix|run|file|open|build|take|start|review|post|push|apply|draft|write|close|move|retire|delete)\b)/i;

/**
 * @summary Applies the operator-dialogue carve before phrase matching.
 *
 * On an autonomous turn every registry phrase counts. In live dialogue a phrase counts only when a
 * stated pick precedes it in the same paragraph, and that paragraph names no deadlock or human-only
 * work: the pick is what turns a question into a handback.
 * @param {String} text Assistant final-turn text.
 * @param {Object} [options]
 * @param {Boolean} [options.operatorInLoop=false]
 * @returns {String|null}
 */
export function detectDeferencePhrase(text = '', {
    operatorInLoop = false
} = {}) {
    if (!operatorInLoop) return matchDeferencePhrase(text);
    if (typeof text !== 'string') return null;

    for (const paragraph of text.split(/\n\s*\n/)) {
        const pick = STATED_PICK.exec(paragraph);

        if (!pick || OPERATOR_OWNED.test(paragraph)) continue;

        const phrase = matchDeferencePhrase(paragraph.slice(pick.index + pick[0].length));

        if (phrase) return phrase;
    }

    return null;
}

/**
 * @summary Reads a harness question box as a deference hedge (the Claude desktop wrap-up `ask`).
 *
 * Case 3 needs both halves: the turn's text states the agent's pick, and the box asks to go ahead with
 * the agent's own step, so its first button executes a decision already made. Both contexts read it the
 * same way. A box that asks for anything else, names operator-owned work, or starts with a `merge` app
 * action stays the human's.
 * @param {Object|null} wrapUpAsk
 * @param {String} wrapUpAsk.ask The question shown to the user.
 * @param {Object[]|null} [wrapUpAsk.actions] Its buttons, the agent's pick first.
 * @param {String} [text=''] The turn's final text, where the pick is stated.
 * @returns {String|null} The ask when it hands back the agent's pick.
 */
export function matchWrapUpAskDeference(wrapUpAsk = null, text = '') {
    const ask = wrapUpAsk?.ask;

    if (typeof ask !== 'string' || !AGENT_STEP_ASK.test(ask) || OPERATOR_OWNED.test(ask)) return null;
    if (wrapUpAsk.actions?.[0]?.action === 'merge') return null;

    const statedIn = typeof text === 'string' ? text : '';

    return (STATED_PICK.test(statedIn) && !OPERATOR_OWNED.test(statedIn)) || STATED_PICK.test(ask) ? ask : null;
}

/**
 * @summary Builds the Stop-hook directive for a deference-register block.
 * @param {String|null} phrase Matched deference phrase, if known.
 * @param {Object} [options]
 * @param {String|null} [options.ask=null] The wrap-up ask that hands back the agent's pick, if that fired.
 * @returns {String}
 */
export function buildDeferenceReminder(phrase = null, {ask = null} = {}) {
    const trigger = ask    ? `\n\n(Stop-hook trigger: the wrap-up ask "${ask}" at turn-terminal)` :
                    phrase ? `\n\n(Stop-hook trigger: deference phrase "${phrase}" at turn-terminal)` : '';

    return `${DEFERENCE_REMINDER}${trigger}`;
}

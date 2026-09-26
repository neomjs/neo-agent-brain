/**
 * @module ai/scripts/lint/check-aiconfig-test-mutation
 * @summary Enforces AiConfig B4 by refusing test-side writes to the shared singleton.
 *
 * Received from the Engine-side pre-split authority at `c623b2f63c^` after the repository cut
 * removed that copy. Brain owns both the Agent OS config contract and the tests this guard scans;
 * the Engine package is never a fallback distribution channel for this implementation.
 */
import * as acorn            from 'acorn';
import {execSync, spawnSync} from 'node:child_process';
import {readFileSync}        from 'node:fs';
import path                  from 'node:path';
import process               from 'node:process';
import {fileURLToPath}       from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const scriptRoot = path.resolve(__dirname, '../../..');

// Inline relief valve for a genuinely unavoidable test-config mutation (judgment-call escape, not a
// blanket bypass). A line carrying this marker is skipped.
export const ESCAPE_MARKER = 'aiconfig-mutation-ok';

/*
 * Class-A safety-critical DB-path leaves. A test that writes one of these to the shared `AiConfig`
 * singleton is the orphan-bleed mechanism: the reactive set-trap routes the assignment to the shared
 * provider, so failed cleanup / a shared process / test-ordering means the next consumer reads the
 * test DB — or a live read lands on test state (the B4 safety-critical class). A test must isolate by
 * construction (`UNIT_TEST_MODE` resolves the test DB), never mutate the singleton.
 *
 * The pattern requires a config-SHAPED root (any identifier ending in `Config`) before a dangerous leaf,
 * so a non-config `x.database = y` does not trip it; the trailing `=(?![=>])` excludes comparisons (`==` / `===`) and
 * arrows (`=>`), and a capture-read (`const x = aiConfig.storagePaths.graph`) has no `=` after the
 * leaf, so only true assignments match. A dangerous leaf is caught whether dot-accessed
 * (`.storagePaths`) or string-literal-bracket-accessed (`['storagePaths']`); a computed key
 * (`aiConfig[varName]`) is out of a static lint's reach — the escape marker + the by-construction
 * migration cover that residue. Config-VARYING leaves (retry / transport) are deliberately out of
 * scope here — that class has no by-construction story yet.
 */
const DB_PATH_LEAVES = '(?:storagePaths|database|collections|logPath)';

/*
 * The config ROOT is matched by SHAPE, not by two literal names, and that is the whole point.
 *
 * The previous anchor was `(?:aiConfig|Memory_Config)` — case-sensitive, exact. Two consequences, both
 * measured against this file's own exported pattern rather than reasoned about:
 *
 *   1. An ALIASED binding walked straight through. `mailboxAiConfig.storagePaths.graph = dbPath` was not
 *      flagged, and files bound this way (`mailboxAiConfig`, `mirrorAiConfig`) mutate Class-A leaves today.
 *   2. Far worse: a repo-wide `aiConfig` -> `AiConfig` PascalCase normalization (1,526 occurrences across
 *      198 files) would have made a case-sensitive literal anchor match NOTHING — while the rename's own
 *      "the mutation lint must stay green" criterion certified that inert gate as success. A fail-build
 *      B4 guard retired by a refactor whose acceptance criteria prove the retirement.
 *
 * So any identifier ENDING in `Config` counts as a config root: `aiConfig`, `AiConfig`, `mailboxAiConfig`,
 * `Memory_Config`, `$Config`, and whatever the next rename produces. The root boundary is a
 * lookbehind/lookahead pair rather than `\b`, because `\b` cannot sit before a `$`-leading identifier and
 * would let `$Config.…` evade a grammar that admits a leading `$`. `aiConfigDefaults` still does not match —
 * the trailing boundary requires `Config` to END the identifier — preserving prior behaviour for the
 * separate TIER1 defaults module.
 *
 * This deliberately accepts FALSE POSITIVES on unrelated `*Config` objects that assign a Class-A leaf.
 * That is the correct trade for a safety-critical gate: a false positive costs one escape marker plus a
 * stated reason, while a false negative is the orphan-bleed incident this lint exists to prevent. The
 * ESCAPE_MARKER is the sanctioned relief valve for the judgement calls.
 */
const CONFIG_ROOT = '[A-Za-z_$][\\w$]*Config';

export const DB_PATH_MUTATION = new RegExp(
    // Root boundary is a lookbehind/lookahead pair, NOT `\\b`: `\\b` fails before a `$`-leading identifier
    // (`$` is a non-word char), so `$Config.storagePaths.graph = x` evaded a grammar that advertises `$` as a
    // valid leading char. `(?<![\\w$])` / `(?![\\w$])` anchor on "not inside another identifier", which is the
    // real intent and closes that divergence in the fail-SAFE direction (catch it; a false positive costs one
    // escape marker, a false negative is the orphan incident).
    `(?<![\\w$])${CONFIG_ROOT}(?![\\w$])[\\w.$[\\]'"\`-]*` +                     // a config-shaped root, then any path chars
    `(?:\\.${DB_PATH_LEAVES}\\b|\\[\\s*['"\`]${DB_PATH_LEAVES}['"\`]\\s*\\])` + // a dangerous leaf: dot OR string-literal bracket
    `[\\w.$[\\]'"\`]*\\s*=(?![=>])`                                             // optional trailing path, then assignment (not == / =>)
);

/*
 * The RESTORE-CAPTURE rule — deliberately NOT called "Class B", which this file already spends on
 * config-VARYING leaves (retry / transport) that it holds out of scope. This is a third, orthogonal
 * axis: Class-A asks WHICH LEAF a test writes, this asks WHETHER THE UNDO CAN WORK AT ALL.
 *
 * `Neo.clone` of an `AiConfig` node captures the leaf's
 * UNRESOLVED default, not the value the provider resolves — so a save/restore pair built on it writes
 * the default back over the resolved value and reports success. The write is not lost loudly; it is
 * replaced quietly, which is why five call sites of careful-looking hygiene restored nothing at all
 * and a worker stayed polluted for its entire life.
 *
 * The four-cell measurement that fixed the target — one direct leaf write, restored four ways:
 *
 *   spread `{...node}`  + `Object.assign`        -> restored
 *   spread `{...node}`  + `restoreConfigObject`  -> restored
 *   `Neo.clone(node)`   + `Object.assign`        -> NOT restored
 *   `Neo.clone(node)`   + `restoreConfigObject`  -> NOT restored
 *
 * The restore idiom is innocent in both columns; the capture is the broken half. An earlier reading of
 * this defect blamed the restore (`Object.assign` "cannot undo a leaf write") and a still earlier one
 * blamed a zero-key clone. Both are retracted: the clone carries the key — it carries the WRONG VALUE.
 * The pattern therefore anchors on the capture and stays indifferent to whatever restores from it.
 *
 * `snapshotAiConfig` is the by-construction answer and already the majority idiom; its contract exists
 * precisely because it captures by RESOLVED value. This guard points at it rather than restating it.
 *
 * Deliberately NOT guarded — measured, not assumed: whole-SUBTREE replacement
 * (`AiConfig.orchestrator.mlx = {...}`) restores correctly, on a node with 3 keys and on one with 16,
 * and a bounded env re-resolution still reaches the replacement. The leaf binding is registry-keyed by
 * dotted path, so swapping the node object does not remove it. Forbidding that shape would fail six
 * working call sites, and a gate whose false positives dominate gets disabled rather than obeyed.
 *
 * Root shape and the false-positive posture are inherited from Class-A above: an unrelated `*Config`
 * local passed to `Neo.clone` trips this and costs one escape marker plus a stated reason.
 *
 * **The grammar admits a qualified root and ordinary line breaks, and that is not cosmetic.** The
 * first version required the config root IMMEDIATELY after `Neo.clone(`, and matched line by line.
 * Three shapes walked through it:
 *
 *   Neo.clone(SDK.Memory_Config.data)     — member-qualified, and a REAL access shape in this tree
 *   Neo.clone(context.AiConfig.data)      — namespaced
 *   Neo.clone(\n    AiConfig.data)        — ordinary formatting
 *
 * A zero-population scan under that grammar could only ever have meant "none of the shapes I can
 * express", never "none present" — the instrument's vocabulary reported as the world. Class-A already
 * anchors its root ANYWHERE in the access path for exactly this reason; this now matches it.
 */
export const CLONE_CAPTURE = new RegExp(
    // Optional member-chain prefix, so a qualified root (`SDK.Memory_Config`) is still a config root.
    // The `\s*` separators span newlines on their own — `\s` matches `\n` with or without the `s`
    // flag, which only governs `.` and this pattern has none. An earlier version passed `s` here with
    // a comment claiming it enabled the multiline match; the mutation test proved the flag inert.
    `(?<![\\w$])Neo\\s*\\.\\s*clone\\s*\\(\\s*(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)*${CONFIG_ROOT}(?![\\w$])`
);

/*
 * Files whose Class-A mutation is load-bearing — NOT a grandfathering queue. Every entry whose write
 * duplicated isolation the harness already provides by construction has been removed; what survives
 * is here because by-construction isolation provably cannot serve it, and each entry states why. A new entry needs that same justification, not a migration promise: an unexplained
 * entry is a silent licence, and the gate stops counting a file the moment it is listed.
 *
 * Both survivors restore what they write, which is what keeps the blast radius inside the spec.
 * Paths are repo-relative POSIX.
 */
export const ALLOWLIST = new Set([
    /*
     * The three logger siblings repoint `data.logPath` at a per-process temp dir. The harness DOES
     * worker-scope these (`configTemplateResolver` sets NEO_{MEMORY,KB,NL}_LOG_PATH per worker), but
     * worker-scoped is not spec-scoped: every spec sharing a worker appends to the same daily file,
     * and these suites assert on the FIRST LINE of that file. Reading the resolved path instead would
     * make the assertion depend on whichever spec logged first — so the only removal available here
     * weakens an assertion, which the burndown does not do.
     */
    'test/playwright/unit/ai/mcp/server/knowledge-base/logger.spec.mjs',
    'test/playwright/unit/ai/mcp/server/memory-core/logger.spec.mjs',
    'test/playwright/unit/ai/mcp/server/neural-link/logger.spec.mjs',
    /*
     * Flips `useUnitTestDatabase` / `useTestHarness` to false in order to assert that the destructive-
     * operation guard fires when they ARE false. The off state is the subject under test, so it cannot
     * be supplied by construction: the harness exists to hold those selectors on.
     */
    'test/playwright/unit/ai/mcp/server/shared/services/DestructiveOperationGuard.spec.mjs',
]);

/**
 * @summary Builds the whole-file per-character "is this code?" mask — false inside string literals,
 * template quasis, regex literals and comments; true in executable code.
 *
 * Ground truth is `acorn`'s tokenizer, not a hand-rolled scan. Every non-code token's span is blanked
 * and everything else stays code, so whitespace and punctuation count as code — the same convention
 * the predecessor scanner used, which is what makes the migration provable rather than merely
 * plausible (see the zero-delta evidence on {@link #codeMask}).
 *
 * A tokenizer earns its place on template literals specifically: `tt.template` covers ONLY the quasi
 * text, so the executable interior of `${...}` — including nested interpolations — stays code by
 * construction. `tt.regexp` covers the whole literal, so a regex containing a quote can no longer
 * desync the remainder of its line. Both were live misclassification classes.
 * @param {String} source
 * @returns {Boolean[]}
 */
function buildFileMask(source) {
    const mask     = new Array(source.length).fill(true),
          comments = [],
          tt       = acorn.tokTypes;

    const blank = (start, end) => {
        for (let i = start; i < end && i < source.length; i++) {
            mask[i] = false
        }
    };

    // `acorn.parse` with `onToken` — NOT `acorn.tokenizer`. A standalone tokenizer is not
    // parser-informed, so it cannot resolve the slash ambiguity from grammar context: it reads the
    // regex in `for await (const x of y) /re/.test(x)` as TWO division operators, which is precisely
    // the class this upgrade exists to eliminate. The parser knows a statement can begin there and
    // emits one `regexp` token. The token streams are otherwise identical — they differ only on the
    // cases that need context, which is to say all the hard ones.
    acorn.parse(source, {
        ecmaVersion: 'latest',
        sourceType : 'module',
        onComment  : (block, text, start, end) => comments.push([start, end]),
        onToken    : token => {
            if (token.type === tt.string || token.type === tt.template || token.type === tt.regexp || token.type === tt.invalidTemplate) {
                blank(token.start, token.end)
            }
        }
    });

    comments.forEach(([start, end]) => blank(start, end));

    return mask
}

/**
 * @summary Cuts a whole-file mask into per-line slices. Newlines are dropped — a line's mask is
 * line-length, matching the per-line contract {@link #codeMask} exposes.
 * @param {String} source
 * @param {Boolean[]} mask
 * @returns {Boolean[][]}
 */
function sliceByLine(source, mask) {
    const masks = [];

    let offset = 0;

    for (const text of source.split('\n')) {
        masks.push(mask.slice(offset, offset + text.length));
        offset += text.length + 1
    }

    return masks
}

/**
 * @summary Builds a per-character "is this code?" mask for one line — false inside string literals,
 * template quasis, regex literals and comments, true in executable code.
 *
 * The mask preserves positions, so a regex match found on the RAW line is classified by whether its
 * root token sits in code. That is what lets a string-literal *bracket key* (`['storagePaths']` — real
 * code that merely contains a string) be detected, while a mutation pattern living entirely inside a
 * string (a log message, a `describe(...)` title) is excluded.
 *
 * **Parser-grade, and why that is not gold-plating.** The predecessor scanned character by character
 * and carried `state.inBlock` across lines. Six review cycles enumerated eight classes of valid
 * JavaScript it misread, each repair exposing the next — the class list is open-ended because
 * slash/continuation grammar is a parser problem. Measured against an `acorn` oracle over 1911 files,
 * that scanner disagreed on **418,515 characters across 1152 files** — yet on **0 of 156** real
 * pattern-match sites, which is why this swap is behaviour-preserving on today's corpus while
 * eliminating the classes by construction. Two reproduced live defects it could not survive:
 * a multi-line template read as code (false POSITIVE — `inString` was function-local, so it reset at
 * every newline), and `const re = /["']/; aiConfig.database = 1;` read as string (false NEGATIVE — the
 * safety-critical direction, a silently missed Class-A mutation).
 *
 * **Why `state` carries the source.** One tokenize per file, memoized here and sliced per line, keeps
 * the per-line contract both consumers depend on (A1 additionally reads a code-only PROJECTION of it)
 * without re-parsing 1900 times. `inBlock` is gone: comment continuity is now a property of the parse,
 * not a flag the caller must hand-carry — which also deletes a live defect, since a consumer that
 * skips a line (`findDbPathMutations` returns early on {@link #ESCAPE_MARKER}) silently corrupted
 * every line after it.
 * @param {String} line The raw line — used only to size the fallback mask.
 * @param {{source: String, lineMasks: Boolean[][], parseFailed: String}} state Carries the file source
 *     and memoizes the parse across the file's lines. Mutated in place on first call.
 * @param {Number} lineIndex 0-based index of `line` within `state.source`.
 * @returns {Boolean[]} `mask[i]` is true when raw character `i` is executable code.
 */
export function codeMask(line, state, lineIndex) {
    if (!state.lineMasks) {
        try {
            state.lineMasks = sliceByLine(state.source, buildFileMask(state.source))
        } catch (error) {
            // FAIL CLOSED. A lexically broken file (mid-edit, or a syntax this acorn cannot read) must
            // never mask to all-string: that would silently green-light every rule for the whole file,
            // and a safety-critical backstop reporting clean because it could not READ the code is the
            // worst failure available to it. All-code is the conservative direction — it over-reports
            // (a string quoting the pattern flags) rather than under-.
            state.parseFailed = error.message;
            state.lineMasks   = state.source.split('\n').map(text => new Array(text.length).fill(true))
        }
    }

    return state.lineMasks[lineIndex] ?? new Array(line.length).fill(true)
}

const DB_PATH_MUTATION_GLOBAL = new RegExp(DB_PATH_MUTATION.source, 'g');

/*
 * The GENERAL shared-config write: a config-shaped root, ANY leaf, an assignment. This is what ADR
 * 0019's B4 clause actually names — "runtime writes to `AiConfig`" — where `DB_PATH_MUTATION` above
 * is the narrow DB-path subset that was implemented under the B4 label.
 *
 * That gap is the defect: the rule carrying the B4 id detected DB paths only, so a spec that wrote
 * `openAiCompatible.host` (or any other leaf outside that subset) was invisible to a gate the ADR
 * advertised as covering it. An audit of "is B4 enforced?" against the ADR returned a false assurance,
 * which is worse than an absent guard — it converts an audit question into a wrong answer.
 *
 * The surface is real and concentrated: the dominant leaf class is config-VARYING tuning knobs —
 * `openAiCompatible.*` retry/timeout leaves, `vectorDimension`, `remSleepBatchLimit` — which is
 * precisely the class this file's own header already names as having no by-construction story yet. The
 * guard prints the current measured count on every run; that printout is the receipt, and no number
 * written here is one.
 *
 * **So this rule is deliberately NOT gating.** Turning it on today would red the files whose correct
 * fix is an injected config snapshot, not an escape marker, and a gate that gets muted within a day
 * teaches the next reader the gate is optional. It ships as a measured, tested, REPORT-ONLY rule: the
 * surface stops being invisible, and promoting it to gating is a separate, deliberate step once those
 * files have a real isolation story. Per-leaf escape markers are explicitly NOT that story — they are
 * how a class of leaves becomes a class of unexamined exemptions.
 */
export const SHARED_CONFIG_MUTATION = new RegExp(
    `(?<![\\w$])${CONFIG_ROOT}(?![\\w$])` +                    // a config-shaped root, same grammar as the DB-path rule
    `(?:\\.[A-Za-z_$][\\w$]*|\\[[\\s]*['"\`][^'"\`]+['"\`]\\s*\\])+` + // ANY leaf: dotted or string-literal bracket
    `\\s*=(?![=>])`                                             // assignment, excluding `==` / `===` / `=>`
);

/**
 * The `Object.assign(<config root>…)` write form, kept as its OWN pattern rather than an alternation
 * on {@link SHARED_CONFIG_MUTATION}: a bare `,<object literal>` alternative also matches any call that
 * merely PASSES a config value alongside a literal (`foo(KB_Config.data, {a: 1})`), which is a read.
 * Anchoring on the callee is the only thing that separates the write from the read.
 */
export const SHARED_CONFIG_ASSIGN_CALL = new RegExp(
    `\\bObject\\.assign\\s*\\(\\s*(?<![\\w$])${CONFIG_ROOT}(?![\\w$])` + // `Object.assign(<config root>…`
    `(?:\\.[A-Za-z_$][\\w$]*|\\[[\\s]*['"\`][^'"\`]+['"\`]\\s*\\])*` +   // any depth of leaf path, including none
    `\\s*,`
);

const SHARED_CONFIG_MUTATION_GLOBAL   = new RegExp(SHARED_CONFIG_MUTATION.source, 'g'),
      SHARED_CONFIG_ASSIGN_CALL_GLOBAL = new RegExp(SHARED_CONFIG_ASSIGN_CALL.source, 'g');

/**
 * @summary Scans file content for ANY write through a config-shaped `*Config` root — the B4 clause's
 * full scope, as opposed to {@link findDbPathMutations}'s DB-path subset.
 *
 * Two write forms are recognised, because each key of an `Object.assign(<config root>, …)` is still a
 * `[[Set]]` on the hierarchical proxy and therefore still routes to the owning provider's `setData`:
 * `assignment` (`<root>.<leaf> = …`) and `assign-call` (`Object.assign(<root>.<leaf>, {…})`). A hit's
 * `form` says which, because the two have different blast radii — one `assign-call` can write many
 * leaves, so a per-hit count is a lower bound on leaves touched, never a census.
 *
 * **Out of static reach, deliberately.** A subtree bound to a local first (`const s = AiConfig.x;
 * s.y = 1`) and any computed key (`root[key] = 1`) are invisible here, exactly as they are for the
 * DB-path rule. A spec that wants to mutate config in isolation goes through an injected snapshot
 * instead; that is the sanctioned form, not a gap this detector is trying to close.
 *
 * Report-only by design. Exported and unit-tested so the promotion to a gating rule is a wiring change
 * in one place rather than a re-derivation. Run it for the CURRENT disposition — the guard prints the
 * live measured count on every run, and no number in a comment or a decision record is a receipt.
 *
 * @param {String} content
 * @returns {Object[]} `[{line, text, leaf}]` — one entry per offending line (1-based line numbers).
 */
export function findSharedConfigMutations(content) {
    const lines = content.split('\n'),
          state = {source: content},
          hits  = [];

    lines.forEach((line, index) => {
        if (line.includes(ESCAPE_MARKER)) {
            return
        }

        const mask = codeMask(line, state, index);

        // Two patterns, two forms, one per hit. `SHARED_CONFIG_ASSIGN_CALL` is scanned on the same
        // masked line so a mention in a comment or a string cannot register either way.
        for (const [pattern, form] of [[SHARED_CONFIG_MUTATION_GLOBAL, 'assignment'], [SHARED_CONFIG_ASSIGN_CALL_GLOBAL, 'assign-call']]) {
            for (const match of line.matchAll(pattern)) {
                if (mask[match.index]) {
                    hits.push({
                        line : index + 1,
                        text : line.trim(),
                        leaf : form === 'assign-call'
                            // the call carries the config path, not the callee: `Object.assign(` is noise here
                            ? match[0].slice(match[0].indexOf('(') + 1).replace(/\s*,\s*$/, '')
                            : match[0].replace(/^[\w$]+/, '').replace(/\s*=(?![=>]).*$/, ''),
                        form
                    });
                    break
                }
            }
        }
    });

    return hits
}

/**
 * @summary Scans file content for Class-A DB-path `AiConfig` mutations whose root token sits in code.
 * @param {String} content
 * @returns {Object[]} `[{line, text}]` — one entry per offending line (1-based line numbers).
 */
export function findDbPathMutations(content) {
    const lines = content.split('\n'),
          state = {source: content},
          hits  = [];

    lines.forEach((line, index) => {
        if (line.includes(ESCAPE_MARKER)) {
            return
        }

        const mask = codeMask(line, state, index);

        for (const match of line.matchAll(DB_PATH_MUTATION_GLOBAL)) {
            // The match starts at the aiConfig / Memory_Config root; flag it only when that root is real
            // code, not a string that merely quotes a mutation-looking pattern (a bracket key like
            // `['storagePaths']` is fine — its root token is still in code).
            if (mask[match.index]) {
                hits.push({line: index + 1, text: line.trim()});
                break
            }
        }
    });

    return hits
}

const CLONE_CAPTURE_GLOBAL = new RegExp(CLONE_CAPTURE.source, 'g');

/**
 * @summary Scans file content for `Neo.clone` restore-captures of an `AiConfig` node.
 *
 * Shares Class-A's code mask and escape marker — the same ground truth, not a second hand-rolled
 * scan — but matches over a CODE-ONLY projection of the whole file rather than line by line, because
 * a capture whose argument wraps across lines is ordinary formatting and was previously invisible.
 *
 * The projection preserves offsets exactly: every non-code character is replaced by a space, so a
 * match index still maps to its real line, and a pair quoted inside a string or comment still cannot
 * match. Masking per line and then joining keeps `codeMask` authoritative rather than re-deriving it.
 * @param {String} content
 * @returns {Object[]} `[{line, text}]` — one entry per offending line (1-based line numbers).
 */
export function findCloneCaptures(content) {
    const lines = content.split('\n'),
          state = {source: content};

    // Offset-preserving code-only projection: same length, non-code blanked.
    //
    // Indexed by UTF-16 CODE UNIT, deliberately. `[...line]` iterates code POINTS, and acorn's token
    // offsets, `line.length` and the `lineStarts` table below all count code units — so one astral
    // character (an emoji in a comment is enough) made the projection SHORTER than its source and
    // shifted every offset after it. Measured consequences of that version:
    //
    //   /*📐*/Neo.clone(AiConfig.data);   → blanked the `N` of executable `Neo`; no hit
    //   an astral comment line above      → mapped the next line's hit onto the line above, where an
    //                                       unrelated escape marker then suppressed it
    //
    // A silent bypass of a safety gate, reachable by typing an emoji in a comment. A surrogate pair
    // is never split by this loop in practice: a token boundary cannot fall between its halves, so
    // both units are always classified the same way.
    const codeOnly = lines.map((line, index) => {
        const mask = codeMask(line, state, index);
        let   out  = '';

        for (let unit = 0; unit < line.length; unit++) {
            out += mask[unit] ? line[unit] : ' '
        }

        return out
    }).join('\n');

    const lineStarts = [];
    let   cursor     = 0;

    for (const line of lines) {
        lineStarts.push(cursor);
        cursor += line.length + 1
    }

    const lineOf = offset => {
        let low = 0, high = lineStarts.length - 1;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (lineStarts[mid] <= offset) low = mid; else high = mid - 1
        }
        return low
    };

    const hits = [],
          seen = new Set();

    for (const match of codeOnly.matchAll(CLONE_CAPTURE_GLOBAL)) {
        const index = lineOf(match.index);

        // The marker is read from the line the capture STARTS on — where an author would write it.
        if (lines[index].includes(ESCAPE_MARKER)) continue;
        if (seen.has(index)) continue;

        seen.add(index);
        hits.push({line: index + 1, text: lines[index].trim()})
    }

    return hits
}

/**
 * @summary AiConfig catalog rules enforced by this guard, with each id attached to the
 * executable detector the scanner invokes.
 *
 * The restore-capture detector is intentionally absent: it is a separate correctness class and
 * does not claim an AiConfig catalog id. Keeping B4 on the detector object prevents a detached
 * file-level id list from agreeing with comments while the executable rule changes underneath it.
 *
 * `id` is the antipattern CATALOG KEY, not a free label: the two-way ownership check in
 * `lint-config-template-ssot.mjs` parses the catalog's id cells with `/\b([A-C]\d+)\b/` and
 * resolves every registry id back to a row, so an id carrying a scope suffix (`B4-DB-PATH`)
 * parses as `B4` and two such rules collide into a `duplicate-row`. One antipattern, one catalog
 * row, one id — the half is therefore carried by `scope` (and by `gating`, which is what the
 * scanner actually branches on), never by the id.
 * @type {ReadonlyArray<{id: String, scope: String, detect: Function, gating: Boolean}>}
 */
export const ADR_0019_RULES = Object.freeze([
    Object.freeze({id: 'B4', scope: 'db-path-subset',  detect: findDbPathMutations,     gating: true}),
    Object.freeze({id: 'B4', scope: 'full',           detect: findSharedConfigMutations, gating: false})
]);

const GATING_RULE = ADR_0019_RULES.find(rule => rule.gating),
      REPORT_ONLY_RULE = ADR_0019_RULES.find(rule => !rule.gating);

/**
 * @summary Scans one file's content for both rules, applying the allowlist to Class-A only.
 *
 * The allowlist is scoped to Class-A and stays that way. Every entry justifies a DB-PATH mutation
 * specifically — a logger repointing `data.logPath`, a guard spec flipping its own selectors off —
 * and not one of those reasons says anything about capture fidelity. Letting a narrow, stated
 * exemption suppress an unrelated rule is how an allowlist becomes a blanket bypass, which is the
 * failure this file's own header warns about.
 *
 * Exported with an injectable allowlist because that scoping is a real behaviour and the alternative
 * ways to test it are all worse: asserting it through the CLI against a genuinely allowlisted file
 * passes whether or not the scoping holds (no such file contains a restore-capture), and the honest
 * version of that test would have to mutate a tracked spec mid-run.
 * @param {String} file Repo-relative POSIX path.
 * @param {String} content
 * @param {Object} [options]
 * @param {Set<String>} [options.allowlist=ALLOWLIST]
 * @returns {{dbPathHits: Object[], sharedConfigHits: Object[], cloneHits: Object[]}}
 */
export function scanFileContent(file, content, {allowlist = ALLOWLIST} = {}) {
    return {
        // Gating: the DB-path class, honestly named. `dbPathHits` keeps its field name so the allowlist
        // scoping below stays scoped to what it always was — a DB-PATH justification.
        dbPathHits: allowlist.has(file) ? [] : GATING_RULE.detect(content),
        // Report-only: the full B4 clause's surface. The allowlist does NOT suppress this, and that is
        // deliberate: an allowlist entry justifies a DB-PATH mutation specifically, and extending that
        // reasoning to an unrelated leaf is how a narrow exemption becomes a blanket bypass. Reported
        // rather than gating, so an allowlisted file still shows its shared-config writes.
        sharedConfigHits: REPORT_ONLY_RULE.detect(content),
        cloneHits        : findCloneCaptures(content)
    }
}

/**
 * @summary Normalizes an input path (absolute from lint-staged, or relative) to a repo-relative POSIX path.
 * @param {String} file
 * @param {String} gitRoot
 * @returns {String}
 */
export function toRepoRelative(file, gitRoot) {
    return path.relative(gitRoot, path.resolve(gitRoot, file)).split(path.sep).join('/')
}

function main() {
    let gitRoot;
    try {
        gitRoot = execSync('git rev-parse --show-toplevel', {cwd: scriptRoot, encoding: 'utf-8'}).trim();
    } catch (e) {
        console.error('\x1b[31mError: Could not determine git repository root.\x1b[0m');
        process.exit(1);
    }

    // Minimal argv parse, hand-rolled because it is five lines and a CLI dependency would cost more
    // than it saves — NOT because this workflow avoids `npm install`. It no longer does: `codeMask`
    // imports acorn, so the workflow installs, like `jsdoc-type-lint`, `ticket-archaeology-lint`,
    // `tree-json-lint` and `config-template-ssot-lint` already did. (The claim previously stated
    // here — that the other lint workflows are dependency-free — was false when written.)
    // lint-staged passes staged paths as positional args; `--quiet` suppresses the per-violation listing.
    const rawArgv   = process.argv.slice(2),
          quiet     = rawArgv.includes('-q') || rawArgv.includes('--quiet'),
          argvFiles = rawArgv.filter(arg => !arg.startsWith('-'));

    function collectDefaultFiles() {
        const result = spawnSync('find', ['test', '-type', 'f', '-name', '*.mjs'], {cwd: gitRoot, encoding: 'utf-8'});
        if (result.status !== 0) {
            console.error('\x1b[31mError: find command failed.\x1b[0m');
            console.error(result.stderr);
            process.exit(1);
        }
        return result.stdout.trim().split('\n').filter(Boolean);
    }

    const rawFiles = argvFiles.length > 0 ? argvFiles : collectDefaultFiles();
    const files    = rawFiles
        .filter(f => f.endsWith('.mjs'))
        .map(f => toRepoRelative(f, gitRoot))
        .filter(f => f.startsWith('test/'));

    if (files.length === 0) {
        console.log('check-aiconfig-test-mutation: 0 test .mjs files in scope, nothing to check.');
        process.exit(0);
    }

    const violations        = [],
          cloneViolations   = [],
          sharedConfigWrites = [];

    for (const file of files) {
        let content;
        try {
            content = readFileSync(path.resolve(gitRoot, file), 'utf-8');
        } catch (e) {
            console.error(`check-aiconfig-test-mutation: could not read ${file}: ${e.message}`);
            continue
        }

        const {dbPathHits, cloneHits, sharedConfigHits} = scanFileContent(file, content);

        dbPathHits.forEach(({line, text}) => violations.push(`${file}:${line}: ${text}`));
        cloneHits.forEach(({line, text}) => cloneViolations.push(`${file}:${line}: ${text}`));
        sharedConfigHits.forEach(hit => sharedConfigWrites.push({file, ...hit}));
    }

    // REPORT-ONLY, deliberately outside the exit decision. The count is printed on every run because
    // the whole defect this rule addresses was that the surface was INVISIBLE — a gate that says
    // "0 violations" while the real number of writes sits behind a narrower rule is a false
    // assurance, and printing the number is the cheapest way to stop it being one again. It does not
    // fail the build, because turning it on today would red the files whose correct fix is an
    // injected config snapshot.
    const distinctLeaves = new Set(sharedConfigWrites.map(write => write.leaf)),
          assignCalls    = sharedConfigWrites.filter(write => write.form === 'assign-call').length;

    console.log(`check-aiconfig-test-mutation: ${files.length} test file(s) scanned, ` +
        `${violations.length} new DB-path violation(s), ${sharedConfigWrites.length} shared-config write(s) ` +
        `across ${distinctLeaves.size} leaf/leaves (REPORT-ONLY, ADR-0019 B4 scope: ` +
        `${sharedConfigWrites.length - assignCalls} assignment, ${assignCalls} Object.assign).`);

    if (!quiet && sharedConfigWrites.length > 0) {
        console.log(`\n  B4 full scope — ${sharedConfigWrites.length} write(s) through a shared *Config root. Not gating yet;`);
        console.log('  see the SHARED_CONFIG_MUTATION comment for the sequencing rationale. Top leaves:');

        [...distinctLeaves]
            .map(leaf => ({leaf, n: sharedConfigWrites.filter(write => write.leaf === leaf).length}))
            .sort((left, right) => right.n - left.n)
            .slice(0, 10)
            .forEach(({leaf, n}) => console.log(`    ${String(n).padStart(4)}  ${leaf}`));
    }

    if (cloneViolations.length > 0) {
        console.error(`\x1b[31mcheck-aiconfig-test-mutation: ${cloneViolations.length} ineffective AiConfig restore capture(s) in tests:\x1b[0m`);
        if (!quiet) {
            cloneViolations.forEach(v => console.error('  ' + v));
            console.error('\n`Neo.clone` of an AiConfig node captures the leaf DEFAULT, not the value the provider resolves,');
            console.error('so restoring from it writes the default back over the resolved value and reports success. Capture');
            console.error('by resolved value with `snapshotAiConfig(aiConfig, paths)` instead — or, only if genuinely');
            console.error(`unavoidable, add an "${ESCAPE_MARKER}: <reason>" marker on the line.`);
        }
    }

    if (violations.length > 0) {
        console.error(`\x1b[31mcheck-aiconfig-test-mutation: ${violations.length} DB-path AiConfig mutation(s) in tests:\x1b[0m`);
        if (!quiet) {
            violations.forEach(v => console.error('  ' + v));
            console.error('\nA test must NEVER mutate the shared AiConfig DB paths — test data bleeds into live DBs (the');
            console.error('#12335 orphan incident; ADR-0019 §4 B4). Isolate by construction (UNIT_TEST_MODE resolves the');
            console.error(`test DB), or — only if genuinely unavoidable — add an "${ESCAPE_MARKER}: <reason>" marker on the line.`);
        }
    }

    // ONE exit decision covering both classes. Reporting Class-B and then falling through to the
    // success line would print violations and exit 0 — a gate that describes a problem instead of
    // failing on it, which is the exact shape this lint exists to prevent elsewhere.
    if (violations.length > 0 || cloneViolations.length > 0) {
        process.exit(1);
    }

    console.log(`check-aiconfig-test-mutation: ${files.length} test file(s) scanned, 0 gating violation(s) ` +
        `(DB-path + restore-capture). ${sharedConfigWrites.length} shared-config write(s) reported above.`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (invokedDirectly) {
    main()
}

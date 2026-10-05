import {test, expect} from '@playwright/test';
import fs             from 'fs';
import path           from 'path';

/**
 * The ordinal-100 re-chunk pass, ordered before the emitter's aggregate verdict.
 *
 * The property: the corpus WRITER carries the re-chunk pass, so every reader of the corpus reads an
 * already-canonical layout instead of repairing one it never wrote. Position-dependent chunking
 * drifts whenever a delta sync re-places only the items it touched, so the pass is idempotent and
 * belongs with the writer. It must run before the aggregate verdict: facets persist as they complete
 * and the verdict throws when any facet failed, so a pass placed after it would leave the facets that
 * did advance in a drifted layout on exactly the runs that most need it.
 *
 * Why this is a SOURCE-ordering assertion and not a behavioural one. `reconcileActiveChunks` is a
 * DEFAULT ESM import and the call site reads that module binding directly. Module bindings are
 * immutable from outside, so there is nothing a test can reassign in order to observe the call — the
 * seam a behavioural arm needs does not exist without a loader hook this runner does not provide.
 * Source-ordering is therefore the strongest instrument available here, not the cheaper one. If the
 * emitter ever takes the pass as an injected collaborator, rewrite this behaviourally.
 *
 * Two deliberate choices about what it may pin:
 *
 * - No TOTAL over `await reconcileActiveChunks(`. A total is satisfied by three calls that re-chunk
 *   the same facet three times and leave another unchunked, and it fails on a legitimately added
 *   facet while saying nothing about the property. The assertion is keyed by facet instead.
 * - The last arm reads the call sites out of the source rather than off a name list, so a facet this
 *   spec has never heard of still cannot be re-chunked after the verdict.
 *
 * Every arm is scoped to `emitGeneratedContent`'s own body. The claim is about the pass this method
 * performs before it rules on its facets; a re-chunk in some other method is a different question,
 * and a whole-file assertion would answer it wrongly by failing on one.
 */

const
    root       = process.cwd(),
    sourcePath = 'ai/services/github-workflow/SyncService.mjs',
    // The chunked corpus types the ordinal-100 pass covers. `releases` is a facet of the emitter's
    // own accounting but not of this pass — the two vocabularies are not the same set, and keying
    // this list off the emitter's `facet(...)` names would conflate them.
    corpusFacets = ['pulls', 'issues', 'discussions'],
    // A class member at exactly one indent level: `async name(`, `name(`, `#name(`, `get name(`.
    memberPattern = /^ {4}(?:static\s+)?(?:async\s+|get\s+|set\s+)?[#\w$]+\s*\(/;

/**
 * @summary Returns the body lines of `emitGeneratedContent`, as `{index, line}` entries.
 * @param {String[]} lines Emitter source split on newlines.
 * @returns {Object[]} The method's own lines, carrying their absolute source line index.
 */
function emitterBody(lines) {
    const start = lines.findIndex(line => /^ {4}async emitGeneratedContent\(/.test(line));

    if (start === -1) {
        return []
    }

    const after = lines.findIndex((line, index) => index > start && memberPattern.test(line));

    return lines
        .slice(start, after === -1 ? lines.length : after)
        .map((line, offset) => ({index: start + offset, line}))
}

test.describe('SyncService — the corpus re-chunk precedes the aggregate verdict (#298)', () => {
    const
        lines   = fs.readFileSync(path.join(root, sourcePath), 'utf8').split('\n'),
        body    = emitterBody(lines),
        verdict = body.find(entry => /const failedFacets = outcomes\.filter\(/.test(entry.line));

    test('the emitter rules on its facets at all — the anchor every ordering below is measured against', () => {
        // Non-vacuity, twice over: an unfound method body makes every `for` loop below iterate nothing
        // and pass, and an absent verdict would leave the ordering measured against nothing.
        expect(body.length, `${sourcePath}: emitGeneratedContent's body must be locatable`)
            .toBeGreaterThan(0);

        expect(verdict, `${sourcePath}: the aggregate verdict is the ordering anchor and must exist`).toBeTruthy()
    });

    test('each corpus facet is re-chunked exactly once, and before the verdict', () => {
        for (const facet of corpusFacets) {
            const calls = body.filter(entry =>
                new RegExp(`await reconcileActiveChunks\\([^)]*type:\\s*'${facet}'`).test(entry.line));

            // Exactly one: a dropped facet leaves its corpus non-canonical for every downstream
            // reader, and a duplicated one is dead work that hides which call site is load-bearing.
            expect(calls.length, `${sourcePath}: facet "${facet}" must be re-chunked exactly once`).toBe(1);

            expect(calls[0].index,
                `${sourcePath}: facet "${facet}" is re-chunked at line ${calls[0].index + 1}, after the ` +
                'verdict — a failed facet would leave the facets that advanced in a drifted layout')
                .toBeLessThan(verdict.index)
        }
    });

    test('no re-chunk call of any facet sits after the verdict', () => {
        // Read off the source rather than off `corpusFacets`, so a facet added later — one this spec
        // does not know by name — still cannot be re-chunked too late. This is the clause that keeps
        // the arm honest as the corpus grows, in place of a pinned total.
        const calls = body.filter(entry => /await reconcileActiveChunks\(/.test(entry.line));

        expect(calls.length, `${sourcePath}: the emitter must carry the re-chunk pass`).toBeGreaterThan(0);

        for (const {index} of calls) {
            expect(index, `${sourcePath}: a reconcileActiveChunks call at line ${index + 1} runs after the verdict`)
                .toBeLessThan(verdict.index)
        }
    })
});

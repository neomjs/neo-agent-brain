/**
 * @module ai/services/shared/captureReceipt
 * @summary The vocabulary a backup receipt uses to say what a row count MEANS, and the single rule
 * that derives a verdict from it.
 *
 * A count of `0` answers "how many rows did I write". It does not answer "was there a corpus here",
 * and the two questions have the same answer shape. Live evidence: 4 of 36 bundles in one store carry
 * `expected: 0, exported: 0` with the message `"Export complete."`, across four separate dates.
 *
 * **Three facts, three axes — never one enum.** The predecessor of this module collapsed them onto a
 * single `captured | empty | unavailable` value and was Drop+Superseded for it. Collapsing means any
 * two of the facts cannot be stated at once, and it forced a changed collection identity to be read
 * as data loss. Neo's own re-embed disproves that reading: `VectorService` rebuilds the corpus into a
 * shadow collection and promotes it with a two-rename transaction — live → parking, shadow →
 * canonical — so **every healthy re-embed changes the canonical collection's identity with nothing
 * lost**. A restore does the same, by dropping and re-resolving. An identity that changes is a
 * statement about lineage; loss is a different proposition needing its own evidence.
 *
 * So the receipt records the facts orthogonally and derives from them, in one place, only claims that
 * the facts actually establish — today `provenEmpty` and `collapsed`.
 *
 * **Two claims, not two enums.** `collapsed` was added for #270, where a run resolved a collection
 * that was not the live corpus, exported zero rows, and published as the newest backup. It is not a
 * second opinion about emptiness: it consumes a FOURTH fact — `previousRowCount`, what the comparison
 * bundle counted for the same source — and answers the question `provenEmpty` deliberately declines,
 * namely which reading of `zero + changed` applies. The two can never both be true, because
 * `provenEmpty` requires `lineage: same` and `collapsed` requires `lineage: changed`; and they are
 * both false for every shape where the facts support neither. Adding the fact rather than widening
 * either verdict is what keeps the axes orthogonal.
 *
 * **Read completeness is NOT an axis here, and its absence is the same rule applied to itself.** An
 * earlier revision carried `readCompleteness: complete | unavailable`, and nothing in the substrate
 * could ever emit `unavailable`: `#exportCollection` throws `PARTIAL_COLLECTION_EXPORT` on
 * `exported !== expected` and the graph exporter does the same, so a partial read aborts the capture
 * and never reaches a receipt. A vocabulary value nothing can emit is a promise the contract cannot
 * keep — the reason `partial` was excluded in the first place — so the whole axis is gone until a
 * producer exists AND the publication contract authorizes a bounded read. Every published receipt
 * describes a complete read by construction; that guarantee lives in the abort, not in a field that
 * only ever prints one value.
 *
 * **This module answers PROVENANCE, not survivability, and its claim is named `provenEmpty` for it.**
 * It means "the facts establish there was genuinely nothing to capture". Whether a bundle carries
 * recoverable payload is a different proposition with a different owner —
 * {@link module:ai/services/memory-core/helpers/bundleIntegrity} — which classifies a zero-row export
 * as `status: 'empty'` and disqualifies it as a recovery source no matter WHY it is zero. The two
 * never contradict because they never claim the same thing: a `zero + changed` source is not
 * `provenEmpty` (the facts do not support the claim) and its bundle is still `empty` (nothing to
 * restore).
 *
 * **Why the lexical separation lands HERE and not on the older field.** Both blocks originally said
 * `empty` about the same zero, and the obvious repair was to rename the survivability status to
 * something like `zero-rows`. That was implemented, and it was wrong: `integrity[].status` is a
 * persisted wire value matched by exact string in readers that are already deployed, so a bundle
 * written with a new token reads to them as having no zero-row subsystem at all — `restorable: true`
 * for a bundle holding nothing. Compatibility is one-directional by construction. This field is the
 * one nothing has persisted yet, so it is the only one that can still be renamed for free, and it
 * absorbs the whole distinction.
 *
 * @see https://github.com/neomjs/neo/issues/16404
 */

/**
 * Did the source hold rows? A measurement, never a judgement.
 *
 * `unestablished` is the answer when the producer handed over something that is not a row count —
 * absent, `NaN`, `Infinity`, or negative. It is a THIRD answer on purpose: coercing a malformed
 * observation to `0` manufactures affirmative evidence of emptiness out of a broken instrument, which
 * is the same conflation this module exists to break, one layer earlier.
 * @type {Object}
 */
export const ROW_STATE = Object.freeze({
    populated    : 'populated',
    zero         : 'zero',
    unestablished: 'unestablished'
});

/**
 * Is this the same source that the comparison bundle observed?
 *
 * `unknown` is structural, not defensive: first run, a comparison bundle swept away by retention, and
 * any capture whose predecessor recorded no identity all land here honestly. It is what lets an
 * unmeasured event degrade instead of breaking the verdict.
 * @type {Object}
 */
export const LINEAGE = Object.freeze({same: 'same', changed: 'changed', unknown: 'unknown'});

/**
 * @summary Compares one source's identity against the same source in the previous published bundle.
 *
 * Identity, not name. The name is stable across a promotion by construction — that is what promotion
 * IS — so a name comparison would report continuity across exactly the event that breaks it.
 *
 * @param {Object}       options
 * @param {String|null} [options.currentId]  Identity observed during this capture.
 * @param {String|null} [options.previousId] Identity the comparison bundle recorded for the same source.
 * @returns {String} A `LINEAGE` value.
 */
export function deriveLineage({currentId = null, previousId = null} = {}) {
    if (!currentId || !previousId) {
        return LINEAGE.unknown
    }

    return currentId === previousId ? LINEAGE.same : LINEAGE.changed
}

/**
 * @summary Derives `provenEmpty` — the module's claim about PROVENANCE — from the recorded facts.
 *
 * **`provenEmpty` requires both axes to line up: a measured zero, and a continuous lineage.** Any
 * other combination leaves the facts standing rather than collapsing them, because every other
 * combination has a reading in which the corpus was fine:
 *
 * - `zero + changed` — the source was replaced between captures. A promotion or restore does this
 *   deliberately; so does a loss. The receipt says which facts it saw and refuses to guess.
 * - `zero + unknown` — nothing to compare against. First run looks exactly like this.
 * - `unestablished + *` — the count is not a measurement, so it cannot evidence a measurement's
 *   conclusion. A broken instrument reads as no evidence, never as evidence of nothing.
 * - `populated + *` — rows are self-evidencing; a source that returns rows was not empty.
 *
 * @param {Object} options
 * @param {String} options.rowState A `ROW_STATE` value.
 * @param {String} options.lineage  A `LINEAGE` value.
 * @returns {Boolean} Whether the facts support the single claim "this source was genuinely empty".
 */
export function derivesProvenEmpty({rowState, lineage} = {}) {
    return rowState === ROW_STATE.zero
        && lineage  === LINEAGE.same
}

/**
 * @summary Derives `collapsed` — the claim that this source DEMONSTRABLY lost a corpus it had.
 *
 * The exact complement of {@link derivesProvenEmpty} on the one combination that function leaves
 * standing for a reason. `zero + changed` has two readings — a deliberate replacement, or a loss —
 * and `provenEmpty` correctly refuses to pick between them from two axes alone. This function adds
 * the third axis that separates them: **what the comparison bundle counted for the same source.**
 *
 * A promotion or restore replaces a source and the replacement HOLDS the corpus, so it reads
 * `populated + changed`. A source that changed identity and came back with nothing, where the
 * predecessor demonstrably held rows, is the only shape left. That is a collapse, and it is the
 * single row of the ticket's verdict table that must not become the newest backup.
 *
 * **Every axis is required to be affirmative, and each exclusion is load-bearing:**
 *
 * - `lineage !== changed` — `same` means the source never moved, and `unknown` means the comparison
 *   never happened. Firing on `unknown` would resurrect exactly the failure
 *   {@link module:ai/scripts/maintenance/backup.readPreviousBundleIdentities} argues against: a
 *   backup that refuses because it cannot find its predecessor is worse than one that cannot prove
 *   emptiness. A missing predecessor must degrade, never refuse.
 * - `rowState !== zero` — `populated` is a healthy replacement. `unestablished` is a broken
 *   instrument, and a broken instrument is not evidence of a collapse any more than it is evidence
 *   of emptiness; it must not be able to abort a capture.
 * - `previousRowCount` not finite, or `<= 0` — no prior corpus was demonstrated, so nothing was
 *   demonstrably lost. A first run, a predecessor that recorded no count, and a predecessor that
 *   legitimately held zero all land here and all still publish. **Emptiness alone is never the
 *   trigger** — the prior non-zero is what turns an observation into a demonstrated loss.
 *
 * @param {Object}        options
 * @param {String}        options.rowState         A `ROW_STATE` value.
 * @param {String}        options.lineage          A `LINEAGE` value.
 * @param {Number|null}   options.previousRowCount Rows the comparison bundle recorded for this source.
 * @returns {Boolean} Whether the facts establish that a corpus this source HELD is now gone.
 */
export function derivesCollapse({rowState, lineage, previousRowCount} = {}) {
    return rowState === ROW_STATE.zero
        && lineage  === LINEAGE.changed
        && Number.isFinite(previousRowCount)
        && previousRowCount > 0
}

/**
 * @summary Assembles one source's receipt entry from its measured facts.
 *
 * Deliberately does NOT take a verdict argument. Callers supply what they observed; the derivation is
 * this module's and stays in one place, so a second consumer cannot invent a fourth reading of the
 * same three facts.
 *
 * **A malformed count is rejected, never repaired.** Absent, `NaN`, `Infinity` and negative values do
 * not describe a number of rows, so they cannot stand in for one: they classify as
 * `ROW_STATE.unestablished`, and `rowCount` reports the raw finite observation or `null` when the
 * producer supplied nothing a number could be read from. An earlier revision coalesced all four to
 * `0`, which let a broken exporter plus an unchanged identity derive `empty: true` — a positive claim
 * of emptiness assembled entirely out of the absence of evidence.
 *
 * **`previousRowCount` is the receipt's one INDEPENDENT expectation.** Every other number here is
 * read through this capture's own source resolution, so when that resolution is wrong they are all
 * wrong together and agree with each other — which is how a run that resolved the wrong collection
 * recorded `expected: 0` beside `count: 0` and read as satisfied. The comparison bundle was written
 * by a different run against a different resolution, so its count is the only figure on the receipt
 * that a bad resolution cannot move. `null` when there is nothing to compare against: **unavailable,
 * never `0`** — the same rule this module already applies to a malformed `rowCount`, since a zero
 * standing in for an absent expectation is once more affirmative evidence manufactured from silence.
 *
 * @param {Object}       options
 * @param {String}       options.source        Stable label for the source (collection name / `native-graph`).
 * @param {Number}       options.rowCount      Rows the export actually wrote.
 * @param {String|null} [options.collectionId] Identity observed this capture; `null` when unobservable.
 * @param {String|null} [options.previousId]   Identity the comparison bundle recorded.
 * @param {String|null} [options.comparedBundle] Bundle name the comparison ran against.
 * @param {Number|null} [options.previousRowCount] Rows the comparison bundle recorded for this source.
 * @returns {Object} The receipt entry, carrying every fact plus the derived `provenEmpty` and
 *          `collapsed` claims.
 */
export function buildSourceReceipt({
    source,
    rowCount,
    collectionId     = null,
    previousId       = null,
    comparedBundle   = null,
    previousRowCount = null
} = {}) {
    const measured = Number.isFinite(rowCount) && rowCount >= 0,
          lineage  = deriveLineage({currentId: collectionId, previousId}),
          // Same admission rule as `rowCount`: only a finite, non-negative observation is a count.
          // Anything else is an ABSENT expectation and must read as such, so it can neither satisfy
          // a zero nor evidence a collapse.
          priorRows = Number.isFinite(previousRowCount) && previousRowCount >= 0
              ? previousRowCount
              : null;

    let rowState;

    if (!measured) {
        rowState = ROW_STATE.unestablished
    } else {
        rowState = rowCount > 0 ? ROW_STATE.populated : ROW_STATE.zero
    }

    return {
        source,
        rowCount        : Number.isFinite(rowCount) ? rowCount : null,
        rowState,
        lineage,
        collectionId,
        comparedBundle,
        previousRowCount: priorRows,
        provenEmpty     : derivesProvenEmpty({rowState, lineage}),
        collapsed       : derivesCollapse({rowState, lineage, previousRowCount: priorRows})
    }
}

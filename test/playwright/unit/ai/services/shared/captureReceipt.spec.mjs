import {test, expect} from '@playwright/test';

import {
    buildSourceReceipt,
    deriveLineage,
    derivesCollapse,
    derivesProvenEmpty,
    LINEAGE,
    ROW_STATE
} from '../../../../../../ai/services/shared/captureReceipt.mjs';

/**
 * @summary The receipt vocabulary and its single derivation rule.
 *
 * The predecessor of this module collapsed three independent facts onto one `captured | empty |
 * unavailable` enum and was Drop+Superseded for it: a changed collection identity was read as data
 * loss, which Neo's own re-embed disproves — `VectorService` rebuilds into a shadow collection and
 * promotes it live → parking, shadow → canonical, so every healthy re-embed changes the canonical
 * identity with nothing lost. These specs pin the axes as orthogonal and `provenEmpty` as the one
 * derived claim, so the collapse cannot come back by accident.
 */
test.describe('ai/services/shared/captureReceipt — orthogonal facts, one derived claim', () => {
    test('`provenEmpty` requires a measured zero AND a continuous lineage', () => {
        expect(derivesProvenEmpty({rowState: ROW_STATE.zero, lineage: LINEAGE.same})).toBe(true);
    });

    test('a CHANGED lineage never derives `provenEmpty` — the falsifier that dropped the predecessor', () => {
        // A re-embed promotes a shadow collection into the canonical name, and a restore drops and
        // re-resolves. Both change the identity deliberately, with nothing lost. Reading that as
        // "the corpus was gone" is the exact defect this module exists to prevent.
        const promoted = buildSourceReceipt({
            source      : 'neo-knowledge-base',
            rowCount    : 0,
            collectionId: 'shadow-id-after-promote',
            previousId  : 'canonical-id-before-promote'
        });

        expect(promoted.lineage).toBe(LINEAGE.changed);
        expect(promoted.provenEmpty).toBe(false);
        // The facts survive rather than collapsing: a consumer can still see there were zero rows.
        expect(promoted.rowState).toBe(ROW_STATE.zero);
    });

    test('an UNKNOWN lineage never derives `provenEmpty` — first run has nothing to compare against', () => {
        const firstRun = buildSourceReceipt({
            source      : 'neo-agent-memory',
            rowCount    : 0,
            collectionId: 'some-id',
            previousId  : null
        });

        expect(firstRun.lineage).toBe(LINEAGE.unknown);
        expect(firstRun.provenEmpty).toBe(false);
    });

    test('rows are self-evidencing: a populated source is never `provenEmpty`, whatever its lineage', () => {
        for (const previousId of ['same-id', 'different-id', null]) {
            const populated = buildSourceReceipt({
                source      : 'neo-agent-memory',
                rowCount    : 94325,
                collectionId: 'same-id',
                previousId
            });

            expect(populated.rowState, `previousId=${previousId}`).toBe(ROW_STATE.populated);
            expect(populated.provenEmpty,    `previousId=${previousId}`).toBe(false);
        }
    });

    test('a populated source with a CHANGED lineage keeps both facts — positive rows must not erase the change', () => {
        // The May-2026 partial specimen in reverse: positive row parity is not a reason to stop
        // reporting that the source is not the one the previous bundle observed.
        const receipt = buildSourceReceipt({
            source      : 'neo-agent-sessions',
            rowCount    : 12,
            collectionId: 'b',
            previousId  : 'a'
        });

        expect(receipt.rowState).toBe(ROW_STATE.populated);
        expect(receipt.lineage).toBe(LINEAGE.changed);
    });

    test('lineage compares IDENTITY, and a missing id on either side is `unknown` rather than `same`', () => {
        expect(deriveLineage({currentId: 'a',  previousId: 'a'})).toBe(LINEAGE.same);
        expect(deriveLineage({currentId: 'a',  previousId: 'b'})).toBe(LINEAGE.changed);
        // Absent evidence is not evidence of continuity — the failure mode that would silently
        // manufacture `provenEmpty` for every source whose id could not be observed.
        expect(deriveLineage({currentId: 'a',  previousId: null})).toBe(LINEAGE.unknown);
        expect(deriveLineage({currentId: null, previousId: 'a'})).toBe(LINEAGE.unknown);
        expect(deriveLineage({currentId: null, previousId: null})).toBe(LINEAGE.unknown);
        expect(deriveLineage()).toBe(LINEAGE.unknown);
    });

    test('the axis vocabularies are frozen — a consumer cannot widen a verdict at runtime', () => {
        expect(Object.isFrozen(ROW_STATE)).toBe(true);
        expect(Object.isFrozen(LINEAGE)).toBe(true);
    });

    test('read-completeness is NOT an axis — the rule that excluded `partial` applied to itself', () => {
        // An earlier revision carried `readCompleteness: complete | unavailable`, and nothing in the
        // substrate could emit `unavailable`: a partial read throws `PARTIAL_COLLECTION_EXPORT` and
        // aborts before any receipt exists. That is the same reason `partial` was excluded, so the
        // whole axis went with it. This pins the absence so it returns only with a producer.
        const receipt = buildSourceReceipt({
            source      : 'neo-knowledge-base',
            rowCount    : 0,
            collectionId: 'same-id',
            previousId  : 'same-id'
        });

        expect(receipt).not.toHaveProperty('readCompleteness');
        expect(Object.values(ROW_STATE)).not.toContain('partial');
    });

    /**
     * A malformed count is not a small number — it is no number. Coercing it to `0` lets a broken
     * exporter plus an unchanged identity assemble a POSITIVE claim of emptiness entirely out of the
     * absence of evidence, which is the module's own conflation reappearing one layer earlier.
     */
    test.describe('malformed counts fail honest', () => {
        // Every case pairs the bad count with MATCHING identities, so lineage is `same` and the only
        // thing standing between the receipt and `provenEmpty: true` is the row-state rule under test.
        const malformed = [
            ['absent',    undefined],
            ['null',      null],
            ['NaN',       NaN],
            ['Infinity',  Infinity],
            ['-Infinity', -Infinity],
            ['negative',  -1],
            ['a string',  '0']
        ];

        for (const [label, rowCount] of malformed) {
            test(`${label} is \`unestablished\`, never a measured zero`, () => {
                const receipt = buildSourceReceipt({
                    source      : 'neo-knowledge-base',
                    rowCount,
                    collectionId: 'same-id',
                    previousId  : 'same-id'
                });

                expect(receipt.lineage).toBe(LINEAGE.same);
                expect(receipt.rowState).toBe(ROW_STATE.unestablished);
                expect(receipt.provenEmpty).toBe(false);
            });
        }

        test('a non-numeric count is reported as `null`, not repaired into `0`', () => {
            const absent = buildSourceReceipt({source: 'kb', rowCount: undefined, collectionId: 'a', previousId: 'a'});

            expect(absent.rowCount).toBeNull();
        });

        test('a negative count is retained verbatim — the operator needs to see what the producer emitted', () => {
            const negative = buildSourceReceipt({source: 'kb', rowCount: -1, collectionId: 'a', previousId: 'a'});

            expect(negative.rowCount).toBe(-1);
            expect(negative.rowState).toBe(ROW_STATE.unestablished);
        });

        test('zero itself is still a MEASURED zero — the guard must not swallow the honest case', () => {
            // The positive control. If `unestablished` ever widened to cover a real 0, every one of the
            // specs above would still pass while the module stopped making its only claim.
            const measured = buildSourceReceipt({source: 'kb', rowCount: 0, collectionId: 'a', previousId: 'a'});

            expect(measured.rowState).toBe(ROW_STATE.zero);
            expect(measured.rowCount).toBe(0);
            expect(measured.provenEmpty).toBe(true);
        });
    });

    /**
     * @summary `collapsed` — the one row of #270's verdict table that must never publish.
     *
     * A run resolved a collection that was not the live corpus, exported zero rows against a live
     * 68,207, recorded `lineage: changed`, and still became the newest backup. `provenEmpty`
     * deliberately declines to read `zero + changed`, because a healthy re-embed produces exactly
     * that shape. `collapsed` answers it with a THIRD fact — what the comparison bundle counted for
     * the same source — and every exclusion below names a shape that must keep publishing.
     */
    test.describe('#270 — `collapsed` fires on a demonstrated loss, and on nothing else', () => {
        test('RED CONTROL: the observed 2026-08-30T19:18 shape — zero, changed, predecessor held 68207', () => {
            // The bundle that prompted the ticket. Before the fix, this published as the newest backup.
            expect(derivesCollapse({
                rowState        : ROW_STATE.zero,
                lineage         : LINEAGE.changed,
                previousRowCount: 68207
            })).toBe(true);
        });

        test('a healthy re-embed promotion does NOT collapse — the falsifier that dropped the predecessor', () => {
            // `VectorService` rebuilds into a shadow collection and promotes it, so the canonical
            // identity changes with nothing lost: `populated + changed`. If `collapsed` fired here it
            // would abort every healthy re-embed — the exact defect this module exists to prevent,
            // re-entering through the new claim instead of the old enum.
            expect(derivesCollapse({
                rowState        : ROW_STATE.populated,
                lineage         : LINEAGE.changed,
                previousRowCount: 68207
            })).toBe(false);
        });

        test('an UNKNOWN lineage never collapses — a missing predecessor must degrade, never refuse', () => {
            // `readPreviousBundleIdentities` is fail-soft by design: a backup that refuses because it
            // cannot find its predecessor is a worse failure than one that cannot prove emptiness.
            // Firing here would resurrect precisely that.
            expect(derivesCollapse({
                rowState        : ROW_STATE.zero,
                lineage         : LINEAGE.unknown,
                previousRowCount: 68207
            })).toBe(false);
        });

        test('a broken instrument never collapses — `unestablished` is not evidence of loss', () => {
            expect(derivesCollapse({
                rowState        : ROW_STATE.unestablished,
                lineage         : LINEAGE.changed,
                previousRowCount: 68207
            })).toBe(false);
        });

        test.describe('NEGATIVE CONTROLS: emptiness alone is never the trigger', () => {
            const noPriorCorpus = [
                {label: 'a first run, with no comparison bundle',    previousRowCount: null},
                {label: 'a predecessor that recorded no count',      previousRowCount: undefined},
                {label: 'a predecessor that legitimately held zero', previousRowCount: 0}
            ];

            for (const {label, previousRowCount} of noPriorCorpus) {
                test(`${label} still publishes`, () => {
                    // Nothing was demonstrably lost, so there is nothing to refuse. The prior
                    // non-zero is what turns an observation into a demonstrated loss.
                    expect(derivesCollapse({
                        rowState: ROW_STATE.zero,
                        lineage : LINEAGE.changed,
                        previousRowCount
                    })).toBe(false);
                });
            }
        });

        test('`provenEmpty` and `collapsed` are mutually exclusive across every fact combination', () => {
            // One requires `same`, the other `changed`. No combination satisfies both, so a consumer
            // can never receive two contradictory claims about one source.
            for (const lineage of Object.values(LINEAGE)) {
                for (const rowState of Object.values(ROW_STATE)) {
                    const facts = {rowState, lineage, previousRowCount: 68207};

                    expect(derivesProvenEmpty(facts) && derivesCollapse(facts)).toBe(false);
                }
            }
        });
    });
});

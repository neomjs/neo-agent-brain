import {test, expect} from '@playwright/test';
import {
    foldChromaDatabaseCensus,
    formatChromaDatabaseCensus
} from '../../../../../../ai/scripts/diagnostics/chromaTestDatabaseCensus.mjs';

/**
 * Coverage for the `#285` census fold. The detection is a pure function over an enumerated
 * population precisely so the red control does not need a live Chroma server: the ticket asks that
 * a clean result be proven by a positive control rather than asserted, and a green that only ever
 * ran against a clean instance cannot distinguish "found nothing" from "cannot see anything".
 *
 * `createProgram` and `main` are deliberately not exercised here — they read resolved AiConfig
 * leaves and reach a live instance, which is the integration surface, not this one.
 */
test.describe('#285 — chroma test-database census fold', () => {
    const PRODUCTION_POPULATION = [
        'default_database',
        'neo-kb-unit-test-78286',
        'neo-kb-unit-test-15240',
        'neo-kb-unit-test-3044'
    ];

    test('RED: reports the three databases actually present in the production instance', () => {
        const census = foldChromaDatabaseCensus(PRODUCTION_POPULATION);

        expect(census.total).toBe(4);
        expect(census.leaked).toEqual([
            'neo-kb-unit-test-78286',
            'neo-kb-unit-test-15240',
            'neo-kb-unit-test-3044'
        ]);
        expect(census.clean).toEqual(['default_database']);
    });

    test('GREEN: reports clean with those three absent — same instrument, different population', () => {
        // The positive control that makes the clean arm mean something. Same fold, same call; the
        // ONLY thing that changed is the population, so a clean result here cannot be the detector
        // silently failing — the test above proves the same code path finds them when present.
        const census = foldChromaDatabaseCensus(['default_database']);

        expect(census.leaked).toEqual([]);
        expect(census.total).toBe(1);
        expect(census.clean).toEqual(['default_database']);
    });

    test('every database is accounted for — leaked + clean can never silently drop one', () => {
        const census = foldChromaDatabaseCensus(PRODUCTION_POPULATION);

        expect(census.leaked.length + census.clean.length).toBe(census.total);
    });

    test('an empty instance folds cleanly', () => {
        const census = foldChromaDatabaseCensus([]);

        expect(census).toMatchObject({total: 0, leaked: [], clean: []});
    });

    test('the rendered report marks the leaked rows and states its own bound', () => {
        const report = formatChromaDatabaseCensus(
            foldChromaDatabaseCensus(PRODUCTION_POPULATION),
            {host: 'localhost', port: 8000, tenant: 'default_tenant'}
        );

        expect(report).toContain('LEAKED neo-kb-unit-test-78286');
        expect(report).toContain('databases = 4  leaked = 3');
        expect(report).toContain('localhost:8000');
        expect(report).toMatch(/Removal is operator-gated/);
        expect(report).toMatch(/recognises generated shapes only/);
    });

    test('a CLEAN report still states the bound', () => {
        // The bound belongs on the clean branch most of all: that is the report someone reads as
        // "there are no test databases", when what it can support is "none matching a known shape".
        const report = formatChromaDatabaseCensus(
            foldChromaDatabaseCensus(['default_database']),
            {host: 'localhost', port: 8000, tenant: 'default_tenant'}
        );

        expect(report).toContain('No database matches a generated test-database name shape.');
        expect(report).toMatch(/recognises generated shapes only/);
    });
});

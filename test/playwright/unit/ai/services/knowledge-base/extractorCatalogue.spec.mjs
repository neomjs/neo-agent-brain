import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

test.describe('immutable extractor catalogue (#261)', () => {
    let createExtractorCatalogue;
    let builtinCatalogue;

    test.beforeAll(async () => {
        const module = await import(
            '../../../../../../ai/services/knowledge-base/source/ExtractorCatalogue.mjs'
        );

        createExtractorCatalogue = module.createExtractorCatalogue;
        builtinCatalogue         = module.default;
    });

    test('stores frozen descriptors behind a mutation-free API', () => {
        const extract   = async () => ({count: 0, yieldedSourcePaths: []});
        const catalogue = createExtractorCatalogue([{
            extractorId      : 'Fixture',
            version          : '1.2.3',
            deltaSafe        : true,
            requiresHierarchy: false,
            extract
        }]);
        const descriptor = catalogue.get('Fixture');

        expect(Object.keys(catalogue).sort()).toEqual(['get', 'has', 'list']);
        expect(descriptor).toMatchObject({
            extractorId      : 'Fixture',
            version          : '1.2.3',
            deltaSafe        : true,
            requiresHierarchy: false,
            extract
        });
        expect(typeof descriptor.normalizeOptions).toBe('function');
        expect(Object.isFrozen(descriptor)).toBe(true);
        expect(() => {
            descriptor.version = '9.9.9';
        }).toThrow();
        expect(catalogue.get('Fixture').version).toBe('1.2.3');

        const listed = catalogue.list();
        expect(Object.isFrozen(listed)).toBe(true);
        expect(() => listed.push(descriptor)).toThrow();
        expect(catalogue.list()).toHaveLength(1);
    });

    test('rejects missing and duplicate identities instead of accepting last-write-wins', () => {
        const extract = async () => {};

        expect(() => createExtractorCatalogue([{
            extractorId: 'Duplicate',
            version    : '1.0.0',
            extract
        }, {
            extractorId: 'Duplicate',
            version    : '2.0.0',
            extract
        }])).toThrow(/Duplicate extractor/u);

        expect(() => createExtractorCatalogue([{
            extractorId: '',
            version    : '1.0.0',
            extract
        }])).toThrow(/require non-empty/u);

        const catalogue = createExtractorCatalogue([]);
        expect(() => catalogue.get('Missing')).toThrow(/Unknown extractor/u);
    });

    test('exposes all repository-ported built-ins with their declared capabilities', () => {
        expect(builtinCatalogue.list().map(({extractorId, version, deltaSafe, requiresHierarchy}) => ({
            extractorId,
            version,
            deltaSafe,
            requiresHierarchy
        }))).toEqual([{
            extractorId      : 'ApiSource',
            version          : '1.0.0',
            deltaSafe        : false,
            requiresHierarchy: true
        }, {
            extractorId      : 'ParserSource',
            version          : '1.0.0',
            deltaSafe        : false,
            requiresHierarchy: false
        }, {
            extractorId      : 'RawRepoSource',
            version          : '1.0.0',
            deltaSafe        : true,
            requiresHierarchy: false
        }, {
            extractorId      : 'SkillSource',
            version          : '1.0.0',
            deltaSafe        : false,
            requiresHierarchy: false
        }]);
    });
});

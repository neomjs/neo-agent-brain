import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

test.describe('extraction profile contract (#261)', () => {
    let createExtractorCatalogue;
    let createExtractionProfileIdentity;
    let createExtractionProfileMaterializationInput;
    let normalizeExtractionProfile;
    let serializeExtractionProfileMaterializationInput;
    let catalogue;

    test.beforeAll(async () => {
        ({createExtractorCatalogue} = await import(
            '../../../../../../ai/services/knowledge-base/source/ExtractorCatalogue.mjs'
        ));
        ({
            createExtractionProfileIdentity,
            createExtractionProfileMaterializationInput,
            normalizeExtractionProfile,
            serializeExtractionProfileMaterializationInput
        } = await import(
            '../../../../../../ai/services/knowledge-base/helpers/extractionProfileContract.mjs'
        ));

        catalogue = createExtractorCatalogue([{
            extractorId: 'ApiSource',
            version    : '1.0.0',
            deltaSafe  : false,
            extract    : async () => ({count: 0, yieldedSourcePaths: []})
        }, {
            extractorId: 'SkillSource',
            version    : '2.0.0',
            deltaSafe  : false,
            extract    : async () => ({count: 0, yieldedSourcePaths: []})
        }]);
    });

    function profile() {
        return {
            profileSchemaVersion: 1,
            routes              : [{
                territory: {
                    roots  : [{path: './src/', optional: false}],
                    include: ['**/*.mjs', 'index.mjs'],
                    exclude: ['generated/**', 'generated/**']
                },
                extractorId: 'ApiSource',
                options    : {type: 'src', nested: {b: 2, a: 1}}
            }, {
                territory: {
                    roots  : ['.agents/skills'],
                    include: ['**/*.md']
                },
                extractorId: 'SkillSource'
            }],
            fallback: {action: 'exclude'}
        };
    }

    test('canonical bytes ignore route/list/object order but preserve extraction semantics', () => {
        const first  = profile();
        const second = {
            ...first,
            routes: [...first.routes].reverse().map(route => ({
                options    : route.options ? {nested: {a: 1, b: 2}, type: route.options.type} : {},
                extractorId: route.extractorId,
                territory  : {
                    exclude: [...(route.territory.exclude || [])].reverse(),
                    include: [...(route.territory.include || [])].reverse(),
                    roots  : [...route.territory.roots].reverse()
                }
            }))
        };

        expect(serializeExtractionProfileMaterializationInput({
            profile          : first,
            catalogue,
            hierarchyIdentity: {id: 'fixture', version: '1'}
        })).toBe(serializeExtractionProfileMaterializationInput({
            profile          : second,
            catalogue,
            hierarchyIdentity: {version: '1', id: 'fixture'}
        }));
    });

    test('semantic glob case changes canonical materialization bytes', () => {
        const lower = profile();
        const upper = profile();

        upper.routes[1].territory.include = ['**/*.MD'];

        expect(serializeExtractionProfileMaterializationInput({
            profile: lower,
            catalogue
        })).not.toBe(serializeExtractionProfileMaterializationInput({
            profile: upper,
            catalogue
        }));
    });

    test('derives one bounded extraction identity from canonical materialization input', () => {
        const first  = profile();
        const second = profile();

        second.routes.reverse();
        second.routes.forEach(route => {
            route.territory.include?.reverse();
            route.territory.exclude?.reverse();
        });

        const firstIdentity = createExtractionProfileIdentity({
            profile          : first,
            catalogue,
            hierarchyIdentity: {id: 'repo-hierarchy', version: '7'}
        });

        expect(firstIdentity).toMatch(/^[a-f0-9]{64}$/u);
        expect(createExtractionProfileIdentity({
            profile          : second,
            catalogue,
            hierarchyIdentity: {version: '7', id: 'repo-hierarchy'}
        })).toBe(firstIdentity);

        second.routes.find(route => route.extractorId === 'SkillSource').territory.include = ['**/*.MD'];

        expect(createExtractionProfileIdentity({
            profile          : second,
            catalogue,
            hierarchyIdentity: {id: 'repo-hierarchy', version: '7'}
        })).not.toBe(firstIdentity);
    });

    test('records exact matcher, descriptor, hierarchy, and normalized-root identity without minting a digest', () => {
        const input = createExtractionProfileMaterializationInput({
            profile          : profile(),
            catalogue,
            hierarchyIdentity: {id: 'repo-hierarchy', version: '7'}
        });

        expect(input).toMatchObject({
            normalizationContractVersion: 1,
            matcher                     : {
                id     : 'micromatch',
                version: '4.0.8',
                options: {
                    dot     : true,
                    nocase  : false,
                    nonegate: true
                }
            },
            hierarchyIdentity: {id: 'repo-hierarchy', version: '7'},
            descriptors      : [{
                extractorId      : 'ApiSource',
                version          : '1.0.0',
                deltaSafe        : false,
                requiresHierarchy: false
            }, {
                extractorId      : 'SkillSource',
                version          : '2.0.0',
                deltaSafe        : false,
                requiresHierarchy: false
            }]
        });
        expect(input.profile.routes[1].territory.roots[0]).toEqual({
            path    : 'src',
            optional: false
        });
        expect(input).not.toHaveProperty('digest');
        expect(Object.isFrozen(input)).toBe(true);
    });

    test('fails closed on unsafe roots, unknown fields, empty includes, and unknown extractors', () => {
        const unsafe = profile();
        unsafe.routes[0].territory.roots = ['../outside'];

        expect(() => normalizeExtractionProfile(unsafe, {catalogue}))
            .toThrow(/safe repo-relative/u);

        const emptyRoot = profile();
        emptyRoot.routes[0].territory.roots = [''];
        expect(() => normalizeExtractionProfile(emptyRoot, {catalogue}))
            .toThrow(/must be strings/u);

        const windowsRoot = profile();
        windowsRoot.routes[0].territory.roots = ['C:\\outside'];
        expect(() => normalizeExtractionProfile(windowsRoot, {catalogue}))
            .toThrow(/safe repo-relative/u);

        const overlappingRoots = profile();
        overlappingRoots.routes[0].territory.roots = ['src', 'src/features'];
        expect(() => normalizeExtractionProfile(overlappingRoots, {catalogue}))
            .toThrow(/roots .* overlap/u);

        const unknownField = profile();
        unknownField.routes[0].territory.cwd = '/tmp';
        expect(() => normalizeExtractionProfile(unknownField, {catalogue}))
            .toThrow(/unsupported field/u);

        const emptyInclude = profile();
        emptyInclude.routes[0].territory.include = [];
        expect(() => normalizeExtractionProfile(emptyInclude, {catalogue}))
            .toThrow(/non-empty array/u);

        const unknownExtractor = profile();
        unknownExtractor.routes[0].extractorId = 'Missing';
        expect(() => normalizeExtractionProfile(unknownExtractor, {catalogue}))
            .toThrow(/Unknown extractor/u);

        const poisonedOptions = profile();
        poisonedOptions.routes[0].options = JSON.parse('{"__proto__":{"polluted":true}}');
        expect(() => normalizeExtractionProfile(poisonedOptions, {catalogue}))
            .toThrow(/forbidden prototype-chain/u);

        const scalarOptions = profile();
        scalarOptions.routes[0].options = 42;
        expect(() => normalizeExtractionProfile(scalarOptions, {catalogue}))
            .toThrow(/options must be a plain object/u);

        const arrayFallbackOptions = profile();
        arrayFallbackOptions.fallback = {
            action     : 'extract',
            extractorId: 'SkillSource',
            options    : []
        };
        expect(() => normalizeExtractionProfile(arrayFallbackOptions, {catalogue}))
            .toThrow(/options must be a plain object/u);
    });

    test('normalizes absent include as an explicit every-regular-blob matcher', () => {
        const candidate = profile();
        delete candidate.routes[0].territory.include;

        const normalized = normalizeExtractionProfile(candidate, {catalogue});
        const apiRoute   = normalized.routes.find(route => route.extractorId === 'ApiSource');

        expect(apiRoute.territory.include).toEqual(['**/*']);
    });

    test('normalizes extractor-specific options before any route can execute', () => {
        expect(() => normalizeExtractionProfile({
            profileSchemaVersion: 1,
            routes              : [{
                territory  : {roots: ['src'], include: ['**/*.mjs']},
                extractorId: 'ApiSource'
            }],
            fallback: {action: 'exclude'}
        })).toThrow(/require a non-empty type/u);

        expect(() => normalizeExtractionProfile({
            profileSchemaVersion: 1,
            routes              : [{
                territory  : {roots: ['.agents/skills'], include: ['**/*.md']},
                extractorId: 'SkillSource',
                options    : {type: 'skill'}
            }],
            fallback: {action: 'exclude'}
        })).toThrow(/must be empty/u);
    });
});

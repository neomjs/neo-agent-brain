import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

test.describe('extraction profile runner (#261)', () => {
    let createExtractorCatalogue;
    let createRepositoryRevisionReader;
    let compileExtractionProfile;
    let runExtractionProfile;
    let SourceRegistry;

    test.beforeAll(async () => {
        ({createExtractorCatalogue} = await import(
            '../../../../../../ai/services/knowledge-base/source/ExtractorCatalogue.mjs'
        ));
        ({createRepositoryRevisionReader} = await import(
            '../../../../../../ai/services/knowledge-base/helpers/repositoryRevisionReader.mjs'
        ));
        ({compileExtractionProfile, runExtractionProfile} = await import(
            '../../../../../../ai/services/knowledge-base/helpers/extractionProfileRunner.mjs'
        ));
        SourceRegistry = (await import(
            '../../../../../../ai/services/knowledge-base/source/SourceRegistry.mjs'
        )).default;
    });

    function entry(sourcePath, mode = '100644', type = 'blob') {
        return {
            sourcePath,
            mode,
            type,
            oid: 'a'.repeat(40)
        };
    }

    function reader(entries, contents = {}) {
        const gitMirror = {
            async listRevisionEntries() {
                return entries;
            },
            async prefetchRevisionBlobs() {
                return {status: 'local'};
            },
            async readRevisionBlob({sourcePath}) {
                return Buffer.from(contents[sourcePath] ?? sourcePath, 'utf8');
            }
        };

        return createRepositoryRevisionReader({
            gitMirror,
            mirrorRoot: '/not-read-by-fixture',
            tenantId  : 'tenant-a',
            repoSlug  : 'org/repo',
            revision  : 'f'.repeat(40)
        });
    }

    function profile(routes, fallback = {action: 'exclude'}) {
        return {
            profileSchemaVersion: 1,
            routes,
            ...(fallback ? {fallback} : {})
        };
    }

    function route(extractorId, root = 'src', include = ['**/*.mjs']) {
        return {
            territory: {roots: [root], include},
            extractorId
        };
    }

    function catalogue({
        deltaSafe = false,
        requiresHierarchy = false,
        calls,
        extractorIds = ['Fixture']
    } = {}) {
        return createExtractorCatalogue(extractorIds.map(extractorId => ({
            extractorId,
            version: '1.0.0',
            deltaSafe,
            requiresHierarchy,
            async extract({context, writeStream}) {
                const paths = context.territory.assignments.map(item => item.entry.sourcePath);
                calls?.push(paths);
                paths.forEach(sourcePath => writeStream.write(JSON.stringify({sourcePath}) + '\n'));

                return {count: paths.length, yieldedSourcePaths: paths};
            }
        })));
    }

    test('preflights the complete revision and emits nothing on overlap or gap', async () => {
        const
            calls            = [],
            writes           = [],
            descriptors      = catalogue({calls, extractorIds: ['A', 'B']}),
            repositoryReader = reader([
                entry('src/good.mjs'),
                entry('README.md')
            ]),
            writeStream = {write: value => writes.push(value)};

        await expect(runExtractionProfile({
            profile     : profile([route('A'), route('B')]),
            catalogue   : descriptors,
            repositoryReader,
            writeStream,
            createHashFn: () => 'hash'
        })).rejects.toMatchObject({code: 'KB_EXTRACTION_ROUTE_OVERLAP'});

        expect(calls).toEqual([]);
        expect(writes).toEqual([]);

        await expect(runExtractionProfile({
            profile     : profile([route('A')], null),
            catalogue   : descriptors,
            repositoryReader,
            writeStream,
            createHashFn: () => 'hash'
        })).rejects.toMatchObject({code: 'KB_EXTRACTION_ROUTE_GAP'});

        expect(calls).toEqual([]);
        expect(writes).toEqual([]);
    });

    test('fails missing required roots and records optional roots plus skipped Git entry modes', async () => {
        const
            descriptors      = catalogue(),
            repositoryReader = reader([
                entry('README.md'),
                entry('linked.md', '120000', 'blob'),
                entry('vendor/pkg', '160000', 'commit')
            ]);

        await expect(compileExtractionProfile({
            profile  : profile([route('Fixture', 'missing')]),
            catalogue: descriptors,
            repositoryReader
        })).rejects.toMatchObject({code: 'KB_EXTRACTION_REQUIRED_ROOT_MISSING'});

        const compiled = await compileExtractionProfile({
            profile: profile([{
                ...route('Fixture', 'missing'),
                territory: {
                    roots  : [{path: 'missing', optional: true}],
                    include: ['**/*']
                }
            }]),
            catalogue: descriptors,
            repositoryReader
        });

        expect(compiled.assignments).toEqual([]);
        expect(compiled.rootObservations).toEqual([{
            routeIndex: 0,
            path      : 'missing',
            optional  : true,
            present   : false
        }]);
        expect(compiled.skippedByType).toEqual([{
            sourcePath: 'linked.md',
            mode      : '120000',
            type      : 'blob',
            reason    : 'symlink'
        }, {
            sourcePath: 'vendor/pkg',
            mode      : '160000',
            type      : 'commit',
            reason    : 'gitlink'
        }]);
        expect(compiled.skippedPaths).toEqual([{
            sourcePath: 'README.md',
            reason    : 'fallback-exclude'
        }]);

        const gitlinkRoot = await compileExtractionProfile({
            profile  : profile([route('Fixture', 'vendor/pkg', ['**/*'])]),
            catalogue: descriptors,
            repositoryReader
        });

        expect(gitlinkRoot.rootObservations).toEqual([{
            routeIndex: 0,
            path      : 'vendor/pkg',
            optional  : false,
            present   : true
        }]);
        expect(gitlinkRoot.assignments).toEqual([]);
    });

    test('replays a full non-delta-safe territory but narrows a proven delta-safe descriptor', async () => {
        const
            entries          = [entry('src/a.mjs'), entry('src/b.mjs')],
            repositoryReader = reader(entries),
            writeStream      = {write() {}},
            unsafeCalls      = [],
            safeCalls        = [];

        await runExtractionProfile({
            profile     : profile([route('Fixture')]),
            catalogue   : catalogue({deltaSafe: false, calls: unsafeCalls}),
            repositoryReader,
            changedPaths: ['src/a.mjs'],
            writeStream,
            createHashFn: () => 'hash'
        });
        await runExtractionProfile({
            profile     : profile([route('Fixture')]),
            catalogue   : catalogue({deltaSafe: true, calls: safeCalls}),
            repositoryReader,
            changedPaths: ['src/a.mjs'],
            writeStream,
            createHashFn: () => 'hash'
        });

        expect(unsafeCalls).toEqual([['src/a.mjs', 'src/b.mjs']]);
        expect(safeCalls).toEqual([['src/a.mjs']]);
    });

    test('matches root-relative globs and includes dotfiles in the explicit all-files default', async () => {
        const descriptors  = catalogue();
        const rootRelative = await compileExtractionProfile({
            profile: profile([{
                territory  : {roots: ['src'], include: ['*.mjs']},
                extractorId: 'Fixture'
            }]),
            catalogue       : descriptors,
            repositoryReader: reader([
                entry('src/a.mjs'),
                entry('src/nested/b.mjs')
            ])
        });

        expect(rootRelative.assignments.map(item => item.entry.sourcePath)).toEqual(['src/a.mjs']);
        expect(rootRelative.skippedPaths).toEqual([{
            sourcePath: 'src/nested/b.mjs',
            reason    : 'fallback-exclude'
        }]);

        const dotfile = await compileExtractionProfile({
            profile: profile([{
                territory  : {roots: ['.']},
                extractorId: 'Fixture'
            }]),
            catalogue       : descriptors,
            repositoryReader: reader([entry('.hidden')])
        });

        expect(dotfile.assignments.map(item => item.entry.sourcePath)).toEqual(['.hidden']);
    });

    test('resolves required hierarchy before the first extractor write', async () => {
        const
            calls            = [],
            writes           = [],
            descriptors      = catalogue({calls, requiresHierarchy: true}),
            repositoryReader = reader([entry('src/a.mjs')]);

        await expect(runExtractionProfile({
            profile     : profile([route('Fixture')]),
            catalogue   : descriptors,
            repositoryReader,
            writeStream : {write: value => writes.push(value)},
            createHashFn: () => 'hash'
        })).rejects.toMatchObject({code: 'KB_EXTRACTION_HIERARCHY_RESOLVER_REQUIRED'});

        expect(calls).toEqual([]);
        expect(writes).toEqual([]);

        let   resolveCount      = 0;
        const hierarchyResolver = {
            id     : 'fixture',
            version: '1',
            async resolve() {
                resolveCount++;
                return {'Fixture.Class': 'Neo.core.Base'};
            }
        };

        await runExtractionProfile({
            profile     : profile([route('Fixture')]),
            catalogue   : descriptors,
            repositoryReader,
            hierarchyResolver,
            writeStream : {write: value => writes.push(value)},
            createHashFn: () => 'hash'
        });

        expect(resolveCount).toBe(1);
        expect(calls).toEqual([['src/a.mjs']]);
        expect(writes).toHaveLength(1);
    });

    test('never consults the mutable legacy SourceRegistry', async () => {
        const
            originalGetSources = SourceRegistry.getSources,
            calls              = [],
            writes             = [];

        SourceRegistry.getSources = () => {
            throw new Error('legacy registry consulted');
        };

        try {
            const result = await runExtractionProfile({
                profile         : profile([route('Fixture')]),
                catalogue       : catalogue({calls}),
                repositoryReader: reader([entry('src/a.mjs')]),
                writeStream     : {write: value => writes.push(value)},
                createHashFn    : () => 'hash'
            });

            expect(result.count).toBe(1);
            expect(result.yieldedSourcePaths).toEqual(['src/a.mjs']);
            expect(calls).toEqual([['src/a.mjs']]);
            expect(writes).toHaveLength(1);
        } finally {
            SourceRegistry.getSources = originalGetSources;
        }
    });

    test('executes the built-in SkillSource descriptor through the bound reader', async () => {
        const writes = [];
        const result = await runExtractionProfile({
            profile: profile([{
                territory: {
                    roots  : ['.agents/skills'],
                    include: ['**/*.md']
                },
                extractorId: 'SkillSource'
            }]),
            repositoryReader: reader([
                entry('.agents/skills/example/SKILL.md')
            ], {
                '.agents/skills/example/SKILL.md': '---\nname: example\n---\n\n# Example\nBound-reader content.\n'
            }),
            writeStream : {write: value => writes.push(JSON.parse(value))},
            createHashFn: chunk => 'hash:' + chunk.name
        });

        expect(result.count).toBe(1);
        expect(result.yieldedSourcePaths).toEqual([
            '.agents/skills/example/SKILL.md'
        ]);
        expect(writes[0]).toMatchObject({
            name   : 'example - Example',
            source : '.agents/skills/example/SKILL.md',
            content: '# Example\nBound-reader content.'
        });
    });

    test('refuses to execute compiled authority against a different bound reader', async () => {
        const
            descriptors = catalogue(),
            firstReader = reader([entry('src/a.mjs')]),
            compiled    = await compileExtractionProfile({
                profile         : profile([route('Fixture')]),
                catalogue       : descriptors,
                repositoryReader: firstReader
            });

        await expect(runExtractionProfile({
            compiledProfile : compiled,
            catalogue       : descriptors,
            repositoryReader: reader([entry('src/a.mjs')]),
            writeStream     : {write() {}},
            createHashFn    : () => 'hash'
        })).rejects.toMatchObject({code: 'KB_EXTRACTION_COMPILED_READER_MISMATCH'});
    });
});

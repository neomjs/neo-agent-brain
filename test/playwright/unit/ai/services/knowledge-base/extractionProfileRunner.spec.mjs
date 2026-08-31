import {test, expect}  from '@playwright/test';
import * as acorn      from 'acorn';
import Neo             from 'neo.mjs/src/Neo.mjs';
import * as core       from 'neo.mjs/src/core/_export.mjs';
import fs              from 'node:fs/promises';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';

const
    REPO_ROOT            = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..'),
    PROFILE_RUNNER_ENTRY = path.join(
        REPO_ROOT,
        'ai/services/knowledge-base/helpers/extractionProfileRunner.mjs'
    ),
    EXTRACTOR_CATALOGUE     = path.join(
        REPO_ROOT,
        'ai/services/knowledge-base/source/ExtractorCatalogue.mjs'
    ),
    BUILT_IN_SKILL_SOURCE   = path.join(
        REPO_ROOT,
        'ai/services/knowledge-base/source/SkillSource.mjs'
    ),
    LEGACY_SOURCE_REGISTRY  = path.join(
        REPO_ROOT,
        'ai/services/knowledge-base/source/SourceRegistry.mjs'
    ),
    LEGACY_SOURCE_BARREL    = path.join(
        REPO_ROOT,
        'ai/services/knowledge-base/source/_export.mjs'
    );

/**
 * @summary Parses literal static and dynamic ESM edges without treating comments as executable code.
 * @param {String} source
 * @returns {String[]}
 */
function collectModuleSpecifiers(source) {
    const
        specifiers = new Set(),
        stack      = [acorn.parse(source, {ecmaVersion: 'latest', sourceType: 'module'})];

    while (stack.length) {
        const node = stack.pop();

        if (
            (
                node.type === 'ImportDeclaration'
                || node.type === 'ExportNamedDeclaration'
                || node.type === 'ExportAllDeclaration'
                || node.type === 'ImportExpression'
            )
            && typeof node.source?.value === 'string'
        ) {
            specifiers.add(node.source.value)
        }

        for (const value of Object.values(node)) {
            if (Array.isArray(value)) {
                value.forEach(item => item && typeof item === 'object' && stack.push(item))
            } else if (value && typeof value === 'object') {
                stack.push(value)
            }
        }
    }

    return [...specifiers]
}

/**
 * @summary Resolves the runner's transitive repo-local ESM import closure without evaluating modules.
 * @param {String} filePath
 * @param {Set<String>} [seen]
 * @returns {Promise<Set<String>>}
 */
async function resolveModuleClosure(filePath, seen = new Set()) {
    if (seen.has(filePath)) return seen;
    seen.add(filePath);

    const imports = collectModuleSpecifiers(await fs.readFile(filePath, 'utf8'));

    for (const specifier of imports) {
        if (specifier.startsWith('.')) {
            const resolved = path.resolve(path.dirname(filePath), specifier);

            if (resolved.startsWith(REPO_ROOT + path.sep)) await resolveModuleClosure(resolved, seen)
        }
    }

    return seen
}

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

    test('module graph excludes the mutable legacy SourceRegistry and its barrel', async () => {
        const closure = [...await resolveModuleClosure(PROFILE_RUNNER_ENTRY)];

        expect(closure, 'positive control: the runner must reach its immutable catalogue')
            .toContain(EXTRACTOR_CATALOGUE);
        expect(closure, 'positive control: the walker must follow literal dynamic imports')
            .toContain(BUILT_IN_SKILL_SOURCE);
        expect(closure).not.toContain(LEGACY_SOURCE_REGISTRY);
        expect(closure).not.toContain(LEGACY_SOURCE_BARREL);
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

    test('binds descriptor provenance at write time for same-shaped chunks from two routes', async () => {
        const writes = [];
        const result = await runExtractionProfile({
            profile: profile([
                route('A', 'alpha'),
                route('B', 'beta')
            ]),
            catalogue       : catalogue({extractorIds: ['A', 'B']}),
            repositoryReader: reader([
                entry('alpha/Same.mjs'),
                entry('beta/Same.mjs')
            ]),
            writeStream: {
                write() {
                    throw new Error('route execution must not use the unbound shared writer')
                },
                forRoute({extractorId, version}) {
                    return {
                        write(value) {
                            writes.push({
                                chunk: JSON.parse(value),
                                extractorId,
                                version
                            })
                        }
                    }
                }
            },
            createHashFn: () => 'hash'
        });

        expect(result.count).toBe(2);
        expect(writes).toEqual([{
            chunk      : {sourcePath: 'alpha/Same.mjs'},
            extractorId: 'A',
            version    : '1.0.0'
        }, {
            chunk      : {sourcePath: 'beta/Same.mjs'},
            extractorId: 'B',
            version    : '1.0.0'
        }]);
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

import {setup} from '../../../../../setup.mjs';

setup({
    neoConfig: {unitTestMode: true},
    appConfig: {
        name             : 'RepositoryApiSourceTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect} from '@playwright/test';
import fs             from 'fs-extra';
import os             from 'node:os';
import path           from 'node:path';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

test.describe('ApiSource repository port (#261)', () => {
    let ApiSource;
    let aiConfig;
    let original;
    let root;

    test.beforeAll(async () => {
        aiConfig  = (await import('../../../../../../../ai/mcp/server/knowledge-base/config.mjs')).default;
        ApiSource = (await import('../../../../../../../ai/services/knowledge-base/source/ApiSource.mjs')).default;
        root      = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-api-source-port-'));

        await fs.ensureDir(path.join(root, 'src'));
        await fs.writeFile(path.join(root, 'src/Foo.mjs'), `
import Base from './Base.mjs';

class Foo extends Base {
    static config = {
        className: 'Fixture.Foo'
    }

    answer() {
        return 42
    }
}

export default Foo;
`, 'utf8');
        await fs.writeJson(path.join(root, 'hierarchy.json'), {
            'Fixture.Foo': 'Neo.core.Base'
        });

        original = {
            hierarchyPath: aiConfig.hierarchyPath,
            neoRootDir   : aiConfig.neoRootDir,
            sourceEntries: aiConfig.sourcePaths.ApiSource
        };
        aiConfig.neoRootDir = root;
        aiConfig.hierarchyPath = path.join(root, 'hierarchy.json');
        aiConfig.sourcePaths.ApiSource = [{path: 'src', type: 'src'}];
    });

    test.afterAll(async () => {
        aiConfig.neoRootDir = original.neoRootDir;
        aiConfig.hierarchyPath = original.hierarchyPath;
        aiConfig.sourcePaths.ApiSource = original.sourceEntries;
        await fs.remove(root);
    });

    test('is byte-equivalent to the one-root filesystem path without ambient config reads', async () => {
        const
            createHashFn = chunk => `hash:${chunk.kind}:${chunk.name}`,
            legacyWrites = [],
            portWrites   = [],
            legacyCount  = await ApiSource.extract({
                write: value => legacyWrites.push(value)
            }, createHashFn),
            content = await fs.readFile(path.join(root, 'src/Foo.mjs'), 'utf8');

        // Poison every ambient location input after the legacy control. The injected port must not consult
        // either; a fallback to the old path would now fail or emit nothing.
        aiConfig.sourcePaths.ApiSource = [];
        aiConfig.hierarchyPath = path.join(root, 'missing-hierarchy.json');
        aiConfig.neoRootDir = path.join(root, 'ambient-root-must-not-be-read');

        try {
            const result = await ApiSource.extractFromRepository({
                context: {
                    tenantId        : 'tenant-a',
                    repoSlug        : 'org/repo',
                    revision        : 'f'.repeat(40),
                    repositoryReader: {
                        async readText(sourcePath) {
                            expect(sourcePath).toBe('src/Foo.mjs');
                            return content;
                        }
                    },
                    territory: {
                        assignments: [{
                            root        : 'src',
                            relativePath: 'Foo.mjs',
                            entry       : {sourcePath: 'src/Foo.mjs'}
                        }]
                    },
                    hierarchyResolver: {
                        id     : 'fixture-hierarchy',
                        version: '1',
                        async resolve() {
                            return {'Fixture.Foo': 'Neo.core.Base'};
                        }
                    }
                },
                options    : {type: 'src'},
                writeStream: {write: value => portWrites.push(value)},
                createHashFn
            });

            expect(result.count).toBe(legacyCount);
            expect(result.yieldedSourcePaths).toEqual(['src/Foo.mjs']);
            expect(portWrites).toEqual(legacyWrites);
        } finally {
            aiConfig.sourcePaths.ApiSource = [{path: 'src', type: 'src'}];
            aiConfig.hierarchyPath = path.join(root, 'hierarchy.json');
            aiConfig.neoRootDir = root;
        }
    });

    test('records a matched binary blob as an extractor-owned skip', async () => {
        const result = await ApiSource.extractFromRepository({
            context: {
                tenantId        : 'tenant-a',
                repoSlug        : 'org/repo',
                revision        : 'f'.repeat(40),
                repositoryReader: {
                    async readText() {
                        const error = new Error('binary');
                        error.code = 'KB_REVISION_READER_BINARY_BLOB';
                        throw error
                    }
                },
                territory: {
                    assignments: [{
                        root        : 'src',
                        relativePath: 'Binary.mjs',
                        entry       : {sourcePath: 'src/Binary.mjs'}
                    }]
                },
                hierarchyResolver: {
                    id     : 'fixture-hierarchy',
                    version: '1',
                    async resolve() {
                        return {'Fixture.Foo': 'Neo.core.Base'};
                    }
                }
            },
            options    : {type: 'src'},
            writeStream: {write() {
                throw new Error('binary content must not emit')
            }},
            createHashFn: () => 'hash'
        });

        expect(result).toMatchObject({
            count             : 0,
            yieldedSourcePaths: [],
            skippedSourcePaths: [{
                sourcePath: 'src/Binary.mjs',
                reason    : 'binary'
            }]
        });
    });

    test('refuses a hierarchy coverage regression before writing any repository chunks', async () => {
        const writes  = [];
        const content = await fs.readFile(path.join(root, 'src/Foo.mjs'), 'utf8');

        await expect(ApiSource.extractFromRepository({
            context: {
                tenantId        : 'tenant-a',
                repoSlug        : 'org/repo',
                revision        : 'f'.repeat(40),
                repositoryReader: {
                    async readText() {
                        return content
                    }
                },
                territory: {
                    assignments: [{
                        root        : 'ai',
                        relativePath: 'Foo.mjs',
                        entry       : {sourcePath: 'ai/Foo.mjs'}
                    }]
                },
                hierarchyResolver: {
                    id     : 'empty-hierarchy',
                    version: '1',
                    async resolve() {
                        return {};
                    }
                }
            },
            options     : {type: 'ai-infrastructure'},
            writeStream : {write: value => writes.push(value)},
            createHashFn: () => 'hash'
        })).rejects.toMatchObject({code: 'CLASS_HIERARCHY_COVERAGE_REGRESSION'});

        expect(writes).toEqual([]);
    });
});

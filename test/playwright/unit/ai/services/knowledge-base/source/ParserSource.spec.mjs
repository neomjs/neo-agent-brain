import {setup} from '../../../../../setup.mjs';

setup({
    neoConfig: {unitTestMode: true},
    appConfig: {
        name             : 'RepositoryParserSourceTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import ParserSource   from '../../../../../../../ai/services/knowledge-base/source/ParserSource.mjs';

function context({parserResolver, content = '# Guide\n'} = {}) {
    return {
        tenantId        : 'tenant-a',
        repoSlug        : 'org/repo',
        revision        : 'f'.repeat(40),
        parserResolver,
        repositoryReader: {
            async readText(sourcePath) {
                expect(sourcePath).toBe('docs/guide.md');
                return content
            }
        },
        territory: {
            assignments: [{
                root        : 'docs',
                relativePath: 'guide.md',
                entry       : {sourcePath: 'docs/guide.md'}
            }]
        }
    }
}

test.describe('ParserSource repository port (#262)', () => {
    test('executes the declared parser and emits its structured chunks, never raw fallback', async () => {
        const writes = [];
        const result = await ParserSource.extractFromRepository({
            context: context({
                parserResolver: {
                    async resolve({parserId, tenantId}) {
                        expect({parserId, tenantId}).toEqual({
                            parserId: 'tenant-markdown',
                            tenantId: 'tenant-a'
                        });

                        return {
                            async parseIngestionFile(file, {tenantContext}) {
                                expect(file).toMatchObject({
                                    sourcePath   : 'docs/guide.md',
                                    parserId     : 'tenant-markdown',
                                    parserVersion: '2.0.0'
                                });
                                expect(tenantContext).toMatchObject({
                                    tenantId: 'tenant-a',
                                    repoSlug: 'org/repo'
                                });

                                return [{
                                    kind   : 'heading',
                                    name   : 'Guide',
                                    content: file.content,
                                    source : file.sourcePath
                                }]
                            }
                        }
                    }
                }
            }),
            options: {
                parserId     : 'tenant-markdown',
                parserVersion: '2.0.0'
            },
            writeStream : {write: value => writes.push(JSON.parse(value))},
            createHashFn: () => 'unused-by-parser-source'
        });

        expect(result).toEqual({
            count             : 1,
            yieldedSourcePaths: ['docs/guide.md'],
            skippedSourcePaths: []
        });
        expect(writes).toEqual([{
            kind   : 'heading',
            name   : 'Guide',
            content: '# Guide\n',
            source : 'docs/guide.md'
        }]);
        expect(writes[0]).not.toHaveProperty('type', 'raw');
    });

    test('preserves fail-closed when the declared parser cannot resolve', async () => {
        const writes = [];

        await expect(ParserSource.extractFromRepository({
            context: context({
                parserResolver: {async resolve() { return null }}
            }),
            options: {
                parserId     : 'missing-parser',
                parserVersion: '1.0.0'
            },
            writeStream : {write: value => writes.push(value)},
            createHashFn: () => 'unused'
        })).rejects.toMatchObject({code: 'KB_PARSER_NOT_REGISTERED'});

        expect(writes).toEqual([]);
    });
});

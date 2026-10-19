import {setup} from '../../../../../setup.mjs';

const appName = 'AdrSourceTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}  from '@playwright/test';
import fs              from 'fs-extra';
import path            from 'path';
import {fileURLToPath} from 'url';
import Neo             from 'neo.mjs/src/Neo.mjs';
import * as core       from 'neo.mjs/src/core/_export.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '../../../../../../..');
const redirect   = `---
type: redirect
target: adr:github.com:1347756127:neomjs%2Fneo-agent-institution:0002
---

# Moved to neomjs/neo-agent-institution
`;

test.describe('Neo.ai.services.knowledge-base.source.AdrSource', () => {
    let AdrSource;
    let aiConfig;
    let originalRoot;
    let mockRoot;

    test.beforeAll(async () => {
        aiConfig    = (await import('../../../../../../../ai/mcp/server/knowledge-base/config.template.mjs')).default;
        AdrSource = (await import('../../../../../../../ai/services/knowledge-base/source/AdrSource.mjs')).default;

        originalRoot = aiConfig.neoRootDir;

        const tmpDir = path.resolve(process.cwd(), 'tmp');
        fs.ensureDirSync(tmpDir);
        mockRoot = path.join(tmpDir, `adr-source-mock-${process.pid}-${Date.now()}`);

        const adrDir = path.join(mockRoot, 'learn/agentos/decisions');
        fs.ensureDirSync(adrDir);

        fs.writeFileSync(path.join(adrDir, '0001-example-adr.md'),
`# ADR 1
Example decision.`);

        fs.writeFileSync(path.join(adrDir, 'not-an-adr.md'),
`# Not an ADR
This should be skipped.`);

        fs.writeFileSync(path.join(adrDir, '0002-moved-record.md'), redirect);

        aiConfig.neoRootDir = mockRoot;
    });

    test.afterAll(() => {
        aiConfig.neoRootDir = originalRoot;
        if (mockRoot && fs.existsSync(mockRoot)) fs.removeSync(mockRoot);
    });

    test('is a Neo.setupClass singleton with the expected className and extract() method', () => {
        expect(AdrSource, 'default export must resolve').toBeDefined();
        expect(AdrSource.className).toBe('Neo.ai.services.knowledge-base.source.AdrSource');
        expect(typeof AdrSource.extract).toBe('function');
    });

    test('extract() emits correctly typed and chunked ADRs, skipping non-matching files and redirects', async () => {
        const written     = [];
        const writeStream = {
            write(chunkStr) {
                written.push(JSON.parse(chunkStr.trim()));
                return true;
            }
        };
        const createHashFn = chunk => 'hash:' + chunk.name;

        const count = await AdrSource.extract(writeStream, createHashFn);

        expect(count).toBe(1);
        expect(written).toHaveLength(1);

        const chunk = written[0];
        expect(chunk).toMatchObject({
            type   : 'adr',
            kind   : 'adr',
            name   : '0001-example-adr',
            content: '# ADR 1\nExample decision.'
        });
    });

    test('extractFromRepository() indexes the record and reports the redirect beside it as skipped', async () => {
        const
            files   = {
                'learn/agentos/decisions/0001-example-adr.md' : '# ADR 1\nExample decision.',
                'learn/agentos/decisions/0002-moved-record.md': redirect,
                'learn/agentos/decisions/README.md'           : '# Decisions'
            },
            written = [],
            result  = await AdrSource.extractFromRepository({
                context: {
                    repositoryReader: {readText: async sourcePath => files[sourcePath]},
                    territory       : {
                        assignments: Object.keys(files).map(sourcePath => ({
                            entry       : {sourcePath},
                            relativePath: path.posix.basename(sourcePath)
                        }))
                    }
                },
                writeStream : {write: line => written.push(JSON.parse(line))},
                createHashFn: chunk => 'hash:' + chunk.name
            });

        expect(result.count).toBe(1);
        expect(result.yieldedSourcePaths).toEqual(['learn/agentos/decisions/0001-example-adr.md']);
        expect(written.map(chunk => chunk.name)).toEqual(['0001-example-adr']);
        expect(result.skippedSourcePaths).toEqual([
            {sourcePath: 'learn/agentos/decisions/0002-moved-record.md', reason: 'redirect'},
            {sourcePath: 'learn/agentos/decisions/README.md',            reason: 'not-adr'}
        ]);
    });
});

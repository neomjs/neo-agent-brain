import {setup} from '../../../../../setup.mjs';

const appName = 'ConceptSourceTest';

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

import {test, expect}              from '@playwright/test';
import fs                          from 'fs-extra';
import path                        from 'path';
import {fileURLToPath}             from 'url';
import Neo                         from 'neo.mjs/src/Neo.mjs';
import * as core                   from 'neo.mjs/src/core/_export.mjs';
import {findSharedConfigMutations} from '../../../../../../../ai/scripts/lint/check-aiconfig-test-mutation.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '../../../../../../..');

test.describe('Neo.ai.services.knowledge-base.source.ConceptSource', () => {
    let ConceptSource;
    let mockRoot;

    test.beforeAll(async () => {
        ConceptSource = (await import('../../../../../../../ai/services/knowledge-base/source/ConceptSource.mjs')).default;

        const tmpDir = path.resolve(process.cwd(), 'tmp');
        fs.ensureDirSync(tmpDir);
        mockRoot = path.join(tmpDir, `concept-source-mock-${process.pid}-${Date.now()}`);

        const conceptsDir = path.join(mockRoot, 'resources/content/concepts');
        fs.ensureDirSync(conceptsDir);

        fs.writeFileSync(path.join(conceptsDir, 'multi-threading.md'),
`---
name: "Multi-Threading Architecture"
tier: 1
---

Neo.mjs distributes application logic across dedicated Web Workers.`);

        const snapshot = ConceptSource.createConfigSnapshot();
        snapshot.projectRoot    = mockRoot;
        ConceptSource.configSnapshot = snapshot;
    });

    test.afterAll(() => {
        ConceptSource.configSnapshot = null;
        if (mockRoot && fs.existsSync(mockRoot)) fs.removeSync(mockRoot);
    });

    test('is a Neo.setupClass singleton with the expected className and extract() method', () => {
        expect(ConceptSource, 'default export must resolve').toBeDefined();
        expect(ConceptSource.className).toBe('Neo.ai.services.knowledge-base.source.ConceptSource');
        expect(typeof ConceptSource.extract).toBe('function');
    });

    test('extract() emits correctly typed and chunked concepts', async () => {
        const written     = [];
        const writeStream = {
            write(chunkStr) {
                written.push(JSON.parse(chunkStr.trim()));
                return true;
            }
        };
        const createHashFn = chunk => 'hash:' + chunk.name;

        const count = await ConceptSource.extract(writeStream, createHashFn);

        expect(count).toBe(1);
        expect(written).toHaveLength(1);

        const chunk = written[0];
        expect(chunk).toMatchObject({
            type       : 'concept',
            kind       : 'concept',
            name       : 'Multi-Threading Architecture',
            tier       : 1,
            description: 'Neo.mjs distributes application logic across dedicated Web Workers.',
            content    : 'Multi-Threading Architecture: Neo.mjs distributes application logic across dedicated Web Workers.'
        });
    });

    test('uses ConceptSource.configSnapshot instead of mutating shared config singletons', async () => {
        const source = await fs.readFile(__filename, 'utf8');
        expect(findSharedConfigMutations(source)).toEqual([]);
    });
});

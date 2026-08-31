import {test, expect} from '@playwright/test';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import {
    TENANT_EXTRACTOR_ERROR_CODES,
    loadTenantExtractor,
    resolveTenantExtractorPath
} from '../../../../../../../ai/services/knowledge-base/source/tenantExtractorLoader.mjs';

test.describe('tenantExtractorLoader — tenant code stays below the deployment root', () => {
    let tmpRoot, root;

    test.beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-extractor-'));
        root    = path.join(tmpRoot, 'root');

        fs.mkdirSync(path.join(root, 'nested'), {recursive: true});
        fs.mkdirSync(path.join(tmpRoot, 'outside'), {recursive: true});
        fs.writeFileSync(path.join(root, 'Good.mjs'), `
export default {
    extractorId: 'TenantDocs',
    version: '1.2.3',
    deltaSafe: false,
    async extract() { return {count: 0, yieldedSourcePaths: []} }
};
`);
        fs.writeFileSync(path.join(root, 'Named.mjs'), `
export const Custom = {
    extractorId: 'NamedDocs',
    version: '2.0.0',
    async extract() { return {count: 0, yieldedSourcePaths: []} }
};
`);
        fs.writeFileSync(path.join(root, 'UnsafeDelta.mjs'), `
export default {
    extractorId: 'UnsafeDelta',
    version: '1.0.0',
    deltaSafe: true,
    async extract() { return {count: 0, yieldedSourcePaths: []} }
};
`);
        fs.writeFileSync(path.join(root, 'Invalid.mjs'), 'export default {extractorId: "Invalid"};\n');
        fs.writeFileSync(path.join(tmpRoot, 'outside', 'Evil.mjs'), `
export default {
    extractorId: 'Evil',
    version: '1.0.0',
    async extract() { return {count: 0, yieldedSourcePaths: []} }
};
`);
    });

    test.afterEach(() => fs.rmSync(tmpRoot, {recursive: true, force: true}));

    test('POSITIVE CONTROL: resolves and loads a descriptor whose module owns id and version', async () => {
        expect(resolveTenantExtractorPath({specifier: 'Good.mjs', root}))
            .toBe(fs.realpathSync(path.join(root, 'Good.mjs')));

        const descriptor = await loadTenantExtractor({specifier: 'Good.mjs', root});

        expect(descriptor).toMatchObject({
            extractorId: 'TenantDocs',
            version    : '1.2.3',
            deltaSafe  : false
        });
        expect(typeof descriptor.extract).toBe('function');
    });

    test('an unset root disables tenant extractor execution with no fallback', () => {
        for (const empty of ['', '   ', undefined, null]) {
            expect(() => resolveTenantExtractorPath({specifier: 'Good.mjs', root: empty}))
                .toThrow(expect.objectContaining({
                    code: TENANT_EXTRACTOR_ERROR_CODES.rootNotSet
                }));
        }
    });

    test('absolute, traversal, and symlink escapes all refuse', () => {
        const outside = path.join(tmpRoot, 'outside', 'Evil.mjs');

        expect(() => resolveTenantExtractorPath({specifier: outside, root}))
            .toThrow(expect.objectContaining({code: TENANT_EXTRACTOR_ERROR_CODES.unsafeShape}));
        expect(() => resolveTenantExtractorPath({specifier: 'nested/../../outside/Evil.mjs', root}))
            .toThrow(expect.objectContaining({code: TENANT_EXTRACTOR_ERROR_CODES.escapesRoot}));

        fs.symlinkSync(outside, path.join(root, 'Linked.mjs'));

        expect(() => resolveTenantExtractorPath({specifier: 'Linked.mjs', root}))
            .toThrow(expect.objectContaining({code: TENANT_EXTRACTOR_ERROR_CODES.escapesRoot}));
    });

    test('a named export is authoritative when the declaration selects it', async () => {
        const descriptor = await loadTenantExtractor({
            specifier : 'Named.mjs',
            exportName: 'Custom',
            root
        });

        expect(descriptor.extractorId).toBe('NamedDocs');
        expect(descriptor.version).toBe('2.0.0');
    });

    test('rejects a custom deltaSafe true claim before catalogue assembly', async () => {
        await expect(loadTenantExtractor({specifier: 'UnsafeDelta.mjs', root}))
            .rejects.toMatchObject({code: TENANT_EXTRACTOR_ERROR_CODES.deltaSafeUnproven});
    });

    test('rejects an export without module-owned id, version, and extract function', async () => {
        await expect(loadTenantExtractor({specifier: 'Invalid.mjs', root}))
            .rejects.toMatchObject({code: TENANT_EXTRACTOR_ERROR_CODES.notDispatchable});
    });
});

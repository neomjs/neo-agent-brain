import {setup} from '../../../../setup.mjs';

const appName = 'RepositoryClassHierarchyResolverTest';

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

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import fs             from 'node:fs';
import path           from 'node:path';

const SHA = 'a'.repeat(40);

let RepositoryClassHierarchyResolver,
    REPOSITORY_CLASS_HIERARCHY_RESOLVER_ID,
    REPOSITORY_CLASS_HIERARCHY_RESOLVER_VERSION;

function createReader(files) {
    const
        prefetched = [],
        entries    = Object.keys(files).sort().map((sourcePath, index) => ({
            sourcePath,
            mode: '100644',
            type: 'blob',
            oid : String(index + 1).padStart(40, '0')
        }));

    return {
        tenantId: 'tenant-a',
        repoSlug: 'org/repo',
        revision: SHA,
        prefetched,
        async listRegularEntries() {
            return entries
        },
        async prefetch(sourcePaths) {
            prefetched.push(...sourcePaths);
        },
        async readText(sourcePath) {
            const value = files[sourcePath];

            if (value instanceof Error) {
                throw value
            }

            return value
        }
    }
}

function neoClass({name, className, parent = null, parentImport = null}) {
    const importLine = parentImport
        ? `import ${parent} from '${parentImport}';\n`
        : '';
    const extendsClause = parent ? ` extends ${parent}` : '';

    return `${importLine}class ${name}${extendsClause} {\n` +
        `    static config = {className: '${className}'}\n` +
        `}\n\nexport default Neo.setupClass(${name});\n`
}

test.describe('repository class-hierarchy resolver (#263)', () => {
    test.beforeAll(async () => {
        const module = await import(
            '../../../../../../ai/services/knowledge-base/helpers/repositoryClassHierarchyResolver.mjs'
        );

        RepositoryClassHierarchyResolver          = module.default;
        REPOSITORY_CLASS_HIERARCHY_RESOLVER_ID      = module.REPOSITORY_CLASS_HIERARCHY_RESOLVER_ID;
        REPOSITORY_CLASS_HIERARCHY_RESOLVER_VERSION = module.REPOSITORY_CLASS_HIERARCHY_RESOLVER_VERSION;
    });

    test('exposes one immutable, versioned repository capability', () => {
        expect(REPOSITORY_CLASS_HIERARCHY_RESOLVER_ID).toBe('repository-class-hierarchy');
        expect(REPOSITORY_CLASS_HIERARCHY_RESOLVER_VERSION).toBe('1.0.0');
        expect(RepositoryClassHierarchyResolver).toMatchObject({
            id     : REPOSITORY_CLASS_HIERARCHY_RESOLVER_ID,
            version: REPOSITORY_CLASS_HIERARCHY_RESOLVER_VERSION
        });
        expect(typeof RepositoryClassHierarchyResolver.resolve).toBe('function');
        expect(Object.isFrozen(RepositoryClassHierarchyResolver)).toBe(true);
    });

    test('derives the hierarchy from the exact scoped revision and resolves relative plus Engine-package parents', async () => {
        const reader = createReader({
            'ai/BaseThing.mjs': neoClass({
                name        : 'BaseThing',
                className   : 'Neo.ai.BaseThing',
                parent      : 'Base',
                parentImport: 'neo.mjs/src/core/Base.mjs'
            }),
            'ai/Child.mjs': neoClass({
                name        : 'Child',
                className   : 'Neo.ai.Child',
                parent      : 'BaseThing',
                parentImport: './BaseThing.mjs'
            }),
            'ai/Plain.mjs'  : neoClass({name: 'Plain', className: 'Neo.ai.Plain'}),
            'ai/utility.mjs': 'export const answer = 42;\n'
        });

        await expect(RepositoryClassHierarchyResolver.resolve({
            tenantId        : reader.tenantId,
            repoSlug        : reader.repoSlug,
            revision        : reader.revision,
            repositoryReader: reader,
            territory       : {roots: ['ai']}
        })).resolves.toEqual({
            'Neo.ai.BaseThing': 'Neo.core.Base',
            'Neo.ai.Child'    : 'Neo.ai.BaseThing',
            'Neo.ai.Plain'    : null
        });

        expect(reader.prefetched).toEqual([
            'ai/BaseThing.mjs',
            'ai/Child.mjs',
            'ai/Plain.mjs',
            'ai/utility.mjs'
        ]);
    });

    test('uses SourceParser class descriptors instead of minting a parallel class census', () => {
        const
            repoRoot = path.resolve(import.meta.dirname, '../../../../../..'),
            source   = fs.readFileSync(
                path.join(repoRoot, 'ai/services/knowledge-base/helpers/repositoryClassHierarchyResolver.mjs'),
                'utf8'
            );

        expect(source).toContain("import SourceParser from '../parser/SourceParser.mjs'");
        expect(source).not.toMatch(/from ['"]acorn['"]/u);
        expect(source).not.toMatch(/AiConfig|aiConfig|hierarchyPath|fs-extra/u);
    });

    test('fails closed on duplicate class identities before returning a map', async () => {
        const reader = createReader({
            'ai/One.mjs': neoClass({name: 'One', className: 'Neo.ai.Duplicate'}),
            'ai/Two.mjs': neoClass({name: 'Two', className: 'Neo.ai.Duplicate'})
        });

        await expect(RepositoryClassHierarchyResolver.resolve({repositoryReader: reader}))
            .rejects.toMatchObject({code: 'KB_REPOSITORY_HIERARCHY_DUPLICATE_CLASS'});
    });

    test('fails closed on malformed source and names the revision path', async () => {
        const reader = createReader({'ai/Broken.mjs': 'class Broken extends {'});

        const error = await RepositoryClassHierarchyResolver.resolve({repositoryReader: reader})
            .then(() => null, value => value);

        expect(error).toMatchObject({code: 'KB_SOURCE_PARSE_FAILED'});
        expect(error.message).toContain('ai/Broken.mjs');
    });

    test('refuses a reader that is not a repository-bound hierarchy capability', async () => {
        await expect(RepositoryClassHierarchyResolver.resolve({repositoryReader: {}}))
            .rejects.toMatchObject({code: 'KB_REPOSITORY_HIERARCHY_READER_INVALID'});
    });
});

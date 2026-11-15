import * as acorn     from 'acorn';
import {spawnSync}    from 'node:child_process';
import fs             from 'node:fs';
import path           from 'node:path';
import process        from 'node:process';
import {test, expect} from '@playwright/test';
import {
    REPOSITORY_CLASS_HIERARCHY_RESOLVER_ID,
    REPOSITORY_CLASS_HIERARCHY_RESOLVER_VERSION,
    REPOSITORY_SOURCE_PATH_CLASS_HIERARCHY_RESOLVER_ID,
    REPOSITORY_SOURCE_PATH_CLASS_HIERARCHY_RESOLVER_VERSION,
    inferClassNameFromPath,
    resolveRelativeModule,
    resolveSuperClass
}                     from '../../../../../../../ai/services/knowledge-base/helpers/classHierarchyResolution.mjs';

const repoRoot         = path.resolve(import.meta.dirname, '../../../../../../..');
const resolutionPath   = path.join(repoRoot, 'ai/services/knowledge-base/helpers/classHierarchyResolution.mjs');
const flatResolverPath = path.join(repoRoot, 'ai/services/knowledge-base/helpers/repositoryClassHierarchyResolver.mjs');

test.describe('classHierarchyResolution — Neo-free versioned superclass resolution', () => {
    test('imports only node:path and never boots Neo in a fresh Node process', () => {
        const source      = fs.readFileSync(resolutionPath, 'utf8');
        const ast         = acorn.parse(source, {ecmaVersion: 'latest', sourceType: 'module'});
        const importNodes = ast.body.filter(
            node => node.type === 'ImportDeclaration'
                || (node.type === 'ExportNamedDeclaration' && node.source)
                || node.type === 'ExportAllDeclaration'
        );

        expect(importNodes.map(node => node.source.value)).toEqual(['node:path']);
        expect(REPOSITORY_CLASS_HIERARCHY_RESOLVER_ID).toBe('repository-class-hierarchy');
        expect(REPOSITORY_CLASS_HIERARCHY_RESOLVER_VERSION).toBe('1.0.0');
        expect(REPOSITORY_SOURCE_PATH_CLASS_HIERARCHY_RESOLVER_ID).toBe('repository-source-path-class-hierarchy');
        expect(REPOSITORY_SOURCE_PATH_CLASS_HIERARCHY_RESOLVER_VERSION).toBe('1.0.0');

        const probe = spawnSync(process.execPath, [
            '--input-type=module',
            '-e',
            `import {inferClassNameFromPath} from ${JSON.stringify(resolutionPath)};
             if (globalThis.Neo !== undefined) process.exit(2);
             if (inferClassNameFromPath('src/button/Base.mjs') !== 'Neo.button.Base') process.exit(3);`
        ], {encoding: 'utf8'});

        expect(probe.status).toBe(0);
    });

    test('resolves in-scope relative imports, named imports, and cross-territory Neo paths', () => {
        const descriptorsByPath = new Map([
            ['src/core/Base.mjs', {className: 'Neo.core.Base'}]
        ]);

        expect(resolveRelativeModule({
            sourcePath: 'src/button/Base.mjs',
            specifier : '../core/Base',
            descriptorsByPath
        })).toEqual({
            sourcePath: 'src/core/Base.mjs',
            descriptor: {className: 'Neo.core.Base'}
        });

        expect(resolveSuperClass({
            sourcePath: 'examples/component/video/MainContainer.mjs',
            descriptor: {
                declaresSuper      : true,
                superClassReference: {kind: 'identifier', name: 'Viewport'},
                imports            : [{
                    kind        : 'default',
                    localName   : 'Viewport',
                    importedName: 'default',
                    source      : '../../../src/container/Viewport.mjs'
                }]
            },
            descriptorsByPath
        })).toBe('Neo.container.Viewport');
    });

    test('keeps repositoryClassHierarchyResolver export surface restricted to resolver capabilities and version constants', async () => {
        const resolverSource = fs.readFileSync(flatResolverPath, 'utf8');
        expect(resolverSource).toContain("from './classHierarchyResolution.mjs'");
        expect(resolverSource).not.toContain('./sourceTreeIndex.mjs');

        const ast           = acorn.parse(resolverSource, {ecmaVersion: 'latest', sourceType: 'module'});
        const exportedNames = new Set();

        for (const node of ast.body) {
            if (node.type === 'ExportDefaultDeclaration') {
                exportedNames.add('default');
            } else if (node.type === 'ExportNamedDeclaration') {
                if (node.declaration?.declarations) {
                    node.declaration.declarations.forEach(d => exportedNames.add(d.id.name));
                } else if (node.declaration?.id) {
                    exportedNames.add(node.declaration.id.name);
                }
                node.specifiers.forEach(s => exportedNames.add(s.exported.name));
            }
        }

        expect([...exportedNames].sort()).toEqual([
            'REPOSITORY_CLASS_HIERARCHY_RESOLVER_ID',
            'REPOSITORY_CLASS_HIERARCHY_RESOLVER_VERSION',
            'REPOSITORY_SOURCE_PATH_CLASS_HIERARCHY_RESOLVER_ID',
            'REPOSITORY_SOURCE_PATH_CLASS_HIERARCHY_RESOLVER_VERSION',
            'RepositorySourcePathClassHierarchyResolver',
            'default'
        ]);
    });
});

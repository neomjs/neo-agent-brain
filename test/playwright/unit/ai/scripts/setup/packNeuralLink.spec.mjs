import {test, expect}  from '@playwright/test';
import fs              from 'fs';
import os              from 'os';
import path            from 'path';
import {fileURLToPath} from 'url';
import {collectClosure, moduleSpecifiers, packNeuralLink} from '../../../../../../ai/scripts/setup/packNeuralLink.mjs';

const
    brainRoot  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..'),
    serverDir  = 'ai/mcp/server/neural-link',
    serverJson = JSON.parse(fs.readFileSync(path.join(brainRoot, serverDir, 'server.json'), 'utf8')),
    // Native or store-backed: none of these may reach a package that must install anywhere npx runs.
    FORBIDDEN  = ['better-sqlite3', 'chromadb', '@chroma-core/default-embed', '@google/generative-ai', 'playwright'];

/**
 * The standalone Neural Link package: the server's import closure, its assets and overlays, and a
 * manifest the MCP Registry can verify. The package must load on a machine with no checkout, so
 * every assertion here is about what reaches that machine.
 */
test.describe('ai/scripts/setup/packNeuralLink', () => {
    test('moduleSpecifiers reads imports, re-exports and literal dynamic imports — never comments', () => {
        const source = [
            "import a from './a.mjs';",
            "export {b} from './b.mjs';",
            "export * from 'pkg/sub.js';",
            "const c = await import('./c.mjs');",
            "const d = await import(`./${name}.mjs`);",
            "// a comment that says from './ghost.mjs' must not count",
            "import 'node:fs';"
        ].join('\n');

        // Source order; the computed specifier and the comment contribute nothing.
        expect(moduleSpecifiers(source)).toEqual(['./a.mjs', './b.mjs', 'pkg/sub.js', './c.mjs', 'node:fs']);
    });

    test('the closure carries the server and nothing that needs a store or a native build', () => {
        const {files, packages} = collectClosure();

        for (const entry of ['standalone.mjs', 'mcp-server.mjs', 'run-bridge.mjs']) {
            expect(files).toContain(`${serverDir}/${entry}`);
        }

        // Overlays resolve to their tracked templates: a local overlay may carry operator deltas.
        expect(files).toContain('ai/config.template.mjs');
        expect(files).not.toContain('ai/config.mjs');
        expect(files.some(file => file.startsWith('ai/services/memory-core/'))).toBe(false);
        expect(files.some(file => file.startsWith('ai/services/knowledge-base/'))).toBe(false);

        expect(packages).toEqual(expect.arrayContaining(['@modelcontextprotocol/sdk', 'neo.mjs', 'ws']));
        for (const name of FORBIDDEN) expect(packages).not.toContain(name);
    });

    test('an import that resolves to nothing fails the closure instead of shipping a broken package', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-closure-'));

        try {
            fs.writeFileSync(path.join(root, 'entry.mjs'), "import './missing.mjs';\n");
            expect(() => collectClosure({entrypoints: ['entry.mjs'], root})).toThrow(/missing\.mjs/);
        } finally {
            fs.rmSync(root, {force: true, recursive: true});
        }
    });

    test('the package takes its identity from server.json, and is self-contained', async () => {
        const
            out = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-neural-link-')),
            npm = serverJson.packages.find(entry => entry.registryType === 'npm');

        try {
            const {manifest} = await packNeuralLink({out});

            // One declaration: the registry entry and the published package can never disagree.
            expect(manifest.name).toBe(npm.identifier);
            expect(manifest.version).toBe(npm.version);
            expect(manifest.mcpName).toBe(serverJson.name);
            expect(npm.transport).toEqual({type: 'stdio'});

            // The launcher is the bin, and the Bridge script is what ConnectionService#spawnBridge runs.
            expect(manifest.bin[manifest.name]).toBe(`${serverDir}/standalone.mjs`);
            expect(fs.existsSync(path.join(out, manifest.bin[manifest.name]))).toBe(true);
            expect(fs.readFileSync(path.join(brainRoot, 'ai/services/neural-link/ConnectionService.mjs'), 'utf8'))
                .toContain("BRIDGE_NPM_SCRIPT = 'ai:server-neural-link'");
            expect(manifest.scripts['ai:server-neural-link']).toBe(`node ./${serverDir}/run-bridge.mjs`);

            // A published package resolves from the registry: no tarball or git pins.
            for (const [name, range] of Object.entries(manifest.dependencies)) {
                expect(range, name).toMatch(/^[~^]?\d/);
                expect(FORBIDDEN).not.toContain(name);
            }

            // Overlays written as `prepare` writes them on a clean clone.
            expect(fs.readFileSync(path.join(out, 'ai/config.mjs'), 'utf8'))
                .toBe(fs.readFileSync(path.join(brainRoot, 'ai/config.template.mjs'), 'utf8'));
            expect(fs.readFileSync(path.join(out, serverDir, 'config.mjs'), 'utf8')).toContain("import '../../../config.mjs'");

            // Runtime assets read by path, and every relative import resolves inside the package.
            expect(fs.existsSync(path.join(out, serverDir, 'openapi.yaml'))).toBe(true);
            expect(() => collectClosure({root: out})).not.toThrow();
        } finally {
            fs.rmSync(out, {force: true, recursive: true});
        }
    });
});

import {setup} from '../../../../../setup.mjs';

setup({
    neoConfig: {
        allowVdomUpdatesInTests: false,
        unitTestMode           : true,
        useDomApiRenderer      : false
    },
    appConfig: {
        name             : 'KBManageKnowledgeBaseWipeRefusalTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}  from '@playwright/test';
import fs              from 'node:fs';
import os              from 'node:os';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';
import Neo             from 'neo.mjs/src/Neo.mjs';
import * as core       from 'neo.mjs/src/core/_export.mjs';

/**
 * The shared core scan now publishes two repository-owned artifacts behind one manifest and embeds
 * them additively. The tool cannot read an absent manifest, while the profile runner pins
 * `deleteStale: false` for both writes. The vector layer still has a destructive mode for other
 * callers, so the control below proves that deletion is reachable when explicitly enabled.
 *
 * The profile runner spec owns the two-repository stamp and option handoff. These tests guard the
 * MCP refusal and the real vector operation with observable collection rows, not a response label.
 */
test.describe.configure({mode: 'serial'});

/**
 * @summary Records vector reads and deletions against a small in-memory corpus.
 * @param {String[]} existingIds
 * @returns {Object}
 */
function createSpyCollection(existingIds) {
    const rows  = new Map(existingIds.map(id => [id, {id, metadata: {}}]));
    const calls = {delete: 0, get: 0, upsert: 0};

    return {
        name: 'spy-knowledge-base', rows, calls,

        async get({limit = 2000, offset = 0} = {}) {
            calls.get++;
            return {ids: [...rows.keys()].slice(offset, offset + limit)}
        },

        async upsert({ids}) {
            calls.upsert++;
            ids.forEach(id => rows.set(id, {id, metadata: {}}))
        },

        async delete({ids}) {
            calls.delete++;
            ids.forEach(id => rows.delete(id))
        },

        async count() { return rows.size }
    }
}

test.describe('manage_knowledge_base shared core deletion boundary', () => {
    let callTool, ChromaManager, KB_Config, VectorService;
    let originalGetCollection, originalThreshold, originalDataPath, directory, dataPath;

    test.beforeAll(async () => {
        const SDK = await import('../../../../../../../ai/services.mjs');

        ({callTool} = await import('../../../../../../../ai/mcp/server/knowledge-base/toolService.mjs'));
        ChromaManager = SDK.KB_ChromaManager;
        KB_Config = SDK.KB_Config;
        VectorService = (await import('../../../../../../../ai/services/knowledge-base/VectorService.mjs')).default;

        originalGetCollection = ChromaManager.getKnowledgeBaseCollection.bind(ChromaManager);
        originalThreshold = KB_Config.data.mcpSyncMaxChunks;
        originalDataPath = KB_Config.data.dataPath;
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-core-wipe-refusal-'));
        dataPath = path.join(directory, 'core.jsonl');
    });

    test.afterAll(() => {
        ChromaManager.getKnowledgeBaseCollection = originalGetCollection;
        KB_Config.data.mcpSyncMaxChunks = originalThreshold;
        KB_Config.data.dataPath = originalDataPath;
        directory && fs.rmSync(directory, {recursive: true, force: true})
    });

    test.beforeEach(() => {
        KB_Config.data.mcpSyncMaxChunks = 5;
        KB_Config.data.dataPath = dataPath;
        fs.writeFileSync(dataPath, '');
        fs.rmSync(`${dataPath}.profiles.json`, {force: true})
    });

    test('the MCP embed call refuses an unpublished profile manifest before vector writes', async () => {
        const spy = createSpyCollection(Array.from({length: 20}, (_, index) => `stale-${index}`));

        ChromaManager.getKnowledgeBaseCollection = async () => spy;

        await expect(callTool('manage_knowledge_base', {action: 'embed'}))
            .rejects.toThrow(/profiles\.json|ENOENT/u);
        expect(spy.rows.size).toBe(20);
        expect(spy.calls.delete).toBe(0);
        expect(spy.calls.get).toBe(0)
    });

    test('skip-stale preserves rows; explicit vector deletion remains a live negative control', async () => {
        const spy     = createSpyCollection(['stale-a', 'stale-b', 'stale-c']);
        const options = {viaMcp: true, tenantContext: {tenantId: 'neo-shared', repoSlug: 'neo'}};

        ChromaManager.getKnowledgeBaseCollection = async () => spy;

        await VectorService.embed(dataPath, {...options, deleteStale: false});
        expect(spy.calls.get).toBeGreaterThan(0);
        expect(spy.rows.size).toBe(3);
        expect(spy.calls.delete).toBe(0);

        await VectorService.embed(dataPath, {
            ...options, deleteStale: true, staleStrategy: 'delete-upfront'
        });
        expect(spy.calls.delete).toBeGreaterThan(0);
        expect(spy.rows.size).toBe(0)
    });

    test('the tool boundary strips a caller-supplied stale strategy', async () => {
        const
            {buildZodSchema} = await import('../../../../../../../ai/mcp/validation/openApiValidator.mjs'),
            yamlModule       = await import('js-yaml'),
            load             = yamlModule.load || yamlModule.default.load,
            here             = path.dirname(fileURLToPath(import.meta.url)),
            repoRoot         = path.resolve(here, '../../../../../../..'),
            spec             = load(fs.readFileSync(path.join(repoRoot, 'ai/mcp/server/knowledge-base/openapi.yaml'), 'utf8'));

        let operation;

        for (const item of Object.values(spec.paths || {})) {
            for (const method of Object.values(item)) {
                if (method?.operationId === 'manage_knowledge_base') operation = method
            }
        }

        expect(operation).toBeTruthy();
        const parsed = buildZodSchema(spec, operation).parse({
            action: 'embed', staleStrategy: 'delete-upfront', viaMcp: true
        });

        expect(parsed).toEqual({action: 'embed'});
        expect('staleStrategy' in parsed).toBe(false);
        expect('viaMcp' in parsed).toBe(false)
    })
});

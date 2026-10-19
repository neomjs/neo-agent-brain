import {setup} from '../../../../setup.mjs';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : 'SnapshotAiConfigTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}     from '@playwright/test';
import Neo                from 'neo.mjs/src/Neo.mjs';
import * as core          from 'neo.mjs/src/core/_export.mjs';
import {snapshotAiConfig} from './util.mjs';

/**
 * @summary Unit coverage for the snapshotAiConfig test-isolation helper.
 *
 * Two layers: pure-fixture tests pin the restore-existing / throw-on-absent contract against a plain
 * object, and a Provider-backed block proves the same contract on the real aiConfig Provider
 * singleton — whose proxy has no delete API, the surface the helper actually guards.
 */
test.describe('Neo.ai test-isolation — snapshotAiConfig (#12435)', () => {
    test('restores mutated leaves to their captured values', () => {
        const cfg = {storagePaths: {graph: '/orig/graph.sqlite'}, handoffFilePath: '/orig/handoff.md'};

        const restore = snapshotAiConfig(cfg, ['storagePaths.graph', 'handoffFilePath']);

        cfg.storagePaths.graph = '/tmp/test.sqlite';
        cfg.handoffFilePath    = '/tmp/handoff.md';

        restore();

        expect(cfg.storagePaths.graph).toBe('/orig/graph.sqlite');
        expect(cfg.handoffFilePath).toBe('/orig/handoff.md');
    });

    test('throws on a leaf that does not exist at capture time', () => {
        const cfg = {storagePaths: {graph: '/orig/graph.sqlite'}};

        // No delete API on the real target, so the helper refuses a path it cannot undo rather than
        // hand back a restore() that silently leaks the test-written value.
        expect(() => snapshotAiConfig(cfg, ['handoffFilePath'])).toThrow(/does not resolve to a value/);
    });

    test('throws when a snapshotted path has no parent', () => {
        const cfg = {};

        expect(() => snapshotAiConfig(cfg, ['engines.chroma.database'])).toThrow(/does not resolve to a value/);
    });

    test('atomically captures, applies overrides, and restores when given an override map (#1150)', () => {
        const cfg = {storagePaths: {graph: '/orig/graph.sqlite'}, handoffFilePath: '/orig/handoff.md'};

        const restore = snapshotAiConfig(cfg, {
            'storagePaths.graph': '/tmp/override.sqlite',
            handoffFilePath     : '/tmp/override-handoff.md'
        });

        expect(cfg.storagePaths.graph).toBe('/tmp/override.sqlite');
        expect(cfg.handoffFilePath).toBe('/tmp/override-handoff.md');

        restore();

        expect(cfg.storagePaths.graph).toBe('/orig/graph.sqlite');
        expect(cfg.handoffFilePath).toBe('/orig/handoff.md');
    });

    test('validates all override map paths before mutating any leaf (#1150)', () => {
        const cfg = {storagePaths: {graph: '/orig/graph.sqlite'}};

        expect(() => snapshotAiConfig(cfg, {
            'storagePaths.graph': '/tmp/never-written.sqlite',
            absentLeaf          : 'bad'
        })).toThrow(/does not resolve to a value/);

        expect(cfg.storagePaths.graph).toBe('/orig/graph.sqlite');
    });

    test('rejects non-scalar object overrides or branch paths (#1151)', () => {
        const cfg = {storagePaths: {graph: '/orig/graph.sqlite'}, tags: ['a']};

        expect(() => snapshotAiConfig(cfg, {
            storagePaths: {graph: '/tmp/nested-object-override.sqlite'}
        })).toThrow('snapshotAiConfig: leaf "storagePaths" must be a scalar or array value; received an object.');

        expect(() => snapshotAiConfig(cfg, {
            'storagePaths.graph': {nested: true}
        })).toThrow('snapshotAiConfig: leaf "storagePaths.graph" must be a scalar or array value; received an object.');

        expect(cfg.storagePaths.graph).toBe('/orig/graph.sqlite');

        const restore = snapshotAiConfig(cfg, {tags: ['b', 'c']});
        expect(cfg.tags).toEqual(['b', 'c']);
        restore();
        expect(cfg.tags).toEqual(['a']);
    });
});

test.describe('Neo.ai test-isolation — snapshotAiConfig on the real aiConfig Provider', () => {
    let aiConfig;

    test.beforeAll(async () => {
        aiConfig = (await import('../../../../../../ai/mcp/server/memory-core/config.template.mjs')).default;
    });

    test('restores an existing leaf on the real Provider singleton via the set trap', () => {
        // handoffFilePathProd is a declared scalar leaf (the formula's prod input), not a storage/DB
        // path, so this snapshot→mutate→restore round-trip cannot bleed test state into a live DB
        // (B4). The active `handoffFilePath` is now a read-only computed formula, so the set trap is
        // exercised on its writable underlying leaf. restore() runs in `finally`, so the shared
        // singleton returns to its captured value even if the mid-flight assertion throws.
        const original = aiConfig.handoffFilePathProd,
              restore  = snapshotAiConfig(aiConfig, ['handoffFilePathProd']);

        try {
            aiConfig.handoffFilePathProd = '/tmp/__neo_probe_handoff__.md';
            expect(aiConfig.handoffFilePathProd).toBe('/tmp/__neo_probe_handoff__.md') // set trap wrote through
        } finally {
            restore()
        }

        expect(aiConfig.handoffFilePathProd).toBe(original) // get trap reads the restored value
    });

    test('refuses an absent leaf it cannot undo, instead of returning a leaky restore', () => {
        // Closes the delete-added falsifier at its source: the proxy cannot remove a path a test
        // adds, so the helper throws at capture rather than hand back a restore() that leaks.
        const probe = '__neoAbsentLeafProbe__';

        expect(aiConfig[probe]).toBeUndefined(); // absent on the real Provider
        expect(() => snapshotAiConfig(aiConfig, [probe])).toThrow(/does not resolve to a value/)
    });

    test('restores nested override-map mutations via the active root snapshot baseline (#1150)', () => {
        const original    = aiConfig.handoffFilePathProd,
              rootRestore = snapshotAiConfig(aiConfig);

        try {
            snapshotAiConfig(aiConfig, {handoffFilePathProd: '/tmp/__neo_nested_1__.md'});
            expect(aiConfig.handoffFilePathProd).toBe('/tmp/__neo_nested_1__.md');

            snapshotAiConfig(aiConfig, {handoffFilePathProd: '/tmp/__neo_nested_2__.md'});
            expect(aiConfig.handoffFilePathProd).toBe('/tmp/__neo_nested_2__.md');
        } finally {
            rootRestore();
        }

        expect(aiConfig.handoffFilePathProd).toBe(original);
        expect(() => snapshotAiConfig(aiConfig, ['knowledgeBase.__probeNestedKey__'])).toThrow(/does not resolve to a value/);
    });
});

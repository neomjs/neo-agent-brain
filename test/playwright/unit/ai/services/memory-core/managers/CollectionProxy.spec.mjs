import {setup} from '../../../../../setup.mjs';

const appName = 'CollectionProxyIdentityTest';

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

/**
 * @summary `resolveCollectionId` answers with the SOURCE's identity, never the proxy's own.
 *
 * `CollectionProxy` extends `Neo.core.Base`, so `proxy.id` is a framework instance id (`neo-base-NN`)
 * that moves with construction order. Backup receipts recorded exactly that as `collectionId` (#281),
 * so `deriveLineage` compared process-instance counters instead of collections — reporting `changed`
 * for an ordinary restart and `same` across a genuine swap. These arms pin the distinction the
 * receipt depends on.
 */
test.describe('Neo.ai.services.memory-core.managers.CollectionProxy — collection identity', () => {
    let CollectionProxy;

    test.beforeAll(async () => {
        CollectionProxy = (await import('../../../../../../../ai/services/memory-core/managers/CollectionProxy.mjs')).default;
    });

    /**
     * Builds a proxy whose manager fan-out is stubbed, so the arms exercise identity resolution
     * without a Chroma client. `getManagers` is the seam the real implementation reads.
     */
    const proxyFronting = (...collections) => {
        const proxy = Neo.create(CollectionProxy, {collectionType: 'memory'});

        proxy.getManagers = async () => collections.map(collection => ({
            getMemoryCollection: async () => collection
        }));

        return proxy;
    };

    test('RED CONTROL: it returns the SOURCE id, never the proxy\'s own `neo-base-NN` instance id', async () => {
        // The whole defect in one assertion. Before the fix the receipt recorded `proxy.id`, which is
        // this value — structured, stable-looking, and completely unrelated to the collection.
        const proxy = proxyFronting({id: 'b0710dd0-cfbf-4196-9855-7a0ea961ebbc'});

        expect(proxy.id).toMatch(/^neo-base-\d+$/u);
        expect(await proxy.resolveCollectionId()).toBe('b0710dd0-cfbf-4196-9855-7a0ea961ebbc');
        expect(await proxy.resolveCollectionId()).not.toBe(proxy.id);
    });

    test('two proxies over the SAME collection agree — so a restart alone cannot read as `changed`', async () => {
        // The lineage property that mattered: separate processes construct separate proxies with
        // different instance ids. If identity tracked the proxy, every restart would look like a
        // collection change, which is precisely what #270's MC evidence showed.
        const first  = proxyFronting({id: 'same-collection'}),
              second = proxyFronting({id: 'same-collection'});

        expect(first.id).not.toBe(second.id);
        expect(await first.resolveCollectionId()).toBe(await second.resolveCollectionId());
    });

    test('two proxies over DIFFERENT collections disagree — a genuine swap stays visible', async () => {
        const before = proxyFronting({id: 'b0710dd0-before'}),
              after  = proxyFronting({id: 'c962a779-after'});

        expect(await before.resolveCollectionId()).not.toBe(await after.resolveCollectionId());
    });

    test('no resolvable manager yields `null`, degrading lineage to `unknown` rather than asserting continuity', async () => {
        expect(await proxyFronting().resolveCollectionId()).toBeNull();
    });

    test.describe('the fan-out case, dispositioned rather than assumed', () => {
        // `getManagers()` returns at most one manager today — both `aiConfig.engine` values select
        // `ChromaManager` alone — so the array is future shape. These arms fix the behaviour now, so a
        // second manager cannot silently redefine what the receipt's identity means.
        test('several collections compose into one deterministic identity', async () => {
            const proxy = proxyFronting({id: 'alpha'}, {id: 'beta'});

            expect(await proxy.resolveCollectionId()).toBe('alpha+beta');
        });

        test('resolution ORDER does not change the identity — an unchanged fan-out never reads as changed', async () => {
            // Sorting is load-bearing, not tidiness: without it, managers resolving in a different
            // order would derive `lineage: changed` for a fan-out that never moved.
            const forward = proxyFronting({id: 'alpha'}, {id: 'beta'}),
                  reverse = proxyFronting({id: 'beta'}, {id: 'alpha'});

            expect(await forward.resolveCollectionId()).toBe(await reverse.resolveCollectionId());
        });

        test('an unresolvable member is dropped rather than poisoning the identity', async () => {
            const proxy = proxyFronting({id: 'alpha'}, {});

            expect(await proxy.resolveCollectionId()).toBe('alpha');
        });
    });
});

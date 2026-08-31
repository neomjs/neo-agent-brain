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

    test.describe('the identity is bound to the READ handle, not to the manager set', () => {
        // `get()` and `count()` read `collections[0]` and ignore the rest, so a receipt's rows come
        // from exactly one collection. An identity describing the whole set would describe something
        // other than the data it accompanies.
        test('several managers still identify the PRIMARY — the one the rows came from', async () => {
            const proxy = proxyFronting({id: 'primary'}, {id: 'secondary'});

            expect(await proxy.resolveCollectionId()).toBe('primary');
        });

        test('NEGATIVE CONTROL: a change confined to a SECONDARY does not move the identity', async () => {
            // The false-refuse this prevents. Under a composite identity, swapping a member that
            // contributes no exported rows would derive `lineage: changed` for a source whose data
            // never moved — and #270's collapse guard would refuse a healthy capture on that basis.
            const before = proxyFronting({id: 'primary'}, {id: 'secondary-v1'}),
                  after  = proxyFronting({id: 'primary'}, {id: 'secondary-v2'});

            expect(await before.resolveCollectionId()).toBe(await after.resolveCollectionId());
        });

        test('the identity names the SAME handle `count()` and `get()` read', async () => {
            // Binds the two together, so a future change to either selection rule breaks this rather
            // than silently decoupling the rows from the id recorded beside them.
            const proxy = proxyFronting(
                {id: 'primary', count: async () => 42},
                {id: 'secondary', count: async () => 99}
            );

            expect(await proxy.count()).toBe(42);
            expect(await proxy.resolveCollectionId()).toBe('primary');
        });

        test('an unresolvable PRIMARY yields `null` rather than borrowing a secondary\'s identity', async () => {
            // Falling through to a later member would put a secondary's id beside the primary's rows —
            // the same not-what-it-accompanies defect, arriving through the failure path.
            const proxy = proxyFronting({}, {id: 'secondary'});

            expect(await proxy.resolveCollectionId()).toBeNull();
        });
    });
});

import {setup} from '../../../../../setup.mjs';

const appName = 'ChromaLifecycleServiceTest';

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

import {test, expect}         from '@playwright/test';
import Neo                    from 'neo.mjs/src/Neo.mjs';
import * as core              from 'neo.mjs/src/core/_export.mjs';
import ChromaLifecycleService from '../../../../../../../ai/services/memory-core/lifecycle/ChromaLifecycleService.mjs';

/**
 * @summary Coverage for the collapsed ChromaLifecycleService readiness gate (unified topology).
 *
 * The managed-mode surface (`startDatabase` / `stopDatabase` / `waitForHeartbeat` / `manageDatabase`)
 * was removed once the orchestrator became the sole Chroma driver; the service is now a readiness +
 * observability gate. These tests pin the kept surface.
 */
test.describe('Neo.ai.services.memory-core.lifecycle.ChromaLifecycleService — unified-topology readiness gate', () => {
    test('initAsync completes without error', async () => {
        await ChromaLifecycleService.initAsync();
        // Unified topology: no daemon spawn — initAsync only logs and resolves.
        expect(true).toBe(true);
    });

    test('getDatabaseStatus reports external-only state', () => {
        expect(ChromaLifecycleService.getDatabaseStatus()).toEqual({running: false});
    });
});

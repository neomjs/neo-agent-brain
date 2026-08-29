import {test, expect}       from '@playwright/test';
import Neo                  from 'neo.mjs/src/Neo.mjs';
import * as core            from 'neo.mjs/src/core/_export.mjs';
import {createRemDigestion} from '../../../../../src/evolution/createRemDigestion.mjs';
import AiConfig             from '../../../../../ai/config.template.mjs';
import MemoryConfig         from '../../../../../ai/mcp/server/memory-core/config.template.mjs';
import EvolutionConfig      from '../../../../../src/evolution/config.template.mjs';
import EvolutionConfigBase  from '../../../../../src/evolution/configBase.mjs';

function createProfile(tick) {
    const
        summaryCollection = {profile: tick},
        storageRouter     = {
            ready               : async () => {},
            getSummaryCollection: async () => summaryCollection
        },
        lifecycleService = {ready: async () => {}};

    return {
        summaryCollection,
        collaborators: {
            storageRouter,
            lifecycleService,
            graphService                 : {},
            logger                       : {debug() {}, error() {}, info() {}, warn() {}},
            adrIngestor                  : {},
            conceptIngestor              : {},
            fileSystemIngestor           : {},
            gapInferenceEngine           : {},
            graphMaintenanceService      : {},
            memorySessionIngestor        : {},
            semanticGraphExtractor       : {},
            topologyInferenceEngine      : {},
            providerReadiness            : {},
            appendRemRunStateFn          : async () => {},
            readCorpusProjectionReceiptFn: async () => null,
            nowFn                        : () => tick
        }
    };
}

test.describe('createRemDigestion', () => {
    test('Evolution owns REM policy while shared provider and run-state leaves resolve from Tier 1', () => {
        expect(EvolutionConfig.getOwnerOfDataProperty('remSleepBatchLimit').owner.className)
            .toBe('Neo.brain.evolution.Config');
        expect(EvolutionConfig.getOwnerOfDataProperty('remRunStateDir').owner.className)
            .toBe('Neo.ai.Config');
        expect(EvolutionConfig.graphProvider).toBe(AiConfig.graphProvider);
        expect(EvolutionConfig.remRunStateDir).toBe(AiConfig.remRunStateDir);
        expect(MemoryConfig.getOwnerOfDataProperty('remSleepBatchLimit')).toBeNull();
    });

    test('Evolution retention keeps its default and env binding on a fresh provider', () => {
        const previous = process.env.NEO_REM_RUN_RETENTION_LIMIT;
        process.env.NEO_REM_RUN_RETENTION_LIMIT = '50';

        const freshConfig = Neo.create(EvolutionConfigBase);

        try {
            expect(EvolutionConfig.remRunRetentionLimit).toBe(200);
            expect(freshConfig.data.remRunRetentionLimit).toBe(50);
        } finally {
            freshConfig.destroy();
            if (previous === undefined) {
                delete process.env.NEO_REM_RUN_RETENTION_LIMIT;
            } else {
                process.env.NEO_REM_RUN_RETENTION_LIMIT = previous;
            }
        }
    });

    test('constructs independent execution profiles from the same Evolution use-case class', async () => {
        const hostProfile  = createProfile(101);
        const cloudProfile = createProfile(202);
        const host         = createRemDigestion(hostProfile.collaborators);
        const cloud        = createRemDigestion(cloudProfile.collaborators);

        await Promise.all([host.ready(), cloud.ready()]);

        expect(host).not.toBe(cloud);
        expect(host.constructor).toBe(cloud.constructor);
        expect(host.sessionsCollection).toStrictEqual(hostProfile.summaryCollection);
        expect(cloud.sessionsCollection).toStrictEqual(cloudProfile.summaryCollection);
        expect(host.nowFn()).toBe(101);
        expect(cloud.nowFn()).toBe(202);
        expect(host.storageRouter.getSummaryCollection).toBe(hostProfile.collaborators.storageRouter.getSummaryCollection);
        expect(cloud.storageRouter.getSummaryCollection).toBe(cloudProfile.collaborators.storageRouter.getSummaryCollection);
    });
});

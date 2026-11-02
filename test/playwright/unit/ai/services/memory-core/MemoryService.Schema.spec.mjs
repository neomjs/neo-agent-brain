import { setup } from '../../../../setup.mjs';

const appName = 'MemoryServiceSchemaTest';

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

import {test, expect}                              from '@playwright/test';
import Neo                                         from 'neo.mjs/src/Neo.mjs';
import * as core                                   from 'neo.mjs/src/core/_export.mjs';
import {IDENTITIES, TRUST_TIERS, TRUST_TIER_ORDER} from '../../../../../../ai/graph/identityRoots.mjs';
import MemoryService                               from '../../../../../../ai/services/memory-core/MemoryService.mjs';
import StorageRouter                               from '../../../../../../ai/services/memory-core/managers/StorageRouter.mjs';
import RequestContextService                       from '../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';
import {drainMemoryWal}                            from './util.mjs';

/**
 * Validates the AGENT_MEMORY graph node payload structure to prevent hollow-success regressions
 * in heartbeat unread-count and sunset-detection logic.
 */
test.describe('MemoryService — AGENT_MEMORY Schema (#10620)', () => {
    let spyCollection;
    let originalGetMemoryCollection;
    let originalUpsertNode;
    let originalLinkNodes;
    let collectionAddCalls = [];
    let linkNodesCalls     = [];
    let upsertNodeCalls    = [];

    let GraphService;

    test.beforeAll(async () => {
        GraphService = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
    });

    test.beforeEach(() => {
        // Never INHERIT a pending projection from a previous spec file in this worker. The spies
        // installed below are what a late timer would land on, so the clear has to happen BEFORE
        // them or the foreign nodes are already counted. Producer-side cancellation is the other
        // half; this half also defends against producers nobody has named yet.
        MemoryService._clearGraphProjectionTimers();

        collectionAddCalls = [];
        linkNodesCalls     = [];
        upsertNodeCalls = [];
        spyCollection = {
            async add(payload) {
                collectionAddCalls.push(payload);
            }
        };
        originalGetMemoryCollection = StorageRouter.getMemoryCollection;
        StorageRouter.getMemoryCollection = async () => spyCollection;

        originalUpsertNode = GraphService.upsertNode;
        originalLinkNodes  = GraphService.linkNodes;

        GraphService.upsertNode = (node) => {
            upsertNodeCalls.push(node);
        };
        GraphService.linkNodes = (...args) => {
            linkNodesCalls.push(args);
        };
    });

    test.afterEach(() => {
        StorageRouter.getMemoryCollection = originalGetMemoryCollection;
        GraphService.upsertNode           = originalUpsertNode;
        GraphService.linkNodes            = originalLinkNodes;
    });

    const flushGraphProjection = () => new Promise(resolve => setTimeout(resolve, 10));

    test('addMemory canonicalizes profile-string agent to node-id graph identity', async () => {
        await MemoryService.addMemory({
            agent    : 'neo-gemini-julia',
            sessionId: 'session-xyz',
            prompt   : 'hello',
            thought  : 'thinking',
            response : 'hi'
        });

        await flushGraphProjection();

        expect(upsertNodeCalls).toHaveLength(1);
        const node = upsertNodeCalls[0];

        expect(node.type).toBe('AGENT_MEMORY');

        // Ensure the structured properties are present and correctly named
        expect(node.properties).toBeDefined();
        // Profile string 'neo-gemini-julia' should be canonicalized to '@neo-gemini-julia'
        expect(node.properties.agentIdentity).toBe('@neo-gemini-julia');
        expect(node.properties.sessionId).toBe('session-xyz');
        expect(typeof node.properties.timestamp).toBe('string');
    });

    test('addMemory preserves canonical node-id graph identity', async () => {
        await MemoryService.addMemory({
            agent    : '@neo-gemini-julia',
            sessionId: 'session-xyz',
            prompt   : 'hello',
            thought  : 'thinking',
            response : 'hi'
        });

        await flushGraphProjection();

        expect(upsertNodeCalls).toHaveLength(1);
        const node = upsertNodeCalls[0];

        expect(node.type).toBe('AGENT_MEMORY');
        expect(node.properties.agentIdentity).toBe('@neo-gemini-julia');
    });

    test('identity roots expose the 8-tier trust taxonomy required by #10292', () => {
        expect(TRUST_TIER_ORDER).toEqual([
            'system',
            'repo-trusted',
            'owner',
            'self',
            'peer-trusted',
            'internal-authored',
            'external',
            'unclassified'
        ]);

        const values = new Set(Object.values(TRUST_TIERS));
        for (const identity of IDENTITIES) {
            expect(values.has(identity.properties.trustTier)).toBe(true);
        }

        expect(IDENTITIES.find(identity => identity.id === '@tobiu').properties.trustTier).toBe(TRUST_TIERS.OWNER);
        expect(IDENTITIES.find(identity => identity.id === '@system').properties.trustTier).toBe(TRUST_TIERS.SYSTEM);
        expect(IDENTITIES.find(identity => identity.id === '@neo-gpt-euclid').properties.trustTier).toBe(TRUST_TIERS.PEER_TRUSTED);
        expect(IDENTITIES.find(identity => identity.id === '@neo-opus-ada').properties.trustTier).toBe(TRUST_TIERS.PEER_TRUSTED);
        expect(IDENTITIES.find(identity => identity.id === 'AGENT:*').properties.trustTier).toBe(TRUST_TIERS.UNCLASSIFIED);
    });

    test('addMemory stamps request-bound AgentIdentity into Chroma metadata and AUTHORED_BY edge', async () => {
        const result = await RequestContextService.run({
            userId             : 'neo-gpt-euclid',
            username           : 'neo-gpt-euclid',
            agentIdentityNodeId: '@neo-gpt-euclid',
            source             : 'env-var'
        }, () => MemoryService.addMemory({
            sessionId: 'session-abc',
            prompt   : 'hello',
            thought  : 'thinking',
            response : 'hi'
        }));

        // addMemory leaves the record WAL-pending — flush it through the daemon drain path.
        await drainMemoryWal({ids: [result.id]});
        await flushGraphProjection();

        expect(collectionAddCalls).toHaveLength(1);
        expect(collectionAddCalls[0].metadatas[0].userId).toBe('neo-gpt-euclid');
        expect(collectionAddCalls[0].metadatas[0].agentIdentity).toBe('@neo-gpt-euclid');

        expect(upsertNodeCalls).toHaveLength(1);
        expect(upsertNodeCalls[0].properties.agentIdentity).toBe('@neo-gpt-euclid');

        const authoredBy = linkNodesCalls.find(([, , relationship]) => relationship === 'AUTHORED_BY');
        expect(authoredBy).toBeDefined();
        expect(authoredBy[0]).toBe(result.id);
        expect(authoredBy[1]).toBe('@neo-gpt-euclid');
        expect(authoredBy[3]).toBe(1.0);
        expect(authoredBy[4]).toMatchObject({
            userId      : 'neo-gpt-euclid',
            sharedEntity: true
        });

        const spawned = linkNodesCalls.find(([, , relationship]) => relationship === 'SPAWNED_MEMORY');
        expect(spawned).toBeDefined();
    });

    test('addMemory preserves unresolved-identity fallthrough without hallucinating AUTHORED_BY edges', async () => {
        const result = await RequestContextService.run({
            userId             : 'external-contributor',
            username           : 'External Contributor',
            agentIdentityNodeId: null,
            source             : 'unresolved'
        }, () => MemoryService.addMemory({
            sessionId: 'session-unbound',
            prompt   : 'hello',
            thought  : 'thinking',
            response : 'hi'
        }));

        // addMemory leaves the record WAL-pending — flush it through the daemon drain path.
        await drainMemoryWal({ids: [result.id]});

        expect(collectionAddCalls).toHaveLength(1);
        expect(collectionAddCalls[0].metadatas[0].userId).toBe('external-contributor');
        expect(collectionAddCalls[0].metadatas[0].agentIdentity).toBe('@external-contributor');

        expect(linkNodesCalls.some(([, , relationship]) => relationship === 'AUTHORED_BY')).toBe(false);
        expect(linkNodesCalls.some(([, , relationship]) => relationship === 'SPAWNED_MEMORY')).toBe(true);
    });

    test('resolveMemoryTrustTier resolves canonical roster ids and all formerLogins aliases to their owning trust tier (#1279)', () => {
        expect(MemoryService.constructor.resolveMemoryTrustTier({agentIdentity: '@neo-gemini-julia'})).toBe(TRUST_TIERS.PEER_TRUSTED);
        expect(MemoryService.constructor.resolveMemoryTrustTier({agentIdentity: '@neo-gemini-maryam'})).toBe(TRUST_TIERS.PEER_TRUSTED);

        for (const formerLogin of [
            '@neo-gemini-pro',
            'neo-gemini-pro',
            '@neo-gemini-3-1-pro',
            '@neo-fable',
            'neo-fable',
            '@neo-gpt',
            'neo-gpt',
            '@neo-opus-4-7',
            '@neo-claude-opus'
        ]) {
            expect(
                MemoryService.constructor.resolveMemoryTrustTier({agentIdentity: formerLogin}),
                `formerLogin ${formerLogin}`
            ).toBe(TRUST_TIERS.PEER_TRUSTED);
        }
    });

    test('resolveMemoryTrustTier resolves auto-provisioned AgentIdentity graph nodes from GraphService (#1279)', () => {
        const
            originalDb            = GraphService.db,
            originalGetNodeRecord = GraphService.getNodeRecord;

        try {
            GraphService.db = {nodes: new Map()};
            GraphService.getNodeRecord = ({id}) => {
                if (id === '@auto-provisioned-seat') {
                    return {
                        id        : '@auto-provisioned-seat',
                        type      : 'AgentIdentity',
                        properties: {
                            trustTier: TRUST_TIERS.INTERNAL_AUTHORED
                        }
                    };
                }
                return null;
            };

            expect(MemoryService.constructor.resolveMemoryTrustTier({agentIdentity: '@auto-provisioned-seat'})).toBe(TRUST_TIERS.INTERNAL_AUTHORED);
            expect(MemoryService.constructor.resolveMemoryTrustTier({agentIdentity: 'auto-provisioned-seat'})).toBe(TRUST_TIERS.INTERNAL_AUTHORED);
            expect(MemoryService.constructor.resolveMemoryTrustTier({agentIdentity: '@unknown-unprovisioned'})).toBe(TRUST_TIERS.UNCLASSIFIED);
        } finally {
            GraphService.db            = originalDb;
            GraphService.getNodeRecord = originalGetNodeRecord;
        }
    });
});

import {test, expect} from '@playwright/test';

import {
    createGraphBootSeedEdgeRecord,
    createGraphBootSeedManifest,
    createGraphBootSeedNodeRecord,
    evaluateGraphBootSeedFreshness,
    getGraphBootSeedNodeSpec,
    GRAPH_BOOT_SEED_VERSION
} from '../../../../../ai/graph/bootSeedManifest.mjs';
import {IDENTITIES}                        from '../../../../../ai/graph/identityRoots.mjs';
import {BROADCAST_SENTINEL, SYSTEM_SENDER} from '../../../../../ai/graph/mailboxRoots.mjs';

test.describe('graph boot-seed manifest', () => {
    test('enumerates the two anchors, the two mailbox roots, no team identity, and one system edge', () => {
        const manifest = createGraphBootSeedManifest();

        expect(manifest.version).toBe(GRAPH_BOOT_SEED_VERSION);
        expect(manifest.nodes.map(node => node.id)).toEqual([
            'frontier',
            'Neo-Master-Architecture',
            '@system',
            'AGENT:*'
        ]);
        // every plane boots with these records, so none of them may be a team member
        expect(manifest.nodes.filter(node => node.type === 'AgentIdentity')).toEqual([]);
        expect(manifest.edges).toEqual([expect.objectContaining({
            source: 'frontier',
            target: 'Neo-Master-Architecture',
            type  : 'SYSTEM_TENET',
            weight: 1
        })]);
        expect(manifest.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    test('the manifest and the roster take the mailbox roots from one declaration', () => {
        const nodes = createGraphBootSeedManifest().nodes;

        for (const root of [SYSTEM_SENDER, BROADCAST_SENTINEL]) {
            expect(nodes.find(node => node.id === root.id)).toEqual(root);
            // the same object, never a copy that the setup seed could write over what boot wrote
            expect(IDENTITIES).toContain(root);
        }
    });

    test('getGraphBootSeedNodeSpec returns a DETACHED clone of a fixed seed, and throws on an unknown id', () => {
        const spec = getGraphBootSeedNodeSpec('frontier');

        expect(spec.id).toBe('frontier');
        expect(spec.type).toBe('SYSTEM_ANCHOR');
        expect(spec.description).toBe('The shifting focal point of the active Neo OS agent session.');

        // DETACHED: a consumer mutating what it received must not corrupt the module's own manifest.
        // This is load-bearing — the manifest is the completeness predicate for fresh-target recovery,
        // so a shared reference would let one caller silently invalidate everyone else's.
        spec.description = 'mutated by a consumer';
        spec.id          = 'clobbered';

        expect(getGraphBootSeedNodeSpec('frontier').description).toBe('The shifting focal point of the active Neo OS agent session.');
        expect(createGraphBootSeedManifest().nodes.find(node => node.id === 'frontier').description)
            .toBe('The shifting focal point of the active Neo OS agent session.');

        // Unknown ids fail LOUD. A silent miss would invite a hand-written local spec back, which is
        // the drift this accessor exists to prevent; the error names the known ids.
        expect(() => getGraphBootSeedNodeSpec('not-a-boot-seed')).toThrow(/not a fixed boot-seed node/);
        expect(() => getGraphBootSeedNodeSpec('not-a-boot-seed')).toThrow(/frontier/);

        // A team identity is no boot seed; the mailbox roots are.
        expect(() => getGraphBootSeedNodeSpec('@neo-opus-ada')).toThrow(/not a fixed boot-seed node/);
        expect(getGraphBootSeedNodeSpec('AGENT:*').type).toBe('BroadcastSentinel')
    });

    test('accepts only the complete exact persisted seed record set', () => {
        const
            manifest = createGraphBootSeedManifest(),
            nodes    = manifest.nodes.map(createGraphBootSeedNodeRecord),
            edges    = manifest.edges.map((edge, index) => ({
                id: `storage-minted-${index}`,
                ...createGraphBootSeedEdgeRecord(edge)
            }));

        expect(evaluateGraphBootSeedFreshness({nodes, edges, manifest})).toMatchObject({
            fresh    : true,
            reason   : null,
            nodeCount: nodes.length,
            edgeCount: 1
        });
    });

    test('rejects extra, missing, or altered records and ignores only the random edge id', () => {
        const
            manifest = createGraphBootSeedManifest(),
            nodes    = manifest.nodes.map(createGraphBootSeedNodeRecord),
            edge     = createGraphBootSeedEdgeRecord(manifest.edges[0]);

        const extraNode = [...nodes, {
            id        : 'unexpected',
            label     : 'NODE',
            properties: {name: 'unexpected', description: '', userId: null}
        }];
        expect(evaluateGraphBootSeedFreshness({nodes: extraNode, edges: [edge], manifest}).fresh).toBe(false);

        expect(evaluateGraphBootSeedFreshness({nodes: nodes.slice(1), edges: [edge], manifest}).fresh).toBe(false);

        const alteredNodes = structuredClone(nodes);
        alteredNodes[0].properties.description = 'altered';
        expect(evaluateGraphBootSeedFreshness({nodes: alteredNodes, edges: [edge], manifest}).fresh).toBe(false);

        expect(evaluateGraphBootSeedFreshness({
            nodes,
            edges: [{id: 'any-id', ...edge, properties: {...edge.properties, weight: 1.1}}],
            manifest
        }).fresh).toBe(false);
    });
});

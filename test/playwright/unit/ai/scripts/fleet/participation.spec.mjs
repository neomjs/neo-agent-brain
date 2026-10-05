import {setup} from '../../../../setup.mjs'

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : 'ParticipationCliTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
})

import {test, expect}  from '@playwright/test'
import {spawnSync}     from 'node:child_process'
import os              from 'node:os'
import path            from 'node:path'
import {fileURLToPath} from 'node:url'

import {parseArgs, runCli, validateArgs} from '../../../../../../ai/scripts/fleet/participation.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..'),
      actor    = `os-user:${os.userInfo().username}`;

/**
 * GraphService double with the two surfaces the write touches: `getNodeRecord` answers `{id, type,
 * properties}`, and `upsertGlobalNode` layers the payload over the stored bag, as the real upsert does.
 * @param {Object} nodes Map of node id to `{type, properties}`.
 * @returns {Object} The double, with `writes` recording every upsert.
 */
function graphDouble(nodes = {}) {
    const writes = [];

    return {
        nodes,
        writes,
        getNodeRecord   : ({id}) => nodes[id] ? {id, type: nodes[id].type, properties: {...nodes[id].properties}} : null,
        upsertGlobalNode: ({id, type, properties}) => {
            writes.push({id, type, properties});
            nodes[id] = {type: nodes[id]?.type ?? type, properties: {...nodes[id]?.properties, ...properties, userId: null}}
        }
    }
}

const run = (graphService, ...argv) => runCli({args: parseArgs(argv), graphService});

test.describe('participation — the plane-host path for an identity\'s participation (#883)', () => {
    let graph;

    test.beforeEach(() => {
        graph = graphDouble({
            '@neo-kimi-iris': {type: 'AgentIdentity', properties: {participationStatus: 'active', reactivationTrigger: 'seed trigger'}},
            'AGENT:*'       : {type: 'BroadcastSentinel', properties: {}}
        })
    });

    test('bench records the decision; activate returns the identity with the reason cleared', () => {
        expect(run(graph, 'bench', '--identity', 'neo-kimi-iris', '--reason', ' the flatrate ended ', '--apply')).toMatchObject({ok: true, applied: true, identity: '@neo-kimi-iris'});
        expect(graph.nodes['@neo-kimi-iris'].properties).toMatchObject({
            participationStatus   : 'operator_benched',
            statusReason          : 'the flatrate ended',
            reactivationTrigger   : null,
            participationDecidedBy: actor
        });
        expect(Date.parse(graph.nodes['@neo-kimi-iris'].properties.since)).not.toBeNaN();

        expect(run(graph, 'activate', '--identity', '@neo-kimi-iris', '--apply')).toMatchObject({ok: true, applied: true});
        expect(graph.nodes['@neo-kimi-iris'].properties).toMatchObject({participationStatus: 'active', statusReason: null, participationDecidedBy: actor});
        expect(graph.writes).toHaveLength(2)
    });

    test('without --apply nothing is written, and re-recording a decision keeps its date', () => {
        expect(run(graph, 'bench', '--identity', '@neo-kimi-iris', '--reason', 'the flatrate ended')).toMatchObject({
            ok: true, applied: false, before: {participationStatus: 'active'}, after: {participationStatus: 'operator_benched'}
        });
        expect(graph.writes).toHaveLength(0);

        run(graph, 'bench', '--identity', '@neo-kimi-iris', '--reason', 'the flatrate ended', '--apply');
        const since = graph.nodes['@neo-kimi-iris'].properties.since;

        expect(run(graph, 'bench', '--identity', '@neo-kimi-iris', '--reason', 'the flatrate ended', '--apply')).toMatchObject({applied: false, unchanged: true});
        expect(graph.nodes['@neo-kimi-iris'].properties.since).toBe(since);
        expect(graph.writes).toHaveLength(1)
    });

    test('show answers the node\'s participation fields', () => {
        expect(run(graph, 'show', '--identity', '@neo-kimi-iris')).toEqual({
            ok: true, identity: '@neo-kimi-iris', participationStatus: 'active', statusReason: null, since: null,
            reactivationTrigger: 'seed trigger', participationDecidedBy: null
        })
    });

    test('an unknown id, a node that is not an identity, and a bench without a reason are refused', () => {
        expect(run(graph, 'bench', '--identity', '@nobody', '--reason', 'r', '--apply')).toMatchObject({ok: false, refused: 'unknown-identity'});
        expect(run(graph, 'activate', '--identity', 'AGENT:*', '--apply')).toMatchObject({ok: false, refused: 'not-an-identity'});
        expect(runCli({args: {...parseArgs(['bench', '--identity', '@neo-kimi-iris', '--apply']), reason: '  '}, graphService: graph})).toMatchObject({ok: false, refused: 'no-reason'});
        expect(graph.writes).toHaveLength(0);

        expect(validateArgs(parseArgs(['bench', '--identity', '@neo-kimi-iris']))).toEqual(['bench needs --reason.']);
        expect(validateArgs(parseArgs(['activate']))).toEqual(['--identity is required.']);
        expect(validateArgs(parseArgs(['unbench', '--identity', '@neo-kimi-iris']))[0]).toContain('the command must be one of')
    });

    test('the entrypoint refuses an invalid invocation before it opens a graph', () => {
        const result = spawnSync(process.execPath, ['ai/scripts/fleet/participation.mjs', 'bench', '--identity', '@neo-kimi-iris'], {
            cwd: repoRoot, encoding: 'utf-8', timeout: 30_000
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('bench needs --reason')
    })
});

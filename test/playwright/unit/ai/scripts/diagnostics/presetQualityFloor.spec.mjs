import {expect, test}            from '@playwright/test';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os                        from 'node:os';
import path                      from 'node:path';
import {fileURLToPath}           from 'node:url';
import {
    DEFAULT_DOCUMENTS_DIR,
    INSTRUMENT,
    isTriVectorShape,
    listDocuments,
    main,
    mapPresetEnv,
    measurePayload,
    measurePreset,
    meetsFloor,
    referenceFloor,
    resolveProviderHost,
    summarizeRuns
} from '../../../../../../ai/scripts/diagnostics/presetQualityFloor.mjs';
import {PLANE_PROFILE, presets, profileInputs} from '../../../../../../ai/services/fleet/placementPresets.mjs';

// The instrument's pure helpers over fixture payloads, and the CLI over a fake child: no model, no
// request, no plane. The real run is a recorded receipt on the ticket, never a spec.

const
    here      = path.dirname(fileURLToPath(import.meta.url)),
    brainRoot = path.resolve(here, '../../../../../..'),
    byId      = id => presets.find(row => row.id === id),
    DOCUMENT  = 'The dock Workspace header actions move to a HeaderActions plugin beside plugin/Maximize.mjs; the ratchet reports the façade over-target.';

/** A payload in the extractor's schema; `nodes` / `edges` override the defaults. */
function payload({nodes, edges} = {}) {
    return {
        a2a_version     : '1.0',
        agent_id        : 'Antigravity_Primary',
        session_artifact: {
            feature_namespace     : 'Neo.dashboard.dock.Workspace',
            human_readable_summary: 'The header actions leave the façade for a plugin.',
            roadmap_impact        : null,
            graph                 : {
                nodes: nodes ?? [
                    {id: 'CLASS:HeaderActions', type: 'CLASS', name: 'HeaderActions', description: 'the plugin', logical_layer: 'UI', stability: 'STABLE'},
                    {id: 'CLASS:Workspace',     type: 'CLASS', name: 'Workspace',     description: 'the façade', logical_layer: 'UI', stability: 'STABLE'},
                    {id: 'FILE:plugin/Maximize.mjs', type: 'FILE', name: 'plugin/Maximize.mjs', description: 'the sibling', logical_layer: 'UI', stability: 'STABLE'},
                    {id: 'CONCEPT:ratchet', type: 'CONCEPT', name: 'ratchet', description: 'the size gate', logical_layer: 'Build', stability: 'STABLE'}
                ],
                edges: edges ?? [
                    {source: 'CLASS:HeaderActions', target: 'CLASS:Workspace', relationship: 'EXTENDS'},
                    {source: 'CLASS:HeaderActions', target: 'memory:abc-123', relationship: 'MENTIONED_IN'},
                    {source: 'CONCEPT:ratchet', target: 'frontier', relationship: 'RELATES_TO'}
                ]
            }
        }
    };
}

/** A fake child: one JSON line per spawn, recording the env it was given. */
function fakeExec(reply, calls = []) {
    return async (file, args, options) => {
        calls.push({file, args, env: options.env});

        const value = typeof reply === 'function' ? reply(options.env) : reply;

        return {stdout: `[SemanticGraphExtractor] noise the parent must skip\n${JSON.stringify(value)}\n`, stderr: ''};
    };
}

async function scratchDocuments(count = 3) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'preset-floor-docs-'));

    for (let index = 0; index < count; index++) {
        await writeFile(path.join(dir, `0${index + 1}-thread.md`), `# thread ${index + 1}\n\n${DOCUMENT}\n`);
    }
    await writeFile(path.join(dir, 'notes.json'), '{}');

    return dir;
}

test.describe('presetQualityFloor', () => {
    test('a preset\'s env lands on the leaf names the profile reads; the declared Docker host is read as loopback on the host unless overridden', async () => {
        const
            profile = profileInputs(await Promise.all(PLANE_PROFILE.composeFiles.map(file => readFile(path.join(brainRoot, file), 'utf8')))),
            local   = mapPresetEnv(byId('local-small'), profile),
            hosted  = mapPresetEnv(byId('hosted'), profile);

        expect(local).toMatchObject({
            NEO_GRAPH_PROVIDER                  : 'openAiCompatible',
            NEO_OPENAI_COMPATIBLE_HOST          : 'http://host.docker.internal:1234',
            NEO_OPENAI_COMPATIBLE_MODEL         : 'google/gemma-4-26b-a4b',
            NEO_OPENAI_COMPATIBLE_EMBEDDING_MODEL: 'text-embedding-qwen3-embedding-0.6b',
            NEO_VECTOR_DIMENSION                : '1024'
        });
        expect(Object.keys(local).some(key => key.startsWith('NEO_LOCAL_AGENT_OS_'))).toBe(false);
        expect(hosted.NEO_GRAPH_PROVIDER).toBe('gemini');

        expect(resolveProviderHost('http://host.docker.internal:1234')).toEqual({declared: 'http://host.docker.internal:1234', used: 'http://127.0.0.1:1234'});
        expect(resolveProviderHost('http://host.docker.internal:1234', 'http://lms.local:1234').used).toBe('http://lms.local:1234');
        expect(resolveProviderHost(undefined)).toEqual({declared: null, used: null});
    });

    test('a payload is measured against its document: schema shape, dangling endpoints (sinks excepted), grounded names', () => {
        const clean = measurePayload(payload(), DOCUMENT);

        expect(clean).toEqual({
            schemaValid: true, nodes: 4, edges: 3, danglingEdges: 0, groundedNodes: 4, ungroundedNames: [], labelledNodes: 0,
            extracted  : ['CLASS:HeaderActions', 'CLASS:Workspace', 'FILE:plugin/Maximize.mjs', 'CONCEPT:ratchet']
        });

        // a label-typed node names what the model produced, so it is neither grounded nor ungrounded; a
        // multi-word claim is grounded when every word of it occurs in the document
        const drift = measurePayload(payload({
            nodes: [
                ...payload().session_artifact.graph.nodes,
                {id: 'CLASS:Neo.dashboard.Main', type: 'CLASS', name: 'Neo.dashboard.Main', description: 'copied from the prompt example', logical_layer: 'UI', stability: 'STABLE'},
                {id: 'CONCEPT:HeaderActions plugin', type: 'CONCEPT', name: 'HeaderActions plugin', description: 'two words, both in the text', logical_layer: 'UI', stability: 'STABLE'},
                {id: 'SESSION:Dock Handler Refactoring Session', type: 'SESSION', name: 'Dock Handler Refactoring Session', description: 'the model\'s label', logical_layer: 'Unknown', stability: 'UNKNOWN'}
            ],
            edges: [
                ...payload().session_artifact.graph.edges,
                {source: 'CLASS:Workspace', target: 'CLASS:Missing', relationship: 'DEPENDS_ON'},
                {source: 'SESSION:abc', target: 'CLASS:Workspace', relationship: 'DISCUSSED_IN'}
            ]
        }), DOCUMENT);

        expect(drift).toMatchObject({schemaValid: true, nodes: 7, edges: 5, danglingEdges: 1, groundedNodes: 5, ungroundedNames: ['Neo.dashboard.Main'], labelledNodes: 1});

        expect(isTriVectorShape({a2a_version: '1.0', session_artifact: {graph: {nodes: [{id: 'x', type: 'CLASS', name: 'x'}], edges: []}}})).toBe(false);
        expect(measurePayload(null, DOCUMENT)).toEqual({schemaValid: false, nodes: 0, edges: 0, danglingEdges: 0, groundedNodes: 0, ungroundedNames: [], labelledNodes: 0, extracted: []});
    });

    test('runs fold into the table\'s shape, and the floor is the reference model\'s recorded result on the same fixtures — met at or above it on every axis, never without a reference', () => {
        const
            good      = {schemaValid: true, nodes: 5, edges: 4, danglingEdges: 0, groundedNodes: 5, ungroundedNames: []},
            thin      = {schemaValid: true, nodes: 3, edges: 2, danglingEdges: 1, groundedNodes: 2, ungroundedNames: ['Neo.dashboard.Main']},
            reference = referenceFloor(),
            met       = summarizeRuns([{document: 'a.md', measure: good}, {document: 'b.md', measure: {...good, groundedNodes: 4}}], {preset: 'local-small', chatModel: 'google/gemma-4-26b-a4b', measuredAt: '2026-10-02'});

        // the reference is the table's recorded gemma run, read from the presets module, never a number in the instrument
        expect(reference).toMatchObject({instrument: INSTRUMENT, chatModel: 'google/gemma-4-26b-a4b', result: {schemaValid: true}});
        expect(reference).toBe(byId('local-small').qualityFloor);

        expect(met).toMatchObject({
            preset    : 'local-small',
            instrument: INSTRUMENT,
            measuredAt: '2026-10-02',
            chatModel : 'google/gemma-4-26b-a4b',
            documents : ['a.md', 'b.md'],
            result    : {schemaValid: true, danglingEdges: 0, groundedNodesPerDocument: '4-5', ungroundedNames: 0},
            floor     : {met: true, reference}
        });
        expect(met.perDocument.map(row => row.document)).toEqual(['a.md', 'b.md']);

        const short = summarizeRuns([{document: 'a.md', measure: good}, {document: 'b.md', measure: thin}], {preset: 'local-small', chatModel: 'gpt-oss-20b', measuredAt: '2026-10-02'});

        expect(short.result).toEqual({schemaValid: true, danglingEdges: 1, groundedNodesPerDocument: '2-5', ungroundedNames: 1});
        expect(short.floor.met).toBe(false);
        expect(summarizeRuns([], {preset: 'local-small', chatModel: null, measuredAt: '2026-10-02'}).floor.met).toBe(false);

        // the reference's own result meets itself; one more dangling edge or one fewer grounded node does not
        expect(meetsFloor(reference.result, reference.result)).toBe(true);
        expect(meetsFloor({...reference.result, danglingEdges: reference.result.danglingEdges + 1}, reference.result)).toBe(false);
        expect(meetsFloor({...reference.result, groundedNodesPerDocument: '1'}, reference.result)).toBe(false);
        expect(meetsFloor(reference.result, null)).toBe(false);
    });

    test('the hosted preset is unmeasured before any child runs: its graph provider is outside the Tri-Vector dispatch', async () => {
        const
            calls  = [],
            result = await measurePreset({presetId: 'hosted', documentsDir: await scratchDocuments(), exec: fakeExec({}, calls)});

        expect(calls).toHaveLength(0);
        expect(result).toMatchObject({preset: 'hosted', instrument: INSTRUMENT, unmeasured: "graph provider 'gemini' is outside the Tri-Vector dispatch (ollama | openAiCompatible)"});
        expect(result.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('a local preset runs one child per document with the mapped env under unit-test mode, and folds the payloads; a child failure or a refused provider is unmeasured', async () => {
        const
            dir     = await scratchDocuments(),
            calls   = [],
            measured = await measurePreset({presetId: 'local-small', documentsDir: dir, providerHost: 'http://127.0.0.1:1234', exec: fakeExec({chatModel: 'google/gemma-4-26b-a4b', payload: payload(), failure: null}, calls)});

        expect(await listDocuments(dir)).toHaveLength(3);
        expect(calls).toHaveLength(3);
        expect(calls[0].file).toBe(process.execPath);
        expect(calls[0].args.slice(0, 2)).toEqual(['--input-type=module', '-e']);
        expect(calls[0].args[2]).toContain('executeTriVectorExtraction');
        expect(calls[0].env).toMatchObject({
            NEO_UNIT_TEST_MODE         : 'true',
            NEO_GRAPH_PROVIDER         : 'openAiCompatible',
            NEO_OPENAI_COMPATIBLE_HOST : 'http://127.0.0.1:1234',
            NEO_OPENAI_COMPATIBLE_MODEL: 'google/gemma-4-26b-a4b',
            NEO_PRESET_FLOOR_SESSION_ID: 'preset-quality-floor:local-small:01-thread.md'
        });
        expect(calls[0].env.NEO_PRESET_FLOOR_DOCUMENT).toBe(path.join(dir, '01-thread.md'));
        expect(measured).toMatchObject({
            preset      : 'local-small',
            chatModel   : 'google/gemma-4-26b-a4b',
            documents   : ['01-thread.md', '02-thread.md', '03-thread.md'],
            result      : {schemaValid: true, danglingEdges: 0, groundedNodesPerDocument: '4', ungroundedNames: 0},
            floor       : {met: true},
            providerHost: {declared: 'http://host.docker.internal:1234', used: 'http://127.0.0.1:1234'}
        });

        const failed = await measurePreset({presetId: 'local-small', documentsDir: dir, exec: fakeExec({chatModel: 'google/gemma-4-26b-a4b', payload: null, failure: {ok: false, deferReason: 'schema-failure', evidence: {errorMessage: 'fetch failed'}}})});

        expect(failed).toMatchObject({preset: 'local-small', chatModel: 'google/gemma-4-26b-a4b', unmeasured: 'the extraction of 01-thread.md returned no payload: fetch failed'});

        const refused = await measurePreset({presetId: 'local-small', documentsDir: dir, exec: fakeExec({unmeasured: "graph provider 'x' is outside the Tri-Vector dispatch (ollama | openAiCompatible)"})});

        expect(refused.unmeasured).toMatch(/outside the Tri-Vector dispatch/);

        await expect(measurePreset({presetId: 'nope', documentsDir: dir, exec: fakeExec({})})).rejects.toThrow(/--preset must be one of hosted \| local-small \| local-full/);
    });

    test('the CLI prints the measurement and exits 0 when measured, 2 when unmeasured; the shipped fixtures are three public engine threads', async () => {
        const
            dir     = await scratchDocuments(),
            written = [],
            stdout  = {write: text => { written.push(text); return true }},
            code    = await main(['node', 'presetQualityFloor', '--preset', 'local-small', '--documents', dir], {stdout, exec: fakeExec({chatModel: 'google/gemma-4-26b-a4b', payload: payload(), failure: null})}),
            printed = JSON.parse(written.join(''));

        expect(code).toBe(0);
        expect(printed.result).toEqual({schemaValid: true, danglingEdges: 0, groundedNodesPerDocument: '4', ungroundedNames: 0});

        const
            hostedOut = [],
            hosted    = await main(['node', 'presetQualityFloor', '--preset', 'hosted', '--documents', dir], {stdout: {write: text => { hostedOut.push(text); return true }}, exec: fakeExec({})});

        expect(hosted).toBe(2);
        expect(JSON.parse(hostedOut.join('')).unmeasured).toMatch(/outside the Tri-Vector dispatch/);

        const fixtures = await listDocuments(DEFAULT_DOCUMENTS_DIR);

        expect(fixtures.map(file => path.basename(file))).toEqual(['19339-dock-reveal-overlay-focus.md', '19354-dock-workspace-header-actions-plugin.md', '19356-grid-body-scroll-edge.md']);
        for (const file of fixtures) {
            const text = await readFile(file, 'utf8');

            expect(text).toMatch(/^# .+\n\nneomjs\/neo#\d+ · opened \d{4}-\d{2}-\d{2} by @\S+ · a public engine thread/);
            expect(text.length).toBeGreaterThan(4000);
            expect(text.length).toBeLessThan(11000);
        }
    });
});

import {expect, test}            from '@playwright/test';
import {execFile}                from 'node:child_process';
import {access, mkdtemp, readFile, readdir, writeFile} from 'node:fs/promises';
import http                      from 'node:http';
import os                        from 'node:os';
import path                      from 'node:path';
import {fileURLToPath}           from 'node:url';
import {promisify}               from 'node:util';
import {
    DEFAULT_DOCUMENTS_DIR,
    INSTRUMENT,
    documentsDigest,
    isTriVectorShape,
    isolatedUnder,
    isolationEnv,
    listDocuments,
    main,
    mapPresetEnv,
    measurePayload,
    measurePreset,
    meetsFloor,
    referenceFloor,
    resolveProviderHost,
    runChildExtraction,
    summarizeRuns
} from '../../../../../../ai/scripts/diagnostics/presetQualityFloor.mjs';
import {PLANE_PROFILE, presets, profileInputs} from '../../../../../../ai/services/fleet/placementPresets.mjs';

// The instrument's pure helpers over fixture payloads, and the CLI over a fake child: no model, no
// request, no plane. The real run is a recorded receipt on the ticket, never a spec.

const
    here      = path.dirname(fileURLToPath(import.meta.url)),
    brainRoot = path.resolve(here, '../../../../../..'),
    byId      = id => presets.find(row => row.id === id),
    GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai',
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

/**
 * A fake child: one JSON line per spawn, recording the env and cwd it was given; it reports the
 * isolation the env asked for, as the real child does (the real child's report is the witness arm).
 */
function fakeExec(reply, calls = []) {
    return async (file, args, options) => {
        calls.push({file, args, env: options.env, cwd: options.cwd});

        const
            env       = options.env,
            isolation = {graph: ':memory:', remRunStateDir: env.NEO_REM_RUN_STATE_DIR, dataRoot: env.NEO_PLANE_DATA_ROOT},
            value     = typeof reply === 'function' ? reply(env) : reply;

        return {stdout: `[SemanticGraphExtractor] noise the parent must skip\n${JSON.stringify({isolation, ...value})}\n`, stderr: ''};
    };
}

/** Three documents of one text, plus a file the instrument must skip — a set the recorded floor was not measured on. */
async function scratchDocuments(count = 3) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'preset-floor-docs-'));

    for (let index = 0; index < count; index++) {
        await writeFile(path.join(dir, `0${index + 1}-thread.md`), `# thread ${index + 1}\n\n${DOCUMENT}\n`);
    }
    await writeFile(path.join(dir, 'notes.json'), '{}');

    return dir;
}

const execFileAsync = promisify(execFile);

/** A fake OpenAI-compatible endpoint answering every chat completion with one payload; records the requests. */
async function fakeProviderServer(reply) {
    const
        requests = [],
        server   = http.createServer((req, res) => {
            let body = '';

            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                requests.push({url: req.url, body: JSON.parse(body)});
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({choices: [{message: {content: JSON.stringify(reply)}, finish_reason: 'stop'}], usage: {prompt_tokens: 10, completion_tokens: 10}}));
            });
        });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    return {requests, host: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve))};
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
        // the hosted preset's graph lane is Gemini's OpenAI-compatible endpoint, mapped through the same inputs
        expect(hosted).toEqual({
            NEO_MODEL_PROVIDER                          : 'gemini',
            NEO_GRAPH_PROVIDER                          : 'openAiCompatible',
            NEO_EMBEDDING_PROVIDER                      : 'gemini',
            NEO_GEMINI_MODEL                            : 'gemini-3.8-flash',
            NEO_GEMINI_EMBEDDING_MODEL                  : 'gemini-embedding-001',
            NEO_OPENAI_COMPATIBLE_HOST                  : GEMINI_ENDPOINT,
            NEO_OPENAI_COMPATIBLE_MODEL                 : 'gemini-3.8-flash',
            NEO_LOCAL_MODELS_CHAT_GRAPH_REASONING_EFFORT: 'low',
            NEO_VECTOR_DIMENSION                        : '3072'
        });

        expect(resolveProviderHost('http://host.docker.internal:1234')).toEqual({declared: 'http://host.docker.internal:1234', used: 'http://127.0.0.1:1234'});
        expect(resolveProviderHost('http://host.docker.internal:1234', 'http://lms.local:1234').used).toBe('http://lms.local:1234');
        // a hosted endpoint is used as declared
        expect(resolveProviderHost(GEMINI_ENDPOINT)).toEqual({declared: GEMINI_ENDPOINT, used: GEMINI_ENDPOINT});
        expect(resolveProviderHost(undefined)).toEqual({declared: null, used: null});
    });

    test('a payload is measured against its document: schema shape, dangling endpoints (sinks excepted), grounded names', () => {
        const clean = measurePayload(payload(), DOCUMENT);

        expect(clean).toEqual({
            schemaValid: true, nodes: 4, edges: 3, danglingEdges: 0, groundedNodes: 4, ungroundedNames: [], labelledNodes: 0,
            extracted  : ['CLASS:HeaderActions', 'CLASS:Workspace', 'FILE:plugin/Maximize.mjs', 'CONCEPT:ratchet']
        });

        // a label-typed node names what the model produced, so it is neither grounded nor ungrounded; a
        // multi-word claim is grounded when every word of it occurs in the document; a canonical Neo path is
        // grounded by its identity (the document says "Workspace", never "Neo.dashboard.dock.Workspace", and
        // neither "neo" nor "dashboard" occurs in it) and invented when the identity is absent ("Main"); an
        // identity under the three-letter floor keeps the full path ("X" occurs in "Maximize", the path does not)
        const drift = measurePayload(payload({
            nodes: [
                ...payload().session_artifact.graph.nodes,
                {id: 'CLASS:Neo.dashboard.Main', type: 'CLASS', name: 'Neo.dashboard.Main', description: 'copied from the prompt example', logical_layer: 'UI', stability: 'STABLE'},
                {id: 'CLASS:Neo.dashboard.X', type: 'CLASS', name: 'Neo.dashboard.X', description: 'a one-letter identity', logical_layer: 'UI', stability: 'STABLE'},
                {id: 'CLASS:Neo.dashboard.dock.Workspace', type: 'CLASS', name: 'Neo.dashboard.dock.Workspace', description: 'the canonical path of the façade', logical_layer: 'UI', stability: 'STABLE'},
                {id: 'CONCEPT:HeaderActions plugin', type: 'CONCEPT', name: 'HeaderActions plugin', description: 'two words, both in the text', logical_layer: 'UI', stability: 'STABLE'},
                {id: 'CONCEPT:Ratchet Management', type: 'CONCEPT', name: 'Ratchet Management', description: 'two words, one of them invented', logical_layer: 'UI', stability: 'STABLE'},
                {id: 'SESSION:Dock Handler Refactoring Session', type: 'SESSION', name: 'Dock Handler Refactoring Session', description: 'the model\'s label', logical_layer: 'Unknown', stability: 'UNKNOWN'}
            ],
            edges: [
                ...payload().session_artifact.graph.edges,
                {source: 'CLASS:Workspace', target: 'CLASS:Missing', relationship: 'DEPENDS_ON'},
                {source: 'SESSION:abc', target: 'CLASS:Workspace', relationship: 'DISCUSSED_IN'}
            ]
        }), DOCUMENT);

        expect(drift).toMatchObject({schemaValid: true, nodes: 10, edges: 5, danglingEdges: 1, groundedNodes: 6, ungroundedNames: ['Neo.dashboard.Main', 'Neo.dashboard.X', 'Ratchet Management'], labelledNodes: 1});

        expect(isTriVectorShape({a2a_version: '1.0', session_artifact: {graph: {nodes: [{id: 'x', type: 'CLASS', name: 'x'}], edges: []}}})).toBe(false);
        expect(measurePayload(null, DOCUMENT)).toEqual({schemaValid: false, nodes: 0, edges: 0, danglingEdges: 0, groundedNodes: 0, ungroundedNames: [], labelledNodes: 0, extracted: []});
    });

    test('runs fold into the table\'s shape, and the floor is the reference model\'s recorded result on the same document set — met at or above it on every axis, never on another set, never without a reference', async () => {
        const
            good      = {schemaValid: true, nodes: 5, edges: 4, danglingEdges: 0, groundedNodes: 5, ungroundedNames: []},
            thin      = {schemaValid: true, nodes: 3, edges: 2, danglingEdges: 1, groundedNodes: 2, ungroundedNames: ['Neo.dashboard.Main']},
            reference = referenceFloor(),
            runs      = [{document: 'a.md', measure: good}, {document: 'b.md', measure: {...good, groundedNodes: 4}}],
            met       = summarizeRuns(runs, {preset: 'local-small', chatModel: 'google/gemma-4-26b-a4b', measuredAt: '2026-10-02', documentsDigest: reference.documentsDigest});

        // the reference is the table's recorded gemma run, read from the presets module, never a number in the instrument —
        // and it stays the bar although the hosted preset now carries a recorded floor of its own (a receipt, not the bar)
        expect(reference).toMatchObject({instrument: INSTRUMENT, chatModel: 'google/gemma-4-26b-a4b', result: {schemaValid: true}});
        expect(reference).toBe(byId('local-small').qualityFloor);
        expect(byId('hosted').qualityFloor).not.toBe(reference);
        expect(meetsFloor(byId('hosted').qualityFloor.result, reference.result)).toBe(true);

        expect(met).toMatchObject({
            preset    : 'local-small',
            instrument: INSTRUMENT,
            measuredAt: '2026-10-02',
            chatModel : 'google/gemma-4-26b-a4b',
            documents : ['a.md', 'b.md'],
            documentsDigest: reference.documentsDigest,
            result    : {schemaValid: true, danglingEdges: 0, groundedNodesPerDocument: '4-5', ungroundedNames: 0},
            floor     : {met: true, comparable: true, reference}
        });
        expect(met.perDocument.map(row => row.document)).toEqual(['a.md', 'b.md']);

        // the same favourable metrics over another document set are not a pass: the comparison is unavailable
        const elsewhere = summarizeRuns(runs, {preset: 'local-small', chatModel: 'google/gemma-4-26b-a4b', measuredAt: '2026-10-02', documentsDigest: 'f'.repeat(64)});

        expect(elsewhere.floor).toEqual({met: false, comparable: false, reference, reason: 'the reference was measured on another document set'});
        expect(summarizeRuns(runs, {preset: 'local-small', chatModel: 'x', measuredAt: '2026-10-02', documentsDigest: reference.documentsDigest, reference: null}).floor).toEqual({met: false, comparable: false, reference: null, reason: 'no reference is recorded'});

        const short = summarizeRuns([{document: 'a.md', measure: good}, {document: 'b.md', measure: thin}], {preset: 'local-small', chatModel: 'gpt-oss-20b', measuredAt: '2026-10-02', documentsDigest: reference.documentsDigest});

        expect(short.result).toEqual({schemaValid: true, danglingEdges: 1, groundedNodesPerDocument: '2-5', ungroundedNames: 1});
        expect(short.floor).toMatchObject({met: false, comparable: true});
        expect(summarizeRuns([], {preset: 'local-small', chatModel: null, measuredAt: '2026-10-02', documentsDigest: reference.documentsDigest}).floor.met).toBe(false);

        // the digest is the set's identity: order-free, content-sensitive, and the table's recorded one IS the shipped fixtures'
        expect(documentsDigest([{name: 'b.md', content: '2'}, {name: 'a.md', content: '1'}])).toBe(documentsDigest([{name: 'a.md', content: '1'}, {name: 'b.md', content: '2'}]));
        expect(documentsDigest([{name: 'a.md', content: '1'}, {name: 'b.md', content: '3'}])).not.toBe(documentsDigest([{name: 'a.md', content: '1'}, {name: 'b.md', content: '2'}]));
        const fixtures = await Promise.all((await listDocuments(DEFAULT_DOCUMENTS_DIR)).map(async file => ({name: path.basename(file), content: await readFile(file, 'utf8')})));

        expect(documentsDigest(fixtures)).toBe(reference.documentsDigest);

        // the reference's own result meets itself; one more dangling edge or one fewer grounded node does not
        expect(meetsFloor(reference.result, reference.result)).toBe(true);
        expect(meetsFloor({...reference.result, danglingEdges: reference.result.danglingEdges + 1}, reference.result)).toBe(false);
        expect(meetsFloor({...reference.result, groundedNodesPerDocument: '1'}, reference.result)).toBe(false);
        expect(meetsFloor(reference.result, null)).toBe(false);
    });

    test('the hosted preset runs its children against Gemini\'s OpenAI-compatible endpoint as declared, isolated like a local one, measured against the reference floor', async () => {
        const
            calls  = [],
            result = await measurePreset({presetId: 'hosted', documentsDir: await scratchDocuments(), exec: fakeExec({chatModel: 'gemini-3.8-flash', payload: payload(), failure: null}, calls)});

        expect(calls).toHaveLength(3);
        expect(calls[0].env).toMatchObject({
            NEO_GRAPH_PROVIDER                          : 'openAiCompatible',
            NEO_OPENAI_COMPATIBLE_HOST                  : GEMINI_ENDPOINT,
            NEO_OPENAI_COMPATIBLE_MODEL                 : 'gemini-3.8-flash',
            NEO_LOCAL_MODELS_CHAT_GRAPH_REASONING_EFFORT: 'low',
            UNIT_TEST_MODE                              : 'true',
            NEO_PLANE_DATA_ROOT                         : calls[0].cwd
        });
        // the key is the operator's, from the environment; the table names no value
        expect(Object.keys(byId('hosted').env).some(key => key.includes('API_KEY'))).toBe(false);
        expect(result).toMatchObject({
            preset      : 'hosted',
            instrument  : INSTRUMENT,
            chatModel   : 'gemini-3.8-flash',
            providerHost: {declared: GEMINI_ENDPOINT, used: GEMINI_ENDPOINT},
            isolation   : {graph: ':memory:', dataRoot: calls[0].cwd},
            result      : {schemaValid: true, danglingEdges: 0, groundedNodesPerDocument: '4', ungroundedNames: 0},
            // scratch documents, not the recorded floor's set: measured, never a pass
            floor       : {met: false, comparable: false, reference: referenceFloor()}
        });
        expect(result.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('a local preset runs one child per document under a fresh scratch root with the consumed isolation flags, refuses a child that resolved a plane path, folds the payloads and removes the root; a child failure or a refused provider is unmeasured', async () => {
        const
            dir      = await scratchDocuments(),
            calls    = [],
            measured = await measurePreset({presetId: 'local-small', documentsDir: dir, providerHost: 'http://127.0.0.1:1234', exec: fakeExec({chatModel: 'google/gemma-4-26b-a4b', payload: payload(), failure: null}, calls)}),
            root     = calls[0].cwd;

        expect(await listDocuments(dir)).toHaveLength(3);
        expect(calls).toHaveLength(3);
        expect(calls[0].file).toBe(process.execPath);
        expect(calls[0].args.slice(0, 2)).toEqual(['--input-type=module', '-e']);
        expect(calls[0].args[2]).toContain('executeTriVectorExtraction');
        // the scratch root is every child's cwd, plane anchor and marker directory; the CONSUMED unit-test flag selects the memory graph store
        expect(path.basename(root)).toMatch(/^preset-quality-floor-/);
        expect(calls.every(call => call.cwd === root)).toBe(true);
        expect(calls[0].env).toMatchObject({
            UNIT_TEST_MODE             : 'true',
            NEO_PLANE_DATA_ROOT        : root,
            NEO_REM_RUN_STATE_DIR      : path.join(root, 'rem-runs'),
            NEO_GRAPH_PROVIDER         : 'openAiCompatible',
            NEO_OPENAI_COMPATIBLE_HOST : 'http://127.0.0.1:1234',
            NEO_OPENAI_COMPATIBLE_MODEL: 'google/gemma-4-26b-a4b',
            NEO_PRESET_FLOOR_SESSION_ID: 'preset-quality-floor:local-small:01-thread.md'
        });
        expect(calls[0].env.NEO_UNIT_TEST_MODE).toBeUndefined();
        expect(calls[0].env.NEO_PRESET_FLOOR_DOCUMENT).toBe(path.join(dir, '01-thread.md'));
        // the root is gone once the run is folded
        await expect(access(root)).rejects.toThrow();
        expect(measured).toMatchObject({
            preset      : 'local-small',
            chatModel   : 'google/gemma-4-26b-a4b',
            documents   : ['01-thread.md', '02-thread.md', '03-thread.md'],
            result      : {schemaValid: true, danglingEdges: 0, groundedNodesPerDocument: '4', ungroundedNames: 0},
            // three scratch documents are not the recorded floor's set: measured, not comparable, never a pass
            floor       : {met: false, comparable: false, reason: 'the reference was measured on another document set'},
            isolation   : {graph: ':memory:', remRunStateDir: path.join(root, 'rem-runs'), dataRoot: root},
            providerHost: {declared: 'http://host.docker.internal:1234', used: 'http://127.0.0.1:1234'}
        });
        expect(measured.documentsDigest).toBe(documentsDigest(await Promise.all(['01-thread.md', '02-thread.md', '03-thread.md'].map(async name => ({name, content: await readFile(path.join(dir, name), 'utf8')})))));

        // a child that resolved the graph store or a plane path elsewhere is refused before its payload counts
        const leaky = await measurePreset({presetId: 'local-small', documentsDir: dir, exec: fakeExec(env => ({isolation: {graph: '/srv/plane/sqlite/memory-core-graph.sqlite', remRunStateDir: env.NEO_REM_RUN_STATE_DIR, dataRoot: env.NEO_PLANE_DATA_ROOT}, chatModel: 'x', payload: payload(), failure: null}))});

        expect(leaky.unmeasured).toBe('the child was not isolated: the child resolved the graph store to /srv/plane/sqlite/memory-core-graph.sqlite, not :memory:');
        expect(isolatedUnder({graph: ':memory:', remRunStateDir: '/elsewhere/rem-runs', dataRoot: '/tmp/x'}, '/tmp/x')).toMatch(/outside its scratch root/);
        expect(isolatedUnder(undefined, '/tmp/x')).toBe('the child reported no isolation');
        expect(isolatedUnder({graph: ':memory:', remRunStateDir: '/tmp/x/rem-runs', dataRoot: '/tmp/x'}, '/tmp/x')).toBeNull();
        expect(isolationEnv('/tmp/x')).toEqual({UNIT_TEST_MODE: 'true', NEO_MEMORY_DB_PATH_TEST: ':memory:', NEO_PLANE_DATA_ROOT: '/tmp/x', NEO_REM_RUN_STATE_DIR: '/tmp/x/rem-runs'});

        const failed = await measurePreset({presetId: 'local-small', documentsDir: dir, exec: fakeExec({chatModel: 'google/gemma-4-26b-a4b', payload: null, failure: {ok: false, deferReason: 'schema-failure', evidence: {errorMessage: 'fetch failed'}}})});

        expect(failed).toMatchObject({preset: 'local-small', chatModel: 'google/gemma-4-26b-a4b', unmeasured: 'the extraction of 01-thread.md returned no payload: fetch failed'});

        const refused = await measurePreset({presetId: 'local-small', documentsDir: dir, exec: fakeExec({unmeasured: "graph provider 'x' is outside the Tri-Vector dispatch (ollama | openAiCompatible)"})});

        expect(refused.unmeasured).toMatch(/outside the Tri-Vector dispatch/);

        await expect(measurePreset({presetId: 'nope', documentsDir: dir, exec: fakeExec({})})).rejects.toThrow(/--preset must be one of hosted \| local-small \| local-full/);
    });

    test('witness: the real child, from a clean environment, runs the shipped path against a fake endpoint — memory graph store, scratch anchor and marker directory, nothing written but the emptied marker directory, the root removed', async () => {
        test.setTimeout(180000);

        const
            provider = await fakeProviderServer(payload()),
            roots    = [],
            seen     = [],
            // the instrument's own spawn, observed: the scratch root's content right after each child exits, before the parent removes it
            exec     = async (file, args, options) => {
                const result = await execFileAsync(file, args, options);

                roots.push(options.cwd);
                seen.push((await readdir(options.cwd, {recursive: true})).sort());

                return result;
            };

        try {
            const
                reference = referenceFloor(),
                measured  = await measurePreset({
                    presetId    : 'local-small',
                    providerHost: provider.host,
                    // no ambient test flag reaches the child, and an inherited test graph path is pinned away: the isolation is the instrument's own env
                    baseEnv     : {PATH: process.env.PATH, HOME: process.env.HOME, NEO_MEMORY_DB_PATH_TEST: '/outside/should-not-open.sqlite'},
                    exec
                }),
                root = roots[0];

            expect(roots).toHaveLength(3);
            expect(roots.every(dir => dir === root)).toBe(true);
            // every request went to the fake endpoint through the shipped client, grammar-constrained
            expect(provider.requests.map(row => row.url)).toEqual(['/v1/chat/completions', '/v1/chat/completions', '/v1/chat/completions']);
            expect(provider.requests[0].body).toMatchObject({model: 'google/gemma-4-26b-a4b', response_format: {type: 'json_schema'}});
            // what the child resolved: memory for the graph store, the scratch root for the anchor and the marker directory
            expect(measured.isolation).toEqual({graph: ':memory:', remRunStateDir: path.join(root, 'rem-runs'), dataRoot: root});
            // what the child wrote: the marker directory, emptied again — and nothing else under its root
            expect(seen).toEqual([['rem-runs'], ['rem-runs'], ['rem-runs']]);
            await expect(access(root)).rejects.toThrow();
            // the payload came through the sentinel; the shipped fixtures are the recorded floor's set
            expect(measured).toMatchObject({preset: 'local-small', chatModel: 'google/gemma-4-26b-a4b', documentsDigest: reference.documentsDigest, result: {schemaValid: true}, floor: {comparable: true}});
            expect(measured.documents).toEqual(['19339-dock-reveal-overlay-focus.md', '19354-dock-workspace-header-actions-plugin.md', '19356-grid-body-scroll-edge.md']);
        } finally {
            await provider.close();
        }
    });

    test('boundary: a child whose resolved graph store is not memory refuses BEFORE importing anything that can write — no extractor import, no marker directory, no file at the inherited path', async () => {
        test.setTimeout(120000);

        const
            outside  = path.join(await mkdtemp(path.join(os.tmpdir(), 'preset-floor-outside-')), 'should-not-open.sqlite'),
            stdouts  = [],
            roots    = [],
            seen     = [],
            // the instrument's spawn with its pin defeated: the child inherits a test graph path the env no longer pins away
            exec     = async (file, args, options) => {
                const result = await execFileAsync(file, args, {...options, env: {...options.env, NEO_MEMORY_DB_PATH_TEST: outside}});

                stdouts.push(result.stdout);
                roots.push(options.cwd);
                seen.push(await readdir(options.cwd, {recursive: true}));

                return result;
            },
            measured = await measurePreset({presetId: 'local-small', providerHost: 'http://127.0.0.1:9', baseEnv: {PATH: process.env.PATH, HOME: process.env.HOME}, exec});

        expect(roots).toHaveLength(1);
        expect(measured).toMatchObject({
            preset    : 'local-small',
            isolation : {graph: outside, remRunStateDir: path.join(roots[0], 'rem-runs'), dataRoot: roots[0]},
            unmeasured: `the child was not isolated: the child resolved the graph store to ${outside}, not :memory:`
        });
        // the refusal came before the extractor was imported: no extractor log line, no marker directory, no file at the path
        expect(stdouts[0]).not.toContain('[SemanticGraphExtractor]');
        expect(seen[0]).toEqual([]);
        await expect(access(outside)).rejects.toThrow();
        await expect(access(roots[0])).rejects.toThrow();
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

        // exit 2 is the child's refusal (the dispatch's own), never a verdict of the table
        const
            refusedOut = [],
            refused    = await main(['node', 'presetQualityFloor', '--preset', 'hosted', '--documents', dir], {stdout: {write: text => { refusedOut.push(text); return true }}, exec: fakeExec({unmeasured: "graph provider 'x' is outside the Tri-Vector dispatch (ollama | openAiCompatible)"})});

        expect(refused).toBe(2);
        expect(JSON.parse(refusedOut.join('')).unmeasured).toMatch(/outside the Tri-Vector dispatch/);

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

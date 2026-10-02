#!/usr/bin/env node
import 'dotenv/config';

import {Command, InvalidArgumentError} from 'commander';
import {execFile}                      from 'node:child_process';
import fs                              from 'node:fs/promises';
import path                            from 'node:path';
import {fileURLToPath, pathToFileURL}  from 'node:url';
import {promisify}                     from 'node:util';
import {PLANE_PROFILE, presets, profileInputs} from '../../services/fleet/placementPresets.mjs';

/**
 * Pre-Flight (structural fast-path): `ai/scripts/diagnostics/presetQualityFloor.mjs` lifts the
 * sibling pattern of `lmStudioEmbeddingInstances.mjs` and `mcpHealthcheck.mjs` — a read-only
 * diagnostics CLI with exported pure helpers and unit coverage; no novel directory.
 *
 * @module ai/scripts/diagnostics/presetQualityFloor
 * @summary The quality-floor instrument: runs one preset's chat model through the SHIPPED Tri-Vector
 * path over three documents and prints what came back — never a stored status.
 *
 * Each document is extracted in a child process that carries the preset's env mapped onto the leaf
 * names the local profile reads (`profileInputs` — the parity witness's own mapping), under
 * `NEO_UNIT_TEST_MODE` so no plane data root is touched, and a `beforeCommit` sentinel that keeps the
 * payload and refuses the graph write. The parent measures the payload against the document: schema
 * validity, dangling edges (an endpoint that is neither a node of the payload, `frontier`, nor a
 * row-backed `memory:` / `session:` provenance target), and grounded names (a node whose name occurs
 * in the document). The result is an observation with its date, pasted into
 * `placementPresets.presets[].qualityFloor` by hand — the script writes nothing, because a
 * measurement is an observation, never a stored status.
 *
 * `unmeasured` is the honest answer for a preset the path cannot run: graph generation dispatches to
 * `ollama` or an OpenAI-compatible endpoint only, so a preset whose `NEO_GRAPH_PROVIDER` is `gemini`
 * reports that before any request; an unreachable model reports the provider's failure. Neither is a
 * pass. The declared local provider host names Docker's `host.docker.internal`; on the host itself
 * the loopback form is used and both are printed, or `--provider-host` names the endpoint outright.
 */

const
    execFileAsync       = promisify(execFile),
    here                = path.dirname(fileURLToPath(import.meta.url)),
    brainRoot           = path.resolve(here, '../../..'),
    DOCUMENT_EXTENSIONS = new Set(['.md', '.txt']);

/** The instrument's name as the presets table records it. */
export const INSTRUMENT = 'tri-vector-three-documents';

/** The documents shipped beside the script: three public engine threads, never session memories. */
export const DEFAULT_DOCUMENTS_DIR = path.join(here, 'fixtures', 'presetQualityFloor');

/** Graph generation's accepted providers (`providerDispatch.GRAPH_MODEL_PROVIDERS`, restated here so the parent stays free of Neo). */
export const GRAPH_PROVIDERS = Object.freeze(['ollama', 'openAiCompatible']);

/**
 * @summary The floor a run is measured against: the reference model's recorded result on the same
 * fixture set — the table's recorded `qualityFloor` (the local presets' gemma run), never a number
 * written here. A result at or above it makes a preset `supported`.
 * @returns {{instrument: String, measuredAt: String, chatModel: String, documents: String[]|undefined, result: Object}|null}
 */
export function referenceFloor() {
    return presets.find(row => row.qualityFloor?.result)?.qualityFloor ?? null;
}

/**
 * @summary Whether a summarized result is at or above a reference result on every axis the table records.
 * @param {Object} result `{schemaValid, danglingEdges, groundedNodesPerDocument, ungroundedNames}`
 * @param {Object|null} reference The reference's `result`.
 * @returns {Boolean} `false` without a reference — nothing is `supported` by default.
 */
export function meetsFloor(result, reference) {
    const minGrounded = range => Number(String(range).split('-')[0]);

    return Boolean(reference) && result.schemaValid === true
        && result.danglingEdges <= reference.danglingEdges
        && result.ungroundedNames <= reference.ungroundedNames
        && minGrounded(result.groundedNodesPerDocument) >= minGrounded(reference.groundedNodesPerDocument);
}

/**
 * Node types whose names are the model's own labels for what it produced (a session, a memory, a plan)
 * rather than claims about the document; grounding applies to every other type.
 * @type {Set<String>}
 */
export const LABEL_NODE_TYPES = new Set(['SESSION', 'MEMORY', 'STRATEGY', 'ARTIFACT_PLAN', 'ARTIFACT_TASK']);

/** One child run per document may take minutes on a loaded host. */
export const CHILD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * @summary A preset's env keys, each landed on the leaf env name the profile maps it to (an overlay
 * input such as `NEO_LOCAL_AGENT_OS_MODEL` becomes `NEO_OPENAI_COMPATIBLE_MODEL`); keys the profile
 * reads under their own name pass through.
 * @param {Object} preset A `placementPresets.presets` row.
 * @param {{inputs: Set<String>, mappings: Map<String, String>}} profile From `profileInputs`.
 * @returns {Object} The env for a child process.
 */
export function mapPresetEnv(preset, profile) {
    return Object.fromEntries(Object.entries(preset.env).map(([key, value]) => [profile.mappings.get(key) ?? key, value]));
}

/**
 * @summary The provider host a run uses: the override, else the declared one with Docker's
 * `host.docker.internal` read as the host's own loopback — the only host a host-side run can reach.
 * @param {String|undefined} declared The mapped `NEO_OPENAI_COMPATIBLE_HOST`.
 * @param {String|null} [override] `--provider-host`.
 * @returns {{declared: String|null, used: String|null}}
 */
export function resolveProviderHost(declared, override = null) {
    const used = override ?? (typeof declared === 'string' ? declared.replace('host.docker.internal', '127.0.0.1') : null);

    return {declared: declared ?? null, used};
}

/**
 * @summary Whether a payload is the Tri-Vector shape the extractor's schema promises.
 * @param {Object} payload
 * @returns {Boolean}
 */
export function isTriVectorShape(payload) {
    const graph = payload?.session_artifact?.graph;

    return typeof payload?.a2a_version === 'string'
        && Array.isArray(graph?.nodes) && Array.isArray(graph?.edges)
        && graph.nodes.every(node => ['id', 'type', 'name', 'description'].every(key => typeof node?.[key] === 'string'))
        && graph.edges.every(edge => ['source', 'target', 'relationship'].every(key => typeof edge?.[key] === 'string'));
}

/**
 * @summary Measures one payload against the document it was extracted from.
 * @param {Object} payload The captured Tri-Vector payload.
 * @param {String} documentText
 * @returns {{schemaValid: Boolean, nodes: Number, edges: Number, danglingEdges: Number, groundedNodes: Number, ungroundedNames: String[]}}
 */
export function measurePayload(payload, documentText) {
    const
        schemaValid = isTriVectorShape(payload),
        nodes       = payload?.session_artifact?.graph?.nodes ?? [],
        edges       = payload?.session_artifact?.graph?.edges ?? [],
        ids         = new Set(nodes.map(node => node.id)),
        haystack    = String(documentText).toLowerCase(),
        // a row-backed provenance target or the frontier hub is a sink the payload need not declare
        isSink      = id => id === 'frontier' || /^(memory|session):/i.test(String(id)),
        known       = id => ids.has(id) || isSink(id),
        nameOf      = node => String(node.name ?? String(node.id).split(':').slice(1).join(':')).trim(),
        // a name is grounded when every word of it (three letters or more) occurs in the document
        grounded    = node => { const words = nameOf(node).toLowerCase().match(/[\p{L}\p{N}_.-]{3,}/gu) ?? []; return words.length > 0 && words.every(word => haystack.includes(word)) },
        // these types name what the model itself produced — a summary, a plan — so their names are labels, never claims about the text
        labelled    = node => LABEL_NODE_TYPES.has(String(node.type).toUpperCase()),
        claims      = nodes.filter(node => !labelled(node)),
        ungrounded  = claims.filter(node => !grounded(node)).map(nameOf);

    return {
        schemaValid,
        nodes          : nodes.length,
        edges          : edges.length,
        danglingEdges  : edges.filter(edge => !known(edge.source) || !known(edge.target)).length,
        groundedNodes  : claims.length - ungrounded.length,
        ungroundedNames: ungrounded,
        labelledNodes  : nodes.length - claims.length,
        extracted      : nodes.map(node => `${node.type}:${nameOf(node)}`)
    };
}

/**
 * @summary Folds per-document measurements into the shape the presets table records, with the floor verdict.
 * @param {Object[]} runs `[{document, measure}]`, every run measured.
 * @param {Object} options
 * @param {String} options.preset
 * @param {String} options.chatModel
 * @param {String} [options.measuredAt]
 * @returns {Object}
 */
export function summarizeRuns(runs, {preset, chatModel, measuredAt = new Date().toISOString().slice(0, 10), reference = referenceFloor()}) {
    const
        grounded = runs.map(run => run.measure.groundedNodes),
        result   = {
            schemaValid             : runs.length > 0 && runs.every(run => run.measure.schemaValid),
            danglingEdges           : runs.reduce((sum, run) => sum + run.measure.danglingEdges, 0),
            groundedNodesPerDocument: runs.length ? (Math.min(...grounded) === Math.max(...grounded) ? String(grounded[0]) : `${Math.min(...grounded)}-${Math.max(...grounded)}`) : '0',
            ungroundedNames         : runs.reduce((sum, run) => sum + run.measure.ungroundedNames.length, 0)
        };

    return {
        preset,
        instrument: INSTRUMENT,
        measuredAt,
        chatModel,
        documents : runs.map(run => run.document),
        result,
        floor     : {met: meetsFloor(result, reference?.result ?? null), reference},
        perDocument: runs.map(run => ({document: run.document, ...run.measure}))
    };
}

/**
 * @summary The child's program: boot Neo, refuse a graph provider outside the dispatch, extract one
 * document through the shipped path, keep the payload at `beforeCommit` and refuse the write.
 * The last stdout line is the JSON the parent reads.
 * @param {String} root The Brain root the child imports from.
 * @returns {String}
 */
export function childSource(root) {
    const file = relative => pathToFileURL(path.join(root, relative)).href;

    return `
        const print = value => console.log(JSON.stringify(value));
        await import(${JSON.stringify(file('node_modules/neo.mjs/src/Neo.mjs'))});
        await import(${JSON.stringify(file('node_modules/neo.mjs/src/core/_export.mjs'))});
        const fs = await import('node:fs/promises');
        const {default: AiConfig} = await import(${JSON.stringify(file('ai/mcp/server/memory-core/config.mjs'))});
        const {GRAPH_MODEL_PROVIDERS, resolveGraphModelProvider} = await import(${JSON.stringify(file('ai/services/graph/providerDispatch.mjs'))});
        const graphProvider = resolveGraphModelProvider(AiConfig);
        if (!GRAPH_MODEL_PROVIDERS.includes(graphProvider)) {
            print({unmeasured: "graph provider '" + graphProvider + "' is outside the Tri-Vector dispatch (" + GRAPH_MODEL_PROVIDERS.join(' | ') + ")"});
            process.exit(0);
        }
        const {default: extractor} = await import(${JSON.stringify(file('ai/services/graph/SemanticGraphExtractor.mjs'))});
        const document  = await fs.readFile(process.env.NEO_PRESET_FLOOR_DOCUMENT, 'utf8');
        const chatModel = graphProvider === 'ollama' ? AiConfig.ollama.model : AiConfig.openAiCompatible.model;
        const sentinel  = new Error('presetQualityFloor: payload captured before commit; nothing is written');
        let captured = null;
        const result = await extractor.executeTriVectorExtraction(
            {meta: {sessionId: process.env.NEO_PRESET_FLOOR_SESSION_ID}, document},
            {beforeCommit: ({payload}) => { captured = payload; throw sentinel }}
        );
        print({chatModel, payload: captured, failure: captured ? null : result});
        process.exit(0);
    `;
}

/**
 * @summary Runs one document through a child extraction and returns the child's last JSON line.
 * @param {Object} options
 * @param {String} options.documentPath
 * @param {String} options.sessionId
 * @param {Object} options.env The mapped preset env.
 * @param {String} [options.root=brainRoot]
 * @param {Function} [options.exec=execFileAsync] The spawn seam, `(file, args, options) → Promise<{stdout}>`.
 * @returns {Promise<Object>}
 */
export async function runChildExtraction({documentPath, sessionId, env, root = brainRoot, exec = execFileAsync}) {
    const {stdout} = await exec(process.execPath, ['--input-type=module', '-e', childSource(root)], {
        cwd      : root,
        env      : {...process.env, ...env, NEO_UNIT_TEST_MODE: 'true', NEO_PRESET_FLOOR_DOCUMENT: documentPath, NEO_PRESET_FLOOR_SESSION_ID: sessionId},
        maxBuffer: 16 * 1024 * 1024,
        timeout  : CHILD_TIMEOUT_MS
    });
    const lines = String(stdout).trim().split(/\r?\n/).filter(Boolean);

    return JSON.parse(lines.at(-1));
}

/**
 * @summary The document files of a directory, in name order.
 * @param {String} dir
 * @returns {Promise<String[]>} Absolute paths.
 */
export async function listDocuments(dir) {
    const names = (await fs.readdir(dir)).filter(name => DOCUMENT_EXTENSIONS.has(path.extname(name))).sort();

    return names.map(name => path.join(dir, name));
}

/**
 * @summary Measures one preset over the documents; `unmeasured` carries the first reason the path could not run.
 * @param {Object} options
 * @param {String} options.presetId
 * @param {String} [options.documentsDir=DEFAULT_DOCUMENTS_DIR]
 * @param {String|null} [options.providerHost=null]
 * @param {String} [options.root=brainRoot]
 * @param {Function} [options.exec] The spawn seam.
 * @param {Function} [options.readCompose] `(file) → Promise<String>` over the profile's Compose files.
 * @returns {Promise<Object>} The summary, or `{preset, unmeasured, measuredAt, ...}`.
 */
export async function measurePreset({presetId, documentsDir = DEFAULT_DOCUMENTS_DIR, providerHost = null, root = brainRoot, exec, readCompose}) {
    const preset = presets.find(row => row.id === presetId);

    if (!preset) {
        throw new InvalidArgumentError(`--preset must be one of ${presets.map(row => row.id).join(' | ')}`);
    }

    const
        read       = readCompose ?? (file => fs.readFile(path.join(root, file), 'utf8')),
        profile    = profileInputs(await Promise.all(PLANE_PROFILE.composeFiles.map(read))),
        env        = mapPresetEnv(preset, profile),
        host       = resolveProviderHost(env.NEO_OPENAI_COMPATIBLE_HOST, providerHost),
        measuredAt = new Date().toISOString().slice(0, 10),
        base       = {preset: presetId, instrument: INSTRUMENT, measuredAt, providerHost: host};

    if (host.used) {
        env.NEO_OPENAI_COMPATIBLE_HOST = host.used;
    }

    if (!GRAPH_PROVIDERS.includes(env.NEO_GRAPH_PROVIDER)) {
        return {...base, unmeasured: `graph provider '${env.NEO_GRAPH_PROVIDER}' is outside the Tri-Vector dispatch (${GRAPH_PROVIDERS.join(' | ')})`};
    }

    const documents = await listDocuments(documentsDir);

    if (documents.length === 0) {
        return {...base, unmeasured: `no .md or .txt document under ${documentsDir}`};
    }

    const runs = [];
    let chatModel = null;

    for (const documentPath of documents) {
        const
            document = path.basename(documentPath),
            child    = await runChildExtraction({documentPath, sessionId: `preset-quality-floor:${presetId}:${document}`, env, root, exec});

        if (child.unmeasured) {
            return {...base, unmeasured: child.unmeasured};
        }

        chatModel ??= child.chatModel ?? null;

        if (!child.payload) {
            return {...base, chatModel, unmeasured: `the extraction of ${document} returned no payload: ${child.failure?.evidence?.errorMessage ?? child.failure?.deferReason ?? 'typed failure'}`, failure: child.failure ?? null};
        }

        runs.push({document, measure: measurePayload(child.payload, await fs.readFile(documentPath, 'utf8'))});
    }

    return {...summarizeRuns(runs, {preset: presetId, chatModel, measuredAt}), providerHost: host};
}

/**
 * @summary The CLI: prints the measurement as JSON; exit 0 when measured, 2 when unmeasured.
 * @param {String[]} [argv=process.argv]
 * @param {Object} [io]
 * @param {Object} [io.stdout=process.stdout]
 * @param {Function} [io.exec] The spawn seam.
 * @returns {Promise<Number>} The exit code.
 */
export async function main(argv = process.argv, {stdout = process.stdout, exec} = {}) {
    const program = new Command()
        .name('presetQualityFloor')
        .description('Runs one preset\'s chat model through the shipped Tri-Vector path over three documents and prints the floor result; writes nothing.')
        .requiredOption('--preset <id>', `one of ${presets.map(row => row.id).join(' | ')}`)
        .option('--documents <dir>', 'a directory of .md / .txt documents', DEFAULT_DOCUMENTS_DIR)
        .option('--provider-host <url>', 'the OpenAI-compatible endpoint to use instead of the preset\'s declared host')
        .exitOverride()
        .configureOutput({writeOut: text => stdout.write(text), writeErr: text => stdout.write(text)});

    program.parse(argv);

    const
        options = program.opts(),
        summary = await measurePreset({presetId: options.preset, documentsDir: path.resolve(options.documents), providerHost: options.providerHost ?? null, exec});

    stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

    return summary.unmeasured ? 2 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then(code => { process.exitCode = code }, error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 });
}

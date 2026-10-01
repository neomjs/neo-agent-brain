/**
 * @module ai/services/fleet/placementPresets
 * @summary The three supported first-run presets as data: env sets over the declared leaves of one
 * profile, each with its inference placement, its birth decision (the embedding model and the vector
 * dimension it pins), the workload the placement probe compares, and the quality floor that makes it
 * `supported` rather than `candidate`. Nothing here is a leaf default and nothing writes config: a
 * preset is what the recipe offers, and the env values the operator accepts become the deployment's
 * declared input. Thresholds never live here either — the probe computes margins from `workload`.
 *
 * Every number carries where it was measured. The plane figures come from the fresh small institution
 * of 2026-09-23 (`fm-fresh-small`, six services beside a live plane), never from the maintainer plane;
 * model sizes are what the model server reports for the loaded weights.
 */

/** @summary One gibibyte (1024³). */
const GiB = 1073741824;

/** @summary The one plane profile the presets target: the local Docker plane, hosted or local inference alike. */
export const PLANE_PROFILE = Object.freeze({
    id          : 'local-agent-os',
    composeFiles: ['deploy/cloud/docker-compose.yml', 'deploy/cloud/docker-compose.local-agent-os.yml']
});

/** @summary The orchestrator's declared role inside that plane (the leaf's own vocabulary). */
export const CONTAINER_AUTHORITY_PROFILE = 'container-plane';

/** @summary The relative Chroma store a plane of a given dimension uses (`<planeDataRoot>/<store>`). */
export const chromaStoreFor = dimension => dimension === 4096 ? 'chroma/unified' : `chroma/unified-${dimension}d`;

const
    FIXTURE_PLANE = Object.freeze({
        planeIdleBytes: Math.round(0.39 * GiB),
        planePeakBytes: Math.round(2.5 * GiB),
        source        : 'fm-fresh-small 2026-09-23: six services idle at 0.39 GiB, peak ≤ 2.5 GiB under ingestion'
    }),
    GEMMA_26B = Object.freeze({id: 'google/gemma-4-26b-a4b', bytes: 15641352350, source: 'lms ps sizeBytes, 4-bit'}),
    QWEN3_8B  = Object.freeze({id: 'text-embedding-qwen3-embedding-8b', bytes: 4680000000, dimension: 4096, source: 'lms ps sizeBytes'}),
    QWEN3_06B = Object.freeze({id: 'text-embedding-qwen3-embedding-0.6b', bytes: 640000000, dimension: 1024, source: 'LM Studio catalog, 8-bit'}),
    GEMMA_FLOOR = Object.freeze({
        instrument: 'tri-vector-three-documents',
        measuredAt: '2026-09-23',
        chatModel : GEMMA_26B.id,
        result    : {schemaValid: true, danglingEdges: 0, groundedNodesPerDocument: '4-5', ungroundedNames: 0},
        note      : 'sets the floor; gpt-oss-20b was 3.7× faster on prefill but thin below it; Qwen3.6 blocked by the reasoning channel'
    }),
    LOCAL_ENV = Object.freeze({
        NEO_MODEL_PROVIDER        : 'openAiCompatible',
        NEO_EMBEDDING_PROVIDER    : 'openAiCompatible',
        NEO_OPENAI_COMPATIBLE_HOST: 'http://host.docker.internal:1234'
    });

/**
 * @summary The supported presets. Fields: `id`, `label`, `inference` (`hosted` | `local`), `profile`,
 * `authorityProfile`, `env` (only declared leaf bindings — the parity spec proves it), `requires`
 * (what the recipe must still ask for), `vectorDimension`, `embedder`, `chatModel`, `workload`
 * (`{planeIdleBytes, planePeakBytes, modelsBytes, vmCapRecommendedBytes}` for the probe's
 * `fitsPreset`), `qualityFloor` (a recorded floor run, or `null` → `candidate`), and for the hosted
 * preset `pendingBindings`: leaves whose defaults it relies on until their env bindings exist.
 */
export const presets = Object.freeze([
    Object.freeze({
        id              : 'hosted',
        label           : 'Hosted inference (Gemini)',
        inference       : 'hosted',
        profile         : PLANE_PROFILE.id,
        authorityProfile: CONTAINER_AUTHORITY_PROFILE,
        env             : Object.freeze({
            NEO_MODEL_PROVIDER    : 'gemini',
            NEO_EMBEDDING_PROVIDER: 'gemini',
            NEO_VECTOR_DIMENSION  : '3072'
        }),
        requires        : ['providerKey', 'pat', 'repos'],
        vectorDimension : 3072,
        embedder        : 'gemini-embedding-001',
        chatModel       : 'gemini-3.5-flash',
        // the Gemini model leaves carry these as defaults and have no env binding yet; the recipe shows
        // the names, the operator cannot change them through a preset until the bindings land
        pendingBindings : ['gemini.modelName', 'gemini.embeddingModel'],
        workload        : Object.freeze({...FIXTURE_PLANE, modelsBytes: 0, vmCapRecommendedBytes: 6 * GiB}),
        qualityFloor    : null
    }),
    Object.freeze({
        id              : 'local-small',
        label           : 'Local inference, small index (1024-dim embedder)',
        inference       : 'local',
        profile         : PLANE_PROFILE.id,
        authorityProfile: CONTAINER_AUTHORITY_PROFILE,
        env             : Object.freeze({
            ...LOCAL_ENV,
            NEO_OPENAI_COMPATIBLE_MODEL          : GEMMA_26B.id,
            NEO_OPENAI_COMPATIBLE_EMBEDDING_MODEL: QWEN3_06B.id,
            NEO_VECTOR_DIMENSION                 : String(QWEN3_06B.dimension)
        }),
        requires        : ['chatModel', 'embeddingModel', 'pat', 'repos'],
        vectorDimension : QWEN3_06B.dimension,
        embedder        : QWEN3_06B.id,
        chatModel       : GEMMA_26B.id,
        pendingBindings : [],
        workload        : Object.freeze({...FIXTURE_PLANE, modelsBytes: GEMMA_26B.bytes + QWEN3_06B.bytes, vmCapRecommendedBytes: 8 * GiB}),
        qualityFloor    : GEMMA_FLOOR
    }),
    Object.freeze({
        id              : 'local-full',
        label           : 'Local inference, full index (4096-dim embedder)',
        inference       : 'local',
        profile         : PLANE_PROFILE.id,
        authorityProfile: CONTAINER_AUTHORITY_PROFILE,
        env             : Object.freeze({
            ...LOCAL_ENV,
            NEO_OPENAI_COMPATIBLE_MODEL          : GEMMA_26B.id,
            NEO_OPENAI_COMPATIBLE_EMBEDDING_MODEL: QWEN3_8B.id,
            NEO_VECTOR_DIMENSION                 : String(QWEN3_8B.dimension)
        }),
        requires        : ['chatModel', 'embeddingModel', 'pat', 'repos'],
        vectorDimension : QWEN3_8B.dimension,
        embedder        : QWEN3_8B.id,
        chatModel       : GEMMA_26B.id,
        pendingBindings : [],
        workload        : Object.freeze({...FIXTURE_PLANE, modelsBytes: GEMMA_26B.bytes + QWEN3_8B.bytes, vmCapRecommendedBytes: 8 * GiB}),
        qualityFloor    : GEMMA_FLOOR
    })
]);

/**
 * @summary A preset is `supported` only with a recorded floor; without one it is a `candidate` the
 * recipe never offers by default.
 * @param {Object} preset
 * @returns {String} `'supported' | 'candidate'`
 */
export function presetStatus(preset) {
    return preset?.qualityFloor ? 'supported' : 'candidate'
}

/**
 * @summary The birth decision's consequence: a preset change after ingest is a NEW store, never an
 * in-place re-dimension. Names the path — the new Chroma store, the two env values that select it,
 * and the re-embedding work — or `null` when the dimension is unchanged.
 * @param {Object} fromPreset
 * @param {Object} toPreset
 * @returns {Object|null} `{from, to, store, env, steps}`
 */
export function reembedPath(fromPreset, toPreset) {
    const from = fromPreset?.vectorDimension, to = toPreset?.vectorDimension;

    if (!Number.isInteger(from) || !Number.isInteger(to)) {
        throw new Error('reembedPath: both presets must declare an integer vectorDimension')
    }
    if (from === to) return null;

    const store = chromaStoreFor(to);

    return {
        from,
        to,
        store,
        env  : {NEO_VECTOR_DIMENSION: String(to), NEO_CHROMA_DATA_DIR: store},
        steps: [
            'stop the plane',
            `declare the new store: NEO_VECTOR_DIMENSION=${to}, NEO_CHROMA_DATA_DIR=${store} (the old store stays on disk, untouched)`,
            `start the plane against the empty store with ${toPreset.embedder}`,
            'ingest the corpus again (the Knowledge Base ingest verb over the same sources)',
            'let the embed daemon re-embed memories into the new store (the WAL is the source, not the old vectors)'
        ]
    }
}

/**
 * @summary Every env binding `ai/configBase.mjs` declares, read from its source text: each
 * `leaf(<default>, '<ENV_NAME>', …)` call. The parity spec resolves preset env keys against this set,
 * so a preset can never name a key the config does not declare.
 * @param {String} configSource The text of `ai/configBase.mjs`.
 * @returns {Set<String>}
 */
export function declaredEnvBindings(configSource) {
    const names = new Set();

    for (const match of String(configSource ?? '').matchAll(/leaf\([^,()]*(?:\([^)]*\))?[^,()]*,\s*'([A-Z][A-Z0-9_]+)'/g)) {
        names.add(match[1])
    }

    return names
}

/**
 * @summary The preset env keys that are not declared leaf bindings — empty for every shipped preset.
 * @param {Object}      preset
 * @param {Set<String>} declared From {@link declaredEnvBindings}.
 * @returns {String[]}
 */
export function unknownPresetEnvKeys(preset, declared) {
    return Object.keys(preset?.env ?? {}).filter(key => !declared.has(key))
}

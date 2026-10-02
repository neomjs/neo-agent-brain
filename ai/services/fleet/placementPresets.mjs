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

const COMPOSE_INPUT = /\$\{([A-Z][A-Z0-9_]*)(?::-[^}]*)?\}/g, COMPOSE_MAPPING = /^\s*(?:-\s*)?([A-Z][A-Z0-9_]*)\s*[:=]\s*\$\{([A-Z][A-Z0-9_]*)/;

/**
 * @summary What a profile actually consumes, read from its Compose files' text in order. An env line
 * `NAME: ${INPUT:-default}` (or `- NAME=${INPUT}`) feeds NAME from INPUT, and the LAST file to feed a
 * name wins — the overlay's provider anchor replaces the base's pass-through of the same name, so a
 * base input the overlay re-feeds from its own name is not an input of the profile any more. Bare
 * `${NAME}` uses outside env lines (a secret's file, a project name) stay inputs. A preset key the
 * profile never reads reaches no container, whatever `configBase` declares.
 * @param {String[]} composeTexts The profile's Compose files, in order.
 * @returns {{inputs: Set<String>, mappings: Map<String, String>}} `mappings`: input name → the env name it lands on, when they differ.
 */
export function profileInputs(composeTexts) {
    const bare = new Set(), feeds = new Map();

    for (const text of composeTexts) {
        for (const line of text.split('\n')) {
            const mapped = COMPOSE_MAPPING.exec(line);

            if (mapped) {
                feeds.set(mapped[1], mapped[2]);
                continue;
            }

            for (const match of line.matchAll(COMPOSE_INPUT)) {
                bare.add(match[1]);
            }
        }
    }

    const inputs = new Set(bare), mappings = new Map(), fed = new Set(feeds.values());

    for (const [name, input] of feeds) {
        inputs.add(input);

        if (input !== name) {
            mappings.set(input, name);
        }
    }

    // a bare input feeds no service env name: a secret's source file, a project name — the profile
    // consumes it itself, so no leaf landing is expected of it
    const bareInputs = new Set([...bare].filter(name => !fed.has(name)));

    return {inputs, mappings, bareInputs};
}

/**
 * @summary The effective-profile parity check: every preset env key must be an input the profile reads,
 * and — for an input that feeds a service env name — the name it lands on (itself, or the mapped name)
 * must be a binding `configBase` declares. A bare input (a secret's source path) needs no leaf.
 * @param {Object} preset
 * @param {{inputs: Set<String>, mappings: Map<String, String>, bareInputs: Set<String>}} profile From {@link profileInputs}.
 * @param {Set<String>} declared From {@link declaredEnvBindings}.
 * @returns {String[]} The offending keys, each with its reason; empty when the preset is honoured.
 */
export function unconsumedPresetEnvKeys(preset, profile, declared) {
    return Object.keys(preset?.env ?? {}).flatMap(key => {
        if (!profile.inputs.has(key)) {
            return [`${key}: not an input of the profile's Compose files`];
        }

        if (profile.bareInputs.has(key)) {
            return [];
        }

        const landsOn = profile.mappings.get(key) ?? key;

        return declared.has(landsOn) ? [] : [`${key}: lands on ${landsOn}, which configBase does not declare`];
    });
}

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
    // the local overlay's own inputs: it maps NEO_LOCAL_AGENT_OS_* onto the openAiCompatible leaves and
    // fixes the three providers to openAiCompatible unless a preset says otherwise
    LOCAL_ENV = Object.freeze({
        NEO_MODEL_PROVIDER              : 'openAiCompatible',
        NEO_GRAPH_PROVIDER              : 'openAiCompatible',
        NEO_EMBEDDING_PROVIDER          : 'openAiCompatible',
        NEO_LOCAL_AGENT_OS_PROVIDER_HOST: 'http://host.docker.internal:1234'
    });

/**
 * @summary The supported presets. Fields: `id`, `label`, `inference` (`hosted` | `local`), `profile`,
 * `authorityProfile`, `env` (the profile's CONSUMED inputs — each key is either a declared leaf binding
 * the profile forwards or an overlay input the profile maps onto one; the parity spec proves both
 * against the Compose files and `configBase`), `requires` (what the recipe must still ask for),
 * `vectorDimension`, `embedder`, `chatModel`, `workload` (`{planeIdleBytes, planePeakBytes,
 * modelsBytes, vmCapRecommendedBytes}` for the probe's `fitsPreset`), `qualityFloor` (a recorded floor
 * run, or `null` → `candidate`), and `pendingBindings`: leaves a preset would still rely on by default
 * because they lack an env binding — empty for every preset since the Gemini model leaves gained
 * theirs; the recipe shows the list when it is not.
 */
export const presets = Object.freeze([
    Object.freeze({
        id              : 'hosted',
        label           : 'Hosted inference (Gemini)',
        inference       : 'hosted',
        profile         : PLANE_PROFILE.id,
        authorityProfile: CONTAINER_AUTHORITY_PROFILE,
        env             : Object.freeze({
            NEO_MODEL_PROVIDER        : 'gemini',
            NEO_GRAPH_PROVIDER        : 'gemini',
            NEO_EMBEDDING_PROVIDER    : 'gemini',
            NEO_GEMINI_MODEL          : 'gemini-3.5-flash',
            NEO_GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
            NEO_VECTOR_DIMENSION      : '3072'
        }),
        requires        : ['providerKey', 'pat', 'repos'],
        vectorDimension : 3072,
        embedder        : 'gemini-embedding-001',
        chatModel       : 'gemini-3.5-flash',
        pendingBindings : [],
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
            NEO_LOCAL_AGENT_OS_MODEL          : GEMMA_26B.id,
            NEO_LOCAL_AGENT_OS_EMBEDDING_MODEL: QWEN3_06B.id,
            NEO_VECTOR_DIMENSION              : String(QWEN3_06B.dimension)
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
            NEO_LOCAL_AGENT_OS_MODEL          : GEMMA_26B.id,
            NEO_LOCAL_AGENT_OS_EMBEDDING_MODEL: QWEN3_8B.id,
            NEO_VECTOR_DIMENSION              : String(QWEN3_8B.dimension)
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

/** @summary The Chroma database the plane opens when nothing else is declared (`NEO_CHROMA_DATABASE`'s leaf default). */
export const DEFAULT_CHROMA_DATABASE = 'default_database';

const CHROMA_DATABASE_NAME = /^[a-z0-9][a-z0-9_-]{2,62}$/i;

/**
 * @summary The birth decision's consequence: a preset change after ingest is a NEW Chroma database,
 * never an in-place re-dimension. Storage selection belongs to the deployment — the profile forwards
 * `NEO_VECTOR_DIMENSION` and `NEO_CHROMA_DATABASE` to the Memory Core and Knowledge Base while Chroma
 * keeps its volume — so this helper names no store by itself: a dimension change needs an explicit
 * fresh database name, validated against the current one and the default before an executable plan
 * is returned. Whether that name is unused in Chroma is the deployment's check and a step of the plan,
 * not something a name can prove. `null` when the dimension is unchanged.
 * @param {Object} fromPreset
 * @param {Object} toPreset
 * @param {Object} [storage]
 * @param {String} [storage.currentDatabase=DEFAULT_CHROMA_DATABASE] The database the plane opens today.
 * @param {String} [storage.freshDatabase] The deployment's chosen new database: never the current, never the default.
 * @returns {Object|null} `{from, to, database: {current, fresh}, env, steps}`
 */
export function reembedPath(fromPreset, toPreset, {currentDatabase = DEFAULT_CHROMA_DATABASE, freshDatabase} = {}) {
    const from = fromPreset?.vectorDimension, to = toPreset?.vectorDimension;

    if (!Number.isInteger(from) || !Number.isInteger(to)) {
        throw new Error('reembedPath: both presets must declare an integer vectorDimension')
    }
    if (from === to) return null;

    const fresh = typeof freshDatabase === 'string' ? freshDatabase.trim() : '';

    if (!fresh) {
        throw new Error('reembedPath: a dimension change needs an explicit fresh database name (NEO_CHROMA_DATABASE); none was given')
    }
    if (fresh === currentDatabase || fresh === DEFAULT_CHROMA_DATABASE) {
        throw new Error(`reembedPath: '${fresh}' is the current or the default database, not a fresh one`)
    }
    if (!CHROMA_DATABASE_NAME.test(fresh)) {
        throw new Error('reembedPath: a Chroma database name is 3–63 characters of letters, digits, _ or -')
    }

    return {
        from,
        to,
        database: {current: currentDatabase, fresh},
        env     : {NEO_VECTOR_DIMENSION: String(to), NEO_CHROMA_DATABASE: fresh},
        steps   : [
            'stop the plane',
            `verify '${fresh}' does not exist in this Chroma yet (the deployment's check: a name proves nothing)`,
            `declare the fresh database: NEO_VECTOR_DIMENSION=${to}, NEO_CHROMA_DATABASE=${fresh} (the profile forwards both; '${currentDatabase}' stays in Chroma's volume, untouched)`,
            `start the plane: the Memory Core and Knowledge Base open '${fresh}' with ${toPreset.embedder}`,
            'ingest the corpus again (the Knowledge Base ingest verb over the same sources)',
            'let the embed daemon re-embed memories into the fresh database (the WAL is the source, not the old vectors)'
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

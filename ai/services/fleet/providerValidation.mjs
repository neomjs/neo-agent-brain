/**
 * @module ai/services/fleet/providerValidation
 * @summary The first run's `validation` observation: ONE chat completion and ONE embedding, performed fresh
 * at every evaluation with the configuration the run supplied — the consented preset's env and the
 * operator's provider key — and reported in the shape the recipe's `evaluateValidation` consumes
 * (`{provider: {ok, model, reason}, embedding: {ok, dimension, reason}}`). Never read from a receipt
 * (bootstrap-record decision §2.3 / §2.5 / §4).
 *
 * **What it proves, and its bound.** That the supplied configuration answers a prompt and embeds at the
 * observed dimension, from this host. It does not prove the plane's own active route — the plane's
 * containers reach the provider through their own network — and it says so in its reason: the plane's
 * route is proven by the `verify` effect, through the plane. Docker's `host.docker.internal` is read as
 * the host's own loopback, the only name a host-side call can reach.
 *
 * Config-free by design: the host-side first run has no AiConfig bootstrap (the plane does not exist yet),
 * so this module speaks the two HTTP contracts the presets declare directly — the OpenAI-compatible
 * `/v1/chat/completions` and `/v1/embeddings`, and Gemini's `embedContent` for the hosted embedder. No
 * vector body is retained or logged; the key lives in the request only.
 */

/**
 * The canary text; short by construction (the embedding lane's safe band is not this module's concern).
 * @type {String}
 */
export const VALIDATION_CANARY = 'first-run validation canary';

/**
 * The completion budget of the one chat call: room for a reasoning model's thinking before its one-word answer.
 * @type {Number}
 */
export const CHAT_MAX_TOKENS = 64;

/**
 * @summary The provider host a host-side call uses: the declared one with Docker's `host.docker.internal`
 * read as the host's own loopback.
 * @param {String|undefined} declared
 * @returns {String|null}
 */
export function hostReachable(declared) {
    return typeof declared === 'string' && declared ? declared.replace('host.docker.internal', '127.0.0.1') : null;
}

/**
 * @summary The two calls a preset's env declares, resolved to URLs, models and headers. Pure.
 * @param {Object} preset A `placementPresets` row.
 * @param {Object} [options]
 * @param {String} [options.providerKey=''] The hosted provider key's value (never logged).
 * @returns {{chat: Object|null, embedding: Object|null, refusal: String|null}}
 */
export function validationPlan(preset, {providerKey = ''} = {}) {
    const
        env      = preset?.env ?? {},
        chatHost = hostReachable(env.NEO_LOCAL_AGENT_OS_PROVIDER_HOST),
        bearer   = providerKey ? {authorization: `Bearer ${providerKey}`} : {};

    if (!chatHost || !env.NEO_LOCAL_AGENT_OS_MODEL) {
        return {chat: null, embedding: null, refusal: `preset '${preset?.id}' declares no OpenAI-compatible chat host or model`};
    }

    const chat = {
        url    : `${chatHost.replace(/\/+$/, '')}/v1/chat/completions`,
        model  : env.NEO_LOCAL_AGENT_OS_MODEL,
        headers: {'content-type': 'application/json', ...bearer},
        // the preset's declared reasoning effort rides along: it is part of the configuration the run supplied,
        // and a reasoning model under a small budget otherwise answers `length` with empty content
        ...(env.NEO_LOCAL_MODELS_CHAT_GRAPH_REASONING_EFFORT ? {reasoningEffort: env.NEO_LOCAL_MODELS_CHAT_GRAPH_REASONING_EFFORT} : {})
    };

    if (env.NEO_EMBEDDING_PROVIDER === 'gemini') {
        if (!providerKey) {
            return {chat, embedding: null, refusal: 'the hosted embedder needs the consented provider key'};
        }

        return {
            chat,
            embedding: {
                kind   : 'gemini',
                url    : `https://generativelanguage.googleapis.com/v1beta/models/${env.NEO_GEMINI_EMBEDDING_MODEL}:embedContent`,
                model  : env.NEO_GEMINI_EMBEDDING_MODEL,
                headers: {'content-type': 'application/json', 'x-goog-api-key': providerKey}
            },
            refusal: null
        };
    }

    if (env.NEO_EMBEDDING_PROVIDER === 'openAiCompatible' && env.NEO_LOCAL_AGENT_OS_EMBEDDING_MODEL) {
        return {
            chat,
            embedding: {kind: 'openAiCompatible', url: `${chatHost.replace(/\/+$/, '')}/v1/embeddings`, model: env.NEO_LOCAL_AGENT_OS_EMBEDDING_MODEL, headers: {'content-type': 'application/json', ...bearer}},
            refusal  : null
        };
    }

    return {chat, embedding: null, refusal: `preset '${preset?.id}' declares an embedding lane this probe does not speak (${env.NEO_EMBEDDING_PROVIDER ?? 'none'})`};
}

async function post(fetchFn, {url, headers}, body, timeoutMs) {
    const response = await fetchFn(url, {method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)});

    if (!response.ok) {
        const text = typeof response.text === 'function' ? await response.text().catch(() => '') : '';

        throw new Error(`HTTP ${response.status}${text ? ` - ${String(text).slice(0, 200)}` : ''}`);
    }

    return response.json();
}

/**
 * @summary Performs the two calls. Each failure is a reason, never a throw: the recipe reads a refusing
 * call as `failed` with that reason.
 * @param {Object} options
 * @param {Object}   options.preset
 * @param {String}   [options.providerKey='']
 * @param {Function} [options.fetchFn=fetch]
 * @param {Number}   [options.timeoutMs=30000]
 * @returns {Promise<{provider: {ok: Boolean, model: String|null, reason: String|null}, embedding: {ok: Boolean, dimension: Number|null, reason: String|null}, bound: String}>}
 */
export async function probeValidation({preset, providerKey = '', fetchFn = fetch, timeoutMs = 30000}) {
    const
        plan  = validationPlan(preset, {providerKey}),
        bound = 'proves the supplied configuration from this host, not the plane\'s active route (the verify effect proves that, through the plane)';

    if (plan.refusal) {
        return {provider: {ok: false, model: plan.chat?.model ?? null, reason: plan.refusal}, embedding: {ok: false, dimension: null, reason: plan.refusal}, bound};
    }

    // 64 tokens, not 8: a reasoning model spends the first tokens thinking and answers `finish_reason: length`
    // with empty content under a tighter budget (measured 2026-10-03 on gemini-3.8-flash and gemma-4-26b)
    const provider = await post(fetchFn, plan.chat, {model: plan.chat.model, messages: [{role: 'user', content: 'Answer with the single word: ready'}], max_tokens: CHAT_MAX_TOKENS, temperature: 0, ...(plan.chat.reasoningEffort ? {reasoning_effort: plan.chat.reasoningEffort} : {})}, timeoutMs)
        .then(payload => {
            const text = payload?.choices?.[0]?.message?.content;

            return typeof text === 'string' && text.trim() ? {ok: true, model: plan.chat.model, reason: null} : {ok: false, model: plan.chat.model, reason: 'the chat completion answered without content'};
        }, error => ({ok: false, model: plan.chat.model, reason: `the chat completion at ${plan.chat.url} failed: ${error?.message ?? error}`}));

    const embedding = await post(fetchFn, plan.embedding, plan.embedding.kind === 'gemini' ? {content: {parts: [{text: VALIDATION_CANARY}]}} : {model: plan.embedding.model, input: VALIDATION_CANARY}, timeoutMs)
        .then(payload => {
            const vector = plan.embedding.kind === 'gemini' ? payload?.embedding?.values : payload?.data?.[0]?.embedding;

            return Array.isArray(vector) && vector.length > 0 ? {ok: true, dimension: vector.length, reason: null} : {ok: false, dimension: null, reason: 'the embedding answered without a vector'};
        }, error => ({ok: false, dimension: null, reason: `the embedding at ${plan.embedding.url} failed: ${error?.message ?? error}`}));

    return {provider, embedding, bound};
}

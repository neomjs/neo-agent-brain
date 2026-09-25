/**
 * @summary Shared provider contract for a response that cannot be consumed safely.
 *
 * Three provider endings cross this boundary as typed failures: an in-stream provider error, a
 * reasoning-only completion, and a response whose served model disagrees with the requested model.
 * The mismatch code carries only bounded identity facts; recovery belongs to the provider's own
 * actuator, not to an imperative attached to this error.
 *
 * @module Neo.ai.provider.createStreamFailureError
 */

/**
 * @summary Caller-detectable code for a completion whose every token went to the reasoning channel.
 * @type {String}
 */
const REASONING_ONLY_RESPONSE_CODE = 'REASONING_ONLY_RESPONSE';

/**
 * @summary Caller-detectable code for a response served by a different model.
 * @type {String}
 */
const MODEL_MISMATCH_CODE = 'MODEL_MISMATCH';

/**
 * @summary Hosted model ids may carry an appended calendar version.
 * @type {RegExp}
 */
const HOSTED_MODEL_DATE_SUFFIX_RE = /-\d{4}-\d{2}-\d{2}$/;

const missingServedModelWarningKeys = new Set();

/**
 * @summary Caller-detectable code for an error the provider reported inside an otherwise successful response.
 * @type {String}
 */
const PROVIDER_STREAM_ERROR_CODE = 'PROVIDER_STREAM_ERROR';

/**
 * @summary Creates the shared reasoning-only-response error.
 *
 * The byte count leads the message so it survives a consumer's bounded error tail; the reasoning
 * text, prompt content and credentials never enter it.
 *
 * @param {Object} options
 * @param {String} options.provider Provider id (e.g. 'OpenAiCompatible').
 * @param {String} options.operationLabel Safe diagnostic label for the caller operation.
 * @param {Number} options.reasoningBytes UTF-8 bytes the provider streamed on the reasoning channel.
 * @param {String} [options.finishReason] The provider's finish reason, when it sent one.
 * @param {String} options.host Provider host.
 * @param {String} options.modelName Provider model id.
 * @returns {Error} Error with `code='REASONING_ONLY_RESPONSE'`, plus `provider`, `reasoningBytes` and `finishReason` fields.
 */
function createReasoningOnlyResponseError({provider, operationLabel, reasoningBytes, finishReason, host, modelName}) {
    const suffix = finishReason ? `, finish_reason=${finishReason}` : '',
          error  = new Error(
              `[${provider}] reasoning-only response: ${reasoningBytes} bytes on the reasoning channel, no content${suffix} — ` +
              `${operationLabel} (host=${host}, model=${modelName})`
          );

    error.code           = REASONING_ONLY_RESPONSE_CODE;
    error.provider       = provider;
    error.reasoningBytes = reasoningBytes;
    error.finishReason   = finishReason || '';

    return error;
}

/**
 * @summary Creates the shared in-stream provider error.
 *
 * The provider's own message is the diagnosis (the schema refusal above names the offending keyword),
 * so it is kept, bounded to 300 characters — the HTTP-error path already forwards the response body.
 *
 * @param {Object} options
 * @param {String} options.provider Provider id (e.g. 'OpenAiCompatible').
 * @param {String} options.operationLabel Safe diagnostic label for the caller operation.
 * @param {Object|String} options.error The provider's error payload (`{message}` or a bare string).
 * @param {String} options.host Provider host.
 * @param {String} options.modelName Provider model id.
 * @returns {Error} Error with `code='PROVIDER_STREAM_ERROR'`, plus `provider` and `providerMessage` fields.
 */
function createProviderStreamError({provider, operationLabel, error, host, modelName}) {
    const providerMessage = String(typeof error === 'string' ? error : (error?.message ?? JSON.stringify(error))).substring(0, 300),
          streamError     = new Error(`[${provider}] ${operationLabel} failed inside the stream: ${providerMessage} (host=${host}, model=${modelName})`);

    streamError.code            = PROVIDER_STREAM_ERROR_CODE;
    streamError.provider        = provider;
    streamError.providerMessage = providerMessage;

    return streamError;
}

/**
 * @summary Hosted endpoints whose PUBLISHED contract appends a calendar version to served model ids.
 *
 * The admission bar is deliberately high, because this set is the only thing that keeps a
 * date-stamped served id from reading as a wrong resident — and a wrong resident is the exact
 * failure the surrounding assertion exists to catch. A host earns a place here by publishing
 * dated snapshots as part of its contract, not by being reachable over public HTTPS.
 *
 * That distinction is the whole point. The previous predicate asked whether a host *looked* hosted
 * — public scheme, not loopback, not RFC1918 — so every public endpoint qualified, including a
 * self-hosted gateway on a public name and a bare `https://example.com/v1`. A wrong resident behind
 * such a host was then indistinguishable from a date stamp, which is the hole this assertion was
 * merged to close. Deriving trust from a hostname's shape is not a contract.
 *
 * `api.openai.com` qualifies: dated snapshots (`gpt-4o-2024-08-06`) are a documented, routine part
 * of its served ids. Hosts whose ids are versioned rather than dated are absent on purpose —
 * `generativelanguage.googleapis.com` and `api.mistral.ai` publish `-002` / `-2402` style versions,
 * and admitting them would tolerate a suffix that never indicated a different build.
 *
 * Adding a host is a deliberate act: cite the vendor's published model-id contract in the entry.
 * @type {Set<String>}
 */
const DATE_ALIAS_CONTRACT_HOSTS = new Set([
    'api.openai.com'
]);

/**
 * @summary Returns whether a model endpoint's DECLARED contract permits a hosted date alias.
 *
 * Default-deny. A local or self-hosted endpoint is not in the set, which is the correct answer for
 * it without needing a second rule: a local server that reports a dated model id is reporting a
 * different resident, not a snapshot of the requested one.
 * @param {String} host Configured provider host.
 * @returns {Boolean} True only for a host with a declared date-alias contract.
 */
function hostedModelAliasesAllowed(host) {
    try {
        const url = new URL(host);

        // The protocol is half the contract, not a detail of the hostname check. A declared
        // provider's ORIGIN is `https://` plus its hostname; admitting the same hostname over
        // plaintext admits an endpoint whose responses are neither authenticated as that provider
        // nor protected in transit, and a date-suffixed model id arriving from one is exactly the
        // wrong-resident signal the surrounding assertion exists to catch. Dropping this check
        // alongside the old shape heuristic is what let `http://api.openai.com/v1` inherit the
        // tolerance it never earned.
        return url.protocol === 'https:' &&
            DATE_ALIAS_CONTRACT_HOSTS.has(url.hostname.replace(/^\[|\]$/g, '').toLowerCase())
    } catch {
        return false
    }
}

/**
 * @summary Normalizes a provider model identifier for comparison.
 * @param {*} value Candidate model identifier.
 * @returns {String} Trimmed identifier, or an empty string for a missing/non-string value.
 */
function normalizeModelId(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * @summary Compares a requested model with the model reported by the provider.
 * @param {String} requested Requested model identifier.
 * @param {String} served Model identifier reported by the provider.
 * @param {Object} [options] Comparison policy.
 * @param {Boolean} [options.allowDateAlias=false] Whether the endpoint's contract permits a hosted date suffix.
 * @returns {Boolean} True when the served identifier is admissible.
 */
function servedModelMatchesRequested(requested, served, {allowDateAlias = false} = {}) {
    const requestedId = normalizeModelId(requested),
          servedId    = normalizeModelId(served);

    if (!requestedId || !servedId) {
        return false;
    }

    if (requestedId === servedId) {
        return true;
    }

    return allowDateAlias &&
        HOSTED_MODEL_DATE_SUFFIX_RE.test(servedId) &&
        servedId.replace(HOSTED_MODEL_DATE_SUFFIX_RE, '') === requestedId;
}

/**
 * @summary Creates the typed error for a provider model-identity disagreement.
 * @param {Object} options Error context.
 * @param {String} options.provider Provider id.
 * @param {String} options.lane Response lane.
 * @param {String} options.requested Requested model identifier.
 * @param {String} options.served Served model identifier.
 * @param {String} options.host Provider host.
 * @param {String} options.modelName Provider model id.
 * @returns {Error} Error carrying `MODEL_MISMATCH` and bounded identity fields.
 */
function createModelMismatchError({provider, lane, requested, served, host, modelName}) {
    const error = new Error(
        `[${provider}] ${lane} response served model '${served}' for requested model '${requested}' (host=${host}, model=${modelName})`
    );

    error.code      = MODEL_MISMATCH_CODE;
    error.provider  = provider;
    error.lane      = lane;
    error.requested = requested;
    error.served    = served;

    return error;
}

/**
 * @summary Warns once per provider/lane/model when a response omits its model field.
 * @param {Object} options Warning context.
 * @param {String} options.provider Provider id.
 * @param {String} options.lane Response lane.
 * @param {String} options.requested Requested model identifier.
 * @param {Function} [options.log] Optional bounded logger.
 * @returns {Boolean} True when this call emitted the warning.
 */
function warnMissingServedModel({provider, lane, requested, log}) {
    const key = `${provider}|${lane}|${normalizeModelId(requested)}`;

    if (missingServedModelWarningKeys.has(key)) {
        return false;
    }

    missingServedModelWarningKeys.add(key);

    const write = typeof log === 'function' ? log : (...args) => console.warn(...args);

    write(`[${provider}] ${lane} response did not include model; requested='${requested}'; identity not asserted.`);

    return true;
}

/**
 * @summary Asserts a present served model against the requested provider model.
 * @param {Object} options Assertion context.
 * @param {Object} options.payload Parsed provider response.
 * @param {String} options.provider Provider id.
 * @param {String} options.lane Response lane.
 * @param {String} options.requested Requested model identifier.
 * @param {String} options.host Provider host.
 * @param {String} options.modelName Provider model id.
 * @param {Boolean} [options.allowDateAlias=false] Whether hosted date aliases are admissible.
 * @param {Function} [options.log] Optional bounded logger for an absent model field.
 * @returns {String|null} The normalized served id, or null when the field is absent.
 * @throws {Error} `MODEL_MISMATCH` when a present served id is not admissible.
 */
function assertServedModel({payload, provider, lane, requested, host, modelName, allowDateAlias = false, log}) {
    const served = normalizeModelId(payload?.model);

    if (!served) {
        warnMissingServedModel({provider, lane, requested, log});
        return null;
    }

    if (!servedModelMatchesRequested(requested, served, {allowDateAlias})) {
        throw createModelMismatchError({provider, lane, requested, served, host, modelName});
    }

    return served;
}

/**
 * The three codes this module mints. Module-private for the reason {@link Neo.ai.provider.createTimeoutError}
 * gives: an exported Set is a shared mutable classifier; the predicate is the only thing that crosses.
 * @type {Set<String>}
 */
const PROVIDER_STREAM_FAILURE_CODES = Object.freeze(new Set([
    PROVIDER_STREAM_ERROR_CODE,
    REASONING_ONLY_RESPONSE_CODE,
    MODEL_MISMATCH_CODE
]));

/**
 * @summary Whether an error code names one of the three provider response failures this module mints.
 *
 * Deliberately narrow, like {@link isProviderTimeoutCode}: it answers "did the provider response fail
 * at this boundary", nothing else. A consumer that also treats timeouts as provider failures composes
 * this with `isProviderTimeoutCode` rather than widening either.
 *
 * @param {String|undefined|null} code The `error.code` to classify.
 * @returns {Boolean} `true` only for `PROVIDER_STREAM_ERROR`, `REASONING_ONLY_RESPONSE`, or `MODEL_MISMATCH`.
 */
function isProviderStreamFailureCode(code) {
    return PROVIDER_STREAM_FAILURE_CODES.has(code);
}

/**
 * @summary Whether an error code names a served-model identity mismatch.
 * @param {String|undefined|null} code The `error.code` to classify.
 * @returns {Boolean} True only for `MODEL_MISMATCH`.
 */
function isModelMismatchCode(code) {
    return code === MODEL_MISMATCH_CODE;
}

export {
    MODEL_MISMATCH_CODE,
    PROVIDER_STREAM_ERROR_CODE,
    REASONING_ONLY_RESPONSE_CODE,
    assertServedModel,
    createModelMismatchError,
    createProviderStreamError,
    createReasoningOnlyResponseError,
    hostedModelAliasesAllowed,
    isModelMismatchCode,
    isProviderStreamFailureCode,
    servedModelMatchesRequested
};

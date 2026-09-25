/**
 * @summary Shared provider contract for a stream that ended without a usable answer.
 *
 * Two endings used to reach a caller as an empty string with nothing thrown, so the caller filed them
 * under whatever its empty-response branch assumes (the Tri-Vector extractor: `context-overflow`): an
 * error frame inside a 200 stream (LM Studio refusing a JSON schema: `{"error":{"message":"ValueError:
 * 'type' must be a string"}}`), and a reasoning model whose chat template streams the entire answer on
 * the reasoning channel (LM Studio serving Qwen3.6: every token in `delta.reasoning_content`,
 * `delta.content` empty until `finish_reason: length`). The OpenAI-compatible transport throws both
 * from here with a uniform `error.code`, the shape {@link Neo.ai.provider.createTimeoutError} set for
 * timeouts, so a consumer detects the ending structurally instead of by message wording; the Ollama
 * transport (`message.thinking`, ndjson `error` lines) can adopt the same two codes.
 *
 * @module Neo.ai.provider.createStreamFailureError
 */

/**
 * Caller-detectable code for a completion whose every token went to the reasoning channel.
 * @type {String}
 */
const REASONING_ONLY_RESPONSE_CODE = 'REASONING_ONLY_RESPONSE';

const MODEL_MISMATCH_CODE = 'MODEL_MISMATCH';

const HOSTED_MODEL_DATE_SUFFIX_RE = /-\d{4}-\d{2}-\d{2}$/;

const missingServedModelWarningKeys = new Set();

/**
 * Caller-detectable code for an error the provider reported inside an otherwise successful response.
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

function normalizeModelId(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function servedModelMatchesRequested(requested, served) {
    const requestedId = normalizeModelId(requested),
          servedId    = normalizeModelId(served);

    if (!requestedId || !servedId) {
        return false;
    }

    if (requestedId === servedId) {
        return true;
    }

    return HOSTED_MODEL_DATE_SUFFIX_RE.test(servedId) &&
        servedId.replace(HOSTED_MODEL_DATE_SUFFIX_RE, '') === requestedId;
}

function createModelMismatchError({
    provider,
    lane,
    requested,
    served,
    host,
    modelName,
    replacementRequired = false
}) {
    const error = new Error(
        `[${provider}] ${lane} response served model '${served}' for requested model '${requested}' (host=${host}, model=${modelName})`
    );

    error.code      = MODEL_MISMATCH_CODE;
    error.provider  = provider;
    error.lane      = lane;
    error.requested = requested;
    error.served    = served;

    if (replacementRequired) {
        error.action = 'replacement-required';
        error.operatorDiagnostic = {
            code   : 'LMS_REPLACEMENT_REQUIRED',
            summary: `LM Studio served model '${served}' for requested model '${requested}'; unload the served model and load the requested model before retrying`.slice(0, 1600)
        };
    }

    return error;
}

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

function assertServedModel({
    payload,
    provider,
    lane,
    requested,
    host,
    modelName,
    replacementRequired = false,
    log
}) {
    const served = normalizeModelId(payload?.model);

    if (!served) {
        warnMissingServedModel({provider, lane, requested, log});
        return null;
    }

    if (!servedModelMatchesRequested(requested, served)) {
        throw createModelMismatchError({
            provider,
            lane,
            requested,
            served,
            host,
            modelName,
            replacementRequired
        });
    }

    return served;
}

/**
 * The two codes this module mints. Module-private for the reason {@link Neo.ai.provider.createTimeoutError}
 * gives: an exported Set is a shared mutable classifier; the predicate is the only thing that crosses.
 * @type {Set<String>}
 */
const PROVIDER_STREAM_FAILURE_CODES = Object.freeze(new Set([
    PROVIDER_STREAM_ERROR_CODE,
    REASONING_ONLY_RESPONSE_CODE,
    MODEL_MISMATCH_CODE
]));

/**
 * @summary Whether an error code names one of the two stream endings this module mints.
 *
 * Deliberately narrow, like {@link isProviderTimeoutCode}: it answers "did the provider's stream end
 * without a usable answer", nothing else. A consumer that also treats timeouts as provider failures
 * composes this with `isProviderTimeoutCode` rather than widening either.
 *
 * @param {String|undefined|null} code The `error.code` to classify.
 * @returns {Boolean} `true` only for `PROVIDER_STREAM_ERROR` or `REASONING_ONLY_RESPONSE`.
 */
function isProviderStreamFailureCode(code) {
    return PROVIDER_STREAM_FAILURE_CODES.has(code);
}

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
    isModelMismatchCode,
    isProviderStreamFailureCode,
    servedModelMatchesRequested
};

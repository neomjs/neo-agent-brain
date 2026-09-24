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

/**
 * The two codes this module mints. Module-private for the reason {@link Neo.ai.provider.createTimeoutError}
 * gives: an exported Set is a shared mutable classifier; the predicate is the only thing that crosses.
 * @type {Set<String>}
 */
const PROVIDER_STREAM_FAILURE_CODES = Object.freeze(new Set([
    PROVIDER_STREAM_ERROR_CODE,
    REASONING_ONLY_RESPONSE_CODE
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

export {
    PROVIDER_STREAM_ERROR_CODE,
    REASONING_ONLY_RESPONSE_CODE,
    createProviderStreamError,
    createReasoningOnlyResponseError,
    isProviderStreamFailureCode
};

/**
 * @module ai/services/fleet/fleetGoldenPathSource
 * @summary Brain-side source for the Fleet cockpit's Golden Path pane — the computed route the
 * synthesizer wrote (`computed-route.json`, the `computed-route.v1` sidecar beside the handoff),
 * passed through under the producer's own status and freshness, beside the corpus-projection
 * admission that says whether that route may be read as current, and the REM pipeline counts
 * that explain a withheld one. Nothing is ranked, merged or synthesized here: the pane renders
 * the producer's route under the producer's word, or the honest reason why there is none.
 *
 * Three axes, each answering as itself: the sidecar (missing / unreadable / contract-invalid are
 * typed reasons, never an empty route presented as "nothing to do"), the admission (the same
 * contract `get_context_frontier` reads, for the `computed-golden-path` consumer), and the REM
 * state (read through the injected operation; a failed read is its own state).
 */

import fs                              from 'node:fs';
import {validateComputedRouteResult}   from '../graph/computedRouteResult.mjs';
import {
    CORPUS_PROJECTION_CONSUMER,
    evaluateCorpusProjectionAdmission
} from '../graph/corpusProjectionContract.mjs';
import {readCorpusProjectionReceipt}   from '../graph/corpusProjectionReceiptStore.mjs';
import {redactReadFailure}             from './redactReadFailure.mjs';

/**
 * @summary Coerce one ISO or epoch value to finite epoch milliseconds, or `null`.
 * @param {*} value
 * @returns {Number|null}
 * @private
 */
function toMsOrNull(value) {
    if (value === null || value === undefined || value === '') return null;

    const ms = typeof value === 'number' ? value : Date.parse(value);

    return Number.isFinite(ms) ? ms : null
}

/**
 * @summary Project one validated sidecar to the wire shape: the producer's status words and
 * timestamps, its provenance, and the items exactly as written (id, title, score, rank,
 * citations). No field is recomputed; `expired` is the one derived fact, and it names the
 * producer's own `expiresAt` against the read's clock.
 * @param {Object} result A `computed-route.v1` object that passed validation.
 * @param {Number} nowMs
 * @returns {Object}
 */
export function projectComputedRoute(result, nowMs) {
    const expiresAtMs = toMsOrNull(result.expiresAt);

    return {
        schemaVersion: result.schemaVersion,
        status       : result.status,
        freshness    : result.freshness ?? null,
        capturedAt   : result.capturedAt ?? null,
        expiresAt    : result.expiresAt ?? null,
        expired      : expiresAtMs === null ? null : expiresAtMs <= nowMs,
        routeVersion : result.routeVersion ?? null,
        provenance   : {
            producer        : result.provenance?.producer ?? null,
            runId           : result.provenance?.runId ?? null,
            algorithmVersion: result.provenance?.algorithmVersion ?? null
        },
        kind : result.route.kind,
        items: result.route.items.map(item => ({
            id       : item.id,
            title    : item.title,
            score    : typeof item.score === 'number' ? item.score : null,
            rank     : Number.isInteger(item.rank) ? item.rank : null,
            citations: Array.isArray(item.citations) ? item.citations : []
        }))
    }
}

/**
 * @summary Read the sidecar as one typed axis: `wired` with the projected route, or `degraded`
 * with the reason a route is absent — missing, unreadable, or outside the contract.
 * @param {String} routePath Absolute path of `computed-route.json`.
 * @param {Object} [seams]
 * @param {Function} [seams.exists]
 * @param {Function} [seams.readFile]
 * @param {Number} [seams.nowMs]
 * @returns {{state: String, reason: (String|null), detail: (String|undefined), route: (Object|null)}}
 */
export function readComputedRouteAxis(routePath, {exists = fs.existsSync, readFile = file => fs.readFileSync(file, 'utf-8'), nowMs = Date.now()} = {}) {
    if (typeof routePath !== 'string' || !routePath || !exists(routePath)) {
        return {state: 'degraded', reason: 'route-sidecar-missing', route: null}
    }

    let result;

    try {
        result = JSON.parse(readFile(routePath))
    } catch (error) {
        return {state: 'degraded', reason: 'route-sidecar-unreadable', detail: redactReadFailure(error) ?? undefined, route: null}
    }

    const {valid, errors} = validateComputedRouteResult(result);

    if (!valid) {
        return {state: 'degraded', reason: 'route-sidecar-invalid', detail: errors.join('; ').slice(0, 240), route: null}
    }

    return {state: 'wired', reason: null, route: projectComputedRoute(result, nowMs)}
}

/**
 * @summary Resolve the corpus-projection admission for the computed Golden Path — the same
 * contract the Context Frontier read applies, for this consumer. A disabled gate admits; an
 * unreadable receipt is evaluated as absent, which the contract refuses on its own terms.
 * @param {Object} options
 * @param {Object} options.config `aiConfig.orchestrator.corpusProjection` (enabled, receiptPath, sourceRepository, sourceRef).
 * @param {Function} [options.readReceipt]
 * @returns {Promise<Object>} `{admitted, fallback, reasonCode, requiredFacets, staleFacets}`
 */
export async function readProjectionAdmission({config, readReceipt = readCorpusProjectionReceipt} = {}) {
    if (!config?.enabled) {
        return {
            admitted      : true,
            fallback      : 'current',
            reasonCode    : 'projection-gate-disabled',
            requiredFacets: ['issues', 'discussions'],
            staleFacets   : []
        }
    }

    let receipt = null;

    try {
        receipt = await readReceipt(config.receiptPath)
    } catch (error) {
        console.warn(`[fleet] golden path: corpus projection receipt unavailable: ${redactReadFailure(error) ?? 'no legible error'}`)
    }

    return evaluateCorpusProjectionAdmission({
        consumer                : CORPUS_PROJECTION_CONSUMER.computedGoldenPath,
        receipt,
        expectedSourceRepository: config.sourceRepository,
        expectedSourceRef       : config.sourceRef
    })
}

/**
 * @summary Create one process-lifetime Golden Path source.
 * @param {Object} options
 * @param {String} options.routePath Absolute path of the synthesizer's `computed-route.json`.
 * @param {Object} options.projectionConfig The resolved `orchestrator.corpusProjection` config.
 * @param {Function} options.getRemPipelineState The Memory Core `get_rem_pipeline_state` operation.
 * @param {Function} [options.readReceipt]
 * @param {Function} [options.now]
 * @param {Function} [options.exists]
 * @param {Function} [options.readFile]
 * @returns {{readGoldenPath: Function}}
 */
export function createFleetGoldenPathSource({
    routePath,
    projectionConfig,
    getRemPipelineState,
    readReceipt = readCorpusProjectionReceipt,
    now         = () => Date.now(),
    exists,
    readFile
} = {}) {
    if (typeof routePath !== 'string' || !routePath) {
        throw new TypeError('fleet golden path: routePath must be a non-empty string')
    }

    if (typeof getRemPipelineState !== 'function') {
        throw new TypeError('fleet golden path: getRemPipelineState must be a function')
    }

    const readRemAxis = async () => {
        try {
            const state = await getRemPipelineState({});

            return {
                state : 'wired',
                reason: null,
                counts: {
                    undigested  : Number.isInteger(state?.undigested) ? state.undigested : null,
                    digested    : Number.isInteger(state?.digested)   ? state.digested   : null,
                    recentCycles: Array.isArray(state?.recentCycles)  ? state.recentCycles.length : null
                }
            }
        } catch (error) {
            const detail = redactReadFailure(error);

            console.warn(`[fleet] golden path rem read failed: ${detail ?? 'no legible error'}`);

            return {state: 'unavailable', reason: 'rem-read-failed', ...(detail ? {detail} : {}), counts: null}
        }
    };

    return {
        /**
         * @summary Read the Golden Path picture: the sidecar axis decides the envelope's
         * `capability` (`wired` when a contract-valid route was read, `degraded` otherwise, with
         * the axis's reason); the admission and the REM counts ride beside it so the pane can say
         * current / last known good / withheld with the producer's own timestamps.
         * @param {Object} [params] Reserved; the verb takes no caller input today.
         * @returns {Promise<Object>}
         */
        async readGoldenPath(params = {}) {
            const nowMs = toMsOrNull(now());

            if (nowMs === null) {
                throw new TypeError('fleet golden path: now must be a finite timestamp')
            }

            const
                capturedAt        = new Date(nowMs).toISOString(),
                routeAxis         = readComputedRouteAxis(routePath, {exists, readFile, nowMs}),
                [admission, rem]  = await Promise.all([
                    readProjectionAdmission({config: projectionConfig, readReceipt}),
                    readRemAxis()
                ]);

            return {
                capability: {
                    state: routeAxis.state,
                    capturedAt,
                    ...(routeAxis.state === 'wired' ? {} : {reason: routeAxis.reason})
                },
                admission,
                route  : routeAxis.route,
                rem    : rem.counts,
                sources: {
                    route: {state: routeAxis.state, reason: routeAxis.reason, ...(routeAxis.detail ? {detail: routeAxis.detail} : {})},
                    admission: {state: admission.admitted ? 'current' : 'withheld', reason: admission.reasonCode},
                    rem  : {state: rem.state, reason: rem.reason, ...(rem.detail ? {detail: rem.detail} : {})}
                }
            }
        }
    }
}

export default createFleetGoldenPathSource;

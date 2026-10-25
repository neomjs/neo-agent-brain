/**
 * @module ai/services/fleet/fleetGoldenPathSource
 * @summary Brain-side source for the Fleet cockpit's Golden Path pane — the computed route the
 * synthesizer wrote (`computed-route.json`, the `computed-route.v1` sidecar beside the handoff),
 * passed through under the producer's own status and freshness, beside the corpus-projection
 * admission that says whether that route may be read as current, and the REM pipeline counts
 * that explain a withheld one. The handoff's producer-written strategic recommendation is an
 * independent section-addressable axis: it is copied verbatim from the producer's Markdown and
 * carries the file reader's own update time and freshness. Nothing is ranked, merged or synthesized
 * here: the pane renders the producer's route under the producer's word, or the honest reason why
 * there is none.
 *
 * The reads cross the plane's operation boundary, like every other fleet source: the route and
 * its admission come from the Memory Core's `get_computed_route` (the process that mounts the
 * handoff volume; a fleet server on the host has no route file of its own), the REM state from
 * `get_rem_pipeline_state`, and the handoff content from `get_sandman_handoff`. Each axis answers
 * as itself — the operation's typed statuses (missing / unreadable / invalid) become degraded
 * reasons, a failed read is its own unavailable axis with a redacted detail — never an empty route
 * presented as "nothing to do".
 */

import {redactReadFailure} from './redactReadFailure.mjs';

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
 * @param {Object} result A `computed-route.v1` object the operation validated.
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
 * @summary Reduce one `get_computed_route` answer to the route axis: `wired` with the projected
 * route when the operation served a validated sidecar, `degraded` with the operation's own reason
 * otherwise. The admission rides the same answer and is passed through untouched.
 * @param {Object} payload The operation's `{status, reason, details, route, admission}`.
 * @param {Number} nowMs
 * @returns {{state: String, reason: (String|null), detail: (String|undefined), route: (Object|null), admission: (Object|null)}}
 */
export function reduceComputedRouteAnswer(payload, nowMs) {
    const admission = payload?.admission && typeof payload.admission === 'object' ? payload.admission : null;

    if (payload?.status === 'available' && payload.route?.route?.items) {
        return {state: 'wired', reason: null, route: projectComputedRoute(payload.route, nowMs), admission}
    }

    const detail = payload?.details?.errors?.join?.('; ') ?? payload?.details?.message;

    return {
        state : 'degraded',
        reason: typeof payload?.reason === 'string' && payload.reason ? payload.reason : 'route-answer-malformed',
        ...(typeof detail === 'string' && detail ? {detail: detail.slice(0, 240)} : {}),
        route : null,
        admission
    }
}

/**
 * @summary Extract the producer's complete strategic Golden Path section, preserving its exact
 * heading and Markdown through (but not including) the next level-two heading.
 * @param {*} markdown
 * @returns {String|null}
 * @private
 */
function extractGoldenPathHandoffSection(markdown) {
    if (typeof markdown !== 'string') return null;

    const heading = /^## Computed Golden Path \(Strategic Recommendation\)[ \t]*\r?$/m.exec(markdown);

    if (!heading) return null;

    const nextHeading = /^##(?!#)[ \t]+[^\r\n]*\r?$/gm;

    nextHeading.lastIndex = heading.index + heading[0].length;

    const next = nextHeading.exec(markdown);

    return markdown.slice(heading.index, next ? next.index : markdown.length)
}

/**
 * @summary Project the Memory Core handoff read onto its independent FM axis. Content without
 * the producer-owned section is degraded explicitly; file absence, operation failure and missing
 * wiring remain distinguishable, with no effect on the computed route or REM axes.
 * @param {*} payload The `get_sandman_handoff` result.
 * @returns {{markdown: (String|null), mtimeMs: (Number|null), ageMs: (Number|null), staleAfterMs: (Number|null), stale: (Boolean|null), reason: (String|null), state: String}}
 * @private
 */
function projectSandmanHandoff(payload) {
    const markdown = extractGoldenPathHandoffSection(payload?.content);
    let   reason   = null;

    if (!markdown) {
        reason = typeof payload?.content === 'string'
            ? 'handoff-section-not-found'
            : (typeof payload?.reason === 'string' && payload.reason) || 'handoff-content-unavailable'
    }

    const
        finiteOrNull = value => typeof value === 'number' && Number.isFinite(value) ? value : null,
        stale        = typeof payload?.stale === 'boolean' ? payload.stale : null;
    let state;

    if (markdown) {
        state = stale === true ? 'stale' : 'available'
    } else {
        state = reason === 'handoff-section-not-found' ? 'degraded' : 'unavailable'
    }

    return {
        markdown,
        mtimeMs     : finiteOrNull(payload?.mtimeMs),
        ageMs       : finiteOrNull(payload?.ageMs),
        staleAfterMs: finiteOrNull(payload?.staleAfterMs),
        stale,
        reason,
        state
    }
}

/**
 * @summary Create one process-lifetime Golden Path source.
 * @param {Object} options
 * @param {Function} options.getComputedRoute The Memory Core `get_computed_route` operation.
 * @param {Function} options.getRemPipelineState The Memory Core `get_rem_pipeline_state` operation.
 * @param {Function} [options.getSandmanHandoff] The Memory Core `get_sandman_handoff` operation.
 * @param {Function} [options.now]
 * @returns {{readGoldenPath: Function}}
 */
export function createFleetGoldenPathSource({getComputedRoute, getRemPipelineState, getSandmanHandoff, now = () => Date.now()} = {}) {
    if (typeof getComputedRoute !== 'function') {
        throw new TypeError('fleet golden path: getComputedRoute must be a function')
    }

    if (typeof getRemPipelineState !== 'function') {
        throw new TypeError('fleet golden path: getRemPipelineState must be a function')
    }

    const readRouteAxis = async nowMs => {
        try {
            return reduceComputedRouteAnswer(await getComputedRoute({}), nowMs)
        } catch (error) {
            const detail = redactReadFailure(error);

            console.warn(`[fleet] golden path route read failed: ${detail ?? 'no legible error'}`);

            return {state: 'unavailable', reason: 'route-read-failed', ...(detail ? {detail} : {}), route: null, admission: null}
        }
    };

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

    const readHandoffAxis = async () => {
        if (typeof getSandmanHandoff !== 'function') {
            return projectSandmanHandoff({reason: 'handoff-source-unwired'})
        }

        try {
            return projectSandmanHandoff(await getSandmanHandoff({sections: 'all'}))
        } catch (error) {
            const detail = redactReadFailure(error);

            console.warn(`[fleet] golden path handoff read failed: ${detail ?? 'no legible error'}`);

            return projectSandmanHandoff({reason: 'handoff-read-failed'})
        }
    };

    return {
        /**
         * @summary Read the Golden Path picture: the route axis decides the envelope's
         * `capability` (`wired` when the operation served a validated route, `degraded` when it
         * answered with a typed reason, `unavailable` when the read itself failed); the admission
         * and the REM counts ride beside it so the pane can say current / last known good /
         * withheld with the producer's own timestamps. The independent `handoff` field carries
         * the complete human-readable Golden Path section plus the handoff file's update/freshness
         * metadata; its staleness never changes the route capability.
         * @param {Object} [params] Reserved; the verb takes no caller input today.
         * @returns {Promise<Object>}
         */
        async readGoldenPath(params = {}) {
            const nowMs = toMsOrNull(now());

            if (nowMs === null) {
                throw new TypeError('fleet golden path: now must be a finite timestamp')
            }

            const
                capturedAt                = new Date(nowMs).toISOString(),
                [routeAxis, rem, handoff] = await Promise.all([readRouteAxis(nowMs), readRemAxis(), readHandoffAxis()]),
                admission                 = routeAxis.admission;

            return {
                capability: {
                    state: routeAxis.state,
                    capturedAt,
                    ...(routeAxis.state === 'wired' ? {} : {reason: routeAxis.reason})
                },
                admission,
                route  : routeAxis.route,
                rem    : rem.counts,
                handoff: {
                    markdown    : handoff.markdown,
                    mtimeMs     : handoff.mtimeMs,
                    ageMs       : handoff.ageMs,
                    staleAfterMs: handoff.staleAfterMs,
                    stale       : handoff.stale,
                    reason      : handoff.reason
                },
                sources: {
                    route    : {state: routeAxis.state, reason: routeAxis.reason, ...(routeAxis.detail ? {detail: routeAxis.detail} : {})},
                    admission: admission
                        ? {state: admission.admitted ? 'current' : 'withheld', reason: admission.reasonCode ?? null}
                        : {state: 'unavailable', reason: routeAxis.reason},
                    rem    : {state: rem.state, reason: rem.reason, ...(rem.detail ? {detail: rem.detail} : {})},
                    handoff: {state: handoff.state, reason: handoff.reason}
                }
            }
        }
    }
}

export default createFleetGoldenPathSource;

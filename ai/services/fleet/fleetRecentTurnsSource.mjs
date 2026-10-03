import {redactReadFailure} from './redactReadFailure.mjs';

/**
 * @module ai/services/fleet/fleetRecentTurnsSource
 * @summary Brain-side, viewer-bound source for the Fleet cockpit's THOUGHT STREAM: one seat's newest
 * turn summaries, as the single injected `query_recent_turns` operation answers them, passed through
 * as a typed, fail-honest envelope. The read asks for the widest a viewer may see of a peer — public
 * summaries under the `team` sharing policy — and the plane's own policy decides what comes back:
 * the envelope carries the operation's `memorySharing` verdict, so a plane that clamps the policy
 * reads as "shares no peer turns", never as a silent seat. Same discipline as the memories siblings:
 * no Fleet synthesis, ranking, cache, durable state, or permission simulation, and a failure
 * surfaces as an honest capability state, never a fabricated empty stream.
 */

const
    IDENTITY      = /^@[A-Za-z0-9][A-Za-z0-9._-]*$/,
    MAX_LIMIT     = 50,
    DEFAULT_LIMIT = 20;

/**
 * @summary Coerce one supported time value to finite epoch milliseconds.
 * @param {Date|String|Number} value
 * @param {String} name
 * @returns {Number}
 * @private
 */
function toMs(value, name) {
    const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);

    if (!Number.isFinite(ms)) {
        throw new TypeError(`fleet recent turns: ${name} must be a finite timestamp`)
    }

    return ms
}

/**
 * @summary Validate the page size. Absent resolves to the default; anything outside the closed
 * integer range is rejected rather than clamped.
 * @param {Number|undefined} limit
 * @returns {Number}
 * @private
 */
function validateLimit(limit) {
    if (limit === undefined) {
        return DEFAULT_LIMIT
    }

    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new TypeError(`fleet recent turns: limit must be an integer between 1 and ${MAX_LIMIT}`)
    }

    return limit
}

/**
 * @summary Validate the paging cursor: the operation's own `nextCursor`, handed back to read the
 * page before it. Absent resolves to `null`; any other shape is rejected rather than coerced, and
 * only the cursor's two fields ride on.
 * @param {Object|undefined|null} before `{timestamp, id}`
 * @returns {{timestamp: String, id: String}|null}
 * @private
 */
function validateBefore(before) {
    if (before === undefined || before === null) {
        return null
    }

    if (typeof before !== 'object' || typeof before.id !== 'string' || !before.id ||
        typeof before.timestamp !== 'string' || !Number.isFinite(Date.parse(before.timestamp))) {
        throw new TypeError('fleet recent turns: before must be the cursor {timestamp, id} a read answered')
    }

    return {timestamp: before.timestamp, id: before.id}
}

/**
 * @summary Create the process-lifetime Fleet recent-turns source.
 *
 * The transport-stamped viewer is resolved at EACH call. The target seat is an explicit identity
 * the caller names; the operation call carries the target, the page, and the read's fixed shape —
 * `memorySharing: 'team'` and `detail: 'summary'` — and nothing a client chose beside them: the
 * widened path serves public summaries only, and a client-picked policy has no honest second
 * value here.
 *
 * @param {Object} options
 * @param {Function} options.queryRecentTurns Injected `query_recent_turns` operation returning the
 *     parsed payload (`{count, turns, nextCursor, memorySharing}`).
 * @param {Function} options.resolveViewerIdentity Returns the transport-stamped canonical @identity.
 * @param {Function} [options.now] Clock returning a Date/epoch/ISO value.
 * @returns {{readRecentTurns: Function}}
 */
export function createFleetRecentTurnsSource({
    queryRecentTurns,
    resolveViewerIdentity,
    now = () => new Date()
} = {}) {
    if (typeof queryRecentTurns !== 'function' || typeof resolveViewerIdentity !== 'function' ||
        typeof now !== 'function') {
        throw new TypeError('createFleetRecentTurnsSource: queryRecentTurns, resolveViewerIdentity, and now are required')
    }

    const resolveViewer = async () => {
        const viewer = await resolveViewerIdentity();

        if (typeof viewer !== 'string' || !IDENTITY.test(viewer)) {
            throw new Error('fleet recent turns: authenticated ingress did not bind a canonical viewer identity')
        }

        return viewer
    };

    return {
        /**
         * @summary Read one page of a seat's newest turn summaries through the source-owned
         * operation. Success passes the operation's rows, its next cursor and its `memorySharing`
         * verdict through untouched under a `wired` capability; an operation failure or an
         * unrecognized payload becomes an `unavailable` envelope carrying zero rows — a wired
         * empty page is claimed ONLY when the operation itself answered one. A failure envelope
         * additionally carries a sanitized `detail` so the surface can say WHY beside the
         * constant reason.
         * @param {Object} params
         * @param {String} params.agentIdentity The seat whose turns to read, as a canonical @identity.
         * @param {Number} [params.limit] Page size, 1..50.
         * @param {Object} [params.before] The cursor a previous read answered (`{timestamp, id}`).
         * @returns {Promise<Object>}
         */
        async readRecentTurns(params = {}) {
            const
                viewer = await resolveViewer(),
                target = params?.agentIdentity;

            if (typeof target !== 'string' || !IDENTITY.test(target)) {
                throw new TypeError('fleet recent turns: agentIdentity must be a canonical @identity')
            }

            const
                limit      = validateLimit(params?.limit),
                before     = validateBefore(params?.before),
                capturedAt = new Date(toMs(now(), 'now')).toISOString(),
                shared     = {viewer, target, page: {limit, before}},
                empty      = {turns: [], count: 0, nextCursor: null, memorySharing: null};

            let result;

            try {
                result = await queryRecentTurns({
                    agentIdentity: target,
                    memorySharing: 'team',
                    detail       : 'summary',
                    limit,
                    ...(before ? {before} : {})
                })
            } catch (error) {
                const detail = redactReadFailure(error);

                // one fact, two consumers: the envelope carries it to the operator surface, the
                // warn is the fleet child's own server-side copy
                console.warn(`[fleet] recent turns read failed (${target}): ${detail ?? 'no legible error'}`);

                return {
                    capability: {state: 'unavailable', reason: 'recent-turns-read-failed', capturedAt, ...(detail ? {detail} : {})},
                    ...shared,
                    ...empty
                }
            }

            if (!result || typeof result !== 'object' || !Array.isArray(result.turns)) {
                return {
                    capability: {state: 'unavailable', reason: 'recent-turns-payload-unrecognized', capturedAt},
                    ...shared,
                    ...empty
                }
            }

            return {
                capability   : {state: 'wired', capturedAt},
                ...shared,
                turns        : result.turns,
                count        : Number.isFinite(result.count) ? result.count : result.turns.length,
                nextCursor   : result.nextCursor ?? null,
                memorySharing: result.memorySharing ?? null
            }
        }
    }
}

export default createFleetRecentTurnsSource;

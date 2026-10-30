/**
 * @summary The content of an idle-out nudge, and how it rides the pulse id.
 *
 * A heartbeat pulse is a GraphLog row without a payload column, so its content travels inside the
 * pulse id as `<source>.<base64url-JSON>`; the wake daemon decodes it and both digest renderers print
 * it. A nudge that says only "idle" is noise to the seat that receives it; one that quotes the seat's
 * own last `lane-state:` line, says how long it has been quiet and restates the sunset rule tells the
 * seat where it stood, so it can answer in one line if nothing moved.
 *
 * The sunset rule is derived from the receiver's gate constants rather than written as prose, so the
 * numbers the nudge quotes are the numbers the gate enforces.
 *
 * Pure except for `readLastLaneStateLine`, which reads outbound messages from an injected graph
 * handle: no Neo import, no config read, no write.
 *
 * @module ai/scripts/lifecycle/idleOutPulseSummary
 */
import {
    DEFAULT_CONTEXT_GATE_MAX_TOKENS,
    DEFAULT_CONTEXT_GATE_WARN_TOKENS
} from '../../daemons/wake/contextGatePolicy.mjs';

/**
 * The pulse-id prefix both renderers and the daemon's decoder branch on.
 * @type {String}
 */
export const IDLE_OUT_PULSE_SOURCE = 'idle-out-nudge';

/**
 * The longest lane-state line a pulse carries; the digest is typed into a harness prompt.
 * @type {Number}
 */
export const LANE_STATE_MAX_CHARS = 240;

/**
 * Matches the `lane-state:` declaration a seat ends its messages with.
 * @type {RegExp}
 */
export const LANE_STATE_PATTERN = /lane-state:\s*(.+)/i;

/**
 * @summary Bounds a lane-state line to {@link LANE_STATE_MAX_CHARS}.
 * @param {String} line
 * @returns {String}
 * @private
 */
function boundLaneState(line) {
    return line.length > LANE_STATE_MAX_CHARS ? `${line.slice(0, LANE_STATE_MAX_CHARS - 1)}…` : line
}

/**
 * @summary Formats a token count the way the gate's documentation quotes it.
 * @param {Number} tokens
 * @returns {String}
 * @private
 */
function formatTokens(tokens) {
    return `${Math.round(tokens / 1000)}k`
}

/**
 * @summary Finds the first `lane-state:` line in a list of texts, newest first.
 * @param {Array<String|null|undefined>} texts Message bodies and subjects, newest first.
 * @returns {String|null} The bounded `lane-state: …` line, or `null` when no text declares one.
 */
export function findLaneStateLine(texts = []) {
    for (const text of texts) {
        if (typeof text !== 'string') continue;

        for (const line of text.split(/\r?\n/)) {
            const match = line.match(LANE_STATE_PATTERN);

            if (match) return boundLaneState(`lane-state: ${match[1].trim()}`)
        }
    }

    return null
}

/**
 * @summary Reads the seat's newest declared lane-state line from its outbound messages — a sunset
 * self-DM is one of them.
 * @param {Object} db Open `better-sqlite3` handle on the graph store.
 * @param {String} identity Canonical `@<identity>`.
 * @param {Object} [options]
 * @param {Number} [options.limit=40] How many of the newest outbound messages to scan.
 * @returns {String|null}
 */
export function readLastLaneStateLine(db, identity, {limit = 40} = {}) {
    const rows = db.prepare(`
        SELECT json_extract(n.data, '$.properties.bodyText') AS bodyText,
               json_extract(n.data, '$.properties.subject')  AS subject
        FROM Edges e
        JOIN Nodes n ON n.id = e.source
        WHERE e.type = 'SENT_BY'
          AND e.target IN (?, ?)
          AND json_extract(n.data, '$.label') = 'MESSAGE'
        ORDER BY json_extract(n.data, '$.properties.sentAt') DESC
        LIMIT ?
    `).all(identity, identity.replace(/^@/, ''), limit);

    return findLaneStateLine(rows.flatMap(row => [row.bodyText, row.subject]))
}

/**
 * @summary Builds the structured summary an idle-out pulse carries.
 *
 * @param {Object} options
 * @param {String} options.identity The nudged seat.
 * @param {Number} [options.now=Date.now()] Injected clock.
 * @param {Number|null} [options.lastActivityAtMs=null] The seat's last known activity (epoch ms).
 * @param {String|null} [options.lastActivitySource=null] Which stamp won: `memory`, `turn-presence` or `message`.
 * @param {String|null} [options.laneState=null] The seat's newest `lane-state:` line.
 * @param {Number} [options.warnContextTokens=DEFAULT_CONTEXT_GATE_WARN_TOKENS] The gate's warn level.
 * @param {Number} [options.maxContextTokens=DEFAULT_CONTEXT_GATE_MAX_TOKENS] The gate's defer level.
 * @returns {{source: String, reason: String, nextAction: String, laneState: String|null,
 *     idleMinutes: Number|null, lastActivityAt: String|null, lastActivitySource: String|null, sunsetRule: String}}
 */
export function buildIdleOutPulseSummary({
    identity,
    now                = Date.now(),
    lastActivityAtMs   = null,
    lastActivitySource = null,
    laneState          = null,
    warnContextTokens  = DEFAULT_CONTEXT_GATE_WARN_TOKENS,
    maxContextTokens   = DEFAULT_CONTEXT_GATE_MAX_TOKENS
} = {}) {
    const known       = Number.isFinite(lastActivityAtMs),
          idleMinutes = known ? Math.max(0, Math.round((now - lastActivityAtMs) / 60000)) : null;

    return {
        source            : IDLE_OUT_PULSE_SOURCE,
        reason            : known ? `idle: ${idleMinutes} min since the last known activity` : `idle: no known activity for ${identity}`,
        nextAction        : 'run /post-review-pickup — own-PR changes, then requested reviews, then the next lane; answer in one line if nothing moved',
        laneState         : laneState || null,
        idleMinutes,
        lastActivityAt    : known ? new Date(lastActivityAtMs).toISOString() : null,
        lastActivitySource: lastActivitySource || null,
        sunsetRule        : `sunset at or below ${formatTokens(warnContextTokens)} tokens of context; wakes defer above ${formatTokens(maxContextTokens)}`
    }
}

/**
 * @summary Encodes a summary as the pulse id (`<source>.<base64url-JSON>`); base64url never carries
 * the `:` the pulse entity id reserves.
 * @param {Object} summary A {@link buildIdleOutPulseSummary} result.
 * @returns {String}
 */
export function encodeIdleOutPulseId(summary) {
    return `${IDLE_OUT_PULSE_SOURCE}.${Buffer.from(JSON.stringify(summary)).toString('base64url')}`
}

/**
 * @summary Builds and encodes the pulse id in one step.
 * @param {Object} options Forwarded to {@link buildIdleOutPulseSummary}.
 * @returns {String}
 */
export function buildIdleOutPulseId(options) {
    return encodeIdleOutPulseId(buildIdleOutPulseSummary(options))
}

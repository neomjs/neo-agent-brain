/**
 * @module ai/daemons/wake/sessionRotation
 * @summary The session-rotation contract between the plane's emitter and the host wake receiver:
 * one trigger, one envelope type, the human-input quiet window a typed rotation waits for, and the
 * emitter's verdicts over a seat's sunset receipt.
 *
 * A seat that writes its sunset handover continues in a fresh session opened through the signed
 * channel its wakes use, but never through a wake route. A `SESSION_ROTATE` subscription publishes a
 * route that admits only `session/rotate` envelopes, and every other route admits only `wake/digest`.
 * So a rotation cannot be typed into a seat as a wake, and a wake digest cannot open a session.
 *
 * **Why typing waits for a pause, and only briefly.** A typed delivery races a person using the same
 * computer: the frontmost assertion catches focus lost before a keystroke batch, while focus lost between
 * a check and a keystroke sends the text to another window. So a rotation types at a pause in keyboard and
 * pointer, and an unreadable idle clock defers rather than guessing. It waits for that pause only
 * {@link ROTATION_MAX_AGE_MS}: a sunset is terminal and its fresh session starts at once, while every
 * minute of waiting lets wakes reach a session that has ended and lets a person restart the seat by hand,
 * after which a late rotation is a second live session of the seat.
 *
 * Pure (no fs, spawn or timers), so Memory Core, the manifest builder, the receiver and its adapters
 * share one fact set without widening any of their dependency closures. The rotation lane and the wake
 * hold read the same verdicts, so the plane never holds a seat's wakes for a receipt it will not rotate.
 *
 * @see ai/daemons/orchestrator/scheduling/sessionRotation.mjs
 * @see ai/daemons/wake/receiver.mjs
 * @see ai/daemons/wake/localWakeAdapters.mjs
 * @see ai/daemons/wake/buildReceiverManifest.mjs
 */

/**
 * The subscription trigger whose route carries rotations. No wake evaluator matches it
 * (`wakeCoalescePolicy.mjs` matches its triggers by name), so it never receives a digest.
 * @type {String}
 */
export const SESSION_ROTATE_TRIGGER = 'SESSION_ROTATE';

/**
 * The envelope type a rotation route admits.
 * @type {String}
 */
export const SESSION_ROTATE_EVENT_TYPE = 'session/rotate';

/**
 * The envelope type every route without an `admits` field admits: the wake digest.
 * @type {String}
 */
export const WAKE_DIGEST_EVENT_TYPE = 'wake/digest';

/**
 * How long the host's keyboard and pointer must be untouched before a rotation types: a pause between
 * bursts, so the activation never takes focus from a person mid-keystroke.
 * @type {Number}
 */
export const HUMAN_INPUT_QUIET_MS = 3 * 1000;

/**
 * How long after the receiver accepted a rotation it may still type it. Past it the rotation fails
 * without a keystroke (`session-rotate-expired`): a late session is a copy, not a recovery.
 * @type {Number}
 */
export const ROTATION_MAX_AGE_MS = 60 * 1000;

/**
 * How soon the receiver asks a deferred rotation again, instead of at its next periodic re-drain.
 * @type {Number}
 */
export const ROTATION_RETRY_MS = 1000;

/**
 * Defer reason: the seat's window lost the front before the first keystroke, so nothing was typed and
 * the rotation may try again inside its age.
 * @type {String}
 */
export const ROTATION_ACTIVATION_LOST = 'activation-lost';

/**
 * Failure reason: the rotation reached its fresh-session keystroke after {@link ROTATION_MAX_AGE_MS}.
 * It opens no session, because the seat may have been restarted by hand since.
 * @type {String}
 */
export const ROTATION_EXPIRED = 'session-rotate-expired';

/**
 * Failure reason: the receiver stopped waiting for this attempt (its timeout fired), so work that
 * settles later opens no session.
 * @type {String}
 */
export const ROTATION_ABORTED = 'session-rotate-aborted';

/**
 * Failure reason: another session claimed the seat ({@link seatHolderKey}) after the rotation's first
 * attempt, so a fresh session would be a second live session of the seat.
 * @type {String}
 */
export const ROTATION_SUPERSEDED = 'session-rotate-superseded';

/**
 * Defer reason: a person used the keyboard or pointer within {@link HUMAN_INPUT_QUIET_MS}.
 * @type {String}
 */
export const HUMAN_INPUT_ACTIVE = 'human-input-active';

/**
 * Defer reason: the idle clock could not be read, so the rotation waits rather than guesses.
 * @type {String}
 */
export const HUMAN_INPUT_UNKNOWN = 'human-input-unknown';

/**
 * @summary The envelope type a subscription's route admits, or `null` for the wake default.
 * @param {Object} subscription A `WAKE_SUBSCRIPTION` record.
 * @param {String} [subscription.trigger]
 * @returns {String|null} `session/rotate` for a rotation route, else `null` (the manifest omits the field).
 */
export function admittedEventType({trigger} = {}) {
    return trigger === SESSION_ROTATE_TRIGGER ? SESSION_ROTATE_EVENT_TYPE : null
}

/**
 * @summary The envelope type a published route admits.
 * @param {Object} route A receiver manifest route.
 * @returns {String} The route's `admits`, defaulting to `wake/digest`.
 */
export function routeAdmits(route) {
    return route?.admits || WAKE_DIGEST_EVENT_TYPE
}

/**
 * @summary Whether an envelope asks for a fresh session rather than delivering a wake.
 * @param {Object} envelope A signed Shape-B envelope.
 * @returns {Boolean}
 */
export function isSessionRotation(envelope) {
    return envelope?.eventType === SESSION_ROTATE_EVENT_TYPE
}

/**
 * @summary The one event id a rotation for this receipt may carry, so a re-emission is the same record.
 * @param {String} receiptMessageId The sunset handover's message id.
 * @returns {String}
 */
export function rotationEventId(receiptMessageId) {
    return `session-rotate:${receiptMessageId}`
}

/**
 * @summary Whether a rotation names its receipt and carries that receipt's event id.
 *
 * The receiver keys its records by event id, so an id chosen apart from the receipt would let one
 * handover open two sessions.
 *
 * @param {Object} envelope A `session/rotate` envelope.
 * @returns {Boolean}
 */
export function hasReceiptIdentity(envelope) {
    const receipt = envelope?.payload?.receiptMessageId;

    return typeof receipt === 'string' && receipt.length > 0 && envelope.eventId === rotationEventId(receipt)
}

/**
 * @summary The first prompt a rotation types into the fresh session, or `null` when it carries none.
 * @param {Object} envelope A `session/rotate` envelope.
 * @returns {String|null}
 */
export function rotationPrompt(envelope) {
    const prompt = envelope?.payload?.prompt;

    return typeof prompt === 'string' && prompt.trim() ? prompt : null
}

/**
 * @summary Decides whether a rotation may type now, from the host's human-input idle time.
 * @param {Number|null} idleMs Milliseconds since the last keyboard or pointer input, `null` when unreadable.
 * @returns {{action: 'type'}|{action: 'defer', reason: String}}
 */
export function evaluateHumanInput(idleMs) {
    if (!Number.isFinite(idleMs)) return {action: 'defer', reason: HUMAN_INPUT_UNKNOWN};
    if (idleMs < HUMAN_INPUT_QUIET_MS) return {action: 'defer', reason: HUMAN_INPUT_ACTIVE};

    return {action: 'type'}
}

/**
 * @summary Whether a deferred outcome waited for a person rather than for a dialog.
 * @param {String} [reason] The adapter's `outcomeReason`.
 * @returns {Boolean}
 */
export function isHumanInputDefer(reason) {
    return reason === HUMAN_INPUT_ACTIVE || reason === HUMAN_INPUT_UNKNOWN
}

/**
 * @summary Whether a rotation the receiver accepted at `acceptedAt` is too old to type. An unreadable
 * accept time is too old: a rotation that cannot be aged cannot be shown to be on time.
 * @param {String} acceptedAt The receiver record's accept time.
 * @param {Number} now
 * @returns {Boolean}
 */
export function isRotationExpired(acceptedAt, now) {
    return !(now < rotationDeadline(acceptedAt))
}

/**
 * @summary The last moment a rotation the receiver accepted at `acceptedAt` may open its session.
 * @param {String} acceptedAt The receiver record's accept time.
 * @returns {Number} Epoch ms, `NaN` for an unreadable accept time (never on time).
 */
export function rotationDeadline(acceptedAt) {
    return Date.parse(acceptedAt) + ROTATION_MAX_AGE_MS
}

/**
 * @summary The session that holds a Claude seat, from the wake listener's record: the session the seat's
 * last prompt claimed it for. A session someone opens claims the seat on its first prompt, so a holder
 * that changed since a rotation's first attempt names a successor the rotation must not duplicate.
 * @param {Object|null} record The listener record (`wakeListenerHook.mjs`).
 * @returns {String|null} `<sessionId>#<pid>`, or `null` without a readable holder.
 */
export function seatHolderKey(record) {
    const owner = record?.owner;

    return typeof owner?.sessionId === 'string' && owner.sessionId ? `${owner.sessionId}#${owner.session?.pid ?? ''}` : null
}

/**
 * @summary Whether a failed delivery script stopped before its first keystroke. The activation phase
 * asserts `"after activation"`, and every keystroke comes after it, so such a failure typed nothing.
 * @param {String} [reason] The adapter's `outcomeReason`: the script's error text.
 * @returns {Boolean}
 */
export function isPreKeystrokeFailure(reason) {
    return /after activation/.test(String(reason ?? ''))
}

/**
 * The reason every rotation carries: the seat ended its session by writing a sunset handover.
 * @type {String}
 */
export const SESSION_ROTATION_REASON = 'sunset_restart';

/**
 * The states of a receipt's `sessionRotation` record after which nothing more happens for it.
 * @type {String[]}
 */
export const TERMINAL_ROTATION_STATES = Object.freeze(['completed', 'incomplete', 'refused']);

/**
 * The tag of the quiet self-DM a fresh session sends in reply to the handover it continues
 * (`context-recovery` step 1a). The marker names the successor, not a Memory Core session id: an MCP
 * reconnect mints a new id inside the old transcript.
 * @type {String}
 */
export const SUNSET_SUCCESSOR_TAG = 'sunset-successor';

/**
 * @summary The first prompt the receiver types into the fresh session. It names the successor marker,
 * so the rotation completes even where the session's `context-recovery` does not send one yet.
 * @param {Object} options
 * @param {String} options.agentIdentity The seat, `@<identity>`.
 * @param {String} options.receiptMessageId The sunset handover the session continues from.
 * @param {Object} options.operatorPresence `{mode, until}` from the plane's operator record.
 * @returns {String}
 */
export function buildRotationPrompt({agentIdentity, receiptMessageId, operatorPresence}) {
    const until = operatorPresence.mode === 'away' && operatorPresence.until ? ` until ${operatorPresence.until}` : '';

    return `/context-recovery Fresh session for ${agentIdentity}, opened by the plane after your sunset handover ${receiptMessageId}: read it first, then send the quiet [sunset successor] self-DM tagged ${SUNSET_SUCCESSOR_TAG} with inReplyTo ${receiptMessageId}. The operator is ${operatorPresence.mode}${until}.`
}

/**
 * @summary The signed rotation envelope for one receipt, addressed to the seat's `SESSION_ROTATE` route.
 * Its event id is the receipt's, so a re-emission is the receiver's duplicate, never a second session.
 * @param {Object} options
 * @param {Object} options.subscription The route: `{id, properties: {agentIdentity}}`.
 * @param {String} options.receiptMessageId
 * @param {String|null} options.oldSessionId
 * @param {String} options.prompt
 * @param {String} options.emittedAt
 * @returns {Object}
 */
export function buildRotationEnvelope({subscription, receiptMessageId, oldSessionId, prompt, emittedAt}) {
    return {
        schemaVersion : '1.0',
        eventType     : SESSION_ROTATE_EVENT_TYPE,
        eventId       : rotationEventId(receiptMessageId),
        agentIdentity : subscription.properties.agentIdentity,
        subscriptionId: subscription.id,
        payload       : {receiptMessageId, oldSessionId, reason: SESSION_ROTATION_REASON, prompt},
        emittedAt
    }
}

/**
 * @summary Whether a receipt still waits for its fresh session: not settled, and no prompt or successor
 * marker has answered it. A prompt after the receipt is a person at the old session or the fresh
 * session's first prompt; either way the old session is no longer the one to wait on.
 * @param {Object|null} read `readSunsetReceipt`'s answer.
 * @returns {Boolean}
 */
export function isReceiptOpen(read) {
    return !!read &&
        !TERMINAL_ROTATION_STATES.includes(read.receipt.sessionRotation?.state) &&
        !read.promptedTurnAt &&
        !read.successor
}

/**
 * @summary Whether the plane holds a seat's wakes: an open receipt, a route that can rotate the seat,
 * and the receipt inside its window.
 *
 * Every wake delivered after a receipt starts a full-context turn in a session that has ended, and
 * that turn can only refuse. Held, the wakes stay unread and reach the fresh session, which inherits
 * the seat's watermark. The window bounds the hold: a rotation that never completes releases the
 * wakes to the old session rather than leaving the seat unreachable.
 *
 * @param {Object} options
 * @param {Object|null} options.read `readSunsetReceipt`'s answer.
 * @param {Boolean} options.hasRotationRoute
 * @param {Number} options.now
 * @param {Number} options.windowMs
 * @returns {Boolean}
 */
export function holdsWakes({read, hasRotationRoute, now, windowMs}) {
    return hasRotationRoute && isReceiptOpen(read) && now - Date.parse(read.receipt.sentAt) < windowMs
}

/**
 * @summary Decides what the rotation lane does with one seat's receipt on this run.
 *
 * - `request`: send the rotation (a first send, or a re-send of one the receiver never accepted:
 *   the event id makes it the same record). A re-send passes the prompt and live-turn guards again,
 *   since a person may resume the old session after a first send failed.
 * - `complete`: a successor marker replies to the receipt since the request. A Memory Core session id
 *   that changes inside the old transcript is no successor.
 * - `refuse`: the receipt never gets a rotation, with the reason recorded on it. `writer-unproven`: sent
 *   within `windowMs` of a predecessor's successor marker by a writer not proven to be a new session.
 * - `incomplete`: the window passed without a fresh session.
 * - `wait`: nothing to do yet (the turn that wrote the receipt is still live, or the receiver has the
 *   request).
 * - `none`: no receipt, or one already settled.
 *
 * The receipt count never holds a rotation: the read always carries counts or `'missing'`, and both
 * rotate. The context size is never an input: the seat chose to end.
 *
 * @param {Object} options
 * @param {Object|null} options.read `readSunsetReceipt`'s answer.
 * @param {Number} options.now
 * @param {Number} options.windowMs How long a receipt may stay open, counted from its `sentAt`.
 * @param {Number} options.minIntervalMs Minimum time between two rotation requests of one seat.
 * @returns {{action: String, reason?: String}}
 */
export function decideRotation({read, now, windowMs, minIntervalMs}) {
    const rotation = read?.receipt.sessionRotation;

    if (!read || TERMINAL_ROTATION_STATES.includes(rotation?.state)) return {action: 'none'};

    const pastWindow = now - Date.parse(read.receipt.sentAt) >= windowMs;

    if (rotation) {
        if (read.successor)       return {action: 'complete'};
        if (pastWindow)           return {action: 'incomplete', reason: rotation.deliveredAt ? 'no-fresh-session' : 'undelivered'};
        if (rotation.deliveredAt) return {action: 'wait', reason: 'receiver-has-request'};
        // a re-send answers to the guards a first send answers to
        if (read.promptedTurnAt)  return {action: 'refuse', reason: 'prompted-after-receipt'};
        if (read.liveTurnUntil)   return {action: 'wait', reason: 'live-turn'};

        return {action: 'request'}
    }

    // inside the window after a successor appeared, only a provably new writer may rotate the seat again
    if (read.predecessor && !read.predecessor.writerProven && Date.parse(read.receipt.sentAt) - Date.parse(read.predecessor.successorAt) < windowMs) {
        return {action: 'refuse', reason: 'writer-unproven'}
    }
    if (read.promptedTurnAt)            return {action: 'refuse', reason: 'prompted-after-receipt'};
    if (read.successor)                 return {action: 'refuse', reason: 'successor-present'};
    if (pastWindow)                     return {action: 'incomplete', reason: 'receipt-not-consumed'};
    if (read.lastRequestedAt && now - Date.parse(read.lastRequestedAt) < minIntervalMs) {
        return {action: 'refuse', reason: 'minimum-interval'}
    }
    if (read.liveTurnUntil) return {action: 'wait', reason: 'live-turn'};

    return {action: 'request'}
}

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
 * **Why typing waits for a quiet keyboard.** A typed delivery races a person using the same computer:
 * the frontmost assertion catches focus lost before a keystroke batch, while focus lost between a check
 * and a keystroke sends the text to another window. A rotation types a whole
 * boot prompt and submits it, so it starts only after a quiet minute of keyboard and pointer, and an
 * unreadable idle clock defers rather than guessing.
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
 * How long the host's keyboard and pointer must be untouched before a rotation types. Sized to the
 * receiver's 60 s re-drain, so a deferred rotation is re-asked once per quiet window.
 * @type {Number}
 */
export const HUMAN_INPUT_QUIET_MS = 60 * 1000;

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
 * How many times a rotation may defer for human input before it surfaces as failed: about two hours of
 * re-drains. A dialog clears in seconds and keeps its own, shorter bound; a working person does not.
 * @type {Number}
 */
export const HUMAN_INPUT_DEFER_BOUND = 120;

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
 * @summary The first prompt the receiver types into the fresh session.
 * @param {Object} options
 * @param {String} options.agentIdentity The seat, `@<identity>`.
 * @param {String} options.receiptMessageId The sunset handover the session continues from.
 * @param {Object} options.operatorPresence `{mode, until}` from the plane's operator record.
 * @returns {String}
 */
export function buildRotationPrompt({agentIdentity, receiptMessageId, operatorPresence}) {
    const until = operatorPresence.mode === 'away' && operatorPresence.until ? ` until ${operatorPresence.until}` : '';

    return `/context-recovery Fresh session for ${agentIdentity}, opened by the plane after your sunset handover ${receiptMessageId}: read it first. The operator is ${operatorPresence.mode}${until}.`
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
 * @summary Whether a receipt still waits for its fresh session: not settled, and no prompt or newer
 * session has answered it. A prompt after the receipt is a person at the old session or the fresh
 * session's first prompt; either way the old session is no longer the one to wait on.
 * @param {Object|null} read `readSunsetReceipt`'s answer.
 * @returns {Boolean}
 */
export function isReceiptOpen(read) {
    return !!read &&
        !TERMINAL_ROTATION_STATES.includes(read.receipt.sessionRotation?.state) &&
        !read.promptedTurnAt &&
        !read.newerSession
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
 *   the event id makes it the same record).
 * - `complete`: a session other than the old one has saved a memory since the request.
 * - `refuse`: the receipt never gets a rotation, with the reason recorded on it.
 * - `incomplete`: the window passed without a fresh session.
 * - `wait`: nothing to do yet (the receipt count is not consumed, the turn that wrote the receipt is
 *   still live, or the receiver has the request).
 * - `none`: no receipt, or one already settled.
 *
 * The receipt count is read from `focusItemsReceipt`: counts or `'missing'` rotate, an absent
 * count waits for the summary lane. The context size is never an input: the seat chose to end.
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
        if (read.newerSession)  return {action: 'complete'};
        if (pastWindow)         return {action: 'incomplete', reason: rotation.deliveredAt ? 'no-fresh-session' : 'undelivered'};
        if (!rotation.deliveredAt) return {action: 'request'};

        return {action: 'wait', reason: 'receiver-has-request'}
    }

    if (read.promptedTurnAt)            return {action: 'refuse', reason: 'prompted-after-receipt'};
    if (read.newerSession)              return {action: 'refuse', reason: 'newer-session'};
    if (pastWindow)                     return {action: 'incomplete', reason: 'receipt-not-consumed'};
    if (read.receipt.focusItemsReceipt === null) return {action: 'wait', reason: 'receipt-count-pending'};
    if (read.lastRequestedAt && now - Date.parse(read.lastRequestedAt) < minIntervalMs) {
        return {action: 'refuse', reason: 'minimum-interval'}
    }
    if (read.liveTurnUntil) return {action: 'wait', reason: 'live-turn'};

    return {action: 'request'}
}

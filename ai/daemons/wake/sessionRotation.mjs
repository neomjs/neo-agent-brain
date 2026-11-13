/**
 * @module ai/daemons/wake/sessionRotation
 * @summary The session-rotation contract between the plane's emitter and the host wake receiver:
 * one trigger, one envelope type, and the human-input quiet window a typed rotation waits for.
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
 * share one fact set without widening any of their dependency closures.
 *
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

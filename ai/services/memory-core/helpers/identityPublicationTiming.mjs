/**
 * @module ai/services/memory-core/helpers/identityPublicationTiming
 * @summary Chooses a prospective family boundary from the admission owner's clock sample.
 * Signed act time is provenance, not an input to this decision. Corrections retain their target's
 * interval and do not use this forward-transition rule. Fenced read-back activation is separate.
 */

/** @summary Requires a canonical nonnegative millisecond value without coercion. */
function timestamp(value) {
    return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

/**
 * @summary Requires a genuinely later admission time, never a synthesized or backdated boundary.
 * The physical owner calls this under serialization, AFTER current trust/expiry checks and lookup
 * of an already-accepted operation receipt. A retryable result must write neither state nor receipt.
 * This pure timing result does not verify authority, perform that lookup or grant a database write.
 * @param {Object} options
 * @param {Number} options.admittedAt The owner's actual shared-wall-clock sample for this attempt.
 * @param {Number|null} options.previousBoundary Last canonical boundary; explicit null for the first.
 * @returns {Object} The unchanged admissible timestamp, or a refusal naming the blocking boundary.
 */
export function resolveForwardFamilyBoundary({admittedAt, previousBoundary} = {}) {
    if (!timestamp(admittedAt) || previousBoundary !== null && !timestamp(previousBoundary)) {
        return Object.freeze({allowed: false, retryable: false, code: 'invalid-boundary-time'});
    }
    if (previousBoundary !== null && admittedAt <= previousBoundary) {
        return Object.freeze({allowed: false, retryable: true, code: 'forward-boundary-not-later',
            cause           : admittedAt === previousBoundary ? 'same-millisecond' : 'clock-regression',
            blockingBoundary: previousBoundary, admittedAt});
    }
    return Object.freeze({allowed: true, since: admittedAt});
}

/**
 * @module src/fleet/contract/seatLifecycle
 * @summary The words a seat's lifecycle record can hold, and what each obliges a cockpit to offer.
 * Data only: the Fleet writes these words (`ai/services/fleet/FleetLifecycleService`), its journal
 * codec accepts them, and a client maps them onto its own display vocabulary. A word outside these
 * lists is rejected evidence on both sides, never relabelled.
 */

/**
 * The states the Fleet writes. One line each: what it means, whether the seat is off, and which
 * control a cockpit offers for it.
 * - `running` — the seat process is alive and supervised; Stop.
 * - `stopping` — Stop was requested and the process is being signalled; Stop stays, no Start.
 * - `stopped` — no process: a completed Stop, an exit the Fleet observed, or no record yet; off; Start.
 * - `failed` — a Start or Stop ended in an error `failureReason` names (`cleanupUnresolved` while the
 *   helper cleanup is still owed); off; Start, which retries and re-proves.
 * - `unavailable` — the seat's harness cannot be launched on this host, `failureReason` says why; off;
 *   Start, which re-probes.
 * @type {ReadonlyArray<String>}
 */
export const SEAT_LIFECYCLE_STATES = Object.freeze(['running', 'stopping', 'stopped', 'failed', 'unavailable']);

/**
 * Words the journal codec still reads but no build writes: `exited` came from the first durable-custody
 * builds, and recovery re-persists it as `stopped`; a client reads it as off. It leaves with the next
 * snapshot version.
 * @type {ReadonlyArray<String>}
 */
export const SEAT_LIFECYCLE_READ_ONLY_STATES = Object.freeze(['exited']);

/**
 * The cockpit row producer's word for a supervised seat whose record names no state: rejected evidence,
 * never a state a control acts on.
 * @type {String}
 */
export const SEAT_LIFECYCLE_ROW_FALLBACK = 'unknown';

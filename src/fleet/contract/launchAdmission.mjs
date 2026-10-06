/**
 * @module src/fleet/contract/launchAdmission
 * @summary What a Claude Desktop seat card may say about native MCP launch admission: whether the seat's
 * Neo MCP servers can start new children, and why not.
 *
 * Desktop starts a profile row's MCP child itself, with a stripped environment, so each row runs Fleet's
 * fixed launcher. The launcher redeems a per-server grant from the Fleet's issuer before it starts the
 * server. The grants belong to one Desktop generation: one managed Start of one process. The Brain's
 * issuer produces every value below and the cockpit only renders them. Every vocabulary is closed, so a
 * consumer can switch on it.
 *
 * Admission concerns new children only. A child that already runs keeps the inputs it started with,
 * so a `stale` or `revoked` seat can still have working tools. Its card offers a managed restart; it
 * never says the tools are disconnected.
 */

/**
 * @summary The seat-level admission state.
 * - `none`: no generation. The seat is stopped, or it is not a Fleet-launched Claude Desktop seat.
 * - `reserved`: a managed Start is preparing or launching the seat. Its children wait for the outcome.
 * - `active`: new children of the running seat are admitted.
 * - `revoked`: the generation ended. `reason` says why, and no new child is admitted.
 * - `stale`: the seat runs, but this Fleet holds no generation for it, for example after a Fleet restart
 *   adopted it. New children refuse until a managed restart.
 * @type {Readonly<{NONE: String, RESERVED: String, ACTIVE: String, REVOKED: String, STALE: String}>}
 */
export const LAUNCH_ADMISSION_STATES = Object.freeze({
    NONE    : 'none',
    RESERVED: 'reserved',
    ACTIVE  : 'active',
    REVOKED : 'revoked',
    STALE   : 'stale'
});

/**
 * @summary Why a generation, or one server's grant, stopped admitting. Revocation is sticky: it lasts for
 * the rest of the generation, and only a new managed Start creates admission again.
 * @type {Readonly<Object<String, String>>}
 */
export const LAUNCH_ADMISSION_REASONS = Object.freeze({
    /** Stop was requested. Revocation precedes the signal and outlives a failed Stop. */
    STOP_REQUESTED    : 'stop-requested',
    /** The Start failed before its seat was launched and leased. */
    START_FAILED      : 'start-failed',
    /** The seat was launched but could not be leased, so Fleet stopped it. */
    LEASE_FAILED      : 'lease-failed',
    /** The seat's Desktop process exited or was found gone. */
    PROCESS_EXITED    : 'process-exited',
    /** The server was switched off. Switching it on again waits for a managed restart. */
    SERVER_DISABLED   : 'server-disabled',
    /** The seat's harness, MCP target or launch owner changed under the running generation. */
    PLAN_CHANGED      : 'plan-changed',
    /** The seat was removed from the registry. */
    AGENT_REMOVED     : 'agent-removed',
    /** A newer Start replaced this generation. */
    REPLACED          : 'replaced',
    /** This Fleet did not start the running seat, so it holds no generation for it. */
    ISSUER_REPLACED   : 'issuer-replaced',
    /** The Start held no value for one of the server's required inputs. */
    CREDENTIAL_MISSING: 'credential-missing'
});

/**
 * @summary One redemption's outcome as the issuer's audit records it.
 * @type {Readonly<{ADMITTED: String, REFUSED: String}>}
 */
export const LAUNCH_ADMISSION_OUTCOMES = Object.freeze({
    ADMITTED: 'admitted',
    REFUSED : 'refused'
});

/**
 * @summary Why a redemption was refused. The issuer records the codes up to `process-unknown`. The
 * launcher reports the last four itself, because they arise where no issuer answered or none can be
 * trusted. `revoked` carries the grant's revocation reason separately.
 * @type {Readonly<Object<String, String>>}
 */
export const LAUNCH_ADMISSION_REFUSALS = Object.freeze({
    /** The request did not match the protocol. */
    MALFORMED              : 'malformed',
    /** No grant of this issuer carries the request's id. */
    UNKNOWN_GRANT          : 'unknown-grant',
    /** The request's proof does not match the grant's secret. */
    PROOF_MISMATCH         : 'proof-mismatch',
    /** The grant belongs to another server than the row names. */
    SERVER_MISMATCH        : 'server-mismatch',
    /** The row names another identity than the grant was issued to. */
    IDENTITY_MISMATCH      : 'identity-mismatch',
    /** The grant or its generation was revoked. */
    REVOKED                : 'revoked',
    /** The Start that reserved the grant settled neither way within the issuer's bound. */
    PENDING_TIMEOUT        : 'pending-timeout',
    /** The seat's Desktop process answers but cannot be identified, so no new child starts. */
    PROCESS_UNKNOWN        : 'process-unknown',
    /** The launcher could not reach an issuer, for example after a Fleet restart. */
    ISSUER_UNAVAILABLE     : 'issuer-unavailable',
    /** An answer carried no valid proof of the issuer that holds the grant. */
    UNAUTHENTICATED        : 'unauthenticated-response',
    /** The admitted target is not one this launcher's installation carries. */
    TARGET_INVALID         : 'target-invalid',
    /** The admitted target could not be started. */
    SPAWN_FAILED           : 'spawn-failed'
});

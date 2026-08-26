/**
 * The Host-Edge realm's source-label vocabulary — the third TWIN of the Brain authority's
 * `FLEET_COCKPIT_SOURCES` (`cloud/services/fleet/fleetCockpitStatus.mjs`). Stable,
 * transport-agnostic labels naming which live substrate produced each row or event.
 *
 * ## Why a third twin exists
 *
 * The vocabulary's design premise, stated by its parity lint, is that **the realms deliberately
 * share no imports**: each realm carries labels it can read operable-cold, without dragging in the
 * Node-only bridge chain that the authority sits behind. Before the repository split there were two
 * realms — the Brain authority and the Body-side cockpit twin (`apps/agentos/config/cockpitSources.mjs`
 * in `neomjs/neo`).
 *
 * The split makes three. The authority is Cloud-planed, and Host-Edge consumers such as
 * {@link module:scripts/fleet/deriveFleetRoster} need the same labels. Importing the authority would
 * invert the one direction the plane split forbids (edge reaching into cloud); importing the Body
 * twin would be a cross-repository edge into the Engine. Neither is available, so the realm that
 * gained an independent existence gains its own twin — which is the pattern the vocabulary already
 * used, applied to the realm the cut created.
 *
 * ## Drift
 *
 * A new source is ONE registration in the Cloud authority, mirrored into every twin in the same
 * commit. `scripts/lint/lint-fleet-vocabulary-parity.mjs` is the binding check; it is aware of the
 * Cloud authority and the Body twin and must be taught this one before it can bind all three.
 *
 * @summary Operable-cold Host-Edge source-label twin.
 * @module scripts/fleet/cockpitSources
 */

/**
 * @type {Object}
 */
export const FLEET_COCKPIT_SOURCES = Object.freeze({
    activity   : 'fleet:activity-adapters',
    a2a        : 'memory-core:mailbox',
    githubPr   : 'github-workflow:pull-requests',
    githubIssue: 'github-workflow:issues',
    commentLane: 'github-workflow:issue-comments',
    graphLane  : 'graph:lane-state',
    graphStall : 'graph:work-stall',
    repoStatus : 'fleet:fleetStatus',
    roster     : 'fleet:listAgents',
    runtime    : 'fleet:runtimeStatus',
    lifecycle  : 'fleet:lifecycle',
    wake       : 'fleet:wakeState',
    throttle   : 'fleet:throttleState',
    presence   : 'fleet:presenceState'
});

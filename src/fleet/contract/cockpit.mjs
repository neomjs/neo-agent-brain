/**
 * @module src/fleet/contract/cockpit
 * @summary Stable source and event identifiers emitted by Fleet cockpit DTO producers.
 * Identifier sharing does not move DTO assembly, redaction or observation authority into clients.
 */

/** @type {Readonly<Object<string,string>>} */
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

/** @type {ReadonlyArray<string>} */

export const FLEET_COCKPIT_EVENT_TYPES = Object.freeze([
    'lifecycle-request',
    'lifecycle-success',
    'lifecycle-failure',
    'bridge-unavailable',
    'bridge-gated',
    'a2a-activity',
    'pr-activity',
    'issue-activity',
    'lane-claim',
    'work-stall',
    'source-degraded'
]);

#!/usr/bin/env node
/**
 * @summary All-agent-idle detection at heartbeat layer.
 *
 * This script queries the SQLite GraphLog to determine if ALL configured agents
 * in the swarm are idle: their last known activity — the newest of memory,
 * turn-presence beacon and outbound message (`lastKnownActivity.mjs`) — is older
 * than the idle threshold the swarm-heartbeat leaf declares.
 *
 * Detector Contract:
 * - Emits a structured `AllAgentIdleSignal` when the all-idle predicate holds.
 * - Signal shape:
 *   {
 *     "allIdle": boolean,
 *     "cycle_id": string,
 *     "identities": string[],
 *     "coordinator_recommendation": string,
 *     "details": { [identity]: { "lastMemTime": string, "lastActivityAt": string, "lastActivitySource": string, "ageMs": number } }
 *   }
 */
import Neo                                               from 'neo.mjs/src/Neo.mjs';
import * as core                                         from 'neo.mjs/src/core/_export.mjs';
import { createHash }                                    from 'crypto';
import LifecycleService                                  from '../../services/memory-core/lifecycle/SystemLifecycleService.mjs';
import GraphService                                      from '../../services/memory-core/GraphService.mjs';
import AiConfig                                          from '../../config.mjs';
import memoryCoreConfig                                  from '../../mcp/server/memory-core/config.mjs';
import {resolveTargets}                                  from '../../daemons/orchestrator/scheduling/swarmHeartbeat.mjs';
import { checkInflightLock }                             from './inflightLock.mjs';
import {readLastKnownActivity}                           from './lastKnownActivity.mjs';
import {participationByIdentity, readAgentIdentityNodes} from '../../graph/agentIdentityParticipation.mjs';
import {isEntryModule}                                   from '../../services/shared/isEntryModule.mjs';

/**
 * @summary Derive a logical all-agent-idle cycle id from the observed identity state.
 * @param {String[]} identities Configured agent identities.
 * @param {Object<String, {lastMemTime: ?String, inFlightNudge: Boolean}>} details Per-identity idle details.
 * @returns {String}
 */
export function deriveAllAgentIdleCycleId(identities, details) {
    const stateKey = [...identities].sort().map(identity => {
        const detail  = details[identity] || {};
        const lastMem = detail.lastMemTime || 'never';
        const nudge   = detail.inFlightNudge ? 'in-flight' : 'clear';

        return `${identity}:${lastMem}:${nudge}`
    }).join('|');

    return createHash('sha256')
        .update(stateKey)
        .digest('hex')
        .slice(0, 16)
}

/**
 * @summary Compute whether every configured swarm identity is past the idle threshold.
 * @param {Object} options
 * @param {String} options.wakeDaemonDir Resolved wake-daemon data member.
 * @returns {Promise<Object>} All-agent-idle detector signal.
 */
export async function checkAllAgentIdle({wakeDaemonDir}={}) {
    await LifecycleService.ready();
    await GraphService.ready();
    const db = GraphService.db.storage.db;

    // All-idle check set: the registered team (deployment-portable via `identityRoots`), kept to
    // the seats whose identity node lets them participate, overridable by the `NEO_SWARM_IDENTITIES`
    // leaf. Distinct from swarm-heartbeat PULSE targets — idle detection needs the full team, not
    // the recently-A2A-active subset. A participation read that cannot answer fails the check
    // rather than judge an unread team idle.
    const identities = await resolveTargets({
        targetSource         : 'active-local-team',
        explicitTargets      : AiConfig.orchestrator.swarmHeartbeat.allIdleIdentities,
        participationProvider: () => participationByIdentity(readAgentIdentityNodes(db))
    });

    const thresholdMs = AiConfig.orchestrator.swarmHeartbeat.idleThresholdMs;
    const now         = Date.now();

    let   allIdle               = true;
    const details               = {};
    let   earliestIdledIdentity = null;
    let   maxAge                = -1;

    for (const identity of identities) {
        const activity = readLastKnownActivity(db, identity, {now});

        // Boundary case: an identity with no stamp at all is fully idle, so a fresh checkout cannot
        // block the all-idle predicate.
        let ageMs = activity.ageMs ?? Infinity;

        const lockData = await checkInflightLock(identity, 'idle_out_nudge', activity.lastActivityAtMs || 0, {wakeDaemonDir});

        // A pending nudge counts as activity only while the seat still has the threshold to answer
        // it; past that, the lock describes a seat that did not come back, and that seat is idle again.
        if (lockData.inFlight && lockData.lockAgeMs <= thresholdMs) {
            ageMs = 0;
        }

        details[identity] = {
            lastMemTime       : activity.lastMemoryAt,
            lastActivityAt    : activity.lastActivityAt,
            lastActivitySource: activity.lastActivitySource,
            ageMs,
            inFlightNudge     : lockData.inFlight,
            abandonedCount    : lockData.abandonedCount || 0
        };

        if (ageMs <= thresholdMs) {
            allIdle = false;
        }

        if (ageMs > maxAge) {
            maxAge = ageMs;
            earliestIdledIdentity = identity;
        }
    }

    const cycleId = deriveAllAgentIdleCycleId(identities, details);

    const signal = {
        allIdle,
        cycle_id                  : cycleId,
        identities,
        coordinator_recommendation: earliestIdledIdentity,
        details
    };

    return signal;
}

async function main() {
    const signal = await checkAllAgentIdle({wakeDaemonDir: memoryCoreConfig.wakeDaemon.dataDir});
    console.log(JSON.stringify(signal));
}

const isMain = isEntryModule(import.meta.url);

if (isMain) {
    main().catch(err => {
        console.error('checkAllAgentIdle failed:', err.message);
        process.exit(1);
    });
}

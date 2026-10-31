#!/usr/bin/env node
/**
 * @summary Auto-Wakeup substrate detector for terminal sunset and recoverable idle-out states.
 *
 * Queries the SQLite GraphLog to determine whether an agent identity is in
 * one of two recovery-relevant states:
 *
 *   - **`sunset`** (terminal): the `WAKE_SUBSCRIPTION` is missing / disabled
 *     / degraded. The `session-sunset` workflow's Unsubscribe primitive is the
 *     authoritative signal; staleness alone is NOT a sunset signal. Recovery:
 *     per-harness terminal restart.
 *   - **`idle_out_candidate`** (recoverable): subscription is active AND the
 *     identity's last known activity — the newest of its memory, its turn-presence beacon
 *     and its outbound message (`lastKnownActivity.mjs`) — is older than the configured idle
 *     threshold (`AiConfig.orchestrator.swarmHeartbeat.idleThresholdMs`, env
 *     `NEO_IDLE_THRESHOLD_MS` — the same leaf `checkAllAgentIdle.mjs` reads). Recovery:
 *     in-place heartbeat nudge — once per idle stretch, non-spawning, idempotent.
 *
 * The two signals are mutually exclusive by construction: `sunset` requires
 * `subscription_active: false`; `idle_out_candidate` requires
 * `subscription_active: true`. Both can be `false` simultaneously (the no-op
 * "agent is operating normally" case).
 *
 * **Output shape:**
 *
 *     {
 *       identity: '@neo-opus-ada',
 *       sunset: false,
 *       idle_out_candidate: true,
 *       evidence: {
 *         subscription_active: true,
 *         subscription_status: 'active',     // 'missing' | 'active' | 'degraded' | 'disabled'
 *         last_memory_age_min: 12,
 *         last_activity_at: '2026-10-30T19:21:04.134Z',
 *         last_activity_source: 'turn-presence', // 'memory' | 'turn-presence' | 'message' | null
 *         last_activity_age_min: 3,
 *         last_sessionId: 'cce1fea5-...'
 *       },
 *       recommended_action: 'idle_out_nudge', // 'sunset_restart' | 'idle_out_nudge' | 'no_action'
 *
 *       // Backward-compat fields for callers not yet migrated:
 *       sunsetted: false,            // mirrors `sunset`
 *       reason: '',                   // human-readable
 *       originSessionId: 'cce1fea5-...',  // = evidence.last_sessionId
 *       abandonedCount: 0             // from in-flight lock check
 *     }
 *
 * **In-flight lock integration:** when a `sunset_restart` or `idle_out_nudge`
 * action is in flight, the corresponding signal downgrades to `false`; the
 * substrate is already mid-recovery, so no second dispatch is needed. This
 * data-layer mutex prevents duplicate recovery dispatches.
 *
 * `AGENT_MEMORY` rows are read for origin-session extraction (so the
 * fresh-session-spawn boot prompt can carry the prior session ID for Memory
 * Core context-priming) and for update-on-read migration of legacy rows
 * lacking structured `timestamp` / `sessionId` / `agentIdentity` fields.
 *
 * @see ai/scripts/lifecycle/inflightLock.mjs        — in-flight recovery lock primitive
 * @see ai/daemons/SwarmHeartbeatService.mjs — primary consumer of detector output
 * @see ai/scripts/lifecycle/resumeHarness.mjs       — sunset-mode action dispatcher
 * @see ai/scripts/lifecycle/swarmWakeCooldown.mjs   — idle-out-mode action dispatcher
 * @see learn/agentos/incidents/2026-05-04-runaway-spawn-pattern.md — wake-recovery failure-mode background
 */
import Neo                              from 'neo.mjs/src/Neo.mjs';
import * as core                        from 'neo.mjs/src/core/_export.mjs';
import path                             from 'path';
import LifecycleService                 from '../../services/memory-core/lifecycle/SystemLifecycleService.mjs';
import {isActiveWakeSubscriptionStatus} from '../../services/memory-core/wakeSubscriptionStatusPolicy.mjs';
import GraphService                     from '../../services/memory-core/GraphService.mjs';
import AiConfig                         from '../../config.mjs';
import memoryCoreConfig                 from '../../mcp/server/memory-core/config.mjs';
import { checkInflightLock }            from './inflightLock.mjs';
import {readLastKnownActivity}          from './lastKnownActivity.mjs';
import {isEntryModule}                  from '../../services/shared/isEntryModule.mjs';

/**
 * @summary Compute the sunset / idle-out detector payload for one agent identity.
 * @param {String} [identity] Agent identity to inspect.
 * @param {Object} options
 * @param {String} options.wakeDaemonDir Resolved wake-daemon data member.
 * @returns {Promise<Object>} Structured detector contract consumed by shell and daemon paths.
 */
export async function checkSunsetted(
    identity = process.env.NEO_AGENT_IDENTITY || '@neo-gemini-julia',
    {wakeDaemonDir}={}
) {
    await LifecycleService.ready();

    // Ensure GraphService finished initializing
    await GraphService.ready();
    const db = GraphService.db.storage.db;

    // Query all subscriptions for this identity so the detector emits a structured
    // `subscription_status` field rather than a binary "exists / doesn't exist".
    const allSubsStmt = db.prepare(`
        SELECT json_extract(data, '$.properties.status')        as status,
               json_extract(data, '$.properties.harnessTarget') as harnessTarget
        FROM Nodes
        WHERE json_extract(data, '$.label') = 'WAKE_SUBSCRIPTION'
          AND json_extract(data, '$.properties.agentIdentity') = ?
    `);
    const allSubs = allSubsStmt.all(identity);

    // `active` wins over `degraded` / `disabled`: an identity with both an active
    // subscription and an inactive one is operationally active. Subscription
    // presence remains the authoritative sunset signal; memory staleness only
    // feeds idle-out recovery.
    let subscriptionStatus;
    if (allSubs.length === 0) {
        subscriptionStatus = 'missing';
    } else {
        const activeSub = allSubs.find(s =>
            isActiveWakeSubscriptionStatus(s.status) && s.harnessTarget !== 'disabled'
        );
        if (activeSub) {
            subscriptionStatus = 'active';
        } else if (allSubs.some(s => s.harnessTarget === 'disabled')) {
            subscriptionStatus = 'disabled';
        } else {
            subscriptionStatus = 'degraded';
        }
    }
    const subscriptionActive = subscriptionStatus === 'active';

    // Bulk-migrate legacy AGENT_MEMORY rows before querying so timestamp ordering
    // is deterministic. Legacy rows store time in `name`; without migration,
    // `ORDER BY COALESCE(timestamp, name)` can keep selecting the same older row
    // ahead of fresh ISO-timestamped rows.
    const legacyStmt = db.prepare(`
        SELECT id,
               data,
               json_extract(data, '$.properties.name')        as nameField,
               json_extract(data, '$.properties.description') as descField
        FROM Nodes
        WHERE json_extract(data, '$.label') = 'AGENT_MEMORY'
          AND (json_extract(data, '$.properties.agentIdentity') = ? OR json_extract(data, '$.properties.userId') = ?)
          AND json_extract(data, '$.properties.timestamp') IS NULL
    `);
    const legacyRows = legacyStmt.all(identity, identity);

    if (legacyRows.length > 0) {
        const updateStmt = db.prepare(`UPDATE Nodes SET data = ? WHERE id = ?`);
        db.transaction((rows) => {
            for (const row of rows) {
                const tsMatch  = row.nameField?.match(/^Memory:\s+(.+)$/);
                const sidMatch = row.descField?.match(/inside session ([a-f0-9-]+)/);

                if (tsMatch && sidMatch) {
                    try {
                        const dataObj = JSON.parse(row.data);
                        dataObj.properties = dataObj.properties || {};
                        dataObj.properties.timestamp = tsMatch[1];
                        dataObj.properties.sessionId = sidMatch[1];
                        dataObj.properties.agentIdentity = identity;
                        updateStmt.run(JSON.stringify(dataObj), row.id);
                    } catch (err) {
                        // Non-parseable legacy rows remain invisible to timestamp ordering.
                    }
                }
            }
        })(legacyRows);
    }

    // The identity's last known activity: the newest of its memory, its turn-presence beacon and
    // its outbound message — one definition shared with `checkAllAgentIdle.mjs`. The memory half
    // also carries the origin session the fresh-session-spawn boot prompt needs.
    const activity         = readLastKnownActivity(db, identity);
    const originSessionId  = activity.lastSessionId;
    const lastActivityMs   = activity.lastActivityAtMs || 0;
    const lastMemoryAgeMin = activity.lastMemoryAgeMs !== null ? Math.round(activity.lastMemoryAgeMs / 60000) : null;

    // Compute the two recovery signals with in-flight lock awareness. Absence of
    // an active WAKE_SUBSCRIPTION is the authoritative sunset signal. Quiet is
    // never a sunset signal; when paired with an active subscription, it only
    // produces the lower-authority in-place idle-out nudge candidate.

    let sunset           = false;
    let idleOutCandidate = false;
    let reason           = '';
    let lockData         = null;

    if (!subscriptionActive) {
        // Sunset path: if a restart is already in flight, downgrade to no-op so
        // recovery stays single-dispatch.
        lockData = await checkInflightLock(identity, 'sunset_restart', lastActivityMs, {wakeDaemonDir});

        if (lockData.inFlight) {
            sunset = false;
            reason = 'Sunset restart already in-flight (lock active)';
        } else {
            sunset = true;
            reason = `No active WAKE_SUBSCRIPTION (status: ${subscriptionStatus})`;
        }
    } else if (activity.ageMs !== null && activity.ageMs > AiConfig.orchestrator.swarmHeartbeat.idleThresholdMs) {
        // Active subscription + a quiet stretch past the threshold = candidate idle-out nudge.
        // This signal is "candidate in-place nudge," NOT "agent is idle." The
        // consumer is responsible for bounded, non-spawning, idempotent dispatch
        // that never destructively types into an active draft. The lock holds for
        // the rest of the stretch; only newer activity releases it.
        lockData = await checkInflightLock(identity, 'idle_out_nudge', lastActivityMs, {wakeDaemonDir});

        if (!lockData.inFlight) {
            idleOutCandidate = true;
        }
        // else: nudge already in flight; emit no_action recommendation.
    }

    // `recommended_action` is the single branch field consumed by Orchestrator
    // heartbeat recovery, swarmWakeCooldown.mjs, and resumeHarness.mjs.
    let recommendedAction;
    if (sunset)                  recommendedAction = 'sunset_restart';
    else if (idleOutCandidate)   recommendedAction = 'idle_out_nudge';
    else                         recommendedAction = 'no_action';

    // Emit the structured contract plus backward-compatible fields consumed by
    // callers that still read `sunsetted`, `reason`, `originSessionId`, or
    // `abandonedCount`.
    return {
        identity,
        sunset,
        idle_out_candidate: idleOutCandidate,
        evidence          : {
            subscription_active  : subscriptionActive,
            subscription_status  : subscriptionStatus,
            last_memory_age_min  : lastMemoryAgeMin,
            last_activity_at     : activity.lastActivityAt,
            last_activity_source : activity.lastActivitySource,
            last_activity_age_min: activity.ageMs !== null ? Math.round(activity.ageMs / 60000) : null,
            last_sessionId       : originSessionId
        },
        recommended_action: recommendedAction,

        // Backward-compat fields:
        sunsetted     : sunset,
        reason,
        originSessionId,
        abandonedCount: lockData?.abandonedCount || 0
    };
}

async function main() {
    const identity = process.argv[2] || process.env.NEO_AGENT_IDENTITY || '@neo-gemini-julia';
    const result   = await checkSunsetted(identity, {wakeDaemonDir: memoryCoreConfig.wakeDaemon.dataDir});
    console.log(JSON.stringify(result));
}

const isMain = isEntryModule(import.meta.url);

if (isMain) {
    main().catch(err => {
        console.error('checkSunsetted failed:', err.message);
        process.exit(1);
    });
}

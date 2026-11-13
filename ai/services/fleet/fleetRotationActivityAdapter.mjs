import {createFleetCockpitEvent, createFleetCockpitEventId} from './fleetCockpitStatus.mjs';
import {DEFAULT_FLEET_ACTIVITY_EVENT_LIMIT}                 from './fleetPrLaneActivityAdapter.mjs';
import {ROTATION_STATES}                                    from './fleetWakeRoutesSource.mjs';
import {FLEET_COCKPIT_SOURCES}                              from '../../../src/fleet/contract/cockpit.mjs';

/**
 * @module ai/services/fleet/fleetRotationActivityAdapter
 * @summary The rotation slot of the Fleet activity history: one event per seat for the decision on its
 * newest sunset receipt (Brain #1383), read from the wake-routes snapshot rather than from the plane, so
 * the `rotation` axis of `fleetWakeRoutes` stays the one projection of that record.
 *
 * A seat's row carries only its newest receipt's decision. Each state is its own event (`requested`, then
 * `completed`), so a cockpit that keeps the events it has seen keeps the rotation's course.
 */

/**
 * @summary Reads the rotation slot's snapshot.
 *
 * The slot is `wired` when the snapshot shows rotations: a seat without a record is a quiet seat, and its
 * absence of events is the truth. It is `degraded` when every seat reads `unobserved` (a plane that reports
 * no rotations, whose silence would otherwise pose as quiet) or when a seat's rotation is `unknown`, and
 * then names why. A snapshot without seats throws, and the composer degrades the slot with the reason.
 * @param {Object} options
 * @param {Function} options.readWakeRoutes `() => Promise<{seats}>`, the wake-routes source's reader.
 * @param {Number} [options.limit=DEFAULT_FLEET_ACTIVITY_EVENT_LIMIT] Maximum events, newest first.
 * @param {Function} [options.now] `() → epoch ms`.
 * @returns {Promise<{capability: Object, events: Object[]}>}
 */
export async function readFleetRotationActivitySnapshot({readWakeRoutes, limit = DEFAULT_FLEET_ACTIVITY_EVENT_LIMIT, now = () => Date.now()} = {}) {
    const
        capturedAt = new Date(now()).toISOString(),
        seats      = (await readWakeRoutes())?.seats;

    if (!Array.isArray(seats)) {
        throw new Error('the wake-routes answer carries no seats')
    }

    const
        unknown = seats.filter(seat => seat?.rotation?.state === 'unknown'),
        blind   = seats.length > 0 && seats.every(seat => seat?.rotation?.state === 'unobserved'),
        events  = seats
            .filter(seat => ROTATION_STATES.includes(seat?.rotation?.state) && seat.rotation.receiptId)
            .map(({agentId, rotation}) => createFleetCockpitEvent({
                eventId   : createFleetCockpitEventId(FLEET_COCKPIT_SOURCES.rotation, `${rotation.receiptId}:${rotation.state}`),
                type      : 'session-rotation',
                source    : FLEET_COCKPIT_SOURCES.rotation,
                agentId,
                occurredAt: rotation.decidedAt,
                payload   : {
                    receiptId     : rotation.receiptId,
                    state         : rotation.state,
                    reason        : rotation.reason,
                    oldSessionId  : rotation.oldSessionId,
                    newSessionId  : rotation.newSessionId,
                    nextEligibleAt: rotation.nextEligibleAt
                }
            }))
            .sort((left, right) => String(right.occurredAt ?? '').localeCompare(String(left.occurredAt ?? '')))
            .slice(0, limit);

    const reason = blind
        ? 'the plane reports no rotations'
        : unknown.length > 0
            ? `rotation unknown for ${unknown.map(seat => seat.agentId).join(', ')}: ${[...new Set(unknown.map(seat => seat.rotation.reason || 'unreadable'))].join('; ')}`
            : null;

    return {
        capability: {
            source    : FLEET_COCKPIT_SOURCES.rotation,
            state     : reason ? 'degraded' : 'wired',
            confidence: reason ? (events.length > 0 ? 'partial' : 'none') : 'observed',
            capturedAt,
            reason
        },
        events
    }
}

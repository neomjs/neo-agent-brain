import {createPlaneMailboxClient, VIEWER_BINDING_UNAVAILABLE} from '../../services/fleet/planeMailboxClient.mjs';
import {toBareIdentity}                                       from './armSeatWakeRoute.mjs';

/**
 * @module ai/daemons/wake/armSeatWakePull
 * @summary Arms a seat for pull delivery: one route its own session polls, and none that types into a window.
 *
 * A pull route is a `SENT_TO_ME` subscription on `harnessTarget: 'none'`. Nothing pushes it: the
 * coalescing engine skips `none` as opted out of push, and the receiver manifest publishes only
 * `a2a-webhook` routes. The seat's session reads it through `poll-digest`, the pull half of wake
 * delivery, so the route carries no address, and a wake cannot land in another seat's window.
 *
 * Everything here takes injected values and resolves no config: the hook entrypoints read the plane leaves.
 */

/**
 * The seat's one pull route. `subscribe` answers an identical route key with the existing row, so
 * subscribing it again is also how a caller learns its id.
 * @type {Object}
 */
export const PULL_ROUTE = Object.freeze({
    trigger              : 'SENT_TO_ME',
    filters              : Object.freeze({}),
    harnessTarget        : 'none',
    harnessTargetMetadata: Object.freeze({})
});

/**
 * Push targets whose routes the receiver dispatches. `none`, `disabled` and `mcp-notifications` type
 * into nothing.
 * @type {String[]}
 */
const PUSH_TARGETS = ['a2a-webhook', 'bridge-daemon'];

/**
 * @summary Names what keeps a seat from reaching its plane before any request is made, or `null`.
 * @param {Object} options
 * @param {String} options.planeBase `seat.planeBase`, read by the entrypoint.
 * @param {String} options.identity The seat as `NEO_AGENT_IDENTITY` names it, with or without `@`.
 * @returns {String|null}
 */
export function seatPlaneGap({planeBase, identity}) {
    if (!String(planeBase ?? '').trim()) return 'seat.planeBase is not configured, so there is no Memory Core plane to reach';
    if (!toBareIdentity(identity))      return 'NEO_AGENT_IDENTITY is not set, so the seat cannot name itself';

    return null
}

/**
 * @summary Opens a plane session proven to be this seat, or names why it cannot.
 * @param {Object} options
 * @param {String} options.planeBase `seat.planeBase`, read by the entrypoint.
 * @param {String} [options.planeBearer=''] `seat.planeBearer`, read by the entrypoint.
 * @param {String} options.identity The seat as `NEO_AGENT_IDENTITY` names it, with or without `@`.
 * @param {Function} [options.createClient=createPlaneMailboxClient]
 * @returns {Promise<Object>} `{client, identity}`, or `{reason, refused}` without a client. `refused`
 * marks a reason no retry changes: no plane or identity configured, or a plane that answered that
 * the credential names another identity.
 */
export async function connectSeatPlane({planeBase, planeBearer = '', identity, createClient = createPlaneMailboxClient}) {
    const gap = seatPlaneGap({planeBase, identity});

    if (gap) return {reason: gap, refused: true};

    const base   = String(planeBase).trim().replace(/\/+$/, ''),
          bare   = toBareIdentity(identity),
          client = createClient({baseUrl: `${base}/mc/mcp`, credential: planeBearer}),
          proof  = await client.init({expectedIdentity: `@${bare}`});

    if (!proof?.ok) {
        await Promise.resolve(client.close?.()).catch(() => {});

        return {
            reason : `the plane credential did not prove @${bare}: ${proof?.reason ?? 'no reason given'}`,
            refused: proof?.blockerCode === VIEWER_BINDING_UNAVAILABLE
        }
    }

    return {client, identity: `@${bare}`}
}

/**
 * @summary Subscribes the seat's pull route and returns its id.
 * @param {Object} options
 * @param {Object} options.client An initialized plane client.
 * @returns {Promise<String>}
 */
export async function resolvePullRoute({client}) {
    const {subscriptionId} = await client.callTool('manage_wake_subscription', {action: 'subscribe', ...PULL_ROUTE}) ?? {};

    if (!subscriptionId) throw new Error('the plane accepted the pull route without naming it');

    return subscriptionId
}

/**
 * @summary Does the receiver dispatch this route by typing into a window?
 *
 * `osascript` activates the app and types into whatever holds focus. A push route with no adapter gets
 * the receiver's platform default, which on macOS is `osascript` as well.
 * @param {Object} subscription A `manage_wake_subscription` `list` record.
 * @returns {Boolean}
 */
export function typesIntoWindow(subscription) {
    const adapter = subscription?.harnessTargetMetadata?.adapter;

    return PUSH_TARGETS.includes(subscription?.harnessTarget) && (!adapter || adapter === 'osascript')
}

/**
 * @summary Moves a seat from window-typing push to pull.
 *
 * The pull route is subscribed first, so the seat is never left without a route. Then every active
 * `SENT_TO_ME` route of the seat that {@link typesIntoWindow} is unsubscribed, which deletes it on the
 * plane. Rollback is subscribing that route again. Routes on other adapters, and other triggers, are
 * left as they are.
 * @param {Object} options
 * @param {Object} options.client An initialized plane client, proven as `identity`.
 * @param {String} options.identity The seat, `@login`.
 * @returns {Promise<Object>} `{subscriptionId, retired}` — the pull route and the unsubscribed ids.
 */
export async function armSeatWakePull({client, identity}) {
    const subscriptionId  = await resolvePullRoute({client}),
          {subscriptions} = await client.callTool('manage_wake_subscription', {action: 'list'}),
          retired         = [];

    for (const subscription of subscriptions) {
        if (subscription.agentIdentity === identity && subscription.status === 'active' &&
            subscription.trigger === 'SENT_TO_ME' && typesIntoWindow(subscription)) {
            await client.callTool('manage_wake_subscription', {action: 'unsubscribe', subscriptionId: subscription.id});
            retired.push(subscription.id)
        }
    }

    return {subscriptionId, retired}
}

import {armSeatWakeRoute}           from '../../daemons/wake/armSeatWakeRoute.mjs';
import {createPlaneMailboxClient}   from './planeMailboxClient.mjs';
import {deriveHarnessWakeAddress}   from './deriveHarnessLaunchSpec.mjs';
import {normalizeSecureMcpEndpoint} from './mcpWireParsing.mjs';

/**
 * @module ai/services/fleet/armFleetSeatWake
 * @summary Arms the wake route of a GUI seat the Fleet has just launched, acting AS that seat on its
 * plane, so a peer's message wakes the window without anyone subscribing it by hand.
 *
 * **Why the Fleet and not a hook inside the harness.** A seat's route needs a subscription owned by
 * the seat's own identity, addressed to the exact window it runs in. The Fleet holds both facts at
 * launch: the seat's plane credential, proven to resolve to the seat before spawn, and the
 * `--user-data-dir` it launched the window with. A harness hook would depend on each harness running
 * it; this caller does not.
 *
 * **Never fails a start.** Every refusal is a returned `{state: 'unarmed', reason}`; the seat keeps
 * running and its status says why it cannot be woken. `null` means "no GUI wake applies to this
 * family" — the Fleet records nothing, and a family with its own route (OpenCode) keeps it.
 */

/**
 * The receiver dispatch per GUI family: the automation `appName` the `osascript` adapter targets,
 * plus a focus seed where the receiver has no default for the app — Codex requires one, Claude's
 * defaults live with the receiver (`ai/daemons/wake/hostHarnessMetadata.mjs`).
 * @type {Object}
 */
export const GUI_WAKE_DISPATCH = Object.freeze({
    'claude-desktop': Object.freeze({adapter: 'osascript', appName: 'Claude'}),
    'codex-desktop' : Object.freeze({adapter: 'osascript', appName: 'Codex', focusSeedKey: 'r'})
});

/**
 * @summary Whether a listed subscription already delivers to this window: active, on the webhook
 * transport, deliverable, and addressed to the same `userDataDir`.
 * @param {Object} subscription A `manage_wake_subscription` list row.
 * @param {String} instanceAddress The seat's launch profile.
 * @returns {Boolean}
 */
export function isLiveRouteFor(subscription, instanceAddress) {
    const metadata = subscription?.harnessTargetMetadata ?? {};

    return subscription?.status === 'active' &&
        subscription.harnessTarget === 'a2a-webhook' &&
        subscription.routeDeliverable !== false &&
        metadata.addressType === 'userDataDir' &&
        (metadata.instanceAddress ?? metadata.userDataDir) === instanceAddress
}

/**
 * @summary Arms one launched GUI seat: proves its plane credential, subscribes it only when no route
 * reaches its window yet, and publishes the route to the host receiver.
 * @param {Object} options
 * @param {Object} options.agent Registry definition (`id`, `harnessType`, `githubUsername`, `mcpTarget`).
 * @param {String} options.instanceHome The started seat's harness home (from its lifecycle status).
 * @param {String} options.planeBase The plane this Fleet is attached to (`fleet.planeBase`).
 * @param {String} options.receiverBase The receiver's plane-facing base (`fleet.wakeReceiverBase`).
 * @param {String} options.manifestPath The receiver's route manifest (`fleet.wakeReceiverManifestPath`).
 * @param {Object} options.tenantService Resolves the seat's plane resources and credential.
 * @param {Function} [options.createClient=createPlaneMailboxClient] Plane MCP client seam.
 * @param {Function} [options.armRoute=armSeatWakeRoute] Publish seam.
 * @param {Object} [options.logger=console]
 * @returns {Promise<Object|null>} `{state: 'ready'|'unarmed', reason, adapter, addressType,
 *     instanceAddress, subscriptionId}`, or `null` when no GUI wake applies to the family.
 */
export async function armFleetSeatWake({
    agent,
    instanceHome,
    planeBase,
    receiverBase,
    manifestPath,
    tenantService,
    createClient = createPlaneMailboxClient,
    armRoute     = armSeatWakeRoute,
    logger       = console
} = {}) {
    const dispatch = GUI_WAKE_DISPATCH[agent?.harnessType];

    if (!dispatch) return null;

    const address = deriveHarnessWakeAddress({harnessType: agent.harnessType, instanceHome});

    if (!address) {
        return {state: 'unarmed', reason: 'the seat has no launched profile to address'}
    }

    const route   = {adapter: dispatch.adapter, ...address, subscriptionId: null},
          unarmed = reason => ({state: 'unarmed', reason, ...route}),
          login   = typeof agent.githubUsername === 'string' ? agent.githubUsername.trim().replace(/^@/, '') : '',
          target  = agent.mcpTarget;

    if (!login) return unarmed('the seat has no GitHub identity to subscribe as');

    if (target?.kind !== 'tenant') {
        return unarmed('the seat runs a resident Memory Core, which is not the plane that dispatches wakes')
    }

    const plan       = tenantService?.resolveMcpResources(target.tenantId),
          credential = plan && tenantService.resolveMcpCredential(target.tenantId);

    if (!plan || !credential) return unarmed('the seat\'s plane is not connected');

    if (normalizeSecureMcpEndpoint(planeBase ?? '') !== plan.endpoint) {
        return unarmed('the seat\'s plane is not the plane this Fleet is attached to, and the receiver URL is declared for that plane only')
    }

    if (!receiverBase || !manifestPath) {
        return unarmed('no wake receiver is declared (fleet.wakeReceiverBase and fleet.wakeReceiverManifestPath)')
    }

    let url;

    try {
        url = new URL('/wake', receiverBase).href
    } catch {
        return unarmed('fleet.wakeReceiverBase is not a valid URL')
    }

    const client   = createClient({baseUrl: plan.resources['memory-core'].url, credential}),
          identity = `@${login}`,
          list     = async () => (await client.callTool('manage_wake_subscription', {action: 'list'}))?.subscriptions;

    try {
        const proof = await client.init({expectedIdentity: identity});

        if (!proof?.ok) return unarmed(`the seat credential did not prove ${identity}: ${proof?.reason ?? 'no reason given'}`);

        const existing       = (await list() ?? []).find(subscription => isLiveRouteFor(subscription, address.instanceAddress));
        let   subscriptionId = existing?.id ?? null;

        if (!existing) {
            const subscribed = await client.callTool('manage_wake_subscription', {
                action               : 'subscribe',
                trigger              : 'SENT_TO_ME',
                harnessTarget        : 'a2a-webhook',
                harnessTargetMetadata: {...dispatch, url, ...address}
            });

            subscriptionId = subscribed?.subscriptionId ?? null
        }

        const published = await armRoute({
            listSubscriptions: list,
            manifestPath,
            tuple            : {identity, instanceAddress: address.instanceAddress, instanceType: address.addressType},
            logger
        });

        return published.armed
            ? {state: 'ready', reason: null, ...route, subscriptionId}
            : unarmed(published.reason)
    } catch (error) {
        return unarmed(`wake arming failed: ${error?.message ?? error}`)
    } finally {
        await Promise.resolve(client.close?.()).catch(() => {})
    }
}

export default armFleetSeatWake;

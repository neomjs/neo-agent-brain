import {armSeatWakeRoute}           from '../../daemons/wake/armSeatWakeRoute.mjs';
import {createPlaneMailboxClient}   from './planeMailboxClient.mjs';
import {deriveHarnessWakeAddress}   from './deriveHarnessLaunchSpec.mjs';
import {normalizeSecureMcpEndpoint} from './mcpWireParsing.mjs';
import {redactReadFailure}          from './redactReadFailure.mjs';

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
 * **The plane decides what "the same route" is.** Every start subscribes the seat's one route —
 * `SENT_TO_ME`, no filters, this receiver's URL — and the Memory Core's `subscribe` either returns the
 * existing row for that route key, refreshed to this window and dispatch, or creates one. A row on
 * another receiver, trigger or filter is a different route: it neither stands in for this one nor is
 * withdrawn.
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
 * @summary Arms one launched GUI seat: proves its plane credential, subscribes its route, and
 * publishes the route to the host receiver.
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

    // Every reason lands on a public status, and the plane, the publisher and thrown errors author most
    // of them: each one passes the Fleet's diagnostic reduction.
    const route   = {adapter: dispatch.adapter, ...address, subscriptionId: null},
          unarmed = reason => ({state: 'unarmed', reason: redactReadFailure(reason), ...route}),
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
          identity = `@${login}`;

    try {
        const proof = await client.init({expectedIdentity: identity});

        if (!proof?.ok) return unarmed(`the seat credential did not prove ${identity}: ${proof?.reason ?? 'no reason given'}`);

        const {subscriptionId} = await client.callTool('manage_wake_subscription', {
            action               : 'subscribe',
            trigger              : 'SENT_TO_ME',
            filters              : {},
            harnessTarget        : 'a2a-webhook',
            harnessTargetMetadata: {...dispatch, url, ...address}
        }) ?? {};

        if (!subscriptionId) return unarmed('the plane accepted the subscription without naming it');

        const published = await armRoute({
            listSubscriptions: async () => (await client.callTool('manage_wake_subscription', {action: 'list'}))?.subscriptions,
            manifestPath,
            tuple            : {identity, instanceAddress: address.instanceAddress, instanceType: address.addressType},
            logger
        });

        if (!published.armed) return unarmed(published.reason);

        // `armed` speaks for every route the seat owns; `ready` is a claim about this one.
        return published.subscriptionIds?.includes(subscriptionId)
            ? {state: 'ready', reason: null, ...route, subscriptionId}
            : unarmed(`the publish carried no route for ${subscriptionId}`)
    } catch (error) {
        return unarmed(`wake arming failed: ${error?.message ?? error}`)
    } finally {
        await Promise.resolve(client.close?.()).catch(() => {})
    }
}

export default armFleetSeatWake;

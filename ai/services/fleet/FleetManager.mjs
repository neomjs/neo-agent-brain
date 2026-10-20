import Base                                                                          from 'neo.mjs/src/core/Base.mjs';
import FleetLifecycleService                                                         from './FleetLifecycleService.mjs';
import {armFleetSeatWake}                                                            from './armFleetSeatWake.mjs';
import {ensureAgentRepos}                                                            from './ensureAgentRepo.mjs';
import {isOnInstance}                                                                from './provisionAgentRepo.mjs';
import {REPO_FORGES, assertNoCheckoutCollision, assertRepoSlug, deriveAgentRepoPath} from './deriveAgentRepoPath.mjs';
import {DEPENDENCY_RECEIPT, readDependencyReceipt}                                   from './installAgentRepoDependencies.mjs';
import {inspectAgentRepo}                                                            from './inspectAgentRepo.mjs';
import {inspectRepoRemoval, removeAgentRepo}                                         from './removeAgentRepo.mjs';
import {inspectFleetRepos}                                                           from './inspectFleetRepos.mjs';
import {launchRefusalOf}                                                             from '../../../src/fleet/contract/launchAuthority.mjs';
import {readFleetPresenceSnapshot}                                                   from './fleetPresenceStateAdapter.mjs';
import {readFleetThrottleStateSnapshot}                                              from './fleetThrottleStateAdapter.mjs';
import {readFleetWakeStateSnapshot}                                                  from './fleetWakeStateAdapter.mjs';
import {redactReadFailure}                                                           from './redactReadFailure.mjs';
import { resolveSeatPlaneTarget }                                                    from './resolveSeatPlaneTarget.mjs';
import {
    convergeSeatGitIdentity,
    credentialRefusalOf,
    proveSeatForgeAccount,
    resolveSeatGitIdentity
}                                                                                    from './seatGitIdentity.mjs';
import {readSeatModelCatalog}           from './seatModelCatalog.mjs';
import {startAgentProvisioned}          from './startAgentProvisioned.mjs';
import {readInstalledRuntimeGeneration} from './runtimeGeneration.mjs';
import {REPLACE_SEAT_CREDENTIAL_SCOPES} from '../../../src/fleet/contract/wire.mjs';
import crypto                           from 'node:crypto';
import path                             from 'node:path';

export {REPLACE_SEAT_CREDENTIAL_SCOPES};

/**
 * @summary Build a non-secret replacement receipt distinguishing persisted authority, carrier preparation,
 * and running-session state.
 * @param {Object} options
 * @returns {Object}
 * @private
 */
function buildCredentialReplacementReceipt({
    scope,
    forge,
    plane,
    boundPlane = null,
    coherent = true,
    incomplete = false,
    session = 'stopped'
} = {}) {
    const
        normalizedScope = REPLACE_SEAT_CREDENTIAL_SCOPES.includes(scope) ? scope : null,
        planeState      = plane ?? (normalizedScope === 'forge-and-bound-plane' ? 'unchanged' : 'not-selected');

    return {
        scope             : normalizedScope,
        persistedAuthority: {
            forge,
            plane: planeState
        },
        forge,
        plane             : planeState,
        boundPlane        : boundPlane ? {endpoint: boundPlane.endpoint, id: boundPlane.id, dataRoot: boundPlane.dataRoot} : null,
        coherent,
        incomplete,
        carrier           : 'deferred-until-start',
        carrierPreparation: 'deferred-until-start',
        session,
        runningSession    : session,
        nextStep          : incomplete ? 'replace-seat-credential' : (forge === 'replaced' ? 'start-agent' : 'fix-and-retry')
    }
}

/**
 * @summary The one rule for a repository a seat clones: a slug that passes the checkout path's own rule
 * ({@link assertRepoSlug}), and a remote naming that repo — https, ssh or the SCP-like
 * `git@host:owner/repo`, with no embedded credentials and never a local source. A GitHub slug is exactly
 * `<owner>/<repo>` and, without a clone URL, is the GitHub URL of the slug. A GitLab slug may name nested
 * groups and must name its clone URL, because without a seat its host cannot be derived (a seat-aware verb
 * derives it first, {@link seatRepoEntry}); the entry records `forge: 'gitlab'`, while GitHub stays
 * unrecorded. A refusal names the rule, never the refused value: a
 * caller's string may be a URL with a credential in it, and an error message travels to logs and panes.
 * @param {Object} coordinates
 * @param {String} [coordinates.repoSlug] `owner/repo`, or `group/…/project` on GitLab.
 * @param {String} [coordinates.cloneUrl] A remote naming that repo.
 * @param {String} [coordinates.forge='github'] One of {@link REPO_FORGES}.
 * @param {String} caller For the error message.
 * @returns {{repoSlug: String, cloneUrl: String, forge?: String}}
 * @throws {Error} On an unknown forge, a malformed slug, a GitLab entry without a clone URL, a clone URL
 * that is not a plain string (a query, fragment or whitespace included), or one that is not a remote naming
 * the slug's repo.
 * @private
 */
function repoCoordinates({repoSlug, cloneUrl, forge = 'github'}, caller) {
    if (!REPO_FORGES.includes(forge)) {
        throw new Error(`${caller}: forge must be one of ${REPO_FORGES.join(', ')}.`)
    }

    let segments;

    try {
        segments = assertRepoSlug(repoSlug, caller)
    } catch {
        throw new Error(`${caller}: repoSlug must be '<owner>/<repo>' in lowercase seat segments (a GitLab slug may name nested groups), never a reserved owner.`)
    }

    if (forge === 'github' && segments.length !== 2) {
        throw new Error(`${caller}: repoSlug must be exactly '<owner>/<repo>' on GitHub.`)
    }

    if (forge !== 'github' && cloneUrl == null) {
        throw new Error(`${caller}: a ${forge} repository needs its clone URL, because its host cannot be derived.`)
    }

    // The matcher below reads text, not a parsed URL: a query or fragment before the path would let a remote
    // that names another path pass it, and a non-string would be coerced into one.
    if (cloneUrl != null && (typeof cloneUrl !== 'string' || /[?#\s]/.test(cloneUrl))) {
        throw new Error(`${caller}: the clone URL must be a plain remote string, with no query, fragment or whitespace.`)
    }

    const
        escaped = repoSlug.replace(/\./g, '\\.'),
        remote  = new RegExp(`^(?:https://[^/@\\s]+/|ssh://(?:[\\w.-]+@)?[^/@\\s:]+(?::\\d+)?/|[\\w.-]+@[\\w.-]+:)${escaped}(?:\\.git)?$`, 'i'),
        repo    = {repoSlug, cloneUrl: cloneUrl ?? `https://github.com/${repoSlug}.git`, ...(forge === 'github' ? {} : {forge})};

    if (!remote.test(repo.cloneUrl)) {
        throw new Error(`${caller}: the clone URL must be an https, ssh or SCP-like remote naming ${repoSlug}, with no credentials and no local source.`)
    }

    return repo
}

/**
 * @summary A seat-aware verb's entry before {@link repoCoordinates}: one that names no clone URL takes the
 * seat's forge, and on a GitLab seat its clone URL is the slug on the seat's own instance (`forgeHost`).
 * An entry naming its clone URL, and every entry of a GitHub seat, passes unchanged.
 * @param {Object}      entry `{repoSlug, cloneUrl?, forge?}`.
 * @param {Object|null} seat  The seat's public definition.
 * @returns {Object} the entry {@link repoCoordinates} reads.
 * @private
 */
function seatRepoEntry(entry, seat) {
    const forge = entry.forge ?? seat?.forge;

    return entry.cloneUrl == null && forge === 'gitlab' && seat?.forge === 'gitlab' && typeof entry.repoSlug === 'string'
        ? {...entry, forge, cloneUrl: `${seat.forgeHost}/${entry.repoSlug}.git`}
        : entry
}

/**
 * @summary Refuse a working repository off the seat's forge. A seat's PAT is bound to one host (its
 * `forgeHost` on GitLab, github.com otherwise), so a working repository elsewhere could neither clone with
 * it nor reach the seat's workflow server. The reason is worded for the operator, who reads it in Accounts.
 * @param {{repoSlug: String, cloneUrl: String, forge?: String}} repo Coordinates {@link repoCoordinates} accepted.
 * @param {Object|null} seat The seat's public definition; none means there is nothing to set.
 * @param {String} caller For the error message.
 * @throws {Error}
 * @private
 */
function assertOnSeatForge(repo, seat, caller) {
    if (!seat) return;

    const forge = seat.forge ?? 'github';

    if ((repo.forge ?? 'github') !== forge) {
        throw new Error(`${caller}: this seat works on ${forge === 'gitlab' ? 'its GitLab instance' : 'GitHub'}, so its working repository must live there too.`)
    }

    if (forge === 'gitlab' && !isOnInstance(repo.cloneUrl, new URL(seat.forgeHost))) {
        throw new Error(`${caller}: this seat's working repository must live on its GitLab instance, ${seat.forgeHost}.`)
    }
}

/**
 * @class Neo.ai.services.fleet.FleetManager
 * @extends Neo.core.Base
 * @singleton
 *
 * @summary
 * The Brain-side (Node-only) Fleet Manager control-plane facade — the surface-independent service
 * layer that resolves the managed checkout root ONCE and exposes the operator operations turnkey, so
 * any surface (an MCP control-plane, the settings pane) sits *thinly* on top rather than re-resolving
 * `managedRoot` or re-wiring the registry / lifecycle singletons at each call site.
 *
 * It **composes** the merged Fleet Manager primitives without modifying them:
 * - `startAgent(id)` → {@link Neo.ai.services.fleet.startAgentProvisioned} (provision-then-start), then
 *   `armFleetSeatWake` for a GUI seat's wake route;
 * - `fleetRepoStatus()` → {@link Neo.ai.services.fleet.inspectFleetRepos} (fleet repo observability),
 *
 * each fed the resolved `managedRoot` + the lifecycle service — the registry is derived from the
 * lifecycle service (`getRegistry`), so there is one source of truth. The composing Fleet entrypoint
 * injects `managedRoot` from the resolved `fleet.dataDir` member; this singleton never re-resolves it.
 *
 * The injectable seams (`lifecycleService`, `provisionAndStartFn`, `repoStatusFn` — default-real,
 * mirroring `FleetLifecycleService`'s `spawnFn` / `registry`) let the resolution + wiring be unit-proven
 * without standing up real fs / git / process spawn. The operator-facing **surface** (MCP control-plane
 * vs settings-pane wiring) is a separate leaf that consumes this facade — it is not part of it.
 */
class FleetManager extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.services.fleet.FleetManager'
         * @protected
         */
        className: 'Neo.ai.services.fleet.FleetManager',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * The absolute fleet-managed checkout root. The composing entrypoint injects it from the resolved
     * Fleet data member; tests inject a per-case temp path through the same seam. A **plain field**,
     * not reactive config — nothing observes/binds it, mirroring the sibling `FleetLifecycleService`'s
     * `credentialEnvVar` / `bridgeTokenEnvVar` tunables.
     * @member {String|null} managedRoot=null
     */
    managedRoot = null
    /**
     * The plane this Fleet serves (`fleet.planeBase`), injected by the composing entrypoint in plane
     * mode and `null` in host mode. A seat's Memory Core and Knowledge Base live there, and its wake
     * route is armed against it. Plain field, like {@link managedRoot}.
     * @member {String|null} planeBase=null
     */
    planeBase = null
    /**
     * Lifecycle collaborator. Defaults (via {@link getLifecycleService}) to the `FleetLifecycleService`
     * singleton; inject a stub for tests. A plain field — the sibling-precedent shape for an injectable
     * seam (`FleetLifecycleService.registry`), not reactive config.
     * @member {Object|null} lifecycleService=null
     */
    lifecycleService = null
    /**
     * Provision-then-start composer seam. Defaults (via {@link getProvisionAndStartFn}) to
     * `startAgentProvisioned`; inject a recording stub for tests. Plain field, mirroring
     * `FleetLifecycleService.spawnFn`.
     * @member {Function|null} provisionAndStartFn=null
     */
    provisionAndStartFn = null
    /**
     * Wake-state observation options for {@link fleetWakeStatus} — `{pidFilePath,
     * resolveSubscriptionState}` per the `fleetWakeStateAdapter` contract. `null` ⇒ every source is
     * honestly `unknown`: this service is not a config entrypoint — config resolution belongs to the
     * composing process entrypoint, which resolves the daemon PID path + the identity-bound
     * subscription read path and injects them here. Plain field, mirroring the sibling seams.
     * @member {Object|null} wakeStateOptions=null
     */
    wakeStateOptions = null
    /**
     * Fleet repo-status aggregator seam. Defaults (via {@link getRepoStatusFn}) to `inspectFleetRepos`;
     * inject a recording stub for tests. Plain field.
     * @member {Function|null} repoStatusFn=null
     */
    repoStatusFn = null
    /**
     * Isolated repository-operation seams for {@link prepareRepos}: `ensureRepo`, `cloneRepo`,
     * `convergeGitIdentity` and `now`. No root, seat or credential comes from this test seam.
     * @member {Object|null} repoPreparationOptions=null
     */
    repoPreparationOptions = null
    /**
     * Local inspection/removal seams for {@link removeRepoCheckout}: `readGit` and `removeDir`.
     * Paths and receipt ownership remain manager-owned.
     * @member {Object|null} repoRemovalOptions=null
     */
    repoRemovalOptions = null
    /**
     * Throttle-state observation options for {@link fleetThrottleStatus} — `{resolveThrottleState}`
     * per the `fleetThrottleStateAdapter` contract. `null` ⇒ every row is honestly `unknown`: no
     * trustworthy throttle truth source exists in the platform yet (the adapter documents the
     * evaluated-and-rejected candidates); the future watchdog-signals producer injects its reader
     * here. Plain field, mirroring the sibling seams.
     * @member {Object|null} throttleStateOptions=null
     */
    throttleStateOptions = null
    /**
     * Presence observation options for {@link fleetPresenceStatus} — `{readPresence,
     * presenceIdentityFor}` per the `fleetPresenceStateAdapter` contract. `null` ⇒ every row is
     * honestly `unknown` under a degraded capability: the composing entrypoint injects the
     * identity-proven plane `who_is_online` reader in plane mode and the in-process Memory Core's
     * projection in host mode. Plain field, mirroring the sibling seams.
     * @member {Object|null} presenceStateOptions=null
     */
    presenceStateOptions = null
    /**
     * Seat wake-arming composer seam. Defaults (via {@link getWakeArmFn}) to `armFleetSeatWake`;
     * inject a recording stub for tests. Plain field, mirroring {@link provisionAndStartFn}.
     * @member {Function|null} wakeArmFn=null
     */
    wakeArmFn = null
    /**
     * Tenant collaborator for wake arming and seat plane credentials. `null` ⇒ the
     * `FleetTenantService` singleton is imported lazily, only when a seat reaches a tenant or the plane
     * this Fleet serves. Plain field.
     * @member {Object|null} tenantService=null
     */
    tenantService = null
    /**
     * Git identity derivation seam for {@link fleetSeatGitIdentity}. Defaults (via {@link getGitIdentityFn}) to
     * `resolveSeatGitIdentity`, the derivation Start runs; inject a recording stub for tests. Plain field.
     * @member {Function|null} gitIdentityFn=null
     */
    gitIdentityFn = null
    /**
     * Forge account proof seam for {@link replaceSeatCredential}. Defaults (via {@link getForgeProofFn}) to
     * `proveSeatForgeAccount`; inject a recording stub for tests. Plain field.
     * @member {Function|null} forgeProofFn=null
     */
    forgeProofFn = null
    /**
     * Catalog read seam for {@link fleetSeatModelCatalog}. Defaults (via {@link getModelCatalogFn}) to
     * `readSeatModelCatalog`, the read Start runs; inject a recording stub for tests. Plain field.
     * @member {Function|null} modelCatalogFn=null
     */
    modelCatalogFn = null
    /**
     * The last operation holding each seat's home, keyed by agent id ({@link withSeatHome}).
     * @member {Map<String,Promise>} seatHomeHolds
     * @private
     */
    seatHomeHolds = new Map()

    /**
     * @summary Returns the composing entrypoint's resolved fleet-managed checkout root.
     *
     * Omission fails before a filesystem operation. Falling back to an env read or this module's
     * location would bypass the AiConfig leaf that already resolved the owning Fleet member.
     * @returns {String}
     */
    getManagedRoot() {
        if (!this.managedRoot) {
            throw new Error('FleetManager: managed root must be injected by the composing entrypoint')
        }

        return this.managedRoot
    }

    /**
     * @returns {Object} the lifecycle collaborator (injected stub or the default singleton).
     * @protected
     */
    getLifecycleService() {
        return this.lifecycleService || FleetLifecycleService;
    }

    /**
     * @returns {Function} the provision-then-start composer (injected stub or `startAgentProvisioned`).
     * @protected
     */
    getProvisionAndStartFn() {
        return this.provisionAndStartFn || startAgentProvisioned;
    }

    /**
     * @returns {Function} the Git identity derivation (injected stub or `resolveSeatGitIdentity`).
     * @protected
     */
    getGitIdentityFn() {
        return this.gitIdentityFn || resolveSeatGitIdentity;
    }

    /**
     * @returns {Function} the forge account proof (injected stub or `proveSeatForgeAccount`).
     * @protected
     */
    getForgeProofFn() {
        return this.forgeProofFn || proveSeatForgeAccount;
    }

    /**
     * @returns {Function} the catalog read (injected stub or `readSeatModelCatalog`).
     * @protected
     */
    getModelCatalogFn() {
        return this.modelCatalogFn || readSeatModelCatalog;
    }

    /**
     * @summary Turnkey identity read: the Git identity a seat's commits would carry, from the derivation its Start
     * runs, its declaration, else its forge account read with its stored PAT. Add asks right after the define, so a
     * seat whose account offers no usable email gets its declaration before the first Start, which still verifies.
     *
     * Never a refusal and never a write: an unknown seat, a seat without a PAT, or a read that fails answers
     * `unknown` with the reason, never `derived`, and a PAT that belongs to another account answers `mismatch`.
     * @param {Object} [params]
     * @param {String} params.id Registry agent id.
     * @returns {Promise<Object>} `{state: 'declared'|'derived'|'missing'|'mismatch'|'unknown', source?, name?, email?, found?, reason?}`.
     */
    async fleetSeatGitIdentity({id} = {}) {
        const
            registry = this.getLifecycleService().getRegistry(),
            agent    = typeof id === 'string' && id ? registry.getDefinition?.(id) ?? registry.getAgent(id) : null;

        if (!agent) return {state: 'unknown', reason: `no agent '${id}' is registered`};

        const
            declared   = Boolean(agent.gitName && agent.gitEmail),
            credential = declared ? null : registry.resolveCredential(id);

        if (!declared && (typeof credential !== 'string' || !credential.trim())) {
            return {state: 'unknown', reason: 'no PAT is stored for it'}
        }

        try {
            return await this.getGitIdentityFn()({agent, credential})
        } catch (error) {
            return {state: 'unknown', reason: redactReadFailure(`the identity read failed: ${error?.message ?? error}`)}
        }
    }

    /**
     * @summary Turnkey catalog read: the models and reasoning efforts a seat's harness offers to declare, asked of the
     * harness ({@link module:ai/services/fleet/seatModelCatalog.readSeatModelCatalog}). Configuration offers exactly
     * these. A running seat answers the catalog its last start read, with when, because a second app-server never
     * starts beside a running seat's own; a seat running since before this Fleet started says so. A stopped seat's
     * read holds the seat's home ({@link withSeatHome}), so it never overlaps another read or a start.
     *
     * Never a refusal and never a write to the seat's record: an unknown seat, or a read that fails, answers its
     * state and reason.
     * @param {Object} [params]
     * @param {String} params.id Registry agent id.
     * @returns {Promise<Object>} `{state: 'complete'|'partial'|'unavailable'|'unsupported', models, efforts?, reason, observedAt?}`.
     */
    async fleetSeatModelCatalog({id} = {}) {
        const
            lifecycle = this.getLifecycleService(),
            registry  = lifecycle.getRegistry(),
            agent     = typeof id === 'string' && id ? registry.getDefinition?.(id) ?? registry.getAgent(id) : null;

        if (!agent) return {state: 'unavailable', models: [], reason: `no agent '${id}' is registered`};

        return this.withSeatHome(id, async () => {
            if (lifecycle.isRunning(id)) {
                return lifecycle.seatCatalogOf(id) ?? {state: 'unavailable', models: [], reason: 'the seat has run since before this Fleet started, so its catalog is read at its next start'}
            }

            try {
                return await this.getModelCatalogFn()({agent, instanceRoot: lifecycle.getInstanceRoot(), lifecycleService: lifecycle})
            } catch (error) {
                return {state: 'unavailable', models: [], reason: redactReadFailure(`the catalog read failed: ${error?.message ?? error}`)}
            }
        })
    }

    /**
     * @summary Runs one operation on a seat's home once every earlier one on it settled, and holds the home until it
     * settles. A catalog read starts the harness's app-server there, and a start launches the harness there, so the
     * two never overlap on one seat, and neither do two of either. An operation that throws releases the home all the
     * same.
     * @param {String}   id
     * @param {Function} operation `() => Promise<*>`
     * @returns {Promise<*>} The operation's own answer
     */
    async withSeatHome(id, operation) {
        const
            run  = (this.seatHomeHolds.get(id) ?? Promise.resolve()).then(operation),
            hold = run.catch(() => {});

        this.seatHomeHolds.set(id, hold);

        try {
            return await run
        } finally {
            this.seatHomeHolds.get(id) === hold && this.seatHomeHolds.delete(id)
        }
    }

    /**
     * @returns {Function} the repo-status aggregator (injected stub or `inspectFleetRepos`).
     * @protected
     */
    getRepoStatusFn() {
        return this.repoStatusFn || inspectFleetRepos;
    }

    /**
     * @summary Turnkey provision-then-start: ensure the agent's repo (at the resolved managed root)
     * exists, then start its harness inside it. Delegates to `startAgentProvisioned` — fail-closed on a
     * provisioning failure (the harness is not spawned). A seat released to its own harness is refused
     * before anything runs. So is one whose identity the operator benched, when the participation read
     * answers; it is read again just before the spawn, and a bench recorded after that read lands on a
     * starting seat ({@link launchRefusalOf}). The start holds the seat's home until its harness is
     * launched and armed or refused ({@link withSeatHome}). Stop cancels every already-pending attempt,
     * including one still queued for the home; a later explicit Start gets a fresh signal. The
     * operator's Skip ({@link skipAgentDependencies}) ends only the attempt's dependency install.
     * A ready route returned after Stop is retained as unresolved cleanup, never as a ready wake.
     * @param {String} agentId Registry agent id.
     * @returns {Promise<Object>} the agent's lifecycle status.
     */
    async startAgent(agentId) {
        this.assertStartPermitted('startAgent', agentId);

        const lifecycle     = this.getLifecycleService(),
              startSignal   = lifecycle.beginStart(agentId),
              admissionMark = lifecycle.getLaunchAdmission?.()?.revocationMark(agentId) ?? null;

        try {
            return await this.withSeatHome(agentId, async () => {
                startSignal.throwIfAborted();
                const participation = await this.seatParticipation(agentId);
                startSignal.throwIfAborted();
                this.assertStartPermitted('startAgent', agentId, participation);

                const status = await this.getProvisionAndStartFn()({
                    lifecycleService    : lifecycle,
                    managedRoot         : this.getManagedRoot(),
                    planeBase           : this.planeBase,
                    readParticipation   : () => this.seatParticipation(agentId),
                    dependencySkipSignal: lifecycle.dependencySkipSignal(agentId, startSignal),
                    admissionMark,
                    startSignal,
                    agentId
                });

                startSignal.throwIfAborted();
                if (status?.canceled) return status;

                // Keep the home until a late subscription has been withdrawn after cancellation;
                // otherwise that cleanup could remove the next Start's canonical subscription.
                const armed = await this.armSeatWake(agentId, status, startSignal);

                if (!startSignal.aborted) return armed;

                let wakeRoute = armed?.wakeRoute;

                if (wakeRoute?.state === 'ready') {
                    wakeRoute = {...wakeRoute, state: 'unarmed', reason: 'start canceled by Stop', cleanupUnresolved: true}
                }
                return {...lifecycle.canceledStart(agentId), ...(wakeRoute ? {wakeRoute} : {})}
            })
        } catch (error) {
            if (startSignal.aborted) return lifecycle.canceledStart(agentId);
            throw error
        } finally {
            lifecycle.finishStart(agentId, startSignal)
        }
    }

    /**
     * @returns {Function} the seat wake-arming composer (injected stub or `armFleetSeatWake`).
     * @protected
     */
    getWakeArmFn() {
        return this.wakeArmFn || armFleetSeatWake
    }

    /**
     * @summary Arms the wake route of a seat {@link startAgent} has just started, and records the
     * outcome on the seat's lifecycle record so its status says whether a peer can wake it.
     *
     * Never fails the start it follows: a refusal or an error becomes `wakeRoute: {state: 'unarmed',
     * reason}` beside a running seat. The receiver coordinates arrive through {@link wakeStateOptions}
     * and the attached plane through {@link planeBase}, both injected by the composing entrypoint.
     * @param {String} agentId Registry agent id.
     * @param {Object} status The lifecycle status `startAgent` produced.
     * @param {AbortSignal} [startSignal] The same lifecycle-owned pending attempt.
     * @returns {Promise<Object>} `status`, plus `wakeRoute` when a GUI wake applies to the seat.
     */
    async armSeatWake(agentId, status, startSignal) {
        const
            lifecycle = this.getLifecycleService(),
            registry  = lifecycle.getRegistry(),
            agent     = registry.getDefinition?.(agentId) ?? registry.getAgent(agentId),
            options   = this.wakeStateOptions || {};

        let wakeRoute;

        try {
            const tenantService = agent?.mcpTarget?.kind === 'tenant' || this.planeBase
                ? await this.getTenantService() : null;

            startSignal?.throwIfAborted();
            wakeRoute = await this.getWakeArmFn()({
                agent,
                startSignal,
                instanceHome: status?.instanceHome,
                planeBase   : this.planeBase,
                receiverBase: options.wakeReceiverBase,
                manifestPath: options.wakeReceiverManifestPath,
                tenantService
            })
        } catch (error) {
            wakeRoute = {state: 'unarmed', reason: redactReadFailure(`wake arming failed: ${error?.message ?? error}`)}
        }

        if (!wakeRoute) return status;

        // Arming can outlive the launch it was started for; the record takes it only from that launch.
        if (!startSignal?.aborted) lifecycle.setWakeRoute?.(agentId, wakeRoute, {pid: status?.pid, startedAt: status?.startedAt});

        return {...status, wakeRoute}
    }

    /**
     * @returns {Promise<Object>} the tenant collaborator (injected stub or the lazily imported singleton).
     * @protected
     */
    async getTenantService() {
        return this.tenantService ?? (await import('./FleetTenantService.mjs')).default
    }

    /**
     * @summary Turnkey fleet repo observability: the per-agent repo-provisioning state across the whole
     * fleet, at the resolved managed root. Delegates to `inspectFleetRepos` (read-only); the registry is
     * the lifecycle service's, so process + repo views key off one agent set.
     * @returns {Object[]} one status entry per registered agent (see `inspectFleetRepos`).
     */
    fleetRepoStatus() {
        return this.getRepoStatusFn()({
            registry   : this.getLifecycleService().getRegistry(),
            managedRoot: this.getManagedRoot()
        });
    }

    /**
     * @summary Turnkey fleet runtime observability: the per-agent process-runtime state across the whole
     * fleet — the live-process view complementing {@link fleetRepoStatus}'s repo view. Composes the
     * registry roster with the lifecycle service's per-agent {@link
     * Neo.ai.services.fleet.FleetLifecycleService#status} read, so every *registered* agent gets a row and
     * the cockpit renders the whole fleet, not only running processes. Read-only; never carries a secret
     * (`status` holds none — `stderrBytes` is a count). Lifecycle records expose running / stopped
     * directly; richer idle / wedged / rate-limited states need watchdog signals this service does not yet
     * surface (a separate watchdog-signals follow-up).
     *
     * **The row-per-agent guarantee is about row EXISTENCE, never about asserting a session state for
     * every agent**, and conflating the two publishes fiction. `status()` answers `stopped` for an agent
     * it holds no record of, which is a sound lifecycle default and an INVENTED VERDICT the moment it is
     * republished as fleet truth: never-launched is not stopped. A fleet running external-harness seats
     * it never launched once rendered every one of them `benched / offline` on exactly that confusion,
     * while the same rows carried `participationStatus: 'active'`.
     *
     * So a row with no backing process record reports `state: 'unmanaged'` with `confidence: 'none'` and
     * a reason naming the absence — **absence of signal, never a verdict** — and the state is never
     * invented. A record the fleet does own keeps `running` / `stopped` verbatim: that IS the
     * operator-benched fact, and it stays observable.
     *
     * One seat is the exception: `launchOwner: 'fleet'` makes this fleet its only sanctioned launcher,
     * so with no record it is not running under the fleet's own contract. It reports `stopped` with
     * `confidence: 'inferred'` — a policy inference, labelled as one — which lets the operator start it
     * the first time. A process record, once there, wins as `observed`.
     *
     * **`running: false` on an unmanaged row is a KNOWN residual assertion, kept deliberately — not
     * inherited by oversight.** The sentence above is honest about `state` and `confidence` and only
     * approximately honest here: if never-launched is not stopped, then no-record is equally not
     * not-running, and an external-harness seat may well be running right now. It survives because
     * `running` is a Boolean with no room for *unknown*, so correcting it means widening a PUBLISHED
     * wire-method field to a tri-state — a contract change, not a fix, and out of scope for the defect
     * this method's split addresses. The cost is bounded and was measured rather than assumed: the only
     * consumer that reads the field is `ai/scripts/fleet/onboardPeer.mjs`, and `Boolean(null) === false`
     * means it would behave identically either way. Widen it when a consumer actually needs to
     * distinguish "not running" from "we do not know" — and delete this paragraph when you do.
     * @returns {Object[]} one `{agentId, state, running, confidence, source}` entry per registered agent;
     *     rows without a process record additionally carry `reason`, a seat whose latest Start reached
     *     its install carries that attempt's `dependencies`, live or final, launched or not, a running
     *     Claude Desktop seat carries `sessionFolder`, where its session opened against its checkout, a seat with a
     *     provisioned start carries the `gitIdentity` that start resolved, a refused start's included, and the
     *     `seatModel` it found of the declared model in the harness's catalog, and a Codex seat carries the
     *     `harnessSettings` its config is set to now ({@link FleetLifecycleService#harnessSettingsFor}).
     *     `runtimeGeneration` preserves the actual Start's runtime and retention pin; unknown bindings
     *     remain unknown across installed-runtime changes.
     *     `nextRuntimeGeneration` is this connected Fleet's verified boot selection for new Starts.
     *     `installedGeneration` independently observes the installer-owned package slot; neither
     *     substitutes for the original Start, and both are absent for checkout runtimes.
     */
    fleetRuntimeStatus() {
        const lifecycle             = this.getLifecycleService();
        const installed             = lifecycle.installedRuntime?.generation;
        const nextRuntimeGeneration = installed ? {id: installed.id, payloadDigest: installed.payloadDigest,
            identity: [...installed.identity]} : null;
        const installedGeneration = installed ? readInstalledRuntimeGeneration({directory: path.dirname(installed.directory)}) : null;

        return lifecycle.getRegistry().listAgents().map(agent => {
            const status   = lifecycle.status(agent.id),
                  observed = status.state !== 'stopped' || status.pid != null || status.startedAt != null || status.exitCode != null,
                  inferred = !observed && agent.launchOwner === 'fleet';

            const row = {
                agentId   : agent.id,
                state     : observed ? status.state : inferred ? 'stopped' : 'unmanaged',
                running   : status.running,
                confidence: observed ? 'observed' : inferred ? 'inferred' : 'none',
                source    : 'fleet:runtimeStatus'
            };

            // The cause travels with the fact: downstream normalization keeps a producer's reason
            // verbatim and is forbidden from inventing one, so the honest "why" has to originate here.
            if (inferred) {
                row.reason = 'no fleet process record: this fleet is the seat\'s only launcher, so it is stopped'
            } else if (!observed) {
                row.reason = 'no fleet process record: this agent runs outside fleet supervision'
            }

            const harnessSettings = lifecycle.harnessSettingsFor(agent);

            if (status.failureReason != null) row.failureReason     = status.failureReason;
            if (status.cleanupUnresolved)     row.cleanupUnresolved = true;
            if (status.repos != null)         row.repos           = status.repos;
            if (status.dependencies != null)  row.dependencies    = status.dependencies;
            if (status.sessionFolder != null)   row.sessionFolder   = status.sessionFolder;
            if (status.exitReason != null)      row.exitReason      = status.exitReason;
            if (status.gitIdentity != null)     row.gitIdentity     = status.gitIdentity;
            if (status.seatModel != null)       row.seatModel       = status.seatModel;
            if (status.launchAdmission != null)   row.launchAdmission   = status.launchAdmission;
            if (status.runtimeGeneration != null) row.runtimeGeneration = status.runtimeGeneration;
            if (installedGeneration)              row.installedGeneration = installedGeneration;
            if (nextRuntimeGeneration)            row.nextRuntimeGeneration = nextRuntimeGeneration;
            if (harnessSettings != null)          row.harnessSettings   = harnessSettings;

            return row;
        });
    }

    /**
     * @summary Turnkey wake-state observability: the per-agent wake axis of the S2 telltale taxonomy
     * (`on | off | suppressed | unknown`) across the registered roster — the third fleet view beside
     * {@link fleetRepoStatus} (repos) and {@link fleetRuntimeStatus} (processes).
     *
     * Delegates to `fleetWakeStateAdapter.readFleetWakeStateSnapshot` with the registry roster (one
     * row per REGISTERED agent, same one-agent-set rule as the sibling views) plus the injected
     * {@link #member-wakeStateOptions}. Observation truth only: subscription intent × daemon PID-file
     * liveness × the daemon-owned terminal delivery-failure receipts; the `setWakeEnabled` control
     * verb mutates state this view independently observes.
     * Fail-honest: with no injected options every row reads `unknown` under a `degraded/none`
     * capability — "we cannot see" stays distinguishable from "the fleet is off"; the state is never
     * invented.
     * @returns {Promise<{capability: Object, states: Object[]}>} Adapter snapshot: per-agent
     * `{agentId, wake, confidence, source}` rows (+ a reason/receipt on degraded delivery) and the
     * capability envelope.
     */
    fleetWakeStatus() {
        return readFleetWakeStateSnapshot({
            agents: this.getLifecycleService().getRegistry().listAgents(),
            ...(this.wakeStateOptions || {})
        });
    }

    /**
     * @summary Turnkey stop: gracefully stop an agent's harness process (`SIGTERM`, then `SIGKILL` after
     * the timeout) via the lifecycle collaborator. A thin delegation — stopping a process needs no
     * `managedRoot` / provisioning, so it forwards straight to `FleetLifecycleService.stop`, mirroring how
     * `fleetRepoStatus` forwards to its aggregator.
     * @param {String} agentId Registry agent id.
     * @returns {Promise<Object>} `{success, id, state, cleanupUnresolved}` from the lifecycle
     * service's `stop`.
     */
    stopAgent(agentId) {
        return this.getLifecycleService().stop(agentId);
    }

    /**
     * @summary The operator's Skip of a starting seat's dependency install: the checkouts it interrupts
     * read `skipped`, and the Start launches. A thin delegation to `FleetLifecycleService.skipDependencies`,
     * like {@link stopAgent}.
     * @param {String} agentId Registry agent id.
     * @returns {{id: String, skippedStarts: Number}} how many pending Starts the Skip reached.
     */
    skipAgentDependencies(agentId) {
        return this.getLifecycleService().skipDependencies(agentId);
    }

    /**
     * @summary Turnkey throttle-state observability: the per-agent throttle axis of the S2 telltale
     * taxonomy (`none | overage | rate-limited | unknown`) across the registered roster — a fleet
     * view beside {@link fleetRepoStatus} (repos) and {@link fleetRuntimeStatus} (processes).
     *
     * Delegates to `fleetThrottleStateAdapter.readFleetThrottleStateSnapshot` with the registry
     * roster (one row per REGISTERED agent, the sibling views' one-agent-set rule) plus the injected
     * {@link #member-throttleStateOptions}. Fail-honest: no trustworthy throttle truth source exists
     * in the platform yet (the adapter documents the evaluated candidates), so the default is every
     * row `unknown` under a `degraded/none` capability — "we cannot see" stays distinguishable from
     * "nothing is throttled"; the state is never invented.
     * @returns {Promise<{capability: Object, states: Object[]}>} Adapter snapshot: per-agent
     * `{agentId, throttle, confidence, source}` rows (+ `reason` on `unknown`) and the capability envelope.
     */
    fleetThrottleStatus() {
        return readFleetThrottleStateSnapshot({
            agents: this.getLifecycleService().getRegistry().listAgents(),
            ...(this.throttleStateOptions || {})
        });
    }

    /**
     * @summary Turnkey presence observability: the per-agent presence axis of the truth-preserving
     * presence contract across the registered roster — the THIRD independent signal
     * beside {@link fleetWakeStatus} (wake routes) and {@link fleetThrottleStatus} (throttle),
     * none inferring another.
     *
     * Delegates to `fleetPresenceStateAdapter.readFleetPresenceSnapshot` with the registry roster
     * (one row per REGISTERED agent, the sibling views' one-agent-set rule) plus the injected
     * {@link #member-presenceStateOptions}. Fail-honest: with no injected reader every row reads
     * `unknown` under a `degraded/none` capability — "we cannot see presence" stays distinguishable
     * from "the fleet is dark"; a band is never invented.
     * @returns {Promise<{capability: Object, states: Object[]}>} Adapter snapshot: per-agent
     * `{agentId, presence, lastSeenAt, confidence, source}` rows (+ `reason` on `unknown`) and the
     * capability envelope.
     */
    fleetPresenceStatus() {
        return readFleetPresenceSnapshot({
            agents: this.getLifecycleService().getRegistry().listAgents(),
            ...(this.presenceStateOptions || {})
        });
    }

    /**
     * @summary Turnkey restart: stop the agent, then start it again through the provisioned path
     * ({@link startAgent}) — so the restarted harness re-ensures its repo and runs inside ITS checkout,
     * not the Fleet Manager's own directory. Deliberately NOT a delegation to the lifecycle service's own
     * `restart`, which re-starts with no `cwd`: that would re-spawn a provisioned agent in the wrong
     * directory, and the checkout-path-keyed auto-memory would silently fork (the exact failure the
     * provisioned start path prevents). Restarting a non-running agent is just a provisioned start. A
     * seat the start would refuse is refused before the stop. An exact runtime choice is checked again
     * after Stop; if its installed target changed during cleanup, the seat stays stopped with a refusal.
     * @param {String} agentId Registry agent id.
     * @param {Object} [options]
     * @param {String} [options.expectedRuntimeGeneration] Exact installed/next-Start identity the operator selected.
     * @returns {Promise<Object>} the agent's lifecycle status (see {@link startAgent}).
     */
    async restartAgent(agentId, {expectedRuntimeGeneration} = {}) {
        this.assertStartPermitted('restartAgent', agentId, await this.seatParticipation(agentId));
        this.assertRuntimeRestartTarget(expectedRuntimeGeneration);

        const stopped = await this.stopAgent(agentId);

        if (stopped.cleanupUnresolved) {
            throw new Error(`FleetManager.restartAgent: cleanup failed for agent '${agentId}'; refusing to spawn a replacement over ambiguous residual processes.`);
        }

        this.assertRuntimeRestartTarget(expectedRuntimeGeneration);
        return this.startAgent(agentId);
    }

    /**
     * @summary Refuses an exact runtime promise before Stop and revalidates it before the new Start.
     * @param {String} [expected] Installed runtime identity chosen by the operator; omitted for ordinary restart.
     */
    assertRuntimeRestartTarget(expected) {
        if (expected === undefined) return;
        const next      = this.getLifecycleService().installedRuntime?.generation;
        const installed = next ? readInstalledRuntimeGeneration({directory: path.dirname(next.directory)}) : null;
        if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || next?.id !== expected ||
            installed?.state !== 'observed' || installed.id !== expected) {
            throw Object.assign(new Error('FleetManager.restartAgent: the runtime target changed or is not verified; review it before restarting.'),
                {code: 'runtime-target-changed'});
        }
    }

    /**
     * @summary Throws when the registry, or the participation the seat's identity node records, says this
     * fleet may not start the seat ({@link launchRefusalOf}).
     * @param {String}      method               The refusing verb, for the error's origin.
     * @param {String}      agentId              Registry agent id.
     * @param {Object|null} [participation=null] The seat's participation ({@link seatParticipation}).
     * @private
     */
    assertStartPermitted(method, agentId, participation = null) {
        const refusal = launchRefusalOf(this.getLifecycleService().getRegistry().getAgent(agentId), participation);

        if (refusal) {
            throw new Error(`FleetManager.${method}: agent '${agentId}' was ${refusal}.`)
        }
    }

    /**
     * @summary The seat's participation as its identity node records it, from a presence snapshot of that
     * one seat.
     * @param {String} agentId Registry agent id.
     * @returns {Promise<Object|null>} `{status, reason, since}`, or `null` when no reader is wired, the read did
     *     not answer, or it holds no record for the seat, none of which a start gate refuses.
     * @protected
     */
    async seatParticipation(agentId) {
        const agent = this.getLifecycleService().getRegistry().getAgent(agentId);

        if (!agent || !this.presenceStateOptions?.readPresence) return null;

        const {states} = await readFleetPresenceSnapshot({...this.presenceStateOptions, agents: [agent]});

        return states[0]?.participation ?? null
    }

    /**
     * @summary Turnkey remove: take an agent out of the fleet — stop its process first (so removal never
     * leaves an orphaned, unmanageable live harness), then deregister its definition + stored PAT via the
     * registry. **Deliberately non-destructive to disk:** the agent's on-disk checkout and its
     * checkout-path-keyed auto-memory are left intact, because deleting the checkout would orphan that
     * auto-memory — the reconciliation (delete / archive / tombstone) is a Memory-Core policy that must
     * land WITH the deletion, not after it. So the destructive checkout cleanup stays coupled with that
     * reconciliation rather than orphaning here. Stopping a non-running agent is a safe no-op.
     * @param {String} agentId Registry agent id.
     * @returns {Promise<Object>} `{success, id}` from the registry's `removeAgent` (`success` ⇒ the agent
     * existed and was deregistered).
     */
    async removeAgent(agentId) {
        const stopped = await this.stopAgent(agentId);

        if (stopped.cleanupUnresolved) {
            throw new Error(`FleetManager.removeAgent: cleanup failed for agent '${agentId}'; refusing to deregister an agent with ambiguous residual processes.`);
        }

        return this.getLifecycleService().getRegistry().removeAgent(agentId);
    }

    /**
     * @summary Set the agent's working-repo coordinates on its registry definition — `metadata.repo =
     * {cloneUrl, repoSlug}`, the EXACT convention {@link Neo.ai.services.fleet.startAgentProvisioned}
     * already honors (it clones/reuses that repo and pins the harness `cwd` to the checkout). So this is
     * functional end-to-end: the next provisioned start launches the agent in the newly-set repo. Takes
     * a SINGLE payload object (`{id, …}`) — mirroring `defineAgent` and the app↔fleet wire's single-
     * `params` contract ({@link Neo.ai.services.fleet.dispatchFleetRequest}), so it is pane-reachable
     * over the wire. A thin fleet-authority delegation to the registry's partial update (the FM owns the
     * definition registry) — NOT a cross-agent control-plane op. **Non-destructive to disk**, mirroring
     * {@link removeAgent}: it does not move or delete the agent's EXISTING checkout or its
     * checkout-path-keyed auto-memory; the next provisioned start ensures the new checkout (clone-or-
     * reuse, never clobber), and reconciling a now-stale old checkout is a Memory-Core policy, not
     * orphaned here. Replaces `metadata.repo` wholesale (a repo is set as a unit); other metadata keys
     * survive the merge.
     *
     * The verb is the boundary, not its callers: the coordinates pass {@link repoCoordinates}, so no
     * caller points a seat's harness at a directory it chose. `{id}` alone clears the repo.
     * @param {Object}  payload
     * @param {String}  payload.id        Registry agent id.
     * @param {String} [payload.repoSlug] `owner/repo`: the checkout dir under the agents root.
     * @param {String} [payload.cloneUrl] A remote naming that repo; defaults to the slug on the seat's forge,
     * `https://github.com/<repoSlug>.git` or `<forgeHost>/<repoSlug>.git` ({@link seatRepoEntry}).
     * @param {String} [payload.forge]    `'gitlab'` for a GitLab repository; without a clone URL, the seat's forge.
     * @returns {Object|null} The updated public definition, or `null` if the agent doesn't exist.
     * @throws {Error} On what {@link repoCoordinates} refuses, or a checkout that would collide with one
     * of the seat's other repositories.
     */
    setRepo({id, cloneUrl, forge, repoSlug} = {}) {
        const
            caller   = 'FleetManager.setRepo',
            registry = this.getLifecycleService().getRegistry(),
            seat     = registry.getAgent(id),
            repo     = repoSlug != null || cloneUrl != null || forge != null
                ? repoCoordinates(seatRepoEntry({repoSlug, cloneUrl, forge}, seat), caller)
                : {};

        if (repo.repoSlug) {
            assertOnSeatForge(repo, seat, caller);
            assertNoCheckoutCollision([repo.repoSlug, ...(seat?.metadata?.repos ?? []).map(entry => entry.repoSlug)], caller)
        }

        return registry.updateAgent(id, {metadata: {repo}});
    }

    /**
     * @summary Set the seat's other repositories: `metadata.repos`, an ordered list of `{repoSlug,
     * cloneUrl}` beside the working repository of {@link setRepo}. A provisioned start clones each one
     * beside the working checkout ({@link Neo.ai.services.fleet.startAgentProvisioned}).
     *
     * The list is set as a unit, and `{id, repos: []}` clears it. Each entry passes
     * {@link repoCoordinates}. A duplicate is refused, and so are the working repository itself and a
     * seat without one. This is a verb of its own because `setRepo`'s callers set the working repository
     * as a unit, so a wider `setRepo` payload would let them clear these. Non-destructive to disk, like
     * {@link setRepo}: a repository dropped from the list keeps its checkout.
     * @param {Object}   payload
     * @param {String}   payload.id    Registry agent id.
     * @param {Object[]} payload.repos `[{repoSlug, cloneUrl?, forge?}]`; an entry without a clone URL takes the
     * seat's forge, as in {@link setRepo}.
     * @returns {Object|null} The updated public definition, or `null` if the agent doesn't exist.
     * @throws {Error} On a list that is not an array, an invalid entry, a duplicate, the working
     * repository, or a seat that has no working repository.
     */
    setRepos({id, repos} = {}) {
        const
            caller   = 'FleetManager.setRepos',
            registry = this.getLifecycleService().getRegistry();

        if (!Array.isArray(repos)) {
            throw new Error(`${caller}: 'repos' must be an array of {repoSlug, cloneUrl}.`)
        }

        const agent = registry.getAgent(id);

        if (!agent) return null;

        const
            identity = repo => `${repo.forge ?? 'github'}:${repo.repoSlug}`,
            working  = agent.metadata?.repo,
            entries  = repos.map(entry => repoCoordinates(seatRepoEntry(entry && typeof entry === 'object' ? entry : {}, agent), caller)),
            ids      = entries.map(identity);

        // worded for the operator, who reads these reasons in Accounts
        if (entries.length && !working?.repoSlug) {
            throw new Error(`${caller}: this seat has no working repository yet; set it first, then its other repositories.`)
        }
        if (ids.includes(identity(working ?? {}))) {
            throw new Error(`${caller}: the working repository is already this seat's own; list only its other repositories.`)
        }
        if (new Set(ids).size !== ids.length) {
            throw new Error(`${caller}: a repository is listed twice.`)
        }

        entries.length && assertNoCheckoutCollision([working.repoSlug, ...entries.map(entry => entry.repoSlug)], caller);

        return registry.updateAgent(id, {metadata: {repos: entries}});
    }

    /**
     * @summary Delete an unlisted checkout only after inspecting its retained work. Working/listed
     * repositories (including overlapping paths) are protected. The seat-home hold excludes Start
     * and preparation; the definition is read again immediately before the synchronous remover.
     * Dirty/untracked/ignored files, stashes and local refs/HEAD absent from remote-tracking refs
     * refuse. Only root node_modules with an installed dependency receipt is disposable.
     * No fetch or open-folder check runs; external processes can still write during these reads.
     * Nested/shared Git storage (submodules, module histories and linked worktrees) is refused.
     * Success retires this checkout's current Lifecycle outcome so a refresh cannot revive its row.
     * @param {Object} payload Closed `{id, repoSlug}`; paths never come from the caller.
     * @returns {Promise<Object|null>} `{removed: true, repoPath}` or `{removed: false, reason}`;
     * null for an unknown seat. Filesystem failure may leave a partially removed checkout.
     */
    async removeRepoCheckout(payload = {}) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
            Object.keys(payload).some(key => !['id', 'repoSlug'].includes(key)) || typeof payload.id !== 'string' || !payload.id.trim()) {
            throw new Error('FleetManager.removeRepoCheckout: name only a seat id and repository slug.')
        }
        try {
            assertRepoSlug(payload.repoSlug, 'FleetManager.removeRepoCheckout')
        } catch {
            throw new Error('FleetManager.removeRepoCheckout: name a valid managed repository slug.')
        }
        const {id, repoSlug} = payload, lifecycle = this.getLifecycleService(), registry = lifecycle.getRegistry();

        return this.withSeatHome(id, async () => {
            const agent = registry.getDefinition(id);
            if (!agent) return null;
            const managedRoot = this.getManagedRoot(), options = this.repoRemovalOptions || {},
                  repoPath    = deriveAgentRepoPath({managedRoot, agentId: id, repoSlug}),
                  refusal     = current => {
                      if (current.metadata?.launch || current.seatHome !== path.resolve(managedRoot, id) || managedRoot !== this.getManagedRoot()) {
                          return 'The seat has no matching managed home; reconcile its placement before deleting a checkout.'
                      }
                      const overlaps = slug => slug && (slug === repoSlug || slug.startsWith(`${repoSlug}/`) || repoSlug.startsWith(`${slug}/`));
                      if (overlaps(current.metadata?.repo?.repoSlug)) return 'The working repository cannot be deleted.';
                      if ((current.metadata?.repos ?? []).some(entry => overlaps(entry.repoSlug))) return 'Unlist the repository before deleting its checkout.';
                      return null
                  };
            let reason = refusal(agent);
            if (reason) return {removed: false, reason};

            const inspection = inspectAgentRepo({repoPath});
            if (!inspection.isCheckout) return {removed: false, reason: 'No readable checkout was found at the managed path; nothing was deleted.'};

            const receipt = readDependencyReceipt(path.join(agent.seatHome, DEPENDENCY_RECEIPT)),
                  guard   = await inspectRepoRemoval({managedRoot, repoPath, dependenciesOwned: receipt[repoSlug]?.state === 'installed', readGit: options.readGit});
            if (!guard.safe) return {removed: false, reason: guard.reason};

            const current = registry.getDefinition(id);
            if (!current) return null;
            reason = refusal(current);
            if (reason) return {removed: false, reason};

            try {
                const result = removeAgentRepo({managedRoot, agentId: id, repoSlug, removeDir: options.removeDir});
                if (result.removed) lifecycle.retireRepoOutcome(id, repoSlug);
                return result.removed ? {removed: true, repoPath: result.repoPath} : {removed: false, reason: 'The checkout is no longer readable at its managed path.'}
            } catch {
                return {removed: false, reason: 'The checkout could not be fully removed. Inspect the remaining files before retrying.'}
            }
        })
    }

    /**
     * @summary Prepares a running seat's additional repositories without restarting its harness or
     * rewriting its workspace. New checkouts receive the captured launch's Git identity; reuse
     * verifies it without writing, including a previous clone whose identity step failed.
     * Results publish only while that same launch remains live.
     * An in-flight clone cannot be interrupted: superseded results retain their rows, and the next
     * Start can reuse any checkout the old operation created.
     * @param {Object} payload Closed `{id}`; repository coordinates remain registry-owned.
     * @returns {Promise<Object|null>} `{state: 'complete'|'at-start'|'identity-unavailable'|'superseded',
     * repos, reason?}`; null for an unknown seat. Missing launch identity requires the next Start.
     */
    async prepareRepos(payload = {}) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
            Object.keys(payload).some(key => key !== 'id') || typeof payload.id !== 'string' || !payload.id.trim()) {
            throw new Error('FleetManager.prepareRepos: name exactly one seat id.')
        }

        const {id}  = payload, lifecycle = this.getLifecycleService(), registry = lifecycle.getRegistry(),
              agent = registry.getDefinition(id);

        if (!agent) return null;

        const launch    = lifecycle.status(id),
              isCurrent = () => {
                  const current = lifecycle.status(id);
                  return lifecycle.isRunning(id) && current.pid === launch.pid && current.startedAt === launch.startedAt
              };

        if (!lifecycle.isRunning(id) || !launch.pid || !launch.startedAt) return {state: 'at-start', repos: []};
        if (!['declared', 'derived'].includes(launch.gitIdentity?.state) || !launch.gitIdentity.name || !launch.gitIdentity.email) {
            return {state: 'identity-unavailable', repos: [], reason: 'The running launch has no recorded Git identity; its next Start records it.'}
        }

        return this.withSeatHome(id, async () => {
            if (!isCurrent()) return {state: 'superseded', repos: []};

            const managedRoot = this.getManagedRoot();
            if (agent.metadata?.launch || agent.seatHome !== path.resolve(managedRoot, id)) {
                throw new Error('FleetManager.prepareRepos: the seat has no matching managed home; reconcile its placement before preparing repositories.')
            }

            const options  = this.repoPreparationOptions || {},
                  identity = {name: launch.gitIdentity.name, email: launch.gitIdentity.email};
            let credential, credentialFailure;

            try {
                credential = registry.resolveCredential(id);
                if (!credential) credentialFailure = 'the seat has no stored credential; update it before preparing repositories'
            } catch (error) {
                credentialFailure = redactReadFailure(error) ?? 'the stored credential could not be read'
            }

            const result = await ensureAgentRepos({
                repos           : agent.metadata?.repos ?? [], managedRoot, agentId: id, credential,
                credentialOrigin: agent.forgeHost, via: 'prepare', isCurrent,
                cloneRepo       : options.cloneRepo, now: options.now,
                ensureRepo      : credentialFailure ? async () => {throw new Error(credentialFailure)} : options.ensureRepo,
                onEnsured       : async ({repoPath, cloned}) => {
                    const outcome = await (options.convergeGitIdentity || convergeSeatGitIdentity)({repoPath, identity, readOnly: !cloned});
                    if (outcome.state !== 'converged') throw new Error(outcome.reason || 'the checkout Git identity did not converge')
                }
            });
            const recorded = result.current && isCurrent() && lifecycle.setRepoOutcomes(id, result.repos, launch);

            return {state: recorded ? 'complete' : 'superseded', repos: result.repos}
        })
    }

    /**
     * @summary Set the agent's profile-avatar reference on its registry definition
     * (`metadata.avatarUrl`) — a fleet-authority presentation-field control, like `setRepo`. Single
     * `{id, …}` payload (wire-compatible via {@link Neo.ai.services.fleet.dispatchFleetRequest}); a thin
     * delegation to the registry's partial update, so other metadata keys survive the merge. A display
     * reference only — not cross-agent-privileged, so fleet authority, not control-plane.
     * @param {Object}  payload
     * @param {String}  payload.id         Registry agent id.
     * @param {String} [payload.avatarUrl] The avatar image URL / reference to record.
     * @returns {Object|null} The updated public definition, or `null` if the agent doesn't exist.
     */
    setAvatar({id, avatarUrl} = {}) {
        const metadata = {};
        if (avatarUrl != null) metadata.avatarUrl = avatarUrl;

        return this.getLifecycleService().getRegistry().updateAgent(id, {metadata});
    }

    /**
     * @summary Explicitly set or rebind a seat credential for the plane this Fleet serves, where its
     * Memory Core and Knowledge Base live ({@link Neo.ai.services.fleet.startAgentProvisioned}). The
     * caller names only the seat and credential: the plane is the one this Fleet serves, and the
     * identity the credential must prove is the seat's row. An ordinary default-plane Start binds the
     * PAT already stored for that seat when no binding exists. Inbound once, never returned.
     * @param {Object} payload
     * @param {String} payload.id         Registry agent id.
     * @param {String} payload.credential Credential the plane must prove belongs to the seat.
     * @returns {Promise<Object>} `{status: 'stored', endpoint, agentId}` or `{status: 'rejected', reason}`.
     */
    async setPlaneCredential({id, credential} = {}) {
        if (!this.planeBase) return {status: 'rejected', reason: 'this Fleet serves no plane'};

        const agent = this.getLifecycleService().getRegistry().getAgent(id);

        if (!agent) return {status: 'rejected', reason: 'unknown agent'};

        return (await this.getTenantService()).storeSeatPlaneCredential({
            planeBase: this.planeBase,
            agentId  : agent.id,
            identity : agent.githubUsername,
            credential
        })
    }

    /**
     * @summary Replace a stopped seat's rejected or rotated token coherently across its selected credential
     * bindings (`scope: 'forge'` or `'forge-and-bound-plane'`).
     *
     * Proves every selected use before the first store write (`proveSeatForgeAccount` and, when
     * `'forge-and-bound-plane'` is selected, `probeSeatPlaneCredential` against the existing bound
     * `{id, dataRoot}` without implicit rebinding). Writes per-seat deltas over freshly read strict maps,
     * records durable incomplete-publication state across the multi-store boundary, verifies readback on
     * all selected stores before returning `status: 'replaced'`, and returns a non-secret receipt that
     * separates persisted authority, carrier preparation (`'deferred-until-start'`), and running-session
     * state (`'stopped'`).
     * @param {Object} payload `{id, credential, scope}`
     * @returns {Promise<Object>}
     */
    async replaceSeatCredential(payload = {}) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
            Object.keys(payload).some(key => !['id', 'credential', 'scope'].includes(key))) {
            return {
                status : 'rejected',
                cause  : 'indeterminate',
                reason : 'replaceSeatCredential accepts only {id, credential, scope}',
                receipt: buildCredentialReplacementReceipt({scope: payload?.scope, forge: 'unchanged'})
            }
        }

        const {scope} = payload;
        if (!REPLACE_SEAT_CREDENTIAL_SCOPES.includes(scope)) {
            return {
                status : 'rejected',
                cause  : 'indeterminate',
                reason : "scope must be 'forge' or 'forge-and-bound-plane'",
                receipt: buildCredentialReplacementReceipt({scope: null, forge: 'unchanged', plane: 'not-selected'})
            }
        }

        const
            id      = typeof payload.id === 'string' ? payload.id.trim() : '',
            trimmed = typeof payload.credential === 'string' ? payload.credential.trim() : '';

        if (!id) {
            return {
                status : 'rejected',
                scope,
                cause  : 'indeterminate',
                reason : 'a seat id is required',
                receipt: buildCredentialReplacementReceipt({scope, forge: 'unchanged'})
            }
        }

        if (!trimmed) {
            return {
                status : 'rejected',
                id,
                scope,
                cause  : 'indeterminate',
                reason : 'credential is required',
                receipt: buildCredentialReplacementReceipt({scope, forge: 'unchanged'})
            }
        }

        return this.withSeatHome(id, async () => {
            const
                lifecycle = this.getLifecycleService(),
                registry  = lifecycle.getRegistry(),
                agent     = registry.getDefinition?.(id) ?? registry.getAgent?.(id);

            if (!agent) {
                return {
                    status : 'rejected',
                    id,
                    scope,
                    cause  : 'indeterminate',
                    reason : `no agent '${id}' is registered`,
                    receipt: buildCredentialReplacementReceipt({scope, forge: 'unchanged'})
                }
            }

            const
                status       = typeof lifecycle.status === 'function' ? lifecycle.status(id) : null,
                pendingCount = lifecycle.pendingStarts?.get?.(id)?.size ?? 0;

            if (lifecycle.isRunning?.(id) || pendingCount > 0 || status?.running === true ||
                status?.state === 'running' || status?.state === 'stopping') {
                return {
                    status : 'rejected',
                    id,
                    scope,
                    cause  : 'seat-running',
                    reason : `agent '${id}' is running; stop it before replacing its credential`,
                    receipt: buildCredentialReplacementReceipt({scope, forge: 'unchanged', session: 'running'})
                }
            }

            if (status?.cleanupUnresolved === true || status?.ownershipUnresolved === true) {
                return {
                    status : 'rejected',
                    id,
                    scope,
                    cause  : 'profile-in-use',
                    reason : `agent '${id}' has unresolved helper processes holding its profile; resolve or stop them before replacing its credential`,
                    receipt: buildCredentialReplacementReceipt({scope, forge: 'unchanged'})
                }
            }

            if (['claude-desktop', 'antigravity'].includes(agent.harnessType) &&
                typeof lifecycle.desktopProfileInUse === 'function' &&
                (lifecycle.processListFn != null || lifecycle !== FleetLifecycleService)) {
                const inUse = lifecycle.desktopProfileInUse(agent);
                if (inUse !== false) {
                    return {
                        status: 'rejected',
                        id,
                        scope,
                        cause : 'profile-in-use',
                        reason: inUse
                            ? `agent '${id}' has its desktop profile open in another process; quit that application before replacing its credential`
                            : `the process table could not be read to confirm agent '${id}'s desktop profile is closed`,
                        receipt: buildCredentialReplacementReceipt({scope, forge: 'unchanged'})
                    }
                }
            }

            const
                otherSeats    = registry.listAgents?.() ?? [],
                runningShared = otherSeats.find(other =>
                    other?.id && other.id !== id &&
                    other.seatHome && agent.seatHome &&
                    other.seatHome === agent.seatHome &&
                    lifecycle.isRunning?.(other.id)
                );

            if (runningShared) {
                return {
                    status : 'rejected',
                    id,
                    scope,
                    cause  : 'profile-in-use',
                    reason : `agent '${id}' shares its seat home with running agent '${runningShared.id}'; stop it before replacing its credential`,
                    receipt: buildCredentialReplacementReceipt({scope, forge: 'unchanged'})
                }
            }

            const priorReplacement = typeof registry.getCredentialReplacementState === 'function'
                ? registry.getCredentialReplacementState(id)
                : null;

            if (priorReplacement?.state === 'corrupt') {
                return {
                    status    : 'rejected',
                    id,
                    scope,
                    surface   : 'forge',
                    cause     : 'indeterminate',
                    incomplete: true,
                    reason    : priorReplacement.reason,
                    receipt   : buildCredentialReplacementReceipt({scope, forge: 'unchanged', coherent: false, incomplete: true})
                }
            }

            if (priorReplacement && priorReplacement.scope === 'forge-and-bound-plane' && scope === 'forge') {
                return {
                    status    : 'rejected',
                    id,
                    scope,
                    surface   : 'plane',
                    cause     : 'indeterminate',
                    incomplete: true,
                    reason    : `agent '${id}' has an incomplete 'forge-and-bound-plane' replacement; re-run with scope 'forge-and-bound-plane' to reconcile both stores`,
                    receipt   : buildCredentialReplacementReceipt({scope, forge: 'unchanged', plane: 'unchanged', boundPlane: priorReplacement.boundPlane ? {endpoint: priorReplacement.planeBase, ...priorReplacement.boundPlane} : null, coherent: false, incomplete: true})
                }
            }

            if (typeof registry.canPersistCredential === 'function') {
                const forgeCheck = registry.canPersistCredential(id);
                if (!forgeCheck.ok) {
                    return {
                        status : 'rejected',
                        id,
                        scope,
                        surface: 'forge',
                        cause  : 'indeterminate',
                        reason : forgeCheck.reason,
                        receipt: buildCredentialReplacementReceipt({scope, forge: 'unchanged'})
                    }
                }
            }

            let tenantService = null, boundPlane = null;

            if (scope === 'forge-and-bound-plane') {
                const
                    placement     = resolveSeatPlaneTarget({target: agent.mcpTarget, harnessType: agent.harnessType, planeBase: this.planeBase}),
                    planeEndpoint = placement?.kind === 'plane' ? placement.endpoint : this.planeBase;

                if (!planeEndpoint) {
                    return {
                        status : 'rejected',
                        id,
                        scope,
                        surface: 'plane',
                        cause  : 'indeterminate',
                        reason : 'this Fleet serves no bound plane for this seat',
                        receipt: buildCredentialReplacementReceipt({scope, forge: 'unchanged', plane: 'unchanged'})
                    }
                }

                tenantService = await this.getTenantService();
                const planeCheck = tenantService.canPersistBoundSeatPlaneCredential({
                    planeBase: planeEndpoint,
                    agentId  : id
                });

                if (!planeCheck.ok) {
                    return {
                        status : 'rejected',
                        id,
                        scope,
                        surface: 'plane',
                        cause  : planeCheck.cause || 'indeterminate',
                        reason : planeCheck.reason,
                        receipt: buildCredentialReplacementReceipt({scope, forge: 'unchanged', plane: 'unchanged'})
                    }
                }

                boundPlane = {
                    endpoint: planeCheck.endpoint,
                    id      : planeCheck.plane.id,
                    dataRoot: planeCheck.plane.dataRoot
                }
            }

            const forgeProof = await this.getForgeProofFn()({agent, credential: trimmed});
            if (!forgeProof?.ok) {
                const
                    refusal   = credentialRefusalOf(forgeProof, 'forge'),
                    forgeName = agent.forge === 'gitlab' ? 'GitLab' : 'GitHub',
                    reason    = refusal.cause === 'wrong-identity'
                        ? `the ${forgeName} PAT belongs to another forge account, not to '${agent.githubUsername}'`
                        : (refusal.cause === 'transport-unavailable'
                            ? `the ${forgeName} forge could not be reached to prove '${agent.githubUsername}'`
                            : `the ${forgeName} forge rejected the PAT for '${agent.githubUsername}'`);

                return {
                    status           : 'rejected',
                    id,
                    scope,
                    surface          : 'forge',
                    cause            : refusal.cause,
                    reason,
                    credentialRefusal: refusal,
                    receipt          : buildCredentialReplacementReceipt({
                        scope,
                        forge: 'unchanged',
                        plane: scope === 'forge-and-bound-plane' ? 'unchanged' : 'not-selected',
                        boundPlane
                    })
                }
            }

            if (scope === 'forge-and-bound-plane') {
                const
                    expectedIdentity = `@${String(agent.githubUsername).trim().replace(/^@/, '')}`,
                    planeProof       = await tenantService.probeSeatPlaneCredential({
                        planeBase    : boundPlane.endpoint,
                        credential   : trimmed,
                        expectedIdentity,
                        expectedPlane: {id: boundPlane.id, dataRoot: boundPlane.dataRoot}
                    });

                if (!planeProof?.ok) {
                    const refusal = credentialRefusalOf(planeProof, 'plane');
                    return {
                        status           : 'rejected',
                        id,
                        scope,
                        surface          : 'plane',
                        cause            : refusal.cause,
                        reason           : planeProof?.reason || refusal.reason,
                        credentialRefusal: refusal,
                        receipt          : buildCredentialReplacementReceipt({
                            scope,
                            forge: 'unchanged',
                            plane: 'unchanged',
                            boundPlane
                        })
                    }
                }
            }

            const targetSha256 = crypto.createHash('sha256').update(trimmed).digest('hex');

            try {
                registry.beginCredentialReplacement?.({
                    id,
                    scope,
                    planeBase: boundPlane?.endpoint ?? null,
                    boundPlane,
                    targetSha256
                })
            } catch {
                return {
                    status : 'rejected',
                    id,
                    scope,
                    surface: 'forge',
                    cause  : 'indeterminate',
                    reason : 'the credential replacement journal could not be written',
                    receipt: buildCredentialReplacementReceipt({
                        scope,
                        forge: 'unchanged',
                        plane: scope === 'forge-and-bound-plane' ? 'unchanged' : 'not-selected',
                        boundPlane
                    })
                }
            }

            try {
                if (typeof registry.replaceCredential === 'function') {
                    registry.replaceCredential(id, trimmed)
                } else {
                    registry.storeCredential(id, trimmed)
                }
            } catch {
                const currentForge = registry.resolveCredential?.(id);
                if (currentForge !== trimmed && !priorReplacement) {
                    try { registry.completeCredentialReplacement?.(id) } catch {}
                    return {
                        status : 'rejected',
                        id,
                        scope,
                        surface: 'forge',
                        cause  : 'indeterminate',
                        reason : 'forge credential could not be persisted',
                        receipt: buildCredentialReplacementReceipt({
                            scope,
                            forge: 'unchanged',
                            plane: scope === 'forge-and-bound-plane' ? 'unchanged' : 'not-selected',
                            boundPlane
                        })
                    }
                }
                try {
                    registry.markCredentialReplacementIncomplete?.(id, {
                        surface: 'forge',
                        forge  : currentForge === trimmed ? 'replaced' : 'unchanged',
                        plane  : scope === 'forge-and-bound-plane' ? 'unchanged' : 'not-selected',
                        reason : 'forge credential could not be persisted'
                    })
                } catch {}
                return {
                    status    : 'rejected',
                    id,
                    scope,
                    surface   : 'forge',
                    cause     : 'indeterminate',
                    incomplete: true,
                    reason    : 'forge credential could not be persisted',
                    receipt   : buildCredentialReplacementReceipt({
                        scope,
                        forge     : currentForge === trimmed ? 'replaced' : 'unchanged',
                        plane     : scope === 'forge-and-bound-plane' ? 'unchanged' : 'not-selected',
                        boundPlane,
                        coherent  : false,
                        incomplete: true
                    })
                }
            }

            if (scope === 'forge-and-bound-plane') {
                let planePersisted;
                try {
                    planePersisted = await tenantService.persistBoundSeatPlaneCredential({
                        planeBase    : boundPlane.endpoint,
                        agentId      : id,
                        credential   : trimmed,
                        expectedPlane: {id: boundPlane.id, dataRoot: boundPlane.dataRoot}
                    })
                } catch {
                    planePersisted = {status: 'rejected', cause: 'indeterminate', reason: 'seat plane credential could not be persisted'}
                }

                if (planePersisted?.status !== 'stored') {
                    const
                        reason = planePersisted?.reason || 'seat plane credential could not be persisted',
                        cause  = planePersisted?.cause  || 'indeterminate';

                    try {
                        registry.markCredentialReplacementIncomplete?.(id, {
                            surface: 'plane',
                            forge  : 'replaced',
                            plane  : 'unchanged',
                            reason
                        })
                    } catch {}

                    return {
                        status           : 'rejected',
                        id,
                        scope,
                        surface          : 'plane',
                        cause,
                        incomplete       : true,
                        reason,
                        credentialRefusal: Object.freeze({surface: 'plane', cause, verdict: 'refused', status: null, reason}),
                        receipt          : buildCredentialReplacementReceipt({
                            scope,
                            forge     : 'replaced',
                            plane     : 'unchanged',
                            boundPlane,
                            coherent  : false,
                            incomplete: true
                        })
                    }
                }
            }

            const
                verifiedForge = registry.resolveCredential?.(id),
                verifiedPlane = scope === 'forge-and-bound-plane'
                    ? tenantService.resolveSeatPlaneCredential({planeBase: boundPlane.endpoint, agentId: id})
                    : null;

            if (verifiedForge !== trimmed || (
                scope === 'forge-and-bound-plane' && (
                    verifiedPlane?.credential !== trimmed ||
                    verifiedPlane?.plane?.id !== boundPlane.id ||
                    verifiedPlane?.plane?.dataRoot !== boundPlane.dataRoot
                )
            )) {
                const
                    failedSurface = verifiedForge !== trimmed ? 'forge' : 'plane',
                    reason        = `${failedSurface} credential readback verification failed`;

                try {
                    registry.markCredentialReplacementIncomplete?.(id, {
                        surface: failedSurface,
                        forge  : verifiedForge === trimmed ? 'replaced' : 'unchanged',
                        plane  : scope === 'forge-and-bound-plane'
                            ? (verifiedPlane?.credential === trimmed ? 'replaced' : 'unchanged')
                            : 'not-selected',
                        reason
                    })
                } catch {}

                return {
                    status    : 'rejected',
                    id,
                    scope,
                    surface   : failedSurface,
                    cause     : 'indeterminate',
                    incomplete: true,
                    reason,
                    receipt   : buildCredentialReplacementReceipt({
                        scope,
                        forge: verifiedForge === trimmed ? 'replaced' : 'unchanged',
                        plane: scope === 'forge-and-bound-plane'
                            ? (verifiedPlane?.credential === trimmed ? 'replaced' : 'unchanged')
                            : 'not-selected',
                        boundPlane,
                        coherent  : false,
                        incomplete: true
                    })
                }
            }

            registry.completeCredentialReplacement?.(id);

            return {
                status : 'replaced',
                id,
                scope,
                receipt: buildCredentialReplacementReceipt({
                    scope,
                    forge     : 'replaced',
                    plane     : scope === 'forge-and-bound-plane' ? 'replaced' : 'not-selected',
                    boundPlane,
                    coherent  : true,
                    incomplete: false
                })
            }
        })
    }

    /**
     * @summary The operator's recorded act that makes this fleet a seat's only launcher: from here on a
     * seat with no process record reads `stopped` in {@link fleetRuntimeStatus}, and the cockpit can
     * start it. The fleet cannot see a session running elsewhere, so adopting a seat that also runs by
     * hand launches it twice — the promise is the operator's. Single `{id}` payload, like `setRepo`.
     * @param {Object} payload
     * @param {String} payload.id Registry agent id.
     * @returns {Object|null} The updated public definition, or `null` if the agent doesn't exist.
     */
    adoptAgent({id} = {}) {
        return this.getLifecycleService().getRegistry().setLaunchOwner(id, 'fleet');
    }

    /**
     * @summary Hands a seat back to a harness the fleet does not start: with no process record it reads
     * `unmanaged` again. The reverse of {@link adoptAgent}; a running supervised process is not stopped.
     * @param {Object} payload
     * @param {String} payload.id Registry agent id.
     * @returns {Object|null} The updated public definition, or `null` if the agent doesn't exist.
     */
    releaseAgent({id} = {}) {
        return this.getLifecycleService().getRegistry().setLaunchOwner(id, 'external');
    }
}

export default Neo.setupClass(FleetManager);

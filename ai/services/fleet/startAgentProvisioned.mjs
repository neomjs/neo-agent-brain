import {REMOTE_MCP_CREDENTIAL_ENV_VAR} from './mcpServers.mjs';
import {ensureAgentRepo}               from './ensureAgentRepo.mjs';
import {launchRefusalOf}               from '../../../src/fleet/contract/launchAuthority.mjs';
import {prepareManagedAgentWorkspace}  from './prepareManagedAgentWorkspace.mjs';
import {redactReadFailure}             from './redactReadFailure.mjs';
import path                            from 'node:path';
import {fileURLToPath}                 from 'node:url';

const DEFAULT_AGENTOS_RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * @summary Resolve the provider login that names the canonical AgentIdentity. Fleet `id` names one
 * resident process/home and may differ when a user owns multiple instances; it is never identity
 * authority.
 * @param {Object} agent Fleet definition.
 * @returns {String} Canonical `@login`.
 * @private
 */
function expectedAgentIdentity(agent) {
    const login = typeof agent?.githubUsername === 'string'
        ? agent.githubUsername.trim().replace(/^@/, '')
        : '';

    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/.test(login)) {
        throw new Error(`startAgentProvisioned: agent '${agent?.id}' has no valid githubUsername identity.`)
    }

    return `@${login}`
}

/**
 * @summary Spawn the harness, re-reading the seat's launch authority first.
 *
 * `FleetManager.startAgent` admits a start, but provisioning and preparation are asynchronous, so the
 * authority admitted at entry can be released while they run — and the queued spawn would still land.
 * Every spawn therefore goes through here rather than calling `start` directly: the refusal is read
 * from the registry AT the spawn, not inherited from the entry check, so no await placed above it can
 * reopen the window.
 *
 * @param {Object}   options
 * @param {Object}   options.lifecycleService Supervisor supplying `getRegistry()` and `start()`.
 * @param {Object}   options.registry         The lifecycle service's registry — re-read here.
 * @param {String}   options.agentId          Registry agent id.
 * @param {Object}  [options.startOptions]    Forwarded verbatim to `lifecycleService.start`.
 * @returns {Promise<Object>} the agent's lifecycle status.
 * @throws {Error} when the seat's launch authority was released while preparation ran.
 * @private
 */
async function spawnPermitted({lifecycleService, registry, agentId, startOptions}) {
    const refusal = launchRefusalOf(registry.getAgent(agentId));

    if (refusal) {
        throw new Error(`startAgentProvisioned: agent '${agentId}' was ${refusal}; it was released while its start was being prepared, so the harness is not spawned.`)
    }

    return startOptions ? lifecycleService.start(agentId, startOptions) : lifecycleService.start(agentId)
}

/**
 * @summary Start a Fleet Manager agent's harness *in its own provisioned repo* — the turnkey
 * "define → start" entry that makes the repo-provisioning chain live.
 *
 * `FleetLifecycleService.start` supervises a process but knows nothing about repos: it spawns the
 * harness in the Fleet Manager's own working directory. This composer closes that gap. Given an agent
 * whose definition carries its working-repo coordinates (`metadata.repo = {cloneUrl, repoSlug}`), it
 * first ensures the target checkout exists — clone-or-reuse, never clobber, via
 * {@link Neo.ai.services.fleet.ensureAgentRepo} — then hydrates the checkout + isolated harness home
 * through {@link Neo.ai.services.fleet.prepareManagedAgentWorkspace}, and only then starts the harness
 * with its `cwd` pinned to the prepared checkout. Fleet Manager auto-memory is checkout-path-keyed, so
 * the path is load-bearing: launching in the wrong or unprepared directory is a silent correctness
 * failure.
 *
 * **Fail-closed:** a provisioning OR preparation error propagates and the harness is NEVER spawned —
 * the Fleet Manager must not launch an agent into an unprovisioned, divergent, unsupported, or
 * identity-colliding directory/home.
 *
 * **The seat's other repositories** (`metadata.repos`, set through `FleetManager.setRepos`) are cloned
 * beside the working checkout with the same PAT before the spawn. They are not fail-closed: one that
 * cannot be cloned is reported on the status and the launch goes on.
 *
 * **Backward-compatible:** an agent without `metadata.repo` has no repo to provision, so it starts
 * exactly as before (inherited cwd). The opinionated provisioning + the `metadata.repo` convention live
 * here, NOT in the registry-owned supervisor — `start` only gained a generic optional `cwd`.
 *
 * **Seat home is a record, not a derivation:** the registry row names `<agentsRoot>/<id>` from birth
 * ({@link Neo.ai.services.fleet.FleetRegistryService#defineAgent}), and a start whose managed root
 * derives a different path is refused before the PAT read and any checkout (`FLEET_SEAT_HOME_MISMATCH`,
 * naming the record and both remedies) — a changed root must never mint a second, empty seat while the
 * real one sits untouched elsewhere. A row older than the record names no home and is refused too
 * (`FLEET_SEAT_HOME_UNBOUND`) until a deliberate act binds it
 * ({@link Neo.ai.services.fleet.FleetRegistryService#relocateSeatHome} from `null`): a directory that
 * happens to exist under the current root carries no binding authority, so nothing is adopted from
 * the filesystem. Only that act, or a deliberate move, rewrites the record.
 *
 * Pure composition over injectable seams: `ensureRepo` (default {@link Neo.ai.services.fleet.ensureAgentRepo}),
 * `prepareWorkspace` (default {@link Neo.ai.services.fleet.prepareManagedAgentWorkspace}), and
 * `cloneRepo` (forwarded to provisioning) make the order/failure contract unit-testable without a git
 * binary or filesystem, mirroring the `spawnFn` / `cloneRepo` idioms across the Fleet services.
 *
 * @param {Object}    options
 * @param {Object}    options.lifecycleService The `FleetLifecycleService` (or a stub) that supervises
 *                                             the process — supplies `getRegistry()`, `isRunning(id)`,
 *                                             `status(id)`, and `start(id, {cwd})`.
 * @param {String}    options.agentId          The Fleet Manager agent id to start.
 * @param {String}   [options.managedRoot]     The absolute, trusted fleet-managed checkout root —
 *                                             required only when the agent carries `metadata.repo`.
 * @param {Function} [options.cloneRepo]       `(cloneUrl, repoPath) => Promise<void>` clone seam,
 *                                             forwarded to `ensureRepo`; defaults to a real `git clone`.
 * @param {Function} [options.ensureRepo]      The repo-provisioning composer; defaults to
 *                                             {@link Neo.ai.services.fleet.ensureAgentRepo}, injectable
 *                                             for tests.
 * @param {Function} [options.prepareWorkspace] The post-provisioning workspace/home composer; defaults
 *                                              to {@link Neo.ai.services.fleet.prepareManagedAgentWorkspace}.
 * @param {Object}   [options.tenantService]     Remote tenant authority. Lazily imports the real
 *                                              singleton only for an opted-in remote seat.
 * @param {String}   [options.instanceRoot]     Explicit harness-home root; omitted ⇒ the lifecycle
 *                                              service's config-resolved `getInstanceRoot()` value.
 * @param {String}   [options.agentosRuntimeRoot] Installed AgentOS runtime root; defaults to the
 *                                                package root containing this composer.
 * @param {String}   [options.nodePath]         Node executable override for generated MCP definitions.
 * @returns {Promise<Object>} the agent's lifecycle status (see `FleetLifecycleService.status`). A prepared
 *   seat's status also carries `seatInstructions`, the preparer's decision about its instructions file,
 *   so whoever starts the seat sees why it got, kept or lost one. A seat with other repositories also
 *   carries `repos`: `[{repoSlug, state: 'prepared' | 'failed', reason?}]`, where a failed entry's
 *   `reason` is the failure's credential-redacted, bounded diagnostic.
 * @throws {Error} when `lifecycleService` / `agentId` is missing, the agent is unknown or has no GitHub
 *   PAT stored (refused before any checkout), `managedRoot`
 *   is absent for a repo-bearing agent, a repo-bearing raw launch override would bypass curated
 *   preparation, the managed root derives a seat home other than the recorded one or the row records
 *   none (`FLEET_SEAT_HOME_MISMATCH` / `FLEET_SEAT_HOME_UNBOUND`, refused before the PAT read),
 *   provisioning/preparation fails (re-thrown — no spawn), or the seat's launch authority was released
 *   while preparation ran ({@link spawnPermitted}).
 */
export async function startAgentProvisioned({
    lifecycleService,
    agentId,
    managedRoot,
    cloneRepo,
    ensureRepo = ensureAgentRepo,
    prepareWorkspace = prepareManagedAgentWorkspace,
    tenantService = null,
    instanceRoot,
    agentosRuntimeRoot = DEFAULT_AGENTOS_RUNTIME_ROOT,
    nodePath
} = {}) {
    if (!lifecycleService) throw new Error("startAgentProvisioned: 'lifecycleService' is required.");
    if (!agentId)          throw new Error("startAgentProvisioned: 'agentId' is required.");

    // Already running ⇒ short-circuit to the current status; do not re-provision. `start` is itself
    // idempotent while running, but provisioning ahead of it would be a pointless git inspection on an
    // agent that is already up.
    if (lifecycleService.isRunning(agentId)) return lifecycleService.status(agentId);

    const registry = lifecycleService.getRegistry(),
          agent    = registry.getDefinition?.(agentId) ?? registry.getAgent(agentId);
    if (!agent) throw new Error(`startAgentProvisioned: unknown agent '${agentId}'.`);

    const
        repo   = agent.metadata?.repo,
        target = agent.mcpTarget;

    // Structural refusals first: none of them may read a secret.
    if (!repo && target?.kind === 'tenant') {
        throw new Error(`startAgentProvisioned: tenant MCP agent '${agentId}' requires a managed repo.`)
    }

    if (repo) {
        // The managed-workspace contract is coupled to Fleet's curated harness launch. A repo-bearing
        // raw override can execute an unrelated command and consumes no derived home/MCP artifacts,
        // so reporting it as prepared would be a false resident-ready claim.
        if (agent.metadata?.launch) {
            throw new Error(`startAgentProvisioned: repo-bearing agent '${agentId}' uses a raw metadata.launch override; curated managed-workspace preparation is required.`);
        }

        if (!managedRoot) {
            throw new Error(`startAgentProvisioned: 'managedRoot' is required to provision the repo for agent '${agentId}'.`);
        }
        if (typeof agentosRuntimeRoot !== 'string' || !path.isAbsolute(agentosRuntimeRoot)) {
            throw new Error(`startAgentProvisioned: 'agentosRuntimeRoot' must be an absolute path for agent '${agentId}'.`)
        }

        // The registry names where this seat's files live; the agents root derives the same path at
        // every start. A different derivation means the root changed under a materialized seat, and
        // provisioning here would mint a second, empty seat while the real one sits untouched elsewhere
        // — refused before the PAT read and any checkout, naming the record and both ways out.
        const
            seatHome         = path.resolve(managedRoot, agentId),
            recordedSeatHome = agent.seatHome ?? null;

        if (recordedSeatHome && recordedSeatHome !== seatHome) {
            throw Object.assign(new Error(
                `startAgentProvisioned: agent '${agentId}' records its seat home at '${recordedSeatHome}', but the current agents root derives '${seatHome}'. Nothing was created. Restore the previous agents root, or move the seat deliberately and relocate its record.`
            ), {code: 'FLEET_SEAT_HOME_MISMATCH', recordedSeatHome, derivedSeatHome: seatHome})
        }

        // A row older than the record names no home. A directory under the current root carries no
        // binding authority — the stray empty seat an earlier start minted satisfies that test as well
        // as the real one — so nothing is adopted here: the start refuses until a deliberate act
        // (relocateSeatHome from nothing) names the directory the seat's files live in.
        if (!recordedSeatHome) {
            throw Object.assign(new Error(
                `startAgentProvisioned: agent '${agentId}' was registered before Fleet recorded seat homes and names none; the current agents root derives '${seatHome}'. Nothing was created; bind its home deliberately (relocateSeatHome from null) to the directory its files live in, then start it again.`
            ), {code: 'FLEET_SEAT_HOME_UNBOUND', derivedSeatHome: seatHome})
        }
    }

    // Resolve the resident child envelope and seat PAT before any checkout/config mutation.
    // The same resolved envelope names the rendered slots and supplies the eventual spawn.
    const resolvedResidentMcpEnv = lifecycleService.resolveResidentMcpEnvironment(agent);
    const resolvedCredential = registry.resolveCredential(agentId);

    // the creation test, applied to what is stored: a blank value written before the requirement
    // is no PAT either
    if (typeof resolvedCredential !== 'string' || resolvedCredential.trim() === '') {
        throw new Error(`startAgentProvisioned: agent '${agentId}' has no GitHub PAT stored; store one before starting it.`)
    }

    // No repo coordinates ⇒ nothing to provision; start in the inherited cwd (backward-compatible).
    if (!repo) {
        return spawnPermitted({lifecycleService, registry, agentId, startOptions: {resolvedCredential}});
    }

    let
        remotePlan                   = null,
        resolvedMcpCredential,
        remoteCapability;

    if (target?.kind === 'tenant') {
        const activeTenantService = tenantService ?? (await import('./FleetTenantService.mjs')).default;

        remotePlan = activeTenantService.resolveMcpResources(target.tenantId);

        if (!remotePlan) {
            throw new Error(`startAgentProvisioned: MCP tenant '${target.tenantId}' is unavailable for agent '${agentId}'.`)
        }

        resolvedMcpCredential = activeTenantService.resolveMcpCredential(target.tenantId);

        if (!resolvedMcpCredential) {
            throw new Error(`startAgentProvisioned: MCP tenant '${target.tenantId}' has no plane credential for agent '${agentId}'.`)
        }

        remoteCapability = await lifecycleService.assertRemoteMcpCapability(agent, {
            mainCheckout: agentosRuntimeRoot,
            nodePath
        });

        const expectedIdentity = expectedAgentIdentity(agent);
        const readiness        = await activeTenantService.probeSeatCredential({
            tenantId  : target.tenantId,
            credential: resolvedMcpCredential,
            expectedIdentity
        });

        if (!readiness?.ok ||
            !readiness.resources?.['memory-core']?.ok ||
            readiness.resources['memory-core'].identity !== expectedIdentity ||
            !readiness.resources?.['knowledge-base']?.ok) {
            throw new Error(`startAgentProvisioned: remote MCP credential readiness failed for agent '${agentId}'.`)
        }
    }

    // Ensure the checkout exists (clone-or-reuse, never clobber). A throw here propagates: the harness
    // is never spawned into an unprovisioned / conflicting directory (fail-closed). Input validation
    // (managedRoot / agentId / repoSlug / a missing cloneUrl when a clone is needed) is inherited from
    // the provisioning chain's own contracts — not re-implemented here. The seat's own PAT
    // authenticates its clone, so a private repo needs no credentials on the Fleet host.
    const {repoPath: targetRepoRoot} = await ensureRepo({
        managedRoot,
        agentId,
        repoSlug  : repo.repoSlug,
        cloneUrl  : repo.cloneUrl,
        credential: resolvedCredential,
        cloneRepo
    });

    // The seat's other repositories go beside the working checkout, with the same PAT. One that fails is
    // reported on the status and the launch goes on: the working checkout is the seat's cwd and its gate,
    // while the others are only places it reaches into. A failure here is response data, out of the
    // dispatcher's sanitizer's reach, and a clone error can echo the PAT.
    const repos = [];

    for (const {repoSlug, cloneUrl} of agent.metadata?.repos ?? []) {
        try {
            await ensureRepo({managedRoot, agentId, repoSlug, cloneUrl, credential: resolvedCredential, cloneRepo});
            repos.push({repoSlug, state: 'prepared'})
        } catch (error) {
            repos.push({repoSlug, state: 'failed', reason: redactReadFailure(error) ?? 'no legible error'})
        }
    }

    // Preparation is a mandatory gate for repo-bearing agents. The lifecycle owns the resolved
    // instance-root SSOT; the explicit option is only a test/per-tenant seam. A preparation throw
    // propagates, so `start` is never called over divergent or unsupported resident state.
    const prepared = await prepareWorkspace({
        agent,
        targetRepoRoot,
        instanceRoot       : instanceRoot ?? lifecycleService.getInstanceRoot?.(),
        agentosRuntimeRoot,
        nodePath,
        residentMcpEnv: resolvedResidentMcpEnv,
        remoteMcpCapability: remoteCapability,
        mcpTarget          : remotePlan && {
            kind            : 'tenant',
            credentialEnvVar: REMOTE_MCP_CREDENTIAL_ENV_VAR,
            resources       : remotePlan.resources
        }
    });

    if (!prepared ||
        prepared.targetRepoRoot !== targetRepoRoot ||
        prepared.agentosRuntimeRoot !== path.resolve(agentosRuntimeRoot)) {
        throw new Error(`startAgentProvisioned: preparation did not return the exact AgentOS runtime and target repo roots for agent '${agentId}'.`);
    }

    if (target?.kind === 'tenant') {
        await lifecycleService.inspectPreparedRemoteMcpAdapter({
            agent,
            binaryPath  : remoteCapability.binaryPath,
            repoPath    : prepared.targetRepoRoot,
            instanceHome: prepared.instanceHome,
            mcpMatrix   : prepared.mcpMatrix,
            mcpPlan     : prepared.mcpPlan,
            mcpTarget   : {
                kind     : 'tenant',
                resources: remotePlan.resources
            }
        })
    }

    const status = await spawnPermitted({
        lifecycleService,
        registry,
        agentId,
        startOptions: {
            cwd: prepared.targetRepoRoot,
            resolvedCredential,
            resolvedResidentMcpEnv,
            ...(target?.kind === 'tenant'
                ? {resolvedMcpCredential, remoteMcpCapability: remoteCapability}
                : {})
        }
    });

    return {
        ...status,
        ...(prepared.seatInstructions ? {seatInstructions: prepared.seatInstructions} : {}),
        ...(repos.length ? {repos} : {})
    }
}

import {REMOTE_MCP_CREDENTIAL_ENV_VAR}                   from './mcpServers.mjs';
import {ensureAgentRepo}                                 from './ensureAgentRepo.mjs';
import {LAUNCH_ADMISSION_CREDENTIALS, LAUNCH_ADMISSION_REASONS} from '../../../src/fleet/contract/launchAdmission.mjs';
import {launchRefusalOf}                                 from '../../../src/fleet/contract/launchAuthority.mjs';
import {prepareManagedAgentWorkspace}                    from './prepareManagedAgentWorkspace.mjs';
import {redactReadFailure}                               from './redactReadFailure.mjs';
import {resolveSeatPlaneTarget}                          from './resolveSeatPlaneTarget.mjs';
import {importSeatMemory, MEMORY_IMPORT_NONE}            from './seatMemoryImport.mjs';
import {
    convergeSeatGitIdentity,
    proveSeatForgeAccount,
    resolveSeatGitIdentity
}                                                        from './seatGitIdentity.mjs';
import {readSeatModelCatalog, unofferedDeclaration}      from './seatModelCatalog.mjs';
import path                                              from 'node:path';
import {fileURLToPath}                                   from 'node:url';

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
 * @summary Whether a tenant's readiness proves the seat's plane credential: both of its resources answer, and
 * the Memory Core names the seat.
 * @param {Object|null} readiness What `FleetTenantService.probeSeatCredential` answered.
 * @param {String} expectedIdentity The seat's canonical `@login`.
 * @returns {Boolean}
 * @private
 */
function tenantProvesSeat(readiness, expectedIdentity) {
    return Boolean(readiness?.ok &&
        readiness.resources?.['memory-core']?.ok &&
        readiness.resources['memory-core'].identity === expectedIdentity &&
        readiness.resources?.['knowledge-base']?.ok)
}

/**
 * @summary Spawn the harness, re-reading the seat's launch authority first.
 *
 * `FleetManager.startAgent` admits a start, but provisioning and preparation are asynchronous, so the
 * authority admitted at entry can be released while they run — and the queued spawn would still land.
 * Every spawn therefore goes through here rather than calling `start` directly: the refusal is read
 * from the registry AT the spawn, not inherited from the entry check, so no await placed above it can
 * reopen the window. The seat's participation is re-read here too, before the registry, so a bench
 * recorded during preparation refuses the spawn; one recorded after this read lands on a started seat.
 *
 * @param {Object}   options
 * @param {Object}   options.lifecycleService   Supervisor supplying `getRegistry()` and `start()`.
 * @param {Object}   options.registry           The lifecycle service's registry — re-read here.
 * @param {String}   options.agentId            Registry agent id.
 * @param {Object}  [options.startOptions]      Forwarded verbatim to `lifecycleService.start`.
 * @param {Function}[options.readParticipation] `() => Promise<Object|null>` the seat's participation now.
 * @returns {Promise<Object>} the agent's lifecycle status.
 * @throws {Error} when the seat's launch authority was released, or its identity benched, while preparation ran.
 * @private
 */
async function spawnPermitted({lifecycleService, registry, agentId, startOptions, readParticipation}) {
    const participation = readParticipation ? await readParticipation() : null,
          definition    = registry.getAgent(agentId),
          released      = launchRefusalOf(definition),
          refusal       = released ?? launchRefusalOf(definition, participation);

    if (refusal) {
        throw new Error(`startAgentProvisioned: agent '${agentId}' was ${refusal}; it was ${released ? 'released' : 'benched'} while its start was being prepared, so the harness is not spawned.`)
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
 * **Memory Core and Knowledge Base live where the team reads them**
 * ({@link Neo.ai.services.fleet.resolveSeatPlaneTarget}). A tenant row keeps its tenant and tenant
 * credential. On the default plane, a start binds the seat PAT already held by the registry only when
 * no plane binding exists; `FleetTenantService` proves the seat identity and served plane before it
 * stores that PAT encrypted. A start that proceeds to provisioning re-reads and re-proves the binding
 * before checkout; wake arming re-proves it before subscription. A seat that cannot get there refuses to
 * start and says why: no managed repo to render the remote servers into, a harness with no remote Memory
 * Core, a failed identity/plane proof, or failed persistence. A private per-seat store is no fallback.
 * Only a Fleet that serves no plane keeps the per-seat servers.
 *
 * **The seat commits as itself.** Before anything is cloned or bound, a repo-bearing start resolves the identity the
 * seat's commits carry ({@link module:ai/services/fleet/seatGitIdentity.resolveSeatGitIdentity}): its declaration,
 * else its forge account read with its PAT. Without one it refuses (`FLEET_SEAT_GIT_IDENTITY_MISSING`, or
 * `FLEET_SEAT_GIT_IDENTITY_UNKNOWN` when the account could not be read), and a PAT that answers for another account
 * than the seat's refuses as `FLEET_SEAT_GIT_IDENTITY_MISMATCH`, before anything is touched. Every managed checkout then gets that identity
 * in its own config scope and must read it back, with the launch env and without it
 * ({@link module:ai/services/fleet/seatGitIdentity.convergeSeatGitIdentity}); a checkout holding another identity
 * refuses the start (`FLEET_SEAT_GIT_IDENTITY_MISMATCH`) and keeps it. The spawn carries the identity as author and
 * committer, and the lifecycle records the outcome for the seat's status, refusals included.
 *
 * Pure composition over injectable seams: `ensureRepo` (default {@link Neo.ai.services.fleet.ensureAgentRepo}),
 * `prepareWorkspace` (default {@link Neo.ai.services.fleet.prepareManagedAgentWorkspace}), the Git identity pair
 * (`resolveGitIdentity`, `convergeGitIdentity`), and `cloneRepo` (forwarded to provisioning) make the order/failure
 * contract unit-testable without a git binary or filesystem, mirroring the `spawnFn` / `cloneRepo` idioms across the
 * Fleet services.
 *
 * @param {Object}    options
 * @param {Object}    options.lifecycleService The `FleetLifecycleService` (or a stub) that supervises
 *                                             the process — supplies `getRegistry()`, `isRunning(id)`,
 *                                             `status(id)`, and `start(id, {cwd})`.
 * @param {String}    options.agentId          The Fleet Manager agent id to start.
 * @param {String}   [options.managedRoot]     The absolute, trusted fleet-managed checkout root —
 *                                             required only when the agent carries `metadata.repo`.
 * @param {String}   [options.planeBase]       The plane the Fleet serves (`fleet.planeBase`), as its
 *                                             entrypoint resolved it; omitted on a Fleet without one.
 * @param {Function} [options.cloneRepo]       `(cloneUrl, repoPath) => Promise<void>` clone seam,
 *                                             forwarded to `ensureRepo`; defaults to a real `git clone`.
 * @param {Function} [options.ensureRepo]      The repo-provisioning composer; defaults to
 *                                             {@link Neo.ai.services.fleet.ensureAgentRepo}, injectable
 *                                             for tests.
 * @param {Function} [options.prepareWorkspace] The post-provisioning workspace/home composer; defaults
 *                                              to {@link Neo.ai.services.fleet.prepareManagedAgentWorkspace}.
 * @param {Function} [options.importMemory]     The adopted seat's memory convergence after preparation;
 *                                              defaults to {@link module:ai/services/fleet/seatMemoryImport.importSeatMemory}.
 * @param {Function} [options.resolveGitIdentity]  `({agent, credential}) => Promise<Object>`, the identity the seat's
 *                                                 commits carry; defaults to `resolveSeatGitIdentity`.
 * @param {Function} [options.convergeGitIdentity] `({repoPath, identity}) => Promise<Object>`, one checkout brought to
 *                                                 that identity; defaults to `convergeSeatGitIdentity`.
 * @param {Function} [options.proveForgeAccount]   `({agent, credential}) => Promise<{ok}>`, whether a PAT a Claude
 *                                                 Desktop seat's MCP child redeems is the seat's own; defaults to
 *                                                 `proveSeatForgeAccount`.
 * @param {Function} [options.readModelCatalog]    `({agent, instanceRoot, lifecycleService}) => Promise<Object|null>`, the
 *                                                 catalog the seat's harness offers, kept for Configuration and
 *                                                 checked against a declared model; defaults to
 *                                                 {@link module:ai/services/fleet/seatModelCatalog.readSeatModelCatalog}.
 * @param {Function} [options.readParticipation]   `() => Promise<Object|null>`, the seat's participation as its
 *                                                 identity node records it, re-read before the spawn; absent, the
 *                                                 spawn checks the registry alone.
 * @param {Object}   [options.tenantService]     Remote tenant authority. Lazily imports the real
 *                                              singleton only for an opted-in remote seat.
 * @param {String}   [options.instanceRoot]     Explicit harness-home root; omitted ⇒ the lifecycle
 *                                              service's config-resolved `getInstanceRoot()` value.
 * @param {String}   [options.agentosRuntimeRoot] Installed AgentOS runtime root; defaults to the
 *                                                package root containing this composer.
 * @param {String}   [options.nodePath]         Node executable override for generated MCP definitions.
 * @returns {Promise<Object>} the agent's lifecycle status (see `FleetLifecycleService.status`). A prepared
 *   seat's status also carries `seatInstructions`, the preparer's decision about its instructions file,
 *   so whoever starts the seat sees why it got, kept or lost one, and an adopted seat `memoryImport`
 *   (`{state: 'copied' | 'present', source, destination, files}`). A seat with other repositories also
 *   carries `repos`: `[{repoSlug, state: 'prepared' | 'failed', reason?}]`, where a failed entry's
 *   `reason` is the failure's credential-redacted, bounded diagnostic.
 * @throws {Error} when `lifecycleService` / `agentId` is missing, the agent is unknown or has no GitHub
 *   PAT stored (refused before any checkout), the seat cannot reach the Memory Core it must use (see
 *   above; refused before any checkout), `managedRoot`
 *   is absent for a repo-bearing agent, a repo-bearing raw launch override would bypass curated
 *   preparation, the managed root derives a seat home other than the recorded one or the row records
 *   none (`FLEET_SEAT_HOME_MISMATCH` / `FLEET_SEAT_HOME_UNBOUND`, refused before the PAT read),
 *   provisioning/preparation fails (re-thrown — no spawn), a consented memory import left the seat's
 *   memory empty (`FLEET_SEAT_MEMORY_IMPORT_UNCONVERGED`, no spawn), the seat has no Git identity to commit under
 *   or a checkout holds another (`FLEET_SEAT_GIT_IDENTITY_MISSING` / `_UNKNOWN` / `_MISMATCH`, no spawn), or the
 *   seat's launch authority was released, or its identity benched, while preparation ran ({@link spawnPermitted}).
 */
export async function startAgentProvisioned({
    lifecycleService,
    agentId,
    managedRoot,
    planeBase = null,
    cloneRepo,
    ensureRepo = ensureAgentRepo,
    prepareWorkspace = prepareManagedAgentWorkspace,
    importMemory = importSeatMemory,
    resolveGitIdentity = resolveSeatGitIdentity,
    convergeGitIdentity = convergeSeatGitIdentity,
    proveForgeAccount = proveSeatForgeAccount,
    readModelCatalog = readSeatModelCatalog,
    readParticipation = null,
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

    // What the seat says about its model belongs to this start: one refused before the model check, or with
    // nothing declared, must not leave an earlier refusal standing as its cause.
    lifecycleService.setSeatModel?.(agentId, null);

    // A raw launch override renders no MCP config, so it has no placement.
    const
        repo      = agent.metadata?.repo,
        target    = agent.mcpTarget,
        placement = agent.metadata?.launch ? null : resolveSeatPlaneTarget({target, harnessType: agent.harnessType, planeBase}),
        remote    = target?.kind === 'tenant' || placement?.kind === 'plane';

    // Structural refusals first: none of them may read a secret.
    if (!repo && remote) {
        throw new Error(`startAgentProvisioned: agent '${agentId}' reaches its Memory Core remotely and requires a managed repo, the workspace its remote servers are rendered into.`)
    }

    if (placement?.kind === 'refused') {
        throw new Error(`startAgentProvisioned: agent '${agentId}' cannot start: ${placement.reason}.`)
    }

    // The managed-workspace contract is coupled to Fleet's curated harness launch. A repo-bearing raw
    // override can execute an unrelated command and consumes no derived home/MCP artifacts, so
    // reporting it as prepared would be a false resident-ready claim.
    if (repo && agent.metadata?.launch) {
        throw new Error(`startAgentProvisioned: repo-bearing agent '${agentId}' uses a raw metadata.launch override; curated managed-workspace preparation is required.`);
    }

    // Every seat the Fleet launches itself has a seat directory under the agents root — the managed
    // clone, the harness home, the survivor lease — repo or not; only a raw `metadata.launch` override
    // derives no home. The registry names where that directory lives, and the agents root derives the
    // same path at every start. A different derivation means the root changed under a materialized
    // seat, and going on would mint a second, empty seat while the real one sits untouched elsewhere
    // — refused before the PAT read, any checkout and any home effect, naming the record and both ways out.
    if (!agent.metadata?.launch) {
        if (!managedRoot) {
            throw new Error(`startAgentProvisioned: 'managedRoot' is required to place the seat home for agent '${agentId}'.`);
        }

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

    if (repo && (typeof agentosRuntimeRoot !== 'string' || !path.isAbsolute(agentosRuntimeRoot))) {
        throw new Error(`startAgentProvisioned: 'agentosRuntimeRoot' must be an absolute path for agent '${agentId}'.`)
    }

    // Resolve the resident child envelope and seat PAT before any checkout/config mutation.
    // The same resolved envelope names the rendered slots and supplies the eventual spawn.
    const resolvedResidentMcpEnv = lifecycleService.resolveResidentMcpEnvironment(agent, {remote});
    const resolvedCredential     = registry.resolveCredential(agentId);

    // the creation test, applied to what is stored: a blank value written before the requirement
    // is no PAT either
    if (typeof resolvedCredential !== 'string' || resolvedCredential.trim() === '') {
        throw new Error(`startAgentProvisioned: agent '${agentId}' has no GitHub PAT stored; store one before starting it.`)
    }

    // What the seat's harness offers is read at every start, declared or not, before the harness is configured or
    // launched: Configuration offers it while the seat runs, and a declared value it lacks refuses here. Only a
    // complete catalog proves an absence. A Codex read runs the harness's app-server in the seat's home, where it
    // writes its own state, and is over before the start goes on.
    const readOffered = async () => {
        const
            catalog     = await readModelCatalog({agent, instanceRoot: instanceRoot ?? lifecycleService.getInstanceRoot?.(), lifecycleService}),
            unavailable = unofferedDeclaration(catalog, agent);

        if (catalog?.stillRunning) {
            throw Object.assign(new Error(`startAgentProvisioned: agent '${agentId}' cannot start: ${catalog.reason}. Nothing was cloned or configured and the harness did not start; start it again once that process has ended.`), {code: 'FLEET_SEAT_HOME_IN_USE'})
        }

        if (catalog && catalog.state !== 'unsupported') {
            lifecycleService.setSeatCatalog?.(agentId, catalog);
            (agent.model || agent.reasoningEffort) && lifecycleService.setSeatModel?.(agentId, {state: unavailable ? 'refused' : catalog.state, model: agent.model ?? null, reasoningEffort: agent.reasoningEffort ?? null, reason: unavailable ?? catalog.reason})
        }

        if (unavailable) {
            throw Object.assign(new Error(`startAgentProvisioned: agent '${agentId}' cannot start: ${unavailable}. Nothing was cloned or configured and the harness did not start. Change it in Detail › Configuration, then start it again.`), {code: 'FLEET_SEAT_MODEL_UNAVAILABLE'})
        }
    };

    // No repo coordinates ⇒ nothing to provision; start in the inherited cwd (backward-compatible).
    // A consented memory import converges into the managed workspace, so without one it cannot.
    if (!repo) {
        if (agent.memoryImport && agent.memoryImport !== MEMORY_IMPORT_NONE) {
            throw Object.assign(new Error(
                "startAgentProvisioned: the memory import needs the seat's repository: set it before starting it."
            ), {code: 'FLEET_SEAT_MEMORY_IMPORT_UNCONVERGED', source: agent.memoryImport, destination: null, step: 'memory import'})
        }

        await readOffered();

        return spawnPermitted({lifecycleService, registry, agentId, readParticipation, startOptions: {resolvedCredential}});
    }

    // The identity the seat's commits carry, resolved before anything is cloned or bound: without one, every commit
    // would name whoever the host's Git config names.
    const gitIdentity = await resolveGitIdentity({agent, credential: resolvedCredential});

    if (gitIdentity.state === 'missing' || gitIdentity.state === 'unknown' || gitIdentity.state === 'mismatch') {
        lifecycleService.setGitIdentity?.(agentId, gitIdentity);

        throw Object.assign(new Error({
            missing : `startAgentProvisioned: agent '${agentId}' has no Git identity to commit under: ${gitIdentity.reason}. Nothing was changed. Declare the name and email its commits carry (gitName and gitEmail), then start it again.`,
            unknown : `startAgentProvisioned: agent '${agentId}' cannot start until its Git identity is known: ${gitIdentity.reason}. Nothing was changed. Check its PAT and its forge, or declare the name and email its commits carry (gitName and gitEmail), then start it again.`,
            mismatch: `startAgentProvisioned: agent '${agentId}' would commit as another account: ${gitIdentity.reason}. Nothing was changed. Store the seat's own PAT, or declare the name and email its commits carry (gitName and gitEmail), then start it again.`
        }[gitIdentity.state]), {code: `FLEET_SEAT_GIT_IDENTITY_${gitIdentity.state.toUpperCase()}`, gitIdentity})
    }

    // read after the identity check, so its refusals stay true that nothing was changed
    await readOffered();

    // A Claude Desktop seat's profile is rewritten below, which only a closed Desktop tolerates. The Fleet's
    // own record says it is not running; a Desktop someone else opened on the profile is checked here.
    const desktopRows = agent.harnessType === 'claude-desktop';

    if (desktopRows) {
        const inUse = lifecycleService.desktopProfileInUse(agent);

        if (inUse !== false) {
            throw Object.assign(new Error(`startAgentProvisioned: agent '${agentId}' cannot start: ${inUse
                ? 'its Claude Desktop profile is open in a process this Fleet does not supervise. Quit that Claude Desktop, then start the seat again'
                : 'the process table could not be read to confirm its Claude Desktop is closed'}. Nothing was cloned or configured.`), {code: 'FLEET_SEAT_PROFILE_IN_USE'})
        }
    }

    const commitIdentity = {name: gitIdentity.name, email: gitIdentity.email};

    // A Claude Desktop seat's MCP children redeem its credentials later, each from the owner selected here and
    // proved the way this Start proves it: the PAT from the registry, the plane credential from its tenant or
    // binding, never the one for the other.
    let
        remotePlan                   = null,
        resolvedMcpCredential,
        remoteCapability,
        planeOwner                   = null;

    const activeTenantService = remote ? tenantService ?? (await import('./FleetTenantService.mjs')).default : null;

    if (target?.kind === 'tenant') {
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

        if (!tenantProvesSeat(readiness, expectedIdentity)) {
            throw new Error(`startAgentProvisioned: remote MCP credential readiness failed for agent '${agentId}'.`)
        }

        planeOwner = {
            credential: LAUNCH_ADMISSION_CREDENTIALS.PLANE_BEARER,
            resolve   : () => activeTenantService.resolveMcpCredential(target.tenantId),
            prove     : async credential => ({
                ok: tenantProvesSeat(await activeTenantService.probeSeatCredential({tenantId: target.tenantId, credential, expectedIdentity}), expectedIdentity)
            })
        }
    } else if (placement?.kind === 'plane') {
        const
            expectedIdentity = expectedAgentIdentity(agent),
            storedArgs       = {planeBase: placement.endpoint, agentId};

        let stored = activeTenantService.resolveSeatPlaneCredential(storedArgs);

        remotePlan            = placement;
        remoteCapability      = await lifecycleService.assertRemoteMcpCapability(agent, {
            mainCheckout: agentosRuntimeRoot,
            nodePath
        });

        if (!stored) {
            const binding = await activeTenantService.storeSeatPlaneCredential({
                ...storedArgs,
                identity  : expectedIdentity,
                credential: resolvedCredential,
                ifAbsent  : true
            });

            stored = activeTenantService.resolveSeatPlaneCredential(storedArgs);

            if (!stored) {
                if (binding?.status !== 'stored') {
                    throw new Error(`startAgentProvisioned: agent '${agentId}' could not bind its existing PAT to the Fleet plane at ${placement.endpoint}: ${binding?.reason ?? 'the credential was not accepted'}.`)
                }

                throw new Error(`startAgentProvisioned: agent '${agentId}' plane binding was not readable after storage.`)
            }
        }

        resolvedMcpCredential = stored.credential;

        const readiness = await activeTenantService.probeSeatPlaneCredential({
            planeBase    : placement.endpoint,
            credential   : stored.credential,
            expectedIdentity,
            expectedPlane: stored.plane
        });

        if (!readiness?.ok) {
            throw new Error(`startAgentProvisioned: agent '${agentId}' cannot use its plane at ${placement.endpoint}: ${readiness?.reason ?? 'the readiness probe failed'}.`)
        }

        // proved against the plane this Start met, so a binding moved to another plane does not carry over
        const provenPlane = stored.plane;

        planeOwner = {
            credential: LAUNCH_ADMISSION_CREDENTIALS.PLANE_BEARER,
            resolve   : () => activeTenantService.resolveSeatPlaneCredential(storedArgs)?.credential ?? null,
            prove     : credential => activeTenantService.probeSeatPlaneCredential({planeBase: placement.endpoint, credential, expectedIdentity, expectedPlane: provenPlane})
        }
    }

    // Ensure the checkout exists (clone-or-reuse, never clobber). A throw here propagates: the harness
    // is never spawned into an unprovisioned / conflicting directory (fail-closed). Input validation
    // (managedRoot / agentId / repoSlug / a missing cloneUrl when a clone is needed) is inherited from
    // the provisioning chain's own contracts — not re-implemented here. The seat's own PAT
    // authenticates its clone, so a private repo needs no credentials on the Fleet host. The PAT is
    // presented only to the origin it was stored for (a GitLab seat's `forgeHost`, else GitHub's).
    const
        credentialOrigin           = agent.forgeHost,
        {repoPath: targetRepoRoot} = await ensureRepo({
            managedRoot,
            agentId,
            repoSlug  : repo.repoSlug,
            cloneUrl  : repo.cloneUrl,
            credential: resolvedCredential,
            credentialOrigin,
            cloneRepo
        });

    // The seat's other repositories go beside the working checkout, with the same PAT. One that fails is
    // reported on the status and the launch goes on: the working checkout is the seat's cwd and its gate,
    // while the others are only places it reaches into. A failure here is response data, out of the
    // dispatcher's sanitizer's reach, and a clone error can echo the PAT.
    const
        repos     = [],
        checkouts = [targetRepoRoot];

    for (const {repoSlug, cloneUrl} of agent.metadata?.repos ?? []) {
        try {
            const {repoPath} = await ensureRepo({managedRoot, agentId, repoSlug, cloneUrl, credential: resolvedCredential, credentialOrigin, cloneRepo});

            checkouts.push(repoPath);
            repos.push({repoSlug, state: 'prepared'})
        } catch (error) {
            repos.push({repoSlug, state: 'failed', reason: redactReadFailure(error) ?? 'no legible error'})
        }
    }

    // Every checkout the seat commits in carries its identity before anything runs there. One that holds another
    // identity keeps it, and the start stops: a disagreement is never masked by the launch env.
    for (const checkout of checkouts) {
        const outcome = await convergeGitIdentity({repoPath: checkout, identity: commitIdentity});

        if (outcome.state !== 'converged') {
            lifecycleService.setGitIdentity?.(agentId, {...gitIdentity, state: 'mismatch'});

            throw Object.assign(new Error(
                `startAgentProvisioned: agent '${agentId}' commits as '${commitIdentity.name} <${commitIdentity.email}>', but its checkout '${checkout}' ${outcome.reason}. The harness is not spawned, and no identity the Fleet did not write was changed. Declare the identity the seat commits as, or remove the other one from that checkout's Git config, then start it again.`
            ), {code: 'FLEET_SEAT_GIT_IDENTITY_MISMATCH', repoPath: checkout, found: outcome.found, gitIdentity})
        }
    }

    lifecycleService.setGitIdentity?.(agentId, gitIdentity);

    // Preparation is a mandatory gate for repo-bearing agents. The lifecycle owns the resolved
    // instance-root SSOT; the explicit option is only a test/per-tenant seam. A preparation throw
    // propagates, so `start` is never called over divergent or unsupported resident state.
    const seatInstanceRoot = instanceRoot ?? lifecycleService.getInstanceRoot?.();

    // A moved seat's row names the home it left (`relocateSeatHome`). When the harness homes live in the
    // seat folders, as they do under one agents root, that home's root is where Fleet rendered the files
    // the copy carries, and the preparation re-derives them for this root.
    const previousInstanceRoot = typeof agent.previousSeatHome === 'string' &&
        path.basename(agent.previousSeatHome) === agentId &&
        path.resolve(seatInstanceRoot) === path.resolve(managedRoot)
        ? path.dirname(agent.previousSeatHome)
        : null;

    // A Claude Desktop seat's profile rows carry one launch grant per enabled server, reserved before the rows
    // are written. The lifecycle activates them once the seat runs and is leased; a Start that fails before
    // that revokes them, so a row written here never admits a child of a seat this Start did not launch.
    const
        admission   = desktopRows ? lifecycleService.getLaunchAdmission() : null,
        reservation = admission && await admission.reserve({agent, registry});

    let prepared, memory, status;

    try {
        prepared = await prepareWorkspace({
            agent,
            targetRepoRoot,
            instanceRoot       : seatInstanceRoot,
            previousInstanceRoot,
            agentosRuntimeRoot,
            nodePath,
            residentMcpEnv     : resolvedResidentMcpEnv,
            remoteMcpCapability: remoteCapability,
            // the plan's remote kind, whether a connected tenant or the Fleet's plane serves MC and KB
            mcpTarget          : remotePlan && {
                kind            : 'tenant',
                credentialEnvVar: REMOTE_MCP_CREDENTIAL_ENV_VAR,
                resources       : remotePlan.resources
            },
            ...(reservation ? {launchAdmission: {issuer: reservation.issuer, identity: reservation.identity, grants: reservation.grants}} : {})
        });

        if (!prepared ||
            prepared.targetRepoRoot !== targetRepoRoot ||
            prepared.agentosRuntimeRoot !== path.resolve(agentosRuntimeRoot)) {
            throw new Error(`startAgentProvisioned: preparation did not return the exact AgentOS runtime and target repo roots for agent '${agentId}'.`);
        }

        if (remote) {
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

        // an adopted seat starts with the memory it consented to import, never an empty folder that
        // reads like a fresh seat's: converge the copy, then read the destination fresh
        memory = await importMemory({agent, instanceRoot: seatInstanceRoot});

        status = await spawnPermitted({
            lifecycleService,
            registry,
            agentId,
            readParticipation,
            startOptions: {
                cwd        : prepared.targetRepoRoot,
                resolvedCredential,
                resolvedResidentMcpEnv,
                gitIdentity: commitIdentity,
                ...(remote
                    ? {resolvedMcpCredential, resolvedMcpEndpoint: remotePlan.endpoint, remoteMcpCapability: remoteCapability}
                    : {}),
                ...(reservation ? {launchAdmission: {
                    generation: reservation.generation,
                    plan      : prepared.mcpPlan,
                    owners    : {
                        pat: {
                            credential: LAUNCH_ADMISSION_CREDENTIALS.SEAT_PAT,
                            resolve   : () => registry.resolveCredential(agentId),
                            prove     : credential => proveForgeAccount({agent, credential})
                        },
                        ...(planeOwner ? {plane: planeOwner} : {})
                    }
                }} : {})
            }
        })
    } catch (error) {
        reservation && admission.revoke(agentId, LAUNCH_ADMISSION_REASONS.START_FAILED, {generation: reservation.generation});
        throw error
    }

    // the answer reaches whoever pressed Start; the launch record keeps it for every later read
    if (repos.length) {
        lifecycleService.setRepoOutcomes(agentId, repos, {pid: status?.pid, startedAt: status?.startedAt})
    }

    return {
        ...status,
        ...(prepared.seatInstructions ? {seatInstructions: prepared.seatInstructions} : {}),
        ...(memory.state !== 'none' ? {memoryImport: memory} : {}),
        ...(repos.length ? {repos} : {})
    }
}

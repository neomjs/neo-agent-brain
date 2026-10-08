import {constants as fsConstants}                     from 'node:fs';
import fs                                             from 'node:fs/promises';
import {writeFileAtomic}                              from '../shared/atomicFileWrite.mjs';
import path                                           from 'node:path';
import os                                             from 'node:os';
import crypto                                         from 'node:crypto';
import {isDeepStrictEqual}                            from 'node:util';
import {parse as parseToml}                           from 'smol-toml';
import {hydrateCurrentWorktree}                       from '../../scripts/migrations/bootstrapWorktree.mjs';
import {MCP_SERVERS, mcpCatalogFor, resolveMcpMatrix} from '../../../src/fleet/contract/mcpServers.mjs';
import {applyCodexSeatSettings, parseTomlTableHeader} from './codexConfigToml.mjs';
import {deriveNodeRuntimeEnv}                         from './deriveNodeRuntimeEnv.mjs';
import {KIMI_SEAT_SERVERS, generateKimiSeatConfig}    from './generateKimiSeatConfig.mjs';
import {
    deriveAgentInstanceHome,
    deriveAgentMemoryDir
} from './deriveAgentInstanceHome.mjs';
import {
    MANAGED_WORKSPACE_MCP_SERVER_DESCRIPTORS as MCP_SERVER_DESCRIPTORS,
    createManagedAgentWorkspacePlan,
    launchRowEnvNames
} from './managedAgentWorkspacePlan.mjs';
import {LAUNCH_GRANT_ENV_VAR, LAUNCH_ISSUER_ENV_VAR, isLaunchIdentity}                                            from './mcpLaunchAdmission.mjs';
import {OPENCODE_SEAT_SERVERS, WAKE_ENVELOPE_PLANT_FILE_NAME, generateOpenCodeSeatConfig, isUnmodifiedGeneration} from './generateOpenCodeSeatConfig.mjs';
import {SEAT_INSTRUCTION_STATES, projectSeatInstructions}                                                         from './projectSeatInstructions.mjs';
import {ensureSeatEnvFile}                                                                                        from './seatEnvFile.mjs';
import {renderAboutThisLayerMd, renderIdentityMd, renderMemoryIndexMd}                                            from './seatMemoryLayerTemplate.mjs';

export {createManagedAgentWorkspacePlan} from './managedAgentWorkspacePlan.mjs';

const
    NEO_MCP_NAME_PREFIX      = 'neo-mjs-',
    CODEX_REMOTE_TRUST_BEGIN = '# Fleet-managed remote MCP project trust begin',
    CODEX_REMOTE_TRUST_END   = '# Fleet-managed remote MCP project trust end',
    CODEX_PROJECT_HEADER     = '# Fleet-managed Neo MCP tables: executable paths come from the installed canonical checkout; cwd/project paths stay bound to this prepared resident checkout; `enabled = false` marks a server the Fleet switches off, the others follow the seat\'s own switch.',
    // The header an earlier Fleet wrote, while the tables still carried `enabled`.
    CODEX_PROJECT_HEADER_V1  = '# Fleet-managed Neo MCP tables: executable paths come from the installed canonical checkout; cwd/project paths stay bound to this prepared resident checkout; enabled values are the current Brain projection.',
    CLAUDE_HARNESS_TYPES     = new Set(['claude-code', 'claude-desktop']),
    CLAUDE_MEMORY_SETTING    = 'autoMemoryDirectory',
    // What a Claude Desktop profile row runs, and what a tenant row's launcher hands to.
    LAUNCHER_ENTRYPOINT      = 'ai/mcp/client/fleetMcpLauncher.mjs',
    BRIDGE_ENTRYPOINT        = 'ai/mcp/client/stdioToStreamableHttp.mjs',
    DESKTOP_PROFILE_RECEIPT  = '.neo-fleet-claude-desktop-profile.json';

/**
 * @summary Convergence states for Fleet-owned workspace artifacts. `DIVERGENT` is emitted on the
 * thrown error's `artifact` field because preparation fails closed instead of returning a launchable
 * result alongside unresolved operator content.
 * @type {Readonly<{CREATED: String, MATCH: String, UPDATED: String, DIVERGENT: String}>}
 */
export const WORKSPACE_ARTIFACT_STATES = Object.freeze({
    CREATED  : 'CREATED',
    MATCH    : 'MATCH',
    UPDATED  : 'UPDATED',
    DIVERGENT: 'DIVERGENT'
});

/**
 * @summary Error for a fail-closed workspace preparation result. `code` is stable for callers;
 * `artifact` contains paths, owned-key names, and state only — never file contents or secret values.
 */
export class ManagedWorkspacePreparationError extends Error {
    constructor(message, {code = 'FLEET_WORKSPACE_PREPARATION_FAILED', artifact} = {}) {
        super(message);
        this.name = 'ManagedWorkspacePreparationError';
        this.code = code;
        if (artifact) this.artifact = artifact;
    }
}

/**
 * @typedef {Object} ManagedAgentWorkspacePlanInput
 * @property {{id: String, harnessType: String}} agent Closed opaque seat + harness intent.
 * @property {Object<String, Boolean>} mcpMatrix Complete canonical MCP enablement matrix.
 * @property {Object|null} [mcpTarget=null] Closed non-secret tenant resource intent.
 */

/**
 * @typedef {Object} ManagedAgentWorkspaceMcpPlan
 * @property {String} key Canonical MCP catalog key.
 * @property {String} name Curated harness-facing server name.
 * @property {Boolean} enabled Whether the server is enabled for this seat.
 * @property {'resident'|'tenant'} target Resource ownership intent.
 * @property {'stdio'|'streamable-http'} transport Curated transport intent.
 * @property {String|null} entrypoint Repository-relative curated entrypoint.
 * @property {String|null} url Public remote resource URL.
 * @property {String|null} credentialEnvVar Credential slot name, never its value.
 * @property {String[]} runtimeEnv Child-runtime environment slot names.
 * @property {String[]} requiredRuntimeEnv Required child-runtime environment slot names.
 * @property {String[]} secretEnv Secret-bearing child-runtime environment slot names.
 */

/**
 * @typedef {Object} ManagedAgentWorkspacePlan
 * @property {{id: String, harnessType: String}} agent Closed opaque seat + harness intent.
 * @property {String} artifactProfile Curated harness artifact profile.
 * @property {Object<String, Boolean>} mcpMatrix Complete canonical MCP enablement matrix.
 * @property {ManagedAgentWorkspaceMcpPlan[]} mcpServers Closed logical MCP plan.
 */

const
    LOGICAL_PLAN_KEYS   = Object.freeze(['agent', 'artifactProfile', 'mcpMatrix', 'mcpServers']),
    LOGICAL_SERVER_KEYS = Object.freeze([
        'key',
        'name',
        'enabled',
        'target',
        'transport',
        'entrypoint',
        'url',
        'credentialEnvVar',
        'runtimeEnv',
        'requiredRuntimeEnv',
        'secretEnv'
    ]),
    FORBIDDEN_LOGICAL_FIELDS = new Set([
        'args',
        'auth',
        'authorization',
        'bearer',
        'command',
        'credential',
        'cwd',
        'grant',
        'grants',
        'agentosRuntimeRoot',
        'instanceRoot',
        'mainCheckout',
        'nodePath',
        'owner',
        'ownerPrincipal',
        'repoPath',
        'targetRepoRoot',
        'secret',
        'token'
    ].map(key => key.toLowerCase()));

/**
 * @summary Prove that one closed logical plan is internally coherent by re-deriving its canonical
 * projection from the plan's own agent, MCP-matrix, and tenant-resource inputs. This is a coherence
 * gate, not a provenance gate: it does not prove that a registry authorized those logical inputs.
 * A future cross-process plan/apply seam must authenticate that origin independently.
 * @param {ManagedAgentWorkspacePlan} plan Candidate logical plan.
 * @returns {ManagedAgentWorkspacePlan} The recursively frozen canonical projection.
 * @private
 */
function validateManagedAgentWorkspacePlan(plan) {
    assertSafeLogicalTree(plan, 'plan');
    assertExactRecord(plan, 'plan', LOGICAL_PLAN_KEYS);
    assertLogicalString(plan.artifactProfile, 'plan.artifactProfile');

    if (!Array.isArray(plan.mcpServers) ||
        plan.mcpServers.length !== MCP_SERVERS.length ||
        Object.keys(plan.mcpServers).some((key, index) => key !== String(index))) {
        throw new TypeError('applyManagedAgentWorkspacePlan: plan.mcpServers must be a dense canonical array.')
    }

    for (const [index, server] of plan.mcpServers.entries()) {
        const label = `plan.mcpServers[${index}]`;

        assertExactRecord(server, label, LOGICAL_SERVER_KEYS);
        assertLogicalString(server.key, `${label}.key`);
        assertLogicalString(server.name, `${label}.name`);
        if (typeof server.enabled !== 'boolean') {
            throw new TypeError(`applyManagedAgentWorkspacePlan: '${label}.enabled' must be boolean.`)
        }
        if (!['resident', 'tenant'].includes(server.target)) {
            throw new TypeError(`applyManagedAgentWorkspacePlan: '${label}.target' is malformed.`)
        }
        if (!['stdio', 'streamable-http'].includes(server.transport)) {
            throw new TypeError(`applyManagedAgentWorkspacePlan: '${label}.transport' is malformed.`)
        }
        if (server.entrypoint !== null) assertLogicalString(server.entrypoint, `${label}.entrypoint`);
        if (server.url !== null) assertLogicalString(server.url, `${label}.url`);
        if (server.credentialEnvVar !== null) assertLogicalString(server.credentialEnvVar, `${label}.credentialEnvVar`);
        assertLogicalStringArray(server.runtimeEnv, `${label}.runtimeEnv`);
        assertLogicalStringArray(server.requiredRuntimeEnv, `${label}.requiredRuntimeEnv`);
        assertLogicalStringArray(server.secretEnv, `${label}.secretEnv`)
    }

    const tenantRows = plan.mcpServers.filter(server => server.target === 'tenant');
    let   mcpTarget  = null;

    if (tenantRows.length) {
        const
            memoryCore    = tenantRows.find(server => server.key === 'memory-core'),
            knowledgeBase = tenantRows.find(server => server.key === 'knowledge-base');

        if (!memoryCore || !knowledgeBase || memoryCore.credentialEnvVar !== knowledgeBase.credentialEnvVar) {
            throw new TypeError('applyManagedAgentWorkspacePlan: tenant plan must bind both canonical resources through one credential slot.')
        }

        mcpTarget = {
            kind            : 'tenant',
            credentialEnvVar: memoryCore.credentialEnvVar,
            resources       : {
                'memory-core'   : {url: memoryCore.url},
                'knowledge-base': {url: knowledgeBase.url}
            }
        }
    }

    const expected = createManagedAgentWorkspacePlan({
        agent    : plan.agent,
        mcpMatrix: plan.mcpMatrix,
        mcpTarget
    });

    if (!isDeepStrictEqual(plan, expected)) {
        throw new TypeError('applyManagedAgentWorkspacePlan: plan does not match the canonical logical projection.')
    }

    return expected
}

/**
 * @summary Binds a logical seat plan to the two explicit host roots. Local server entrypoints and
 * Neural Link's package/Bridge cwd are AgentOS-owned; target-repository ownership starts at generated
 * artifacts and harness execution, never at the MCP executable edge.
 * @param {Object} options
 * @param {ManagedAgentWorkspacePlan} options.logicalPlan
 * @param {String} options.agentosRuntimeRoot
 * @param {String} options.nodePath
 * @param {Object} options.runtime Host runtime facts.
 * @param {Object} options.residentMcpEnv Per-server resolved child environment; only slot names are rendered.
 * @returns {Object[]}
 * @private
 */
function bindManagedAgentWorkspacePlan({logicalPlan, agentosRuntimeRoot, nodePath, runtime, residentMcpEnv}) {
    const environment = deriveNodeRuntimeEnv(nodePath, runtime);

    return logicalPlan.mcpServers.map(server => ({
        ...server,
        ...(Object.keys(environment).length ? {environment: {...environment}} : {}),
        command   : nodePath,
        sourceRoot: agentosRuntimeRoot,
        args      : [
            path.join(agentosRuntimeRoot, server.entrypoint),
            ...(server.key === 'neural-link' ? ['--cwd', agentosRuntimeRoot] : [])
        ],
        runtimeEnv        : [...new Set([...server.runtimeEnv, ...Object.keys(residentMcpEnv[server.key] || {})])],
        requiredRuntimeEnv: [...new Set([...server.requiredRuntimeEnv, ...Object.keys(residentMcpEnv[server.key] || {})])],
        secretEnv         : [...server.secretEnv],
        unsupportedReason : MCP_SERVER_DESCRIPTORS[server.key].unsupportedReason || null
    }))
}

/**
 * @summary Bind and apply one validated logical workspace plan at the host-only effect edge. This
 * function alone introduces absolute target-repo/home/AgentOS-runtime/Node paths, then preserves
 * the existing bounded effect census: `stat`/`lstat`/`access`, checkout hydration, bounded reads, `mkdir`,
 * create-only and temporary writes, atomic `rename`, `chmod(0600)`, and receipt `unlink`. It never
 * spawns a process. Completed hydration or atomic/create-only artifacts may remain after a later
 * failure; retry converges that honest partial state without exposing partial file bytes.
 *
 * The sole production caller remains `startAgentProvisioned()` through the plan/apply composer
 * below. Renderers and convergence helpers consume the same host-bound plan shape as before.
 * Canonical re-derivation proves internal coherence with the plan's own logical inputs; it does not
 * prove registry authorization or cross-process provenance. That belongs to the later authenticated
 * plan/apply envelope rather than this host edge.
 * @param {Object} options
 * @param {ManagedAgentWorkspacePlan} options.plan Closed logical plan; structural clones accepted
 *     after schema and canonical-projection coherence validation.
 * @param {String} options.targetRepoRoot Absolute provisioned target checkout path.
 * @param {String|null} [options.repoSlug=null] The checkout's repository, `<owner>/<name>`; it names
 *     the seat's instructions and is a host fact beside `targetRepoRoot`, never part of the logical plan.
 * @param {String} options.instanceRoot Absolute Fleet harness-home root.
 * @param {String|null} [options.previousInstanceRoot=null] The agents root a relocated seat's folder was
 *     copied from. Each Fleet-owned file still exactly as Fleet rendered it there is re-derived for this root.
 * @param {String} options.agentosRuntimeRoot Installed AgentOS runtime root.
 * @param {String} [options.nodePath] Node executable used for installed MCP entrypoints.
 * @param {Object} [options.runtime=process] Host runtime facts for child execution mode.
 * @param {String} [options.claudeConfigRoot] Claude Desktop's shared Code-tab config root (host home by default).
 * @param {Object} [options.residentMcpEnv] Per-server resolved child environment supplied at Start.
 * @param {Object} [options.remoteMcpCapability] Existing non-secret installed-adapter proof.
 * @param {Object} [options.launchAdmission] `{issuer, identity, grants}`: a Claude Desktop seat's reserved
 *     launch admission ({@link Neo.ai.services.fleet.McpLaunchAdmissionService#reserve}), which its profile
 *     rows carry. Required for that harness only.
 * @param {Function} [options.hydrateWorkspace] Import-safe checkout hydration seam.
 * @param {Function} [options.deriveInstanceHome] Per-agent home derivation seam.
 * @param {Object} [options.fileSystem] Promise filesystem seam.
 * @param {Function} [options.log] Hydration logger.
 * @returns {Promise<{agentosRuntimeRoot: String, targetRepoRoot: String, instanceHome: String, mcpMatrix: Object, mcpPlan: Object[], hydration: Object, artifacts: Object[], seatInstructions: Object}>}
 *     `seatInstructions` is the decision about the seat's instruction file: `{state, reason, ignored?, homeFile?}`.
 * @throws {ManagedWorkspacePreparationError} For invalid plans/bindings, unsafe paths, unsupported
 *     capabilities, divergent content, or effect failures.
 */
export async function applyManagedAgentWorkspacePlan(options={}) {
    try {
        return await applyManagedAgentWorkspacePlanUnchecked(options)
    } catch (error) {
        if (error instanceof ManagedWorkspacePreparationError) throw error;
        if (error instanceof RangeError) throw unsupported(error.message);

        const wrapped = new ManagedWorkspacePreparationError(
            error instanceof TypeError
                ? `prepareManagedAgentWorkspace: host apply rejected its logical plan (${error.message}).`
                : 'prepareManagedAgentWorkspace: host apply effect failed.'
        );

        wrapped.cause = error;
        throw wrapped
    }
}

/** @summary Apply validated host bindings, preserving only name references in artifacts. @private */
async function applyManagedAgentWorkspacePlanUnchecked({
    plan: inputPlan,
    targetRepoRoot,
    repoSlug = null,
    instanceRoot,
    previousInstanceRoot = null,
    agentosRuntimeRoot,
    nodePath = process.execPath,
    runtime = process,
    claudeConfigRoot = os.homedir(),
    residentMcpEnv = {},
    remoteMcpCapability = null,
    launchAdmission = null,
    hydrateWorkspace = hydrateCurrentWorktree,
    deriveInstanceHome = deriveAgentInstanceHome,
    fileSystem = fs,
    log = () => {}
} = {}) {
    const logicalPlan = validateManagedAgentWorkspacePlan(inputPlan);

    assertAbsolutePath(targetRepoRoot, 'targetRepoRoot');
    assertAbsolutePath(instanceRoot, 'instanceRoot');
    assertAbsolutePath(agentosRuntimeRoot, 'agentosRuntimeRoot');
    assertAbsolutePath(nodePath, 'nodePath');

    const
        canonicalTargetRepoRoot     = path.resolve(targetRepoRoot),
        canonicalInstanceRoot       = path.resolve(instanceRoot),
        canonicalAgentosRuntimeRoot = path.resolve(agentosRuntimeRoot),
        agent                       = logicalPlan.agent,
        instanceHome                = deriveInstanceHome({
            instanceRoot: canonicalInstanceRoot,
            agentId     : agent.id,
            harnessType : agent.harnessType
        }),
        plan                        = bindManagedAgentWorkspacePlan({
            logicalPlan,
            agentosRuntimeRoot: canonicalAgentosRuntimeRoot,
            nodePath,
            runtime,
            residentMcpEnv
        }),
        previous                    = previousSeatPlacement({
            previousInstanceRoot,
            instanceRoot  : canonicalInstanceRoot,
            targetRepoRoot: canonicalTargetRepoRoot,
            agent,
            deriveInstanceHome
        });

    assertAbsolutePath(instanceHome, 'instanceHome');
    if (agent.harnessType === 'claude-desktop') assertAbsolutePath(claudeConfigRoot, 'claudeConfigRoot');
    for (const server of plan.filter(row => row.enabled && row.transport === 'stdio')) {
        if (!path.isAbsolute(residentMcpEnv[server.key]?.NEO_PLANE_DATA_ROOT || '')) {
            throw unsupported(`resident '${server.key}' needs a resolved plane environment before preparation`)
        }
    }
    await assertNoSymlinkSegments({
        rootPath  : canonicalInstanceRoot,
        targetPath: instanceHome,
        fileSystem,
        label     : 'resident home'
    });

    const hydration = await hydrateWorkspace({
        mainCheckout: canonicalAgentosRuntimeRoot,
        projectRoot : canonicalTargetRepoRoot,
        log
    });

    await assertRealDirectory(canonicalTargetRepoRoot, 'targetRepoRoot', fileSystem);
    await assertExecutablePlan({plan, nodePath, fileSystem});
    await assertNoSymlinkSegments({
        rootPath  : canonicalInstanceRoot,
        targetPath: instanceHome,
        fileSystem,
        label     : 'resident home'
    });

    const memoryArtifacts = await convergeSeatMemory({
        agent,
        targetRepoRoot: canonicalTargetRepoRoot,
        instanceRoot  : canonicalInstanceRoot,
        previous,
        fileSystem
    });

    const artifacts = await prepareHarnessArtifacts({
        agent,
        targetRepoRoot    : canonicalTargetRepoRoot,
        instanceRoot      : canonicalInstanceRoot,
        instanceHome,
        agentosRuntimeRoot: canonicalAgentosRuntimeRoot,
        plan,
        previous,
        remoteMcpCapability,
        claudeConfigRoot,
        residentMcpEnv,
        launchAdmission,
        fileSystem
    });

    // the seat's own .env, in its seat folder beside the clones, where the operator adds keys
    await ensureSeatEnvFile({seatHome: path.join(canonicalInstanceRoot, agent.id), fileSystem});

    artifacts.push(...memoryArtifacts);

    const seatInstructions = await convergeSeatInstructions({
        harnessType   : agent.harnessType,
        targetRepoRoot: canonicalTargetRepoRoot,
        instanceHome,
        memoryDir     : deriveAgentMemoryDir({instanceRoot: canonicalInstanceRoot, agentId: agent.id}),
        repoSlug,
        fileSystem,
        log
    });

    seatInstructions.artifact && artifacts.push(seatInstructions.artifact);

    return {
        agentosRuntimeRoot: canonicalAgentosRuntimeRoot,
        targetRepoRoot    : canonicalTargetRepoRoot,
        instanceHome,
        mcpMatrix         : {...logicalPlan.mcpMatrix},
        mcpPlan           : plan.map(server => ({
            ...server,
            ...(server.environment ? {environment: {...server.environment}} : {}),
            args              : [...server.args],
            runtimeEnv        : [...server.runtimeEnv],
            requiredRuntimeEnv: [...server.requiredRuntimeEnv],
            secretEnv         : [...server.secretEnv]
        })),
        hydration,
        artifacts,
        seatInstructions  : seatInstructions.observation
    }
}

/**
 * @summary Fleet workspace preparation composer: resolve the sparse-at-rest MCP matrix once,
 * project the closed logical input, plan once, then apply once. Runtime and target roots are required
 * under their semantic names; the former `mainCheckout` / `repoPath` aliases are deliberately not
 * accepted because a stale caller must fail during seat re-materialization instead of silently
 * executing AgentOS from the target repository.
 *
 * Executable MCP entrypoints deliberately resolve from `agentosRuntimeRoot`: fresh managed
 * clones have no dependencies, dependency installation/build is outside this composer, and sharing
 * another checkout's writable `node_modules` would collapse the checkout boundary. The prepared
 * `targetRepoRoot` remains the single harness cwd/project truth, while Neural Link's explicit `--cwd`
 * resolves from AgentOS because it starts the AgentOS package/Bridge. Target ignored overlays are
 * hydrated for resident workspace tooling; no resident dependency artifact is created or adopted.
 *
 * Product adapters are evidence-gated. Codex uses project TOML plus an isolated home; Claude Code
 * uses an explicit strict MCP JSON with environment-variable references; Claude Desktop uses its isolated
 * profile, whose rows start each server through Fleet's launcher and native launch admission, and retires
 * the rows earlier Fleets wrote into the Code-tab local scope. Antigravity refuses until a contained
 * per-resident MCP authority is proven.
 *
 * @param {Object}   options
 * @param {Object}   options.agent               Fleet registry agent definition.
 * @param {String}   options.targetRepoRoot      Absolute provisioned target checkout path.
 * @param {String}   options.instanceRoot        Absolute Fleet harness-home root.
 * @param {String}  [options.previousInstanceRoot] The agents root a relocated seat's folder was copied from.
 * @param {String}   options.agentosRuntimeRoot  Installed AgentOS runtime root.
 * @param {String}  [options.nodePath]           Node executable used for installed MCP entrypoints.
 * @param {Object}  [options.mcpTarget]          Resolved non-secret tenant target:
 *     `{kind:'tenant', credentialEnvVar, resources:{memory-core:{url},knowledge-base:{url}}}`.
 * @param {Object}  [options.remoteMcpCapability] Exact non-secret installed-adapter proof returned
 *     by `FleetLifecycleService.assertRemoteMcpCapability`.
 * @param {Function}[options.hydrateWorkspace]    Import-safe checkout hydration seam.
 * @param {Function}[options.deriveInstanceHome]  Per-agent home derivation seam.
 * @param {Function}[options.resolveMatrix]       Sparse-at-rest MCP resolver seam.
 * @param {Object}  [options.runtime=process]     Host runtime facts for child execution mode.
 * @param {String}  [options.claudeConfigRoot]    Claude Desktop's shared Code-tab config root.
 * @param {Object}  [options.residentMcpEnv]      Per-server resolved child environment supplied at Start.
 * @param {Object}  [options.launchAdmission]     A Claude Desktop seat's reserved launch admission.
 * @param {Object}  [options.fileSystem]          Promise filesystem seam.
 * @param {Function}[options.log]                 Hydration logger.
 * @returns {Promise<{agentosRuntimeRoot: String, targetRepoRoot: String, instanceHome: String, mcpMatrix: Object, mcpPlan: Object[], hydration: Object, artifacts: Object[], seatInstructions: Object}>}
 *     `seatInstructions` is the decision about the seat's instruction file: `{state, reason, ignored?, homeFile?}`.
 * @throws {ManagedWorkspacePreparationError} for unsupported adapters or divergent owned content.
 * @see createManagedAgentWorkspacePlan
 * @see applyManagedAgentWorkspacePlan
 */
export async function prepareManagedAgentWorkspace({
    agent,
    targetRepoRoot,
    instanceRoot,
    previousInstanceRoot = null,
    agentosRuntimeRoot,
    nodePath = process.execPath,
    runtime = process,
    claudeConfigRoot = os.homedir(),
    residentMcpEnv = {},
    hydrateWorkspace = hydrateCurrentWorktree,
    deriveInstanceHome = deriveAgentInstanceHome,
    resolveMatrix = resolveMcpMatrix,
    mcpTarget = null,
    remoteMcpCapability = null,
    launchAdmission = null,
    fileSystem = fs,
    log = () => {}
} = {}) {
    if (!agent || typeof agent !== 'object') {
        throw new ManagedWorkspacePreparationError("prepareManagedAgentWorkspace: 'agent' is required.");
    }

    assertNonEmptyString(agent.id, 'agent.id');
    assertNonEmptyString(agent.harnessType, 'agent.harnessType');
    if (agent.metadata?.launch) {
        throw unsupported('raw metadata.launch overrides bypass curated resident-home and MCP preparation');
    }

    let plan;
    try {
        plan = createManagedAgentWorkspacePlan({
            agent    : {
                id         : agent.id,
                harnessType: agent.harnessType,
                ...(agent.forge           ? {forge          : agent.forge}           : {}),
                ...(agent.model           ? {model          : agent.model}           : {}),
                ...(agent.reasoningEffort ? {reasoningEffort: agent.reasoningEffort} : {})
            },
            mcpMatrix: resolveMatrix(agent.mcpServers, mcpCatalogFor(agent.forge)),
            mcpTarget
        })
    } catch (error) {
        if (error instanceof ManagedWorkspacePreparationError) throw error;
        throw unsupported(error.message)
    }

    return applyManagedAgentWorkspacePlan({
        plan,
        targetRepoRoot,
        repoSlug: agent.metadata?.repo?.repoSlug ?? null,
        instanceRoot,
        previousInstanceRoot,
        agentosRuntimeRoot,
        nodePath,
        runtime,
        claudeConfigRoot,
        residentMcpEnv,
        remoteMcpCapability,
        launchAdmission,
        hydrateWorkspace,
        deriveInstanceHome,
        fileSystem,
        log
    })
}

/** @private */
function assertSafeLogicalTree(value, label, ancestors=new WeakSet()) {
    if (typeof value === 'string') {
        if (isPortableAbsolutePath(value)) {
            throw new TypeError(`createManagedAgentWorkspacePlan: '${label}' must not contain an absolute host path.`)
        }
        return
    }

    if (value === null || value === undefined || typeof value !== 'object') return;

    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`createManagedAgentWorkspacePlan: '${label}' must contain plain data only.`)
    }
    if (Object.getOwnPropertySymbols(value).length) {
        throw new TypeError(`createManagedAgentWorkspacePlan: '${label}' must not contain symbol fields.`)
    }
    if (ancestors.has(value)) {
        throw new TypeError(`createManagedAgentWorkspacePlan: '${label}' must not contain a reference cycle.`)
    }

    ancestors.add(value);

    try {
        for (const key of Object.keys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);

            if (!descriptor || descriptor.get || descriptor.set) {
                throw new TypeError(`createManagedAgentWorkspacePlan: '${label}.${key}' must be a data field, not an accessor.`)
            }
            if (FORBIDDEN_LOGICAL_FIELDS.has(key.toLowerCase())) {
                throw new TypeError(`createManagedAgentWorkspacePlan: forbidden logical field '${key}'.`)
            }

            assertSafeLogicalTree(descriptor.value, `${label}.${key}`, ancestors)
        }
    } finally {
        ancestors.delete(value)
    }
}

/** @private */
function assertExactRecord(value, label, allowedKeys, requiredKeys=allowedKeys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`createManagedAgentWorkspacePlan: '${label}' must be an object.`)
    }

    const
        unknown = Object.keys(value).find(key => !allowedKeys.includes(key)),
        missing = requiredKeys.find(key => !Object.hasOwn(value, key));

    if (unknown) {
        throw new TypeError(`createManagedAgentWorkspacePlan: unknown field '${label}.${unknown}'.`)
    }
    if (missing) {
        throw new TypeError(`createManagedAgentWorkspacePlan: missing field '${label}.${missing}'.`)
    }
}

/** @private */
function assertLogicalString(value, label) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`createManagedAgentWorkspacePlan: '${label}' must be a non-empty string.`)
    }
}

/** @private */
function assertLogicalStringArray(value, label) {
    if (!Array.isArray(value) ||
        Object.keys(value).some((key, index) => key !== String(index)) ||
        value.some(item => typeof item !== 'string' || item.length === 0)) {
        throw new TypeError(`applyManagedAgentWorkspacePlan: '${label}' must be a dense string array.`)
    }
}

/** @private */
function isPortableAbsolutePath(value) {
    return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)
}


/** @private */
async function assertRealDirectory(directoryPath, label, fileSystem) {
    const stat = await fileSystem.lstat(directoryPath).catch(() => null);

    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
        throw divergentArtifact(directoryPath, label, 'expected a real resident-owned directory');
    }
}

/** @private */
async function assertExecutablePlan({plan, nodePath, fileSystem}) {
    const localEnabled = plan.filter(server => server.enabled && server.transport === 'stdio');

    if (localEnabled.length === 0) return;

    const nodeStat = await fileSystem.stat(nodePath).catch(() => null);

    if (!nodeStat?.isFile()) {
        throw unsupported(`Node executable is absent or not a file at '${nodePath}'`);
    }

    try {
        await fileSystem.access(nodePath, fsConstants.X_OK);
    } catch {
        throw unsupported(`Node executable is absent or non-executable at '${nodePath}'`);
    }

    for (const server of plan) {
        if (!server.enabled || server.transport !== 'stdio') continue;

        const
            entrypoint = server.args[0],
            entryStat  = await fileSystem.lstat(entrypoint).catch(() => null);

        if (!entryStat?.isFile()) {
            throw unsupported(`enabled MCP server '${server.key}' has no installed file entrypoint at '${entrypoint}'`);
        }

        try {
            await fileSystem.access(entrypoint, fsConstants.R_OK);
        } catch {
            throw unsupported(`enabled MCP server '${server.key}' has no readable installed entrypoint at '${entrypoint}'`);
        }
    }
}

/** @private */
async function assertNoSymlinkSegments({rootPath, targetPath, fileSystem, label}) {
    const relative = path.relative(rootPath, targetPath);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw divergentArtifact(targetPath, label, 'path escapes its trusted root');
    }

    const rootStat = await fileSystem.lstat(rootPath).catch(error => {
        if (error?.code === 'ENOENT') return null;
        throw error;
    });
    if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) {
        throw divergentArtifact(rootPath, label, 'trusted root is not a real directory');
    }

    let current = rootPath;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        const stat = await fileSystem.lstat(current).catch(error => {
            if (error?.code === 'ENOENT') return null;
            throw error;
        });
        if (!stat) break;
        if (stat.isSymbolicLink()) {
            throw divergentArtifact(current, label, 'symlinked resident-owned path segment');
        }
    }
}

/** @summary Converge the selected harness's owned workspace and MCP carrier. @private */
async function prepareHarnessArtifacts({
    agent,
    targetRepoRoot,
    instanceRoot,
    instanceHome,
    agentosRuntimeRoot,
    plan,
    previous,
    remoteMcpCapability,
    claudeConfigRoot,
    residentMcpEnv,
    launchAdmission,
    fileSystem
}) {
    switch (agent.harnessType) {
        case 'codex':
        case 'codex-desktop':
            return prepareCodexArtifacts({agent, targetRepoRoot, instanceHome, agentosRuntimeRoot, plan, previous, fileSystem});
        case 'kimi-code':
            return prepareKimiArtifacts({agent, instanceRoot, targetRepoRoot, instanceHome, agentosRuntimeRoot, plan, previous, fileSystem});
        case 'opencode':
            return prepareOpenCodeArtifacts({agent, instanceRoot, targetRepoRoot, instanceHome, agentosRuntimeRoot, plan, previous, fileSystem});
        case 'claude-code':
            return prepareClaudeJsonArtifact({
                agent,
                filePath      : path.join(instanceHome, 'mcp-config.json'),
                trustedRoot   : instanceHome,
                plan,
                remoteMcpCapability,
                fileSystem,
                interpolateEnv: true
            });
        case 'claude-desktop':
            return prepareClaudeDesktopArtifacts({agent, targetRepoRoot, instanceHome, plan, claudeConfigRoot, residentMcpEnv, launchAdmission, fileSystem});
        default:
            throw unsupported(`harness '${agent.harnessType}' has no workspace adapter`);
    }
}

/**
 * @summary The home a harness reads its user-scope files from: Codex Desktop nests its `CODEX_HOME`
 * inside the instance home, every other harness uses the instance home itself.
 * @param {String} harnessType
 * @param {String} instanceHome
 * @returns {String}
 * @private
 */
function harnessHomeRoot(harnessType, instanceHome) {
    return harnessType === 'codex-desktop' ? path.join(instanceHome, 'codex-home') : instanceHome
}

/**
 * @summary Converges the seat's maintainer instructions in its harness home (`projectSeatInstructions`
 * decides the file and its text). The file changes with every Skills release, so it is converged against
 * a receipt of Fleet's last write rather than as create-only content; a person's edit still refuses the
 * start. When the seat stops taking the file, Fleet retires the copy it wrote, so stale rules never load
 * beside the checkout's own. The decision travels in the preparation result as `observation`.
 * @param {Object} options
 * @returns {Promise<{artifact: Object|null, observation: Object}>}
 * @private
 */
async function convergeSeatInstructions({harnessType, targetRepoRoot, instanceHome, memoryDir, repoSlug, fileSystem, log}) {
    const
        ownedLabel  = 'seat instructions',
        receiptPath = path.join(instanceHome, '.neo-fleet-seat-instructions.json'),
        projection  = await projectSeatInstructions({
            harnessType,
            homeRoot: harnessHomeRoot(harnessType, instanceHome),
            repoSlug,
            targetRepoRoot,
            memoryDir,
            fileSystem
        }),
        observation = {
            state : projection.state,
            reason: projection.reason,
            ...(projection.ignored ? {ignored: projection.ignored} : {})
        };

    if (projection.state === SEAT_INSTRUCTION_STATES.PROJECTED) {
        return {
            artifact: await convergeTextArtifact({
                filePath       : projection.filePath,
                desiredContent : projection.content,
                ownedProjection: wholeFileOwnedProjection,
                ownedLabel,
                trustedRoot    : instanceHome,
                fileSystem,
                receiptPath
            }),
            observation
        }
    }

    log(`${ownedLabel} ${projection.state}: ${projection.reason}`);

    if (!projection.filePath) return {artifact: null, observation};

    const retired = await retireSeatInstructions({filePath: projection.filePath, receiptPath, trustedRoot: instanceHome, fileSystem, ownedLabel});

    return {
        artifact   : retired.artifact,
        observation: retired.homeFile ? {...observation, homeFile: retired.homeFile} : observation
    }
}

/**
 * @summary Removes the instructions file Fleet wrote into a seat's home once the seat no longer takes it,
 * with its receipt. Only a file that still hashes to Fleet's last write is Fleet's to remove. A file with no
 * receipt was never Fleet's and stays, reported in `homeFile`; a file edited after Fleet wrote it refuses
 * the start, because its rules would load beside the ones the seat now takes.
 * @param {Object} options
 * @returns {Promise<{artifact: Object|null, homeFile?: String}>}
 * @private
 */
async function retireSeatInstructions({filePath, receiptPath, trustedRoot, fileSystem, ownedLabel}) {
    await assertNoSymlinkSegments({rootPath: trustedRoot, targetPath: filePath, fileSystem, label: ownedLabel});

    let existing;

    try {
        existing = await fileSystem.readFile(filePath, 'utf8')
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;

        await removeContentReceipt({receiptPath, trustedRoot, fileSystem});
        return {artifact: null}
    }

    const recorded = await readContentReceipt({receiptPath, filePath, trustedRoot, fileSystem});

    if (recorded === null) {
        return {artifact: null, homeFile: `kept: ${filePath} was not written by Fleet`}
    }

    if (recorded !== hashContent(existing)) {
        throw divergentArtifact(filePath, ownedLabel, 'edited after Fleet wrote it, and the seat no longer takes it')
    }

    await fileSystem.unlink(filePath);
    await removeContentReceipt({receiptPath, trustedRoot, fileSystem});

    return {artifact: {path: filePath, status: WORKSPACE_ARTIFACT_STATES.UPDATED, ownedKeys: `${ownedLabel} retired`}}
}

/**
 * @summary Creates the seat-owned memory folder and fills only missing Codex birth files. Claude's
 * `autoMemoryDirectory` pins the same folder; Kimi and OpenCode scaffold through their generators.
 * Imported and bearer-authored files stay untouched. A relocated Claude pin follows the seat.
 * @param {Object}      options
 * @param {Object}      options.agent          Fleet registry agent definition.
 * @param {String}      options.targetRepoRoot Absolute provisioned target checkout path.
 * @param {String}      options.instanceRoot   Absolute Fleet agents root.
 * @param {Object|null} options.previous       The relocated seat's previous placement ({@link previousSeatPlacement}).
 * @param {Object}      options.fileSystem     Promise filesystem seam.
 * @returns {Promise<Object[]>} The directory, birth files or Claude settings artifacts.
 * @private
 */
async function convergeSeatMemory({agent, targetRepoRoot, instanceRoot, previous, fileSystem}) {
    if (agent.harnessType === 'kimi-code' || agent.harnessType === 'opencode') {
        const legacyDir = path.join(deriveAgentInstanceHome({instanceRoot, agentId: agent.id, harnessType: agent.harnessType}), 'memory');

        await assertNoSymlinkSegments({rootPath: instanceRoot, targetPath: legacyDir, fileSystem, label: 'legacy seat memory'});

        const entries = await fileSystem.readdir(legacyDir).catch(error => {
            if (error?.code === 'ENOENT') return [];
            throw error
        });

        if (entries.length) {
            throw divergentArtifact(legacyDir, 'seat memory', 'legacy harness memory must be moved into the seat memory folder before preparation')
        }
    }

    const memoryDir = deriveAgentMemoryDir({instanceRoot, agentId: agent.id}),
          artifacts = [await ensureDirectoryArtifact(memoryDir, instanceRoot, fileSystem, {mode: 0o700})];

    if (CLAUDE_HARNESS_TYPES.has(agent.harnessType)) {
        artifacts.push(await convergeJsonSetting({
            filePath     : path.join(targetRepoRoot, '.claude', 'settings.local.json'),
            key          : CLAUDE_MEMORY_SETTING,
            value        : memoryDir,
            previousValue: previous && deriveAgentMemoryDir({instanceRoot: previous.instanceRoot, agentId: agent.id}),
            trustedRoot  : targetRepoRoot,
            fileSystem
        }));
    } else if (agent.harnessType === 'codex' || agent.harnessType === 'codex-desktop') {
        for (const [name, content] of [
            ['MEMORY.md', renderMemoryIndexMd({harness: agent.harnessType})],
            ['identity.md', renderIdentityMd()],
            ['about-this-layer.md', renderAboutThisLayerMd({harness: agent.harnessType})]
        ]) {
            artifacts.push(await convergeTextArtifact({
                filePath       : path.join(memoryDir, name), desiredContent: content,
                ownedProjection: createOnlyOwnedProjection, ownedLabel: 'create-only bearer memory layer',
                trustedRoot    : memoryDir, fileSystem
            }));
        }
    }

    return artifacts
}

/**
 * @summary Converges one Fleet-owned top-level key in a JSON settings file the seat and its person also
 * write. The key goes into the file's own text, so every other byte stays as it was. A value already
 * there that differs is refused, never replaced: it is someone else's decision about the same thing.
 * The one exception is `previousValue`, the value Fleet itself wrote at a relocated seat's previous home.
 * @param {Object} options
 * @param {String} options.filePath    The settings file.
 * @param {String} options.key         The Fleet-owned top-level key.
 * @param {*}      options.value       Its JSON-serializable value.
 * @param {*}      [options.previousValue=null] Fleet's value at the seat's previous home, replaced in place.
 * @param {String} options.trustedRoot The root no path segment may leave by a symlink.
 * @param {Object} options.fileSystem  Promise filesystem seam.
 * @returns {Promise<Object>} The artifact, `CREATED`, `MATCH` or `UPDATED`.
 * @throws {ManagedWorkspacePreparationError} For a file that is not a JSON object, or a different value.
 * @private
 */
async function convergeJsonSetting({filePath, key, value, previousValue = null, trustedRoot, fileSystem}) {
    await assertNoSymlinkSegments({rootPath: trustedRoot, targetPath: filePath, fileSystem, label: key});

    let existing;

    try {
        existing = await fileSystem.readFile(filePath, 'utf8')
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;

        await fileSystem.mkdir(path.dirname(filePath), {recursive: true});
        await assertNoSymlinkSegments({rootPath: trustedRoot, targetPath: filePath, fileSystem, label: key});

        try {
            await fileSystem.writeFile(filePath, `${JSON.stringify({[key]: value}, null, 4)}\n`, {encoding: 'utf8', flag: 'wx', mode: 0o600});
            return {path: filePath, status: WORKSPACE_ARTIFACT_STATES.CREATED, ownedKeys: key}
        } catch (writeError) {
            if (writeError?.code !== 'EEXIST') throw writeError;
            existing = await fileSystem.readFile(filePath, 'utf8')
        }
    }

    const settings = parseJsonObject(existing);

    if (!settings) throw divergentArtifact(filePath, key, 'not a JSON object');

    if (Object.hasOwn(settings, key)) {
        if (isDeepStrictEqual(settings[key], value)) {
            return {path: filePath, status: WORKSPACE_ARTIFACT_STATES.MATCH, ownedKeys: key}
        }

        if (previousValue === null || !isDeepStrictEqual(settings[key], previousValue)) {
            throw divergentArtifact(filePath, key, `it already names another ${key}`)
        }

        const
            property = findDirectJsonProperty(existing, findJsonObjectRange(existing), key),
            replaced = property && existing.slice(0, property.valueStart) + JSON.stringify(value) + existing.slice(property.valueEnd);

        if (!replaced || !isDeepStrictEqual(parseJsonObject(replaced), {...settings, [key]: value})) {
            throw divergentArtifact(filePath, key, 'the replacement could not preserve the file')
        }

        await publishTextAtomically({filePath, content: replaced, fileSystem});

        return {path: filePath, status: WORKSPACE_ARTIFACT_STATES.UPDATED, ownedKeys: key}
    }

    const merged = insertJsonProperty(existing, key, value);

    if (!isDeepStrictEqual(parseJsonObject(merged), {...settings, [key]: value})) {
        throw divergentArtifact(filePath, key, 'the insertion could not preserve the file')
    }

    await publishTextAtomically({filePath, content: merged, fileSystem});

    return {path: filePath, status: WORKSPACE_ARTIFACT_STATES.UPDATED, ownedKeys: key}
}

/**
 * @summary Inserts one property at the top of a JSON object's source, leaving every other byte as it
 * was. The new line takes the indentation of the property after it, or four spaces in an empty object.
 * @param {String} source A JSON object's source.
 * @param {String} key
 * @param {*}      value
 * @returns {String}
 * @private
 */
function insertJsonProperty(source, key, value) {
    const
        open  = findJsonObjectRange(source).start + 1,
        first = skipJsonTrivia(source, open),
        entry = `${JSON.stringify(key)}: ${JSON.stringify(value)}`;

    if (source[first] === '}') {
        return `${source.slice(0, open)}\n    ${entry}\n${source.slice(first)}`
    }

    const lead = source.slice(open, first);

    return `${source.slice(0, open)}${lead.includes('\n') ? lead.slice(lead.lastIndexOf('\n')) : ''}${entry},${source.slice(open)}`
}

/**
 * @summary Parses strict JSON and keeps it only when it is a plain object.
 * @param {String} source
 * @returns {Object|null}
 * @private
 */
function parseJsonObject(source) {
    try {
        const value = JSON.parse(source);

        return value && typeof value === 'object' && !Array.isArray(value) ? value : null
    } catch {
        return null
    }
}

/**
 * @summary Converge a Codex seat's project MCP tables and its Codex home. The `enabled` lines are
 * converged first ({@link convergeCodexProjectSwitches}): the Fleet switches servers off in the
 * project layer and leaves the others to the seat's own switch, which writes the home.
 * @param {Object} options
 * @returns {Promise<Object[]>} The artifact rows: project, home, memories directory.
 * @private
 */
async function prepareCodexArtifacts({agent, targetRepoRoot, instanceHome, plan, previous, fileSystem}) {
    const
        projectPath     = path.join(targetRepoRoot, '.codex', 'config.toml'),
        legacyContent   = renderCodexProjectConfig(localizePlan(plan)),
        runtimePrevious = previousNodeRuntimePlan(plan),
        homeRoot        = harnessHomeRoot(agent.harnessType, instanceHome),
        homePath        = path.join(homeRoot, 'config.toml'),
        memoriesPath    = path.join(homeRoot, 'memories'),
        homeContent     = renderCodexHomeConfig(),
        remote          = plan.some(server => server.target === 'tenant'),
        artifacts       = [];
    const switched = await convergeCodexProjectSwitches({
        filePath   : projectPath,
        plan,
        instanceHome,
        adapter    : agent.harnessType,
        trustedRoot: targetRepoRoot,
        fileSystem
    });
    const contextSeed = await readCodexContextSeed({targetRepoRoot, projectPath, homePath, instanceHome, fileSystem});

    artifacts.push(...await convergeTransportArtifact({
        filePath                 : projectPath,
        desiredContent           : contextSeed + renderCodexProjectConfig(plan),
        legacyContent,
        placementLegacyContent   : renderCodexProjectConfig(previousPlacementPlan(plan)),
        runtimeLegacyContent     : runtimePrevious && renderCodexProjectConfig(runtimePrevious),
        runtimeLegacyStdioContent: runtimePrevious && renderCodexProjectConfig(localizePlan(runtimePrevious)),
        ownedProjection          : projectCodexOwnedProjection,
        mergeTransport           : mergeCodexTransport,
        adapter                  : agent.harnessType,
        instanceHome,
        remote,
        ownedLabel               : 'mcp_servers.\"neo-mjs-*\"',
        trustedRoot              : targetRepoRoot,
        fileSystem
    }));

    if (contextSeed && artifacts[0].status !== WORKSPACE_ARTIFACT_STATES.CREATED) {
        await publishTextAtomically({
            filePath: projectPath,
            content : contextSeed + await fileSystem.readFile(projectPath, 'utf8'),
            fileSystem
        });
        artifacts[0].status = WORKSPACE_ARTIFACT_STATES.UPDATED
    }

    if (switched && artifacts[0].status === WORKSPACE_ARTIFACT_STATES.MATCH) {
        artifacts[0].status = WORKSPACE_ARTIFACT_STATES.UPDATED
    }

    const homeArtifact = await convergeTextArtifact({
        filePath       : homePath,
        desiredContent : homeContent,
        ownedProjection: codexHomeOwnedProjection,
        ownedLabel     : 'cli_auth_credentials_store,mcp_oauth_credentials_store,features.memories',
        trustedRoot    : instanceHome,
        fileSystem
    });

    if (await convergeCodexRemoteTrust({
        filePath: homePath,
        repoPath: targetRepoRoot,
        // the block names the checkout's real path as it was then, so both spellings are Fleet's
        previousRepoPaths: previous ? [previous.targetRepoRoot, await fileSystem.realpath(previous.targetRepoRoot).catch(() => null)] : [],
        remote,
        trustedRoot      : instanceHome,
        fileSystem
    }) && homeArtifact.status === WORKSPACE_ARTIFACT_STATES.MATCH) {
        homeArtifact.status = WORKSPACE_ARTIFACT_STATES.UPDATED
    }

    if (await convergeCodexSeatSettings({filePath: homePath, agent, trustedRoot: instanceHome, fileSystem}) &&
        homeArtifact.status === WORKSPACE_ARTIFACT_STATES.MATCH) {
        homeArtifact.status = WORKSPACE_ARTIFACT_STATES.UPDATED
    }

    artifacts.push(homeArtifact);
    artifacts.push(await ensureDirectoryArtifact(memoriesPath, instanceHome, fileSystem));

    return artifacts;
}

/**
 * @summary Writes the seat's declared model and reasoning effort into its Codex home config, replacing whatever
 * value it held, so the next thread starts on them. Every other key and comment stays as it is, and a file that
 * cannot be written that way is refused unchanged ({@link module:ai/services/fleet/codexConfigToml.applyCodexSeatSettings}).
 * @param {Object} options
 * @param {String} options.filePath    The Codex home `config.toml`, converged just before.
 * @param {Object} options.agent       The seat's record, read for `model` and `reasoningEffort`.
 * @param {String} options.trustedRoot The root no path segment may leave by a symlink.
 * @param {Object} options.fileSystem  Promise filesystem seam.
 * @returns {Promise<Boolean>} Whether Fleet changed the file.
 * @private
 */
async function convergeCodexSeatSettings({filePath, agent, trustedRoot, fileSystem}) {
    if (!agent.model && !agent.reasoningEffort) return false;

    await assertNoSymlinkSegments({rootPath: trustedRoot, targetPath: filePath, fileSystem, label: 'model,model_reasoning_effort'});

    const source = await fileSystem.readFile(filePath, 'utf8');

    let next;

    try {
        next = applyCodexSeatSettings(source, agent)
    } catch (error) {
        // a file Fleet cannot write without changing anything else is refused as it stands, and Start says why
        throw divergentArtifact(filePath, 'model,model_reasoning_effort', error.message)
    }

    if (next === source) return false;

    await publishTextAtomically({filePath, content: next, fileSystem});

    return true
}

/**
 * @summary Bootstrap the selected repository's Codex context policy without owning it thereafter.
 * Either explicit project/home key preserves the resident's whole policy. Only the two documented
 * positive integer defaults are seeded; MCP, provider and permission settings are never copied.
 * @param {Object} options Explicit project/home paths and the bounded promise filesystem seam.
 * @returns {Promise<String>} Root TOML prefix, or an empty string when no seed is applicable.
 * @private
 */
async function readCodexContextSeed({targetRepoRoot, projectPath, homePath, instanceHome, fileSystem}) {
    const keys       = ['model_context_window', 'model_auto_compact_token_limit'];
    const readPolicy = async (filePath, trustedRoot) => {
        await assertNoSymlinkSegments({rootPath: trustedRoot, targetPath: filePath, fileSystem, label: 'Codex context policy'});
        let source;

        try {
            source = await fileSystem.readFile(filePath, 'utf8')
        } catch (error) {
            if (error?.code === 'ENOENT') return {};
            throw error
        }

        try {
            return parseToml(source)
        } catch {
            throw divergentArtifact(filePath, 'Codex context policy', 'invalid TOML')
        }
    };

    for (const [filePath, root] of [[projectPath, targetRepoRoot], [homePath, instanceHome]]) {
        const policy = await readPolicy(filePath, root);
        if (keys.some(key => Object.hasOwn(policy, key))) return ''
    }

    const templatePath = path.join(targetRepoRoot, '.codex', 'config.template.toml');
    const template     = await readPolicy(templatePath, targetRepoRoot);
    const entries      = keys.filter(key => Object.hasOwn(template, key)).map(key => [key, template[key]]);

    if (entries.some(([, value]) => !Number.isSafeInteger(value) || value <= 0)) {
        throw divergentArtifact(templatePath, 'Codex context policy', 'context defaults must be positive safe integers')
    }

    return entries.length
        ? '# Initial context defaults from this repository; subsequent settings are resident-owned.\n' +
            entries.map(([key, value]) => `${key} = ${value}`).join('\n') + '\n\n'
        : '';
}

/** @private */
async function prepareClaudeJsonArtifact({
    agent,
    filePath,
    trustedRoot,
    plan,
    remoteMcpCapability,
    fileSystem,
    interpolateEnv
}) {
    const
        runtimePrevious = previousNodeRuntimePlan(plan),
        renderPrevious  = previous => renderClaudeJsonContent({agent, plan: previousPlacementPlan(previous), remoteMcpCapability, interpolateEnv, placement: false}),
        desiredContent  = renderClaudeJsonContent({
            agent,
            plan,
            remoteMcpCapability,
            instanceHome: trustedRoot,
            interpolateEnv
        }),
        legacyContent  = renderClaudeJsonContent({
            agent,
            plan        : localizePlan(plan),
            remoteMcpCapability,
            instanceHome: trustedRoot,
            interpolateEnv
        });

    return convergeTransportArtifact({
        filePath,
        desiredContent,
        legacyContent,
        placementLegacyContent   : [renderPrevious(plan), runtimePrevious && renderClaudeJsonContent({agent, plan: runtimePrevious, interpolateEnv})].filter(Boolean),
        runtimeLegacyContent     : runtimePrevious && renderPrevious(runtimePrevious),
        runtimeLegacyStdioContent: runtimePrevious && renderPrevious(localizePlan(runtimePrevious)),
        ownedProjection          : claudeJsonOwnedProjection,
        mergeTransport           : (existing, desired, names) => mergeJsonTransport(existing, desired, 'mcpServers', names),
        adapter                  : agent.harnessType,
        instanceHome             : trustedRoot,
        remote                   : plan.some(server => server.target === 'tenant'),
        ownedLabel               : 'mcpServers.neo-mjs-*',
        trustedRoot,
        fileSystem
    })
}

/**
 * @summary Render Claude Code MCP JSON with native HTTP and stdio env references. The exact prior
 * Desktop shape is retained only to recognize and retire Fleet's old profile rows.
 * @private
 */
function renderClaudeJsonContent({agent, plan, interpolateEnv, legacyDesktop = false, placement = true}) {
    const servers = {};

    for (const server of plan) {
        if (!server.enabled) continue;

        if (server.transport === 'streamable-http') {
            if (legacyDesktop) {
                servers[server.name] = {
                    command: server.command,
                    ...(server.environment ? {env: {...server.environment}} : {}),
                    args   : [
                        path.join(server.sourceRoot, 'ai/mcp/client/stdioToStreamableHttp.mjs'),
                        '--url',
                        server.url,
                        '--token-env',
                        server.credentialEnvVar
                    ]
                }
            } else {
                servers[server.name] = {
                    type   : 'http',
                    url    : server.url,
                    headers: {Authorization: `Bearer \${${server.credentialEnvVar}}`}
                }
            }
            continue
        }

        const
            env      = {...server.environment},
            envNames = interpolateEnv
                ? new Set(placement ? server.runtimeEnv : [...server.requiredRuntimeEnv, ...server.secretEnv])
                : server.requiredRuntimeEnv;

        for (const name of envNames) {
            if (interpolateEnv) {
                const required = server.requiredRuntimeEnv.includes(name) || server.secretEnv.includes(name);
                env[name] = `\${${name}${placement && !required ? ':-' : ''}}`;
            } else if (name === 'NEO_AGENT_IDENTITY') {
                env[name] = agent.id;
            } else {
                throw unsupported(`Claude Desktop has no secret-free representation for runtime env '${name}'`);
            }
        }

        servers[server.name] = {command: server.command, args: server.args, env};
    }

    return JSON.stringify({mcpServers: servers}, null, 2) + '\n'
}

/**
 * @summary Converge a managed Desktop seat's Neo MCP rows into its own profile, so every Code session of that
 * Desktop has them, whatever folder it opened. Desktop starts a profile row's child with a
 * stripped environment, so each enabled server's row runs Fleet's launcher with that server's reserved grant
 * ({@link renderDesktopLaunchRows}). Then the rows an earlier Fleet wrote into the Code-tab local scope are
 * retired. Start prepares only while the seat's Desktop is stopped, so no Desktop writes the profile meanwhile.
 * @param {Object} options Explicit host roots, the bound plan, the resident values and the reserved admission.
 * @returns {Promise<Object[]>} Profile and local-scope convergence observations.
 * @private
 */
async function prepareClaudeDesktopArtifacts({agent, targetRepoRoot, instanceHome, plan, claudeConfigRoot, residentMcpEnv, launchAdmission, fileSystem}) {
    if (!launchAdmission?.issuer || !launchAdmission.grants || !launchAdmission.identity) {
        throw unsupported('Claude Desktop profile rows need a reserved native launch admission')
    }

    await assertLaunchEntrypoints({plan, fileSystem});

    const profile = await convergeDesktopProfile({
        agent,
        instanceHome,
        plan,
        desired: renderDesktopLaunchRows({agent, plan, residentMcpEnv, launchAdmission}),
        fileSystem
    });

    return [profile, await retireClaudeLocalScope({targetRepoRoot: await fileSystem.realpath(targetRepoRoot), instanceHome, claudeConfigRoot, fileSystem})]
}

/**
 * @summary One profile row per enabled server: Fleet's launcher, the server it starts, and literally the
 * validated forge login, the Node runtime env, the resident server's plane placement, the issuer's origin
 * and the server's grant. Every value a row leaves out is redeemed at launch
 * ({@link launchRowEnvNames}), so the profile holds no PAT, plane bearer or signing key.
 * @param {Object} options
 * @returns {Object} Canonical `neo-mjs-*` rows.
 * @private
 */
function renderDesktopLaunchRows({agent, plan, residentMcpEnv, launchAdmission}) {
    // the login the grants were reserved for, never the Fleet id: a custom id may differ from it
    const {identity} = launchAdmission;

    if (!isLaunchIdentity(identity)) {
        throw unsupported(`agent '${agent.id}' has no valid forge login for its profile rows`)
    }

    const rows = {};

    for (const server of plan) {
        if (!server.enabled) continue;

        const
            capability = launchAdmission.grants[server.key],
            resolved   = residentMcpEnv[server.key] || {};

        if (!capability) throw unsupported(`enabled MCP server '${server.key}' has no reserved launch grant`);

        rows[server.name] = {
            command: server.command,
            args   : [path.join(server.sourceRoot, LAUNCHER_ENTRYPOINT), '--server', server.key],
            env    : {
                ...server.environment,
                NEO_AGENT_IDENTITY: identity,
                ...Object.fromEntries(launchRowEnvNames(server).placement
                    .filter(name => typeof resolved[name] === 'string')
                    .map(name => [name, resolved[name]])),
                [LAUNCH_ISSUER_ENV_VAR]: launchAdmission.issuer,
                [LAUNCH_GRANT_ENV_VAR] : capability
            }
        }
    }

    return canonicalize(rows)
}

/**
 * @summary Prove the files the profile rows start: the launcher for every enabled row, and for a tenant row
 * the stdio bridge it hands to.
 * @private
 */
async function assertLaunchEntrypoints({plan, fileSystem}) {
    for (const server of plan.filter(row => row.enabled)) {
        const files = [LAUNCHER_ENTRYPOINT, ...(server.target === 'tenant' ? [BRIDGE_ENTRYPOINT] : [])];

        for (const file of files.map(relative => path.join(server.sourceRoot, relative))) {
            if (!(await fileSystem.lstat(file).catch(() => null))?.isFile()) {
                throw unsupported(`enabled MCP server '${server.key}' has no installed launch entrypoint at '${file}'`)
            }
        }
    }
}

/**
 * @summary Converge the owned `neo-mjs-*` rows of the Desktop profile; every other key stays the operator's.
 * Rows count as Fleet's when the receipt recorded them, or when they are exactly a projection an earlier
 * Fleet wrote before receipts. Anything else refuses before a byte changes. The receipt names the new rows
 * before the profile does and keeps the old ones admissible, so a preparation interrupted between the two
 * writes converges on its next run.
 * @param {Object} options
 * @returns {Promise<Object>} Profile convergence observation.
 * @private
 */
async function convergeDesktopProfile({agent, instanceHome, plan, desired, fileSystem}) {
    const
        filePath    = path.join(instanceHome, 'claude_desktop_config.json'),
        receiptPath = path.join(instanceHome, DESKTOP_PROFILE_RECEIPT),
        ownedLabel  = 'mcpServers.neo-mjs-*';

    await assertNoSymlinkSegments({rootPath: instanceHome, targetPath: filePath, fileSystem, label: ownedLabel});
    await assertNoSymlinkSegments({rootPath: instanceHome, targetPath: receiptPath, fileSystem, label: 'profile receipt'});

    const source = await readOptionalText(filePath, fileSystem);
    let parsed;

    try {
        parsed = source === null ? {} : JSON.parse(source);
        for (const value of [parsed, parsed.mcpServers]) {
            if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new TypeError()
        }
    } catch {
        throw divergentArtifact(filePath, ownedLabel, 'invalid Claude Desktop profile')
    }

    const
        actual      = claudeJsonOwnedProjection(JSON.stringify(parsed)),
        actualHash  = hashContent(JSON.stringify(actual)),
        desiredHash = hashContent(JSON.stringify(desired)),
        recorded    = await readDesktopProfileReceipt({receiptPath, fileSystem}),
        record      = previous => publishTextAtomically({
            filePath: receiptPath,
            content : JSON.stringify({version: 2, artifact: path.basename(filePath), sha256: desiredHash, previous}, null, 2) + '\n',
            fileSystem
        });

    await fileSystem.mkdir(instanceHome, {recursive: true});

    if (source !== null && actualHash === desiredHash) {
        recorded.includes(desiredHash) || await record(null);
        return {path: filePath, status: WORKSPACE_ARTIFACT_STATES.MATCH, ownedKeys: ownedLabel}
    }

    if (Object.keys(actual).length && !recorded.includes(actualHash) && !isFormerDesktopProjection({agent, plan, actual})) {
        throw divergentArtifact(filePath, ownedLabel, 'Fleet-owned profile rows differ from what Fleet last wrote')
    }

    await record(Object.keys(actual).length ? actualHash : null);

    if (await readOptionalText(filePath, fileSystem) !== source) {
        throw divergentArtifact(filePath, ownedLabel, 'changed during preparation; quit the seat\'s Claude Desktop and start it again')
    }

    const rows = parsed.mcpServers ??= {};

    for (const name of Object.keys(rows)) if (name.startsWith(NEO_MCP_NAME_PREFIX)) delete rows[name];
    Object.assign(rows, desired);

    await publishTextAtomically({filePath, content: JSON.stringify(parsed, null, 2) + '\n', fileSystem});

    return {path: filePath, status: source === null ? WORKSPACE_ARTIFACT_STATES.CREATED : WORKSPACE_ARTIFACT_STATES.UPDATED, ownedKeys: ownedLabel}
}

/**
 * @returns {Promise<String[]>} The row hashes the profile receipt admits: the rows Fleet wrote last, and the
 *     ones before them while that write may not have landed. Empty when no receipt can vouch.
 * @private
 */
async function readDesktopProfileReceipt({receiptPath, fileSystem}) {
    let receipt;

    try {
        receipt = JSON.parse(await fileSystem.readFile(receiptPath, 'utf8'))
    } catch (error) {
        if (error?.code === 'ENOENT' || error instanceof SyntaxError) return [];
        throw error
    }

    return receipt?.version === 2 && receipt.artifact === 'claude_desktop_config.json'
        ? [receipt.sha256, receipt.previous].filter(hash => /^[a-f0-9]{64}$/.test(hash ?? ''))
        : []
}

/**
 * @summary Whether profile rows are exactly a projection Fleet wrote before profile receipts existed, so a
 * seat moved by an earlier Fleet converges instead of refusing.
 * @private
 */
function isFormerDesktopProjection({agent, plan, actual}) {
    const legacyPlan = previousPlacementPlan(plan).map(server => ({...server, enabled: server.enabled &&
        !server.requiredRuntimeEnv.some(name => server.secretEnv.includes(name))}));
    const candidates = [legacyPlan, localizePlan(legacyPlan)];
    const previous   = previousNodeRuntimePlan(legacyPlan);

    if (previous) candidates.push(previous, localizePlan(previous));

    return candidates.some(candidate => isDeepStrictEqual(actual, claudeJsonOwnedProjection(renderClaudeJsonContent({
        agent, plan: candidate, interpolateEnv: false, legacyDesktop: true
    }))))
}

/**
 * @summary Retire the `neo-mjs-*` rows an earlier Fleet wrote into the shared Code-tab config under the managed
 * clone. The profile rows replace them, and a duplicate would mask whichever Desktop prefers. Only rows exactly
 * as the receipt recorded them go; anything else refuses, naming the file, and foreign projects, trust and
 * toggles stay as they are. The changed bytes are backed up first and a concurrent rewrite refuses.
 * @param {Object} options Explicit clone, profile and config root.
 * @returns {Promise<Object>} Local-scope retirement observation.
 * @private
 */
async function retireClaudeLocalScope({targetRepoRoot, instanceHome, claudeConfigRoot, fileSystem}) {
    const
        filePath    = path.join(claudeConfigRoot, '.claude.json'),
        receiptPath = path.join(instanceHome, '.neo-fleet-claude-project.json'),
        ownedLabel  = 'projects.<managed-clone>.mcpServers.neo-mjs-*',
        retired     = {path: filePath, status: WORKSPACE_ARTIFACT_STATES.MATCH, ownedKeys: `${ownedLabel} retired`};

    await assertNoSymlinkSegments({rootPath: claudeConfigRoot, targetPath: filePath, fileSystem, label: ownedLabel});

    const source = await readOptionalText(filePath, fileSystem);
    let parsed;

    try {
        parsed = source === null ? {} : JSON.parse(source);
        for (const value of [parsed, parsed.projects, parsed.projects?.[targetRepoRoot], parsed.projects?.[targetRepoRoot]?.mcpServers]) {
            if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new TypeError()
        }
    } catch {
        throw divergentArtifact(filePath, ownedLabel, 'invalid Claude local config')
    }

    const actual = claudeJsonOwnedProjection(JSON.stringify(parsed.projects?.[targetRepoRoot] || {}));

    if (Object.keys(actual).length) {
        const recorded = await readContentReceipt({receiptPath, filePath, trustedRoot: instanceHome, fileSystem});

        if (recorded !== hashContent(JSON.stringify(actual))) {
            throw divergentArtifact(filePath, ownedLabel, 'Code-tab rows differ from what Fleet wrote; remove them from the managed clone\'s project, then start again')
        }

        const backup = path.join(instanceHome, '.neo-fleet-claude-backup.json');

        await assertNoSymlinkSegments({rootPath: instanceHome, targetPath: backup, fileSystem, label: 'Claude config backup'});
        await fileSystem.mkdir(instanceHome, {recursive: true});
        await publishTextAtomically({filePath: backup, content: source, fileSystem});

        if (await readOptionalText(filePath, fileSystem) !== source) {
            throw divergentArtifact(filePath, ownedLabel, 'changed during preparation; retry after the config writer settles')
        }

        const rows = parsed.projects[targetRepoRoot].mcpServers;

        for (const name of Object.keys(rows)) if (name.startsWith(NEO_MCP_NAME_PREFIX)) delete rows[name];

        await publishTextAtomically({filePath, content: JSON.stringify(parsed, null, 2) + '\n', fileSystem});
        retired.status = WORKSPACE_ARTIFACT_STATES.UPDATED
    }

    await removeContentReceipt({receiptPath, trustedRoot: instanceHome, fileSystem});

    return retired
}

/** @private */
async function readOptionalText(filePath, fileSystem) {
    return fileSystem.readFile(filePath, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error
    })
}

/**
 * Birth a Kimi Code seat's full artifact set from `generateKimiSeatConfig` — the generator owns
 * content, this composer owns convergence policy. The curated MCP matrix narrows the canonical
 * server set (a disabled catalog server is never wired); the memory-layer files are CREATE-ONLY
 * (story-sovereignty: after first boot they are bearer-authored, and re-provisioning must never
 * clobber or even flag them); the config/hook surfaces converge on their Fleet-owned projections.
 * @private
 */
async function prepareKimiArtifacts({agent, instanceRoot, targetRepoRoot, instanceHome, agentosRuntimeRoot, plan, previous, fileSystem}) {
    const
        enabledKeys = new Set(plan.filter(server => server.enabled).map(server => server.key)),
        servers     = KIMI_SEAT_SERVERS.filter(server => enabledKeys.has(server.name.slice(NEO_MCP_NAME_PREFIX.length)));

    if (servers.length === 0) {
        throw unsupported("harness 'kimi-code' has no enabled MCP servers to wire");
    }

    const
        remoteServers = createRemoteServerMap(plan),
        optionsAt     = placement => ({
            agentosRuntimeRoot,
            targetRepoRoot: placement.targetRepoRoot,
            seatEnvFile   : path.join(placement.targetRepoRoot, '.env'),
            kimiHome      : placement.instanceHome,
            memoryDir     : deriveAgentMemoryDir({instanceRoot: placement.instanceRoot, agentId: agent.id}),
            nodeBinary    : plan[0].command,
            servers
        }),
        options     = optionsAt({targetRepoRoot, instanceHome, instanceRoot}),
        environment = plan[0].environment,
        {files} = generateKimiSeatConfig({...options, environment, remoteServers}),
        {files: legacyFiles} = generateKimiSeatConfig({...options, environment}),
        runtimeLegacyFiles = environment && generateKimiSeatConfig({...options, remoteServers}).files,
        runtimeLegacyStdioFiles = environment && generateKimiSeatConfig(options).files,
        previousFiles = previous && rehomeFiles(generateKimiSeatConfig({...optionsAt(previous), environment, remoteServers}).files, previous, {targetRepoRoot, instanceHome});

    return convergeSeatConfigFiles({files, legacyFiles, runtimeLegacyFiles, runtimeLegacyStdioFiles, previousFiles, repoPath: targetRepoRoot, instanceHome, memoryDir: options.memoryDir, fileSystem, policies: [
        {
            match           : /config\.toml$/,
            ownedProjection : kimiConfigTomlOwnedProjection,
            relocatableLines: kimiConfigTomlOwnedLines,
            ownedLabel      : 'default_permission_mode,default_model,[[permission.rules]],[[hooks]]'
        },
        {
            match           : /\.kimi-code\/mcp\.json$/,
            ownedProjection : claudeJsonOwnedProjection,
            relocatableLines: source => linesStartingWithin(source, jsonPropertyRanges(source, ['mcpServers'], key => key.startsWith(NEO_MCP_NAME_PREFIX))),
            ownedLabel      : 'mcpServers."neo-mjs-*"',
            transport       : {adapter: 'kimi-code', containerName: 'mcpServers'}
        },
        {match: /hooks\/identityAnchorHook\.mjs$/, ownedProjection: wholeFileOwnedProjection, relocatableLines: everyLine, ownedLabel: 'generated identity-anchor hook'}
        // Everything else (the four memory-layer files) is create-only bearer substrate.
    ]});
}

/**
 * Birth an OpenCode seat's full artifact set from `generateOpenCodeSeatConfig` — same split as
 * the Kimi branch: generator content, composer convergence, matrix-narrowed servers, create-only
 * bearer memory layer. The wake-envelope boot hook is emitted into the instance home (fully
 * Fleet-owned; divergence fails closed per the generated-artifact posture).
 * @private
 */
async function prepareOpenCodeArtifacts({agent, instanceRoot, targetRepoRoot, instanceHome, agentosRuntimeRoot, plan, previous, fileSystem}) {
    const
        enabledKeys = new Set(plan.filter(server => server.enabled).map(server => server.key)),
        servers     = OPENCODE_SEAT_SERVERS.filter(server => enabledKeys.has(server.name.slice(NEO_MCP_NAME_PREFIX.length)));

    if (servers.length === 0) {
        throw unsupported("harness 'opencode' has no enabled MCP servers to wire");
    }

    const
        remoteServers = createRemoteServerMap(plan),
        optionsAt     = placement => ({
            agentosRuntimeRoot,
            targetRepoRoot: placement.targetRepoRoot,
            seatEnvFile   : path.join(placement.targetRepoRoot, '.env'),
            memoryDir     : deriveAgentMemoryDir({instanceRoot: placement.instanceRoot, agentId: agent.id}),
            nodeBinary    : plan[0].command,
            environment   : plan[0].environment,
            seatHome      : placement.instanceHome,
            wakeHookPath  : path.join(placement.instanceHome, 'write-wake-envelope.mjs'),
            // The seat's OWN OpenCode plugins dir, resolved here rather than inside the boot hook:
            // `deriveHarnessLaunchSpec` points `XDG_CONFIG_HOME` at this same `instanceHome`, so the plant
            // lands where that seat's first OpenCode process looks for it — before the hook ever runs.
            // The hook runs after the server is listening, so a plant IT installed could only be loaded by
            // a later process, and `hookEnv` does not carry `XDG_CONFIG_HOME` at all.
            wakePlantPath : path.join(placement.instanceHome, 'opencode', 'plugins', WAKE_ENVELOPE_PLANT_FILE_NAME),
            servers
        }),
        options       = optionsAt({targetRepoRoot, instanceHome, instanceRoot}),
        {files}       = generateOpenCodeSeatConfig({...options, remoteServers}),
        {files: legacyFiles} = generateOpenCodeSeatConfig(options),
        runtimeLegacyFiles = plan[0].environment && generateOpenCodeSeatConfig({...options, environment: {}, remoteServers}).files,
        runtimeLegacyStdioFiles = plan[0].environment && generateOpenCodeSeatConfig({...options, environment: {}}).files,
        previousFiles = previous && rehomeFiles(generateOpenCodeSeatConfig({...optionsAt(previous), remoteServers}).files, previous, {targetRepoRoot, instanceHome});

    // The plant is WITHHELD from the generic text-artifact pass rather than given a policy row, because
    // `convergeTextArtifact` cannot replace and the plant has to be replaceable: the file already on a
    // provisioned seat is an earlier GENERATION, not a hand edit, and only the generation marker can
    // tell those apart. Its own convergence owns the file, and the rule is scoped to it alone.
    const
        plantFile  = files.find(file => file.path === options.wakePlantPath),
        rest       = files.filter(file => file.path !== options.wakePlantPath),
        legacyRest = legacyFiles.filter(file => file.path !== options.wakePlantPath);

    return [
        ...await convergeSeatConfigFiles({
            files   : rest, legacyFiles: legacyRest, runtimeLegacyFiles, runtimeLegacyStdioFiles, previousFiles, repoPath: targetRepoRoot, instanceHome, memoryDir: options.memoryDir, fileSystem,
            policies: [
                {
                    match           : /opencode\.jsonc$/,
                    ownedProjection : opencodeJsoncOwnedProjection,
                    relocatableLines: opencodeJsoncRelocatableLines,
                    ownedLabel      : 'mcp."neo-mjs-*",instructions',
                    transport       : {adapter: 'opencode', containerName: 'mcp'}
                },
                {match: /write-wake-envelope\.mjs$/, ownedProjection: wholeFileOwnedProjection, relocatableLines: everyLine, ownedLabel: 'generated wake-envelope boot hook'}
            ]
        }),
        ...await convergeWakeEnvelopePlant({plantFile, instanceHome, fileSystem})
    ];
}

/**
 * @summary Converge the wake-envelope plant under its OWN rule, because the general text-artifact rule
 * cannot express provenance.
 *
 * `convergeTextArtifact` is create-or-refuse: it replaces nothing. That is right for a config a person
 * edits and wrong for the plant, which the Fleet owns outright and rewrites whenever the Brain's copy
 * changes — so without this, the FIRST plant edit after provisioning is refused on every seat, because
 * the file on disk is an earlier generation and a bare byte-compare cannot tell an earlier generation
 * from a hand edit. Nothing is clobbered here either: a file that is not a pristine generation (see
 * `isUnmodifiedGeneration`) is refused exactly as any other divergent Fleet-owned content is, and the
 * refusal names the file. The two outcomes are distinguishable in the receipt, which is the point —
 * `UPDATED` says "the Fleet moved its own file forward", `DIVERGENT` says "a person did".
 * @private
 */
async function convergeWakeEnvelopePlant({plantFile, instanceHome, fileSystem}) {
    if (!plantFile) {
        return []
    }

    const plant = plantFile,
          label = 'generated wake-envelope plant';

    await assertNoSymlinkSegments({rootPath: instanceHome, targetPath: plant.path, fileSystem, label});

    let existing = null;

    try {
        existing = await fileSystem.readFile(plant.path, 'utf8')
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error
    }

    if (existing === plant.content) {
        return [{path: plant.path, status: WORKSPACE_ARTIFACT_STATES.MATCH, ownedKeys: label}]
    }

    if (existing !== null && !isUnmodifiedGeneration(existing)) {
        throw new ManagedWorkspacePreparationError(
            `prepareManagedAgentWorkspace: refusing to overwrite a hand-edited wake-envelope plant at '${plant.path}'. ` +
            'A plant carrying a generation marker that matches its own body is an earlier Fleet generation and is replaced; ' +
            'one without is a person\'s, and reconciling it is theirs to do.',
            {
                code    : 'FLEET_WORKSPACE_DIVERGENT',
                artifact: {
                    path     : plant.path,
                    status   : WORKSPACE_ARTIFACT_STATES.DIVERGENT,
                    ownedKeys: label,
                    reason   : 'hand-edited plant: no generation marker, or its marker does not match its body'
                }
            }
        )
    }

    await fileSystem.mkdir(path.dirname(plant.path), {recursive: true});

    await publishTextAtomically({filePath: plant.path, content: plant.content, fileSystem});

    return [{
        path     : plant.path,
        status   : existing === null ? WORKSPACE_ARTIFACT_STATES.CREATED : WORKSPACE_ARTIFACT_STATES.UPDATED,
        ownedKeys: label
    }];
}

/**
 * Converge a generator's emission list against the workspace: each file lands under the policy
 * its path matches (Fleet-owned projection, fail-closed on divergence) or falls through to the
 * create-only bearer default — an existing file of ANY content reports MATCH untouched (the
 * seat's own authorship is never a divergence), an absent file is created from the template.
 * A relocated seat's `previousFiles` (the generator's rendering at its previous home) move first.
 * @private
 */
async function convergeSeatConfigFiles({files, legacyFiles, runtimeLegacyFiles, runtimeLegacyStdioFiles, previousFiles, repoPath, instanceHome, memoryDir, fileSystem, policies}) {
    const artifacts = [];

    for (const file of files) {
        const policy = policies.find(entry => entry.match.test(file.path));

        const legacyFile   = legacyFiles?.find(entry => entry.path === file.path);
        const previousFile = policy && previousFiles?.find(entry => entry.path === file.path);
        const common       = {
            filePath       : file.path,
            desiredContent : file.content,
            ownedProjection: policy ? policy.ownedProjection : createOnlyOwnedProjection,
            ownedLabel     : policy ? policy.ownedLabel      : 'create-only bearer memory layer',
            trustedRoot    : file.path.startsWith(memoryDir + path.sep) ? memoryDir
                : file.path.startsWith(repoPath + path.sep) ? repoPath : instanceHome,
            fileSystem
        };
        const moved     = previousFile && await relocateGeneratedText({...common, previousContent: previousFile.content, relocatableLines: policy.relocatableLines});
        const converged = policy?.transport
            ? await convergeTransportArtifact({
                ...common,
                legacyContent            : legacyFile.content,
                runtimeLegacyContent     : runtimeLegacyFiles?.find(entry => entry.path === file.path)?.content,
                runtimeLegacyStdioContent: runtimeLegacyStdioFiles?.find(entry => entry.path === file.path)?.content,
                mergeTransport           : (existing, desired, names) => mergeJsonTransport(
                    existing,
                    desired,
                    policy.transport.containerName,
                    names
                ),
                adapter: policy.transport.adapter,
                instanceHome,
                remote : file.content !== legacyFile.content
            })
            : [await convergeTextArtifact(common)];

        if (moved && converged[0].status === WORKSPACE_ARTIFACT_STATES.MATCH) {
            converged[0].status = WORKSPACE_ARTIFACT_STATES.UPDATED
        }

        artifacts.push(...converged)
    }

    return artifacts;
}

/**
 * @summary Moves one generated file with its relocated seat. When the file's Fleet-owned projection is
 * still exactly the generator's rendering at the previous home, each generated line that changed between
 * the two renderings is replaced by its new line, but only inside the ranges the policy owns
 * (`relocatableLines`). The same line anywhere else, in an entry the operator added for instance, stays
 * as it was. Nothing is written unless the result projects to the current rendering; then convergence
 * decides, as on any Start.
 * @param {Object}   options
 * @param {String}   options.filePath         The file at the seat's current home.
 * @param {String}   options.previousContent  The generator's rendering at the previous home.
 * @param {String}   options.desiredContent   Its rendering here.
 * @param {Function} options.ownedProjection  The file's Fleet-owned projection.
 * @param {Function} options.relocatableLines `(source, {previousContent, desiredContent}) => Set<Number>`, the
 *     indexes of the lines the Fleet owns in `source`.
 * @param {String}   options.trustedRoot      The root no path segment may leave by a symlink.
 * @param {Object}   options.fileSystem       Promise filesystem seam.
 * @returns {Promise<Boolean>} Whether the file was rewritten.
 * @private
 */
async function relocateGeneratedText({filePath, previousContent, desiredContent, ownedProjection, relocatableLines, trustedRoot, fileSystem}) {
    await assertNoSymlinkSegments({rootPath: trustedRoot, targetPath: filePath, fileSystem, label: 'relocated seat file'});

    const
        existing   = await fileSystem.readFile(filePath, 'utf8').catch(error => {
            if (error?.code === 'ENOENT') return null;
            throw error
        }),
        projectsTo = (source, rendering) => JSON.stringify(ownedProjection(source)) === JSON.stringify(ownedProjection(rendering));

    if (existing === null || projectsTo(existing, desiredContent) || !projectsTo(existing, previousContent)) return false;

    const
        before = previousContent.split('\n'),
        after  = desiredContent.split('\n'),
        moves  = new Map();

    if (before.length !== after.length) return false;

    for (const [index, line] of before.entries()) {
        if (line === after[index]) continue;
        // one previous line rendered two ways has no single new line
        if (moves.has(line) && moves.get(line) !== after[index]) return false;

        moves.set(line, after[index])
    }

    const
        owned     = relocatableLines(existing, {previousContent, desiredContent}),
        relocated = existing.split('\n').map((line, index) => owned.has(index) ? moves.get(line) ?? line : line).join('\n');

    if (!projectsTo(relocated, desiredContent)) return false;

    await publishTextAtomically({filePath, content: relocated, fileSystem});

    return true
}

/**
 * @summary Where a relocated seat's paths pointed before its folder was copied to this agents root: the
 * previous root's harness home, and its checkout when that sat inside the seat's folder (one outside it
 * did not move). `null` without a previous root, or when it is this root.
 * @param {Object}      options
 * @param {String|null} options.previousInstanceRoot The agents root the seat's folder was copied from.
 * @param {String}      options.instanceRoot         This agents root, resolved.
 * @param {String}      options.targetRepoRoot       This checkout, resolved.
 * @param {Object}      options.agent                The plan's `{id, harnessType}`.
 * @param {Function}    options.deriveInstanceHome   Per-agent home derivation seam.
 * @returns {{instanceRoot: String, instanceHome: String, targetRepoRoot: String}|null}
 * @private
 */
function previousSeatPlacement({previousInstanceRoot, instanceRoot, targetRepoRoot, agent, deriveInstanceHome}) {
    if (previousInstanceRoot === null) return null;

    assertAbsolutePath(previousInstanceRoot, 'previousInstanceRoot');

    const
        root   = path.resolve(previousInstanceRoot),
        inSeat = path.relative(path.join(instanceRoot, agent.id), targetRepoRoot);

    if (root === instanceRoot) return null;

    return {
        instanceRoot  : root,
        instanceHome  : deriveInstanceHome({instanceRoot: root, agentId: agent.id, harnessType: agent.harnessType}),
        targetRepoRoot: inSeat === '..' || inSeat.startsWith(`..${path.sep}`) || path.isAbsolute(inSeat)
            ? targetRepoRoot
            : path.join(root, agent.id, inSeat)
    }
}

/**
 * @summary Re-addresses a generator's rendering at a seat's previous placement to the files it becomes at
 * the current one, so each rendering pairs with its current file.
 * @param {Object[]} files     `{path, content}` rendered for the previous placement.
 * @param {Object}   previous  `{targetRepoRoot, instanceHome}` there.
 * @param {Object}   current   `{targetRepoRoot, instanceHome}` here.
 * @returns {Object[]}
 * @private
 */
function rehomeFiles(files, previous, current) {
    return files.map(file => {
        for (const key of ['targetRepoRoot', 'instanceHome']) {
            const relative = path.relative(previous[key], file.path);

            if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
                return {...file, path: path.join(current[key], relative)}
            }
        }

        return file
    })
}

/**
 * The create-only projection: existing bearer-authored content is never a divergence.
 * @private
 */
function createOnlyOwnedProjection() {
    return null;
}

/**
 * The whole-file projection for fully Fleet-owned generated artifacts (hook scripts): any
 * content drift — a hand-edit or a stale template generation — fails closed and loud.
 * @private
 */
function wholeFileOwnedProjection(source) {
    return source;
}

/**
 * The Fleet-owned surface of a generated Kimi `config.toml`: the two managed scalars plus every
 * array-of-tables block (`[[permission.rules]]`, `[[hooks]]`) the generator emits. Harness-owned
 * additions the seat's first login writes (provider tables) sit OUTSIDE the projection, so a
 * post-provisioning re-birth reports MATCH instead of a false divergence.
 * @private
 */
function kimiConfigTomlOwnedProjection(source) {
    const result  = {blocks: [], scalars: {}};
    let   current = null;

    for (const line of source.split(/\r?\n/)) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith('#')) continue;

        const arrayHeader = trimmed.match(/^\[\[([^\]]+)\]\]$/);

        if (arrayHeader) {
            current = [trimmed];
            result.blocks.push(current);
            continue;
        }
        if (/^\[[^\]]+\]$/.test(trimmed)) { current = null; continue; }
        if (current) { current.push(trimmed); continue; }

        const scalar = trimmed.match(/^(default_permission_mode|default_model)\s*=\s*(.+)$/);
        if (scalar) result.scalars[scalar[1]] = scalar[2].trim();
    }

    return canonicalize(result);
}

/**
 * The Fleet-owned surface of a generated `opencode.jsonc`: the `neo-mjs-*` MCP entries plus the
 * `instructions` array (the memory-layer load wiring). Resident additions outside those keys are
 * free. Legal JSONC comments and trailing commas are normalized only for comparison; the source
 * bytes themselves remain resident-owned outside Fleet's narrow MCP replacements.
 * @private
 */
function opencodeJsoncOwnedProjection(source) {
    let parsed;
    try {
        parsed = parseJsonLike(source);
    } catch {
        return {__invalidJson: true};
    }

    const result = {instructions: parsed?.instructions};

    for (const [name, definition] of Object.entries(parsed?.mcp || {})) {
        if (name.startsWith(NEO_MCP_NAME_PREFIX)) (result.mcp ??= {})[name] = definition;
    }

    return canonicalize(result);
}

/**
 * @summary The lines of a generated `opencode.jsonc` a relocation may move: the `neo-mjs-*` MCP entries, the
 * `instructions`, and the `external_directory` grants the Fleet wrote for the seat's own folders (the keys
 * its rendering at the previous home has and its current rendering no longer does). An entry the operator
 * added stays theirs, however much it resembles a Fleet one.
 * @param {String} source
 * @param {Object} renderings `{previousContent, desiredContent}`.
 * @returns {Set<Number>}
 * @private
 */
function opencodeJsoncRelocatableLines(source, {previousContent, desiredContent}) {
    const grants = content => {
        try {
            return Object.keys(parseJsonLike(content)?.permission?.external_directory ?? {})
        } catch {
            return []
        }
    };
    const kept = new Set(grants(desiredContent)), moved = new Set(grants(previousContent).filter(key => !kept.has(key)));

    return linesStartingWithin(source, [
        ...jsonPropertyRanges(source, ['mcp'], key => key.startsWith(NEO_MCP_NAME_PREFIX)),
        ...jsonPropertyRanges(source, [], key => key === 'instructions'),
        ...jsonPropertyRanges(source, ['permission', 'external_directory'], key => moved.has(key))
    ])
}

/**
 * @summary The lines of a generated Kimi `config.toml` the Fleet owns: its two scalars and every
 * array-of-tables block, as {@link kimiConfigTomlOwnedProjection} reads them.
 * @param {String} source
 * @returns {Set<Number>}
 * @private
 */
function kimiConfigTomlOwnedLines(source) {
    const owned = new Set();
    let   block = false;

    source.split('\n').forEach((line, index) => {
        const trimmed = line.trim();

        if (/^\[\[[^\]]+\]\]$/.test(trimmed)) block = true;
        else if (/^\[[^\]]+\]$/.test(trimmed)) block = false;

        if (block || /^(default_permission_mode|default_model)\s*=/.test(trimmed)) owned.add(index)
    });

    return owned
}

/**
 * @summary The lines whose first non-blank character lies inside one of the ranges.
 * @param {String}     source
 * @param {Number[][]} ranges `[start, end]` offsets.
 * @returns {Set<Number>}
 * @private
 */
function linesStartingWithin(source, ranges) {
    const owned  = new Set();
    let   offset = 0;

    source.split('\n').forEach((line, index) => {
        const first = offset + line.length - line.trimStart().length;

        ranges.some(([start, end]) => first >= start && first < end) && owned.add(index);
        offset += line.length + 1
    });

    return owned
}

/**
 * @summary Every line of a file the Fleet owns whole.
 * @param {String} source
 * @returns {Set<Number>}
 * @private
 */
function everyLine(source) {
    return new Set(source.split('\n').keys())
}

/**
 * @summary Render only Fleet-owned MCP tables from the resolved plan. Project policy belongs to
 * the resident; convergence preserves existing settings without a runtime-root setup template.
 * @private
 */
function renderCodexProjectConfig(plan) {
    return [
        CODEX_PROJECT_HEADER,
        plan.map(renderCodexMcpTable).join('\n\n'),
        ''
    ].join('\n');
}

/**
 * @summary One Codex project table. Only a server the Fleet switches off carries `enabled`
 * ({@link convergeCodexProjectSwitches}).
 * @private
 */
function renderCodexMcpTable(server) {
    const switchedOff = server.enabled ? [] : ['enabled = false'];

    if (server.transport === 'streamable-http') {
        return [
            `[mcp_servers.\"${server.name}\"]`,
            `url = ${JSON.stringify(server.url)}`,
            `bearer_token_env_var = ${JSON.stringify(server.credentialEnvVar)}`,
            'startup_timeout_sec = 30',
            'tool_timeout_sec = 120',
            ...switchedOff
        ].join('\n')
    }

    return [
        `[mcp_servers.\"${server.name}\"]`,
        `command = ${JSON.stringify(server.command)}`,
        `args = ${JSON.stringify(server.args)}`,
        ...(server.environment ? [`env = { ${Object.entries(server.environment)
            .map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ')} }`] : []),
        `env_vars = ${JSON.stringify(server.runtimeEnv)}`,
        'startup_timeout_sec = 30',
        'tool_timeout_sec = 120',
        ...switchedOff
    ].join('\n');
}

/** @private */
function renderCodexHomeConfig() {
    return [
        '# Fleet-owned Codex home policy. Authentication material itself is created by Codex login, never by Fleet.',
        'cli_auth_credentials_store = "file"',
        'mcp_oauth_credentials_store = "file"',
        '',
        '[features]',
        'memories = true',
        ''
    ].join('\n');
}

/**
 * @summary Extract a Codex MCP server name from one parsed TOML table header.
 * @param {{array: Boolean, body: String}|null} header
 * @returns {String|null}
 * @private
 */
function codexMcpServerName(header) {
    if (!header || header.array) return null;

    return header.body.match(/^mcp_servers\."([^"]+)"$/)?.[1] ?? null
}

/** @private */
function projectCodexOwnedProjection(source) {
    const lines   = source.split(/\r?\n/), result = {};
    let   current = null, buffer = [];

    const flush = () => {
        if (current?.startsWith(NEO_MCP_NAME_PREFIX)) {
            result[current] = trimTomlTableSuffix(buffer.map(line => line.trimEnd()).join('\n')).trim();
        }
    };

    for (const line of lines) {
        const
            header = parseTomlTableHeader(line),
            name   = codexMcpServerName(header);

        if (name) {
            flush();
            current = name;
            buffer = [line];
            continue;
        }
        if (header) {
            flush();
            current = null;
            buffer = [];
            continue;
        }
        if (current) buffer.push(line);
    }
    flush();

    return canonicalize(result);
}

/** @private */
function codexHomeOwnedProjection(source) {
    const wanted = new Set([
        'cli_auth_credentials_store',
        'mcp_oauth_credentials_store',
        'features.memories'
    ]), result = {};
    let table = '';

    for (const rawLine of source.split(/\r?\n/)) {
        const header = parseTomlTableHeader(rawLine);

        if (header) {
            table = header.array ? '' : header.body;
            continue
        }

        const line = rawLine.replace(/\s+#.*$/, '').trim();
        if (!line) continue;
        const entry = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
        if (!entry) continue;
        const key = table ? `${table}.${entry[1]}` : entry[1];
        if (wanted.has(key)) result[key] = entry[2].trim();
    }

    return canonicalize(result);
}

/**
 * @summary Bring the `enabled` line of each `neo-mjs-*` table in a Codex project config to the plan:
 * `enabled = false` closes a table the Fleet switches off, and a switched-on table carries none, so
 * the seat's own switch decides. The app's switch writes the seat's Codex home (the user layer), and
 * the project layer outranks it, so an `enabled = true` here would shadow the switch. Converging the
 * line apart from the rest of the table lets a cockpit change of the matrix land instead of reading
 * as divergence. A tenant seat's transport receipt that vouched for the previous tables is re-issued
 * for the converged ones first, so a crash between the two writes leaves a receipt the next Start can
 * still use.
 * @param {Object}   options
 * @param {String}   options.filePath     The project `config.toml`.
 * @param {Object[]} options.plan         The bound MCP plan (`name`, `enabled`).
 * @param {String}   options.instanceHome The seat's instance home (receipt location).
 * @param {String}   options.adapter      Harness type the receipt names.
 * @param {String}   options.trustedRoot  The target repository root.
 * @param {Object}   options.fileSystem   Promise filesystem seam.
 * @returns {Promise<Boolean>} whether Fleet changed the project artifact.
 * @private
 */
async function convergeCodexProjectSwitches({filePath, plan, instanceHome, adapter, trustedRoot, fileSystem}) {
    let source;

    try {
        source = await fileSystem.readFile(filePath, 'utf8')
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error
    }

    const
        off    = new Set(plan.filter(server => !server.enabled).map(server => server.name)),
        output = [];
    let table = null, lastContent = -1;

    const close = () => {
        if (table && off.has(table)) output.splice(lastContent + 1, 0, 'enabled = false')
    };

    for (const line of source.replace(CODEX_PROJECT_HEADER_V1, CODEX_PROJECT_HEADER).split('\n')) {
        const header = parseTomlTableHeader(line);

        if (header) {
            const name = codexMcpServerName(header);

            close();
            table       = name?.startsWith(NEO_MCP_NAME_PREFIX) ? name : null;
            output.push(line);
            lastContent = output.length - 1;
            continue
        }

        if (table && /^\s*enabled\s*=\s*(?:true|false)\s*(?:#.*)?\r?$/.test(line)) continue;

        output.push(line);

        if (table && line.trim() && !line.trim().startsWith('#')) lastContent = output.length - 1
    }

    close();

    const converged = output.join('\n');

    if (converged === source) return false;

    await assertNoSymlinkSegments({rootPath: trustedRoot, targetPath: filePath, fileSystem, label: 'mcp_servers."neo-mjs-*".enabled'});

    const
        receiptPath = path.join(instanceHome, TRANSPORT_RECEIPT_FILE),
        receipt     = await readTransportReceipt({receiptPath, adapter, filePath, fileSystem});

    if (receipt?.projectionSha256 === hashProjection(splitTransportProjection(projectCodexOwnedProjection(source)).transport)) {
        await convergeTransportReceipt({
            receiptPath,
            adapter,
            filePath,
            projectionSha256: hashProjection(splitTransportProjection(projectCodexOwnedProjection(converged)).transport),
            fileSystem,
            instanceHome
        })
    }

    await publishTextAtomically({filePath, content: converged, fileSystem});
    return true
}

/**
 * @summary Add the narrow Codex project-trust row only while remote MCP is selected, then remove
 * exactly Fleet's marked block on opt-out. Trust keys use the checkout's real path, as Codex does;
 * only an exact former lexical block may migrate. Re-entry reads semantic trust, preserving native settings
 * inserted inside Fleet's comments; mixed blocks cannot be removed on opt-out. A non-trusted row
 * rejects remote admission. This keeps the no-intent home artifact byte-identical
 * to the stdio baseline while making the generated project MCP config consumable at runtime.
 * A relocated seat's block, exactly as Fleet rendered it for a `previousRepoPaths` entry, moves to the
 * checkout's new path.
 * @param {Object} options
 * @returns {Promise<Boolean>} whether Fleet changed the home artifact.
 * @private
 */
async function convergeCodexRemoteTrust({filePath, repoPath, previousRepoPaths = [], remote, trustedRoot, fileSystem}) {
    await assertNoSymlinkSegments({
        rootPath  : trustedRoot,
        targetPath: filePath,
        fileSystem,
        label     : 'Codex remote MCP project trust'
    });

    const
        source        = await fileSystem.readFile(filePath, 'utf8'),
        trustPath     = remote ? await fileSystem.realpath(repoPath) : repoPath,
        expectedBlock = renderCodexRemoteTrustBlock(trustPath),
        begin         = source.indexOf(CODEX_REMOTE_TRUST_BEGIN),
        endMarker     = source.indexOf(CODEX_REMOTE_TRUST_END),
        secondBegin   = begin < 0 ? -1 : source.indexOf(CODEX_REMOTE_TRUST_BEGIN, begin + 1),
        secondEnd     = endMarker < 0 ? -1 : source.indexOf(CODEX_REMOTE_TRUST_END, endMarker + 1);

    if ((begin < 0) !== (endMarker < 0) || secondBegin >= 0 || secondEnd >= 0 || endMarker < begin) {
        throw transportDivergence(filePath, 'projects.<managed-repo>.trust_level', 'malformed Fleet trust marker')
    }

    const existingTrust = remote ? readCodexProjectTrust(source, trustPath, filePath) : undefined;

    if (begin >= 0) {
        const
            end   = endMarker + CODEX_REMOTE_TRUST_END.length,
            block = source.slice(begin, end);

        if (remote) {
            if (trustPath !== repoPath && readCodexProjectTrust(block, repoPath, filePath) !== undefined) {
                if (block !== renderCodexRemoteTrustBlock(repoPath)) {
                    throw transportDivergence(filePath, 'projects.<managed-repo>.trust_level', 'legacy Fleet trust block diverged')
                }
                if (existingTrust !== undefined && existingTrust !== 'trusted') {
                    throw transportDivergence(filePath, 'projects.<managed-repo>.trust_level', 'resident trust row is not trusted')
                }

                // An existing resident grant already owns canonical trust; never create a duplicate table.
                const replacement = existingTrust === 'trusted' ? '' : expectedBlock;

                await publishTextAtomically({filePath, content: source.slice(0, begin) + replacement + source.slice(end), fileSystem});
                return true
            }
            if (block !== expectedBlock && previousRepoPaths.some(previousPath => previousPath && block === renderCodexRemoteTrustBlock(previousPath))) {
                // the operator's own decision about the new checkout stands: a distrust is never overwritten
                if (existingTrust !== undefined && existingTrust !== 'trusted') {
                    throw transportDivergence(filePath, 'projects.<managed-repo>.trust_level', 'resident trust row is not trusted')
                }

                const replacement = existingTrust === 'trusted' ? '' : expectedBlock;

                await publishTextAtomically({filePath, content: source.slice(0, begin) + replacement + source.slice(end), fileSystem});
                return true
            }
            if (existingTrust !== 'trusted') {
                throw transportDivergence(filePath, 'projects.<managed-repo>.trust_level', 'Fleet trust block diverged')
            }
            return false
        }

        const removable = block.match(
            /^# Fleet-managed remote MCP project trust begin\n\[projects\.(.+)\]\ntrust_level = "trusted"\n# Fleet-managed remote MCP project trust end$/
        );

        if (!removable) {
            throw transportDivergence(filePath, 'projects.<managed-repo>.trust_level', 'Fleet trust block diverged')
        }

        const suffix = source.slice(end).startsWith('\n\n') ? source.slice(end + 2) : source.slice(end);

        await publishTextAtomically({
            filePath,
            content: source.slice(0, begin) + suffix,
            fileSystem
        });
        return true
    }

    if (!remote) return false;

    if (existingTrust === 'trusted') return false;
    if (existingTrust !== undefined) {
        throw transportDivergence(filePath, 'projects.<managed-repo>.trust_level', 'resident trust row is not trusted')
    }

    const featureHeader = /^\[features\]\s*$/m.exec(source);
    if (!featureHeader) {
        throw transportDivergence(filePath, 'projects.<managed-repo>.trust_level', 'features insertion anchor is missing')
    }

    const output = source.slice(0, featureHeader.index) +
        expectedBlock + '\n\n' +
        source.slice(featureHeader.index);

    await publishTextAtomically({filePath, content: output, fileSystem});
    return true
}

/** @private */
function renderCodexRemoteTrustBlock(repoPath) {
    return [
        CODEX_REMOTE_TRUST_BEGIN,
        `[projects.${JSON.stringify(repoPath)}]`,
        'trust_level = "trusted"',
        CODEX_REMOTE_TRUST_END
    ].join('\n')
}

/** @summary Read native TOML trust without exposing resident source in parser diagnostics. @private */
function readCodexProjectTrust(source, repoPath, filePath) {
    try {
        return parseToml(source).projects?.[repoPath]?.trust_level
    } catch {
        throw transportDivergence(filePath, 'projects.<managed-repo>.trust_level', 'invalid Codex home TOML')
    }
}

/** @private */
function claudeJsonOwnedProjection(source) {
    let parsed;
    try {
        parsed = JSON.parse(source);
    } catch {
        return {__invalidJson: true};
    }

    const result = {};
    for (const [name, definition] of Object.entries(parsed?.mcpServers || {})) {
        if (name.startsWith(NEO_MCP_NAME_PREFIX)) result[name] = definition;
    }
    return canonicalize(result);
}

const TRANSPORT_SERVER_NAMES = Object.freeze([
    `${NEO_MCP_NAME_PREFIX}memory-core`,
    `${NEO_MCP_NAME_PREFIX}knowledge-base`
]);

const TRANSPORT_RECEIPT_FILE = '.neo-fleet-mcp-transport.json';

/** @summary Recognize the former exact invocation without widening any other managed setting. @private */
function previousNodeRuntimePlan(plan) {
    return plan.some(server => server.environment)
        ? plan.map(({environment, ...server}) => server)
        : null;
}

/**
 * @summary Exact pre-placement slot vocabulary for upgrading only an untouched Fleet projection.
 * Descriptor history is bounded here; unrelated operator edits remain a divergence.
 * @param {Object[]} plan Bound current plan.
 * @returns {Object[]} Prior generated plan.
 * @private
 */
function previousPlacementPlan(plan) {
    return plan.map(server => ({...server,
        runtimeEnv        : [...(MCP_SERVER_DESCRIPTORS[server.key].legacyRuntimeEnv || MCP_SERVER_DESCRIPTORS[server.key].runtimeEnv)],
        requiredRuntimeEnv: [...MCP_SERVER_DESCRIPTORS[server.key].requiredRuntimeEnv]
    }))
}

/** @private */
function localizePlan(plan) {
    return plan.map(server => server.target === 'tenant'
        ? {...server, target: 'resident', transport: 'stdio', url: null, credentialEnvVar: null}
        : {...server});
}

/** @private */
function createRemoteServerMap(plan) {
    return Object.fromEntries(plan
        .filter(server => server.target === 'tenant')
        .map(server => [server.name, {
            url             : server.url,
            credentialEnvVar: server.credentialEnvVar
        }]));
}

/**
 * @summary Converge the one transport-bearing artifact with an authenticated transition receipt.
 * Markerless legacy stdio may move once; later changes require the receipt hash to match the
 * current MC/KB projection. Other managed entries must match, except the exact prior runtime
 * projection supplied by the renderer. That one upgrade changes child Node mode without accepting
 * unrelated edits; resident tables and login state remain outside the owned projection.
 * @private
 */
async function convergeTransportArtifact({
    filePath,
    desiredContent,
    legacyContent,
    runtimeLegacyContent,
    runtimeLegacyStdioContent,
    placementLegacyContent,
    ownedProjection,
    mergeTransport,
    adapter,
    instanceHome,
    remote,
    ownedLabel,
    trustedRoot,
    fileSystem
}) {
    await assertNoSymlinkSegments({rootPath: trustedRoot, targetPath: filePath, fileSystem, label: ownedLabel});

    const
        receiptPath          = path.join(instanceHome, TRANSPORT_RECEIPT_FILE),
        desired              = splitTransportProjection(ownedProjection(desiredContent)),
        legacy               = splitTransportProjection(ownedProjection(legacyContent)),
        placementPrevious    = [].concat(placementLegacyContent || []).map(content => splitTransportProjection(ownedProjection(content))),
        runtimePrevious      = runtimeLegacyContent && splitTransportProjection(ownedProjection(runtimeLegacyContent)),
        runtimePreviousStdio = runtimeLegacyStdioContent && splitTransportProjection(ownedProjection(runtimeLegacyStdioContent));
    let existing;
    let artifactStatus = WORKSPACE_ARTIFACT_STATES.MATCH;

    try {
        existing = await fileSystem.readFile(filePath, 'utf8')
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;

        await fileSystem.mkdir(path.dirname(filePath), {recursive: true});
        await assertNoSymlinkSegments({rootPath: trustedRoot, targetPath: filePath, fileSystem, label: ownedLabel});
        await fileSystem.writeFile(filePath, desiredContent, {encoding: 'utf8', flag: 'wx', mode: 0o600});
        existing       = desiredContent;
        artifactStatus = WORKSPACE_ARTIFACT_STATES.CREATED
    }

    const actual         = splitTransportProjection(ownedProjection(existing));
    const runtimeUpgrade = JSON.stringify(actual.other) !== JSON.stringify(desired.other)
        && [runtimePrevious, ...placementPrevious].some(previous => previous && !previous.invalid
            && JSON.stringify(actual.other) === JSON.stringify(previous.other));

    if (actual.invalid || desired.invalid || legacy.invalid ||
        (!runtimeUpgrade && JSON.stringify(actual.other) !== JSON.stringify(desired.other))) {
        throw transportDivergence(filePath, ownedLabel, actual.invalid ? 'invalid managed artifact' : 'non-transport managed keys differ')
    }

    const transportChanged = JSON.stringify(actual.transport) !== JSON.stringify(desired.transport);

    if (transportChanged) {
        const receipt    = await readTransportReceipt({receiptPath, adapter, filePath, fileSystem});
        const authorized = receipt
            ? receipt.projectionSha256 === hashProjection(actual.transport)
            : JSON.stringify(actual.transport) === JSON.stringify(legacy.transport)
                || placementPrevious.some(previous => !previous.invalid
                    && JSON.stringify(actual.transport) === JSON.stringify(previous.transport))
                || (runtimePreviousStdio && !runtimePreviousStdio.invalid
                    && JSON.stringify(actual.transport) === JSON.stringify(runtimePreviousStdio.transport));

        if (!authorized) {
            throw transportDivergence(filePath, ownedLabel, 'current MC/KB projection is neither markerless legacy stdio nor receipt-authenticated')
        }
    }

    if (transportChanged || runtimeUpgrade) {
        const names      = runtimeUpgrade ? MCP_SERVERS.map(({key}) => `${NEO_MCP_NAME_PREFIX}${key}`) : TRANSPORT_SERVER_NAMES;
        const merged     = mergeTransport(existing, desiredContent, names);
        const mergedPlan = splitTransportProjection(ownedProjection(merged));

        if (mergedPlan.invalid ||
            JSON.stringify(mergedPlan.transport) !== JSON.stringify(desired.transport) ||
            JSON.stringify(mergedPlan.other) !== JSON.stringify(desired.other)) {
            throw transportDivergence(filePath, ownedLabel, 'transport-only merge could not preserve the managed artifact contract')
        }

        await publishTextAtomically({filePath, content: merged, fileSystem});
        artifactStatus = WORKSPACE_ARTIFACT_STATES.UPDATED
    }

    const artifacts = [{
        path     : filePath,
        status   : artifactStatus,
        ownedKeys: ownedLabel
    }];

    if (remote) {
        artifacts.push(await convergeTransportReceipt({
            receiptPath,
            adapter,
            filePath,
            projectionSha256: hashProjection(desired.transport),
            fileSystem,
            instanceHome
        }))
    } else {
        const removed = await removeTransportReceipt({receiptPath, fileSystem, instanceHome});
        if (removed) artifacts.push(removed)
    }

    return artifacts
}

/** @private */
function splitTransportProjection(projection) {
    if (!projection || projection.__invalidJson) {
        return {invalid: true, transport: {}, other: {}}
    }

    const
        hasMcpBag = Object.hasOwn(projection, 'mcp'),
        bag       = hasMcpBag ? (projection.mcp || {}) : projection,
        transport = {},
        otherBag  = {...bag};

    for (const name of TRANSPORT_SERVER_NAMES) {
        if (Object.hasOwn(bag, name)) transport[name] = bag[name];
        delete otherBag[name]
    }

    const other = hasMcpBag
        ? {...projection, ...(Object.keys(otherBag).length ? {mcp: otherBag} : {})}
        : otherBag;

    if (hasMcpBag && Object.keys(otherBag).length === 0) delete other.mcp;

    return {
        invalid  : false,
        transport: canonicalize(transport),
        other    : canonicalize(other)
    }
}

/** @private */
function hashProjection(projection) {
    return crypto.createHash('sha256').update(JSON.stringify(canonicalize(projection))).digest('hex')
}

/** @private */
async function readTransportReceipt({receiptPath, adapter, filePath, fileSystem}) {
    let raw;

    try {
        raw = await fileSystem.readFile(receiptPath, 'utf8')
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error
    }

    let receipt;

    try {
        receipt = JSON.parse(raw)
    } catch {
        throw transportDivergence(receiptPath, 'transport receipt', 'invalid JSON')
    }

    const expectedKeys = ['adapter', 'artifact', 'projectionSha256', 'version'];

    if (!receipt ||
        typeof receipt !== 'object' ||
        Array.isArray(receipt) ||
        Object.keys(receipt).sort().join(',') !== expectedKeys.sort().join(',') ||
        receipt.version !== 1 ||
        receipt.adapter !== adapter ||
        receipt.artifact !== path.basename(filePath) ||
        !/^[a-f0-9]{64}$/.test(receipt.projectionSha256 || '')) {
        throw transportDivergence(receiptPath, 'transport receipt', 'receipt identity or shape differs')
    }

    return receipt
}

/** @private */
async function convergeTransportReceipt({receiptPath, adapter, filePath, projectionSha256, fileSystem, instanceHome}) {
    await assertNoSymlinkSegments({
        rootPath  : instanceHome,
        targetPath: receiptPath,
        fileSystem,
        label     : 'transport receipt'
    });

    const desired = {
        version : 1,
        adapter,
        artifact: path.basename(filePath),
        projectionSha256
    };
    let existing = null;

    try {
        existing = JSON.parse(await fileSystem.readFile(receiptPath, 'utf8'))
    } catch (error) {
        if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }

    if (JSON.stringify(existing) === JSON.stringify(desired)) {
        return {path: receiptPath, status: WORKSPACE_ARTIFACT_STATES.MATCH, ownedKeys: 'transport receipt'}
    }

    const status = existing
        ? WORKSPACE_ARTIFACT_STATES.UPDATED
        : WORKSPACE_ARTIFACT_STATES.CREATED;

    await fileSystem.mkdir(path.dirname(receiptPath), {recursive: true});
    await publishTextAtomically({
        filePath: receiptPath,
        content : JSON.stringify(desired, null, 2) + '\n',
        fileSystem
    });

    return {path: receiptPath, status, ownedKeys: 'transport receipt'}
}

/** @private */
async function removeTransportReceipt({receiptPath, fileSystem, instanceHome}) {
    await assertNoSymlinkSegments({
        rootPath  : instanceHome,
        targetPath: receiptPath,
        fileSystem,
        label     : 'transport receipt'
    });

    try {
        await fileSystem.unlink(receiptPath);
        return {path: receiptPath, status: WORKSPACE_ARTIFACT_STATES.UPDATED, ownedKeys: 'transport receipt removed'}
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error
    }
}

/** @private */
function hashContent(content) {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * @summary The sha256 a content receipt records for its file, or `null` when no receipt can vouch for
 * it: absent, malformed, or naming another file. `null` grants no authority, so the caller fails closed.
 * @private
 */
async function readContentReceipt({receiptPath, filePath, trustedRoot, fileSystem}) {
    await assertNoSymlinkSegments({rootPath: trustedRoot, targetPath: receiptPath, fileSystem, label: 'content receipt'});

    let receipt;

    try {
        receipt = JSON.parse(await fileSystem.readFile(receiptPath, 'utf8'))
    } catch (error) {
        if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
        throw error
    }

    return receipt?.version === 1 && receipt.artifact === path.basename(filePath) && /^[a-f0-9]{64}$/.test(receipt.sha256 ?? '')
        ? receipt.sha256
        : null
}

/**
 * @summary Records the bytes Fleet last wrote to a file, so the next convergence can tell its own
 * write from a person's edit. Writes only when the record changes.
 * @private
 */
async function writeContentReceipt({receiptPath, filePath, content, trustedRoot, fileSystem}) {
    await assertNoSymlinkSegments({rootPath: trustedRoot, targetPath: receiptPath, fileSystem, label: 'content receipt'});

    const receipt = JSON.stringify({version: 1, artifact: path.basename(filePath), sha256: hashContent(content)}, null, 2) + '\n';

    let existing = null;

    try {
        existing = await fileSystem.readFile(receiptPath, 'utf8')
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error
    }

    if (existing !== receipt) {
        await fileSystem.mkdir(path.dirname(receiptPath), {recursive: true});
        await publishTextAtomically({filePath: receiptPath, content: receipt, fileSystem})
    }
}

/**
 * @summary Removes a content receipt once its file is gone; an absent receipt is already removed.
 * @private
 */
async function removeContentReceipt({receiptPath, trustedRoot, fileSystem}) {
    await assertNoSymlinkSegments({rootPath: trustedRoot, targetPath: receiptPath, fileSystem, label: 'content receipt'});

    try {
        await fileSystem.unlink(receiptPath)
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error
    }
}

/** @private */
async function publishTextAtomically({filePath, content, fileSystem}) {
    // Scratch naming and cleanup-on-failure are the primitive's now; the `unlink(tmpPath)` that used
    // to live in the catch referenced a binding this no longer declares.
    await writeFileAtomic(filePath, content, {fsModule: fileSystem, mode: 0o600});
    await fileSystem.chmod(filePath, 0o600)
}

/** @private */
function mergeCodexTransport(existing, desired, names = TRANSPORT_SERVER_NAMES) {
    let   output       = existing;
    const replacements = names.map(name => {
        const
            current = findTomlMcpTable(existing, name),
            target  = findTomlMcpTable(desired, name);

        if (!current || !target) {
            throw transportDivergence(name, 'Codex MCP table', 'managed table is missing')
        }

        return {start: current.start, end: current.end, value: target.value}
    }).sort((a, b) => b.start - a.start);

    for (const replacement of replacements) {
        output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end)
    }

    return output
}

/**
 * @summary Exclude resident separator whitespace and comment lines from an owned TOML table.
 * @private
 */
function trimTomlTableSuffix(source) {
    return source.replace(/(?:\r?\n[ \t]*(?:#[^\r\n]*)?)*[ \t]*$/, '');
}

/** @private */
function findTomlMcpTable(source, name) {
    let start = null, boundary = source.length, lineStart = 0;

    while (lineStart < source.length) {
        const
            lineEnd = source.indexOf('\n', lineStart),
            line    = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd),
            header  = parseTomlTableHeader(line);

        if (start === null) {
            if (codexMcpServerName(header) === name) start = lineStart
        } else if (header) {
            boundary = lineStart;
            break
        }

        if (lineEnd === -1) break;

        lineStart = lineEnd + 1
    }

    if (start === null) return null;

    const value = trimTomlTableSuffix(source.slice(start, boundary));

    return {start, end: start + value.length, value}
}

/** @private */
function mergeJsonTransport(existing, desired, containerName, names = TRANSPORT_SERVER_NAMES) {
    const desiredObject = parseJsonLike(desired);
    const desiredBag    = desiredObject?.[containerName];

    if (!desiredBag || typeof desiredBag !== 'object') {
        throw transportDivergence(containerName, 'JSON MCP container', 'desired container is missing')
    }

    const
        rootRange             = findJsonObjectRange(existing),
        containerRange        = findDirectJsonProperty(existing, rootRange, containerName),
        desiredRootRange      = findJsonObjectRange(desired),
        desiredContainerRange = findDirectJsonProperty(desired, desiredRootRange, containerName);

    if (!containerRange || existing[containerRange.valueStart] !== '{') {
        throw transportDivergence(containerName, 'JSON MCP container', 'existing container is missing')
    }
    if (!desiredContainerRange || desired[desiredContainerRange.valueStart] !== '{') {
        throw transportDivergence(containerName, 'JSON MCP container', 'desired container source is missing')
    }

    const selectedNames = names === TRANSPORT_SERVER_NAMES ? names : names.filter(name => Object.hasOwn(desiredBag, name));
    const replacements  = selectedNames.map(name => {
        const
            current = findDirectJsonProperty(existing, {
                start: containerRange.valueStart,
                end  : containerRange.valueEnd
            }, name),
            target  = findDirectJsonProperty(desired, {
                start: desiredContainerRange.valueStart,
                end  : desiredContainerRange.valueEnd
            }, name);

        if (!current || !target || !Object.hasOwn(desiredBag, name)) {
            throw transportDivergence(name, 'JSON MCP entry', 'managed entry is missing')
        }

        return {
            start: current.valueStart,
            end  : current.valueEnd,
            value: desired.slice(target.valueStart, target.valueEnd)
        }
    }).sort((a, b) => b.start - a.start);

    let output = existing;

    for (const replacement of replacements) {
        output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end)
    }

    return output
}

/** @private */
function parseJsonLike(source) {
    return JSON.parse(normalizeJsonc(source))
}

/**
 * @summary Normalize legal JSONC comments and trailing commas for semantic comparison without
 * rewriting the resident's source artifact. String content and line structure are preserved.
 * @param {String} source
 * @returns {String}
 * @private
 */
function normalizeJsonc(source) {
    const
        withoutComments = [],
        length          = source.length;
    let
        cursor   = 0,
        inString = false,
        escaped  = false;

    while (cursor < length) {
        const character = source[cursor];

        if (inString) {
            withoutComments.push(character);

            if (escaped) {
                escaped = false
            } else if (character === '\\') {
                escaped = true
            } else if (character === '"') {
                inString = false
            }

            cursor++;
            continue
        }

        if (character === '"') {
            inString = true;
            withoutComments.push(character);
            cursor++;
            continue
        }

        if (source.startsWith('//', cursor)) {
            while (cursor < length && source[cursor] !== '\n') {
                withoutComments.push(' ');
                cursor++
            }
            continue
        }

        if (source.startsWith('/*', cursor)) {
            const end = source.indexOf('*/', cursor + 2);

            if (end < 0) throw new SyntaxError('Unterminated JSONC block comment.');

            while (cursor < end + 2) {
                withoutComments.push(source[cursor] === '\n' ? '\n' : ' ');
                cursor++
            }
            continue
        }

        withoutComments.push(character);
        cursor++
    }

    const
        normalized = withoutComments.join(''),
        output     = normalized.split('');

    inString = false;
    escaped  = false;

    for (cursor = 0; cursor < normalized.length; cursor++) {
        const character = normalized[cursor];

        if (inString) {
            if (escaped) {
                escaped = false
            } else if (character === '\\') {
                escaped = true
            } else if (character === '"') {
                inString = false
            }
            continue
        }

        if (character === '"') {
            inString = true;
            continue
        }

        if (character === ',') {
            let lookahead = cursor + 1;

            while (/\s/.test(normalized[lookahead])) lookahead++;
            if (normalized[lookahead] === '}' || normalized[lookahead] === ']') output[cursor] = ' '
        }
    }

    return output.join('')
}

/** @private */
function findJsonObjectRange(source) {
    const start = skipJsonTrivia(source, 0);

    if (source[start] !== '{') return null;

    return {start, end: scanJsonValueEnd(source, start)}
}

/** @private */
function findDirectJsonProperty(source, objectRange, propertyName) {
    const property = directJsonProperties(source, objectRange).find(entry => entry.key === propertyName);

    return property ? {valueStart: property.valueStart, valueEnd: property.valueEnd} : null
}

/**
 * @summary The direct properties of one object in a JSON(C) source, in order, up to the first one that
 * does not parse: `{key, keyStart, valueStart, valueEnd}` each.
 * @private
 */
function directJsonProperties(source, objectRange) {
    const properties = [];

    if (!objectRange || source[objectRange.start] !== '{') return properties;

    let cursor = objectRange.start + 1;

    while (cursor < objectRange.end) {
        cursor = skipJsonTrivia(source, cursor);
        if (source[cursor] === ',') {
            cursor++;
            continue
        }
        if (source[cursor] !== '"') break;

        const keyStart = cursor;
        const keyEnd   = scanJsonStringEnd(source, cursor);
        const key      = JSON.parse(source.slice(keyStart, keyEnd));

        cursor = skipJsonTrivia(source, keyEnd);
        if (source[cursor] !== ':') break;

        const valueStart = skipJsonTrivia(source, cursor + 1);
        const valueEnd   = scanJsonValueEnd(source, valueStart);

        properties.push({key, keyStart, valueStart, valueEnd});
        cursor = valueEnd
    }

    return properties
}

/**
 * @summary The source ranges, key through value, of the direct properties a predicate selects in the object
 * at `objectPath` (an empty path is the root object).
 * @param {String}   source
 * @param {String[]} objectPath
 * @param {Function} selects `(key) => Boolean`.
 * @returns {Number[][]} `[start, end]` per selected property.
 * @private
 */
function jsonPropertyRanges(source, objectPath, selects) {
    let range = findJsonObjectRange(source);

    for (const name of objectPath) {
        const property = findDirectJsonProperty(source, range, name);

        if (!property || source[property.valueStart] !== '{') return [];

        range = {start: property.valueStart, end: property.valueEnd}
    }

    return directJsonProperties(source, range).filter(entry => selects(entry.key)).map(entry => [entry.keyStart, entry.valueEnd])
}

/** @private */
function skipJsonTrivia(source, start) {
    let cursor = start;

    while (cursor < source.length) {
        if (/\s/.test(source[cursor])) {
            cursor++;
        } else if (source.startsWith('//', cursor)) {
            cursor = source.indexOf('\n', cursor + 2);
            if (cursor < 0) return source.length;
        } else if (source.startsWith('/*', cursor)) {
            const end = source.indexOf('*/', cursor + 2);
            if (end < 0) return source.length;
            cursor = end + 2
        } else {
            break
        }
    }

    return cursor
}

/** @private */
function scanJsonStringEnd(source, start) {
    let escaped = false;

    for (let cursor = start + 1; cursor < source.length; cursor++) {
        const character = source[cursor];

        if (escaped) {
            escaped = false
        } else if (character === '\\') {
            escaped = true
        } else if (character === '"') {
            return cursor + 1
        }
    }

    return source.length
}

/** @private */
function scanJsonValueEnd(source, start) {
    if (source[start] === '"') return scanJsonStringEnd(source, start);

    if (source[start] === '{' || source[start] === '[') {
        const stack = [source[start] === '{' ? '}' : ']'];

        for (let cursor = start + 1; cursor < source.length; cursor++) {
            if (source[cursor] === '"') {
                cursor = scanJsonStringEnd(source, cursor) - 1;
                continue
            }
            if (source.startsWith('//', cursor)) {
                const end = source.indexOf('\n', cursor + 2);
                if (end < 0) return source.length;
                cursor = end;
                continue
            }
            if (source.startsWith('/*', cursor)) {
                const end = source.indexOf('*/', cursor + 2);
                if (end < 0) return source.length;
                cursor = end + 1;
                continue
            }
            if (source[cursor] === '{') {
                stack.push('}')
            } else if (source[cursor] === '[') {
                stack.push(']')
            } else if (source[cursor] === stack.at(-1)) {
                stack.pop();
                if (!stack.length) return cursor + 1
            }
        }

        return source.length
    }

    let cursor = start;
    while (cursor < source.length &&
        source[cursor] !== ',' &&
        source[cursor] !== '}' &&
        source[cursor] !== ']' &&
        !source.startsWith('//', cursor) &&
        !source.startsWith('/*', cursor)) cursor++;
    return cursor
}

/** @private */
function transportDivergence(filePath, ownedKeys, reason) {
    return new ManagedWorkspacePreparationError(
        `prepareManagedAgentWorkspace: refusing unauthenticated MCP transport transition at '${filePath}' (${reason}).`,
        {
            code    : 'FLEET_WORKSPACE_DIVERGENT',
            artifact: {path: filePath, status: WORKSPACE_ARTIFACT_STATES.DIVERGENT, ownedKeys, reason}
        }
    )
}

/**
 * @summary Converges one Fleet-owned text file: create it when absent, match it when its owned
 * projection agrees, refuse the start otherwise. With a `receiptPath`, a file that still hashes to
 * Fleet's last write is Fleet's to replace, so generated content can follow its source; a person's
 * edit, or a missing or malformed receipt, still refuses. Matching bytes do not establish authorship:
 * only an actual Fleet create/update records a write.
 * @private
 */
async function convergeTextArtifact({filePath, desiredContent, ownedProjection, ownedLabel, trustedRoot, fileSystem, receiptPath = null}) {
    await assertNoSymlinkSegments({rootPath: trustedRoot, targetPath: filePath, fileSystem, label: ownedLabel});

    const recordWrite = content => receiptPath && writeContentReceipt({receiptPath, filePath, content, trustedRoot, fileSystem});

    let existing;
    try {
        existing = await fileSystem.readFile(filePath, 'utf8');
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;

        await fileSystem.mkdir(path.dirname(filePath), {recursive: true});
        await assertNoSymlinkSegments({rootPath: trustedRoot, targetPath: filePath, fileSystem, label: ownedLabel});
        try {
            await fileSystem.writeFile(filePath, desiredContent, {encoding: 'utf8', flag: 'wx', mode: 0o600});
            await recordWrite(desiredContent);
            return {path: filePath, status: WORKSPACE_ARTIFACT_STATES.CREATED, ownedKeys: ownedLabel};
        } catch (writeError) {
            if (writeError?.code !== 'EEXIST') throw writeError;
            existing = await fileSystem.readFile(filePath, 'utf8');
        }
    }

    const
        actual  = ownedProjection(existing),
        desired = ownedProjection(desiredContent);

    if (JSON.stringify(actual) === JSON.stringify(desired)) {
        return {path: filePath, status: WORKSPACE_ARTIFACT_STATES.MATCH, ownedKeys: ownedLabel};
    }

    if (receiptPath && await readContentReceipt({receiptPath, filePath, trustedRoot, fileSystem}) === hashContent(existing)) {
        await publishTextAtomically({filePath, content: desiredContent, fileSystem});
        await recordWrite(desiredContent);
        return {path: filePath, status: WORKSPACE_ARTIFACT_STATES.UPDATED, ownedKeys: ownedLabel};
    }

    const artifact = {
        path     : filePath,
        status   : WORKSPACE_ARTIFACT_STATES.DIVERGENT,
        ownedKeys: ownedLabel,
        reason   : actual.__invalidJson ? 'invalid JSON' : 'Fleet-owned keys differ or are missing'
    };
    throw new ManagedWorkspacePreparationError(
        `prepareManagedAgentWorkspace: refusing to overwrite divergent Fleet-owned content at '${filePath}' (${ownedLabel}).`,
        {code: 'FLEET_WORKSPACE_DIVERGENT', artifact}
    );
}

/**
 * @summary Converges one directory: create it when absent (with `mode` when given), match it when it
 * is a real directory, refuse a symlink or any other entry. An existing directory keeps its mode.
 * @private
 */
async function ensureDirectoryArtifact(directoryPath, trustedRoot, fileSystem, {mode} = {}) {
    let stat;
    try {
        stat = await fileSystem.lstat(directoryPath);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }

    if (stat) {
        if (stat.isSymbolicLink()) {
            throw divergentArtifact(directoryPath, 'directory', 'symlinked resident-owned directory');
        }
        if (!stat.isDirectory()) {
            const artifact = {path: directoryPath, status: WORKSPACE_ARTIFACT_STATES.DIVERGENT, ownedKeys: 'directory'};
            throw new ManagedWorkspacePreparationError(
                `prepareManagedAgentWorkspace: expected directory '${directoryPath}', found another filesystem entry.`,
                {code: 'FLEET_WORKSPACE_DIVERGENT', artifact}
            );
        }
        return {path: directoryPath, status: WORKSPACE_ARTIFACT_STATES.MATCH, ownedKeys: 'directory'};
    }

    await fileSystem.mkdir(directoryPath, {recursive: true, ...(mode ? {mode} : {})});
    await assertNoSymlinkSegments({rootPath: trustedRoot, targetPath: directoryPath, fileSystem, label: 'directory'});
    return {path: directoryPath, status: WORKSPACE_ARTIFACT_STATES.CREATED, ownedKeys: 'directory'};
}

/** @private */
function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;

    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

/** @private */
function divergentArtifact(filePath, ownedKeys, reason) {
    return new ManagedWorkspacePreparationError(
        `prepareManagedAgentWorkspace: refusing divergent resident-owned path '${filePath}' (${reason}).`,
        {
            code    : 'FLEET_WORKSPACE_DIVERGENT',
            artifact: {path: filePath, status: WORKSPACE_ARTIFACT_STATES.DIVERGENT, ownedKeys, reason}
        }
    );
}

/** @private */
function unsupported(reason) {
    return new ManagedWorkspacePreparationError(
        `prepareManagedAgentWorkspace: unsupported adapter state — ${reason}.`,
        {code: 'FLEET_WORKSPACE_UNSUPPORTED'}
    );
}

/** @private */
function assertNonEmptyString(value, name) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new ManagedWorkspacePreparationError(`prepareManagedAgentWorkspace: '${name}' must be a non-empty string.`);
    }
}

/** @private */
function assertAbsolutePath(value, name) {
    assertNonEmptyString(value, name);
    if (!path.isAbsolute(value)) {
        throw new ManagedWorkspacePreparationError(`prepareManagedAgentWorkspace: '${name}' must be absolute, received '${value}'.`);
    }
}

export default prepareManagedAgentWorkspace;

import {constants as fsConstants}                  from 'node:fs';
import fs                                          from 'node:fs/promises';
import {writeFileAtomic}                           from '../shared/atomicFileWrite.mjs';
import path                                        from 'node:path';
import crypto                                      from 'node:crypto';
import {isDeepStrictEqual}                         from 'node:util';
import {parse as parseToml}                        from 'smol-toml';
import {hydrateCurrentWorktree}                    from '../../scripts/migrations/bootstrapWorktree.mjs';
import {MCP_SERVERS, resolveMcpMatrix}             from '../../../src/fleet/contract/mcpServers.mjs';
import {deriveNodeRuntimeEnv}                      from './deriveNodeRuntimeEnv.mjs';
import {KIMI_SEAT_SERVERS, generateKimiSeatConfig} from './generateKimiSeatConfig.mjs';
import {
    deriveAgentInstanceHome,
    deriveAgentMemoryDir
} from './deriveAgentInstanceHome.mjs';
import {
    MANAGED_WORKSPACE_MCP_SERVER_DESCRIPTORS as MCP_SERVER_DESCRIPTORS,
    createManagedAgentWorkspacePlan
} from './managedAgentWorkspacePlan.mjs';
import {OPENCODE_SEAT_SERVERS, WAKE_ENVELOPE_PLANT_FILE_NAME, generateOpenCodeSeatConfig, isUnmodifiedGeneration} from './generateOpenCodeSeatConfig.mjs';
import {SEAT_INSTRUCTION_STATES, projectSeatInstructions}                                                         from './projectSeatInstructions.mjs';

export {createManagedAgentWorkspacePlan} from './managedAgentWorkspacePlan.mjs';

const
    NEO_MCP_NAME_PREFIX      = 'neo-mjs-',
    CODEX_REMOTE_TRUST_BEGIN = '# Fleet-managed remote MCP project trust begin',
    CODEX_REMOTE_TRUST_END   = '# Fleet-managed remote MCP project trust end',
    CODEX_PROJECT_HEADER     = '# Fleet-managed Neo MCP tables: executable paths come from the installed canonical checkout; cwd/project paths stay bound to this prepared resident checkout; `enabled = false` marks a server the Fleet switches off, the others follow the seat\'s own switch.',
    // The header an earlier Fleet wrote, while the tables still carried `enabled`.
    CODEX_PROJECT_HEADER_V1  = '# Fleet-managed Neo MCP tables: executable paths come from the installed canonical checkout; cwd/project paths stay bound to this prepared resident checkout; enabled values are the current Brain projection.',
    CLAUDE_HARNESS_TYPES     = new Set(['claude-code', 'claude-desktop']),
    CLAUDE_MEMORY_SETTING    = 'autoMemoryDirectory';

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
 * @returns {Object[]}
 * @private
 */
function bindManagedAgentWorkspacePlan({logicalPlan, agentosRuntimeRoot, nodePath, runtime}) {
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
        runtimeEnv        : [...server.runtimeEnv],
        requiredRuntimeEnv: [...server.requiredRuntimeEnv],
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
 * @param {String} options.agentosRuntimeRoot Installed AgentOS runtime root.
 * @param {String} [options.nodePath] Node executable used for installed MCP entrypoints.
 * @param {Object} [options.runtime=process] Host runtime facts for child execution mode.
 * @param {Object} [options.remoteMcpCapability] Existing non-secret installed-adapter proof.
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

/** @private */
async function applyManagedAgentWorkspacePlanUnchecked({
    plan: inputPlan,
    targetRepoRoot,
    repoSlug = null,
    instanceRoot,
    agentosRuntimeRoot,
    nodePath = process.execPath,
    runtime = process,
    remoteMcpCapability = null,
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
            runtime
        });

    assertAbsolutePath(instanceHome, 'instanceHome');
    await assertRemoteBridgeCapability({
        agent,
        plan,
        capability        : remoteMcpCapability,
        agentosRuntimeRoot: canonicalAgentosRuntimeRoot,
        nodePath,
        fileSystem
    });
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

    const artifacts = await prepareHarnessArtifacts({
        agent,
        targetRepoRoot    : canonicalTargetRepoRoot,
        instanceHome,
        agentosRuntimeRoot: canonicalAgentosRuntimeRoot,
        plan,
        remoteMcpCapability,
        fileSystem
    });

    artifacts.push(...await convergeSeatMemory({
        agent,
        targetRepoRoot: canonicalTargetRepoRoot,
        instanceRoot  : canonicalInstanceRoot,
        fileSystem
    }));

    const seatInstructions = await convergeSeatInstructions({
        harnessType   : agent.harnessType,
        targetRepoRoot: canonicalTargetRepoRoot,
        instanceHome,
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
 * uses an explicit strict MCP JSON with environment-variable references; Claude Desktop uses its
 * exact `CLAUDE_USER_DATA_DIR` profile file but refuses any enabled server whose startup requires a
 * dynamic secret that cannot be represented without writing the secret. Optional secrets remain
 * child-environment capabilities, not persisted config. Antigravity refuses until a contained
 * per-resident MCP authority is proven.
 *
 * @param {Object}   options
 * @param {Object}   options.agent               Fleet registry agent definition.
 * @param {String}   options.targetRepoRoot      Absolute provisioned target checkout path.
 * @param {String}   options.instanceRoot        Absolute Fleet harness-home root.
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
    agentosRuntimeRoot,
    nodePath = process.execPath,
    runtime = process,
    hydrateWorkspace = hydrateCurrentWorktree,
    deriveInstanceHome = deriveAgentInstanceHome,
    resolveMatrix = resolveMcpMatrix,
    mcpTarget = null,
    remoteMcpCapability = null,
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
            agent    : {id: agent.id, harnessType: agent.harnessType},
            mcpMatrix: resolveMatrix(agent.mcpServers),
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
        agentosRuntimeRoot,
        nodePath,
        runtime,
        remoteMcpCapability,
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

/**
 * @summary Revalidate Claude Desktop's exact installed Neo bridge before hydration. The lifecycle
 * performs the same gate before checkout provisioning; this local check prevents direct composer
 * callers from manufacturing a structurally plausible proof over missing or drifted bytes.
 * @param {Object} options
 * @param {Object} options.agent
 * @param {Object[]} options.plan
 * @param {Object|null} options.capability
 * @param {String} options.agentosRuntimeRoot
 * @param {String} options.nodePath
 * @param {Object} options.fileSystem
 * @returns {Promise<void>}
 * @private
 */
async function assertRemoteBridgeCapability({agent, plan, capability, agentosRuntimeRoot, nodePath, fileSystem}) {
    if (agent.harnessType !== 'claude-desktop' ||
        !plan.some(server => server.enabled && server.target === 'tenant')) {
        return
    }

    const
        bridge             = capability?.bridge,
        expectedEntrypoint = path.join(agentosRuntimeRoot, 'ai/mcp/client/stdioToStreamableHttp.mjs');

    if (capability?.harnessType !== 'claude-desktop' ||
        !bridge ||
        bridge.kind !== 'neo-stdio-streamable-http' ||
        bridge.command !== nodePath ||
        bridge.entrypoint !== expectedEntrypoint) {
        throw unsupported('Claude Desktop remote MCP requires the exact installed Neo bridge capability proof')
    }

    const
        nodeStat   = await fileSystem.stat(nodePath).catch(() => null),
        bridgeStat = await fileSystem.lstat(expectedEntrypoint).catch(() => null);

    if (!nodeStat?.isFile() || !bridgeStat?.isFile()) {
        throw unsupported('Claude Desktop bridge Node command or installed entrypoint is absent')
    }

    try {
        await fileSystem.access(nodePath, fsConstants.X_OK);
        await fileSystem.access(expectedEntrypoint, fsConstants.R_OK)
    } catch {
        throw unsupported('Claude Desktop bridge Node command or installed entrypoint is inaccessible')
    }
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

/** @private */
async function prepareHarnessArtifacts({
    agent,
    targetRepoRoot,
    instanceHome,
    agentosRuntimeRoot,
    plan,
    remoteMcpCapability,
    fileSystem
}) {
    switch (agent.harnessType) {
        case 'codex':
        case 'codex-desktop':
            return prepareCodexArtifacts({agent, targetRepoRoot, instanceHome, agentosRuntimeRoot, plan, fileSystem});
        case 'kimi-code':
            return prepareKimiArtifacts({targetRepoRoot, instanceHome, agentosRuntimeRoot, plan, fileSystem});
        case 'opencode':
            return prepareOpenCodeArtifacts({targetRepoRoot, instanceHome, agentosRuntimeRoot, plan, fileSystem});
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
            return prepareClaudeJsonArtifact({
                agent,
                filePath      : path.join(instanceHome, 'claude_desktop_config.json'),
                trustedRoot   : instanceHome,
                plan,
                remoteMcpCapability,
                fileSystem,
                interpolateEnv: false
            });
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
async function convergeSeatInstructions({harnessType, targetRepoRoot, instanceHome, repoSlug, fileSystem, log}) {
    const
        ownedLabel  = 'seat instructions',
        receiptPath = path.join(instanceHome, '.neo-fleet-seat-instructions.json'),
        projection  = await projectSeatInstructions({
            harnessType,
            homeRoot: harnessHomeRoot(harnessType, instanceHome),
            repoSlug,
            targetRepoRoot,
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
 * @summary Pins a Claude seat's auto memory to its seat folder. Claude Code keys auto memory by the
 * checkout unless `autoMemoryDirectory` names a directory, so the checkout's local settings name
 * `<agentsRoot>/<agentId>/memory`: the seat keeps one memory whichever checkout it opens and wherever a
 * checkout moves. The directory is created owner-only, because it holds the seat's notes. The setting is
 * Claude Code's, so the other families get nothing here.
 * @param {Object} options
 * @param {Object} options.agent          Fleet registry agent definition.
 * @param {String} options.targetRepoRoot Absolute provisioned target checkout path.
 * @param {String} options.instanceRoot   Absolute Fleet agents root.
 * @param {Object} options.fileSystem     Promise filesystem seam.
 * @returns {Promise<Object[]>} The directory and settings artifacts, or none for another family.
 * @private
 */
async function convergeSeatMemory({agent, targetRepoRoot, instanceRoot, fileSystem}) {
    if (!CLAUDE_HARNESS_TYPES.has(agent.harnessType)) return [];

    const memoryDir = deriveAgentMemoryDir({instanceRoot, agentId: agent.id});

    return [
        await ensureDirectoryArtifact(memoryDir, instanceRoot, fileSystem, {mode: 0o700}),
        await convergeJsonSetting({
            filePath   : path.join(targetRepoRoot, '.claude', 'settings.local.json'),
            key        : CLAUDE_MEMORY_SETTING,
            value      : memoryDir,
            trustedRoot: targetRepoRoot,
            fileSystem
        })
    ]
}

/**
 * @summary Converges one Fleet-owned top-level key in a JSON settings file the seat and its person also
 * write. The key goes into the file's own text, so every other byte stays as it was. A value already
 * there that differs is refused, never replaced: it is someone else's decision about the same thing.
 * @param {Object} options
 * @param {String} options.filePath    The settings file.
 * @param {String} options.key         The Fleet-owned top-level key.
 * @param {*}      options.value       Its JSON-serializable value.
 * @param {String} options.trustedRoot The root no path segment may leave by a symlink.
 * @param {Object} options.fileSystem  Promise filesystem seam.
 * @returns {Promise<Object>} The artifact, `CREATED`, `MATCH` or `UPDATED`.
 * @throws {ManagedWorkspacePreparationError} For a file that is not a JSON object, or a different value.
 * @private
 */
async function convergeJsonSetting({filePath, key, value, trustedRoot, fileSystem}) {
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

        throw divergentArtifact(filePath, key, `it already names another ${key}`)
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
async function prepareCodexArtifacts({agent, targetRepoRoot, instanceHome, plan, fileSystem}) {
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
        filePath   : homePath,
        repoPath   : targetRepoRoot,
        remote,
        trustedRoot: instanceHome,
        fileSystem
    }) && homeArtifact.status === WORKSPACE_ARTIFACT_STATES.MATCH) {
        homeArtifact.status = WORKSPACE_ARTIFACT_STATES.UPDATED
    }

    artifacts.push(homeArtifact);
    artifacts.push(await ensureDirectoryArtifact(memoriesPath, instanceHome, fileSystem));

    return artifacts;
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
        renderPrevious  = previous => renderClaudeJsonContent({agent, plan: previous, remoteMcpCapability, interpolateEnv}),
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
 * @summary Render Claude-family MCP JSON. Claude Desktop receives Neo's local command bridge for
 * remote rows; direct-HTTP-capable Claude Code receives native HTTP entries.
 * @private
 */
function renderClaudeJsonContent({agent, plan, remoteMcpCapability, interpolateEnv}) {
    const servers = {};

    for (const server of plan) {
        if (!server.enabled) continue;

        if (server.transport === 'streamable-http') {
            if (agent.harnessType === 'claude-desktop') {
                servers[server.name] = {
                    command: remoteMcpCapability.bridge.command,
                    ...(server.environment ? {env: {...server.environment}} : {}),
                    args   : [
                        remoteMcpCapability.bridge.entrypoint,
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
                ? new Set([...server.requiredRuntimeEnv, ...server.secretEnv])
                : server.requiredRuntimeEnv;

        for (const name of envNames) {
            if (interpolateEnv) {
                env[name] = `\${${name}}`;
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
 * Birth a Kimi Code seat's full artifact set from `generateKimiSeatConfig` — the generator owns
 * content, this composer owns convergence policy. The curated MCP matrix narrows the canonical
 * server set (a disabled catalog server is never wired); the memory-layer files are CREATE-ONLY
 * (story-sovereignty: after first boot they are bearer-authored, and re-provisioning must never
 * clobber or even flag them); the config/hook surfaces converge on their Fleet-owned projections.
 * @private
 */
async function prepareKimiArtifacts({targetRepoRoot, instanceHome, agentosRuntimeRoot, plan, fileSystem}) {
    const
        enabledKeys = new Set(plan.filter(server => server.enabled).map(server => server.key)),
        servers     = KIMI_SEAT_SERVERS.filter(server => enabledKeys.has(server.name.slice(NEO_MCP_NAME_PREFIX.length)));

    if (servers.length === 0) {
        throw unsupported("harness 'kimi-code' has no enabled MCP servers to wire");
    }

    const
        remoteServers = createRemoteServerMap(plan),
        options       = {
            agentosRuntimeRoot,
            targetRepoRoot,
            seatEnvFile: path.join(targetRepoRoot, '.env'),
            kimiHome   : instanceHome,
            memoryDir  : path.join(instanceHome, 'memory'),
            nodeBinary : plan[0].command,
            servers
        },
        environment = plan[0].environment,
        {files} = generateKimiSeatConfig({...options, environment, remoteServers}),
        {files: legacyFiles} = generateKimiSeatConfig({...options, environment}),
        runtimeLegacyFiles = environment && generateKimiSeatConfig({...options, remoteServers}).files,
        runtimeLegacyStdioFiles = environment && generateKimiSeatConfig(options).files;

    return convergeSeatConfigFiles({files, legacyFiles, runtimeLegacyFiles, runtimeLegacyStdioFiles, repoPath: targetRepoRoot, instanceHome, fileSystem, policies: [
        {match: /config\.toml$/,                   ownedProjection: kimiConfigTomlOwnedProjection, ownedLabel: 'default_permission_mode,default_model,[[permission.rules]],[[hooks]]'},
        {
            match          : /\.kimi-code\/mcp\.json$/,
            ownedProjection: claudeJsonOwnedProjection,
            ownedLabel     : 'mcpServers."neo-mjs-*"',
            transport      : {adapter: 'kimi-code', containerName: 'mcpServers'}
        },
        {match: /hooks\/identityAnchorHook\.mjs$/, ownedProjection: wholeFileOwnedProjection,      ownedLabel: 'generated identity-anchor hook'}
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
async function prepareOpenCodeArtifacts({targetRepoRoot, instanceHome, agentosRuntimeRoot, plan, fileSystem}) {
    const
        enabledKeys = new Set(plan.filter(server => server.enabled).map(server => server.key)),
        servers     = OPENCODE_SEAT_SERVERS.filter(server => enabledKeys.has(server.name.slice(NEO_MCP_NAME_PREFIX.length)));

    if (servers.length === 0) {
        throw unsupported("harness 'opencode' has no enabled MCP servers to wire");
    }

    const
        remoteServers = createRemoteServerMap(plan),
        options       = {
            agentosRuntimeRoot,
            targetRepoRoot,
            seatEnvFile : path.join(targetRepoRoot, '.env'),
            memoryDir   : path.join(instanceHome, 'memory'),
            nodeBinary  : plan[0].command,
            environment : plan[0].environment,
            seatHome    : instanceHome,
            wakeHookPath: path.join(instanceHome, 'write-wake-envelope.mjs'),
            // The seat's OWN OpenCode plugins dir, resolved here rather than inside the boot hook:
            // `deriveHarnessLaunchSpec` points `XDG_CONFIG_HOME` at this same `instanceHome`, so the plant
            // lands where that seat's first OpenCode process looks for it — before the hook ever runs.
            // The hook runs after the server is listening, so a plant IT installed could only be loaded by
            // a later process, and `hookEnv` does not carry `XDG_CONFIG_HOME` at all.
            wakePlantPath: path.join(instanceHome, 'opencode', 'plugins', WAKE_ENVELOPE_PLANT_FILE_NAME),
            servers
        },
        {files}       = generateOpenCodeSeatConfig({...options, remoteServers}),
        {files: legacyFiles} = generateOpenCodeSeatConfig(options),
        runtimeLegacyFiles = plan[0].environment && generateOpenCodeSeatConfig({...options, environment: {}, remoteServers}).files,
        runtimeLegacyStdioFiles = plan[0].environment && generateOpenCodeSeatConfig({...options, environment: {}}).files;

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
            files   : rest, legacyFiles: legacyRest, runtimeLegacyFiles, runtimeLegacyStdioFiles, repoPath: targetRepoRoot, instanceHome, fileSystem,
            policies: [
                {
                    match          : /opencode\.jsonc$/,
                    ownedProjection: opencodeJsoncOwnedProjection,
                    ownedLabel     : 'mcp."neo-mjs-*",instructions',
                    transport      : {adapter: 'opencode', containerName: 'mcp'}
                },
                {match: /write-wake-envelope\.mjs$/, ownedProjection: wholeFileOwnedProjection, ownedLabel: 'generated wake-envelope boot hook'}
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
 * @private
 */
async function convergeSeatConfigFiles({files, legacyFiles, runtimeLegacyFiles, runtimeLegacyStdioFiles, repoPath, instanceHome, fileSystem, policies}) {
    const artifacts = [];

    for (const file of files) {
        const policy = policies.find(entry => entry.match.test(file.path));

        const legacyFile = legacyFiles?.find(entry => entry.path === file.path);
        const common     = {
            filePath       : file.path,
            desiredContent : file.content,
            ownedProjection: policy ? policy.ownedProjection : createOnlyOwnedProjection,
            ownedLabel     : policy ? policy.ownedLabel      : 'create-only bearer memory layer',
            trustedRoot    : file.path.startsWith(repoPath + path.sep) ? repoPath : instanceHome,
            fileSystem
        };

        if (policy?.transport) {
            artifacts.push(...await convergeTransportArtifact({
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
            }))
        } else {
            artifacts.push(await convergeTextArtifact(common))
        }
    }

    return artifacts;
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
 * @summary Parse a TOML table header without mistaking brackets or `#` inside quoted keys for the
 * structural close/comment boundary. Both `[table]` and `[[array.table]]` forms are recognized,
 * including legal trailing comments.
 * @param {String} line One physical TOML line.
 * @returns {{array: Boolean, body: String}|null}
 * @private
 */
function parseTomlTableHeader(line) {
    const
        source    = String(line).trimStart(),
        array     = source.startsWith('[['),
        openWidth = array ? 2 : 1;

    if ((!array && !source.startsWith('[')) || source.length <= openWidth) return null;

    let quote = null, escaped = false;

    for (let index = openWidth; index < source.length; index++) {
        const char = source[index];

        if (quote) {
            if (quote === '"' && escaped) {
                escaped = false
            } else if (quote === '"' && char === '\\') {
                escaped = true
            } else if (char === quote) {
                quote = null
            }

            continue
        }

        if (char === '"' || char === "'") {
            quote = char;
            continue
        }

        if (char === '#') return null;

        const closes = array
            ? char === ']' && source[index + 1] === ']'
            : char === ']';

        if (!closes) continue;

        const
            body   = source.slice(openWidth, index).trim(),
            suffix = source.slice(index + (array ? 2 : 1)).trim();

        if (!body || (suffix && !suffix.startsWith('#'))) return null;

        return {array, body}
    }

    return null
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
 * exactly Fleet's marked block on opt-out. Re-entry reads semantic trust, preserving native settings
 * inserted inside Fleet's comments; mixed blocks cannot be removed on opt-out. A non-trusted row
 * rejects remote admission. This keeps the no-intent home artifact byte-identical
 * to the stdio baseline while making the generated project MCP config consumable at runtime.
 * @param {Object} options
 * @returns {Promise<Boolean>} whether Fleet changed the home artifact.
 * @private
 */
async function convergeCodexRemoteTrust({filePath, repoPath, remote, trustedRoot, fileSystem}) {
    await assertNoSymlinkSegments({
        rootPath  : trustedRoot,
        targetPath: filePath,
        fileSystem,
        label     : 'Codex remote MCP project trust'
    });

    const
        source        = await fileSystem.readFile(filePath, 'utf8'),
        expectedBlock = renderCodexRemoteTrustBlock(repoPath),
        begin         = source.indexOf(CODEX_REMOTE_TRUST_BEGIN),
        endMarker     = source.indexOf(CODEX_REMOTE_TRUST_END),
        secondBegin   = begin < 0 ? -1 : source.indexOf(CODEX_REMOTE_TRUST_BEGIN, begin + 1),
        secondEnd     = endMarker < 0 ? -1 : source.indexOf(CODEX_REMOTE_TRUST_END, endMarker + 1);

    if ((begin < 0) !== (endMarker < 0) || secondBegin >= 0 || secondEnd >= 0 || endMarker < begin) {
        throw transportDivergence(filePath, 'projects.<managed-repo>.trust_level', 'malformed Fleet trust marker')
    }

    const existingTrust = remote ? readCodexProjectTrust(source, repoPath, filePath) : undefined;

    if (begin >= 0) {
        const
            end   = endMarker + CODEX_REMOTE_TRUST_END.length,
            block = source.slice(begin, end);

        if (remote) {
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
        && runtimePrevious && !runtimePrevious.invalid
        && JSON.stringify(actual.other) === JSON.stringify(runtimePrevious.other);

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
    if (!objectRange || source[objectRange.start] !== '{') return null;

    let cursor = objectRange.start + 1;

    while (cursor < objectRange.end) {
        cursor = skipJsonTrivia(source, cursor);
        if (source[cursor] === ',') {
            cursor++;
            continue
        }
        if (source[cursor] === '}') return null;
        if (source[cursor] !== '"') return null;

        const keyEnd = scanJsonStringEnd(source, cursor);
        const key    = JSON.parse(source.slice(cursor, keyEnd));

        cursor = skipJsonTrivia(source, keyEnd);
        if (source[cursor] !== ':') return null;

        const valueStart = skipJsonTrivia(source, cursor + 1);
        const valueEnd   = scanJsonValueEnd(source, valueStart);

        if (key === propertyName) {
            return {valueStart, valueEnd}
        }

        cursor = valueEnd
    }

    return null
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
 * edit, or a missing or malformed receipt, still refuses.
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
        await recordWrite(desiredContent);
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

import {setup} from '../../../../setup.mjs';

setup({
    neoConfig: {unitTestMode: true},
    appConfig: {name: 'ProbeMutationDispositionGuardTest', isMounted: () => true, vnodeInitialising: false}
});

import {test, expect} from '@playwright/test';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import process        from 'node:process';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

const
    repoRoot = path.resolve(process.cwd()),
    aiRoot   = path.join(repoRoot, 'ai'),

    DEADLINE_ABORT_PATTERNS = Object.freeze({
        abortController   : /\bnew\s+AbortController\s*\(/,
        abortSignalTimeout: /\bAbortSignal\.timeout\s*\(/
    }),

    /**
     * Complete production census of every module under `ai/` that constructs `new AbortController()`
     * or arms `AbortSignal.timeout()`.
     *
     * Keying on one spelling misses the other. Every module in this 25-module population is
     * accounted for here and partitioned into:
     * - `probeSurface: true` (12 modules): modules carrying probe / canary / liveness / readiness
     *   entry points that must declare `@probeDisposition` in `PROBE_POPULATION_CENSUS`.
     * - `probeSurface: false` (13 modules): workload request transports, OAuth/PAT verification,
     *   daemon lifecycle shutdown signals, or outbound delivery clients that are not probes.
     */
    ABORT_DEADLINE_MODULE_CENSUS = Object.freeze({
        'daemons/orchestrator/Orchestrator.mjs': {
            probeSurface     : true,
            deadlineSpellings: ['new AbortController()'],
            role             : 'Orchestrator freeze re-probe embedding canary (`probeFrozenCollectionHealth`).'
        },
        'daemons/orchestrator/services/TenantRepoSyncService.mjs': {
            probeSurface     : false,
            deadlineSpellings: ['new AbortController()'],
            role             : 'Tenant repo sync batch-embedding circuit cancellation (`providerTimeoutCircuit`).'
        },
        'daemons/orchestrator/taskDefinitions.mjs': {
            probeSurface     : true,
            deadlineSpellings: ['new AbortController()'],
            role             : 'Chroma HTTP heartbeat health probe (`probeChromaHttpHealth`) + TCP port observation (`probeTcpPort`).'
        },
        'daemons/wake/daemon.mjs': {
            probeSurface     : false,
            deadlineSpellings: ['new AbortController()', 'AbortSignal.timeout()'],
            role             : 'Wake digest delivery and webhook push execution bounds.'
        },
        'daemons/wake/localWakeAdapters.mjs': {
            probeSurface     : true,
            deadlineSpellings: ['new AbortController()', 'AbortSignal.timeout()'],
            role             : 'OpenCode loopback session telemetry probe (`probeOpenCodeSession`) alongside wake delivery adapters.'
        },
        'mcp/server/memory-core/helpers/recordTurnPresenceOverMcp.mjs': {
            probeSurface     : false,
            deadlineSpellings: ['new AbortController()'],
            role             : 'Hook-to-MCP turn-presence beacon write transport.'
        },
        'mcp/server/shared/services/AuthService.mjs': {
            probeSurface     : false,
            deadlineSpellings: ['AbortSignal.timeout()'],
            role             : 'GitHub PAT / OIDC token verification on authentication cache miss.'
        },
        'provider/Ollama.mjs': {
            probeSurface     : false,
            deadlineSpellings: ['new AbortController()'],
            role             : 'Native Ollama `stream()` idle/upstream request cancellation.'
        },
        'provider/OpenAiCompatible.mjs': {
            probeSurface     : false,
            deadlineSpellings: ['new AbortController()'],
            role             : 'OpenAI-compatible `generate()` / `stream()` request deadline cancellation.'
        },
        'scripts/benchmark/provider-lane-election.mjs': {
            probeSurface     : false,
            deadlineSpellings: ['new AbortController()', 'AbortSignal.timeout()'],
            role             : 'Benchmark workload driver and SIGINT cancellation controller.'
        },
        'scripts/diagnostics/fleetHealthcheck.mjs': {
            probeSurface     : true,
            deadlineSpellings: ['AbortSignal.timeout()'],
            role             : 'Authenticated `/fleet/probe` readiness check (`probeFleetHealth`).'
        },
        'scripts/diagnostics/lmStudioEmbeddingInstances.mjs': {
            probeSurface     : true,
            deadlineSpellings: ['new AbortController()'],
            role             : 'LM Studio `/v1/models` diagnostic probe (`fetchModels`).'
        },
        'scripts/diagnostics/mcpHealthcheck.mjs': {
            probeSurface     : true,
            deadlineSpellings: ['new AbortController()'],
            role             : 'Container MCP streamable-HTTP session + `healthcheck` tool probe (`runHealthcheck`).'
        },
        'services/fleet/FleetLifecycleService.mjs': {
            probeSurface     : false,
            deadlineSpellings: ['new AbortController()', 'AbortSignal.timeout()'],
            role             : 'Seat start/stop lifecycle cancellation and OpenCode wake session bootstrap POST.'
        },
        'services/fleet/FleetTenantService.mjs': {
            probeSurface     : true,
            deadlineSpellings: ['AbortSignal.timeout()'],
            role             : 'Tenant MCP resource initialization and identity readiness probe (`initializeMcpResource`, `probeTenantEndpoint`, `probeSignal`).'
        },
        'services/fleet/McpLaunchAdmissionService.mjs': {
            probeSurface     : true,
            deadlineSpellings: ['new AbortController()'],
            role             : 'Credential-owner launch-admission proof (`prove`).'
        },
        'services/fleet/fleetWakeSseConsumer.mjs': {
            probeSurface     : false,
            deadlineSpellings: ['new AbortController()'],
            role             : 'Long-lived SSE stream consumer connection lifecycle.'
        },
        'services/fleet/opencodeWakeEnvelopePlugin.mjs': {
            probeSurface     : true,
            deadlineSpellings: ['new AbortController()'],
            role             : 'OpenCode loopback `/session/:id` verification probe (`getSession`).'
        },
        'services/fleet/providerValidation.mjs': {
            probeSurface     : true,
            deadlineSpellings: ['AbortSignal.timeout()'],
            role             : 'Host-side chat + embedding canary validation probe (`post`, `probeValidation`).'
        },
        'services/fleet/seatGitIdentity.mjs': {
            probeSurface     : false,
            deadlineSpellings: ['AbortSignal.timeout()'],
            role             : 'GitHub `/user` and `/user/emails` lookup during seat git-identity provisioning.'
        },
        'services/fleet/wireFleetOpenWorkSource.mjs': {
            probeSurface     : false,
            deadlineSpellings: ['AbortSignal.timeout()'],
            role             : 'GitHub GraphQL open-work query reader for Fleet Manager.'
        },
        'services/graph/providerReadinessHelper.mjs': {
            probeSurface     : true,
            deadlineSpellings: ['AbortSignal.timeout()'],
            role             : 'Provider model discovery, embedding-serving canary, `/slots` probe, `/api/ps` probe, and model residency warm/load helpers.'
        },
        'services/ingestion/githubActions.mjs': {
            probeSurface     : false,
            deadlineSpellings: ['AbortSignal.timeout()'],
            role             : 'GitHub Actions workflow-run ingestion REST client.'
        },
        'services/memory-core/WebhookDeliveryService.mjs': {
            probeSurface     : false,
            deadlineSpellings: ['AbortSignal.timeout()'],
            role             : 'Outbound webhook event POST delivery.'
        },
        'services/shared/embeddingProbe.mjs': {
            probeSurface     : true,
            deadlineSpellings: ['new AbortController()'],
            role             : 'Shared embedding health/readiness canary (`buildEmbeddingProbeBlock`).'
        }
    }),

    /**
     * Supervision and task-wiring modules that compose or consume `livenessProbe`, `healthProbe`,
     * and `postSpawn` residency hooks without directly constructing `AbortController`.
     */
    NON_ABORT_RESIDENCY_AND_PROBE_HOOK_MODULES = Object.freeze([
        'daemons/orchestrator/services/ConfiguredTaskDefinitionsService.mjs',
        'daemons/orchestrator/services/ProcessSupervisorService.mjs'
    ]),

    /**
     * Checked-in enumeration of the intersection between "issues a request / actuates state" and
     * "is used as a probe / canary / liveness / readiness / residency check" across `ai/`.
     */
    PROBE_POPULATION_CENSUS = Object.freeze([
        {
            module           : 'services/graph/providerReadinessHelper.mjs',
            symbol           : 'fetchLmsLoadedModels',
            disposition      : 'observation',
            effects          : [],
            armsDeadlineAbort: false,
            note             : 'Spawns read-only `lms ps --json` CLI child and kills only that reader child on timeout.'
        },
        {
            module           : 'services/graph/providerReadinessHelper.mjs',
            symbol           : 'fetchOpenAiCompatibleModelIds',
            disposition      : 'intervention',
            effects          : ['abort-in-flight'],
            armsDeadlineAbort: true,
            note             : 'Issues `GET /v1/models` with `AbortSignal.timeout(timeoutMs)`.'
        },
        {
            module           : 'services/graph/providerReadinessHelper.mjs',
            symbol           : 'checkOpenAiCompatibleEmbeddingServing',
            disposition      : 'intervention',
            effects          : ['abort-in-flight', 'occupy-slot', 'advance-state'],
            armsDeadlineAbort: true,
            note             : 'Dispatches `POST /v1/embeddings` canary in non-metadata mode with `AbortSignal.timeout(timeoutMs)`.'
        },
        {
            module           : 'services/graph/providerReadinessHelper.mjs',
            symbol           : 'fetchEmbeddingLaneSlots',
            disposition      : 'intervention',
            effects          : ['abort-in-flight'],
            armsDeadlineAbort: true,
            note             : 'Issues boot-time `GET /slots` with `AbortSignal.timeout(timeoutMs)`.'
        },
        {
            module           : 'services/graph/providerReadinessHelper.mjs',
            symbol           : 'fetchOllamaRunningModels',
            disposition      : 'intervention',
            effects          : ['abort-in-flight'],
            armsDeadlineAbort: true,
            note             : 'Issues `GET /api/ps` with `AbortSignal.timeout(timeoutMs)`.'
        },
        {
            module           : 'services/graph/providerReadinessHelper.mjs',
            symbol           : 'warmOllamaRoleModel',
            disposition      : 'intervention',
            effects          : ['occupy-slot', 'warm-or-evict', 'advance-state'],
            armsDeadlineAbort: false,
            note             : 'Dispatches `/api/chat` or `/api/embed` to warm model residency while detaching caller wait without aborting provider work.'
        },
        {
            module           : 'services/graph/providerReadinessHelper.mjs',
            symbol           : 'loadLmsModel',
            disposition      : 'intervention',
            effects          : ['warm-or-evict', 'advance-state'],
            armsDeadlineAbort: false,
            note             : 'Runs `lms load` CLI to mutate resident model state in LM Studio.'
        },
        {
            module           : 'services/graph/providerReadinessHelper.mjs',
            symbol           : 'fetchLmsSelectedRuntimeRows',
            disposition      : 'observation',
            effects          : [],
            armsDeadlineAbort: false,
            note             : 'Spawns read-only `lms runtime ls` CLI child without mutating provider state.'
        },
        {
            module           : 'services/graph/providerReadinessHelper.mjs',
            symbol           : 'ensureLmsModelsLoaded',
            disposition      : 'intervention',
            effects          : ['abort-in-flight', 'occupy-slot', 'warm-or-evict', 'advance-state'],
            armsDeadlineAbort: false,
            note             : 'Polls `/v1/models` + `lms ps --json`, invokes `loadLmsModel` for missing models, and runs optional `embeddingServingProbe`.'
        },
        {
            module           : 'services/graph/providerReadinessHelper.mjs',
            symbol           : 'ensureOllamaModelsReady',
            disposition      : 'intervention',
            effects          : ['abort-in-flight', 'occupy-slot', 'warm-or-evict', 'advance-state'],
            armsDeadlineAbort: false,
            note             : 'Polls `/api/ps` (`fetchOllamaRunningModels`) and warms missing or under-context roles via `warmOllamaRoleModel`.'
        },
        {
            module           : 'services/graph/providerReadinessHelper.mjs',
            symbol           : 'repairProviderRoleSetResidency',
            disposition      : 'intervention',
            effects          : ['abort-in-flight', 'occupy-slot', 'warm-or-evict', 'advance-state'],
            armsDeadlineAbort: false,
            note             : 'Recovery actuator helper delegating to `ensureOllamaModelsReady` or `ensureLmsModelsLoaded`.'
        },
        {
            module           : 'services/graph/providerReadinessHelper.mjs',
            symbol           : 'probeProviderParallelModelCapacity',
            disposition      : 'intervention',
            effects          : ['abort-in-flight'],
            armsDeadlineAbort: false,
            note             : 'Delegates to `fetchOllamaRunningModelIds` / `fetchOpenAiCompatibleModelIds`, inheriting their HTTP deadline abort.'
        },
        {
            module           : 'services/graph/providerReadinessHelper.mjs',
            symbol           : 'checkProvider',
            disposition      : 'intervention',
            effects          : ['abort-in-flight'],
            armsDeadlineAbort: false,
            note             : 'Delegates to `fetchOpenAiCompatibleModelIds` or `http.get` with `req.setTimeout(..., () => req.destroy())`.'
        },
        {
            module           : 'services/graph/providerReadinessHelper.mjs',
            symbol           : 'waitForProvider',
            disposition      : 'intervention',
            effects          : ['abort-in-flight'],
            armsDeadlineAbort: false,
            note             : 'Loops `checkProvider` across retry attempts.'
        },
        {
            module           : 'services/shared/embeddingProbe.mjs',
            symbol           : 'buildEmbeddingProbeBlock',
            disposition      : 'intervention',
            effects          : ['abort-in-flight', 'occupy-slot', 'advance-state'],
            armsDeadlineAbort: true,
            note             : 'Dispatches real `embedText` canary and aborts `controller` on `timeoutMs`.'
        },
        {
            module           : 'daemons/orchestrator/Orchestrator.mjs',
            symbol           : 'probeFrozenCollectionHealth',
            disposition      : 'intervention',
            effects          : ['abort-in-flight', 'occupy-slot', 'advance-state'],
            armsDeadlineAbort: true,
            note             : 'Dispatches `embedTexts([\'__freeze-reprobe-health-canary__\'])` and aborts `controller` on `timeoutMs`.'
        },
        {
            module           : 'daemons/orchestrator/taskDefinitions.mjs',
            symbol           : 'probeTcpPort',
            disposition      : 'observation',
            effects          : [],
            armsDeadlineAbort: false,
            note             : 'Performs loopback TCP handshake only (`net.connect`) and closes its own socket without issuing an application request.'
        },
        {
            module           : 'daemons/orchestrator/taskDefinitions.mjs',
            symbol           : 'probeChromaHttpHealth',
            disposition      : 'intervention',
            effects          : ['abort-in-flight'],
            armsDeadlineAbort: true,
            note             : 'Issues `GET /api/v2/heartbeat` and aborts `controller` on `timeoutMs`.'
        },
        {
            module           : 'daemons/orchestrator/services/ConfiguredTaskDefinitionsService.mjs',
            symbol           : 'buildConfiguredTaskDefinitions',
            disposition      : 'intervention',
            effects          : ['abort-in-flight', 'occupy-slot', 'warm-or-evict', 'advance-state'],
            armsDeadlineAbort: false,
            note             : 'Composes `tasks.lms` and `tasks.ollama` `livenessProbe` and `postSpawn` residency hooks.'
        },
        {
            module           : 'daemons/orchestrator/services/ConfiguredTaskDefinitionsService.mjs',
            symbol           : 'applyConfiguredLmsTask',
            disposition      : 'intervention',
            effects          : ['abort-in-flight', 'occupy-slot', 'warm-or-evict', 'advance-state'],
            armsDeadlineAbort: false,
            note             : 'Wires `tasks.lms.livenessProbe` (`fetchOpenAiCompatibleModelIds`) and `tasks.lms.postSpawn` (`ensureLmsModelsLoaded`).'
        },
        {
            module           : 'daemons/orchestrator/services/ConfiguredTaskDefinitionsService.mjs',
            symbol           : 'applyConfiguredOllamaTask',
            disposition      : 'intervention',
            effects          : ['abort-in-flight', 'occupy-slot', 'warm-or-evict', 'advance-state'],
            armsDeadlineAbort: false,
            note             : 'Wires `tasks.ollama.livenessProbe` and `tasks.ollama.postSpawn` to `ensureOllamaModelsReady`.'
        },
        {
            module           : 'daemons/orchestrator/services/ProcessSupervisorService.mjs',
            symbol           : 'runLivenessReadinessHook',
            disposition      : 'intervention',
            effects          : ['abort-in-flight', 'occupy-slot', 'warm-or-evict', 'advance-state'],
            armsDeadlineAbort: false,
            note             : 'Invokes `task.postSpawn` after liveness confirmation (steady-state residency witness).'
        },
        {
            module           : 'daemons/orchestrator/services/ProcessSupervisorService.mjs',
            symbol           : 'gateRecycleOnHealthProbe',
            disposition      : 'intervention',
            effects          : ['abort-in-flight'],
            armsDeadlineAbort: false,
            note             : 'Schedules `task.healthProbe()` and recycles the supervised child on sustained failure.'
        },
        {
            module           : 'daemons/orchestrator/services/ProcessSupervisorService.mjs',
            symbol           : 'gateRestartOnLivenessProbe',
            disposition      : 'intervention',
            effects          : ['abort-in-flight', 'occupy-slot', 'warm-or-evict', 'advance-state'],
            armsDeadlineAbort: false,
            note             : 'Schedules `task.livenessProbe()` and chains `runLivenessReadinessHook` on confirmation.'
        },
        {
            module           : 'daemons/wake/localWakeAdapters.mjs',
            symbol           : 'probeOpenCodeSession',
            disposition      : 'intervention',
            effects          : ['abort-in-flight'],
            armsDeadlineAbort: true,
            note             : 'Issues `GET /session/:id/message?limit=30` with `AbortSignal.timeout(4000)`.'
        },
        {
            module           : 'scripts/diagnostics/fleetHealthcheck.mjs',
            symbol           : 'probeFleetHealth',
            disposition      : 'intervention',
            effects          : ['abort-in-flight'],
            armsDeadlineAbort: true,
            note             : 'Issues authenticated `GET /fleet/probe` with `AbortSignal.timeout(timeoutMs)`.'
        },
        {
            module           : 'scripts/diagnostics/lmStudioEmbeddingInstances.mjs',
            symbol           : 'fetchModels',
            disposition      : 'intervention',
            effects          : ['abort-in-flight'],
            armsDeadlineAbort: true,
            note             : 'Issues `GET /v1/models` with `new AbortController()` + `setTimeout` abort.'
        },
        {
            module           : 'scripts/diagnostics/mcpHealthcheck.mjs',
            symbol           : 'runHealthcheck',
            disposition      : 'intervention',
            effects          : ['abort-in-flight', 'advance-state'],
            armsDeadlineAbort: true,
            note             : 'Connects MCP streamable-HTTP session, calls `healthcheck`, and aborts `abortController` on timeout.'
        },
        {
            module           : 'services/fleet/FleetTenantService.mjs',
            symbol           : 'initializeMcpResource',
            disposition      : 'intervention',
            effects          : ['abort-in-flight', 'advance-state'],
            armsDeadlineAbort: true,
            note             : 'Initializes MCP session, optionally proves identity/plane, and aborts via `probeSignal` / `AbortSignal.timeout(2_000)`.'
        },
        {
            module           : 'services/fleet/FleetTenantService.mjs',
            symbol           : 'probeTenantEndpoint',
            disposition      : 'intervention',
            effects          : ['abort-in-flight', 'advance-state'],
            armsDeadlineAbort: false,
            note             : 'Runs `initializeMcpResource` in parallel across Memory Core and Knowledge Base plane endpoints.'
        },
        {
            module           : 'services/fleet/FleetTenantService.mjs',
            symbol           : 'probeSignal',
            disposition      : 'intervention',
            effects          : ['abort-in-flight'],
            armsDeadlineAbort: true,
            note             : 'Constructs `AbortSignal.timeout(AiConfig.fleet.tenantProbeTimeoutMs)`.'
        },
        {
            module           : 'services/fleet/McpLaunchAdmissionService.mjs',
            symbol           : 'prove',
            disposition      : 'intervention',
            effects          : ['abort-in-flight', 'advance-state'],
            armsDeadlineAbort: true,
            note             : 'Executes `owners[name].prove(value, {signal: controller.signal})` and aborts on `proofTimeoutMs`.'
        },
        {
            module           : 'services/fleet/opencodeWakeEnvelopePlugin.mjs',
            symbol           : 'getSession',
            disposition      : 'intervention',
            effects          : ['abort-in-flight'],
            armsDeadlineAbort: true,
            note             : 'Issues `GET /session/:id` with `new AbortController()` + `setTimeout` abort.'
        },
        {
            module           : 'services/fleet/providerValidation.mjs',
            symbol           : 'post',
            disposition      : 'intervention',
            effects          : ['abort-in-flight', 'occupy-slot', 'advance-state'],
            armsDeadlineAbort: true,
            note             : 'Dispatches validation `POST` with `AbortSignal.timeout(timeoutMs)`.'
        },
        {
            module           : 'services/fleet/providerValidation.mjs',
            symbol           : 'probeValidation',
            disposition      : 'intervention',
            effects          : ['abort-in-flight', 'occupy-slot', 'advance-state'],
            armsDeadlineAbort: false,
            note             : 'Dispatches chat completion + embedding canary validation calls through `post()`.'
        }
    ]);

/**
 * Walks a directory tree and returns every `.mjs` file that arms `new AbortController()` or
 * `AbortSignal.timeout()`, along with which deadline spellings appear in the file.
 * @param {String} rootDir
 * @returns {Array<{module: String, deadlineSpellings: String[]}>}
 */
function scanAbortDeadlineModules(rootDir) {
    const entries = fs.readdirSync(rootDir, {recursive: true, withFileTypes: true});
    const matches = [];

    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;

        const fullPath  = path.join(entry.parentPath, entry.name),
              source    = fs.readFileSync(fullPath, 'utf8'),
              spellings = [];

        if (DEADLINE_ABORT_PATTERNS.abortController.test(source)) {
            spellings.push('new AbortController()');
        }
        if (DEADLINE_ABORT_PATTERNS.abortSignalTimeout.test(source)) {
            spellings.push('AbortSignal.timeout()');
        }

        if (spellings.length > 0) {
            matches.push({
                module           : path.relative(rootDir, fullPath).split(path.sep).join('/'),
                deadlineSpellings: spellings
            });
        }
    }

    return matches.sort((a, b) => (a.module < b.module ? -1 : a.module > b.module ? 1 : 0));
}

/**
 * Extracts a function or method's immediately preceding JSDoc comment and brace-balanced body.
 * @param {String} sourceText
 * @param {String} symbol
 * @returns {{jsdoc: String|null, body: String}}
 */
function extractSymbolInspectionUnit(sourceText, symbol) {
    const escaped  = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          patterns = [
              new RegExp(`^[ \\t]*(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`, 'm'),
              new RegExp(`^[ \\t]*(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z0-9_$]+\\s*=>)`, 'm'),
              new RegExp(`^[ \\t]*(?:async\\s+)?${escaped}\\s*\\([^)]*\\)\\s*\\{`, 'm')
          ];

    let match = null;
    for (const pattern of patterns) {
        const candidate = pattern.exec(sourceText);
        if (candidate && (!match || candidate.index < match.index)) {
            match = candidate;
        }
    }

    if (!match) {
        throw new Error(`Could not locate symbol '${symbol}' in source`);
    }

    const declarationStart = match.index,
          prefix           = sourceText.slice(0, declarationStart),
          lastClose        = prefix.lastIndexOf('*/');

    let jsdoc = null;
    if (lastClose !== -1 && prefix.slice(lastClose + 2).trim() === '') {
        const lastOpen = prefix.lastIndexOf('/**', lastClose);
        if (lastOpen !== -1) {
            jsdoc = prefix.slice(lastOpen, lastClose + 2);
        }
    }

    const openParenIndex = sourceText.indexOf('(', declarationStart);
    if (openParenIndex === -1) {
        throw new Error(`Could not locate parameter list for symbol '${symbol}'`);
    }

    let parenDepth      = 0,
        closeParenIndex = openParenIndex;

    for (let i = openParenIndex; i < sourceText.length; i++) {
        const ch = sourceText[i];
        if (ch === '(') parenDepth++;
        else if (ch === ')') {
            parenDepth--;
            if (parenDepth === 0) {
                closeParenIndex = i + 1;
                break;
            }
        }
    }

    const openBraceIndex = sourceText.indexOf('{', closeParenIndex);
    if (openBraceIndex === -1) {
        throw new Error(`Could not locate opening brace for symbol '${symbol}'`);
    }

    let depth    = 0,
        endIndex = openBraceIndex;

    for (let i = openBraceIndex; i < sourceText.length; i++) {
        const ch = sourceText[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                endIndex = i + 1;
                break;
            }
        }
    }

    return {
        jsdoc,
        body: sourceText.slice(declarationStart, endIndex)
    };
}

/**
 * Parses `@probeDisposition` from a JSDoc block.
 * @param {String|null} jsdoc
 * @returns {{raw: String, disposition: String, effects: String[]}|null}
 */
function parseProbeDispositionTag(jsdoc) {
    if (typeof jsdoc !== 'string') return null;

    const match = /@probeDisposition\s+([^\n\r*]+)/.exec(jsdoc);
    if (!match) return null;

    const raw   = match[1].trim(),
          parts = /^([a-zA-Z-]+)(?:\s*\(([^)]*)\))?$/.exec(raw);

    if (!parts) {
        return {raw, disposition: raw, effects: []};
    }

    const disposition = parts[1].trim(),
          effects     = parts[2]
              ? parts[2].split(',').map(item => item.trim()).filter(Boolean)
              : [];

    return {raw, disposition, effects};
}

/**
 * Audits one extracted probe inspection unit (`{jsdoc, body}`) against the probe-mutation
 * disposition contract.
 *
 * - Missing `@probeDisposition` fails (`missing-probe-disposition`) — never defaults to `observation`.
 * - Unknown disposition fails (`invalid-probe-disposition`).
 * - `observation` naming intervention effects fails (`observation-declares-effects`).
 * - `intervention` without named effects fails (`missing-intervention-effect`) or with unknown
 *   effects fails (`invalid-intervention-effect`).
 * - `observation` arming `new AbortController()` or `AbortSignal.timeout()` in its body fails
 *   (`observation-arms-deadline-abort`).
 *
 * @param {Object} options
 * @param {String|null} options.jsdoc
 * @param {String} options.body
 * @param {String[]} options.allowedEffects
 * @returns {{ok: Boolean, reason: String|null, parsed: Object|null, armsDeadlineAbort: Boolean}}
 */
function auditProbeInspectionUnit({jsdoc, body, allowedEffects}) {
    const parsed            = parseProbeDispositionTag(jsdoc),
          armsDeadlineAbort = DEADLINE_ABORT_PATTERNS.abortController.test(body) ||
              DEADLINE_ABORT_PATTERNS.abortSignalTimeout.test(body);

    if (!parsed) {
        return {
            ok    : false,
            reason: 'missing-probe-disposition',
            parsed: null,
            armsDeadlineAbort
        };
    }

    if (parsed.disposition !== 'observation' && parsed.disposition !== 'intervention') {
        return {
            ok    : false,
            reason: 'invalid-probe-disposition',
            parsed,
            armsDeadlineAbort
        };
    }

    if (parsed.disposition === 'observation') {
        if (parsed.effects.length > 0) {
            return {
                ok    : false,
                reason: 'observation-declares-effects',
                parsed,
                armsDeadlineAbort
            };
        }
        if (armsDeadlineAbort) {
            return {
                ok    : false,
                reason: 'observation-arms-deadline-abort',
                parsed,
                armsDeadlineAbort
            };
        }

        return {
            ok    : true,
            reason: null,
            parsed,
            armsDeadlineAbort
        };
    }

    if (parsed.effects.length === 0) {
        return {
            ok    : false,
            reason: 'missing-intervention-effect',
            parsed,
            armsDeadlineAbort
        };
    }

    const invalidEffect = parsed.effects.find(effect => !allowedEffects.includes(effect));
    if (invalidEffect) {
        return {
            ok    : false,
            reason: `invalid-intervention-effect:${invalidEffect}`,
            parsed,
            armsDeadlineAbort
        };
    }

    return {
        ok    : true,
        reason: null,
        parsed,
        armsDeadlineAbort
    };
}

/**
 * Non-vacuity gate: refuses an empty module scan or a probe census that lacks either disposition.
 * @param {Object} options
 * @param {Array} options.abortModules
 * @param {Array} options.probeUnits
 */
function assertNonVacuousProbeScan({abortModules, probeUnits}) {
    if (!Array.isArray(abortModules) || abortModules.length === 0) {
        throw new Error('Vacuous abort-deadline scan: matched 0 modules under ai/');
    }
    if (!Array.isArray(probeUnits) || probeUnits.length === 0) {
        throw new Error('Vacuous probe census: matched 0 probe definitions');
    }
    if (!probeUnits.some(unit => unit.disposition === 'observation')) {
        throw new Error('Vacuous probe census: matched 0 observation probes');
    }
    if (!probeUnits.some(unit => unit.disposition === 'intervention')) {
        throw new Error('Vacuous probe census: matched 0 intervention probes');
    }
}

test.describe('Probe mutation disposition census and mechanical guard', () => {
    let ContainerHealthDiagnosisService,
        CONTAINER_HEALTH_ACTION_CLASSES,
        CONTAINER_HEALTH_FACT_TYPES,
        PROBE_DISPOSITIONS,
        PROBE_INTERVENTION_EFFECTS,
        resolveConsumedProbeAuthority;

    test.beforeAll(async () => {
        ({
            default: ContainerHealthDiagnosisService,
            CONTAINER_HEALTH_ACTION_CLASSES,
            CONTAINER_HEALTH_FACT_TYPES,
            PROBE_DISPOSITIONS,
            PROBE_INTERVENTION_EFFECTS,
            resolveConsumedProbeAuthority
        } = await import('../../../../../../ai/daemons/orchestrator/services/ContainerHealthDiagnosisService.mjs'));
    });

    test('AC-1 TOTALITY: all 25 abort-deadline modules and residency hook seams under ai/ are enumerated', () => {
        const liveScan      = scanAbortDeadlineModules(aiRoot),
              liveModules   = liveScan.map(item => item.module),
              censusModules = Object.keys(ABORT_DEADLINE_MODULE_CENSUS).sort();

        expect(liveModules, 'a module under ai/ added or removed new AbortController() / AbortSignal.timeout() without updating ABORT_DEADLINE_MODULE_CENSUS')
            .toEqual(censusModules);
        expect(liveModules.length).toBe(25);

        for (const item of liveScan) {
            const censusEntry = ABORT_DEADLINE_MODULE_CENSUS[item.module];
            expect(item.deadlineSpellings.sort(), `deadline spellings drifted for ${item.module}`)
                .toEqual([...censusEntry.deadlineSpellings].sort());
        }

        const expectedProbeSurfaceModules = [
            ...Object.entries(ABORT_DEADLINE_MODULE_CENSUS)
                .filter(([, entry]) => entry.probeSurface)
                .map(([modulePath]) => modulePath),
            ...NON_ABORT_RESIDENCY_AND_PROBE_HOOK_MODULES
        ].sort();

        const enumeratedProbeModules = [...new Set(PROBE_POPULATION_CENSUS.map(entry => entry.module))].sort();

        expect(enumeratedProbeModules, 'every probe-surface abort module and supervision residency hook module must be represented in PROBE_POPULATION_CENSUS')
            .toEqual(expectedProbeSurfaceModules);
    });

    test('AC-2 DECLARATION: every enumerated probe carries an explicit observation or intervention (with named effect) disposition in JSDoc', () => {
        for (const entry of PROBE_POPULATION_CENSUS) {
            const fullPath   = path.join(aiRoot, entry.module),
                  sourceText = fs.readFileSync(fullPath, 'utf8'),
                  unit       = extractSymbolInspectionUnit(sourceText, entry.symbol),
                  audit      = auditProbeInspectionUnit({
                      jsdoc         : unit.jsdoc,
                      body          : unit.body,
                      allowedEffects: PROBE_INTERVENTION_EFFECTS
                  });

            expect(audit.ok, `${entry.module}#${entry.symbol} failed disposition audit: ${audit.reason}`)
                .toBe(true);
            expect(audit.parsed.disposition, `${entry.module}#${entry.symbol} disposition mismatch`)
                .toBe(entry.disposition);
            expect(audit.parsed.effects, `${entry.module}#${entry.symbol} effects mismatch`)
                .toEqual(entry.effects);
            expect(audit.armsDeadlineAbort, `${entry.module}#${entry.symbol} armsDeadlineAbort mismatch`)
                .toBe(entry.armsDeadlineAbort);
        }
    });

    test('AC-3 GUARD & BIDIRECTIONAL MUTATION CONVICTION: observation probes cannot arm deadline aborts; ollamaStuckRunnerLiveness fixture convicts', () => {
        // 1. Live observation population passes.
        const liveObservations = PROBE_POPULATION_CENSUS.filter(entry => entry.disposition === 'observation');
        expect(liveObservations.length).toBeGreaterThan(0);

        for (const entry of liveObservations) {
            const sourceText = fs.readFileSync(path.join(aiRoot, entry.module), 'utf8'),
                  unit       = extractSymbolInspectionUnit(sourceText, entry.symbol),
                  audit      = auditProbeInspectionUnit({
                      jsdoc         : unit.jsdoc,
                      body          : unit.body,
                      allowedEffects: PROBE_INTERVENTION_EFFECTS
                  });

            expect(audit.ok).toBe(true);
            expect(audit.armsDeadlineAbort).toBe(false);
        }

        // 2. Direction A (Positive Control 1): Reproduce the deleted `ollamaStuckRunnerLiveness.mjs`
        // `probeOllamaServing` pattern (`new AbortController()` + `setTimeout(() => controller.abort(), canaryTimeoutMs)`)
        // disguised as `@probeDisposition observation` -> MUST FAIL the guard.
        const stuckRunnerFixtureSource = `
            /**
             * @summary Probes whether native Ollama can complete a tiny chat canary within the deadline.
             * @probeDisposition observation
             */
            export async function probeOllamaServing({host, model, canaryTimeoutMs = 10000, fetchFn = fetch} = {}) {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), canaryTimeoutMs);
                try {
                    const response = await fetchFn(new URL('/api/chat', host).toString(), {
                        method: 'POST',
                        body  : JSON.stringify({model, stream: false, messages: [{role: 'user', content: 'ping'}]}),
                        signal: controller.signal
                    });
                    return {alive: response.ok};
                } finally {
                    clearTimeout(timer);
                }
            }
        `;
        const stuckRunnerUnit  = extractSymbolInspectionUnit(stuckRunnerFixtureSource, 'probeOllamaServing'),
              stuckRunnerAudit = auditProbeInspectionUnit({
                  jsdoc         : stuckRunnerUnit.jsdoc,
                  body          : stuckRunnerUnit.body,
                  allowedEffects: PROBE_INTERVENTION_EFFECTS
              });

        expect(stuckRunnerAudit.ok).toBe(false);
        expect(stuckRunnerAudit.reason).toBe('observation-arms-deadline-abort');
        expect(stuckRunnerAudit.armsDeadlineAbort).toBe(true);

        // 3. Direction A (Positive Control 2): Mutate a live `observation` probe (`probeTcpPort`) to arm
        // `AbortSignal.timeout(timeoutMs)` -> MUST FAIL the guard (proving both spellings are caught).
        const taskDefsSource     = fs.readFileSync(path.join(aiRoot, 'daemons/orchestrator/taskDefinitions.mjs'), 'utf8'),
              probeTcpPortUnit   = extractSymbolInspectionUnit(taskDefsSource, 'probeTcpPort'),
              mutatedObservation = auditProbeInspectionUnit({
                  jsdoc: probeTcpPortUnit.jsdoc,
                  body : probeTcpPortUnit.body.replace(
                      'socket.setTimeout(Number(timeoutMs));',
                      'const signal = AbortSignal.timeout(Number(timeoutMs));'
                  ),
                  allowedEffects: PROBE_INTERVENTION_EFFECTS
              });

        expect(mutatedObservation.ok).toBe(false);
        expect(mutatedObservation.reason).toBe('observation-arms-deadline-abort');

        // 4. Direction B (Inverse Control): Removing an abort from a declared `intervention` probe
        // (`probeChromaHttpHealth` and `fetchOpenAiCompatibleModelIds`) does NOT fail the guard.
        const chromaUnit           = extractSymbolInspectionUnit(taskDefsSource, 'probeChromaHttpHealth'),
              disarmedIntervention = auditProbeInspectionUnit({
                  jsdoc         : chromaUnit.jsdoc,
                  body          : chromaUnit.body.replace('new AbortController()', '({signal: undefined})'),
                  allowedEffects: PROBE_INTERVENTION_EFFECTS
              });

        expect(disarmedIntervention.ok).toBe(true);
        expect(disarmedIntervention.armsDeadlineAbort).toBe(false);

        const readinessSource       = fs.readFileSync(path.join(aiRoot, 'services/graph/providerReadinessHelper.mjs'), 'utf8'),
              openAiModelsUnit      = extractSymbolInspectionUnit(readinessSource, 'fetchOpenAiCompatibleModelIds'),
              disarmedTimeoutSignal = auditProbeInspectionUnit({
                  jsdoc         : openAiModelsUnit.jsdoc,
                  body          : openAiModelsUnit.body.replace('AbortSignal.timeout(timeoutMs)', 'undefined'),
                  allowedEffects: PROBE_INTERVENTION_EFFECTS
              });

        expect(disarmedTimeoutSignal.ok).toBe(true);
        expect(disarmedTimeoutSignal.armsDeadlineAbort).toBe(false);
    });

    test('AC-4 NON-VACUITY CONTROL: the live scan finds known members and an empty scan fails loudly', () => {
        const liveScan = scanAbortDeadlineModules(aiRoot);

        expect(() => assertNonVacuousProbeScan({
            abortModules: liveScan,
            probeUnits  : PROBE_POPULATION_CENSUS
        })).not.toThrow();

        const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-guard-vacuous-'));
        try {
            const emptyScan = scanAbortDeadlineModules(emptyDir);
            expect(emptyScan).toEqual([]);
            expect(() => assertNonVacuousProbeScan({
                abortModules: emptyScan,
                probeUnits  : PROBE_POPULATION_CENSUS
            })).toThrow(/Vacuous abort-deadline scan/);
        } finally {
            fs.rmSync(emptyDir, {recursive: true, force: true});
        }

        expect(() => assertNonVacuousProbeScan({
            abortModules: liveScan,
            probeUnits  : []
        })).toThrow(/Vacuous probe census/);

        expect(() => assertNonVacuousProbeScan({
            abortModules: liveScan,
            probeUnits  : PROBE_POPULATION_CENSUS.filter(item => item.disposition === 'intervention')
        })).toThrow(/0 observation probes/);
    });

    test('AC-5 UNDECLARED PROBE FAILS: omitting @probeDisposition or omitting an intervention effect fails instead of defaulting to observation', () => {
        const taskDefsSource   = fs.readFileSync(path.join(aiRoot, 'daemons/orchestrator/taskDefinitions.mjs'), 'utf8'),
              probeTcpPortUnit = extractSymbolInspectionUnit(taskDefsSource, 'probeTcpPort');

        const strippedDisposition = auditProbeInspectionUnit({
            jsdoc         : probeTcpPortUnit.jsdoc.replace(/\s*\*\s*@probeDisposition[^\n\r]*/, ''),
            body          : probeTcpPortUnit.body,
            allowedEffects: PROBE_INTERVENTION_EFFECTS
        });

        expect(strippedDisposition.ok).toBe(false);
        expect(strippedDisposition.reason).toBe('missing-probe-disposition');

        const missingEffect = auditProbeInspectionUnit({
            jsdoc         : '/**\n * @summary Canary.\n * @probeDisposition intervention\n */',
            body          : 'function canary() { return true; }',
            allowedEffects: PROBE_INTERVENTION_EFFECTS
        });

        expect(missingEffect.ok).toBe(false);
        expect(missingEffect.reason).toBe('missing-intervention-effect');

        const unknownDisposition = auditProbeInspectionUnit({
            jsdoc         : '/**\n * @summary Canary.\n * @probeDisposition advisory\n */',
            body          : 'function canary() { return true; }',
            allowedEffects: PROBE_INTERVENTION_EFFECTS
        });

        expect(unknownDisposition.ok).toBe(false);
        expect(unknownDisposition.reason).toBe('invalid-probe-disposition');

        const unknownEffect = auditProbeInspectionUnit({
            jsdoc         : '/**\n * @summary Canary.\n * @probeDisposition intervention (invented-effect)\n */',
            body          : 'function canary() { return true; }',
            allowedEffects: PROBE_INTERVENTION_EFFECTS
        });

        expect(unknownEffect.ok).toBe(false);
        expect(unknownEffect.reason).toBe('invalid-intervention-effect:invented-effect');
    });

    test('AC-6 DIAGNOSIS CONSUMING SEAM: a probe declared intervention cannot silently back or corroborate an authoritative diagnosis fact', () => {
        const observedAt = 1_760_000_000_000,
              service    = Neo.create(ContainerHealthDiagnosisService, {
                  nowFn           : () => observedAt,
                  ollamaHostReader: () => 'http://ollama:11434'
              });

        // 1. Unacknowledged intervention on `providerResidency` withdraws `authoritative: true` and blocks recovery.
        const unacknowledgedResidencyDecision = service.diagnose({
            serviceKey       : 'ollama',
            observedAt,
            inspect          : {State: {Status: 'running', Running: true, Health: {Status: 'healthy'}}},
            providerResidency: {
                provider          : 'ollama',
                host              : 'http://ollama:11434',
                model             : 'qwen2.5-coder:14b',
                ready             : false,
                degraded          : true,
                missingModels     : ['qwen2.5-coder:14b'],
                requiredModels    : ['qwen2.5-coder:14b'],
                availableModels   : [],
                targetIdentity    : {kind: 'compose-service', id: 'ollama'},
                probeDisposition  : PROBE_DISPOSITIONS.intervention,
                interventionEffect: ['abort-in-flight', 'warm-or-evict']
            }
        });

        expect(unacknowledgedResidencyDecision.status).toBe('advisory');
        expect(unacknowledgedResidencyDecision.actionClass).toBeNull();
        expect(unacknowledgedResidencyDecision.facts).toHaveLength(1);
        expect(unacknowledgedResidencyDecision.facts[0]).toMatchObject({
            type         : CONTAINER_HEALTH_FACT_TYPES.providerResidency,
            authoritative: false,
            details      : {
                reasonCode              : 'missing-required-model',
                probeDisposition        : 'intervention',
                interventionEffect      : 'abort-in-flight, warm-or-evict',
                interventionAcknowledged: false,
                authorityWithdrawnReason: 'unacknowledged-intervention-probe'
            }
        });

        // 2. Explicitly acknowledged intervention preserves `authoritative: true` while keeping the
        // intervention disposition and effect visible on `fact.details` at the consuming seam.
        const acknowledgedResidencyDecision = service.diagnose({
            serviceKey       : 'ollama',
            observedAt,
            inspect          : {State: {Status: 'running', Running: true, Health: {Status: 'healthy'}}},
            providerResidency: {
                provider               : 'ollama',
                host                   : 'http://ollama:11434',
                model                  : 'qwen2.5-coder:14b',
                ready                  : false,
                degraded               : true,
                missingModels          : ['qwen2.5-coder:14b'],
                requiredModels         : ['qwen2.5-coder:14b'],
                availableModels        : [],
                targetIdentity         : {kind: 'compose-service', id: 'ollama'},
                probeDisposition       : PROBE_DISPOSITIONS.intervention,
                interventionEffect     : ['abort-in-flight', 'warm-or-evict'],
                acknowledgeIntervention: true
            }
        });

        expect(acknowledgedResidencyDecision.status).toBe('diagnosed');
        expect(acknowledgedResidencyDecision.actionClass).toBe(CONTAINER_HEALTH_ACTION_CLASSES.warmProvider);
        expect(acknowledgedResidencyDecision.facts[0]).toMatchObject({
            type         : CONTAINER_HEALTH_FACT_TYPES.providerResidency,
            authoritative: true,
            details      : {
                reasonCode              : 'missing-required-model',
                probeDisposition        : 'intervention',
                interventionEffect      : 'abort-in-flight, warm-or-evict',
                interventionAcknowledged: true
            }
        });

        // 3. Unacknowledged intervention on `endpointProbe` cannot silently corroborate `container-unhealthy` into a restart.
        const unacknowledgedEndpointDecision = service.diagnose({
            serviceKey   : 'memory-core',
            observedAt,
            inspect      : {State: {Status: 'running', Running: true, Health: {Status: 'unhealthy', FailingStreak: 3}}},
            endpointProbe: {
                ok                : false,
                name              : 'mcp-healthcheck',
                message           : 'timed out after 5000ms',
                probeDisposition  : PROBE_DISPOSITIONS.intervention,
                interventionEffect: 'abort-in-flight'
            }
        });

        expect(unacknowledgedEndpointDecision.status).toBe('advisory');
        expect(unacknowledgedEndpointDecision.actionClass).toBeNull();
        const endpointFact = unacknowledgedEndpointDecision.facts.find(
            fact => fact.type === CONTAINER_HEALTH_FACT_TYPES.endpointProbeFailed
        );
        expect(endpointFact.details).toMatchObject({
            probeDisposition        : 'intervention',
            interventionEffect      : 'abort-in-flight',
            interventionAcknowledged: false,
            authorityWithdrawnReason: 'unacknowledged-intervention-probe'
        });

        // 4. `resolveConsumedProbeAuthority` admits `observation` without withdrawal.
        expect(resolveConsumedProbeAuthority({
            probe               : {probeDisposition: PROBE_DISPOSITIONS.observation},
            defaultAuthoritative: true
        })).toEqual({
            authoritative        : true,
            corroborationAdmitted: true,
            details              : {
                probeDisposition: 'observation'
            }
        });
    });
});

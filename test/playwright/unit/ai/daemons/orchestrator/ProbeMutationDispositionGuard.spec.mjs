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
     * Keying on one spelling misses the other. Every module in this 27-module population is
     * accounted for here and partitioned into:
     * - `probeSurface: true` (13 modules): modules carrying probe / canary / liveness / readiness
     *   entry points that must declare `@probeDisposition` in `PROBE_POPULATION_CENSUS`.
     * - `probeSurface: false` (14 modules): workload request transports, OAuth/PAT verification,
     *   daemon lifecycle shutdown signals, or outbound delivery clients that are not probes.
     */
    ABORT_DEADLINE_MODULE_CENSUS = Object.freeze({
        'daemons/orchestrator/Orchestrator.mjs': {
            probeSurface     : true,
            deadlineSpellings: ['new AbortController()'],
            role             : 'Orchestrator freeze re-probe embedding canary (`probeFrozenCollectionHealth`).'
        },
        'daemons/orchestrator/services/ProcessSupervisorService.mjs': {
            probeSurface     : true,
            deadlineSpellings: ['new AbortController()'],
            role             : 'Task success-hook cancellation alongside the declared supervision readiness hooks.'
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
        'daemons/wake/antigravityWakeSidecar.mjs': {
            probeSurface     : false,
            deadlineSpellings: ['new AbortController()'],
            role             : 'Sidecar lifecycle shutdown cancels the interval on SIGTERM or SIGINT.'
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
        'daemons/orchestrator/services/ConfiguredTaskDefinitionsService.mjs'
    ]),

    /**
     * Explicit allowlist of non-probe functions inside probe-surface modules that arm an execution
     * deadline (`daemons/wake/localWakeAdapters.mjs` shares wake-delivery adapters with
     * `probeOpenCodeSession`, and `opencodeWakeEnvelopePlugin.mjs` wraps `getSession` inside the
     * `NeoWakeEnvelope` plugin factory). Any other deadline-abort or probe-helper function added to
     * a probe-surface module is treated as a probe site and must be declared in `PROBE_POPULATION_CENSUS`.
     */
    NON_PROBE_ABORT_SITES_IN_PROBE_MODULES = Object.freeze({
        // runTask fences its own lifecycle completion; the supervisor's readiness probes remain declared below.
        'daemons/orchestrator/services/ProcessSupervisorService.mjs': Object.freeze(['runTask']),
        'daemons/wake/localWakeAdapters.mjs'                        : Object.freeze(['dispatchLocalWake', 'postOpenCodeDigest', 'deliverKimiServer']),
        'services/fleet/opencodeWakeEnvelopePlugin.mjs'             : Object.freeze(['NeoWakeEnvelope'])
    }),

    JS_CONTROL_KEYWORDS = new Set([
        'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'throw',
        'new', 'delete', 'typeof', 'void', 'yield', 'await', 'class', 'constructor',
        'super', 'import', 'export', 'try', 'finally', 'else', 'do', 'with'
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
 * Replaces JS comments, string literals, regex literals, and template literal text chunks with
 * spaces of identical length (preserving line breaks and executable `${...}` template expressions)
 * so lexical scanning and brace-balanced function extraction never treat comment/string/regex
 * tokens or braces as executable syntax.
 *
 * @param {String} sourceText
 * @returns {String}
 */
function stripNonExecutableJs(sourceText) {
    const length        = sourceText.length,
          out           = new Array(length),
          templateStack = [];

    let i             = 0,
        prevTokenChar = '';

    const canStartRegex = () => {
        if (!prevTokenChar) return true;
        return '(!%&*+,-.:;<=>?[^{|~'.includes(prevTokenChar);
    };

    const blankChar = ch => (ch === '\n' || ch === '\r' ? ch : ' ');

    while (i < length) {
        const ch   = sourceText[i],
              next = sourceText[i + 1];

        // 1. Single-line comment `// ...`
        if (ch === '/' && next === '/') {
            out[i]     = ' ';
            out[i + 1] = ' ';
            i += 2;
            while (i < length && sourceText[i] !== '\n' && sourceText[i] !== '\r') {
                out[i] = ' ';
                i++;
            }
            continue;
        }

        // 2. Block comment `/* ... */`
        if (ch === '/' && next === '*') {
            out[i]     = ' ';
            out[i + 1] = ' ';
            i += 2;
            while (i < length && !(sourceText[i] === '*' && sourceText[i + 1] === '/')) {
                out[i] = blankChar(sourceText[i]);
                i++;
            }
            if (i < length) {
                out[i]     = ' ';
                out[i + 1] = ' ';
                i += 2;
            }
            continue;
        }

        // 3. Single- or double-quoted string literal
        if (ch === '\'' || ch === '"') {
            const quote = ch;
            out[i++] = ' ';
            while (i < length) {
                const c = sourceText[i];
                out[i++] = blankChar(c);
                if (c === '\\' && i < length) {
                    out[i] = blankChar(sourceText[i]);
                    i++;
                    continue;
                }
                if (c === quote) break;
            }
            prevTokenChar = '"';
            continue;
        }

        // 4. Template literal start or continuation after `${ ... }`
        if (ch === '`') {
            out[i++] = ' ';
            while (i < length) {
                const c = sourceText[i];
                if (c === '\\' && i + 1 < length) {
                    out[i]     = blankChar(c);
                    out[i + 1] = blankChar(sourceText[i + 1]);
                    i += 2;
                    continue;
                }
                if (c === '$' && sourceText[i + 1] === '{') {
                    out[i]     = ' ';
                    out[i + 1] = ' ';
                    i += 2;
                    templateStack.push({braceDepth: 0});
                    prevTokenChar = '(';
                    break;
                }
                out[i++] = blankChar(c);
                if (c === '`') {
                    prevTokenChar = '"';
                    break;
                }
            }
            continue;
        }

        // 5. Inside `${ ... }` template expression: closing `}` at braceDepth 0 resumes template text
        if (templateStack.length > 0) {
            const top = templateStack[templateStack.length - 1];
            if (ch === '{') {
                top.braceDepth++;
            } else if (ch === '}') {
                if (top.braceDepth === 0) {
                    templateStack.pop();
                    out[i++] = ' ';
                    while (i < length) {
                        const c = sourceText[i];
                        if (c === '\\' && i + 1 < length) {
                            out[i]     = blankChar(c);
                            out[i + 1] = blankChar(sourceText[i + 1]);
                            i += 2;
                            continue;
                        }
                        if (c === '$' && sourceText[i + 1] === '{') {
                            out[i]     = ' ';
                            out[i + 1] = ' ';
                            i += 2;
                            templateStack.push({braceDepth: 0});
                            prevTokenChar = '(';
                            break;
                        }
                        out[i++] = blankChar(c);
                        if (c === '`') {
                            prevTokenChar = '"';
                            break;
                        }
                    }
                    continue;
                }
                top.braceDepth--;
            }
        }

        // 6. Regex literal `/.../`
        if (ch === '/' && canStartRegex()) {
            out[i++] = ' ';
            let inCharClass = false;
            while (i < length) {
                const c = sourceText[i];
                if (c === '\n' || c === '\r') {
                    out[i++] = c;
                    break;
                }
                out[i++] = ' ';
                if (c === '\\' && i < length) {
                    out[i] = blankChar(sourceText[i]);
                    i++;
                    continue;
                }
                if (c === '[') inCharClass = true;
                else if (c === ']') inCharClass = false;
                else if (c === '/' && !inCharClass) {
                    while (i < length && /[a-z]/i.test(sourceText[i])) {
                        out[i++] = ' ';
                    }
                    break;
                }
            }
            prevTokenChar = '/';
            continue;
        }

        out[i++] = ch;
        if (!/\s/.test(ch)) {
            prevTokenChar = ch;
        }
    }

    return out.join('');
}

/**
 * Walks a directory tree and returns every `.mjs` file that arms `new AbortController()` or
 * `AbortSignal.timeout()` in executable code, along with which deadline spellings appear in the file.
 * @param {String} rootDir
 * @param {Object<String, String>} [sourceOverrides={}]
 * @returns {Array<{module: String, deadlineSpellings: String[]}>}
 */
function scanAbortDeadlineModules(rootDir, sourceOverrides = {}) {
    const entries = fs.readdirSync(rootDir, {recursive: true, withFileTypes: true});
    const matches = [];

    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;

        const fullPath   = path.join(entry.parentPath, entry.name),
              modulePath = path.relative(rootDir, fullPath).split(path.sep).join('/'),
              source     = Object.hasOwn(sourceOverrides, modulePath)
                  ? sourceOverrides[modulePath]
                  : fs.readFileSync(fullPath, 'utf8'),
              executableSource = stripNonExecutableJs(source),
              spellings        = [];

        if (DEADLINE_ABORT_PATTERNS.abortController.test(executableSource)) {
            spellings.push('new AbortController()');
        }
        if (DEADLINE_ABORT_PATTERNS.abortSignalTimeout.test(executableSource)) {
            spellings.push('AbortSignal.timeout()');
        }

        if (spellings.length > 0) {
            matches.push({
                module           : modulePath,
                deadlineSpellings: spellings
            });
        }
    }

    return matches.sort((a, b) => (a.module < b.module ? -1 : a.module > b.module ? 1 : 0));
}

/**
 * Extracts a function or method's immediately preceding JSDoc comment and brace-balanced body
 * using lexical-stripped executable boundaries so comment/string/regex braces cannot truncate
 * or extend the function body.
 * @param {String} sourceText
 * @param {String} symbol
 * @returns {{jsdoc: String|null, body: String, executableBody: String}}
 */
function extractSymbolInspectionUnit(sourceText, symbol) {
    const executableText = stripNonExecutableJs(sourceText),
          escaped        = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          patterns       = [
              new RegExp(`^[ \\t]*(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`, 'm'),
              new RegExp(`^[ \\t]*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z0-9_$]+\\s*=>)`, 'm'),
              new RegExp(`^[ \\t]*(?:static\\s+)?(?:async\\s+)?${escaped}\\s*\\([^)]*\\)\\s*\\{`, 'm')
          ];

    let match = null;
    for (const pattern of patterns) {
        const candidate = pattern.exec(executableText);
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

    const openParenIndex = executableText.indexOf('(', declarationStart);
    if (openParenIndex === -1) {
        throw new Error(`Could not locate parameter list for symbol '${symbol}'`);
    }

    let parenDepth      = 0,
        closeParenIndex = openParenIndex;

    for (let i = openParenIndex; i < executableText.length; i++) {
        const ch = executableText[i];
        if (ch === '(') parenDepth++;
        else if (ch === ')') {
            parenDepth--;
            if (parenDepth === 0) {
                closeParenIndex = i + 1;
                break;
            }
        }
    }

    const openBraceIndex = executableText.indexOf('{', closeParenIndex);
    if (openBraceIndex === -1) {
        throw new Error(`Could not locate opening brace for symbol '${symbol}'`);
    }

    let depth    = 0,
        endIndex = openBraceIndex;

    for (let i = openBraceIndex; i < executableText.length; i++) {
        const ch = executableText[i];
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
        body          : sourceText.slice(declarationStart, endIndex),
        executableBody: executableText.slice(declarationStart, endIndex)
    };
}

/**
 * Discovers probe symbols inside a probe-surface module by scanning all function and method
 * declarations in `executableText` (in addition to `censusSymbolsForModule`) so newly added
 * intra-module probe functions or deadline-abort/probe-helper call sites cannot escape the guard.
 *
 * @param {String} modulePath
 * @param {String} sourceText
 * @param {Set<String>} censusSymbolsForModule
 * @returns {String[]}
 */
function discoverModuleProbeSymbols(modulePath, sourceText, censusSymbolsForModule = new Set()) {
    const executableText    = stripNonExecutableJs(sourceText),
          discovered        = new Set(censusSymbolsForModule),
          nonProbeAllowlist = NON_PROBE_ABORT_SITES_IN_PROBE_MODULES[modulePath] || [],
          declPatterns      = [
              /^[ \t]*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm,
              /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z0-9_$]+\s*=>)/gm,
              /^[ \t]*(?:static\s+)?(?:async\s+)?([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/gm
          ],
          candidateNames = new Set();

    for (const pattern of declPatterns) {
        let match;
        while ((match = pattern.exec(executableText)) !== null) {
            const symbol = match[1];
            if (!symbol || JS_CONTROL_KEYWORDS.has(symbol)) continue;
            candidateNames.add(symbol);
        }
    }

    for (const symbol of candidateNames) {
        if (discovered.has(symbol) || nonProbeAllowlist.includes(symbol)) continue;

        let unit;
        try {
            unit = extractSymbolInspectionUnit(sourceText, symbol);
        } catch {
            continue;
        }

        const openBraceOffset    = unit.executableBody.indexOf('{'),
              bodyAfterOpenBrace = openBraceOffset === -1
                  ? unit.executableBody
                  : unit.executableBody.slice(openBraceOffset + 1),
              hasDispositionTag   = parseProbeDispositionTag(unit.jsdoc) !== null,
              armsDeadlineAbort   = DEADLINE_ABORT_PATTERNS.abortController.test(unit.executableBody) ||
                  DEADLINE_ABORT_PATTERNS.abortSignalTimeout.test(unit.executableBody),
              callsDiscoveryProbe = /\brunProviderDiscoveryProbe\s*\(/.test(bodyAfterOpenBrace);

        if (hasDispositionTag || armsDeadlineAbort || callsDiscoveryProbe) {
            discovered.add(symbol);
        }
    }

    return [...discovered];
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
 * - `observation` arming `new AbortController()` or `AbortSignal.timeout()` in its executable body
 *   fails (`observation-arms-deadline-abort`).
 *
 * @param {Object} options
 * @param {String|null} options.jsdoc
 * @param {String} options.body
 * @param {String[]} options.allowedEffects
 * @returns {{ok: Boolean, reason: String|null, parsed: Object|null, armsDeadlineAbort: Boolean}}
 */
function auditProbeInspectionUnit({jsdoc, body, allowedEffects}) {
    const parsed            = parseProbeDispositionTag(jsdoc),
          executableBody    = stripNonExecutableJs(body),
          armsDeadlineAbort = DEADLINE_ABORT_PATTERNS.abortController.test(executableBody) ||
              DEADLINE_ABORT_PATTERNS.abortSignalTimeout.test(executableBody);

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

/**
 * Executes the full population + intra-module probe disposition guard across `ai/`.
 *
 * - Direction A (must fail):
 *   1. An `observation` probe arms `new AbortController()` or `AbortSignal.timeout()` (including when
 *      hidden behind comment/string/regex closing braces).
 *   2. A newly introduced undeclared probe function or deadline-abort/probe-helper call site is added
 *      inside an existing probe-surface module or an unenumerated module under `ai/`.
 *   3. A probe omits `@probeDisposition` or an `intervention` probe omits a valid named effect.
 * - Direction B (must pass):
 *   Removing an existing deadline abort (`new AbortController()` / `AbortSignal.timeout()`) from a
 *   declared `intervention` probe passes the full guard without failure.
 *
 * @param {Object} [options={}]
 * @param {String} [options.rootDir=aiRoot]
 * @param {Object<String, String>} [options.sourceOverrides={}]
 * @param {Array} [options.census=PROBE_POPULATION_CENSUS]
 * @param {String[]} [options.allowedEffects]
 * @returns {{ok: Boolean, failures: Array<{module: String, symbol: String|null, reason: String}>, liveScan: Array}}
 */
function evaluateProbePopulationGuard({
    rootDir         = aiRoot,
    sourceOverrides = {},
    census          = PROBE_POPULATION_CENSUS,
    allowedEffects  = []
} = {}) {
    const liveScan = scanAbortDeadlineModules(rootDir, sourceOverrides);
    assertNonVacuousProbeScan({abortModules: liveScan, probeUnits: census});

    const failures = [];

    for (const item of liveScan) {
        const censusEntry = ABORT_DEADLINE_MODULE_CENSUS[item.module];
        if (!censusEntry) {
            failures.push({
                module: item.module,
                symbol: null,
                reason: 'unenumerated-abort-deadline-module'
            });
            continue;
        }

        for (const spelling of item.deadlineSpellings) {
            if (!censusEntry.deadlineSpellings.includes(spelling)) {
                failures.push({
                    module: item.module,
                    symbol: null,
                    reason: `undeclared-module-deadline-spelling:${spelling}`
                });
            }
        }
    }

    const expectedProbeSurfaceModules = [
        ...Object.entries(ABORT_DEADLINE_MODULE_CENSUS)
            .filter(([, entry]) => entry.probeSurface)
            .map(([modulePath]) => modulePath),
        ...NON_ABORT_RESIDENCY_AND_PROBE_HOOK_MODULES
    ].sort();

    for (const modulePath of expectedProbeSurfaceModules) {
        const sourceText = Object.hasOwn(sourceOverrides, modulePath)
            ? sourceOverrides[modulePath]
            : fs.readFileSync(path.join(rootDir, modulePath), 'utf8');

        const moduleCensusEntries    = census.filter(entry => entry.module === modulePath),
              censusSymbolsForModule = new Set(moduleCensusEntries.map(entry => entry.symbol)),
              discoveredSymbols      = discoverModuleProbeSymbols(modulePath, sourceText, censusSymbolsForModule);

        for (const symbol of discoveredSymbols) {
            let unit;
            try {
                unit = extractSymbolInspectionUnit(sourceText, symbol);
            } catch (error) {
                failures.push({
                    module: modulePath,
                    symbol,
                    reason: `missing-symbol:${error.message}`
                });
                continue;
            }

            const audit = auditProbeInspectionUnit({
                jsdoc: unit.jsdoc,
                body : unit.body,
                allowedEffects
            });

            if (!audit.ok) {
                failures.push({
                    module: modulePath,
                    symbol,
                    reason: audit.reason
                });
            }

            const censusEntry = moduleCensusEntries.find(entry => entry.symbol === symbol);
            if (!censusEntry) {
                failures.push({
                    module: modulePath,
                    symbol,
                    reason: 'undeclared-in-probe-census'
                });
                continue;
            }

            if (audit.ok) {
                if (audit.parsed.disposition !== censusEntry.disposition) {
                    failures.push({
                        module: modulePath,
                        symbol,
                        reason: 'census-disposition-mismatch'
                    });
                }
                if (JSON.stringify(audit.parsed.effects) !== JSON.stringify(censusEntry.effects)) {
                    failures.push({
                        module: modulePath,
                        symbol,
                        reason: 'census-effects-mismatch'
                    });
                }
                if (audit.armsDeadlineAbort && (
                    !censusEntry.armsDeadlineAbort ||
                    censusEntry.disposition !== 'intervention' ||
                    !censusEntry.effects.includes('abort-in-flight')
                )) {
                    failures.push({
                        module: modulePath,
                        symbol,
                        reason: 'undeclared-deadline-abort'
                    });
                }
            }
        }
    }

    return {
        ok      : failures.length === 0,
        failures,
        liveScan
    };
}

test.describe('Probe mutation disposition census and mechanical guard', () => {
    let ContainerHealthDiagnosisService,
        CONTAINER_HEALTH_ACTION_CLASSES,
        CONTAINER_HEALTH_FACT_TYPES,
        PROBE_DISPOSITIONS,
        PROBE_INTERVENTION_EFFECTS,
        resolveConsumedProbeAuthority,
        DeploymentStateBridgeService,
        classifyDirectProbeOutcome,
        RUN_HEALTHCHECK_PROBE_DISPOSITION,
        runHealthcheck,
        PROBE_PROVIDER_PARALLEL_MODEL_CAPACITY_DISPOSITION,
        probeProviderParallelModelCapacity;

    test.beforeAll(async () => {
        ({
            default: ContainerHealthDiagnosisService,
            CONTAINER_HEALTH_ACTION_CLASSES,
            CONTAINER_HEALTH_FACT_TYPES,
            PROBE_DISPOSITIONS,
            PROBE_INTERVENTION_EFFECTS,
            resolveConsumedProbeAuthority
        } = await import('../../../../../../ai/daemons/orchestrator/services/ContainerHealthDiagnosisService.mjs'));

        ({
            default: DeploymentStateBridgeService,
            classifyDirectProbeOutcome
        } = await import('../../../../../../ai/daemons/orchestrator/services/DeploymentStateBridgeService.mjs'));

        ({
            RUN_HEALTHCHECK_PROBE_DISPOSITION,
            runHealthcheck
        } = await import('../../../../../../ai/scripts/diagnostics/mcpHealthcheck.mjs'));

        ({
            PROBE_PROVIDER_PARALLEL_MODEL_CAPACITY_DISPOSITION,
            probeProviderParallelModelCapacity
        } = await import('../../../../../../ai/services/graph/providerReadinessHelper.mjs'));
    });

    test('AC-1 TOTALITY: all abort-deadline modules and residency hook seams under ai/ are enumerated', () => {
        const guardResult   = evaluateProbePopulationGuard({allowedEffects: PROBE_INTERVENTION_EFFECTS}),
              liveScan      = guardResult.liveScan,
              liveModules   = liveScan.map(item => item.module),
              censusModules = Object.keys(ABORT_DEADLINE_MODULE_CENSUS).sort();

        expect(guardResult.ok, `live probe population guard failed: ${JSON.stringify(guardResult.failures)}`)
            .toBe(true);
        expect(liveModules, 'a module under ai/ added or removed new AbortController() / AbortSignal.timeout() without updating ABORT_DEADLINE_MODULE_CENSUS')
            .toEqual(censusModules);
        expect(liveModules.length).toBe(27);

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
            expect(audit.armsDeadlineAbort, `${entry.module}#${entry.symbol} baseline armsDeadlineAbort mismatch`)
                .toBe(entry.armsDeadlineAbort);
        }
    });

    test('AC-3 GUARD & BIDIRECTIONAL MUTATION CONVICTION: full guard convicts observation aborts, comment/string brace hiding, and reachable same-module additions while passing abort removal', () => {
        // 1. Live population passes the full guard.
        const baselineGuard = evaluateProbePopulationGuard({allowedEffects: PROBE_INTERVENTION_EFFECTS});
        expect(baselineGuard.ok).toBe(true);
        expect(baselineGuard.failures).toEqual([]);

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

        // 3. Direction A (Positive Control 2): Mutate a live `observation` probe (`probeTcpPort` in
        // `daemons/orchestrator/taskDefinitions.mjs`) to arm `new AbortController()` -> MUST FAIL the full guard.
        const taskDefsModule  = 'daemons/orchestrator/taskDefinitions.mjs',
              taskDefsSource  = fs.readFileSync(path.join(aiRoot, taskDefsModule), 'utf8'),
              mutatedTcpGuard = evaluateProbePopulationGuard({
                  allowedEffects : PROBE_INTERVENTION_EFFECTS,
                  sourceOverrides: {
                      [taskDefsModule]: taskDefsSource.replace(
                          'socket.setTimeout(Number(timeoutMs));',
                          'const controller = new AbortController(); socket.setTimeout(Number(timeoutMs));'
                      )
                  }
              });

        expect(mutatedTcpGuard.ok).toBe(false);
        expect(mutatedTcpGuard.failures).toContainEqual({
            module: taskDefsModule,
            symbol: 'probeTcpPort',
            reason: 'observation-arms-deadline-abort'
        });

        // 4. Direction A (Positive Control 3 — Comment / String / Regex Brace Hiding Control):
        // Insert a closing brace inside a line comment (`// }`), a string (`"}"`), and a regex (`/\}/`)
        // before `AbortSignal.timeout(timeoutMs)` inside `fetchLmsLoadedModels` (`@probeDisposition observation`).
        // A naive brace counter would terminate the body early at `// }` and miss the abort; the lexical
        // scanner keeps the full executable body intact and convicts through the full guard.
        const readinessModule          = 'services/graph/providerReadinessHelper.mjs',
              readinessSource          = fs.readFileSync(path.join(aiRoot, readinessModule), 'utf8'),
              commentBraceHidingSource = readinessSource.replace(
                  "if (typeof timeoutMs !== 'number') {",
                  "// }\n    const braceString = '}';\n    const braceRegex = /\\}/;\n    const hiddenAbortSignal = AbortSignal.timeout(timeoutMs);\n    if (typeof timeoutMs !== 'number') {"
              ),
              commentBraceGuard = evaluateProbePopulationGuard({
                  allowedEffects : PROBE_INTERVENTION_EFFECTS,
                  sourceOverrides: {
                      [readinessModule]: commentBraceHidingSource
                  }
              });

        expect(commentBraceGuard.ok).toBe(false);
        expect(commentBraceGuard.failures).toContainEqual({
            module: readinessModule,
            symbol: 'fetchLmsLoadedModels',
            reason: 'observation-arms-deadline-abort'
        });

        // 5. Direction A (Positive Control 4 — Reachable Same-Module Undeclared Probe Addition):
        // Append a newly introduced undeclared probe function inside `services/graph/providerReadinessHelper.mjs`
        // (both one arming `AbortSignal.timeout(timeoutMs)` and one delegating through `runProviderDiscoveryProbe`).
        // Even though the module-level spelling set for `providerReadinessHelper.mjs` is unchanged, intra-module
        // discovery catches both undeclared probe functions and fails the full guard.
        const sameModuleAddedSource = `${readinessSource}\n
export async function probeAddedModelIds({host, timeoutMs, fetchFn = fetch} = {}) {
    return runProviderDiscoveryProbe({
        key: \`added:\${host}:\${timeoutMs}\`,
        caller: 'probeAddedModelIds',
        async runProbe() {
            const response = await fetchFn(host, {signal: AbortSignal.timeout(timeoutMs)});
            return response.ok;
        }
    });
}
`,
              sameModuleAddedGuard = evaluateProbePopulationGuard({
                  allowedEffects : PROBE_INTERVENTION_EFFECTS,
                  sourceOverrides: {
                      [readinessModule]: sameModuleAddedSource
                  }
              });

        expect(sameModuleAddedGuard.ok).toBe(false);
        expect(sameModuleAddedGuard.failures).toContainEqual({
            module: readinessModule,
            symbol: 'probeAddedModelIds',
            reason: 'missing-probe-disposition'
        });
        expect(sameModuleAddedGuard.failures).toContainEqual({
            module: readinessModule,
            symbol: 'probeAddedModelIds',
            reason: 'undeclared-in-probe-census'
        });

        // 6. Direction B (Inverse Control): Removing the existing deadline abort from declared `intervention`
        // probes (`fetchOpenAiCompatibleModelIds` in `providerReadinessHelper.mjs` and `probeChromaHttpHealth`
        // in `taskDefinitions.mjs`) PASSES the full guard (`evaluateProbePopulationGuard`).
        const disarmedReadinessSource = readinessSource.replace(
                  'signal: AbortSignal.timeout(timeoutMs)',
                  'signal: undefined'
              ),
              disarmedTaskDefsSource = taskDefsSource.replace(
                  'const controller = new AbortController();',
                  'const controller = {abort() {}, signal: undefined};'
              ),
              directionBGuard = evaluateProbePopulationGuard({
                  allowedEffects : PROBE_INTERVENTION_EFFECTS,
                  sourceOverrides: {
                      [readinessModule]: disarmedReadinessSource,
                      [taskDefsModule] : disarmedTaskDefsSource
                  }
              });

        expect(directionBGuard.ok).toBe(true);
        expect(directionBGuard.failures).toEqual([]);
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
        const taskDefsModule = 'daemons/orchestrator/taskDefinitions.mjs',
              taskDefsSource = fs.readFileSync(path.join(aiRoot, taskDefsModule), 'utf8'),
              strippedGuard  = evaluateProbePopulationGuard({
                  allowedEffects : PROBE_INTERVENTION_EFFECTS,
                  sourceOverrides: {
                      [taskDefsModule]: taskDefsSource.replace(/\s*\*\s*@probeDisposition\s+observation/, '')
                  }
              });

        expect(strippedGuard.ok).toBe(false);
        expect(strippedGuard.failures).toContainEqual({
            module: taskDefsModule,
            symbol: 'probeTcpPort',
            reason: 'missing-probe-disposition'
        });

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

    test('AC-6 DIAGNOSIS CONSUMING SEAM: composed producer -> bridge -> diagnosis path enforces disposition, named effect, and explicit acknowledgement', async () => {
        const observedAt   = 1_760_000_000_000,
              ollamaConfig = {
                  modelProvider    : 'ollama',
                  graphProvider    : 'ollama',
                  embeddingProvider: 'ollama',
                  ollama           : {
                      host                 : 'http://ollama:11434',
                      model                : 'qwen2.5-coder:14b',
                      embeddingModel       : 'qwen3-embedding',
                      requireParallelModels: 2
                  }
              },
              runningHealthyInspect   = {State: {Status: 'running', Running: true, Health: {Status: 'healthy'}}},
              runningUnhealthyInspect = {State: {Status: 'running', Running: true, Health: {Status: 'unhealthy', FailingStreak: 3}}},
              diagnosisService        = Neo.create(ContainerHealthDiagnosisService, {
                  nowFn           : () => observedAt,
                  ollamaHostReader: () => 'http://ollama:11434'
              });

        // 1. Composed Producer -> Bridge -> Diagnosis (Acknowledged Intervention):
        // `probeProviderParallelModelCapacity` and `runHealthcheck` attach definition-owned disposition
        // metadata, `DeploymentStateBridgeService` threads it with explicit acknowledgement, and
        // `ContainerHealthDiagnosisService` preserves `authoritative: true` / restart corroboration.
        const acknowledgedBridge = Neo.create(DeploymentStateBridgeService, {
            nowFn                 : () => observedAt,
            providerResidencyProbe: opts => probeProviderParallelModelCapacity({
                ...opts,
                config           : ollamaConfig,
                fetchOllamaModels: async () => ['qwen3-embedding:latest']
            })
        });

        const bridgedAcknowledgedResidency = await acknowledgedBridge.collectProviderResidency({
            serviceKey: 'local-model',
            observedAt
        });

        expect(bridgedAcknowledgedResidency).toMatchObject({
            provider                : 'ollama',
            ready                   : false,
            missingModels           : ['qwen2.5-coder:14b'],
            probeDisposition        : PROBE_PROVIDER_PARALLEL_MODEL_CAPACITY_DISPOSITION.probeDisposition,
            interventionEffect      : [...PROBE_PROVIDER_PARALLEL_MODEL_CAPACITY_DISPOSITION.interventionEffect],
            declaredProbeDisposition: 'intervention',
            acknowledgeIntervention : true
        });

        const acknowledgedResidencyDecision = diagnosisService.diagnose({
            serviceKey       : 'local-model',
            observedAt,
            inspect          : runningHealthyInspect,
            providerResidency: bridgedAcknowledgedResidency
        });

        expect(acknowledgedResidencyDecision.status).toBe('diagnosed');
        expect(acknowledgedResidencyDecision.actionClass).toBe(CONTAINER_HEALTH_ACTION_CLASSES.warmProvider);
        expect(acknowledgedResidencyDecision.facts[0]).toMatchObject({
            type         : CONTAINER_HEALTH_FACT_TYPES.providerResidency,
            authoritative: true,
            details      : {
                reasonCode              : 'missing-required-model',
                probeDisposition        : 'intervention',
                interventionEffect      : 'abort-in-flight',
                interventionAcknowledged: true
            }
        });

        const directProbeTimeoutError = Object.assign(
            new Error('MCP healthcheck timed out after 2500ms'),
            {
                code       : 'ETIMEDOUT',
                probeTiming: {verdict: 'service-unresponsive'},
                ...RUN_HEALTHCHECK_PROBE_DISPOSITION
            }
        );

        const bridgedAcknowledgedEndpoint = classifyDirectProbeOutcome(directProbeTimeoutError, {
            probe                  : runHealthcheck,
            acknowledgeIntervention: acknowledgedBridge.acknowledgeDirectProbeIntervention
        });

        expect(bridgedAcknowledgedEndpoint).toMatchObject({
            ok                      : false,
            name                    : 'direct-endpoint-probe',
            message                 : 'service-unresponsive',
            probeDisposition        : RUN_HEALTHCHECK_PROBE_DISPOSITION.probeDisposition,
            interventionEffect      : [...RUN_HEALTHCHECK_PROBE_DISPOSITION.interventionEffect],
            declaredProbeDisposition: 'intervention',
            acknowledgeIntervention : true
        });

        const acknowledgedEndpointDecision = diagnosisService.diagnose({
            serviceKey   : 'memory-core',
            observedAt,
            inspect      : runningUnhealthyInspect,
            endpointProbe: bridgedAcknowledgedEndpoint
        });

        expect(acknowledgedEndpointDecision.status).toBe('diagnosed');
        expect(acknowledgedEndpointDecision.actionClass).toBe(CONTAINER_HEALTH_ACTION_CLASSES.restart);
        expect(acknowledgedEndpointDecision.facts.find(
            fact => fact.type === CONTAINER_HEALTH_FACT_TYPES.endpointProbeFailed
        ).details).toMatchObject({
            probeDisposition        : 'intervention',
            interventionEffect      : 'abort-in-flight, advance-state',
            interventionAcknowledged: true
        });

        // 2. Composed Producer -> Bridge -> Diagnosis (Unacknowledged Intervention Refusal):
        // When the bridge seam does not acknowledge the intervention (`acknowledge*Intervention: false`),
        // `ContainerHealthDiagnosisService` withdraws `authoritative: true` and refuses restart corroboration.
        const unacknowledgedBridge = Neo.create(DeploymentStateBridgeService, {
            nowFn                                   : () => observedAt,
            acknowledgeProviderResidencyIntervention: false,
            acknowledgeDirectProbeIntervention      : false,
            providerResidencyProbe                  : opts => probeProviderParallelModelCapacity({
                ...opts,
                config           : ollamaConfig,
                fetchOllamaModels: async () => ['qwen3-embedding:latest']
            })
        });

        const bridgedUnacknowledgedResidency = await unacknowledgedBridge.collectProviderResidency({
            serviceKey: 'local-model',
            observedAt
        });
        const unacknowledgedResidencyDecision = diagnosisService.diagnose({
            serviceKey       : 'local-model',
            observedAt,
            inspect          : runningHealthyInspect,
            providerResidency: bridgedUnacknowledgedResidency
        });

        expect(unacknowledgedResidencyDecision.status).toBe('advisory');
        expect(unacknowledgedResidencyDecision.actionClass).toBeNull();
        expect(unacknowledgedResidencyDecision.facts[0]).toMatchObject({
            type         : CONTAINER_HEALTH_FACT_TYPES.providerResidency,
            authoritative: false,
            details      : {
                reasonCode              : 'missing-required-model',
                probeDisposition        : 'intervention',
                interventionEffect      : 'abort-in-flight',
                interventionAcknowledged: false,
                authorityWithdrawnReason: 'unacknowledged-intervention-probe'
            }
        });

        const bridgedUnacknowledgedEndpoint = classifyDirectProbeOutcome(directProbeTimeoutError, {
            probe                  : runHealthcheck,
            acknowledgeIntervention: unacknowledgedBridge.acknowledgeDirectProbeIntervention
        });
        const unacknowledgedEndpointDecision = diagnosisService.diagnose({
            serviceKey   : 'memory-core',
            observedAt,
            inspect      : runningUnhealthyInspect,
            endpointProbe: bridgedUnacknowledgedEndpoint
        });

        expect(unacknowledgedEndpointDecision.status).toBe('advisory');
        expect(unacknowledgedEndpointDecision.actionClass).toBeNull();
        expect(unacknowledgedEndpointDecision.facts.find(
            fact => fact.type === CONTAINER_HEALTH_FACT_TYPES.endpointProbeFailed
        ).details).toMatchObject({
            probeDisposition        : 'intervention',
            interventionEffect      : 'abort-in-flight, advance-state',
            interventionAcknowledged: false,
            authorityWithdrawnReason: 'unacknowledged-intervention-probe'
        });

        // 2b. Consuming-Seam Ownership Precedence:
        // A producer return payload injecting `acknowledgeIntervention: true` must NOT override
        // `collectProviderResidency({ acknowledgeIntervention: false })` or `acknowledgeProviderResidencyIntervention: false`.
        const selfAcknowledgingProducerBridge = Neo.create(DeploymentStateBridgeService, {
            nowFn                                   : () => observedAt,
            acknowledgeProviderResidencyIntervention: false,
            providerResidencyProbe                  : async opts => ({
                ...(await probeProviderParallelModelCapacity({
                    ...opts,
                    config           : ollamaConfig,
                    fetchOllamaModels: async () => ['qwen3-embedding:latest']
                })),
                acknowledgeIntervention: true
            })
        });
        const bridgedSelfAcknowledgingResidency = await selfAcknowledgingProducerBridge.collectProviderResidency({
            serviceKey             : 'local-model',
            observedAt,
            acknowledgeIntervention: false
        });
        expect(bridgedSelfAcknowledgingResidency.acknowledgeIntervention).toBe(false);

        const selfAcknowledgingProducerDecision = diagnosisService.diagnose({
            serviceKey       : 'local-model',
            observedAt,
            inspect          : runningHealthyInspect,
            providerResidency: bridgedSelfAcknowledgingResidency
        });
        expect(selfAcknowledgingProducerDecision.status).toBe('advisory');
        expect(selfAcknowledgingProducerDecision.actionClass).toBeNull();
        expect(selfAcknowledgingProducerDecision.facts[0]).toMatchObject({
            type         : CONTAINER_HEALTH_FACT_TYPES.providerResidency,
            authoritative: false,
            details      : {
                reasonCode              : 'missing-required-model',
                probeDisposition        : 'intervention',
                interventionEffect      : 'abort-in-flight',
                interventionAcknowledged: false,
                authorityWithdrawnReason: 'unacknowledged-intervention-probe'
            }
        });

        // 3. Dropped Disposition Metadata Refusal:
        // A declared intervention must NOT regain authority or corroboration if `probeDisposition` is dropped.
        const droppedDispositionResidencyDecision = diagnosisService.diagnose({
            serviceKey       : 'ollama',
            observedAt,
            inspect          : runningHealthyInspect,
            providerResidency: {
                ...bridgedAcknowledgedResidency,
                probeDisposition: undefined
            }
        });

        expect(droppedDispositionResidencyDecision.status).toBe('advisory');
        expect(droppedDispositionResidencyDecision.actionClass).toBeNull();
        expect(droppedDispositionResidencyDecision.facts[0]).toMatchObject({
            type         : CONTAINER_HEALTH_FACT_TYPES.providerResidency,
            authoritative: false,
            details      : {
                authorityWithdrawnReason: 'missing-probe-disposition'
            }
        });

        const droppedDispositionEndpointDecision = diagnosisService.diagnose({
            serviceKey   : 'memory-core',
            observedAt,
            inspect      : runningUnhealthyInspect,
            endpointProbe: {
                ...bridgedAcknowledgedEndpoint,
                probeDisposition: undefined
            }
        });

        expect(droppedDispositionEndpointDecision.status).toBe('advisory');
        expect(droppedDispositionEndpointDecision.actionClass).toBeNull();
        expect(droppedDispositionEndpointDecision.facts.find(
            fact => fact.type === CONTAINER_HEALTH_FACT_TYPES.endpointProbeFailed
        ).details).toMatchObject({
            authorityWithdrawnReason: 'missing-probe-disposition'
        });

        // 4. Missing or Invalid Named Effect Refusal on Acknowledged Intervention:
        const missingEffectDecision = diagnosisService.diagnose({
            serviceKey       : 'ollama',
            observedAt,
            inspect          : runningHealthyInspect,
            providerResidency: {
                ...bridgedAcknowledgedResidency,
                interventionEffect: []
            }
        });

        expect(missingEffectDecision.status).toBe('advisory');
        expect(missingEffectDecision.actionClass).toBeNull();
        expect(missingEffectDecision.facts[0]).toMatchObject({
            type         : CONTAINER_HEALTH_FACT_TYPES.providerResidency,
            authoritative: false,
            details      : {
                probeDisposition        : 'intervention',
                interventionAcknowledged: false,
                authorityWithdrawnReason: 'missing-intervention-effect'
            }
        });

        const invalidEffectDecision = diagnosisService.diagnose({
            serviceKey       : 'ollama',
            observedAt,
            inspect          : runningHealthyInspect,
            providerResidency: {
                ...bridgedAcknowledgedResidency,
                interventionEffect: ['invented-effect']
            }
        });

        expect(invalidEffectDecision.status).toBe('advisory');
        expect(invalidEffectDecision.actionClass).toBeNull();
        expect(invalidEffectDecision.facts[0]).toMatchObject({
            type         : CONTAINER_HEALTH_FACT_TYPES.providerResidency,
            authoritative: false,
            details      : {
                probeDisposition        : 'intervention',
                interventionAcknowledged: false,
                authorityWithdrawnReason: 'invalid-intervention-effect:invented-effect'
            }
        });

        // 5. Legitimate `observation` Probe Preserves Authority Without Intervention Acknowledgement:
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

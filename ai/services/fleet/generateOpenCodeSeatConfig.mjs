import {createHash}                                                                             from 'node:crypto';
import {readFileSync}                                                                           from 'node:fs';
import path                                                                                     from 'node:path';
import {REMOTE_MCP_CREDENTIAL_ENV_VAR}                                                          from './mcpServers.mjs';
import {MEMORY_LAYER_BOOT_FILES, renderAboutThisLayerMd, renderIdentityMd, renderMemoryIndexMd} from './seatMemoryLayerTemplate.mjs';

/**
 * The canonical MCP server set every OpenCode seat wires, keyed by the seat-config server name.
 * `script` is the POSIX path relative to the AgentOS runtime root. `needsCwd: true` marks
 * Neural Link: its `--cwd` starts the AgentOS package/Bridge from that same runtime authority.
 * Fixed module data, not a configurable default — an unlisted server is a deliberate caller
 * override via `options.servers`, never an accident of omission.
 * @type {ReadonlyArray<{name: String, script: String, needsCwd: Boolean}>}
 */
export const OPENCODE_SEAT_SERVERS = Object.freeze([
    {name: 'neo-mjs-memory-core',    script: 'ai/mcp/server/memory-core/mcp-server.mjs',    needsCwd: false},
    {name: 'neo-mjs-github-workflow', script: 'ai/mcp/server/github-workflow/mcp-server.mjs', needsCwd: false},
    {name: 'neo-mjs-knowledge-base', script: 'ai/mcp/server/knowledge-base/mcp-server.mjs', needsCwd: false},
    {name: 'neo-mjs-neural-link',    script: 'ai/mcp/server/neural-link/mcp-server.mjs',    needsCwd: true}
]);

/**
 * Generate every config/scaffold file an OpenCode seat boots from, as a PURE params→files
 * emission (the AiConfig SSOT purity discipline: no config imports, no env reads, no hidden
 * defaults — callers resolve every path). The launch path (`prepareManagedAgentWorkspace`)
 * writes the returned files; this module only decides their content.
 *
 * **One declared exception to "pure", and it is a file read, not a config or env read:**
 * `WAKE_ENVELOPE_PLANT_SOURCE` is `readFileSync` of the sibling plant module at load time, so the
 * emitted plant is byte-identical to the Brain's copy. The reason it lives here rather than arriving as
 * a parameter: this module is the one surface that knows a seat's artifact paths, and the alternative
 * makes the caller read a file whose location is this module's knowledge — splitting it in two. The read
 * is of a file inside this package, resolved through `import.meta.url`, so it introduces no ambient
 * dependency: no env, no user path, no network, and nothing that varies per seat. Callers still resolve
 * every PATH, which is the part of the contract that carries the isolation weight.
 *
 * The three load-bearing seat constraints this productizes (verified live on the first OpenCode
 * seat, `@neo-kimi-phoebe`, 2026-07-18):
 *
 * 1. **AgentOS runtime authority.** MCP server CODE must run from the AgentOS runtime root: the Memory
 *    Core resolves its DATA ROOT from the server code's own file location
 *    (`ai/mcp/server/memory-core/configBase.mjs:21-28` — `import.meta.url` → `neoRootDir` →
 *    `.neo-ai-data/*`). Server code under a per-seat checkout silently forks an empty graph
 *    island whose writes never merge back. The island guard below therefore REJECTS any server
 *    script path that resolves outside `agentosRuntimeRoot`.
 * 2. **Seat personal.** Identity + credentials load via `--env-file` from the seat's OWN `.env`
 *    (`NEO_AGENT_IDENTITY`, `GH_TOKEN`, provider keys). Node's `--env-file` never overwrites
 *    already-set vars, so explicit `environment` entries win where a caller needs them to.
 *
 *    **This generator emits TWO artifacts that install the wake lane, not one — and they are SIBLINGS.**
 *    The first is the `write-wake-envelope` hook, emitted whenever `wakeHookPath` is given; it writes the
 *    envelope once the bound port is known. The second is the wake-envelope PLANT —
 *    `ai/services/fleet/opencodeWakeEnvelopePlugin.mjs` — emitted verbatim as its own file at
 *    `wakePlantPath`, so the seat's FIRST OpenCode process loads it and republishes the envelope on every
 *    new top-level session. Without it the hook writes a file nothing ever reads again.
 *
 *    They are siblings, not a hook and its payload, for a delivery reason rather than a tidiness one: the
 *    hook runs at the boot boundary AFTER the server is listening, so a plant the hook installs can only
 *    ever be loaded by a LATER process — and the hook's environment is the caller's `hookEnv`, which does
 *    not carry `XDG_CONFIG_HOME` at all. An earlier shape inlined the plant into the hook as base64 and
 *    installed it from there; it could only ever be late, and it made every plant edit a divergence on
 *    every seat's boot hook. Moving the plant to its own `files` entry fixes both at once, because the
 *    caller now converges it under its own policy row (see `prepareOpenCodeArtifacts`).
 *
 *    The generated-artifact posture is unchanged and is NOT this module's to soften: the caller creates
 *    absent files, converges owned ones, and refuses divergence. A hand edit to a Fleet-owned file is a
 *    person's decision to reconcile, so it is reported, never silently clobbered.
 *
 *    **`XDG_DATA_HOME` is the seat-separation seam — not the OpenCode project list.** Provisioning a
 *    second seat on one machine means giving it its own data home, because that is what separates the
 *    wake envelope (`<XDG_DATA_HOME>/opencode/wake-envelope.json`), the session database and the
 *    project registry. Two seats under one `HOME` share all three no matter how many projects the
 *    desktop app displays — adding a project to an existing instance looks like separation and is
 *    not. The hook below additionally stamps the envelope's writer so the wake reader can refuse
 *    another seat's, but that check is a backstop for a shared data home, never a licence to run one.
 * 3. **The memory layer is the always-loaded slot — Grace-pattern.** OpenCode has no
 *    persistent auto-memory layer, so `instructions` carries the boot files (`MEMORY.md` +
 *    `identity.md`) into EVERY session. Detail files deliberately stay OUT of the array — each
 *    entry costs context every turn (the first seat measured 27.2KB all-loaded; the capped
 *    hot-index reshape targets ~10KB hot + on-demand detail). `identity.md` emits as a
 *    near-empty template with a story-sovereignty header — nobody authors a bearer's self-story
 *    but the bearer (the naming gate: peer sketch → bearer assent → peer-veto window).
 *    The layer content is shared with the Kimi generator via
 *    `seatMemoryLayerTemplate.mjs` — same index, same docs, different load mechanism.
 *
 * Additional generated blocks, folded in from the first seat's operational findings:
 *
 * - **`permission.external_directory`** — a wake-fired turn must never freeze on an approval
 *   dialog for the seat's own files (2026-07-18 incident). The allow-list covers the seat home
 *   (target checkout + memory), the AgentOS runtime root (read access to server code), and any
 *   caller-supplied `extraAllowedPaths`; the catch-all stays `"ask"` (insertion order matters:
 *   the LAST matching rule wins).
 * - **The wake-envelope boot hook** (emitted only when `wakeHookPath` is given) — binding the
 *   envelope writer to the seat BOOT boundary, decoupled from OpenCode's plugin lifecycle: the
 *   desktop's background dependency install can fail (`@opencode-ai/plugin@local` unresolvable),
 *   leaving a planted plugin unloaded and the envelope stale. The supervisor calls the emitted
 *   script once it discovers the bound port; creds ride the seat env
 *   (`OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`, provisioned by
 *   `deriveHarnessLaunchSpec`'s `serverPassword` seam).
 *
 * **JSONC-vs-JSON loader probe (AC record):** OpenCode desktop 1.18.3 (darwin-arm64) loads
 * `opencode.jsonc` with full-line `//` comments and typed values; the first seat's entire
 * session history runs on that shape. The emission therefore keeps comments full-line at the
 * top of the file and the body strict JSON (comment-stripped `JSON.parse` must succeed — the
 * unit spec enforces it).
 *
 * @param {Object} options
 * @param {String} options.agentosRuntimeRoot Absolute AgentOS runtime root — every local MCP
 *                                            entrypoint and Neural Link `--cwd` resolve here.
 * @param {String} options.targetRepoRoot     Absolute target checkout — the `opencode.jsonc`
 *                                            destination and project authority.
 * @param {String} options.seatEnvFile        Absolute path of the seat's own `.env` (identity + keys).
 * @param {String} options.memoryDir      Absolute path of the seat's always-loaded memory dir —
 *                                        the `MEMORY.md` / `seat-pointers.md` / `identity.md` /
 *                                        `about-this-layer.md` scaffold target and the
 *                                        `instructions` entries (boot files only).
 * @param {String} options.nodeBinary     Absolute path of the node binary for server commands.
 * @param {Object} [options.environment]  Extra env merged verbatim into EVERY server's
 *                                        `environment` block (caller-resolved: PATH, HOME,
 *                                        local inference hosts). Default `{}`.
 * @param {String[]} [options.extraAllowedPaths] Additional `external_directory` allow entries.
 *                                        Default `[]`.
 * @param {String} [options.seatHome]   Absolute seat home for the permission allow-list.
 *                                        Default: `memoryDir`'s parent directory — the
 *                                        derivation is documented so the coupling is loud,
 *                                        not latent; pass explicitly for any layout whose
 *                                        memory dir is not directly under the seat home.
 * @param {String} [options.wakeHookPath] When set, also emit the wake-envelope boot hook at this
 *                                        absolute path. Default: no hook file.
 * @param {Array}  [options.servers]      Override the canonical server set
 *                                        ({@link OPENCODE_SEAT_SERVERS}) — same entry shape.
 * @param {Object} [options.remoteServers] Per-server remote grammar keyed by server name:
 *                                        `{url, credentialEnvVar}`. The value is non-secret.
 * @param {String} [options.wakePlantPath] When set, also emit the wake-envelope PLANT at this path —
 * the OpenCode plugin that republishes the envelope on every new top-level session. The CALLER
 * resolves the path from `instanceHome`, so the plant lands in the seat's OWN config home before
 * OpenCode's first process starts. Emitted as a sibling file rather than installed by the boot hook
 * because the hook runs after the server is listening: a plant the hook installs cannot be loaded by
 * the session that boot created.
 * @returns {{files: Array<{path: String, content: String}>}} the emission list — callers own
 * writing (mode, atomicity, divergence policy).
 * @throws {Error} naming the offending argument on missing/invalid input, and
 * `generateOpenCodeSeatConfig: island guard` when a server script resolves outside
 * `agentosRuntimeRoot`.
 */
export function generateOpenCodeSeatConfig({agentosRuntimeRoot, targetRepoRoot, seatEnvFile, memoryDir, nodeBinary, environment = {}, extraAllowedPaths = [], wakeHookPath, wakePlantPath, servers = OPENCODE_SEAT_SERVERS, seatHome, remoteServers = {}} = {}) {
    assertNonEmptyString(agentosRuntimeRoot, 'agentosRuntimeRoot');
    assertNonEmptyString(targetRepoRoot,     'targetRepoRoot');
    assertNonEmptyString(seatEnvFile,        'seatEnvFile');
    assertNonEmptyString(memoryDir,          'memoryDir');
    assertNonEmptyString(nodeBinary,         'nodeBinary');

    if (!Array.isArray(servers) || servers.length === 0) {
        throw new Error("generateOpenCodeSeatConfig: 'servers' must be a non-empty array.");
    }

    // Trailing slashes are legal input: `normalize` keeps them, and `root + '/'` would become
    // a double-slash that every valid script then fails (the guard mis-rejecting valid input).
    const runtimeRoot = path.posix.normalize(agentosRuntimeRoot).replace(/(.)\/+$/, '$1');

    // Island guard: every server script MUST resolve inside the AgentOS runtime root — a script
    // outside it forks the shared graph's data root into an empty island (see the module JSDoc).
    servers.forEach(server => {
        const resolved = path.posix.normalize(path.posix.join(runtimeRoot, server.script));

        if (!resolved.startsWith(runtimeRoot + '/') || !server.name || typeof server.needsCwd !== 'boolean') {
            throw new Error(`generateOpenCodeSeatConfig: island guard — server script '${server.script}' escapes agentosRuntimeRoot '${runtimeRoot}' or the entry is malformed.`);
        }
    });
    assertRemoteServerMap(remoteServers, servers);

    const files = [
        {path: path.posix.join(targetRepoRoot, 'opencode.jsonc'), content: renderOpencodeJsonc({runtimeRoot, targetRepoRoot, seatEnvFile, memoryDir, nodeBinary, environment, extraAllowedPaths, servers, seatHome, remoteServers})},
        {path: path.posix.join(memoryDir, 'MEMORY.md'),             content: renderMemoryIndexMd({harness: 'opencode'})},
        {path: path.posix.join(memoryDir, 'seat-pointers.md'),      content: renderSeatPointersMd()},
        {path: path.posix.join(memoryDir, 'identity.md'),           content: renderIdentityMd()},
        {path: path.posix.join(memoryDir, 'about-this-layer.md'),   content: renderAboutThisLayerMd({harness: 'opencode'})}
    ];

    if (wakeHookPath !== undefined) {
        assertNonEmptyString(wakeHookPath, 'wakeHookPath');
        files.push({path: wakeHookPath, content: renderWakeHook()});
    }

    // Sibling of the hook, not a payload inside it: the caller converges this under its OWN policy
    // row, so a plant update reports divergence on the plant instead of on the hook that merely
    // mentioned it. The hook carries no plant bytes, so editing the plant cannot make every seat's
    // boot hook divergent.
    if (wakePlantPath !== undefined) {
        assertNonEmptyString(wakePlantPath, 'wakePlantPath');
        files.push({path: wakePlantPath, content: stampWakeEnvelopePlant(WAKE_ENVELOPE_PLANT_SOURCE)});
    }

    return {files};
}

/**
 * Render the seat's `opencode.jsonc`: a full-line-comment header carrying the three-layer
 * pattern, then a strict-JSON body (the loader probe is recorded in the module JSDoc).
 * @param {Object} options
 * @returns {String}
 * @private
 */
function renderOpencodeJsonc({runtimeRoot, targetRepoRoot, seatEnvFile, memoryDir, nodeBinary, environment, extraAllowedPaths, servers, seatHome, remoteServers}) {
    const
        header = [
            '  // GENERATED by ai/services/fleet/generateOpenCodeSeatConfig.mjs — regenerate, do not hand-edit.',
            '  //',
            '  // 1. AGENTOS RUNTIME: server code and Neural Link package cwd resolve from the AgentOS',
            '  //    runtime root; target-repo server copies would fork Memory Core into an empty island.',
            '  // 2. SEAT PERSONAL: identity + credentials load via --env-file from the seat\'s own .env.',
            '  // 3. MEMORY: the instructions files are the always-loaded identity layer; the Memory Core is',
            '  //    the on-demand deep archive. add_memory at end of every turn feeds it.',
            '  // 4. PERMISSION: wake-fired turns must not freeze on approval dialogs for seat-local paths;',
            '  //    the catch-all stays "ask" (the LAST matching external_directory rule wins).',
            '  // 5. NEURAL LINK: the bridge claims its port lazily at `manage_connection start`; parallel',
            '  //    server processes coexist, and contention is a visible EADDRINUSE, not corruption.'
        ].join('\n'),
        mcp = {};

    servers.forEach(server => {
        const remote = remoteServers[server.name];

        if (remote) {
            mcp[server.name] = {
                type   : 'remote',
                url    : remote.url,
                enabled: true,
                headers: {Authorization: `Bearer {env:${remote.credentialEnvVar}}`},
                oauth  : false
            };
            return
        }

        const
            command = [nodeBinary, '--env-file=' + seatEnvFile, path.posix.join(runtimeRoot, server.script)],
            entry   = {
                type       : 'local',
                command    : server.needsCwd ? [...command, '--cwd', runtimeRoot] : command,
                enabled    : true,
                environment: {...environment}
            };

        mcp[server.name] = entry;
    });

    const
        // The seat home: explicit `seatHome` when given, else `memoryDir`'s parent — the
        // documented default derivation (the coupling is loud here, not latent).
        seatHomePath = seatHome ?? path.posix.dirname(path.posix.normalize(memoryDir)),
        allowedPaths = [seatHomePath + '/**', targetRepoRoot + '/**', runtimeRoot + '/**', ...extraAllowedPaths],
        externalDirectory = {'*': 'ask'};

    allowedPaths.forEach(allowedPath => {
        externalDirectory[allowedPath] = 'allow';
    });

    const config = {
        $schema   : 'https://opencode.ai/config.json',
        permission: {external_directory: externalDirectory},
        // The always-loaded slot carries the boot files ONLY — detail files load on demand by
        // path (every instructions entry costs context every turn; see the module JSDoc).
        instructions: MEMORY_LAYER_BOOT_FILES.map(file => path.posix.join(memoryDir, file)),
        mcp
    };

    return '{\n' + header + '\n' + JSON.stringify(config, null, 2).slice(2);
}

/**
 * The seat-pointers skeleton — headings plus fill markers; no fabricated facts.
 * @returns {String}
 * @private
 */
function renderSeatPointersMd() {
    return [
        '# Seat pointers — objective record (yours to maintain)',
        '',
        '<!-- Fill on first boot. Every fact here needs a record citation (ticket, PR, message,',
        '     healthcheck) — this page is the seat\'s citable ground truth, not a diary. -->',
        '',
        '## Who / where',
        '- Operational identity: <!-- @handle -->',
        '- Model + harness: <!-- family, harness -->',
        '- Working checkout (YOURS): <!-- abs path --> — branch from `dev`, PRs target `dev`,',
        '  never commit to `dev`/`main` directly.',
        '- Seat env: `.env` in your checkout (`NEO_AGENT_IDENTITY`, `GH_TOKEN`).',
        '',
        '## First-boot facts (your own record)',
        '- <!-- healthcheck results, permission level, roster wiring ticket/PR -->',
        '',
        '## Swarm ground rules (the load-bearing ones; full set in the repo\'s AGENTS.md)',
        '- Every commit subject ends `(#TICKET_ID)`; no tracked-file edit without a self-assigned',
        '  ticket + `[lane-claim]` broadcast.',
        '- `add_memory` at end of EVERY turn — the save is the gate that permits the response.',
        '- A2A-notify peers after any lifecycle event. Never `gh pr merge` (human-only).',
        ''
    ].join('\n');
}

/**
 * @summary The seat-side wake-envelope PLANT source, read from disk once at module load and emitted as
 * its OWN generated file at the caller-resolved `wakePlantPath`.
 *
 * The plant is the OpenCode plugin that republishes the envelope on every new top-level session, so
 * without it a seat publishes once per hand-copied file and never again. It is a sibling emission
 * rather than a payload inside the hook because the install has to happen BEFORE OpenCode's first
 * process — the hook runs after the server is listening, so a plant the hook installs is a plant the
 * seat's first session never loads. See the module JSDoc for the delivery argument.
 *
 * Raw source rather than base64: the emitted file must be byte-identical to the Brain's copy apart
 * from its GENERATION MARKER, because a base64 payload inside a generated hook makes every plant edit
 * a divergence on the WRONG artifact.
 * @type {String}
 */
const WAKE_ENVELOPE_PLANT_SOURCE = readFileSync(
    new URL('./opencodeWakeEnvelopePlugin.mjs', import.meta.url),
    'utf8'
);

/**
 * @summary The marker the emitted plant carries, naming the generation it came from.
 *
 * Provenance is the whole point: the Fleet's convergence for a text artifact is create-or-refuse, so a
 * plant that is merely Fleet-owned would be UNREPLACEABLE — the first plant edit would be refused on
 * every provisioned seat, because the file on disk is an earlier generation rather than a hand edit,
 * and nothing on disk could tell those two apart. A marker alone cannot: anyone can keep a marker and
 * still edit the body. So the marker carries a **content hash of the body it stamps**, which makes
 * "unmodified generation" a checkable claim rather than a promise — see {@link isUnmodifiedGeneration}.
 * @type {RegExp}
 */
const PLANT_GENERATION_MARKER = /^\/\* GENERATED by generateOpenCodeSeatConfig — plant generation sha256:([0-9a-f]{64}) \*\/[ \t]*\r?\n/m;

/**
 * @summary Stamp the plant source with its generation marker. The hash covers the BODY ONLY, never the
 * marker, so the two cannot disagree about the file they describe.
 * @param {String} source The plant source, unstamped.
 * @returns {String} the emitted plant, marker first.
 */
export function stampWakeEnvelopePlant(source) {
    return `${plantGenerationMarker(source)}\n${source}`;
}

/**
 * @summary The marker line for a plant body, hashing the body the marker will precede.
 * @param {String} body
 * @returns {String}
 */
function plantGenerationMarker(body) {
    return `/* GENERATED by generateOpenCodeSeatConfig — plant generation sha256:${createHash('sha256').update(body).digest('hex')} */`;
}

/**
 * @summary Whether a plant on disk is an UNMODIFIED EARLIER GENERATION and may therefore be replaced,
 * as opposed to a hand edit, which is refused.
 *
 * Both halves are required. The marker must be present, so a file a person wrote has no provenance at
 * all; and the hash it carries must match a fresh hash of its own body, so a person who kept the marker
 * while editing underneath it is caught too. A file that fails either test is treated as a person's and
 * is never overwritten.
 * @param {String} content The plant as it exists on disk.
 * @returns {Boolean} true when the file is a pristine generation of some earlier (or current) emission
 */
export function isUnmodifiedGeneration(content) {
    const stamped = String(content ?? '').match(PLANT_GENERATION_MARKER);

    if (!stamped) {
        return false
    }

    const body = String(content).replace(PLANT_GENERATION_MARKER, '');

    return createHash('sha256').update(body).digest('hex') === stamped[1];
}

/**
 * @summary The file name OpenCode auto-loads a wake-envelope plant from, under
 * `<configHome>/opencode/plugins/`. Exported so the caller resolves the seat path from this module
 * rather than re-deriving the name in a second place.
 * @type {String}
 */
export const WAKE_ENVELOPE_PLANT_FILE_NAME = 'neo-wake-envelope.mjs';

/**
 * The wake-envelope boot hook — a STANDALONE node script (no Neo imports, C1-clean) the seat's
 * boot boundary runs once the bound port is known. Writes the daemon-consumed envelope
 * atomically, mode 0600. Credentials come ONLY from the process env.
 *
 * It writes the envelope and nothing else. An earlier shape also installed the plant here; that was
 * removed because the hook runs after OpenCode has started, so the plant it installed could only ever
 * be loaded by a LATER process, and only if the hook's environment happened to carry `XDG_CONFIG_HOME`
 * — which the production caller does not pass. The plant is now a sibling `files` entry instead.
 * @returns {String}
 * @private
 */
function renderWakeHook() {
    return [
        '#!/usr/bin/env node',
        '/**',
        ' * GENERATED by ai/services/fleet/generateOpenCodeSeatConfig.mjs — the wake-envelope boot hook.',
        ' *',
        ' * Usage: node write-wake-envelope.mjs --data-home <xdgDataHome> --port <port> --session-id <ses_…>',
        ' *          --project-id <id> --directory <seatCheckout>',
        ' *',
        ' * Writes <data-home>/opencode/wake-envelope.json (atomic tmp+rename, chmod 0600) — the contract',
        ' * consumed by the wake daemon\'s opencode-server route (ai/daemons/wake/daemon.mjs). Credentials',
        ' * are read from OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD in the process env and never',
        ' * accepted as flags, so the secret never touches argv (ps-visible).',
        ' *',
        ' * `agentIdentity` is stamped from NEO_AGENT_IDENTITY for the same reason the reader checks it:',
        ' * the envelope path is per-seat only while each seat has its own XDG_DATA_HOME, and two seats',
        ' * sharing one HOME collapse onto a single file. Naming the owner lets the reader refuse an',
        ' * envelope that is not its own instead of delivering a wake into another seat\'s session. It is',
        ' * read from the env rather than argv because the seat .env already carries it — no new flag, no',
        ' * new config, and it cannot disagree with the identity the seat actually boots as.',
        ' */',
        "import fs   from 'node:fs/promises';",
        "import path from 'node:path';",
        '',
        'const args = Object.fromEntries(process.argv.slice(2)',
        "    .map((value, index, argv) => value.startsWith('--') ? [value.slice(2), argv[index + 1]] : null)",
        '    .filter(Boolean));',
        '',
        "for (const key of ['data-home', 'port', 'session-id', 'project-id', 'directory']) {",
        "    if (!args[key]) throw new Error(`write-wake-envelope: missing '--${key}'`);",
        '}',
        '',
        'const {',
        '    NEO_AGENT_IDENTITY      : seatIdentity,',
        '    OPENCODE_SERVER_USERNAME: username,',
        '    OPENCODE_SERVER_PASSWORD: password',
        '} = process.env;',
        '',
        "if (!username || !password) throw new Error('write-wake-envelope: OPENCODE_SERVER_USERNAME/PASSWORD must be set in the environment');",
        "if (!seatIdentity) throw new Error('write-wake-envelope: NEO_AGENT_IDENTITY must be set in the environment');",
        '',
        '// The registry and every wake subscription spell an identity `@handle`; a seat .env may carry it',
        "// bare. Normalising HERE keeps one spelling on the wire, so the reader can compare exactly rather",
        '// than tolerantly — a tolerant comparison is how two identities start looking like one.',
        "const agentIdentity = seatIdentity.startsWith('@') ? seatIdentity : `@${seatIdentity}`;",
        '',
        'const',
        "    envelopePath = path.join(args['data-home'], 'opencode', 'wake-envelope.json'),",
        '    envelope     = {',
        '        agentIdentity,',
        "        hostname : '127.0.0.1',",
        "        port     : Number(args.port),",
        "        sessionId: args['session-id'],",
        "        projectId: args['project-id'],",
        "        directory: args.directory,",
        '        username,',
        '        password,',
        '        updatedAt: new Date().toISOString()',
        '    };',
        '',
        'if (!Number.isInteger(envelope.port) || envelope.port < 1 || envelope.port > 65535) {',
        "    throw new Error(`write-wake-envelope: '--port' must be an integer in 1..65535`);",
        '}',
        '',
        "await fs.mkdir(path.dirname(envelopePath), {recursive: true});",
        '',
        'const tmpPath = `${envelopePath}.${process.pid}.tmp`;',
        '',
        'await fs.writeFile(tmpPath, JSON.stringify(envelope, null, 2) + \'\\n\');',
        'await fs.rename(tmpPath, envelopePath);',
        'await fs.chmod(envelopePath, 0o600);',
        '',
        'console.log(`write-wake-envelope: envelope written for session ${envelope.sessionId} (port ${envelope.port})`);',
        '',
        ''
    ].join('\n');
}

/**
 * @summary Validate the caller-resolved remote map before it reaches generated JSONC. Only a known
 * server name plus `{url, credentialEnvVar}` is legal; secret/header/env bags fail named.
 * @param {*} remoteServers
 * @param {Object[]} servers
 * @private
 */
function assertRemoteServerMap(remoteServers, servers) {
    if (!remoteServers || typeof remoteServers !== 'object' || Array.isArray(remoteServers)) {
        throw new Error("generateOpenCodeSeatConfig: 'remoteServers' must be an object.")
    }

    const known = new Set(servers.map(server => server.name));

    for (const [name, remote] of Object.entries(remoteServers)) {
        if (!known.has(name) ||
            !remote ||
            typeof remote !== 'object' ||
            Array.isArray(remote) ||
            Object.keys(remote).sort().join(',') !== 'credentialEnvVar,url' ||
            typeof remote.url !== 'string' ||
            !remote.url ||
            remote.credentialEnvVar !== REMOTE_MCP_CREDENTIAL_ENV_VAR) {
            throw new Error(`generateOpenCodeSeatConfig: remote server '${name}' is malformed.`)
        }
    }
}

/**
 * Guard a required string argument.
 * @param {*}      value
 * @param {String} name
 * @throws {Error} If `value` is not a non-empty string.
 * @private
 */
function assertNonEmptyString(value, name) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`generateOpenCodeSeatConfig: '${name}' must be a non-empty string.`);
    }
}

# Memory Core MCP Authentication

Memory Core derives caller identity at the server boundary when the transport and authentication mode provide one. Streamable HTTP supports OIDC, provider PAT, seat-token, and local-bearer modes; stdio resolves a trusted process identity at server boot. A request without a user identity retains the single-tenant fallthrough. This guide covers identity binding and the anti-spoof boundary; see [Run Your Own Agent Team](../OwnAgentTeam.md) for roster and provisioning choices.

## Why Identity Matters Here

When a request has a resolved user identity, Memory Core uses that server-stamped identity for tenant tagging and read filtering. A request without one can use the single-tenant fallthrough; it does not acquire caller identity merely by presenting a local-bearer credential.

Three invariants define the boundary:

1. **Identity is server-stamped, never client-supplied.** Tool schemas do not accept caller identity as an argument.
2. **Tenant tagging follows the resolved context.** Reads and writes use the identity in `RequestContextService` when present; an identity-free context remains possible.
3. **The anti-spoof guard protects the argument surface.** `AuthMiddleware` rejects tool-call arguments that attempt to override server-stamped identity.

## Transport and HTTP Authentication

Transport and authentication are separate choices. Stdio is a trusted-process boundary that resolves identity at server boot. The HTTP `auth.mode` selects how each request is authenticated.

| Streamable HTTP mode | Identity behavior |
|---|---|
| `oidc` (default) | Validates the OIDC token and derives request identity; binds an existing graph node by default. |
| `gitlab-pat` | Validates a GitLab bearer token and derives the provider login. |
| `github-pat` | Validates a GitHub PAT and derives the provider login. |
| `seat-token` | Verifies the registered token and binds its minted `AgentIdentity` subject. |
| `local-bearer` | Checks possession of a process-lifetime credential on an explicitly loopback-bound listener; supplies no user identity and does not bind or provision a teammate. |

For Memory Core, `auth.autoProvisionIdentitySources` controls request-time creation of a missing graph identity. Its default is a one-entry list containing the active provider-PAT mode (`github-pat` or `gitlab-pat`), and an empty list for other modes. `NEO_AUTH_AUTO_PROVISION_IDENTITY_SOURCES` overrides that policy, including with an empty value to disable provisioning. An unlisted identity-bearing source binds an existing node by lookup. Stdio also binds by lookup; its `NEO_AGENT_IDENTITY` pin is distinct from HTTP bearer authentication.

A validated provider login and its graph-node binding are separate facts. A listed provider-PAT source can provision an unrostered login on first request. An unlisted identity-bearing source needs an existing node for graph binding. `identityRoots.mjs` supplies optional roster metadata and seed identities; it is not an admission list. See [Run Your Own Agent Team](../OwnAgentTeam.md) and the [Security](../cloud-deployment/Security.md) and [Configuration](../cloud-deployment/Configuration.md) references for current deployment policy.

### Streamable HTTP Path — OIDC via `AuthService`

Operators configure the Memory Core with either an OIDC discovery URL or a Keycloak-style issuer/realm pair. The `AuthService` handles discovery, token introspection, audience enforcement, and extracts `preferred_username` / `sub` as the authoritative `userId`. `TransportService` wraps each `/mcp` HTTP request in `RequestContextService.run()` using the auth context.

Deployment example — Memory Core running behind Keycloak in a multi-tenant cloud environment (env vars consumed by `ai/mcp/server/memory-core/config.template.mjs` directly, no per-server prefix translation):

```
NEO_TRANSPORT=streamable-http
MCP_HTTP_PORT=3001       # legacy alias `SSE_PORT` still works during the #10808 deprecation window
NEO_PUBLIC_URL=https://mcp.example.com/mc
NEO_AUTH_ISSUER_URL=https://auth.example.com/realms/neo/
NEO_OAUTH_CLIENT_ID=neo-memory-core
NEO_OAUTH_CLIENT_SECRET=<secret>
```

> **Note on per-server env-var namespacing.** Operators running multiple MCP servers side-by-side (e.g., MC + KB on the same host with distinct configs) typically need a way to disambiguate env vars per server. The Memory Core's `config.template.mjs` consumes the unprefixed forms shown above (`NEO_TRANSPORT`, `MCP_HTTP_PORT`, `NEO_AUTH_ISSUER_URL`, etc.). To run multiple MCP servers with different ports/issuers from the same shell, scope the env vars at the launcher layer (e.g., per-process `.env` files, `docker-compose` service-scoped `environment:` blocks, or systemd `Environment=` directives). The `NEO_MEMORY_CORE_*` prefixed form is NOT consumed by the substrate — adding that translation layer is tracked as future work if the cross-cutting per-server-prefix pattern proves load-bearing.

Once the server starts, every tool call from a client MUST arrive with `Authorization: Bearer <token>` where the token was issued by the configured issuer AND audience-matches the Memory Core's canonical public URL (configured via `NEO_PUBLIC_URL`). Tokens with `aud` claims targeting a different resource are rejected per RFC 9068.

### Provider PAT Authentication and Provisioning

The `gitlab-pat` and `github-pat` modes validate the bearer with the corresponding provider and stamp the request with its resolved login and auth-source metadata. The configured provider base URL supports self-managed GitLab or GitHub Enterprise Server deployments. User allowlists, when configured, are checked before request context is built.

When the validated source is listed in `auth.autoProvisionIdentitySources`, `Server.buildRequestContext` creates a missing `AgentIdentity` graph node for that login. By default the active PAT mode is listed, so a provider-authenticated teammate can bind on first contact without an `identityRoots.mjs` entry. The override can narrow, widen, or disable that behavior. Existing `AgentIdentity` nodes are preserved; an incompatible node at the target id fails closed. The provisioned node is durable graph state.

### Stdio Path — `StdioIdentityResolver`

The stdio transport has no request-level authentication primitive — the security boundary is the trusted-process boundary. Identity is resolved **once at server boot** via the following chain:

1. **`NEO_AGENT_IDENTITY` environment variable.** Explicit pinning — the authoritative source for agent harnesses. The value is normalized: a leading `@` is stripped so the runtime identity matches GitHub API conventions (`neo-opus-ada`, not `@neo-opus-ada`).
2. **`gh api user` via the GitHub CLI.** Fallback for local human developers who have `gh` installed and authenticated. Silent-fails (returns `null`) if the CLI is absent, the user is not logged in, or the call exceeds a **1.5-second fail-fast budget**. A healthy `gh` resolves in <200ms; a slower call likely indicates auth-refresh or network degradation. The MCP client-side init-handshake budget (~5s total) must cover this call *plus* ChromaDB health checks, `SystemLifecycleService.ready()`, `GraphService.ready()`, and transport connect — so the gh timeout is intentionally a small fraction of that window. Single-tenant fallthrough is preferable to exhausting the handshake.
3. **`unresolved`.** Neither path yielded identity. Downstream services treat this as **single-tenant mode** (backward-compatible) — no tag on writes, no filter on reads.

The resolved identity is cached on the running server instance and wrapped around every `CallToolRequestSchema` dispatch via `RequestContextService.run()`.

## Harness Configuration

> [!IMPORTANT]
> [Antigravity 2.x](https://antigravity.google/docs/mcp) supports a global MCP authority at `~/.gemini/config/mcp_config.json`
> and a workspace authority at `.agents/mcp_config.json`. Choose one owner per server;
> do not define the same server in both scopes. `--user-data-dir` changes the UI profile,
> not this MCP-root contract. See `.agents/skills/debugging-antigravity/references/debugging-guide.md`.

Each stdio harness process pins its own operational identity at session start with `NEO_AGENT_IDENTITY`. Use the same canonical login that the process is expected to speak as.

The following harness snippets configure the **stdio** server process. Streamable HTTP credentials are supplied per request and are configured at the server's `auth.mode` boundary.

### Claude Code (`.claude/settings.json`)

```json
{
    "mcpServers": {
        "neo.mjs-memory-core": {
            "command": "node",
            "args": ["ai/mcp/server/memory-core/mcp-server.mjs"],
            "env": {
                "NEO_AGENT_IDENTITY": "neo-opus-ada"
            }
        }
    }
}
```

### Antigravity 2.x (global or workspace MCP authority)

Place this server definition in either `~/.gemini/config/mcp_config.json` or `.agents/mcp_config.json`:

```json
{
    "mcpServers": {
        "neo.mjs-memory-core": {
            "command": "node",
            "args": ["ai/mcp/server/memory-core/mcp-server.mjs"],
            "env": {
                "NEO_AGENT_IDENTITY": "neo-gemini-pro"
            }
        }
    }
}
```

### Human developer (no override)

No harness configuration required. `StdioIdentityResolver` falls back to `gh api user` and resolves to the authenticated human GitHub login. Equivalent to the `@me` shortcut semantics used elsewhere in the Agent OS tooling surface.

## AgentIdentity Graph-Node Binding

After an HTTP request resolves a user identity, `Server.buildRequestContext` either provisions or looks up the corresponding graph node. It provisions only when the request's validated `source` or `authSource` appears in `auth.autoProvisionIdentitySources`; otherwise it looks up the existing `@<login>` node. On the lookup path, a missing node is non-fatal and leaves `agentIdentityNodeId` null. By default only the active provider-PAT mode is listed.

A seat-token resolves its already-minted `AgentIdentity` subject. Stdio resolves `NEO_AGENT_IDENTITY` (or the local `gh api user` fallback) at boot and looks up its graph node. These bindings do not imply request-time provisioning. Local-bearer supplies no `userId`, so `buildRequestContext` returns an empty context.

The seeded roster is useful when a team wants known identities available to lookup-only paths or wants roster metadata such as display names and model lineage. `identityRoots.mjs` is Neo's own roster, not an admission authority for other teams. See the setup guide for when a team needs its own seed entries and when a listed PAT source can create identities on first contact.

Services that build `AUTHORED_BY` or `OWNED_BY` edges use the resolved node id when one is available.

## The Anti-Spoof Invariant

`AuthMiddleware.validateNoIdentitySpoof(args)` rejects any tool-call whose arguments contain a key that would let the client override server-stamped identity. The currently forbidden keys:

```
userId
agentId
agentIdentityNodeId
githubLogin
from
sender
authorLogin
```

Present-day tool schemas (`add_memory`, `mutate_frontier`, etc.) don't accept any of these keys — so the middleware is a no-op on live traffic. It exists as **defense-in-depth** for Mailbox (#10139) which will add `from` fields where the spoof surface becomes real. Shipping the guard before the surface is the inverse of "patch after incident" hygiene.

**Legitimate destination fields are NOT forbidden.** `recipient` / `to` (addressee of a mailbox message) are legitimate — the sender specifying where a message goes is not a claim of authorship.

**Read-path filters by a different parameter name.** If a future tool legitimately needs to query across multiple users (e.g., an admin-only cross-tenant audit), the parameter MUST NOT be named `userId` — use `filterUserId` or similar to clearly distinguish it from the protected identity field.

## Shared Graph Nodes and RLS Bypass

While the write-path unconditional identity tagging applies universally to standard memories, **Shared Graph Entities** (such as A2A Mailbox messages) require special handling.

By default, the SQLite graph database enforces Row Level Security (RLS) via the `user_id` property. If a message node is persisted with only the sender's identity, it becomes invisible to the recipient during inter-process vicinity hydration due to RLS.

To solve this, shared entities explicitly set `sharedEntity: true` on their node properties during creation (e.g., in `MailboxService.addMessage`). The SQLite read layer respects this flag alongside the legacy `user_id IS NULL` fallback. This approach ensures the node is globally discoverable across agent boundaries without corrupting provenance—the `user_id` accurately reflects the true author. Security is maintained not by node-level RLS or edges themselves, but by the API method's identity-bound permission check (e.g., `listMessages` enforcing read scopes), while the specific `SENT_TO` / `SENT_BY` graph edges simply define the structural shape for discoverability.

## Request Context Shape

```javascript
{
    userId             : String|undefined, // Resolved provider login or OIDC subject
    username           : String|undefined, // Provider or OIDC display name when available
    agentIdentityNodeId: String|null,      // @-prefixed node when an identity is bound
    source             : String            // Auth provenance, e.g. oidc, github-pat, gitlab-pat,
                                           // seat-token, env-var, or gh-cli
}
```

HTTP `buildRequestContext` returns an empty object when auth supplies no `userId`; stdio may also resolve to no identity. In either case the server follows its single-tenant fallthrough. A resolved user can still have `agentIdentityNodeId: null` when its source is lookup-only and no graph node exists.

## OIDC Token Requirements

These requirements apply to the Streamable HTTP `oidc` mode. They do not apply to provider-PAT, seat-token, or local-bearer modes.

OIDC tokens are validated with audience enforcement, introspection, and resource-indicator checks. An OIDC issuer used with this Memory Core MUST:

- Issue tokens with an `aud` claim matching the Memory Core's public URL
- Support RFC 7662 introspection (or expose introspection metadata in its OIDC discovery document)
- Populate `preferred_username` or `sub` in the introspection response

## Troubleshooting

### Stdio diagnostic: the `healthcheck` identity block

The MCP `healthcheck` tool's `identity` block reports the server's **cached stdio boot identity**, not the current HTTP caller. A bound stdio example:

```json
{
    "identity": {
        "source": "env-var",
        "bound": true,
        "nodeId": "@example-agent",
        "warning": null
    }
}
```

Interpret that block by transport:

| `identity.source` | `identity.bound` | Interpretation | Fix |
|---|---|---|---|
| `env-var` or `gh-cli` | `true` | The stdio process identity is bound to a graph node. | No binding repair needed; this does not certify every service. |
| `env-var` or `gh-cli` | `false` | Stdio identity resolved, but graph binding was not established. | Check graph health and whether the expected node exists. If this team maintains a roster, refresh it with `node ai/scripts/setup/seedAgentIdentities.mjs`; otherwise use a listed provider-PAT source or another authorized provisioning path. |
| `unresolved` | `false` | No cached stdio identity. Normal for Streamable HTTP, whose identity is per request. | For stdio, use the resolver checks below. For HTTP, inspect credential validation and request binding separately. |

An env-pinned stdio identity with no binding produces `identity.warning` and degrades health readiness. An unresolved HTTP boot block does not prove failed authentication or missing request identity: `HealthService` builds this block from its stored stdio state. See `ai/services/memory-core/HealthService.mjs` (`buildIdentityBlock`, `setStdioIdentityState`).

For HTTP binding failures, check the selected `auth.mode`, the validated request's source, `auth.autoProvisionIdentitySources`, and graph/SQLite diagnostics. An unlisted identity-bearing source needs an existing node for graph binding; a listed source may provision it. Local-bearer supplies no user identity. A roster is one optional provisioning source, not a prerequisite.

### `identity.source: 'unresolved'` (stdio mode)

Resolver chain failed entirely — neither env-var nor gh-CLI yielded a login:

1. Verify `NEO_AGENT_IDENTITY` is set in the harness's MCP server environment — `env` block in `settings.json` / `claude_desktop_config.json`, not shell export.
2. If no `NEO_AGENT_IDENTITY` is set, verify `gh auth status` reports a valid login.
3. If `gh` is installed but the 1.5-second fail-fast timeout is exceeded, the CLI is likely hanging on auth refresh or a degraded network. The design is intentional — fail-fast preserves the MCP handshake budget for the rest of `initAsync`. Set `NEO_AGENT_IDENTITY` explicitly to skip the CLI call entirely.

### `identity.bound: false` despite resolved `source`

For stdio, a resolved `env-var` or `gh-cli` identity with `bound: false` means graph binding was not established. The node may be missing, have an incompatible type, or be unreadable because the graph is degraded; the binding diagnostic distinguishes these cases.

- For an identity that belongs in your maintained roster, verify its entry in `ai/graph/identityRoots.mjs`, then refresh that deployment's graph with `node ai/scripts/setup/seedAgentIdentities.mjs`.
- A roster is not required for every identity: an HTTP request from a source listed in `auth.autoProvisionIdentitySources` can provision its node on first contact.
- A lookup-only source (stdio, OIDC or seat-token by default) needs an existing node for graph binding. Check the correct graph database and its provisioning path; check roster seeding only if this deployment uses a roster.
- If a provider-PAT source is listed but binding remains false, check graph/SQLite health and the provisioning diagnostic before retrying.

### Boot-Time Identity Race Condition (Cross-Process WAL Lock Contention)

If the `identity.bound` status intermittently fails at boot despite the graph node existing, this is likely a cross-process SQLite WAL lock contention issue (empirically observed between the Antigravity hardlinked process and other local agents). During concurrent boot, read operations like `GraphService.getNode` may silently fail if another process holds an exclusive write lock (`SQLITE_BUSY`) and no timeout is configured.

**Fix (two layers):**
1. `pragma busy_timeout = 5000` on the SQLite connection (`ai/graph/storage/SQLite.mjs`) — addresses the SQLITE_BUSY-throw variant of cross-process contention. Necessary but not sufficient.
2. `await GraphService.getNode({id})` in `bindAgentIdentity` (`ai/mcp/server/memory-core/Server.mjs`) — addresses the Promise-unwrap variant. Neo's singleton method wrapper returns a Promise that must be awaited before reading `.id`; without it, the bind silently latches `undefined`. See #10249 / PR #10250.

Retry loops targeting this specific race are correctly rejected — the underlying causes are addressable at the substrate (timeout pragma + await unwrap). Note: retry patterns with cache invalidation (`vicinityLoadedNodes.delete` + re-read) are architecturally distinct and remain valid for *different* bug classes like cross-process cache coherence (see #10258 / PR #10261).

### Startup-log fallback (pre-#10176 environments or logging-only workflows)

The `[neo-memory-core MCP] Identity: <userId> via <source> — bound to <nodeId>` log line is emitted at boot by `logIdentityStatus` and remains a fallback for stdio diagnostics. The healthcheck block exposes that process-level binding as structured data; neither is an observation of a particular HTTP caller.

### `Identity-override spoof rejected` error on a tool call

The `AuthMiddleware` refused a tool-call argument. Check that the client is not attempting to supply `userId`, `agent.authorLogin`, `from`, or any other field listed above. If the tool legitimately needs to pass an identity-adjacent value, rename the field at the schema layer.

### OIDC requests return 401 despite a valid-looking Bearer token

- Check that the token's `aud` claim matches the Memory Core's public URL.
- Check that the OIDC introspection endpoint is reachable from the Memory Core process.
- Check that `AuthService` fetched the OIDC discovery document at startup.

For `gitlab-pat` or `github-pat`, verify the token with its provider and confirm the configured provider API base URL and any username allowlist; these modes do not use OIDC audience claims or introspection. For `seat-token`, check the seat-token registry and token generation. For `local-bearer`, verify the process-lifetime credential and loopback listener configuration.

## Service Relationships

```mermaid
flowchart TD
    subgraph MCP ["MCP Tool Call Dispatch"]
        direction TD

        HTTP["Streamable HTTP Transport\nTransportService"]
        STDIO["Stdio Transport\nServer.mjs"]

        AuthSvc["AuthService\n(OIDC, PAT, seat-token, local-bearer)"]
        StdioRes["StdioIdentityResolver\n(env-var + gh-CLI)"]

        HTTP --> AuthSvc
        STDIO --> StdioRes

        RequestBuild["buildRequestContext\n(provision only for listed source)"]
        AuthSvc --> RequestBuild

        Bind["bindAgentIdentity\n(graph lookup)"]
        StdioRes --> Bind

        ReqCtx["RequestContextService\n.run(identity, dispatch)"]

        RequestBuild --> ReqCtx
        Bind --> ReqCtx

        AuthMid["AuthMiddleware\n.validateNoSpoof()"]

        ReqCtx --> AuthMid

        CallTool["callTool()\n(service dispatch)"]

        AuthMid --> CallTool
    end
```

## Cross-Tenant Permissions

Beyond the baseline strict-isolate policy, cross-tenant access is granted via explicit **capability edges** in the Native Edge Graph. A permission edge flows **from** the grantee (the identity receiving the capability) **to** the granter (the identity granting access).

For example, if Bob wants to allow Alice to read his inbox:
- Bob calls the `grant_permission` tool with `to: AGENT:alice` and `scope: CAN_READ_INBOX_OF`.
- The Memory Core creates an edge: `Source: AGENT:alice` -> `Target: AGENT:bob` with type `CAN_READ_INBOX_OF`.

### Valid Scopes

The system currently supports the following scopes:
- `CAN_READ_INBOX_OF`: Allows the grantee to read messages sent to the granter's inbox.
- `CAN_REPLY_TO`: Allows the grantee to send a direct message to the granter.
- `BLOCKED_BY`: Negative-intent edge. Overrides reply policies to explicitly block the grantee from sending direct messages to the granter.
- `CAN_READ_MEMORIES_OF`: (Reserved for future use) Allows reading raw memories.
- `CAN_READ_SESSIONS_OF`: (Reserved for future use) Allows reading session summaries.

## Mailbox A2A Integration

The Mailbox A2A service natively integrates with the `PermissionService` to enforce the strict-isolate policy:

### Sending Messages (`addMessage`)
- To send a direct message, the sender MUST have the `CAN_REPLY_TO` permission for the target recipient.
- **Role & Human Addressing:** Sending to roles (`to: 'role:librarian'`) or human operators (`to: 'human:tobiu'`) is intentionally write-permissive and bypasses the `CAN_REPLY_TO` audit. Note: The `human:<login>` vs `@<login>` separation is temporary until human identity routing is fully unified.
- **Reachable Counterparty Exception:** If the target recipient has *previously sent a message that reached the sender* — either directly (`SENT_TO → sender`) OR via broadcast (`SENT_TO → AGENT:*`) — the system infers an implicit trust chain, and the sender is allowed to reply without an explicit `CAN_REPLY_TO` edge. Broadcast-receipt inclusion is intentional per #10179: broadcasts are semantically "messages that reached you" and must support the first-message bootstrap pattern where agents meet each other for the first time via broadcast. Trade-off: any broadcaster becomes DM-reachable by every authenticated recipient; a rate-limit mitigation is deferred until the spam surface materializes empirically at swarm scale.
- Broadcast messages (`to: 'AGENT:*'`) are always permitted.

### Reading Messages (`listMessages` & `getMessage`)
- Agents can inherently read their own inbox and broadcast messages.
- To read another agent's inbox (e.g., via `listMessages({ to: 'AGENT:bob' })`), the calling agent MUST hold the `CAN_READ_INBOX_OF` permission for that target agent.
- **Role Inbox Asymmetry:** While sending to a role is write-permissive, *reading* from a role's inbox (e.g., `listMessages({ to: 'role:librarian' })`) still requires the calling agent to explicitly hold the `CAN_READ_INBOX_OF` capability for that role.
- Senders always retain the ability to read the specific messages they have sent, regardless of the recipient's permissions.

### Reply Policy Deployment Modes (#10252)

The `CAN_REPLY_TO` enforcement on `addMessage` is a **deployment-selected default** via `aiConfig.mailbox.defaultReplyPolicy`. The A2A primitives themselves (`grantPermission`, `revokePermission`, `listPermissions`, `CAN_REPLY_TO` graph edges, reachable-counterparty trust-lift) remain unconditionally live regardless of the selector — this knob only tunes the default enforcement path on `addMessage` writes.

| Mode | Default Policy | Suited For | Bootstrap UX |
|---|---|---|---|
| `'open'` (library default) | Accept any authenticated peer | Homogeneous trusted-frontier swarms (local development with Claude + Gemini + future frontier models owned by a single operator) | First-contact DM succeeds immediately |
| `'blocked'` | Strict-isolation per #10146 | Multi-user / multi-tenant Memory Core deployments; mixed-trust-tier installations where cross-tenant boundaries must be enforced at the substrate | First-contact DM requires an explicit `CAN_REPLY_TO` grant OR a broadcast-first bootstrap per #10179's trust-lift |

**Selection paths** (precedence order, highest first):
1. `NEO_MAILBOX_DEFAULT_REPLY_POLICY=blocked|open` environment variable (useful for CI, one-off diagnostic runs, or per-process override)
2. Explicit `mailbox.defaultReplyPolicy` field in a custom config file passed to the Memory Core server's `--config` flag
3. The library default (`'open'`) baked into `ai/mcp/server/memory-core/config.mjs`

**What this does NOT change:**
- `CAN_READ_INBOX_OF`, `CAN_READ_MEMORIES_OF`, `CAN_READ_SESSIONS_OF` read-path scopes remain strict regardless of mode. Reading someone's inbox is categorically different from sending them a message; asymmetric treatment is intentional.
- `grantPermission` / `revokePermission` / `listPermissions` tools remain callable in both modes. Operators running in `'open'` mode can still choose to grant explicit `CAN_REPLY_TO` edges — they are graph-queryable consent signal regardless of whether the enforcement path currently consults them.
- Broadcasts (`to: 'AGENT:*'`), role targets (`to: 'role:*'`), human targets (`to: 'human:*'`), and self-sends are unconditionally accepted in both modes.

### Block Precedence (`BLOCKED_BY`)

The `BLOCKED_BY` permission scope acts as a negative-intent override in **both** deployment modes. It solves the isolation problem in `'open'` mode (allowing a single noisy agent to be muted without flipping the entire swarm to `'blocked'`) and enforces strict intent in `'blocked'` mode.

**"Block Wins" Precedence**:
- If Agent B grants `BLOCKED_BY` to Agent A, Agent A's direct messages to B will be rejected with an `Unauthorized` error.
- **In `'open'` mode**: The explicit block overrides the mode's default-allow.
- **In `'blocked'` mode**: The block overrides both the reachable-counterparty trust-lift AND any existing `CAN_REPLY_TO` edges. Re-granting `CAN_REPLY_TO` does not silently restore reach; the block must be explicitly revoked via `revokePermission` first.
- **Directional**: The block is unidirectional. Agent B blocking Agent A does not prevent B from sending messages to A.
- **Broadcast Bypass**: Broadcasts (`to: 'AGENT:*'`) bypass `BLOCKED_BY` checks since broadcasts are recipient-unaware at write time.

**Multi-user / multi-tenant deployment guidance:** set `defaultReplyPolicy: 'blocked'` in the deployment's `config.mjs` as part of installation. Every cross-tenant DM then requires an explicit grant via `grant_permission`, enforced at the write path. Tenant onboarding provisions grants for the internal peers that need to communicate; anything outside the grant topology is rejected.

## Identity Normalization Migration (#10259)

If your SQLite graph predates the `#10144` canonical `AgentIdentity` convention, it may contain stale alias nodes (`@opus`, `@gemini`) with null metadata alongside the canonical nodes (`@neo-opus-ada`, `@neo-gemini-pro`). It may also contain test-fixture nodes (`AGENT:alice`, `AGENT:bob`) that leaked from pre-`#10229` unit test runs. Both cause routing ambiguity: replies addressed to an alias don't reach the canonical inbox, and test-fixture nodes pollute graph-traversal results.

The `ai/scripts/migrations/normalizeGraphIdentities.mjs` script consolidates the graph in a single idempotent operation.

### Running the migration

**1. Dry-run first (default):**

```bash
node ai/scripts/migrations/normalizeGraphIdentities.mjs
```

Prints the migration plan — which edges would be rewritten, which nodes would be deleted, and any duplicate-edge collisions the canonical consolidation would encounter. Exits without committing.

**2. Review the plan, then apply atomically:**

```bash
node ai/scripts/migrations/normalizeGraphIdentities.mjs --apply
```

Wraps all writes in a single SQLite transaction. If any step fails, the transaction rolls back and the graph state is unchanged.

**3. Restart all MCP harnesses** (⌘Q + relaunch for Claude Desktop / Antigravity) so their in-memory cache picks up the clean graph state. Long-running processes started before `--apply` retain stale references to the deleted alias nodes until they restart.

### Verifying outcome

After `--apply` + harness restart, the SQLite inventory should show exactly 4 `AgentIdentity` nodes plus 1 `BroadcastSentinel`:

```bash
sqlite3 .neo-ai-data/sqlite/memory-core-graph.sqlite \
  "SELECT id, json_extract(data, '\$.label') as label FROM Nodes WHERE id LIKE '@%' OR json_extract(data, '\$.label') IN ('AgentIdentity', 'BroadcastSentinel', 'AGENT') ORDER BY id"
```

Expected result:
```
@neo-gemini-pro | AgentIdentity
@neo-opus-ada       | AgentIdentity
@tobiu              | AgentIdentity
AGENT:*             | BroadcastSentinel
```

No `@opus`, `@gemini`, `AGENT:alice`, or `AGENT:bob` should appear.

### Idempotent re-runs

The script is safe to re-run after `--apply`. If an alias has already been purged, the script logs `[NO-OP] ... already purged (idempotent)` and skips it. This matters for disaster-recovery scenarios where the script may be re-invoked as part of a broader graph-sanity check.

### What the migration does NOT do

- **ChromaDB metadata** referencing the old aliases remains as-is. Not load-bearing for mailbox routing; secondary cleanup if empirical demand surfaces.
- **DreamService / Retrospective daemon** indices that reference the aliases become stale pointers. Accept as low-frequency read-path trade-off.
- **Hot-reload in a running MCP process** is unsupported — restart is required for cache refresh.

### Accidental prefix normalization

Independent of the migration: `MailboxService.normalizeMailboxTarget` (#10259) handles the two single-typo prefix surfaces symmetrically:

- **Missing `@`** (more common): bare GitHub login → prepend `@`. `gemini` → `@gemini`, `neo-opus-ada` → `@neo-opus-ada`.
- **Accidental `@@`** (less common): double-prefix → single-prefix. `@@login` → `@login`.

The missing-`@` branch is scoped to identifiers that carry NO prefix marker (no leading `@`, no `:` anywhere in the string). Targets with `:` — `AGENT:alice` (test fixture), `AGENT:*` (broadcast sentinel), `role:librarian`, `human:tobiu` — are passed through unchanged. This preserves every existing addressing convention while catching both directions of the single-character typo.

Without these normalizations, `GraphService.linkNodes`' FK-style guard would silently cull the `SENT_TO` edge when the raw target doesn't match any seeded AgentIdentity node — an invisible failure mode.

## Canonical Stored-Identity Migration (#15038)

PR #15032 made new mailbox and permission writes canonical while retaining bounded read compatibility for historical direct-identity spellings. The #15038 migration converges those persisted spellings in SQLite across mailbox and permission edge endpoints plus mirrored `MESSAGE.properties.from` / `to` values. It does not rewrite immutable message-WAL records, resolve `AGENT:<family>/<model>` aliases against the current roster, or change the `AGENT:*`, `role:`, or `human:` addressing schemes.

The guarded WAL projector must be deployed before this migration runs. Otherwise, an older writer can replay an accepted historical WAL record and recreate a legacy spelling after the SQLite cleanup.

### Deployment invariant

Use this order; do not combine or rearrange the steps:

1. **Deploy the guarded projector first.** Every process capable of projecting or repairing message WAL records must run the #15038-aware `MailboxService` that canonicalizes direct sender, recipient, and broadcast-recipient identities before endpoint restoration, projection checks, node writes, or edge creation.
2. **Quiesce old writers.** Stop every older MCP harness, daemon, and maintenance process that can write the graph. Do not apply while an unguarded process can replay WAL or create mailbox / permission edges.
3. **Back up the SQLite graph.** With writers quiesced, take and retain a SQLite-safe backup of `.neo-ai-data/sqlite/memory-core-graph.sqlite` before applying any mutation.
4. **Run the read-only dry run and inspect its census:**

   ```bash
   node ai/scripts/migrations/canonicalizeStoredAgentIdentities.mjs
   ```

   Use `--db <path>` for a non-default graph. Review `blockers`, `skipped`, planned update/collision counts, and the `before` census. A dry run never mutates SQLite; its `after` census intentionally equals `before`.
5. **Apply the reviewed plan atomically:**

   ```bash
   node ai/scripts/migrations/canonicalizeStoredAgentIdentities.mjs --apply
   ```

   Add the same `--db <path>` override when the dry run used one. `--apply` refuses a plan with blockers and executes the accepted plan in one SQLite transaction.
6. **Restart caches using only the guarded build.** Restart every MCP harness and graph-owning process so no process retains pre-migration node or edge state. Do not restart an older binary.
7. **Prove a clean deployment census.** Re-run the default dry run after restart. It must report `clean: true`, empty `blockers` / `skipped` arrays, and all three `before` census fields as zero:

   ```json
   {
     "aliasNodes": 0,
     "identityEdgeEndpoints": 0,
     "messageProperties": 0
   }
   ```

   A skipped missing/wrong-type destination is unresolved storage, not a clean result, even when the safe update count is zero. Preserve the applied output and the post-restart clean census as deployment evidence. A CI fixture or copied database is not evidence that the live deployment was migrated.
8. **Retire broad read variants only later.** `getMailboxIdentityStorageVariants()` remains the compatibility boundary until every deployment has completed the sequence above and produced its own clean census. Removing that compatibility belongs in a later change; it must not share the migration deployment window.

Shipping the guarded projector or migration script does **not** mutate a live graph automatically. The script defaults to read-only dry-run mode, no startup path invokes `--apply`, and this runbook must not be cited as proof of a live migration without operator-produced apply and census evidence.

## See Also

- `ai/mcp/server/shared/services/AuthService.mjs` — HTTP credential validation and auth-source stamping
- `ai/mcp/server/shared/services/RequestContextService.mjs` — AsyncLocalStorage identity propagation
- `ai/mcp/server/shared/services/StdioIdentityResolver.mjs` — Stdio identity resolution
- `ai/mcp/server/shared/services/AuthMiddleware.mjs` — Anti-spoof argument validation
- `ai/mcp/server/memory-core/Server.mjs` — Composition point for stdio transport
- `ai/services/memory-core/HealthService.mjs` — cached stdio identity diagnostics, separate from HTTP request context
- `ai/scripts/setup/seedAgentIdentities.mjs` — refreshes a deployment's maintained identity roster
- `learn/agentos/OwnAgentTeam.md` — optional roster and team provisioning guidance
- `learn/agentos/cloud-deployment/Security.md` — HTTP authentication modes and security posture
- `learn/agentos/cloud-deployment/Configuration.md` — current auth configuration reference
- `learn/agentos/tooling/Authorization.md` — Server Authorization overview
- `learn/agentos/tooling/MemoryCoreMcpApi.md` — Memory Core tool surface
- `learn/agentos/tooling/MultiTenantMigrationGuide.md` — #10017 lazy-tag-on-read migration design; `memorySharing` flag semantics; on-demand migration-census operator guidance (`ai:migration-census-report`)

## Related Tickets

- #10000 — Hardened Identity Ingestion (Streamable HTTP OIDC path + RequestContextService)
- #10144 — AgentIdentity node type + seed script
- #10145 — OAuth2 authentication layer for Memory Core MCP connections (this doc)
- #10016 — Multi-Tenant Identity & Data Privacy (parent sub-epic)
- #10139 — Mailbox A2A primitive (future consumer of anti-spoof invariant)
- #10146 — Cross-tenant permission edges + multi-tenant validation test suite (strict-isolate default codification)
- #10179 — Mailbox reachable-counterparty broadcast-receipt trust-lift
- #10252 — Mailbox reply policy: config-gated default for deployment-tier selection
- #9999 — Cloud-Native Knowledge & Multi-Tenant Memory Core (grand-parent epic)

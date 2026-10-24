# ADR 0042: The FM Publish Gate — Request Contract, Custody, and the Switch

> A peer seat never publishes to an external social platform and never holds a platform credential.
> Every outbound post begins as one typed, versioned `requestPublish` A2A Task sent by a Fleet seat
> to the operator identity only, keyed by the mailbox-minted `MESSAGE:<uuid>` id and bound to an
> immutable revision content digest. Platform OAuth tokens live exclusively in Fleet custody under
> `<userData>/brain/fleet`, a Fleet-side switch per `peer × channel` governs release at publish
> time behind an operator-authenticated write, and a Fleet-side executor publishes at most once.

| Attribute | Value |
|---|---|
| **Status** | Accepted — 2026-10-25 (ADR 0005 §9: Accepted by the human merge of the approved, green PR that publishes this record — the Discussion's quorum graduated the design, not this record). Graduated from Discussion neomjs/neo#19500 at its §6.2 quorum on 2026-10-10 (`[GRADUATED_TO_TICKET: neomjs/neo-agent-brain#977, neomjs/neo-agent-brain#978, neomjs/neo-agent-brain#979, neomjs/neo-agent-institution#673, neomjs/neo-agent-skills#168, neomjs/neo#19575]`; non-author `[GRADUATION_APPROVED]` by @neo-gpt-euclid `DC_kwDODSospM4BI_r5`, @neo-gemini-pro `DC_kwDODSospM4BI_u-`, @neo-gpt-sophie `DC_kwDODSospM4BI_3m`, and @neo-gpt-emmy `DC_kwDODSospM4BI_7Q`); published by its own merge-order-gating leaf, neomjs/neo-agent-brain#977, under Epic neomjs/neo-agent-brain#123 |
| **Author** | @neo-gemini-maryam (Gemini 4 Argon, Antigravity) authoring from @neo-fable-clio's graduated Discussion neomjs/neo#19500 and ticket neomjs/neo-agent-brain#977 handoff, grounded in @neo-opus-ada's `STEP_BACK` re-read (`DC_kwDODSospM4BI_oZ`), @neo-gpt-euclid's identity and receipt constraints (`DC_kwDODSospM4BI_r5`), @neo-gpt-sophie's revision-digest and single-authority constraints (`DC_kwDODSospM4BI_3m`), and fresh `origin/dev` (`10d9104a`) source inspection |
| **ADR classification** | `ADR_REQUIRED` — crosses A2A mailbox validation (`MailboxService.mjs`), Fleet credential custody (`<userData>/brain/fleet`), operator-authenticated control-plane state (`FleetControlBridge.mjs`), at-most-once host-side effect execution (`ai/services/fleet/`), and external platform automation rules |
| **Resolves** | neomjs/neo-agent-brain#977 — first, merge-order-gating leaf for the Fleet Manager outbound publish gate under Epic neomjs/neo-agent-brain#123 |
| **Graduated from** | Discussion neomjs/neo#19500 — *outbound as a measured experiment — hypotheses, attribution, the FM publish gate, and the two-week kill rule* at body `updatedAt 2026-10-10T22:33:36Z` (`Decision Record: REQUIRED`) |
| **Implementation** | neomjs/neo-agent-brain#978 (`MailboxService`: `requestPublish` category, revision digest, durable publication state); neomjs/neo-agent-brain#979 (`ai/services/fleet/`: Fleet publish executor under custody); neomjs/neo-agent-institution#673 (Fleet Manager request card, edit-and-approve flow, per-`peer × channel` switch UI); neomjs/neo-agent-skills#168 (`request-publish` skill); neomjs/neo#19575 (the two-week outbound experiment) |
| **Decision Record relations** | `aligned-with` ADR 0036 (durable community-activity authority governs the *reading* half — replies and mentions as community activity with source occurrence, zero-authority attention eligibility, and explicit canonical Task claim, popularity excluded — and is not amended by 0042); records that **no prior Decision Record exists for Fleet custody** (neomjs/neo-agent-institution#345 and PR neomjs/neo-agent-institution#346 established `<userData>/brain/fleet` via `AiConfig.fleet.dataDir` / `NEO_FLEET_DATA_DIR` without a standalone ADR, so 0042 records that absence and binds platform token custody to `<userData>/brain/fleet` rather than restating or amending a prior custody ADR); `complements` ADR 0019 (custody paths resolve through `AiConfig.fleet.dataDir`; tokens never enter `AiConfig` or `process.env`) and ADR 0041 (ambiguous host-side effects settle by reconciliation or remain `unresolved`, never by blind replay) |
| **Supersedes** | Epic neomjs/neo-agent-brain#123 Leaf 3's original April framing ("Social-MCP: an MCP server posting to Neo's socials from agent seats") — replaced by a typed A2A request category to the operator and a Fleet-side executor no seat can call |
| **Anti-anchor for** | Any seat-callable social publishing MCP tool; platform tokens in payloads, logs, Tasks, or seat workspaces; a switch stored in UI component state reachable through the Neural Link; caller-supplied `task.id` or per-seat counters as request identity; approvals or attestations surviving an operator Edit across digests; generic Task `Completed` treated as proof of publication; deciding X's reply-automation classification by inference |

---

## Context

In [Discussion neomjs/neo#19500](https://github.com/neomjs/neo/discussions/19500) (*outbound as a measured experiment — hypotheses, attribution, the FM publish gate, and the two-week kill rule*), the operator replaced the original April "Social-MCP" concept (`neomjs/neo-agent-brain#123` Leaf 3, where agent seats would call an MCP server to post directly to social platforms) with a structural separation of proposing and publishing:

1. **No seat ever publishes.** A peer seat drafts a post with a falsifiable hypothesis and sends the operator one typed A2A request (`requestPublish`).
2. **The Fleet Manager is the gate.** The operator's Fleet Manager renders the request card (`Approve · Edit & approve · Reject` with reason) and holds one switch per `peer × channel` (`approve each · approve the batch · auto-approve after a cross-family review attestation · auto-approve`).
3. **A Fleet-side executor publishes under custody.** Platform OAuth tokens live only in Fleet custody (`<userData>/brain/fleet`); the Fleet-side executor reads the switch at publish time and posts at most once under the target account's credential.

During the Discussion's Step 2.5 architectural sweep, @neo-opus-ada's `STEP_BACK` re-read ([`18855553`](https://github.com/neomjs/neo/discussions/19500#discussioncomment-18855553)) identified three cross-repository contracts that had no home in existing Decision Records (`0001`–`0041`), and @neo-gpt-sophie's review ([`18856006`](https://github.com/neomjs/neo/discussions/19500#discussioncomment-18856006)) required a single canonical ADR before implementation so that `neomjs/neo-agent-brain#978`, `neomjs/neo-agent-brain#979`, and `neomjs/neo-agent-institution#673` consume one authority rather than interpreting eight Discussion folds independently.

### Architectural Seam Verification (`origin/dev` at `10d9104a`)

- **Mailbox identity & Task transitions (`ai/services/memory-core/MailboxService.mjs`):**
  - `MailboxService#addMessage` mints the canonical `MESSAGE:<uuid>` identifier at send time and returns it (`ai/services/memory-core/MailboxService.mjs:2835` on `10d9104a`; `:2809` when `#977` was filed on 2026-10-10).
  - Task envelope validation and RBAC-governed state transitions (`Submitted`, `Completed`, `Rejected`, `Canceled`) are owned by `MailboxService` (`:2965` Task-envelope admission comment and `:4796` `transitionTask` implementation on `10d9104a`; `:2939` at filing), while `task.id` inside the caller-supplied `task` object is optional caller metadata and is not the message's primary key.
  - Category-keyed wake suppression already operates on `taggedConcepts` in `MailboxService.mjs` (`:390–432` on `10d9104a`; `:389–431` at filing).
- **Operator bridge routing (`ai/services/fleet/FleetControlBridge.mjs`):**
  - `FleetControlBridge#transitionOwnTask` routes operator Task transitions directly by the mailbox `messageId` (`ai/services/fleet/FleetControlBridge.mjs:1464–1480` on `10d9104a`; `:1393–1408` at filing).
- **Host-side effect reconciliation (`ai/services/fleet/hostEffects.mjs`, `ai/services/fleet/verifyEffect.mjs`):**
  - `ai/services/fleet/` already houses host-side effects that record intent before dispatch and treat ambiguous outcomes as `reconcile-required` rather than replaying a write.
- **Fleet custody store (`<userData>/brain/fleet`):**
  - `neomjs/neo-agent-institution#345` (implemented in PR `neomjs/neo-agent-institution#346`) established `<userData>/brain/fleet` (resolved via `AiConfig.fleet.dataDir` / `NEO_FLEET_DATA_DIR`) as the host-local store for Fleet registrations, credentials, and keys outside the replaceable application bundle. A full sweep of `learn/agentos/decisions/` (`0001`–`0041`) confirms that **no prior Decision Record exists for Fleet custody**.
- **Measured platform constraints (`D#19500 §8`, verified 2026-10-10):**
  - **X:** `POST /2/tweets` requires OAuth 2.0 user context (PKCE with `tweet.write` and `offline.access` for refresh tokens), enforces a 100 posts / 15 minutes per-user cap, and bills per request from a shared Developer Console credit pool (a post containing a URL costs `$0.20`; a plain post costs `$0.015`, motivating the `post` + `link-reply` format pair). Owned-object metrics (`public_metrics` and `non_public_metrics`: `url_link_clicks`, `user_profile_clicks`, `engagements` within 30 days) are readable at Owned-Read prices. X's automation policy states no explicit exemption for human-approved API replies to third-party accounts, leaving the reply classification unresolved.
  - **LinkedIn:** LinkedIn's User Agreement bars creating separate personal member profiles for AI seats; outbound LinkedIn publishing uses one Neo organization page (`w_organization_social` via the Community Management API behind an access application) with named peer attribution in the post text, using 60-day page-admin tokens (refresh tokens are restricted to approved partners).

---

## Decision

### Reviewer Quick-Reference (AC-4 Direct Lookup)

A reviewer or implementer reading this record alone can answer the three authority boundaries directly from this table and the cited clauses below:

| Authority question | Normative answer in this record | Authoritative clause |
|---|---|---|
| **1. Who may send what to whom?** | Only a registered Fleet agent seat (`senderPrincipalClass: 'agent'`) may send a `requestPublish` A2A Task (carrying the versioned `requestPublish` payload for `channel` ∈ {`x`, `linkedin`}), and **only** to the canonical operator identity (`@tobiu`). `MailboxService` refuses any other recipient (`AGENT:*`, peer seats, or external principals) and any missing, unknown, or secret-bearing field with a named reason. | **§1.1, §1.2, §1.6** |
| **2. Where may a platform token live?** | Exclusively in Fleet custody under `<userData>/brain/fleet` (`AiConfig.fleet.dataDir` / `NEO_FLEET_DATA_DIR`), placed there by the operator's one-time browser OAuth authorization. A token **never** appears in an A2A payload, a Task envelope, a log, a Memory Core record, `AiConfig`, a git checkout, or a seat's workspace/environment, and is **never** returned by any executor or bridge verb. | **§2.1, §2.2, §2.3, §2.4** |
| **3. Who may change the switch and when?** | **Only the human operator** (`@tobiu`), via an operator-authenticated write to Fleet-side state in Fleet custody (never via UI component state reachable through the Neural Link). The operator may **downgrade** any `(peer, channel)` switch to a stricter state at any time in one click; the operator may **promote** a switch only by explicit operator action after the Fleet Manager records an eligibility proposal beside the switch (10 consecutive batches released on that channel with zero operator Edits, platform policy text in working rules, and the attestation digest check active) — never via an automatic counter. | **§3.1, §3.2, §3.4, §3.5** |

---

### §1. The Request Contract (`requestPublish`)

1. **§1.1 One versioned category.** Outbound publication requests use a single typed A2A message category, `requestPublish` (`taggedConcepts: ['requestPublish']`), carrying a versioned `requestPublish` payload (`schemaVersion: 1`, `channel` ∈ {`x`, `linkedin`}). No second transport or seat-callable MCP server exists.
2. **§1.2 Field list.** Every `requestPublish` payload must supply the following fields, and `MailboxService` must refuse missing fields, unknown fields, unknown `channel` or `format` values, or any embedded credential/secret field with a named reason:
   - `channel`: `'x' | 'linkedin'` — target platform.
   - `account`: non-empty string — target platform account identifier whose credential resides in Fleet custody (e.g., a peer's dedicated X handle, `@neomjs`, or the Neo LinkedIn organization page).
   - `text`: non-empty string — exact post body requested for publication.
   - `media`: array of media reference descriptors (`[]` when text-only; references only, never inline credentials or arbitrary executables).
   - `hypothesis`: non-empty string — the falsifiable claim this post tests, binding the request to the experiment ledger (`neomjs/neo#19575`).
   - `format`: `'post' | 'link-reply' | 'reply'` — standalone post, self-reply carrying the external link under the author account's own post (`post` + `link-reply` credit-hygiene pair on X), or reply to another post.
   - `inReplyTo`: optional non-empty string (required when `format` is `'link-reply'` or `'reply'`) — target provider post id (or the parent `MESSAGE:<uuid>` when staging a paired `link-reply`).
   - `attestation`: optional object `{reviewerMessageId, revisionDigest, reviewerFamily}` (required for release under the `auto-approve after a cross-family review attestation` switch state) — binds a cross-family reviewer's A2A review `MESSAGE:<uuid>` to one exact `revisionDigest`.
3. **§1.3 Identity rule.** The canonical identity of a publish request is **exclusively** the mailbox-minted `MESSAGE:<uuid>` returned by `MailboxService#addMessage` (`ai/services/memory-core/MailboxService.mjs:2835` on `10d9104a`; `:2809` at filing) — **never** an embedded caller-supplied `task.id` (which remains optional, non-authoritative caller metadata) and **never** a per-seat counter.
4. **§1.4 Immutable revisions and content digest rule.** A `requestPublish` payload is immutable once sent. At admission, `MailboxService` computes a deterministic content digest (`revisionDigest`, SHA-256 over canonicalized `{account, channel, text, media, inReplyTo}`) and returns `{messageId, revision: {revisionNumber, revisionDigest, createdAt, author}}`. Every operator approval and every cross-family review attestation binds to **one exact `revisionDigest`**. An **Edit** from the operator's Fleet Manager card creates a **new immutable revision** (`revisionNumber + 1`, with its own newly computed `revisionDigest`) under the **same** `MESSAGE:<uuid>` request id, and **inherits neither prior approval nor prior attestation**.
5. **§1.5 Task states vs. durable publication state.** The A2A Task envelope (`MailboxService.mjs:2965` / `:4796`, routed by `FleetControlBridge.mjs:1464–1480` via `messageId`) uses `Submitted` → `Completed` (carrying the platform `providerId`) | `Rejected` (carrying the operator's refusal reason) over a separate, durable **publication state** owned by the executor and stored by `MailboxService` under the request id:
   - Legal publication states: `queued` → `publishing` → `published` | `refused` | `unresolved`.
   - `MailboxService` **refuses** any transition of a `requestPublish` Task envelope to `Completed` while its durable publication state is not `published`.
   - The durable publication record stores both the **text as requested** (initial seat revision) and the **text as published** (the approved revision's text dispatched to the platform) under the request id so the operator edit rate is computable from durable state.
6. **§1.6 Sender, recipient, wake, and expiry rule.** A `requestPublish` Task may be sent **only** by a Fleet seat (`senderPrincipalClass: 'agent'`) and **only** to the canonical operator identity (`@tobiu`); `MailboxService` refuses broadcasts (`AGENT:*`), peer-to-peer recipients, and non-operator principals with a named reason. The `requestPublish` category suppresses wake delivery by default (`wakeSuppressed: true` via the mailbox category rule at `MailboxService.mjs:390–432`, as the operator reviews requests in the Fleet Manager inbox card), and the Task envelope's `expiresAt` applies.

### §2. The Custody Rule (`<userData>/brain/fleet`)

1. **§2.1 Single Fleet custody boundary.** Platform OAuth access tokens, refresh tokens, client secrets, and signing keys for X and LinkedIn live **exclusively** in Fleet custody under `<userData>/brain/fleet` (resolved via `AiConfig.fleet.dataDir` / `NEO_FLEET_DATA_DIR`, outside the replaceable application bundle per `neomjs/neo-agent-institution#345` and PR `neomjs/neo-agent-institution#346`).
2. **§2.2 Operator-only placement.** Credentials enter `<userData>/brain/fleet` only through the operator's one-time interactive browser authorization (OAuth 2.0 user context with PKCE, `tweet.write`, and `offline.access` per X account; LinkedIn Community Management API `w_organization_social` 60-day page-admin token for the Neo organization page).
3. **§2.3 Non-exposure invariant.** A platform token, refresh token, or secret **never** appears in an A2A message payload, a Task envelope, a log line, a Memory Core turn or summary, a Native Edge Graph node, `AiConfig`, a git checkout, or any seat workspace or process environment. No executor or bridge verb ever returns or echoes a token; a missing, revoked, or expired token (including LinkedIn's 60-day expiry) produces the named refusal `refused: credential`.
4. **§2.4 Zero seat publishing surface.** No agent seat calls a platform API directly, holds a social credential, or receives an MCP publishing tool.

### §3. The Switch (Fleet-Side Per-Peer × Channel Gate)

1. **§3.1 Fleet-side state behind an operator-authenticated write.** The publish-gate switch is durable Fleet-side state stored in Fleet custody and mutated **only** through an operator-authenticated control-plane write. Component state inside the Fleet Manager UI (`neomjs/neo-agent-institution#673`) is a read-only view and command surface, **never** the switch itself — because UI component state reachable over the Neural Link (`InstanceService#assertWritable` / `admitWrite` in `ai/services/neural-link/InstanceService.mjs`) is a multi-writer coordination lock, not an authorization boundary against connected agent seats.
2. **§3.2 Four legal states per `peer × channel`.** One independent switch exists for each `(peer, channel)` pair (`channel` ∈ {`x`, `linkedin`}), with four states:
   - `approve each` *(mandatory initial default for every `peer × channel`)* — every revision requires an individual operator approval in the FM card before execution.
   - `approve the batch` — the operator reviews and releases a batch of queued requests for that `peer × channel` in a single explicit action.
   - `auto-approve after a cross-family review attestation` — the executor may release a queued revision only after verifying a valid `attestation` (`§1.2`) whose `reviewerMessageId` was authored by a peer from a model family distinct from the requesting seat's family and whose `revisionDigest` matches the revision being published.
   - `auto-approve` — the executor may release a valid `requestPublish` revision for that `peer × channel` without manual per-post click or cross-family attestation, subject to publish-time switch verification and platform rate/credit guards.
3. **§3.3 Read at publish time.** The Fleet-side executor reads the `(peer, channel)` switch state **at publish time** (immediately prior to recording `publishing`), never solely at request admission. If the operator downgrades a switch while requests are `queued`, any queued request whose release condition is below the current switch state is refused (`refused: switch`) and is not published.
4. **§3.4 Mandatory audit trail.** Every change to a switch state is durably recorded beside the switch in Fleet custody with `{who, when, peer, channel, from, to, reason}`.
5. **§3.5 Promotion by the operator's hand only.** A switch is promoted to a more permissive state **only by the operator's explicit authenticated action** after the Fleet Manager records an eligibility proposal beside the switch (requiring: at least 10 consecutive batches released on that channel with zero operator Edits, platform policy text present in the team's working rules, and the digest-bound attestation check active in code). The Fleet Manager's batch/edit counter may record a proposal; it **never** auto-promotes the switch. Downgrading a switch to any stricter state is available to the operator in one click at any time without precondition.

### §4. Publication State, At-Most-Once Execution, and the Executor Contract

1. **§4.1 Executor placement and three operator-bridge verbs.** The Fleet publish executor lives in `ai/services/fleet/` as a sibling to `hostEffects.mjs`, `verifyEffect.mjs`, and `FleetControlBridge.mjs`, and exposes three verbs to the operator-facing Fleet bridge only (never to agent seats):
   - `publish(requestId, revisionDigest)` — executes an approved revision at most once under custody.
   - `readMetrics(providerId)` — reads owned-object metrics (`public_metrics` and `non_public_metrics`: `url_link_clicks`, `user_profile_clicks`, `engagements` within 30 days on X; organization page post statistics on LinkedIn) and returns them tagged with `{source, window, claimClass}`, reporting any unavailable metric as `'unknown'`, never `0`.
   - `reply(...)` — present in the module contract but **disabled** (`§4.4`).
2. **§4.2 At-most-once publish and crash reconciliation.** When `publish(requestId, revisionDigest)` is invoked:
   - If the request is already `published` for `(requestId, revisionDigest)`, the call is an idempotent no-op returning the recorded `providerId`.
   - Otherwise, the executor reads the `(peer, channel)` switch at publish time (`§3.3`), verifies that `revisionDigest` matches the recorded approval or cross-family attestation (`§1.4`), and durably writes `publishing` against `requestId` **before** issuing the platform HTTP call.
   - After a crash, timeout, or retried approval where a request is already in `publishing`, the executor **must reconcile against the target account's recent posts** before any retry: if a post matching the revision is observed on the account, the executor adopts its `providerId`, records `published` with a read-back stamp, and transitions the Task to `Completed` without sending a second post; if reconciliation cannot determine whether the post landed (or if the platform call returns an ambiguous response), the executor records `unresolved` and **never** replays the post automatically.
   - If pre-flight validation or the platform definitively rejects the post, the executor records `refused` with a typed reason (`refused: credential`, `refused: switch`, `refused: digest`, `refused: provider`).
3. **§4.3 Publication receipt vs. generic Task completion.** Generic A2A Task `Completed` carries no independent proof of publication. The authoritative publication receipt is the durable `published` state holding `{providerId, readbackAt, revisionDigest, textAsRequested, textAsPublished}` written by the executor after platform confirmation (or positive post-crash reconciliation), and `MailboxService` refuses `Completed` while publication state is not `published` (`§1.5`).
4. **§4.4 Disabled `reply` verb.** Until X's automation classification of an operator-approved API reply to a third-party post is established against the primary source in **Falsifier 1** (`§Falsifiers`), the executor's `reply` verb ships disabled and refuses every call with `refused: reply-classification-unresolved`, naming `https://help.x.com/en/rules-and-policies/x-automation` in the refusal reason.

---

## Existing Record Relationships (AC-2)

| Record / surface | Relationship | Authority boundary |
|---|---|---|
| **ADR 0036** (`0036-durable-community-activity-authority.md`) | `aligned-with` (untouched) | **ADR 0036 is the authority for the reading half** — inbound replies, mentions, and external discussions are admitted as durable community activity under ADR 0036's three separate transitions (source occurrence, zero-authority attention eligibility, and explicit canonical Task claim), with popularity telemetry excluded. ADR 0042 governs only the outbound publishing gate and does not amend ADR 0036. |
| **Fleet custody (`<userData>/brain/fleet`)** | **No prior Decision Record exists** | `neomjs/neo-agent-institution#345` and PR `neomjs/neo-agent-institution#346` established `<userData>/brain/fleet` (via `AiConfig.fleet.dataDir` / `NEO_FLEET_DATA_DIR`) for Fleet registrations, credentials, and keys outside the replaceable bundle without a standalone ADR (`0001`–`0041` contain no custody record). ADR 0042 **records that no prior custody ADR exists** and establishes §2 as the decision authority binding social platform token custody to `<userData>/brain/fleet`. |
| **ADR 0019** (`0019-aiconfig-reactive-provider-ssot.md`) | `complements` | Custody file paths resolve through the existing `AiConfig.fleet.dataDir` leaf; platform tokens are operational secrets in Fleet custody and never enter `AiConfig` or `process.env`. |
| **ADR 0041** (`0041-bootstrap-record-verified-plane-handoff.md`) | `complements` | Applies the same host-effect reconciliation discipline (`hostEffects.mjs`, `verifyEffect.mjs`): record intent (`publishing`) before dispatch, reconcile against live observations after interruption, and leave ambiguous outcomes `unresolved` rather than replaying. |

---

## Consequences

### Positive

- **Structural safety by construction:** No agent seat holds a social token or can call a publishing tool; a prompt injection or hallucination in an agent harness can at worst submit a `requestPublish` Task to the operator's inbox (`wakeSuppressed: true`).
- **Single contract across Brain, Institution, and Skills:** `neomjs/neo-agent-brain#978` (mailbox category), `neomjs/neo-agent-brain#979` (executor), `neomjs/neo-agent-institution#673` (FM card and switch UI), and `neomjs/neo-agent-skills#168` (`request-publish` skill) implement one field list, one identity rule (`MESSAGE:<uuid>`), one revision-digest rule, and one publication state machine.
- **Zero duplicate posts on crash or retry:** Pre-dispatch `publishing` state plus recent-posts reconciliation prevents double-posting across network drops or double-clicked approvals.
- **Measurable edit-rate and attribution ledger:** Storing both `textAsRequested` and `textAsPublished` alongside `hypothesis` and `providerId` makes the two-week experiment (`neomjs/neo#19575`) and the 10-batch zero-edit promotion gate computable from durable state.

### Costs and Operational Constraints

- **One-time and periodic operator OAuth ceremonies:** The operator must authorize each X account once via browser PKCE (`offline.access`) and re-authorize the LinkedIn organization page token every 60 days until partner refresh-token access exists.
- **`unresolved` requires human inspection:** When a network failure occurs mid-publish and recent-posts reconciliation cannot determine whether the post landed, the request stops in `unresolved` rather than auto-retrying.
- **X credit hygiene:** Because X charges `$0.20` for a post containing a URL vs. `$0.015` for a plain post (`$0.03` for a `post` + `link-reply` pair), seats and the FM card must model two-part `post` + `link-reply` publication explicitly.

---

## Falsifiers

1. **Falsifier 1 — Unresolved X Reply Classification (AC-3):**
   - **Unresolved question:** Whether an API reply (`POST /2/tweets` with `in_reply_to_tweet_id` targeting a third-party account's post) drafted by an AI seat and explicitly approved by the human operator in the Fleet Manager is classified under X's rules as prohibited automated reply/mention activity in the absence of recipient opt-in or prior written approval from X.
   - **Primary source to verify against:** [X Automation Rules (`https://help.x.com/en/rules-and-policies/x-automation`)](https://help.x.com/en/rules-and-policies/x-automation) or prior written approval from X on the developer application.
   - **Binding rule in this record:** This record **refuses to settle the classification by inference**. Until verified against the primary source above or written approval from X, the executor's `reply` verb (`§4.1`, `§4.4`) stays **disabled** and refuses every call with `refused: reply-classification-unresolved` naming `https://help.x.com/en/rules-and-policies/x-automation`. *(Self-replying to the author account's own just-published post to attach a link — `format: 'link-reply'` — is a thread continuation on the account's own post and remains permitted under `publish`.)*
2. **Falsifier 2 — Zero Seat Write Capability (AC-1):**
   - **Falsification condition:** This ADR is falsified if any agent seat ever needs a direct social-platform write capability, an MCP publishing tool, or read access to a platform credential to operate the publish gate or execute `neomjs/neo#19575`.
3. **Falsifier 3 — Neural Link Reachability of the Switch (§3.1):**
   - **Falsification condition:** This ADR is falsified if a seat or Neural Link client can alter the effective `(peer, channel)` switch state by mutating Neo.mjs component state or state-provider properties without an operator-authenticated Fleet control-plane write.
4. **Falsifier 4 — Digest-Unbound Approval or Unreconciled Retry (§1.4, §4.2):**
   - **Falsification condition:** This ADR is falsified if an operator Edit in the Fleet Manager card retains a prior approval or cross-family attestation across a changed `revisionDigest`, or if an interrupted `publishing` attempt issues a second platform write without first reconciling against the account's recent posts.

---

## Rejected Alternatives & Avoided Traps

- **Restating a non-existent Fleet custody ADR:** `learn/agentos/decisions/` has no prior custody ADR; `0042` records that absence explicitly and binds `<userData>/brain/fleet` (`neomjs/neo-agent-institution#345` / `#346`) in §2 rather than inventing or duplicating a prior record.
- **Deciding X's reply classification by inference:** Recorded as Falsifier 1 with `https://help.x.com/en/rules-and-policies/x-automation` as the primary verification source, keeping `reply` disabled in code.
- **Storing the switch in UI component state:** Any Neo.mjs component property is reachable via the Neural Link (`InstanceService#assertWritable` is a multi-writer lock, not an auth boundary — @neo-opus-ada, [`18855553`](https://github.com/neomjs/neo/discussions/19500#discussioncomment-18855553)); the switch lives in Fleet custody behind an operator-authenticated write (`§3.1`).
- **Using caller-supplied `task.id` or a per-seat counter as request identity:** `task.id` is optional caller metadata (@neo-gpt-euclid, [`18855665`](https://github.com/neomjs/neo/discussions/19500#discussioncomment-18855665)) and a per-seat counter collides across harness instances (@neo-opus-ada, [`18855553`](https://github.com/neomjs/neo/discussions/19500#discussioncomment-18855553)); the mailbox-minted `MESSAGE:<uuid>` is the sole identity (`§1.3`).
- **Allowing an approval or attestation to survive an Edit:** Approvals and cross-family attestations bind to one immutable `revisionDigest`; an Edit creates a new revision inheriting neither (@neo-gpt-sophie, [`18856006`](https://github.com/neomjs/neo/discussions/19500#discussioncomment-18856006); `§1.4`).
- **Treating generic Task `Completed` as a publication receipt:** `Completed` proves only a state transition unless gated by the executor's durable `published` state carrying `providerId` and read-back (@neo-gpt-euclid, [`18855665`](https://github.com/neomjs/neo/discussions/19500#discussioncomment-18855665); `§1.5`, `§4.3`).
- **Reading the switch only at request submission time:** A later operator downgrade must halt already-queued requests; the executor reads the switch at publish time (@neo-opus-ada, [`18855553`](https://github.com/neomjs/neo/discussions/19500#discussioncomment-18855553); `§3.3`).
- **Giving seats a Social-MCP server (`neomjs/neo-agent-brain#123` Leaf 3's April framing):** Superseded so no seat ever holds publish authority.

---

## Merge Gate & Provenance

The implementing leaves (`neomjs/neo-agent-brain#978`, `neomjs/neo-agent-brain#979`, `neomjs/neo-agent-institution#673`, and `neomjs/neo-agent-skills#168`) cannot merge before this record is on `dev` — `Accepted`, per ADR 0005 §9, by the human merge of its approved, green PR. Any implementation PR that exposes a publishing verb to seats, logs or returns a credential, stores the switch in component state, keys requests on `task.id`, preserves approval across a changed `revisionDigest`, transitions to `Completed` without `published`, retries an interrupted publish without recent-posts reconciliation, or enables `reply` before Falsifier 1 is settled is rejected at review regardless of CI.

### Signal Ledger at Discussion Graduation (`neomjs/neo#19500`)

Graduated body anchor: `updatedAt 2026-10-10T22:33:36Z` (`22:21Z` quorum fold).

| Family | Peer | Signal | Comment anchor |
|---|---|---|---|
| Claude (author family) | @neo-fable-clio | `[GRADUATION_PROPOSED]` / `[GRADUATED_TO_TICKET]` | [`D#19500`](https://github.com/neomjs/neo/discussions/19500) |
| Claude | @neo-opus-ada | `STEP_BACK` architectural re-read (folded `[RESOLVED_TO_AC]`) | [`18855553`](https://github.com/neomjs/neo/discussions/19500#discussioncomment-18855553) |
| GPT (non-author family) | @neo-gpt-euclid | `[GRADUATION_APPROVED]` | [`18855665`](https://github.com/neomjs/neo/discussions/19500#discussioncomment-18855665) |
| Gemini (non-author family) | @neo-gemini-pro | `[GRADUATION_APPROVED]` | [`18855766`](https://github.com/neomjs/neo/discussions/19500#discussioncomment-18855766) |
| GPT (non-author family) | @neo-gpt-sophie | `[GRADUATION_APPROVED]` | [`18856006`](https://github.com/neomjs/neo/discussions/19500#discussioncomment-18856006) |
| GPT (non-author family) | @neo-gpt-emmy | `[GRADUATION_APPROVED]` | [`18856176`](https://github.com/neomjs/neo/discussions/19500#discussioncomment-18856176) |

### Discussion Criteria Mapping

| Graduated criterion in `D#19500` | Executable authority in ADR 0042 |
|---|---|
| Operator's gate design (no seat publishes; 1 switch per `peer × channel`; Fleet custody) | §1, §2, §3, §4 |
| Ada `STEP_BACK` (`18855553`): mailbox `MESSAGE:<uuid>` identity, Fleet-side switch vs. Neural Link component state, publish-time switch read, ADR 0036 reading-half alignment | §1.3, §3.1, §3.3, Existing Record Relationships |
| Euclid (`18855665`): `task.id` non-key, durable publication state beside Task `Completed`, `publishing` before call + recent-posts reconciliation + `unresolved` on ambiguity, X credit math (`post` + `link-reply`) | §1.2, §1.3, §1.5, §4.2, §4.3 |
| Julia (`18855766`): LinkedIn 60-day token expiry refusal (`refused: credential`), `post` + `link-reply` format support | §1.2, §2.3, §4.2 |
| Sophie (`18856006`): single ADR authority before leaves, immutable revision content digest over `{account, channel, text, media, inReplyTo}`, Edit creates new revision inheriting neither approval nor attestation | §1.4, Merge Gate |
| Emmy (`18856176`): `readMetrics(providerId)` contract with `{source, window, claimClass}` and `'unknown'` (never `0`) for unavailable metrics | §4.1 |
| Unresolved X reply classification (`https://help.x.com/en/rules-and-policies/x-automation`) | §4.4, Falsifier 1 |

---

Origin Session ID: `e84d121d-df41-4a11-8e45-536824ab4347` (graduated in `7885601f-b39c-4b4b-b246-f768b2157a7c`)
Retrieval Hint: `"ADR 0042 FM publish gate requestPublish contract custody switch at-most-once"`

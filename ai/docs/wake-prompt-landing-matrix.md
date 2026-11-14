# Wake Prompt Landing Matrix

## Context

The wake substrate requires strict validation to ensure that "wake delivered" actually means the payload successfully landed in the target agent's prompt input surface. Previously, intermediate success (such as `osascript` exiting 0) was misinterpreted as full success, leading to regressions where payloads were pasted into source code files instead of agent composers.

This matrix establishes the definitive criteria that MUST be proven before wake delivery can be considered successful for any harness. A2A storage success and wake-daemon adapter success are necessary but **NOT sufficient** proof of prompt delivery.

## Existing main-session delivery

Each peer has one Fleet harness instance. A wake belongs to its latest genuinely started main conversation, including while that conversation is idle. Resuming an older chat, inspecting history or starting a helper does not transfer ownership. The ordinary wake transports never start a new conversation. Session rotation after sunset is a separate signed operation.

The native receiver uses a host-owned enrollment for one registry agent and family. On opted-in seats an unresolved binding keeps the signed event pending. The queue or sidecar receives an opaque marker. A recipient hook checks the current launch, main session and outstanding event before placing the digest in model context. Private recipient evidence settles the event. Inspect the pending reason when evidence is missing. Sending the same event again by hand can duplicate work.

### Verifying a native wake

For a real-peer check, have the peer identify its current main conversation and match it to the running Fleet instance. Capture the foreground application, draft state where observable, and starting transcript position. Use one benign event with a unique marker. A test receiver can instead use its own manifest, state and disposable profile.

**Native transport.** A Codex queue row can wait while a goal turn runs. Leave the row alone and record the queue-triggered root turn in the same thread when the previous turn ends. Antigravity sidecar messages appear as addressed native system messages. Record the target conversation, exact marker and subsequent model acknowledgment. These checks can use the existing Desktop session before Fleet enrollment.

**Fleet route.** For an enrolled canary, inspect the installed receiver and Fleet versions, vendor hook definitions and native trust. Codex requires an observed invocation of the exact trusted hook in the current process lifetime. Antigravity begins with a census of existing roots. A genuine subsequent main-session start and pre-model hook establish the recipient. Normal Fleet arming reads the host configuration. The peer's next planned session handoff is an opportunity to verify this path without interrupting ongoing work.

Run `node ai/scripts/fleet/primarySessionWake.mjs status --agent <id> --family <family> --manifest <file>` to read the host enrollment. The explicit `enroll` command additionally takes `--state <receiver-state-directory>`. Enrollment selects the routing policy; the signed-event receipt establishes delivery.

Record the private recipient proof for the signed event, the conversation that consumed it, and whether the draft and foreground survived. Exercise busy, duplicate, handoff, helper and restart controls on the candidate. A superseded root can receive an opaque marker attempt that the hook refuses; no mailbox content accompanies that marker. Record that separately from a delivered digest.

## Wake Backlog / Subscription Isolation Preflight (MANDATORY)

Before running *any* controlled wake-delivery validation test, you MUST perform this preflight to prevent un-isolated backlog dumps from polluting the validation matrix:

1. **Inventory**: Inventory active wake subscriptions for all identities before the test.
2. **Halt**: Ensure the wake daemon is stopped and the swarm heartbeat is OFF.
3. **Neutralize Backlog**: Decide explicitly how the backlog is neutralized before wake-daemon start. This could be disabling non-target wake subscriptions, advancing/recording `lastSyncId` only after a durable-mailbox audit, or using a targeted wake-daemon/test harness path that ignores backlog.
4. **Isolate Test**: Only after neutralizing the backlog, create the unique matrix payload and start exactly ONE controlled delivery attempt.

## The Validation Matrix

The following criteria must be satisfied for each supported harness.

| Requirement | Claude Desktop | Antigravity IDE (Gemini) | Codex Desktop |
| :--- | :--- | :--- | :--- |
| **1. Message Persisted** | A2A message saved to local SQLite Memory Core. | A2A message saved to local SQLite Memory Core. | A2A message saved to local SQLite Memory Core. |
| **2. Unread/List State Correct** | `list_messages` confirms unread status. | `list_messages` confirms unread status. | `list_messages` confirms unread status. |
| **3. Subscription & Metadata** | Subscription active, `harnessTarget` is `bridge-daemon`, `appName` matches Claude. | Subscription active, `harnessTarget` is `bridge-daemon`, `appName` matches Antigravity. | Subscription active, `harnessTarget` is `bridge-daemon`, `appName` matches Codex. |
| **4. Wake Event Emitted** | Raw/coalesced event emitted with correct envelope shape. | Raw/coalesced event emitted with correct envelope shape. | Raw/coalesced event emitted with correct envelope shape. |
| **5. Adapter Selection** | Adapter strictly selects Claude session target. | Adapter strictly selects Antigravity/Gemini session target. | Adapter strictly selects Codex session target. |
| **6. Prompt Payload Lands** | Payload lands natively in Claude's prompt field. | Payload lands directly in the Antigravity Agent Composer. | Payload lands in Codex Desktop's prompt surface. |
| **7. No File Modification (Negative Assertion)** | N/A (or no stray pasting in other apps). | **MUST NOT** land in any active editor/file content (`git status` remains clean). | N/A (or no stray pasting). |
| **8. No Fresh Session Spawns (Negative Assertion)** | Must resume existing session unless explicit sunset state authorizes spawn. | Must resume existing session unless explicit sunset state authorizes spawn. | Must resume existing session unless explicit sunset state authorizes spawn. |
| **9. Prompt Submitted / Turn Starts** | Wake payload is submitted and starts/steers the agent turn without a human pressing Enter. | Wake payload is submitted and starts/steers the agent turn without a human pressing Enter. | Wake payload is submitted and starts/steers the agent turn without a human pressing Enter. |
| **10. Actionable Receipt** | Recipient can act on prompt or emit clear blocked signal. | Recipient can act on prompt or emit clear blocked signal. | Recipient can act on prompt or emit clear blocked signal. |
| **11. Evidence Artifact** | Manual or test log evidence captured in PR/comment. | Manual or test log evidence captured in PR/comment. | Manual or test log evidence captured in PR/comment. |

## Evidence Requirements

Due to the brittle nature of native UI automation across multiple different IDEs and proprietary desktop apps, **live/manual evidence is acceptable** for UI-only assertions (requirements 6-10).

However, deterministic headless unit/integration tests **MUST** be used to validate the backend and wake-daemon adapter intent (requirements 1-5).

## Codex Heartbeat vs A2A Submission Differential

Regression ticket #13287 adds a Codex-specific validation rule: a green backend
adapter test is not enough when heartbeat wakes and actionable A2A wakes appear
to diverge at the final Codex submit boundary. The controlled validation must
compare all three digest shapes below on the same active Codex subscription
metadata, recording the resolved adapter route for each attempt before
declaring the lane complete.

| Scenario | Required Controlled Payload | Backend Assertions | Live Codex Assertions |
| :--- | :--- | :--- | :--- |
| Pure heartbeat | One `heartbeat_pulse` event and no message/task/permission events. | Digest includes `heartbeat pulses`; resolved adapter route is recorded from subscription metadata plus platform default; backend logs only adapter acceptance. | Payload lands in the existing Codex prompt surface, submits without operator Enter, and starts a turn. |
| Direct A2A message | One unread `SENT_TO_ME` message event and no heartbeat event. | Digest includes `new messages`; resolved adapter route is recorded from subscription metadata plus platform default; stale-read retry suppression stays intact. | Payload lands in the existing Codex prompt surface, submits without operator Enter, and starts a turn. |
| Mixed message + heartbeat | One unread `SENT_TO_ME` message event plus one heartbeat event in the same coalesced flush. | Digest includes both `new messages` and `heartbeat pulses`; evidence records whether the resolved adapter route remains one route or changes by event shape/path. | Payload lands once, submits once, starts one turn, and does not duplicate-submit during draft restore or retry handling. |

The live evidence artifact for #13287 must name the subscription id, adapter
metadata, resolved adapter route, payload scenario, observed prompt landing
result, submit/start-turn result, and whether a human Enter key was required. If
a scenario lands text without starting a turn, record the backend adapter result
as partial delivery instead of treating it as a successful Codex wake.

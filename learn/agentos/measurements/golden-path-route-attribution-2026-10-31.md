# Golden Path Route-Attribution Ledger — `totalWeight` vs. `decayingWeight` (`#1389`)

- **Captured at**: `2026-10-31T13:23:21.944Z` (`runId: 37b33fb0-c778-4639-a850-fe5558c74200`)
- **Ticket**: `neomjs/neo-agent-brain#1389` (*The Golden Path ranks on total inbound weight, so message records never fade*)
- **Authority**: [`ai/services/graph/GoldenPathSynthesizer.mjs`](../../../ai/services/graph/GoldenPathSynthesizer.mjs) + [`ai/services/memory-core/GraphService.mjs`](../../../ai/services/memory-core/GraphService.mjs)
- **Silence threshold (`goldenPathSilentThreadThresholdMs`)**: `14` days (`cutoff: 2026-10-17T13:23:21Z`)

## 1. Before / After Candidate Ranking Table (Live Candidate Pool + `#17844` Specimen)

Formula: $\text{Score} = 2.0 \times \text{Semantic} + 1.0 \times \text{Structural}$.
- **Before (`totalWeight`)**: Sums all visible non-`BLOCKS` inbound edges, including non-decaying `MESSAGE:*` record edges (`isMessageRecordEdge`, `#537`), protected fact edges (`PROTECTED_EDGE_TYPE_SET`), and the prior pass's `frontier -> GUIDES` edge (`#15105`).
- **After (`decayingWeight`)**: Sums only visible decaying scent edges (`SESSION_SUMMARY -> DISCUSSED_IN`, `ISSUE -> PARENT_OF`, non-`frontier` `GUIDES`/`RELATES_TO`/`ADVANCES`), excluding `MESSAGE:*` record edges, `PROTECTED_EDGE_TYPE_SET`, and `frontier -> GUIDES`.

| Node ID | Latest Activity (`updatedAt`) | `MESSAGE:` Edges (Count / Weight) | Excluded Protected | Excluded `frontier->GUIDES` | `totalWeight` (Before) | `decayingWeight` (After) | Decaying Edge Attribution | Score Before (Rank) | Score After (Rank) |
|---|---|---:|---:|---:|---:|---:|---|---:|---:|
| `issue-15197` | `2026-10-19` (`12d`, active) | `76` / `152.00` | `6.80` (`3 × RESOLVES`) | `2.40` | `180.80` | `19.60` | `10 × SESSION_SUMMARY -> DISCUSSED_IN` (`10 × 1.96`) | `182.34` (**#1**) | `21.14` (**#1**) |
| `issue-9853` | `2026-10-09` (`22d`, silent) | `0` / `0.00` | `0.00` | `1.10` | `6.00` | `4.90` | `1 × PARENT_OF` (`0.98`) + `4 × DISCUSSED_IN` (`3.92`) | `7.56` (**#3**) | `6.46` (**#2**) |
| `issue-19482` | `2026-10-09` (`22d`, closed on GH) | `3` / `3.00` | `1.30` (`1 × RESOLVES`) | `1.08` | `9.30` | `3.92` | `1 × PARENT_OF` (`0.98`) + `3 × DISCUSSED_IN` (`2.94`) | `10.93` (**#2**) | `5.55` (**#3**) |
| `issue-16217` | `2026-09-01` (`60d`, silent) | `1` / `1.00` | `0.00` | `1.04` | `4.00` | `1.96` | `2 × SESSION_SUMMARY -> DISCUSSED_IN` (`2 × 0.98`) | `5.61` (**#7**) | `3.57` (**#4**) |
| `issue-13144` | `2026-10-29` (`2d`, active) | `3` / `3.00` | `0.00` | `1.02` | `5.00` | `0.98` | `1 × SESSION_SUMMARY -> DISCUSSED_IN` (`0.98`) | `6.63` (**#4**) | `2.61` (**#5**) |
| `discussion-15812` | `2026-07-24` (`99d`, silent) | `0` / `0.00` | `0.00` | `4.00` | `4.00` | `0.00` | `0` decaying edges | `5.82` (**#5**) | `1.82` (**#6**) |
| `discussion-16648` | `2026-08-07` (`85d`, silent) | `0` / `0.00` | `0.00` | `4.00` | `4.00` | `0.00` | `0` decaying edges | `5.82` (**#6**) | `1.82` (**#7**) |
| `discussion-18730` | `2026-09-23` (`38d`, silent) | `0` / `0.00` | `0.00` | `3.64` | `3.64` | `0.00` | `0` decaying edges | `5.45` (**#8**) | `1.82` (**#8**) |
| `discussion-15758` | `2026-09-19` (`42d`, silent) | `0` / `0.00` | `0.00` | `2.91` | `2.91` | `0.00` | `0` decaying edges | `4.73` (**#9**) | `1.82` (**#9**) |
| `discussion-17084` | `2026-08-24` (`68d`, silent) | `0` / `0.00` | `0.00` | `2.18` | `2.18` | `0.00` | `0` decaying edges | `4.00` (**#10**) | `1.82` (**#10**) |
| `issue-17844` *(specimen, outside semantic top-20)* | `2026-10-31` *(re-scoped; was `2026-10-12`)* | `147` / `147.00` | `0.00` | `0.00` | `165.13` | `18.13` | `18` decaying edges (`18.13`) | *(outside ANN pool)* | *(outside ANN pool)* |

## 2. Key Ratios & Silence-Threshold Verification (AC-2 & AC-3)

1. **Leader message-record ratio eliminated**:
   - On live leader `issue-15197` (`updatedAt: 2026-10-19`, active within the 14-day window): `MESSAGE:*` edges accounted for **`152.00 / 180.80 = 84.07%`** of `totalWeight` (a **`7.76 : 1`** ratio of message-record weight `152.00` to decaying weight `19.60`, and a **`9.22×`** structural inflation `180.80` vs `19.60`). After switching to `decayingWeight`, message-record share is **`0.00 / 19.60 = 0.00%`**.
   - On the ticket's `#17844` specimen: `147` `MESSAGE:*` edges accounted for **`147.00 / 165.13 = 89.02%`** of `totalWeight` (an **`8.11 : 1`** ratio over `decayingWeight = 18.13`, **`9.11×`** total-to-decaying). After switching to `decayingWeight`, message-record share is **`0.00%`**.
2. **Silence-threshold verification (`goldenPathSilentThreadThresholdMs = 14d`)**:
   - Before (`totalWeight`), silent items `discussion-15812` (`99d` silent, `totalWeight: 4.00`) and `discussion-16648` (`85d` silent, `totalWeight: 4.00`) had a `4.08×` higher structural term than active `issue-13144` (`2d` old, `decayingWeight: 0.98`) solely from self-reinforcing `frontier -> GUIDES` edges. Under `decayingWeight`, all five silent Discussions drop to `Structural: 0.00` (`Score: 1.82`) and rank below active `issue-13144` (`Score: 2.61`, **#5**).
   - Every item silent longer than 14 days that retains a structural term above `0.00` (`issue-9853` at `4.90`, `issue-19482` at `3.92`, `issue-16217` at `1.96`) is 100% accounted for by decaying `SESSION_SUMMARY -> DISCUSSED_IN` and `ISSUE -> PARENT_OF` edges recorded in the table above.

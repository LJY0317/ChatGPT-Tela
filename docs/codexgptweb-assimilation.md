# CodexGPTWeb assimilation ledger

ChatGPT Tela is intended to replace this maintainer's former `codex-chatgpt-web-local-patches`
installation without losing the engineering lessons that justified the downstream patch set. This
ledger compares three inputs:

- the independently rooted `LJY0317/codex-chatgpt-web-local-patches` snapshot;
- the later `miuuyy/codex-chatgpt-web` upstream;
- Tela's own Native-authority / stable-connector architecture.

The goal is **behavioral assimilation, not source copying**. A downstream behavior is adopted only
when it fits Tela's stronger ownership boundaries. Native Codex remains authoritative for task
identity, history, tools, filesystem/sandbox authority and compaction. ChatGPT Web state is always
replaceable provider state.

Status vocabulary:

- **absorbed** — implemented on the product path with focused tests;
- **partial** — a safe foundation exists, but an important production behavior is still missing;
- **pending** — intentionally tracked for a later implementation batch;
- **not copied** — the downstream feature solves a boundary Tela does not need or conflicts with a
  deliberate Tela product decision.

## Context and browser lifetime

| Downstream lesson | Tela status | Tela contract |
| --- | --- | --- |
| Separate durable Native logical context from disposable Web physical context | **absorbed** | `RevisionLineage`, `WebPhysicalContext.logicalTokens`, `transferTokens`; Web projection can never replace Native history. |
| Keep a task/model/effort Web conversation across sequential Native turns | **absorbed** | one retained browser surface per exact Native task/Web epoch; successful turns leave it idle for reuse. |
| Send only the canonical suffix on retained continuation | **absorbed** | `retained-delta` requires the prior committed Native input head and exact previous Web-answer fingerprint in the current canonical lineage. |
| Advance retained state only after a proven completed Web turn | **absorbed** | planner settlement is transactional; failed/ambiguous turns do not move the committed retained anchor. |
| Never inherit uncertain browser state after failure | **absorbed** | any failed retained turn destroys that physical surface before another turn can run. |
| Model/effort change starts a new physical epoch | **absorbed** | Web epoch identity includes the current Native model + reasoning-effort route identity. |
| Web physical rollover may occur without Native compaction | **absorbed** | retained epochs track their fresh physical baseline separately from Native logical history; downstream-calibrated conservative soft/hard Web limits trigger a fresh physical epoch without requesting Native compaction. Growth includes assistant output already resident in the retained Web conversation, not merely bytes resent in later suffixes. |
| Bound old settled tool evidence and assistant prose in a fresh provider projection | **absorbed** | all system/developer/user/steering and tool-call structure stay exact; `tool_search` registry stays exact; settled assistant/tool payloads are bounded only in the disposable Web view and the reduction is diagnosed structurally. |
| Hard-fit a fresh projection to the measured Web window without changing Native history | **absorbed** | fresh projection budgets are searched from irreducible step 0 through the default retained-evidence budget; Tela maximizes reducible historical assistant/tool evidence under the soft limit, uses remaining hard-window headroom only when irreducible authority already exceeds soft pressure, and fails closed if step 0 still exceeds the hard window. Exact final composer characters are also checked before model preparation or submit. |
| Large fresh context as memory-backed file + exact receipt before enabling work | **absorbed** | large fresh physical context can be staged as one deterministic UTF-8 attachment held entirely in memory; ChatGPT must return the exact receipt stored only at the end of the file before the real execution message is authorized. The inert preload has no connector/tool bridge, Native logical history/tokens remain unchanged, the active request is re-presented exactly in the execution message, and receipt proves file access/integrity rather than semantic comprehension. Profile 1 product-path canary is live-proven; unknown pre-existing attachments are preserved fail-closed instead of being deleted by filename guess. |
| Multipart Bigger Context changes physical transport only | **pending** | must not inflate Native logical context or move Native compaction thresholds. |

## Model catalog and model/effort selection

| Downstream lesson | Tela status | Tela contract |
| --- | --- | --- |
| Preserve every Native model and add explicit Web-backed choices | **partial** | The default Desktop path is live-proven. Profile 2+ now uses Plura's optional authenticated model-list overlay contract and preserves Native rows on callback failure; real Profile 2 picker and Native passthrough proof remain. |
| Discover current ChatGPT model families from the authenticated browser | **absorbed** | the hidden authenticated browser discovers live family rows and effort availability; no GPT-version allowlist or account-plan guess exists in product constants. Live canaries proved three current families on Profile 1 and eight on Profile 2, confirming that account-local browser observation—not one global catalog—is the authority. |
| Give dynamic model families stable opaque route identities | **absorbed** | NFKC/whitespace/case-normalized observed family semantics derive an opaque SHA-256 family key; display labels are not authority. |
| Verify selected Web family/effort immediately before Send | **absorbed** | the runtime preparation hook executes immediately before the consequential submit boundary; exact family + effort readback must converge within a fixed bound or the message is not sent. Private non-submit live canaries proved select/readback/restore on both Profile 1 and Profile 2. Hidden/offscreen family activation uses bounded DOM/pointer fallbacks only with semantic checked-row readback. |
| Reuse retained surface only when exact family/effort ownership is proven | **absorbed** | Web epoch route identity includes model/effort, and every Web submit re-proves browser family/effort even on a retained surface. Cross-model/effort reuse therefore fails closed. |
| Keep Native and Web switching inside one Codex provider | **absorbed** | the default Desktop provider preserves first-party ChatGPT authorization, uses a separate local Tela capability header, passes Native model requests to the first-party Codex backend, and sends only the synthetic Tela Web namespace to the browser bridge. |
| Remove bridge-owned response/item ids before switching back to Native | **absorbed** | Tela-owned `resp_tela_*`/`msg_tela_*`/tool ids are structurally scrubbed while opaque first-party ids and semantic item contents are preserved. |

## Native authority and tool bridge

| Downstream lesson | Tela status | Tela contract |
| --- | --- | --- |
| Native task/turn is sole execution authority | **absorbed** | current-turn evidence is canonically rebound before every consequential Native request. |
| Exact per-turn bearer instead of human-readable task ids | **absorbed** | opaque `turnCapability`; retired capabilities cannot be reused. |
| Discover the current Native tool inventory at runtime | **absorbed** | public `ChatGPT Tela` connector exposes inventory + exact call, not a copied static tool list. |
| One outstanding Native tool boundary at a time; no duplicate side effects | **absorbed** | two-phase Native delivery, used call-id set, continuation proof and no automatic resubmit. |
| Keep tool calls/results inside the same Web response | **absorbed** | exact Native result is released only after the Web continuation boundary is armed. |
| Recover cwd/workspace/sandbox only from canonical Native authority | **absorbed** | request metadata is not filesystem authority; app-server/rollout evidence owns it. |
| Native V2 subagents without a parallel legacy protocol | **partial** | runtime inventory can expose current Native agent tools; product-level subagent dogfood and nested-agent tests remain to be expanded. |

## Browser correctness and security

| Downstream lesson | Tela status | Tela contract |
| --- | --- | --- |
| Separate browser DOM mechanics from task authority | **absorbed** | ChatGPT semantic provider / DOM driver cannot create Native authority. |
| Stable logical turn identity, no resend to repair DOM ambiguity | **absorbed** | exact composer readback + one new user lineage; ambiguous submission is indeterminate and never retried. |
| Connector identity is protocol identity, not a mutable preference | **absorbed** | frozen public `ChatGPT Tela` connector/ABI identity. |
| Hidden connector choice must follow the UI's real keyboard owner instead of assuming pointer hit-testing | **absorbed** | when an exact add-context connector row is visible, Tela moves the bounded menu highlight to that exact row, activates with Enter, and accepts it only after the exact selected connector pill appears. Pointer is a fallback, never proof. This downstream-derived path was live-proven on Profile 2 where direct offscreen activation failed. |
| Fresh setup/readiness surface must not own Native work | **absorbed** | profile-control surfaces are isolated and non-consequential. |
| Approval automation remains bounded and explicit | **partial** | one-shot approval automation exists; downstream policy/diagnostic edge cases remain an audit item. |
| User must not interact with Work's hidden bridge browser | **absorbed** | Control Center gets JPEG-only read-only preview; actual Web surface stays hidden/unfocused. |

## Diagnostics and operability

| Downstream lesson | Tela status | Tela contract |
| --- | --- | --- |
| Structural/privacy-safe turn diagnostics instead of raw prompt logs | **absorbed** | timestamped counts/byte sizes/duration/error/truncation only. |
| Distinguish logical input, physical transfer and browser/render pressure | **absorbed** | Work diagnostics separately emit logical tokens, current transfer tokens, estimated retained-epoch input, effective rollover boundary, rollover decisions, and exact prepared browser-message character count without recording message text. |
| Bounded incident snapshot with structural allowlist | **pending** | keep MacLagMonitor for OS-level Renderer/WindowServer evidence; Tela should own product causal evidence. |
| On-demand deep trace rather than permanent heavy profiling | **pending** | add a user-triggered/incident-scoped product trace; never a permanent browser profiler. |
| Isolated development canary using the real product path | **absorbed** | existing exact-turn canaries remain; `cli model-canary --slot <n>` live-proves that profile's family/effort selection + restoration without submitting a message (live-proven on slots 1 and 2), and `cli retention-canary` passively proves real retained-delta + retained-surface reuse from bounded structural diagnostics without generating any extra ChatGPT turn. |
| Distinguish public-ingress root causes instead of generic unavailable state | **absorbed** | Gateway/CLI/Control Center separate local MCP, Tailscale backend/login/online state, exact Funnel mapping and public MCP reachability; Tailscale-off is reported as the root cause rather than a generic connector failure. |

## Product lifecycle and profile isolation

| Downstream lesson | Tela status | Tela contract |
| --- | --- | --- |
| Stable login partition with task tabs isolated from each other | **absorbed** | one persistent partition per Tela profile; task/Web-epoch surfaces are separate documents. |
| Default single-profile UX, optional multi-profile isolation | **absorbed** | Profile 1 remains the default. Without Plura Desktop, Tela uses its built-in single-profile owner; when Plura Desktop is configured, the same public control contract owns Profile 1 and Profile 2+ so two supervisors never compete for the default Desktop. |
| Configuration, user preference and process-local state have different owners | **partial** | Tela lifecycle ownership is explicit; remaining Control Center preferences should not become backend authority. |
| Transactional install/update/repair/uninstall | **absorbed** | signed package trust, ownership manifest, resumable upgrade/repair and shared uninstall runtime. |
| Cross-platform packaging/verification | **absorbed** | macOS/Windows/Linux CI and signed-package smoke are release gates. |

## Features deliberately not copied as-is

- **A second Codex Native2/Zero Risk connector stack** — Tela already has one stable public connector
  and a split Gateway/Chat/Codex backend. Duplicating the old tunnel/broker identities would recreate
  the route-owner and setup problems Tela is replacing.
- **A user-operated bridge chat/browser** — Tela's bridge surface is observation/recovery only; user
  interaction could interrupt the exact Work turn.
- **Model-generation allowlists or fixed account-plan classifications** — live browser observation is
  the intended model/effort authority.
- **Web projection as conversation authority** — deleting every projection/cache must at worst cost
  reconstruction; it must never corrupt or redefine the Native thread.

## Assimilation order

1. retained Web epoch + suffix-only continuation (**absorbed**);
2. deterministic fresh provider projection + physical pressure telemetry (**absorbed**);
3. browser semantic model-family/effort discovery (**absorbed**, Profile 1 live-proven);
4. composite Native + explicit Tela Web `model/list` surface and routing (**partial**: default Desktop live-proven; Profile 2+ adapter implemented, live proof pending);
5. independent physical-pressure epoch rollover + fresh hard-fit planner (**absorbed**);
6. receipt-verified large-context/file transport (**absorbed**) and multipart transport;
7. retained compaction proof/canary (**absorbed for retained live reuse; compaction-specific proof remains**), richer incident diagnostics, approval/subagent/skill audits;
8. final parity audit against both the downstream snapshot and then-current upstream before the old
   project is considered replaceable.

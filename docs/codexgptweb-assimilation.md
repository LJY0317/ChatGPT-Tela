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
| Web physical rollover may occur without Native compaction | **partial** | independent Web epoch abstraction exists; production still needs browser-discovered physical soft/hard limits before pressure-based rollover is enabled. |
| Bound old settled tool evidence and assistant prose in a fresh provider projection | **absorbed** | all system/developer/user/steering and tool-call structure stay exact; `tool_search` registry stays exact; settled assistant/tool payloads are bounded only in the disposable Web view and the reduction is diagnosed structurally. |
| Hard-fit a fresh projection to the measured Web window without changing Native history | **pending** | depends on live model/effort limit discovery; never silently delete irreducible authority/current causal state. |
| Large fresh context as memory-backed file + exact receipt before enabling work | **pending** | representation-only optimization; no disk temp file, no connector on preload, no claim that receipt proves semantic comprehension. |
| Multipart Bigger Context changes physical transport only | **pending** | must not inflate Native logical context or move Native compaction thresholds. |

## Model catalog and model/effort selection

| Downstream lesson | Tela status | Tela contract |
| --- | --- | --- |
| Preserve every Native model and add explicit Web-backed choices | **pending** | use the current Codex `model/list` contract; Native choices must stay Native rather than being silently rerouted. |
| Discover current ChatGPT model families from the authenticated browser | **pending** | no GPT-version allowlist or account-plan guess in product constants. |
| Give dynamic model families stable opaque route identities | **pending** | identity derives from observed family semantics; labels are display data, not authority. |
| Verify selected Web family/effort immediately before Send | **pending** | mismatch or missing option fails closed; never fall back to another family/effort. |
| Reuse retained surface only when exact family/effort ownership is proven | **partial** | Native route identity already prevents cross-model/effort reuse; browser-side selected-family proof still needs a semantic model-picker capability. |

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
| Fresh setup/readiness surface must not own Native work | **absorbed** | profile-control surfaces are isolated and non-consequential. |
| Approval automation remains bounded and explicit | **partial** | one-shot approval automation exists; downstream policy/diagnostic edge cases remain an audit item. |
| User must not interact with Work's hidden bridge browser | **absorbed** | Control Center gets JPEG-only read-only preview; actual Web surface stays hidden/unfocused. |

## Diagnostics and operability

| Downstream lesson | Tela status | Tela contract |
| --- | --- | --- |
| Structural/privacy-safe turn diagnostics instead of raw prompt logs | **absorbed** | timestamped counts/byte sizes/duration/error/truncation only. |
| Distinguish logical input, physical transfer and browser/render pressure | **partial** | logical/transfer token counts now emit on Work plans; browser message-char and physical epoch-pressure telemetry remain pending. |
| Bounded incident snapshot with structural allowlist | **pending** | keep MacLagMonitor for OS-level Renderer/WindowServer evidence; Tela should own product causal evidence. |
| On-demand deep trace rather than permanent heavy profiling | **pending** | add a user-triggered/incident-scoped product trace; never a permanent browser profiler. |
| Isolated development canary using the real product path | **partial** | current canaries and Profile 2 exact-turn proof exist; retained-context and model-picker live canaries still need product commands. |

## Product lifecycle and profile isolation

| Downstream lesson | Tela status | Tela contract |
| --- | --- | --- |
| Stable login partition with task tabs isolated from each other | **absorbed** | one persistent partition per Tela profile; task/Web-epoch surfaces are separate documents. |
| Default single-profile UX, optional multi-profile isolation | **absorbed** | Profile 1 is the default; Profile 2+ goes through Plura Desktop control. |
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
2. deterministic fresh provider projection (**absorbed**) + physical pressure telemetry;
3. browser semantic model-family/effort discovery;
4. composite Native + explicit Tela Web `model/list` surface and routing;
5. independent physical-pressure epoch rollover + hard-fit planner;
6. receipt-verified large-context/file and multipart transports;
7. retained compaction proof/canary, richer incident diagnostics, approval/subagent/skill audits;
8. final parity audit against both the downstream snapshot and then-current upstream before the old
   project is considered replaceable.


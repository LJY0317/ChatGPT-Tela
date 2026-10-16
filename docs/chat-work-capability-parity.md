# Tela Chat work-runtime parity design (2026-10-16)

Status: design with initial source implementation at 78ae391 in an isolated worktree. Optional v1 effect,
scope, authority, replay, verification and maturity descriptors now cross Chat/protocol/Gateway discovery.
See that commit's docs/chat-capability-discovery.md. This is not installed or verified Work/Codex parity;
result schemas, broker policies, logical checkpoint persistence and matched performance tests remain open.

## Goal and execution policy

Use Tela Chat first for ordinary repository development. DevSpace is a peer technical fallback for an independently permitted task. Use exact-current-turn Native tools when their authority is essential. Eventually restore reliable Native-tool use by Web models, but do not make that repair a prerequisite for productive Chat work. A route or model change never upgrades permissions. Do not repeat a platform-denied action through another surface.

## Split semantic work from physical execution

The **logical work context** stores user intent, acceptance criteria, revisions, decisions, task relationships, result references and uncertainties. It can survive model/provider changes, compaction and physical transport replacement. It is not a credential or authority grant. Context shortening must explicitly preserve omissions and provenance.

The **physical context** binds a specific owner-approved workspace and checkout writer, process operation, account/browser generation or exact Native turn and tool inventory. Every binding has proof, scope, freshness and revocation semantics. Reattachment requires re-proof; path strings, remembered tool names, recycled PIDs and model changes are insufficient. Tela Chat, Codex and DevSpace keep independent mutable runtime state.

## Proposed semantic capability layer

Describe capabilities by effects and proof, not tool-name equivalence. Example intents are workspace read/patch, command run/observe, Git review, worktree lifecycle, agent delegation, browser observation, file import/export and exact Native tool invocation. Each descriptor declares: runtime-discovered provider/version, read/write/destructive effect class, authority owner and resource scope, argument/result schema, replay semantics, authoritative verification recipe, current maturity and measured cost.

This catalogue **advertises**, not authorizes. The owning backend checks permissions and execution authority every time. Never silently map a Chat workspace capability into Native turn authority. Preserve Tela's existing four-function public Gateway ABI and peer-service failure boundaries. Add descriptor fields through versioned compatible Chat capability discovery when implemented, not by hardcoding external models, Native tools or DOM selectors.

## Model-aware presentation without model-based privilege

Models can differ in context use, schema adherence, multimodal understanding and recovery behavior. Present short typed instructions and bounded structured results; retain large stdout/diffs/media in owner-scoped artifacts with references, digests and explicit truncation. Let a program manage event-driven progress and dependency state rather than an LLM repeatedly polling. Track planned, admitted, accepted, running/waiting, terminal/uncertain and verified/unverified separately. A displayed final answer is not proof an action succeeded.

Maintain single-writer-per-checkout, exact operation identity, provenance/ownership of delegated tasks, and conservative result reconciliation. Safety/permission refusal, transport failure, post-acceptance probable observation and missing context proof are distinct failure classes; never hide first cause under subsequent 409. A refused action cannot be retried via another provider or route. Independently allowed design and privacy-safe metadata diagnosis can proceed.

## Acceptance roadmap

### Current source slice: delegated checkout-writer admission (2026-10-16)

Tela Chat's delegated agent manager now records each turn's requested write mode and
rejects a second writable delegated turn targeting an overlapping approved root or
the same discoverable Git checkout while another writable turn is running or has an
unresolved interrupted outcome. Older unresolved turn records without a write-mode
field are conservatively treated as possibly writable. Read-only agent turns remain
admissible; completed/stopped turns release this local admission guard. Regression
fixtures cover nested roots, read-only overlap, restart uncertainty and existing
agent authority constraints.

This is **not** the cross-service, cross-process single-writer broker. It does not
reserve direct `exec_command`/patch writes, other Chat service instances, DevSpace,
Native Codex or Plura writers. It is not a sandbox, cannot undo effects after
cancellation, and does not automatically clear unknown writer state. Before
claiming global single-writer correctness, introduce a durable exact-checkout
reservation shared by all compatible write routes with owner generation,
authenticated settlement and restart/conflict tests; retain independently owned
service authority. No new public Gateway tool or installed acceptance is implied.

1. **Baseline**: discover current Chat and exact-turn Native capabilities and produce a matrix of advertised, proven, unsupported and unknown functions. Compare actual outcomes, not similarly named tools.
2. **Typed catalogue**: implement backward-compatible semantic descriptors and contract tests for effect, authority, proof, replay policy and maturity. Existing public connector fingerprint remains unchanged.
3. **Durability and ergonomics**: finish process restart reconciliation, owned-tree cancellation, conflict-safe file edits, review expansion and typed incident receipts. Never replay an accepted uncertain write.
4. **Agents and modalities**: verify scoped delegation/result/review, browser observation/actions and file/media support through their independently authorized adapters. Keep physical account and Native ownership separate.
5. **Native rehabilitation**: diagnose exact initial failure layers and repair evidenced product defects without bypassing platform checks. Prove real Web-model Native tool call, delivered tool result and validated final answer, including refusal/retirement cases.
6. **Parity measurement**: benchmark benign matched tasks at equivalent model effort, permissions, inputs and hardware. Measure correctness, recovery, user steps, time, model/tool bytes and tokens where observable, CPU/RSS/idle impact. Claim superiority only for verified scopes, not from an interface inventory.

Regression gates: missing authority must cause no effect; safety refusal must not reroute; transport uncertainty must not duplicate writes; dirty/unknown checkout owners must prevent concurrent writes; physical replacement must revoke old capability while preserving verified logical context; truncation must remain visible; model switches must preserve scope; cleanup/restarts must touch only exactly owned resources.

Separate source, tests, real-model behavior, installed verification and platform parity in status reporting. Previous `7f5e93a.1` and `16f6d5d.1` installation reports do not prove that full Native Web-model acceptance or Chat parity is completed.


The initial optional capability effect/replay/verification descriptors are implemented and covered
by source regressions; see [capability discovery](chat-capability-discovery.md). This does not
complete task authority, durable logical work records, result schemas or model-verified parity.

# Native / Web context continuity contract

## Original-turn ACK route for readable Legacy current input (source candidate 2026-10-12)

The owned default Desktop proxy now records a **process-local, revocable**
receipt for an original public `turn/start` response that confirms the exact
`inProgress` Native turn. It joins the engine's `turn.id` to the original
`threadId` using the same socket and matching JSON-RPC request ID, not
untrusted Responses metadata. A mismatched, missing, completed, replaced or
ambiguous receipt grants no turn authority. The same JSON-RPC request ID
cannot be reused to prove a later turn on that connection: an old delayed
ACK could otherwise be mistaken for the newly requested thread. Native
traffic is still forwarded without mutation, but the reused ID grants no
new Legacy ownership. The bounded proof registry disables further admissions
if it runs out of safe request-ID slots. A second socket cannot silently
take over an accepted receipt. Close, explicit thread/turn retirement, new
Native turn, account invalidation and owned proxy shutdown revoke it.

For a thread **explicitly reporting `historyMode=legacy`**, the default
Desktop current-turn reader may now use this fresh original engine ACK and
two public `thread/read(includeTurns:false)` metadata checks with matching
owner/environment, while the exact receipt remains current. A watcher uses
the same receipt and its original socket's lifecycle signals; it **never**
calls `thread/resume`, `thread/turns/list`, `thread/items/list`,
`thread/fork`, or `turn/start` merely to inspect old Legacy history. Without
this live receipt (for example after restart), or for unknown storage modes,
the existing unindexed-history refusal remains unchanged. Paginated readers
retain their existing indexed proof path.

This unlocks Native→Web continuity for an older Legacy thread **only where
the already-authenticated current Native Responses request contains a
complete, readable model-visible task context**, including an ordinary
readable `context_compaction` marker followed by its user summary. It never
manufactures historical content. A 73 MiB Legacy thread with **opaque**
encrypted compaction and no separately verifiable checkpoint still returns
`tela_native_history_indexed_source_required` and
`recovery.kind=continue_on_native`, not a partial, falsely successful Web
answer. The live ACK proves the new turn's identity, **not** atomic historical
revision, past executed model/provider, or a tool-free fork certificate.
Only default Desktop routing owns this proxy receipt. Source tests use
synthetic metadata/turns and do not establish installed or live 73 MiB
acceptance.

## 2026-10-11 resumed original-work safety gate: no hidden Legacy replay

The product must not turn a small public page limit into an unbounded
**server-side** replay of an old Legacy Native rollout. All source-level
historical compaction/anchor and explicit-handoff public paging now require
`historyMode:paginated` in a metadata-only `thread/read(includeTurns:false)`
**before** any `thread/turns/list` or `thread/items/list`, and reprove
the storage mode and owner/environment metadata afterward. Missing, future
and Legacy modes return `NativeHistoryBootstrapRequired` with
`recoveryReason:"unindexed_history"` without paging. The loaded active-turn
interruption scan similarly rejects an unindexed active thread before
`thread/read(includeTurns:true)`, pagination, or any partial interrupt.
Idle unindexed loaded threads remain skippable from metadata alone.
Both the default Desktop target and the optional multi-profile target now
configure bounded active-turn ownership proof.
The bounded Native turn **watcher** also validates the indexed current-turn
identity before sending `thread/resume(excludeTurns:true)` and rechecks after
the observation connection attaches. Legacy/unknown active turns never
reach the resume request merely to attach notifications; a storage-mode
change at either proof stage fails closed. The pre-resume indexed probe is
on demand for an actual watched turn, not an idle sampler.

An old 73 MiB Legacy cold Web attempt with no prior verified current-input
or retained source is therefore **not yet recoverable automatically**.
The nonretryable 422 `tela_native_history_indexed_source_required`
returns `recovery.kind:"continue_on_native"`, not a misleading request to
create an explicit Native handoff that would still need unsafe Legacy paging.
The source/protocol tests use fixtures only; no installed app/73 MiB private
thread, historical model/provider attestation, user account, or Native tool
action was touched. The missing upstream requirements remain a bounded,
owner-authenticated Legacy source/compaction read and historical executed-model
provenance with a true pre-execution no-tools fork policy.

When a Web attempt has already emitted SSE preparation progress, HTTP status
cannot be changed retroactively to 422. A late typed Native-history failure
therefore ends the *same* stream with `response.failed` carrying the identical
nonretryable Tela recovery code and `continue_on_native` / explicit handoff
action as the ordinary pre-stream HTTP 422. Both paths use fixed messages,
never exception text or private Native history. No `response.completed` or
Web continuation is committed after that failure. The structural diagnostic
`native_context_recovery_streamed` distinguishes this late SSE result from
a normal pre-stream HTTP 422; HTTP 200 alone is not proof of recovery.

## Automatic cold Native handoff (source-only 2026-10-11 extension)

The normal current input, proven retained Web page, durable Native readable
checkpoint and already user-requested prior Native final answer take
precedence over any additional Native model call. For an otherwise impossible
cold Web start, a public, ephemeral Native fork of the immediately previous
completed turn may produce a tightly bounded structured handoff with one
**Native** model call. It is selected from a verified Native catalog (or the
fork's own persisted model) rather than hard-coded model IDs. The original
in-progress Web turn is never duplicated, interrupted or mutated. The fork
uses read-only sandbox, approval never, JSON schema and tool-item rejection;
it explicitly defers and clears any inherited Goal before generating text.
The source is re-proven afterward, and its content is stored under the
account's separate historical checkpoint namespace and the opaque Native
compaction fingerprint. Recent public source ancestry is required to reuse
the cached value after Web restart. The derived summary is lower-priority
task guidance with explicit original-evidence limitations, not authority.

Where any public fork isolation or exact historical executed Native model
proof is unsupported, no model is started. The product runtime now
**omits** the `automaticNativeHandoff` and
`verifyAutomaticNativeHandoff` callbacks entirely. The separate
source adapter remains **deny before RPC connect** by default; only isolated
synthetic fixtures explicitly opt into unshipped fork behavior. The typed
HTTP 422 cold-history boundary remains. Synthetic tests do not constitute
live Native authority, historical model provenance, a verified tool-free
engine policy, or an installed automatic recovery feature.
The common Native continuity resolver also **ignores accidental callback
injection and cached automatic summaries** unless a second, conspicuously
unsafe flag is supplied by an isolated synthetic fixture. The actual product
does not supply that flag. A denied injection emits one content-free
`native_auto_handoff_rejected` event in the `continuity_resolver` phase;
this is not an engine capability claim or a release enablement switch.
See [the required upstream execution-provenance and tool-free fork contract](native-execution-provenance-gate.md)
for the exact missing engine evidence and acceptance gates; it is a request,
not a public API that Tela can already call.

## Legacy compatibility cleanup (2026-10-11)

- Removed the old historical projection switch that allowed
  thread/read(includeTurns:true) to download the entire original transcript.
  All AppServerCompactionHistorySource.project callers now use bounded public
  thread/read(includeTurns:false) and thread/turns/list. Direct media/history
  tests follow the same contract.
- Removed fallback of ordinary Web-epoch checkpoint storage for a missing
  Native-history checkpoint cache. Separate source-binding and retention
  boundaries are intentional and no auto-migration is performed.
- Protected Native continuity summaries and current Native Goal observations
  from provider-only trimming of old assistant/tool prose. Their exact
  canonical revision IDs reach Web physical fitting, which refuses to
  silently crop that source-bound content even under memory pressure.
- Previously permitted Legacy `thread/turns/list` requests are now
  **blocked before pagination** in compaction source/anchor and explicit
  handoff readers; their limits did not bound Native-internal rollout work.
- `AppServerCurrentTurnSource` now **defaults** to bounded proof for every
  new caller, not merely the explicitly configured Native-first and optional
  multi-profile routes. The standalone default Desktop product-profile route
  also explicitly selects bounded proof. All these routes fail closed for
  Legacy, missing or unknown history modes before any unbounded read; the
  public product source factory does not expose an unsafe override.
  Older full-snapshot compatibility remains only as an explicitly requested
  `preferBoundedTurnProof:false` mode in isolated internal regression
  fixtures; it is never selected implicitly. Product lifecycle interruption
  never invokes the full-history fallback.
- A verified user-requested Native handoff remains available through
  **Paginated public** recent-turn summaries, not unindexed Legacy.
  Without a validated checkpoint, independently verifiable handoff or
  readable source, opaque Native compaction continues to fail closed.

These changes do not decode encrypted compaction, grant missing historical
tool/file evidence, or automatically restore a cold 73 MiB Legacy conversation.

This document describes the implemented source architecture. Native Codex remains the only
authority for task identity, tool execution, approval, cancellation, branching and compaction.
All checkpoint and Web physical state is derived and disposable.

## One continuity decision

On each authenticated Native-owned Web request:

The resolver first requires its `threadId` and `currentTurnId` to match
the in-process canonical `NativeTurnAuthority` exactly, including the
`native-current-turn` authority source. A mismatched owner fails before
reusing hot history, reading local derived caches, invoking public history
adapters or producing a checkpoint. This prevents accidental cross-turn or
cross-thread routing inside Tela; it does **not** itself attest a historical
executed model, external account identity or tool-free fork capability.

1. The canonical current-turn proof and original Native Responses input remain unchanged.
   A readable local `context_compaction` followed by a user summary is ordinary current
   Native input; it needs no separate historical adapter or model call.
2. For an opaque Native compaction, a proven *surviving* Web physical page may reuse its
   existing transport summary only after exact model/effort, encrypted-state fingerprint,
   canonical revision ancestry, preceding assistant answer and Web pressure are checked.
3. Otherwise, locate a source-bound Native history checkpoint by the current public
   compaction item/turn anchor. The account-scoped cache is only a hint; current Native
   identity must be rechecked.
4. If unavailable, optionally read a *user-requested* completed Native final-answer
   handoff only through a proven indexed Paginated source. A persisted handoff
   and a newly found handoff are each accepted only after independent
   verification of the exact same public Native answer, source IDs, digest,
   summary and limitations. Missing or changed verification fails before a
   derived cache write or Web execution. A Legacy early handoff probe fails
   before unsafe historical pagination.
   After recognizing the exact requested handoff prompt, both readers reject
   any **visible** tool call, file change, plan, second user request, extra
   assistant message, or unknown public item; only one user prompt, optional
   reasoning, and one final answer are accepted in that completed Native turn.
   An unrelated ordinary Native tool turn remains a non-handoff. This checks
   the bounded public `itemsView:summary` projection, **not** a proof that
   the Native engine blocked every possible hidden tool execution.
   The current in-progress Web turn also must be unacted: at most its initial
   public `userMessage` is permitted. A visible agent/tool/unknown item or
   multiple user items blocks both new and cached handoff verification, rather
   than importing a previous checkpoint after execution has already started.
   Before accepting either a newly found or cached manual handoff, Tela
   rechecks the newest in-progress turn through one
   `thread/turns/list(itemsView:notLoaded,limit:1)` **indexed Paginated**
   metadata page, after the normal post-source metadata owner check.
   A changed newest turn or malformed public head refuses the handoff
   before returning derived Web context. The extra page never requests
   historical tool outputs or attempts a Legacy server-side replay.
   This narrows the source-snapshot race; it is **not** an atomic Native
   turn-revision certificate or proof that a Native engine cannot change
   state after the final public check.
5. Only then try the bounded complete visible Native source. If it is fully readable and
   an ordinary, authorized Web checkpoint producer is available, create one checkpoint
   within the *same* Web source/output budget. Revalidate the public compaction anchor
   before committing it. Otherwise use the bounded source as-is if it fits.
6. If the original source is unavailable, oversized or ambiguously owned, fail closed
   with a context-recovery requirement. Never turn a partial suffix into an alleged
   complete original transcript.

`packages/development-runtime/src/native-context-continuity.ts` owns this selection
and returns a typed mode, visible context, media and evidence references. The Native
history and manually produced summaries are **lower-priority transport context**;
they never constitute new system instructions, Native tool receipts or source-file data.

## Physical Web context and session ownership

`packages/development-runtime/src/native-request-planner.ts` independently builds a
canonical Native logical revision lineage, then selects:

- Verified retained Web epoch: transfer only the new canonical suffix, preserving its
  already-resident context and required media. Reuse the proven logical projection once.
- New or rolled-over Web epoch: use source-bound Web checkpoint + revisions when valid,
  otherwise the bounded, physically fitted visible context. Optional context attachment
  has a separate upload receipt. Provider projection cannot erase the current request,
  authorization or verified original evidence.

All actual Web summarizers, including Native local compaction, use
`web-checkpoint-source.ts` to enforce one source-plus-media budget with reserved
model-output headroom. If source cannot fit, no extra model call is made to
repeatedly compact the same unfit prefix. The original Native logical history is not
deleted or modified.

Fresh and retained Web results settle through one transactional boundary. Only an
actual completed answer with physical surface lease and document generation advances
the committed Web epoch. Failure, cancellation and retired leases invalidate uncertain
Web state, not the Native task. Route/effort changes create another physical epoch
without claiming shared underlying model KV cache.

## Restart, account and source recovery

- The history checkpoint store and ordinary Web-epoch cache have distinct account-scoped
  namespaces and retention. Cache entries carry integrity proofs and Native source
  identities, not Native authority.
- Restart requires renewed public Native anchor or handoff-answer proof; retained
  browser-state shortcuts do not survive restart.
- Legacy Native thread paging may still reconstruct the whole historical
  rollout on the Native server side, so all historical projection/handoff
  paths refuse it. Paginated Native `thread/items/list` supports indexed
  compaction anchor discovery where the public contract explicitly allows it.
- A cache missing or corrupt on a 73 MiB old Legacy conversation **cannot be made
  whole** by pretending the encrypted compaction is readable. An explicit
  handoff alone does **not** make Legacy public pagination safe. Native
  continuation or a future bounded public original-source contract is required.
- Old files/commands/images can only become verified evidence after readback through a
  current authorized Native/public tool path. An evidence reference or summary does not
  itself grant file access or permission to reexecute past commands.

## Decision observability and validation

Web-turn diagnostics expose a payload-free `continuity_source` value from
`current-input`, `retained`, `readable-checkpoint`, `cached-handoff`,
`explicit-handoff`, `bounded-source`, or `produced-checkpoint`, alongside the
existing checkpoint/physical-pressure flags. No prompt, command text, account identity
or raw task identifier is recorded in routine diagnostic output.

Synthetic fixtures cover 593 turns/99 compactions, oversized history refusal,
20 retained follow-ups, persistent checkpoint restart, manual handoff source
readback, cache tampering, changed compaction lineage, Native owner cancellation,
local compaction parity, and a shared Web checkpoint budget. These tests are not
a live long-conversation Web acceptance or a signed installed release.

# Native / Web context continuity contract

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

Where any public fork isolation or exact Native model proof is unsupported,
no model is started. The original typed HTTP 422 cold-history recovery
boundary remains. The dedicated fork fixtures were authored but their
execution was blocked by host safety screening; this is **not a tested or
installed automatic recovery feature** until that blocker is resolved.

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
- Preserved official historyMode=legacy **data** support through bounded
  public paging. A Legacy Native server may still internally replay its
  rollout for those pages. This is a source-side limitation, not permission
  to bulk-transfer old tool outputs.
- Preserved a separate older official Desktop current-turn proof compatibility
  path where public thread/turns/list may be unsupported. That authority
  reader can still use thread/read(includeTurns:true); do not claim all
  whole-history RPC calls across the entire product have been removed.
- Preserved a verified user-requested Native handoff even without a history
  projector; without a validated checkpoint, handoff, or readable source,
  opaque Native compaction continues to fail closed.

These changes do not decode encrypted compaction, grant missing historical
tool/file evidence, or automatically restore a cold 73 MiB Legacy conversation.

This document describes the implemented source architecture. Native Codex remains the only
authority for task identity, tool execution, approval, cancellation, branching and compaction.
All checkpoint and Web physical state is derived and disposable.

## One continuity decision

On each authenticated Native-owned Web request:

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
   handoff. A persisted handoff is accepted only after rereading its public Native answer.
   A short early handoff probe avoids a giant Legacy compaction-marker scan when no
   complete source-checkpoint candidate exists.
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
- Legacy Native thread paging may still reconstruct the whole historical rollout on
  the Native server side. Paginated Native `thread/items/list` allows indexed compaction
  anchor discovery where the public contract explicitly supports it.
- A cache missing or corrupt on a 73 MiB old Legacy conversation **cannot be made
  whole** by pretending the encrypted compaction is readable. An explicit bounded
  handoff or a genuinely supported public source is still required.
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

# Native / Web context continuity contract

## Viewing versus submission evidence (source; awaiting installation)

The strict host input fence still covers the exact composer/send through acceptance.
After acceptance, an optional fence from that same host distinguishes pending hit-tests,
proven viewing (selection, copy, navigation and locally linked disclosure controls),
and unknown/editing input. Pending input authorizes no delivery. Unknown input requires
fresh exact author proof; an unchanged anchor alone never authorizes a result. A viewing
gesture does not invalidate an already accepted causal receipt. Document/account/Native
ownership and conflicting user/assistant lineage remain mandatory. Unsupported hosts
retain the stricter existing path; no resend, model call or new execution authority is added.
The renderer's existing event clock wakes after a host hit-test, including selection with
no DOM mutation. It adds no timer or idle sampler.

Open Browser shows the currently owned physical Web page, not an archive of the full
Native conversation. After a necessary physical rollover, earlier Native messages live
in canonical history/checkpoints, not necessarily in scrollable Web bubbles. Keyboard
viewing scrolls the focused overflow pane or the main conversation pane. Visible public
progress is extracted only within the unique marker-owned disclosure branch; hidden
subtrees, user bodies, final answers and ambiguous candidates remain excluded.

This is the current contract and source implementation record, replacing dated source-candidate narratives.
The earlier working-context baseline was installed with the official signed local upgrade as
`0.0.0-context-continuity-20261017.f1a482c.1`. Profile 1/2 and Web route readiness
were checked without sending model messages. **Real account/model semantic or
billing validation remains unperformed and user-owned.**
Execution budgets and receipt settlement
remain defined by [token-efficiency.md](token-efficiency.md).

## Browser inspection lifecycle correction (2026-10-17)

The 13:31 KST incident was a checkpoint accepted before Interact was opened;
an unowned `mouseDown` revoked the host input fence, which the checkpoint runner
had coupled to the whole observation. The input's physical origin and remote
completion are **unknown**. No conclusion that the user edited or sent anything
is supported. `LOCAL-HISTORY/context-continuity-20261017/incident-1331-summary.json`
contains the payload-free incident receipt.

The source-only lifecycle change separates the strict composer/send/acceptance
input fence from the subsequent Native/document-owned observation. An accepted
turn retains the exact request identity, renderer/document anchor, assistant
lineage, unique parent, and conversation route. A same-document detour pauses
handoff until the original author is proved again. After outside input,
an opaque author can no longer borrow the original input fence, while a
fresh exact author witness may restore observation. Native cancellation and
main-document lifetime remain independent. The checkpoint runner no longer
closes a successfully accepted remote operation solely because an interactive
mouse/key input was seen. This is not authorization to resend uncertain work.

The test-only Electron window sequence proved that reveal/Interact leaves the
document live and a subsequent pointer event retires only the submission fence.
The full source gate passed `bun run verify` (1,763 tests, 235 files, zero
failures; TypeScript passed), including different-conversation suspension,
recovery, conflicting authors, Native cancellation, approvals and exact result
handoffs. It does not prove live Electron/ChatGPT event provenance, real-account
responses, an installed binary, or signed upgrade/profile recovery. No
real-account model message was sent for this review.

## Bounds and current gaps

| Layer | Owner | Contract |
| --- | --- | --- |
| Canonical history/artifacts | Native / original tools | Preserve authority and evidence. The archive may grow; its entire contents are not model input. Tela does not delete Native history to fit Web. |
| Native active context | Native engine | Follow effective model/settings and standard compaction. A Web checkpoint does not rewrite Native history or global settings. |
| Web working context | Tela projection | Exact current instructions/request, bounded derived checkpoint and necessary recent suffix. Its admitted size must not scale with archived conversation length. |
| Resident Web conversation | Owned provider session | Append proven deltas while usable. Account for cumulative occupancy independently from Native compaction and newly transferred bytes. |

Logical context describes canonical ancestry, source identity and accessible evidence. Physical
context is the bounded representation a model/session receives. A derived summary is lossy guidance,
not original evidence or tool authority. Arbitrarily many independent facts cannot all remain exact
in constant space; old details require authorized readback. An oversized exact current request or
unresolved causal chain can require recovery. Bounded admission does not guarantee success for every
arbitrary task, or a globally bounded Native archive.

### Official-engine pre-turn compaction

The official Desktop engine can compact with the **previous Native model** before the
first Web request when switching to a smaller context window. This is separate from
Tela's Web checkpoint preparation; zero Web preparation calls does not prove zero
Native model calls. A completed Web answer does not establish a preparation-free switch.

An isolated probe of engine `0.167.0-alpha.3.2` confirms that this compaction carries the
current thread/turn identity and `model_downshift` / `pre_turn` metadata, but not the
selected destination model. The published [app-server contract](https://learn.chatgpt.com/docs/app-server)
provides a turn model override and manual thread compaction, without establishing a
separate pre-turn compaction-model override. Exact identity alone does not authorize
rewriting a Native model request or manufacturing its opaque compaction result.

Removing this Native preparation requires an engine-supported destination-aware
compaction policy and compatible continuation output. Keep this as an upstream
integration limitation until that contract is demonstrated; do not raise catalog limits,
disable Native compaction globally, restore a patched engine, or discard source history.

The installed baseline `97dc2d5` supports retained deltas, source-bound checkpoints, bounded
fragmentation, durable stage reuse and cost refusal but does **not** maintain a rolling working set.
In the subsequent local source implementation, `web-working-context-policy.ts` resolves one
calibration/operational policy; `native-working-context.ts` advances prior checkpoint + sealed suffix;
the existing `context-cache.ts` and `native-visible-prefix-journal.ts` atomically publish a
completed, source-bound checkpoint pointer. Both regular planning and Native local compaction call
that selector. These changes were included in the locally installed `f1a482c`
source release, not in the preceding `97dc2d5` runtime.

Product defaults remain **conservative calibration**, not discovered browser limits: 95,000
estimated resident tokens for physical rollover, the existing effort-dependent hard/checkpoint
source limits, 24,000 first-message operational target, 8,000 checkpoint-content target, 13,952
uncheckpointed-suffix target and 2,048 per-settled-turn output/tool reserve. A single large
settled revision may exceed the suffix target; one maintenance call must still pass the hard source
and finite preparation budgets. There is no dynamic Web capacity query.

Physical residency is estimated monotonically from accepted task input, observed settled
final-answer size, the serialized Native tool-result bytes actually released to the Web
turn, a per-tool-round overhead estimate and a per-turn reserve. Unserializable
Native result content invalidates the retained-context estimate rather than counting it as zero.
It is **not** billed provider usage and cannot observe all hidden reasoning or in-browser output.
A checkpoint or shorter Native active context
cannot subtract already-resident Web tokens. These estimates remain a limitation, not a guarantee
of actual account capacity.

## One capacity and working-set policy

Resolve Native settings through its supported adapter. Scope Web capabilities/usage to the proven
account/model/effort and adapter generation. Label values observed, configured or conservatively
estimated. Unknown Web capacity cannot be inferred from a Native template, API specification, model
name or one successful send. Keep existing isolated calibration explicit until a real capability
exists; do not claim dynamic discovery from a fixed value.

One pure policy resolver serves ordinary planning and local compaction. Keep distinct:

- Hard Web epoch/message/file/character capacity and output/reasoning/protocol reserves.
- A smaller operational first-message target with useful retained-continuation runway.
- Derived checkpoint-size and uncheckpointed-suffix targets.
- The existing preparation call/input/time policy, which grants no send authority.

Derive operational targets from the user working-context preference and provider evidence; keep
product defaults in one replaceable adapter, not per-incident thresholds or numerous UI knobs.
A hard limit is a refusal boundary, not a target to fill. The fresh payload is exact current
policy/environment/goal + checkpoint + bounded necessary suffix + active request/tool/media chain.
Normally it fits the first-message target with runway below the resident rollover boundary.
Mandatory exact content may exceed the soft target if it still passes hard admission; report that
condition rather than silently truncating it or presenting a preference as provider capacity.

`web-model-catalog.ts` overrides the Native template's capacity/compaction metadata with
Web-owned policy. Web rows must describe supported route behavior rather than inherit Native limits.
Do not change Native model rows, copy Web transport limits into global Native settings, or force
frequent Native compaction just to achieve a small initial Web message.

## Maintained checkpoint instead of accumulated summaries

Extend the existing account-scoped checkpoint store and stage journal: no second compressor,
execution ledger, background summarizer or task-history authority. Keep the latest useful checkpoint
on the active branch and bounded alternatives under existing retention. Its envelope carries compact
source coverage/anchor, semantic compatibility, bounded summary and evidence limitations/references.
Do not recursively embed every earlier summary or retain an unbounded list of covered turns.

At a proven settled boundary, fold the previous checkpoint plus only the new sealed suffix into a
replacement when suffix/runway policy requires it. This source must fit one summary operation.
Preserve objectives, current constraints/decisions, unfinished work, failures and readback references;
remove superseded narration from derived working context. Current authoritative instructions and
exact active requests remain separate from lower-priority summary prose. Original evidence stays
Native-owned and available through authorized readback.

Use one useful summary completion, including a necessary file receipt, without acknowledgement,
polishing or model-backed mechanical validation. Repeated summarization is lossy: test unresolved
commitments and readback behavior; source coverage/digests cannot prove semantic completeness.
Persist before physical release, and publish the new checkpoint only under matching Native source
and branch proof. Failure leaves the previous valid checkpoint usable; an uncertain completion never
advances coverage. Native compaction, edits and account/route changes require explicit source mapping
or revalidation. Text similarity cannot reattach stale ancestry.

Maintenance runs on demand at existing request/settlement boundaries. Coalesce/defer when safe; no
idle timer, model call on every turn or second writer. Optimize total preparation calls/bytes, new
surfaces and useful session runway together. Smaller first messages can require more maintenance;
neither minimum payload alone nor maximum session lifetime alone is the objective.

## Common planning and independent physical lifecycle

Ordinary Web requests and Native local compaction share working-set selection and cost admission:

1. Prove current Native authority, account/route and canonical branch. Reconcile uncertain work first.
2. With proven owned Web ancestry, preceding answer and capacity, send only the canonical delta.
   A new checkpoint or Native compaction alone does not require a new Web conversation.
3. For a necessary fresh conversation, select the cheapest compatible checkpoint plus bounded suffix.
   Advance it if required before opening the task surface. The first task message contains one
   prepared working bundle, not successive installments of the historical archive.
4. Maintenance uses the previous checkpoint plus bounded new suffix once, sharing the same preparation
   budget across continuity and compaction. Commit only on owned completion.
5. Genuine cold/edited legacy sources may need bounded bootstrap. Resolve compatible completed stages
   first, then admit remaining work. This is exceptional recovery, never the recurring normal-turn
   path. Bound source access, calls, input and time. Missing proof/budget requires explicit recovery,
   not more chats, automatic budget expansion or repeated reconstruction from zero.

The existing runner may use an isolated tool-free summary surface. Count these surfaces separately
from task conversations and account probes, and include all in churn/cost acceptance. Do not inject
several preparation installments into the fresh task conversation, hide extra summary prompts in
ordinary answers or share a live profile concurrently to reduce visible chat counts.

A local checkpoint cannot remove already-resident Web tokens. Keep the current page while ownership
and headroom permit; prepare a small successor bundle and rotate once when needed. Without a
supported provider operation, appending a summary does not reclaim capacity. Real ownership/generation
loss, incompatible route or edits invalidating retained ancestry may also require rotation. New
Native turns, checkpoint IDs, harmless presentation changes, cache misses and transport retries are
not independent rotation reasons.

Fresh creation requires a unique owned physical generation. A deterministic logical epoch ID alone
cannot prove that a page was reset. Full/checkpoint-delta plans need a fresh physical conversation;
only separately proven retained-delta plans can append to an existing one. Claim no shared provider
KV cache between Native/Web, accounts, models or sessions.

Track per-generation occupancy from accepted inputs and observed outputs/protocol usage. Use
exposed authoritative usage or a labeled conservative monotonic estimate, including answers and tool
rounds. Native compaction shrinking its active input cannot decrease old Web occupancy. Short deltas
and checkpoint creation do not reset it. Ambiguous acceptance preserves an unknown outcome and blocks
unsafe further admission. Commit once per operation; retries must not double-count or execute again.
Do not rely only on currentLogicalTokens minus baseLogicalTokens to prove remaining physical room.

## Source and recovery gates preserved

Native owns task/environment/tool authority. Responses metadata alone is not proof. The owned
Desktop proxy's original engine ACK attests only its exact live turn under existing socket, matching
request ID, metadata and revocation gates. A changed socket/owner, ambiguous ACK or completed/retired
turn revokes it. Readable authenticated current input needs no old-history read; it does not attest
historical execution or grant replay authority.

Public history/anchor paging requires proven indexed historyMode=paginated and matching
owner/environment before and after bounded reads. Never use thread/read(includeTurns:true), Legacy
resume/fork or a small public page size to trigger unbounded server-side reconstruction. Opaque
Native state cannot become invented plaintext or an allegedly complete suffix. Unindexed Legacy
history requires supported bounded Native source/continuation; a handoff prompt does not make Legacy
paging safe. Preserve typed nonretryable HTTP and already-started SSE recovery behavior.

Prefer retained context and completed readable checkpoints from the current supplied input.
The retired Native handoff prompt, answer verifier and derived handoff cache are not supported
recovery paths. Omitted history still requires a readable source; a summary cannot establish
Native execution authority. See [the current continuity boundary](native-web-continuity.md).

Cache loss affects reuse, never authority. Reuse compatible durable completed receipts first. Loss of
all usable source/checkpoints remains recovery, not guaranteed constant-cost successful cold start.
Unknown claims cannot expire/be evicted to authorize replay. Proven local release retains unknown
remote outcome and requires independent new Native authority for an admitted successor. Preserve
separate account-scoped stores, bounded derived retention and original claim identities. Evidence
references are not observations; old files/images/commands need current authorized readback.

## Implementation sequence and acceptance

| Slice | Existing boundary | Required change |
| --- | --- | --- |
| Capacity/policy | physical-limits.ts, web-model-catalog.ts, checkpoint-preparation-budget.ts | `web-working-context-policy.ts` resolves conservative calibration vs smaller targets; Web catalog rows no longer inherit Native context/compaction/output numbers. |
| Checkpoint advance | context-cache.ts, native-visible-prefix-checkpoint.ts, existing journal | Scope-bound rolling summary, completed stage -> durable same-journal pointer -> disposable cache. Missing cache can rehydrate; unknown stages cannot publish. |
| Common planning | native-request-planner.ts, native-context-continuity.ts, native-local-compaction.ts | Shared on-demand `selectNativeWorkingCheckpoint` selection. Compaction reuses prior working state without an extra bootstrap summary. |
| Physical lifecycle | web-epoch-pressure.ts, planner settlement, existing surface owner | Monotonic estimated residency per owned generation; checkpoint updates do not rotate a healthy retained page. |
| Evidence | Existing diagnostics and efficiency fixtures | Counted stage inputs/calls, coverage/reuse, checkpoint+suffix and resident estimates; Electron host counts successful task, summary, account/probe and setup surface acquisitions by purpose. Actual provider billing and failed partial OS-window allocations remain unknown. |

Implement in dependency order as reviewable slices. Do not install a partial checkpoint migration
that strands completed receipts. Keep source tests, installed readiness and actual useful live
continuation separate. No claim of infinite-conversation or constant-cost success before lifecycle
acceptance; real-use validation remains user-owned.

With deterministic histories/counting producers, vary archived length over orders of magnitude
while necessary active work stays fixed. After initialization, fresh task input, maintenance input,
pending suffix and new-call count must stay within the same configured budgets. Also test growing
active work and explicit oversize refusal: boundedness cannot depend on forgetting unresolved work.

Cover bootstrap, retained repeat/append, rolling updates/many rollovers, restart, cache loss with
surviving receipts, total loss, edits before/after checkpoints, Native compaction during a Web epoch,
large tool/output/media, cancellation, uncertain acceptance, transport duplicates and changed
account/model/effort/policy. Require no ordinary whole-history preparation, no task rotation solely
for checkpoint maintenance, one fresh task seed, zero summary calls for completed reuse, no extra
polishing/ACK and bounded auxiliary-surface counts. Retain meaning checks for objectives, active
constraints, decisions, unfinished work and readback refs. These fixtures prove structural/cost gates,
not lossless model understanding or real-account success.

### First Native-to-Web transition

Use the same supplied-input and retained-session rules described in
[native-web-continuity.md](native-web-continuity.md). Do not restore the retired
Native handoff runtime or hierarchical fragment/merge compressor to revive an
old conversation. Normal long conversations remain supported work; when their
readable context is unavailable, report that limit without sending an automatic
Native fallback or treating a partial summary as complete history.

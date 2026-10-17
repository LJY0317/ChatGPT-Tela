# Token and model-call efficiency contract

Minimize total model work subject to correct context, authority and execution semantics. Fewer
visible tokens alone are not success: never silently truncate evidence, reuse stale context,
change the selected model/effort, weaken cancellation, or replay an uncertain operation.

## Required order of operations

1. Reuse the exact owned conversation and send its canonical suffix when retained lineage is proven.
2. Reuse a verified completed checkpoint before producing one. Summarize only new or changed source.
3. Use deterministic local parsing, hashes, validation, deduplication and event-driven waiting for
   mechanical work. Do not add an LLM call for checks a program can perform.
4. When source cannot fit, summarize each exact fragment at most once per compatible scope/policy.
   Combine file-access evidence with the useful tool-free summary response; do not spend a separate
   acknowledgement generation per fragment. Missing capability fails explicitly, not via hidden
   extra calls, model switches, or a second implementation.
5. Bound and expose remaining preparation cost. A transport file is not compression or proof that
   all of its contents were understood. Estimates are not provider-billed token measurements.

Approval preparation is deterministic local work. Hidden-window progress must not depend on
animation frames or disabling background throttling. Use current geometry and exact revision proof,
a transient host deadline and the existing one-shot input boundary; do not add model calls, repeated
clicks or idle rendering to recover a stalled preparation.

A lower call count is not sufficient if it increases duplicated source or loses necessary context.
Cold preparation needs an economic admission plan based on compatible completed receipts, remaining
new calls, estimated transfer and elapsed-time bounds before sending. Source-byte and emergency
stage ceilings alone do not satisfy that target. Prefer incremental checkpoints over repeated
whole-history reconstruction. The source-byte ceiling remains 16 MiB; preparation is now admitted
against a separate owned cost policy, rather than the previous 128-stage emergency ceiling.

Validation must establish the specific evidence needed for request ownership, causal lineage,
completion and delivery. Perform deterministic checks locally; ignore irrelevant presentation
changes and avoid model-backed rechecking. Do not substitute arbitrary DOM selection, unrelated
visible answers or uncertain sends for those proofs. Distinguish an actual completed answer blocked
by observation from preparation-only work or an unaccepted request.

Retain causal submission proof independently of rendered-body availability. Display expansion must
not force cold reconstruction when the exact composer/send, logical parent and unchanged host input
still prove the owned request. Distinguish display evidence from ownership evidence in diagnostics.
Checkpoint local settlement follows proven physical release, not exception categories. Without a
matching closure receipt, failed observations remain unresolved. Completed stages stay reusable and
retired owners cannot resend. A new independently authorized Native owner may replace a locally
closed claim; this is never an automatic retry or a cold reset of the completed prefix.
Regression reviews must also check that a previously closed operation does not
trigger a fresh summary, cold session, repeated source transfer or unnecessary
manual reconciliation merely because its failure classification changed.

## Capacity, ownership and preparation policy

The [working-context lifecycle](context-continuity-contract.md) defines the next implementation:
bounded first-message and maintenance inputs, an incrementally advanced checkpoint, and independent
resident-session accounting. Current fit/cost refusals alone do not establish those steady-state
bounds. Do not equate full archived history with active working context or rotate Web merely because
a checkpoint changed. Use that contract's implementation order and long-history acceptance gates.

Native owns canonical task history, edits, authorization and compaction. Preserve logical/physical
context separation: the Web window is a projection, not a replacement authority. Obtain effective
Native settings and usage through the public Native adapter where available; never copy Native's
window size or opaque compaction state into a Web capacity claim. Model capacity, message/file
transport limits, the user's working-context preference and preparation cost are distinct inputs.
Reserve output/reasoning headroom and account for accumulated Web context separately from newly
transferred deltas. Unknown usage remains an estimate. The current Web physical-limit adapter still
uses isolated conservative calibration; dynamic capability/usage resolution remains unimplemented.

One `CheckpointPreparationBudget` belongs to one Native planner invocation. Continuity recovery,
fragmented request/history preparation and single checkpoint producers share it. No phase creates
fresh allowance; same-budget producer decoration is idempotent. The independent policy module owns
validation, cost admission and monotonic elapsed time. Logical lineage, durable execution claims and
browser acceptance retain their separate owners. Cost admission grants none of those authorities.

Defaults are at most 8 new provider attempts, estimated input no greater than eight fitted checkpoint
source windows, and no new attempt after 10 minutes of preparation. These are configurable Tela
product defaults, not OpenAI model limits, a response deadline or guaranteed billed-token counts.
An in-flight attempt is allowed to settle; total wall time may exceed the admission deadline by that
attempt. Reused completed receipts consume no attempt/input allowance and remain readable after the
admission deadline. A budget rejection is a nonretryable context-preparation limit, not evidence that
a send occurred or permission to retry a retired Native turn.

The durable ledger exposes bounded completed receipts without making execution claims. Verify their
exact stage/source/input identity, then estimate unresolved work before the first claim. Unknown
summaries reserve a conservative reducing binary merge tree; this upper bound can decline a tight
budget even if actual summaries would have merged more cheaply. Preflight and execution share one
merge-grouping implementation. Recheck remaining actual allowance before each new claim and before
entering the provider. If allowance expires while acquiring a claim, an identity-bound, proven
uninvoked stage is closed; a genuinely uncertain send remains pending. Completed summaries and
original claim identities are never deleted to make a plan admissible.

Admission policy does not participate in semantic stage identity: changing a cost budget must not
invalidate compatible completed summaries or bypass an unresolved send. The actual next context is
still the latest valid checkpoint plus its active suffix; edits exclude abandoned descendants.
Summary quality, real browser capacity and useful task completion need separate acceptance evidence.

Regression ownership: `checkpoint-preparation-budget.test.ts` covers accounting, time and producer
decoration; `native-context-continuity.test.ts` covers shared-phase allowance; checkpoint/journal and
`native-context-efficiency.test.ts` cover zero-budget durable reuse, cold rejection without claims,
late admission closure, real unknown-send fencing and continuation. Planner/product tests preserve
routing, Native ownership and policy propagation. Future policy patches must preserve these tests.

## Reuse and provenance

Reusable units are content-addressed within account, Native conversation, selected model/effort,
and summarization-policy boundaries. Whole-history growth must not invalidate an unchanged source
fragment. Exact stage inputs and completed summaries remain journal-bound; the final assembled
checkpoint must still prove complete ordered coverage of the current canonical source. Cache
eviction must never authorize repeating an uncertain submitted operation. Protocol upgrades must
honor unresolved older execution records rather than evade them with new keys.

Cancelled/ambiguous turns cannot advance retained anchors. A file-only summary has no tool authority.
Source confirmation, document ownership, Native input witnesses, structured completion parsing and
durable settlement are correctness checks; perform them locally wherever possible.

## Steady state and recovery

Proven retained context plus its canonical suffix is the steady-state target, not an unconditional
transport rule. Editing prior input, cancellation, lost physical ownership, model/account changes
and exhausted context capacity may invalidate that proof. Recover from compatible completed
checkpoints/fragments and send only the necessary reconstruction; never force a suffix onto an
unproven page or repeat full cold preparation by default. Recovery cost is explicit and bounded.

Keep preparation, Web submission, exact acceptance, model completion and Native delivery distinct.
A visible Web answer is not proof that it belongs to the accepted Native operation. Local acceptance
observation has a bounded deadline even when the browser stops changing; missing author proof
must produce a diagnostic failure, not an endless working indicator, a fabricated final answer or
an automatic resend. Mechanical receipt observation must not add a model call.

An activated send whose acceptance remains unproven uses the closed
`tela_web_submission_unproven` classification. Preserve that first structural reason across
retirement, HTTP rejection and an already-started progress stream; reconnects must not launch a
second execution. Reconcile the existing submission before a new authorized turn continues.
Author candidates forming one containment chain may collapse to one payload only when the
outermost and innermost complete text agree under the existing line-ending normalization. This
preserves the original fingerprint across redundant wrappers without model calls or DOM mutation.
Sibling/branching candidates remain ambiguous. Unequal endpoints of one chain expose two alternative
fingerprints, not standalone author proof. Within a causally owned unique user turn with a logical
anchor, exactly one endpoint matching the full expected payload may establish identity. The same
resolver governs acceptance, ongoing parent/rekey proof and owned synthetic saved-chat checks.
Never select by position, preview visibility or a substring; a conflicting primary payload cannot
be overridden by alternatives. Inspect at most64candidates and read at most two endpoint payloads
under the existing payload bound. Diagnostics report only candidate count, nesting, endpoint lengths,
equivalence and expected-match booleans, never texts or candidate fingerprints.
Unresolved alternatives supply no content identity. This evidence adds
zero model calls, context injection or successful-turn prompt bytes. Completed preparation receipts
remain available under their original source/account/model/policy identity.

Full author-text rereading after Send is not a universal identity requirement. A guarded causal
submission receipt may combine the verified full pre-send composer, single activation, consumed
composer and unique new logical user/assistant parent under unchanged host input ownership.
This is a local deterministic proof with no extra model turn, receipt-ack generation, context
upload, summary or prompt token. It must not be described as server-byte acceptance or semantic
comprehension. Rendered previews and virtualization do not by themselves invalidate logical context
or completed summaries. Missing causal/ownership evidence still blocks delivery, never authorizes replay.

## Regression and review gates

### Upstream changes must not trigger repeated model work

Optimize total useful-task cost, including failed attempts and recovery, rather than only tokens
in one request. Observation-adapter revisions, selectors and presentation fingerprints must not
participate in semantic checkpoint identity. Change the summary-policy identity only when its actual
semantics change; preserve unresolved-operation ownership across that change. A renderer failure
alone must not evict completed summaries, invalidate canonical context or initiate cold preparation.

For every observation/recovery patch, compare cold, retained, exact-repeat, append, edit and
observation-failure paths using counted provider attempts and durable receipts. Retained continuation
and mechanical recovery add zero preparation calls; identical completed preparation adds zero new
summary calls after cache loss. Edits reuse compatible unchanged fragments and rebuild only affected
coverage/merges. Do not claim that every edit can retain its physical Web session.

Report actual counters separately: new/reused fragment and merge stages, preparation/task calls,
estimated newly transferred and duplicated input, preparation duration and useful final delivery.
Label missing provider usage as unmeasured; byte/token estimates cannot prove billing or comprehension.
New diagnostic checks add no prompt bytes or model calls. Prefer bounded event-driven local evidence
over repeated model inspection. An efficiency regression requires an explicit correctness/capability
reason and a measured bound; passing an emergency cost cap is insufficient.

The identity/recovery design and unimplemented gaps are in
`docs/architecture.md#change-resilient-web-identity-and-recovery-design`.

Changes to prompts, context, tools, retries, routing, delegation and monitoring must state their
effect on model-call count, duplicated input, output bounds and reuse. Normal retained continuation
must add zero preparation model calls. An attachment-backed checkpoint must use one useful model
response, with no separate acknowledgement response. Repeating identical source after disposable
cache loss must use completed journal receipts; appending source must reuse unchanged fragments.
Foreign account/model/policy, edited content, incomplete coverage, wrong receipts and uncertain
submissions must not count as reuse. Verify these with counted provider calls and real local
journals, not timing-only tests or assertions about helper implementations.

Diagnostics are structural, bounded and on demand: distinguish preparation sends, completed reuse,
transferred bytes/local token estimates, elapsed preparation, actual task start and task outcome.
They must not collect source bodies, run model-based polling, or manufacture semantic-recall proof.
No change is accepted as an optimization merely because its prompt is shorter. Call counts and
local estimates provide regression evidence; real Web quality and latency remain acceptance work.

`bun run verify` includes the counted transport, durable fragment-reuse and retained-continuation
tests in the existing macOS/Windows/Linux CI matrix. Review changes to those budgets alongside
implementation changes; passing fixtures do not establish real model comprehension.

## Protocol transition and observation

The v2 fragment identity separates exact stage content from whole-source provenance. Account,
Native thread, model/effort and semantic summary policy still scope reuse. The journal checks
pending operations atomically before granting new work. Admission uses a stable account/thread
scope independent of source growth, model, effort and summary policy; those dimensions still
restrict completed-summary reuse. Older pending records without a scope cannot be proven foreign
and conservatively block new claims in their account ledger. Exact completed receipts remain
readable without authorizing another send. Completed
whole-source checkpoint caches remain readable; older fragment receipts cannot be reinterpreted
as v2 semantic receipts. A first v2 preparation may therefore incur a cold cost. Older binaries
do not understand v2 journal keys: downgrades must preserve the journal and use compatible recovery,
never delete execution records to make an older reader proceed.

`checkpoint_transfer_planned` reports one planned summary call, zero separate acknowledgement
calls and source/transfer estimates. `native_checkpoint_efficiency_settled` reports actual stage
attempts, completed receipt reuse and accumulated transfer estimates for successful preparation.
Existing stage-settlement/failure events cover interrupted preparations. These counters explain
transport work; they do not measure provider billing or certify semantic retention. A real task
using executable tool authority retains its separate existing admission/receipt checks.

## Implementation sequence (2026-10-16)

1. Establish this contract and persistent contributor guidance before changing behavior.
2. Collapse tool-free checkpoint file receipt and summary into one submit/completion contract.
3. Make fragment execution identity independent of unrelated whole-source growth; retain the full
   source coverage proof and protect pending legacy operations across the protocol transition.
4. Add counted cold/repeat/append/edit/isolation/cancellation and retained-continuation regressions;
   document measured limits and validate the signed candidate separately from real usage.

This is a project-wide design constraint, not a claim of globally optimal token use. An intentional
increase in model work needs a concrete correctness/quality requirement, measured alternatives and
reviewable acceptance evidence; update this contract and regression budgets with that decision.


## Production source and settlement boundaries

Canonical provenance and payload integrity are separate: the public history reader binds its
owner/source digest and independently hashes the exact serialized content. The compressor verifies
payload bytes without substituting that hash for canonical provenance. Request-prefix serialization
keeps ordered revision identities inside the source, and excludes the changing outer head field so
that appending a revision leaves earlier fragment bytes unchanged. This format correction can
require a first preparation for older completed request-prefix inputs; it never discards or bypasses
an older pending operation.

Persist each validated bounded summary under its exact journal claim before releasing the isolated
browser surface. Release/cancellation failures must fail the current run, but cannot erase a completed
receipt or force the next owner to summarize those bytes again. A failed durable write stays unknown.

Distinguish an uncertain submission from a proven same-operation completion whose machine response
is unusable. The latter closes only after successful physical release; it does not commit a summary
or authorize replay by the same Native owner. A separately authorized new Native turn may claim a
new isolated operation. Foreign identities, unproven completion and failed release remain unknown.
This proof path applies to newly observed operations; missing historical evidence cannot be
manufactured retroactively. Local transfer estimates include the actual formatted transport
contract, source bytes, receipt footer, media manifest and deduplicated media bytes; estimates
remain distinct from billed tokens.


## Releasing interrupted owners

Maintenance can settle an exact pending operation after a verified owned lifecycle cutover proves
its original physical owner was released. Prove Native work idle before that cutover, bind the
installed/target/account/generation receipts, and recheck owner absence and exact original claim
under the journal writer lock immediately before mutation. Current readiness, elapsed time,
a new Native turn or an error log alone cannot establish release. Records without a turn owner
require whole-generation quiescence proof. Preserve the original identity and claim, existing
completed summaries, and unknown remote outcome; settlement means local closure, never success.
The retired Native owner cannot submit again even under a changed stage key. Only independently
proven new Native authority can start another isolated operation. This maintenance contract applies
to both legacy and current records through one settlement API; do not add version-specific retry paths.

### Diagnostic accounting must not become model work

Turn-level diagnostics aggregate existing execution events and locally known byte lengths; they
add no context text, acknowledgement generation, model call, or cache-key policy. Keep encoded
context/protocol bytes, prepared drafts, activation attempts, tool-result text/media and MCP
transport envelopes distinct. Overlapping byte categories are never summed as billed usage.
A complete process-local terminal receipt does not prove cross-service cost, comprehension or
host display. Unknown/clipped measurements stay explicit. Preserve the cold/repeat/append/edit
and retained-context gates when instrumenting these paths; see `docs/diagnostics.md` for the
bounded summary and correlation contract.

Retained-answer codec changes must preserve an unchanged extended DOM body without another model
call, checkpoint or whole-history transfer, and reject changed source attributes/namespaces even
when display text matches. Unsupported elements use one bounded lossless representation rather
than a growing tag exception table. Local normalization is not an extra inference step. Existing
cold/repeat/append/edit/recovery cost gates still apply; unavailable proof grants no fallback send.

Compaction retry gates must cover transport/correlation-only changes (one summary result or the same
cached pre-send failure), JSON key order, changed source/instructions/model/environment (no new call),
concurrent waiters and revoked owners. Diagnostics and canonical failure replay add no model calls,
new physical sessions or full-history projection beyond the original operation. Source fitting uses
the provider capability limit and includes full readable evidence. Oversized readable text uses the
existing account-bound request-prefix compressor and durable stage receipts, with one shared budget
for continuity and compaction. Return the final merged summary without another polishing call.
An insufficient whole-plan budget, missing journal, unsupported media or uncertain stage still blocks
before further sends. Enabling staged compaction does not raise the default preparation budget;
very large cold histories may still need a verified checkpoint or explicitly configured cost policy.

## Rolling working-context accounting (signed local source installation; 2026-10-17)

`web-working-context-policy.ts` resolves the common policy for regular Web tasks and
Native compaction. Fixed conservative capacity calibration is not browser discovery.
The default first-input (24k), derived checkpoint (8k), suffix (13,952) and
per-turn output/tool reserve (2,048) are distinct from hard Web refusal limits and
the unchanged 8-model-call, 8 × source-budget, 10-minute preparation admission.
Oversized exact current user requests, high-priority instructions and required
tool evidence are not trimmed to meet an optional soft target.

`native-working-context.ts` selects the newest source-compatible checkpoint on
the active Native branch. On-demand maintenance seals the previous lossy summary
plus its complete *new sealed suffix*, never an ever-growing summary chain.
The existing `native-visible-prefix-checkpoint.ts` compressor and account-scoped
execution journal remain the sole stage-send authority. The same journal durably
publishes the completed-stage/anchor/route pointer before the disposable cache
is written. Lost cache with intact published pointer yields zero summary calls;
lost ledger, uncertain operations, changed scope and edited ancestry fail closed.
Read historical details again through currently authorized Native tools.

When irreducible instructions/current work already exceed the fresh-input target,
minimize optional archived assistant/tool presentation instead of filling the
remaining hard window. Required Native tool evidence and protected checkpoints
remain exact. Do not raise rollover limits or re-summarize the same source merely
to hide an oversized seed. `web_turn_plan` partitions the prepared seed into
authority/user/checkpoint/protected-tool/other UTF-8 bytes and records the target,
whether it exceeds the target/rollover threshold, prior settlement and existing
rollover pressure. These are local estimates, not provider billing; unchanged
checkpoints and a fresh browser do not imply retained physical context.

Ordinary task checkpoint maintenance does not replace an owned retained Web
conversation. Necessary fresh tasks contain one inline working bundle without a
preload/ACK. Resident usage is a conservative, monotonic **estimate**, composed
of input transfer, observed settled final-answer bytes, serialized Native
tool-result bytes actually released to the browser, per-round overhead and a
per-turn reserve. An unmeasurable Native result prevents unsafe retained reuse.
It is neither Native logical token delta nor provider billing. Native local
compaction reuses the same checkpoint selection/budget and makes one final
summary call. Neither path adds idle or per-turn background model work.

Deterministic local regressions count stage model calls, input estimates and
compatible completed reuse, multi-rollover behavior, cache loss/restart,
changed historical content, journal loss, media, cancellation and unknown sends.
The Electron composition's one BrowserHost acquisition boundary records
`web_surface_acquired` events with purpose and process-local total/purpose
counts, including task, summary, account probe, profile probe and setup windows;
the deterministic desktop fixture checks these categories. Events count only
**successfully owned browser leases**, not failed partial OS-window creation
and not chargeable provider operations. Checkpoint stage/send events separately
count possible model work. Actual provider billing, hidden reasoning/output
and live account costs remain **unmeasured** and require owner validation.

#### Cold source versus retained-page update acceptance

For a synthetic 411-item/468,190-token cold source, preflight predicted
9 stage calls and 873,988 total summary input tokens, exceeding default
8-call/791,240-input admission; 0 summary calls and 0 task chats were opened.
These figures are deterministic fixture projections, NOT a measurement of the
specific incident or a provider bill. Completed compatible checkpoints are
reused first at zero model calls. An explicitly user-requested, bounded Native
handoff incurs one Native turn/model call plus one Web task seed, subject to
public indexed history/current-turn verification; Legacy history has no such
safe paging shortcut. Retained Web deltas proceed even if optional summary
maintenance is declined before any execution claim. A maintenance failure with
an uncertain stage never grants an alternate send or reusable completion.

## Oversized mandatory seed diagnosis

A successful transport is not an efficiency verdict. If required current instructions already
exceed the soft epoch rollover limit, a fresh seed can trigger rollover again on the next turn.
Correlate seed authority partitions, settled occupancy, retained-surface evidence and checkpoint
calls across turns before changing policy. Do not fix this by hiding current instructions,
raising the hard window or adding repeated checkpoint calls. Reduce redundant declarations at
the canonical source where authorized, or design bounded retention against proven provider
capacity. Until that is established, report the cost and unresolved rollover condition explicitly.
An automatically continued goal can start new turns correctly while the model repeats completed
checks; distinct canonical revisions and tool results distinguish that from transport replay.
Tool completion alone does not prove meaningful task progress or semantic memory retention.

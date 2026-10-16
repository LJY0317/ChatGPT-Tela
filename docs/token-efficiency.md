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

## Capacity, ownership and preparation policy

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

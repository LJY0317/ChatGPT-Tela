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

## Regression and review gates

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

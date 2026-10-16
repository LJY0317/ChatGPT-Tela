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
pending v1 operations of the current source atomically before granting a v2 claim. Completed
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

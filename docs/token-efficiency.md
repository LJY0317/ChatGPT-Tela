# Token and model-call efficiency contract

Minimize total model work subject to correct context, authority and execution semantics.
Never silently truncate evidence, reuse stale context, change the selected model/effort,
or replay an uncertain operation to save tokens.

## Continuation and preparation

1. Reuse the exact owned conversation and send its canonical suffix when lineage is proven.
2. Reuse a compatible completed checkpoint before producing one. Maintain the previous
   working summary plus only its newly sealed canonical suffix, not the original archive.
3. Prepare a complete fitted working snapshot in **one** model operation. Automatic source
   fragmentation, intermediate acknowledgement conversations and merge trees are unsupported.
4. Keep current user work and exact system/developer instructions outside lossy historical
   summaries. Reattach only missing instruction revisions; identical prose alone is not identity.
5. Bound fresh seeds, maintained summaries and tool/assistant growth separately. A transport
   file is neither compression nor proof that the model understood every byte.

One `CheckpointPreparationBudget` belongs to one Native preparation across continuity,
working-state maintenance and compaction. Default allowance is one new provider attempt,
one fitted checkpoint input and no new admission after ten minutes. Completed receipts
cost no attempt/input allowance. An in-flight attempt may settle after that admission
period. A rejected budget does not prove a send or authorize replay.

Native local compaction already owns a summary operation. It selects existing working
state without first producing an intermediate maintenance summary and summarizing again.
Its source is the selected checkpoint plus the unsealed suffix, including any new
instruction revisions. Do not reattach checkpoint-covered historical instructions to
this summary source: Native restores its current initial context after compaction.
Ordinary task transport still preserves exact instructions outside historical summaries.
Preparation and the actual task answer are counted separately; a retained healthy task
usually needs no preparation model call at all.

## Capacity and regular maintenance

Native owns canonical task history, edits, authorization and compaction. Web state is a
working projection, never a replacement authority. Web model catalog rows publish the
Web adapter's conservative context window and automatic-compaction boundary, rather than
inheriting Native model capacity or leaving it to an unrelated model default. Native
catalog rows and global user context settings remain unchanged.

The current adapter uses conservative browser calibration, not independently measured
provider capacity. Working policy targets a fresh seed of at most 24,000 estimated tokens,
a maintained checkpoint of roughly 8,000 and a bounded recent suffix. These are operational
targets, distinct from the hard input limit and output headroom. Count accumulated Web
assistant/tool output as residency; do not confuse newly transferred deltas with total use.

Maintain the working state before sealed history outgrows its single-input summarizer.
Existing tests exercise long incremental archives, repeated physical rollover, cache-loss
restart and a maintained-summary-plus-new-suffix source. Original archives stay in Native;
they are not repeatedly injected into a new Web conversation after compaction.

A fresh exact request may exceed the soft seed target if irreducible authority/current
work still fits the hard window. Do not repeatedly rotate and resend that same seed.
Do not truncate a current request or paraphrase authoritative instructions to satisfy a
soft target. Diagnose upstream authority duplication separately.

## Cold imports and forks

A fork or edited continuation has independent execution and physical Web ownership. Completed
plaintext working summaries can be reused across tasks or Web model changes only when the
account, summary policy and complete ordered source prefix match exactly. A change inside
that prefix invalidates reuse; changed current suffixes remain independent. Durable prefix
digests are published with the existing completed checkpoint, without another model call.
Legacy publications gain this proof only after exact same-task ancestor validation. Media
prefixes are not shared across tasks. A large unmaintained cold import remains different
from failed maintenance of a previously managed Web working set.

This proves equivalence of the complete source prefix already present in the current
canonical request, not a Native parent/child relationship or a public fork-point contract.
It reuses derived prose only; it neither reads another branch's suffix nor transfers its
execution, tool or physical-session ownership.

If the complete cold source cannot fit one summary input, preserve it and return the
explicit checkpoint/handoff recovery. Do not launch repeated fragment/merge requests,
raise a hidden retry allowance, silently omit history, or claim a one-pass recovery that
did not occur. Existing oversized archives may need an explicit Native checkpoint before
switching back to Web; the preventive working-set policy does not retroactively shrink them.

## Durable reuse and ownership

One account-scoped stage journal owns summary submissions and completed receipts.
Caches are disposable derived data. Preserve compatible published checkpoints across
cache loss; never clear uncertain claims to allow another send. Exact account,
policy, source and active ancestry determine derived-summary reuse. Model/effort and task
identity still bind physical Web sessions, execution claims and uncertain operations. Current turn identity
owns execution; derived historical prose cannot grant tool or approval authority.

An undelivered completed response belongs to its canonically bound Native turn, not the
request's transport bytes. Compaction may replace the history before final delivery; return
the existing immutable result without re-execution. Pending steering stays unconsumed until
that final commits, then requires the ordinary final anchor and canonical input witnesses.

Persist each validated bounded summary before releasing its isolated browser surface.
A cleanup failure cannot erase a completed receipt or require a second summary call.
Failed durable writes and uncertain submission remain unknown. A proven unusable result
may be closed after release, but a retired turn cannot replay it. Original Native history
and evidence remain available for authorized source readback.

## Evidence and comparisons

Report task/preparation calls, completed reuse, fresh seed, suffix, summary and physical
residency separately. Counts and token estimates are not provider billing. Correlate
planner decisions with stage/settlement receipts; missing logs are not proof of failure.
Raw source and provider evidence remain local opt-in with bounded retention.

## Standard engine and optional fork

The engine executing Native tools is required by the current Desktop integration; a
Tela-specific engine fork is a separate dependency. Prefer public Codex contracts:

| Responsibility | Current evidence and decision |
| --- | --- |
| Web summary transport | Standard Responses compaction-v2 (`compaction_trigger`) now uses the existing selector, budget, journal and single summary producer. No separate compressor or engine patch is needed for this transport. |
| Summary replay and Native switch | A bounded transparent Tela envelope is returned as one `compaction` item. Web reads its historical summary; Native forwarding translates only Tela envelopes to ordinary summary text. Unknown provider-encrypted states keep their existing source-recovery path. |
| Startup model catalog | Standard `model_catalog_json` exposed a custom Web row through actual `model/list` in the isolated official-engine fixture. This does not prove Desktop picker rendering or live invalidation. |
| Automatic pressure without usage | The official-engine fixture observed no automatic compaction after a large synthetic reply with `usage: null`; explicit compaction succeeded. The installed fork's local pressure estimate still has a purpose until an equivalent standard path is verified. Do not fabricate provider usage to trigger it. |
| Live catalog refresh | A fork RPC refreshes an engine catalog but does not invalidate Desktop's picker cache. Retain capability-gated compatibility while verifying supported lifecycle behavior; do not add another refresh protocol. |

The local text transport remains compatible with the installed preview. The legacy Web
`/responses/compact` endpoint remains unsupported; standard compaction-v2 is supported.
Terminal source/budget errors use HTTP 400 with their existing recovery codes: the
standard engine retried 422 three times in the synthetic failure fixture, but made one
request with 400 and then continued a new turn with the original history. The installed
older local-compaction loop still retries 400; a status change alone does not repair it.
No installed engine has been replaced by these source changes.

`packages/development-runtime/src/fixtures/standard-engine-compaction.ts` runs a supplied
engine through public paginated RPC with an isolated temporary home, a supplied public
model catalog template, and synthetic model responses. It checks model-list seeding,
compaction, subsequent Web planning and Native forwarding. Run it with `--engine`,
`--catalog`, and optionally `--output`, `--scratch-root`, or `--auto-limit`.
`--reject-compaction source-budget` or `--reject-compaction summary` checks terminal
rejection, single summary admission and continued access to unchanged history.
It makes no browser/model calls and does not validate real model quality, Desktop UI,
provider billing, or production automatic pressure. A successful manual fallback is
reported separately from the observed automatic-compaction count.

[CodexGPTWeb compaction](https://github.com/miuuyy/codex-chatgpt-web/blob/cdfceafd51df9ab6f19818c145eac5a99c593a3d/src/responses/compaction.ts)
and [Native forwarding](https://github.com/miuuyy/codex-chatgpt-web/blob/cdfceafd51df9ab6f19818c145eac5a99c593a3d/src/native-passthrough.ts)
show the same useful contract boundary: standard remote compaction and provider-owned
summary decoding. Its model usage estimates and experimental multipart policy are
project choices, not proof of ChatGPT capacity or Tela billing. Tela does not adopt
opaque-history omission or automatic fragment/merge recovery.

[Codex Proxy](https://github.com/icebear0828/codex-proxy/tree/f824033a88e28d82f25db562e22758c383bfc177)
uses a standard compact endpoint and an optional official app-server bridge, but relays
API/account traffic rather than Tela's browser model session. Its account routing and
failover machinery do not address these continuation defects and are not dependencies.

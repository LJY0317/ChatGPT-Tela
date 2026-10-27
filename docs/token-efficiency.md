# Token and model-call efficiency contract

Minimize total model work subject to correct context, authority and execution semantics.
Never silently truncate evidence, reuse stale context, change the selected model/effort,
or replay an uncertain operation to save tokens.

## Continuation and preparation

1. Reuse the exact owned conversation and send its canonical suffix when lineage is proven.
2. Reuse a compatible completed checkpoint before producing one. Maintain the previous
   working summary plus only its newly sealed canonical suffix, not the original archive.
3. Prepare one fitted historical prefix in **one** model operation and retain its complete
   successor verbatim. Automatic source fragmentation, intermediate acknowledgement
   conversations and merge trees are unsupported.
4. Keep current user work and exact system/developer instructions outside lossy historical
   summaries. Reattach only missing instruction revisions; identical prose alone is not identity.
   Apply this to global and project instructions in standalone Chat and delegation alike:
   avoid repeated tool-result injection when prior delivery remains proven and applicable;
   reload changed sources or missing context rather than assuming another chat received them.
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
Preparation and the actual task answer are counted separately. A healthy retained page
selects existing checkpoints without invoking proactive summary maintenance. Prepare a
new summary when a fresh page or Native compaction actually needs one.

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

At rollover, advance the working summary through complete historical exchanges that fit
one summarizer input; do not require the entire sealed suffix to fit that operation. Keep
the remaining suffix exact rather than trimming assistant prose for presentation. Admission
and production share the same source envelope and transfer estimate. Existing tests exercise
long incremental archives, large answers crossing the summary limit, repeated physical
rollover, cache-loss restart and a maintained-summary-plus-new-suffix source. Original
archives stay in Native; they are not repeatedly injected after compaction.

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

Indexed opaque-history recovery imports the complete public source as ordered historical
revisions, then uses the ordinary working-checkpoint selector. It no longer requires a
separate whole-history summary first. Historical Native turn boundaries permit one fitted prefix;
the complete successor, current request and current authority remain exact. Old public
hook/instruction items remain historical evidence, never current system/developer authority.
A small import needs no preparation. A compatible working checkpoint may avoid preparation;
a fresh page needing maintenance shares the normal one-call budget. A healthy retained
page keeps the frozen source and media provenance without repeating import or uploads.
The disposable frozen-source cache is bounded by both entries and total source/media bytes.

Native canonical history, its derived Web working context and the resident browser epoch
remain separate. A proven summary prefix does not prove page residency or grant execution
authority. Unknown overlap between public history and canonical Responses input is retained;
text similarity is not sufficient evidence to remove historical items.

If one fitted prefix plus its exact successor cannot fit Web, preserve it and return explicit
checkpoint/handoff recovery, before a summary known to be useless. This remains a supported
large-history limitation, not a reason to revive legacy replay or truncate evidence. A
smaller seed with deferred original ranges requires a real authenticated Tela Chat body-read
capability first. Current structural Native inspection is not that reader. The Native history
source shares the public `thread/items/list` page reader, including a selected `turnId` and
exclusive item anchor; this is not yet exposed as a Web readback capability. Bind that future
capability to the current account, branch and explicitly deferred ranges, not an arbitrary
model-supplied profile or thread. Return readable original items rather than whole-turn replay
or Base64 fragments. Do not duplicate the archive, add a search engine or promise readback
that Web cannot perform. No background Native summaries, automatic
paid Native fallback or fragment/merge chain is authorized by this policy.

## Durable reuse and ownership

One account-scoped stage journal owns summary submissions and completed receipts.
Caches are disposable derived data. Preserve compatible published checkpoints across
cache loss; never clear uncertain claims to allow another send. Exact account,
policy, source and active ancestry determine derived-summary reuse. Model/effort and task
identity still bind execution claims and uncertain operations. Physical session reuse
requires the same model; effort is applied per submit without retiring a proven page. Current turn identity
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

## Native Goal continuations

Goal accounting (`tokensUsed`, elapsed time and update timestamps) stays in Native
state, outside canonical Web context identity. Only operative status, objective and
budget belong to the projected Goal observation. Otherwise every accounting update
rewrites the conversation ancestry and forces another summary and fresh Web page.
Place the latest Goal observation after canonical Native input and bind retained
completion to the last canonical input revision. A changed objective, status or
budget then updates the current protected tool-result without rewriting older
history or invalidating the prior Web answer witness. This change affects new
projections; previously persisted checkpoints still require exact ancestor proof.
An active Goal can continue through a Native developer message without a new user
message; preserve that role and send only the verified retained suffix.

Native owns Goal scheduling and its public `thread/goal/*` lifecycle. A final answer
or “done” phrase does not complete a Goal. For coordinated Web workers, the Native
coordinator reviews the assigned result and explicitly settles that worker's Goal;
installation or integration outside its assignment belongs to the parent Goal.
If the assigned work is blocked, record the remaining dependency and stop automatic
repetition instead of leaving the Goal active to rerun unchanged checks. Tela Chat
execution must not regain the legacy Native work-tool bridge to change Goal state.

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

[CodexGPTWeb compaction](https://github.com/miuuyy/codex-chatgpt-web/blob/0901b9fb1976b4a984c7e9b4082c2868767bbf7c/src/responses/compaction.ts)
separates Native compaction output from provider-readable summaries. Its unknown encrypted
history becomes an unreadable-history note; its optional multipart transport and compaction
fit trimming are not Tela's preservation policy. It does not establish lossless cold Native
history transfer or provider billing/capacity guarantees.

[Chat on Steroids handoff](https://github.com/totec448-spec/chat-on-steroids/blob/ccead536f29d566927d63e8f508104cd8e1c3071/src/main/session/handoff-prompt.ts)
asks the existing Web conversation to write its own brief, then continues in a fresh chat.
Its durable local session can outlive a physical chat, but that Web-resident source differs
from Tela's first import of opaque Native state. Adopt the separation and on-demand history
principle, not another Goal/session engine or an assumption that Native state is portable.

[Codex Proxy](https://github.com/icebear0828/codex-proxy/tree/f824033a88e28d82f25db562e22758c383bfc177)
uses a standard compact endpoint and an optional official app-server bridge, but relays
API/account traffic rather than Tela's browser model session. Its account routing and
failover machinery do not address these continuation defects and are not dependencies.

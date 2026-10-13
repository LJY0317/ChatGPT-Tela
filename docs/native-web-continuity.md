# Native and Web continuity: automatic cold-history handoff

For the source architecture and exact Native/physical Web ownership contract,
see `docs/context-continuity-contract.md`. The same context selection now serves
ordinary Web turns and Native local compaction. An explicit old-style handoff
works only where authenticated recent-turn summaries are **indexed Paginated**,
not on older unindexed Legacy history.

Native Codex remains the only authority for task state, tools, approvals, cancellation and compaction. Tela's readable Web context is a lossy physical representation, never a permission grant or direct Native model-state export.

## Normal use

### Installed first-use acceptance checkpoint (2026-10-12)

On the locally installed signed `01e0178` source-based Tela preview,
the **mainstream default Web profile (slot 1)** passed two bounded browser
canaries: a real model picker discovered three families, exercised a
selection and verified restoration of the original family/effort; a separate
synthetic 200,316-byte context attachment returned the exact expected
request-bound receipt. Neither canary submits a model request, starts a
Native fork, reads the real user's Native history, or verifies continuation
after a Native tool call. They establish real installed **picker and context
transport** readiness, not first useful Web execution or automatic opaque
73 MiB Legacy recovery. A separate optional Web profile remained failed;
its readiness must not be inferred from slot 1 or repaired by changing
another product's login/profile owner. The remaining next major acceptance
is a separately owner-authorized original-task, same-turn Web/tool/final
round trip.

Choosing a Web model normally does not launch a Native summary model call.
A verified retained Web session receives only the new suffix. A new Web
session preferentially uses an integrity-checked Native-compaction-anchor-bound
readable checkpoint; if the complete historical source fits within a bounded
model budget, Tela may create such a Web-side checkpoint.

The owned default Desktop proxy can also prove a **fresh original Native
turn** in a Legacy thread using its accepted public `turn/start` response
and bounded metadata-only `thread/read` checks. This admits Web execution
only when the current Native request already contains complete **readable**
task context. No Legacy history page is requested and the proxy receipt is
revoked on turn/connection loss. A cold restart without the receipt or an
old opaque compaction still fails closed; this is not full automatic
reconstruction of the 73 MiB source. Other/native managed profiles without
an owned proxy receipt retain the indexed-mode requirement.

For **first Web use after a long Native-only session**, a publicly readable
`context_compaction` marker followed by its Native-provided user summary
supersedes *earlier* model-visible user/assistant/tool history in that same
authenticated current request. Tela checks every earlier readable marker,
selects the **latest** valid boundary, and projects only its summary and
subsequent turns alongside current instructions and independently verified
owner/goal evidence. Superseded tool outputs must not inflate the first Web
transfer or be presented as current work. This requires a real readable
summary: it does **not** decrypt opaque Legacy compactions, recover unindexed
historical model state, or claim prior tool evidence was newly verified.

**Experimental cold automatic fallback (not enabled in production):** When no readable checkpoint
or complete Web-sized historical source can be supplied, Tela's isolated fixture tests an
single extra Native model call through the **public app-server** without a
separate copy/paste prompt or user-confirmation dialog. The user-selected Web
turn stays on its original Native thread. An ephemeral Native fork is created
from its immediately previous completed turn, never from the active Web turn.
Only an unambiguous currently advertised Native model may summarize it. The
fork defers and clears any inherited automatic Goal continuation before
running a read-only, no-approval structured-output prompt. Unexpected tool
items reject the fork and trigger interruption of its **own** turn only.
No original Native task, tool or approval state is modified. The extra Native
model request is explicitly recorded in payload-free routine diagnostics.

**Production does not install the experimental automatic-handoff callbacks
at all; its standalone adapter also rejects before RPC connect.**
The public Codex engine does not yet prove historical executed model/provider
provenance or a pre-execution tool-free fork policy. Tests of fixture behavior
must not be mistaken for a released feature.

The experimental resulting JSON records objective, constraints, completed and pending
work, decisions, file/evidence hints and evidence limitations. It is
**lossy context, not original source evidence**. Its exact source turn,
content digest and opaque Native compaction fingerprint bind an account-scoped
cache. After restart, public recent-turn ancestry must be re-proven; on a
live retained Web page only the new logical delta is transferred.
The product has no extra Native summary attempt counter while this
research-only feature is unshipped. No secondary model inference is
started merely because a user selects a Web model.

## Old long conversation, no readable checkpoint

The public Codex core contains human-readable compaction summaries internally, but the published app-server ContextCompaction item exports only an ID. Tela never reads private rollout files, official app databases, cookies or undocumented storage.

If the original long conversation cannot be resumed on Web, **check its
public history mode first**. If the active thread is Legacy, missing a
verified mode, or another unindexed mode, Tela returns nonretryable 422
`tela_native_history_indexed_source_required` with
`recovery.kind:continue_on_native`. Continue in Native; neither a
small `turns/list` request nor another explicit handoff turn makes this
Legacy server-side replay safe. Do not paste private history or access
undocumented official Desktop stores.

For an explicitly verified **Paginated** Native thread, the older
user-requested handoff remains source-only:

1. Stay in the SAME Native conversation and select a Native model.
2. Submit the EXACT prompt exported as NATIVE_WEB_HANDOFF_PROMPT in packages/codex/src/native-handoff.ts. To display a copyable version from the Tela project root, run:

       bun -e 'import { NATIVE_WEB_HANDOFF_PROMPT } from "./packages/codex/src/native-handoff.ts"; console.log(NATIVE_WEB_HANDOFF_PROMPT)'

3. Wait for the normal Native turn to complete. It must produce the requested plain JSON object with summary and limitations; Markdown-fenced or malformed answers are not accepted.
4. Select a Web model for the immediately following turn. The product version implementing this procedure must be installed first.

Tela reads the two newest indexed public turn summaries, verifies exact
previous user intent, a completed Native final-answer item and a bounded
16 KiB JSON envelope. This is a user-requested normal Native turn, NOT a
secret additional model call at Web selection. The prompt asks Native not
to use tools, but does NOT enforce that restriction; any actual Native
tools remain subject to existing approval and execution authority.

The account-scoped cache stores the exact source turn/item identity, answer digest and opaque Native compaction fingerprint. After browser restart, Tela rereads recent public Native summary pages (at most 64 turns and 256 KiB of response JSON) to verify the source before using the cached summary. Cross-thread, cross-account, changed-compaction, tampered, missing or unverifiable state never authorizes reuse.

This is an explicitly LOSSY handoff. Original older tool outputs, images, files and commands are not silently imported or proven. If a consequential action depends on missing original evidence, that evidence must first be retrieved through an authorized current Native/public source. Tela cannot claim that a summary is a complete historical transcript.

## Fail-closed behavior

If neither an exact readable checkpoint nor a verified, user-requested
handoff is available on **Paginated** history, initial Web preparation
returns `tela_native_history_checkpoint_required` (HTTP 422).
Legacy/missing/unknown indexed mode instead returns
`tela_native_history_indexed_source_required` (HTTP 422) and
`continue_on_native`. The old Native turn is retired on failure; 409
on repeating it protects against duplicate execution and is not a
reason to retry blindly.

The 422 includes nonretryable recovery metadata identifying the explicit
Native turn fallback **only after automatic source recovery was unavailable**.
A retired turn
replay returns 409 with code tela_native_turn_already_retired and
retryable=false. Replays rejected from the same runtime's known-retired
registry no longer repeatedly fetch Native Desktop history. This is
negative-only rejection, not a new authority grant, and cannot force an
external Native client to stop making retry requests.

## Public API limitations and release status

The current legacy app-server turns/list may internally reconstruct the
whole rollout even when only two public summary turns are returned.
Tela now refuses such requests *before* issuing them, including lifecycle
interruption. A future public, indexed, owner-authenticated exact-revision
API for readable Native compaction summaries would enable bounded Legacy
recovery. No private fallback is permitted.
The current-turn owner reader also defaults to the indexed proof path in
both normal product-profile construction and the public source factory;
an omitted constructor option must not hydrate the full Legacy rollout.
An older unindexed engine may therefore reject a Web transition that the
previous unsafe compatibility reader attempted. Continuing in Native
preserves the original task until a genuine bounded public API is available.

The automatic fork and structured handoff remain **disabled in production**.
Isolated synthetic RPC/model-provider regressions passed, but the actual
historical executed Native model/provider and true pre-execution tool-free
fork contract are still unavailable from the installed public engine.
Do not claim the original 73 MiB conversation automatically recovers until
a supported engine contract, signed package, owner-bound installed proof,
actual Native summary and Web continuation are verified. An older engine
may also lack ephemeral fork, deferred Goal, Goal clear/get or notification
subscriptions. Such uncertainty fails closed without executing a secondary
Native turn.

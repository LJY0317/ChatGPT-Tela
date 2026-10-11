# Native and Web continuity: automatic cold-history handoff

For the source architecture and exact Native/physical Web ownership contract,
see `docs/context-continuity-contract.md`. The same context selection now serves
ordinary Web turns and Native local compaction; an explicit old-style handoff
remains a *cold legacy recovery* option when the public automatic path is unavailable.

Native Codex remains the only authority for task state, tools, approvals, cancellation and compaction. Tela's readable Web context is a lossy physical representation, never a permission grant or direct Native model-state export.

## Normal use

Choosing a Web model normally does not launch a Native summary model call.
A verified retained Web session receives only the new suffix. A new Web
session preferentially uses an integrity-checked Native-compaction-anchor-bound
readable checkpoint; if the complete historical source fits within a bounded
model budget, Tela may create such a Web-side checkpoint.

**New cold automatic fallback (source-only):** When no readable checkpoint
or complete Web-sized historical source can be supplied, Tela attempts a
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

The resulting JSON records objective, constraints, completed and pending
work, decisions, file/evidence hints and evidence limitations. It is
**lossy context, not original source evidence**. Its exact source turn,
content digest and opaque Native compaction fingerprint bind an account-scoped
cache. After restart, public recent-turn ancestry must be re-proven; on a
live retained Web page only the new logical delta is transferred. A single
opaque compaction fingerprint is attempted once per live product profile
session, not on every selected Web model or new user turn.

## Old long conversation, no readable checkpoint

The public Codex core contains human-readable compaction summaries internally, but the published app-server ContextCompaction item exports only an ID. Tela never reads private rollout files, official app databases, cookies or undocumented storage.

If the original long conversation cannot be resumed on Web **and the installed
public Native engine cannot provide an isolated automatic fork**, the older
explicit source-only fallback remains:

1. Stay in the SAME Native conversation and select a Native model.
2. Submit the EXACT prompt exported as NATIVE_WEB_HANDOFF_PROMPT in packages/codex/src/native-handoff.ts. To display a copyable version from the Tela project root, run:

       bun -e 'import { NATIVE_WEB_HANDOFF_PROMPT } from "./packages/codex/src/native-handoff.ts"; console.log(NATIVE_WEB_HANDOFF_PROMPT)'

3. Wait for the normal Native turn to complete. It must produce the requested plain JSON object with summary and limitations; Markdown-fenced or malformed answers are not accepted.
4. Select a Web model for the immediately following turn. The product version implementing this procedure must be installed first.

Tela reads the two newest public turn summaries, verifies exact previous user intent, a completed Native final-answer item and a bounded 16 KiB JSON envelope. This is a user-requested normal Native turn, NOT a secret additional model call at Web selection. The prompt asks Native not to use tools, but does NOT enforce that restriction; any actual Native tools remain subject to existing approval and execution authority.

The account-scoped cache stores the exact source turn/item identity, answer digest and opaque Native compaction fingerprint. After browser restart, Tela rereads recent public Native summary pages (at most 64 turns and 256 KiB of response JSON) to verify the source before using the cached summary. Cross-thread, cross-account, changed-compaction, tampered, missing or unverifiable state never authorizes reuse.

This is an explicitly LOSSY handoff. Original older tool outputs, images, files and commands are not silently imported or proven. If a consequential action depends on missing original evidence, that evidence must first be retrieved through an authorized current Native/public source. Tela cannot claim that a summary is a complete historical transcript.

## Fail-closed behavior

If neither an exact readable checkpoint nor a verified, user-requested handoff is available, the initial Web preparation returns the explicit context recovery error tela_native_history_checkpoint_required (HTTP 422). The old Native turn is retired on failure; 409 on repeating it protects against duplicate execution and is not a reason to retry blindly.

The 422 includes nonretryable recovery metadata identifying the explicit
Native turn fallback **only after automatic source recovery was unavailable**.
A retired turn
replay returns 409 with code tela_native_turn_already_retired and
retryable=false. Replays rejected from the same runtime's known-retired
registry no longer repeatedly fetch Native Desktop history. This is
negative-only rejection, not a new authority grant, and cannot force an
external Native client to stop making retry requests.

## Public API limitations and release status

The current legacy app-server turns/list may internally reconstruct the whole rollout even when only two public summary turns are returned. A future public, indexed, exact-revision API for readable Native compaction summaries would eliminate most first-use handoff overhead. No private fallback is permitted.

The automatic fork and structured handoff are **source-only**. The public
fork/model/Goal-isolation adapter tests were written, but host safety screening
blocked their requested execution; TypeScript compilation is verified
separately. Do not claim the original 73 MiB conversation automatically
recovers until the tests, signed package, installed API capability proof,
actual Native summary and Web continuation are verified. An older engine
may not support ephemeral fork, deferred Goal, Goal clear/get or notification
subscriptions. Such uncertainty fails closed without silently executing an
unverified secondary Native turn.

# Approval visibility, agent diagnosis and remote review

This contract distinguishes three different authorities which can show
visually similar approval prompts. A UI warning is not an API grant.

## 1. ChatGPT platform tool card (before Tela ingress)

An owner may see a ChatGPT **Allow once / Deny** card for Tela
`exec_command`. A command embedding `bun -e`, shell execution and
credential-bearing calls to an authenticated Codex service may be
classified as **external execution**: the shell capability is arbitrary
even when this one request intended only to read a status. Being open
source or owner-maintained does not establish the safety of every command.

The ChatGPT host controls this card **before it passes any tool invocation
to Tela**. Tela cannot observe the host classifier's decision, which UI
was shown, whether it is still pending, or grant/approve that host card.
Missing `capability_call_start` is not proof of a block: transport,
routing and logging may also be unavailable. A later Tela
`capability_call_start/complete` or a durable process receipt proves only
that Tela received/executed the operation; it does not prove who clicked
the card or why it appeared. A user-provided screenshot is
**user-observed host evidence**, never a Tela log event.

**Remediation:** use `inspect_native_work` instead of `exec_command`
for routine inspection. It is a capability-discoverable read-only action
with exact opened `workspace_id`, `thread_id`, optional `slot` and
time window, and no arbitrary script, supplied credential or writable
action. Its capability semantics declare `read`; the optional
unified-development MCP tool also advertises read-only annotations.
The ChatGPT host still decides whether a tool needs review. No metadata
guarantees automatic approval. If it requires human review, use its own
visible confirmation path, including a mobile card when available; do
not automate clicks with an alternate tool or relocated command.

## 2. Tela-owned Web browser tool card (after owned Web admission)

| Observed state | Meaning | Next step |
| --- | --- | --- |
| `pending` | A card was seen in the selected owned surface | Inspect its exact type and owner |
| `none` | A successful current observation found no card | Do not infer Native turn completion |
| `unavailable` | No valid observation was produced | Earlier pending evidence remains unresolved |

For `unavailable`, a fixed reason narrows the failure:
`automation_unavailable`, `dom_observation_failed`,
`bridge_preview_failed`, `no_active_surface` or
`surface_not_selected`. None authorizes replay or implies clearance.

Control Center already offers user-facing **View/Interact** for an
owned session. Its observer now preserves `approvalState` and
`approvalObservationReason` in the typed service contract without
returning JPEG bytes to diagnostic model output. A profile may have
multiple Web surfaces or Native work turns. Current Web approval state
is **profile-scoped**, never automatically attributed to a supplied
Native conversation UUID. Native `thread/read(includeTurns:false)`
and bounded paginated latest-turn reads independently establish status.

Tela automation defaults off. On an already owned Web operation, explicit
`recognized_once` or `recognized_conversation` preferences select one exact,
unique current-action choice. Discovery accepts marked provider cards and
accessible dialogs with the exact connector heading; nested wrappers represent
one candidate and retain their warning scope. Unknown auxiliary controls and
Deny cardinality do not veto an otherwise proven target. Generic `Allow` needs
the card-local connector heading; explicit `Allow once` does not borrow that
meaning from arbitrary page text. Persistent `Always allow` is never selected.
Warnings still require human review. Platform pre-ingress review is independent.

**Manual one-shot consent and accepted request identity:** On a proven
owned Web surface, a human may click a currently recognized approval-card
control in the Control Center browser. The Electron input gate must
classify the exact hit-tested target **before** revoking the accepted
Web request's causal input witness. During the asynchronous hit test,
the provider is fenced from releasing observations. A still-visible,
unchanged card-local consent button preserves the original request's
causal receipt; unknown/editing inputs revoke before their input is
replayed. This matters when the canonical composer is much longer than
the visibly truncated user bubble: truncated display text is not
independent proof that the original submitted request changed. A real
request edit, competing user turn or owner mismatch still fails closed.

**Card details navigation:** A human opening the current card's exact
`See details` control with `aria-haspopup=dialog` preserves the accepted request
witness. The same card, visible enabled target and exact control meaning must
still be proven. This is viewing, never a grant to click or dismiss a warning;
changed, disabled or unknown controls remain unclassified. It addresses a
reproducible classifier boundary, not a proven historical incident cause.

**Manual dropdown consent:** Opening a uniquely observed card-local
`Approval options` disclosure is viewing/consent navigation, not a
request edit. A human choice rendered in an out-of-card menu preserves
the accepted input witness only if the card is unchanged, one visible
`role=menu` is linked to the single expanded disclosure through
`aria-controls` or `aria-labelledby`, and an enabled menu item has an
exactly recognized decision label. That choice may be a native `button`
instead of a `role=menuitem`, but its role never grants authority:
the unique expanded menu, precise card linkage, visible/active target
and recognized decision label are still mandatory. An unlinked/duplicate/
stale menu, foreign action or changed card revokes/blocks delivery. This
manual-input classifier never clicks a menu or approves a safety warning,
and cannot alter a ChatGPT host-managed permission decision.

### Agent-assisted eligibility, conversation-scoped preference and verified approvals

The provider-owned pure policy `reviewChatGptApprovalForAgent()` shares
the **same one-shot decision** used immediately before input dispatch;
the policy result cannot open an independent agent grant. It yields a
small, fixed vocabulary: `absent`, `eligible_once`, `eligible_conversation`, `manual_review`,
`disabled`, `ambiguous`, `unrecognized` or `limit_reached`.
Each report includes a next action and `agentMayApprove:false`; an
ordinary `eligible_once` result only means an **already running,
owner-bound Web turn** may use its existing opt-in auto-approval path.
The explicitly selected `recognized_conversation` mode prefers a unique
**Allow for this conversation** choice. An exact card-local **Approval options**
disclosure may be opened once, followed by unchanged-card, unique linked-menu,
warning and target revalidation. Native buttons and menuitems are deduplicated;
a button with `role=menuitem` is one control. Auxiliary controls and a separate
persistent choice do not make the chosen narrower control ambiguous.
The same pure choice resolver runs in policy and renderer preparation, before
and after scrolling. The host separately verifies card/revision, current owner,
viewport hit target and cancellation before dispatch. A card receives at most
one uncertain activation; neither new revision nor clearance resets its fence.

The profile's currently selected Web surface reports this classification
through the typed bridge-preview contract. It is optional and **only
present when a card is actually pending**; observation failure never
supplies eligibility. `inspect_native_work` carries the current profile
review in `browser.review` without attaching it to the Native
conversation. Web and Native owners must be independently reverified
and neither a model judgment nor a profile preview alone authorizes
the click. The exact card and revision are checked again immediately
before the browser input.

**Frozen-renderer human input:** An intercepted human pointer gesture stays
pending until its current target is classified. If that read-only DOM hit test
does not settle within 5 seconds, or Electron rejects it, the intercepted
gesture is **discarded without replay**; it is never automatically treated as
permission, an edited request or a new turn. Pending observation is released,
so an otherwise owned Web request may continue once the renderer recovers.
A main-process Electron `unresponsive` signal discards the same pending
gesture immediately, and further human input stays blocked until the
renderer reports `responsive` or a new document replaces it.
A late result from the old hit test cannot dispatch the click. The person must
click again after recovery. Unknown gestures that are actually classified and
delivered still revoke the accepted input witness before delivery, and
platform safety review remains mandatory. This mitigates one renderer-stall
failure mode; it does not by itself prove the original `accepted_user_changed`
incident is repaired.

The former eight-dispatch budget is replaced by a state rule: **while a
previous automatic dispatch remains unverified, withhold another automatic
dispatch**. Trusted input, observed clearance and owned assistant progress are
all required to verify it. Verified approvals have no count limit. A direct
card replacement only supplies clearance, never execution success on its own.
The existing public `limit_reached` category now reports this unresolved state;
it does not describe a fixed successful-approval quota. No additional model
calls, polling or retry path are introduced.

**Approval wait lifecycle:** Program-owned timers wake the existing observation
at 30 seconds (visible pending state), two minutes (prolonged wait), five minutes
(fresh owner/lineage, renderer and eligibility observation), and ten minutes
(terminate the owned accepted operation). The ten-minute deadline fences result
and approval delivery before bounded owner-verified public Stop dispatch.
It never selects Deny, assumes approval success, or resubmits an accepted task.
Native cancellation and browser Stop share the provider cancellation contract.
Stop delivery, observed disappearance of generation controls, surface release,
and remote execution outcome remain distinct. A missing/failed Stop proof keeps
the remote outcome uncertain. Late approval cannot revive the retired Native
operation. No extra LLM call manages the wait.

**Not yet implemented:** an agent-triggered `approve_once` API for an
already pending card. Before implementing it, prove exact Native turn,
active Web turn, browser surface, single user-granted task scope,
card fingerprint/revision and current backend owner in one transaction.
A future request should carry a short-lived one-use, owner-bound
intent without raw arguments, and dispatch **only through the existing
provider-owned approval engine** under `recognized_once`. User-provided
text, model classification, a screenshot or a profile-wide card count
is never an authority lease; a host security warning remains human-only.
The result must distinguish `dispatched`, trusted input, card
clearance and actual Native task continuation, and an indeterminate
dispatch must never be retried automatically.

## 3. Diagnostic and remote review workflow

Prefer the owner-scoped read-only capability over a diagnostic shell:

```text
Tela Chat inventory: inspect_native_work
Tela Chat call: {workspace_id, thread_id, slot: 2, minutes: 30}
Development MCP: tela_chat_inspect_native_work (when enabled)
Local CLI: chatgpt-tela thread inspect --thread UUID --slot 2
```

The authenticated Codex-service read verifies the selected profile,
Native thread identity/metadata and matching bounded structural events,
observes current profile Web approval, and rechecks unchanged owner
identity before reporting. Native latest-turn `inProgress` means
**not settled**. A Web `pending` with no exact attribution does not
prove why that Native turn is waiting. Output is bounded status,
timestamps, IDs and fixed reason classes, not prompts, paths, Web
images, raw card text or credentials. Opaque Legacy history is not replayed.

When the owner is away from the Mac:

1. A **host-owned ChatGPT card** requires the host's own review UI.
   The local agent cannot approve or acknowledge it.
2. For a **Tela-owned Web card**, a safe recognized-once approval may
   follow existing explicit opt-in rules. Warnings and ambiguous cards
   require a person's review in the authenticated interactive browser
   or another officially supported user interface.
3. A future phone-friendly Tela approval inbox would need authenticated
   user identity, a short-lived owner-bound review nonce, current exact
   card fingerprint, deliberate user action, single-use dispatch,
   separately observed input/clearance, audit receipt, expiry and
   revocation. **This is not implemented** and must not be emulated
   with an agent-controlled hidden approval API.
4. Unknown host state, owner mismatch, stale card, failed DOM read
   or an uncertain accepted turn remains blocked with a clear next
   human action. Never retry by switching tools to evade a host decision.

## Failure evidence and rollout

Use `capability_call_start/complete` and durable process status to
identify what Tela executed. `approval_wait_transition`,
`approval_manual_review_required` and
`bridge_approval_observation_unavailable` describe owned Web evidence.
`approval_agent_review` is the new bounded, content-free classification;
it is diagnostic evidence and **not** a host approval or execution receipt.
If the Native profile is unavailable, use `thread evidence --thread UUID
--minutes 180` to inspect the historical wait and failure without live
identity or click authority. The latest failure reason must not be confused
with an inferred approval timeout: `accepted_user_changed` is a request
identity failure, and `manual_review` is a human-consent gate.
Record the first failing layer, source coverage and unknowns rather
than treating silence as proof of refusal. Host cards seen only in
ChatGPT UI need user-supplied or official host evidence. Never log
raw commands, credentials, prompts or card bodies.

Source implementation is distinct from the installed product. Real
approval recognition and external host policy decisions require live
acceptance evidence; passing local tests proves neither.

## Official platform evidence availability (reviewed 2026-10-18)

The [Responses MCP guide](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
exposes `mcp_approval_request`, `mcp_approval_response`, approval request IDs and
MCP call items to the client that owns that API response. These are not an event
feed for a separate ChatGPT UI conversation; Tela's MCP server has not obtained
that host response stream. [MCP Events](https://developers.openai.com/plugins/build/mcp-events)
lets ChatGPT subscribe to server-originated events; it does not give the server
a subscription to ChatGPT approval cards. [Secure MCP Tunnel documentation](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
notes app invocation/auth lifecycle compliance logs and tunnel metadata audit
logs, not a server entitlement to arbitrary pre-ingress approval decisions.
No applicable authorized host approval feed was found in the installed contract.

Tela can correlate its own ingress/start/complete timestamps, operation receipts,
owned Web approval transitions and explicitly recorded user observations.
Before-ingress waiting duration, reviewer identity, warning contents and decision
remain unobserved unless an authorized official source supplies them. Missing
ingress is not proof of a host refusal. Never log capability tokens, arguments,
prompts, cookies or raw card text; never fabricate host request IDs from local IDs.

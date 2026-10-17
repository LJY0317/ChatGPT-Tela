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

Tela's existing explicitly opted-in `recognized_once` policy can
process **one narrowly recognized ordinary one-shot Web approval** with
exact card identity, replay fencing and input/clearance evidence. It
cannot select **Always allow**, authorize an ambiguous card, or approve
warnings flagged `requiresManualReview`. An agent may triage these
warnings but its assessment is not a substitute for human approval.

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
Record the first failing layer, source coverage and unknowns rather
than treating silence as proof of refusal. Host cards seen only in
ChatGPT UI need user-supplied or official host evidence. Never log
raw commands, credentials, prompts or card bodies.

Source implementation is distinct from the installed product. Real
approval recognition and external host policy decisions require live
acceptance evidence; passing local tests proves neither.

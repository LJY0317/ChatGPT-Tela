# Diagnostic evidence

## Observation compatibility evidence design

For an owned submission, preserve the first structural failure independently of the final snapshot.
The planned bounded incident projection records first/last reason, candidate count and containment,
candidate text lengths and equality to the expected payload, logical-anchor continuity, renderer-key
replacement, route/document continuity and monotonic stage durations. Comparisons occur locally;
never export candidate text, HTML, raw anchors, URLs or message bodies. Limit candidates, transitions
and retention; coalesce identical observations and capture on failure rather than idle polling.

`web_turn_acceptance_observed` now coalesces at most16 structural transitions per submission: reason,
new-user count, logical-anchor presence, expected-payload match, initial-route continuity, root
count/nesting/equivalence and unequal endpoint lengths. Timeout retains the first author-proof
failure separately from the last observation; the public nonretryable failure preserves that first
reason even if the author later disappears. Candidate fingerprints and raw identifiers are not logged.
Document/key transition history is not yet a complete diagnostic field set; existing ongoing
ownership observations remain separate. These records cannot explain which DOM branch added text
or prove remote termination. Add sanitized fixture coverage before extending payload selection.
Diagnostic observations never grant acceptance,
release, replay, tool or delivery authority. See the change-resilient design in `docs/architecture.md`.

Causal acceptance adds only booleans/counts: composer consumed, paired assistant/anchor,
carried user witness and causal receipt. `accepted_fingerprint_matches` remains an actual observed
payload comparison; causal acceptance does not manufacture a text-match result. Ongoing ownership
reports `payload_state=causal` separately from actual author-root availability. Host
`inspection_ownership_revoked` records at most16 unowned-input revisions per surface, without keys,
coordinates or text. The canonical diagnostic sanitizer now preserves `first_reason_class`; previously
the provider emitted it but incident projection discarded it. Regression tests cover that public
projection, not only the emitter. Candidate text and fingerprints remain excluded from logs.

## Public progress, manual consent and seed authority

`web_public_progress_extraction` reports unique explicitly linked status-region counts and
visible eligible region counts. The adapter reads only visible public descriptions in the
proven assistant turn. Hidden, ambiguous, user and final-answer regions remain excluded.
A transport commit attests local delivery only; it does not prove Desktop rendered that text.

`inspection_input_classified.manual_consent` distinguishes a real user's card-local action
from passive viewing. The provider rechecks the currently observed unique card and enabled
control; the host releases the existing user gesture without inventing one. This does not
edit the submitted request or grant Native execution authority. Provider warnings require
manual review and remain visible; ordinary automatic one-shot approval cannot accept them.

`native_seed_authority_observed` records fresh-seed system/developer segment counts, total,
unique, duplicate and largest byte sizes, plus Native instructions bytes. Content hashes
stay local to that calculation; no instruction text or hashes enter the event. Duplicate
measurements do not authorize deduplication or instruction removal. The existing bounded
log retention applies; no sampler, model call or raw history capture is added.

## Cancellation, edited requests and steering

Native admission is serialized per conversation, including transitions to a new Native turn.
A newly proven canonical owner revokes an older owner and waits for its execution/physical cleanup
to settle before starting another planner. Late old tool acknowledgements and answers cannot
commit through the new capability. A transport reconnect still only replaces the response observer.

Checkpoint journal entries distinguish pending, completed and locally closed operations. A dedicated
tool-free checkpoint runner issues a closure receipt only after its provider call has returned and
its isolated surface has successfully released (or before the provider was invoked). The receipt
identifies the exact source and local operation; it does **not** prove remote generation stopped or
that no quota was consumed. Only a different proven Native turn can replace that closed operation.
The old claim nonce cannot complete the replacement. A proven summary racing cancellation is
persisted before the cancelled Native owner is checked again, permitting exact-source reuse.

Legacy pending entries, lost responses, failed journal writes and failed surface closure remain
unknown. A new turn ID, timeout, log inference or deleted cache never clears them. This change
does not retroactively reconcile older incidents lacking an owned closure receipt. New closed
entries extend the local journal format; older runtimes reject them safely rather than replay them.
Settled entries have bounded retention/capacity; pending unknown operations are never evicted.

An explicitly requested maintenance recovery may reconcile one exact legacy pending operation
through `reconcileQuiescentLegacy`. Its authenticated lifecycle adapter must select the owned
profile/account and unchanged claim, prove no active Native work through public metadata, obtain
the official profile cleanup acknowledgement, and independently prove its original runtime and
Desktop process owners absent. Under the journal writer lock it rechecks stopped profile ownership,
account/installation binding and process absence twice before writing. The record retains its
source, claim, reconciliation fingerprint and `remoteOutcome=unknown`; `closed` attests only local
quiescence. A terminal Native owner fingerprint fences off the existing failed turn. Only a later
canonically proven Native turn may claim a new operation. No old response, tools or generation are
replayed. `pendingOperations` exposes bounded selection metadata, never summary contents.

This is an explicit privileged maintenance action, not an automatic startup migration or an
inference from diagnostic timestamps. Active work, changed ownership, modern pending records,
failed cleanup, live old processes and changed selections refuse mutation. Acknowledged recovery
is idempotent for its exact receipt; interrupted maintenance must inspect its operation checkpoint
before taking further action. The profile is restored through the same official lifecycle. The
existing cancellation-lifecycle runtime understands the resulting closed entry, so this recovery
does not require replacing binaries or restarting another profile.

Structural stages now include `context_checkpoint_provider_invoked`, `web_send_activation_started`
(phase `context_preload` or `turn`), local `web_send_activation_settled`,
`context_checkpoint_closed`, `native_checkpoint_stage_closed`, `native_prior_execution_settled`,
`native_steering_deferred` and `native_steering_cycle_started`. Claimed checkpoint attempts have
distinct operation fingerprints. Send activation is not server acceptance or completion; use
the matching semantic acceptance/result evidence. No raw message, account or tool body is added.

Native-witnessed steering is consumed exactly once at the next permitted response cycle, after
the prior final is locally committed. It is not injected into a running Web generation, and it
does not repeat a tool already delivered. Edits invalidate changed source ancestry; unchanged,
completed checkpoint sources can be reused. Cancelling a turn revokes further tool authority;
it does not undo effects of tools already executed. A failed retained-surface close keeps a local
retirement fence, preventing both reuse and a new epoch from bypassing unresolved ownership.

## Native response reconnect and idle boundaries

Correlate the request fingerprint across `http_transport_closed`, `http_transport_error`, and
`http_request_observer_aborted`. Closed streams preserve the observed `close_source`, configured
request/header/socket timeout values, local `socket_write_count`/`socket_write_bytes`, and
`last_socket_write_at_ms`/`last_socket_write_age_ms`. Writes attest only local socket acceptance,
never host display. A configured timeout does not prove that it fired. Client cancellation and a
network disconnect remain combined when the transport supplies no finer evidence; only observed
socket errors distinguish connection reset, broken pipe and timeout.

While an admitted response is actively being read, an idle stream emits a protocol
`response.in_progress` envelope every 30 seconds. The pinned Native SSE consumer waits for
parsed events, so comment-only keepalives do not satisfy its idle contract. This event asserts
transport liveness, without reasoning text, progress percentages, tool authority or final commit.
Its single timer is cleared on data, cancellation or completion; it does not run for idle services
and makes no model calls. It does not reduce cold-checkpoint inference time.

## Per-turn context evidence

```sh
chatgpt-tela diagnostics context --scope <24-character-scope-fingerprint> --minutes 120
```

This on-demand, read-only report joins bounded structural logs by scope/turn and unambiguous
request fingerprints. `--at <ISO-time>` selects an earlier window. It reports checkpoint fragment
and merge activity, preparation duration, request-checkpoint production/reuse, logical/transfer
token estimates, projection omission/truncation counts, reconnect write gaps and local final
commit versus retirement without an observed final. Older logs may lack new fields.

`web_turn_plan` now fingerprints epoch, surface, physical head/base revisions and checkpoint set,
plus document generation. `web_context_settled` records successful local settlement separately.
A retained delta is `verified_local_link` only when its planner-proven retained input head matches
a prior locally settled input head on the same epoch, surface and document generation. The delta's
base is the subsequent assistant revision, so it is recorded separately. Settlement is emitted by
the planner only after its retained-owner transaction commits. Missing evidence stays `incomplete_evidence`;
an unmatched link is diagnostic evidence requiring inspection, not proof of semantic forgetting.
New request-checkpoint flags are separate from the older history-checkpoint flags.

The report exposes event/turn/plan/transport caps and source coverage. It never reads private
captures or conversation bodies, changes capture policy, writes incidents or sends model requests.
Token estimates, local lineage and local final commit cannot prove exact billed usage, summary
quality, semantic recall or host display. Repeated file reads alone do not prove lost context.

`native_response_observer_replaced` means a canonically admitted reconnect replaced the previous
response wait without restarting Web execution. `native_checkpoint_model_started` and the matching
stage-fingerprinted failure/settlement record identify fragment/merge stage and duration. A missing
completion is uncertainty, not permission to resend a submitted checkpoint. No source, summary,
tool contents or remote/account identity enters these records.

## Native-to-Web planner failure substage (source candidate, 2026-10-15)

The existing `web_turn_plan` observation includes `logical_estimate`,
`transfer_estimate`, and `estimated_reused_context` (only positive for a
retained-delta projection). These are **estimates**, not measured provider
input tokens, token-cache hits, monetary savings, or duplicate-context
charges. A retired Native turn cannot make this estimate into proof of
retained model context. Real accounting requires a provider-owned usage
receipt and a separately verified surface/context lineage.

An existing `web_preparation_failed` event may now include a closed,
payload-free `planner_stage` value when failure occurred during
`phase=context_plan`: `request_parse`, `model_route`,
`retained_context`, `native_continuity`, `logical_projection`,
`checkpoint_lookup`, `checkpoint_production`, `physical_context_fit`,
`media_binding`, or `settlement`. Unknown or externally injected values
are omitted. The field is validated by the existing canonical diagnostic
store and retained in its incident timeline; `proof_stage` remains reserved
for account/model-discovery/connector/readiness proof.

This observation identifies the most recent planner boundary, not the root
cause or proof of actual Native execution. The original exception, ownership,
checkpoint authority, and retry behavior are unchanged. No new model calls,
session creation, or full-history transfers are triggered by diagnostics.
Retired-turn HTTP 400 is terminal for Native clients and must not
be conflated with an initial context-planning failure or Host safety refusal.

Native tool delivery evidence is deliberately ordered: `native_tool_delivery_committed`
records the channel's successful local acknowledgement; only after that
boundary may `native_outcome_committed` describe a tool-call outcome. A
rejected duplicate commit must not create another success witness. Neither
event attests Host execution, model continuation, or acceptance by a platform
safety reviewer.

Retirement emits `native_turn_retired` with a closed `reason_class`
(`owner_changed`, `owner_signal`, `watch_failed`,
`execution_failed`, `gateway_closed`) and an immutable pre-cancellation
phase/tool state snapshot. This is local evidence only; a completed response
does not imply that the Host executed any requested tool. The retired-turn transport
now suggests an explicitly authorized **new Native turn**, retaining the
existing conversation whenever independently verified. It does not launch a
new conversation, authorize retry, or assert prior execution settlement;
`prior_execution_settled` remains `unknown`.

## Start here

`native_history_anchor_rejected` distinguishes `marker_missing` (the bounded indexed source
was exhausted without a public compaction marker) from `byte_budget` (coverage remains unknown).
Page/item/byte counts are structural evidence. Internal Native compaction may have no public
UI marker; this does not prove history loss or index corruption. Retired requests preserve a
known sanitized history-recovery decision without restoring execution authority.

Native response-cycle rejection now records `native_cycle_proof_rejected` before the existing
replay denial. Its fixed reason separates a missing prior final, no new user message, and a
missing or mismatched canonical input witness. Counts and exact-request equality are structural
evidence; no input text, hashes, or identifiers are added.

Retained Web context failures distinguish unavailable committed proof, missing/incomplete observed
body proof, and semantic mismatch. Equal presentation text does not establish semantic equality.
The closed renderer reason is reported separately from the continuity reason. The typed
`tela_web_retained_context_unproven` recovery survives retirement and is identical for initial HTTP
400 and `response.failed` after SSE starts. Retired retries neither reread Native history nor launch
Web execution. This does not prove the client stops retrying, recover missing body proof, or authorize
an automatic resend. These changes require installation and real-profile acceptance before claiming
that an installed incident is fixed. Cycle conflicts likewise use terminal HTTP 400: the Native client
can treat an unexpected HTTP 409 as reconnectable despite a retryable=false JSON field.

Use `chatgpt-tela diagnostics list`, then `diagnostics inspect --ref <ref>`. The platform-standard
Tela logs directory contains `diagnostics/START-HERE.md`, a rebuildable `INDEX.json`, canonical
`incidents/`, and separately protected `private/`. No reference checkout is a runtime dependency.
Source development uses `bun run cli` in place of `chatgpt-tela`.

To align local evidence with something you saw:

```sh
chatgpt-tela diagnostics record --at <ISO-time> --symptom response-stalled --minutes 5
chatgpt-tela diagnostics activity --minutes 5
```

Optional `--operation <fingerprint>` selects a correlated request/turn. `--recovered-at <ISO-time>`
and `--output-started-at <ISO-time>` are explicit human observations. A local tool settling or an
HTTP response finishing does **not** prove that ChatGPT displayed it or resumed generation.
The report separates report-time process/tool activity, transport, other conversation progress,
instance changes, local silence, and missing/truncated sources. RPC sequence numbers alone never
join unrelated requests. Scope fingerprints are correlation signals, not proven account identities.

Symptoms: `stream-failure`, `connection-interrupted`, `response-stalled`, `additional-review`,
`response-recovered`, `approval-stalled`, `tool-review-blocked`, `missing-models`, `startup-stalled`, `ui-anomaly`, `unknown`.
Existing `diagnostics incident`, `trace`, `workload`, `retention-canary`, `doctor` and platform-specific
`diagnostics desktop` remain focused views; their evidence is not a second authority.

### Tool review reports and observation gaps

Use `diagnostics record --at <ISO-time> --symptom tool-review-blocked --report-origin worker-report`
when a worker reports rejection outside Tela ingress. Other closed provenance values are
`user-observation` and `host-error`; omission remains `unspecified`. This records a report, not
authenticated platform origin, a successful execution or permission to retry. Do not include raw
error text, commands or identifiers. An external host can refuse a call before any Tela callback:
local instrumentation cannot manufacture that receipt or recover the host's internal reasoning.

`record`/`activity` select the incident time interval before applying the existing per-source event
cap, within the unchanged byte budget. Source coverage exposes malformed/oversized rows, skipped
outside-window rows, unavailable/rotated sources and remaining caps. An absent result is not proof
of no rejection. `boundaries.toolEvidence` separates observed approval dispatch/input/card-clear,
Native queue/delivery/result, reported errors, refusal signals and incomplete inspection. Counts
stop at report time; without an operation selector they are aggregate observations. They never
establish the cause of a later rejected request. In particular, approval receipt does not prove
downstream safety review acceptance, and HTTP 200 is transport success, not task success.

This common on-demand analysis is shared by Chat, Work/Codex and delegation incident consumers;
it merges no mutable service/account authority and adds no polling, model call or raw capture.
Existing local-only incident/log retention remains unchanged. Source verification and installation
are separate; no exact pre-ingress host receipt is claimed unless the host exposes one.

## Optional private evidence

### Failure-only diagnostic coverage (2026-10-11 source candidate)

Tela Chat and Tela Codex now emit additional **structural, bounded,
payload-free, failure-only events** without altering authorization,
retry, original exceptions or Native execution:

| Boundary | Diagnostic stage | What it proves (not what it guesses) |
|---|---|---|
| Chat RPC capability | `capability_call_failed` | Existing request correlation plus a **fixed** `reason_class` from a closed allowlist, never raw exception text. |
| Chat process admission | `process_capacity_rejected` | A process was **not** spawned; total/limit, uncertain, active, recent terminal and expired terminal reservation counts. |
| Chat durable persistence | `process_state_storage_failed` | Store write or the independent 1 MiB serialization budget failed; structural byte/count fields only. |
| Chat recovery and retirement | `process_recovery_failed`, `process_retirement_failed` | Failed read/retire/write phase and a safe reason class; uncertain owners remain protected. |
| Chat process output | `process_result_retention_failed` | Output retention failed; unknown state is preserved instead of trusting a successful execution. |
| Chat shutdown | `shutdown_rejected` | Active request count or unresolved-work safety gate refused shutdown. |
| Chat local incidents | `reasonClass` on `list_incidents`/`show_incident` | A persisted, bounded error classification in addition to existing capability and failed/aborted status. Old records without this optional field remain readable. |
| Codex paginated owner proof | `native_current_turn_rejected` | Missing/Legacy indexing, unavailable/invalid page, changed active status, owner or environment **before Web authority is granted**. |
| Codex original live Legacy receipt | `native_live_turn_proven`, `desktop_native_live_turn_rejected` | Only an original same-socket `turn/start` ACK plus unchanged metadata-only owner checks may prove a current Legacy turn without paging. A successful proof records fixed `history_mode=legacy` / `route_kind=public_live_ack_metadata`. Ambiguous, late or saturated receipts emit fixed rejection reason classes; never raw thread/turn ids, RPC payload, prompts or tools. A live receipt is not historical context provenance. |

Original-turn receipt reuse is refused with fixed `desktop_native_live_turn_rejected.reason_class=reused_request_id`. A delayed duplicate ACK cannot grant a different Legacy thread's authority; the original Native JSON-RPC traffic remains unchanged. This reason identifies only an unsafe receipt correlation, not a Native execution failure.
| Codex automatic handoff | `native_auto_handoff_rejected` | A direct call to the default-denied research adapter was rejected **before RPC connect** (`prepare`, `verify_source`, `verify_recent`), or an accidental callback injection was ignored by the continuity resolver (`continuity_resolver`). At most one resolver event per decision; phase and fixed `production_disabled` class only, never raw thread IDs, user content or model strings. The product does not wire this adapter. |
| Codex explicit manual handoff | `native_manual_handoff_rejected` | A public indexed summary contained unexpected visible activity in `source_turn` (tool/action, multiple messages, unknown kind) or an already-acted `current_turn` (`unexpected_visible_activity`). A final metadata-only indexed head check may also refuse a changed newest current turn (`current_turn_changed`) or malformed head (`invalid_indexed_head`). Only fixed phase/reason fields; never activity details, prompt, tool output, or Native identifiers. Absence of this event does **not** prove a tool-free engine policy. |
| Native-to-Web streamed source recovery | `native_context_recovery_streamed` | After SSE progress commits HTTP 200, late typed Native bootstrap failure ends with `response.failed`. Records only `transport_phase=sse_after_progress` and fixed `reason_class` (either `history_mode_unindexed` or `history_bootstrap_required`). The client receives the same nonretryable recovery action as HTTP 422. This is a failed continuation, not successful delivery; neither event nor SSE failure contains original exception text. |

`list_processes` also returns a read-only `capacity` object with
`registryCount`, `registryLimit`, `availableSlots`, `unknownCount`,
`activeCount`, `terminalRecentCount`, `terminalExpiredCount`,
`archivedTerminalCount`, `archiveLimit`, and `admissionOutlook`.
The `availableSlots` field is **immediate hot-registry headroom**, not a
boolean for whether the next command can be executed. The outlook is:

- `slot_available`: a hot reservation slot is already free.
- `on_demand_reclaim_candidate`: the hot registry is full, but at least
  one completed record is a candidate for retirement or archived preservation
  before the next command. No cleanup is performed by this observation.
- `archive_capacity_uncertain`: recent terminal receipts exist but the
  separate archive is full. Expired archive records might be retired on
  demand; success is not assumed.
- `no_terminal_candidate`: the full hot registry contains no completed
  receipts eligible for reclaim. Unresolved work must be independently
  reconciled; it is never discarded merely to free a slot.

This classification is **an advisory structural snapshot**, never a
guarantee of successful execution: authenticated retirement, archive
integrity, the independent 1 MiB hot-store budget, disk writes, and OS
process admission can still fail. Only an actual accepted `exec_command`
receipt establishes that a particular new operation was started.
The event-driven source candidate now publishes each proven terminal
receipt to the bounded, authenticated SQLite completion archive **after**
its result and hot terminal state have committed, then releases its hot
reservation. This is distinct from deleting the receipt: its exact
operation ID and recovered output remain available through restart and
idempotent replay, while same-process incremental output retains a small
byte cursor rather than a completed child and its buffered output in RAM.
A service start drains older proven hot completions in one SQLite
transaction; active/unknown reservations never move. An interrupted
handoff preserves a canonical hot copy, and archive/storage failure keeps
the hot receipt instead of guessing success. Existing minimum 24-hour
terminal retention and authenticated expiration remain in force.
Thus healthy recent completions normally increase `archivedTerminalCount`,
not `registryCount`; an archive at its own limit can still cause future
admission pressure. This remains source-only until a verified signed
installation and authenticated live-service acceptance.
These are **service-wide aggregates only**; the process rows remain limited
to the caller's approved workspace. A full registry can therefore be
diagnosed through `list_processes` even when `exec_command` cannot start
another process or the chosen workspace has no unresolved commands.
The snapshot does not start, terminate, consume or reclassify any operation,
probe a saved PID, or test writable storage.
Terminal reservations less than 24 hours old still protect command
idempotency; uncertain owners are never retired to free capacity. A source
change or Git commit does **not** update the running installed service:
verify its actual `registryLimit` after a separately approved normal rollout.

For older/unindexed Native compaction history, the Web preparation failure
classifier now reports the fixed `history_mode_unindexed` class. This is
distinct from other `history_bootstrap_required` cases (e.g. an oversized
but indexed source). The HTTP recovery contract returns nonretryable 422
`tela_native_history_indexed_source_required` and
`continue_on_native`; an extra Legacy handoff turn is **not** claimed
to bypass the hidden server-side history reconstruction.
Bounded Native observation likewise proves the indexed active turn before
`thread/resume`. A missing rejection event on a normal product turn does
not mean a hidden fork ran: the product deliberately omits fork callbacks.

This is not an always-on process sampler: reservation count breakdowns are
computed **on explicit `list_processes` reads or capacity rejection only**;
the read-only admission outlook does not add background observation or polling.
No command, request body,
conversation text, raw workspace/thread/turn identity, path, URL, token or
exception message enters the added events. Correlation remains a locally
generated request/operation/scope fingerprint and is never account authority.
For failures outside the known taxonomy, `unknown` is intentional. Do not
fall back to raw error strings to improve classification coverage.

**No cross-product host observation is invented.** DevSpace's host-visible
MCP request can be correlated using its independently owned lifecycle
diagnostics, but OpenAI's pre-tool safety gate can reject an invocation
*before DevSpace receives any request*. In that case there is no DevSpace
request ID, tool start, or process reservation to inspect. Missing log
entries also could mean a transport/logging gap; absence is not proof of a
particular safety-policy decision. To diagnose that gap, the **host/platform**
would need an authenticated, consented, privacy-safe decision record with
only a locally correlateable attempt reference, stage
(`host_policy_before_dispatch` vs `transport` vs `devspace_received`),
fixed reason class, policy contract revision, and a Boolean indicating
whether dispatch actually occurred. Never log the blocked prompt,
command, shell arguments, file content, raw identifiers or policy internals
that would expose bypass details. Tela cannot implement a platform preflight
callback for decisions it never sees.

All added coverage is **source/test verified only** until a separately
approved build/installation and reproduction. Existing logs do not
retroactively acquire these fields. The source still cannot attest
historical encrypted Legacy model provenance, host UI rendering, mobile
Remote delivery, or cross-account ownership.

Native Responses and compact requests emit `native_dispatch_started` with exact byte-equality,
received/forwarded byte counts and counts of Tela-owned reference, item-id and display-item removals.
Unchanged requests reuse their original buffer; equality comparison occurs only on the rewrite path.
Existing request/operation fingerprints correlate dispatch attempts; no body digest or payload is logged.
`native_dispatch_headers_received` records status and time to headers, not completed streaming or UI receipt.
These bounded events run only during requests, use existing log retention, and add no retry or idle work.
They establish this forwarding boundary's behavior, not why a model repeats work after compaction.

Native HTTP failures record request shape (storage policy, reference presence, inspected item and
encrypted-reasoning counts), upstream request/item fingerprints, and fixed error classes. A missing
item is compared with at most 4096 submitted items; incomplete coverage is explicit. No item bodies,
raw identifiers, authentication or server error text are written. Only failed response bytes already
consumed by the caller are inspected, up to 16 KiB; oversized/non-JSON errors stay unclassified.
Cancellation/read failure is recorded without draining the response or retrying it. Successful streams
are untouched. These observations cannot restore missing state or prove delivery to the app.

The default Desktop adapter correlates bounded `thread/read` requests, replies and socket-write
completion using random operation fingerprints. It records response byte/turn counts and RPC status,
never conversation identifiers or bodies. Connection-close summaries include receive/write counts and
unanswered history reads. Tracking is capped at 128 reads and the existing 64-event connection budget;
the final close summary survives that budget. `socket_write_only` means the local write callback
completed, **not** that Desktop consumed, rendered or synchronized the history. No polling, automatic
resend, payload-limit change or official app instrumentation is introduced.

```sh
chatgpt-tela diagnostics capture --minutes 15
# For explicitly authorized ongoing local diagnosis:
chatgpt-tela diagnostics capture --mode until-disabled
# Reproduce the problem in an owned Tela browser surface.
chatgpt-tela diagnostics capture --minutes 0
```

This enables **sensitive local capture across active Tela tasks**. Timed mode expires after at most
60 minutes without polling or restarting. `until-disabled` requires explicit opt-in and persists
across restarts until `--minutes 0`; the same file/count/age limits apply. No background sampler runs.
HTML/screenshots are captured at submission/acceptance checkpoints
and failure/ambiguous approval boundaries. Tool request/results and Web context may also be saved as
bounded private JSON. Authentication routes and password/email forms suppress HTML/screenshots.
Private JSON redacts credential-named fields; HTML strips scripts, executable/URL/value attributes;
known bearer/key strings are scrubbed. This is best-effort redaction, **not a guarantee that a
conversation contains no secrets**. Keep all private artifacts confidential. Public structural
reports contain only artifact references, types and sizes, never their contents.
Private artifacts have no upload/export path. Analyze them locally and return only structural
classifications/counts; never return raw files through model tools or include them in Git/releases.

The capture is read-only, does not click approvals, resend requests, alter permissions, change models,
or attach to the official Desktop app. Native/Work authority and existing approval policy remain intact.
The browser capture has a three-second deadline and deduplication. A diagnostic failure never replaces
an execution result. Enabling capture can add active-request latency; leave it disabled for ordinary use.

`web_preparation_failed` records the first failure before browser execution, distinguishing Native
lifecycle watch and context planning with fixed reason classes. Private mode may also retain a bounded,
redacted request/error snapshot locally. No exception prose enters structural reports; the original
execution error, retirement and approval behavior are unchanged.
Failure/checkpoint DOM evidence also records bounded viewport geometry near the rendered keyed turn.
It reads at most 16 ancestors, does not move the viewport, and logs no text or element identities.
This can help investigate rendering/virtualization but is not response ownership proof.

### Native tool contract and safety-status evidence

`native_tool_queued`, `native_tool_delivery_committed`, and `native_tool_result_received` /
`native_tool_result_error` correlate the exact call with process-local salted tool/schema fingerprints,
structured/freeform mode, observed Native sandbox kind, and workspace-root count. No root paths,
tool names, capabilities, invocation arguments, descriptions, result prose or credentials are logged.
Contract inspection is bounded to512 nodes/12 levels/64 KiB of strings; incomplete inspection is explicit.
Local transport commitment and result receipt do not prove host execution, permission acceptance,
or the origin of a failure. They never affect validation, delivery, replay or approval decisions.

Shared MCP tracing distinguishes an error result from a thrown callback error. Error-only inspection
of already received text is bounded to16 KiB characters/32 nodes and records whether the known
safety-status-undetermined message was observed. `origin_proven:false` and `execution_proven:false`
remain explicit: this is a message signal, not attestation of an OpenAI policy decision. Unknown or
truncated errors stay unclassified, and original results/errors are returned unchanged. There is no
new request, retry, poller, capture enablement or idle work. Existing local rotation/incidents apply.
A platform rejection before Tela receives a request still requires host/platform evidence; these logs
cannot retroactively explain that rejection or make a blocked operation permissible.

When an **owned Tela Web** approval card is visible, the provider may classify a public security
warning into one fixed reason (`tool_description_policy_directive`, `suspicious_instruction`,
or `provider_warning`). `approval_manual_review_required` records `reason_class`, policy mode
and card count only on a changed observation; `approval_wait_transition` retains its distinct
pending / dispatch / input-received / cleared phases. A pending warning also emits fixed
human-readable progress without copying the card body into the model or logs. Classification is
presentation evidence, not a platform risk finding, permission, proof of click receipt or
authorization to resend. Changed or unknown text remains manual. Platform-owned ChatGPT tool
approval UI outside the attached Web browser is **not** observable through this adapter;
user-supplied screenshots or official platform status are separate evidence.

## Retention and cost

Retained-prefix failures emit `web_retained_anchor_rejected` with fixed reason classes,
matched assistant count, identity/semantic-answer/presentation match booleans, committed/observed
answer character counts and observed phase. The semantic proof serializes the owned assistant body
without CSS visibility filtering; display Markdown remains separate. No answer text or
identity values are retained. These failure-only events distinguish a missing lineage from an
unavailable or changed committed answer; they do not relax the continuation proof.
`web_dom_observation_failed` separately identifies surface evaluation, approval evaluation or
snapshot projection using fixed error classes. Original errors still reach the caller unchanged;
no exception messages, extra reads or retries are added.

`web_public_progress_extraction` reports container/anchor/title coverage once per settled keyed
response; `web_turn_observed` includes the matched public-progress part count. Existing
`native_turn_state` events include published, no-viewer and budget-rejected progress counts.
These distinguish extraction misses from presentation gaps without storing prose, changing
semantic revisions, adding observations, or logging each streamed update. They do not prove UI receipt.

- Structural events rotate current plus one predecessor. Default file budget: 2 MiB.
- An analysis reads at most 12 sources, 2 MiB per source, 4096 events per source, 128 timeline events.
- Canonical incidents: at most 64 / 4 MiB / 30 days; individual envelope at most 128 KiB.
- Private artifacts and metadata: at most 24 files / 64 MiB / 7 days; payload at most 8 MiB.
  DOM text is capped at one million characters; private JSON at 256 KiB with depth/member/string caps.
- Failure bursts coalesce into one deferred incident flush; inventory snapshots are change-only,
  bounded to 256 scopes and expire on subsequent calls. No idle sampler, screenshot loop or cleanup timer.
- Ownership markers restrict pruning to Tela-owned evidence. Foreign files and symlinks are not removed.
- POSIX directories/files use 0700/0600; Windows uses the user's product data directory and ACLs.

Collected evidence stays in the local product logs directory, outside the repository. Git ignores
collected JSONL, incident/artifact names and diagnostic directories as defense in depth. Do not force-add,
commit, push, upload, or include evidence in release packages. Source/tests use synthetic disposable data. Bun test preload isolates the inherited sink and tags test events;
common analysis excludes test-tagged records and bounded, local test-origin annotations.
Removing Tela data through its existing owned uninstall lifecycle removes its logs; keeping data preserves
bounded evidence. No DevSpace or CodexGPTWeb data is imported, deleted or changed.

## Reference assimilation map

DevSpace local patches and the retained CodexGPTWeb local-patches revision `15285cd` were behavioral
references. Tela implements these concepts independently behind its own runtime contracts.

| Reference diagnostic family | Tela boundary / implementation |
| --- | --- |
| Request, MCP RPC, host scope, instance and callback provenance | Core diagnostic context; HTTP host; private service client; Gateway and Native MCP tool wrappers |
| Client cancellation versus settled tools versus delivered HTTP response | Tool start/abort/failure/settlement; HTTP received/ready/finished/disconnect events; report-time activity |
| Process provenance after a request has ended | Chat process spawn/settlement callbacks retain original request and operation context; public process status remains authority |
| Host stream failure, recovery, output start, silent target while other scopes progress | Canonical `record` analysis, explicit host timestamps, correlated timeline and evidence gaps |
| Bounded current/previous readers and incident discovery/retention | Core diagnostic store; common CLI center; focused Work/workload/retention readers |
| Browser navigation, renderer crash/hang and terminal transport evidence | Owned Electron lifecycle listeners, HTTP lifecycle, failure-time bounded resource timing/status counts; no URL/message logging |
| Browser DOM/UI anomalies and approval-card forensic capture | Structural button/card counts; ambiguity incident; opt-in sanitized HTML/JPEG; auth guard and deduplication |
| Deep trace request/context/result snapshots and stage evidence | Opt-in private tool/context JSON plus before-submit/accepted/failure DOM checkpoints; private artifact references |
| Native tool inventory loss/change | Change-only salted inventory fingerprints, count deltas, namespace/freeform counts and Native turn state transitions |
| Compaction baseline/refill growth, projection, tool rounds, retained epoch pressure | Existing projection/epoch events plus context pressure deltas, checkpoint presence, compaction start/complete/rejection and current turn tool state |
| Model discovery, startup, ownership and package/lifecycle faults | Existing readiness/catalog/profile/controller/lifecycle diagnostics included in the common structural reader and category report |
| CPU/resource snapshot and transport health | Existing bounded `diagnostics desktop`, authenticated product `status`/`doctor`, and permission-scoped Chat process status; no continuous OS monitoring |

Web engine admission records `web_catalog_refresh_failed` with `request`, `response_validation`
or `admission_match`, elapsed time, cancellation and model counts; no model IDs or exception prose.
`web_admission_failed` retains the shared bounded causal classification, and `web_reconnect_failed`
records the underlying local failure before HTTP translation. A reconnect HTTP 409 alone proves
neither an active Web turn nor Native retirement. Correlate these stages before choosing recovery;
an in-flight preparation is joined without a second refresh, and no failed request is replayed.

Reference-specific provider names, launcher layouts, request types and hardcoded known-tool lists are not
copied: Tela discovers its own capabilities and maintains Native authority. A log-only PID is not treated
as permission to inspect or signal a process. macOS unified-log/tunnel transcripts and server-side model
reasoning are not automatically harvested: they can expose unrelated private activity, and absence of
local evidence is explicitly reported rather than interpreted as a remote cause. External system-log
investigations need a separately scoped, one-shot collection; they are not replaced by these structural logs.

## Verification boundary

Synthetic tests cover concurrent cancellation provenance, credential filtering, private capture gating,
auth suppression, duplicate capture, independent RPC IDs, report-time state, truncation/symlinks,
retention/foreign ownership, incident discovery, renderer-listener teardown and existing runtime/MCP flows.
Installing this source candidate and reproducing real approval/timeout incidents is a separate coordinated
step. Windows/Linux live capture and exact Web token/quota accounting are not proven by macOS tests.
Legacy diagnostic projects should not be deleted until the required live cases have equivalent evidence.

## Desktop model delivery and lifecycle

### Native reasoning provenance (opt-in)

The existing expiring `diagnostics capture --minutes 15` policy also enables payload-free Native
reasoning observation for requests started while it is enabled. Default operation observes only
structural failures; opt-in reasoning inspection shares caller-consumed SSE bytes. No tee, eager drain,
retry, sampler or additional upstream request is introduced. Response bytes, cancellation and transport
errors remain unchanged. The observer records hashed item identity, added/done phase, presence of
encrypted recovery data, terminal response event and consumer/transport termination. Subsequent input
inspection can correlate a previously observed item with current encrypted-data presence, including
HTTP-failed requests. This is observation, not authority to repair or drop Native history.

Inspection stops after 1 MiB, a 64 KiB frame, 128 data events or 60 seconds (checked on received bytes).
The process-local index retains at most 256 fingerprints for 10 minutes, pruned on demand; replay logs
are capped at 16 matches per request. No text, ciphertext, credentials or raw identifiers are persisted.
Disabling capture clears the index on the next request; already admitted streams may finish their
bounded observation, but cannot repopulate a cleared index. Existing log/incident retention applies.
Reasoning inspection remains opt-in and bounded; production battery equivalence is not claimed.

`inspection_complete:false` means an observation limit, invalid framing or partial frame prevented full
inspection. Missing terminal events, absent prior observation and an evicted index entry are not proof
of data loss. Public app-server history omits encrypted reasoning by schema, so it cannot establish
whether private persisted history retained that data. These diagnostics cannot reconstruct past loss.

### Web tool continuation stalls

Each accepted Web request records its route class (initial, provisional, conversation or other),
baseline lineage count and whether the accepted request fingerprint matched. Route promotion and
rejection record only structural ownership checks, so normal address/key hydration can be separated
from foreign navigation without retaining addresses or message identifiers. These events follow the
existing bounded retention and do not add a timer or a second submission.

At an exact tool-result handoff the semantic provider records assistant counts, parentless/matched/new
lineage counts, accepted-user presence, pending continuation and approval-card counts. Additional handoff
events are capped at 16 per tracked turn. Existing change-only turn-state events include these counts;
the wait loop retains only an observation count and last-observation timestamp, without an added poller.
After an accepted turn fails, the runner performs one read-only semantic observation before retiring its
surface. A 1.5-second deadline bounds even a provider that ignores cancellation; observation failure
does not replace the original error, release ownership early, submit another turn or relax replay guards.
No routine evidence contains text, URLs or renderer identities. Private HTML/screenshots remain under
the existing expiring capture policy. Counts distinguish missing assistants from unmatched or completed
assistants; they do not alone prove a server generation failure or that ChatGPT consumed an MCP result.

The owned default-profile proxy records model-list request, final response counts (Native/Web/hidden Web), and local WebSocket send completion/failure with a random connection fingerprint. Declared client categories separate Tela API probes from other clients; they do not prove process identity. No RPC identifiers, model names, client names, payloads or credentials are retained. Logging is limited to64 events plus a closing summary and128 tracked diagnostic requests per connection, with existing bounded log retention and no idle sampler.

A successful socket write does not prove frontend receipt, filtering or rendering. Compare these transport events with an explicit human picker observation. Native startup and stop record phase, elapsed time, failure and rollback/cleanup outcome; Native readiness is not first-window paint. Work incident/trace analysis retains the allowlisted counts, statuses and fingerprints.

### macOS menu and Control Center evidence

`menu-ui-events.json` in the product log directory records only menu lifecycle, own-app activation and own-window visible/key/main/occlusion booleans. It is event-driven, local-only, and bounded to the latest 64 events within 24 hours (read bound 128 KiB). It contains no window titles, other-app identity or content. It distinguishes deactivation before menu tracking from an explicit close/hide; user observation is still needed to confirm relative window ordering.

### Turn ownership and inspection witnesses

`web_turn_ownership_observed` records transition-only author-payload/anchor states, accepted-key count and route-match booleans (64 witnesses per turn). Missing author projection is distinguished from confirmed conflicting identity; the first acceptance wait and recovery have separate events. It stores no body or raw identifiers.

Author ownership witnesses also separate `rendered_payload_state` (unmounted/unavailable/matching/changed)
from `payload_state` and `causal_receipt`. A changed preview under a valid causal receipt is not an
ownership rejection. Acceptance records host input-boundary availability; `web_submission_input_revoked`
records availability, revision equality and abort state without keys, positions or text. Existing
transition caps still apply; no observer or polling loop is added.

Checkpoint diagnostics span the same operation: `checkpoint_operation_observed` records accepted and
completed phases, while `checkpoint_operation_failed` retains the phase reached and whether submission
and completion were observed. Completion does not imply a valid envelope or durable summary.
`context_checkpoint_failed` distinguishes Native-owner cancellation, host-input revocation and provider
errors. `context_checkpoint_released` records physical release and persistence separately; a failed
release has its own event and cannot produce a local-close receipt. Any failure whose isolated lease
was successfully released produces the same request-bound local-close receipt; exception categories
classify diagnostics, not settlement authority. `released_locally` preserves unknown remote outcome;
only an exact proven completed rejection is classified `completed_unusable`. The journal still requires
its original claim/owner. A producer failure without that receipt remains unresolved. The public
`checkpoint_closed` recovery state asks for a new authorized Native turn; only unresolved
`checkpoint_interrupted` asks for reconciliation. Neither state permits replay of the retired turn.
No exception messages, message digests, source bodies, raw operation identities or private captures
are added. Existing structured incident/log retention bounds apply.

`inspection_window_action` distinguishes reveal, hide, close-to-hide and owned release, including document generation/live state. `inspection_mode_changed` records mode changes; `inspection_input_observed` records at most64 activation categories per surface with owned-input/mode flags, never keys, coordinates or target text. These observations establish timing and input source, not approval acceptance or causality. Existing structural incident limits/private capture consent and retention apply; no sampler or model request is added.

### Hidden-window approval preparation

Approval preparation records `approval_preparation_started`, `approval_preparation_target` and
`approval_preparation_settled` or `approval_preparation_failed`. These contain duration, consent delay,
allowlisted outcome/reason and disposable identity fingerprints, never card text or coordinates.
A host-owned deadline bounds preparation to five seconds plus the configured consent delay, including
renderer evaluations that ignore cancellation. Timeout or owner cancellation cannot dispatch input;
late preparation completion is discarded. The timer and abort listeners are removed on settlement.

Instant scrolling and synchronous geometry/hit testing avoid animation-frame waits, which may pause
in hidden windows. Preparation revalidates the original card and revision after scrolling; changed,
disabled, ambiguous, occluded or offscreen targets remain unapproved. Background throttling stays at
its default; no continuous rendering, sampler or model request is introduced.

An obstructed target also emits `approval_target_failed` with a fixed hit kind (`none`, `document`,
`dialog`, `control`, `other`) and booleans for same-card hit, target pointer-events/inert and document
visibility. A null hit is distinct from a different element; neither proves a particular overlay.
Only the last reported card revision is retained for deduplication. Repeated preparation of that
unchanged revision adds no incident; a changed revision may record a new one. Existing bounded
incident retention applies. No text, DOM identifiers, coordinates, capture or extra polling is added;
this evidence never changes approval authority or selects another click target.

`approval_dispatch_started` marks the separate input boundary. Its outcome remains one-shot: an
uncertain dispatch is never automatically retried against the same card. Preparation completion or
`approval_activated` alone does not prove input receipt, card clearance, tool execution or task success.

### Native response versus task lifetime

`native_execution_failed` records the first bounded execution failure class and phase. `native_outcome_committed` records provider tool/final delivery, not official Native task termination (`native_terminal_observed=false`). `native_replay_rejected` carries pseudonymous scope/turn correlations and `current_authority_proven=false`; it is a negative guard, not a current-task proof. Match these events before attributing a409 to stale new-turn identity. A model response may complete while the official engine still has accepted steering input. These events do not relax retirement or authorize automatic replay.

### Requested route, Web readback and unflagged tool refusals

`web_turn_plan` records `provider_kind:web` and a bounded requested-model fingerprint;
`native_dispatch_started` records `provider_kind:native`. A model catalog selection or a Desktop
composer label alone is not execution proof. Correlate the exact Native turn/request with Web
planning, `web_model_selected`, browser acceptance, tool delivery/results and Native terminal evidence.
`web_model_selected` stores a pseudonymous family fingerprint, finite effort category, and successful
family/effort readback booleans. The canonical diagnostic reader now retains those effort values;
no model labels, account identity or browser content is exported.

Function/custom tool outputs do not carry a reliable error flag in the Native Responses contract.
`native_tool_result_signal_anomaly` and shared MCP `tool_result_signal_anomaly` observe an unflagged
host-refusal envelope, separately from `native_tool_result_error`/`tool_error`. The common bounded
adapter checks only known message/content/text/error fields or a bounded JSON envelope, with a
16 KiB/32-node/16-array-entry budget. Unflagged text must start with the full known host refusal;
a sentence embedded in quoted source or a log excerpt does not qualify. No output is reclassified,
modified, retried or used to grant/revoke execution authority.

`error_result_reported:false` means the received result flag did not identify an error.
`message_signal_observed:true` is only a textual signal; `origin_proven:false` and
`execution_proven:false` remain explicit even when the text names a platform. Ordinary content can
imitate such a prefix, so the signal is never task-failure or policy-origin authority.
Unknown envelopes or clipped inspection do not prove absence of a refusal. The observer adds no
upstream request, browser snapshot, timer, private capture or idle work. Existing bounded local
incident/log retention applies. Shared MCP tracing covers compatible Tela Chat and Codex callers;
Native tool execution outside these observable boundaries cannot be inferred from those logs.

### Native capacity and streamed failures

The Native passthrough shares one provider-error classifier and stream parser for HTTP failures and
HTTP200 SSE failures. `native_backend_error_failed` (`phase:http`) and
`native_backend_stream_failed` (`phase:sse`) distinguish `server_overloaded`, `rate_limit`,
`usage_limit`, and other fixed error classes. They retain status, elapsed time, a pseudonymous
upstream request fingerprint, and bounded numeric `retry_after_ms` when the provider actually supplies
it. No raw code, message, model name, account, prompt, or response content is logged. A UI retry
countdown or total client attempt count cannot be inferred from this evidence.

Failure observation is enabled when the existing diagnostic sink is configured, independently of
private capture. It inspects only consumer-pulled bytes: no tee, eager drain, timer, network retry,
model call, or idle work. Normal completed streams emit no additional failure event. The parser
retains at most one 64 KiB frame plus a 4 KiB decoding slice, discards oversized frames, and resumes
at their delimiter. Late failures remain observable after the private reasoning inspection's
byte/event/time limits. At most one failure and one unproven-end event can be emitted per stream;
existing local log retention applies. Processing is proportional to consumed bytes; workload/battery
cost has not been measured in production.

`native_backend_stream_anomaly` distinguishes missing terminal events, cancellation, transport
interruption, and incomplete inspection from a completed stream. An incomplete observation is not
proof of absence of a server failure. Diagnostics preserve status, headers, bytes, backpressure,
cancellation, and original read errors; they neither recover nor retry the user's task.

| Native visible-prefix checkpoint | `native_visible_prefix_checkpoint_started`, `native_visible_prefix_stage_settled`, `native_visible_prefix_stage_rejected` | Complete indexed visible history can bootstrap Web without an optional UI compaction marker. Records bounded source bytes/item count, fragment/stage counts, fixed fragment/merge phase and completed/reused/uncertain outcome. No historical text or source identifiers. The account-scoped execution journal owns submitted-stage receipts; disposable caches do not authorize reuse or retries. An uncertain submission returns `tela_native_checkpoint_reconciliation_required` with `retryable=false`; subsequent retired-turn retries preserve that recovery decision. |
| Checkpoint resource cost | `checkpoint_transfer_planned`, `native_checkpoint_efficiency_settled` | Tool-free summary transport reports source bytes, local transfer estimates, one planned model call and zero separate acknowledgement calls. Successful prefix preparation reports stage attempts and completed-stage reuse; interrupted work retains the existing per-stage evidence. See [efficiency contract](token-efficiency.md). These counters do not measure provider billing or semantic comprehension. |
| Web submission acceptance | `web_turn_acceptance_pending`, `web_turn_acceptance_timeout`, `web_turn_identity_accepted` | Distinguishes a sent message from exact accepted-turn proof. Structural candidate count, nesting and endpoint equivalence identify accepted redundant wrappers or rejected differing payloads without recording text. Pending/timeout reasons use closed author-root/payload enums; timeout includes structural user count and whether any completed assistant was observed, without adopting that answer or proving its lineage. The existing surface-confirmation deadline bounds receipt waiting; it does not impose an inference deadline or authorize resend. |
| Checkpoint response rejection | `checkpoint_response_rejected` | Separates unproven completion, missing plain body, invalid JSON/envelope, operation/source/file-receipt mismatch, empty or oversized summary, foreign completion and browser failure. Emits only closed reason enums and semantic observation state, never response/source bodies or expected receipt values. Completion observed in the browser does not prove an accepted checkpoint; a generic uncertain-checkpoint error alone does not establish a failed send. This diagnostic does not relax validation or authorize retry. |
| Checkpoint durable settlement | `context_checkpoint_closed`, `native_checkpoint_stage_closed`, `native_checkpoint_model_failed` | A validated summary persists before surface release; `completed_result_preserved` reports that later cleanup failed without losing reuse. A proven same-operation unusable completion closes only after successful release and returns `tela_native_checkpoint_response_rejected`, preserved on retired-turn retries. Same-owner replay stays forbidden. Generic/foreign/unproven failures and unsuccessful release remain uncertain. Existing pending records lacking this proof are not upgraded into closed or completed records. |


### Unsupported Native projection and terminal retry semantics

Native `agent_message` input is attributed inter-agent communication, not a user instruction
or final-answer witness. The shared Web/Native local-compaction projector preserves its author,
recipient and ordered plaintext content; incidental IDs/metadata do not affect semantic identity.
Agent revisions remain protected from historical assistant truncation. Opaque/encrypted or malformed
agent content fails closed before Web submission.

`request_projection_unsupported` classifies this preparation boundary without logging input types,
agent text or identifiers. HTTP 400 `tela_native_projection_unsupported` preserves the same sanitized
recovery after retirement. Late streaming failures use the same code in `response.failed`.
Native currently retries unknown streamed failure codes once despite `retryable=false`;
the next request receives the preserved HTTP 400 recovery and stops.
Generic retired turns likewise use HTTP 400: Native maps 409 to a retryable unexpected-status error,
regardless of a JSON `retryable=false` field. These terminal responses never restore execution authority.
A new Web turn alone cannot repair unsupported context; use Native until support is available.


### Native result handoff and pending approval

Semantic lifecycle precedence is shared: failed assistant first, pending approval before
presentation completion. Copy/turn-action controls can coexist with a still-pending decision.
An exact Native-result handoff may record its observation baseline during that wait; it does not
click a card, grant tool authority, or prove a completed action. No continuation/final is committed
while approval remains unresolved, and card clearance alone is not assistant progression.

`web_tool_handoff_rejected` records fixed `assistant_completed` / `assistant_failed` reasons and
structural counts when an already terminal assistant prevents handoff. Ambiguous or probable
handoff evidence remains rejected by the runtime, emits `handoff_proof_unavailable`, and returns
terminal HTTP 400 `tela_native_handoff_reconciliation_required`. The same sanitized advice survives
retirement and streamed failures. Native may retry an already-started streamed failure once;
the following HTTP 400 ends the retry. Preserve/reconcile the existing Native result before a
new authorized turn; neither a retry nor this recovery code authorizes executing the tool twice.


Owned maintenance settlement emits `native_checkpoint_operation_reconciled` with a bounded stage
fingerprint, original owner kind, `released_locally`, `remote_outcome=unknown` and zero model calls.
It requires verified physical-owner release and exact journal selection; it does not report a
successful summary, proven remote cancellation or a resumed task. Completed summaries are preserved.

## Turn summaries and measurement coverage

`diagnostics context` contract version2 retains its existing plans and continuity links and adds
`summary`, `cycleReceipts` and `completionEvidence` per Native turn. A Native turn may contain more
than one authorized response cycle: a fresh cycle cannot inherit a prior cycle's final. The current
summary follows the latest observed cycle boundary, not every late browser event bearing an old
origin fingerprint. `completedAt` and duration stop at the final/retirement boundary;
`observationThrough` and `postTerminalEvents` retain subsequent observation separately.

The summary distinguishes one Web activation, exact/causal acceptance, transient identity waits,
Native tool queue/result/Web-release, observer replacement, transport disconnect, context settlement
and local final commit. Observer count is not reconnect count; incomplete bounded refusal inspection
is not a tool error; unavailable rendered author text is not a failed causal receipt. Repeated
activation of the same known operation/phase is a warning, not proof of duplicate server execution.

The runtime emits `native_cycle_observation_started` and one `native_cycle_summary` per observed
planner cycle. It uses the same sanitized event path, with at most32 process-local subscribers and
512 relevant events per cycle. It unsubscribes on final commit or retirement; no timer, log scan,
model request or idle polling is added. Terminal duration uses a monotonic clock. Summary rows share
existing bounded rotating-log retention; they are not an unlimited audit store. `summary_complete`
attests only an unclipped process-local window, never all services, host display or remote execution.
A retained receipt can establish observed local completion after raw rows rotate; its coverage and
byte-measurement flags remain visible. Unsupported/missing receipts do not establish success.

Byte measurements are separated from local token estimates:

- `composer` measures Tela-authored text at the local activation boundary; `preparedComposer` counts
  preparation separately, so a failed draft is not a transmitted message.
- `context` is encoded inline context JSONL; `protocol` is the remaining header/instructions/envelope.
  These two sum to composer bytes. This partition is a transport measurement, not billed tokens.
- Attachment counts cover observed upload attempts. Native MCP text parts, image bytes and existing
  serialized MCP request/result envelope measurements are separate observations. Text/image values
  overlap their envelope; do not sum them into a fictitious total. Opaque resource/model overhead and
  unlinked inventory work are not assumed measured.
- `observed`, `total` and `complete` describe only observed contributions. Zero observed with
  `complete=false` is unknown actual cost, not zero actual cost. Tool coverage checks known Native
  result operations; missing projected results cannot masquerade as a complete measurement.
  New MCP text-byte inspection scans at most1MiB of UTF-16 characters per result; larger results
  preserve their original payload and expose character counts with byte measurement unavailable.

Only unambiguous request or operation fingerprints join cross-service observations. Conflicting
links and ambiguous/unattributed operations are counted rather than guessed. Native operation
fingerprints bind projected MCP byte counters without hashing capabilities, arguments or bodies.
The same Native result records `native_tool_result_released` immediately before its existing Web
release; this diagnostic changes no execution, permission or replay decision. Old logs lacking this
stage show unmeasured release coverage, not a newly invented failure.

Do not evaluate semantic recall with extra model calls just for monitoring. Reuse, source coverage,
new summary attempts, transfer estimates, useful local completion and user-confirmed effects are
separate evidence. Provider billing/actual inference count remain unmeasured unless an authoritative
provider contract supplies them. These diagnostics never become correctness or recovery authority.

For routine agent diagnosis, request one concise turn first:

```sh
chatgpt-tela diagnostics context --scope <24-character-scope-fingerprint> --view summary --limit 1
```

`--view full` preserves detailed plans and continuity links; summary view defaults to eight turns
and retains only the latest receipt per turn. `--limit` is bounded1–64. Explicit selection omissions,
source coverage and evidence caps remain present in both views. Use full details only to resolve a
specific gap rather than repeatedly injecting complete diagnostic timelines into an agent context.

Coverage follows ownership boundaries: planner-cycle receipts instrument Tela's Native-to-Web runtime;
projected-result counters instrument both public and private Native MCP servers through their shared
registration code. Existing MCP trace-envelope measurements remain available to compatible Chat tools,
but Chat tasks and directly forwarded official Native responses do not acquire a Native-to-Web receipt
or authority merely by sharing logging utilities. Missing receipts on those uninstrumented paths are
coverage gaps, not failures. Do not import peer service runtimes or invent Native identifiers to make
an aggregate appear complete.

### Inspection input revocation evidence

`inspection_ownership_revoked` records only a fixed input category (pointer, modifier, navigation,
editing, activation, other), revision and interaction mode. All external key-downs retain the same
ownership fence, including modifiers; classification grants no authority. Switching to interact alone
does not revoke input ownership. `inspection_owner_disposed` identifies subsequent surface release
and whether external input was previously observed, without claiming that it caused the release.
Browser lifecycle events carry a disposable surface fingerprint because their creation-time request
context may differ from the request currently reusing that surface. Existing event caps and retention
apply; actual keys, shortcut combinations and text are never recorded.

### Retained answer availability

`web_retained_answer_committed` records `verified`/`unavailable` and a closed reason at answer
completion, independently of final delivery. It contains no answer or element/attribute values.
`web_retained_anchor_rejected` continues to distinguish missing committed proof from later body
absence or a changed digest. A lossless generic DOM representation handles elements outside the
normalized author grammar; remaining unavailable proof never permits text-equality fallback.

### Compaction and tool/service failure boundaries

Compaction uses a shared request-source projection, model/effort and canonical Native owner/environment
for operation identity. Wire delivery and correlation metadata do not change that identity. Every
request, including cached/coalesced waiters, still proves current ownership before delivery; changed
source/model/environment is rejected without another model call. Failed results remain coalesced.

`compaction_operation_observed` records new/coalesced/cached state and comparison booleans for source
and wire, linked by the disposable operation fingerprint. `compaction_source_observed` records logical
and transfer estimates, the current provider source limit and fit result. `compaction_rejected` preserves
the original failure phase/reason even for a cached failure, plus HTTP status and fixed failure class.
Binding reasons distinguish malformed claims, absent/changed owners, lineage/agent changes and failed
owner reads. `compaction_release_failed` records cleanup separately; it cannot erase the primary
failure or publish a successful operation before cleanup. Oversized source still needs a verified
readable checkpoint; diagnostics never authorize truncation, a resend or another summary attempt.

Private service calls distinguish transport, response decoding and HTTP rejection, retaining status
through a typed error. Gateway distinguishes descriptor lookup, invocation and status observation,
including parent cancellation versus its own deadline. Chat capability and Native invocation failures
share a bounded classifier (four causal nodes; 4096 message characters per node, fixed outputs only).
Standard missing-file/type/timeout/transport failures remain distinguishable through wrappers. MCP
uses the installed SDK's public timeout code in its adapter and records connect/invoke and cleanup
failures separately. Returned MCP errors and thrown errors remain distinct; opaque upstream errors
may still be unknown. No inference about actual tool execution follows from these diagnostics.

These failure-only events reuse existing parent/scope/operation correlation, canonical incident
filtering and bounded rotation/retention. No paths, endpoint URLs, request/response bodies, stack
traces, arbitrary error codes or exception messages are logged. No private capture, sampler, model
call, execution retry or new session is added. Existing approval/body/context evidence is reused.


## Accepted Web viewing and seed-cost evidence

`inspection_input_classified` records at most 16 host hit-test outcomes per surface,
without targets, coordinates or text. Strict submission input fencing remains separate
from the same host's accepted-observation fence. Pending classification blocks delivery;
only proven selection/locally linked disclosure or copy/navigation preserves observation.
Unknown/editing input requires exact request proof. `web_turn_ownership_observed` adds
observation-input state and expected/observed author character/root counts, never bodies.
`inspection_scroll_observed` reports at most 16 keyboard-scroll range observations.
Public-progress extraction records bounded marker-sibling search depth/candidate counts
(65 means the sibling budget was exceeded), not hidden text or generic disclosures.

An accepted ownership failure has a closed `tela_web_observation_unproven` reason;
HTTP and started SSE share terminal, nonretryable recovery. The existing bounded
retired-turn registry retains the reason rather than replacing it with a generic replay
error. No retry, resubmission or automatic fresh-context recovery is authorized.

`web_turn_plan` seed-byte partitions appear as `seedCost` in full and compact context
reports. The partitions cover prepared segment text; encoded composer/protocol and media
measurements remain separate. Flags show fresh-seed target/rollover excess and whether
a prior local settlement existed. They help identify repeated reconstruction; they do
not prove wasted billing or semantic recall. Missing old fields remain unknown. The
packaged launcher accepts the same `--view summary --limit 1` options as the source CLI.
All evidence uses existing bounded rotation; no cumulative archive or idle model work.

# Diagnostic evidence

## Start here

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
`response-recovered`, `approval-stalled`, `missing-models`, `startup-stalled`, `ui-anomaly`, `unknown`.
Existing `diagnostics incident`, `trace`, `workload`, `retention-canary`, `doctor` and platform-specific
`diagnostics desktop` remain focused views; their evidence is not a second authority.

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
| Codex automatic handoff | `native_auto_handoff_rejected` | A direct call to the default-denied research adapter was rejected **before RPC connect**; `prepare`, `verify_source`, or `verify_recent` only. The product does not wire this adapter. |

`list_processes` now also returns a read-only `capacity` object with
`registryCount`, `registryLimit`, `availableSlots`, `unknownCount`,
`activeCount`, `terminalRecentCount` and `terminalExpiredCount`.
These are **service-wide aggregates only**; the process rows remain limited
to the caller's approved workspace. A full registry can therefore be
diagnosed through `list_processes` even when `exec_command` cannot start
another process or the chosen workspace has no unresolved commands.
The snapshot does not start, terminate, consume or reclassify any operation.
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
computed **only on capacity rejection**; no command, request body,
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
reasoning observation for requests started while it is enabled. Default operation does not parse
successful streams. Opt-in inspection observes only caller-consumed SSE bytes; no tee, eager drain,
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
Opt-in parsing has bounded CPU cost; default-on admission or battery equivalence is not claimed.

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

`inspection_window_action` distinguishes reveal, hide, close-to-hide and owned release, including document generation/live state. `inspection_mode_changed` records mode changes; `inspection_input_observed` records at most64 activation categories per surface with owned-input/mode flags, never keys, coordinates or target text. These observations establish timing and input source, not approval acceptance or causality. Existing structural incident limits/private capture consent and retention apply; no sampler or model request is added.

# Separate Web tasks

## Explicit ownership handoff for Native-created threads

Direct Native RPC conversations are outside the managed Web delegation journal by default.
The coordinator can explicitly call `linkNativeThreadForRetention` with compact
ownership evidence: slot, canonical checkout path, creation timestamp,
authenticated account fingerprint, and exact thread/turn IDs. Use original creation
authority, or an explicit user request to adopt existing delegated threads with
their coordinator acknowledgements and current account proof. Readability alone
never opts personal threads in, and current proof must not be presented as historical proof.
No build verification report or external receipt file
is required. The link rechecks the authenticated account and exact public
`thread/read` (including paginated history) and indexed turn metadata, then adds one `linked` journal
entry without acquiring a work permit or sending a model request. Duplicate
thread links are refused. Existing retention lifecycle reads the same journal.

For live acceptance, the Native coordinator must first read the original
delegation evidence and account/profile ownership proof, confirm the target thread
is deliberately opted in, then inspect its current `thread/read`, both
`thread/list` archive partitions, last indexed turn and `thread/queue/list`.
Only then may it deliberately invoke the link on a non-production fixture or
an explicitly authorized target. Verify the journal link and next retention
decision on demand, observe archive metadata and its receipt after expiry,
then verify manual restore exclusion. Test delete only with an isolated
disposable thread; never use existing user conversations as delete fixtures.
Re-read the journal and Native metadata after daemon restart to verify resume.
The existing retention receipts (`archived`, `excluded`, `deleted`) distinguish
performed effects from mere due dates. Linking keeps the existing retention policy;
it does not backdate result collection. Missing collection timestamps follow the
uncollected policy and are never replaced by answer times or file modification times.

The source CLI can run a bounded, workspace-write-capable task on a connected Tela Work profile without
changing the model of an existing conversation or exporting its history. Newly created journal-owned Native
threads receive a one-time `[Tela Agent] ` prefix on first explicit inspection of a terminal result,
successful or failed,
through Native `thread/name/set`. Naming uses the current title, or the first nonempty line of
Native preview when unnamed. A one-time naming marker is cleaned with the job and kept separate
from verified-answer collection time; existing collection receipts count as already handled.
No title-event observer, timer or permanent title list is used. Later inspections and continuations preserve user
renames. Naming failures do not block the answer and are not automatically retried.
The Native engine creates
a new durable, paginated thread and supplies its own tool/sandbox authority; the existing Web
provider performs inference. This is not an independent Tela Chat worker or an API-key fallback.

## Source CLI

These commands require an already installed, owned Tela Work runtime and a matching signed-in Web
profile. They do not start, update or restart services. New delegations default to the calling profile when its runtime hint or exact Native thread identifies one; otherwise the single-profile default is 1. Explicit `--slot N` selects another profile. A continuation retains its existing job profile.

```sh
bun run cli web-delegate catalog
bun run cli web-delegate start --cwd /path/to/project --prompt-file /path/to/task.txt [--mode read|write]
bun run cli web-delegate continue --job UUID --prompt-file /path/to/followup.txt
bun run cli web-delegate capacity [--slot N] [--mode read|write]
bun run cli web-delegate status --job UUID
bun run cli web-delegate reconcile --job UUID
bun run cli web-delegate result --job UUID
```

These commands operate on journal-owned Web jobs. `continue` requires a proven
completed eligible parent and starts a new turn in the same thread; it does not
enqueue work or steer a running generation. The Native conversation's own queue
and steering operate under its separate Native authority. When the current harness
advertises its original Goal tools, the Web task receives a separate Goal-only
control capability. Discover `goal_control_inventory` through Tela Chat and use
`goal_control_call` with the returned Native schema. This uses the original Native
tool execution/result path; it creates no Goal store or scheduler and cannot invoke
Native work tools. Goal caller IDs are scoped to the Native thread and turn before
execution, so a later turn can reuse a caller label without matching an older result.
The returned result retains the caller's original ID; duplicate-call checks within
one turn are unchanged. The capability expires with the response cycle. When no original
Goal tool is advertised, no completion capability is supplied: report that limit
instead of creating a shell/RPC completion helper.

Completion requires the full objective's evidence before the original Goal update
call, followed by a final answer. An isolated installed acceptance verified an actual
file read, the original completion result, normal Native turn completion and no
successor turn. This does not guarantee every delegated task reaches its objective.
The external coordinator API has no scheduler fence or turn compare-and-set; prior
acceptance observed a successor start in the same second as external completion,
so an external ACK alone is insufficient.


`status` includes the last observed public Native reasoning **summary** in
`progress`, when available. It retains only the newest summary (up to 2,048
characters), its observation time, and whether it came from live notifications
or indexed history. `observedAt` is the read time, not proof the task recently
advanced; a retained summary is not proof that its described condition is still
visible. No raw reasoning is read. Explicit `reconcile` can recover an available
summary from the exact running turn without replaying its request. Missing
summary evidence remains unknown, and elapsed time never implies blockage.
Terminal settlement clears this presentation. Profile-level browser approval
inspection remains separate because its selected surface is not attributable
to a particular delegated Native turn.


`start` prints a job ID early and observes completion through the existing event connection.
The caller can finish its own model turn instead of repeatedly asking whether the worker is done.
Waiting in this process does not invoke a language model. The Web worker still uses inference while
doing its task; preparing and reviewing a task also consumes the calling model's tokens.

`status` reports persisted observations, not proof that an engine is still running. `reconcile` reads
only the acknowledged job's newest turn using bounded public paging, rechecks its owner and stores
a proven final result. A completed execution is reported separately from
requested-task success (`taskOutcome: unassessed` until an explicit outcome contract exists). An explicit
final failure/partial/blockage report must not be counted as task success. Older records without final
evidence cannot be returned as verified results. It never sends the prompt again. Lost creation/submission acknowledgements
without an exact turn identity remain uncertain and require inspection. For a
fresh dedicated thread with exactly one indexed turn, reconciliation can recover
a lost first-turn acknowledgement when its single user text hashes to the
persisted submitted prompt. Ambiguous history, a continuation, or any input
mismatch preserves uncertainty and never resubmits a request.

Tool counts describe observed supported Native items, including collaboration calls. Their coverage
is reported as live events, limited history summary, or unverified for older records. Zero is never
proof of no execution: summaries can omit tools and child-agent activity has separate ownership.
History recovery preserves already observed counts rather than replacing them with summary zeroes.
A completed turn with no proven final is marked `result_unavailable` and releases its slot; failed Native turns report `turn_failed`, while lost observation or ACK reports `transport_or_ack` and remains reserved for exact recovery. An overlong or ambiguous response without verified completion remains uncertain. The final answer is delivered from an explicit final-phase message, or from
the **only** unphased assistant message in an exactly completed Native turn.
Commentary and multiple ambiguous messages are not guessed into a final;
task success remains unassessed either way.
The separate `toolResultItems` count requires bounded result-bearing completed Native tool
items, without storing their command, output or arguments. It is evidence of returned tool
results, not proof of their contents, success of requested effects, or Web semantic use.

The selected model comes from the current complete Web catalog. The isolated release-label policy
selects the highest unambiguous numeric release, prefers Extra high, and permits High only on that
same model. Unknown naming, tied releases, missing efforts or incomplete catalogs fail before Send.
Actual browser selection and readback reuse the normal Web model routing implementation.

## Admission and capacity

Control Center Work shows one managed-job occupancy row per detected profile, with a native hover help button. Settings offers an independent 1–5 concurrent-tasks picker for each detected profile; changes affect new admission without cancelling work. Counts exclude direct Native RPC conversations (including the original analysis conversation) that never entered the managed journal. Unavailable observations display as unavailable, not zero.

The source CLI now supports `web-delegate capacity [--slot N]`, which reads the
owned local delegation journal without invoking a model or opening a browser.
`start` acquires one cross-process task permit (configurable 1–5 per profile (default 3)) and a
checkout writer permit before connecting to the provider. Each new task defaults
to workspace-write authority so a read-heavy analysis can proceed to code changes
within the same Native conversation. These are local managed-job limits, not Web
provider quotas. The physical Git worktree root is the writer identity even when
callers choose different subdirectories. Multiple tasks may write concurrently in
different worktrees; only one may hold writer ownership within a worktree.
Read-only tasks may share a checkout with its writer when the profile has a
free task permit. Writer checkout contention applies only to new writers;
same-thread continuation exclusivity is enforced separately.
Legacy read-only jobs and their lease files remain readable and count against the
configured total permits until terminal recovery. An old read-only thread cannot be
silently upgraded to write authority. There is no queue.

`continue --job UUID --prompt-file ...` requires a verified completed write-capable
job, its exact owner/profile/checkout, and the latest completed Native turn on
that thread. It reserves a new child job ID and starts a **new turn in the same
Native thread**, with only the new prompt sent as input. The original completed
job and immutable result stay intact. The returned child ID is used for status,
result, reconcile, and another continuation. It does not create a new agent,
thread, or duplicate the finished turn. A fresh RPC connection attaches with
`thread/resume` and `excludeTurns: true` before submitting the continuation so
the final-answer and turn-completion events reach the caller. Native/Web session reuse depends on the
same owner and active terminal endpoint; mismatched identity fails closed.
After a runtime replacement, the current session must prove the same persisted
account and profile, and the exact parent turn must still be completed in the
current owner's bounded indexed history. Recovery reads the exact delegated turn
through the newly proven endpoint and rechecks account and session stability;
it never silently injects history or resubmits the old prompt. A changed login,
missing original thread, or ambiguous result remains unresolved.
Recreating it would require a new explicit task and a separately measured context
budget. An acknowledgement loss remains uncertain and must be reconciled before
any continuation.

A prior
live source-CLI write delegation on profile 1 created one requested file in an
isolated temporary workspace; its exact bytes, final receipt and released
permits were checked on 2026-10-19 (Asia/Seoul). This verifies that specific
write path, not confinement against hostile writes or production checkout
protection.
`web-delegate capacity [--slot N]` reports the same total-task occupancy
regardless of the optional legacy `--mode` input.
The authenticated Codex service exposes the same managed-job capacity snapshot
at `GET /v1/codex/profiles/:slot/web-delegation-capacity`; the macOS Control
Center Work page fetches this status on demand. This reports **local CLI-managed
delegations only**, not the availability of an arbitrary ChatGPT Web turn.

An admission refusal emits a machine-readable JSON object with
`status=admission_refused`, `code`, verified local `capacity`, and a
`nextAction`. `CAPACITY_TOTAL_PROFILE` means all configured managed tasks are reserved;
`CAPACITY_WRITER_CHECKOUT` means the selected worktree has another writer; `UNCERTAIN_RESERVATION` means ownership is unresolved;
`CAPACITY_STORAGE_RECORDS` is a legacy refusal code; current admission ignores
the retained-record count. These are distinct from account quotas or other profiles'
unmanaged activity. No time-based release, stale-process inference or blind
resend is allowed. An exact terminal journal completion frees its permit;
lost ACKs retain it until the exact job is reconciled. A source-level regression test verifies that connection loss after an acknowledged turn retains the reservation until exact recovery confirms the final answer, without resending the model request. Live disconnect acceptance remains outstanding. The capacity snapshot
covers only jobs known to this managed source CLI, not all Web tabs or chats.

A completed Native turn with exactly one unphased assistant message can be a
verified final answer. `start` emits a final result event, `reconcile` returns
the saved answer when proven, and `result` prints it without rerunning a model.
Immutable terminal receipts protect completed answers against late observer
timeouts or stale in-flight snapshots.

A Native turn can fail after emitting an explicit `final_answer`. Its Web job
remains `failed/turn_failed`, while `result` and `reconcile` may deliver that
verified final for diagnosis; the answer does not prove task success or permit
continuation. For a completed turn with no final in live notifications, the
exact indexed turn is read before settling `failed/result_unavailable` and
releasing its lease. Recovery applies the same terminal rule without replaying
the input. Missing or untrusted history remains uncertain and retains its
reservation.

Job records and results are private product data under the Codex service state directory, with
restricted filesystem permissions. Finished receipts and unresolved recovery journals remain
available for exact readback, even beyond the legacy 64-record review threshold. The capacity
response retains `records.limit=64` for v2 clients but sets `records.admissionBound=false`:
the threshold is advisory, and only owned active leases determine new job admission. No
automatic record expiry, deletion, or pruning is performed. Storage errors remain ordinary
filesystem failures, independent of capacity refusals. Do not put records, prompts, keys or
results in a repository or release. A complete user-reviewed removal lifecycle remains future work.
Source fixtures and a profile-1 live same-thread continuation verify final-answer delivery and
completion after attaching the fresh connection. Both-profile acceptance remains a separate check.

Continuations inherit their parent's profile and read-only or workspace-write mode.
They cannot promote an existing read-only thread to writing. Historical job
records without a corresponding lease remain available for exact recovery but
do not consume admission capacity or fence independent jobs. Held or unknown
leases still retain their reservation pending exact resolution.
An active continuation holds an exclusive permit for its Native thread, even
when both tasks are read-only. A second continuation is refused until the first
is proven terminal. Setup failures before `turn/start` release their permits;
after a submission attempt, uncertain acknowledgements remain reserved.

## Browser and permissions

The existing Work activity session picker and Open browser/Interact controls show an owned Web
surface. Closing its viewer normally hides the window; it does not cancel inference. Quitting the
Electron runtime is different. A job-to-surface identity contract is still needed before the product
can offer an automatic per-job browser button. Do not infer that identity from window titles.

The default execution requests and verifies a workspace-write Native sandbox with approval policy never.
That policy does not replace the ChatGPT connector's own approval UI or grant external apps write
permission. Do not treat prompt instructions as a filesystem or MCP security boundary.

## Remaining product work

- Durable completion delivery and a result inbox; native automatic wakeup requires a supported host contract.
- Exact cancellation, unknown-ACK reconciliation and owned removal of job/engine resources.
- A structured task specification, bounded file evidence and stale-result detection.
- Exact job-to-browser association and reliable one-shot approvals.
- Consumer UI, installed Windows/Linux acceptance and broader platform verification.
- Write tasks confined to a separately owned worktree, with explicit scoped permissions, change review,
  validation and cleanup. Existing user checkouts and other agents' work must remain protected.

The source CLI has completed live read-only and isolated write Web tasks.
The remaining end-to-end caller delivery, simultaneous live tasks, cancellation,
restart durability and full image attachment paths still require acceptance tests.

## Test-only live round-trip receipt (2026-10-18)

`packages/codex-service/src/web-native-roundtrip.integration.ts` has an opt-in
`--preflight` that creates and officially deletes an exact new empty Native
thread, proving absence before any model call. The separate `--acceptance`
attempts only one read-only Web turn in a new disposable Git repository and
checks a random local marker in the Web final and in a same-turn Native tool
result. Every acknowledged test thread receives at most one official Delete
request; uncertain cleanup retains its local journal for inspection.

In an earlier installed Profile 1 attempt, preflight passed (zero model requests, one exact
Delete/absence). One real Extra High Web request produced an exact-marker
final answer and one Native tool item. Its public Native summary did **not**
independently prove the result payload, so strict same-turn result acceptance
**failed**; the acknowledged synthetic thread was officially deleted and
its absence verified. A subsequent fresh attempt refused before a model
request because one Web surface remained active. That surface's ownership
was not established, so it was not closed. Live events with content-free
result witnesses are now included in the fixture for a later independently
authorized acceptance; no uncertain or retired turn was replayed. This is
not evidence of opaque Legacy-context continuity or an installed new release.

Profile 2 also passed an actual one-request Web/Native-tool/final round trip:
the completed Native command result and same-turn Web final matched a random
disposable-file marker. All synthetic threads were officially deleted and
proven absent; no personal conversations were read. The test-only script's
`--slot 1|2` option does not change normal production behavior.

### Post-upgrade acceptance, same date

After deploying the signed local macOS version
`0.0.0-approval-sequential-20261018.5aca459.1`, both profiles passed
independent preflights: each created one empty synthetic Native thread,
officially deleted it, and proved exact absence without a model call.

Both profiles then passed **separate** one-model-request, read-only
`web-native-roundtrip.integration.ts --acceptance --slot N` runs. Each
recorded one completed Native `commandExecution` item with a live
result carrier containing the test-only random marker, an explicit
Web final answer containing that marker, and proof that both belonged
to the **same Native turn**. The tests read no personal threads and
officially deleted all acknowledged synthetic threads, verifying absence.
These later successes supersede the *earlier* Profile 1 failure for
this **one-tool round-trip acceptance** only; they do not establish
opaque Legacy-context continuity or arbitrary write tasks.

Both tests used a Native read-only sandbox with approval policy
`never`. The separate structural diagnostic windows contained
**zero approval cards**; therefore the installed fix for consecutive,
distinct Web approval cards remains **source-tested and deployed, but
not live multi-card accepted**. Do not report it as proven from these
round-trip results.

## Managed conversation retention

The Codex daemon archives managed Web-delegation conversations 24 hours after
an explicit result retrieval, or seven days after real Native activity when no
result was retrieved. A subsequent managed continuation starts its own clock.
The daemon deletes its own automatically archived conversations 30 days later.
Result receipts and local workspace files remain intact. Status reads do not
extend either period. These rules cover journal-owned `web-delegate` threads;
chats created directly by another Native client are not discovered or adopted.

Retention uses the Native `thread/list`, `thread/turns/list`, `thread/queue/list`,
`thread/archive`, `thread/read` and `thread/delete` contracts. Active turns and
queued work are protected. Observed manual archive/restore, an outside-journal
continuation, or changes while archived relinquish automatic management.
Missing conversations are reconciled without recreating them. Unknown mutation
outcomes relinquish management rather than repeating a potentially completed
operation. Transient manual changes entirely between observations cannot be
reconstructed from the public metadata.

One next-expiry timer runs in the existing daemon. Journal writes, profile
reconnection and daemon startup trigger another pass; there is no polling or
new service. If a due thread is active or its profile unavailable, it is checked
again on one of those events. A stopped daemon performs no cleanup and catches
up after restart. Browser-window retirement is a separate lifecycle.

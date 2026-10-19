# Separate Web tasks

The source CLI can run a bounded, workspace-write-capable task on a connected Tela Work profile without
changing the model of an existing conversation or exporting its history. The Native engine creates
a new durable, paginated thread and supplies its own tool/sandbox authority; the existing Web
provider performs inference. This is not an independent Tela Chat worker or an API-key fallback.

## Source CLI

These commands require an already installed, owned Tela Work runtime and a matching signed-in Web
profile. They do not start, update or restart services. The default profile is used unless specified.

```sh
bun run cli web-delegate catalog
bun run cli web-delegate start --cwd /path/to/project --prompt-file /path/to/task.txt [--mode read|write]
bun run cli web-delegate continue --job UUID --prompt-file /path/to/followup.txt
bun run cli web-delegate capacity [--slot N] [--mode read|write]
bun run cli web-delegate status --job UUID
bun run cli web-delegate reconcile --job UUID
bun run cli web-delegate result --job UUID
```

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
without an exact turn identity remain uncertain and require inspection.

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

The source CLI now supports `web-delegate capacity [--slot N]`, which reads the
owned local delegation journal without invoking a model or opening a browser.
`start` acquires one cross-process task permit (three per profile) and a
checkout writer permit before connecting to the provider. Each new task defaults
to workspace-write authority so a read-heavy analysis can proceed to code changes
within the same Native conversation. These are local managed-job limits, not Web
provider quotas. The physical Git worktree root is the writer identity even when
callers choose different subdirectories. Multiple tasks may write concurrently in
different worktrees; only one may hold writer ownership within a worktree.
Legacy read-only jobs and their lease files remain readable and count against the
three total permits until terminal recovery. An old read-only thread cannot be
silently upgraded to write authority. There is no queue.

`continue --job UUID --prompt-file ...` requires a verified completed write-capable
job, its exact owner/profile/checkout, and the latest completed Native turn on
that thread. It reserves a new child job ID and starts a **new turn in the same
Native thread**, with only the new prompt sent as input. The original completed
job and immutable result stay intact. The returned child ID is used for status,
result, reconcile, and another continuation. It does not create a new agent,
thread, or duplicate the finished turn. Native/Web session reuse depends on the
same owner and active terminal endpoint; mismatched identity fails closed.
Reconstructing an expired or changed session is not supported; no history is
silently re-injected, so the injection cost is zero for accepted continuations.
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
Center Work page shows this status on demand. This reports **local CLI-managed
delegations only**, not the availability of an arbitrary ChatGPT Web turn.

An admission refusal emits a machine-readable JSON object with
`status=admission_refused`, `code`, verified local `capacity`, and a
`nextAction`. `CAPACITY_TOTAL_PROFILE` means all three managed tasks are reserved;
`CAPACITY_WRITER_CHECKOUT` means the selected worktree has another writer; `UNCERTAIN_RESERVATION` means ownership is unresolved;
`CAPACITY_STORAGE_RECORDS` means the separate 64-record retention ceiling
has been reached. These are distinct from account quotas or other profiles'
unmanaged activity. No time-based release, stale-process inference or blind
resend is allowed. An exact terminal journal completion frees its permit;
lost ACKs retain it until the exact job is reconciled. A source-level regression test verifies that connection loss after an acknowledged turn retains the reservation until exact recovery confirms the final answer, without resending the model request. Live disconnect acceptance remains outstanding. The capacity snapshot
covers only jobs known to this managed source CLI, not all Web tabs or chats.

A completed Native turn with exactly one unphased assistant message can be a
verified final answer. `start` emits a final result event, `reconcile` returns
the saved answer when proven, and `result` prints it without rerunning a model.
Immutable terminal receipts protect completed answers against late observer
timeouts or stale in-flight snapshots.

Job records and results are private product data under the Codex service state directory, with
restricted filesystem permissions. A hard capacity of 64 records bounds storage; it does not
silently discard results. Do not put these records, prompts, keys or results in a repository or
release. This source version does not yet provide a complete removal lifecycle. Successful continuation is covered by source fixtures; a live model continuation has not been exercised in this change.

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

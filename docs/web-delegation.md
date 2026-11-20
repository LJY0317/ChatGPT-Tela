# Web tasks

Tela supplies Web responses to the official Desktop app. The app owns Native task
execution and conversation identity. The retired external engine, managed-job CLI
and proxy are removed; do not recreate them or change the official provider identity.

## Finding Web tasks today

In the official ChatGPT Desktop app, open Work for the connected profile and select
a Web model where that choice is offered. Start a task or use the app's own agent
delegation controls when available. The official host creates and admits the task;
Tela supplies its Web responses. Tela has no separate **New Web task** action.

On macOS, open **ChatGPT Tela → Control Center → Work**. The profile's **Open app**
button opens its official app. The existing **Web activity** section lists owned,
currently available Web browser surfaces. Select one to **View snapshot**, **Open
browser**, or **Interact…**. These actions reuse that surface; they do not start or
duplicate a task. An empty list means there is no active owned surface to preview,
not that an official task or conversation was deleted. Manage tasks and conversations
in the official app. The retention commands below are source-level management
operations, not user-facing delegation creation commands.

When Tela verifies a newly spawned child's first Web turn, it prefixes the
official chat title with `[Tela Agent]` as part of enrollment. Separate chats
created by selecting a Web model keep their title until explicitly tracked.
Using a Web model or adding the prefix does not enroll a chat in retention.
Open **Control Center → Work → Manage Web tasks…** and select a tracked task
to **View answer**. The list uses existing registrations for the configured profiles,
including automatically registered Web children. Choose **Confirm receipt** after reading.
If the latest request failed or was interrupted, **View previous answer** opens the
most recent earlier saved final in the same chat. Reading it does not confirm receipt
or change the archive deadline.

If a Web request may have been sent, Tela can return its verified saved answer
on an exact reconnect. If its browser session is still listed under
**Control Center → Work → Web activity**, select it and choose **Open browser**
to check for a result. Once the temporary browser session is gone, a send record
alone cannot recover its answer. Check the saved task history before starting a
new request.

To register an independent Web chat, choose **Use a task link…** if the list is shown.
Paste the ChatGPT task link, select the matching profile if asked, and choose **Track task**.
You can also use the link to open an answer from a tracked, already archived chat.
From the command line, use `chatgpt-tela retain-delegation --standalone --thread CHAT --slot N`.
The selected profile must already know the exact standalone chat and its Web
model. The caller can enroll it as soon as those details are visible in official
history, including before the first turn saves. The source CLI can read the latest
result of an enrolled chat:

```sh
chatgpt-tela read-delegation-result --standalone --thread CHAT --slot N
chatgpt-tela acknowledge-result --standalone --thread CHAT --slot N --turn TURN --item FINAL_ITEM
```

The read returns the exact turn, final item and text, or the current turn's pending,
failed or interrupted status. A registered chat with no saved turn is pending without a
turn ID. Reading alone does not change the deadline. If another final answer replaces the
one you viewed, reopen the result before confirming receipt. The service stores the receipt without the
answer body. The desktop host's separate-chat creation tool currently returns a thread
identity to its caller, but it exposes no verified creation callback to Tela. Its caller
must enroll that chat explicitly. Regular Web chats never opt in solely by using a Web model.

### Native-to-Web child dispatch

On build `2026111804`, the official Desktop coordinator in profile 2 created two
children targeting the two Tela Web models. Both stopped at context projection
before browser submission. The host supplied each assignment in an
`agent_message` with a visible header and an opaque `encrypted_content` part.
The assignment was absent from the visible input, so dropping the opaque part
would send an incomplete task. Neither child returned an answer.

The official engine accepts plaintext collaboration messages when the caller
marks the tool arguments as plaintext or invokes the collaboration tool through
Code Mode. The default Desktop and direct CLI trials did not produce a readable
assignment. The public app-server's direct turn APIs also reject user input on
parent-controlled V2 children. Parent/root turn attribution alone cannot create
that relationship.

The official engine bundled with Desktop (`0.171.0-alpha.13`) completed a native
child Web task in a scoped CLI trial with
`features.multi_agent_v2={enabled=true,non_code_mode_only=false}`. The coordinator
used the nested Code Mode tool. The child's saved first turn contained the
plaintext assignment, the actual Web answer reached the parent, and Tela's
existing registry automatically registered the child and acknowledged the exact
final. A separate profile-2 trial through the official Desktop task tools
repeated the full path without a CLI submission. A temporary profile
configuration exposed the nested collaboration tool for a fresh Desktop task.
The first child turn, Web final delivery, automatic registration, and receipt
were verified before leaving the profile configuration at its original setting.
With the profile restored to its original settings, a fresh Desktop task in
the same profile did not expose nested Code Mode spawn. A subsequent profile-2
Desktop test used only this feature configuration in a trusted disposable
project's `.codex/config.toml`:

```toml
[features.multi_agent_v2]
enabled = true
non_code_mode_only = false
```

The local Desktop task used nested Code Mode spawn once. The Web child
received plaintext, was registered automatically, and returned its final
answer to the parent. Acknowledgement applied the twelve-hour archive deadline.
The experiment's project setting and trust entry were removed. This is a
version-specific experiment with the bundled engine; the option is undocumented
in the public configuration reference.
[Engine implementation](https://github.com/openai/codex/blob/rust-v0.171.0-alpha.13/codex-rs/core/src/tools/handlers/multi_agents_v2.rs#L54-L66)
· [Direct input restriction](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/thread_input.rs).

For the default Desktop setup, use the official desktop thread tools to create
an independent Web task with the full assignment and retrieve its result by
thread ID. This route was verified with a live Web answer and explicit retention
registration.

### Cross-profile dispatch

The 2026-11-17 review found no official way for Tela to target a different
Desktop profile for conversation creation or live turn control. Plura's target
contract v2 exposes profile identity and app lifecycle. The official Codex
app-server can create and steer turns on a connected instance, but the tested
Desktop instances did not expose a supported profile-bound endpoint. Tela's local
stored-history reader runs separately from those live Desktop owners. It can
collect a registered chat's saved answer through its profile without becoming
that conversation's live controller.

The missing contract is either an official thread tool with verified destination
profile selection or an authenticated endpoint to the existing Desktop owner
per profile. It must support creation, exact follow-up, interruption, status and
final-result readback. Acceptance requires disposable tasks in both directions,
with confirmed destination/turn IDs, wrong-profile rejection, and an outcome
receipt that prevents duplicate submission after disconnect. Keep existing
profile identity and transport code when that contract becomes available.

### Web answer delivery in standalone chats

On profile 2, two official Desktop Web chats on build `2026111804` produced
answers in the browser that the app could not collect. The folded renderer
exposed only part of the submitted text, and hydration changed the rendered
turn key. Opening the fold could temporarily unmount the author bubble.

Tela now checks a digest placed near the start of the submitted message after
the exact composer send. A folded receipt can rebind the matching author and
assistant lineage within the same unchanged document, including a second
renderer rekey after the route is canonical. Edits, different conversations,
and competing authors continue to require independent proof.
Build `2026111807` returned both expected final answers to profile 2's official
Desktop chat, one from each supported Web model.

### Concurrent delegation setting: pending host support

The requested policy is **three simultaneous Web-delegated child tasks per profile
by default**, with a user-editable count that never exceeds the official host's
effective maximum for that profile. It is **not currently enforced**. A Web browser
surface is not a child-task identity, and multiple child tasks may be admitted
without consulting Tela's menu or local preferences.

The official host owns child creation/acceptance (including its agent tools).
Tela's [current-turn parser](../packages/codex/src/request.ts) receives the parent
and child identities only in an accepted request; its [Native history reader](../packages/codex/src/app-server.ts)
observes already-created `subAgent.thread_spawn` lineage. The [delegation service](../packages/codex-service/src/http-server.ts)
only enrolls, acknowledges, or reconciles a *previously created* child for archival.
These are post-acceptance operations, not a concurrency admission gate. The obsolete
`webDelegationLimits` key is intentionally discarded by the [current preferences
parser](../packages/product-config/src/preferences.ts); restoring that field alone
would save an inert number.

Before exposing a numeric control, the official app needs to provide a supported,
atomic pre-acceptance limit (or a host-enforced configurable cap), the authoritative
profile/child ownership and active/terminal lifecycle, and a readable maximum that
covers every host child-creation route. Only then can each profile use
`min(user choice ?? 3, host maximum)`, enforced **before child acceptance**.
Until those contracts exist, no local queue, scheduler, daemon, or model
instruction can claim to enforce the limit.

The Work page includes a short **Web tasks / Web 작업** introduction beside the
existing profile actions. It reuses Web activity; there is no second task inventory
or nonfunctional concurrency selector.

## Responses within a Native turn

A Native turn may contain several provider responses, including a coordinator
message injected after an answer. Tela admits that follow-up only after the prior
final was delivered; it does not treat every changed request as a replay of the
first response. Active tool rounds still require their exact outstanding result.
Completed receipts advance from the exact delivered predecessor in the existing
journal, retaining one receipt per Native turn. Replays of replaced requests are
rejected, including after restart; a retained answer alone does not authorize a
new response. This does not add a scheduler or restore the retired engine.

## Delegated-chat retention

The source implementation connects new Web-child observation, explicit registration
and exact result acknowledgement to the existing Tela Codex service's archive path.
This integration is not installed or accepted against consumer Desktop profiles yet.
Automatic deletion remains disabled.

When a new child executes its first official turn through a Web route, the installed
profile runtime notifies the existing owned service once per new provider operation.
Notification starts before Web context preparation so an eligible child can still be
managed if that preparation fails. The service verifies the exact configured profile,
canonical parent/child lineage and first turn before enrollment. Ordinary chats and later Native-to-Web switches do not
enroll. Replayed responses do not dispatch another notification; observations never
reactivate retained archive records. A registration failure emits correlated diagnostics
without blocking the answer or shutdown readiness. No catalog scan, hook installation,
model request, retry worker or second registry is added.

An isolated installed-engine trial confirmed parent identity in the child request and
successfully enrolled it through the actual read-only history client before returning
its first synthetic answer. This used no external model call or consumer profile.
It proves that boundary, not consumer Desktop installation or timed archival.

If the official parent/child lineage is already readable but the first turn is still
unavailable, the service saves the observation in the existing registry. Listing that
parent's tasks or running normal retention reconciliation can confirm it without moving
the seven-day deadline. Pending observations cannot be named, listed as managed, or
archived until the exact first turn matches. A readable different first turn, or a
readable empty history at the seven-day deadline, discards the observation.

The host must supply the parent identity and the service must be able to verify the
thread lineage when notified. Explicit enrollment remains available:

Use the Native coordinator's existing command tool after creating a selected child:

```sh
chatgpt-tela retain-delegation --thread CHILD --slot 1
```

This explicitly enrolls that child. It checks the public
`source.subAgent.thread_spawn.parent_thread_id` against the coordinator's Native
`CODEX_THREAD_ID` and scopes the record to this installation and exact configured
profile/history home. A title, Web model, old journal, ordinary user chat, app save,
or lifecycle event alone never enrolls a conversation. Native `spawn_agent` does not
implicitly call this command. A new child's first Web turn uses the observation path
above; other deliberately selected children require this explicit command.
No AGENTS.md rule or additional model request is needed for the operation itself.

The coordinator can recover its own tracked child IDs from the existing registry:

```sh
chatgpt-tela list-delegations --slot 1
chatgpt-tela read-delegation-result --thread CHILD --slot 1
```

The list is scoped to the calling coordinator and selected profile. It includes
archived registrations while their metadata is retained. A listed receipt is
historical; read the current result before assuming it covers the latest turn.
If the latest turn failed or was interrupted, add `--previous-before TURN` to
read the most recent prior saved answer without acknowledging it.

After receiving an exact result, the coordinator confirms it through the same service:

```sh
chatgpt-tela acknowledge-result --thread CHILD --turn TURN --item FINAL_ITEM --slot 1
```

For the latest failed/interrupted turn, replace `--item` with `--outcome failed` or
`--outcome interrupted`. The service verifies lineage and the exact indexed final
item or terminal failure; duplicate acknowledgement preserves its first timestamp.
This is explicit confirmation of receipt, not proof of comprehension, task completion,
or resolution of the original request. It stores identifiers and time, not answer
or error bodies. A wait wakeup is not a collection receipt.

- A verified receipt for the newest final answer makes it eligible 12 hours after
  first collection. Duplicate receipts do not restart this clock. Failure/interruption
  acknowledgement is not collection of an answer.
- Every other enrolled chat uses the fixed deadline of first enrollment plus 7 days.
  A new uncollected turn, missing completion time, observation failure or metadata read
  does not extend that deadline. Unknown receipt validity uses the same fallback.
  A new turn invalidates the older answer receipt, not the original fallback clock.
- The service keeps one next-due timer and reconciles enrolled records at startup.
  It never scans the conversation catalog, adds a daemon, starts a model turn,
  interrupts work or forces an owner to release a conversation.
- At the mutation boundary, an exact-thread lifecycle client acquires the official
  writer through `thread/resume` with `excludeTurns:true`, checks lineage and the
  latest turn when validating an answer receipt, then calls `thread/archive` on the same
  connection. No provider/config/history overrides, unarchive or delete are exposed.
  The separate stored-history reader remains read-only.
- The official archive API also attempts to archive spawned descendants. Automatic
  management therefore supports only leaves without recorded Native child creation.
  Before archiving, it pages this conversation's official item history for successful
  spawn/child-start evidence and performs scoped, one-item descendant queries under
  the writer. A container stays registered and overdue for user review; it is never
  silently excluded or allowed to archive conversations outside its ownership.
  Active and archived list reads alone are insufficient: a child can be restored
  between them and disappear from both reads even while the parent's writer is held.
- A writer conflict or unavailable lifecycle preserves the original retention deadline.
  The same next-due timer schedules another maintenance review 12 hours later, without
  a second scheduler, rapid retries or catalog scanning. Only due registered records
  are examined; pending, uncertain archive mutations are never replayed automatically.
  Repeated failed hints do not postpone an already scheduled review. Service startup,
  profile connection changes and explicit reconciliation check overdue records immediately,
  bypassing the maintenance delay. An eligible record is archived in that same pass:


  ```sh
  chatgpt-tela reconcile-delegations --slot 1
  chatgpt-tela reconcile-delegations --all
  ```

  On macOS, the existing menu lifecycle paths also reconcile on official Desktop exit
  and system wake. They use the registry's installation/profile scope, not unavailable
  Desktop PIDs. Concurrent hints are coalesced. The service does not depend on menu
  availability for its timer. No plugin hook, hook approval, new model turn or forced
  owner release is involved. Exact arbitrary per-thread unload observation remains
  unverified; a released chat can therefore wait until the next maintenance review.

  Plugin maintenance is separate: installation, repair and Sparkle completion reuse
  one operation to update the owned source and an already installed, enabled local
  plugin through the official CLI. Missing/disabled plugins and user edits are preserved.
  Settings reads plugin metadata on demand; it does not claim tool or retention readiness.

- An archive request has a durable pending intent followed by a confirmed archive
  timestamp. A crash or ambiguous failure between them reports `archive_unconfirmed`
  and never automatically repeats the mutation. Check the chat in ChatGPT and use
  **Stop tracking…** to clear that review entry. This only ends Tela's automatic tracking.
  Confirmed or released entries require explicit re-enrollment.
- Work shows **Cleanup needs review** only when registered chats are overdue. **Review…**
  lists their profile, saved title/ID and reason. **Check again** invokes the same lifecycle
  reconciliation; it never starts a turn or silently approves recursive archive.
  A read-only authenticated service snapshot does not depend on the maintenance writer queue.
  Running work, unavailable ownership, changed profile identity, affected descendants and
  ambiguous archive results remain visible. The deadline is not a guarantee that an offline
  or permanently inaccessible official app can perform an archive. Exact per-thread stopping
  through the app-owned engine and an affected-chat approval flow remain incomplete; do not
  substitute whole-profile interruption or claim they are implemented.
  If automatic reconciliation cannot save a deferral, the existing timer waits for the
  next 12-hour review. **Check again** still checks immediately.
- Archived or released tracking metadata expires after 60 days on startup, reconciliation
  or the next metadata write. Registration and acknowledgement
  metadata uses total-byte limits without file-count limits. Existing unresolved
  records are preserved when new registration would exceed the storage budget.
  Acknowledgement receipts retain their existing 60-day/4-MiB age/byte policy.

Native context and local service authentication are not cryptographic attestation of
which model read an answer. Profile changes invalidate the old ownership scope.
Native child creation, explicit Tela enrollment, result confirmation, archive intent
and archive success remain separate facts.

## Verified boundary and remaining work

Installed-engine isolated tests established that a separate writer cannot archive,
delete or resume a thread held by another owner, including an idle loaded thread.
After release, resume/read/archive succeeded without a model request. Resuming an
already archived thread was rejected without changing its archived state. These are
installed CLI/app-server observations, not universal guarantees across versions or
consumer Desktop acceptance. An isolated product-source run also left a Native
container untouched, archived a selected leaf, and left that leaf active after manual restore
and reconciliation. Its clock was advanced in the fixture; no real profile was changed.

Automatic 30-day deletion is disabled. The [official App Server delete contract](https://learn.chatgpt.com/docs/app-server#delete-a-thread)
allows deleting both active and archived chats and cascades to spawned descendants.
Both installed profiles' 0.171.0-alpha.13 schemas, including experimental methods,
expose only `threadId` for deletion. An isolated 0.169.0-alpha.11.1 trial deleted a
chat after restoring it to the active list. The official Desktop UI offers manual
deletion from Archived chats.

Enable automatic deletion only when the engine can atomically verify that the exact
archive instance is unchanged, is at least 30 days old, and the operation has no
out-of-scope descendants. A separate read, restore notification, or writer lock
does not make the unconditional endpoint safe.

Full manual archive/restore observation before the first managed archive is still
unverified. An archive-and-restore occurring entirely between observations may
go undetected.

Existing profile data and user-created conversations have not been enrolled or changed.

MCP initialization instructions direct ChatGPT Native-model work to the host's
Native work tools. Ordinary Chat and Web-backed Work/Codex use Tela Chat or
DevSpace. The local, remote and development MCP surfaces share this guidance;
it does not depend on a project instruction file. This is not server enforcement:
the current MCP contract supplies no verified active-model identity.

Codex host policy is separate from ChatGPT account plugin settings. Its supported
per-plugin MCP and per-app controls are a possible enforcement boundary without
model self-report. Before applying them, identify every actual local/cloud tool
source and verify that ordinary Chat and the separate Web worker remain usable.
Disabling a local MCP server alone does not suppress account-connected app tools;
do not uninstall or disable an account plugin to approximate this separation.

A bounded Desktop trial applied those host controls to the exact connected app
IDs and local plugin server. A fresh Native chat reported no DevSpace or local
Tela work-tool guidance; a separate Web turn still performed the requested local
file read. An obsolete plugin skill was excluded through plugin activation policy,
and a fresh official skills listing no longer returned it. These observations
validate that local setup, not universal enforcement: the Native visibility
observation is a model report, and existing chat context can retain old tool names.

This host policy is currently local configuration, not an automatic consumer
installation feature. It filters the host, not an individual selected model;
Web tool access in the trial used its separate ChatGPT connection. Ordinary
Chat with a device-local plugin has not been accepted under this policy.
A consumer integration must resolve the installed sources through supported
host metadata and preserve independent Chat/Web connections; do not ship
personal app IDs or infer a model's identity from its own claims. The current
product config does not record ownership of arbitrary account app identities,
so provider registration must not automatically disable third-party apps.

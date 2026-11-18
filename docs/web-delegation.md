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
The service verifies the exact configured profile, canonical parent/child lineage and
first turn before enrollment. Ordinary chats and later Native-to-Web switches do not
enroll. Replayed responses do not dispatch another notification; observations never
reactivate retained archive records. A registration failure emits correlated diagnostics
without blocking the answer or shutdown readiness. No catalog scan, hook installation,
model request, retry worker or second registry is added.

An isolated installed-engine trial confirmed parent identity in the child request and
successfully enrolled it through the actual read-only history client before returning
its first synthetic answer. This used no external model call or consumer profile.
It proves that boundary, not consumer Desktop installation or timed archival.

This path depends on the host supplying parent identity with its first Web request and
making that first turn readable. Missing evidence is not replaced with title matching
or adoption of older chats. Registration success is durable only after the service has
saved the record; dispatch alone is not success. Explicit enrollment remains available:

Use the Native coordinator's existing command tool after creating a selected child:

```sh
chatgpt-tela retain-delegation --thread CHILD --slot 1
```

This explicitly enrolls that child. It checks the public
`source.subAgent.thread_spawn.parent_thread_id` against the coordinator's Native
`CODEX_THREAD_ID` and scopes the record to this installation and exact configured
profile/history home. A title, Web model, old journal, ordinary user chat, app save,
or hook event alone never enrolls a conversation. Native `spawn_agent` does not
implicitly call this command. A new child's first Web turn uses the observation path
above; other deliberately selected children require this explicit command.
No AGENTS.md rule or additional model request is needed for the operation itself.

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

- With a matching acknowledgement of the newest terminal turn, archive 12 hours after
  the later of that acknowledgement and official turn completion.
- Without one, use 7 days from official turn completion. A new turn invalidates an old
  acknowledgement. Metadata reads do not move either clock; unknown terminal times
  do not fall back to a fabricated activity timestamp.
- The service keeps one next-due timer and reconciles enrolled records at startup.
  It never scans the conversation catalog, adds a daemon, starts a model turn,
  interrupts work or forces an owner to release a conversation.
- At the mutation boundary, an exact-thread lifecycle client acquires the official
  writer through `thread/resume` with `excludeTurns:true`, checks lineage and the
  latest terminal turn under that ownership, then calls `thread/archive` on the same
  connection. No provider/config/history overrides, unarchive or delete are exposed.
  The separate stored-history reader remains read-only.
- The official archive API also attempts to archive spawned descendants. Automatic
  management therefore supports only leaves without recorded Native child creation.
  Before archiving, it pages this conversation's official item history for successful
  spawn/child-start evidence and performs scoped, one-item descendant queries under
  the writer. A container is excluded from management, not retried on every startup;
  its conversation and independent acknowledgement receipt remain unchanged.
  Active and archived list reads alone are insufficient: a child can be restored
  between them and disappear from both reads even while the parent's writer is held.
- A writer conflict or unavailable lifecycle defers the record without a retry loop.
  It is reconsidered at service startup or explicit reconciliation, not by polling:

  ```sh
  chatgpt-tela reconcile-delegations --slot 1
  ```

  On macOS, the menu's existing Desktop lifecycle observer reconciles enrolled
  records when an official Desktop app actually terminates. App-owned profiles omit
  Desktop PIDs, so this wakeup uses the registry's installation/profile scope rather
  than an unavailable PID-to-profile mapping. Concurrent exit hints are coalesced;
  a new hint during a pass schedules another pass, without polling or starting services.

  The installed local plugin also offers an asynchronous `PostToolUse` command hook
  for `close_agent`. Once installed, enabled and explicitly trusted in the host's
  **Settings > Hooks**, it invokes the same reconciliation after a child-close tool
  result, including while Desktop stays open. It adds no MCP tool or model context;
  unavailable Tela is a no-op for Native work. A disabled plugin or untrusted hook
  does not supply this event. Packaging or registration does not grant hook trust.
  Normal installation, repair and Sparkle completion reuse one refresh operation: update
  the owned generated source, then use the official CLI to upgrade an already installed,
  enabled plugin identified by its exact local source. Missing/disabled plugins and edited
  sources/marketplace entries stay untouched. This never writes host hook trust or changes
  per-plugin MCP overrides. Optional refresh failure is diagnosed without failing the app update.
  Settings reads official plugin and hook/config metadata on demand, without model requests
  or polling. Only an exact enabled, trusted hook is shown ready; unknown is not ready.
  Configuration applies to new chats; existing-chat reload is not asserted. macOS isolated
  CLI acceptance covers cache upgrade and disabled/MCP-override preservation; Windows/Linux
  host execution and consumer hook approval remain unverified.
  The explicit all-profile equivalent is `chatgpt-tela reconcile-delegations --all`.

  Both events are maintenance hints. They never enroll an ordinary chat, acknowledge
  a result, interrupt work or authorize deletion. The service still acquires the
  canonical writer and checks the due time. Arbitrary per-thread unloading outside
  supported close hooks remains without a verified Desktop event subscription; a
  late owner release can still defer until another event or explicit reconciliation.
- An archive request has a durable pending intent followed by a confirmed archive
  timestamp. A crash or ambiguous failure between them reports `archive_unconfirmed`
  and never automatically repeats the mutation. Confirmed records are never
  re-archived after manual restore; re-enrollment must be explicit.
- Archived metadata expires after 60 days on startup; registration/acknowledgement
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
consumer Desktop acceptance. An isolated product-source run also excluded a Native
container, archived a selected leaf, and left that leaf active after manual restore
and reconciliation. Its clock was advanced in the fixture; no real profile was changed.

A current installed-engine isolated trial loaded the generated plugin through the
public marketplace CLI, observed its asynchronous close hook, then used the product
hook handler, authenticated service HTTP route and lifecycle reader to archive an
enrolled leaf while its parent process remained open. Only the fixture's retention
clock advanced; no external model request or consumer profile change occurred.
This does not prove consumer Desktop hook installation/trust or every unload path.

Deletion needs an additional restore-aware serialized contract: the installed engine
accepted `thread/delete` after `thread/unarchive`. A current 0.169.0-alpha.11.1 isolated
trial again confirmed that the restored chat was in the active list and was still
deleted by that call; the generated delete schema accepts only `threadId`, with no
archived-state or archive-generation precondition. Writer exclusion alone therefore
cannot enforce “delete only the still-archived generation.” Automatic 30-day deletion
is not enabled. Do not approximate it with a separate read followed by unconditional
delete. Full manual archive/restore observation before the first managed archive is
also not established; an archive-and-restore occurring entirely between observations
must not be claimed as detected. Consumer acceptance must resolve that boundary.

Official [hooks](https://learn.chatgpt.com/docs/hooks) supplied exact session/child
identities in isolated trials, but are not installed by this change. `SessionEnd` is
not an archive receipt and `wait_agent` is not an exact-result acknowledgement.
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

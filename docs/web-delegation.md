# Web tasks

Tela supplies Web responses to the official Desktop app. The app owns Native task
execution and conversation identity. The retired external engine, managed-job CLI
and proxy are removed; do not recreate them or change the official provider identity.

## Delegated-chat retention

The source implementation connects explicit registration and result acknowledgement
to the existing Tela Codex service's automatic archive path. It is not installed or
accepted against consumer Desktop profiles yet. Automatic deletion remains disabled.

Use the Native coordinator's existing command tool after creating a selected child:

```sh
chatgpt-tela retain-delegation --thread CHILD --slot 1
```

This explicitly enrolls that child. It checks the public
`source.subAgent.thread_spawn.parent_thread_id` against the coordinator's Native
`CODEX_THREAD_ID` and scopes the record to this installation and exact configured
profile/history home. A title, Web model, old journal, ordinary user chat, app save,
or hook event alone never enrolls a conversation. Native `spawn_agent` does not
implicitly call this command; the creation workflow must invoke it deliberately.
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
- A writer conflict or unavailable lifecycle defers the record without a retry loop.
  It is reconsidered at service startup or explicit reconciliation, not by polling:

  ```sh
  chatgpt-tela reconcile-delegations --slot 1
  ```

  There is not yet a verified owner-release event connection guaranteeing immediate
  progress after that deferral. A due time does not justify interrupting live work.
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
consumer Desktop acceptance.

Deletion needs an additional restore-aware serialized contract: the installed engine
accepted `thread/delete` after `thread/unarchive`. Writer exclusion alone therefore
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

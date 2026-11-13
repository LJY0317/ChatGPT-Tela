# Web tasks

Tela supplies Web model responses to the official desktop app. The app owns
Native task execution, conversation identity, and its conversation lifecycle.

The former source-only `web-delegate` CLI, managed-job capacity API and automatic
archive/delete worker have been removed. They depended on an external Native
terminal that the app-owned architecture does not expose. No replacement
scheduler or private desktop connection is installed.

Official app-server APIs can inspect stored conversations and archive them through
`thread/archive`. An explicitly selected, settled conversation can therefore be
archived without a model call or restoring the retired engine. This is manual
conversation management, not automatic retention. A separate inspection process's
`notLoaded` status does not prove that the Desktop has no active work.

Automatic retention needs a maintained creation record tying a Tela-created task
to its exact host/profile and conversation, plus current activity and result
settlement from that task's owner. A title, selected Web model, incoming Responses
thread ID, or obsolete job journal alone does not establish that ownership. Ordinary
user-created Web conversations must remain outside automatic management. Preserve
result collection and manual archive/restore decisions separately from task
execution; do not fabricate collection or archive timestamps from other activity.

### Automatic retention: requested, not implemented

Removing the old worker did not fulfill the automatic-cleanup requirement. The
replacement must integrate with the current task owner rather than revive the
external engine. Ordinary user conversations remain unmanaged.

- Register exact host/profile/conversation identity from the creation receipt of a
  Tela-created task. An explicit user selection may enroll an existing conversation;
  title matching, Web-model use and historical journals may not enroll it.
- Keep creation, actual task activity, coordinator acknowledgement and archive
  confirmation distinct. Archive settled work 12 hours after the later of its exact
  result acknowledgement and last actual task activity. Without acknowledgement,
  keep the 7-day policy from the latest actual task activity. Status queries and
  diagnostic reads do not restart either clock. Active work remains ineligible.
- An acknowledgement binds the enrolled parent, child and exact terminal turn/result;
  an older result's acknowledgement cannot cover a newer turn. Record it explicitly
  after the coordinator receives the result, not from an app save, wakeup, child stop
  or natural-language claim. Keep identifiers and acknowledgement time rather than a
  second answer copy. Acknowledging a failure does not resolve the original request.
  No additional model request is needed; the acknowledgement can accompany the
  coordinator's next existing management operation. An absent receipt keeps 7 days.
- Delete eligible managed work 30 days after confirmed archiving, preserving the
  unresolved request/result record until its existing retention requirements are met.
  Missing archive timestamps must not be replaced with conversation update times.
- A manual restore removes that conversation from automatic management until the user
  explicitly enrolls it again. Recheck exact ownership and activity at the mutation
  boundary; active work, approval waits and unsettled operations are ineligible even
  after a deadline. Cancel obsolete deadlines on new work, restore or removal.
- Reuse the existing service lifecycle with one next-due wakeup and startup reconciliation
  of enrolled records. Do not scan every conversation periodically or introduce another
  engine, daemon, model call or retry chain. Remove expired management receipts under
  age/total-byte retention rather than keeping a permanent second conversation catalog.

The current provider ingress exposes response-operation correlation and delivery,
not task creation, Desktop-wide activity or coordinator result collection. A separate
stored-history reader cannot supply those missing live-owner facts. Do not widen
that read-only transport into a background archive/delete client.

Official [hooks](https://learn.chatgpt.com/docs/hooks) are a candidate event boundary:
`SubagentStart` supplies parent session, child turn and agent identity, while prompt/stop
events expose turn lifecycle. They do not by themselves prove Tela ownership or
that the coordinator collected a result; `SessionEnd` is not an archive receipt.
First verify those events in the installed Desktop and connect them to exact
creation/collection receipts. No consumer hook registration or retention scheduler
is installed yet. Existing conversations and private request/result journals are
preserved; manual conversation controls remain available. Web responses and tools
on the current provider route are independent of this missing automation.

Isolated CLI and app-server trials both emitted session, prompt and stop hooks
with exact conversation/turn identities against a local fixed-response fixture.
The earlier app-server miss was a probe error: rewriting `config.toml` discarded
its hook approvals. The official TUI records reviewed definition hashes through
[`config/batchWrite`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/hooks_rpc.rs).
Preserve those settings; Tela's existing route registration/removal already does.
This verifies event transport, not automatic collection or consumer Desktop
installation. Use supported host authorization, retain exact creation/collection
receipts and serialize mutations with the actual task owner before enabling cleanup.
Do not copy private trust storage or silently approve unrelated hooks.

An isolated official-engine spawn/wait trial also correlated `SubagentStart.agent_id`
with the child's public `source.subAgent.thread_spawn` lineage. The spawn tool's task
path matched `agent_path`; no title or event-order inference was needed. This proves
Native child creation, not automatic Tela enrollment. In that installed interface,
`wait_agent` returned only `{message: "Wait completed.", timed_out: false}`.
Its post-tool hook contained neither a child ID nor a final answer. A wakeup must not
be called a result-collection receipt. The chosen policy requires an explicit
coordinator acknowledgement for the shorter 12-hour period; a final answer saved by
the official app alone retains the 7-day period. This is confirmation of receipt,
not proof that the model understood the result. No consumer acknowledgement operation
or scheduler is connected yet; these periods describe the requested replacement.

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

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

The former 24-hour collected-result, 7-day uncollected-result and 30-day archived
delete policy is not currently scheduled. Restoring it requires the lifecycle
inputs above; do not restore the old external engine, scan titles to adopt chats,
or treat successful manual archiving as acceptance of automatic cleanup.
Existing conversations and private request/result journals are preserved. Use the
app's conversation controls to manage them. Web responses and tools on the current
provider route remain independent of this removed management layer.

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

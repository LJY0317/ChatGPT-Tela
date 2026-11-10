# Web tasks

Tela supplies Web model responses to the official desktop app. The app owns
Native task execution, conversation identity, and its conversation lifecycle.

The former source-only `web-delegate` CLI, managed-job capacity API and automatic
archive/delete worker have been removed. They depended on an external Native
terminal that the app-owned architecture does not expose. No replacement
scheduler or private desktop connection is installed. Automatic delegation and
conversation cleanup require a supported host contract before they can return.

Existing conversations and private request/result journals are not deleted or
automatically adopted. Use the app's conversation controls to manage them.
Web responses and tools on the current provider route remain independent of
this removed management layer.

MCP initialization instructions direct ChatGPT Native-model work to the host's
Native work tools. Ordinary Chat and Web-backed Work/Codex use Tela Chat or
DevSpace. The local, remote and development MCP surfaces share this guidance;
it does not depend on a project instruction file. This is not server enforcement:
the current MCP contract supplies no verified active-model identity. Global
plugin disablement would also disable intended Chat/Web access.

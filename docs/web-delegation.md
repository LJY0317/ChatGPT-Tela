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

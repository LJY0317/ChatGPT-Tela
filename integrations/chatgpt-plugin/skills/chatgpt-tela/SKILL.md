---
name: chatgpt-tela
description: Use the user's connected ChatGPT Tela runtime when a request needs local project/workspace work, or when an active Work/Codex task should continue through ChatGPT Web with that exact Native turn's current tools. Do not invoke Tela for ordinary conversation or knowledge work that needs neither local workspace access nor active Codex-turn delegation.
---

# ChatGPT Tela

ChatGPT Tela is one user-facing integration backed by two independent services. **Tela Chat** operates on
locally approved workspaces. **Tela Codex** bridges ChatGPT Web to one exact active Native Codex turn. Choose
the path whose authority matches the task; do not silently transfer authority from one backend to the other.
If one backend is unavailable, the other may still be usable.

## Ordinary Chat and local project work

Use Tela Chat when the request needs the user's local project files, Git state, commands, worktrees, reviews,
incidents, or optional workspace agents.

1. Discover the current Tela Chat capability inventory when the exact capability or schema is not already
   known.
2. Open the relevant approved workspace once and reuse its returned `workspace_id` for continued work in that
   workspace.
3. Use bounded multi-read only for already-known independent files. When one result determines what to inspect
   next, read sequentially instead of prefetching unrelated paths.
4. For a command that may mutate state or outlive one response, provide an `operation_id` when the current
   schema supports it. If the response is uncertain, inspect `process_status` with that operation id before
   starting the command again.
5. Treat tool results as evidence. After a deterministic failure, change the inputs, hypothesis, or observable
   state before retrying the same action.
6. After related edits, use the available change-review capability when it helps verify the final workspace
   state.
7. Routine work should use direct workspace capabilities. Delegate to a Tela Chat agent only when separate
   context, specialization, parallel investigation, or a follow-up with the same worker materially helps.

## Work/Codex and ChatGPT Web delegation

Use Tela Codex only when the current task must act through the **exact active Native Codex turn**. Native Codex
remains authoritative for task/turn identity, workspace, sandbox, approvals, and the tools available in that
turn.

1. Use only the opaque `turn_capability` supplied by the active task transport. Never ask the user to invent
   one, reuse one from another turn, transform it, or treat it as task content.
2. Discover the current Native tool inventory before invoking a tool whose exact name or schema is not already
   known. Tool availability is turn-scoped and may change.
3. Invoke only tools returned for that same turn capability and pass arguments matching the returned schema.
4. Use Native tools when the active request needs a local effect or fresh local evidence. If the supplied task
   context already contains sufficient evidence, answer without an unnecessary tool call.
5. An actual tool result or platform error is required before claiming that a local action succeeded, failed,
   was denied, or was blocked.
6. Continue from the current task state after context rollover or a fresh ChatGPT Web conversation; do not
   repeat completed work merely because the physical Web conversation changed.

Do not expose Tela routing tokens, transport wrappers, or internal capability-selection details in the
user-facing answer unless the user explicitly asks how the integration works.

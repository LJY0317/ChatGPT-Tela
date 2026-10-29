# Chat capability discovery

Tela Chat publishes only capabilities available in its current runtime. Each catalog entry keeps its
existing name, description and input schema, and adds optional `semantics` version 1. Older inventories
without this field remain readable. The public connector functions and fingerprint are unchanged.

The descriptor records effect, resource scope, replay policy, verification route, the owning
sandbox declaration, automatic retry policy or proof of Work/Codex parity. The service still checks
workspace, resource identity and ownership for each invocation. Unknown descriptor versions or invalid
values are rejected rather than interpreted as permission; unknown fields are discarded.

| Replay policy | Required behavior |
| --- | --- |
| `observe_again` | A new observation may differ; it does not replay a mutation. |
| `inspect_before_repeat` | Inspect the affected resource/result before deciding whether a new action is needed. An uncertain accepted action must not be blindly repeated. |
| `same_operation_id` | For `exec_command`, supply and retain `operation_id` before the first call. Reconcile with `process_status` after delivery loss. Omitting the ID generates a fresh operation and cannot deduplicate a later request. |

Shell commands use the user's local execution permissions: workspace scope selects an approved cwd,
not a filesystem or network sandbox. Commands, nonempty process input and agents therefore advertise
`arbitrary_execution`. A command exit is not proof the requested task succeeded; validate its effects.
`write_stdin` may consume output even when input is empty. Prefer `process_status` for reconciliation.
`show_changes` creates review state and may advance a baseline, so it also requires inspection before
repetition. Agent write scope must be selected and enforced independently of this conservative maximum
effect classification. Missing agent capabilities in discovery mean no provider is currently exposed;
an agent contract in source does not prove an installed provider is available.

Verification labels identify the kind of evidence to collect, not a finished acceptance check:
workspace diffs/content, exact process status, review checkpoint, owned worktree status, agent status,
bounded read result or user confirmation. For non-Git imported files, inspect bytes/digest rather than
assuming a Git diff exists. Keep unavailable, advertised, source-tested, installed and model-verified
states separate. Native capabilities require the exact active turn's independent discovery/authority.

Source tests cover completeness, runtime availability filtering, legacy compatibility, descriptor
validation and delivery through the Chat service/protocol/Gateway. They do not establish real-model
success, cost superiority, or Native recovery. Result-schema metadata, task-scoped broker policies,
logical checkpoint persistence and matched end-to-end parity measurement remain separate work.

Metadata adds inventory bytes, not a model inference or execution call. Query only the capabilities
needed for the current action using the existing catalog filter. The source fixture's 31-entry
catalog adds 5,578 UTF-8 bytes; its single `exec_command` query is 743 bytes including the input
schema. Regression ceilings are 6 KiB of full-catalog metadata and 1 KiB for that query. These are
local serialized-byte budgets, not provider-billed tokens, measured model savings or parity proof.

`open_workspace` returns an `instructionRevision` for its global and project-root instruction set.
Supply it as `known_instruction_revision` only when that exact prior set remains in the caller's context.
A matching workspace-scoped revision returns `instructionsUnchanged: true` and an empty `instructions`
array; this means reuse the retained set, not that no instructions apply. New chats or lost context omit
the argument to receive full bodies. Changed sources return a new revision and the full current set,
which supersedes the old set. Nested files remain explicit reads advertised by `availableInstructionFiles`;
this revision does not attest their contents. No server-side delivery history, cache or model call is added.

import type { ChatCapabilitySemantics } from "@chatgpt-tela/service-protocol";
import type { TelaChatCapability } from "./tools";

function descriptor(effect: ChatCapabilitySemantics["effect"], scope: ChatCapabilitySemantics["scope"],
  replay: ChatCapabilitySemantics["replay"], verification: ChatCapabilitySemantics["verification"]): ChatCapabilitySemantics {
  return Object.freeze({ version: 1, authority: "chat_service", effect, scope, replay, verification, maturity: "implemented" });
}
const read = descriptor("read", "workspace", "observe_again", "bounded_result");
const agentRead = descriptor("read", "owned_agent", "observe_again", "agent_status");
const agentRun = descriptor("arbitrary_execution", "owned_agent", "inspect_before_repeat", "agent_status");

/** Exhaustive Tela-owned mapping; no external tool names or model identities. */
export const CHAT_CAPABILITY_SEMANTICS: Readonly<Record<TelaChatCapability, ChatCapabilitySemantics>> = Object.freeze({
  inspect_native_work: descriptor("read", "service", "observe_again", "bounded_result"),
  inspect_native_evidence: descriptor("read", "service", "observe_again", "bounded_result"),
  open_workspace: descriptor("service_state", "approved_root", "inspect_before_repeat", "bounded_result"),
  export_file: descriptor("service_state", "workspace", "inspect_before_repeat", "bounded_result"),
  open_file_import: descriptor("service_state", "workspace", "inspect_before_repeat", "user_confirmation"),
  import_file: descriptor("workspace_write", "workspace", "inspect_before_repeat", "workspace_diff"),
  list_directory: read, search_text: read, search_files: read, list_skills: read, read_skill: read, read: read, view_image: read, read_many: read,
  apply_patch: descriptor("workspace_write", "workspace", "inspect_before_repeat", "workspace_diff"),
  // A workspace selects cwd, not a sandbox for arbitrary shell effects.
  exec_command: descriptor("arbitrary_execution", "workspace", "same_operation_id", "process_status"),
  // Even empty-input collection consumes output; nonempty chars can affect a process.
  write_stdin: descriptor("arbitrary_execution", "owned_process", "inspect_before_repeat", "process_status"),
  list_processes: descriptor("read", "workspace", "observe_again", "bounded_result"),
  cancel_process: descriptor("arbitrary_execution", "owned_process", "inspect_before_repeat", "process_status"),
  process_status: descriptor("read", "owned_process", "observe_again", "process_status"),
  show_changes: descriptor("service_state", "workspace", "inspect_before_repeat", "review_checkpoint"),
  show_review: read, list_reviews: read, list_incidents: read, show_incident: read,
  create_worktree: descriptor("workspace_write", "workspace", "inspect_before_repeat", "worktree_status"),
  inspect_worktree: descriptor("read", "owned_worktree", "observe_again", "worktree_status"),
  remove_worktree: descriptor("resource_removal", "owned_worktree", "inspect_before_repeat", "worktree_status"),
  list_worktrees: descriptor("read", "service", "observe_again", "bounded_result"),
  list_agent_targets: descriptor("read", "service", "observe_again", "bounded_result"),
  start_agent: agentRun, continue_agent: agentRun, get_agent: agentRead, list_agents: agentRead, wait_agents: agentRead,
  stop_agent: descriptor("service_state", "owned_agent", "inspect_before_repeat", "agent_status"),
});

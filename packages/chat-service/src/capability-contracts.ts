import type { TelaChatCapability } from "./tools";

export interface ChatCapabilityContract {
  readonly capability: TelaChatCapability;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

const string = (maxLength: number) => Object.freeze({ type: "string", minLength: 1, maxLength });
const integer = (minimum: number, maximum?: number) => Object.freeze({
  type: "integer",
  minimum,
  ...(maximum === undefined ? {} : { maximum }),
});
const object = (
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
) => Object.freeze({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

const workspaceId = string(512);
const path = string(16_384);
const operationId = Object.freeze({ type: "string", format: "uuid" });
const agentId = string(512);

export const TELA_CHAT_CAPABILITY_CONTRACTS: readonly ChatCapabilityContract[] = Object.freeze([
  {
    capability: "open_workspace",
    description: "Open one locally approved workspace root. The workspace remains user-owned.",
    inputSchema: object({ path }, ["path"]),
  },
  {
    capability: "read",
    description: "Read a bounded line range from one file inside an opened Tela Chat workspace.",
    inputSchema: object({ workspace_id: workspaceId, path, offset: integer(1), limit: integer(1, 400) }, ["workspace_id", "path"]),
  },
  {
    capability: "read_many",
    description: "Read bounded ranges from multiple files in one opened Tela Chat workspace.",
    inputSchema: object({
      workspace_id: workspaceId,
      reads: Object.freeze({
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: object({ path, offset: integer(1), limit: integer(1, 400) }, ["path"]),
      }),
    }, ["workspace_id", "reads"]),
  },
  {
    capability: "apply_patch",
    description: "Apply one transactional Tela patch inside an opened workspace with path-escape protection.",
    inputSchema: object({ workspace_id: workspaceId, patch: string(2 * 1024 * 1024) }, ["workspace_id", "patch"]),
  },
  {
    capability: "exec_command",
    description: "Start one resumable command inside an opened workspace. operation_id makes retries idempotent.",
    inputSchema: object({
      workspace_id: workspaceId,
      cmd: string(64 * 1024),
      working_directory: path,
      operation_id: operationId,
      yield_time_ms: integer(0, 12_000),
    }, ["workspace_id", "cmd"]),
  },
  {
    capability: "write_stdin",
    description: "Write to or collect incremental output from one live Tela Chat process session.",
    inputSchema: object({
      workspace_id: workspaceId,
      session_id: integer(1),
      chars: Object.freeze({ type: "string", maxLength: 64 * 1024 }),
      yield_time_ms: integer(0, 12_000),
    }, ["workspace_id", "session_id"]),
  },
  {
    capability: "process_status",
    description: "Inspect one durable Tela Chat process operation without re-running it.",
    inputSchema: object({ workspace_id: workspaceId, operation_id: operationId }, ["workspace_id", "operation_id"]),
  },
  {
    capability: "show_changes",
    description: "Show current Git-backed changes and create a bounded historical review checkpoint when possible.",
    inputSchema: object({ workspace_id: workspaceId }, ["workspace_id"]),
  },
  {
    capability: "show_review",
    description: "Open one immutable bounded Tela Chat review checkpoint by review_ref.",
    inputSchema: object({ workspace_id: workspaceId, review_ref: string(512) }, ["workspace_id", "review_ref"]),
  },
  {
    capability: "list_reviews",
    description: "List bounded historical review checkpoints for one opened Tela Chat workspace.",
    inputSchema: object({ workspace_id: workspaceId }, ["workspace_id"]),
  },
  {
    capability: "list_incidents",
    description: "List bounded privacy-safe failure metadata for one opened Tela Chat workspace.",
    inputSchema: object({ workspace_id: workspaceId, limit: integer(1, 100) }, ["workspace_id"]),
  },
  {
    capability: "show_incident",
    description: "Open one privacy-safe Tela Chat incident record without raw command/path/prompt/output payloads.",
    inputSchema: object({ workspace_id: workspaceId, incident_ref: string(512) }, ["workspace_id", "incident_ref"]),
  },
  {
    capability: "create_worktree",
    description: "Create a Tela-owned detached Git worktree under Tela state from an opened source workspace.",
    inputSchema: object({ source_workspace_id: workspaceId, base_ref: string(1024) }, ["source_workspace_id"]),
  },
  {
    capability: "inspect_worktree",
    description: "Inspect exact ownership, cleanliness, and removability of one Tela-managed worktree.",
    inputSchema: object({ worktree_id: string(512) }, ["worktree_id"]),
  },
  {
    capability: "remove_worktree",
    description: "Remove one managed worktree only when Tela can re-prove exact ownership and safe clean state.",
    inputSchema: object({ worktree_id: string(512) }, ["worktree_id"]),
  },
  {
    capability: "list_worktrees",
    description: "List Tela-managed worktree ownership records.",
    inputSchema: object({}),
  },
  {
    capability: "list_agent_targets",
    description: "List agent providers currently available inside the independent Tela Chat runtime.",
    inputSchema: object({}),
  },
  {
    capability: "start_agent",
    description: "Start one durable agent turn scoped to an opened workspace and explicit read/write mode.",
    inputSchema: object({
      workspace_id: workspaceId,
      target: string(256),
      prompt: string(256 * 1024),
      write_mode: Object.freeze({ type: "string", enum: ["read_only", "workspace_write"] }),
    }, ["workspace_id", "target", "prompt"]),
  },
  {
    capability: "continue_agent",
    description: "Continue one proven durable agent session in the same opened workspace.",
    inputSchema: object({
      workspace_id: workspaceId,
      agent_id: agentId,
      prompt: string(256 * 1024),
      write_mode: Object.freeze({ type: "string", enum: ["read_only", "workspace_write"] }),
    }, ["workspace_id", "agent_id", "prompt"]),
  },
  {
    capability: "get_agent",
    description: "Inspect one durable Tela Chat agent without provider-internal prompt or tool-traffic details.",
    inputSchema: object({ workspace_id: workspaceId, agent_id: agentId }, ["workspace_id", "agent_id"]),
  },
  {
    capability: "list_agents",
    description: "List durable agent summaries for one opened Tela Chat workspace.",
    inputSchema: object({ workspace_id: workspaceId }, ["workspace_id"]),
  },
  {
    capability: "wait_agents",
    description: "Wait a bounded time for one or more Tela Chat agent turns and return their current observations.",
    inputSchema: object({
      workspace_id: workspaceId,
      agent_ids: Object.freeze({ type: "array", minItems: 1, maxItems: 32, items: agentId }),
      timeout_ms: integer(0, 12_000),
    }, ["workspace_id", "agent_ids"]),
  },
  {
    capability: "stop_agent",
    description: "Abort only the currently active turn for one workspace-scoped Tela Chat agent.",
    inputSchema: object({ workspace_id: workspaceId, agent_id: agentId }, ["workspace_id", "agent_id"]),
  },
]);

export function chatCapabilityCatalog(
  available: readonly TelaChatCapability[],
  query = "",
): readonly ChatCapabilityContract[] {
  const allowed = new Set(available);
  const needle = query.trim().toLowerCase();
  return Object.freeze(TELA_CHAT_CAPABILITY_CONTRACTS.filter(contract => {
    if (!allowed.has(contract.capability)) return false;
    if (!needle) return true;
    return contract.capability.toLowerCase().includes(needle)
      || contract.description.toLowerCase().includes(needle);
  }));
}

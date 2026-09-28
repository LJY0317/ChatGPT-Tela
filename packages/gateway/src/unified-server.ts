import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  registerTurnBridgeTools,
  type TurnBridgeBackend,
} from "@chatgpt-tela/mcp";

export const CHATGPT_TELA_UNIFIED_DEVELOPMENT_DISPLAY_NAME = "ChatGPT Tela";
export const CHATGPT_TELA_UNIFIED_DEVELOPMENT_MCP_SERVER_NAME = "chatgpt-tela-unified-development";
export const CHATGPT_TELA_UNIFIED_DEVELOPMENT_MCP_SERVER_VERSION = "0.0.0";
export const CHATGPT_TELA_UNIFIED_CODEX_INVENTORY = "tela_codex_tool_inventory";
export const CHATGPT_TELA_UNIFIED_CODEX_CALL = "tela_codex_tool_call";

export interface UnifiedChatBackend {
  call(capability: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown>;
}

interface ChatToolDefinition {
  readonly name: string;
  readonly capability: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
}

const workspaceId = z.string().min(1).max(512);
const path = z.string().min(1).max(16_384);
const yieldTime = z.number().int().min(0).max(12_000).optional();
const agentId = z.string().min(1).max(512);
const agentTarget = z.string().min(1).max(256);
const agentPrompt = z.string().min(1).max(256 * 1024);
const agentWriteMode = z.enum(["read_only", "workspace_write"]).optional();

export const UNIFIED_CHAT_TOOL_DEFINITIONS: readonly ChatToolDefinition[] = Object.freeze([
  {
    name: "tela_chat_open_workspace",
    capability: "open_workspace",
    title: "Open Tela Chat workspace",
    description: "Open one locally approved workspace root. The workspace remains user-owned.",
    inputSchema: z.object({ path }),
  },
  {
    name: "tela_chat_read",
    capability: "read",
    title: "Read workspace file",
    description: "Read a bounded line range from one file inside an opened Tela Chat workspace.",
    inputSchema: z.object({ workspace_id: workspaceId, path, offset: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(400).optional() }),
  },
  {
    name: "tela_chat_read_many",
    capability: "read_many",
    title: "Read workspace files",
    description: "Read bounded ranges from multiple files in one opened Tela Chat workspace.",
    inputSchema: z.object({
      workspace_id: workspaceId,
      reads: z.array(z.object({ path, offset: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(400).optional() })).min(1).max(20),
    }),
  },
  {
    name: "tela_chat_apply_patch",
    capability: "apply_patch",
    title: "Apply workspace patch",
    description: "Apply one transactional Tela patch inside an opened workspace with path-escape protection.",
    inputSchema: z.object({ workspace_id: workspaceId, patch: z.string().min(1).max(2 * 1024 * 1024) }),
  },
  {
    name: "tela_chat_exec_command",
    capability: "exec_command",
    title: "Run workspace command",
    description: "Start one resumable command inside an opened workspace. Supply operation_id to make retries idempotent.",
    inputSchema: z.object({ workspace_id: workspaceId, cmd: z.string().min(1).max(64 * 1024),
      working_directory: z.string().min(1).max(16_384).optional(), operation_id: z.string().uuid().optional(),
      yield_time_ms: yieldTime }),
  },
  {
    name: "tela_chat_write_stdin",
    capability: "write_stdin",
    title: "Continue workspace process",
    description: "Write to or collect incremental output from one live Tela Chat process session.",
    inputSchema: z.object({ workspace_id: workspaceId, session_id: z.number().int().min(1),
      chars: z.string().max(64 * 1024).optional(), yield_time_ms: yieldTime }),
  },
  {
    name: "tela_chat_process_status",
    capability: "process_status",
    title: "Inspect process operation",
    description: "Inspect one durable Tela Chat process operation without re-running it.",
    inputSchema: z.object({ workspace_id: workspaceId, operation_id: z.string().uuid() }),
  },
  {
    name: "tela_chat_show_changes",
    capability: "show_changes",
    title: "Show workspace changes",
    description: "Show current Git-backed changes and create a bounded historical review checkpoint when possible.",
    inputSchema: z.object({ workspace_id: workspaceId }),
  },
  {
    name: "tela_chat_show_review",
    capability: "show_review",
    title: "Open historical review",
    description: "Open one immutable bounded Tela Chat review checkpoint by review_ref.",
    inputSchema: z.object({ workspace_id: workspaceId, review_ref: z.string().min(1).max(512) }),
  },
  {
    name: "tela_chat_list_reviews",
    capability: "list_reviews",
    title: "List workspace reviews",
    description: "List bounded historical review checkpoints for one opened workspace.",
    inputSchema: z.object({ workspace_id: workspaceId }),
  },
  {
    name: "tela_chat_create_worktree",
    capability: "create_worktree",
    title: "Create managed worktree",
    description: "Create a Tela-owned detached Git worktree under Tela state from an opened source workspace.",
    inputSchema: z.object({ source_workspace_id: workspaceId, base_ref: z.string().min(1).max(1024).optional() }),
  },
  {
    name: "tela_chat_inspect_worktree",
    capability: "inspect_worktree",
    title: "Inspect managed worktree",
    description: "Inspect exact ownership, cleanliness, and removability of one Tela-managed worktree.",
    inputSchema: z.object({ worktree_id: z.string().min(1).max(512) }),
  },
  {
    name: "tela_chat_remove_worktree",
    capability: "remove_worktree",
    title: "Remove managed worktree",
    description: "Remove one managed worktree only when Tela can re-prove exact ownership and safe clean state.",
    inputSchema: z.object({ worktree_id: z.string().min(1).max(512) }),
  },
  {
    name: "tela_chat_list_worktrees",
    capability: "list_worktrees",
    title: "List managed worktrees",
    description: "List Tela-managed worktree ownership records.",
    inputSchema: z.object({}),
  },
  {
    name: "tela_chat_list_incidents",
    capability: "list_incidents",
    title: "List workspace incidents",
    description: "List bounded privacy-safe failure metadata for one opened Tela Chat workspace.",
    inputSchema: z.object({ workspace_id: workspaceId, limit: z.number().int().min(1).max(100).optional() }),
  },
  {
    name: "tela_chat_show_incident",
    capability: "show_incident",
    title: "Open workspace incident",
    description: "Open one privacy-safe Tela Chat incident record. Raw commands, paths, prompts, output, and error messages are never persisted in this record.",
    inputSchema: z.object({ workspace_id: workspaceId, incident_ref: z.string().min(1).max(512) }),
  },
  {
    name: "tela_chat_list_agent_targets",
    capability: "list_agent_targets",
    title: "List Tela Chat agent targets",
    description: "List agent providers currently available inside the independent Tela Chat runtime.",
    inputSchema: z.object({}),
  },
  {
    name: "tela_chat_start_agent",
    capability: "start_agent",
    title: "Start Tela Chat agent",
    description: "Start one durable agent turn scoped to an opened workspace and explicit read/write mode.",
    inputSchema: z.object({ workspace_id: workspaceId, target: agentTarget, prompt: agentPrompt,
      write_mode: agentWriteMode }),
  },
  {
    name: "tela_chat_continue_agent",
    capability: "continue_agent",
    title: "Continue Tela Chat agent",
    description: "Continue one proven durable agent session in the same opened workspace.",
    inputSchema: z.object({ workspace_id: workspaceId, agent_id: agentId, prompt: agentPrompt,
      write_mode: agentWriteMode }),
  },
  {
    name: "tela_chat_get_agent",
    capability: "get_agent",
    title: "Inspect Tela Chat agent",
    description: "Inspect one durable Tela Chat agent without exposing provider-internal prompts or tool traffic.",
    inputSchema: z.object({ workspace_id: workspaceId, agent_id: agentId }),
  },
  {
    name: "tela_chat_list_agents",
    capability: "list_agents",
    title: "List Tela Chat agents",
    description: "List durable agent summaries for one opened Tela Chat workspace.",
    inputSchema: z.object({ workspace_id: workspaceId }),
  },
  {
    name: "tela_chat_wait_agents",
    capability: "wait_agents",
    title: "Wait for Tela Chat agents",
    description: "Wait a bounded time for one or more Tela Chat agent turns and return their current observations.",
    inputSchema: z.object({ workspace_id: workspaceId, agent_ids: z.array(agentId).min(1).max(32),
      timeout_ms: z.number().int().min(0).max(12_000).optional() }),
  },
  {
    name: "tela_chat_stop_agent",
    capability: "stop_agent",
    title: "Stop Tela Chat agent turn",
    description: "Abort only the currently active turn for one workspace-scoped Tela Chat agent.",
    inputSchema: z.object({ workspace_id: workspaceId, agent_id: agentId }),
  },
]);

function jsonText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function createUnifiedDevelopmentMcpServer(input: {
  readonly chat: UnifiedChatBackend;
  readonly codex: TurnBridgeBackend;
}): McpServer {
  const server = new McpServer({
    name: CHATGPT_TELA_UNIFIED_DEVELOPMENT_MCP_SERVER_NAME,
    version: CHATGPT_TELA_UNIFIED_DEVELOPMENT_MCP_SERVER_VERSION,
  }, {
    capabilities: { tools: { listChanged: false } },
    instructions: "Development unified ChatGPT Tela MCP. Tela Chat tools operate on locally approved workspaces. Tela Codex control tools require an opaque capability for one exact active Native turn. Either backend may be unavailable independently.",
  });

  const registerChatTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: {
      readonly title: string;
      readonly description: string;
      readonly inputSchema: z.ZodTypeAny;
    },
    handler: (arguments_: Readonly<Record<string, unknown>>) => Promise<{
      readonly content: readonly { readonly type: "text"; readonly text: string }[];
      readonly isError?: boolean;
    }>,
  ) => void;

  for (const definition of UNIFIED_CHAT_TOOL_DEFINITIONS) {
    registerChatTool(definition.name, {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
    }, async arguments_ => {
      try {
        const result = await input.chat.call(definition.capability, arguments_ as Readonly<Record<string, unknown>>);
        return { content: [{ type: "text" as const, text: jsonText(result) }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    });
  }

  registerTurnBridgeTools(server, input.codex, {
    inventory: CHATGPT_TELA_UNIFIED_CODEX_INVENTORY,
    call: CHATGPT_TELA_UNIFIED_CODEX_CALL,
  }, {
    inventoryTitle: "Native Codex tool inventory",
    inventoryDescription: "List runtime-discovered Native Codex tools for one exact active Tela Codex turn.",
    callTitle: "Native Codex tool call",
    callDescription: "Invoke one runtime-discovered tool from the exact active Tela Codex turn inventory.",
  });

  return server;
}

import { join } from "node:path";
import { ChatAgentManager, type ChatAgentDriver, type ChatAgentWriteMode } from "./agents";
import { ChatChangeReviewer } from "./changes";
import { ChatFileTools } from "./files";
import { ChatIncidentStore } from "./incidents";
import { ChatPatchTool } from "./patch";
import { ChatProcessManager } from "./processes";
import { ChatReviewCheckpointStore } from "./reviews";
import { ChatWorkspaceRegistry } from "./workspaces";
import { ChatManagedWorktreeManager } from "./worktrees";

export interface ChatAgentWorkspaceTools {
  read(input: {
    readonly workspaceId: string;
    readonly path: string;
    readonly offset?: number;
    readonly limit?: number;
  }): unknown;
  readMany(input: {
    readonly workspaceId: string;
    readonly reads: readonly { readonly path: string; readonly offset?: number; readonly limit?: number }[];
  }): unknown;
  applyPatch(input: { readonly workspaceId: string; readonly patch: string }): unknown;
  showChanges(workspaceId: string): Promise<unknown>;
}

export type ChatAgentDriverFactory = (tools: ChatAgentWorkspaceTools) => ChatAgentDriver;

export const TELA_CHAT_BASE_CAPABILITIES = Object.freeze([
  "open_workspace",
  "read",
  "read_many",
  "apply_patch",
  "exec_command",
  "write_stdin",
  "process_status",
  "show_changes",
  "show_review",
  "list_reviews",
  "list_incidents",
  "show_incident",
] as const);

export const TELA_CHAT_MANAGED_WORKTREE_CAPABILITIES = Object.freeze([
  "create_worktree",
  "inspect_worktree",
  "remove_worktree",
  "list_worktrees",
] as const);

export const TELA_CHAT_AGENT_CAPABILITIES = Object.freeze([
  "list_agent_targets",
  "start_agent",
  "continue_agent",
  "get_agent",
  "list_agents",
  "wait_agents",
  "stop_agent",
] as const);

export const TELA_CHAT_CAPABILITIES = Object.freeze([
  ...TELA_CHAT_BASE_CAPABILITIES,
  ...TELA_CHAT_MANAGED_WORKTREE_CAPABILITIES,
  ...TELA_CHAT_AGENT_CAPABILITIES,
] as const);

export type TelaChatCapability = typeof TELA_CHAT_CAPABILITIES[number];

export interface ChatToolRuntime {
  readonly workspaces: ChatWorkspaceRegistry;
  readonly files: ChatFileTools;
  readonly patch: ChatPatchTool;
  readonly processes: ChatProcessManager;
  readonly changes: ChatChangeReviewer;
  readonly reviews: ChatReviewCheckpointStore;
  readonly incidents: ChatIncidentStore;
  readonly worktrees?: ChatManagedWorktreeManager;
  readonly agents?: ChatAgentManager;
  readonly capabilities: readonly TelaChatCapability[];
  initialize(): Promise<void>;
  call(capability: TelaChatCapability, arguments_: unknown): Promise<unknown>;
  close(): Promise<void>;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000\r\n]/.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function multilineText(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== "string" || !value || value.includes("\u0000")) throw new Error(`${field} is invalid`);
  if (Buffer.byteLength(value, "utf8") > maximumBytes) throw new Error(`${field} exceeds ${maximumBytes} bytes`);
  return value;
}

function optionalText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : text(value, field);
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw new Error(`${field} must be an integer`);
  return value as number;
}

function agentWriteMode(value: unknown): ChatAgentWriteMode | undefined {
  if (value === undefined) return undefined;
  if (value === "read_only" || value === "workspace_write") return value;
  throw new Error("write_mode must be read_only or workspace_write");
}

function capability(value: string, allowed: readonly TelaChatCapability[]): TelaChatCapability {
  if (!allowed.includes(value as TelaChatCapability)) throw new Error(`unknown or unavailable Tela Chat capability: ${value}`);
  return value as TelaChatCapability;
}

export function createChatToolRuntime(input: {
  readonly allowedRoots: readonly string[];
  readonly stateRoot: string;
  readonly agentDrivers?: readonly ChatAgentDriver[];
  readonly agentDriverFactories?: readonly ChatAgentDriverFactory[];
  readonly ownership?: {
    readonly installId: string;
    readonly productVersion: string;
    readonly manifestPath: string;
  };
}): ChatToolRuntime {
  const managedRoot = join(input.stateRoot, "managed-worktrees");
  const workspaces = new ChatWorkspaceRegistry({
    allowedRoots: input.allowedRoots,
    ...(input.ownership ? { managedRoots: [managedRoot] } : {}),
    storePath: join(input.stateRoot, "workspaces-v1.json"),
  });
  const files = new ChatFileTools(workspaces);
  const patch = new ChatPatchTool(workspaces);
  const processes = new ChatProcessManager({ workspaces, storePath: join(input.stateRoot, "process-operations-v1.json") });
  const reviews = new ChatReviewCheckpointStore({ root: join(input.stateRoot, "reviews") });
  const incidents = new ChatIncidentStore({ root: join(input.stateRoot, "incidents") });
  const changes = new ChatChangeReviewer(workspaces, reviews);
  const agentWorkspaceTools: ChatAgentWorkspaceTools = Object.freeze({
    read: (request: Parameters<ChatAgentWorkspaceTools["read"]>[0]) => files.read(request),
    readMany: (request: Parameters<ChatAgentWorkspaceTools["readMany"]>[0]) => files.readMany(request),
    applyPatch: (request: Parameters<ChatAgentWorkspaceTools["applyPatch"]>[0]) => patch.apply(request),
    showChanges: (workspaceId: string) => changes.show(workspaceId),
  });
  const agentDrivers = Object.freeze([
    ...(input.agentDrivers ?? []),
    ...(input.agentDriverFactories ?? []).map(factory => factory(agentWorkspaceTools)),
  ]);
  const agents = agentDrivers.length > 0
    ? new ChatAgentManager({
        workspaces,
        storePath: join(input.stateRoot, "agents-v1.json"),
        drivers: agentDrivers,
      })
    : undefined;
  const worktrees = input.ownership
    ? new ChatManagedWorktreeManager({
        workspaces,
        managedRoot,
        storePath: join(input.stateRoot, "managed-worktrees-v1.json"),
        ownershipManifestPath: input.ownership.manifestPath,
        installId: input.ownership.installId,
        productVersion: input.ownership.productVersion,
      })
    : undefined;
  const capabilities: readonly TelaChatCapability[] = Object.freeze([
    ...TELA_CHAT_BASE_CAPABILITIES,
    ...(worktrees ? TELA_CHAT_MANAGED_WORKTREE_CAPABILITIES : []),
    ...(agents ? TELA_CHAT_AGENT_CAPABILITIES : []),
  ]);
  return Object.freeze({
    workspaces,
    files,
    patch,
    processes,
    changes,
    reviews,
    incidents,
    ...(worktrees ? { worktrees } : {}),
    ...(agents ? { agents } : {}),
    capabilities,
    async initialize() {
      await worktrees?.reconcile();
    },
    async call(name: TelaChatCapability, inputValue: unknown) {
      const selected = capability(name, capabilities);
      const args = object(inputValue, `${selected} arguments`);
      try {
        switch (selected) {
        case "open_workspace":
          return workspaces.open(text(args.path, "workspace path"));
        case "read":
          return files.read({ workspaceId: text(args.workspace_id, "workspace_id"), path: text(args.path, "path"),
            ...(optionalInteger(args.offset, "offset") === undefined ? {} : { offset: optionalInteger(args.offset, "offset")! }),
            ...(optionalInteger(args.limit, "limit") === undefined ? {} : { limit: optionalInteger(args.limit, "limit")! }) });
        case "read_many": {
          if (!Array.isArray(args.reads)) throw new Error("reads must be an array");
          return files.readMany({ workspaceId: text(args.workspace_id, "workspace_id"), reads: args.reads.map((entry, index) => {
            const read = object(entry, `reads[${index}]`);
            const offset = optionalInteger(read.offset, `reads[${index}].offset`);
            const limit = optionalInteger(read.limit, `reads[${index}].limit`);
            return { path: text(read.path, `reads[${index}].path`),
              ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) };
          }) });
        }
        case "apply_patch":
          return patch.apply({ workspaceId: text(args.workspace_id, "workspace_id"), patch: multilineText(args.patch, "patch", 2 * 1024 * 1024) });
        case "exec_command":
          return processes.exec({ workspaceId: text(args.workspace_id, "workspace_id"), command: text(args.cmd, "cmd"),
            ...(optionalText(args.working_directory, "working_directory") === undefined ? {} : { workingDirectory: optionalText(args.working_directory, "working_directory")! }),
            ...(optionalText(args.operation_id, "operation_id") === undefined ? {} : { operationId: optionalText(args.operation_id, "operation_id")! }),
            ...(optionalInteger(args.yield_time_ms, "yield_time_ms") === undefined ? {} : { yieldTimeMs: optionalInteger(args.yield_time_ms, "yield_time_ms")! }) });
        case "write_stdin":
          return processes.writeStdin({ workspaceId: text(args.workspace_id, "workspace_id"), sessionId: optionalInteger(args.session_id, "session_id")!,
            ...(args.chars === undefined ? {} : { chars: typeof args.chars === "string" ? args.chars : (() => { throw new Error("chars must be a string"); })() }),
            ...(optionalInteger(args.yield_time_ms, "yield_time_ms") === undefined ? {} : { yieldTimeMs: optionalInteger(args.yield_time_ms, "yield_time_ms")! }) });
        case "process_status":
          return processes.status(text(args.workspace_id, "workspace_id"), text(args.operation_id, "operation_id"));
        case "show_changes":
          return changes.show(text(args.workspace_id, "workspace_id"));
        case "show_review":
          return changes.showReview(text(args.workspace_id, "workspace_id"), text(args.review_ref, "review_ref"));
        case "list_reviews":
          return changes.listReviews(text(args.workspace_id, "workspace_id"));
        case "list_incidents":
          return incidents.list(text(args.workspace_id, "workspace_id"), optionalInteger(args.limit, "limit") ?? 20);
        case "show_incident":
          return incidents.read(text(args.workspace_id, "workspace_id"), text(args.incident_ref, "incident_ref"));
        case "create_worktree":
          return worktrees!.create({
            sourceWorkspaceId: text(args.source_workspace_id, "source_workspace_id"),
            ...(optionalText(args.base_ref, "base_ref") === undefined ? {} : { baseRef: optionalText(args.base_ref, "base_ref")! }),
          });
        case "inspect_worktree":
          return worktrees!.inspect(text(args.worktree_id, "worktree_id"));
        case "remove_worktree":
          return worktrees!.remove(text(args.worktree_id, "worktree_id"));
        case "list_worktrees":
          return worktrees!.list();
        case "list_agent_targets":
          return agents!.targets();
        case "start_agent": {
          const mode = agentWriteMode(args.write_mode);
          return agents!.start({
            workspaceId: text(args.workspace_id, "workspace_id"),
            target: text(args.target, "target"),
            prompt: multilineText(args.prompt, "prompt", 256 * 1024),
            ...(mode === undefined ? {} : { writeMode: mode }),
          });
        }
        case "continue_agent": {
          const mode = agentWriteMode(args.write_mode);
          return agents!.continue({
            workspaceId: text(args.workspace_id, "workspace_id"),
            agentId: text(args.agent_id, "agent_id"),
            prompt: multilineText(args.prompt, "prompt", 256 * 1024),
            ...(mode === undefined ? {} : { writeMode: mode }),
          });
        }
        case "get_agent":
          return agents!.get(text(args.workspace_id, "workspace_id"), text(args.agent_id, "agent_id"));
        case "list_agents":
          return agents!.list(text(args.workspace_id, "workspace_id"));
        case "wait_agents": {
          if (!Array.isArray(args.agent_ids)) throw new Error("agent_ids must be an array");
          const timeoutMs = optionalInteger(args.timeout_ms, "timeout_ms");
          return agents!.wait({
            workspaceId: text(args.workspace_id, "workspace_id"),
            agentIds: args.agent_ids.map((value, index) => text(value, `agent_ids[${index}]`)),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          });
        }
        case "stop_agent":
          return agents!.stop(text(args.workspace_id, "workspace_id"), text(args.agent_id, "agent_id"));
        }
      } catch (error) {
        if (selected !== "list_incidents" && selected !== "show_incident") {
          const workspaceId = typeof args.workspace_id === "string"
            ? args.workspace_id
            : typeof args.source_workspace_id === "string"
              ? args.source_workspace_id
              : undefined;
          if (workspaceId) {
            try { incidents.captureFailure({ capability: selected, workspaceId, error }); }
            catch { /* Diagnostics are best-effort and never change the primary operation outcome. */ }
          }
        }
        throw error;
      }
    },
    async close() {
      const results = await Promise.allSettled([
        processes.close(),
        ...(agents ? [agents.close()] : []),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map(result => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, "Tela Chat runtime shutdown was incomplete");
    },
  });
}

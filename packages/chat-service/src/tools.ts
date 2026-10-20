import { join } from "node:path";
import { inspectNativeThreadHistoricalEvidence, emitDiagnosticEvent, diagnosticFingerprint } from "@chatgpt-tela/core";
import { CHAT_PROCESS_STORE_FILENAME } from "@chatgpt-tela/product-lifecycle/chat-process-storage";
import { ChatAgentManager, type ChatAgentDriver, type ChatAgentWriteMode } from "./agents";
import { ChatChangeReviewer } from "./changes";
import { ChatFileImporter, CHAT_IMPORT_MAX_BYTES } from "./imports";
import { ChatFileExporter } from "./exports";
import { ChatFileTools } from "./files";
import { ChatExplorationTools } from "./exploration";
import { ChatIncidentStore } from "./incidents";
import { ChatPatchTool } from "./patch";
import { ChatProcessManager, type OwnedProcessWorkerConfig } from "./processes";
import { ChatReviewCheckpointStore } from "./reviews";
import { ChatSkillCatalog } from "./skills";
import { ChatWorkspaceRegistry } from "./workspaces";
import { ChatManagedWorktreeManager } from "./worktrees";
import { discoverWorkspaceInstructions } from "./workspace-instructions";

export interface ChatAgentWorkspaceTools {
  workspaceInstructions(workspaceId: string): unknown;
  listDirectory(input: {
    readonly workspaceId: string;
    readonly path?: string;
    readonly limit?: number;
  }): unknown;
  searchText(input: {
    readonly workspaceId: string;
    readonly query: string;
    readonly path?: string;
    readonly caseSensitive?: boolean;
    readonly maxResults?: number;
  }): unknown;
  listSkills(workspaceId: string, query?: string): unknown;
  readSkill(input: {
    readonly workspaceId: string;
    readonly name: string;
    readonly path?: string;
    readonly offset?: number;
    readonly limit?: number;
  }): unknown;
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
  "list_directory",
  "search_text",
  "search_files",
  "list_skills",
  "read_skill",
  "read",
  "view_image",
  "read_many",
  "apply_patch",
  "exec_command",
  "write_stdin",
  "list_processes",
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

export const TELA_CHAT_FILE_IMPORT_CAPABILITIES = Object.freeze(["open_file_import", "import_file"] as const);

export const TELA_CHAT_CAPABILITIES = Object.freeze([
  ...TELA_CHAT_BASE_CAPABILITIES,
  "inspect_native_work",
  "inspect_native_evidence",
  "export_file",
  ...TELA_CHAT_FILE_IMPORT_CAPABILITIES,
  ...TELA_CHAT_MANAGED_WORKTREE_CAPABILITIES,
  ...TELA_CHAT_AGENT_CAPABILITIES,
] as const);

export type TelaChatCapability = typeof TELA_CHAT_CAPABILITIES[number];

export interface ChatToolRuntime {
  readonly workspaces: ChatWorkspaceRegistry;
  readonly exploration: ChatExplorationTools;
  readonly skills: ChatSkillCatalog;
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
  assertCanClose(): void;
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

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function reviewSince(value: unknown): "last_shown" | "workspace_open" | undefined {
  if (value === undefined) return undefined;
  if (value === "last_shown" || value === "workspace_open") return value;
  throw new Error("since must be last_shown or workspace_open");
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
  readonly globalSkillRoots?: readonly string[];
  readonly filePublisherExecutable?: string;
  /** Internal candidate admission only; the caller verifies the executable before selecting it. */
  readonly ownerWorker?: OwnedProcessWorkerConfig;
  readonly agentDrivers?: readonly ChatAgentDriver[];
  readonly agentDriverFactories?: readonly ChatAgentDriverFactory[];
  /** Optional authenticated, read-only peer contract; never import Codex runtime into Chat. */
  readonly inspectNativeWork?: (request: { readonly slot: number; readonly threadId: string;
    readonly minutes: number }) => Promise<unknown>;
  /** Installed local diagnostic paths, never model/agent-provided paths. */
  readonly historicalDiagnosticPaths?: readonly string[];
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
  const exporter = input.filePublisherExecutable ? new ChatFileExporter(workspaces, input.filePublisherExecutable) : undefined;
  const importer = input.filePublisherExecutable ? new ChatFileImporter(workspaces, input.filePublisherExecutable, join(input.stateRoot, "imports-v2")) : undefined;
  const exploration = new ChatExplorationTools(workspaces);
  const skills = new ChatSkillCatalog({ workspaces, ...(input.globalSkillRoots ? { globalRoots: input.globalSkillRoots } : {}) });
  const patch = new ChatPatchTool(workspaces);
  const processes = new ChatProcessManager({ workspaces, storePath: join(input.stateRoot, CHAT_PROCESS_STORE_FILENAME),
    ...(input.ownerWorker ? { ownerWorker: input.ownerWorker } : {}) });
  const reviews = new ChatReviewCheckpointStore({ root: join(input.stateRoot, "reviews") });
  const incidents = new ChatIncidentStore({ root: join(input.stateRoot, "incidents") });
  const changes = new ChatChangeReviewer(workspaces, reviews, join(input.stateRoot, "review-comparisons"));
  const agentWorkspaceTools: ChatAgentWorkspaceTools = Object.freeze({
    workspaceInstructions: (workspaceId: string) => {
      const workspace = workspaces.get(workspaceId);
      return discoverWorkspaceInstructions(workspace.root);
    },
    listDirectory: (request: Parameters<ChatAgentWorkspaceTools["listDirectory"]>[0]) => exploration.listDirectory(request),
    searchText: (request: Parameters<ChatAgentWorkspaceTools["searchText"]>[0]) => exploration.searchText(request),
    listSkills: (workspaceId: string, query = "") => skills.list(workspaceId, query),
    readSkill: (request: Parameters<ChatAgentWorkspaceTools["readSkill"]>[0]) => skills.read(request),
    read: (request: Parameters<ChatAgentWorkspaceTools["read"]>[0]) => files.read(request),
    readMany: (request: Parameters<ChatAgentWorkspaceTools["readMany"]>[0]) => files.readMany(request),
    applyPatch: (request: Parameters<ChatAgentWorkspaceTools["applyPatch"]>[0]) => patch.apply(request),
    showChanges: (workspaceId: string) => changes.show(workspaceId),
  });
  const agentDrivers = Object.freeze([
    ...(input.agentDrivers ?? []),
    ...(input.agentDriverFactories ?? []).map(factory => factory(agentWorkspaceTools)),
  ]);
  // Load durable authority even when a previously configured driver is unavailable.
  const agentState = new ChatAgentManager({
    workspaces,
    storePath: join(input.stateRoot, "agents-v1.json"),
    drivers: agentDrivers,
  });
  const agents = agentState.targetCount > 0 ? agentState : undefined;
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
  const capabilities = (): readonly TelaChatCapability[] => Object.freeze([
    ...(exporter?.supported ? ["export_file" as const] : []),
    ...TELA_CHAT_BASE_CAPABILITIES,
    ...(input.inspectNativeWork ? ["inspect_native_work" as const] : []),
    ...(input.historicalDiagnosticPaths ? ["inspect_native_evidence" as const] : []),
    ...(importer ? TELA_CHAT_FILE_IMPORT_CAPABILITIES : []),
    ...(worktrees ? TELA_CHAT_MANAGED_WORKTREE_CAPABILITIES : []),
    ...(agents ? TELA_CHAT_AGENT_CAPABILITIES : []),
  ]);
  return Object.freeze({
    workspaces,
    exploration,
    skills,
    files,
    patch,
    processes,
    changes,
    reviews,
    incidents,
    ...(worktrees ? { worktrees } : {}),
    ...(agents ? { agents } : {}),
    get capabilities() { return capabilities(); },
    async initialize() {
      await importer?.initialize();
      await exporter?.initialize();
      await worktrees?.reconcile();
    },
    async call(name: TelaChatCapability, inputValue: unknown) {
      const selected = capability(name, capabilities());
      const args = object(inputValue, `${selected} arguments`);
      // A fixed-name, payload-free witness for mutations/executions that actually
      // Its absence alone is not proof of a refusal (logs may be unavailable).
      if (selected === "exec_command" || selected === "apply_patch" || selected === "write_stdin") {
        const workspaceId = args.workspace_id;
        emitDiagnosticEvent("chatgpt_tela_chat", "chat_capability_dispatch_received", {
          capability: selected,
          ...(typeof workspaceId === "string" && workspaceId.length > 0
            && workspaceId.length <= 16_384 && !workspaceId.includes("\0")
            ? { scope_fingerprint: diagnosticFingerprint(workspaceId) } : {}),
        });
      }
      try {
        switch (selected) {
        case "open_workspace": {
          const workspace = workspaces.open(text(args.path, "workspace path"));
          const reviewBaseline = await changes.initializeWorkspace(workspace.id);
          return Object.freeze({ ...workspace, ...discoverWorkspaceInstructions(workspace.root), reviewBaseline });
        }
        case "inspect_native_work": {
          // The open workspace is a user-approved Chat context gate, not
          // permission to mutate a Native thread or choose another profile.
          workspaces.get(text(args.workspace_id, "workspace_id"));
          const threadId = text(args.thread_id, "thread_id");
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(threadId)) {
            throw Error("Native thread identity must be an exact UUID");
          }
          const slot = optionalInteger(args.slot, "slot") ?? 1;
          const minutes = optionalInteger(args.minutes, "minutes") ?? 30;
          if (slot < 1 || slot > 99 || minutes < 1 || minutes > 120) throw Error("invalid inspection slot or window");
          return await input.inspectNativeWork!({ slot, threadId, minutes });
        }
        case "inspect_native_evidence": {
          workspaces.get(text(args.workspace_id, "workspace_id"));
          const threadId = text(args.thread_id, "thread_id");
          const minutes = optionalInteger(args.minutes, "minutes") ?? 180;
          return inspectNativeThreadHistoricalEvidence({
            threadId, minutes, diagnosticPaths: input.historicalDiagnosticPaths!,
          });
        }
        case "export_file":
          return await exporter!.read(text(args.workspace_id, "workspace_id"), text(args.path, "path"));
        case "open_file_import": {
          const workspace = workspaces.get(text(args.workspace_id, "workspace_id"));
          await importer!.recover(workspace.id);
          return Object.freeze({ workspace_id: workspace.id, maxBytes: CHAT_IMPORT_MAX_BYTES });
        }
        case "import_file":
          return await importer!.publish({ workspaceId: text(args.workspace_id, "workspace_id"), path: text(args.path, "path"),
            dataBase64: typeof args.data_base64 === "string" ? args.data_base64 : (() => { throw new Error("data_base64 must be a string"); })() });
        case "list_directory":
          return exploration.listDirectory({
            workspaceId: text(args.workspace_id, "workspace_id"),
            ...(optionalText(args.path, "path") === undefined ? {} : { path: optionalText(args.path, "path")! }),
            ...(optionalInteger(args.limit, "limit") === undefined ? {} : { limit: optionalInteger(args.limit, "limit")! }),
          });
        case "search_text":
          return exploration.searchText({
            workspaceId: text(args.workspace_id, "workspace_id"),
            query: multilineText(args.query, "query", 4 * 1024),
            ...(optionalText(args.path, "path") === undefined ? {} : { path: optionalText(args.path, "path")! }),
            ...(args.case_sensitive === undefined ? {} : typeof args.case_sensitive === "boolean"
              ? { caseSensitive: args.case_sensitive }
              : (() => { throw new Error("case_sensitive must be a boolean"); })()),
            ...(optionalInteger(args.max_results, "max_results") === undefined ? {} : { maxResults: optionalInteger(args.max_results, "max_results")! }),
          });
        case "search_files":
          return exploration.searchFiles({
            workspaceId: text(args.workspace_id, "workspace_id"),
            query: multilineText(args.query, "query", 4 * 1024),
            ...(optionalText(args.path, "path") === undefined ? {} : { path: optionalText(args.path, "path")! }),
            ...(optionalBoolean(args.case_sensitive, "case_sensitive") === undefined ? {} : { caseSensitive: optionalBoolean(args.case_sensitive, "case_sensitive")! }),
            ...(optionalInteger(args.max_results, "max_results") === undefined ? {} : { maxResults: optionalInteger(args.max_results, "max_results")! }),
          });
        case "list_skills":
          return skills.list(
            text(args.workspace_id, "workspace_id"),
            optionalText(args.query, "query") ?? "",
          );
        case "read_skill":
          return skills.read({
            workspaceId: text(args.workspace_id, "workspace_id"),
            name: text(args.name, "name"),
            ...(optionalText(args.path, "path") === undefined ? {} : { path: optionalText(args.path, "path")! }),
            ...(optionalInteger(args.offset, "offset") === undefined ? {} : { offset: optionalInteger(args.offset, "offset")! }),
            ...(optionalInteger(args.limit, "limit") === undefined ? {} : { limit: optionalInteger(args.limit, "limit")! }),
          });
        case "read":
          return files.read({ workspaceId: text(args.workspace_id, "workspace_id"), path: text(args.path, "path"),
            ...(optionalInteger(args.offset, "offset") === undefined ? {} : { offset: optionalInteger(args.offset, "offset")! }),
            ...(optionalInteger(args.limit, "limit") === undefined ? {} : { limit: optionalInteger(args.limit, "limit")! }) });
        case "view_image":
          return files.viewImage({ workspaceId: text(args.workspace_id, "workspace_id"), path: text(args.path, "path") });
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
          return processes.exec({ workspaceId: text(args.workspace_id, "workspace_id"), command: multilineText(args.cmd, "cmd", 64 * 1024),
            ...(optionalText(args.working_directory, "working_directory") === undefined ? {} : { workingDirectory: optionalText(args.working_directory, "working_directory")! }),
            ...(optionalText(args.operation_id, "operation_id") === undefined ? {} : { operationId: optionalText(args.operation_id, "operation_id")! }),
            ...(optionalInteger(args.yield_time_ms, "yield_time_ms") === undefined ? {} : { yieldTimeMs: optionalInteger(args.yield_time_ms, "yield_time_ms")! }) });
        case "write_stdin":
          return processes.writeStdin({ workspaceId: text(args.workspace_id, "workspace_id"), sessionId: optionalInteger(args.session_id, "session_id")!,
            ...(args.chars === undefined ? {} : { chars: typeof args.chars === "string" ? args.chars : (() => { throw new Error("chars must be a string"); })() }),
            ...(optionalInteger(args.yield_time_ms, "yield_time_ms") === undefined ? {} : { yieldTimeMs: optionalInteger(args.yield_time_ms, "yield_time_ms")! }) });
        case "list_processes":
          return processes.list({ workspaceId: text(args.workspace_id, "workspace_id"),
            ...(optionalInteger(args.after_session_id, "after_session_id") === undefined ? {} : { afterSessionId: optionalInteger(args.after_session_id, "after_session_id")! }),
            ...(optionalInteger(args.limit, "limit") === undefined ? {} : { limit: optionalInteger(args.limit, "limit")! }),
            ...(optionalBoolean(args.include_completed, "include_completed") === undefined ? {} : { includeCompleted: optionalBoolean(args.include_completed, "include_completed")! }) });
        case "process_status":
          return processes.inspect(text(args.workspace_id, "workspace_id"), text(args.operation_id, "operation_id"));
        case "show_changes": {
          const since = reviewSince(args.since);
          const markReviewed = optionalBoolean(args.mark_reviewed, "mark_reviewed");
          return changes.show(text(args.workspace_id, "workspace_id"), {
            ...(since === undefined ? {} : { since }),
            ...(markReviewed === undefined ? {} : { markReviewed }),
          });
        }
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
    assertCanClose() { processes.assertCanClose(); },
    async close() {
      // Refuse before closing any peer subsystem; recovery must remain usable.
      processes.assertCanClose();
      const results = await Promise.allSettled([
        processes.close(),
        ...(importer ? [importer.close()] : []),
        ...(exporter ? [exporter.close()] : []),
        agentState.close(),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map(result => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, "Tela Chat runtime shutdown was incomplete");
    },
  });
}

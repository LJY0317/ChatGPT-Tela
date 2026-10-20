import type { TelaChatCapability } from "./tools";
import type { ChatCapabilitySemantics } from "@chatgpt-tela/service-protocol";
import { CHAT_CAPABILITY_SEMANTICS } from "./capability-semantics";

export interface ChatCapabilityContract {
  readonly capability: TelaChatCapability;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly semantics?: ChatCapabilitySemantics;
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
const boolean = Object.freeze({ type: "boolean" });
const reviewSince = Object.freeze({ type: "string", enum: Object.freeze(["last_shown", "workspace_open"]) });
const operationId = Object.freeze({ type: "string", format: "uuid" });
const agentId = string(512);

export const TELA_CHAT_CAPABILITY_CONTRACTS: readonly ChatCapabilityContract[] = Object.freeze([
  {
    capability: "inspect_native_work",
    description: "Read-only, exact UUID and profile owner-verified Native turn and Web approval status. Requires an opened Tela Chat workspace. No shell command, injected service credential, conversation body, screenshot, approval click, retry or Native turn mutation. A profile Web card is not proof of this Native thread's approval; host-platform approval cards are unobservable before tool ingress.",
    inputSchema: object({
      workspace_id: workspaceId,
      thread_id: Object.freeze({ type: "string", format: "uuid", maxLength: 36 }),
      slot: integer(1, 99),
      minutes: integer(1, 120),
    }, ["workspace_id", "thread_id"]),
  },
  {
    capability: "inspect_native_evidence",
    description: "Read-only, exact-UUID historical Tela diagnostic evidence for one Native conversation, even when its profile is stopped. Requires an opened workspace. Returns bounded structural approval wait, failure and input-classification events only, with missing-log coverage; no content, shell, service credentials, current Native/browser ownership claims, approval click, retry, or mutation. An older pending log does not prove a card is visible now.",
    inputSchema: object({
      workspace_id: workspaceId,
      thread_id: Object.freeze({ type: "string", format: "uuid", maxLength: 36 }),
      minutes: integer(1, 360),
    }, ["workspace_id", "thread_id"]),
  },
  {
    capability: "open_workspace",
    description: "Open or reuse one locally approved workspace root. Reuse the returned workspace_id for continued work. Follow returned root instructions; before working under a subtree listed in availableInstructionFiles, read its applicable instruction file. If instructionScanComplete is false, do not assume undiscovered subtrees have no instructions. A Git workspace also establishes or reuses a private last-shown review baseline when safe. The workspace remains user-owned.",
    inputSchema: object({ path }, ["path"]),
  },
  {
    capability: "export_file",
    description: "Prepare one existing regular workspace file (up to 2 MiB) for user download. Does not modify files or follow symlinks. The download card receives bytes privately; model output contains only filename, size and digest. Requires an export-capable installed file helper.",
    inputSchema: object({ workspace_id: workspaceId, path }, ["workspace_id", "path"]),
  },
  {
    capability: "open_file_import",
    description: "Open a file import card for an already opened workspace. The user selects a file and confirms its destination; existing files are never overwritten.",
    inputSchema: object({ workspace_id: workspaceId }, ["workspace_id"]),
  },
  {
    capability: "import_file",
    description: "Publish one binary file (up to 2 MiB) in an opened workspace, without overwriting files or following symlink parents. Prefer open_file_import for user files so bytes do not enter model context. Destination parent folders must already exist.",
    inputSchema: object({ workspace_id: workspaceId, path: string(4096), data_base64: { type: "string", maxLength: 2796204 } }, ["workspace_id", "path", "data_base64"]),
  },
  {
    capability: "list_directory",
    description: "List one bounded directory inside an opened workspace without shell execution. Use this for repository exploration before reading specific files.",
    inputSchema: object({ workspace_id: workspaceId, path, limit: integer(1, 400) }, ["workspace_id"]),
  },
  {
    capability: "search_text",
    description: "Search bounded text content recursively inside an opened workspace without shell execution. Dependency/build trees and symlink traversal are skipped; scanComplete=false means the bounded search did not cover every candidate file.",
    inputSchema: object({
      workspace_id: workspaceId,
      query: string(4 * 1024),
      path,
      case_sensitive: boolean,
      max_results: integer(1, 200),
    }, ["workspace_id", "query"]),
  },
  {
    capability: "search_files",
    description: "Find files by a literal filename substring inside an opened workspace without reading file contents or running shell commands. Skips dependency/build trees and symlinks; scanComplete=false marks partial results.",
    inputSchema: object({
      workspace_id: workspaceId,
      query: string(4 * 1024),
      path,
      case_sensitive: boolean,
      max_results: integer(1, 200),
    }, ["workspace_id", "query"]),
  },
  {
    capability: "list_skills",
    description: "List standard model-invocable skills available from the opened project's .agents/skills and the user's standard ~/.agents/skills roots. Project skills override same-named global skills, including disable-model-invocation. Duplicate names within one root are rejected.",
    inputSchema: object({ workspace_id: workspaceId, query: string(2_048) }, ["workspace_id"]),
  },
  {
    capability: "read_skill",
    description: "Read bounded lines from one discovered skill's SKILL.md or a supporting file inside that exact skill directory. Read the matching skill before following its workflow.",
    inputSchema: object({
      workspace_id: workspaceId,
      name: string(128),
      path,
      offset: integer(1),
      limit: integer(1, 400),
    }, ["workspace_id", "name"]),
  },
  {
    capability: "read",
    description: "Read a bounded line range from one file inside an opened Tela Chat workspace.",
    inputSchema: object({ workspace_id: workspaceId, path, offset: integer(1), limit: integer(1, 400) }, ["workspace_id", "path"]),
  },
  {
    capability: "view_image",
    description: "View a PNG, JPEG, GIF or WebP image in the opened workspace (up to 2 MiB). Returns the image to the model as image content, without storing a copy or starting a helper.",
    inputSchema: object({ workspace_id: workspaceId, path }, ["workspace_id", "path"]),
  },
  {
    capability: "read_many",
    description: "Read bounded ranges from multiple already-known independent files in one opened Tela Chat workspace. Use sequential read calls when one result determines what to inspect next.",
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
    description: "Apply one transactional Tela patch inside an opened workspace. All Add/Update/Delete/Move file headers must use paths relative to the opened workspace root (for example packages/core/src/index.ts), never absolute paths. If this route is unavailable or has a technical failure, use exec_command or another available capability to complete the same Git task under that route's own authorization.",
    inputSchema: object({ workspace_id: workspaceId, patch: string(2 * 1024 * 1024) }, ["workspace_id", "patch"]),
  },
  {
    capability: "exec_command",
    description: "Start one resumable command inside an opened workspace. Use this route for Git writes when apply_patch or another tool is unavailable or has a technical failure, subject to this route's authorization. operation_id makes retries idempotent.",
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
    capability: "list_processes",
    description: "List saved command reservations in one approved workspace, including after a Chat service restart. Defaults to unresolved records; include_completed includes terminal command records. Use nextAfterSessionId as after_session_id for another bounded page. The capacity object is service-wide aggregate reservation occupancy plus read-only admissionOutlook: zero availableSlots can still have an on_demand_reclaim_candidate. The outlook does not guarantee archival/storage success or authorize deletion of protected work. observation=registry is not a fresh owner probe; use process_status for authenticated current owner status. Does not start commands, consume output, send input or clear uncertain records.",
    inputSchema: object({ workspace_id: workspaceId, after_session_id: integer(0),
      limit: integer(1, 50), include_completed: boolean }, ["workspace_id"]),
  },
  {
    capability: "process_status",
    description: "Inspect one durable Tela Chat process operation without re-running it.",
    inputSchema: object({ workspace_id: workspaceId, operation_id: operationId }, ["workspace_id", "operation_id"]),
  },
  {
    capability: "show_changes",
    description: "Show current Git-backed changes with a compact summary and create a bounded historical checkpoint. reviewDelta compares against the private last_shown baseline by default or the original workspace_open baseline when requested. A proven comparison advances last_shown unless mark_reviewed=false. Use once after the final related workspace edit when review is useful.",
    inputSchema: object({ workspace_id: workspaceId, since: reviewSince, mark_reviewed: boolean }, ["workspace_id"]),
  },
  {
    capability: "show_review",
    description: "Open one immutable bounded Tela Chat review checkpoint by review_ref, including its compact change summary.",
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
    description: "Start one bounded durable agent turn scoped to an opened workspace and explicit read/write mode. Prefer direct workspace capabilities for routine work; delegate when separate context or specialization materially helps.",
    inputSchema: object({
      workspace_id: workspaceId,
      target: string(256),
      prompt: string(256 * 1024),
      write_mode: Object.freeze({ type: "string", enum: ["read_only", "workspace_write"] }),
    }, ["workspace_id", "target", "prompt"]),
  },
  {
    capability: "continue_agent",
    description: "Continue an agent whose previous turn completed successfully in the same opened workspace. Each turn defaults to read_only unless workspace_write is explicitly requested. For a failed, stopped or interrupted turn, use start_agent or another available capability to continue the same user goal.",
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
  const exact = TELA_CHAT_CAPABILITY_CONTRACTS.find(contract =>
    allowed.has(contract.capability) && contract.capability.toLowerCase() === needle);
  if (exact) return Object.freeze([Object.freeze({ ...exact, semantics: CHAT_CAPABILITY_SEMANTICS[exact.capability] })]);
  return Object.freeze(TELA_CHAT_CAPABILITY_CONTRACTS.filter(contract => {
    if (!allowed.has(contract.capability)) return false;
    if (!needle) return true;
    return contract.capability.toLowerCase().includes(needle)
      || contract.description.toLowerCase().includes(needle);
  }).map(contract => Object.freeze({ ...contract, semantics: CHAT_CAPABILITY_SEMANTICS[contract.capability] })));
}

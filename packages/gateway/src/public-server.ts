import { CHATGPT_TELA_EXPORT_RESOURCE_URI, CHATGPT_TELA_EXPORT_WIDGET_HTML } from "./export-widget";
import { CHATGPT_FILE_CONNECT_ORIGINS } from "./chatgpt-file-source";
import { CHATGPT_TELA_IMPORT_RESOURCE_URI, CHATGPT_TELA_IMPORT_WIDGET_HTML } from "./import-widget";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { diagnosticFingerprint, emitDiagnosticEvent, traceDiagnosticToolCall, withDiagnosticContext, type NativeToolResult } from "@chatgpt-tela/core";
import {
  CHATGPT_TELA_CHAT_CAPABILITY_CALL,
  CHATGPT_TELA_CHAT_CAPABILITY_INVENTORY,
  CHATGPT_TELA_MCP_SERVER_NAME,
  CHATGPT_TELA_MCP_SERVER_VERSION,
  CHATGPT_TELA_CODEX_TOOL_CALL,
  CHATGPT_TELA_CODEX_TOOL_INVENTORY,
  nativeToolResultToMcpContent,
  observeNativeMcpResultProjection,
  registerTurnBridgeTools,
  type TelaMcpResultContent,
  type TurnBridgeBackend,
} from "@chatgpt-tela/mcp";
import type { ChatCapabilityContract } from "@chatgpt-tela/service-protocol";
import {
  CHATGPT_TELA_REVIEW_RESOURCE_MIME_TYPE,
  CHATGPT_TELA_REVIEW_RESOURCE_URI,
  CHATGPT_TELA_REVIEW_WIDGET_HTML,
} from "./review-widget";

export interface PublicChatBackend {
  inventory(query?: string): readonly ChatCapabilityContract[] | Promise<readonly ChatCapabilityContract[]>;
  call(capability: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export const CHATGPT_TELA_PUBLIC_INSTRUCTIONS = [
  "Use ChatGPT Tela when the request needs the user's connected local workspace or the exact active Native Codex turn; do not invoke it for ordinary conversation or knowledge work that needs neither.",
  "Tela Chat and Tela Codex are independent backends behind one Plugin connection. Choose the backend from the actual request route: Web work uses Tela Chat inventory/call and Native Codex turns use exact-turn Codex inventory/call. A failure of one does not authorize automatic fallback or transfer ownership to the other.",
  "For local work on the Tela Chat route, use the Tela Chat capability inventory first when the exact capability or schema is not already known. Open a workspace once and reuse its workspace_id. Batch only independent already-known reads. For commands that may mutate state or outlive one response, provide operation_id; after an uncertain response, inspect process_status before starting the command again.",
  "The Tela Chat inventory query is an optional case-insensitive filter over capability names and descriptions, not a place for task instructions. Omit it or use an empty string to discover all capabilities; for narrower discovery, use a short capability keyword only. Do not paste a user's full request, conversation titles, or unrelated identifiers into inventory. Inventory is read-only and never performs the requested task.",
  "After related edits, use an available change-review capability when it helps verify the final workspace state. Prefer direct workspace capabilities for routine work and delegate to a Tela Chat agent only when separate context or specialization materially helps.",
  "Only for an active Native Codex turn, the Native transport supplies turn_capability: a temporary bearer credential identifying that exact local task for routing. Discover and use the available capabilities to complete the user's goal; if one tool is unavailable or has a technical failure, use another suitable tool. Do not expose this credential in explanations or logs.",
  "Discover the current Native tool inventory instead of assuming names or schemas from another turn. Describe a requested command by its actual purpose, targets and possible effects, including writes or process changes; do not hide a command behind a reassuring label. If a tool is unavailable or has a technical failure, continue the same user goal with another relevant available tool or method when possible. Check what the first attempt changed before repeating any effect.",
  "A Git write in an opened workspace may be completed through apply_patch, exec_command, or another available capability. If one route is unavailable or has a technical failure, choose another route that can perform the same requested Git operation, provided that route's own authorization allows it.",
  "The Codex inventory query is a literal case-insensitive substring filter, not semantic search. Omit it or use an empty string for the complete inventory. An empty filtered result does not mean no tools are available.",
  "Invoke only tools returned for that same turn capability with arguments matching the returned schema, and continue from the current task state rather than repeating completed work after context rollover or a fresh Web conversation.",
  "Treat actual tool results and platform errors as evidence. A failed tool does not end the user's task: try another suitable tool or method for the same goal. After a deterministic failure, use the failure details to choose the next route; before repeating a side effect, inspect whether the first attempt changed anything.",
  "Do not claim an execution or service connection was lost merely because a tool result is empty, unavailable, or not visible. Report the exact observed boundary, and claim transport loss only when an explicit transport failure or connection-close event is observed. Keep Native turn completion, captured answer, Goal status, and tool-result delivery as separate facts; Native Goal token counters do not establish Web usage or billing.",
  "A completed turn, collected answer, completed Goal or short resume acknowledgement does not by itself settle the original user question. On failure preserve its objective, exact origin thread/turn, remaining scope and successor reference in existing durable coordination context. Settle only against the actual answer; keep unresolved work explicit. Prefer the existing thread, but use a minimal handoff when legacy resumption is unsupported.",
  "For task-relevant user attachments, use supported inline image input or authorized workspace file references, and verify actual delivery before claiming a file was received.",
].join(" ");

function jsonText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function createPublicMcpServer(input: {
  readonly chat: PublicChatBackend;
  readonly codex: TurnBridgeBackend;
}): McpServer {
  const server = new McpServer({
    name: CHATGPT_TELA_MCP_SERVER_NAME,
    version: CHATGPT_TELA_MCP_SERVER_VERSION,
  }, {
    capabilities: { tools: { listChanged: false } },
    instructions: CHATGPT_TELA_PUBLIC_INSTRUCTIONS,
  });

  const rawRegisterTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: {
      readonly title: string;
      readonly description: string;
      readonly inputSchema: z.ZodTypeAny;
    },
    handler: (arguments_: Readonly<Record<string, unknown>>, extra?: unknown) => Promise<{
      readonly content: readonly TelaMcpResultContent[];
      readonly isError?: boolean;
      readonly _meta?: Readonly<Record<string, unknown>>;
    }>,
  ) => void;
  const registerTool: typeof rawRegisterTool = (name, config, handler) => rawRegisterTool(name, config,
    (arguments_, extra) => {
      const call = () => traceDiagnosticToolCall(name, arguments_, extra, () => handler(arguments_, extra));
      const goal = name === CHATGPT_TELA_CHAT_CAPABILITY_CALL && arguments_.capability === "goal_control_call"
        ? arguments_.arguments as { call_id?: unknown } | undefined : undefined;
      // Bind the caller's opaque correlation ID before the public MCP trace begins.
      // Native's separate operation fingerprint is recorded by the existing bridge.
      const id = goal?.call_id;
      if (typeof id !== "string" || !id || id.length > 512) return call();
      try { return withDiagnosticContext({ parent_fingerprint: diagnosticFingerprint(id) }, call); }
      catch { return call(); }
    });

  server.registerResource("tela-chat-review", CHATGPT_TELA_REVIEW_RESOURCE_URI, {
    title: "Tela Chat review",
    description: "Read-only card for current or saved Tela Chat reviews.",
    mimeType: CHATGPT_TELA_REVIEW_RESOURCE_MIME_TYPE,
  }, async () => ({
    contents: [{
      uri: CHATGPT_TELA_REVIEW_RESOURCE_URI,
      mimeType: CHATGPT_TELA_REVIEW_RESOURCE_MIME_TYPE,
      text: CHATGPT_TELA_REVIEW_WIDGET_HTML,
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
    }],
  }));

  server.registerResource("tela-chat-import", CHATGPT_TELA_IMPORT_RESOURCE_URI, {
    title: "Save a file to your workspace", mimeType: CHATGPT_TELA_REVIEW_RESOURCE_MIME_TYPE,
  }, async () => ({ contents: [{ uri: CHATGPT_TELA_IMPORT_RESOURCE_URI, mimeType: CHATGPT_TELA_REVIEW_RESOURCE_MIME_TYPE,
    text: CHATGPT_TELA_IMPORT_WIDGET_HTML, _meta: { ui: { prefersBorder: true, csp: { connectDomains: [...CHATGPT_FILE_CONNECT_ORIGINS], resourceDomains: [] } } } }] }));

  server.registerResource("tela-chat-export", CHATGPT_TELA_EXPORT_RESOURCE_URI, {
    title: "Download a workspace file", mimeType: CHATGPT_TELA_REVIEW_RESOURCE_MIME_TYPE,
  }, async () => ({ contents: [{ uri: CHATGPT_TELA_EXPORT_RESOURCE_URI, mimeType: CHATGPT_TELA_REVIEW_RESOURCE_MIME_TYPE,
    text: CHATGPT_TELA_EXPORT_WIDGET_HTML, _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } } }] }));

  registerTool(CHATGPT_TELA_CHAT_CAPABILITY_INVENTORY, {
    title: "Tela Chat capability inventory",
    description: "List runtime-available Tela Chat workspace/agent capabilities and their current input schemas. Use this for Tela Chat workflows; Native Codex turns use the Codex tool inventory instead.",
    inputSchema: z.object({
      query: z.string().max(1000).optional().default(""),
    }),
  }, async arguments_ => {
    const query = typeof arguments_.query === "string" ? arguments_.query : "";
    const capabilities = await input.chat.inventory(query);
    emitDiagnosticEvent("chatgpt_tela_mcp", "mcp_chat_inventory_returned", {
      query_empty: query.length === 0,
      ...(query.length ? { query_fingerprint: diagnosticFingerprint(query) } : {}),
      query_word_count: query.trim() ? query.trim().split(/\s+/).length : 0,
      count: capabilities.length,
    });
    return { content: [{ type: "text", text: JSON.stringify(capabilities) }] };
  });

  registerTool(CHATGPT_TELA_CHAT_CAPABILITY_CALL, {
    title: "Tela Chat capability call",
    description: "Invoke one Tela Chat capability returned by the Chat inventory using arguments that match its runtime input schema. This does not create Native Codex turn authority.",
    inputSchema: z.object({
      capability: z.string().min(1).max(512),
      arguments: z.record(z.string(), z.unknown()).optional().default({}),
    }),
  }, async request => {
    const capability = typeof request.capability === "string" ? request.capability : "";
    const arguments_ = request.arguments && typeof request.arguments === "object" && !Array.isArray(request.arguments)
      ? request.arguments as Readonly<Record<string, unknown>>
      : {};
    try {
      const result = await input.chat.call(capability, arguments_);
      if (capability === "export_file") {
        const file = z.object({ name: z.string().min(1).max(4096).regex(/^[^\x00-\x1f\x7f/\\]+$/), bytes: z.number().int().min(0).max(2 * 1024 * 1024),
          sha256: z.string().regex(/^[a-f0-9]{64}$/), dataBase64: z.string().max(4 * Math.ceil(2 * 1024 * 1024 / 3)) }).strict().safeParse(result);
        if (!file.success) throw new Error("invalid file download result");
        return { content: [{ type: "text", text: jsonText({ name: file.data.name, bytes: file.data.bytes, sha256: file.data.sha256, download: "Use the download card." }) }],
          _meta: { ui: { resourceUri: CHATGPT_TELA_EXPORT_RESOURCE_URI }, "tela/fileExport": file.data } };
      }
      if (capability === "view_image") {
        const image = z.object({ mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
          dataBase64: z.string().max(4 * Math.ceil(2 * 1024 * 1024 / 3)) }).strict().parse(result);
        return { content: [{ type: "image", mimeType: image.mimeType, data: image.dataBase64 }] };
      }
      if (capability === "goal_control_call") {
        const nativeResult = result as NativeToolResult;
        const mapped = nativeToolResultToMcpContent(nativeResult.content);
        observeNativeMcpResultProjection(nativeResult, mapped);
        return {
          content: [...mapped.content],
          ...(nativeResult.isError ? { isError: true } : {}),
        };
      }
      return {
        content: [{ type: "text", text: jsonText(result) }],
        ...((capability === "show_changes" || capability === "show_review")
          ? { _meta: { ui: { resourceUri: CHATGPT_TELA_REVIEW_RESOURCE_URI } } }
          : capability === "open_file_import" ? { _meta: { ui: { resourceUri: CHATGPT_TELA_IMPORT_RESOURCE_URI } } } : {}),
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });

  registerTurnBridgeTools(server, input.codex, {
    inventory: CHATGPT_TELA_CODEX_TOOL_INVENTORY,
    call: CHATGPT_TELA_CODEX_TOOL_CALL,
  }, {
    inventoryTitle: "Native Codex tool inventory",
    inventoryDescription: "List Native Codex tools for one exact active Native turn identified by its opaque turn capability. Regular Tela Chat workflows use the Chat capability inventory instead.",
    callTitle: "Native Codex tool call",
    callDescription: "Invoke one runtime-discovered tool from the exact active Native Codex turn inventory. A valid opaque turn capability is required.",
  });

  return server;
}

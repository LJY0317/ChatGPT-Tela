import { diagnosticFingerprint, diagnosticSerializedBytes, emitDiagnosticEvent } from "@chatgpt-tela/core";
import {
  CHATGPT_TELA_CHAT_CAPABILITY_CALL, CHATGPT_TELA_CHAT_CAPABILITY_INVENTORY,
  CHATGPT_TELA_CODEX_TOOL_CALL, CHATGPT_TELA_CODEX_TOOL_INVENTORY,
} from "./public-abi";

const methods: Readonly<Record<string, string>> = {
  "server/discover": "server_discover",
  initialize: "initialize", "notifications/initialized": "initialized",
  "tools/list": "tools_list", "tools/call": "tools_call", ping: "ping",
};
const tools: Readonly<Record<string, string>> = {
  [CHATGPT_TELA_CHAT_CAPABILITY_INVENTORY]: "chat_inventory",
  [CHATGPT_TELA_CHAT_CAPABILITY_CALL]: "chat_call",
  [CHATGPT_TELA_CODEX_TOOL_INVENTORY]: "codex_inventory",
  [CHATGPT_TELA_CODEX_TOOL_CALL]: "codex_call",
};

/** Observe protocol envelopes only; never retain params, arbitrary names or response bodies. */
export function observeMcpEnvelope(value: unknown, connection: string | undefined, direction: "received" | "emitted"): void {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const row = value as Record<string, any>;
    const fields: Record<string, string | number | boolean> = { connection_observed: connection !== undefined,
      ...(connection ? { connection_fingerprint: connection } : {}) };
    if ((typeof row.id === "string" && row.id.length > 0 && row.id.length <= 16384)
      || (typeof row.id === "number" && Number.isSafeInteger(row.id))) fields.rpc_fingerprint = diagnosticFingerprint(String(row.id));
    if (direction === "received") {
      const scope = row.params?._meta?.["openai/session"];
      if (typeof scope === "string" && scope.length <= 16384) fields.scope_fingerprint = diagnosticFingerprint(scope);
      const version = row.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
      const date = typeof version === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(version) : undefined;
      if (date) { fields.protocol_year = Number(date[1]); fields.protocol_month = Number(date[2]); fields.protocol_day = Number(date[3]); }
      fields.method_class = typeof row.method === "string" && Object.hasOwn(methods, row.method) ? methods[row.method]! : "other";
      if (row.method === "tools/call") {
        const name = row.params?.name;
        fields.kind = typeof name === "string" && Object.hasOwn(tools, name) ? tools[name]! : "other";
      }
    } else {
      fields.delivery = "transport_send_returned";
      fields.error_result = row.error !== undefined || row.result?.isError === true;
      if (Number.isSafeInteger(row.error?.code)) fields.error_code = row.error.code;
      const content = row.result?.content;
      if (Array.isArray(content)) {
        fields.part_count = content.length;
        fields.kind = content.length === 0 ? "empty"
          : content.every(item => item?.type === "text") ? "text"
          : content.every(item => item?.type === "image") ? "image"
          : content.every(item => item?.type === "text" || item?.type === "image") ? "mixed" : "other";
        const contentBytes = diagnosticSerializedBytes(content);
        const resultBytes = diagnosticSerializedBytes(row.result);
        if (contentBytes !== undefined) fields.body_bytes = contentBytes;
        if (resultBytes !== undefined) fields.result_bytes = resultBytes;
      }
      if (Array.isArray(row.result?.tools)) {
        fields.phase = "tools_list";
        fields.count = row.result.tools.length;
        for (const [name, kind] of Object.entries(tools)) fields[kind + "_present"] = row.result.tools.some((tool: any) => tool?.name === name);
      } else fields.phase = row.error !== undefined ? "rpc_error" : "rpc_result";
    }
    emitDiagnosticEvent("chatgpt_tela_mcp", "mcp_rpc_" + direction, fields);
  } catch { /* Observation cannot change protocol delivery. */ }
}

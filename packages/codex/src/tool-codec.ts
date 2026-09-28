import type {
  NativeToolCatalogEntry,
  NativeToolInvocation,
  NativeToolResult,
} from "@chatgpt-tela/core";

export type NativeResponsesToolCallItem =
  | {
      readonly type: "function_call";
      readonly call_id: string;
      readonly name: string;
      readonly namespace?: string;
      readonly arguments: string;
    }
  | {
      readonly type: "custom_tool_call";
      readonly call_id: string;
      readonly name: string;
      readonly input: string;
    }
  | {
      readonly type: "tool_search_call";
      readonly call_id: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Translate one exact runtime invocation back into the Native Responses tool-call shape. */
export function encodeNativeToolInvocation(
  tool: NativeToolCatalogEntry,
  invocation: NativeToolInvocation,
): NativeResponsesToolCallItem {
  if (tool.wireName !== invocation.wireName) {
    throw new Error("native tool invocation does not match its descriptor");
  }

  if (tool.kind === "freeform") {
    if (invocation.mode !== "freeform") {
      throw new Error("native freeform invocation is missing raw input");
    }
    return Object.freeze({
      type: "custom_tool_call" as const,
      call_id: invocation.callId,
      name: tool.name,
      input: invocation.input,
    });
  }

  if (tool.kind === "function") {
    if (invocation.mode !== "structured") {
      throw new Error("native function invocation is missing structured arguments");
    }
    return Object.freeze({
      type: "function_call" as const,
      call_id: invocation.callId,
      name: tool.name,
      ...(tool.namespace ? { namespace: tool.namespace } : {}),
      arguments: JSON.stringify(invocation.arguments),
    });
  }

  if (tool.kind === "discovery") {
    if (invocation.mode !== "structured") {
      throw new Error("native discovery invocation is missing structured arguments");
    }
    return Object.freeze({
      type: "tool_search_call" as const,
      call_id: invocation.callId,
      arguments: Object.freeze({ ...invocation.arguments }),
    });
  }

  throw new Error(`native tool transport codec is not defined for kind ${tool.kind}`);
}

/**
 * Extract tool results carried by a later Native Responses request. Binding/turn ownership must be
 * proven separately before these results are accepted by the runtime channel.
 */
export function extractNativeToolResults(value: unknown): readonly NativeToolResult[] {
  const body = record(value);
  if (!body || !Array.isArray(body.input)) return [];
  const results: NativeToolResult[] = [];

  for (const value of body.input) {
    const item = record(value);
    if (!item || typeof item.call_id !== "string" || item.call_id.trim().length === 0) continue;
    if (item.type === "tool_search_output") {
      const status = typeof item.status === "string" ? item.status : "unknown";
      const tools = Array.isArray(item.tools) ? item.tools : [];
      results.push(Object.freeze({
        callId: item.call_id,
        content: Object.freeze({ status, tools: Object.freeze([...tools]) }),
        isError: status !== "completed" && status !== "success",
      }));
      continue;
    }
    if (item.type !== "function_call_output" && item.type !== "custom_tool_call_output") continue;
    results.push(Object.freeze({
      callId: item.call_id,
      content: item.output ?? "",
      isError: false,
    }));
  }

  return Object.freeze(results);
}

import { describe, expect, test } from "bun:test";
import type { NativeToolCatalogEntry } from "@chatgpt-tela/core";
import { encodeNativeToolInvocation, extractNativeToolResults } from "./tool-codec";

function tool(input: Partial<NativeToolCatalogEntry> & Pick<NativeToolCatalogEntry, "wireName" | "name" | "kind">): NativeToolCatalogEntry {
  return {
    description: "",
    observedFrom: ["fixture"],
    ...input,
  };
}

describe("Native Responses tool codec", () => {
  test("encodes a namespaced function with explicit namespace rather than reparsing its wire name", () => {
    expect(encodeNativeToolInvocation(
      tool({ wireName: "github__search", name: "search", namespace: "github", kind: "function" }),
      { callId: "call-1", wireName: "github__search", mode: "structured", arguments: { query: "ChatGPT Tela" } },
    )).toEqual({
      type: "function_call",
      call_id: "call-1",
      name: "search",
      namespace: "github",
      arguments: JSON.stringify({ query: "ChatGPT Tela" }),
    });
  });

  test("encodes freeform tools as custom_tool_call", () => {
    expect(encodeNativeToolInvocation(
      tool({ wireName: "apply_patch", name: "apply_patch", kind: "freeform" }),
      { callId: "call-1", wireName: "apply_patch", mode: "freeform", input: "*** Begin Patch" },
    )).toEqual({
      type: "custom_tool_call",
      call_id: "call-1",
      name: "apply_patch",
      input: "*** Begin Patch",
    });
  });

  test("encodes tool discovery with its dedicated Native wire shape", () => {
    expect(encodeNativeToolInvocation(
      tool({ wireName: "tool_search", name: "tool_search", kind: "discovery" }),
      { callId: "search-1", wireName: "tool_search", mode: "structured", arguments: { query: "github" } },
    )).toEqual({
      type: "tool_search_call",
      call_id: "search-1",
      arguments: { query: "github" },
    });
  });

  test("extracts only Native tool result items from a later request", () => {
    expect(extractNativeToolResults({
      input: [
        { type: "message", role: "user", content: "continue" },
        { type: "function_call_output", call_id: "call-1", output: "ok" },
        { type: "custom_tool_call_output", call_id: "call-2", output: [{ type: "input_text", text: "patched" }] },
        { type: "tool_search_output", call_id: "call-3", status: "completed", tools: [{ type: "function", name: "later" }] },
      ],
    })).toEqual([
      { callId: "call-1", content: "ok", isError: false },
      { callId: "call-2", content: [{ type: "input_text", text: "patched" }], isError: false },
      {
        callId: "call-3",
        content: { status: "completed", tools: [{ type: "function", name: "later" }] },
        isError: false,
      },
    ]);
  });

  test("does not invent a codec for future tool semantics", () => {
    expect(() => encodeNativeToolInvocation(
      tool({ wireName: "future", name: "future", kind: "other" }),
      { callId: "call-1", wireName: "future", mode: "structured", arguments: {} },
    )).toThrow("codec is not defined");
  });
});

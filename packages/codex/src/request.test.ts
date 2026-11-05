import { describe, expect, test } from "bun:test";
import { parseNativeRequestIdentity, parseNativeTurnClaim, parseNativeTurnReplayIdentity } from "./request";
import { NativeToolInventory } from "@chatgpt-tela/core";

function body(metadata: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return {
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify(metadata),
    },
    ...extra,
  };
}

describe("native Codex request adapter", () => {
  test("preserves official deferred Native function definitions as discovery hints", () => {
    const claim = parseNativeTurnClaim(body({
      request_kind: "turn", thread_id: "thread-1", turn_id: "turn-1",
    }, { input: [{ type: "additional_tools", tools: [{
      type: "namespace", name: "functions", tools: [{ type: "function", name: "later",
        description: "Deferred", defer_loading: true, parameters: { type: "object", properties: { id: { type: "string" } } } },
        { type: "function", name: "ready", defer_loading: false, parameters: { type: "object" } }],
    }] }] }));
    const tools = claim.toolObservations[0]!.tools;
    expect(tools).toMatchObject([
      { wireName: "later", deferLoading: true, inputSchema: { type: "object", properties: { id: { type: "string" } } } },
      { wireName: "ready" },
    ]);
    expect("deferLoading" in tools[1]!).toBe(false);
  });
  test("official additional_tools and tool_search_output hint variants share one Native identity", () => {
    const definition = { type: "function", name: "find_event", description: "Calendar lookup",
      parameters: { type: "object", properties: { id: { type: "string" } } } };
    for (const discovered of [{ ...definition, defer_loading: true }, definition,
      { ...definition, defer_loading: false }]) {
      const claim = parseNativeTurnClaim(body({
        request_kind: "turn", thread_id: "thread-1", turn_id: "turn-1",
      }, { input: [
        { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "functions",
          tools: [{ ...definition, defer_loading: true }] }] },
        { type: "tool_search_output", call_id: "search-1", status: "completed", execution: "client",
          tools: [discovered] },
      ] }));
      const inventory = NativeToolInventory.fromObservations("thread-1", "turn-1", claim.toolObservations);
      expect(inventory.list()).toHaveLength(1);
      expect(inventory.exact("find_event")).toMatchObject({
        name: "find_event", deferLoading: true,
        observedFrom: ["request.input.additional_tools:0", "request.input.tool_search_output:1"],
        inputSchema: definition.parameters,
      });
    }
  });
  test("metadata-only attribution distinguishes compaction without expanding replay authority or reading history", () => {
    const value = body({request_kind:"compaction",thread_id:"thread-1",turn_id:"turn-1"}) as Record<string, unknown>;
    Object.defineProperty(value, "input", {get() { throw Error("history must not be read"); }});
    Object.defineProperty(value, "tools", {get() { throw Error("tool catalog must not be read"); }});
    expect(parseNativeRequestIdentity(value)).toEqual({requestKind:"compaction",threadId:"thread-1",turnId:"turn-1"});
    expect(() => parseNativeTurnReplayIdentity(value)).toThrow("not a current turn");
  });
  test("parses current-turn identity without treating request environment fields as authority", () => {
    const claim = parseNativeTurnClaim(body({
      request_kind: "turn",
      thread_id: "thread-1",
      turn_id: "turn-1",
      cwd: "/untrusted/request/path",
      sandbox_policy: { type: "danger-full-access" },
    }));

    expect(claim.threadId).toBe("thread-1");
    expect(claim.turnId).toBe("turn-1");
    expect("cwd" in claim).toBe(false);
  });

  test("observes body, additional, namespace, and future named tools dynamically", () => {
    const claim = parseNativeTurnClaim(body({
      request_kind: "turn",
      thread_id: "thread-1",
      turn_id: "turn-1",
    }, {
      tools: [
        { type: "function", name: "exec_command", description: "command", parameters: { type: "object" } },
        { type: "custom", name: "apply_patch", description: "patch" },
        { type: "mystery_future_tool", name: "future_tool", description: "future" },
      ],
      input: [{
        type: "additional_tools",
        tools: [{
          type: "namespace",
          name: "github",
          tools: [{ type: "function", name: "search", description: "search" }],
        }],
      }, {
        type: "tool_search_output",
        call_id: "search-1",
        status: "completed",
        tools: [{ type: "function", name: "deferred_tool", description: "loaded later" }],
      }],
    }));

    expect(claim.toolObservations.flatMap(observation => observation.tools).map(tool => [tool.wireName, tool.kind]))
      .toEqual([
        ["exec_command", "function"],
        ["apply_patch", "freeform"],
        ["future_tool", "other"],
        ["github__search", "function"],
        ["deferred_tool", "function"],
      ]);
  });

  test("rejects non-turn requests at the current-turn boundary", () => {
    expect(() => parseNativeTurnClaim(body({
      request_kind: "compaction",
      thread_id: "thread-1",
      turn_id: "turn-1",
    }))).toThrow("not a current turn");
  });
});

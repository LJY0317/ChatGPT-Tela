import { describe, expect, test } from "bun:test";
import { NativeToolInventory, type NativeToolDescriptor } from "./tools";

function tool(wireName: string): NativeToolDescriptor {
  return {
    wireName,
    name: wireName,
    description: `Runtime tool ${wireName}`,
    kind: "function",
    inputSchema: { type: "object" },
  };
}

describe("native tool inventory", () => {
  test("deferred discovery hints do not become Tela-side execution restrictions or descriptor conflicts", () => {
    const deferred: NativeToolDescriptor = { ...tool("later"), deferLoading: true };
    const other = tool("ready");
    const initial = NativeToolInventory.fromObservations("thread-1", "turn-1", [
      { source: "request.input.additional_tools:0", tools: [deferred, other] },
    ]);
    expect(initial.list().map(item => item.wireName)).toEqual(["later", "ready"]);
    expect(initial.search("").map(item => item.wireName)).toEqual(["later", "ready"]);
    expect(initial.search("later").map(item => item.wireName)).toEqual(["later"]);
    expect(initial.exact("later")?.deferLoading).toBe(true);
    // Official tool_search_output can retain true; omitted/false variants must
    // still match the same definition without inventing a new authorization.
    for (const returned of [{ ...tool("later"), deferLoading: true },
      { ...tool("later") }, { ...tool("later"), deferLoading: false }]) {
      for (const reversed of [false, true]) {
        const observations = [
          { source: "request.input.additional_tools:0", tools: [deferred, other] },
          { source: "request.input.tool_search_output:1", tools: [returned] },
        ];
        const merged = NativeToolInventory.fromObservations("thread-1", "turn-1",
          reversed ? observations.reverse() : observations);
        expect(merged.exact("later")).toMatchObject({
          wireName: "later", deferLoading: true, inputSchema: { type: "object" },
        });
        expect(merged.search("later").map(item => item.wireName)).toEqual(["later"]);
      }
    }
  });
  test("accepts arbitrary current-turn and runtime-discovered tools without a hardcoded catalog", () => {
    const inventory = NativeToolInventory.fromObservations("thread-1", "turn-1", [
      { source: "current-turn", tools: [tool("exec_command")] },
      { source: "runtime-discovery", tools: [tool("future_namespace__brand_new_tool")] },
    ]);

    expect(inventory.list().map(entry => entry.wireName)).toEqual([
      "exec_command",
      "future_namespace__brand_new_tool",
    ]);
    expect(inventory.exact("future_namespace__brand_new_tool")?.observedFrom)
      .toEqual(["runtime-discovery"]);
  });

  test("merges identical observations and preserves provenance", () => {
    const inventory = NativeToolInventory.fromObservations("thread-1", "turn-1", [
      { source: "current-turn", tools: [tool("example")] },
      { source: "gateway", tools: [tool("example")] },
    ]);

    expect(inventory.exact("example")?.observedFrom).toEqual(["current-turn", "gateway"]);
  });

  test("fails closed when two native sources disagree about one wire identity", () => {
    expect(() => NativeToolInventory.fromObservations("thread-1", "turn-1", [
      { source: "current-turn", tools: [tool("example")] },
      { source: "gateway", tools: [{ ...tool("example"), description: "different contract" }] },
    ])).toThrow("conflicting native tool descriptor");
  });
});

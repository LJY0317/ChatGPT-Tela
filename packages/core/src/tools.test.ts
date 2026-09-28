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

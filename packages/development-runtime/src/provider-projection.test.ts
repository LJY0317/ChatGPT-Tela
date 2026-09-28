import { describe, expect, test } from "bun:test";
import { projectFreshWebPhysicalContext } from "./provider-projection";

describe("fresh Web provider projection", () => {
  test("bounds settled assistant/tool evidence while preserving authority, tool linkage, registry and active request", () => {
    const hugeAssistant = "A".repeat(30_000);
    const hugeToolOutput = "T".repeat(10_000);
    const context = {
      headRevisionId: "user-current",
      activeRequestRevisionId: "user-current",
      mode: "full" as const,
      logicalTokens: 99999,
      transferTokens: 99999,
      segments: [
        { type: "revision" as const, revisionId: "sys", kind: "system" as const, content: "SYSTEM EXACT" },
        { type: "revision" as const, revisionId: "dev", kind: "developer" as const, content: "DEVELOPER EXACT" },
        { type: "revision" as const, revisionId: "user-old", kind: "user" as const, content: "USER EXACT" },
        { type: "revision" as const, revisionId: "call", kind: "tool-call" as const, content: '{"call_id":"c1","arguments":"STRUCTURE EXACT"}' },
        { type: "revision" as const, revisionId: "result", kind: "tool-result" as const,
          content: JSON.stringify({ type: "function_call_output", call_id: "c1", output: hugeToolOutput }) },
        { type: "revision" as const, revisionId: "search", kind: "tool-result" as const,
          content: JSON.stringify({ type: "tool_search_output", call_id: "s1", tools: [{ name: "exact_registry" }] }) },
        { type: "revision" as const, revisionId: "assistant", kind: "assistant" as const, content: hugeAssistant },
        { type: "revision" as const, revisionId: "user-current", kind: "user" as const, content: "CURRENT USER EXACT" },
      ],
    };

    const projected = projectFreshWebPhysicalContext(context);
    expect(projected.context.logicalTokens).toBe(99999);
    expect(projected.context.transferTokens).toBeLessThan(99999);
    const serialized = JSON.stringify(projected.context);
    expect(serialized).toContain("SYSTEM EXACT");
    expect(serialized).toContain("DEVELOPER EXACT");
    expect(serialized).toContain("USER EXACT");
    expect(serialized).toContain("STRUCTURE EXACT");
    expect(serialized).toContain("exact_registry");
    expect(serialized).toContain("CURRENT USER EXACT");
    expect(serialized).not.toContain(hugeToolOutput);
    expect(serialized).not.toContain(hugeAssistant);
    expect(projected.stats.truncatedToolResults).toBe(1);
    expect(projected.stats.truncatedAssistantRevisions).toBe(1);
  });

  test("never projects retained delta a second time", () => {
    const context = {
      headRevisionId: "r2",
      baseRevisionId: "r1",
      activeRequestRevisionId: "r2",
      mode: "retained-delta" as const,
      logicalTokens: 100000,
      transferTokens: 5,
      segments: [{ type: "revision" as const, revisionId: "r2", kind: "user" as const, content: "exact suffix" }],
    };
    expect(projectFreshWebPhysicalContext(context).context).toBe(context);
  });
});

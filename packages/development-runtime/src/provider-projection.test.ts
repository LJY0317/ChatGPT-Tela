import { describe, expect, test } from "bun:test";
import {
  fitFreshWebPhysicalContext,
  projectFreshWebPhysicalContext,
} from "./provider-projection";

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

  test("hard-fit maximizes reducible evidence while bringing a fresh projection under the soft limit", () => {
    const context = {
      headRevisionId: "user-current",
      activeRequestRevisionId: "user-current",
      mode: "full" as const,
      logicalTokens: 130_000,
      transferTokens: 130_000,
      segments: [
        { type: "revision" as const, revisionId: "sys", kind: "system" as const, content: "S".repeat(340_000) },
        { type: "revision" as const, revisionId: "assistant-1", kind: "assistant" as const, content: "A".repeat(120_000) },
        { type: "revision" as const, revisionId: "assistant-2", kind: "assistant" as const, content: "B".repeat(120_000) },
        { type: "revision" as const, revisionId: "assistant-3", kind: "assistant" as const, content: "C".repeat(120_000) },
        { type: "revision" as const, revisionId: "assistant-4", kind: "assistant" as const, content: "D".repeat(120_000) },
        { type: "revision" as const, revisionId: "result", kind: "tool-result" as const,
          content: JSON.stringify({ type: "function_call_output", call_id: "c1", output: "T".repeat(80_000) }) },
        { type: "revision" as const, revisionId: "user-current", kind: "user" as const, content: "continue" },
      ],
    };
    const initial = projectFreshWebPhysicalContext(context);
    expect(initial.context.transferTokens).toBeGreaterThanOrEqual(95_000);
    const fit = fitFreshWebPhysicalContext(context, {
      rolloverTokenLimit: 95_000,
      contextWindowTokenLimit: 111_193,
    });
    expect(fit.context.transferTokens).toBeLessThan(95_000);
    expect(fit.stats.fitTarget).toBe("soft");
    expect(fit.stats.retentionStep).toBeGreaterThan(0);
    expect(fit.stats.retentionStep).toBeLessThan(1_024);
    expect(fit.context.logicalTokens).toBe(130_000);
    expect(JSON.stringify(fit.context)).toContain("continue");
  });

  test("when irreducible authority already exceeds soft pressure, hard-fit uses only the remaining hard window", () => {
    const context = {
      headRevisionId: "user-current",
      activeRequestRevisionId: "user-current",
      mode: "full" as const,
      logicalTokens: 150_000,
      transferTokens: 150_000,
      segments: [
        { type: "revision" as const, revisionId: "sys", kind: "system" as const, content: "S".repeat(392_000) },
        { type: "revision" as const, revisionId: "assistant-1", kind: "assistant" as const, content: "A".repeat(120_000) },
        { type: "revision" as const, revisionId: "assistant-2", kind: "assistant" as const, content: "B".repeat(120_000) },
        { type: "revision" as const, revisionId: "assistant-3", kind: "assistant" as const, content: "C".repeat(120_000) },
        { type: "revision" as const, revisionId: "assistant-4", kind: "assistant" as const, content: "D".repeat(120_000) },
        { type: "revision" as const, revisionId: "user-current", kind: "user" as const, content: "continue" },
      ],
    };
    const fit = fitFreshWebPhysicalContext(context, {
      rolloverTokenLimit: 95_000,
      contextWindowTokenLimit: 111_193,
    });
    expect(fit.context.transferTokens).toBeGreaterThanOrEqual(95_000);
    expect(fit.context.transferTokens).toBeLessThan(111_193);
    expect(fit.stats.fitTarget).toBe("hard");
    expect(fit.stats.retentionStep).toBeLessThan(1_024);
  });

  test("hard-fit refuses to delete irreducible Native authority when even step zero exceeds the Web window", () => {
    const context = {
      headRevisionId: "user-current",
      activeRequestRevisionId: "user-current",
      mode: "full" as const,
      logicalTokens: 120_000,
      transferTokens: 120_000,
      segments: [
        { type: "revision" as const, revisionId: "sys", kind: "system" as const, content: "S".repeat(450_000) },
        { type: "revision" as const, revisionId: "assistant", kind: "assistant" as const, content: "A".repeat(80_000) },
        { type: "revision" as const, revisionId: "user-current", kind: "user" as const, content: "continue" },
      ],
    };
    expect(() => fitFreshWebPhysicalContext(context, {
      rolloverTokenLimit: 95_000,
      contextWindowTokenLimit: 111_193,
    })).toThrow("Native context was left unchanged");
  });
});

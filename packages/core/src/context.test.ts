import { describe, expect, test } from "bun:test";
import { RevisionLineage, planPhysicalContext, type LogicalRevision } from "./context";

function revision(
  id: string,
  parentId: string | null,
  estimatedTokens: number,
  kind: LogicalRevision["kind"] = "user",
): LogicalRevision {
  return { id, parentId, kind, estimatedTokens, contentRef: `native:${id}` };
}

describe("context planning", () => {
  test("steering follows the selected lineage and excludes the superseded branch", () => {
    const lineage = new RevisionLineage([
      revision("r1", null, 100),
      revision("r2", "r1", 200, "assistant"),
      revision("old", "r2", 300),
      revision("steer", "r2", 40, "steering"),
      revision("head", "steer", 80),
    ]);

    const plan = planPhysicalContext({ lineage, headId: "head" });
    expect(plan.status).toBe("ready");
    expect(plan.logicalRevisionIds).toEqual(["r1", "r2", "steer", "head"]);
    expect(plan.logicalRevisionIds).not.toContain("old");
  });

  test("a checkpoint reduces physical transfer without changing logical context", () => {
    const lineage = new RevisionLineage([
      revision("r1", null, 1000),
      revision("r2", "r1", 1200, "assistant"),
      revision("r3", "r2", 300),
    ]);

    const full = planPhysicalContext({ lineage, headId: "r3" });
    const compact = planPhysicalContext({
      lineage,
      headId: "r3",
      checkpoint: { id: "cp1", revisionId: "r2", estimatedTokens: 250, projectionRef: "checkpoint:cp1" },
    });

    expect(full.status).toBe("ready");
    expect(compact.status).toBe("ready");
    if (full.status !== "ready" || compact.status !== "ready") throw new Error("expected ready plans");
    expect(compact.logicalRevisionIds).toEqual(full.logicalRevisionIds);
    expect(compact.logicalTokens).toBe(full.logicalTokens);
    expect(compact.physicalRevisionIds).toEqual(["r3"]);
    expect(compact.transferTokens).toBe(550);
    expect(compact.transferTokens).toBeLessThan(full.transferTokens);
  });

  test("ignores a checkpoint from a superseded branch instead of treating cache state as authority", () => {
    const lineage = new RevisionLineage([
      revision("root", null, 10),
      revision("old", "root", 10),
      revision("new", "root", 10, "steering"),
    ]);

    const plan = planPhysicalContext({
      lineage,
      headId: "new",
      checkpoint: { id: "stale", revisionId: "old", estimatedTokens: 1, projectionRef: "checkpoint:stale" },
    });

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") throw new Error("expected ready plan");
    expect(plan.mode).toBe("full");
    expect(plan.logicalRevisionIds).toEqual(["root", "new"]);
  });

  test("requests compaction instead of silently dropping context when no complete plan fits", () => {
    const lineage = new RevisionLineage([revision("r1", null, 1000)]);
    expect(planPhysicalContext({ lineage, headId: "r1", budgetTokens: 100 })).toEqual({
      status: "checkpoint-required",
      headId: "r1",
      logicalRevisionIds: ["r1"],
      logicalTokens: 1000,
      budgetTokens: 100,
    });
  });
});

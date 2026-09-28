import { describe, expect, test } from "bun:test";
import {
  RevisionLineage,
  type ContextCheckpoint,
  type LogicalRevision,
} from "@chatgpt-tela/core";
import { prepareWebContext, type ContextProjectionSource } from "./context";

function revision(
  id: string,
  parentId: string | null,
  estimatedTokens: number,
  kind: LogicalRevision["kind"] = "user",
): LogicalRevision {
  return { id, parentId, kind, estimatedTokens, contentRef: `native:${id}` };
}

describe("runtime Web context preparation", () => {
  test("materializes only checkpoint plus delta for a compact physical plan", async () => {
    const lineage = new RevisionLineage([
      revision("r1", null, 1000),
      revision("r2", "r1", 900, "assistant"),
      revision("r3", "r2", 100),
    ]);
    const checkpoint: ContextCheckpoint = {
      id: "cp1",
      revisionId: "r2",
      estimatedTokens: 180,
      projectionRef: "checkpoint:cp1",
    };
    const loaded: string[] = [];
    const source: ContextProjectionSource = {
      async revisionContent(value) {
        loaded.push(`revision:${value.id}`);
        return `content:${value.id}`;
      },
      async checkpointContent(value) {
        loaded.push(`checkpoint:${value.id}`);
        return "compact summary";
      },
    };

    const prepared = await prepareWebContext({
      lineage,
      headId: "r3",
      checkpoint,
      budgetTokens: 500,
      source,
    });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("expected ready context");
    expect(prepared.physicalContext.mode).toBe("checkpoint-delta");
    expect(prepared.physicalContext.logicalTokens).toBe(2000);
    expect(prepared.physicalContext.transferTokens).toBe(280);
    expect(prepared.physicalContext.segments).toEqual([
      {
        type: "checkpoint",
        checkpointId: "cp1",
        sourceRevisionId: "r2",
        content: "compact summary",
      },
      {
        type: "revision",
        revisionId: "r3",
        kind: "user",
        content: "content:r3",
      },
    ]);
    expect(loaded).toEqual(["checkpoint:cp1", "revision:r3"]);
  });

  test("does not load any content when a new checkpoint is required", async () => {
    const lineage = new RevisionLineage([revision("r1", null, 1000)]);
    let reads = 0;
    const source: ContextProjectionSource = {
      async revisionContent() { reads += 1; return "unused"; },
      async checkpointContent() { reads += 1; return "unused"; },
    };

    const prepared = await prepareWebContext({
      lineage,
      headId: "r1",
      budgetTokens: 100,
      source,
    });

    expect(prepared).toEqual({
      status: "checkpoint-required",
      headId: "r1",
      logicalRevisionIds: ["r1"],
      logicalTokens: 1000,
      budgetTokens: 100,
    });
    expect(reads).toBe(0);
  });

  test("a stale checkpoint cannot remove the active steering branch", async () => {
    const lineage = new RevisionLineage([
      revision("root", null, 10),
      revision("old", "root", 20, "assistant"),
      revision("steer", "root", 5, "steering"),
    ]);
    const source: ContextProjectionSource = {
      async revisionContent(value) { return value.id; },
      async checkpointContent() { return "stale"; },
    };

    const prepared = await prepareWebContext({
      lineage,
      headId: "steer",
      checkpoint: {
        id: "old-cp",
        revisionId: "old",
        estimatedTokens: 1,
        projectionRef: "checkpoint:old",
      },
      source,
    });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("expected ready context");
    expect(prepared.physicalContext.mode).toBe("full");
    expect(prepared.physicalContext.segments.map(segment => (
      segment.type === "revision" ? segment.revisionId : segment.checkpointId
    ))).toEqual(["root", "steer"]);
  });
});

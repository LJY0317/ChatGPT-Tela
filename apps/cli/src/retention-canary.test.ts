import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeRetentionCanary } from "./retention-canary";

describe("retained-context passive live canary", () => {
  test("passes only on exact retained-delta plus retained-surface evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-retention-canary-"));
    const path = join(root, "codex.diagnostics.jsonl");
    const now = Date.parse("2026-09-29T04:00:00.000Z");
    writeFileSync(path, [
      { ts: "2026-09-29T03:50:00.000Z", event: "chatgpt_tela_work", stage: "web_turn_plan",
        context_mode: "full", logical_estimate: 40_000, transfer_estimate: 20_000, retained_surface: false,
        retained_delta: false, physical_rollover: false },
      { ts: "2026-09-29T03:52:00.000Z", event: "chatgpt_tela_work", stage: "web_turn_plan",
        context_mode: "retained-delta", logical_estimate: 44_000, transfer_estimate: 1_500, retained_surface: true,
        retained_delta: true, physical_rollover: false },
      { ts: "2026-09-29T03:55:00.000Z", event: "chatgpt_tela_work", stage: "web_turn_plan",
        context_mode: "full", logical_estimate: 80_000, transfer_estimate: 18_000, retained_surface: false,
        retained_delta: false, physical_rollover: true,
        previous_epoch_input_estimate: 93_000, previous_epoch_rollover_limit: 90_000 },
      { ts: "2026-09-29T02:00:00.000Z", event: "chatgpt_tela_work", stage: "web_turn_plan",
        context_mode: "retained-delta", retained_surface: true, logical_estimate: 999_999, transfer_estimate: 1 },
      { ts: "2026-09-29T03:58:00.000Z", event: "other", stage: "web_turn_plan", content: "private" },
    ].map(item => JSON.stringify(item)).join("\n") + "\n");
    try {
      const result = summarizeRetentionCanary({ paths: [path], minutes: 15, nowMs: now });
      expect(result).toMatchObject({
        status: "pass",
        privacy: "structural-retention-diagnostics-only",
        contentRead: false,
        pathsEmitted: false,
        mutating: false,
        evidence: {
          workTurnPlans: 3,
          freshPlans: 2,
          retainedDeltaPlans: 1,
          retainedSurfacePlans: 1,
          provenRetainedPlans: 1,
          physicalRollovers: 1,
          maxLogicalTokens: 80_000,
          maxTransferTokens: 20_000,
          maxRetainedLogicalTokens: 44_000,
          minRetainedTransferTokens: 1_500,
          latestRolloverPressure: { estimatedTokens: 93_000, rolloverLimitTokens: 90_000 },
        },
        latestRetainedProofAt: "2026-09-29T03:52:00.000Z",
      });
      expect(JSON.stringify(result)).not.toContain("private");
      expect(JSON.stringify(result)).not.toContain("999999");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports not-observed without treating lack of evidence as a failure", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-retention-canary-empty-"));
    const path = join(root, "codex.diagnostics.jsonl");
    const now = Date.parse("2026-09-29T04:00:00.000Z");
    writeFileSync(path, JSON.stringify({
      ts: "2026-09-29T03:59:00.000Z",
      event: "chatgpt_tela_work",
      stage: "web_turn_plan",
      context_mode: "full",
      retained_surface: false,
      retained_delta: false,
      logical_estimate: 1_000,
      transfer_estimate: 1_000,
    }) + "\n");
    try {
      const result = summarizeRetentionCanary({ paths: [path], minutes: 15, nowMs: now });
      expect(result).toMatchObject({
        status: "not-observed",
        evidence: { workTurnPlans: 1, provenRetainedPlans: 0 },
      });
      expect((result.interpretation as string)).toContain("second turn in the same Work task");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an unbounded observation window", () => {
    expect(() => summarizeRetentionCanary({ paths: [], minutes: 121 })).toThrow("1 to 120");
  });
});

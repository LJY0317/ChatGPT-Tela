import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeDiagnosticWorkload } from "./diagnostic-workload";

describe("diagnostic workload summary", () => {
  test("aggregates only structural recent Chat/Codex payload sizes without returning content", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-diagnostic-workload-"));
    const path = join(root, "chat.diagnostics.jsonl");
    const now = Date.parse("2026-09-29T04:00:00.000Z");
    writeFileSync(path, [
      { ts: "2026-09-29T03:50:00.000Z", event: "chatgpt_tela_chat", stage: "capability_call_complete",
        capability: "read_many", result_bytes: 70_000, has_more: true },
      { ts: "2026-09-29T03:55:00.000Z", event: "chatgpt_tela_codex", stage: "tool_invoke_complete",
        result_bytes: 300_000, request_bytes: 4_000, is_error: false },
      { ts: "2026-09-29T02:00:00.000Z", event: "chatgpt_tela_chat", stage: "capability_call_complete",
        capability: "read", result_bytes: 999_999 },
      { event: "chatgpt_tela_chat", stage: "capability_call_complete", capability: "read", result_bytes: 12 },
    ].map(item => JSON.stringify(item)).join("\n") + "\n");
    try {
      const summary = summarizeDiagnosticWorkload({ paths: [path], minutes: 15, nowMs: now });
      expect(summary).toMatchObject({
        privacy: "structural-counts-and-byte-sizes-only",
        contentRead: false,
        pathsEmitted: false,
        combined: { calls: 2, resultBytes: 370_000, maxResultBytes: 300_000, largeResults64KiB: 2, largeResults256KiB: 1 },
        chat: { calls: 1, resultBytes: 70_000, boundedReadsWithMore: 1,
          byCapability: { read_many: { calls: 1, resultBytes: 70_000 } } },
        codex: { calls: 1, resultBytes: 300_000, requestBytes: 4_000, errorCalls: 0 },
        events: { scanned: 4, inWindow: 2, withoutTimestamp: 1, missingResultSize: 0 },
      });
      expect(JSON.stringify(summary)).not.toContain("999999");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

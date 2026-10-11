import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateDiagnosticCaptureEnabled } from "@chatgpt-tela/core";
import { runPackagedDiagnosticsCommand } from "./diagnostics";

test("packaged diagnostics rejects malformed capture without changing capture policy", () => {
  const logsRoot = mkdtempSync(join(tmpdir(), "tela-packaged-diagnostics-"));
  try {
    for (const args of [
      ["diagnostics", "capture", "--minutes"],
      ["diagnostics", "capture", "--minutes", "2", "--minutes", "3"],
      ["diagnostics", "capture", "--path", "/outside"],
      ["diagnostics", "capture", "--mode", "unknown"],
      ["diagnostics", "capture", "--mode", "until-disabled", "--minutes", "1"],
      ["diagnostics", "unknown"],
    ]) expect(() => runPackagedDiagnosticsCommand(args, { logsRoot })).toThrow();
    expect(existsSync(join(logsRoot, "diagnostics", "capture-policy.json"))).toBe(false);
    runPackagedDiagnosticsCommand(["diagnostics", "capture", "--minutes", "2"], { logsRoot });
    expect(privateDiagnosticCaptureEnabled(join(logsRoot, "diagnostics"))).toBe(true);
    const result=runPackagedDiagnosticsCommand(["diagnostics", "capture", "--mode", "until-disabled"], { logsRoot });
    expect(result).toMatchObject({ enabled:true, mode:"until-disabled", privacy:"private-local-only" });
    expect(privateDiagnosticCaptureEnabled(join(logsRoot, "diagnostics"))).toBe(true);
    runPackagedDiagnosticsCommand(["diagnostics", "capture"], { logsRoot });
    expect(privateDiagnosticCaptureEnabled(join(logsRoot, "diagnostics"))).toBe(false);
  } finally { rmSync(logsRoot, { recursive: true, force: true }); }
});

test("packaged incidents use bounded product sources and never embed private payload", () => {
  const logsRoot = mkdtempSync(join(tmpdir(), "tela-packaged-diagnostics-"));
  try {
    writeFileSync(join(logsRoot, "codex.diagnostics.jsonl"), JSON.stringify({
      ts: "2026-10-08T00:00:00Z", event: "chatgpt_tela_work", stage: "web_turn_timeout",
      prompt: "synthetic private payload", url: "https://synthetic-private.example",
    }) + "\n");
    const record = runPackagedDiagnosticsCommand(["diagnostics", "record", "--at",
      "2026-10-08T00:00:01Z", "--symptom", "response-stalled"], { logsRoot }) as { ref: string };
    const inspected = JSON.stringify(runPackagedDiagnosticsCommand(
      ["diagnostics", "inspect", "--ref", record.ref], { logsRoot }));
    expect(inspected).toContain("web_turn_timeout");
    expect(inspected).not.toContain("synthetic private payload");
    expect(inspected).not.toContain("synthetic-private.example");
    expect(inspected).not.toContain(logsRoot);
    const list = runPackagedDiagnosticsCommand(["diagnostics"], { logsRoot }) as { incidents: unknown[] };
    expect(list.incidents).toHaveLength(1);
  } finally { rmSync(logsRoot, { recursive: true, force: true }); }
});

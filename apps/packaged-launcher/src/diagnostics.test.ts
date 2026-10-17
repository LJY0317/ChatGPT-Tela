import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateDiagnosticCaptureEnabled } from "@chatgpt-tela/core";
import { runPackagedDiagnosticsCommand } from "./diagnostics";

test("packaged context report is scoped, structural and read-only", () => {
  const logsRoot = mkdtempSync(join(tmpdir(), "tela-context-report-"));
  try {
    const scope = "1".repeat(24), other = "2".repeat(24);
    writeFileSync(join(logsRoot, "codex.diagnostics.jsonl"), [scope, other].map(scope_fingerprint => JSON.stringify({
      ts: "2026-10-16T00:00:00Z", event: "chatgpt_tela_work", stage: "web_turn_plan",
      scope_fingerprint, turn_fingerprint: "3".repeat(24), context_mode: "checkpoint-delta",
      logical_estimate: 200000, transfer_estimate: 8000, prompt: "PRIVATE_CONTENT",
    })).join("\n") + "\n");
    const before = readdirSync(logsRoot).sort();
    const report = runPackagedDiagnosticsCommand(["diagnostics", "context", "--scope", scope,
      "--at", "2026-10-16T00:01:00Z", "--minutes", "2"], { logsRoot }) as any;
    expect(report.turns).toHaveLength(1);
    expect(report.turns[0].scopeFingerprint).toBe(scope);
    expect(report.turns[0].plans[0].transferTokenEstimate).toBe(8000);
    expect(report.semanticRecall).toBe("not_evaluated");
    expect(JSON.stringify(report)).not.toContain("PRIVATE_CONTENT");
    expect(readdirSync(logsRoot).sort()).toEqual(before);
    const compact = runPackagedDiagnosticsCommand(["diagnostics", "context", "--scope", scope,
      "--at", "2026-10-16T00:01:00Z", "--minutes", "2", "--view", "summary", "--limit", "1"], {logsRoot}) as any;
    expect(compact.view).toBe("summary"); expect(compact.turns).toHaveLength(1);
    expect(compact.turns[0].plans).toBeUndefined(); expect(compact.sourceCoverage).toBeDefined();
    expect(() => runPackagedDiagnosticsCommand(["diagnostics", "context", "--view", "unknown"], {logsRoot})).toThrow();
    expect(() => runPackagedDiagnosticsCommand(["diagnostics", "context", "--limit", "65"], {logsRoot})).toThrow();
    expect(() => runPackagedDiagnosticsCommand(["diagnostics", "context", "--scope", "invalid"], { logsRoot })).toThrow();
    expect(() => runPackagedDiagnosticsCommand(["diagnostics", "context", "--minutes", "121"], { logsRoot })).toThrow();
  } finally { rmSync(logsRoot, { recursive: true, force: true }); }
});

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


test("packaged report origins are bounded and never claim host proof", () => {
  const logsRoot = mkdtempSync(join(tmpdir(), "tela-report-origin-"));
  const at = "2026-10-15T01:00:00.000Z";
  try {
    for (const [origin, expected] of [["worker-report", "worker-report"], ["user-observation", "user-observation"], ["host-error", "host-error"], [undefined, "unspecified"]] as const) {
      const args = ["diagnostics", "record", "--at", at, "--symptom", "tool-review-blocked"];
      if (origin) args.push("--report-origin", origin);
      const record = runPackagedDiagnosticsCommand(args, { logsRoot }) as { ref: string };
      const inspection = runPackagedDiagnosticsCommand(["diagnostics", "inspect", "--ref", record.ref], { logsRoot });
      expect(inspection).toMatchObject({ hostReported: { origin: expected, originProven: false } });
      const activity = runPackagedDiagnosticsCommand(["diagnostics", "activity", "--at", at, ...(origin ? ["--report-origin", origin] : [])], { logsRoot });
      expect(activity).toMatchObject({ hostReported: { origin: expected, originProven: false } });
    }
    expect((runPackagedDiagnosticsCommand(["diagnostics", "list"], { logsRoot }) as { incidents: unknown[] }).incidents.length).toBeGreaterThan(0);
    const before = readdirSync(join(logsRoot, "diagnostics", "incidents")).sort();
    for (const tail of [["--report-origin", "incorrect"], ["--report-origin"], ["--report-origin", "worker-report", "--report-origin", "host-error"]]) {
      expect(() => runPackagedDiagnosticsCommand(["diagnostics", "record", "--at", at, ...tail], { logsRoot })).toThrow();
    }
    expect(() => runPackagedDiagnosticsCommand(["diagnostics", "inspect", "--report-origin", "worker-report"], { logsRoot })).toThrow();
    expect(readdirSync(join(logsRoot, "diagnostics", "incidents")).sort()).toEqual(before);
    expect(existsSync(join(logsRoot, "diagnostics", "capture-policy.json"))).toBe(false);
  } finally { rmSync(logsRoot, { recursive: true, force: true }); }
});

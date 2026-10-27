import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticDurationMs, diagnosticFingerprint, emitDiagnosticEvent } from "./diagnostic-events";
import { diagnosticLogPaths, listDiagnosticIncidents } from "./diagnostic-store";

const originalDiagnosticFile = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;

afterEach(() => {
  if (originalDiagnosticFile === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = originalDiagnosticFile;
  delete process.env.CHATGPT_TELA_DIAGNOSTIC_MAX_BYTES;
});

describe("privacy-safe diagnostic events", () => {
  test("a short-lived worker rotates an oversized sink on its first event", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-short-lived-diagnostics-"));
    const path = join(root, "update.diagnostics.jsonl");
    try {
      writeFileSync(path, "x".repeat(65_537));
      const module = new URL("./diagnostic-events.ts", import.meta.url).href;
      const result = spawnSync(process.execPath, ["--eval",
        `import { emitDiagnosticEvent } from ${JSON.stringify(module)}; emitDiagnosticEvent("chatgpt_tela_update", "worker_started");`], {
        env: { ...process.env, CHATGPT_TELA_DIAGNOSTIC_FILE: path, CHATGPT_TELA_DIAGNOSTIC_MAX_BYTES: "65536" },
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(path, "utf8").trim()).stage).toBe("worker_started");
      expect(diagnosticLogPaths(path).filter(file => file !== path).map(file => readFileSync(file).length)).toEqual([65_537]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("ordinary auth renewal stays in events while destructive removal retains an incident", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-auth-incident-"));
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = join(root, "events.jsonl");
    try {
      emitDiagnosticEvent("chatgpt_tela_web_auth", "auth_entry_removed", { removal_cause: "overwrite", removed: true });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(listDiagnosticIncidents(join(root, "diagnostics"))).toHaveLength(0);
      emitDiagnosticEvent("chatgpt_tela_web_auth", "auth_entry_removed", { removal_cause: "expired", removed: true });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(listDiagnosticIncidents(join(root, "diagnostics"))).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("fingerprints correlate without returning the source value", () => {
    const value = "opaque-local-id";
    const fingerprint = diagnosticFingerprint(value);
    expect(fingerprint).toMatch(/^[a-f0-9]{24}$/);
    expect(fingerprint).not.toContain(value);
  });

  test("duration is bounded and never negative", () => {
    expect(diagnosticDurationMs(100, 160)).toBe(60);
    expect(diagnosticDurationMs(200, 100)).toBe(0);
  });

  test("sensitive field names are rejected without throwing to callers", () => {
    const directory = mkdtempSync(join(tmpdir(), "chatgpt-tela-diagnostics-filter-"));
    const path = join(directory, "diagnostics.jsonl");
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = path;
    try {
      emitDiagnosticEvent("chatgpt_tela_test", "safe_stage", { status: "ready", count: 2 });
      emitDiagnosticEvent("chatgpt_tela_test", "unsafe_stage", { prompt: "do not log me" });
      emitDiagnosticEvent("chatgpt_tela_test", "unsafe_stage", { local_path: "/private/user/path" });
    } finally {
      // afterEach restores the environment; remove the fixture after reading below.
    }
    const writes = readFileSync(path, "utf8").trim().split("\n");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!) as { ts?: string }).toMatchObject({
      ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(writes[0]).toContain('"status":"ready"');
    expect(writes[0]).not.toContain("do not log me");
    expect(writes[0]).not.toContain("/private/user/path");
    rmSync(directory, { recursive: true, force: true });
  });

  test("request lineage failure retains structural proof without payload", () => {
    const directory = mkdtempSync(join(tmpdir(), "tela-lineage-diagnostics-"));
    const path = join(directory, "diagnostics.jsonl");
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = path;
    try {
      emitDiagnosticEvent("chatgpt_tela_work", "web_turn_identity_rejected", {
        reason_class: "unproven_rekey", parent_user_present: false,
        parent_fingerprint_matches: false, matching_user_count: 1,
        user_count: 1, prior_user_present: true, new_lineage_count: 1,
      });
      expect(JSON.parse(readFileSync(path, "utf8").trim())).toMatchObject({
        stage: "web_turn_identity_rejected", parent_user_present: false,
        parent_fingerprint_matches: false, matching_user_count: 1,
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("configured JSONL sink receives only normalized safe events", () => {
    const directory = mkdtempSync(join(tmpdir(), "chatgpt-tela-diagnostics-"));
    const path = join(directory, "diagnostics.jsonl");
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = path;
    emitDiagnosticEvent("chatgpt_tela_test", "persisted", { status: "ready", count: 3 });
    emitDiagnosticEvent("chatgpt_tela_test", "blocked", { secret: "never-write" });
    const stored = readFileSync(path, "utf8");
    expect(JSON.parse(stored.trim()) as { ts?: string }).toMatchObject({
      ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(stored).toContain('"stage":"persisted"');
    expect(stored).toContain('"count":3');
    expect(stored).not.toContain("never-write");
    rmSync(directory, { recursive: true, force: true });
  });
});

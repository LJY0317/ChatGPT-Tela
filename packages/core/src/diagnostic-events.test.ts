import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticDurationMs, diagnosticFingerprint, emitDiagnosticEvent } from "./diagnostic-events";

const originalDiagnosticFile = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;

afterEach(() => {
  if (originalDiagnosticFile === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = originalDiagnosticFile;
  delete process.env.CHATGPT_TELA_DIAGNOSTIC_MAX_BYTES;
});

describe("privacy-safe diagnostic events", () => {
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
    const original = process.stderr.write;
    const writes: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      emitDiagnosticEvent("chatgpt_tela_test", "safe_stage", { status: "ready", count: 2 });
      emitDiagnosticEvent("chatgpt_tela_test", "unsafe_stage", { prompt: "do not log me" });
      emitDiagnosticEvent("chatgpt_tela_test", "unsafe_stage", { local_path: "/private/user/path" });
    } finally {
      process.stderr.write = original;
    }
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"status":"ready"');
    expect(writes[0]).not.toContain("do not log me");
    expect(writes[0]).not.toContain("/private/user/path");
  });

  test("configured JSONL sink receives only normalized safe events", () => {
    const directory = mkdtempSync(join(tmpdir(), "chatgpt-tela-diagnostics-"));
    const path = join(directory, "diagnostics.jsonl");
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = path;
    const original = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      emitDiagnosticEvent("chatgpt_tela_test", "persisted", { status: "ready", count: 3 });
      emitDiagnosticEvent("chatgpt_tela_test", "blocked", { secret: "never-write" });
    } finally {
      process.stderr.write = original;
    }
    const stored = readFileSync(path, "utf8");
    expect(stored).toContain('"stage":"persisted"');
    expect(stored).toContain('"count":3');
    expect(stored).not.toContain("never-write");
    rmSync(directory, { recursive: true, force: true });
  });
});

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatProcessManager } from "./processes";
import { ChatWorkspaceRegistry } from "./workspaces";

describe("Tela Chat failure-only process diagnostics", () => {
  test("full protected registry reports structural capacity occupancy without command or paths", async () => {
    const oldDiagnosticFile = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    const base = mkdtempSync(join(tmpdir(), "tela-capacity-diagnostic-"));
    const root = join(base, "project");
    const log = join(base, "safe-events.jsonl");
    const storePath = join(base, "operations.json");
    mkdirSync(root);
    const registry = new ChatWorkspaceRegistry({
      allowedRoots: [root], storePath: join(base, "workspaces.json"),
    });
    const workspace = registry.open(root);
    const old = "2000-01-01T00:00:00.000Z";
    const current = new Date().toISOString();
    const operations = Array.from({ length: 1024 }, (_, i) => ({
      operationId: randomUUID(), serverInstanceId: randomUUID(),
      workspaceId: workspace.id, sessionId: i + 1,
      state: i < 800 ? "unknown" : i < 824 ? "running" : "exited",
      startedAt: i < 824 ? old : current, updatedAt: i < 824 ? old : current,
      ...(i >= 824 ? { endedAt: current, exitCode: 0 } : {}),
    }));
    writeFileSync(storePath, JSON.stringify({ version: 1, nextSessionId: 1025, operations }));
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = log;
    let manager: ChatProcessManager | undefined;
    try {
      manager = new ChatProcessManager({ workspaces: registry, storePath });
      // Reservation admission must reject before starting a shell process.
      const privateCommand = "printf sensitive-command > should-not-exist.txt";
      await expect(manager.exec({ workspaceId: workspace.id, command: privateCommand }))
        .rejects.toThrow("at capacity");
      const output = readFileSync(log, "utf8");
      const matching = output.split("\n").filter(Boolean).map(line => JSON.parse(line))
        .filter(row => row.stage === "process_capacity_rejected");
      expect(matching).toHaveLength(1);
      expect(matching[0]).toMatchObject({
        reason_class: "capacity_exhausted", registry_count: 1024,
        registry_limit: 1024, unknown_count: 824, active_count: 0,
        terminal_recent_count: 200, terminal_expired_count: 0,
        scope_fingerprint: expect.stringMatching(/^[a-f0-9]{24}$/),
        operation_fingerprint: expect.stringMatching(/^[a-f0-9]{24}$/),
      });
      expect(output).not.toContain(privateCommand);
      expect(output).not.toContain(base);
      expect(output).not.toContain(workspace.id);
    } finally {
      if (oldDiagnosticFile === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = oldDiagnosticFile;
      await expect(manager!.close()).rejects.toThrow("unresolved execution");
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("malformed persisted state emits a fixed read-phase failure and preserves the evidence", () => {
    const oldDiagnosticFile = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    const base = mkdtempSync(join(tmpdir(), "tela-recovery-diagnostic-"));
    const root = join(base, "project");
    const log = join(base, "safe-events.jsonl");
    const storePath = join(base, "operations.json");
    mkdirSync(root);
    const registry = new ChatWorkspaceRegistry({
      allowedRoots: [root], storePath: join(base, "workspaces.json"),
    });
    const privateBytes = "not JSON /Users/private/secret-key=123";
    writeFileSync(storePath, privateBytes);
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = log;
    try {
      expect(() => new ChatProcessManager({ workspaces: registry, storePath })).toThrow();
      const output = readFileSync(log, "utf8");
      expect(output).toContain('"stage":"process_recovery_failed"');
      expect(output).toContain('"phase":"read"');
      expect(output).not.toContain(privateBytes);
      expect(readFileSync(storePath, "utf8")).toBe(privateBytes);
    } finally {
      if (oldDiagnosticFile === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = oldDiagnosticFile;
      rmSync(base, { recursive: true, force: true });
    }
  });
});

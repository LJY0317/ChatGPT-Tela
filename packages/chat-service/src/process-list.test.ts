import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ChatWorkspaceRegistry } from "./workspaces";
import { createChatToolRuntime } from "./tools";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "tela-process-list-"));
  const roots = [join(base, "first"), join(base, "second")];
  for (const root of roots) mkdirSync(root);
  const stateRoot = join(base, "state"), storePath = join(stateRoot, "process-operations-v1.json");
  mkdirSync(stateRoot);
  const registry = new ChatWorkspaceRegistry({ allowedRoots: roots, storePath: join(stateRoot, "workspaces-v1.json") });
  const first = registry.open(roots[0]!), second = registry.open(roots[1]!);
  const now = new Date().toISOString();
  const operations = Array.from({ length: 62 }, (_, i) => ({ operationId: randomUUID(),
    serverInstanceId: randomUUID(), workspaceId: i === 61 ? second.id : first.id,
    sessionId: i + 1, state: i === 60 ? "exited" : "running", startedAt: now, updatedAt: now,
    ...(i === 60 ? { endedAt: now, exitCode: 0 } : {}) }));
  writeFileSync(storePath, JSON.stringify({ version: 1, requestKey: "1".repeat(64), operations }));
  const runtime = createChatToolRuntime({ allowedRoots: roots, stateRoot });
  return { base, storePath, first, second, operations, runtime };
}

test("public registry discovery paginates unresolved work without cross-workspace data or replay", async () => {
  const f = fixture();
  try {
    expect(f.runtime.capabilities).toContain("list_processes");
    const before = readFileSync(f.storePath, "utf8");
    const first: any = await f.runtime.call("list_processes", { workspace_id: f.first.id, limit: 50 });
    expect(first.observation).toBe("registry"); expect(first.processes).toHaveLength(50);
    expect(first.nextAfterSessionId).toBe(50);
    const second: any = await f.runtime.call("list_processes", { workspace_id: f.first.id, after_session_id: 50 });
    expect(second.processes).toHaveLength(10); expect(second.nextAfterSessionId).toBeNull();
    expect([...first.processes, ...second.processes].map((row: any) => row.sessionId)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    for (const row of [...first.processes, ...second.processes]) {
      expect(row.workspaceId).toBe(f.first.id); expect(row.state).toBe("unknown");
      expect(row.liveness).toBe("unknown"); expect(row.ioAvailable).toBe(false);
      for (const field of ["output", "command", "requestKey", "requestFingerprint", "secret"]) expect(row).not.toHaveProperty(field);
    }
    const all: any = await f.runtime.call("list_processes", { workspace_id: f.first.id, after_session_id: 60, include_completed: true });
    expect(all.processes.map((row: any) => row.sessionId)).toEqual([61]);
    const other: any = await f.runtime.call("list_processes", { workspace_id: f.second.id });
    expect(other.processes.map((row: any) => row.sessionId)).toEqual([62]);
    expect(readFileSync(f.storePath, "utf8")).toBe(before);
    await expect(f.runtime.close()).rejects.toThrow("unresolved execution");
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("list bounds and workspace authority reject invalid discovery without changing reservations", async () => {
  const f = fixture();
  try {
    const before = readFileSync(f.storePath, "utf8");
    for (const args of [{ limit: 0 }, { limit: 51 }, { after_session_id: -1 }, { after_session_id: 1.5 }, { include_completed: "yes" }]) {
      await expect(f.runtime.call("list_processes", { workspace_id: f.first.id, ...args })).rejects.toThrow();
    }
    await expect(f.runtime.call("list_processes", { workspace_id: "unapproved" })).rejects.toThrow();
    expect(readFileSync(f.storePath, "utf8")).toBe(before);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

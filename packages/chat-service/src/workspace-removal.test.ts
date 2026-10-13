import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatWorkspaceRegistry } from "./workspaces";
import { ChatProcessManager } from "./processes";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "tela-removal-admission-"));
  const root = join(base, "workspace"); mkdirSync(root);
  const storePath = join(base, "workspaces.json");
  const registry = () => new ChatWorkspaceRegistry({ allowedRoots: [root], storePath });
  const workspaces = registry(); const workspace = workspaces.open(root);
  return { base, root, workspaces, workspace, registry, processStore: join(base, "processes.json") };
}

test("exclusive removal blocks new execution and aliases until its finally releases", async () => {
  const f = fixture();
  const processes = new ChatProcessManager({ workspaces: f.workspaces, storePath: f.processStore });
  try {
    const release = f.workspaces.reserveRemoval(f.workspace.id);
    try {
      await expect(processes.exec({ workspaceId: f.workspace.id, command: "true" })).rejects.toThrow("removal is in progress");
      expect(() => f.workspaces.open(f.root)).toThrow("removal is in progress");
      expect(() => f.workspaces.reserveRemoval(f.workspace.id)).toThrow("already in progress");
    } finally { release(); }
    expect(f.workspaces.get(f.workspace.id)).toEqual(f.workspace);
    const result = await processes.exec({ workspaceId: f.workspace.id, command: "true", yieldTimeMs: 1000 });
    expect(result.state).toBe("exited");
    f.workspaces.reserveRemoval(f.workspace.id)();
  } finally { await processes.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("restart leaves unfinished durable operations unresolved and refuses destructive admission", async () => {
  const f = fixture();
  const processes = new ChatProcessManager({ workspaces: f.workspaces, storePath: f.processStore });
  try {
    expect((await processes.exec({ workspaceId: f.workspace.id, command: "true", yieldTimeMs: 1000 })).state).toBe("exited");
    await processes.close();
    const store = JSON.parse(readFileSync(f.processStore, "utf8"));
    // Completed receipts now live in SQLite. Model a distinct in-flight
    // reservation across restart instead of rewriting a finished receipt.
    const now = new Date().toISOString();
    store.operations.push({ operationId: randomUUID(), serverInstanceId: randomUUID(),
      workspaceId: f.workspace.id, sessionId: store.nextSessionId++,
      state: "running", startedAt: now, updatedAt: now });
    writeFileSync(f.processStore, JSON.stringify(store));
    const workspaces = f.registry();
    const restarted = new ChatProcessManager({ workspaces, storePath: f.processStore });
    try {
      expect(() => workspaces.reserveRemoval(f.workspace.id)).toThrow("active or unresolved");
      expect(workspaces.get(f.workspace.id)).toEqual(f.workspace);
      expect(JSON.parse(readFileSync(f.processStore, "utf8")).operations[0].state).toBe("unknown");
    } finally { await expect(restarted.close()).rejects.toThrow("unresolved execution"); }
  } finally { await processes.close(); rmSync(f.base, { recursive: true, force: true }); }
});


test("in-flight async use protects overlapping workspace scopes and releases on failure", async () => {
  const f = fixture();
  const child = join(f.root, "child"); mkdirSync(child);
  const nested = f.workspaces.open(child);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const operation = f.workspaces.use(f.workspace.id, async () => { await gate; throw new Error("fixture failure"); });
  const rejected = operation.then(() => "unexpected success", error => (error as Error).message);
  try {
    expect(() => f.workspaces.reserveRemoval(nested.id)).toThrow("active asynchronous");
  } finally { release(); }
  expect(await rejected).toBe("fixture failure");
  try {
    const done = f.workspaces.reserveRemoval(nested.id);
    try { expect(() => f.workspaces.get(f.workspace.id)).toThrow("removal is in progress"); }
    finally { done(); }
    expect(f.workspaces.get(nested.id)).toEqual(nested);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

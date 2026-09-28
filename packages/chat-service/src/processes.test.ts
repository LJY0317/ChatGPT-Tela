import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ChatWorkspaceRegistry } from "./workspaces";
import { ChatProcessManager } from "./processes";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "tela-chat-process-"));
  const root = join(base, "project");
  mkdirSync(root);
  const registry = new ChatWorkspaceRegistry({ allowedRoots: [root], storePath: join(base, "workspaces.json") });
  const workspace = registry.open(root);
  const storePath = join(base, "operations.json");
  return { base, root, registry, workspace, storePath,
    manager: new ChatProcessManager({ workspaces: registry, storePath }) };
}

describe("Tela Chat process operations", () => {
  test("explicit operation ids deduplicate response-loss retries", async () => {
    const f = fixture();
    const operationId = randomUUID();
    try {
      const first = await f.manager.exec({ workspaceId: f.workspace.id, operationId,
        command: process.platform === "win32" ? "echo once" : "printf once", yieldTimeMs: 1000 });
      const second = await f.manager.exec({ workspaceId: f.workspace.id, operationId,
        command: process.platform === "win32" ? "echo twice" : "printf twice", yieldTimeMs: 1000 });
      expect(first.operationId).toBe(operationId);
      expect(first.output).toContain("once");
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.output).toBe("");
    } finally {
      await f.manager.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test("longer commands expose status and incremental output without persisting command text", async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    const operationId = randomUUID();
    try {
      const first = await f.manager.exec({ workspaceId: f.workspace.id, operationId,
        command: "printf start; sleep 0.15; printf end", yieldTimeMs: 10 });
      expect(first.state).toBe("running");
      expect(f.manager.status(f.workspace.id, operationId).ioAvailable).toBe(true);
      const final = await f.manager.writeStdin({ workspaceId: f.workspace.id, sessionId: first.sessionId,
        yieldTimeMs: 1000 });
      expect(final.state).toBe("exited");
      expect(final.output).toContain("end");
      const persisted = readFileSync(f.storePath, "utf8");
      expect(persisted).not.toContain("printf start");
      expect(persisted).not.toContain(f.root);
    } finally {
      await f.manager.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test("restart never reattaches stdin/stdout to a prior running pid", async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    const operationId = randomUUID();
    try {
      const running = await f.manager.exec({ workspaceId: f.workspace.id, operationId,
        command: "sleep 2", yieldTimeMs: 5 });
      expect(running.state).toBe("running");
      const reopened = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
      try {
        const status = reopened.status(f.workspace.id, operationId);
        expect(status.state).toBe("unknown");
        expect(status.ioAvailable).toBe(false);
        expect(status.liveness).toBe("unknown");
      } finally {
        await reopened.close();
      }
    } finally {
      await f.manager.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  });
});

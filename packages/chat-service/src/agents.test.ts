import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatWorkspaceRegistry } from "./workspaces";
import { ChatAgentManager, type ChatAgentDriver } from "./agents";

function fixture(driver: ChatAgentDriver) {
  const base = mkdtempSync(join(tmpdir(), "tela-chat-agents-"));
  const root = join(base, "project");
  mkdirSync(root);
  const workspaces = new ChatWorkspaceRegistry({ allowedRoots: [root], storePath: join(base, "workspaces.json") });
  const workspace = workspaces.open(root);
  const storePath = join(base, "agents.json");
  const manager = new ChatAgentManager({ workspaces, storePath, drivers: [driver] });
  return { base, root, workspaces, workspace, storePath, manager };
}

describe("Tela Chat durable agents", () => {
  test("serializes writable agents across overlapping roots, but permits read-only turns", async () => {
    const driver: ChatAgentDriver = { id: "fixture", run: async (_input, _callbacks, signal) => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { response: "stopped" };
    } };
    const f = fixture(driver);
    const nested = join(f.root, "nested"); mkdirSync(nested);
    const nestedWorkspace = f.workspaces.open(nested);
    try {
      const first = await f.manager.start({ workspaceId: f.workspace.id, target: "fixture", prompt: "writer", writeMode: "workspace_write" });
      await expect(f.manager.start({ workspaceId: nestedWorkspace.id, target: "fixture", prompt: "second writer", writeMode: "workspace_write" }))
        .rejects.toThrow("active or unresolved writable agent");
      const reader = await f.manager.start({ workspaceId: nestedWorkspace.id, target: "fixture", prompt: "reader", writeMode: "read_only" });
      expect(reader.status).toBe("running");
      await f.manager.stop(f.workspace.id, first.id);
      await f.manager.stop(nestedWorkspace.id, reader.id);
    } finally { await f.manager.close(); rmSync(f.base, { recursive: true, force: true }); }
  });

  test("restart retains an unresolved writer reservation and does not misclassify a read-only interruption", async () => {
    const driver: ChatAgentDriver = { id: "fixture", async run(_input, _callbacks, signal) {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { response: "stopped" };
    } };
    const f = fixture(driver);
    try {
      const writer = await f.manager.start({ workspaceId: f.workspace.id, target: "fixture", prompt: "writer", writeMode: "workspace_write" });
      const persisted = JSON.parse(readFileSync(f.storePath, "utf8"));
      expect(persisted.turns.some((turn: { writeMode: string }) => turn.writeMode === "workspace_write")).toBe(true);
      await f.manager.stop(f.workspace.id, writer.id);
      await f.manager.close();
      persisted.agents[0].status = "running";
      persisted.turns[0].status = "running";
      writeFileSync(f.storePath, JSON.stringify(persisted));
      const reopened = new ChatAgentManager({ workspaces: f.workspaces, storePath: f.storePath, drivers: [driver] });
      try {
        await expect(reopened.start({ workspaceId: f.workspace.id, target: "fixture", prompt: "new writer", writeMode: "workspace_write" }))
          .rejects.toThrow("active or unresolved writable agent");
        const reader = await reopened.start({ workspaceId: f.workspace.id, target: "fixture", prompt: "reader", writeMode: "read_only" });
        await reopened.stop(f.workspace.id, reader.id);
      } finally { await reopened.close(); }
    } finally { await f.manager.close(); rmSync(f.base, { recursive: true, force: true }); }
  });

  test("sibling approved roots within one checkout share a writer fence, including legacy unknown mode", async () => {
    const driver: ChatAgentDriver = { id: "fixture", async run(_input, _callbacks, signal) {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { response: "stopped" };
    } };
    const f = fixture(driver);
    const left = join(f.root, "left"), right = join(f.root, "right");
    mkdirSync(join(f.root, ".git")); mkdirSync(left); mkdirSync(right);
    const leftWorkspace = f.workspaces.open(left), rightWorkspace = f.workspaces.open(right);
    try {
      const first = await f.manager.start({ workspaceId: leftWorkspace.id, target: "fixture", prompt: "writer", writeMode: "workspace_write" });
      await expect(f.manager.start({ workspaceId: rightWorkspace.id, target: "fixture", prompt: "second writer", writeMode: "workspace_write" }))
        .rejects.toThrow("active or unresolved writable agent");
      const prior = JSON.parse(readFileSync(f.storePath, "utf8"));
      await f.manager.stop(leftWorkspace.id, first.id);
      await f.manager.close();
      prior.agents[0].status = "running";
      prior.turns[0].status = "running";
      delete prior.turns[0].writeMode;
      writeFileSync(f.storePath, JSON.stringify(prior));
      const reopened = new ChatAgentManager({ workspaces: f.workspaces, storePath: f.storePath, drivers: [driver] });
      try {
        await expect(reopened.start({ workspaceId: rightWorkspace.id, target: "fixture", prompt: "legacy conflict", writeMode: "workspace_write" }))
          .rejects.toThrow("active or unresolved writable agent");
      } finally { await reopened.close(); }
    } finally { await f.manager.close(); rmSync(f.base, { recursive: true, force: true }); }
  });

  test("a parent writer still fences a nested Git checkout it could modify", async () => {
    const driver: ChatAgentDriver = { id: "fixture", async run(_input, _callbacks, signal) {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { response: "stopped" };
    } };
    const f = fixture(driver);
    const nested = join(f.root, "separate-checkout");
    mkdirSync(join(f.root, ".git")); mkdirSync(nested); mkdirSync(join(nested, ".git"));
    const secondWorkspace = f.workspaces.open(nested);
    try {
      const first = await f.manager.start({ workspaceId: f.workspace.id, target: "fixture", prompt: "outer", writeMode: "workspace_write" });
      await expect(f.manager.start({ workspaceId: secondWorkspace.id, target: "fixture", prompt: "inner", writeMode: "workspace_write" }))
        .rejects.toThrow("active or unresolved writable agent");
      await f.manager.stop(f.workspace.id, first.id);
    } finally { await f.manager.close(); rmSync(f.base, { recursive: true, force: true }); }
  });

  test("independent sibling checkouts can run separate writers", async () => {
    const driver: ChatAgentDriver = { id: "fixture", async run(_input, _callbacks, signal) {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { response: "stopped" };
    } };
    const f = fixture(driver);
    const sibling = join(f.base, "other-project");
    mkdirSync(sibling); mkdirSync(join(f.root, ".git")); mkdirSync(join(sibling, ".git"));
    const registry = new ChatWorkspaceRegistry({ allowedRoots: [f.root, sibling], storePath: join(f.base, "other-workspaces.json") });
    const firstWorkspace = registry.open(f.root), secondWorkspace = registry.open(sibling);
    const manager = new ChatAgentManager({ workspaces: registry, storePath: join(f.base, "other-agents.json"), drivers: [driver] });
    try {
      const first = await manager.start({ workspaceId: firstWorkspace.id, target: "fixture", prompt: "first", writeMode: "workspace_write" });
      const second = await manager.start({ workspaceId: secondWorkspace.id, target: "fixture", prompt: "second", writeMode: "workspace_write" });
      expect(first.status).toBe("running"); expect(second.status).toBe("running");
      await manager.stop(firstWorkspace.id, first.id);
      await manager.stop(secondWorkspace.id, second.id);
    } finally { await manager.close(); await f.manager.close(); rmSync(f.base, { recursive: true, force: true }); }
  });

  test("start and continue persist provider continuation but never persist prompts", async () => {
    const seen: Array<{ prompt: string; providerSessionId?: string }> = [];
    const driver: ChatAgentDriver = {
      id: "fixture",
      description: "Fixture provider",
      async run(input, callbacks) {
        seen.push({ prompt: input.prompt, ...(input.providerSessionId ? { providerSessionId: input.providerSessionId } : {}) });
        const session = input.providerSessionId ?? "provider-session-private";
        await callbacks.onSessionId(session);
        return { response: `fixture-response-${seen.length}`, providerSessionId: session };
      },
    };
    const f = fixture(driver);
    try {
      expect(f.manager.targets()).toEqual([{ id: "fixture", description: "Fixture provider" }]);
      const started = await f.manager.start({ workspaceId: f.workspace.id, target: "fixture",
        prompt: "private first prompt", writeMode: "read_only" });
      const [first] = await f.manager.wait({ workspaceId: f.workspace.id, agentIds: [started.id], timeoutMs: 1000 });
      expect(first).toMatchObject({ status: "idle", response: "fixture-response-1" });
      await f.manager.continue({ workspaceId: f.workspace.id, agentId: started.id, prompt: "private second prompt" });
      const [second] = await f.manager.wait({ workspaceId: f.workspace.id, agentIds: [started.id], timeoutMs: 1000 });
      expect(second).toMatchObject({ status: "idle", response: "fixture-response-2" });
      expect(seen).toEqual([
        { prompt: "private first prompt" },
        { prompt: "private second prompt", providerSessionId: "provider-session-private" },
      ]);
      const persisted = readFileSync(f.storePath, "utf8");
      expect(persisted).not.toContain("private first prompt");
      expect(persisted).not.toContain("private second prompt");
      expect(persisted).toContain("provider-session-private");
    } finally {
      await f.manager.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test("restart marks an unproven running turn unknown and never reattaches it", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolvePromise => { release = resolvePromise; });
    const driver: ChatAgentDriver = {
      id: "fixture",
      async run(_input, callbacks) {
        await callbacks.onSessionId("provider-session-running");
        await gate;
        return { response: "late", providerSessionId: "provider-session-running" };
      },
    };
    const f = fixture(driver);
    try {
      const started = await f.manager.start({ workspaceId: f.workspace.id, target: "fixture", prompt: "run" });
      await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
      const reopened = new ChatAgentManager({ workspaces: f.workspaces, storePath: f.storePath, drivers: [driver] });
      try {
        expect(reopened.get(f.workspace.id, started.id).status).toBe("unknown");
        await expect(reopened.continue({ workspaceId: f.workspace.id, agentId: started.id, prompt: "do not continue" }))
          .rejects.toThrow("unproven interrupted turn");
      } finally {
        await reopened.close();
      }
      release();
      await f.manager.wait({ workspaceId: f.workspace.id, agentIds: [started.id], timeoutMs: 1000 });
    } finally {
      release();
      await f.manager.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test("stop signals only the active workspace-scoped agent turn", async () => {
    let aborted = false;
    const driver: ChatAgentDriver = {
      id: "fixture",
      async run(_input, _callbacks, signal) {
        await new Promise<void>(resolvePromise => {
          if (signal.aborted) { aborted = true; resolvePromise(); return; }
          signal.addEventListener("abort", () => { aborted = true; resolvePromise(); }, { once: true });
        });
        return { response: "must not become a successful stopped result" };
      },
    };
    const f = fixture(driver);
    try {
      const started = await f.manager.start({ workspaceId: f.workspace.id, target: "fixture", prompt: "stop me" });
      const stopped = await f.manager.stop(f.workspace.id, started.id);
      expect(aborted).toBe(true);
      expect(stopped.status).toBe("stopped");
      expect(() => f.manager.get("chatws_other", started.id)).toThrow();
    } finally {
      await f.manager.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test("failed turn cannot resume from a session id alone, including after restart", async () => {
    let runs = 0;
    const driver: ChatAgentDriver = { id: "fixture", async run(_input, callbacks) {
      runs++;
      await callbacks.onSessionId("known-session-unproven-result");
      throw new Error("private provider error and prompt data");
    } };
    const f = fixture(driver);
    try {
      const started = await f.manager.start({ workspaceId: f.workspace.id, target: "fixture", prompt: "run" });
      const [failed] = await f.manager.wait({ workspaceId: f.workspace.id, agentIds: [started.id], timeoutMs: 1000 });
      expect(failed).toMatchObject({ status: "failed", error: { code: "agent_driver_failed" } });
      expect(readFileSync(f.storePath, "utf8")).not.toContain("private provider error");
      await expect(f.manager.continue({ workspaceId: f.workspace.id, agentId: started.id, prompt: "retry" }))
        .rejects.toThrow("no proven completed turn");
      await f.manager.close();
      const reopened = new ChatAgentManager({ workspaces: f.workspaces, storePath: f.storePath, drivers: [driver] });
      try {
        await expect(reopened.continue({ workspaceId: f.workspace.id, agentId: started.id, prompt: "retry" }))
          .rejects.toThrow("no proven completed turn");
        expect(runs).toBe(1);
      } finally { await reopened.close(); }
    } finally { await f.manager.close(); rmSync(f.base, { recursive: true, force: true }); }
  });

  test("synchronous driver failure clears its lifecycle before shutdown", async () => {
    const driver: ChatAgentDriver = { id: "fixture", run() { throw new Error("immediate failure"); } };
    const f = fixture(driver);
    try {
      const started = await f.manager.start({ workspaceId: f.workspace.id, target: "fixture", prompt: "run" });
      await f.manager.wait({ workspaceId: f.workspace.id, agentIds: [started.id], timeoutMs: 1000 });
      expect(f.manager.get(f.workspace.id, started.id).status).toBe("failed");
      await f.manager.close();
      const reopened = new ChatAgentManager({ workspaces: f.workspaces, storePath: f.storePath, drivers: [driver] });
      try { expect(reopened.get(f.workspace.id, started.id).status).toBe("failed"); }
      finally { await reopened.close(); }
    } finally { await f.manager.close(); rmSync(f.base, { recursive: true, force: true }); }
  });

  test("completed session resumes after restart with fresh read-only authority by default", async () => {
    const seen: Array<{ mode: string; session: string | undefined }> = [];
    const driver: ChatAgentDriver = { id: "fixture", async run(input, callbacks) {
      seen.push({ mode: input.writeMode, session: input.providerSessionId });
      if (!input.providerSessionId) await callbacks.onSessionId("completed-session");
      return { response: "done", providerSessionId: "completed-session" };
    } };
    const f = fixture(driver);
    try {
      const started = await f.manager.start({ workspaceId: f.workspace.id, target: "fixture",
        prompt: "write authorized", writeMode: "workspace_write" });
      await f.manager.wait({ workspaceId: f.workspace.id, agentIds: [started.id], timeoutMs: 1000 });
      await f.manager.close();
      const reopened = new ChatAgentManager({ workspaces: f.workspaces, storePath: f.storePath, drivers: [driver] });
      try {
        await reopened.continue({ workspaceId: f.workspace.id, agentId: started.id, prompt: "review only" });
        expect((await reopened.wait({ workspaceId: f.workspace.id, agentIds: [started.id], timeoutMs: 1000 }))[0]!.status).toBe("idle");
        expect(seen).toEqual([
          { mode: "workspace_write", session: undefined },
          { mode: "read_only", session: "completed-session" },
        ]);
      } finally { await reopened.close(); }
    } finally { await f.manager.close(); rmSync(f.base, { recursive: true, force: true }); }
  });
});

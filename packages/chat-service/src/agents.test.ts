import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
});

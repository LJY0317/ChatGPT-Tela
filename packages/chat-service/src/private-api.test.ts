import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatAgentDriver } from "./agents";
import { createChatToolRuntime } from "./tools";
import { startChatService } from "./index";

describe("Tela Chat private capability API", () => {
  test("publishes stable Tela-owned capability names and executes them behind local bearer auth", async () => {
    const base = mkdtempSync(join(tmpdir(), "tela-chat-private-"));
    const root = join(base, "project");
    mkdirSync(root);
    writeFileSync(join(root, "a.txt"), "A\n");
    const token = "p".repeat(48);
    const tools = createChatToolRuntime({ allowedRoots: [root], stateRoot: join(base, "state") });
    const service = await startChatService({ bearerToken: token, tools });
    try {
      const request = (path: string, init: RequestInit = {}) => fetch(new URL(path, service.endpoint), {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      });
      const capabilities = await (await request("v1/capabilities")).json() as {
        capabilities: string[];
        catalog: Array<{ capability: string; description: string; inputSchema: Record<string, unknown> }>;
      };
      expect(capabilities.capabilities).toContain("open_workspace");
      expect(capabilities.capabilities).toContain("process_status");
      expect(capabilities.capabilities).not.toContain("start_agent");
      expect(capabilities.catalog.map(item => item.capability)).toEqual(capabilities.capabilities);
      expect(capabilities.catalog.find(item => item.capability === "read")?.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      const openedResponse = await request("v1/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability: "open_workspace", arguments: { path: root } }),
      });
      expect(openedResponse.status).toBe(200);
      const opened = await openedResponse.json() as { result: { id: string } };
      const readResponse = await request("v1/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability: "read", arguments: { workspace_id: opened.result.id, path: "a.txt" } }),
      });
      expect((await readResponse.json() as { result: { content: string } }).result.content).toBe("1: A");
    } finally {
      await service.close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("agent lifecycle capabilities appear only when a provider driver is explicitly configured", async () => {
    const base = mkdtempSync(join(tmpdir(), "tela-chat-private-agent-"));
    const root = join(base, "project");
    mkdirSync(root);
    const token = "a".repeat(48);
    const driver: ChatAgentDriver = {
      id: "fixture-agent",
      description: "Private API fixture agent",
      async run(_input, callbacks) {
        await callbacks.onSessionId("fixture-private-session");
        return { response: "agent-private-ok", providerSessionId: "fixture-private-session" };
      },
    };
    const tools = createChatToolRuntime({
      allowedRoots: [root],
      stateRoot: join(base, "state"),
      agentDrivers: [driver],
    });
    const service = await startChatService({ bearerToken: token, tools });
    try {
      const request = (path: string, init: RequestInit = {}) => fetch(new URL(path, service.endpoint), {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      });
      const capabilities = await (await request("v1/capabilities")).json() as {
        capabilities: string[];
        catalog: Array<{ capability: string }>;
      };
      for (const capability of ["list_agent_targets", "start_agent", "continue_agent", "get_agent", "list_agents", "wait_agents", "stop_agent"]) {
        expect(capabilities.capabilities).toContain(capability);
        expect(capabilities.catalog.map(item => item.capability)).toContain(capability);
      }
      const call = async (capability: string, arguments_: unknown) => {
        const response = await request("v1/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ capability, arguments: arguments_ }),
        });
        expect(response.status).toBe(200);
        return (await response.json() as { result: unknown }).result;
      };
      expect(await call("list_agent_targets", {})).toEqual([{
        id: "fixture-agent",
        description: "Private API fixture agent",
      }]);
      const workspace = await call("open_workspace", { path: root }) as { id: string };
      const started = await call("start_agent", {
        workspace_id: workspace.id,
        target: "fixture-agent",
        prompt: "delegate this bounded task",
      }) as { id: string };
      const waited = await call("wait_agents", {
        workspace_id: workspace.id,
        agent_ids: [started.id],
        timeout_ms: 1000,
      }) as Array<{ status: string; response?: string }>;
      expect(waited[0]).toMatchObject({ status: "idle", response: "agent-private-ok" });
    } finally {
      await service.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});

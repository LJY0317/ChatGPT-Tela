import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChatToolRuntime } from "./tools";
import { OpenAiChatAgentDriver } from "./openai-agent";

test("delegated model calls cannot acquire shell, read-only write, or another workspace authority", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "tela-agent-authority-")));
  const root = join(base, "project"), other = join(base, "other");
  mkdirSync(root); mkdirSync(other);
  let call: { name: string; arguments: Record<string, unknown> };
  let rounds = 0;
  const runtime = createChatToolRuntime({ allowedRoots: [root, other], stateRoot: join(base, "state"),
    agentDriverFactories: [tools => new OpenAiChatAgentDriver({
      apiKey: "sk-fixture-only-no-real-api-traffic", model: "fixture-model", workspaceTools: tools,
      fetch: async input => {
        const value = String(input).endsWith("/conversations") ? { id: "conv_fixture" }
          : rounds++ % 2 === 0 ? { output: [{ type: "function_call", call_id: "call_fixture",
            name: call.name, arguments: JSON.stringify(call.arguments) }] }
          : { output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] };
        return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
      },
    })],
  });
  try {
    const workspace = runtime.workspaces.open(root), outside = runtime.workspaces.open(other);
    async function execute(mode: "read_only" | "workspace_write", name: string, arguments_: Record<string, unknown>) {
      call = { name, arguments: arguments_ }; rounds = 0;
      const agent = await runtime.agents!.start({ workspaceId: workspace.id, target: "openai-responses",
        prompt: "fixture", writeMode: mode });
      return (await runtime.agents!.wait({ workspaceId: workspace.id, agentIds: [agent.id], timeoutMs: 1000 }))[0]!;
    }
    const patch = "*** Begin Patch\n*** Add File: owned.txt\n+owned\n*** End Patch";
    expect((await execute("read_only", "apply_patch", { patch })).status).toBe("failed");
    expect(existsSync(join(root, "owned.txt"))).toBe(false);
    expect((await execute("workspace_write", "exec_command", { cmd: "write marker" })).status).toBe("failed");
    expect((await execute("workspace_write", "apply_patch", {
      patch: "*** Begin Patch\n*** Add File: ../other/escaped.txt\n+escaped\n*** End Patch",
    })).status).toBe("failed");
    expect(existsSync(join(other, "escaped.txt"))).toBe(false);
    expect((await execute("workspace_write", "apply_patch", { workspace_id: outside.id, patch })).status).toBe("idle");
    expect(readFileSync(join(root, "owned.txt"), "utf8")).toBe("owned\n");
    expect(existsSync(join(other, "owned.txt"))).toBe(false);
  } finally { await runtime.close(); rmSync(base, { recursive: true, force: true }); }
});

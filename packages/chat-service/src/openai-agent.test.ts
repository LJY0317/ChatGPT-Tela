import { describe, expect, test } from "bun:test";
import type { ChatAgentWorkspaceTools } from "./tools";
import { OpenAiChatAgentDriver } from "./openai-agent";

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fixtureTools(events: string[]): ChatAgentWorkspaceTools {
  return {
    read(input) {
      events.push(`read:${input.workspaceId}:${input.path}:${input.offset ?? ""}:${input.limit ?? ""}`);
      return { path: input.path, content: "1: hello" };
    },
    readMany(input) {
      events.push(`read_many:${input.workspaceId}:${input.reads.map(read => read.path).join(",")}`);
      return input.reads.map(read => ({ path: read.path, content: "fixture" }));
    },
    applyPatch(input) {
      events.push(`apply_patch:${input.workspaceId}`);
      return { additions: 1, removals: 0 };
    },
    async showChanges(workspaceId) {
      events.push(`show_changes:${workspaceId}`);
      return { status: " M README.md", patch: "+change" };
    },
  };
}

describe("OpenAI Responses Tela Chat agent", () => {
  test("creates a durable conversation and relays bounded read tools before returning final text", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown>; authorization?: string }> = [];
    const events: string[] = [];
    const fetch_ = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({
        url,
        body,
        ...(new Headers(init?.headers).get("authorization")
          ? { authorization: new Headers(init?.headers).get("authorization")! }
          : {}),
      });
      if (url.endsWith("/conversations")) return response({ id: "conv_fixture_1", object: "conversation" });
      if (requests.filter(request => request.url.endsWith("/responses")).length === 1) {
        return response({
          output: [{
            type: "function_call",
            call_id: "call_read_1",
            name: "read",
            arguments: JSON.stringify({ path: "README.md", offset: null, limit: 10 }),
          }],
        });
      }
      return response({
        output: [{ type: "message", content: [{ type: "output_text", text: "read complete" }] }],
      });
    };
    const driver = new OpenAiChatAgentDriver({
      apiKey: "sk-fixture-secret-value-long-enough",
      model: "test-model",
      workspaceTools: fixtureTools(events),
      fetch: fetch_,
    });
    const sessionIds: string[] = [];
    const result = await driver.run({
      prompt: "Inspect README",
      workspaceId: "chatws_1",
      workspaceRoot: "/private/workspace",
      writeMode: "read_only",
    }, { onSessionId: id => { sessionIds.push(id); } }, new AbortController().signal);

    expect(result).toEqual({ response: "read complete", providerSessionId: "conv_fixture_1" });
    expect(sessionIds).toEqual(["conv_fixture_1"]);
    expect(events).toEqual(["read:chatws_1:README.md::10"]);
    expect(requests).toHaveLength(3);
    expect(requests.every(request => request.authorization === "Bearer sk-fixture-secret-value-long-enough")).toBe(true);
    const firstResponse = requests[1]!.body;
    expect(firstResponse.conversation).toBe("conv_fixture_1");
    expect(JSON.stringify(firstResponse)).not.toContain("/private/workspace");
    expect(firstResponse.instructions).toContain("read_many only for already-known independent paths");
    expect(firstResponse.instructions).toContain("Treat actual tool results as evidence");
    expect(firstResponse.instructions).toContain("This run is read-only");
    expect((firstResponse.tools as Array<{ name: string }>).map(tool => tool.name)).toEqual([
      "read", "read_many", "show_changes",
    ]);
    const continuationInput = requests[2]!.body.input as Array<Record<string, unknown>>;
    expect(continuationInput).toEqual([{
      type: "function_call_output",
      call_id: "call_read_1",
      output: JSON.stringify({ path: "README.md", content: "1: hello" }),
    }]);
  });

  test("reuses a proven conversation id and only exposes apply_patch in workspace_write mode", async () => {
    const requests: Record<string, unknown>[] = [];
    const events: string[] = [];
    let responseCount = 0;
    const driver = new OpenAiChatAgentDriver({
      apiKey: "sk-fixture-secret-value-long-enough",
      model: "test-model",
      workspaceTools: fixtureTools(events),
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/conversations")) throw new Error("conversation creation must not happen on continuation");
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        requests.push(body);
        responseCount += 1;
        return response(responseCount === 1
          ? {
              output: [{
                type: "function_call",
                call_id: "call_patch_1",
                name: "apply_patch",
                arguments: JSON.stringify({ patch: "*** Begin Patch\n*** Add File: a.txt\n+ok\n*** End Patch" }),
              }],
            }
          : { output: [{ type: "message", content: [{ type: "output_text", text: "patched" }] }] });
      },
    });
    const sessions: string[] = [];
    const result = await driver.run({
      prompt: "Patch it",
      workspaceId: "chatws_2",
      workspaceRoot: "/not-sent",
      providerSessionId: "conv_existing_1",
      writeMode: "workspace_write",
    }, { onSessionId: id => { sessions.push(id); } }, new AbortController().signal);

    expect(result).toEqual({ response: "patched", providerSessionId: "conv_existing_1" });
    expect(sessions).toEqual([]);
    expect(events).toEqual(["apply_patch:chatws_2"]);
    expect((requests[0]!.tools as Array<{ name: string }>).map(tool => tool.name)).toContain("apply_patch");
    expect(requests[0]!.instructions).toContain("Read enough relevant context before editing");
    expect(requests[0]!.instructions).toContain("inspect show_changes");
    expect(requests.every(request => request.conversation === "conv_existing_1")).toBe(true);
  });

  test("fails closed when read-only mode receives a write call or the signal is already aborted", async () => {
    const driver = new OpenAiChatAgentDriver({
      apiKey: "sk-fixture-secret-value-long-enough",
      model: "test-model",
      workspaceTools: fixtureTools([]),
      fetch: async input => String(input).endsWith("/conversations")
        ? response({ id: "conv_fixture_ro" })
        : response({
            output: [{
              type: "function_call",
              call_id: "call_bad_write",
              name: "apply_patch",
              arguments: JSON.stringify({ patch: "*** Begin Patch\n*** End Patch" }),
            }],
          }),
    });
    await expect(driver.run({
      prompt: "Do not write",
      workspaceId: "chatws_ro",
      workspaceRoot: "/private",
      writeMode: "read_only",
    }, { onSessionId() {} }, new AbortController().signal)).rejects.toThrow("unavailable in read-only");

    const aborted = new AbortController();
    aborted.abort(new Error("fixture abort"));
    await expect(driver.run({
      prompt: "stop",
      workspaceId: "chatws_ro",
      workspaceRoot: "/private",
      writeMode: "read_only",
    }, { onSessionId() {} }, aborted.signal)).rejects.toThrow("fixture abort");
  });

  test("provider HTTP failures expose status only and never echo the API key", async () => {
    const secret = "sk-never-echo-this-secret-value";
    const driver = new OpenAiChatAgentDriver({
      apiKey: secret,
      model: "test-model",
      workspaceTools: fixtureTools([]),
      fetch: async () => response({ error: { message: `bad key ${secret}` } }, 401),
    });
    let message = "";
    try {
      await driver.run({
        prompt: "hello",
        workspaceId: "chatws_1",
        workspaceRoot: "/private",
        writeMode: "read_only",
      }, { onSessionId() {} }, new AbortController().signal);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("HTTP 401");
    expect(message).not.toContain(secret);
  });
});

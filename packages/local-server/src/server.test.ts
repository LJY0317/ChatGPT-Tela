import { describe, expect, test } from "bun:test";
import type { CanonicalCurrentTurnSource } from "@chatgpt-tela/codex";
import {
  ActiveTurnRegistry,
  NativeResponsesGateway,
} from "@chatgpt-tela/runtime";
import { startLocalResponsesServer } from "./server";

const source: CanonicalCurrentTurnSource = {
  async currentTurn(threadId) {
    return {
      threadId,
      turnId: "turn-1",
      cwd: "/workspace",
      workspaceRoots: ["/workspace"],
      sandbox: { kind: "read-only", network: "restricted" },
      proof: "turn-context",
      environmentSourceTurnId: "turn-1",
    };
  },
};

function requestBody(input: unknown[] = []): Record<string, unknown> {
  return {
    model: "chatgpt-tela-test-model",
    stream: true,
    client_metadata: {
      "x-codex-turn-metadata": {
        request_kind: "turn",
        thread_id: "thread-1",
        turn_id: "turn-1",
      },
    },
    input,
    tools: [{
      type: "function",
      name: "exec_command",
      description: "command",
      parameters: { type: "object" },
    }],
  };
}

async function post(
  server: Awaited<ReturnType<typeof startLocalResponsesServer>>,
  value: unknown,
  token = server.runtimeToken,
): Promise<Response> {
  return fetch(new URL("responses", server.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(value),
  });
}

describe("local Native Responses server", () => {
  test("runs one streamed tool round over a real loopback HTTP lifecycle", async () => {
    const turns = new ActiveTurnRegistry();
    const gateway = new NativeResponsesGateway(source, turns, async registered => {
      registered.channel.markSubmitted();
      registered.channel.markAccepted();
      const waitingResult = registered.channel.requestTool({
        callId: "call-1",
        wireName: "exec_command",
        mode: "structured",
        arguments: { cmd: ["printf", "ok"] },
      });
      let state = registered.channel.state();
      while (!(state.phase === "tool-result-delivered"
        && state.nativeResultReady === true
        && state.outstandingToolCallId === "call-1")) {
        state = await registered.channel.waitForStateChange(state.revision);
      }
      registered.channel.releaseNativeToolResultToWeb("call-1");
      const result = await waitingResult;
      registered.channel.markWebContinuation();
      registered.channel.complete(`done:${String(result.content)}`);
    });
    const server = await startLocalResponsesServer({ gateway });
    try {
      expect(server.hostname).toBe("127.0.0.1");
      expect(server.runtimeToken.length).toBeGreaterThanOrEqual(32);

      const first = await post(server, requestBody());
      expect(first.status).toBe(200);
      const firstText = await first.text();
      expect(firstText).toContain('"call_id":"call-1"');
      expect(firstText).toContain("data: [DONE]");

      const followup = await post(server, requestBody([
        { type: "function_call_output", call_id: "call-1", output: "ok" },
      ]));
      expect(followup.status).toBe(200);
      const finalText = await followup.text();
      expect(finalText).toContain('"delta":"done:ok"');
      expect(finalText).toContain("response.completed");
      expect(turns.size).toBe(0);
    } finally {
      await server.stop();
    }
  });

  test("requires the runtime bearer capability and rejects browser-origin requests", async () => {
    const gateway = new NativeResponsesGateway(source, new ActiveTurnRegistry(), async () => {});
    const server = await startLocalResponsesServer({ gateway });
    try {
      expect((await post(server, requestBody(), "x".repeat(32))).status).toBe(401);
      const browserRequest = await fetch(new URL("responses", server.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${server.runtimeToken}`,
          origin: "https://example.com",
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody()),
      });
      expect(browserRequest.status).toBe(403);
    } finally {
      await server.stop();
    }
  });

  test("can authenticate Tela locally through a dedicated header without consuming upstream authorization", async () => {
    const gateway = new NativeResponsesGateway(source, new ActiveTurnRegistry(), async () => {});
    let observedAuthorization: string | null | undefined;
    const server = await startLocalResponsesServer({
      gateway,
      authentication: { kind: "header", name: "X-ChatGPT-Tela-Runtime-Token" },
      async requestRouter(request) {
        observedAuthorization = request.headers.get("authorization");
        return new Response("native", { status: 202 });
      },
    });
    try {
      const missing = await fetch(new URL("responses", server.baseUrl), {
        method: "POST",
        headers: {
          authorization: "Bearer upstream-chatgpt-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody()),
      });
      expect(missing.status).toBe(401);

      const response = await fetch(new URL("responses", server.baseUrl), {
        method: "POST",
        headers: {
          authorization: "Bearer upstream-chatgpt-token",
          "x-chatgpt-tela-runtime-token": server.runtimeToken,
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody()),
      });
      expect(response.status).toBe(202);
      expect(await response.text()).toBe("native");
      expect(observedAuthorization).toBe("Bearer upstream-chatgpt-token");
    } finally {
      await server.stop();
    }
  });

  test("router may own non-responses provider endpoints behind the same local capability", async () => {
    const gateway = new NativeResponsesGateway(source, new ActiveTurnRegistry(), async () => {});
    const server = await startLocalResponsesServer({
      gateway,
      async requestRouter(request) {
        return new URL(request.url).pathname === "/v1/models"
          ? Response.json({ models: [] })
          : undefined;
      },
    });
    try {
      const response = await fetch(new URL("models", server.baseUrl), {
        headers: { authorization: `Bearer ${server.runtimeToken}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ models: [] });
    } finally {
      await server.stop();
    }
  });

  test("server stop is idempotent", async () => {
    const gateway = new NativeResponsesGateway(source, new ActiveTurnRegistry(), async () => {});
    const server = await startLocalResponsesServer({ gateway });
    await server.stop();
    await server.stop();
  });
});

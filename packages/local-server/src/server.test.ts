import { describe, expect, test } from "bun:test";
import { zstdCompressSync } from "node:zlib";
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
  test("decodes authenticated Codex zstd bodies before routing and gateway parsing", async () => {
    let observed: unknown;
    const gateway = new NativeResponsesGateway(source, new ActiveTurnRegistry(), async registered => {
      registered.channel.markSubmitted();
      registered.channel.markAccepted();
      registered.channel.complete("decoded");
    });
    const server = await startLocalResponsesServer({
      gateway,
      async requestRouter(request) {
        expect(request.headers.has("content-encoding")).toBe(false);
        expect(request.headers.has("content-length")).toBe(false);
        observed = await request.json();
        return undefined;
      },
    });
    try {
      const value = requestBody();
      const response = await fetch(new URL("responses", server.baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${server.runtimeToken}`, "content-encoding": "zstd" },
        body: zstdCompressSync(Buffer.from(JSON.stringify(value))),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"delta":"decoded"');
      expect(observed).toEqual(value);
    } finally { await server.stop(); }
  });

  test("rejects invalid, unsupported and oversized decoded bodies before provider routing", async () => {
    let routed = false;
    const gateway = new NativeResponsesGateway(source, new ActiveTurnRegistry(), async () => {});
    const server = await startLocalResponsesServer({
      gateway, maxRequestBodyBytes: 512,
      async requestRouter() { routed = true; return new Response(); },
    });
    try {
      const send = (encoding: string, body: Uint8Array, token = server.runtimeToken) => fetch(
        new URL("responses", server.baseUrl), {
          method: "POST", headers: { authorization: `Bearer ${token}`, "content-encoding": encoding },
          body: Uint8Array.from(body).buffer,
        },
      );
      expect((await send("zstd", Buffer.from("broken"), "wrong")).status).toBe(401);
      expect((await send("zstd", Buffer.from("broken"))).status).toBe(400);
      expect((await send("unknown", Buffer.from("{}"))).status).toBe(415);
      expect((await send("zstd", zstdCompressSync(Buffer.from("x".repeat(4096))))).status).toBe(413);
      expect(routed).toBe(false);
    } finally { await server.stop(); }
  });

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
      expect(turns.size).toBe(1);
      await gateway.close();
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

  test("authenticated WebSocket upgrade requests ask Codex to use HTTP Responses", async () => {
    const gateway = new NativeResponsesGateway(source, new ActiveTurnRegistry(), async () => {});
    const server = await startLocalResponsesServer({
      gateway,
      authentication: { kind: "header", name: "OpenAI-Organization" },
    });
    try {
      const response = await fetch(new URL("responses", server.baseUrl), {
        headers: {
          "OpenAI-Organization": server.runtimeToken,
          upgrade: "websocket",
        },
      });
      expect(response.status).toBe(426);
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


test("explicit route-only server retains auth and fails closed without a gateway", async () => {
  await expect(startLocalResponsesServer({})).rejects.toThrow("gateway or explicit router");
  let routed = 0;
  const server = await startLocalResponsesServer({ async requestRouter(request) {
    routed++;
    if (new URL(request.url).pathname === "/v1/models") return Response.json({ models: [] });
    return undefined;
  } });
  try {
    expect((await post(server, {}, "wrong")).status).toBe(401);
    expect(routed).toBe(0);
    expect((await post(server, {})).status).toBe(404);
    expect((await fetch(new URL("models", server.baseUrl), { headers: { authorization: `Bearer ${server.runtimeToken}` } })).status).toBe(200);
    expect(routed).toBe(2);
  } finally { await server.stop(); }
});


test("in-process dispatch preserves authentication, browser-origin rejection, body decoding and closure", async () => {
  let calls = 0;
  const server = await startLocalResponsesServer({ runtimeToken: "t".repeat(48),
    async requestRouter(request) { calls++; return Response.json(await request.json()); } });
  const request = (headers: Record<string, string>, body: BodyInit = '{"value":1}') =>
    new Request(new URL("responses", server.baseUrl), { method: "POST", headers, body });
  try {
    expect((await server.handleRequest(request({}))).status).toBe(401);
    expect((await server.handleRequest(request({ authorization: `Bearer ${server.runtimeToken}`, origin: "https://example.invalid" }))).status).toBe(403);
    expect(calls).toBe(0);
    const response = await server.handleRequest(request({ authorization: `Bearer ${server.runtimeToken}`, "content-encoding": "zstd" },
      Uint8Array.from(zstdCompressSync(Buffer.from('{"value":2}')))));
    expect(await response.json()).toEqual({ value: 2 });
    expect(calls).toBe(1);
    const controller = new AbortController(); controller.abort();
    await expect(server.handleRequest(new Request(new URL("responses", server.baseUrl), { signal: controller.signal }))).rejects.toThrow();
    expect(calls).toBe(1);
    await server.stop();
    expect((await server.handleRequest(request({ authorization: `Bearer ${server.runtimeToken}` }))).status).toBe(503);
    expect(calls).toBe(1);
  } finally { await server.stop(); }
});

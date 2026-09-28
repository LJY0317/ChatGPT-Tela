import { describe, expect, test } from "bun:test";
import { startWebHttpServer } from "@chatgpt-tela/http-host";
import { CodexBackendClient } from "./codex-backend-client";

describe("Tela Gateway Codex private client", () => {
  test("relays dynamic Native tool names through only the private service protocol", async () => {
    const token = "z".repeat(48);
    const seen: unknown[] = [];
    const server = await startWebHttpServer({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodyBytes: 1024 * 1024,
      async fetch(request) {
        if (request.headers.get("authorization") !== `Bearer ${token}`) {
          return new Response(null, { status: 401 });
        }
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/v1/status") {
          return Response.json({
            contractVersion: 1,
            service: "codex",
            instanceId: "codex-private-fixture",
            state: "ready",
          });
        }
        if (request.method === "POST" && url.pathname === "/v1/codex/tools/inventory") {
          seen.push(await request.json());
          return Response.json({
            tools: [{
              wireName: "future_runtime_tool_2040",
              name: "future_runtime_tool_2040",
              kind: "function",
              description: "runtime-provided tool",
              inputSchema: { type: "object" },
              observedFrom: ["fixture-runtime"],
            }],
          });
        }
        if (request.method === "POST" && url.pathname === "/v1/codex/tools/invoke") {
          const body = await request.json();
          seen.push(body);
          return Response.json({
            result: {
              callId: (body as { invocation: { callId: string } }).invocation.callId,
              content: "future-ok",
              isError: false,
            },
          });
        }
        return new Response(null, { status: 404 });
      },
    });
    const client = new CodexBackendClient({
      version: 1,
      service: "codex",
      instanceId: "codex-private-fixture",
      installId: "install-fixture",
      pid: 1,
      endpoint: `http://127.0.0.1:${server.port}/`,
      bearerToken: token,
      startedAt: "2026-09-27T00:00:00.000Z",
    });
    try {
      expect((await client.status()).state).toBe("ready");
      expect((await client.inventory("turnr_ProfileA1_opaque", "future"))[0]?.wireName)
        .toBe("future_runtime_tool_2040");
      expect((await client.invoke("turnr_ProfileA1_opaque", {
        callId: "call-future-1",
        wireName: "future_runtime_tool_2040",
        mode: "structured",
        arguments: { arbitrary: true },
      })).content).toBe("future-ok");
      expect(JSON.stringify(seen)).toContain("future_runtime_tool_2040");
    } finally {
      await server.stop();
    }
  });
});

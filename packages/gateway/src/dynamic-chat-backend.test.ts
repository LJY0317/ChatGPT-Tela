import { describe, expect, test } from "bun:test";
import { startWebHttpServer } from "@chatgpt-tela/http-host";
import { DynamicChatBackend } from "./dynamic-chat-backend";

describe("dynamic Tela Chat backend", () => {
  test("resolves the current Chat descriptor per call and crosses only the private service protocol", async () => {
    const token = "h".repeat(48);
    const seen: unknown[] = [];
    const server = await startWebHttpServer({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodyBytes: 1024 * 1024,
      async fetch(request) {
        if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/v1/capabilities") {
          return Response.json({ contractVersion: 1, service: "chat",
            capabilities: ["read", "future_chat_capability_2099"],
            catalog: [
              { capability: "read", description: "Read a bounded workspace file",
                inputSchema: { type: "object", properties: { path: { type: "string" } } } },
              { capability: "future_chat_capability_2099", description: "Future runtime capability",
                inputSchema: { type: "object", properties: { future: { type: "boolean" } } } },
            ] });
        }
        if (request.method === "POST" && url.pathname === "/v1/call") {
          const body = await request.json();
          seen.push(body);
          const capability = (body as { capability: string }).capability;
          return Response.json({ contractVersion: 1, service: "chat", capability,
            result: { capability, via: "private-http" } });
        }
        return new Response(null, { status: 404 });
      },
    });
    let available = true;
    const backend = new DynamicChatBackend(() => available
      ? {
          version: 1,
          service: "chat",
          instanceId: "chat-private-fixture",
          installId: "install-fixture",
          pid: 1,
          endpoint: `http://127.0.0.1:${server.port}/`,
          bearerToken: token,
          startedAt: "2026-09-27T00:00:00.000Z",
        }
      : undefined);
    try {
      expect((await backend.inventory("future")).map(item => item.capability)).toEqual(["future_chat_capability_2099"]);
      expect(await backend.call("read", { workspace_id: "chatws_fixture", path: "README.md" }))
        .toEqual({ capability: "read", via: "private-http" });
      expect(seen).toEqual([{ capability: "read", arguments: { workspace_id: "chatws_fixture", path: "README.md" } }]);
      available = false;
      await expect(backend.call("read", {})).rejects.toThrow("Chat backend is unavailable");
    } finally {
      await server.stop();
    }
  });
});

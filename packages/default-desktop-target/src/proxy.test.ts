import { describe, expect, test } from "bun:test";
import { createDefaultDesktopResponsesRoute, TELA_DEFAULT_DESKTOP_PROVIDER_ID } from "./route";
import { startDefaultDesktopAppServerProxy } from "./proxy";

function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("fixture WebSocket failed")), { once: true });
  });
}

describe("default Desktop route-preserving app-server proxy", () => {
  test("rewrites only routed thread requests and forwards upstream replies", async () => {
    const observed: string[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        return server.upgrade(request) ? undefined : new Response(null, { status: 400 });
      },
      websocket: {
        message(socket, message) {
          if (typeof message !== "string") return socket.close(1003, "text only");
          observed.push(message);
          socket.send(JSON.stringify({ ok: true, received: observed.length }));
        },
      },
    });
    const proxy = await startDefaultDesktopAppServerProxy({
      upstreamEndpoint: `ws://127.0.0.1:${upstream.port}/`,
      route: createDefaultDesktopResponsesRoute({
        baseUrl: "http://127.0.0.1:18741/v1",
        envKey: "CHATGPT_TELA_RUNTIME_TOKEN",
        credential: "x".repeat(48),
      }),
    });
    const client = await openSocket(proxy.endpoint);
    try {
      const reply = new Promise<string>((resolve, reject) => {
        client.addEventListener("message", event => resolve(String(event.data)), { once: true });
        client.addEventListener("error", () => reject(new Error("proxy client error")), { once: true });
      });
      client.send(JSON.stringify({ id: 1, method: "thread/start", params: { config: {} } }));
      expect(JSON.parse(await reply)).toEqual({ ok: true, received: 1 });
      const routed = JSON.parse(observed[0]!) as any;
      expect(routed.params.modelProvider).toBe(TELA_DEFAULT_DESKTOP_PROVIDER_ID);
      expect(routed.params.config.model_provider).toBe(TELA_DEFAULT_DESKTOP_PROVIDER_ID);

      const unrelated = '{"id":2,"method":"thread/read","params":{"threadId":"abc"}}';
      const secondReply = new Promise<string>(resolve => {
        client.addEventListener("message", event => resolve(String(event.data)), { once: true });
      });
      client.send(unrelated);
      await secondReply;
      expect(observed[1]).toBe(unrelated);
    } finally {
      client.close();
      await proxy.close();
      upstream.stop(true);
    }
  });

  test("rejects non-loopback upstream endpoints before listening", async () => {
    const route = createDefaultDesktopResponsesRoute({
      baseUrl: "http://127.0.0.1:18741/v1",
      envKey: "CHATGPT_TELA_RUNTIME_TOKEN",
      credential: "x".repeat(48),
    });
    await expect(startDefaultDesktopAppServerProxy({ upstreamEndpoint: "ws://example.com:9999/", route }))
      .rejects.toThrow("loopback");
  });
});

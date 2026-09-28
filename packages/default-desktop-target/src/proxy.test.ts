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

  test("augments only the exact model/list response id and preserves unrelated app-server traffic", async () => {
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
          const request = JSON.parse(message) as any;
          socket.send(JSON.stringify({ method: "thread/status/changed", params: { untouched: true } }));
          socket.send(JSON.stringify({
            id: request.id,
            result: request.method === "model/list"
              ? { data: [{ id: "native", model: "native", displayName: "Native" }], nextCursor: null }
              : { untouched: true },
          }));
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
      augmentModelList(result) {
        const value = result as any;
        return { ...value, data: [...value.data, { id: "web", model: "web", displayName: "Web" }] };
      },
    });
    const client = await openSocket(proxy.endpoint);
    const messages: any[] = [];
    client.addEventListener("message", event => { messages.push(JSON.parse(String(event.data))); });
    try {
      client.send(JSON.stringify({ id: 41, method: "model/list", params: {} }));
      const deadline = Date.now() + 2_000;
      while (messages.length < 2 && Date.now() < deadline) await Bun.sleep(10);
      expect(messages[0]).toEqual({ method: "thread/status/changed", params: { untouched: true } });
      expect(messages[1]).toEqual({
        id: 41,
        result: {
          data: [
            { id: "native", model: "native", displayName: "Native" },
            { id: "web", model: "web", displayName: "Web" },
          ],
          nextCursor: null,
        },
      });

      client.send(JSON.stringify({ id: 42, method: "thread/read", params: { threadId: "abc" } }));
      while (messages.length < 4 && Date.now() < deadline) await Bun.sleep(10);
      expect(messages[3]).toEqual({ id: 42, result: { untouched: true } });
      expect(observed).toHaveLength(2);
    } finally {
      client.close();
      await proxy.close();
      upstream.stop(true);
    }
  });

  test("model/list augmentation failure preserves the Native result rather than breaking Desktop", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        return server.upgrade(request) ? undefined : new Response(null, { status: 400 });
      },
      websocket: {
        message(socket, message) {
          if (typeof message !== "string") return;
          const request = JSON.parse(message) as any;
          socket.send(JSON.stringify({ id: request.id, result: { data: [{ model: "native" }], nextCursor: null } }));
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
      augmentModelList() { throw new Error("simulated catalog mismatch"); },
    });
    const client = await openSocket(proxy.endpoint);
    try {
      const reply = new Promise<any>((resolve, reject) => {
        client.addEventListener("message", event => resolve(JSON.parse(String(event.data))), { once: true });
        client.addEventListener("error", () => reject(new Error("proxy client error")), { once: true });
      });
      client.send(JSON.stringify({ id: "models-1", method: "model/list", params: {} }));
      expect(await reply).toEqual({
        id: "models-1",
        result: { data: [{ model: "native" }], nextCursor: null },
      });
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

  test("close is bounded even when the connected client does not initiate its own close", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        return server.upgrade(request) ? undefined : new Response(null, { status: 400 });
      },
      websocket: { message() {} },
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
    client.addEventListener("error", () => { /* expected when bounded shutdown terminates the socket */ });
    const startedAt = Date.now();
    try {
      await proxy.close();
      expect(Date.now() - startedAt).toBeLessThan(2_500);
      expect(proxy.activeConnectionCount).toBe(0);
    } finally {
      try { client.close(); } catch { /* already terminated by the proxy */ }
      upstream.stop(true);
    }
  });
});

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { connectCodexAppServerWebSocket } from "@chatgpt-tela/codex";
import { createAccountCheck } from "./account-check";
import { startProfileBridgePreviewServer } from "./bridge-preview-server";

test("authenticated HTTP account checks use fresh Native RPC and never mutate authentication", async () => {
  let container = "synthetic-container-a";
  const requests: { method: string; params?: unknown }[] = [];
  const native = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response(null, { status: 404 }); },
    websocket: {
      message(socket, message) {
        const row = JSON.parse(String(message));
        requests.push({ method: row.method, params: row.params });
        if (row.id === undefined) return;
        const result = row.method === "initialize" ? {} : row.method === "account/read"
          ? { account: { type: "chatgpt", email: "private@example.invalid" }, workspaceRouting: { chatgptAccountId: container } }
          : undefined;
        socket.send(JSON.stringify({ id: row.id, ...(result === undefined
          ? { error: { message: "Unexpected mutation or method" } } : { result }) }));
      },
    },
  });
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const binding = hash("synthetic-user-a");
  const token = "t".repeat(48);
  const preview = await startProfileBridgePreviewServer({ slot: 1, bearerToken: token,
    observe: async () => ({ activeSurfaceCount: 0 }),
    accountCheck: createAccountCheck({
      async native(signal) {
        const rpc = await connectCodexAppServerWebSocket(`ws://127.0.0.1:${native.port}`, { signal });
        try { return await rpc.request("account/read", { refreshToken: false }, signal); }
        finally { await rpc.close(); }
      },
      web: async () => ({ accountFingerprint: binding, containerFingerprint: hash("synthetic-container-a"), accountStructure: "workspace" }),
      binding: () => binding,
    }),
  });
  try {
    const url = new URL("v1/account-check", preview.endpoint);
    expect((await fetch(url)).status).toBe(401);
    expect(requests).toHaveLength(0);
    const headers = { authorization: `Bearer ${token}` };
    const first = await fetch(url, { headers });
    expect(first.headers.get("cache-control")).toBe("no-store");
    const firstText = await first.text();
    expect(JSON.parse(firstText).nativeWebContainer).toBe("matching");
    expect(firstText).not.toContain("private@");
    expect(firstText).not.toContain(binding);
    container = "synthetic-container-b";
    const second = await (await fetch(url, { headers })).json() as any;
    expect(second.nativeWebContainer).toBe("different");
    expect(second.webBinding).toBe("matching");
    expect(second.userIdentity).toBe("unverified");
    expect(requests.filter(row => row.method === "account/read")).toEqual([
      { method: "account/read", params: { refreshToken: false } },
      { method: "account/read", params: { refreshToken: false } },
    ]);
    expect(requests.every(row => ["initialize", "initialized", "account/read"].includes(row.method))).toBe(true);
  } finally {
    await preview.close();
    await native.stop(true);
  }
});

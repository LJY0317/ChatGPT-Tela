import { describe, expect, test } from "bun:test";
import { startChatService } from "@chatgpt-tela/chat-service";
import { LocalServiceClient } from "@chatgpt-tela/service-protocol/client";
import { startGatewayService } from "./gateway-service";

describe("Tela Gateway service isolation", () => {
  test("starts and stays ready with both backends absent", async () => {
    const gateway = await startGatewayService({ resolveBackend: () => undefined, backendTimeoutMs: 25 });
    try {
      const status = await gateway.status();
      expect(status.service.state).toBe("ready");
      expect(status.backends.map(item => [item.service, item.availability])).toEqual([
        ["chat", "unavailable"],
        ["codex", "unavailable"],
      ]);
      const client = new LocalServiceClient({
        version: 1,
        service: "gateway",
        instanceId: gateway.instanceId,
        installId: "gateway-test",
        pid: process.pid,
        endpoint: gateway.endpoint.href,
        bearerToken: gateway.bearerToken,
        startedAt: new Date(0).toISOString(),
      });
      expect((await client.status()).state).toBe("ready");
    } finally {
      await gateway.close();
    }
  });

  test("healthy Chat stays available while Codex descriptor resolution fails", async () => {
    const token = "q".repeat(48);
    const chat = await startChatService({ bearerToken: token });
    const gateway = await startGatewayService({
      backendTimeoutMs: 50,
      resolveBackend(service) {
        if (service === "codex") throw new Error("codex descriptor corrupt");
        return {
          version: 1,
          service: "chat",
          instanceId: chat.instanceId,
          installId: "install-fixture",
          pid: process.pid,
          endpoint: chat.endpoint.href,
          bearerToken: token,
          startedAt: new Date(0).toISOString(),
        };
      },
    });
    try {
      const status = await gateway.status();
      expect(status.backends[0]?.availability).toBe("ready");
      expect(status.backends[1]).toEqual({
        service: "codex",
        availability: "unavailable",
        detail: "codex descriptor corrupt",
      });
    } finally {
      await gateway.close();
      await chat.close();
    }
  });

  test("reports public ingress independently from local Gateway/backend readiness", async () => {
    const gateway = await startGatewayService({
      resolveBackend: () => undefined,
      resolveIngressStatus: () => ({
        contractVersion: 1,
        availability: "unavailable",
        cause: "tailscale-backend-unreachable",
        detail: "Tailscale is not running or its local backend cannot be reached",
        exposureKind: "tailscale-funnel",
      }),
    });
    try {
      const response = await fetch(new URL("v1/ingress", gateway.endpoint), {
        headers: { authorization: `Bearer ${gateway.bearerToken}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        contractVersion: 1,
        availability: "unavailable",
        cause: "tailscale-backend-unreachable",
        detail: "Tailscale is not running or its local backend cannot be reached",
        exposureKind: "tailscale-funnel",
      });
      expect((await gateway.status()).service.state).toBe("ready");
    } finally {
      await gateway.close();
    }
  });
});

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
  test("public connection checks are explicit and do not stop healthy local services", async () => {
    let publicChecks = 0, recovered = false;
    const gateway = await startGatewayService({ resolveBackend: () => undefined,
      resolveIngressStatus(_signal, options) {
        if (options?.publicTransport) publicChecks++;
        return { contractVersion: 1, availability: !options?.publicTransport || recovered ? "ready" : "unavailable",
          localAvailability: "ready", publicAvailability: options?.publicTransport ? recovered ? "ready" : "unavailable" : "not-checked",
          cause: options?.publicTransport && !recovered ? "public-transport-unreachable" : "ready", detail: "fixture" };
      },
    });
    const read = async (path: string) => (await fetch(new URL(path, gateway.endpoint), { headers: { authorization: `Bearer ${gateway.bearerToken}` } })).json();
    try {
      expect(await read("v1/ingress")).toMatchObject({ availability: "ready", publicAvailability: "not-checked" });
      expect(publicChecks).toBe(0);
      expect(await read("v1/ingress?public=1")).toMatchObject({ availability: "unavailable", localAvailability: "ready", publicAvailability: "unavailable" });
      expect((await gateway.status()).service.state).toBe("ready");
      recovered = true;
      expect(await read("v1/ingress?public=1")).toMatchObject({ availability: "ready", publicAvailability: "ready" });
      expect(publicChecks).toBe(2);
    } finally { await gateway.close(); }
  });

});

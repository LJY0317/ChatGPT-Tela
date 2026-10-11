import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProductPaths } from "@chatgpt-tela/product-lifecycle";
import { startChatService } from "@chatgpt-tela/chat-service";
import { writeServiceRuntimeDescriptor } from "@chatgpt-tela/service-protocol";
import { ownedServiceShutdown } from "./service-shutdown";

test("a running registration without a runtime descriptor cannot authorize shutdown", async () => {
  const home = mkdtempSync(join(tmpdir(), "tela-shutdown-missing-"));
  try {
    const paths = resolveProductPaths({ platform: "linux", home, environment: {} });
    await expect(ownedServiceShutdown("fixture-install", paths)("chat")).rejects.toThrow("no authenticated runtime");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("foreign install runtime identity is preserved instead of authorizing shutdown", async () => {
  const home = mkdtempSync(join(tmpdir(), "tela-shutdown-foreign-"));
  const paths = resolveProductPaths({ platform: "linux", home, environment: {} });
  const service = await startChatService({ bearerToken: "foreign-fixture-token".repeat(3) });
  try {
    mkdirSync(paths.serviceRuntime("chat"), { recursive: true });
    writeServiceRuntimeDescriptor(join(paths.serviceRuntime("chat"), "descriptor.json"), {
      version: 1, service: "chat", instanceId: service.instanceId, installId: "foreign-install",
      pid: process.pid, endpoint: service.endpoint.href, bearerToken: service.bearerToken, startedAt: new Date().toISOString(),
    });
    await expect(ownedServiceShutdown("expected-install", paths)("chat")).rejects.toThrow();
    expect(service.status().state).toBe("ready");
    expect((await fetch(new URL("v1/status", service.endpoint), { headers: { authorization: `Bearer ${service.bearerToken}` } })).status).toBe(200);
  } finally { await service.close(); rmSync(home, { recursive: true, force: true }); }
});

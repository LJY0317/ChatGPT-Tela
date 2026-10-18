import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProductPaths, PackagedServiceShutdownNotStartedError } from "@chatgpt-tela/product-lifecycle";
import { startChatService, createChatToolRuntime } from "@chatgpt-tela/chat-service";
import { writeServiceRuntimeDescriptor } from "@chatgpt-tela/service-protocol";
import { ownedServiceShutdown } from "./service-shutdown";

test("real Chat admission reports a blocker without closing and translates only its owner receipt", async () => {
  const home = mkdtempSync(join(tmpdir(), "tela-shutdown-blocker-"));
  const paths = resolveProductPaths({ platform: "linux", home, environment: {} });
  const tools = createChatToolRuntime({ allowedRoots: [home], stateRoot: join(home, "tools") });
  let blocked = true, scans = 0;
  const service = await startChatService({ bearerToken: "fixture-token".repeat(4), tools: { ...tools,
    assertCanClose() { scans++; if (blocked) throw Error("private owner work"); },
  } });
  try {
    mkdirSync(paths.serviceRuntime("chat"), { recursive: true });
    writeServiceRuntimeDescriptor(join(paths.serviceRuntime("chat"), "descriptor.json"), {
      version: 1, service: "chat", instanceId: service.instanceId, installId: "fixture", pid: process.pid,
      endpoint: service.endpoint.href, bearerToken: service.bearerToken, startedAt: new Date().toISOString(),
    });
    const shutdown = ownedServiceShutdown("fixture", paths);
    service.status(); expect(scans).toBe(0);
    await shutdown.prepare("chat");
    expect(scans).toBe(0);
    await expect(shutdown("chat")).rejects.toBeInstanceOf(PackagedServiceShutdownNotStartedError);
    expect(scans).toBe(1);
    expect(service.status().state).toBe("ready");
    blocked = false; await shutdown.prepare("chat");
    blocked = true; // A new operation won admission after preflight.
    await expect(shutdown("chat")).rejects.toMatchObject({ service: "chat", name: "PackagedServiceShutdownNotStartedError" });
    expect(service.status().state).toBe("ready");
  } finally { blocked = false; await service.close(); rmSync(home, { recursive: true, force: true }); }
});

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

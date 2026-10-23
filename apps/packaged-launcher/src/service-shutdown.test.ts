import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProductPaths, PackagedServiceShutdownNotStartedError } from "@chatgpt-tela/product-lifecycle";
import { startChatService, createChatToolRuntime } from "@chatgpt-tela/chat-service";
import { writeServiceRuntimeDescriptor } from "@chatgpt-tela/service-protocol";
import { startCodexServiceHttpServer, type CodexService } from "@chatgpt-tela/codex-service";
import { ownedServiceShutdown } from "./service-shutdown";
import { ChatServiceClient, descriptorForService } from "@chatgpt-tela/service-protocol/client";

test("explicit maintenance cancellation is followed by observed shutdown readiness", async () => {
  const home = mkdtempSync(join(tmpdir(), "tela-update-cancel-path-"));
  const paths = resolveProductPaths({ platform: "linux", home, environment: {} });
  const tools = createChatToolRuntime({ allowedRoots: [home], stateRoot: join(home, "tools") });
  const entry = { workspaceId: tools.workspaces.open(home).id, workspaceName: "example-project", operationId: "fixture-operation", sessionId: 3,
    startedAt: new Date().toISOString(), state: "running", liveness: "alive" };
  let terminalJournal = false, cancellations = 0;
  const service = await startChatService({ bearerToken: "fixture-maintenance-token".repeat(2), tools: {
    ...tools,
    assertCanClose() { if (!terminalJournal) throw Error("unresolved owner"); },
    async maintenanceProcesses() { return terminalJournal ? [] : [entry]; },
    async call(capability, args) {
      expect(capability).toBe("cancel_process");
      expect(args).toEqual({ workspace_id: entry.workspaceId, operation_id: entry.operationId });
      cancellations++; terminalJournal = true;
      return { state: "signaled" };
    },
  } });
  try {
    mkdirSync(paths.serviceRuntime("chat"), { recursive: true });
    const descriptor = { version: 1 as const, service: "chat" as const, instanceId: service.instanceId,
      installId: "fixture", pid: process.pid, endpoint: service.endpoint.href,
      bearerToken: service.bearerToken, startedAt: new Date().toISOString() };
    writeServiceRuntimeDescriptor(join(paths.serviceRuntime("chat"), "descriptor.json"), descriptor);
    const owner = ownedServiceShutdown("fixture", paths);
    await expect(owner.prepare("chat")).rejects.toBeInstanceOf(PackagedServiceShutdownNotStartedError);
    const client = new ChatServiceClient(descriptorForService(descriptor, "chat"));
    expect(await client.maintenanceProcesses()).toEqual([entry]);
    expect(await client.call("cancel_process", { workspace_id: entry.workspaceId, operation_id: entry.operationId })).toEqual({ state: "signaled" });
    expect(cancellations).toBe(1);
    expect(await client.maintenanceProcesses()).toEqual([]);
    await owner.prepare("chat");
    expect(service.status().state).toBe("ready");
  } finally { terminalJournal = true; await service.close(); rmSync(home, { recursive: true, force: true }); }
});

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
    await expect(shutdown.prepare("chat")).rejects.toBeInstanceOf(PackagedServiceShutdownNotStartedError);
    expect(scans).toBe(1);
    expect(service.status().state).toBe("ready");
    blocked = false;
    await shutdown.prepare("chat");
    expect(scans).toBe(2);
    blocked = true;
    await expect(shutdown("chat")).rejects.toBeInstanceOf(PackagedServiceShutdownNotStartedError);
    expect(scans).toBe(3);
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


test("Codex activity is checked before any shutdown request", async () => {
  const home = mkdtempSync(join(tmpdir(), "tela-codex-preflight-"));
  const paths = resolveProductPaths({ platform: "linux", home, environment: {} });
  let blocked = true, shutdownCalls = 0;
  const service = {
    serviceStatus: () => ({ contractVersion: 1, service: "codex", instanceId: "fixture-codex", state: "ready" }),
    shutdownReadiness: async () => blocked ? "blocked" : "ready",
    close: async () => { shutdownCalls++; },
  } as unknown as CodexService;
  const http = await startCodexServiceHttpServer({ service });
  try {
    mkdirSync(paths.serviceRuntime("codex"), { recursive: true });
    writeServiceRuntimeDescriptor(join(paths.serviceRuntime("codex"), "descriptor.json"), {
      version: 1, service: "codex", instanceId: "fixture-codex", installId: "fixture", pid: process.pid,
      endpoint: http.endpoint.href, bearerToken: http.bearerToken, startedAt: new Date().toISOString(),
    });
    const shutdown = ownedServiceShutdown("fixture", paths);
    await expect(shutdown.prepare("codex")).rejects.toBeInstanceOf(PackagedServiceShutdownNotStartedError);
    expect(shutdownCalls).toBe(0);
    blocked = false;
    await shutdown.prepare("codex");
    expect(shutdownCalls).toBe(0);
  } finally { await http.close(); rmSync(home, { recursive: true, force: true }); }
});

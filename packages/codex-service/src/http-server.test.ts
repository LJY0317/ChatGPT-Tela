import { ProfileConnectionError } from "./profile-operation";
import { describe, expect, test } from "bun:test";
import { CodexShutdownNotStartedError, type CodexService } from "./controller";
import { startCodexServiceHttpServer } from "./http-server";
import { CodexServiceClient, ServiceShutdownNotStartedError } from "@chatgpt-tela/service-protocol/client";

function fixtureService(): CodexService {
  return {
    instanceId: "codex-fixture",
    config: {},
    tools: {
      async inventory() { return []; },
      async invoke(_capability, invocation) {
        return { callId: invocation.callId, content: "ok", isError: false };
      },
    },
    serviceStatus() {
      return { contractVersion: 1, service: "codex", instanceId: "codex-fixture", state: "ready" };
    },
    async shutdownReadiness() { return "ready"; },
    async profiles() { return []; },
    async startProfile() { throw new Error("not used"); },
    async waitWebPreparation() { throw new Error("not used"); },
    async reconnectWeb() { throw new Error("not used"); },
    async stopProfile() { throw new Error("not used"); },
    async terminalSession(slot) { return { contractVersion: 1, slot, endpoint: "ws://127.0.0.1:1234/" }; },
    async bridgeSurfaces(slot) { return { contractVersion: 1, slot, revision: 0, surfaces: [] }; },
    async bridgePreview(slot) {
      return {
        contractVersion: 1,
        slot,
        activeSurfaceCount: 1,
        previewAvailable: true,
        imageMimeType: "image/jpeg",
        imageBase64: "AQIDBA==",
      };
    },
    async modelSelectionCanary(slot) {
      return {
        contractVersion: 1,
        slot,
        familyCount: 3,
        exercised: true,
        testedEffort: "medium",
        restoredEffort: "high",
      };
    },
    async contextAttachmentCanary(slot) {
      return {
        contractVersion: 1,
        slot,
        attachmentBytes: 512,
        receiptVerified: true,
      };
    },
    async close() {},
    activeProfileCount: 0,
  };
}

describe("Tela Codex private HTTP server", () => {
  test("a busy owner returns the exact no-start shutdown receipt", async () => {
    const service = fixtureService();
    let stopAttempts = 0;
    service.close = async () => { stopAttempts++; throw new CodexShutdownNotStartedError(); };
    const server = await startCodexServiceHttpServer({ service });
    const client = new CodexServiceClient({ version: 1, service: "codex", instanceId: service.instanceId,
      installId: "fixture", pid: process.pid, endpoint: server.endpoint.href,
      bearerToken: server.bearerToken, startedAt: new Date().toISOString() });
    try {
      await expect(client.shutdown()).rejects.toBeInstanceOf(ServiceShutdownNotStartedError);
      expect(stopAttempts).toBe(1);
      expect(service.serviceStatus().state).toBe("ready");
    } finally { await client.close(); await server.close(); }
  });

  test("service readiness waits for its one startup restoration pass", async () => {
    let complete=false;
    const server=await startCodexServiceHttpServer({service:fixtureService(),startupComplete:()=>complete});
    const client=new CodexServiceClient({version:1,service:'codex',instanceId:'codex-fixture',installId:'fixture',
      pid:process.pid,endpoint:server.endpoint.href,bearerToken:server.bearerToken,startedAt:new Date().toISOString()});
    try {
      expect((await client.status()).state).toBe('degraded');
      complete=true;expect((await client.status()).state).toBe('ready');
    } finally {await server.close();}
  });

  test("shutdown readiness is an opt-in status observation and unknown work blocks", async () => {
    const service = fixtureService();
    let readiness: "ready" | "blocked" = "blocked";
    service.shutdownReadiness = async () => readiness;
    const server = await startCodexServiceHttpServer({ service });
    const client = new CodexServiceClient({ version: 1, service: "codex", instanceId: service.instanceId,
      installId: "fixture", pid: process.pid, endpoint: server.endpoint.href,
      bearerToken: server.bearerToken, startedAt: new Date().toISOString() });
    try {
      expect((await client.status()).shutdownReadiness).toBeUndefined();
      expect((await client.status(undefined, { shutdownReadiness: true })).shutdownReadiness).toBe("blocked");
      readiness = "ready";
      expect((await client.status(undefined, { shutdownReadiness: true })).shutdownReadiness).toBe("ready");
    } finally { await client.close(); await server.close(); }
  });

  test("managed Web delegation capacity is an authenticated, content-free read", async () => {
    const service = fixtureService(), token = "c".repeat(48);
    let reads = 0;
    const server = await startCodexServiceHttpServer({
      service, bearerToken: token,
      delegationCapacity: (...args) => {
        expect(args).toEqual([2]);
        const [slot] = args;
        reads++;
        return { contractVersion: 3, profileSlot: slot, source: "managed_delegation_journal",
          observedAt: new Date().toISOString(), coverage: "managed_jobs_only",
          policy: "configurable_tasks_one_writer_per_checkout_v3",
          uncertain: 0,
          total: { used: 3, limit: 3 }, records: { retained: 3, limit: 64 },
          available: false, blockCode: "CAPACITY_TOTAL_PROFILE",
          messageKo: "위임 한도 도달", messageEn: "Delegation limit reached",
          nextAction: "wait_for_active_job" };
      },
    });
    const client = new CodexServiceClient({ version: 1, service: "codex", instanceId: service.instanceId,
      installId: "fixture", pid: process.pid, endpoint: server.endpoint.href,
      bearerToken: token, startedAt: new Date().toISOString() });
    try {
      const url = new URL("v1/codex/profiles/2/web-delegation-capacity", server.endpoint);
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { headers: { authorization: `Bearer ${token}`,
        origin: "https://chatgpt.com" } })).status).toBe(403);
      expect((await client.webDelegationCapacity(2)).blockCode).toBe("CAPACITY_TOTAL_PROFILE");
      expect(reads).toBe(1);
      await expect(client.webDelegationCapacity(0)).rejects.toThrow("invalid profile slot");
    } finally { await client.close(); await server.close(); }
  });
  test("shutdown does not acknowledge or stop the service when child cleanup is refused", async () => {
    const service = fixtureService(); let refuse = true, calls = 0, signaled = false;
    service.close = async () => { calls++; if (refuse) throw Error("normal owned quit refused"); };
    const token = "q".repeat(48), server = await startCodexServiceHttpServer({ service, bearerToken: token });
    void server.shutdownRequested.then(() => { signaled = true; });
    const headers = { authorization: `Bearer ${token}` };
    try {
      expect((await fetch(new URL("v1/shutdown", server.endpoint), { method: "POST", headers })).status).toBe(409);
      expect(calls).toBe(1); expect(signaled).toBe(false);
      expect((await fetch(new URL("v1/status", server.endpoint), { headers })).status).toBe(200);
      refuse = false;
      expect((await fetch(new URL("v1/shutdown", server.endpoint), { method: "POST", headers })).status).toBe(200);
      await server.shutdownRequested; expect(signaled).toBe(true); expect(calls).toBe(2);
    } finally { await server.close(); }
  });
  test("synthetic cleanup rejects browser-origin callers and mismatched profile receipts", async () => {
    const service = fixtureService();
    let invoked = 0, wrongSlot = false;
    service.recoverSyntheticSavedChat = async slot => {
      invoked++;
      return { contractVersion: 1, slot: wrongSlot ? 2 : slot,
        syntheticConversationProven: true, officialDelete: { contractVersion: 1,
          menuOpened: true, officialDeleteSelected: true,
          officialConfirmationDispatched: true, historyAbsentAfterReload: true } };
    };
    const token = "v".repeat(48);
    const server = await startCodexServiceHttpServer({ service, bearerToken: token });
    const c = new CodexServiceClient({ version: 1, service: "codex", instanceId: service.instanceId,
      installId: "fixture", pid: process.pid, endpoint: server.endpoint.href,
      bearerToken: token, startedAt: new Date().toISOString() });
    try {
      const uri = new URL("v1/codex/profiles/1/synthetic-cleanup", server.endpoint);
      expect((await fetch(uri, { method: "POST" })).status).toBe(401);
      expect((await fetch(uri, { method: "POST", headers: { authorization: `Bearer ${token}`,
        origin: "https://chatgpt.com" } })).status).toBe(403);
      expect(invoked).toBe(0);
      expect((await c.recoverSyntheticSavedChat(1)).officialDelete.historyAbsentAfterReload).toBe(true);
      wrongSlot = true;
      await expect(c.recoverSyntheticSavedChat(1)).rejects.toThrow();
      expect(invoked).toBe(2);
    } finally { await c.close(); await server.close(); }
  });
  test("saved delete acceptance cannot run from a browser origin or return a wrong-slot receipt", async () => {
    const service = fixtureService();
    let called = 0;
    let mismatched = false;
    service.runSavedDeleteAcceptance = async slot => {
      called++;
      return { contractVersion: 1, slot: mismatched ? 2 : slot, newlyAccepted: true,
        modelReplyCompleted: true, officialDelete: { contractVersion: 1,
          menuOpened: true, officialDeleteSelected: true,
          officialConfirmationDispatched: true, historyAbsentAfterReload: true } };
    };
    const token = "q".repeat(48);
    const server = await startCodexServiceHttpServer({ service, bearerToken: token });
    const client = new CodexServiceClient({ version: 1, service: "codex", instanceId: service.instanceId,
      installId: "fixture", pid: process.pid, endpoint: server.endpoint.href,
      bearerToken: token, startedAt: new Date().toISOString() });
    try {
      const url = new URL("v1/codex/profiles/1/saved-delete-acceptance", server.endpoint);
      expect((await fetch(url, { method: "POST" })).status).toBe(401);
      expect((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`,
        origin: "https://chatgpt.com" } })).status).toBe(403);
      expect(called).toBe(0);
      expect((await client.runSavedDeleteAcceptance(1)).newlyAccepted).toBe(true);
      mismatched = true;
      await expect(client.runSavedDeleteAcceptance(1)).rejects.toThrow();
      expect(called).toBe(2);
    } finally { await client.close(); await server.close(); }
  });
  test("history preflight rejects unowned callers and wrong-slot private observations", async () => {
    const service = fixtureService();
    const seen: number[] = [];
    let mismatch = false;
    service.inspectAccountBrowserHistoryUi = async slot => {
      seen.push(slot);
      return { contractVersion: 1, slot: mismatch ? 1 : slot, route: "home", historyLinkCount: 0,
        visibleHistoryLinkCount: 0, nearbyActionRowCount: 0,
        nearbyMenuRowCount: 0, visibleMenuCount: 0, visibleDialogCount: 0 };
    };
    const token = "r".repeat(48);
    const server = await startCodexServiceHttpServer({ service, bearerToken: token });
    const client = new CodexServiceClient({ version: 1, service: "codex", instanceId: service.instanceId,
      installId: "fixture", pid: process.pid, endpoint: server.endpoint.href,
      bearerToken: token, startedAt: new Date().toISOString() });
    try {
      const url = new URL("v1/codex/profiles/2/account-browser-history-ui", server.endpoint);
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { headers: { authorization: `Bearer ${token}`, origin: "https://chatgpt.com" } })).status).toBe(403);
      expect(seen).toEqual([]);
      expect((await client.inspectAccountBrowserHistoryUi(2)).slot).toBe(2);
      mismatch = true;
      await expect(client.inspectAccountBrowserHistoryUi(2)).rejects.toThrow();
      expect(seen).toEqual([2, 2]);
    } finally { await client.close(); await server.close(); }
  });
  test("closing the exact account browser uses only the authenticated profile path", async () => {
    const service = fixtureService();
    const closed: number[] = [];
    service.closeAccountBrowser = async slot => { closed.push(slot); };
    const token = "q".repeat(48);
    const server = await startCodexServiceHttpServer({ service, bearerToken: token });
    const client = new CodexServiceClient({ version: 1, service: "codex", instanceId: service.instanceId,
      installId: "fixture", pid: process.pid, endpoint: server.endpoint.href, bearerToken: token, startedAt: new Date().toISOString() });
    const url = new URL("v1/codex/profiles/2/account-browser-close", server.endpoint);
    try {
      expect((await fetch(url, { method: "POST" })).status).toBe(401);
      expect((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, origin: "https://chatgpt.com" } })).status).toBe(403);
      expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
      expect(closed).toEqual([]);
      await client.closeAccountBrowser(2);
      expect(closed).toEqual([2]);
      await expect(client.closeAccountBrowser(100)).rejects.toThrow("invalid profile slot");
      expect(closed).toEqual([2]);
    } finally { await client.close(); await server.close(); }
  });
  test("running Web account browser route is per-slot, authenticated and not a launcher setup bypass", async () => {
    const service = fixtureService(); const invoked: number[] = [];
    service.openAccountBrowser = async slot => { invoked.push(slot); };
    const token = "b".repeat(48);
    const server = await startCodexServiceHttpServer({ service, bearerToken: token });
    const url = new URL("v1/codex/profiles/2/account-browser", server.endpoint);
    try {
      expect((await fetch(url, { method: "POST" })).status).toBe(401);
      expect((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`,
        origin: "https://chatgpt.com" } })).status).toBe(403);
      expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
      expect((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` } })).status).toBe(204);
      expect(invoked).toEqual([2]);
    } finally { await server.close(); }
  });
  test("email display is local authenticated UI data, separate from inventory and coarse checks", async () => {
    const service = fixtureService(); let calls = 0; let wrongSlot = false;
    service.accountDisplay = async slot => { calls++; return { contractVersion: 1, slot: wrongSlot ? 2 : slot,
      native: { state: "signed-in", email: "work@example.invalid" }, web: { state: "signed-in", email: "web@example.invalid" }, comparison: "different" }; };
    const token = "d".repeat(48); const server = await startCodexServiceHttpServer({ service, bearerToken: token });
    const client = new CodexServiceClient({ version: 1, service: "codex", instanceId: service.instanceId, installId: "fixture", pid: process.pid,
      endpoint: server.endpoint.href, bearerToken: token, startedAt: new Date().toISOString() });
    try {
      const url = new URL("v1/codex/profiles/1/account-display", server.endpoint);
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { headers: { authorization: `Bearer ${token}`, origin: "https://chatgpt.com" } })).status).toBe(403);
      expect(calls).toBe(0);
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await response.json() as any).native.email).toBe("work@example.invalid");
      const inventory = await (await fetch(new URL("v1/codex/profiles", server.endpoint), { headers: { authorization: `Bearer ${token}` } })).text();
      expect(inventory).not.toContain("@example");
      wrongSlot = true;
      await expect(client.accountDisplay(1)).rejects.toThrow("slot");
    } finally { await client.close(); await server.close(); }
  });
  test("account check is authenticated, on demand, coarse, and slot-bound through the client", async () => {
    const service = fixtureService(); let calls = 0; let wrongSlot = false;
    service.accountCheck = async slot => { calls++; return { contractVersion: 1, slot: wrongSlot ? 2 : slot,
      nativeSignIn: "signed-in", webBinding: "matching", nativeWebContainer: "matching", userIdentity: "unverified", email: "private" } as any; };
    const token = "a".repeat(48); const server = await startCodexServiceHttpServer({ service, bearerToken: token });
    const client = new CodexServiceClient({version:1, service:"codex", instanceId:service.instanceId, installId:"fixture", pid:process.pid,
      endpoint:server.endpoint.href,bearerToken:token,startedAt:new Date().toISOString()});
    try {
      const url = new URL("v1/codex/profiles/1/account-check", server.endpoint);
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url,{headers:{authorization:`Bearer ${token}`,origin:"https://chatgpt.com"}})).status).toBe(403);
      expect(calls).toBe(0);
      const response = await fetch(url,{headers:{authorization:`Bearer ${token}`}});
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("private");
      expect((await client.accountCheck(1)).userIdentity).toBe("unverified");
      wrongSlot = true;
      await expect(client.accountCheck(1)).rejects.toThrow("slot does not match");
      expect((await fetch(url,{method:"POST",headers:{authorization:`Bearer ${token}`}})).status).toBe(404);
      expect(calls).toBe(3);
    } finally { await client.close(); await server.close(); }
  });
  test("reopen options reach both response modes; invalid consent cannot start an operation", async () => {
    const service = fixtureService();
    const calls: unknown[] = [];
    service.startProfile = async (slot, options) => {
      calls.push({ slot, pid: options?.expectedDesktopProcessId, stopped: options?.requireStopped });
      return { slot, targetId: "default", targetDisplayName: "ChatGPT", targetState: "running", targetSessionState: "ready", controlState: "running" };
    };
    const token = "p".repeat(48);
    const server = await startCodexServiceHttpServer({ service, bearerToken: token });
    try {
      const url = new URL("v1/codex/profiles/1/start", server.endpoint);
      for (const accept of ["application/json", "application/x-ndjson"]) {
        const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, accept },
          body: JSON.stringify({ expectedDesktopProcessId: 123 }) });
        expect(response.status).toBe(200); await response.text();
      }
      const stopped = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: '{"requireStopped":true}' });
      expect(stopped.status).toBe(200);
      for (const body of ['{"expectedDesktopProcessId":0}', '{"expectedDesktopProcessId":"123"}', '{"requireStopped":"yes"}', '{"unknown":true}', '[]', 'x'.repeat(1025)]) {
        expect((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` }, body })).status).toBe(400);
      }
      expect(calls).toEqual([{ slot: 1, pid: 123, stopped: undefined }, { slot: 1, pid: 123, stopped: undefined }, { slot: 1, pid: undefined, stopped: true }]);
    } finally { await server.close(); }
  });
  test("serves bridge preview only behind the private service bearer and disables caching", async () => {
    const token = "c".repeat(48);
    const server = await startCodexServiceHttpServer({ service: fixtureService(), bearerToken: token });
    try {
      const url = new URL("v1/codex/profiles/2/bridge-preview", server.endpoint);
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { headers: { authorization: `Bearer ${token}`, origin: "https://chatgpt.com" } })).status).toBe(403);
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        contractVersion: 1,
        slot: 2,
        activeSurfaceCount: 1,
        previewAvailable: true,
        imageMimeType: "image/jpeg",
        imageBase64: "AQIDBA==",
      });
    } finally {
      await server.close();
    }
  });

  test("serves explicit model-selection canary through the private service only", async () => {
    const token = "m".repeat(48);
    const server = await startCodexServiceHttpServer({ service: fixtureService(), bearerToken: token });
    try {
      const url = new URL("v1/codex/profiles/1/model-selection-canary", server.endpoint);
      expect((await fetch(url, { method: "POST" })).status).toBe(401);
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        contractVersion: 1,
        slot: 1,
        familyCount: 3,
        exercised: true,
        testedEffort: "medium",
        restoredEffort: "high",
      });
    } finally {
      await server.close();
    }
  });

  test("serves explicit context-attachment canary through the private service only", async () => {
    const token = "a".repeat(48);
    const server = await startCodexServiceHttpServer({ service: fixtureService(), bearerToken: token });
    try {
      const url = new URL("v1/codex/profiles/1/context-attachment-canary", server.endpoint);
      expect((await fetch(url, { method: "POST" })).status).toBe(401);
      expect((await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, origin: "https://chatgpt.com" },
      })).status).toBe(403);
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        contractVersion: 1,
        slot: 1,
        attachmentBytes: 512,
        receiptVerified: true,
      });
    } finally {
      await server.close();
    }
  });
});

test("terminal attachment is private, no-store and does not start or stop a profile", async () => {
  const token = "t".repeat(48);
  const service = fixtureService();
  const server = await startCodexServiceHttpServer({ service, bearerToken: token });
  try {
    const url = new URL("v1/codex/profiles/2/terminal-session", server.endpoint);
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: `Bearer ${token}`, origin: "http://localhost" } })).status).toBe(403);
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ contractVersion: 1, slot: 2, endpoint: "ws://127.0.0.1:1234/" });
  } finally { await server.close(); }
});


test("authenticated connection stream delivers progress before completion and a safe failure phase", async () => {
  const token = "p".repeat(48);
  const service = fixtureService();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  service.startProfile = async (_slot, options) => {
    calls++;
    options?.onProgress?.("checking");
    options?.onProgress?.("closing");
    await blocked;
    throw new ProfileConnectionError("closing", { cause: new Error("private fixture data") });
  };
  const server = await startCodexServiceHttpServer({ service, bearerToken: token });
  try {
    const url = new URL("v1/codex/profiles/1/start", server.endpoint);
    const headers = { authorization: `Bearer ${token}`, accept: "application/x-ndjson" };
    expect((await fetch(url, { method: "POST", headers: { ...headers, origin: "https://chatgpt.com" } })).status).toBe(403);
    expect(calls).toBe(0);
    const response = await fetch(url, { method: "POST", headers });
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const reader = response.body!.getReader();
    const first = await reader.read();
    const progress = new TextDecoder().decode(first.value);
    expect(progress).toContain('"phase":"checking"');
    expect(progress).toContain('"phase":"closing"');
    expect(progress).not.toContain('"error"');
    release();
    let result = "";
    while (true) { const item = await reader.read(); if (item.done) break; result += new TextDecoder().decode(item.value); }
    expect(JSON.parse(result).error.phase).toBe("closing");
    expect(result).not.toContain("private fixture");
    expect(calls).toBe(1);
  } finally { release(); await server.close(); }
});

test("connection stream exposes Native immediately while Web waits, then preserves Native on Web failure", async () => {
  const service = fixtureService();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const profile = { slot: 1, targetId: "default", targetDisplayName: "ChatGPT", targetState: "running", targetSessionState: "ready", controlState: "running" as const, webModelsReady: false };
  service.startProfile = async () => ({ ...profile, webState: "preparing" });
  service.waitWebPreparation = async () => { await gate; return { ...profile, webState: "failed" }; };
  service.stopProfile = async () => { throw new Error("Native must not stop"); };
  let retries = 0;
  service.reconnectWeb = async () => { retries++; return { ...profile, webState: "ready", webModelsReady: true }; };
  const token = "v".repeat(48);
  const server = await startCodexServiceHttpServer({ service, bearerToken: token });
  try {
    const response = await fetch(new URL("v1/codex/profiles/1/start", server.endpoint), { method: "POST", headers: { authorization: `Bearer ${token}`, accept: "application/x-ndjson" } });
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"webState":"preparing"'); expect(first).toContain('"controlState":"running"');
    release();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"webState":"failed"');
    await reader.cancel();
    const url = new URL("v1/codex/profiles/1/web-reconnect", server.endpoint);
    expect((await fetch(url, { method: "POST" })).status).toBe(401);
    const retry = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect((await retry.json()).webModelsReady).toBe(true); expect(retries).toBe(1);
  } finally { release(); await server.close(); }
});

test("private service forwards exact selected preview and explicit reveal without unauthenticated actions", async () => {
  const service = fixtureService(), token = "u".repeat(48), id = "surface_" + "a".repeat(32);
  const calls: string[] = [];
  service.bridgePreview = async (slot, selected) => {
    calls.push(`preview:${slot}:${selected}`);
    return { contractVersion: 1, slot, activeSurfaceCount: 0, previewAvailable: false };
  };
  const modes: boolean[] = [];
  service.revealBridgeSurface = async (slot, selected, interactive) => { calls.push(`reveal:${slot}:${selected}`); modes.push(interactive === true); };
  const server = await startCodexServiceHttpServer({service, bearerToken: token});
  const headers = {authorization: `Bearer ${token}`, "content-type": "application/json"};
  try {
    expect((await fetch(new URL(`v1/codex/profiles/2/bridge-preview?surfaceId=${id}`, server.endpoint), {headers})).status).toBe(200);
    const url = new URL("v1/codex/profiles/2/bridge-reveal", server.endpoint), body = JSON.stringify({surfaceId: id});
    expect((await fetch(url, {method: "POST", body})).status).toBe(401);
    expect((await fetch(url, {method: "POST", headers: {...headers, origin: "https://example.test"}, body})).status).toBe(403);
    expect((await fetch(url, {method: "POST", headers, body})).status).toBe(204);
    expect(calls).toEqual([`preview:2:${id}`, `reveal:2:${id}`]);
    expect(modes).toEqual([false]);
    expect((await fetch(url, {method:"POST",headers,body:JSON.stringify({surfaceId:id,interactive:"true"})})).status).toBe(400);
    expect((await fetch(url, {method:"POST",headers,body:JSON.stringify({surfaceId:id,interactive:true})})).status).toBe(204);
    expect(modes).toEqual([false,true]);
  } finally {await server.close();}
});

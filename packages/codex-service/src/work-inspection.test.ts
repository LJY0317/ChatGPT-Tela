import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAppServerRpc } from "@chatgpt-tela/codex";
import { CodexServiceClient } from "@chatgpt-tela/service-protocol/client";
import { startCodexServiceHttpServer } from "./http-server";
import type { CodexService } from "./controller";
import { createCodexWorkInspector } from "./work-inspection";
import { diagnosticFingerprint } from "@chatgpt-tela/core";
import { writeFileSync } from "node:fs";

const threadId = "11111111-2222-7333-8444-555555555555";
const turnId = "66666666-7777-7888-9999-aaaaaaaaaaaa";
const profile = {
  slot: 2, targetId: "fixture", targetDisplayName: "Fixture", targetState: "running",
  targetSessionState: "ready", controlState: "running" as const, childProcessId: 4242,
  responsesRouteFingerprint: "b".repeat(64),
};
function harness() {
  let current = profile;
  const calls: { method: string; args: any }[] = [];
  let closed = false;
  const rpc = {
    async request(method: string, args: any) {
      calls.push({ method, args });
      if (method === "thread/read") return { thread: {
        id: threadId, status: { type: "active" }, historyMode: "paginated",
        updatedAt: 1792224222, cwd: "/PRIVATE/OWNER",
      } };
      if (method === "thread/turns/list") return { data: [
        { id: turnId, status: "inProgress", itemsView: "notLoaded", items: [] },
      ], nextCursor: null };
      throw Error("unexpected Native call");
    },
    async close() { closed = true; },
  };
  let preview = {
    contractVersion: 1 as const, slot: 2, activeSurfaceCount: 1, previewAvailable: true,
    imageMimeType: "image/jpeg" as const, imageBase64: "SECRET_SCREENSHOT_IMAGE",
    retention: { total: 129, target: 10, active: 128, undelivered: 1, closing: 0, otherOwners: 0, reclaimable: 0 },
    approvalState: "unavailable" as const, approvalObservationReason: "dom_observation_failed" as const,
  };
  const service = {
    async profiles() { return [current]; },
    async terminalSession(slot: number) { return { contractVersion: 1 as const, slot, endpoint: "ws://127.0.0.1:1234/", runtimeProcessId: 10, responsesRouteFingerprint: "a".repeat(64) }; },
    async bridgePreview() { return preview; },
  };
  return {
    rpc, calls, service,
    connect: async () => rpc as unknown as CodexAppServerRpc,
    changeOwner() { current = { ...current, childProcessId: current.childProcessId + 1 }; },
    get closed() { return closed; },
  };
}

describe("profile-owned read-only Work inspection", () => {
  test("turn-scoped request and settlement boundaries survive an unselected browser without borrowing older finals", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-turn-boundary-"));
    const f = harness();
    f.service.bridgePreview = async () => ({ contractVersion: 1, slot: 2, activeSurfaceCount: 2,
      previewAvailable: false, approvalState: "unavailable" } as any);
    const at = new Date().toISOString();
    const scope = diagnosticFingerprint(threadId), current = diagnosticFingerprint(turnId);
    const other = diagnosticFingerprint("22222222-3333-7444-8555-666666666666");
    const rows = [
      { ts: at, event: "chatgpt_tela_work", stage: "native_outcome_committed",
        scope_fingerprint: scope, turn_fingerprint: other, outcome: "final" },
      { ts: at, event: "chatgpt_tela_work", stage: "native_response_observer_started",
        scope_fingerprint: scope, turn_fingerprint: current },
      { ts: at, event: "chatgpt_tela_work", stage: "web_turn_identity_pending",
        scope_fingerprint: scope, turn_fingerprint: current, reason_class: "user_not_rendered" },
    ];
    mkdirSync(join(root, "logs"), { recursive: true });
    writeFileSync(join(root, "logs", "codex.diagnostics.jsonl"), rows.map(row => JSON.stringify(row)).join("\n")+"\n");
    try {
      const result = await createCodexWorkInspector({ service: f.service as any,
        logsRoot: join(root, "logs"), connect: f.connect })(2, threadId);
      expect(result.browser.selectedSurface).toBe(false);
      expect(result.diagnostics.activeRequestBoundary).toMatchObject({
        turnFingerprint: current, turnStatus: "inProgress", nativeFinalCommitted: false,
        observedStages: ["native_response_observer_started", "web_turn_identity_pending"],
      });
      const completed = [
        { ts: at, event: "chatgpt_tela_work", stage: "web_turn_final_observed",
          scope_fingerprint: scope, turn_fingerprint: current, assistant_phase: "complete" },
        { ts: at, event: "chatgpt_tela_work", stage: "native_outcome_committed",
          scope_fingerprint: scope, turn_fingerprint: current, outcome: "final" },
        { ts: at, event: "chatgpt_tela_work", stage: "native_response_body_closed",
          scope_fingerprint: scope, turn_fingerprint: current, reason_class: "drained",
          delivery: "http_body_consumer", ui_observed: false },
      ];
      writeFileSync(join(root, "logs", "codex.diagnostics.jsonl"),
        [...rows, ...completed].map(row => JSON.stringify(row)).join("\n") + "\n");
      const settled = await createCodexWorkInspector({ service: f.service as any,
        logsRoot: join(root, "logs"), connect: f.connect })(2, threadId);
      expect(settled.diagnostics.activeRequestBoundary).toMatchObject({
        browserFinalObserved: true, nativeFinalCommitted: true, nativeResponseDrained: true,
        turnFingerprint: current, turnStatus: "inProgress",
      });
      expect(JSON.stringify(settled)).not.toContain("private assistant body");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("passes bounded checkpoint decisions for the exact selected slot and rejects private fields", async () => {
    const f = harness(), root = mkdtempSync(join(tmpdir(), "tela-checkpoint-inspect-"));
    const requests: number[] = [];
    const inspect = createCodexWorkInspector({
      service: { ...f.service, async inspectCheckpointCandidates(slot: number) {
        requests.push(slot);
        return { contractVersion: 1, slot, threadId, readiness: "available",
          reason: "projection_unavailable", cachedForThread: 1,
          completedReceipts: 3, publishedForAccount: 2, matchingReuseScope: 1,
          exactScope: "unknown", prefix: "unknown", anchor: "unknown",
          content: "SENSITIVE_CHECKPOINT" };
      } } as any, logsRoot: root, connect: f.connect,
    });
    try {
      const result = await inspect(2, threadId);
      expect(result.checkpointCandidates).toMatchObject({
        cachedForThread: 1, publishedForAccount: 2, prefix: "unknown",
      });
      expect(requests).toEqual([2]);
      expect(JSON.stringify(result)).not.toContain("SENSITIVE_CHECKPOINT");
      await expect(inspect(1, threadId)).rejects.toThrow("owner-verified");
      expect(requests).toEqual([2]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("rejects mismatched checkpoint ownership and keeps the verified Native result", async () => {
    const f = harness(), root = mkdtempSync(join(tmpdir(), "tela-checkpoint-mismatch-"));
    try {
      const inspect = createCodexWorkInspector({
        service: { ...f.service, async inspectCheckpointCandidates() {
          return { contractVersion: 1, slot: 1, threadId,
            readiness: "available", reason: "no_local_candidates", cachedForThread: 0,
            completedReceipts: 0, publishedForAccount: 0, matchingReuseScope: 0,
            exactScope: "unknown", prefix: "unknown", anchor: "unknown" };
        } } as any, logsRoot: root, connect: f.connect,
      });
      const observed = await inspect(2, threadId);
      expect(observed.identityVerified).toBe(true);
      expect(observed.checkpointCandidates).toMatchObject({ readiness: "unknown", reason: "storage_unavailable" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("reports Native statuses and selected browser observation without exposing screenshot or claiming card ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-work-inspection-")); mkdirSync(join(root, "logs"));
    const f = harness();
    try {
      const report = await createCodexWorkInspector({
        service: f.service as Pick<CodexService, "profiles" | "terminalSession" | "bridgePreview">,
        logsRoot: join(root, "logs"), connect: f.connect,
      })(2, threadId);
      expect(report).toMatchObject({
        identityVerified: true, threadId,
        native: { state: "active", recentTurns: [{ id: turnId, status: "inProgress" }] },
        browser: { activeSurfaceCount: 1, approvalState: "unavailable",
          retention: { total: 129, target: 10, active: 128, undelivered: 1 },
          observationReason: "dom_observation_failed", attributableToThread: false },
        hostPlatformReview: { visibility: "outside_tela_pre_ingress", agentMayApprove: false },
      });
      expect(f.calls.map(x => x.method)).toEqual(["thread/read", "thread/turns/list"]);
      expect(f.calls[0]!.args.includeTurns).toBe(false);
      expect(f.closed).toBe(true);
      expect(JSON.stringify(report)).not.toContain("SECRET_SCREENSHOT");
      expect(JSON.stringify(report)).not.toContain("PRIVATE/OWNER");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("rejects an owner change and never starts a second writer or retries a Native turn", async () => {
    const f = harness(), root = mkdtempSync(join(tmpdir(), "tela-work-identity-"));
    f.service.bridgePreview = async () => { f.changeOwner(); return {
      contractVersion: 1, slot: 2, activeSurfaceCount: 1, previewAvailable: true,
      imageMimeType: "image/jpeg", imageBase64: "not-exported", approvalState: "pending",
    } as any; };
    try {
      const inspect = createCodexWorkInspector({
        service: f.service as Pick<CodexService, "profiles" | "terminalSession" | "bridgePreview">,
        logsRoot: root, connect: f.connect,
      });
      await expect(inspect(2, threadId)).rejects.toThrow("owner changed");
      expect(f.calls.map(x => x.method)).toEqual(["thread/read", "thread/turns/list"]);
      await expect(inspect(2, "not-a-uuid")).rejects.toThrow("valid slot");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("browser failures leave independently owner-proven Native inspection visible but never claim approval cleared", async () => {
    const f = harness(), root = mkdtempSync(join(tmpdir(), "tela-work-browser-"));
    f.service.bridgePreview = async () => { throw Error("PRIVATE DOM failed /Users/secret"); };
    try {
      const report = await createCodexWorkInspector({
        service: f.service as Pick<CodexService, "profiles" | "terminalSession" | "bridgePreview">,
        logsRoot: root, connect: f.connect,
      })(2, threadId);
      expect(report.native.state).toBe("active");
      expect(report.browser).toMatchObject({
        approvalState: "unavailable", observationReason: "bridge_preview_failed",
        activeSurfaceCount: null, attributableToThread: false,
      });
      expect(JSON.stringify(report)).not.toContain("PRIVATE DOM");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("agent sees approval waiting without authority over that Native conversation", async () => {
    const f = harness(), root = mkdtempSync(join(tmpdir(), "tela-agent-approval-review-"));
    const service = {
      ...f.service,
      async bridgePreview() { return {
        contractVersion: 1 as const, slot: 2, activeSurfaceCount: 1, previewAvailable: true,
        imageMimeType: "image/jpeg" as const, imageBase64: "SENSITIVE_BROWSER_FRAME",
        approvalState: "pending" as const,
        approvalWait: {phase:"dispatch_sent" as const,elapsedMs:120000,unverifiedDispatchCount:1,operationState:"waiting" as const},
      }; },
    };
    try {
      const report = await createCodexWorkInspector({
        service: service as Pick<CodexService, "profiles" | "terminalSession" | "bridgePreview">,
        logsRoot: root, connect: f.connect,
      })(2, threadId);
      expect(report.browser).toMatchObject({
        approvalState: "pending", attributableToThread: false,
        wait: {phase:"dispatch_sent",elapsedMs:120000,unverifiedDispatchCount:1,operationState:"waiting"},
      });
      expect(JSON.stringify(report)).not.toContain("SENSITIVE_BROWSER_FRAME");
      expect(f.calls.map(x => x.method)).toEqual(["thread/read", "thread/turns/list"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("a foreign Web observation is never attributed to the owned profile", async () => {
    const f = harness(), root = mkdtempSync(join(tmpdir(), "tela-work-web-owner-"));
    f.service.bridgePreview = async () => ({
      contractVersion: 1, slot: 1, activeSurfaceCount: 1, previewAvailable: false,
    } as any);
    try {
      await expect(createCodexWorkInspector({
        service: f.service as Pick<CodexService, "profiles" | "terminalSession" | "bridgePreview">,
        logsRoot: root, connect: f.connect,
      })(2, threadId)).rejects.toThrow("browser preview owner mismatch");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("authenticated private Codex service serves a bounded read, rejects unauthorized and unsupported payloads", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-work-http-")), f = harness();
    const inspect = createCodexWorkInspector({
      service: f.service as Pick<CodexService, "profiles" | "terminalSession" | "bridgePreview">,
      logsRoot: root, connect: f.connect,
    });
    const base = {
      instanceId: "fixture", config: {}, tools: { async inventory() { return []; }, async invoke() { throw Error("no invocation"); } },
      serviceStatus() { return { contractVersion: 1 as const, service: "codex" as const, instanceId: "fixture", state: "ready" as const }; },
      profiles: f.service.profiles, terminalSession: f.service.terminalSession, bridgePreview: f.service.bridgePreview,
      async startProfile() { throw Error("not used"); }, async waitWebPreparation() { throw Error("not used"); },
      async reconnectWeb() { throw Error("not used"); }, async stopProfile() { throw Error("not used"); },
      async modelSelectionCanary() { throw Error("not used"); }, async contextAttachmentCanary() { throw Error("not used"); },
      async close() {}, activeProfileCount: 1,
    } as unknown as CodexService;
    const token = "x".repeat(48);
    const server = await startCodexServiceHttpServer({ service: base, bearerToken: token, inspectWork: inspect });
    const client = new CodexServiceClient({
      version: 1, service: "codex", instanceId: "fixture", installId: "fixture",
      pid: process.pid, endpoint: server.endpoint.href, bearerToken: token,
      startedAt: new Date().toISOString(),
    });
    try {
      const uri = new URL("v1/codex/profiles/2/work-inspection", server.endpoint);
      expect((await fetch(uri, { method: "POST", body: JSON.stringify({ threadId, minutes: 30 }) })).status).toBe(401);
      expect((await fetch(uri, { method: "POST", headers: { authorization: `Bearer ${token}`,
        origin: "https://chatgpt.com" }, body: JSON.stringify({ threadId, minutes: 30 }) })).status).toBe(403);
      expect((await fetch(uri, { method: "POST", headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ threadId, minutes: 30, cmd: "UNEXPECTED" }) })).status).toBe(400);
      const response = await client.inspectWork(2, threadId);
      expect(response).toMatchObject({
        identityVerified: true, threadId,
        browser: { approvalState: "unavailable", observationReason: "dom_observation_failed" },
        hostPlatformReview: { agentMayApprove: false },
      });
      expect(JSON.stringify(response)).not.toContain("SECRET_SCREENSHOT");
      expect(JSON.stringify(response)).not.toContain("PRIVATE/OWNER");
    } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
  });
  test("private Native exceptions never leave the authenticated inspection endpoint", async () => {
    const base = {
      instanceId: "fixture", config: {}, tools: { async inventory() { return []; }, async invoke() { throw Error("unused"); } },
      serviceStatus() { return { contractVersion: 1, service: "codex", instanceId: "fixture", state: "ready" }; },
      async profiles() { return []; }, async terminalSession() { throw Error("unused"); },
      async bridgePreview() { throw Error("unused"); }, async startProfile() { throw Error("unused"); },
      async waitWebPreparation() { throw Error("unused"); }, async reconnectWeb() { throw Error("unused"); },
      async stopProfile() { throw Error("unused"); }, async modelSelectionCanary() { throw Error("unused"); },
      async contextAttachmentCanary() { throw Error("unused"); },
      async close() {}, activeProfileCount: 0,
    } as unknown as CodexService;
    const token = "s".repeat(48);
    const server = await startCodexServiceHttpServer({ service: base, bearerToken: token,
      async inspectWork() { throw Error("PRIVATE /Users/someone/.codex/rollout"); },
    });
    try {
      const response = await fetch(new URL("v1/codex/profiles/2/work-inspection", server.endpoint), {
        method: "POST", headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ threadId, minutes: 30 }),
      });
      expect(response.status).toBe(409);
      expect(await response.text()).not.toContain("PRIVATE");
      expect((await fetch(new URL("v1/status", server.endpoint), {
        headers: { authorization: `Bearer ${token}` },
      })).status).toBe(200);
    } finally { await server.close(); }
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAppServerRpc } from "@chatgpt-tela/codex";
import { CodexServiceClient } from "@chatgpt-tela/service-protocol/client";
import { parseCodexWorkInspectionContract } from "@chatgpt-tela/service-protocol";
import { startCodexServiceHttpServer } from "./http-server";
import type { CodexService } from "./controller";
import { createCodexWorkInspector } from "./work-inspection";
import { diagnosticFingerprint, writeDiagnosticIncident } from "@chatgpt-tela/core";
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
  let currentTurnStatus = "inProgress";
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
        { id: turnId, status: currentTurnStatus, itemsView: "notLoaded", items: [] },
      ], nextCursor: null };
      throw Error("unexpected Native call");
    },
    async close() { closed = true; },
  };
  let preview = {
    contractVersion: 1 as const, slot: 2, activeSurfaceCount: 1, previewAvailable: true,
    selectedSurfaceId: "surface_" + "a".repeat(32),
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
    setTurnStatus(status: string) { currentTurnStatus = status; },
    get closed() { return closed; },
  };
}

describe("profile-owned read-only Work inspection", () => {
  test("existing picker structure and owner fields survive official inspection parsing without leaking unrelated fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-picker-inspect-"));
    const f = harness();
    const ts = new Date().toISOString();
    const scope = diagnosticFingerprint(threadId), turn = diagnosticFingerprint(turnId);
    const rows = [
      { stage: "web_model_picker_timeout", control_count: 0, composer_count: 1,
        global_control_count: 0, menu_count: 0, composer_form_present: true,
        private_html: "PRIVATE_MARKUP", document_revoked: true },
      { stage: "web_model_picker_failed", reason_class: "model_picker_control_unavailable",
        snapshot_available: false, control_count: 0, unrelated_count: 77 },
      { stage: "web_model_picker_owner_observed", document_observed: true,
        document_revoked: false, input_observed: false, input_available: false,
        input_revoked: false, observation_pending: false, private_url: "PRIVATE_URL" },
      { stage: "web_turn_observed", control_count: 5,
        composer_form_present: true, document_observed: true, private_value: "PRIVATE_OTHER" },
      { stage: "native_goal_control_issued", control_fingerprint: diagnosticFingerprint("goal-control") },
      { stage: "native_goal_control_inventory_rejected", event: "chatgpt_tela_chat",
        control_fingerprint: diagnosticFingerprint("goal-control"),
        phase: "call", reason_class: "unknown_or_retired_control" },
    ];
    mkdirSync(join(root, "logs"), { recursive: true });
    writeFileSync(join(root, "logs", "codex.diagnostics.jsonl"), rows.map(row => JSON.stringify(
      row.stage === "native_goal_control_inventory_rejected"
        ? { ts, event: "chatgpt_tela_chat", stage: row.stage,
          control_fingerprint: row.control_fingerprint, phase: row.phase, reason_class: row.reason_class }
        : { ts, event: row.stage === "native_goal_control_issued" ? "chatgpt_tela_codex" : "chatgpt_tela_work",
          scope_fingerprint: scope, turn_fingerprint: turn, ...row },
    )).join("\n") + "\n");
    try {
      const report = await createCodexWorkInspector({ service: f.service as any,
        logsRoot: join(root, "logs"), connect: f.connect })(2, threadId);
      const parsed = parseCodexWorkInspectionContract(report, 2, threadId);
      expect(parsed.diagnostics.recentEvents as unknown[]).toEqual([
        { at: ts, stage: "web_model_picker_timeout", control_count: 0, composer_count: 1,
          global_control_count: 0, menu_count: 0, composer_form_present: true },
        { at: ts, stage: "web_model_picker_failed", reasonClass: "model_picker_control_unavailable",
          snapshot_available: false, control_count: 0 },
        { at: ts, stage: "web_model_picker_owner_observed", document_observed: true,
          document_revoked: false, input_observed: false, input_available: false,
          input_revoked: false, observation_pending: false },
        { at: ts, stage: "web_turn_observed" },
        { at: ts, stage: "native_goal_control_issued",
          controlFingerprint: diagnosticFingerprint("goal-control") },
        { at: ts, stage: "native_goal_control_inventory_rejected", phase: "call",
          controlFingerprint: diagnosticFingerprint("goal-control"),
          reasonClass: "unknown_or_retired_control" },
      ]);
      expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
      expect(JSON.stringify(parsed)).not.toContain("unrelated_count");
      expect(parsed.diagnostics.recentEvents[0]).not.toHaveProperty("document_revoked");
      expect(parsed.diagnostics.recentEvents[2]).not.toHaveProperty("control_count");
      // The public parser validates rather than trusts the incoming stage-specific field types.
      const altered = structuredClone(report);
      const alteredRow = altered.diagnostics.recentEvents[0] as Record<string, unknown>;
      alteredRow.control_count = "private raw value";
      expect(parseCodexWorkInspectionContract(altered, 2, threadId).diagnostics.recentEvents[0])
        .not.toHaveProperty("control_count");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("inspection selects its exact Native task and derives attribution from the returned owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-work-owner-"));
    const f = harness();
    const selectors: unknown[] = [];
    const preview = await f.service.bridgePreview();
    f.service.bridgePreview = async (...args: unknown[]) => {
      selectors.push(args);
      return { ...preview, retention: { ...preview.retention, surface: {
        id: preview.selectedSurfaceId, taskId: threadId, state: "active", nextAction: "wait_for_work",
      } } } as any;
    };
    try {
      const inspect = createCodexWorkInspector({ service: f.service as any, logsRoot: root, connect: f.connect });
      const result = await inspect(2, threadId);
      expect(selectors).toEqual([[2, undefined, threadId]]);
      expect(result.browser.attributableToThread).toBe(true);
      expect(result.browser.retention?.surface?.taskId).toBe(threadId);
      expect(result.browser.approvalAuthority).toBe("observation_only");
      expect(parseCodexWorkInspectionContract(result, 2, threadId).browser.attributableToThread).toBe(true);
      for (const retention of [undefined, { ...result.browser.retention!, surface: {
        ...result.browser.retention!.surface!, taskId: "another-thread",
      } }]) {
        expect(parseCodexWorkInspectionContract({ ...result, browser: { ...result.browser,
          attributableToThread: true, retention } }, 2, threadId).browser.attributableToThread).toBe(false);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("turn-scoped request and settlement boundaries survive an unselected browser without borrowing older finals", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-turn-boundary-"));
    const f = harness();
    f.service.bridgePreview = async () => ({ contractVersion: 1, slot: 2, activeSurfaceCount: 2,
      previewAvailable: false, approvalState: "unavailable" } as any);
    const at = new Date().toISOString();
    const scope = diagnosticFingerprint(threadId), current = diagnosticFingerprint(turnId);
    const operation = diagnosticFingerprint("current-web-epoch");
    const other = diagnosticFingerprint("22222222-3333-7444-8555-666666666666");
    const rows = [
      { ts: at, event: "chatgpt_tela_work", stage: "native_outcome_committed",
        scope_fingerprint: scope, turn_fingerprint: other, outcome: "final" },
      { ts: at, event: "chatgpt_tela_work", stage: "native_response_observer_started",
        scope_fingerprint: scope, turn_fingerprint: current },
      { ts: at, event: "chatgpt_tela_work", stage: "web_turn_identity_pending",
        scope_fingerprint: scope, turn_fingerprint: current, reason_class: "user_not_rendered" },
      { ts: at, event: "chatgpt_tela_work", stage: "web_turn_identity_accepted",
        scope_fingerprint: scope, turn_fingerprint: current, operation_fingerprint: operation },
      { ts: at, event: "chatgpt_tela_work", stage: "native_response_body_closed",
        scope_fingerprint: scope, turn_fingerprint: current, outcome: "tool_call",
        reason_class: "drained", delivery: "http_body_consumer", ui_observed: false },
    ];
    mkdirSync(join(root, "logs"), { recursive: true });
    writeFileSync(join(root, "logs", "codex.diagnostics.jsonl"), rows.map(row => JSON.stringify(row)).join("\n")+"\n");
    try {
      const result = await createCodexWorkInspector({ service: f.service as any,
        logsRoot: join(root, "logs"), connect: f.connect })(2, threadId);
      expect(result.browser.selectedSurface).toBe(false);
      expect(result.diagnostics.activeRequestBoundary).toMatchObject({
        turnFingerprint: current, turnStatus: "inProgress", nativeFinalCommitted: false,
        nativeResponseDrained: false,
        observedStages: ["native_response_observer_started", "web_turn_identity_accepted", "native_response_body_closed"],
      });
      expect(parseCodexWorkInspectionContract(result, 2, threadId).diagnostics.activeRequestBoundary).toMatchObject({
        turnStatus: "inProgress", nativeFinalCommitted: false,
        proof: "turn_scoped_local_events_only",
      });
      expect(parseCodexWorkInspectionContract(result, 2, threadId).diagnostics.activeRequestBoundary).toMatchObject({
        webExecutionFailure: null, responseCycleProof: null,
      });
      const completed = [
        { ts: at, event: "chatgpt_tela_work", stage: "web_turn_final_observed",
          scope_fingerprint: scope, turn_fingerprint: current, operation_fingerprint: operation,
          assistant_phase: "complete" },
        { ts: at, event: "chatgpt_tela_codex", stage: "native_public_item_observed",
          scope_fingerprint: scope, turn_fingerprint: current, kind: "agent_message", phase: "final_answer" },
        { ts: at, event: "chatgpt_tela_work", stage: "native_outcome_committed",
          scope_fingerprint: scope, turn_fingerprint: current, outcome: "final" },
        { ts: at, event: "chatgpt_tela_work", stage: "native_response_body_closed",
          scope_fingerprint: scope, turn_fingerprint: current, outcome: "final", reason_class: "drained",
          delivery: "http_body_consumer", ui_observed: false },
      ];
      writeFileSync(join(root, "logs", "codex.diagnostics.jsonl"),
        [...rows, ...completed].map(row => JSON.stringify(row)).join("\n") + "\n");
      const settled = await createCodexWorkInspector({ service: f.service as any,
        logsRoot: join(root, "logs"), connect: f.connect })(2, threadId);
      expect(settled.diagnostics.activeRequestBoundary).toMatchObject({
        browserFinalObserved: true, nativeFinalItemObserved: true,
        nativeFinalCommitted: true, nativeResponseDrained: true,
        turnFingerprint: current, turnStatus: "inProgress",
      });
      expect(parseCodexWorkInspectionContract(settled, 2, threadId).diagnostics.activeRequestBoundary).toMatchObject({
        browserFinalObserved: true, nativeFinalCommitted: true, nativeResponseDrained: true,
      });
      expect(JSON.stringify(settled)).not.toContain("private assistant body");
      expect(JSON.stringify(parseCodexWorkInspectionContract(settled, 2, threadId))).not.toContain("private assistant body");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("stored cycle failure and rejected input proof survive the official HTTP client projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-failure-projection-"));
    const f = harness();
    const ts = new Date().toISOString();
    const scope = diagnosticFingerprint(threadId), turn = diagnosticFingerprint(turnId);
    const operation = diagnosticFingerprint("web-epoch-owned-operation");
    const epoch = diagnosticFingerprint("epoch");
    const lease = diagnosticFingerprint("lease");
    const revision = diagnosticFingerprint("revision");
    const activeRevision = diagnosticFingerprint("active-revision");
    const failure = { ts, event: "chatgpt_tela_work", stage: "web_execution_exception", scope_fingerprint: scope,
      turn_fingerprint: turn, operation_fingerprint: operation, reason_class: "observation_probable",
      boundary: "event_wait", observation_state: "probable", observation_evidence_class: "composer_readback_unproven",
      observation_evidence_count: 3, accepted: true, turn_phase: "accepted" };
    const plan = { ts, event: "chatgpt_tela_work", stage: "web_turn_plan", scope_fingerprint: scope,
      turn_fingerprint: turn, operation_fingerprint: operation, epoch_fingerprint: epoch,
      lease_fingerprint: lease, head_revision_fingerprint: revision,
      active_request_revision_fingerprint: activeRevision };
    const rejection = { ts, event: "chatgpt_tela_work", stage: "native_cycle_proof_rejected",
      scope_fingerprint: scope, turn_fingerprint: turn, reason_class: "new_input_missing",
      prior_final_present: true, new_message_count: 0, exact_request_replay: false,
      prior_final_fingerprint: diagnosticFingerprint("prior-final") };
    const finalRows = [
      { ts, event: "chatgpt_tela_work", stage: "web_turn_final_observed", scope_fingerprint: scope, turn_fingerprint: turn, operation_fingerprint: operation },
      { ts, event: "chatgpt_tela_work", stage: "web_answer_received", scope_fingerprint: scope, turn_fingerprint: turn, operation_fingerprint: operation },
      { ts, event: "chatgpt_tela_codex", stage: "native_public_item_observed", scope_fingerprint: scope, turn_fingerprint: turn, kind: "agent_message", phase: "final_answer" },
      { ts, event: "chatgpt_tela_work", stage: "native_outcome_committed", scope_fingerprint: scope, turn_fingerprint: turn, outcome: "final" },
      { ts, event: "chatgpt_tela_work", stage: "native_response_body_closed", scope_fingerprint: scope, turn_fingerprint: turn, outcome: "final", reason_class: "drained" },
    ];
    const incidentRoot = join(root, "logs", "diagnostics");
    mkdirSync(join(root, "logs"), { recursive: true });
    writeDiagnosticIncident(incidentRoot, { stage: "native_cycle_summary", observedAt: ts,
      timeline: [plan, failure, rejection, ...finalRows] as any });
    const serverInspect = createCodexWorkInspector({ service: f.service as any,
      logsRoot: join(root, "logs"), connect: f.connect });
    const token = "x".repeat(48);
    const base = {
      instanceId: "fixture", config: {}, tools: { async inventory() { return []; }, async invoke() { throw Error("unused"); } },
      serviceStatus() { return { contractVersion: 1 as const, service: "codex" as const, instanceId: "fixture", state: "ready" as const }; },
      profiles: f.service.profiles, terminalSession: f.service.terminalSession, bridgePreview: f.service.bridgePreview,
      async startProfile() { throw Error("unused"); }, async waitWebPreparation() { throw Error("unused"); },
      async reconnectWeb() { throw Error("unused"); }, async stopProfile() { throw Error("unused"); },
      async modelSelectionCanary() { throw Error("unused"); }, async contextAttachmentCanary() { throw Error("unused"); },
      async close() {}, activeProfileCount: 1,
    } as unknown as CodexService;
    const server = await startCodexServiceHttpServer({ service: base, bearerToken: token, inspectWork: serverInspect });
    const client = new CodexServiceClient({ version: 1, service: "codex", instanceId: "fixture", installId: "fixture",
      pid: process.pid, endpoint: server.endpoint.href, bearerToken: token, startedAt: ts });
    try {
      const result = await client.inspectWork(2, threadId);
      expect(result.diagnostics.activeRequestBoundary).toMatchObject({
        webExecutionFailure: { stage: "web_execution_exception", reasonClass: "observation_probable",
          boundary: "event_wait", observationState: "probable", observationReason: "composer_readback_unproven",
          observationEvidenceCount: 3, accepted: true, operationFingerprint: operation,
          epochFingerprint: epoch, leaseFingerprint: lease, headRevisionFingerprint: revision,
          activeRequestRevisionFingerprint: activeRevision },
        responseCycleProof: { reasonClass: "new_input_missing", priorFinalPresent: true,
          newMessageCount: 0, exactRequestReplay: false, inputEvidence: [], inputEvidenceComplete: true,
          matchedCount: 0, unmatchedCount: 0, priorFinalFingerprint: diagnosticFingerprint("prior-final") },
        browserFinalObserved: true, webAnswerReceived: true, nativeFinalItemObserved: true,
        nativeFinalCommitted: true, nativeResponseDrained: true,
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("private");
      expect(serialized).not.toContain("raw");
      expect(serialized).not.toContain("composer_readback_unproven".replace("composer", "private"));
    } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("official Native completion is exposed separately from a missing local delivery receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-native-complete-boundary-"));
    const f = harness();
    f.setTurnStatus("completed");
    try {
      const result = await createCodexWorkInspector({ service: f.service as any,
        logsRoot: root, connect: f.connect })(2, threadId);
      expect(result.native.recentTurns[0]?.status).toBe("completed");
      expect(result.diagnostics.activeRequestBoundary).toMatchObject({
        turnStatus: "completed", nativeFinalCommitted: false, nativeResponseDrained: false,
        proof: "turn_scoped_local_events_only",
      });
      const projected = parseCodexWorkInspectionContract(result, 2, threadId);
      expect(projected.diagnostics.activeRequestBoundary).toMatchObject({
        turnStatus: "completed", nativeFinalCommitted: false, nativeResponseDrained: false,
      });
      expect(() => parseCodexWorkInspectionContract({
        ...result, diagnostics: { ...result.diagnostics, activeRequestBoundary: {
          ...result.diagnostics.activeRequestBoundary, turnStatus: "inProgress",
        } },
      }, 2, threadId)).toThrow("invalid Native-to-local response boundary evidence");
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
        selectedSurfaceId: "surface_" + "b".repeat(32),
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

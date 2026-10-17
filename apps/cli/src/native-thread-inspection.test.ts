import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticFingerprint } from "@chatgpt-tela/core";
import { inspectNativeThread, inspectNativeThreadHistoricalEvidence } from "./native-thread-inspection";

const THREAD = "11111111-2222-7333-8444-555555555555";
const TURN = "66666666-7777-7888-9999-aaaaaaaaaaaa";
const NOW = Date.parse("2026-10-17T08:20:00Z");

function fixtureReader(overrides: {
  readonly mismatchedOwner?: boolean;
  readonly legacy?: boolean;
  readonly malformedTurn?: boolean;
} = {}) {
  const calls: { method: string; params: any }[] = [];
  return {
    calls,
    async request(method: string, params: any) {
      calls.push({ method, params });
      if (method === "thread/read") return {
        thread: { id: overrides.mismatchedOwner ? "foreign" : THREAD,
          status: { type: "active" }, historyMode: overrides.legacy ? "legacy" : "paginated",
          updatedAt: 1792224222, title: "PRIVATE TASK NAME", cwd: "/PRIVATE/WORKSPACE" },
      };
      if (method === "thread/turns/list") return { data: [
        { id: TURN, status: "inProgress", itemsView: "notLoaded",
          items: overrides.malformedTurn ? [{ text: "PRIVATE TOOL OUTPUT" }] : [] },
      ], nextCursor: "opaque" };
      throw Error("unexpected method");
    },
  };
}

describe("one read-only conversation inspection by exact Native ID", () => {
  test("offline evidence correlates one UUID after owner loss without claiming a live approval", () => {
    const dir = mkdtempSync(join(tmpdir(), "tela-thread-evidence-"));
    const path = join(dir, "events.jsonl");
    const scope = diagnosticFingerprint(THREAD);
    writeFileSync(path, [
      { ts: "2026-10-17T08:05:23Z", event: "chatgpt_tela_work", stage: "approval_wait_transition",
        scope_fingerprint: scope, phase: "pending", content: "PRIVATE REQUEST" },
      { ts: "2026-10-17T08:05:23Z", event: "chatgpt_tela_work", stage: "approval_manual_review_required",
        scope_fingerprint: scope, reason_class: "provider_warning", approval_mode: "recognized_once" },
      { ts: "2026-10-17T08:19:45Z", event: "chatgpt_tela_browser", stage: "inspection_input_classified",
        scope_fingerprint: scope, manual_consent: true, raw_card: "SECRET CARD" },
      { ts: "2026-10-17T08:19:46Z", event: "chatgpt_tela_work", stage: "web_turn_identity_rejected",
        scope_fingerprint: scope, reason_class: "accepted_user_changed" },
      { ts: "2026-10-17T08:19:46Z", event: "chatgpt_tela_work", stage: "native_execution_failed",
        scope_fingerprint: scope, reason_class: "request_changed" },
      { ts: "2026-10-17T08:19:46Z", event: "chatgpt_tela_work", stage: "native_turn_retired",
        scope_fingerprint: scope, reason_class: "execution_failed" },
      { ts: "2026-10-17T08:19:47Z", event: "chatgpt_tela_work", stage: "native_execution_failed",
        scope_fingerprint: diagnosticFingerprint("foreign"), raw_prompt: "FOREIGN PRIVATE" },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    try {
      const result = inspectNativeThreadHistoricalEvidence({
        threadId: THREAD, diagnosticPaths: [path], minutes: 30, nowMs: NOW,
      });
      expect(result).toMatchObject({
        identityVerified: false, nativeOwner: "not_checked",
        browserCardCurrentlyVisible: "not_verified", contentRead: false, mutating: false,
        coverage: { eventsMatched: 6 },
        approval: { reasonClass: "provider_warning", noClearanceRecordedAfterPending: true,
          nativeEndedAfterPending: true, observedGapSeconds: 863 },
        lastNativeFailure: { stage: "native_execution_failed", reasonClass: "request_changed" },
        lastNativeOutcome: { stage: "native_turn_retired", reasonClass: "execution_failed" },
        continuation: { canAutomaticallyApproveSecurityReview: false, canAutomaticallyReplayAcceptedTurn: false },
      });
      const printed = JSON.stringify(result);
      expect(printed).not.toMatch(/PRIVATE|SECRET|FOREIGN/);
      expect(result.recentEvents.some(row => row.manualConsent === true)).toBe(true);
      expect(() => inspectNativeThreadHistoricalEvidence({ threadId: "wrong", diagnosticPaths: [] }))
        .toThrow("exact Native UUID");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("a logged later clearance is not confused with an unresolved approval", () => {
    const dir = mkdtempSync(join(tmpdir(), "tela-thread-evidence-clear-"));
    const path = join(dir, "events.jsonl");
    const scope_fingerprint = diagnosticFingerprint(THREAD);
    writeFileSync(path, [
      { ts: "2026-10-17T08:05:23Z", event: "chatgpt_tela_work", stage: "approval_wait_transition",
        scope_fingerprint, phase: "pending" },
      { ts: "2026-10-17T08:06:23Z", event: "chatgpt_tela_work", stage: "approval_wait_transition",
        scope_fingerprint, phase: "card_cleared" },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    try {
      const result = inspectNativeThreadHistoricalEvidence({
        threadId: THREAD, diagnosticPaths: [path], nowMs: NOW, minutes: 30,
      });
      expect(result.approval.noClearanceRecordedAfterPending).toBe(false);
      expect(result.approval.lastTransition).toBe("card_cleared");
      expect(result.browserCardCurrentlyVisible).toBe("not_verified");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("joins private Native metadata and bounded public diagnostics without copying text or granting approval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tela-thread-inspection-"));
    const path = join(dir, "events.jsonl");
    const scope = diagnosticFingerprint(THREAD);
    writeFileSync(path, [
      { ts: "2026-10-17T08:02:58Z", event: "chatgpt_tela_work", stage: "web_turn_plan",
        scope_fingerprint: scope, transfer_estimate: 109966, retained_surface: false,
        content: "SECRET SHOULD NOT APPEAR" },
      { ts: "2026-10-17T08:05:23Z", event: "chatgpt_tela_work", stage: "approval_wait_transition",
        scope_fingerprint: scope, phase: "pending", card_fingerprint: "aaaaaaaabbbbbbbbcccccccc" },
      { ts: "2026-10-17T08:05:23Z", event: "chatgpt_tela_work", stage: "approval_manual_review_required",
        scope_fingerprint: scope, reason_class: "provider_warning", approval_mode: "recognized_once" },
      { ts: "2026-10-17T08:05:24Z", event: "chatgpt_tela_work", stage: "approval_manual_review_required",
        scope_fingerprint: diagnosticFingerprint("a different thread"),
        reason_class: "unrelated", raw_prompt: "SECRET OTHER CHAT" },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const rpc = fixtureReader();
    try {
      const result = await inspectNativeThread({
        rpc, threadId: THREAD, slot: 2, diagnosticPaths: [path], minutes: 30, nowMs: NOW,
      });
      expect(result).toMatchObject({
        contractVersion: 1, threadId: THREAD, slot: 2, identityVerified: true,
        native: { state: "active", historyMode: "paginated", recentTurns: [{ id: TURN, status: "inProgress" }] },
        diagnostics: {
          coverage: { eventsMatched: 3 },
          lastWebPlan: { transferEstimate: 109966, retainedSurface: false },
          reviewEvidence: { reasonClass: "provider_warning", approvalMode: "recognized_once",
            currentlyVisible: "not_verified", stillPendingInAvailableEvents: true },
        },
        continuation: { classification: "last_observed_manual_review",
          nextAction: "inspect_current_owned_approval_before_any_click",
          canAutomaticallyApproveSecurityReview: false, canAutomaticallyReplayAcceptedTurn: false },
      });
      expect(rpc.calls.map(c => c.method)).toEqual(["thread/read", "thread/turns/list"]);
      expect(rpc.calls[0]!.params.includeTurns).toBe(false);
      expect(rpc.calls[1]!.params).toMatchObject({ limit: 4, itemsView: "notLoaded" });
      const printed = JSON.stringify(result);
      expect(printed).not.toContain("SECRET");
      expect(printed).not.toContain("PRIVATE");
      expect(printed).not.toContain("aaaaaaaabbbbbbbbcccccccc");
      expect(printed).not.toContain("/PRIVATE/WORKSPACE");
      expect(printed).not.toContain("unrelated");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a later observed clearance closes the previously pending review without approving anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tela-thread-clear-"));
    const path = join(dir, "events.jsonl");
    writeFileSync(path, [
      { ts: "2026-10-17T08:05:23Z", event: "chatgpt_tela_work", stage: "approval_wait_transition",
        scope_fingerprint: diagnosticFingerprint(THREAD), phase: "pending" },
      { ts: "2026-10-17T08:06:00Z", event: "chatgpt_tela_work", stage: "approval_wait_transition",
        scope_fingerprint: diagnosticFingerprint(THREAD), phase: "cleared" },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    try {
      const result = await inspectNativeThread({
        rpc: fixtureReader(), threadId: THREAD, slot: 2,
        diagnosticPaths: [path], nowMs: NOW, minutes: 30,
      });
      expect(result.diagnostics.reviewEvidence).toBeNull();
      expect(result.continuation.classification).toBe("in_progress_without_verified_review");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("rejects incorrect identity and content-bearing page, allows Legacy metadata only", async () => {
    const badId = fixtureReader();
    await expect(inspectNativeThread({ rpc: badId, threadId: "invalid", slot: 2, diagnosticPaths: [] }))
      .rejects.toThrow("exact Native UUID");
    expect(badId.calls).toHaveLength(0);
    await expect(inspectNativeThread({ rpc: fixtureReader({ mismatchedOwner: true }),
      threadId: THREAD, slot: 2, diagnosticPaths: [] })).rejects.toThrow("not owned");
    await expect(inspectNativeThread({ rpc: fixtureReader({ malformedTurn: true }),
      threadId: THREAD, slot: 2, diagnosticPaths: [] })).rejects.toThrow("metadata does not match");
    const legacy = fixtureReader({ legacy: true });
    const result = await inspectNativeThread({
      rpc: legacy, threadId: THREAD, slot: 2, diagnosticPaths: [],
    });
    expect(result.native.recentTurns).toEqual([]);
    expect(legacy.calls.map(c => c.method)).toEqual(["thread/read"]);
  });
});

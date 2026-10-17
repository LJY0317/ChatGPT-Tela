import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatToolRuntime } from "./tools";
import { diagnosticFingerprint } from "@chatgpt-tela/core";

const THREAD = "11111111-2222-7333-8444-555555555555";

test("one discovered bounded read capability replaces arbitrary Bun command for Native Work inspection", async () => {
  const base = mkdtempSync(join(tmpdir(), "tela-chat-inspect-"));
  const root = join(base, "workspace"); mkdirSync(root);
  const requests: unknown[] = [];
  const runtime = createChatToolRuntime({
    allowedRoots: [root], stateRoot: join(base, "state"),
    inspectNativeWork: async request => {
      requests.push(request);
      return Object.freeze({ status: "read_only", ownerProven: true, agentMayApprove: false,
        observedAt: "2026-10-17T00:00:00Z" });
    },
  });
  const withoutPeer = createChatToolRuntime({ allowedRoots: [root], stateRoot: join(base, "independent") });
  try {
    expect(runtime.capabilities).toContain("inspect_native_work");
    expect(withoutPeer.capabilities).not.toContain("inspect_native_work");
    const opened = runtime.workspaces.open(root);
    const result = await runtime.call("inspect_native_work", {
      workspace_id: opened.id, thread_id: THREAD, slot: 2, minutes: 15,
      cmd: "NEVER_EXECUTE_THIS_UNREVIEWED_COMMAND",
    });
    expect(result).toMatchObject({ status: "read_only", ownerProven: true, agentMayApprove: false });
    expect(requests).toEqual([{ slot: 2, threadId: THREAD, minutes: 15 }]);
    for (const bad of [
      { workspace_id: "foreign", thread_id: THREAD },
      { workspace_id: opened.id, thread_id: "not-an-id" },
      { workspace_id: opened.id, thread_id: THREAD, slot: 100 },
      { workspace_id: opened.id, thread_id: THREAD, minutes: 0 },
    ]) {
      await expect(runtime.call("inspect_native_work", bad)).rejects.toThrow();
    }
    expect(requests).toHaveLength(1);
    await expect(withoutPeer.call("inspect_native_work", {
      workspace_id: opened.id, thread_id: THREAD,
    })).rejects.toThrow("unavailable");
  } finally { await runtime.close(); await withoutPeer.close(); rmSync(base, { recursive: true, force: true }); }
});

test("agent can inspect only historical structural approval evidence after Native owner is unavailable", async () => {
  const base = mkdtempSync(join(tmpdir(), "tela-chat-offline-evidence-"));
  const root = join(base, "workspace"); mkdirSync(root);
  const log = join(base, "local-structural-events.jsonl");
  // The read deliberately filters to the last 180 minutes. Fixed calendar
  // timestamps become expired test data as wall time passes.
  const pendingAt = new Date(Date.now() - 90 * 60_000).toISOString();
  const failedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  writeFileSync(log, [
    { ts: pendingAt, event: "chatgpt_tela_work", stage: "approval_wait_transition",
      scope_fingerprint: diagnosticFingerprint(THREAD), phase: "pending",
      raw_card: "SENSITIVE_APPROVAL" },
    { ts: failedAt, event: "chatgpt_tela_work", stage: "native_execution_failed",
      scope_fingerprint: diagnosticFingerprint(THREAD), reason_class: "request_changed" },
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  const offline = createChatToolRuntime({
    allowedRoots: [root], stateRoot: join(base, "state"),
    historicalDiagnosticPaths: [log],
  });
  try {
    expect(offline.capabilities).not.toContain("inspect_native_work");
    expect(offline.capabilities).toContain("inspect_native_evidence");
    const opened = offline.workspaces.open(root);
    const result = await offline.call("inspect_native_evidence", {
      workspace_id: opened.id, thread_id: THREAD, minutes: 180,
      shell: "SHOULD_NOT_BE_INTERPRETED_AS_A_COMMAND",
    });
    expect(result).toMatchObject({
      threadId: THREAD, identityVerified: false, nativeOwner: "not_checked",
      browserCardCurrentlyVisible: "not_verified", contentRead: false, mutating: false,
      approval: { lastTransition: "pending", noClearanceRecordedAfterPending: true,
        nativeEndedAfterPending: true },
      lastNativeFailure: { reasonClass: "request_changed" },
    });
    expect(JSON.stringify(result)).not.toContain("SENSITIVE_APPROVAL");
    expect(JSON.stringify(result)).not.toContain("SHOULD_NOT_BE_INTERPRETED");
    await expect(offline.call("inspect_native_evidence", {
      workspace_id: opened.id, thread_id: "invalid",
    })).rejects.toThrow("exact Native UUID");
    await expect(offline.call("inspect_native_evidence", {
      workspace_id: opened.id, thread_id: THREAD, minutes: 361,
    })).rejects.toThrow("1 to 360");
  } finally { await offline.close(); rmSync(base, { recursive: true, force: true }); }
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readServiceRuntimeDescriptor, writeServiceRuntimeDescriptor, removeServiceRuntimeDescriptor } from "./index";
import { parseCodexTerminalSessionContract, parseCodexAccountDisplayContract, parseCodexAccountCheckContract, parseCodexProfileStatusContract, parseCodexBridgePreviewContract, parseServiceRuntimeDescriptor, parseServiceStatus, parseCodexWebDelegationCapacityContract } from "./index";

describe("private service protocol", () => {
  test("descriptor cleanup belongs to the exact publishing service, not a replacement", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-descriptor-owner-"));
    const path = join(root, "descriptor.json");
    const owner = { version: 1, service: "chat", instanceId: "old-chat", installId: "install-1",
      pid: 123, endpoint: "http://127.0.0.1:32001/", bearerToken: "x".repeat(48),
      startedAt: "2026-10-30T00:00:00Z" } as const;
    try {
      for (const change of [{ instanceId: "new-chat" }, { pid: 456 }, { installId: "install-2" }]) {
        const replacement = { ...owner, ...change };
        writeServiceRuntimeDescriptor(path, replacement);
        removeServiceRuntimeDescriptor(path, owner);
        expect(readServiceRuntimeDescriptor(path)).toEqual(replacement);
      }
      writeServiceRuntimeDescriptor(path, owner);
      removeServiceRuntimeDescriptor(path, owner);
      expect(readServiceRuntimeDescriptor(path)).toBeUndefined();
      expect(() => removeServiceRuntimeDescriptor(path, owner)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("terminal attachment carries its exact runtime owner with the endpoint", () => {
    const value = { contractVersion: 1 as const, slot: 2, endpoint: "ws://127.0.0.1:1234/",
      runtimeProcessId: 42, responsesRouteFingerprint: "a".repeat(64) };
    expect(parseCodexTerminalSessionContract({ ...value, secret: "discard" })).toEqual(value);
    expect(parseCodexTerminalSessionContract({ contractVersion: 1, slot: 2, endpoint: value.endpoint }).endpoint).toBe(value.endpoint);
    expect(() => parseCodexTerminalSessionContract({ ...value, runtimeProcessId: 0 })).toThrow();
    expect(() => parseCodexTerminalSessionContract({ ...value, responsesRouteFingerprint: undefined })).toThrow();
  });

  test("retained count above legacy review threshold is valid with free execution permits", () => {
    const base = { contractVersion: 3, profileSlot: 2, source: "managed_delegation_journal",
      observedAt: new Date().toISOString(), coverage: "managed_jobs_only",
      policy: "configurable_tasks_one_writer_per_checkout_v3", uncertain: 0,
      total: { used: 0, limit: 3 }, records: { retained: 65, limit: 64, admissionBound: false },
      available: true, messageKo: "프로필 2: 동시 작업 0/3", messageEn: "Profile 2: concurrent jobs 0/3",
      nextAction: "start_if_profile_ready" };
    expect(parseCodexWebDelegationCapacityContract(base).records.retained).toBe(65);
    expect(parseCodexWebDelegationCapacityContract({ ...base, records: { retained: 3, limit: 64 } }).available).toBe(true);
    expect(() => parseCodexWebDelegationCapacityContract({ ...base, records: { ...base.records, admissionBound: true } })).toThrow();
  });
  test("email disclosure rejects unsafe values and false matching assertions", () => {
    const value = { contractVersion: 1, slot: 1, native: { state: "signed-in", email: "user@EXAMPLE.invalid" }, web: { state: "signed-in", email: "user@example.invalid" }, comparison: "matching" };
    expect(parseCodexAccountDisplayContract(value).comparison).toBe("matching");
    for (const invalid of [{ comparison: "different" }, { slot: 0 }, { native: { state: "signed-out", email: "user@example.invalid" } },
      { native: { state: "signed-in", email: "user\n@example.invalid" } }, { web: { state: "signed-in", email: "User@example.invalid" } }]) {
      expect(() => parseCodexAccountDisplayContract({ ...value, ...invalid })).toThrow();
    }
    const result = parseCodexAccountDisplayContract({ ...value, secret: "no", native: { ...value.native, token: "no" } });
    expect(JSON.stringify(result)).not.toContain("secret"); expect(JSON.stringify(result)).not.toContain("token");
  });
  test("account observation rejects false user equality and strips identities", () => {
    const value = { contractVersion: 1, slot: 1, nativeSignIn: "signed-in", webBinding: "matching", nativeWebContainer: "matching", userIdentity: "unverified" } as const;
    expect(parseCodexAccountCheckContract({ ...value, email: "private@example.invalid", accountId: "private" })).toEqual(value);
    for (const invalid of [{ slot: 0 }, { slot: 100 }, { contractVersion: 2 }, { userIdentity: "matching" }, { nativeSignIn: "unknown" }, { webBinding: "ready" }, { nativeWebContainer: "ready" }]) {
      expect(() => parseCodexAccountCheckContract({ ...value, ...invalid })).toThrow();
    }
  });
  test("Desktop identity and connection progress survive the profile contract without exposing paths", () => {
    const profile = { slot: 1, targetId: "default", targetDisplayName: "ChatGPT", targetState: "running", targetSessionState: "ready", controlState: "running", desktopProcessId: 123, connectionInProgress: false } as const;
    expect(parseCodexProfileStatusContract(profile)).toEqual(profile);
    expect(() => parseCodexProfileStatusContract({ ...profile, desktopProcessId: 0 })).toThrow();
    expect(() => parseCodexProfileStatusContract({ ...profile, connectionInProgress: "false" })).toThrow();
  });
  test("accepts only loopback runtime descriptors with strong local bearer tokens", () => {
    const descriptor = parseServiceRuntimeDescriptor({
      version: 1,
      service: "chat",
      instanceId: "chat-instance-1",
      installId: "install-1",
      pid: 123,
      endpoint: "http://127.0.0.1:32001/",
      bearerToken: "x".repeat(48),
      startedAt: "2026-09-27T00:00:00.000Z",
    });
    expect(descriptor.service).toBe("chat");
    expect(() => parseServiceRuntimeDescriptor({ ...descriptor, endpoint: "https://example.com/" })).toThrow("loopback");
  });

  test("service health is independent of product/public tool naming", () => {
    const ready = { contractVersion: 1, service: "chat", instanceId: "chat-1", state: "ready", shutdownReadiness: "blocked" } as const;
    expect(parseServiceStatus(ready)).toEqual(ready);
    expect(() => parseServiceStatus({ ...ready, shutdownReadiness: false })).toThrow();
    expect(parseServiceStatus({
      contractVersion: 1,
      service: "codex",
      instanceId: "codex-1",
      state: "degraded",
      detail: "browser profile unavailable",
    })).toEqual({
      contractVersion: 1,
      service: "codex",
      instanceId: "codex-1",
      state: "degraded",
      detail: "browser profile unavailable",
    });
  });

  test("read-only bridge preview contract is bounded and unambiguous", () => {
    const retention = { total: 129, target: 10, active: 128, undelivered: 1,
      closing: 0, otherOwners: 0, reclaimable: 0 };
    expect(parseCodexBridgePreviewContract({ contractVersion: 1, slot: 2,
      activeSurfaceCount: 129, previewAvailable: false, retention }).retention).toEqual(retention);
    expect(parseCodexBridgePreviewContract({
      contractVersion: 1,
      slot: 2,
      activeSurfaceCount: 1,
      previewAvailable: true,
      imageMimeType: "image/jpeg",
      imageBase64: "AQIDBA==",
    })).toEqual({
      contractVersion: 1,
      slot: 2,
      activeSurfaceCount: 1,
      previewAvailable: true,
      imageMimeType: "image/jpeg",
      imageBase64: "AQIDBA==",
    });
    expect(() => parseCodexBridgePreviewContract({
      contractVersion: 1,
      slot: 2,
      activeSurfaceCount: 2,
      previewAvailable: true,
      imageMimeType: "image/jpeg",
      imageBase64: "AQIDBA==",
    })).toThrow("image is invalid");
    expect(() => parseCodexBridgePreviewContract({
      contractVersion: 1,
      slot: 2,
      activeSurfaceCount: 0,
      previewAvailable: false,
      imageBase64: "AQIDBA==",
    })).toThrow("must not include image data");
    const id = "surface_" + "a".repeat(32);
    const selected = { contractVersion: 1, slot: 2, activeSurfaceCount: 1, previewAvailable: false,
      surfaces: [{ id, label: "Owned surface" }], selectedSurfaceId: id };
    const detail = { id, taskId: "native-task", state: "undelivered", nextAction: "inspect_result",
      idleExpiresAt: "2026-11-06T00:00:00Z", rawPage: "PRIVATE" };
    const detailed = { ...selected, retention: { ...retention, surface: detail } };
    expect(parseCodexBridgePreviewContract(detailed).retention?.surface).toEqual({ id, taskId: "native-task",
      state: "undelivered", nextAction: "inspect_result", idleExpiresAt: "2026-11-06T00:00:00Z" });
    expect(() => parseCodexBridgePreviewContract({ ...detailed, selectedSurfaceId: undefined })).toThrow("owner mismatch");
    for (const change of [{ id: "another-surface" }, { state: "gone" }, { nextAction: "force_close" }, { idleExpiresAt: "invalid" }]) {
      expect(() => parseCodexBridgePreviewContract({ ...selected,
        retention: { ...retention, surface: { ...detail, ...change } } })).toThrow();
    }
    expect(parseCodexBridgePreviewContract({
      ...selected, approvalState: "unavailable", approvalObservationReason: "dom_observation_failed",
    })).toMatchObject({ approvalState: "unavailable", approvalObservationReason: "dom_observation_failed" });
    expect(() => parseCodexBridgePreviewContract({ ...selected, approvalState: "cleared" })).toThrow();
    expect(() => parseCodexBridgePreviewContract({
      ...selected, approvalState: "pending", approvalObservationReason: "dom_observation_failed",
    })).toThrow();
    expect(() => parseCodexBridgePreviewContract({ ...selected, selectedSurfaceId: undefined,
      approvalState: "pending" })).toThrow();
    const wait = {phase:"card_cleared",elapsedMs:540000,unverifiedDispatchCount:1,operationState:"waiting",rawCard:"PRIVATE"};
    const waiting = parseCodexBridgePreviewContract({...selected,approvalState:"none",approvalWait:wait});
    expect(waiting.approvalWait).toEqual({phase:"card_cleared",elapsedMs:540000,unverifiedDispatchCount:1,operationState:"waiting"});
    expect(() => parseCodexBridgePreviewContract({...selected,selectedSurfaceId:undefined,approvalWait:wait})).toThrow();
    for (const invalid of [{elapsedMs:-1},{elapsedMs:Infinity},{operationState:"complete"},{phase:"approved"},{unverifiedDispatchCount:0.5}, {phase:["pending"]}, {operationState:["waiting"]}]) {
      expect(() => parseCodexBridgePreviewContract({...selected,approvalWait:{...wait,...invalid}})).toThrow();
    }
  });
});

test("model readiness is carried separately from process ownership", () => {
  const status = { slot: 1, targetId: "default", targetDisplayName: "ChatGPT", targetState: "running", targetSessionState: "ready", controlState: "running", webModelsReady: false };
  expect(parseCodexProfileStatusContract(status).webModelsReady).toBe(false);
  expect(() => parseCodexProfileStatusContract({ ...status, webModelsReady: "yes" })).toThrow();
});

test("Web admission is explicit and does not imply visible models or Native shutdown", async () => {
  const { parseCodexWebStateContract, parseCodexProfileStatusContract } = await import("./index");
  const base = { slot: 1, targetId: "default", targetDisplayName: "ChatGPT", targetState: "running", targetSessionState: "ready", controlState: "running" };
  expect(parseCodexProfileStatusContract({ ...base, webState: "failed", webModelsReady: false }).controlState).toBe("running");
  expect(parseCodexProfileStatusContract({ ...base, webState: "login-required", webModelsReady: false }).webState).toBe("login-required");
  expect(parseCodexWebStateContract({ contractVersion: 1, slot: 1, webState: "login-required", webModelIds: [] }).webState).toBe("login-required");
  expect(() => parseCodexWebStateContract({ contractVersion: 1, slot: 1, webState: "login-required", webModelIds: ["chatgpt-tela-web/fixture"] })).toThrow();
  expect(parseCodexProfileStatusContract({ ...base, webState: "preparing", webModelsReady: false }).webState).toBe("preparing");
  expect(parseCodexProfileStatusContract({ ...base, webState: "preparing", webModelsReady: false,
    accountManagementActive: true }).accountManagementActive).toBe(true);
  expect(() => parseCodexProfileStatusContract({ ...base, webState: "ready", accountManagementActive: true })).toThrow();
  expect(() => parseCodexProfileStatusContract({ ...base, webState: "preparing", accountManagementActive: "yes" })).toThrow();
  expect(() => parseCodexProfileStatusContract({ ...base, webState: "guessed" })).toThrow();
  expect(parseCodexWebStateContract({ contractVersion: 1, slot: 1, webState: "ready", webModelIds: ["chatgpt-tela-web/fixture"] }).webState).toBe("ready");
  expect(parseCodexWebStateContract({ contractVersion: 1, slot: 1, webState: "preparing", webModelIds: [],
    accountManagementActive: true }).accountManagementActive).toBe(true);
  for (const value of [
    { contractVersion: 1, slot: 1, webState: "ready", webModelIds: [] },
    { contractVersion: 1, slot: 1, webState: "failed", webModelIds: ["chatgpt-tela-web/fixture"] },
    { contractVersion: 1, slot: 1, webState: "ready", webModelIds: ["native-fixture"] },
    { contractVersion: 1, slot: 1, webState: "ready", webModelIds: ["chatgpt-tela-web/fixture", "chatgpt-tela-web/fixture"] },
    { contractVersion: 1, slot: 1, webState: "ready", webModelIds: ["chatgpt-tela-web/fixture"], accountManagementActive: true },
    { contractVersion: 1, slot: 1, webState: "preparing", webModelIds: [], accountManagementActive: "yes" },
  ]) expect(() => parseCodexWebStateContract(value)).toThrow();
});

test("multiple previews require a selection belonging to the exact bounded inventory", () => {
  const a = "surface_" + "a".repeat(32), b = "surface_" + "b".repeat(32);
  const value = { contractVersion: 1, slot: 1, activeSurfaceCount: 2, previewAvailable: true,
    surfaces: [{id: a, label: "A"}, {id: b, label: "B"}], selectedSurfaceId: b,
    imageMimeType: "image/jpeg", imageBase64: "AQIDBA==" };
  expect(parseCodexBridgePreviewContract(value).selectedSurfaceId).toBe(b);
  expect(() => parseCodexBridgePreviewContract({...value, selectedSurfaceId: "surface_" + "c".repeat(32)})).toThrow();
  expect(() => parseCodexBridgePreviewContract({...value, surfaces: [value.surfaces[0], value.surfaces[0]]})).toThrow();
  expect(() => parseCodexBridgePreviewContract({...value, selectedSurfaceId: undefined})).toThrow();
});

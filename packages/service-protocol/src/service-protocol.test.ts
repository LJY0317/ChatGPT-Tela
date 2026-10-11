import { describe, expect, test } from "bun:test";
import { parseCodexAccountDisplayContract, parseCodexAccountCheckContract, parseCodexProfileStatusContract, parseCodexBridgePreviewContract, parseServiceRuntimeDescriptor, parseServiceStatus } from "./index";

describe("private service protocol", () => {
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
  expect(parseCodexProfileStatusContract({ ...base, webState: "preparing", webModelsReady: false }).webState).toBe("preparing");
  expect(() => parseCodexProfileStatusContract({ ...base, webState: "guessed" })).toThrow();
  expect(parseCodexWebStateContract({ contractVersion: 1, slot: 1, webState: "ready", webModelIds: ["chatgpt-tela-web/fixture"] }).webState).toBe("ready");
  for (const value of [
    { contractVersion: 1, slot: 1, webState: "ready", webModelIds: [] },
    { contractVersion: 1, slot: 1, webState: "failed", webModelIds: ["chatgpt-tela-web/fixture"] },
    { contractVersion: 1, slot: 1, webState: "ready", webModelIds: ["native-fixture"] },
    { contractVersion: 1, slot: 1, webState: "ready", webModelIds: ["chatgpt-tela-web/fixture", "chatgpt-tela-web/fixture"] },
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

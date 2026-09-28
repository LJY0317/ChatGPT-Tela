import { describe, expect, test } from "bun:test";
import { parseCodexBridgePreviewContract, parseServiceRuntimeDescriptor, parseServiceStatus } from "./index";

describe("private service protocol", () => {
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

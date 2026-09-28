import { describe, expect, test } from "bun:test";
import { parseServiceRuntimeDescriptor, parseServiceStatus } from "./index";

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
});

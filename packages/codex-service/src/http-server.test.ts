import { describe, expect, test } from "bun:test";
import type { CodexService } from "./controller";
import { startCodexServiceHttpServer } from "./http-server";

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
    async profiles() { return []; },
    async startProfile() { throw new Error("not used"); },
    async stopProfile() { throw new Error("not used"); },
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
    async close() {},
    activeProfileCount: 0,
  };
}

describe("Tela Codex private HTTP server", () => {
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
});

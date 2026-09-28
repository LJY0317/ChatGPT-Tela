import { describe, expect, test } from "bun:test";
import { startProfileBridgePreviewServer } from "./bridge-preview-server";

describe("profile bridge preview server", () => {
  test("serves only authenticated loopback read-only preview observations", async () => {
    let observations = 0;
    const token = "u".repeat(48);
    const server = await startProfileBridgePreviewServer({
      slot: 2,
      bearerToken: token,
      async observe() {
        observations += 1;
        return { activeSurfaceCount: 1, jpeg: new Uint8Array([1, 2, 3, 4]) };
      },
    });
    try {
      expect((await fetch(new URL("v1/bridge-preview", server.endpoint))).status).toBe(401);
      expect((await fetch(new URL("v1/bridge-preview", server.endpoint), {
        headers: { authorization: `Bearer ${token}`, origin: "https://chatgpt.com" },
      })).status).toBe(403);
      const response = await fetch(new URL("v1/bridge-preview", server.endpoint), {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        contractVersion: 1,
        slot: 2,
        activeSurfaceCount: 1,
        previewAvailable: true,
        imageMimeType: "image/jpeg",
        imageBase64: "AQIDBA==",
      });
      expect(observations).toBe(1);
    } finally {
      await server.close();
    }
  });

  test("runs model-selection canary only as an authenticated explicit POST", async () => {
    const token = "m".repeat(48);
    let calls = 0;
    const server = await startProfileBridgePreviewServer({
      slot: 1,
      bearerToken: token,
      async observe() { return { activeSurfaceCount: 0 }; },
      async probeModelSelection() {
        calls += 1;
        return { familyCount: 3, exercised: true, testedEffort: "medium", restoredEffort: "high" };
      },
    });
    try {
      const url = new URL("v1/model-selection-canary", server.endpoint);
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { method: "GET", headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
      expect((await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, origin: "https://chatgpt.com" },
      })).status).toBe(403);
      const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` } });
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
      expect(calls).toBe(1);
    } finally {
      await server.close();
    }
  });
});

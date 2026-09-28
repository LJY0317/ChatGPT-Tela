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
});

import { describe, expect, test } from "bun:test";
import { chatGptWebFamilyKey, chatGptWebModelId } from "@chatgpt-tela/chatgpt";
import { startModelListOverlayServer } from "./model-list-overlay-server";

describe("Plura model-list overlay callback", () => {
  test("authenticates the exact callback and preserves Native rows while adding Web choices", async () => {
    const key = chatGptWebFamilyKey("Web Family");
    const server = await startModelListOverlayServer({
      token: "s".repeat(48),
      families: () => [{ key, label: "Web Family", availableEfforts: ["medium"] }],
    });
    const native = {
      data: [{
        id: "native", model: "native", displayName: "Native",
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
      }],
    };
    try {
      const unauthorized = await fetch(server.url, {
        method: "POST", body: JSON.stringify({ contractVersion: 1, result: native }),
      });
      expect(unauthorized.status).toBe(401);
      const invalid = await fetch(server.url, {
        method: "POST",
        headers: { authorization: `Bearer ${"s".repeat(48)}` },
        body: JSON.stringify({ contractVersion: 2, result: native }),
      });
      expect(invalid.status).toBe(400);
      const response = await fetch(server.url, {
        method: "POST",
        headers: { authorization: `Bearer ${"s".repeat(48)}` },
        body: JSON.stringify({ contractVersion: 1, result: native }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { contractVersion: number; result: typeof native };
      expect(body.contractVersion).toBe(1);
      expect(body.result.data[0]).toEqual(native.data[0]);
      expect(body.result.data[1]?.model).toBe(chatGptWebModelId(key));
    } finally {
      await server.close();
    }
  });
});

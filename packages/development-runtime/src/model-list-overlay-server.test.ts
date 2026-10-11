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

test("startup catalog callback preserves Native model metadata and adds the discovered Web family", async () => {
  const key = chatGptWebFamilyKey("Observed Web");
  const server = await startModelListOverlayServer({ token: "s".repeat(48), localCompaction: true,
    families: () => [{ key, label: "Observed Web", availableEfforts: ["high"] }], });
  const native = { models: [{ slug: "native", display_name: "Native", visibility: "list",
    supported_in_api: true, default_reasoning_level: "high",
    supported_reasoning_levels: [{ effort: "high", description: "High" }], input_modalities: ["text"], priority: 0 }] };
  try {
    const response = await fetch(server.url, { method: "POST", headers: { authorization: `Bearer ${"s".repeat(48)}` },
      body: JSON.stringify({ contractVersion: 1, result: native }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { models: Record<string, unknown>[] } };
    expect(body.result.models[0]).toEqual(native.models[0]);
    expect(body.result.models[1]?.slug).toBe(chatGptWebModelId(key));
  } finally { await server.close(); }
});


test("late Web discovery changes the same overlay without replacing Native rows", async () => {
  const key = chatGptWebFamilyKey("Late Web");
  let families: Parameters<typeof startModelListOverlayServer>[0]["families"] extends () => infer T ? T : never = [];
  const server = await startModelListOverlayServer({ token: "s".repeat(48), families: () => families });
  const native = { data: [{ id: "native", model: "native", displayName: "Native",
    supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }] }] };
  const read = async () => {
    const response = await fetch(server.url, { method: "POST", headers: { authorization: `Bearer ${"s".repeat(48)}` },
      body: JSON.stringify({ contractVersion: 1, result: native }) });
    expect(response.status).toBe(200);
    return await response.json() as { result: { data: { model: string }[] } };
  };
  try {
    expect((await read()).result.data).toEqual(native.data);
    families = [{ key, label: "Late Web", availableEfforts: ["medium"] }];
    expect((await read()).result.data.map(row => row.model)).toEqual(["native", chatGptWebModelId(key)]);
    families = [];
    expect((await read()).result.data).toEqual(native.data);
  } finally { await server.close(); }
});

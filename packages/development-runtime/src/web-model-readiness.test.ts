import { expect, test } from "bun:test";
import { chatGptWebFamilyKey, chatGptWebModelId } from "@chatgpt-tela/chatgpt";
import { verifyWebModelReadiness } from "./web-model-readiness";
const families = [{ key: chatGptWebFamilyKey("Fixture"), label: "Fixture", availableEfforts: ["high" as const] }];
const row = { model: chatGptWebModelId(families[0]!.key), hidden: false };
function verify(config: unknown, list: unknown) {
  return verifyWebModelReadiness({ request: async method => method === "config/read" ? config : list }, families, AbortSignal.timeout(1000));
}
test("API overlay alone cannot establish model visibility", async () => {
  await expect(verify({ config: {} }, { data: [row] })).rejects.toThrow("catalog is not active");
});
test("active catalog and complete discovered Web set establish readiness", async () => {
  await verify({ config: { model_catalog_json: "/fixture/models.json" } }, { data: [{ model: "native" }, row], nextCursor: null });
});
test("missing, hidden, duplicate and stale Web rows cannot report ready", async () => {
  for (const data of [[], [{ ...row, hidden: true }], [row, row], [{ model: "chatgpt-tela-web/obsolete" }]]) {
    await expect(verify({ config: { model_catalog_json: "/fixture/models.json" } }, { data })).rejects.toThrow();
  }
  await expect(verify({ config: { model_catalog_json: "/fixture/models.json" } }, { data: [row], nextCursor: "more" })).rejects.toThrow("incomplete");
});

test("catalog checks reject failed updates and accept restored or newly discovered choices", async () => {
  let activeConfig: unknown = { config: { model_catalog_json: "/fixture/v1.json" } };
  let activeList: unknown = { data: [row] };
  const rpc = { request: async (method: string) => method === "config/read" ? activeConfig : activeList };
  for (let cycle = 0; cycle < 3; cycle++) {
    await verifyWebModelReadiness(rpc, families, AbortSignal.timeout(1000));
    activeConfig = { config: {} };
    await expect(verifyWebModelReadiness(rpc, families, AbortSignal.timeout(1000))).rejects.toThrow("not active");
    activeConfig = { config: { model_catalog_json: `/fixture/v${cycle + 2}.json` } };
    activeList = { data: [] };
    await expect(verifyWebModelReadiness(rpc, families, AbortSignal.timeout(1000))).rejects.toThrow();
    activeList = { data: [row] };
    await verifyWebModelReadiness(rpc, families, AbortSignal.timeout(1000));
  }
  const next = { key: chatGptWebFamilyKey("New discovery"), label: "New discovery", availableEfforts: ["high" as const] };
  await expect(verifyWebModelReadiness(rpc, [...families, next], AbortSignal.timeout(1000))).rejects.toThrow("does not match");
  activeList = { data: [row, { model: chatGptWebModelId(next.key), hidden: false }] };
  await verifyWebModelReadiness(rpc, [...families, next], AbortSignal.timeout(1000));
});

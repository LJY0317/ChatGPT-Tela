import { describe, expect, test } from "bun:test";
import { chatGptWebFamilyKey, chatGptWebModelId } from "@chatgpt-tela/chatgpt";
import { createDefaultProfileCompositeProviderRouter } from "./composite-provider-router";

const header = "X-ChatGPT-Tela-Runtime-Token";

function request(path: string, body?: unknown): Request {
  return new Request(`http://127.0.0.1:9000${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer native-auth",
      [header]: "local-secret",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function nativeCatalog() {
  return {
    models: [{
      slug: "native-model",
      display_name: "Native",
      visibility: "list",
      supported_in_api: true,
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
    }],
  };
}

describe("default-profile composite provider router", () => {
  test("preserves native responses while Web model ids stay on the Tela browser route", async () => {
    const upstream: string[] = [];
    const router = createDefaultProfileCompositeProviderRouter({
      runtimeHeaderName: header,
      discoverWebModelFamilies: async () => [],
      backendBaseUrl: "https://native.invalid/backend-api/codex",
      async fetchUpstream(req) {
        upstream.push(req.url);
        expect(req.headers.get(header)).toBeNull();
        expect(req.headers.get("authorization")).toBe("Bearer native-auth");
        return new Response("native-ok");
      },
    });
    const native = await router.route(request("/v1/responses", { model: "native-model", input: [] }));
    expect(await native?.text()).toBe("native-ok");
    const key = chatGptWebFamilyKey("Web Family");
    expect(await router.route(request("/v1/responses", { model: chatGptWebModelId(key), input: [] }))).toBeUndefined();
    expect(upstream).toEqual(["https://native.invalid/backend-api/codex/responses"]);
  });

  test("augments native model discovery and coalesces/caches browser discovery", async () => {
    let discoveries = 0;
    let clock = 100;
    const key = chatGptWebFamilyKey("Web Family");
    const router = createDefaultProfileCompositeProviderRouter({
      runtimeHeaderName: header,
      catalogTtlMs: 1_000,
      now: () => clock,
      async discoverWebModelFamilies() {
        discoveries += 1;
        return [{ key, label: "Web Family", availableEfforts: ["medium"] }];
      },
      async fetchUpstream() {
        return Response.json(nativeCatalog());
      },
    });
    const first = await router.route(request("/v1/models"));
    const second = await router.route(request("/v1/models"));
    expect(discoveries).toBe(1);
    expect(((await first?.json()) as any).models.map((model: any) => model.slug)).toEqual([
      "native-model", chatGptWebModelId(key),
    ]);
    expect(((await second?.json()) as any).models).toHaveLength(2);
    clock += 1_001;
    await router.route(request("/v1/models"));
    expect(discoveries).toBe(2);
  });

  test("browser catalog failure degrades to native-only instead of hiding Native models", async () => {
    const router = createDefaultProfileCompositeProviderRouter({
      runtimeHeaderName: header,
      discoverWebModelFamilies: async () => { throw new Error("picker changed"); },
      fetchUpstream: async () => Response.json(nativeCatalog()),
    });
    const response = await router.route(request("/v1/models"));
    expect(((await response?.json()) as any).models.map((model: any) => model.slug)).toEqual(["native-model"]);
  });
});

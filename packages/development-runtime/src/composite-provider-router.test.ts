import { describe, expect, test } from "bun:test";
import { chatGptWebFamilyKey, chatGptWebModelId } from "@chatgpt-tela/chatgpt";
import { createDefaultProfileCompositeProviderRouter } from "./composite-provider-router";

const header = "OpenAI-Organization";

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
  test("model-local compaction is advertised only for Web models on the opted-in engine route", async () => {
    for (const localCompaction of [false, true]) {
      const router = createDefaultProfileCompositeProviderRouter({ runtimeHeaderName: header, localCompaction,
        discoverWebModelFamilies: async () => [{ key: chatGptWebFamilyKey("Web Family"), label: "Web Family", availableEfforts: ["medium"] }],
        fetchUpstream: async () => Response.json(nativeCatalog()),
      });
      await router.refreshWebModelFamilies();
      const catalog = await (await router.route(request("/v1/models")))?.json();
      expect(catalog.models[0].compaction_mode).toBeUndefined();
      expect(catalog.models[1].compaction_mode).toBe(localCompaction ? "local" : undefined);
    }
  });
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
    const webCompactionV2 = await router.route(request("/v1/responses", {
      model: chatGptWebModelId(key),
      input: [{ type: "message", role: "user", content: "test" }, { type: "compaction_trigger" }],
    }));
    expect(webCompactionV2?.status).toBe(400);
    expect((await webCompactionV2?.json()).error).toMatchObject({
      type: "invalid_request_error", code: "tela_web_compaction_unsupported",
    });
    expect(await router.route(request("/v1/responses", {
      model: "native-model", input: [{ type: "compaction_trigger" }],
    }))).toBeDefined();
    const webCompaction = await router.route(request("/v1/responses/compact", { model: chatGptWebModelId(key), input: [] }));
    expect(webCompaction?.status).toBe(400);
    expect((await webCompaction?.json()).error.code).toBe("tela_web_compaction_unsupported");
    expect(await router.route(request("/v1/responses/compact", { model: "native-model", input: [] }))).toBeDefined();
    expect(upstream).toEqual([
      "https://native.invalid/backend-api/codex/responses",
      "https://native.invalid/backend-api/codex/responses",
      "https://native.invalid/backend-api/codex/responses/compact",
    ]);
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
    await router.refreshWebModelFamilies();
    const second = await router.route(request("/v1/models"));
    expect(discoveries).toBe(1);
    expect(((await first?.json()) as any).models.map((model: any) => model.slug)).toEqual([
      "native-model",
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

  test("Native catalog completes while Web discovery is held and refresh is coalesced", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let discoveries = 0;
    const family = { key: chatGptWebFamilyKey("Held Web"), label: "Held Web", availableEfforts: ["medium"] as const };
    const router = createDefaultProfileCompositeProviderRouter({ runtimeHeaderName: header,
      discoverWebModelFamilies: async () => { discoveries++; await held; return [family]; },
      fetchUpstream: async () => Response.json(nativeCatalog()),
    });
    try {
      const responses = await Promise.all([router.route(request("/v1/models")), router.route(request("/v1/models"))]);
      for (const response of responses) expect((await response?.json()).models).toEqual(nativeCatalog().models);
      expect(discoveries).toBe(1);
    } finally { release(); }
    await router.refreshWebModelFamilies();
    expect((await (await router.route(request("/v1/models")))?.json()).models).toHaveLength(2);
  });

  test("combined ETag changes only with delivered body, including Web-only changes", async () => {
    let families: any[] = [];
    const router = createDefaultProfileCompositeProviderRouter({ runtimeHeaderName: header,
      discoverWebModelFamilies: async () => families,
      fetchUpstream: async () => Response.json(nativeCatalog(), { headers: { etag: '"native-only"' } }),
    });
    await router.refreshWebModelFamilies();
    const before = await router.route(request("/v1/models"));
    families = [{ key: chatGptWebFamilyKey("New Web"), label: "New Web", availableEfforts: ["medium"] }];
    await router.refreshWebModelFamilies();
    const after = await router.route(request("/v1/models"));
    const unchanged = await router.route(request("/v1/models"));
    expect(before?.headers.get("etag")).not.toBe(after?.headers.get("etag"));
    expect(after?.headers.get("etag")).toBe(unchanged?.headers.get("etag"));
  });

  test("invalid Web projection preserves Native response and metadata", async () => {
    const family = { key: chatGptWebFamilyKey("Duplicate"), label: "Duplicate", availableEfforts: ["medium"] as const };
    const router = createDefaultProfileCompositeProviderRouter({ runtimeHeaderName: header,
      discoverWebModelFamilies: async () => [family, family],
      fetchUpstream: async () => Response.json(nativeCatalog(), { headers: { "x-fixture-metadata": "preserved" } }),
    });
    await router.refreshWebModelFamilies();
    const response = await router.route(request("/v1/models"));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-fixture-metadata")).toBe("preserved");
    expect(await response?.json()).toEqual(nativeCatalog());
  });
});

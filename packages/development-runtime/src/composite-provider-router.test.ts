import { describe, expect, test } from "bun:test";
import { chatGptWebFamilyKey, chatGptWebModelId, type ChatGptWebModelFamily } from "@chatgpt-tela/chatgpt";
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
        webModelFamilies: () => [{ key: chatGptWebFamilyKey("Web Family"), label: "Web Family", availableEfforts: ["medium"] }],
        fetchUpstream: async () => Response.json(nativeCatalog()),
      });
      const catalog = await (await router.route(request("/v1/models")))?.json();
      expect(catalog.models[0].compaction_mode).toBeUndefined();
      expect(catalog.models[1].compaction_mode).toBe(localCompaction ? "local" : undefined);
    }
  });
  test("preserves native responses while Web model ids stay on the Tela browser route", async () => {
    const upstream: string[] = [];
    const router = createDefaultProfileCompositeProviderRouter({
      runtimeHeaderName: header,
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
    expect(webCompactionV2).toBeUndefined();
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

  test("app-owned composite routes Native -> Web -> Native with the original authorization", async () => {
    const nativeModels: string[] = [];
    const webModels: string[] = [];
    const key = chatGptWebFamilyKey("Web Family");
    const router = createDefaultProfileCompositeProviderRouter({
      runtimeHeaderName: header,
      async fetchUpstream(req) {
        expect(req.headers.get("authorization")).toBe("Bearer native-auth");
        expect(req.headers.has(header)).toBe(false);
        const body = await req.json() as { model: string };
        nativeModels.push(body.model);
        return Response.json({ provider: "native", model: body.model });
      },
    });
    const dispatch = async (model: string) => {
      const incoming = request("/v1/responses", { model, input: [] });
      const native = await router.route(incoming);
      if (native) return native.json();
      // Same downstream boundary as the existing app-owned requestRouter:
      // only the recognized Web namespace is delivered to browser Responses.
      expect(model).toBe(chatGptWebModelId(key));
      webModels.push(model);
      return { provider: "web", model };
    };
    expect((await dispatch("native-model") as any).provider).toBe("native");
    expect((await dispatch(chatGptWebModelId(key)) as any).provider).toBe("web");
    expect((await dispatch("native-model") as any).provider).toBe("native");
    expect(nativeModels).toEqual(["native-model", "native-model"]);
    expect(webModels).toEqual([chatGptWebModelId(key)]);
    const unauthenticated = new Request("http://127.0.0.1:9000/v1/responses", {
      method: "POST", body: JSON.stringify({ model: "native-model", input: [] }),
    });
    await expect(router.route(unauthenticated)).rejects.toThrow("first-party request authorization");
  });

  test("Native catalog changes are visible while Web choices come from the admitted connection", async () => {
    let nativeRevision = 0;
    const key = chatGptWebFamilyKey("Web Family");
    let webModelFamilies: readonly ChatGptWebModelFamily[] = [];
    const router = createDefaultProfileCompositeProviderRouter({
      runtimeHeaderName: header,
      webModelFamilies: () => webModelFamilies,
      async fetchUpstream() {
        const catalog = nativeCatalog();
        if (nativeRevision) catalog.models.push({ ...catalog.models[0]!, slug: "new-server-model" });
        return Response.json(catalog);
      },
    });
    const slugs = async () => (await (await router.route(request("/v1/models")))?.json()).models.map((model: { slug: string }) => model.slug);
    expect(await slugs()).toEqual(["native-model"]);
    webModelFamilies = [{ key, label: "Web Family", availableEfforts: ["medium"] }];
    nativeRevision = 1;
    expect(await slugs()).toEqual(["native-model", "new-server-model", chatGptWebModelId(key)]);
    webModelFamilies = [];
    expect(await slugs()).toEqual(["native-model", "new-server-model"]);
  });

  test("combined ETag changes only with delivered body, including Web-only changes", async () => {
    let families: readonly ChatGptWebModelFamily[] = [];
    const router = createDefaultProfileCompositeProviderRouter({ runtimeHeaderName: header,
      webModelFamilies: () => families,
      fetchUpstream: async () => Response.json(nativeCatalog(), { headers: { etag: '"native-only"' } }),
    });
    const before = await router.route(request("/v1/models"));
    families = [{ key: chatGptWebFamilyKey("New Web"), label: "New Web", availableEfforts: ["medium"] }];
    const after = await router.route(request("/v1/models"));
    const unchanged = await router.route(request("/v1/models"));
    expect(before?.headers.get("etag")).not.toBe(after?.headers.get("etag"));
    expect(after?.headers.get("etag")).toBe(unchanged?.headers.get("etag"));
  });

  test("invalid Web projection preserves Native response and metadata", async () => {
    const family = { key: chatGptWebFamilyKey("Duplicate"), label: "Duplicate", availableEfforts: ["medium"] as const };
    const router = createDefaultProfileCompositeProviderRouter({ runtimeHeaderName: header,
      webModelFamilies: () => [family, family],
      fetchUpstream: async () => Response.json(nativeCatalog(), { headers: { "x-fixture-metadata": "preserved" } }),
    });
    const response = await router.route(request("/v1/models"));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-fixture-metadata")).toBe("preserved");
    expect(await response?.json()).toEqual(nativeCatalog());
  });
});

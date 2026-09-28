import { describe, expect, test } from "bun:test";
import {
  createDefaultDesktopResponsesRoute,
  defaultDesktopCodexConfigArguments,
  rewriteDefaultDesktopAppServerRequest,
  TELA_DEFAULT_DESKTOP_PROVIDER_ID,
} from "./route";

const route = createDefaultDesktopResponsesRoute({
  baseUrl: "http://127.0.0.1:18741/responses",
  envKey: "CHATGPT_TELA_RUNTIME_TOKEN",
  credential: "s".repeat(48),
});

describe("built-in default Desktop Responses route", () => {
  test("contains only Tela-owned routing identity and no model or Native tool catalog", () => {
    expect(route.baseUrl).toBe("http://127.0.0.1:18741/v1");
    expect(route.providerId).toBe(TELA_DEFAULT_DESKTOP_PROVIDER_ID);
    expect(route.runtimeHeaderName).toBe("X-ChatGPT-Tela-Runtime-Token");
    expect(route.modelCatalogUrl).toBe("http://127.0.0.1:18741/v1/models");
    expect(route.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const args = defaultDesktopCodexConfigArguments(route).join(" ");
    expect(args).toContain(TELA_DEFAULT_DESKTOP_PROVIDER_ID);
    expect(args).toContain("model_catalog_url");
    expect(args).toContain("requires_openai_auth=true");
    expect(args).toContain("X-ChatGPT-Tela-Runtime-Token");
    expect(args).not.toContain("gpt-");
    expect(args).not.toContain("tool_");
    expect(args).not.toContain("s".repeat(48));
    expect(args).not.toContain(".env_key=");
  });

  test("overlays only thread lifecycle requests and preserves unrelated JSON-RPC bytes", () => {
    const unrelated = '{"id":1,"method":"thread/read","params":{"threadId":"abc"}}';
    expect(rewriteDefaultDesktopAppServerRequest(unrelated, route)).toBe(unrelated);

    const input = JSON.stringify({
      id: 2,
      method: "thread/start",
      params: {
        modelProvider: "some_runtime_provider",
        config: {
          arbitrary_future_field: { keep: true },
          model_providers: { other_provider: { name: "keep-me" } },
        },
      },
    });
    const output = JSON.parse(rewriteDefaultDesktopAppServerRequest(input, route)) as any;
    expect(output.params.modelProvider).toBe(TELA_DEFAULT_DESKTOP_PROVIDER_ID);
    expect(output.params.config.model_provider).toBe(TELA_DEFAULT_DESKTOP_PROVIDER_ID);
    expect(output.params.config.arbitrary_future_field).toEqual({ keep: true });
    expect(output.params.config.model_providers.other_provider).toEqual({ name: "keep-me" });
    expect(output.params.config.model_providers[TELA_DEFAULT_DESKTOP_PROVIDER_ID]).toMatchObject({
      base_url: "http://127.0.0.1:18741/v1",
      model_catalog_url: "http://127.0.0.1:18741/v1/models",
      env_http_headers: {
        "X-ChatGPT-Tela-Runtime-Token": "CHATGPT_TELA_RUNTIME_TOKEN",
      },
      wire_api: "responses",
      requires_openai_auth: true,
    });
    expect(output.params.config.model_providers[TELA_DEFAULT_DESKTOP_PROVIDER_ID].env_key).toBeUndefined();
  });

  test("fails closed instead of replacing malformed routed config", () => {
    expect(() => rewriteDefaultDesktopAppServerRequest(JSON.stringify({
      method: "thread/resume",
      params: { config: "not-an-object" },
    }), route)).toThrow("non-object config");
  });
});

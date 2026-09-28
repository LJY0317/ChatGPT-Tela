import { describe, expect, test } from "bun:test";
import { forwardNativeCodexRequest, scrubTelaResponsesArtifacts } from "./native-passthrough";

describe("Native Codex passthrough", () => {
  test("scrubs only Tela-owned response and item ids", () => {
    const source = {
      previous_response_id: "resp_tela_abcdefghijklmnopqrstuvwx",
      input: [
        { type: "message", id: "msg_tela_abcdefghijklmnopqrstuvwx", role: "assistant", content: [] },
        { type: "message", id: "msg_native_opaque", role: "assistant", content: [] },
      ],
    };
    const result = scrubTelaResponsesArtifacts(source);
    expect(result.changed).toBe(true);
    expect(result.value).toEqual({
      input: [
        { type: "message", role: "assistant", content: [] },
        { type: "message", id: "msg_native_opaque", role: "assistant", content: [] },
      ],
    });
    expect(source.previous_response_id).toBe("resp_tela_abcdefghijklmnopqrstuvwx");
  });

  test("forwards first-party authorization but strips the Tela runtime capability", async () => {
    let observed: Request | undefined;
    const request = new Request("http://127.0.0.1:9000/v1/responses?foo=bar", {
      method: "POST",
      headers: {
        authorization: "Bearer native-chatgpt-auth",
        "chatgpt-account-id": "account-1",
        "x-chatgpt-tela-runtime-token": "local-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "native-model",
        previous_response_id: "resp_tela_abcdefghijklmnopqrstuvwx",
        input: [{ type: "message", id: "msg_tela_abcdefghijklmnopqrstuvwx", role: "assistant", content: [] }],
      }),
    });
    const response = await forwardNativeCodexRequest({
      request,
      endpoint: "responses",
      runtimeHeaderName: "x-chatgpt-tela-runtime-token",
      backendBaseUrl: "https://chatgpt.invalid/backend-api/codex",
      async fetchUpstream(upstream) {
        observed = upstream;
        return new Response("ok", { status: 201, headers: { "x-upstream": "yes" } });
      },
    });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("ok");
    expect(observed?.url).toBe("https://chatgpt.invalid/backend-api/codex/responses?foo=bar");
    expect(observed?.headers.get("authorization")).toBe("Bearer native-chatgpt-auth");
    expect(observed?.headers.get("chatgpt-account-id")).toBe("account-1");
    expect(observed?.headers.has("x-chatgpt-tela-runtime-token")).toBe(false);
    const body = await observed?.json() as any;
    expect(body.previous_response_id).toBeUndefined();
    expect(body.input[0].id).toBeUndefined();
  });

  test("fails closed without first-party authorization", async () => {
    const request = new Request("http://127.0.0.1:9000/v1/responses", {
      method: "POST",
      headers: { "x-chatgpt-tela-runtime-token": "local-secret" },
      body: "{}",
    });
    await expect(forwardNativeCodexRequest({
      request,
      endpoint: "responses",
      runtimeHeaderName: "x-chatgpt-tela-runtime-token",
      fetchUpstream: async () => new Response("unexpected"),
    })).rejects.toThrow("first-party request authorization");
  });
});

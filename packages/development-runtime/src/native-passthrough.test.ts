import { describe, expect, test } from "bun:test";
import { forwardNativeCodexRequest, scrubTelaResponsesArtifacts } from "./native-passthrough";
import { readFileSync } from "node:fs";
import { withDiagnosticContext } from "@chatgpt-tela/core";

describe("Native Codex passthrough", () => {
  test("preserves replayable Native reasoning and chunked successful SSE byte-for-byte", async () => {
    const payload = JSON.stringify({ store: false, input: [
      { type: "reasoning", id: "rs_fixture_native", encrypted_content: "synthetic-encrypted-state", summary: [] },
      { type: "message", role: "user", content: "synthetic next turn" },
    ] }, null, 2);
    const wire = 'event: response.output_item.done\ndata: {"item":{"type":"reasoning","id":"rs_fixture_next","encrypted_content":"synthetic-next-state","summary":[]}}\n\nevent: response.completed\ndata: {"response":{"status":"completed"}}\n\n';
    const encoded = new TextEncoder().encode(wire);
    let offset = 0;
    const response = await forwardNativeCodexRequest({
      request: new Request("http://localhost/v1/responses", { method: "POST", headers: { authorization: "Bearer synthetic" }, body: payload }),
      endpoint: "responses", runtimeHeaderName: "x-tela",
      fetchUpstream: async request => {
        expect(await request.text()).toBe(payload);
        return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
          if (offset === encoded.length) { controller.close(); return; }
          const end = Math.min(offset + 11, encoded.length);
          controller.enqueue(encoded.slice(offset, end)); offset = end;
        } }), { headers: { "content-type": "text/event-stream", "x-request-id": "synthetic-native-request" } });
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-request-id")).toBe("synthetic-native-request");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(encoded);
  });

  test("mixed Tela cleanup keeps Native reasoning including unavailable recovery state unchanged", () => {
    const native = { type: "reasoning", id: "rs_fixture_native", encrypted_content: "synthetic-native-state", summary: [] };
    const incomplete = { type: "reasoning", id: "rs_fixture_incomplete", encrypted_content: null, summary: [] };
    const source = { store: false, input: [native, incomplete,
      { type: "message", id: "msg_tela_abcdefghijklmnopqrstuvwx", role: "assistant", content: [] },
    ] };
    const result = scrubTelaResponsesArtifacts(source);
    expect(result.changed).toBe(true);
    const items = (result.value as typeof source).input;
    expect(items[0]).toBe(native);
    expect(items[1]).toBe(incomplete);
    expect((result.value as typeof source).store).toBe(false);
    expect(items[2]).not.toHaveProperty("id");
  });

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

  test("browser-public summaries cannot request first-party persisted reasoning lookup", () => {
    const native = { type: "reasoning", id: "rs_firstparty", summary: [] };
    const display = { type: "reasoning", id: "rs_tela_abcdefghijklmnopqrstuvwx",
      summary: [{ type: "summary_text", text: "Public progress" }] };
    const source = { input: [native, display] };
    const cleaned = scrubTelaResponsesArtifacts(source);
    expect(cleaned.value).toEqual({ input: [native] });
    expect((cleaned.value as typeof source).input[0]).toBe(native);
    expect(source.input).toEqual([native, display]);
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

test("dispatch evidence correlates exact Native bytes and bounded Tela changes without payloads", async () => {
  const cases = [
    { endpoint: "responses" as const, payload: ' { "input": [{"type":"message","role":"user","content":"private-fixture-text"}] } ', unchanged: true, counts: [0, 0, 0] },
    { endpoint: "responses/compact" as const, payload: '{not-json-private-fixture-text', unchanged: true, counts: undefined },
    { endpoint: "responses" as const, payload: JSON.stringify({ previous_response_id: "resp_tela_abcdefghijklmnopqrstuvwx", input: [
      { type: "reasoning", id: "rs_tela_abcdefghijklmnopqrstuvwx", summary: [{ text: "private-fixture-text" }] },
      { type: "message", id: "msg_tela_abcdefghijklmnopqrstuvwx", content: "private-fixture-text" },
      { type: "reasoning", id: "rs_native_fixture", encrypted_content: "private-fixture-state" },
    ] }), unchanged: false, counts: [1, 1, 1] },
  ];
  for (const [index, fixture] of cases.entries()) {
    const fingerprint = String(index + 1).repeat(24);
    let dispatches = 0, received = "";
    const response = await withDiagnosticContext({ request_fingerprint: fingerprint }, () => forwardNativeCodexRequest({
      request: new Request(`http://localhost/v1/${fixture.endpoint}`, { method: "POST",
        headers: { authorization: "Bearer private-fixture-auth" }, body: fixture.payload }),
      endpoint: fixture.endpoint, runtimeHeaderName: "x-tela",
      fetchUpstream: async request => { dispatches++; received = await request.text(); return new Response("ok"); },
    }));
    expect(await response.text()).toBe("ok");
    expect(dispatches).toBe(1);
    expect(received === fixture.payload).toBe(fixture.unchanged);
    const rows = readFileSync(process.env.CHATGPT_TELA_DIAGNOSTIC_FILE!, "utf8").trim().split("\n")
      .map(line => JSON.parse(line)).filter(row => row.request_fingerprint === fingerprint);
    expect(rows.map(row => row.stage)).toEqual(["native_dispatch_started", "native_dispatch_headers_received"]);
    expect(rows[0]).toMatchObject({ body_unchanged: fixture.unchanged, received_bytes: Buffer.byteLength(fixture.payload),
      forwarded_bytes: Buffer.byteLength(received), dispatch_count: 1, provider_kind: "native", route_kind: fixture.endpoint.replaceAll("/", "_") });
    if (fixture.counts) expect([rows[0].removed_reference_count, rows[0].stripped_item_id_count,
      rows[0].removed_display_item_count]).toEqual(fixture.counts);
    expect(rows[1].status_code).toBe(200);
    expect(JSON.stringify(rows)).not.toContain("private-fixture");
    expect(JSON.stringify(rows)).not.toContain("rs_native_fixture");
  }
});


test("network diagnostics preserve original failure and do not add retries", async () => {
  const failure = new TypeError("fetch failed", { cause: Object.assign(new Error("private host"), { code: "ENOTFOUND" }) });
  let calls = 0;
  const request = new Request("http://127.0.0.1:9000/v1/models", { headers: { authorization: "Bearer fixture" } });
  await expect(forwardNativeCodexRequest({ request, endpoint: "models", runtimeHeaderName: "OpenAI-Organization",
    fetchUpstream: async () => { calls++; throw failure; },
  })).rejects.toBe(failure);
  expect(calls).toBe(1);
});

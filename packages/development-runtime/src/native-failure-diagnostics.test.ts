import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { diagnosticFingerprint, structuralDiagnosticEvent, withDiagnosticContext } from "@chatgpt-tela/core";
import { diagnoseNativeFailure, nativeErrorFields, nativeRequestShape } from "./native-failure-diagnostics";
import { forwardNativeCodexRequest } from "./native-passthrough";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function events() {
  return readFileSync(process.env.CHATGPT_TELA_DIAGNOSTIC_FILE!, "utf8").trim().split("\n")
    .map(line => JSON.parse(line)).filter(row => row.event === "chatgpt_tela_network");
}
const input = { store: false, input: [
  { type: "reasoning", id: "rs_synthetic", encrypted_content: "SYNTHETIC_PRIVATE_ENCRYPTED", summary: "SYNTHETIC_PRIVATE_TEXT" },
  { type: "item_reference", id: "ref_synthetic" },
] };
describe("bounded Native failure evidence", () => {
  test("binds a missing item to request shape without payload or raw identity", async () => {
    const fingerprint = diagnosticFingerprint("synthetic-request-correlation");
    const body = JSON.stringify({ error: { message: "Item with id 'rs_synthetic' not found. Items are not persisted when store is set to false. SYNTHETIC_PRIVATE_ERROR" } });
    let forwarded = "";
    const response = await withDiagnosticContext({ request_fingerprint: fingerprint }, () => forwardNativeCodexRequest({
      request: new Request("http://localhost/v1/responses", { method: "POST", headers: { authorization: "Bearer SYNTHETIC_PRIVATE_AUTH" }, body: JSON.stringify(input) }),
      endpoint: "responses", runtimeHeaderName: "x-tela",
      fetchUpstream: async request => { forwarded = await request.text(); return new Response(body, { status: 404, headers: { "x-request-id": "synthetic-server-id" } }); },
    }));
    // Consume outside the producer context: deferred diagnostics must still correlate.
    expect(response.status).toBe(404);
    expect(response.headers.get("x-request-id")).toBe("synthetic-server-id");
    expect(await response.text()).toBe(body);
    expect(forwarded).toBe(JSON.stringify(input));
    const rows = events().filter(row => row.request_fingerprint === fingerprint);
    expect(rows.filter(row => ["native_backend_http_failed", "native_backend_error_failed"].includes(row.stage))).toHaveLength(2);
    expect(rows.filter(row => row.stage === "native_dispatch_started")).toHaveLength(1);
    expect(rows.filter(row => row.stage === "native_dispatch_headers_received")).toHaveLength(1);
    const row = rows.find(row => row.stage === "native_backend_error_failed")!;
    expect(row.reason_class).toBe("missing_item");
    expect(row.matched_item).toBe(true);
    expect(row.reasoning_encrypted).toBe(true);
    expect(row.policy).toBe("stateless");
    expect(row.item_fingerprint).toBe(diagnosticFingerprint("rs_synthetic"));
    expect(structuralDiagnosticEvent(row)?.reason_class).toBe("missing_item");
    expect(JSON.stringify(rows)).not.toContain("SYNTHETIC_PRIVATE");
    expect(JSON.stringify(rows)).not.toContain("rs_synthetic");
    expect(JSON.stringify(rows)).not.toContain("synthetic-server-id");
  });
  test("separates request inspection coverage from absent encrypted reasoning", () => {
    const shape = nativeRequestShape({ store: false, input: Array.from({ length: 4100 }, (_, i) => ({ type: "reasoning", id: `rs_${i}` })) });
    expect(shape.fields.inspection_complete).toBe(false);
    expect(shape.fields.inspected_count).toBe(4096);
    expect(shape.fields.reasoning_encrypted_count).toBe(0);
    expect(shape.items.size).toBe(4096);
    const fields = nativeErrorFields(encode({ error: { message: "Item with id 'rs_4099' not found" } }), shape);
    expect(fields.matched_item).toBe(false);
    expect(fields.kind).toBe("unknown");
  });
  test("classifies broad error families without exporting server text", () => {
    for (const [code, expected] of [["context_length_exceeded", "context_limit"], ["rate_limit_exceeded", "rate_limit"], ["invalid_api_key", "authentication"], ["permission_denied", "permission"], ["invalid_request_error", "invalid_request"]]) {
      expect(nativeErrorFields(encode({ error: { code, message: "private" } }), nativeRequestShape(undefined)).reason_class).toBe(expected);
    }
    expect(nativeErrorFields(encode("private"), nativeRequestShape(undefined)).parsed_error).toBe(false);
  });
  test("does not consume successful streams", () => {
    const body = new ReadableStream<Uint8Array>({ pull() { throw new Error("must not pull"); } }, { highWaterMark: 0 });
    const response = new Response(body);
    expect(diagnoseNativeFailure(response, nativeRequestShape(input), "responses", 1)).toBe(body);
    expect(body.locked).toBe(false);
  });
  test("caps error inspection while preserving the complete response", async () => {
    const body = "X".repeat(100_000);
    const observed = diagnoseNativeFailure(new Response(body, { status: 500 }), nativeRequestShape(input), "responses", 1);
    expect(await new Response(observed).text()).toBe(body);
    expect(events().at(-1)?.truncated).toBe(true);
    expect(events().at(-1)?.reason_class).toBe("unclassified");
  });
  test("cancellation does not drain upstream and propagates its reason", async () => {
    let pulls = 0; let reason: unknown;
    const body = new ReadableStream<Uint8Array>({ pull() { pulls++; }, cancel(value) { reason = value; } }, { highWaterMark: 0 });
    const observed = diagnoseNativeFailure(new Response(body, { status: 404 }), nativeRequestShape(input), "responses", 1)!;
    expect(pulls).toBe(0);
    await observed.cancel("synthetic cancel");
    expect(reason).toBe("synthetic cancel");
    expect(pulls).toBe(0);
  });
  test("upstream read failure remains the original failure", async () => {
    const failure = new Error("SYNTHETIC_PRIVATE_FAILURE");
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(failure); } }, { highWaterMark: 0 });
    const observed = diagnoseNativeFailure(new Response(body, { status: 500 }), nativeRequestShape(input), "responses", 1)!;
    await expect(new Response(observed).text()).rejects.toBe(failure);
    expect(events().at(-1)?.reason_class).toBe("body_interrupted");
  });
  test("cancelling during a pending read does not report an artificial read failure", async () => {
    const fingerprint = diagnosticFingerprint("synthetic-pending-cancel");
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const observed = withDiagnosticContext({ request_fingerprint: fingerprint }, () =>
      diagnoseNativeFailure(new Response(body, { status: 404 }), nativeRequestShape(input), "responses", 1)!);
    const reader = observed.getReader();
    const pending = reader.read();
    await reader.cancel();
    expect((await pending).done).toBe(true);
    expect(cancelled).toBe(true);
    expect(events().filter(row => row.request_fingerprint === fingerprint).map(row => row.stage)).toEqual([
      "native_backend_http_failed", "native_backend_body_cancelled",
    ]);
  });
});

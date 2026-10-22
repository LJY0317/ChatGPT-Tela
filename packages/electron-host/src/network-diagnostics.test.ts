import { expect, test } from "bun:test";
import { diagnosticFingerprint, observeDiagnosticEvents, withDiagnosticContext, type StructuralDiagnosticEvent } from "@chatgpt-tela/core";
import { retainRendererNetworkDiagnostics } from "./network-diagnostics";

test("shared renderer network observation records provider POST completion and failure boundaries without URLs, credentials or stale Native ownership", () => {
  let failed: ((details: any) => void) | null = null;
  let completed: ((details: any) => void) | null = null;
  let sent: ((details: any) => void) | null = null;
  let response: ((details: any) => void) | null = null;
  let registrations = 0;
  const session = { webRequest: {
    onSendHeaders(listener: any) { sent = listener; if (listener) registrations++; },
    onResponseStarted(listener: any) { response = listener; if (listener) registrations++; },
    onErrorOccurred(listener: any) { failed = listener; if (listener) registrations++; },
    onCompleted(listener: any) { completed = listener; if (listener) registrations++; },
  } };
  const rows: StructuralDiagnosticEvent[] = [];
  const stop = observeDiagnosticEvents(row => rows.push(row));
  const profile = diagnosticFingerprint("test-profile");
  const first = retainRendererNetworkDiagnostics(session as any, { webContentsId: 1,
    origin: { profile_fingerprint: profile, surface_fingerprint: diagnosticFingerprint("first") } });
  const second = retainRendererNetworkDiagnostics(session as any, { webContentsId: 2,
    origin: { profile_fingerprint: profile, surface_fingerprint: diagnosticFingerprint("second"),
      request_fingerprint: diagnosticFingerprint("old-request") } });
  try {
    expect(registrations).toBe(4);
    const request = { id: 9, webContentsId: 2, url: "https://chatgpt.com/backend-api/private-conversation?token=secret",
      method: "POST", resourceType: "xhr", fromCache: false, timestamp: 1000 };
    Object.defineProperties(request, {
      requestHeaders: { get(): never { throw Error("headers must not be read"); } },

    });
    const headers = { "Content-Type": ["text/event-stream; charset=utf-8"] };
    Object.defineProperty(headers, "set-cookie", { enumerable: true, get(): never { throw Error("cookies must not be read"); } });
    sent!(request);
    expect(rows.at(-1)).toMatchObject({ stage: "renderer_request_sent", network_timestamp_ms: 1000 });
    response!({ ...request, timestamp: 1200, statusCode: 200, responseHeaders: headers });
    expect(rows.at(-1)).toMatchObject({ stage: "renderer_response_started", browser_response: "event_stream", request_role: "stream_candidate", http_status: 200, network_timestamp_ms: 1200 });
    const responseRequest = rows.at(-1)!.network_request_fingerprint;
    withDiagnosticContext({ request_fingerprint: diagnosticFingerprint("unrelated-request") }, () => {
      failed!({ ...request, error: "net::ERR_CONNECTION_RESET" });
    });
    expect(rows.at(-1)).toMatchObject({ stage: "renderer_request_failed", domain_class: "chatgpt",
      route_class: "provider_api", route_fingerprint: diagnosticFingerprint("/backend-api/private-conversation"), failure_class: "err_connection_reset", surface_correlated: true,
      surface_fingerprint: diagnosticFingerprint("second") });
    expect(rows.at(-1)).not.toHaveProperty("request_fingerprint");
    expect(rows.at(-1)!.network_request_fingerprint).toBe(responseRequest);
    completed!({ ...request, statusCode: 429 });
    expect(rows.at(-1)).toMatchObject({ stage: "renderer_http_failed", http_status: 429, request_role: "unresolved_post" });
    completed!({ ...request, statusCode: 503 });
    expect(rows.at(-1)).toMatchObject({ http_status: 503 });
    const route = rows.at(-1)!.route_fingerprint;
    completed!({ ...request, url: "https://chatgpt.com/backend-api/private-conversation?token=different-secret", statusCode: 429 });
    expect(rows.at(-1)!.route_fingerprint).toBe(route);
    completed!({ ...request, url: "https://chatgpt.com/backend-api/other-request", statusCode: 429 });
    expect(rows.at(-1)!.route_fingerprint).not.toBe(route);
    const count = rows.length;
    completed!({ ...request, statusCode: 200 });
    expect(rows.at(-1)).toMatchObject({ stage: "renderer_api_request_completed", http_status: 200,
      method_class: "post", surface_fingerprint: diagnosticFingerprint("second") });
    expect(rows.at(-1)).not.toHaveProperty("request_fingerprint");
    completed!({ ...request, method: "GET", statusCode: 200 });
    completed!({ ...request, url: "https://chatgpt.com/static-resource", statusCode: 200 });
    completed!({ ...request, webContentsId: 99, statusCode: 200 });
    failed!({ ...request, resourceType: "image", error: "net::ERR_ABORTED" });
    expect(rows).toHaveLength(count + 1);
    const text = JSON.stringify(rows);
    for (const value of ["secret", "private-conversation", "chatgpt.com", "old-request", "unrelated-request"])
      expect(text).not.toContain(value);
    first();
    expect(failed).not.toBeNull();
    second();
    expect(failed).toBeNull();
    expect(completed).toBeNull();
    expect(sent).toBeNull();
    expect(response).toBeNull();
  } finally { first(); second(); stop?.(); }
});

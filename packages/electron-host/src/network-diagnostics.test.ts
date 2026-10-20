import { expect, test } from "bun:test";
import { diagnosticFingerprint, observeDiagnosticEvents, withDiagnosticContext, type StructuralDiagnosticEvent } from "@chatgpt-tela/core";
import { retainRendererNetworkDiagnostics } from "./network-diagnostics";

test("shared renderer network observation records failure boundaries without URLs, credentials or stale Native ownership", () => {
  let failed: ((details: any) => void) | null = null;
  let completed: ((details: any) => void) | null = null;
  let registrations = 0;
  const session = { webRequest: {
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
    expect(registrations).toBe(2);
    const request = { id: 9, webContentsId: 2, url: "https://chatgpt.com/backend-api/private-conversation?token=secret",
      method: "POST", resourceType: "xhr", fromCache: false };
    Object.defineProperties(request, {
      requestHeaders: { get(): never { throw Error("headers must not be read"); } },
      responseHeaders: { get(): never { throw Error("headers must not be read"); } },
    });
    withDiagnosticContext({ request_fingerprint: diagnosticFingerprint("unrelated-request") }, () => {
      failed!({ ...request, error: "net::ERR_CONNECTION_RESET" });
    });
    expect(rows.at(-1)).toMatchObject({ stage: "renderer_request_failed", domain_class: "chatgpt",
      route_class: "provider_api", failure_class: "err_connection_reset", surface_correlated: true,
      surface_fingerprint: diagnosticFingerprint("second") });
    expect(rows.at(-1)).not.toHaveProperty("request_fingerprint");
    completed!({ ...request, statusCode: 429 });
    expect(rows.at(-1)).toMatchObject({ stage: "renderer_http_failed", http_status: 429 });
    completed!({ ...request, statusCode: 503 });
    expect(rows.at(-1)).toMatchObject({ http_status: 503 });
    const count = rows.length;
    completed!({ ...request, statusCode: 200 });
    failed!({ ...request, resourceType: "image", error: "net::ERR_ABORTED" });
    expect(rows).toHaveLength(count);
    const text = JSON.stringify(rows);
    for (const value of ["secret", "private-conversation", "chatgpt.com", "old-request", "unrelated-request"])
      expect(text).not.toContain(value);
    first();
    expect(failed).not.toBeNull();
    second();
    expect(failed).toBeNull();
    expect(completed).toBeNull();
  } finally { first(); second(); stop?.(); }
});

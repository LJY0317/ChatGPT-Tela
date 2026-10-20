import type { OnCompletedListenerDetails, OnErrorOccurredListenerDetails, WebRequest } from "electron";
import { diagnosticContext, diagnosticFingerprint, emitDiagnosticEvent, withDiagnosticContext } from "@chatgpt-tela/core";

type Origin = ReturnType<typeof diagnosticContext>;
type Owner = { readonly webContentsId: number | undefined; readonly origin: Origin };
type Observation = OnCompletedListenerDetails | OnErrorOccurredListenerDetails;
type RequestEvents = Pick<WebRequest, "onCompleted" | "onErrorOccurred">;
// Electron permits one listener per webRequest event. Share it across the owned
// partition's surfaces, and detach when its last lease is released.
const sessions = new WeakMap<RequestEvents, { readonly owners: Map<symbol, Owner> }>();

export function retainRendererNetworkDiagnostics(
  session: { readonly webRequest?: RequestEvents } | undefined,
  owner: Owner,
): () => void {
  const request = session?.webRequest;
  if (!request) return () => {};
  let current = sessions.get(request);
  const first = !current;
  if (!current) { current = { owners: new Map() }; sessions.set(request, current); }
  const entry = current;
  const key = Symbol();
  entry.owners.set(key, owner);
  const observe = (details: Observation) => {
    try {
      if (details.resourceType !== "xhr" && details.resourceType !== "webSocket") return;
      const httpStatus = "statusCode" in details ? details.statusCode : undefined;
      if (httpStatus !== undefined && httpStatus < 400) return;
      const url = new URL(details.url);
      const originClass = url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com") ? "chatgpt"
        : url.hostname === "openai.com" || url.hostname.endsWith(".openai.com") ? "openai" : "other";
      const target = details.webContentsId === undefined ? undefined : [...entry.owners.values()]
        .find(item => item.webContentsId === details.webContentsId);
      const context = target?.origin ?? owner.origin;
      // A persistent surface can outlive its creating Native turn. Correlate the
      // renderer and time, never attribute later requests to that original turn.
      const rendererContext = Object.fromEntries(Object.entries(context).filter(([key]) =>
        ["profile_fingerprint", "partition_fingerprint", "storage_fingerprint"].includes(key)
        || (key === "surface_fingerprint" && !!target)));
      withDiagnosticContext(rendererContext, () => {
        emitDiagnosticEvent("chatgpt_tela_browser", httpStatus === undefined ? "renderer_request_failed" : "renderer_http_failed", {
          network_request_fingerprint: diagnosticFingerprint(JSON.stringify([details.webContentsId ?? null, details.id])),
          domain_class: originClass, origin_fingerprint: diagnosticFingerprint(url.origin),
          route_fingerprint: diagnosticFingerprint(url.pathname),
          route_class: originClass !== "other" && /^\/(?:backend-api|api|public-api)(?:\/|$)/.test(url.pathname) ? "provider_api" : "other",
          resource_class: details.resourceType.toLowerCase(),
          method_class: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(details.method) ? details.method.toLowerCase() : "other",
          surface_correlated: !!target,
          ...(httpStatus === undefined ? { failure_class: /^net::ERR_[A-Z0-9_]+$/.test(details.error) ? details.error.slice(5).toLowerCase() : "unclassified" }
            : { http_status: httpStatus, from_cache: details.fromCache }),
        });
      }, false);
    } catch { /* Passive diagnostics cannot change a browser request or its outcome. */ }
  };
  if (first) {
    try {
      request.onErrorOccurred(observe);
      request.onCompleted(observe);
    } catch {
      entry.owners.delete(key); sessions.delete(request);
      try { request.onErrorOccurred(null); request.onCompleted(null); } catch { /* Diagnostic teardown only. */ }
      return () => {};
    }
  }
  return () => {
    if (!entry.owners.delete(key) || entry.owners.size) return;
    sessions.delete(request);
    try { request.onErrorOccurred(null); request.onCompleted(null); } catch { /* Diagnostic teardown only. */ }
  };
}

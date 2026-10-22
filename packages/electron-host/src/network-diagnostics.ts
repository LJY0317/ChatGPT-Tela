import type { OnCompletedListenerDetails, OnErrorOccurredListenerDetails, OnSendHeadersListenerDetails, OnResponseStartedListenerDetails, WebRequest } from "electron";
import { diagnosticContext, diagnosticFingerprint, emitDiagnosticEvent, withDiagnosticContext } from "@chatgpt-tela/core";

type Origin = ReturnType<typeof diagnosticContext>;
type Owner = { readonly webContentsId: number | undefined; readonly origin: Origin };
type Observation = OnCompletedListenerDetails | OnErrorOccurredListenerDetails | OnSendHeadersListenerDetails | OnResponseStartedListenerDetails;
type RequestEvents = Pick<WebRequest, "onCompleted" | "onErrorOccurred" | "onSendHeaders" | "onResponseStarted">;
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
  const observe = (phase: "sent" | "response" | "settled", details: Observation) => {
    try {
      if (details.resourceType !== "xhr" && details.resourceType !== "webSocket") return;
      const httpStatus = "statusCode" in details ? details.statusCode : undefined;
      if (phase === "settled" && httpStatus !== undefined && httpStatus < 400 && details.method !== "POST") return;
      const url = new URL(details.url);
      const originClass = url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com") ? "chatgpt"
        : url.hostname === "openai.com" || url.hostname.endsWith(".openai.com") ? "openai" : "other";
      const target = details.webContentsId === undefined ? undefined : [...entry.owners.values()]
        .find(item => item.webContentsId === details.webContentsId);
      const providerApi = originClass !== "other" && /^\/(?:backend-api|api|public-api)(?:\/|$)/.test(url.pathname);
      const completedProviderPost = httpStatus !== undefined && httpStatus < 400;
      // A provider POST may finish at HTTP level while the page later reports
      // delivery failure. Observe that boundary without reading headers/body or
      // claiming that a model response or its event stream completed correctly.
      if ((phase !== "settled" || completedProviderPost) && (!target || !providerApi)) return;
      // Standard response metadata distinguishes a stream from unrelated API traffic.
      // Never read request headers, bodies, cookies, or other response header values.
      const headers = "responseHeaders" in details ? details.responseHeaders : undefined;
      const mimeKey = headers && Object.keys(headers).find(key => key.toLowerCase() === "content-type");
      const mime = mimeKey ? headers![mimeKey]?.[0]?.split(";", 1)[0]?.trim().toLowerCase() : undefined;
      const responseClass = mime === "text/event-stream" ? "event_stream"
        : mime === "application/json" || mime?.endsWith("+json") ? "json" : mime ? "other" : "unknown";
      // This is an observed transport role, not a claim about provider semantics.
      const requestRole = details.method === "POST" && responseClass === "event_stream" ? "stream_candidate"
        : details.method !== "POST" ? "auxiliary_candidate" : "unresolved_post";
      const context = target?.origin ?? owner.origin;
      // A persistent surface can outlive its creating Native turn. Correlate the
      // renderer and time, never attribute later requests to that original turn.
      const rendererContext = Object.fromEntries(Object.entries(context).filter(([key]) =>
        ["profile_fingerprint", "partition_fingerprint", "storage_fingerprint"].includes(key)
        || (key === "surface_fingerprint" && !!target)));
      withDiagnosticContext(rendererContext, () => {
        emitDiagnosticEvent("chatgpt_tela_browser", phase === "sent" ? "renderer_request_sent" : phase === "response" ? "renderer_response_started"
          : httpStatus === undefined ? "renderer_request_failed" : completedProviderPost ? "renderer_api_request_completed" : "renderer_http_failed", {
          network_request_fingerprint: diagnosticFingerprint(JSON.stringify([details.webContentsId ?? null, details.id])),
          domain_class: originClass, origin_fingerprint: diagnosticFingerprint(url.origin),
          route_fingerprint: diagnosticFingerprint(url.pathname),
          route_class: providerApi ? "provider_api" : "other",
          resource_class: details.resourceType.toLowerCase(),
          method_class: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(details.method) ? details.method.toLowerCase() : "other",
          surface_correlated: !!target,
          browser_response: responseClass,
          request_role: requestRole,
          network_timestamp_ms: Math.round(details.timestamp),
          ...("error" in details ? { failure_class: /^net::ERR_[A-Z0-9_]+$/.test(details.error) ? details.error.slice(5).toLowerCase() : "unclassified" } : {}),
          ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
          ...("fromCache" in details ? { from_cache: details.fromCache } : {}),
        });
      }, false);
    } catch { /* Passive diagnostics cannot change a browser request or its outcome. */ }
  };
  if (first) {
    try {
      request.onSendHeaders(details => observe("sent", details));
      request.onResponseStarted(details => observe("response", details));
      request.onErrorOccurred(details => observe("settled", details));
      request.onCompleted(details => observe("settled", details));
    } catch {
      entry.owners.delete(key); sessions.delete(request);
      try { request.onSendHeaders(null); request.onResponseStarted(null); request.onErrorOccurred(null); request.onCompleted(null); } catch { /* Diagnostic teardown only. */ }
      return () => {};
    }
  }
  return () => {
    if (!entry.owners.delete(key) || entry.owners.size) return;
    sessions.delete(request);
    try { request.onSendHeaders(null); request.onResponseStarted(null); request.onErrorOccurred(null); request.onCompleted(null); } catch { /* Diagnostic teardown only. */ }
  };
}

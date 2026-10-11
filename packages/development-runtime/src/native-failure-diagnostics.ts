import {
  diagnosticContext, diagnosticFingerprint, emitDiagnosticEvent, withDiagnosticContext,
  type DiagnosticScalar,
} from "@chatgpt-tela/core";

const MAX_ITEMS = 4096;
const MAX_ERROR_BYTES = 16 * 1024;
type Fields = Record<string, DiagnosticScalar>;
type Item = { kind: string; encrypted: boolean };
export type NativeRequestShape = { fields: Fields; items: Map<string, Item> };
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const opaqueId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x20]/.test(value);
function itemKind(value: unknown): string {
  return typeof value === "string" && ["reasoning", "message", "item_reference", "function_call", "function_call_output", "compaction"].includes(value)
    ? value === "function_call_output" ? "call_result" : value : "unknown";
}

/** Retain only bounded identities and shape, never semantic item bodies. */
export function nativeRequestShape(value: unknown): NativeRequestShape {
  const root = object(value);
  const fields: Fields = { parsed: !!root };
  const items = new Map<string, Item>();
  if (!root) return { fields, items };
  fields.policy = root.store === false ? "stateless" : root.store === true ? "stored" : "unspecified";
  fields.previous_reference = typeof root.previous_response_id === "string";
  const input = Array.isArray(root.input) ? root.input : [];
  fields.item_count = input.length;
  fields.inspected_count = Math.min(input.length, MAX_ITEMS);
  fields.inspection_complete = input.length <= MAX_ITEMS;
  fields.reasoning_count = 0;
  fields.reasoning_identified_count = 0;
  fields.reasoning_encrypted_count = 0;
  fields.reference_count = 0;
  fields.call_count = 0;
  fields.call_result_count = 0;
  fields.compaction_count = 0;
  for (let i = 0; i < Math.min(input.length, MAX_ITEMS); i++) {
    const item = object(input[i]);
    if (!item) continue;
    const kind = itemKind(item.type);
    const encrypted = typeof item.encrypted_content === "string" && item.encrypted_content.length > 0;
    if (kind === "reasoning") {
      fields.reasoning_count = Number(fields.reasoning_count) + 1;
      if (opaqueId(item.id)) fields.reasoning_identified_count = Number(fields.reasoning_identified_count) + 1;
      if (encrypted) fields.reasoning_encrypted_count = Number(fields.reasoning_encrypted_count) + 1;
    }
    const counter = ({ item_reference: "reference_count", function_call: "call_count", call_result: "call_result_count", compaction: "compaction_count" } as Record<string, string>)[kind];
    if (counter) fields[counter] = Number(fields[counter]) + 1;
    if (opaqueId(item.id)) items.set(item.id, { kind, encrypted });
  }
  return { fields, items };
}

export function nativeErrorFields(bytes: Uint8Array, shape: NativeRequestShape): Fields {
  let envelope: unknown;
  try { envelope = JSON.parse(new TextDecoder().decode(bytes)); } catch { return { reason_class: "unclassified", parsed_error: false }; }
  const error = object(object(envelope)?.error);
  if (!error) return { reason_class: "unclassified", parsed_error: false };
  const message = typeof error.message === "string" ? error.message : "";
  const missing = /Item with id ['"]([^'"\r\n]+)['"] not found/i.exec(message)?.[1];
  const fields: Fields = { parsed_error: true, reason_class: "unclassified" };
  if (missing && opaqueId(missing)) {
    const item = shape.items.get(missing);
    Object.assign(fields, {
      reason_class: "missing_item", item_fingerprint: diagnosticFingerprint(missing),
      matched_item: !!item, kind: item?.kind ?? "unknown", reasoning_encrypted: item?.encrypted ?? false,
      stateless_hint: /store.*false|not persisted/i.test(message),
    });
  } else {
    // External error strings stay inside this adapter; only fixed classes leave it.
    const code = `${typeof error.code === "string" ? error.code : ""} ${typeof error.type === "string" ? error.type : ""}`;
    fields.reason_class = /context_length|context_window/i.test(code) ? "context_limit"
      : /rate_limit|quota/i.test(code) ? "rate_limit"
      : /authentication|invalid_api_key/i.test(code) ? "authentication"
      : /permission/i.test(code) ? "permission"
      : /invalid_request/i.test(code) ? "invalid_request" : "unclassified";
  }
  return fields;
}

/** Observe only bytes consumed by the caller. No tee, eager drain, retry or timer. */
export function diagnoseNativeFailure(upstream: Response, shape: NativeRequestShape, route: string, durationMs: number): ReadableStream<Uint8Array> | null {
  if (upstream.status < 400) return upstream.body;
  const context = diagnosticContext();
  const base: Fields = { ...shape.fields, route_kind: route.replaceAll("/", "_"), status_code: upstream.status, duration_ms: durationMs };
  const serverId = upstream.headers.get("x-request-id");
  if (opaqueId(serverId)) base.upstream_fingerprint = diagnosticFingerprint(serverId);
  const emit = (stage: string, fields: Fields) => {
    try { withDiagnosticContext(context, () =>
      emitDiagnosticEvent("chatgpt_tela_network", stage, { ...base, ...fields })); }
    catch { /* Evidence must never replace a transport result. */ }
  };
  emit("native_backend_http_failed", {});
  if (!upstream.body) { emit("native_backend_error_failed", { reason_class: "empty_body" }); return null; }
  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  let truncated = false;
  let cancelled = false;
  const release = () => { chunks.length = 0; shape.items.clear(); };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (cancelled) return;
        if (next.done) {
          const bytes = new Uint8Array(count);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          emit("native_backend_error_failed", truncated
            ? { reason_class: "unclassified", truncated: true }
            : { ...nativeErrorFields(bytes, shape), truncated: false });
          release(); reader.releaseLock(); controller.close();
        } else {
          if (!truncated && count + next.value.byteLength <= MAX_ERROR_BYTES) {
            chunks.push(next.value.slice()); count += next.value.byteLength;
          } else { truncated = true; chunks.length = 0; count = 0; }
          controller.enqueue(next.value);
        }
      } catch (error) {
        if (cancelled) return;
        emit("native_backend_body_failed", { reason_class: "body_interrupted" });
        release(); reader.releaseLock(); controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      emit("native_backend_body_cancelled", { reason_class: "consumer_cancelled" });
      release();
      try { await reader.cancel(reason); } finally { reader.releaseLock(); }
    },
  }, { highWaterMark: 0 });
}

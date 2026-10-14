import {
  configuredDiagnosticRoot, diagnosticContext, diagnosticFingerprint, emitDiagnosticEvent,
  privateDiagnosticCaptureEnabled, withDiagnosticContext, type DiagnosticScalar,
} from "@chatgpt-tela/core";
import { nativeProviderErrorFields, nativeResponseEvidence, type NativeRequestShape } from "./native-failure-diagnostics";

const LIMIT = Object.freeze({ bytes: 1024 * 1024, frame: 64 * 1024, events: 128, items: 256, replay: 16, age: 10 * 60000, duration: 60000 });
type Fields = Record<string, DiagnosticScalar>;
type Seen = { at: number; added: boolean; initialEncrypted: boolean; done: boolean; finalEncrypted: boolean; outcome: string; complete: boolean };
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x20]/.test(value);

/** Process-local observation, not history authority. No payloads or raw identities survive parsing. */
export class NativeReasoningObservation {
  private readonly seen = new Map<string, Seen>();
  private generation = 0;
  constructor(private readonly now: () => number = Date.now) {}
  clear() { this.generation++; this.seen.clear(); }
  observe(upstream: Response, shape: NativeRequestShape, emit: (stage: string, fields: Fields) => void, reasoning = true): ReadableStream<Uint8Array> | null {
    const publish = (stage: string, fields: Fields) => { try { emit(stage, fields); } catch { /* Best effort. */ } };
    const generation = this.generation;
    for (const [key, value] of this.seen) if (this.now() - value.at >= LIMIT.age) this.seen.delete(key);
    let replayed = 0;
    for (const [id, item] of reasoning ? shape.items : []) {
      if (item.kind !== "reasoning" || this.seen.size === 0) continue;
      const key = diagnosticFingerprint(id), previous = this.seen.get(key);
      if (!previous) continue;
      if (replayed++ >= LIMIT.replay) break;
      publish("native_reasoning_replayed", { item_fingerprint: key, first_seen: previous.added,
        initial_encrypted: previous.initialEncrypted, final_seen: previous.done, final_encrypted: previous.finalEncrypted,
        reasoning_encrypted: item.encrypted, outcome: previous.outcome, inspection_complete: previous.complete });
    }
    if (!upstream.body || upstream.status >= 400 || !/^text\/event-stream(?:;|$)/i.test(upstream.headers.get("content-type") ?? "")) return upstream.body;
    const reader = upstream.body.getReader(), decoder = new TextDecoder();
    const touched = new Map<string, Seen>();
    let buffer = "", data: string[] = [], dataSize = 0, bytes = 0, events = 0;
    let reasoningActive = reasoning;
    let droppingFrame = false, droppingLine = false, failurePublished = false;
    const base = { ...nativeResponseEvidence(upstream), phase: "sse", route_kind: "responses" };
    let complete = true, outcome = "no_terminal_event", cancelled = false, finished = false;
    const started = this.now();
    const stop = () => { complete = false; reasoningActive = false; };
    const frame = () => {
      if (droppingFrame) { droppingFrame = false; data = []; dataSize = 0; return; }
      if (!data.length) return;
      events = Math.min(Number.MAX_SAFE_INTEGER, events + 1);
      if (reasoningActive && events > LIMIT.events) stop();
      const text = data.join("\n"); data = []; dataSize = 0;
      if (text === "[DONE]") return;
      let event: Record<string, unknown> | undefined;
      try { event = object(JSON.parse(text)); } catch { if (reasoning) stop(); else complete = false; return; }
      if (!event) { if (reasoning) stop(); else complete = false; return; }
      // External event schema is isolated here; unknown events carry no observation claim.
      if (event.type === "response.completed") outcome = "completed";
      else if (event.type === "response.failed" || event.type === "error") outcome = "failed";
      else if (event.type === "response.incomplete") outcome = "incomplete";
      if (!failurePublished && ["response.failed", "error", "response.incomplete"].includes(String(event.type))) {
        failurePublished = true;
        const response = object(event.response);
        publish("native_backend_stream_failed", { ...base,
          ...nativeProviderErrorFields(event.error ?? response?.error ?? object(response?.incomplete_details) ?? (event.type === "error" ? event : undefined), shape),
          outcome, duration_ms: Math.max(0, this.now() - started), inspection_complete: complete });
      }
      if (!reasoningActive) return;
      if (event.type !== "response.output_item.added" && event.type !== "response.output_item.done") return;
      const item = object(event.item);
      if (item?.type !== "reasoning" || !identity(item.id)) return;
      const key = diagnosticFingerprint(item.id);
      let seen = touched.get(key);
      if (!seen) {
        if (touched.size >= LIMIT.items) { stop(); return; }
        seen = { at: this.now(), added: false, initialEncrypted: false, done: false, finalEncrypted: false, outcome: "pending", complete: false };
        touched.set(key, seen);
      }
      const encrypted = typeof item.encrypted_content === "string" && item.encrypted_content.length > 0;
      if (event.type === "response.output_item.added") { seen.added = true; seen.initialEncrypted ||= encrypted; }
      else { seen.done = true; seen.finalEncrypted ||= encrypted; }
      publish("native_reasoning_observed", { item_fingerprint: key, phase: event.type.endsWith(".added") ? "added" : "done", reasoning_encrypted: encrypted });
    };
    const inspect = (chunk: Uint8Array) => {
      if (failurePublished && !reasoningActive) return;
      if (reasoningActive && (bytes + chunk.byteLength > LIMIT.bytes || this.now() - started >= LIMIT.duration)) stop();
      bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + chunk.byteLength);
      // Slice before decoding so even a single unusually large chunk has bounded temporary text.
      for (let offset = 0; offset < chunk.byteLength; offset += 4096) {
        buffer += decoder.decode(chunk.subarray(offset, offset + 4096), { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
          if (droppingLine) { droppingLine = false; continue; }
          if (!line) frame();
          else if (!droppingFrame && line.startsWith("data:")) {
            const value = line.slice(5).replace(/^ /, ""); dataSize += value.length + 1;
            if (dataSize > LIMIT.frame) {
              stop(); droppingFrame = true; data = []; dataSize = 0;
            } else data.push(value);
          }
        }
        if (buffer.length + dataSize > LIMIT.frame) {
          stop(); droppingFrame = true; droppingLine = buffer.length > 0; buffer = ""; data = []; dataSize = 0;
        }
      }
    };
    const finish = (transport: string) => {
      if (finished) return; finished = true;
      if (buffer.length || data.length) complete = false;
      for (const [key, value] of touched) {
        value.outcome = transport === "eof" ? outcome : transport;
        value.complete = complete; value.at = this.now();
        if (generation === this.generation) {
          this.seen.delete(key); this.seen.set(key, value);
          while (this.seen.size > LIMIT.items) this.seen.delete(this.seen.keys().next().value!);
        }
      }
      if (!reasoning && !failurePublished && (transport !== "eof" || outcome !== "completed" || !complete)) {
        publish("native_backend_stream_anomaly", { ...base,
          outcome: transport === "eof" ? outcome : transport, inspection_complete: complete,
          duration_ms: Math.max(0, this.now() - started) });
      }
      if (reasoning) publish("native_reasoning_stream_observed", { outcome: transport === "eof" ? outcome : transport,
        inspection_complete: complete, inspected_bytes: bytes, inspected_count: events, reasoning_count: touched.size });
      buffer = ""; data = []; touched.clear();
    };
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (cancelled) return;
          if (next.done) { finish("eof"); reader.releaseLock(); controller.close(); }
          else { try { inspect(next.value); } catch { stop(); } controller.enqueue(next.value); }
        } catch (error) {
          if (cancelled) return;
          finish("body_interrupted"); reader.releaseLock(); controller.error(error);
        }
      },
      async cancel(reason) {
        cancelled = true; finish("consumer_cancelled");
        try { await reader.cancel(reason); } finally { reader.releaseLock(); }
      },
    }, { highWaterMark: 0 });
  }
}

const observation = new NativeReasoningObservation();
/** Failure evidence is on-demand and content-free; reasoning replay remains opt-in. */
export function observeNativeResponse(upstream: Response, shape: NativeRequestShape): ReadableStream<Uint8Array> | null {
  const root = configuredDiagnosticRoot();
  if (!root) { observation.clear(); return upstream.body; }
  const reasoning = privateDiagnosticCaptureEnabled(root);
  if (!reasoning) observation.clear();
  const context = diagnosticContext();
  return observation.observe(upstream, shape, (stage, fields) =>
    withDiagnosticContext(context, () => emitDiagnosticEvent("chatgpt_tela_network", stage, fields)), reasoning);
}

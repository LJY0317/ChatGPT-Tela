import {
  configuredDiagnosticRoot, diagnosticContext, diagnosticFingerprint, emitDiagnosticEvent,
  privateDiagnosticCaptureEnabled, withDiagnosticContext, type DiagnosticScalar,
} from "@chatgpt-tela/core";
import type { NativeRequestShape } from "./native-failure-diagnostics";

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
  observe(upstream: Response, shape: NativeRequestShape, emit: (stage: string, fields: Fields) => void): ReadableStream<Uint8Array> | null {
    const publish = (stage: string, fields: Fields) => { try { emit(stage, fields); } catch { /* Best effort. */ } };
    const generation = this.generation;
    for (const [key, value] of this.seen) if (this.now() - value.at >= LIMIT.age) this.seen.delete(key);
    let replayed = 0;
    for (const [id, item] of shape.items) {
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
    let complete = true, outcome = "no_terminal_event", cancelled = false, finished = false;
    const started = this.now();
    const stop = () => { complete = false; buffer = ""; data = []; dataSize = 0; };
    const frame = () => {
      if (!data.length) return;
      if (++events > LIMIT.events) { stop(); return; }
      const text = data.join("\n"); data = []; dataSize = 0;
      if (text === "[DONE]") return;
      let event: Record<string, unknown> | undefined;
      try { event = object(JSON.parse(text)); } catch { stop(); return; }
      if (!event) { stop(); return; }
      // External event schema is isolated here; unknown events carry no observation claim.
      if (event.type === "response.completed") outcome = "completed";
      else if (event.type === "response.failed" || event.type === "error") outcome = "failed";
      else if (event.type === "response.incomplete") outcome = "incomplete";
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
      if (!complete) return;
      if (bytes + chunk.byteLength > LIMIT.bytes || this.now() - started >= LIMIT.duration) { stop(); return; }
      bytes += chunk.byteLength;
      // Slice before decoding so even a single unusually large chunk has bounded temporary text.
      for (let offset = 0; offset < chunk.byteLength && complete; offset += 4096) {
        buffer += decoder.decode(chunk.subarray(offset, offset + 4096), { stream: true });
        let newline: number;
        while (complete && (newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
          if (!line) frame();
          else if (line.startsWith("data:")) {
            const value = line.slice(5).replace(/^ /, ""); dataSize += value.length;
            if (dataSize > LIMIT.frame) stop(); else data.push(value);
          }
        }
        if (buffer.length + dataSize > LIMIT.frame) stop();
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
      publish("native_reasoning_stream_observed", { outcome: transport === "eof" ? outcome : transport,
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
/** Existing expiring opt-in policy gates successful-stream work. Default keeps the original body. */
export function observeNativeReasoning(upstream: Response, shape: NativeRequestShape): ReadableStream<Uint8Array> | null {
  const root = configuredDiagnosticRoot();
  if (!root || !privateDiagnosticCaptureEnabled(root)) { observation.clear(); return upstream.body; }
  const context = diagnosticContext();
  return observation.observe(upstream, shape, (stage, fields) =>
    withDiagnosticContext(context, () => emitDiagnosticEvent("chatgpt_tela_network", stage, fields)));
}

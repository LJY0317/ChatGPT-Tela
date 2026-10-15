import { randomBytes } from "node:crypto";
import type { NativeGatewayOutcome, NativeResponsesGateway } from "@chatgpt-tela/runtime";
import { encodeNativeResponsesOutcome, nativeResponsesSsePlan } from "./protocol";
import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import { nativeHistoryRecovery } from "./native-history-recovery";
import { nativeProjectionRecovery } from "./native-projection-recovery";

/** A request-local, bounded presentation stream. Only pulled outcome frames commit execution. */
export class NativeProgressStream {
  readonly signal = new AbortController();
  readonly firstProgress: Promise<void>;
  readonly #ready: () => void;
  readonly #responseId = `resp_tela_${randomBytes(18).toString("base64url")}`;
  readonly #itemId = `rs_tela_${randomBytes(18).toString("base64url")}`;
  readonly #frames: Array<{ text: string; commit?: () => void }> = [];
  readonly #summaries: string[] = [];
  #chars = 0;
  #sequence = 0;
  #started = false;
  #ended = false;
  #wake: (() => void) | undefined;

  constructor(readonly model: string, readonly createdAt: number) {
    let ready!: () => void;
    this.firstProgress = new Promise<void>(resolve => { ready = resolve; });
    this.#ready = ready;
  }

  #event(name: string, fields: Record<string, unknown>): void {
    if (this.signal.signal.aborted) return;
    this.#frames.push({ text: `event: ${name}\ndata: ${JSON.stringify({ type: name,
      sequence_number: this.#sequence++, ...fields })}\n\n` });
    this.#wake?.();
  }

  #envelope(status: string, output: unknown[] = [], error?: unknown) {
    return { id: this.#responseId, object: "response", created_at: this.createdAt,
      status, model: this.model, output, usage: null, ...(error ? { error } : {}) };
  }

  progress = (summary: string): boolean => {
    if (this.#ended || this.signal.signal.aborted || !summary.trim() || summary.length > 16384
      || this.#chars + summary.length > 65536) return false;
    this.#chars += summary.length;
    if (!this.#started) {
      this.#started = true;
      this.#event("response.created", { response: this.#envelope("in_progress") });
      this.#event("response.output_item.added", { output_index: 0,
        item: { type: "reasoning", id: this.#itemId, summary: [] } });
    }
    const index = this.#summaries.length;
    this.#summaries.push(summary);
    const identity = { item_id: this.#itemId, output_index: 0, summary_index: index };
    this.#event("response.reasoning_summary_part.added", { ...identity, part: { type: "summary_text", text: "" } });
    this.#event("response.reasoning_summary_text.delta", { ...identity, delta: summary });
    this.#event("response.reasoning_summary_text.done", { ...identity, text: summary });
    this.#event("response.reasoning_summary_part.done", { ...identity, part: { type: "summary_text", text: summary } });
    this.#ready();
    return true;
  };

  finish(outcome: NativeGatewayOutcome, gateway: NativeResponsesGateway): void {
    if (this.#ended || this.signal.signal.aborted) return;
    const reasoning = { type: "reasoning", id: this.#itemId,
      summary: this.#summaries.map(text => ({ type: "summary_text", text })) };
    this.#event("response.output_item.done", { output_index: 0, item: reasoning });
    const encoded = encodeNativeResponsesOutcome({ outcome, model: this.model, createdAt: this.createdAt,
      responseId: this.#responseId, precedingOutput: [reasoning] });
    const plan = nativeResponsesSsePlan(outcome, encoded, { sequenceStart: this.#sequence, includeCreated: false });
    plan.frames.forEach((text, index) => this.#frames.push({ text,
      ...(index === plan.commitAfterFrame ? { commit: () => gateway.commit(outcome) } : {}) }));
    this.#ended = true;
    this.#wake?.();
  }

  fail(error: unknown): void {
    if (this.#ended || this.signal.signal.aborted) return;
    const projectionRecovery = nativeProjectionRecovery(error);
    const recovery = projectionRecovery ?? nativeHistoryRecovery(error);
    if (recovery) {
      // HTTP status is already committed as 200 once an SSE progress frame
      // leaves. Preserve typed nonretryable recovery in response.failed.
      // The exception itself may contain private Native history or tool text.
      emitDiagnosticEvent("chatgpt_tela_work", "native_context_recovery_streamed", {
        reason_class: projectionRecovery ? "request_projection_unsupported" : recovery.recovery.kind === "continue_on_native"
          ? "history_mode_unindexed" : "history_bootstrap_required",
        transport_phase: "sse_after_progress",
      });
    }
    this.#event("response.failed", { response: this.#envelope("failed", [], {
      ...(recovery ?? {
        code: "chatgpt_tela_runtime_error",
        message: error instanceof Error ? error.message : String(error),
      }),
    }) });
    this.#frames.push({ text: "data: [DONE]\n\n" });
    this.#ended = true;
    this.#wake?.();
  }

  response(): Response {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      pull: async controller => {
        while (!this.#frames.length && !this.#ended && !this.signal.signal.aborted) {
          await new Promise<void>(resolve => { this.#wake = resolve; });
          this.#wake = undefined;
        }
        if (this.signal.signal.aborted) return;
        const frame = this.#frames.shift();
        if (frame) { controller.enqueue(encoder.encode(frame.text)); frame.commit?.(); }
        if (this.#ended && !this.#frames.length) controller.close();
      },
      cancel: () => { this.signal.abort(); this.#frames.length = 0; this.#wake?.(); },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }
}

import { nativeFailure } from "./native-failure";
import { diagnosticContext, emitDiagnosticEvent, withDiagnosticContext } from "@chatgpt-tela/core";
import type {
  NativeGatewayOutcome,
  NativeResponsesGateway,
} from "@chatgpt-tela/runtime";
import {
  encodeNativeResponsesOutcome,
  nativeResponsesSsePlan,
} from "./protocol";
import { NativeProgressStream } from "./live-progress";
import { SUPPLIED_FAILURE_DIAGNOSTICS, type SuppliedFailureDiagnostics } from "@chatgpt-tela/runtime";
import { encodeTelaCompactionSummary } from "@chatgpt-tela/codex";

/** Response delivery does not itself require Native tool/history authority. */
export type ResponsesGateway = Pick<NativeResponsesGateway, "handle" | "commit">;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function errorResponse(status: number, message: string): Response {
  return Response.json({
    error: {
      type: "invalid_request_error",
      message,
    },
  }, { status });
}

function observedBody(input: {
  readonly chunks: readonly string[];
  readonly commitAfterChunk?: number;
  readonly commit?: () => void;
  readonly outcome: NativeGatewayOutcome["type"] | "failed";
  readonly onClosed?: () => void;
  readonly signal?: AbortSignal;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  let committed = false;
  let closedOnce = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const diagnostics = diagnosticContext();
  const onAbort = () => { closed("request_aborted"); try { controllerRef?.error(input.signal?.reason); } catch { /* Already closed. */ } };
  const closed = (reason: string) => {
    if (closedOnce) return;
    closedOnce = true;
    if (input.signal) input.signal.removeEventListener("abort", onAbort);
    withDiagnosticContext(diagnostics, () => emitDiagnosticEvent("chatgpt_tela_work", "native_response_body_closed", {
      reason_class: reason, outcome: input.outcome, outcome_committed: committed,
      pulled_frame_count: index, queued_frame_count: input.chunks.length - index,
      delivery: "http_body_consumer", ui_observed: false,
    }));
    try { input.onClosed?.(); } catch { /* Diagnostics never change response delivery. */ }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controllerRef = controller; if (input.signal?.aborted) onAbort(); else input.signal?.addEventListener("abort", onAbort, { once: true }); },
    pull(controller) {
      try {
        if (index >= input.chunks.length) {
          closed("drained");
          controller.close();
          return;
        }
        const current = index;
        controller.enqueue(encoder.encode(input.chunks[index++]!));
        if (!committed && input.commit && current === input.commitAfterChunk) {
          input.commit();
          committed = true;
        }
        if (index >= input.chunks.length) { closed("drained"); controller.close(); }
      } catch (error) { closed("failed"); throw error; }
    },
    cancel() { closed("consumer_cancelled"); },
  }, { highWaterMark: 0 });
  return stream;
}

function responseForOutcome(input: {
  readonly outcome: NativeGatewayOutcome;
  readonly gateway: ResponsesGateway;
  readonly model: string;
  readonly stream: boolean;
  readonly createdAt: number;
  readonly signal?: AbortSignal;
}): Response {
  const encoded = encodeNativeResponsesOutcome({
    outcome: input.outcome,
    model: input.model,
    createdAt: input.createdAt,
  });
  const responseContext = input.outcome.delivery.diagnosticContext ?? diagnosticContext();
  if (!input.stream) {
    const json = `${JSON.stringify(encoded.response)}\n`;
    return new Response(withDiagnosticContext(responseContext, () => observedBody({
      chunks: [json],
      commitAfterChunk: 0,
      commit: () => input.gateway.commit(input.outcome),
      outcome: input.outcome.type, ...(input.signal ? { signal: input.signal } : {}),
      ...(input.outcome.delivery.finishDiagnostics ? { onClosed: input.outcome.delivery.finishDiagnostics } : {}),
    })), {
      headers: { "content-type": "application/json" },
    });
  }

  const plan = nativeResponsesSsePlan(input.outcome, encoded);
  return new Response(withDiagnosticContext(responseContext, () => observedBody({
    chunks: plan.frames,
    commitAfterChunk: plan.commitAfterFrame,
    commit: () => input.gateway.commit(input.outcome),
    outcome: input.outcome.type,
    ...(input.outcome.delivery.finishDiagnostics ? { onClosed: input.outcome.delivery.finishDiagnostics } : {}),
  })), {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/**
 * Fetch-compatible `/responses` boundary for the currently proven ChatGPT Tela protocol subset.
 * Transport parsing/serialization stays outside the Native authority and runtime state machines.
 */
export async function handleNativeResponsesHttp(
  request: Request,
  gateway: ResponsesGateway,
  options: { readonly now?: () => number } = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "Native Responses request body must be valid JSON");
  }
  const body = record(raw);
  if (!body) return errorResponse(400, "Native Responses request body must be an object");
  if (typeof body.model !== "string" || body.model.trim().length === 0) {
    return errorResponse(400, "Native Responses request requires a model");
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return errorResponse(400, "Native Responses stream must be a boolean");
  }

  let outcome: NativeGatewayOutcome;
  const createdAt = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const progress = body.stream === true ? new NativeProgressStream(body.model, createdAt) : undefined;
  try {
    const pending = gateway.handle(body, {
      ...(progress ? { onProgress: progress.progress } : {}),
      signal: progress ? AbortSignal.any([request.signal, progress.signal.signal]) : request.signal,
    });
    if (progress) {
      const first = await Promise.race([pending.then(value => ({ value })), progress.firstProgress.then(() => null)]);
      if (first === null) {
        void pending.then(value => progress.finish(value, gateway), error => progress.fail(error))
          .catch(error => progress.fail(error));
        return progress.response(request.signal);
      }
      outcome = first.value;
      progress.signal.abort();
    } else outcome = await pending;
  } catch (error) {
    // A late SSE failure already committed HTTP 200; a subsequent replay
    // returns the same public cause as a terminal HTTP 400 without re-execution.
    const supplied = error !== null && (typeof error === "object" || typeof error === "function")
      ? (error as { [SUPPLIED_FAILURE_DIAGNOSTICS]?: SuppliedFailureDiagnostics })[SUPPLIED_FAILURE_DIAGNOSTICS] : undefined;
    return new Response(withDiagnosticContext(supplied?.context ?? diagnosticContext(), () => observedBody({
      chunks: [JSON.stringify({ error: nativeFailure(error, Boolean(supplied)).error })], outcome: "failed", signal: request.signal,
      ...(supplied ? { onClosed: supplied.finish } : {}),
    })), { status: 400, headers: { "content-type": "application/json" } });
  }

  return responseForOutcome({
    outcome,
    gateway,
    model: body.model,
    stream: body.stream === true,
    createdAt,
    signal: request.signal,
  });
}

/** Tool-free summary response. Native commits its own local compaction after complete receipt. */
export function nativeCompactionSummaryResponse(input: {
  readonly summary: string;
  readonly operationId: string;
  readonly model: string;
  readonly stream: boolean;
  readonly remote?: boolean;
}): Response {
  if (!input.summary.trim() || !input.operationId.trim()) throw new Error("Native summary response is empty");
  const outcome: NativeGatewayOutcome = {
    type: "final", answer: input.summary, delivery: { capability: `compaction-${input.operationId}` },
  };
  const encoded = encodeNativeResponsesOutcome({ outcome, model: input.model });
  if (input.remote) {
    const item = { type: "compaction", id: encoded.outputItemId,
      encrypted_content: encodeTelaCompactionSummary(input.summary) };
    const response = { ...encoded.response, output: [item] };
    if (!input.stream) return Response.json(response);
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ];
    const wire = events.map((event, sequence_number) =>
      `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
    return new Response(wire + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  }
  if (!input.stream) return Response.json(encoded.response);
  const plan = nativeResponsesSsePlan(outcome, encoded);
  return new Response(plan.frames.join(""), { headers: { "content-type": "text/event-stream" } });
}
